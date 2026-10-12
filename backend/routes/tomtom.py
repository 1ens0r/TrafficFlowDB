"""TomTom real-traffic API: status, readings, incidents, config, refresh.

Every endpoint is cheap except POST /refresh (which spends budget) — and
even that refuses when the daily budget is exhausted.
"""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import querylog
from ..database import get_pool
from ..services import tomtom

router = APIRouter(prefix="/api/tomtom", tags=["tomtom"])


class TomTomConfig(BaseModel):
    enabled: bool | None = None
    interval_sec: int | None = None
    batch_size: int | None = None
    daily_budget: int | None = None
    min_confidence: float | None = None


class RefreshIn(BaseModel):
    segments: list[int] | None = None
    incidents: bool = False
    bbox: str | None = None


@router.get("/status")
def status():
    return tomtom.status()


@router.get("/readings")
def readings(fresh_only: bool = False):
    with get_pool().connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT rs.segment_id, rs.segment_name,
                       tr.current_speed, tr.freeflow_speed,
                       tr.confidence, tr.road_closure, tr.fetched_at,
                       (i1.latitude + i2.latitude) / 2 AS mid_lat,
                       (i1.longitude + i2.longitude) / 2 AS mid_lon
                FROM road_segment rs
                JOIN intersection i1 ON i1.intersection_id = rs.start_intersection_id
                JOIN intersection i2 ON i2.intersection_id = rs.end_intersection_id
                LEFT JOIN tomtom_reading tr ON tr.segment_id = rs.segment_id
                WHERE rs.is_active
                  AND (%s = FALSE OR tr.fetched_at > NOW() - INTERVAL '45 minutes')
                ORDER BY rs.segment_id
                """, (fresh_only,))
            out = []
            for r in cur.fetchall():
                out.append({
                    "segment_id": r[0], "segment_name": r[1],
                    "current_speed": r[2], "freeflow_speed": r[3],
                    "confidence": r[4], "road_closure": r[5],
                    "fetched_at": r[6].isoformat() if r[6] else None,
                    "mid_lat": float(r[7]), "mid_lon": float(r[8]),
                })
            return out


@router.get("/incidents")
def incidents(limit: int = 100):
    with get_pool().connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT incident_id, category, magnitude, description,
                       from_road, to_road, length_m, delay_s,
                       start_time, end_time, lon, lat, fetched_at
                FROM tomtom_incident ORDER BY delay_s DESC LIMIT %s
                """, (max(1, min(limit, 200)),))
            cols = [d[0] for d in cur.description]
            rows = []
            for r in cur.fetchall():
                d = dict(zip(cols, r, strict=True))
                for k in ("start_time", "end_time", "fetched_at"):
                    if d.get(k) is not None:
                        d[k] = d[k].isoformat()
                rows.append(d)
            return rows


@router.post("/refresh")
def refresh(body: RefreshIn | None = None):
    body = body or RefreshIn()
    if body.incidents:
        out = tomtom.poll_incidents(body.bbox)
        if not out.get("ok"):
            raise HTTPException(status_code=429, detail=out.get("reason"))
        return out
    segs = None
    if body.segments:
        segs = [int(s) for s in body.segments[:20]]
    out = tomtom.poll_once(manual=segs)
    if not out.get("ok"):
        raise HTTPException(status_code=429 if out.get("reason") in (
            "budget_exhausted", "backoff") else 400, detail=out.get("reason"))
    return out


@router.put("/config")
def write_config(patch: TomTomConfig):
    before = tomtom.get_cfg()
    out = tomtom.configure(patch.model_dump(exclude_none=True))
    querylog.log("TOMTOM", "tune poller (interval/batch/budget/enabled)", 0,
                 f"{before['interval_sec']}s×{before['batch_size']} → "
                 f"{out['interval_sec']}s×{out['batch_size']}, "
                 f"budget {out['daily_budget']}/day")
    return {**out, "key_set": tomtom.is_configured()}
