-- ============================================================================
-- TrafficFlowDB — Physical database design (PostgreSQL 16 + PostGIS optional)
-- 3NF normalized. Intersections = graph nodes, road_segments = graph edges.
-- Run order: schema.sql -> views.sql -> triggers.sql -> procedures.sql -> seed
-- ============================================================================

-- PostGIS is optional: spatial index + geography used when available,
-- plain lat/lon + haversine in the API otherwise.
CREATE EXTENSION IF NOT EXISTS postgis;

-- ---------------------------------------------------------------- users ----
-- EER: USER (superclass) -> ADMIN / DRIVER (subclasses, disjoint + total
-- enforced at the application layer, partial at the DB layer via role check).
CREATE TABLE IF NOT EXISTS users (
    user_id       SERIAL PRIMARY KEY,
    username      VARCHAR(50)  NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role          VARCHAR(10)  NOT NULL CHECK (role IN ('admin', 'driver')),
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_profile (
    user_id      INTEGER PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
    department   VARCHAR(100),
    access_level INTEGER NOT NULL DEFAULT 1 CHECK (access_level BETWEEN 1 AND 5)
);

CREATE TABLE IF NOT EXISTS driver_profile (
    user_id    INTEGER PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
    license_no VARCHAR(30) NOT NULL UNIQUE,
    phone      VARCHAR(20)
);

-- --------------------------------------------------------------- vehicles --
-- EER: VEHICLE (superclass) -> CAR / BUS / EMERGENCY_VEHICLE (subclasses).
CREATE TABLE IF NOT EXISTS vehicle (
    vehicle_id     SERIAL PRIMARY KEY,
    vehicle_number VARCHAR(20)  NOT NULL UNIQUE,
    vehicle_type   VARCHAR(20)  NOT NULL
                   CHECK (vehicle_type IN ('car', 'bus', 'emergency')),
    status         VARCHAR(20)  NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'inactive', 'maintenance')),
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    last_seen      TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS car_detail (
    vehicle_id       INTEGER PRIMARY KEY REFERENCES vehicle(vehicle_id) ON DELETE CASCADE,
    fuel_type        VARCHAR(20) NOT NULL DEFAULT 'petrol'
                     CHECK (fuel_type IN ('petrol', 'diesel', 'cng', 'electric', 'hybrid')),
    seating_capacity INTEGER NOT NULL DEFAULT 5 CHECK (seating_capacity BETWEEN 1 AND 12)
);

CREATE TABLE IF NOT EXISTS bus_detail (
    vehicle_id       INTEGER PRIMARY KEY REFERENCES vehicle(vehicle_id) ON DELETE CASCADE,
    seating_capacity INTEGER NOT NULL DEFAULT 40 CHECK (seating_capacity BETWEEN 10 AND 120),
    route_number     VARCHAR(20)
);

CREATE TABLE IF NOT EXISTS emergency_vehicle_detail (
    vehicle_id     INTEGER PRIMARY KEY REFERENCES vehicle(vehicle_id) ON DELETE CASCADE,
    emergency_type VARCHAR(20) NOT NULL
                   CHECK (emergency_type IN ('ambulance', 'fire', 'police')),
    priority_level INTEGER NOT NULL DEFAULT 1 CHECK (priority_level BETWEEN 1 AND 3)
);

-- ---------------------------------------------------------- road network --
-- Graph nodes.
CREATE TABLE IF NOT EXISTS intersection (
    intersection_id SERIAL PRIMARY KEY,
    name            VARCHAR(100) NOT NULL UNIQUE,
    latitude        DOUBLE PRECISION NOT NULL CHECK (latitude  BETWEEN -90 AND 90),
    longitude       DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    scope           VARCHAR(20) NOT NULL DEFAULT 'metro'
                    CHECK (scope IN ('metro', 'national'))
);

