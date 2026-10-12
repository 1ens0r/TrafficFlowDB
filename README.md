# TrafficFlowDB

**Real-time traffic intelligence on a relational database — across India.**
Vehicles drive real origin→destination trips, stream GPS into PostgreSQL, the
database scores congestion per segment, and Dijkstra reroutes around it.
You can spawn fleets, inject jams, rewrite the congestion rulebook live —
and query the database yourself in the SQL Lab while every query streams
through the Under-the-hood terminal.

> One-line pitch: a real-time traffic intelligence system in which a relational
> database acts as the central layer for collecting, managing, analyzing, and serving
> continuously changing transportation data.

Live network: **32 national highway hubs, 42 trunk corridors** — one connected
graph, so `Delhi → Kochi` (3,570 km) routes in a single query. Speeds come from
**live TomTom Traffic API** data, falling back to an optional simulated fleet.

### What is real, and what is not

This distinction matters more than any feature, so it is stated up front:

| | Source | Status |
|---|---|---|
| **Corridor speeds** | TomTom Flow Segment Data | **Real.** Measured `currentSpeed` / `freeFlowSpeed`, refreshed every 240 s |
| **Congestion level** | Derived from those speeds | **Real.** Classified on the observed slow-down ratio |
| **Traffic incidents** | TomTom Incident API | **Real.** Actual events with true coordinates |
| **Route ETAs** | Dijkstra over real speeds | **Real** |
| **Vehicle counts** | — | **Not available.** TomTom publishes no vehicle counts or GPS traces |
| **Moving dots on the map** | Interpolated along corridors | **Illustrative.** Dots move at the *real* reported speed, but positions are interpolated — see §7 |

No public API exposes individual probe vehicles; they are licensed exclusively.
Anything claiming otherwise is either a simulation or scraping a consumer app.

---

## 1. Requirements

| Layer    | Requirement                                              |
|----------|----------------------------------------------------------|
| OS       | Linux (developed on Ubuntu), Docker 24+                  |
| Database | PostgreSQL 16 + PostGIS (provided via `docker-compose`) |
| Backend  | Python 3.12+ · FastAPI · Uvicorn · psycopg 3            |
| Frontend | Any modern browser (Leaflet + OSM tiles via CDN)         |
| Tests    | pytest                                                   |

Pinned in `requirements.txt`. No Node/build step — dependency-free vanilla HTML/CSS/JS.

## 2. Quickstart

```bash
docker compose up -d
# open http://localhost:8000  (?theme=dark for dark mode)
```

Everything ships in one command — the API image builds and boots against the
database, applies migrations, calibrates vendor probe points and starts
polling. The dashboard works immediately with live data; nothing else to run.

**TomTom API key.** Copy the example and paste your key (free dev tier):

```bash
cp .env.example .env && chmod 600 .env
# edit .env -> TOMTOM_API_KEY=<your key>
docker compose up -d
```

`.env` is git-ignored and never committed. Leave the key empty to run
fleet-only.

Optional GPS ingest simulator (off by default — the map runs on real data):
open the **Customize** drawer → *GPS ingest simulator*.

Config: `DATABASE_URL`, `TRAFFIC_WINDOW_MINUTES`, `POLL_SECONDS`,
`TOMTOM_INTERVAL_SEC`, `TOMTOM_BATCH_SIZE`, `TOMTOM_DAILY_BUDGET`
(see `.env.example`; the live pipeline knobs are also tunable via
`PUT /api/config` / the Customize drawer).

## 2.1 Staying inside the free tier

TomTom's free tier allows ~2,500 transactions/day, and the vendor is billed per
request — so an unguarded poller on 42 corridors burns the quota in minutes.
Four controls keep it safe, all live-tunable via **Customize → Real-time TomTom**:

1. **Round-robin batching** — each cycle touches only `TOMTOM_BATCH_SIZE`
   corridors, oldest reading first, so coverage is fair and never spikes.
2. **Daily budget ledger** — `tomtom_usage` counts every request made; the
   poller stops at `TOMTOM_DAILY_BUDGET` and reports `budget_exhausted`
   instead of silently overspending.
3. **One transaction per corridor** — probe points are calibrated *once* at
   startup (a corridor's straight-line midpoint is often off-road, which
   TomTom rejects with HTTP 400) and persisted, so no poll ever wastes a call.
4. **Tiled incidents** — TomTom caps `bbox` at 10,000 km², so incidents are
   swept one hub per cycle instead of an all-India query that always fails.

Default `240 s × 4` projects to **~1,200 calls/day**, leaving headroom for
manual refreshes. `GET /api/tomtom/status` reports live spend, coverage and
poller health; the dashboard's **API monitor** panel shows the same figures.

