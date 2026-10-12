from fastapi import APIRouter

from ..database import get_pool

router = APIRouter(prefix="/api/network", tags=["network"])


@router.get("/intersections")
def intersections():
    with get_pool().connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT intersection_id, name, latitude, longitude, scope "
                "FROM intersection ORDER BY scope, intersection_id"
            )
            return [
                {"id": r[0], "name": r[1], "lat": r[2], "lon": r[3], "scope": r[4]}
                for r in cur.fetchall()
            ]


@router.get("/segments")
def segments():
    with get_pool().connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT rs.segment_id, rs.segment_name, rs.distance_km,
                       rs.speed_limit_kmh, rs.road_type, rs.capacity, rs.is_active,
                       rs.scope,
                       rs.start_intersection_id, rs.end_intersection_id,
                       i1.latitude, i1.longitude, i2.latitude, i2.longitude,
                       trg.polyline, trg.point_count, trg.frc
                FROM road_segment rs
                JOIN intersection i1 ON i1.intersection_id = rs.start_intersection_id
                JOIN intersection i2 ON i2.intersection_id = rs.end_intersection_id
                LEFT JOIN tomtom_road_geometry trg ON trg.segment_id = rs.segment_id
                ORDER BY rs.segment_id
                """
            )
            out = []
            for r in cur.fetchall():
                poly = r[14]
                pts = []
                if poly:
                    try:
                        pts = [[float(p[0]), float(p[1])] for p in poly]
                    except Exception:  # noqa: BLE001 — fall back to the chord
                        pts = []
                out.append({
                    "id": r[0], "name": r[1], "distance_km": r[2],
                    "speed_limit": r[3], "road_type": r[4], "capacity": r[5],
                    "active": r[6], "scope": r[7], "a": r[8], "b": r[9],
                    "a_lat": r[10], "a_lon": r[11], "b_lat": r[12], "b_lon": r[13],
                    # TomTom's own road alignment for this corridor, when
                    # captured. The map prefers this over a straight chord.
                    "road_polyline": pts,
                    "road_points": int(r[15] or 0),
                    "frc": r[16],
                })
            return out


@router.get("/positions")
def positions():
    # live_positions is pre-bounded to the last 60 s, so PostgreSQL reads via
    # idx_position_time instead of sorting the whole append-only table.
    with get_pool().connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT * FROM live_positions "
                "WHERE recorded_at > NOW() - INTERVAL '60 seconds'")
            cols = [d[0] for d in cur.description]
            rows = []
            for r in cur.fetchall():
                d = dict(zip(cols, r, strict=True))
                if d.get("recorded_at") is not None:
                    d["recorded_at"] = d["recorded_at"].isoformat()
                rows.append(d)
            return rows