-- Graph edges. One row per physical road; the router treats every active
-- segment as bidirectional (two-way street model). One-way support can be
-- added later with a `direction` column without breaking the schema.
CREATE TABLE IF NOT EXISTS road_segment (
    segment_id             SERIAL PRIMARY KEY,
    start_intersection_id  INTEGER NOT NULL REFERENCES intersection(intersection_id),
    end_intersection_id    INTEGER NOT NULL REFERENCES intersection(intersection_id),
    segment_name           VARCHAR(120) NOT NULL,
    distance_km            DOUBLE PRECISION NOT NULL CHECK (distance_km > 0),
    speed_limit_kmh        INTEGER NOT NULL DEFAULT 50 CHECK (speed_limit_kmh BETWEEN 5 AND 120),
    road_type              VARCHAR(20) NOT NULL DEFAULT 'arterial'
                           CHECK (road_type IN ('arterial', 'collector', 'local', 'highway')),
    capacity               INTEGER NOT NULL DEFAULT 40 CHECK (capacity > 0),
    is_active              BOOLEAN NOT NULL DEFAULT TRUE,
    scope                  VARCHAR(20) NOT NULL DEFAULT 'metro'
                           CHECK (scope IN ('metro', 'trunk', 'connector')),
    CHECK (start_intersection_id <> end_intersection_id)
);

