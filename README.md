# trafficflowdb

a relational traffic-intelligence system that ingests live vendor observations,
classifies congestion per road segment, and solves traffic-aware routing over
india's national highway network. the database is the authoritative layer for
collection, classification, retention and serving; every consumer — rest, a
websocket, and a browser dashboard — reads the same derived state.

corridor speeds, congestion levels, road incidents and route estimates are
derived from **live TomTom Traffic API** measurements. no synthetic traffic is
required at any point. see §1 for an explicit statement of which quantities are
measured and which are inferred.

network: **32 national highway hubs, 42 bidirectional trunk corridors**, one
connected graph, permitting single-query routing across the full subcontinent
(`delhi → kochi`, 3,570 km, solved in approximately 0.05 ms).

---

## 1. data provenance

the following table is normative. any claim not represented here is inferred,
not measured.

| quantity | source | status |
|----------|--------|--------|
| corridor speed | TomTom Flow Segment Data (`currentSpeed`, `freeFlowSpeed`) | **measured** — refreshed every 240 s |
| congestion level | derived from measured slow-down ratio | **measured** — see §5 |
| traffic incidents | TomTom Incident API | **measured** — genuine coordinates |
| travel time, distance | dijkstra over measured edge weights | **measured** |
| vehicle counts | — | **unavailable** — tomtom publishes neither counts nor probe traces |
| map dot position | interpolated along corridor geometry | **inferred** — see §6 |

individual probe vehicles are licenced exclusively by their operators and are
not redistributable through any public interface. any implementation purporting
to expose them is either simulating them or scraping a consumer client.

---

## 2. requirements

| layer    | requirement                                                    |
|----------|----------------------------------------------------------------|
| os       | linux (developed on ubuntu), docker 24 or later                 |
| database | postgresql 16 with postgis, provisioned by `docker compose`     |
| backend  | python 3.12 or later · fastapi · uvicorn · psycopg 3            |
| frontend | any modern browser · leaflet with keyless osm tiles             |
| tests    | pytest 8                                                       |

all python dependencies are pinned in `requirements.txt`. there is no
javascript build step; the frontend is dependency-free vanilla html, css and
javascript.

## 3. deployment

```bash
cp .env.example .env && chmod 600 .env
# populate TOMTOM_API_KEY in .env
docker compose up -d
```

this single command builds the api image, starts postgres, applies the schema
and every migration in dependency order, calibrates vendor probe points, and
begins polling. the dashboard is serviceable immediately at `localhost:8000`;
no additional process is required. `?theme=dark` selects the dark palette.

`.env` is git-ignored and is never committed. the API operates in a degraded,
fleet-free mode when the key is absent.

### 3.1 transactional cost containment

the tomtom free tier permits approximately 2,500 transactions per day and bills
per request. an unconstrained poller across 42 corridors exhausts that quota in
under two hours. four mechanisms bound consumption:

1. **round-robin batching** — each cycle requests only `TOMTOM_BATCH_SIZE`
   corridors, ordered by oldest reading, guaranteeing uniform coverage without
   burst behaviour.
2. **daily budget ledger** — the `tomtom_usage` table records every request
   issued. the poller halts at `TOMTOM_DAILY_BUDGET` and reports
   `budget_exhausted` rather than silently overspending.
3. **single-transaction corridors** — probe points are calibrated once during
   startup, because a corridor's straight-line midpoint frequently lies off the
   physical road and is rejected with http 400. subsequent polls therefore cost
   exactly one transaction at a known-valid coordinate.
4. **tiled incident sweep** — tomtom rejects bounding boxes exceeding 10,000 km²,
   so incidents are swept one hub per cycle on rotation rather than as a single
   all-india query, which always fails.

the default `240 s × 4` configuration projects to approximately **1,200
transactions per day**, preserving headroom for manual refreshes.
`GET /api/tomtom/status` reports live spend, coverage and poller health; the
dashboard's **api monitor** panel renders the same figures.

### 3.2 configuration