## 3. Architecture

```
TomTom Traffic API ──► poller (budget-capped, round-robin)
    └─► tomtom_reading / tomtom_history / tomtom_incident
            └─► refresh_all_traffic()  ← vendor speed wins when fresh
                    └─► traffic_condition (snapshot) + traffic_history (trend)
                        └─► Dijkstra on travel-time weights → route + route_segment
                            └─► REST + WebSocket /ws/live (traffic, incidents, query log)
                                └─► dashboard: analytics, map, SQL Lab, API monitor

(optional) simulated fleet → POST /api/gps/batch → same pipeline, used only
where no vendor reading is fresh
```

`intersection` rows are nodes, `road_segment` rows are bidirectional edges.
Bulk ingest keeps round trips constant per batch:
**~3,000+ fixes/sec** measured (250-fix batch in ~60 ms).

Vendor readings are cached, never polled synchronously: the API never blocks
on TomTom, so a vendor outage degrades coverage instead of the service.

## 4. Traffic sources

**Primary — live vendor data.** Each cycle the poller samples a few corridors,
writes the measured speed to `tomtom_reading`, appends to `tomtom_history`,
and recomputes the snapshot. A fresh vendor reading is authoritative: it
overrides the fleet average and sets the congestion level from the observed
slow-down ratio. This is the data you see by default.

**Secondary — optional simulator.** For demonstrating the raw GPS ingest path,
the built-in fleet doesn't random-walk — each one picks a destination (national-biased,
like real intercity flow), follows the Dijkstra shortest-time path, and
re-plans on arrival:

- **Density-aware speed**: target speed folds in live segment load
  (`1 − density × 0.6`), eased toward — jams propagate organically.
- **Driver personalities**: per-vehicle aggression factor × type factor
  (bus 0.85, emergency 1.3 and congestion-immune).
- **Bus dwell**: buses pause 1–3 ticks at nodes (stops) with 40% probability.
- **Capacity-weighted spawn**: big corridors naturally carry more flow.

With ~250 vehicles the busy corridors start jamming on their own — no scripted
congestion. It is off by default because real vendor data is better.

## 5. Database design (the core)

**Entities (3NF):** `users` (+`admin_profile`, `driver_profile`) ·
`vehicle` (+`car_detail`, `bus_detail`, `emergency_vehicle_detail`) ·
`intersection` · `road_segment` · `gps_data` (append-only) ·
`vehicle_position` (map-matched) · `traffic_condition` (one live row/segment) ·
`traffic_history` (trend) · `traffic_thresholds` (live rulebook singleton) ·
`tomtom_reading` · `tomtom_history` · `tomtom_incident` · `tomtom_usage`
(vendor spend ledger) · `tomtom_config` (persisted poll settings) ·
`route_request` → `route` → `route_segment`.

**EER:** `VEHICLE → CAR / BUS / EMERGENCY_VEHICLE`, `USER → ADMIN / DRIVER`.

**DBMS features:** btree + BRIN time/segment/congestion indexes · views
(`live_traffic_summary`, `congested_segments`, `live_positions`,
`latest_positions`, `segment_stats_5min`, `tomtom_segment_traffic`,
`tomtom_coverage`) · triggers (GPS validation, `last_seen`, route guard,
`pg_notify` on congestion change) · procedures (`calculate_segment_traffic`,
`refresh_all_traffic`, `get_congested_segments`, `find_nearby_segments`,
`prune_old_data`, `set_segment_probe`) · a SELECT-only `traffic_ro` role
provisioned at boot for the SQL Lab.

Files: `database/schema.sql`, `views.sql`, `triggers.sql`, `procedures.sql`,
`migrate_india.sql`, `migrate_all_india.sql`, `migrate_tomtom.sql`,
`migrate_probes.sql`, `migrate_more_corridors.sql`, `migrate_perf.sql`,
`migrate_tomtom_traffic.sql` — applied in order by `init_db()`. All are
idempotent and re-run safely on every boot.

**Retention:** positions 90 min, history 12 h (`prune_old_data`, run on a
timer). Append-only tables are BRIN-indexed and read through `live_positions`,
a 60 s-bounded view, so the hot path never sorts history.

## 6. Congestion rule

Two rules, and which one applies is recorded per row in
`traffic_condition.traffic_source`.

**Vendor-backed corridors** (`traffic_source = 'tomtom'`) — classified on the
observed slow-down, where `free-flow` is TomTom's own estimate for the road:

```
ratio        = currentSpeed / freeFlowSpeed      1 = free, 0 = stopped
traffic_index = 1 - ratio                        0 = free, 1 = jam
HIGH    if ratio < 0.25
MEDIUM  if ratio < 0.55
LOW     otherwise
```

