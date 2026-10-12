"""API performance + vendor-usage monitor.

Middleware times every request in-process (cheap, no DB write on the hot
path) and keeps a bounded window so /api/monitor can report real p50/p95
latency, error rate and throughput alongside TomTom budget usage.
"""
from __future__ import annotations

import threading
import time
from collections import deque

WINDOW = 600
_lock = threading.Lock()
_samples: deque[dict] = deque(maxlen=WINDOW)
_started = time.time()
_counters = {"requests": 0, "errors": 0, "total_ms": 0.0, "slowest": 0.0}


def record(path: str, method: str, ms: float, status: int) -> None:
    with _lock:
        _samples.append({"t": time.time(), "ms": ms, "status": status,
                         "path": path, "method": method})
        _counters["requests"] += 1
        _counters["total_ms"] += ms
        if status >= 500:
            _counters["errors"] += 1
        if ms > _counters["slowest"]:
            _counters["slowest"] = ms


def _pct(sorted_vals: list[float], p: float) -> float:
    if not sorted_vals:
        return 0.0
    idx = min(len(sorted_vals) - 1, int(round((p / 100) * (len(sorted_vals) - 1))))
    return sorted_vals[idx]


def report(window_sec: int = 300) -> dict:
    now = time.time()
    with _lock:
        items = list(_samples)
        counters = dict(_counters)
        started = _started
    window_sec = max(10, min(window_sec, 3600))
    recent = [s for s in items if s["t"] > now - window_sec]
    lat = sorted(s["ms"] for s in recent)
    by_group: dict[str, dict] = {}
    for s in items:
        g = s["path"].split("?")[0]
        # collapse numeric ids so /segment/20 and /segment/45 group together
        key = "/".join(":id" if p.isdigit() else p for p in g.split("/"))
        agg = by_group.setdefault(key, {"endpoint": key, "calls": 0,
                                        "total_ms": 0.0, "errors": 0})
        agg["calls"] += 1
        agg["total_ms"] += s["ms"]
        if s["status"] >= 400:
            agg["errors"] += 1
    endpoints = sorted(
        ({"endpoint": a["endpoint"], "calls": a["calls"],
          "avg_ms": round(a["total_ms"] / a["calls"], 2),
          "errors": a["errors"]}
         for a in by_group.values()),
        key=lambda x: -x["calls"])[:10]
    return {
        "uptime_sec": round(now - started, 1),
        "window_sec": window_sec,
        "requests_total": counters["requests"],
        "requests_in_window": len(recent),
        "errors_total": counters["errors"],
        "error_rate_pct": round(
            100.0 * counters["errors"] / counters["requests"], 3
        ) if counters["requests"] else 0.0,
        "avg_ms": round(counters["total_ms"] / counters["requests"], 2)
        if counters["requests"] else 0.0,
        "p50_ms": round(_pct(lat, 50), 2),
        "p95_ms": round(_pct(lat, 95), 2),
        "p99_ms": round(_pct(lat, 99), 2),
        "max_ms": round(counters["slowest"], 2),
        "throughput_rps": round(len(recent) / window_sec, 3),
        "endpoints": endpoints,
    }