| variable                | default | purpose                                        |
|-------------------------|---------|------------------------------------------------|
| `DATABASE_URL`          | local   | postgres connection string                     |
| `TRAFFIC_WINDOW_MINUTES`| `5`     | rolling analysis window                        |
| `POLL_SECONDS`          | `2`     | dashboard refresh cadence                      |
| `TOMTOM_API_KEY`        | empty   | vendor credential; empty disables vendor polling |
| `TOMTOM_INTERVAL_SEC`   | `240`   | poll cadence                                   |
| `TOMTOM_BATCH_SIZE`     | `4`     | corridors per cycle                            |
| `TOMTOM_DAILY_BUDGET`   | `2000`  | hard daily transaction ceiling                 |

poll settings persist to `tomtom_config` and survive restart and redeployment.
`PUT /api/tomtom/config` adjusts them at runtime; `PUT /api/config` adjusts the
analysis window and dashboard cadence. congestion thresholds remain editable
through `PUT /api/config` or directly in the sql lab, as they reside in the
database.

---

## 4. architecture

```
tomtom traffic api ──► poller (budget-capped, round-robin)
    └─► tomtom_reading · tomtom_history · tomtom_incident · tomtom_usage
            └─► refresh_all_traffic()      ← vendor speed authoritative when fresh
                    └─► traffic_condition (live snapshot) · traffic_history (trend)
                        └─► dijkstra on travel-time weights → route → route_segment
                            └─► rest + websocket /ws/live
                                └─► dashboard: analytics · map · sql lab · api monitor
```

the design inverts the conventional dependency direction: the vendor is polled
asynchronously and cached, and the rest api never blocks on an upstream call. a
vendor outage therefore degrades coverage rather than availability.

`intersection` rows are graph nodes; `road_segment` rows are bidirectional edges.
optional GPS ingest, when enabled, follows the identical downstream path and is
the only producer of `gps_data`; it is not required for operation.

bulk ingest maintains a constant round-trip count irrespective of batch size:
one vehicle upsert, two bulk inserts, and a single `refresh_all_traffic()` call.
measured throughput is **approximately 3,000 fixes per second** at 250 fixes per
batch in 60 ms.

---

## 5. congestion classification

two rules apply, and the applicable rule is recorded per row in
`traffic_condition.traffic_source`.

**vendor-backed corridors** (`traffic_source = 'tomtom'`) — classification is
derived from observed slow-down, where free-flow is tomtom's own estimate for
the road:

```
ratio         = currentSpeed / freeFlowSpeed        1 = free-flowing, 0 = stopped
traffic_index = 1 - ratio                          0 = free-flowing, 1 = standstill

HIGH     ratio < 0.25
MEDIUM   ratio < 0.55
LOW      otherwise
```

**gps-backed corridors** — the original rule over ingested positions, with
thresholds held in the `traffic_thresholds` singleton and read by the stored
procedure on every invocation:

```
density = distinct_vehicles / capacity

HIGH     avg_speed < high_speed   AND density > high_density      (15, 0.75)
MEDIUM   avg_speed < med_speed    OR  density > med_density       (30, 0.50)
LOW      otherwise
```

a corridor reverts to the second rule once its vendor reading exceeds the
freshness window, so the system exhibits neither coverage gaps nor stale values
presented as current.

---

## 6. rendering scale: why vehicles do not visibly move at national zoom

this is a property of scale, not a defect. corridors span 100 to 1,000 km. at a
whole-of-india viewport, 250 km occupies roughly 150 pixels, so a vehicle
travelling at 100 km/h advances approximately **0.02 pixels per frame** — the
motion is physically imperceptible. production traffic systems display flow
rather than individual vehicles at this scale for precisely this reason.

the map is therefore explicit about resolution:

- **z ≥ 7** — dots traverse the corridor at the **measured** speed, so a
  congested corridor visibly decelerates while a free-flowing one advances
  rapidly.
- **below z 7** — direction-of-flow is rendered instead, rather than
  simulating motion that does not exist at that scale.

positions are interpolated along corridor geometry because tomtom publishes
segment speeds rather than vehicle traces. requesting a route flies the viewport
to z ≤ 9, where the motion is resolvable. all overlays are composited on a single
canvas within one `requestAnimationFrame` pass, sustaining frame rate at any
zoom level.

---

## 7. routing

weights are `w = distance_km / effective_speed × 60`. speed precedence is:
emergency `priority=true` resolves to the free-flow limit; otherwise a fresh
vendor reading is selected, then the observed fleet average, then the limit
derated by the congestion multiplier (low 1.0 / medium 1.5 / high 2.5). each leg
reports `speed_source`, making the provenance of every estimate inspectable.