**Fleet-backed corridors** — the original rule over ingested GPS, with
thresholds in `traffic_thresholds`, read by the procedure on every call:

```
density = distinct_vehicles / capacity
HIGH     if avg_speed < high_speed AND density > high_density   (15, 0.75)
MEDIUM   if avg_speed < med_speed  OR  density > med_density     (30, 0.50)
LOW      otherwise
```

A corridor drops back to the fleet rule once its vendor reading goes stale,
so the map never shows empty gaps and never shows a stale number as live.

## 7. Why the map's dots don't move at full zoom

A corridor is 100–1,000 km long. At a whole-of-India zoom, 250 km is roughly
150 px, so a vehicle doing 100 km/h advances about **0.02 px per frame** — the
motion is physically imperceptible, not broken. Real traffic products show
flow rather than individual cars at that scale for exactly this reason.

So the map is honest about scale:

- **Zoomed in (z ≥ 7)** — dots travel along the corridor at the **real
  reported speed**, so a jammed corridor visibly crawls while a free one
  whips past.
- **Country zoom** — direction-of-flow instead, rather than faking motion.

Positions are interpolated along corridor geometry because TomTom publishes
segment speeds, not vehicle traces. Requesting a route flies to z ≤ 9, where
that motion is visible. Everything is drawn on a single canvas in one
`requestAnimationFrame` pass, so it stays smooth at any zoom.

## 8. Routing

Dijkstra, weight = live travel time `w = distance / effective_speed × 60`.
Speed precedence: emergency `priority=true` uses the free-flow limit;
otherwise a fresh vendor reading wins, then the fleet-observed average, then
the limit derated by congestion multiplier (LOW 1.0 / MEDIUM 1.5 / HIGH 2.5).
Each leg reports `speed_source` so you can see which data set chose its ETA.
Requests persist `route_request → route → route_segment[]`.
Delhi → Mumbai (1,460 km, 4 legs) computes in ~0.05 ms. Every response also
carries a `comparison` block: the shortest-distance route's km + ETA next to
the fastest route's, plus `saved_min`, `extra_km`, and `same_route` — the
dashboard renders it as a Shortest-vs-Fastest card, so the demo can prove
"choose the fastest, not the shortest" in one number.

## 8. SQL Lab — query it yourself

Dashboard → SQL Lab: schema browser (33 tables & views) + editor
(`Ctrl K` focuses, `Ctrl ⏎` runs) + results grid. Triple-locked reads:

1. Parser allowlist — `SELECT`/`WITH` only, single statement, no stacking,
   no catalog snooping (`pg_*`, `version()`).
2. The `traffic_ro` role holds SELECT-only grants — even a smuggled write
   dies with `permission denied` (verified live).
3. `statement_timeout = 5 s` on the read-only pool; 200-row cap.

Recommended starter queries (one click each, all verified live):

1. **Congested right now** — live leaderboard from `live_traffic_summary`.
2. **Slowest trunk corridors** — where the highways are bleeding speed.
3. **Load by scope** — trunk segment/vehicle/speed rollup.
4. **Fleet mix, live** — car/bus/emergency counts + speeds from `latest_positions`.
5. **Fixes per minute (15 min)** — ingest firehose rate from `gps_data`.
6. **Hourly speed trend** — 12-hour network performance from `traffic_history`.
7. **Real vs simulated** — which corridors come from TomTom vs the fleet:
   `SELECT traffic_source, COUNT(*), ROUND(AVG(traffic_index)::numeric,3)
    FROM traffic_condition GROUP BY 1;`
8. **Vendor spend today** — `SELECT * FROM tomtom_usage;`

(`POST /api/command` NL console from v2 remains as an API extra.)

## 9. REST + WebSocket API

