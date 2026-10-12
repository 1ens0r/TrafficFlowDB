"""TomTom real-traffic poller with hard cost controls.

Cost model (free tier ≈ 2,500 transactions/day):
  flowSegmentData = 1 tx per segment per poll (the expensive part).
  incidentDetails (India bbox) = 1 tx per poll (cheap, shared).

Controls, all live-tunable via PUT /api/tomtom/config:
  - round-robin by oldest fetched_at: each cycle touches only `batch_size`
    segments, so every corridor refreshes every
    total_segments / batch_size * interval_sec seconds.
  - daily budget ledger (tomtom_usage): poller stops making calls at budget
    and reports `budget_exhausted` in status instead of silently spending.
  - TTL blend: routing/dashboard treat readings as fresh for 15 min, stale
    after — so a slow cadence never serves misleading speeds as live.
  - incidents ride along every 6th flow cycle (≈30 min at defaults).

Defaults: 300 s × 4 segs over ~42 segments → ~1,152 flow tx/day + ~50
incident tx/day — safely inside budget with headroom for manual refreshes.
"""
from __future__ import annotations

import asyncio
import threading
import time

import httpx

from .. import querylog, runtime
from ..config import settings

FLOW_URL = ("https://api.tomtom.com/traffic/services/4/flowSegmentData"
            "/absolute/18/json")
INCIDENTS_URL = "https://api.tomtom.com/traffic/services/5/incidentDetails"
# minLon, minLat, maxLon, maxLat — covers all-India corridors with margin.
INDIA_BBOX = "67.0,6.0,98.0,38.0"
# A reading stays authoritative for this long. The free tier cannot refresh 42
# corridors more often than ~every 40 min, so a 15-min window would drop half
# the network back to "no data" between sweeps. 45 min keeps full coverage
# while still being recent enough to route on.
FRESH_SEC = 45 * 60  # keep in sync with the 45-minute windows in procedures.sql
# Stricter window for routing: a stale-but-real speed still beats a synthetic
# guess, but the UI always shows the reading's age so it is never passed off
# as live.
ROUTE_MAX_AGE_SEC = 45 * 60

_lock = threading.Lock()
_beat = {"cycles": 0, "last_cycle": 0.0, "last_result": None, "last_error": "",
         "last_calibration": None}
_cfg = {
    "enabled": settings.tomtom_enabled,
    "interval_sec": settings.tomtom_interval_sec,
    "batch_size": settings.tomtom_batch_size,
    "daily_budget": settings.tomtom_daily_budget,
    "min_confidence": settings.tomtom_min_confidence,
}
_cfg_loaded = False
_backoff_until = 0.0
_last_err = ""
_inc_cycle = 0


def get_cfg() -> dict:
    _load_persisted()
    with _lock:
        return dict(_cfg)


def _clamp(cfg: dict) -> dict:
    cfg["interval_sec"] = max(60, min(int(cfg["interval_sec"]), 3600))
    cfg["batch_size"] = max(1, min(int(cfg["batch_size"]), 20))
    cfg["daily_budget"] = max(0, min(int(cfg["daily_budget"]), 50000))
    cfg["enabled"] = bool(cfg["enabled"])
    return cfg


def _load_persisted() -> None:
    """Restore drawer-tuned settings after a restart (no-op if unavailable)."""
    global _cfg_loaded
    if _cfg_loaded:
        return
    _cfg_loaded = True
    try:
        from ..database import get_pool
        with get_pool().connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT enabled, interval_sec, batch_size, daily_budget, "
                    "min_confidence FROM tomtom_config WHERE id = 1")
                row = cur.fetchone()
    except Exception:  # noqa: BLE001 — env defaults are fine
        return
    if row:
        with _lock:
            _cfg.update(_clamp({
                "enabled": row[0], "interval_sec": row[1], "batch_size": row[2],
                "daily_budget": row[3], "min_confidence": row[4]}))


def configure(patch: dict) -> dict:
    _load_persisted()
    with _lock:
        for key in ("enabled", "interval_sec", "batch_size", "daily_budget",
                    "min_confidence"):
            if key in patch and patch[key] is not None:
                _cfg[key] = patch[key]
        out = _clamp(dict(_cfg))
    _persist(out)
    return out


