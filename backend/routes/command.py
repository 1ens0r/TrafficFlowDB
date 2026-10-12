"""POST /api/command — the dashboard console's brain.

Parses free text (backend/services/command.py, pure + tested) and executes
the action by reusing the real route handlers, so console results are
identical to UI results.
"""
import time

from fastapi import APIRouter
from pydantic import BaseModel

from .. import querylog
from ..database import get_pool
from ..schemas import RouteRequestIn
from ..services.command import interpret
from .routing import request_route
from .stats import overview

router = APIRouter(prefix="/api/command", tags=["command"])

EXAMPLES = [
    "Route Delhi to Mumbai",
    "Route Mumbai to Chennai",
    "Kolkata to Guwahati",
    "Traffic on NH48",
    "Where is it jammed?",
    "Jam NH44",
    "Rush hour",
    "Stats",
    "Reset",
]


class CommandIn(BaseModel):
    text: str


def _nodes() -> list[dict]:
    with get_pool().connection() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT intersection_id, name FROM intersection")
            return [{"id": r[0], "name": r[1]} for r in cur.fetchall()]


@router.get("/examples")
def examples():
    return {"examples": EXAMPLES}


@router.post("")
def run_command(body: CommandIn):
    t0 = time.perf_counter()
    action = interpret(body.text, _nodes())
    kind = action["action"]
    try:
        if kind == "route":
            result = request_route(RouteRequestIn(
                source_id=action["src"]["id"],
                destination_id=action["dst"]["id"]))
        elif kind == "congested":
            with get_pool().connection() as conn:
                with conn.cursor() as cur:
                    cur.execute("SELECT * FROM get_congested_segments('MEDIUM')")
                    cols = [d[0] for d in cur.description]
                    result = [dict(zip(cols, r, strict=True)) for r in cur.fetchall()]
        elif kind == "stats":
            result = overview()
        elif kind == "traffic_request":
            with get_pool().connection() as conn:
                cur = conn.cursor()
                cur.execute(
                    """
                    SELECT rs.segment_id, rs.segment_name
                    FROM road_segment rs
                    WHERE rs.is_active AND rs.segment_name ILIKE %s
                    LIMIT 8
                    """, (f"%{action['query']}%",))
                ids = [r[0] for r in cur.fetchall()]
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT * FROM live_traffic_summary WHERE segment_id = ANY(%s)",
                        (ids or [-1],))
                    cols = [d[0] for d in cur.description]
                    result = [dict(zip(cols, r, strict=True)) for r in cur.fetchall()]
        elif kind in ("jam_request", "reset"):
            # Simulation was removed: the system reports measured traffic and
            # never injects fabricated vehicles.
            result = {"error": "simulation removed — this system reports "
                               "measured traffic only",
                      "examples": EXAMPLES}
        elif kind in ("clarify_route", "place"):
            result = action
        elif kind == "help":
            result = {"examples": EXAMPLES}
        else:
            result = {"error": f"didn't understand {body.text!r}",
                      "examples": EXAMPLES}
    except LookupError as exc:
        result = {"error": str(exc), "examples": EXAMPLES}
    ms = (time.perf_counter() - t0) * 1000
    querylog.log("CMD", f"console: {body.text[:80]!r}", ms, f"→ {kind}")
    for row in result if isinstance(result, list) else []:
        for k, v in row.items():
            if hasattr(v, "isoformat"):
                row[k] = v.isoformat()
    return {"action": kind, "result": result}
