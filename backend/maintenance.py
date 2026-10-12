"""Periodic retention pruning.

The ingest loop appends hundreds of fixes per second, so without pruning the
demo database reaches hundreds of millions of rows and every time-windowed
query degrades. Runs in the background: prune, then VACUUM ANALYZE the hot
append-only tables so the space is actually reclaimed.
"""
from __future__ import annotations

import asyncio

from . import querylog
from .database import get_pool

EVERY_SEC = 300
POSITIONS_MINUTES = 90
HISTORY_HOURS = 12


def prune_once() -> dict:
    t0 = asyncio.get_event_loop().time()
    with get_pool().connection() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM prune_old_data(%s, %s)",
                        (POSITIONS_MINUTES, HISTORY_HOURS))
            row = cur.fetchone() or (0, 0, 0)
            cur.execute("SELECT vacuum_hot_tables()")
    ms = (asyncio.get_event_loop().time() - t0) * 1000
    out = {"deleted_gps": int(row[0]), "deleted_position": int(row[1]),
           "deleted_history": int(row[2]), "ms": round(ms, 1)}
    querylog.log("MAINT", "SELECT prune_old_data(90min, 12h); SELECT vacuum_hot_tables()",
                 ms, f"gps -{out['deleted_gps']}, pos -{out['deleted_position']}, "
                     f"hist -{out['deleted_history']}")
    return out


async def run_forever() -> None:
    # Let the demo fill with traffic before the first prune.
    await asyncio.sleep(120)
    while True:
        try:
            await asyncio.to_thread(prune_once)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 — maintenance must never take API down
            pass
        await asyncio.sleep(EVERY_SEC)