-- ============================================================================
-- TrafficFlowDB — TomTom real-traffic cache (cost-controlled).
-- Raw vendor readings live here, never in the core pipeline tables:
-- traffic_condition stays the fleet-derived snapshot; the router and the
-- dashboard blend in fresh TomTom speeds as an override weight.
-- Idempotent: safe to re-run on every API boot.
-- ============================================================================

-- Latest vendor speed per segment (one row per segment, upserted by poller).
CREATE TABLE IF NOT EXISTS tomtom_reading (
    segment_id       INTEGER PRIMARY KEY REFERENCES road_segment(segment_id) ON DELETE CASCADE,
    current_speed    DOUBLE PRECISION NOT NULL CHECK (current_speed >= 0),
    freeflow_speed   DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (freeflow_speed >= 0),
    travel_time_s    DOUBLE PRECISION NOT NULL DEFAULT 0,
    freeflow_time_s  DOUBLE PRECISION NOT NULL DEFAULT 0,
    confidence       DOUBLE PRECISION NOT NULL DEFAULT 0,
    road_closure     BOOLEAN NOT NULL DEFAULT FALSE,
    fetched_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tomtom_fetched ON tomtom_reading (fetched_at);

-- Daily API spend ledger (one row per UTC day). The poller stops at budget.
CREATE TABLE IF NOT EXISTS tomtom_usage (
    day   DATE PRIMARY KEY DEFAULT CURRENT_DATE,
    calls INTEGER NOT NULL DEFAULT 0 CHECK (calls >= 0)
);

-- Cached TomTom incidents for the India bbox (replaced wholesale per fetch).
CREATE TABLE IF NOT EXISTS tomtom_incident (
    incident_id   TEXT PRIMARY KEY,
    category      TEXT NOT NULL DEFAULT '',
    magnitude     TEXT NOT NULL DEFAULT '',
    description   TEXT NOT NULL DEFAULT '',
    from_road     TEXT NOT NULL DEFAULT '',
    to_road       TEXT NOT NULL DEFAULT '',
    length_m      DOUBLE PRECISION NOT NULL DEFAULT 0,
    delay_s       DOUBLE PRECISION NOT NULL DEFAULT 0,
    start_time    TIMESTAMPTZ,
    end_time      TIMESTAMPTZ,
    lon           DOUBLE PRECISION,
    lat           DOUBLE PRECISION,
    fetched_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- NOTE: SELECT grants for traffic_ro are handled by ensure_readonly_role(),
-- which runs after migrations and covers ALL TABLES (including these).