-- ------------------------------------------------------------ gps / positions
-- High-frequency raw transactional feed. Partitioning-ready (by time) and
-- intentionally append-only: never updated, only inserted + pruned.
CREATE TABLE IF NOT EXISTS gps_data (
    gps_id      BIGSERIAL PRIMARY KEY,
    vehicle_id  INTEGER NOT NULL REFERENCES vehicle(vehicle_id) ON DELETE CASCADE,
    latitude    DOUBLE PRECISION NOT NULL CHECK (latitude  BETWEEN -90 AND 90),
    longitude   DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    speed_kmh   DOUBLE PRECISION NOT NULL CHECK (speed_kmh >= 0 AND speed_kmh <= 300),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Map-matched positions: every raw fix resolved to a road_segment.
CREATE TABLE IF NOT EXISTS vehicle_position (
    position_id BIGSERIAL PRIMARY KEY,
    vehicle_id  INTEGER NOT NULL REFERENCES vehicle(vehicle_id) ON DELETE CASCADE,
    segment_id  INTEGER REFERENCES road_segment(segment_id),
    latitude    DOUBLE PRECISION NOT NULL CHECK (latitude  BETWEEN -90 AND 90),
    longitude   DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    speed_kmh   DOUBLE PRECISION NOT NULL CHECK (speed_kmh >= 0 AND speed_kmh <= 300),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Congestion rulebook: singleton row edited live via PUT /api/config.
-- The stored procedure reads these, so thresholds change without a deploy.
CREATE TABLE IF NOT EXISTS traffic_thresholds (
    id           INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    high_speed   DOUBLE PRECISION NOT NULL DEFAULT 15  CHECK (high_speed >= 0),
    high_density DOUBLE PRECISION NOT NULL DEFAULT 0.75 CHECK (high_density >= 0),
    med_speed    DOUBLE PRECISION NOT NULL DEFAULT 30  CHECK (med_speed >= 0),
    med_density  DOUBLE PRECISION NOT NULL DEFAULT 0.50 CHECK (med_density >= 0)
);

INSERT INTO traffic_thresholds (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ------------------------------------------------------ traffic analysis --
-- Current snapshot: exactly one row per segment (upserted by the analyzer).
CREATE TABLE IF NOT EXISTS traffic_condition (
    traffic_id      SERIAL PRIMARY KEY,
    segment_id      INTEGER NOT NULL UNIQUE REFERENCES road_segment(segment_id) ON DELETE CASCADE,
    average_speed   DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (average_speed >= 0),
    vehicle_count   INTEGER NOT NULL DEFAULT 0 CHECK (vehicle_count >= 0),
    density         DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (density >= 0),
    congestion_level VARCHAR(10) NOT NULL DEFAULT 'LOW'
                     CHECK (congestion_level IN ('LOW', 'MEDIUM', 'HIGH')),
    calculated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Append-only history for trend charts + analytics (one row per computation).
CREATE TABLE IF NOT EXISTS traffic_history (
    history_id      BIGSERIAL PRIMARY KEY,
    segment_id      INTEGER NOT NULL REFERENCES road_segment(segment_id) ON DELETE CASCADE,
    average_speed   DOUBLE PRECISION NOT NULL,
    vehicle_count   INTEGER NOT NULL,
    density         DOUBLE PRECISION NOT NULL,
    congestion_level VARCHAR(10) NOT NULL CHECK (congestion_level IN ('LOW', 'MEDIUM', 'HIGH')),
    calculated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------- traffic_origin --
-- Which source produced the current snapshot: ingested GPS fleet, or a real
-- vendor speed reading from TomTom. Declared here (not only in the migration)
-- because views.sql is applied before migrations and reads these columns.
ALTER TABLE traffic_condition ADD COLUMN IF NOT EXISTS traffic_source VARCHAR(10)
    NOT NULL DEFAULT 'fleet';
ALTER TABLE traffic_condition ADD COLUMN IF NOT EXISTS traffic_index DOUBLE PRECISION
    NOT NULL DEFAULT 0;
-- Same origin columns on the history table so the source mix can be charted
-- over time ("how much of this network is real vendor data vs. fleet GPS").
ALTER TABLE traffic_history ADD COLUMN IF NOT EXISTS traffic_source VARCHAR(10)
    NOT NULL DEFAULT 'fleet';
ALTER TABLE traffic_history ADD COLUMN IF NOT EXISTS traffic_index DOUBLE PRECISION
    NOT NULL DEFAULT 0;
DO $$ BEGIN
    ALTER TABLE traffic_condition ADD CONSTRAINT chk_traffic_source
        CHECK (traffic_source IN ('fleet', 'tomtom'));
    ALTER TABLE traffic_condition ADD CONSTRAINT chk_traffic_index
        CHECK (traffic_index >= 0 AND traffic_index <= 1);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------- routing --
CREATE TABLE IF NOT EXISTS route_request (
    request_id               SERIAL PRIMARY KEY,
    source_intersection_id      INTEGER NOT NULL REFERENCES intersection(intersection_id),
    destination_intersection_id INTEGER NOT NULL REFERENCES intersection(intersection_id),
    user_id                  INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
    requested_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (source_intersection_id <> destination_intersection_id)
);

CREATE TABLE IF NOT EXISTS route (
    route_id          SERIAL PRIMARY KEY,
    request_id        INTEGER NOT NULL REFERENCES route_request(request_id) ON DELETE CASCADE,
    total_distance_km DOUBLE PRECISION NOT NULL CHECK (total_distance_km > 0),
    estimated_time_min DOUBLE PRECISION NOT NULL CHECK (estimated_time_min >= 0),
    traffic_score     DOUBLE PRECISION NOT NULL DEFAULT 0,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS route_segment (
    route_segment_id SERIAL PRIMARY KEY,
    route_id         INTEGER NOT NULL REFERENCES route(route_id) ON DELETE CASCADE,
    segment_id       INTEGER NOT NULL REFERENCES road_segment(segment_id),
    sequence_number  INTEGER NOT NULL CHECK (sequence_number > 0),
    UNIQUE (route_id, sequence_number),
    UNIQUE (route_id, segment_id)
);

-- Scope columns also enforced here (not only in CREATE TABLE above) so
-- databases created by an older schema revision gain them before views.sql
-- runs. Fully idempotent.
ALTER TABLE intersection ADD COLUMN IF NOT EXISTS scope VARCHAR(20)
    NOT NULL DEFAULT 'metro';
ALTER TABLE road_segment ADD COLUMN IF NOT EXISTS scope VARCHAR(20)
    NOT NULL DEFAULT 'metro';
DO $$ BEGIN
    ALTER TABLE intersection ADD CONSTRAINT chk_intersection_scope
        CHECK (scope IN ('metro', 'national'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
    ALTER TABLE road_segment ADD CONSTRAINT chk_segment_scope
        CHECK (scope IN ('metro', 'trunk', 'connector'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ================================================================== indexes =
-- Temporal high-frequency lookups: (vehicle, time) and (segment, time).
CREATE INDEX IF NOT EXISTS idx_gps_vehicle_time
    ON gps_data (vehicle_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_gps_time
    ON gps_data (recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_position_vehicle_time
    ON vehicle_position (vehicle_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_position_segment_time
    ON vehicle_position (segment_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_position_time
    ON vehicle_position (recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_traffic_segment
    ON traffic_condition (segment_id);
CREATE INDEX IF NOT EXISTS idx_traffic_congestion
    ON traffic_condition (congestion_level);
CREATE INDEX IF NOT EXISTS idx_history_segment_time
    ON traffic_history (segment_id, calculated_at DESC);

CREATE INDEX IF NOT EXISTS idx_segment_endpoints
    ON road_segment (start_intersection_id, end_intersection_id);
CREATE INDEX IF NOT EXISTS idx_segment_active
    ON road_segment (is_active) WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_route_request_time
    ON route_request (requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_route_segments
    ON route_segment (route_id, sequence_number);
