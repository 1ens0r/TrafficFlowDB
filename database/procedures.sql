-- ============================================================================
-- TrafficFlowDB — Stored procedures / functions (DBMS showcase)
-- The API calls these instead of inlining analytics SQL, so congestion
-- rules live in exactly one place: the database.
--
-- Congestion rule (defaults; live values in traffic_thresholds, editable
-- via PUT /api/config — the procedure reads them on every call):
--   density = live_vehicles / capacity
--   HIGH   if avg_speed < high_speed AND density > high_density
--   MEDIUM if avg_speed < med_speed  OR  density > med_density
--   LOW    otherwise
-- ============================================================================

-- Recompute traffic for ONE segment from the last `p_window_minutes` of
-- positions. Upserts traffic_condition + appends traffic_history.
-- Returns the new congestion level.
--
-- Speed source precedence:
--   1. Fresh TomTom reading (<= 15 min)  -> real observed speed + slow-down index
--   2. Ingested GPS fleet average        -> density/vehicles from vehicle_position
-- Vendor data wins whenever it exists, so the whole product reflects real
-- traffic; corridors without coverage keep the fleet-derived value.
CREATE OR REPLACE FUNCTION calculate_segment_traffic(
    p_segment_id      INTEGER,
    p_window_minutes  INTEGER DEFAULT 5
)
RETURNS VARCHAR AS $$
DECLARE
    v_count    INTEGER;
    v_avg      DOUBLE PRECISION;
    v_capacity INTEGER;
    v_limit    INTEGER;
    v_density  DOUBLE PRECISION;
    v_level    VARCHAR(10);
    v_source   VARCHAR(10) := 'fleet';
    v_index    DOUBLE PRECISION := 0;
    v_tt_speed DOUBLE PRECISION;
    v_tt_free  DOUBLE PRECISION;
    v_ratio    DOUBLE PRECISION;
    v_tt_count INTEGER;
    t_high_speed   DOUBLE PRECISION;
    t_high_density DOUBLE PRECISION;
    t_med_speed    DOUBLE PRECISION;
    t_med_density  DOUBLE PRECISION;
BEGIN
    SELECT capacity, speed_limit_kmh INTO v_capacity, v_limit
    FROM road_segment WHERE segment_id = p_segment_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Unknown segment %', p_segment_id;
    END IF;

    SELECT high_speed, high_density, med_speed, med_density
    INTO t_high_speed, t_high_density, t_med_speed, t_med_density
    FROM traffic_thresholds WHERE id = 1;

    -- 1) real vendor speed, when fresh
    SELECT current_speed, freeflow_speed INTO v_tt_speed, v_tt_free
    FROM tomtom_reading
    WHERE segment_id = p_segment_id
      AND fetched_at > NOW() - INTERVAL '45 minutes';

    SELECT COUNT(DISTINCT vehicle_id), COALESCE(AVG(speed_kmh), v_limit)
    INTO v_count, v_avg
    FROM vehicle_position
    WHERE segment_id = p_segment_id
      AND recorded_at > NOW() - (p_window_minutes || ' minutes')::INTERVAL;

    IF v_tt_speed IS NOT NULL AND v_tt_free > 0 THEN
        v_source := 'tomtom';
        v_avg    := v_tt_speed;
        v_ratio  := LEAST(1.0, v_tt_speed / v_tt_free);
        v_index  := GREATEST(0.0, 1.0 - v_ratio);
        -- Corridor load expressed in vehicles: capacity scaled by the slow-down
        -- index (TomTom publishes no count), kept alongside real fleet counts.
        v_tt_count := ROUND(v_capacity * v_index);
        IF v_count < v_tt_count THEN
            v_count := v_tt_count;
        END IF;
        -- Congestion from observed slow-down against free-flow.
        IF v_ratio < 0.25 THEN
            v_level := 'HIGH';
        ELSIF v_ratio < 0.55 THEN
            v_level := 'MEDIUM';
        ELSE
            v_level := 'LOW';
        END IF;
    ELSE
        v_density := CASE WHEN v_capacity > 0
                          THEN v_count::double precision / v_capacity
                          ELSE 0 END;
        IF v_avg < t_high_speed AND v_density > t_high_density THEN
            v_level := 'HIGH';
        ELSIF v_avg < t_med_speed OR v_density > t_med_density THEN
            v_level := 'MEDIUM';
        ELSE
            v_level := 'LOW';
        END IF;
    END IF;

    IF v_density IS NULL THEN
        v_density := CASE WHEN v_capacity > 0
                          THEN v_count::double precision / v_capacity
                          ELSE 0 END;
    END IF;

    INSERT INTO traffic_condition
        (segment_id, average_speed, vehicle_count, density, congestion_level,
         traffic_source, traffic_index, calculated_at)
    VALUES (p_segment_id, v_avg, v_count, v_density, v_level,
            v_source, v_index, NOW())
    ON CONFLICT (segment_id) DO UPDATE SET
        average_speed    = EXCLUDED.average_speed,
        vehicle_count    = EXCLUDED.vehicle_count,
        density          = EXCLUDED.density,
        congestion_level = EXCLUDED.congestion_level,
        traffic_source   = EXCLUDED.traffic_source,
        traffic_index    = EXCLUDED.traffic_index,
        calculated_at    = EXCLUDED.calculated_at;

    INSERT INTO traffic_history
        (segment_id, average_speed, vehicle_count, density, congestion_level,
         traffic_source, traffic_index)
    VALUES (p_segment_id, v_avg, v_count, v_density, v_level, v_source, v_index);

    RETURN v_level;
