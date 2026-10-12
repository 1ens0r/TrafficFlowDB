"""TrafficFlowDB API — FastAPI entrypoint.

Serves REST + WebSocket on /api and the static dashboard on /.
Run:  uvicorn backend.main:app --reload
"""
from __future__ import annotations

import asyncio
import json
import pathlib
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from . import maintenance, monitor, querylog, runtime
from .config import settings
from .database import close_pool, get_pool, init_db, wait_for_db
from .routes import analytics, command, config, fleet, gps, logs, network, routing, scenarios, sql, stats, tomtom, traffic, vehicles

FRONTEND_DIR = pathlib.Path(__file__).resolve().parent.parent / "frontend"
ASSET_VERSION = str(int(time.time()))


@asynccontextmanager
async def lifespan(app: FastAPI):
    from simulator.fleet import FleetManager
    from backend.services import tomtom as tomtom_svc
    wait_for_db()
    init_db()
    querylog.log("NET", "lifespan: schema + seed + migrations applied", 0,
                 "API ready")
    app.state.fleet = FleetManager()
    app.state.fleet.start()
    app.state.tomtom_task = asyncio.create_task(tomtom_svc.run_forever())
    app.state.maint_task = asyncio.create_task(maintenance.run_forever())
    yield
    for task in (app.state.tomtom_task, app.state.maint_task):
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
    await app.state.fleet.stop()
    close_pool()


app = FastAPI(title="TrafficFlowDB", version="3.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def perf_and_cache(request: Request, call_next):
    """Time every request for /api/monitor and keep dashboard assets fresh.

    Static assets get no-store so a cached index.html can never be paired
    with a newer app.js (that mismatch previously blanked the whole page).
    """
    t0 = time.perf_counter()
    response = await call_next(request)
    ms = (time.perf_counter() - t0) * 1000
    path = request.url.path
    if not path.startswith("/ws"):
        monitor.record(path, request.method, ms, response.status_code)
    if not path.startswith("/api") and response.status_code < 400:
        response.headers["Cache-Control"] = "no-store, max-age=0"
    return response

for router in (gps.router, vehicles.router, traffic.router,
               network.router, routing.router, stats.router,
               config.router, scenarios.router, command.router, logs.router,
               fleet.router, sql.router, tomtom.router, analytics.router):
    app.include_router(router)


@app.get("/api/health")
def health():
    with get_pool().connection() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT 1")
    return {"status": "ok", "asset_version": ASSET_VERSION}


@app.get("/api/monitor")
def api_monitor(window_sec: int = 300):
    """API performance + vendor usage (one call, powers the dashboard panel)."""
    return {"performance": monitor.report(window_sec), "tomtom": tomtom_status_slim()}


def tomtom_status_slim() -> dict:
    from .services import tomtom as _tt
    return _tt.status()


def _jsonable(rows: list[dict]) -> list[dict]:
    for row in rows:
        for k, v in row.items():
            if hasattr(v, "isoformat"):
                row[k] = v.isoformat()
    return rows


@app.websocket("/ws/live")
async def live(ws: WebSocket):
    """Push traffic + positions + fresh query-log entries every poll tick."""
    await ws.accept()
    try:
        while True:
            with get_pool().connection() as conn:
                with conn.cursor() as cur:
                    cur.execute("SELECT * FROM live_traffic_summary ORDER BY segment_id")
                    cols = [d[0] for d in cur.description]
                    traffic_rows = _jsonable(
                        [dict(zip(cols, r, strict=True)) for r in cur.fetchall()])
                    cur.execute("SELECT * FROM live_positions")
                    pcols = [d[0] for d in cur.description]
                    pos_rows = _jsonable(
                        [dict(zip(pcols, r, strict=True)) for r in cur.fetchall()])
            await ws.send_text(json.dumps({
                "traffic": traffic_rows,
                "positions": pos_rows,
                "logs": querylog.snapshot(limit=25),
            }))
            await asyncio.sleep(runtime.get("poll_seconds"))
    except WebSocketDisconnect:
        pass


# Static dashboard (mounted last so /api routes win).
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
