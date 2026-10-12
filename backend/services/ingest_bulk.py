"""High-throughput bulk ingest.

Old path: N fixes = N×(2 INSERTs + 1 stored-proc call) round trips.
New path: 1 vehicle upsert + 2 bulk INSERTs + 1 refresh_all_traffic() —
constant round trips no matter the batch size.
"""
from __future__ import annotations

import time

from .. import querylog, runtime
from ..database import get_pool
from ..services import geo
from .gps_processor import segment_geometries


def bulk_ingest(points: list[dict]) -> dict:
    """points: [{vehicle_number, vehicle_type, latitude, longitude,
    speed_kmh, segment_id|None, recorded_at|None}]. Returns summary."""
    t0 = time.perf_counter()
    pool = get_pool()
    with pool.connection() as conn:
        # 1. map-match any fix that arrives without a segment reference.
        geoms = segment_geometries(conn)
        for p in points:
            if p.get("segment_id") is None:
                m = geo.match_segment(p["latitude"], p["longitude"], geoms)
                p["segment_id"] = m["segment_id"] if m else None

        with conn.cursor() as cur:
            # 2. upsert vehicles + subtype rows in set operations.
            vals = ", ".join(["(%s,%s)"] * len(points))
            flat = tuple(x for p in points
                         for x in (p["vehicle_number"], p.get("vehicle_type", "car")))
            cur.execute(
                f"INSERT INTO vehicle (vehicle_number, vehicle_type) "
                f"SELECT DISTINCT n, ty FROM (VALUES {vals}) AS t(n, ty) "
                f"ON CONFLICT (vehicle_number) DO NOTHING",
                flat,
            )
            cur.execute(
                "SELECT vehicle_id, vehicle_number, vehicle_type FROM vehicle "
                "WHERE vehicle_number = ANY(%s)",
                ([p["vehicle_number"] for p in points],),
            )
            idmap = {r[1]: (r[0], r[2]) for r in cur.fetchall()}
            cur.execute(
                "INSERT INTO car_detail (vehicle_id) SELECT v FROM UNNEST(%s::int[]) v "
                "ON CONFLICT DO NOTHING",
                ([vid for num, (vid, ty) in idmap.items() if ty == "car"] or [-1],),
            )
            cur.execute(
                "INSERT INTO bus_detail (vehicle_id) SELECT v FROM UNNEST(%s::int[]) v "
                "ON CONFLICT DO NOTHING",
                ([vid for num, (vid, ty) in idmap.items() if ty == "bus"] or [-1],),
            )
            cur.execute(
                "INSERT INTO emergency_vehicle_detail (vehicle_id, emergency_type) "
                "SELECT v, 'ambulance' FROM UNNEST(%s::int[]) v ON CONFLICT DO NOTHING",
                ([vid for num, (vid, ty) in idmap.items() if ty == "emergency"] or [-1],),
            )

            # 3. bulk append raw + matched fixes.
            rows = [(idmap[p["vehicle_number"]][0], p["latitude"], p["longitude"],
                     p["speed_kmh"], p.get("recorded_at")) for p in points]
            cur.executemany(
                "INSERT INTO gps_data (vehicle_id, latitude, longitude, speed_kmh, recorded_at) "
                "VALUES (%s, %s, %s, %s, COALESCE(%s::timestamptz, NOW()))",
                rows,
            )
            rows2 = [(idmap[p["vehicle_number"]][0], p.get("segment_id"),
                      p["latitude"], p["longitude"], p["speed_kmh"], p.get("recorded_at"))
                     for p in points]
            cur.executemany(
                "INSERT INTO vehicle_position (vehicle_id, segment_id, latitude, longitude, "
                "speed_kmh, recorded_at) "
                "VALUES (%s, %s, %s, %s, %s, COALESCE(%s::timestamptz, NOW()))",
                rows2,
            )
            # 4. one refresh for the whole batch.
            cur.execute("SELECT * FROM refresh_all_traffic(%s)",
                        (runtime.get("traffic_window_minutes"),))
            refreshed = cur.fetchall()
            cur.execute(
                "UPDATE vehicle SET last_seen = NOW() WHERE vehicle_id = ANY(%s)",
                (list(idmap and [v[0] for v in idmap.values()]),),
            )
    ms = (time.perf_counter() - t0) * 1000
    querylog.log(
        "SQL",
        "bulk upsert vehicles; bulk INSERT gps_data ×N + vehicle_position ×N; "
        "SELECT refresh_all_traffic(window); touch last_seen",
        ms,
        f"batch of {len(points)} fixes",
    )
    per_sec = len(points) / max(ms / 1000, 1e-6)
    return {"ingested": len(points), "vehicles": len(idmap),
            "segments_refreshed": len(refreshed), "ms": round(ms, 2),
            "fixes_per_sec": round(per_sec, 1)}