| Method | Endpoint                        | Purpose                                        |
|--------|---------------------------------|------------------------------------------------|
| GET    | `/api/health`                   | readiness                                      |
| POST   | `/api/gps` · `/api/gps/batch`   | ingest 1 fix / bulk batch (constant round trips) |
| GET    | `/api/network/*`                | intersections, segments (+scope), live positions |
| GET    | `/api/traffic/summary`          | live snapshot (drives map + table)             |
| GET    | `/api/traffic/congested?level=` | worst-first                                    |
| GET    | `/api/traffic/segment/{id}`     | snapshot + 60-pt history                       |
| POST   | `/api/traffic/refresh`          | recompute all segments                         |
| POST   | `/api/routes/request`           | `{source_id, destination_id, priority?}`       |
| GET    | `/api/routes/history`           | past recommendations                           |
| GET/PUT| `/api/config`                   | window, poll cadence, congestion thresholds    |
| GET/POST| `/api/fleet`                   | server fleet status / spawn-retire control     |
| POST   | `/api/scenarios/jam`            | inject N crawling vehicles on a segment        |
| POST   | `/api/scenarios/rush-hour`      | peak load on top-capacity corridors            |
| POST   | `/api/scenarios/reset`          | remove scenario vehicles, recompute            |
| GET/POST| `/api/sql/*`                   | schema, samples, read-only query runner        |
| GET    | `/api/logs?since=&limit=`       | live query-log ring buffer                     |
| GET    | `/api/tomtom/status`            | coverage, spend, poller health                 |
| GET    | `/api/tomtom/readings`          | per-corridor speed + map coordinates           |
| GET    | `/api/tomtom/incidents?limit=`  | positioned live traffic events                  |
| POST   | `/api/tomtom/refresh`           | force a poll (refuses at budget; `bbox` for incidents) |
| PUT    | `/api/tomtom/config`            | live cadence / batch / budget tuning           |
| GET    | `/api/analytics/overview`       | congestion split, network speed, vendor coverage |
| GET    | `/api/analytics/trends?hours=`  | speed trend, ingest and vendor coverage series |
| GET    | `/api/analytics/corridors`      | slowest + densest corridors                    |
| GET    | `/api/monitor?window_sec=`      | API p50/p95/p99, error rate, busiest endpoints |
| WS     | `/ws/live`                      | traffic + positions + log entries every tick   |

Docs: `:8000/docs`. The **Under the hood** terminal streams the query log
(SQL text + ms + context) with category filters, pause, and running averages —
a bounded in-memory ring, so logging never slows ingest.

## 10. Demo script

1. `cp .env.example .env`, paste your `TOMTOM_API_KEY`, then `docker compose up -d`
   → open `:8000`. Live vendor data starts flowing on its own.
2. **Live analytics** — watch corridor coverage climb and speeds settle onto
   real measured values. Open the **API monitor** for spend and latency.
3. `Route Delhi to Mumbai` — every leg is weighted by real speeds; the
   Shortest-vs-Fastest card shows the trade-off in one number.
4. Zoom into the route: traffic dots now move at the corridors' real speeds,
   and the jam slows down visibly.
5. SQL Lab → run **Congested right now** — your own query, live rows, and you
   can see `traffic_source` proving which rows came from TomTom.
6. Toggle **Incidents** on the map for real jams and closures with true
   coordinates.

No simulated traffic is needed at any point; the fleet is optional and off.

## 11. Metrics (measured)

Bulk ingest **~3,000 fixes/s** (250-fix batch ≈ 60 ms, 1 refresh) ·
stats ~3–7 ms under load · Dijkstra 32 nodes/42 edges ~0.05 ms ·
API p50 ~4 ms · p95 ~13 ms · 0 errors (live) · dashboard tick 2 s (WS push + poll fallback).

## 12. Layout

```
backend/   main, database pool (+read-only role), runtime config, querylog,
           monitor (request timing), maintenance (retention), schemas,
           routes/ (gps, network, traffic, routing, vehicles, stats, config,
           fleet, scenarios, command, sql, logs, tomtom, analytics)
           services/ (geo, gps_processor, ingest_bulk, traffic_analyzer,
           route_optimizer, scenarios, command, sqllab, tomtom poller)
simulator/ OD-trip fleet (Vehicle mover, build_graph/plan_trip),
           vehicle_simulator.py (CLI), fleet.py (server FleetManager)
frontend/  glass dashboard: index.html, styles.css, app.js (Leaflet)
database/  schema, views, triggers, procedures, India network migrations,
           TomTom tables + probe calibration, perf (BRIN/live view/pruning)
tests/     47 pytest tests: geo, congestion rules, Dijkstra, console parser, SQL guard, vendor poller
```

## 13. Testing

```bash
pytest tests -q   # 47 passed: Haversine/map-match, classifier boundaries,
                  # Dijkstra (avoidance, priority, unreachable, totals),
                  # console parser, SQL Lab guard (writes/stacking/catalog blocked,
                  # all 6 samples valid), vendor poller guards + speed precedence
```

## 14. Methodology (for the report)

Requirement analysis → conceptual design (ER/EER: 10 entities, 2 specializations) →
logical design → 3NF (positions reference segments; snapshot/history split;
thresholds factored out; SELECT-only role separation) → physical design (PK/FK/checks,
indexes, views, triggers, procedures) → implementation (DB → bulk API → OD fleet →
analyzer → router → dashboard) → verification (live E2E: spawn → density jam →
red map → reroute → your own SQL confirms it).