requests persist as `route_request → route → route_segment[]`. `delhi → mumbai`
(1,460 km, four legs) resolves in approximately 0.05 ms. every response carries a
`comparison` block containing the shortest-distance route's distance and
estimate alongside the fastest route's, with `saved_min`, `extra_km` and
`same_route`, which the dashboard renders as a shortest-versus-fastest card —
demonstrating that time-optimality and distance-optimality are distinct
objectives.

---

## 8. sql lab

the dashboard exposes a read-only query interface: a schema browser, an editor
(`ctrl k` to focus, `ctrl ⏎` to execute) and a results grid.

access is constrained at three independent layers:

1. **parser allowlist** — `SELECT` and `WITH` only; single statement; no
   statement stacking; no catalog introspection (`pg_*`, `version()`).
2. **least-privilege role** — a `traffic_ro` role holding `SELECT`-only grants.
   a smuggled write terminates with `permission denied` irrespective of layer 1.
3. **resource bounds** — `statement_timeout = 5000` on the read-only pool and a
   200-row response cap.

recommended queries, all verified against live data:

1. **congested right now** — live leaderboard from `live_traffic_summary`
2. **slowest trunk corridors** — where the network is losing the most speed
3. **load by scope** — segment, vehicle and speed rollup
4. **real vs. inferred** — provenance split:
   `SELECT traffic_source, COUNT(*) FROM traffic_condition GROUP BY 1`
5. **vendor spend to date** — `SELECT * FROM tomtom_usage`
6. **ingest rate** — fixes per minute from `gps_data`
7. **hourly speed trend** — network performance from `traffic_history`

`POST /api/command` remains available as a natural-language interface.

---

## 9. rest and websocket interface

| method     | endpoint                        | function                                  |
|------------|---------------------------------|-------------------------------------------|
| get        | `/api/health`                   | readiness probe                           |
| post       | `/api/gps` · `/api/gps/batch`   | ingest single or bulk fixes               |
| get        | `/api/network/*`                | intersections, segments, live positions   |
| get        | `/api/traffic/summary`          | live snapshot; drives map and table       |
| get        | `/api/traffic/congested?level=` | worst-first ordering                      |
| get        | `/api/traffic/segment/{id}`     | snapshot plus history                     |
| post       | `/api/traffic/refresh`          | recompute all segments                    |
| post       | `/api/routes/request`           | `{source_id, destination_id, priority?}`  |
| get        | `/api/routes/history`           | prior recommendations                     |
| get / put  | `/api/config`                   | window, cadence, congestion thresholds    |
| get / post | `/api/sql/*`                    | schema, samples, read-only query runner   |
| get        | `/api/logs?since=&limit=`       | query-log ring buffer                     |
| get        | `/api/tomtom/status`            | coverage, spend, poller health            |
| get        | `/api/tomtom/readings`          | per-corridor speed with coordinates       |
| get        | `/api/tomtom/incidents?limit=`  | positioned live events                    |
| post       | `/api/tomtom/refresh`           | force a poll; refuses at budget ceiling   |
| put        | `/api/tomtom/config`            | runtime cadence, batch and budget tuning  |
| get        | `/api/analytics/overview`       | congestion split, network speed, coverage |
| get        | `/api/analytics/trends?hours=`  | speed, ingest and coverage series         |
| get        | `/api/analytics/corridors`      | slowest and densest corridors             |
| get        | `/api/monitor?window_sec=`      | p50/p95/p99, error rate, hot endpoints    |
| ws         | `/ws/live`                      | traffic, positions and log entries per tick |

openapi documentation is served at `/docs`.

---

## 10. database design

**entities (3nf):** `users` (+ `admin_profile`, `driver_profile`) · `vehicle` (+
`car_detail`, `bus_detail`, `emergency_vehicle_detail`) · `intersection` ·
`road_segment` · `gps_data` (append-only) · `vehicle_position` (map-matched) ·
`traffic_condition` (one live row per segment) · `traffic_history` (trend) ·
`traffic_thresholds` (rulebook singleton) · `tomtom_reading` · `tomtom_history` ·
`tomtom_incident` · `tomtom_usage` (spend ledger) · `tomtom_config` ·
`route_request → route → route_segment`.