END;
$$ LANGUAGE plpgsql;

-- Recompute traffic for EVERY active segment. Called by the API on a timer
-- and by the /api/traffic/refresh endpoint.
CREATE OR REPLACE FUNCTION refresh_all_traffic(p_window_minutes INTEGER DEFAULT 5)
RETURNS TABLE (segment_id INTEGER, congestion_level VARCHAR) AS $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN SELECT s.segment_id FROM road_segment s WHERE s.is_active LOOP
        PERFORM calculate_segment_traffic(r.segment_id, p_window_minutes);
    END LOOP;
    RETURN QUERY SELECT t.segment_id, t.congestion_level FROM traffic_condition t;
END;
$$ LANGUAGE plpgsql;

-- Congested segments at or above a severity ('MEDIUM' returns MEDIUM+HIGH).
CREATE OR REPLACE FUNCTION get_congested_segments(p_level VARCHAR DEFAULT 'MEDIUM')
RETURNS TABLE (
    segment_id       INTEGER,
    segment_name     VARCHAR,
    average_speed    DOUBLE PRECISION,
    vehicle_count    INTEGER,
    density          DOUBLE PRECISION,
    congestion_level VARCHAR
) AS $$
BEGIN
    IF p_level = 'HIGH' THEN
        RETURN QUERY
        SELECT l.segment_id, l.segment_name, l.average_speed,
               l.vehicle_count, l.density, l.congestion_level
        FROM live_traffic_summary l
        WHERE l.congestion_level = 'HIGH'
        ORDER BY l.density DESC;
    ELSE
        RETURN QUERY
        SELECT l.segment_id, l.segment_name, l.average_speed,
               l.vehicle_count, l.density, l.congestion_level
        FROM live_traffic_summary l
        WHERE l.congestion_level IN ('MEDIUM', 'HIGH')
        ORDER BY CASE l.congestion_level WHEN 'HIGH' THEN 0 ELSE 1 END,
                 l.density DESC;
    END IF;
END;
$$ LANGUAGE plpgsql;

-- Nearest active segments to a point (Haversine, km). Used by the API's
-- map-matcher fallback and debuggable straight from psql.
CREATE OR REPLACE FUNCTION find_nearby_segments(
    p_lat   DOUBLE PRECISION,
    p_lon   DOUBLE PRECISION,
    p_limit INTEGER DEFAULT 3
)
RETURNS TABLE (segment_id INTEGER, segment_name VARCHAR, dist_km DOUBLE PRECISION) AS $$
BEGIN
    RETURN QUERY
    SELECT
        rs.segment_id,
        rs.segment_name,
        (6371 * acos(LEAST(1, GREATEST(-1,
            cos(radians(p_lat)) * cos(radians(
                (i1.latitude + i2.latitude) / 2)) *
            cos(radians(
                (i1.longitude + i2.longitude) / 2) - radians(p_lon)) +
            sin(radians(p_lat)) * sin(radians(
                (i1.latitude + i2.latitude) / 2))
        )))) AS dist_km
    FROM road_segment rs
    JOIN intersection i1 ON i1.intersection_id = rs.start_intersection_id
    JOIN intersection i2 ON i2.intersection_id = rs.end_intersection_id
    WHERE rs.is_active
    ORDER BY dist_km
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql;
