"""Analytics API: pre-aggregated graph data so the dashboard leads with
charts instead of raw tables. All queries are indexed rollups (ms-scale).
"""
import time

from fastapi import APIRouter

from ..database import get_pool

router = APIRouter(prefix="/api/analytics", tags=["analytics"])


@router.get("/overview")
def overview():
    t0 = time.perf_counter()
    with get_pool().connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT congestion_level, COUNT(*),
                       COALESCE(AVG(average_speed), 0),
                       COALESCE(SUM(vehicle_count), 0)
                FROM live_traffic_summary GROUP BY congestion_level
                """)
            by_level = {r[0]: {"segments": r[1], "avg_speed": round(float(r[2]), 1),
                               "vehicles": int(r[3])} for r in cur.fetchall()}
            for lvl in ("LOW", "MEDIUM", "HIGH"):
                by_level.setdefault(lvl, {"segments": 0, "avg_speed": 0, "vehicles": 0})
            cur.execute(
                "SELECT COALESCE(SUM(distance_km),0), COALESCE(AVG(average_speed),0) "
                "FROM live_traffic_summary")
            total_km, net_avg = cur.fetchone()
            cur.execute("SELECT COUNT(*) FROM vehicle_position "
                        "WHERE recorded_at > NOW() - INTERVAL '5 minutes'")
            fixes = int(cur.fetchone()[0])
            cur.execute("SELECT COUNT(*) FROM road_segment WHERE is_active")
            segs = int(cur.fetchone()[0])
            cur.execute(
                """
                SELECT COALESCE(AVG(traffic_index), 0),
                       COUNT(*) FILTER (WHERE traffic_source = 'tomtom')
                FROM traffic_condition
                """)
            avg_index, tt_backed = cur.fetchone()
            cur.execute(
                "SELECT calibrated, fresh, total FROM tomtom_coverage")
            cal, fresh_cov, total_seg = cur.fetchone()
    return {
        "by_level": by_level,
        "network_avg_speed": round(float(net_avg), 1),
        "avg_index": round(float(avg_index), 3),
        "tomtom_backed": int(tt_backed),
        "tomtom_calibrated": int(cal),
        "tomtom_fresh_coverage": int(fresh_cov),
        "total_km": round(float(total_km), 1),
        "fixes_5min": fixes,
        "tomtom_fresh": int(fresh_cov),
        "segments": segs,
        "ms": round((time.perf_counter() - t0) * 1000, 2),
    }


@router.get("/trends")
def trends(hours: int = 12):
    hours = max(1, min(hours, 72))
    # Bucket width adapts to the window so the chart always has shape: an
    # hourly rollup of a system that has only been up 10 minutes renders as a
    # single point (a blank-looking chart). Short windows use minutes.
    bucket = "minute" if hours <= 3 else ("5 minutes" if hours <= 12 else "hour")
    n_buckets = {"minute": 180, "5 minutes": 144, "hour": 72}[bucket]
    with get_pool().connection() as conn:
        with conn.cursor() as cur:
            # date_bin (not date_trunc) so a 5-minute bucket is expressible.
            cur.execute(
                """
                SELECT date_bin(%s::interval, calculated_at,
                                TIMESTAMPTZ '2000-01-01') AS b,
                       AVG(average_speed),
                       SUM(CASE WHEN congestion_level IN ('MEDIUM','HIGH') THEN 1 ELSE 0 END),
                       COUNT(*)
                FROM traffic_history
                WHERE calculated_at > NOW() - (%s || ' hours')::INTERVAL
                GROUP BY 1 ORDER BY 1
                """, (bucket, hours))
            rows = cur.fetchall()
            series = []
            for r in rows:
                n = max(1, int(r[3]))
                series.append({
                    "bucket": r[0].isoformat(),
                    "avg_speed": round(float(r[1]), 1),
                    "congested_pct": round(100.0 * int(r[2]) / n, 1),
                    "samples": int(r[3]),
                })
            # Zero-fill missing buckets so gaps render as flat, not as a
            # misleading straight line between distant points.
            series = _zero_fill(series, bucket, hours, n_buckets)
            cur.execute(
                """
                SELECT date_bin(%s::interval, observed_at,
                                TIMESTAMPTZ '2000-01-01') AS b,
                       AVG(current_speed),
                       SUM(CASE WHEN congestion_level IN ('MEDIUM','HIGH') THEN 1 ELSE 0 END),
                       COUNT(*)
                FROM tomtom_history
                WHERE observed_at > NOW() - (%s || ' hours')::INTERVAL
                GROUP BY 1 ORDER BY 1
                """, (bucket, hours))
            tt_rows = cur.fetchall()
            tt_series = [{"bucket": r[0].isoformat(),
                          "avg_speed": round(float(r[1]), 1),
                          "congested_pct": round(100.0 * int(r[2]) / max(1, int(r[3])), 1),
                          "samples": int(r[3])} for r in tt_rows]
            tt_series = _zero_fill(tt_series, bucket, hours, n_buckets)
            cur.execute(
                """
                SELECT date_bin(INTERVAL '1 minute', recorded_at,
                                TIMESTAMPTZ '2000-01-01') AS m, COUNT(*)
                FROM gps_data
                WHERE recorded_at > NOW() - INTERVAL '60 minutes'
                GROUP BY 1 ORDER BY 1
                """)
            ingest = [{"minute": r[0].isoformat(), "fixes": int(r[1])}
                      for r in cur.fetchall()]
            cur.execute(
                """
                SELECT date_bin(INTERVAL '1 minute', calculated_at,
                                TIMESTAMPTZ '2000-01-01') AS m,
                       SUM(CASE WHEN traffic_source = 'tomtom' THEN 1 ELSE 0 END)
                FROM traffic_history
                WHERE calculated_at > NOW() - INTERVAL '60 minutes'
                GROUP BY 1 ORDER BY 1
                """)
            tt = [{"minute": r[0].isoformat(), "tomtom": int(r[1] or 0)}
                  for r in cur.fetchall()]
    return {"hours": hours, "bucket": bucket, "speed_trend": series,
            "tomtom_trend": tt_series, "ingest_per_min": ingest,
            "tomtom_per_min": tt}


def _zero_fill(series: list[dict], bucket: str, hours: int,
               n_buckets: int) -> list[dict]:
    """Pad a sparse rollup to a continuous bucket series."""
    if not series:
        return series
    import datetime as dt
    have = {s["bucket"] for s in series}
    first = series[0]["bucket"]
    step = {"minute": dt.timedelta(minutes=1),
            "5 minutes": dt.timedelta(minutes=5),
            "hour": dt.timedelta(hours=1)}[bucket]
    t0 = dt.datetime.fromisoformat(first)
    out = list(series)
    cur_t, end = t0, t0 + step * n_buckets
    while cur_t <= end:
        k = cur_t.isoformat()
        if k not in have:
            out.append({"bucket": k, "avg_speed": 0.0,
                        "congested_pct": 0.0, "samples": 0})
        cur_t += step
    out.sort(key=lambda s: s["bucket"])
    return out


@router.get("/corridors")
def corridors(limit: int = 8):
    limit = max(3, min(limit, 20))
    with get_pool().connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT l.segment_id, l.segment_name, l.distance_km,
                       l.average_speed, l.vehicle_count, l.density,
                       l.congestion_level, l.speed_limit_kmh,
                       (tr.fetched_at > NOW() - INTERVAL '45 minutes') AS tt_fresh,
                       tr.current_speed
                FROM live_traffic_summary l
                LEFT JOIN tomtom_reading tr ON tr.segment_id = l.segment_id
                ORDER BY l.average_speed ASC LIMIT %s
                """, (limit,))
            slowest = [_corr(r) for r in cur.fetchall()]
            cur.execute(
                """
                SELECT l.segment_id, l.segment_name, l.distance_km,
                       l.average_speed, l.vehicle_count, l.density,
                       l.congestion_level, l.speed_limit_kmh,
                       (tr.fetched_at > NOW() - INTERVAL '45 minutes') AS tt_fresh,
                       tr.current_speed
                FROM live_traffic_summary l
                LEFT JOIN tomtom_reading tr ON tr.segment_id = l.segment_id
                ORDER BY l.density DESC LIMIT %s
                """, (limit,))
            densest = [_corr(r) for r in cur.fetchall()]
    return {"slowest": slowest, "densest": densest}


def _corr(r) -> dict:
    return {
        "segment_id": r[0], "segment_name": r[1], "distance_km": r[2],
        "average_speed": round(float(r[3]), 1), "vehicle_count": r[4],
        "density": round(float(r[5]), 3), "congestion_level": r[6],
        "speed_limit_kmh": r[7], "tomtom_fresh": bool(r[8]),
        "tomtom_speed": round(float(r[9]), 1) if r[9] is not None else None,
    }
