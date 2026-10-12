-- ============================================================================
-- TrafficFlowDB — TomTom-authoritative traffic.
--
-- TomTom Flow Segment Data returns speed / free-flow speed / travel time /
-- confidence — NOT a vehicle count. The standard way to turn that into a
-- congestion measure is the slow-down ratio:
--
--     ratio        = currentSpeed / freeFlowSpeed      (1 = free, 0 = stopped)
--     traffic_index = (1 - ratio)                       (0 = free, 1 = jam)
--
-- This migration makes that vendor reading AUTHORITATIVE whenever it is
-- fresh, so the map, views, SQL Lab and the router all reflect real observed
-- speeds instead of only the synthetic fleet. Corridors with no fresh reading
-- keep the existing fleet-derived value, so coverage degrades gracefully.
-- Idempotent: safe to re-run on every API boot.
-- ============================================================================

ALTER TABLE traffic_condition
    ADD COLUMN IF NOT EXISTS traffic_source VARCHAR(10) NOT NULL DEFAULT 'fleet'
        CHECK (traffic_source IN ('fleet', 'tomtom'));
ALTER TABLE traffic_condition
    ADD COLUMN IF NOT EXISTS traffic_index DOUBLE PRECISION NOT NULL DEFAULT 0
        CHECK (traffic_index >= 0 AND traffic_index <= 1);

COMMENT ON COLUMN traffic_condition.traffic_index IS
    'Slow-down index: 0 = free-flow, 1 = stopped. Derived from TomTom currentSpeed/freeFlowSpeed.';
COMMENT ON COLUMN traffic_condition.traffic_source IS
    'fleet = derived from ingested GPS; tommom = real vendor speed reading.';

-- Poll configuration lives in the database, not process memory, so tuning it
-- in the Customize drawer survives a restart / redeploy.
CREATE TABLE IF NOT EXISTS tomtom_config (
    id              INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    interval_sec    INTEGER NOT NULL DEFAULT 240 CHECK (interval_sec BETWEEN 60 AND 3600),
    batch_size      INTEGER NOT NULL DEFAULT 4 CHECK (batch_size BETWEEN 1 AND 20),
    daily_budget    INTEGER NOT NULL DEFAULT 2000 CHECK (daily_budget >= 0),
    min_confidence  DOUBLE PRECISION NOT NULL DEFAULT 0
);

-- Vendor time series. traffic_history is only written when the snapshot is
-- recomputed; this one records EVERY successful fetch, so the speed trend
-- fills at the poll cadence even with the GPS fleet switched off.
CREATE TABLE IF NOT EXISTS tomtom_history (
    history_id     BIGSERIAL PRIMARY KEY,
    segment_id     INTEGER NOT NULL REFERENCES road_segment(segment_id) ON DELETE CASCADE,
    current_speed  DOUBLE PRECISION NOT NULL,
    freeflow_speed DOUBLE PRECISION NOT NULL DEFAULT 0,
    traffic_index  DOUBLE PRECISION NOT NULL DEFAULT 0,
    congestion_level VARCHAR(10) NOT NULL DEFAULT 'LOW'
                     CHECK (congestion_level IN ('LOW', 'MEDIUM', 'HIGH')),
    observed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tomtom_history_time
    ON tomtom_history (observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_tomtom_history_segment
    ON tomtom_history (segment_id, observed_at DESC);

-- The real road, as TomTom resolved it.
--
-- flowSegmentData returns the geometry of the road it actually matched for
-- our probe point. Storing that polyline means the network drawn on the map
-- is TomTom's own road alignment rather than a straight line we invented
-- between two cities, and it is verifiable evidence that a corridor's probe
-- sits on a real road.
CREATE TABLE IF NOT EXISTS tomtom_road_geometry (
    segment_id  INTEGER PRIMARY KEY REFERENCES road_segment(segment_id) ON DELETE CASCADE,
    polyline    JSONB       NOT NULL,           -- [[lat, lon], ...] in travel order
    point_count INTEGER     NOT NULL DEFAULT 0,
    length_km   DOUBLE PRECISION NOT NULL DEFAULT 0,
    frc         VARCHAR(10),                    -- functional road class
    captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Vendor read + derived index in one place for the dashboard and SQL Lab.
CREATE OR REPLACE VIEW tomtom_segment_traffic AS
SELECT
    rs.segment_id,
    rs.segment_name,
    rs.speed_limit_kmh,
    tr.current_speed,
    tr.freeflow_speed,
    tr.confidence,
    tr.road_closure,
    tr.fetched_at,
    ROUND((tr.current_speed / NULLIF(tr.freeflow_speed, 0))::numeric, 3) AS speed_ratio,
    ROUND((1 - LEAST(1.0, tr.current_speed / NULLIF(tr.freeflow_speed, 0)))::numeric, 3)
        AS traffic_index,
    CASE
        WHEN tr.road_closure THEN 'HIGH'
        WHEN tr.current_speed / NULLIF(tr.freeflow_speed, 0) < 0.25 THEN 'HIGH'
        WHEN tr.current_speed / NULLIF(tr.freeflow_speed, 0) < 0.55 THEN 'MEDIUM'
        ELSE 'LOW'
    END AS congestion_level
FROM road_segment rs
JOIN tomtom_reading tr ON tr.segment_id = rs.segment_id
WHERE rs.is_active
  AND tr.fetched_at > NOW() - INTERVAL '45 minutes';

-- Overview: vendor coverage vs. gap, for the "API monitor" panel.
CREATE OR REPLACE VIEW tomtom_coverage AS
SELECT
    COUNT(*) FILTER (WHERE rs.probe_lat IS NOT NULL)             AS calibrated,
    COUNT(*) FILTER (WHERE tr.segment_id IS NOT NULL)            AS ever_read,
    COUNT(*) FILTER (
        WHERE tr.fetched_at > NOW() - INTERVAL '45 minutes')    AS fresh,
    COUNT(*)                                                    AS total
FROM road_segment rs
LEFT JOIN tomtom_reading tr ON tr.segment_id = rs.segment_id
WHERE rs.is_active;