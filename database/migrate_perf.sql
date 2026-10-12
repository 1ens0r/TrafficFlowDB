-- ============================================================================
-- TrafficFlowDB — performance hardening for the high-frequency read path.
-- The ingest loop appends ~250 fixes/s, so the read path must never scan
-- history tables. Adds: a bounded live view, BRIN time indexes (append-only
-- data => BRIN is ~1000x smaller than btree), and retention pruning so the
-- demo database stays small instead of growing to hundreds of millions.
-- Idempotent: safe to re-run on every API boot.
-- ============================================================================

-- Bounded "what is moving right now" view. The 60 s window lets PostgreSQL
-- use idx_position_time instead of sorting the entire append-only table.
CREATE OR REPLACE VIEW live_positions AS
SELECT DISTINCT ON (vp.vehicle_id)
    vp.vehicle_id,
    v.vehicle_number,
    v.vehicle_type,
    vp.segment_id,
    rs.segment_name,
    vp.latitude,
    vp.longitude,
    vp.speed_kmh,
    vp.recorded_at
FROM vehicle_position vp
JOIN vehicle v ON v.vehicle_id = vp.vehicle_id
LEFT JOIN road_segment rs ON rs.segment_id = vp.segment_id
WHERE vp.recorded_at > NOW() - INTERVAL '60 seconds'
ORDER BY vp.vehicle_id, vp.recorded_at DESC;

-- Append-only tables: BRIN over the timestamp is tiny and perfectly suited
-- to "everything from the last N minutes" range scans.
CREATE INDEX IF NOT EXISTS brin_gps_recorded
    ON gps_data USING BRIN (recorded_at) WITH (pages_per_range = 32);
CREATE INDEX IF NOT EXISTS brin_position_recorded
    ON vehicle_position USING BRIN (recorded_at) WITH (pages_per_range = 32);
CREATE INDEX IF NOT EXISTS brin_history_calculated
    ON traffic_history USING BRIN (calculated_at) WITH (pages_per_range = 32);

-- Retention. Without this the demo DB grows ~1.8M history rows/hour and
-- ~900k position rows/hour. Windows comfortably exceed what the dashboard,
-- the SQL Lab samples and the trend charts read.
CREATE OR REPLACE FUNCTION prune_old_data(
    p_positions_minutes INTEGER DEFAULT 90,
    p_history_hours     INTEGER DEFAULT 12
)
RETURNS TABLE (
    deleted_gps      BIGINT,
    deleted_position BIGINT,
    deleted_history  BIGINT
) AS $$
DECLARE
    v_gps BIGINT := 0;
    v_pos BIGINT := 0;
    v_hist BIGINT := 0;
BEGIN
    DELETE FROM gps_data
    WHERE recorded_at < NOW() - (p_positions_minutes || ' minutes')::INTERVAL;
    GET DIAGNOSTICS v_gps = ROW_COUNT;

    DELETE FROM vehicle_position
    WHERE recorded_at < NOW() - (p_positions_minutes || ' minutes')::INTERVAL;
    GET DIAGNOSTICS v_pos = ROW_COUNT;

    DELETE FROM traffic_history
    WHERE calculated_at < NOW() - (p_history_hours || ' hours')::INTERVAL;
    GET DIAGNOSTICS v_hist = ROW_COUNT;

    DELETE FROM tomtom_incident WHERE fetched_at < NOW() - INTERVAL '2 hours';

    RETURN QUERY SELECT v_gps, v_pos, v_hist;
END;
$$ LANGUAGE plpgsql;

-- Trim the table bloat the deletes leave behind (cheap, autovacuum-lite).
CREATE OR REPLACE FUNCTION vacuum_hot_tables() RETURNS VOID AS $$
BEGIN
    EXECUTE 'VACUUM (ANALYZE) gps_data';
    EXECUTE 'VACUUM (ANALYZE) vehicle_position';
    EXECUTE 'VACUUM (ANALYZE) traffic_history';
END;
$$ LANGUAGE plpgsql;