**eer:** `vehicle → car / bus / emergency_vehicle`, `user → admin / driver`;
two disjoint total specializations.

**dbms features:** btree and brin indexes over time, segment and congestion ·
views (`live_traffic_summary`, `congested_segments`, `live_positions`,
`latest_positions`, `segment_stats_5min`, `tomtom_segment_traffic`,
`tomtom_coverage`) · triggers (gps validation, `last_seen` maintenance, route
guard, `pg_notify` on congestion transition) · procedures
(`calculate_segment_traffic`, `refresh_all_traffic`, `get_congested_segments`,
`find_nearby_segments`, `prune_old_data`, `set_segment_probe`) · a select-only
`traffic_ro` role provisioned at boot for the sql lab.

**files:** `database/schema.sql`, `views.sql`, `triggers.sql`, `procedures.sql`,
`migrate_india.sql`, `migrate_all_india.sql`, `migrate_tomtom.sql`,
`migrate_probes.sql`, `migrate_more_corridors.sql`, `migrate_perf.sql`,
`migrate_tomtom_traffic.sql` — applied in dependency order by `init_db()`. every
file is idempotent and re-executes safely on each boot.

**retention:** positions are truncated at 90 minutes and history at 12 hours by
`prune_old_data`, executed on a background timer. append-only tables are brin
indexed and accessed through `live_positions`, a 60-second-bounded view, so the
hot path never performs a sort over history. without this the table grows at
approximately 1.8M history rows per hour and latency grows without bound.

---

## 11. measured performance

| metric                            | value                              |
|-----------------------------------|------------------------------------|
| bulk ingest throughput            | ~3,000 fixes/s (250 in ~60 ms)     |
| `/api/network/positions`          | ~8 ms (was ~100 ms pre-indexing)   |
| analytics rollups                 | ~3–7 ms                            |
| dijkstra, 32 nodes / 42 edges     | ~0.05 ms                           |
| api latency                       | p50 ~2 ms · p95 ~10 ms · 0 errors  |
| dashboard refresh                 | 2 s, websocket with http fallback  |
| vendor coverage                   | 40 / 42 corridors                  |
| projected vendor spend            | ~1,200 transactions/day            |

---

## 12. repository layout

```
backend/     main, database pool with read-only role, runtime config,
             querylog, monitor (request timing), maintenance (retention),
             routes/ (gps, network, traffic, routing, vehicles, stats, config,
             scenarios, command, sql, logs, fleet, tomtom, analytics)
             services/ (geo, gps_processor, ingest_bulk, traffic_analyzer,
             route_optimizer, scenarios, command, sqllab, tomtom poller)
simulator/   optional gps ingest: vehicle mover, graph construction and trip
             planning, cli entrypoint, server-side fleet manager
frontend/    dashboard: index.html, styles.css, app.js (leaflet + canvas)
database/    schema, views, triggers, procedures, network migrations, vendor
             tables, probe calibration, performance hardening
tests/       47 pytest cases: geometry, congestion rules, dijkstra, console
             parser, sql guard, vendor poller
```

the simulator is retained solely as an optional demonstration of the gps
ingest path and is unreachable from the dashboard. all user-facing state derives
from vendor data.

---

## 13. verification

```bash
pytest tests -q
```

47 cases: haversine distance and map-matching, classifier boundary conditions,
dijkstra behaviour (avoidance, priority, unreachability, total consistency,
distance-versus-time modes), console parser, sql guard (writes, statement
stacking and catalog access rejected; all samples valid), and vendor poller
guards with speed-precedence resolution.

end-to-end verification was performed against the live deployment: vendor
polling populates corridor speeds, congestion transitions are observed, routing
re-weights around them, and the same state is independently verifiable through
the sql lab.

---

## 14. methodology

requirement analysis → conceptual design (er/eer: fifteen entities, two
disjoint specializations) → logical design → 3nf normalization (positions
reference segments; snapshot and history are separated; thresholds are factored
out; role separation enforces least privilege) → physical design (primary,
foreign keys, check constraints, indexes, views, triggers, procedures) →
implementation (schema → cached vendor ingestion → classifier → router →
dashboard) → verification (live end-to-end, with provenance established at every
stage).