def _persist(cfg: dict) -> None:
    """Save poll config so it survives restarts (best-effort)."""
    try:
        from ..database import get_pool
        with get_pool().connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO tomtom_config
                        (id, enabled, interval_sec, batch_size, daily_budget, min_confidence)
                    VALUES (1, %s, %s, %s, %s, %s)
                    ON CONFLICT (id) DO UPDATE SET
                        enabled = EXCLUDED.enabled,
                        interval_sec = EXCLUDED.interval_sec,
                        batch_size = EXCLUDED.batch_size,
                        daily_budget = EXCLUDED.daily_budget,
                        min_confidence = EXCLUDED.min_confidence
                    """, (cfg["enabled"], cfg["interval_sec"], cfg["batch_size"],
                          cfg["daily_budget"], cfg["min_confidence"]))
    except Exception:  # noqa: BLE001 — never fail a settings write
        pass


def is_configured() -> bool:
    return bool(settings.tomtom_api_key)


def _backoff() -> bool:
    return time.time() < _backoff_until


def _set_backoff(sec: float = 600.0) -> None:
    global _backoff_until
    _backoff_until = time.time() + sec


# -- DB helpers --------------------------------------------------------------
def _used_today(cur) -> int:
    cur.execute("SELECT calls FROM tomtom_usage WHERE day = CURRENT_DATE")
    row = cur.fetchone()
    return int(row[0]) if row else 0


def _add_usage(cur, n: int) -> int:
    cur.execute(
        "INSERT INTO tomtom_usage (day, calls) VALUES (CURRENT_DATE, %s) "
        "ON CONFLICT (day) DO UPDATE SET calls = tomtom_usage.calls + %s "
        "RETURNING calls",
        (n, n),
    )
    return int(cur.fetchone()[0])


def _pick_batch(cur, n: int) -> list[dict]:
    """Oldest-fetched corridors first, so coverage is fair and round-robin.

    Only corridors with a calibrated on-road probe are eligible — an
    uncalibrated segment would burn a transaction and return HTTP 400.
    """
    cur.execute(
        """
        SELECT rs.segment_id, rs.segment_name,
               rs.probe_lat, rs.probe_lon, tr.fetched_at
        FROM road_segment rs
        LEFT JOIN tomtom_reading tr ON tr.segment_id = rs.segment_id
        WHERE rs.is_active AND rs.probe_lat IS NOT NULL
        ORDER BY tr.fetched_at NULLS FIRST
        LIMIT %s
        """,
        (n,),
    )
    return [{"segment_id": r[0], "name": r[1],
             "lat": float(r[2]), "lon": float(r[3])} for r in cur.fetchall()]


def _candidate_points(a_lat: float, a_lon: float,
                      b_lat: float, b_lon: float) -> list[tuple[float, float]]:
    """Points along the straight corridor, nearest-to-real-road first.

    Midpoint leads (works for direct corridors); the offsets walk outward
    toward each end where the corridor is anchored on a city/road junction.
    """
    pts = []
    for t in (0.5, 0.42, 0.58, 0.34, 0.66, 0.25, 0.75):
        pts.append((a_lat + (b_lat - a_lat) * t, a_lon + (b_lon - a_lon) * t))
    return pts


def calibrate_probes(limit: int = 6) -> dict:
    """One-time: find an on-road probe for corridors that have none.

    Costs at most `limit` × candidates transactions, ONCE per corridor, then
    every subsequent poll is a single transaction at a known-good point.
    """
    from ..database import get_pool

    key = settings.tomtom_api_key
    cfg = get_cfg()
    if not key or not cfg["enabled"]:
        return {"ok": False, "reason": "unavailable"}
    calibrated, tried, budget_used = 0, 0, 0
    try:
        with get_pool().connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT segment_id, segment_name, a_lat, a_lon, b_lat, b_lon "
                    "FROM tomtom_uncalibrated_segments LIMIT %s", (max(1, limit),))
                pending = cur.fetchall()
                if not pending:
                    return {"ok": True, "calibrated": 0, "remaining": 0}
                for sid, name, a_lat, a_lon, b_lat, b_lon in pending:
                    if _used_today(cur) >= cfg["daily_budget"]:
                        break
                    for lat, lon in _candidate_points(a_lat, a_lon, b_lat, b_lon):
                        if _used_today(cur) >= cfg["daily_budget"]:
                            break
                        flow = _fetch_flow(key, lat, lon)
                        _add_usage(cur, 1)
                        tried += 1
                        budget_used += 1
                        if flow and flow["current_speed"] is not None:
                            cur.execute("SELECT set_segment_probe(%s, %s, %s)",
                                        (sid, lat, lon))
                            if flow.get("current_speed") or flow.get("freeflow_speed"):
                                cur.execute(
                                    """
                                    INSERT INTO tomtom_reading
                                        (segment_id, current_speed, freeflow_speed,
                                         travel_time_s, freeflow_time_s, confidence,
                                         road_closure, fetched_at)
                                    VALUES (%s,%s,%s,%s,%s,%s,%s,NOW())
                                    ON CONFLICT (segment_id) DO UPDATE SET
                                        current_speed = EXCLUDED.current_speed,
                                        freeflow_speed = EXCLUDED.freeflow_speed,
                                        travel_time_s = EXCLUDED.travel_time_s,
                                        freeflow_time_s = EXCLUDED.freeflow_time_s,
                                        confidence = EXCLUDED.confidence,
                                        road_closure = EXCLUDED.road_closure,
                                        fetched_at = EXCLUDED.fetched_at
                                    """, (sid, flow["current_speed"],
                                          flow["freeflow_speed"], flow["travel_time_s"],
                                          flow["freeflow_time_s"], flow["confidence"],
                                          flow["road_closure"]))
                            calibrated += 1
                            break
                cur.execute("SELECT COUNT(*) FROM tomtom_uncalibrated_segments")
                remaining = int(cur.fetchone()[0])
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "reason": f"db_error: {exc}"[:120]}
    querylog.log("TOMTOM", "calibrate probe points along corridors "
                 "(one-time, then 1 tx per poll)", 0,
                 f"{calibrated} calibrated, {tried} calls spent, "
                 f"{remaining} remaining")
    return {"ok": True, "calibrated": calibrated, "tried": tried,
            "remaining": remaining, "calls_used": budget_used}


# -- HTTP --------------------------------------------------------------------
def _fetch_flow(key: str, lat: float, lon: float) -> dict | None:
    global _last_err
    try:
        r = httpx.get(FLOW_URL, params={
            "key": key, "point": f"{lat},{lon}", "unit": "KMPH",
        }, timeout=12.0)
    except Exception as exc:  # noqa: BLE001
        _last_err = f"transport:{type(exc).__name__}"
        return None
    if r.status_code == 429:
        _set_backoff()
        _last_err = "http:429"
        return None
    if r.status_code != 200:
        _last_err = f"http:{r.status_code}:{r.text[:90]}"
        return None
    try:
        f = r.json()["flowSegmentData"]
        return {
            "current_speed": float(f.get("currentSpeed", 0)),
            "freeflow_speed": float(f.get("freeFlowSpeed", 0)),
            "travel_time_s": float(f.get("currentTravelTime", 0)),
            "freeflow_time_s": float(f.get("freeFlowTravelTime", 0)),
            "confidence": float(f.get("confidence", 0)),
            "road_closure": bool(f.get("roadClosure", False)),
        }
    except Exception as exc:  # noqa: BLE001
        _last_err = f"parse:{type(exc).__name__}"
        return None


def _level_of(flow: dict) -> str:
    """Congestion from the vendor slow-down ratio (mirrors calculate_segment_traffic)."""
    ff = flow.get("freeflow_speed") or 0
    if ff <= 0:
        return "LOW"
    ratio = min(1.0, flow["current_speed"] / ff)
    if ratio < 0.25:
        return "HIGH"
    if ratio < 0.55:
        return "MEDIUM"
    return "LOW"


def poll_once(manual: list[int] | None = None) -> dict:
    """One cost-guarded flow-poll cycle. Returns a summary; never raises."""
    from ..database import get_pool

    cfg = get_cfg()
    key = settings.tomtom_api_key
    if not key:
        return {"ok": False, "reason": "no_key"}
    if not cfg["enabled"]:
        return {"ok": False, "reason": "disabled"}
    if _backoff():
        return {"ok": False, "reason": "backoff"}
    t0 = time.perf_counter()
    fetched, failed, skipped, _refreshed = 0, 0, 0, 0
    try:
        with get_pool().connection() as conn:
            with conn.cursor() as cur:
                used = _used_today(cur)
                if used >= cfg["daily_budget"]:
                    return {"ok": False, "reason": "budget_exhausted",
                            "used_today": used, "budget": cfg["daily_budget"]}
                if manual:
                    cur.execute(
                        """
                        SELECT rs.segment_id, rs.segment_name,
                               COALESCE(rs.probe_lat,
                                        (i1.latitude + i2.latitude) / 2),
                               COALESCE(rs.probe_lon,
                                        (i1.longitude + i2.longitude) / 2)
                        FROM road_segment rs
                        JOIN intersection i1
                          ON i1.intersection_id = rs.start_intersection_id
                        JOIN intersection i2
                          ON i2.intersection_id = rs.end_intersection_id
                        WHERE rs.segment_id = ANY(%s) AND rs.is_active
                        """, (manual,))
                    batch = [{"segment_id": r[0], "name": r[1],
                              "lat": float(r[2]), "lon": float(r[3])}
                             for r in cur.fetchall()]
                else:
                    room = cfg["daily_budget"] - used
                    batch = _pick_batch(cur, min(cfg["batch_size"], room))
                for seg in batch:
                    if _used_today(cur) >= cfg["daily_budget"]:
                        skipped += len(batch) - fetched - failed
                        break
                    flow = _fetch_flow(key, seg["lat"], seg["lon"])
                    _add_usage(cur, 1)  # vendor bills per request made
                    if not flow:
                        failed += 1
                        continue
                    level = _level_of(flow)
                    index = 0.0
                    if flow.get("freeflow_speed"):
                        index = max(0.0, min(1.0, 1.0 - (
                            flow["current_speed"] / flow["freeflow_speed"])))
                    cur.execute(
                        """
                        INSERT INTO tomtom_reading
                            (segment_id, current_speed, freeflow_speed,
                             travel_time_s, freeflow_time_s, confidence,
                             road_closure, fetched_at)
                        VALUES (%s,%s,%s,%s,%s,%s,%s,NOW())
                        ON CONFLICT (segment_id) DO UPDATE SET
                            current_speed = EXCLUDED.current_speed,
                            freeflow_speed = EXCLUDED.freeflow_speed,
                            travel_time_s = EXCLUDED.travel_time_s,
                            freeflow_time_s = EXCLUDED.freeflow_time_s,
                            confidence = EXCLUDED.confidence,
                            road_closure = EXCLUDED.road_closure,
                            fetched_at = EXCLUDED.fetched_at
                        """, (seg["segment_id"], flow["current_speed"],
                              flow["freeflow_speed"], flow["travel_time_s"],
                              flow["freeflow_time_s"], flow["confidence"],
                              flow["road_closure"]))
                    cur.execute(
                        """
                        INSERT INTO tomtom_history
                            (segment_id, current_speed, freeflow_speed,
                             traffic_index, congestion_level, observed_at)
                        VALUES (%s,%s,%s,%s,%s,NOW())
                        """, (seg["segment_id"], flow["current_speed"],
                              flow["freeflow_speed"], index, level))
                    fetched += 1
                used = _used_today(cur)
                # Vendor speeds are authoritative, so recompute the snapshot
                # once per cycle: views, map, SQL Lab and router all pick the
                # real reading up. One call per cycle, not per row.
                cur.execute("SELECT * FROM refresh_all_traffic(%s)",
                            (runtime.get("traffic_window_minutes"),))
                _refreshed = len(cur.fetchall())
    except Exception as exc:  # noqa: BLE001 — poller never takes the API down
        return {"ok": False, "reason": f"db_error: {exc}"[:120]}
    ms = (time.perf_counter() - t0) * 1000
    querylog.log("TOMTOM",
                 "flowSegmentData ×%d (round-robin, budget-capped); "
                 "SELECT refresh_all_traffic(window)" % fetched, ms,
                 f"{fetched} ok, {failed} failed, {skipped} skipped "
                 f"({used}/{cfg['daily_budget']} today), {_refreshed} segments")
    return {"ok": True, "fetched": fetched, "failed": failed,
            "skipped": skipped, "used_today": used, "refreshed": _refreshed,
            "budget": cfg["daily_budget"], "ms": round(ms, 1)}


def _hub_boxes(cur, limit: int) -> list[str]:
    """Small bboxes around hubs. TomTom caps `bbox` at 10,000 km², so an
    all-India box is rejected outright (400) — we must tile it. One hub per
    cycle on rotation keeps incident coverage inside the daily budget."""
    cur.execute(
        "SELECT latitude, longitude FROM intersection "
        "WHERE scope = 'national' ORDER BY intersection_id")
    hubs = cur.fetchall()
    if not hubs:
        return []
    offset = _inc_cycle * 1
    picked = []
    for i in range(min(limit, len(hubs))):
        lat, lon = hubs[(offset + i) % len(hubs)]
        picked.append(f"{lon - 0.35:.3f},{lat - 0.3:.3f},"
                      f"{lon + 0.35:.3f},{lat + 0.3:.3f}")
    return picked


def fetch_incidents_for(bbox: str) -> list[dict]:
    """Live TomTom incidents inside one (<=10k km²) bbox. Never raises."""
    key = settings.tomtom_api_key
    if not key or _backoff():
        return []
    try:
        # No `fields` filter: TomTom rejects `incidents.id` (and friends) as
        # unknown fields with a 400. Unfiltered responses include everything
        # we need and cost the same single transaction.
        r = httpx.get(INCIDENTS_URL, params={
            "key": key, "bbox": bbox, "language": "en-GB",
            "timeValidityValid": "true",
        }, timeout=25.0)
    except Exception:  # noqa: BLE001
        return []
    if r.status_code != 200:
        if r.status_code == 429:
            _set_backoff()
        return []
    try:
        return r.json().get("incidents", [])
    except Exception:  # noqa: BLE001
        return []


def _store_incidents(cur, items: list[dict]) -> int:
    """Persist incidents. Unfiltered responses carry geometry but only
    iconCategory in properties, so the id is derived from the geometry."""
    stored = 0
    for inc in items[:300]:
        p = inc.get("properties", {}) or {}
        g = inc.get("geometry", {}) or {}
        coords = g.get("coordinates") or []
        lon = lat = None
        try:
            if g.get("type") == "Point" and len(coords) >= 2:
                lon, lat = float(coords[0]), float(coords[1])
            elif isinstance(coords, list) and coords and isinstance(coords[0], list):
                mid = coords[len(coords) // 2]
                lon, lat = float(mid[0]), float(mid[1])
        except Exception:  # noqa: BLE001
            pass
        if lat is None or lon is None:
            continue
        evs = p.get("events") or []
        desc = evs[0].get("description", "") if evs else ""
        icon = str(p.get("iconCategory", ""))
        iid = str(inc.get("id") or f"{icon}-{round(lat, 4)}-{round(lon, 4)}")
        cur.execute(
            """
            INSERT INTO tomtom_incident
                (incident_id, category, magnitude, description,
                 from_road, to_road, length_m, delay_s,
                 start_time, end_time, lon, lat, fetched_at)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,NOW())
            ON CONFLICT (incident_id) DO UPDATE SET
                description = EXCLUDED.description,
                magnitude = EXCLUDED.magnitude,
                delay_s = EXCLUDED.delay_s,
                lon = EXCLUDED.lon, lat = EXCLUDED.lat,
                fetched_at = EXCLUDED.fetched_at
            """, (iid, icon, str(p.get("magnitudeOfDelay", ""))[:40], str(desc)[:500],
                  str(p.get("from", ""))[:200], str(p.get("to", ""))[:200],
                  float(p.get("length", 0) or 0), float(p.get("delay", 0) or 0),
                  p.get("startTime"), p.get("endTime"), lon, lat))
        stored += 1
    return stored


def poll_incidents(bbox: str | None = None) -> dict:
    """Refresh the incident cache.

    bbox given -> that one area (manual / on-demand, a single call).
    bbox None  -> one hub per cycle on rotation (background sweep). TomTom
                  rejects boxes over 10,000 km², so an all-India query is not
                  an option; tiling by hub is what keeps it working.
    """
    global _inc_cycle
    from ..database import get_pool

    cfg = get_cfg()
    key = settings.tomtom_api_key
    if not key or not cfg["enabled"] or _backoff():
        return {"ok": False, "reason": "unavailable"}
    t0 = time.perf_counter()
    try:
        with get_pool().connection() as conn:
            with conn.cursor() as cur:
                boxes = [bbox] if bbox else _hub_boxes(cur, 1)
                if not boxes:
                    return {"ok": False, "reason": "no_hubs"}
                if _used_today(cur) >= cfg["daily_budget"]:
                    return {"ok": False, "reason": "budget_exhausted"}
                stored = 0
                for box in boxes:
                    items = fetch_incidents_for(box)
                    _add_usage(cur, 1)  # vendor bills per request made
                    if items:
                        stored += _store_incidents(cur, items)
                cur.execute("SELECT COUNT(*) FROM tomtom_incident")
                total = int(cur.fetchone()[0])
                _inc_cycle += 1
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "reason": f"db_error: {exc}"[:120]}
    ms = (time.perf_counter() - t0) * 1000
    querylog.log("TOMTOM", "incidentDetails (tiled per hub; 10k km² bbox cap)",
                 ms, f"{stored} stored/updated, {total} incidents cached")
    return {"ok": True, "incidents": stored, "cached": total, "ms": round(ms, 1)}


def status() -> dict:
    """Cheap status snapshot for the dashboard + API (no vendor calls)."""
    from ..database import get_pool

    cfg = get_cfg()
    with _lock:
        beat = dict(_beat)
    out = {**cfg, "key_set": is_configured(), "fresh_sec": FRESH_SEC,
           "bbox": INDIA_BBOX, "used_today": 0, "fresh_count": 0,
           "total_segments": 0, "last_fetch": None, "incidents": 0,
           "budget_exhausted": False, "backoff": _backoff(),
           "cycles": beat["cycles"], "last_cycle": beat["last_cycle"],
           "last_error": beat["last_error"], "last_result": beat["last_result"],
           "vendor_error": _last_err}
    try:
        with get_pool().connection() as conn:
            with conn.cursor() as cur:
                out["used_today"] = _used_today(cur)
                cur.execute("SELECT COUNT(*) FROM road_segment WHERE is_active")
                out["total_segments"] = int(cur.fetchone()[0])
                cur.execute(
                    "SELECT COUNT(*), MAX(fetched_at) FROM tomtom_reading "
                    "WHERE fetched_at > NOW() - (%s || ' seconds')::INTERVAL",
                    (FRESH_SEC,))
                n, mx = cur.fetchone()
                out["fresh_count"] = int(n or 0)
                out["last_fetch"] = mx.isoformat() if mx else None
                cur.execute("SELECT COUNT(*) FROM tomtom_incident")
                out["incidents"] = int(cur.fetchone()[0])
                cur.execute("SELECT COUNT(*) FROM road_segment "
                            "WHERE is_active AND probe_lat IS NOT NULL")
                out["calibrated_segments"] = int(cur.fetchone()[0])
                cur.execute("SELECT COUNT(*) FROM tomtom_uncalibrated_segments")
                out["uncalibrated_segments"] = int(cur.fetchone()[0])
    except Exception:
        pass
    out.setdefault("calibrated_segments", 0)
    out.setdefault("uncalibrated_segments", 0)
    out["last_calibration"] = beat["last_calibration"]
    out["budget_exhausted"] = out["used_today"] >= cfg["daily_budget"]
    out["est_daily_use"] = (
        (86400 // max(cfg["interval_sec"], 1)) * cfg["batch_size"] + 50)
    return out


async def run_forever() -> None:
    """Background loop started from lifespan. Sleeps when keyless/disabled."""
    cycle = 0
    while True:
        try:
            cfg = get_cfg()
            if is_configured() and cfg["enabled"]:
                # One-time probe calibration runs first and only once; after
                # every corridor has an on-road point, normal polling is 1 tx.
                cal = await asyncio.to_thread(calibrate_probes, 6)
                with _lock:
                    _beat["last_calibration"] = cal
                res = await asyncio.to_thread(poll_once)
                cycle += 1
                with _lock:
                    _beat["cycles"] = cycle
                    _beat["last_cycle"] = time.time()
                    _beat["last_result"] = res
                    _beat["last_error"] = ""
                if cycle % 6 == 0:  # incidents ≈ every 6th flow cycle
                    await asyncio.to_thread(poll_incidents)
                await asyncio.sleep(cfg["interval_sec"])
            else:
                await asyncio.sleep(30)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — loop never dies on a bad cycle
            with _lock:
                _beat["last_cycle"] = time.time()
                _beat["last_error"] = str(exc)[:160]
            await asyncio.sleep(60)
