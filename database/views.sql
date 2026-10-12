-- ============================================================================
-- TrafficFlowDB — Views (dashboard + analytics read layer)
-- The live dashboard reads these views, never the raw tables directly.
-- ============================================================================

-- Dropped first (not CREATE OR REPLACE) because column lists evolve across
-- revisions and OR REPLACE cannot rename/reorder columns. Dependents
-- (congested_segments, SQL functions) are recreated below / in procedures.sql.
DROP VIEW IF EXISTS congested_segments;
DROP VIEW IF EXISTS live_traffic_summary;
DROP VIEW IF EXISTS latest_positions;
DROP VIEW IF EXISTS segment_stats_5min;

-- One row per road segment with its latest computed traffic state.
CREATE VIEW live_traffic_summary AS
SELECT
    rs.segment_id,
    rs.segment_name,
    rs.distance_km,
    rs.speed_limit_kmh,
    rs.capacity,
    rs.is_active,
    rs.scope,
    i1.name AS start_name,
    i2.name AS end_name,
    i1.latitude  AS start_lat,
    i1.longitude AS start_lon,
    i2.latitude  AS end_lat,
    i2.longitude AS end_lon,
    COALESCE(tc.average_speed, rs.speed_limit_kmh::double precision) AS average_speed,
    COALESCE(tc.vehicle_count, 0)   AS vehicle_count,
    COALESCE(tc.density, 0)         AS density,
    COALESCE(tc.congestion_level, 'LOW') AS congestion_level,
    COALESCE(tc.traffic_source, 'fleet') AS traffic_source,
    COALESCE(tc.traffic_index, 0) AS traffic_index,
    tc.calculated_at
FROM road_segment rs
JOIN intersection i1 ON i1.intersection_id = rs.start_intersection_id
JOIN intersection i2 ON i2.intersection_id = rs.end_intersection_id
LEFT JOIN traffic_condition tc ON tc.segment_id = rs.segment_id;

-- Currently congested roads, worst first.
CREATE VIEW congested_segments AS
SELECT *
FROM live_traffic_summary
WHERE congestion_level IN ('MEDIUM', 'HIGH')
ORDER BY
    CASE congestion_level WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END,
    density DESC;

-- Latest known position per vehicle (for the live map markers).
CREATE VIEW latest_positions AS
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
ORDER BY vp.vehicle_id, vp.recorded_at DESC;

-- 5-minute rolling stats per segment (powers the analyzer + charts).
CREATE VIEW segment_stats_5min AS
SELECT
    vp.segment_id,
    COUNT(DISTINCT vp.vehicle_id) AS vehicle_count,
    AVG(vp.speed_kmh)             AS avg_speed
FROM vehicle_position vp
WHERE vp.recorded_at > NOW() - INTERVAL '5 minutes'
  AND vp.segment_id IS NOT NULL
GROUP BY vp.segment_id;
