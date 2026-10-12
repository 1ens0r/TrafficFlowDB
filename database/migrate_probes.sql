-- ============================================================================
-- TrafficFlowDB — TomTom probe points (network-aware vendor sampling).
--
-- The straight-line midpoint of a corridor is frequently off the real road
-- (our edges are 2-point lines; highways curve). TomTom answers 400
-- "Point too far from nearest existing segment" for those, which silently
-- starved the poller of real speeds.
--
-- Fix: calibrate ONCE — probe a few candidate points along each corridor,
-- store the first that resolves, then every later poll costs exactly one
-- transaction at a point known to be on-road. No retries, ever.
-- Idempotent: safe to re-run on every API boot.
-- ============================================================================

ALTER TABLE road_segment ADD COLUMN IF NOT EXISTS probe_lat DOUBLE PRECISION;
ALTER TABLE road_segment ADD COLUMN IF NOT EXISTS probe_lon DOUBLE PRECISION;
ALTER TABLE road_segment ADD COLUMN IF NOT EXISTS probe_calibrated_at TIMESTAMPTZ;

COMMENT ON COLUMN road_segment.probe_lat IS
    'Lat of a point on the real road for this corridor (TomTom flow probe).';
COMMENT ON COLUMN road_segment.probe_lon IS
    'Lon of a point on the real road for this corridor (TomTom flow probe).';

-- Corridors that have never been calibrated (NULL probe), oldest-network first.
CREATE OR REPLACE VIEW tomtom_uncalibrated_segments AS
SELECT rs.segment_id, rs.segment_name,
       i1.latitude AS a_lat, i1.longitude AS a_lon,
       i2.latitude AS b_lat, i2.longitude AS b_lon
FROM road_segment rs
JOIN intersection i1 ON i1.intersection_id = rs.start_intersection_id
JOIN intersection i2 ON i2.intersection_id = rs.end_intersection_id
WHERE rs.is_active AND rs.probe_lat IS NULL
ORDER BY rs.segment_id;

-- Persist a working probe point.
CREATE OR REPLACE FUNCTION set_segment_probe(
    p_segment_id INTEGER,
    p_lat         DOUBLE PRECISION,
    p_lon         DOUBLE PRECISION
) RETURNS VOID AS $$
BEGIN
    UPDATE road_segment
    SET probe_lat = p_lat, probe_lon = p_lon, probe_calibrated_at = NOW()
    WHERE segment_id = p_segment_id;
END;
$$ LANGUAGE plpgsql;

-- One-shot seed: corridors whose straight-line midpoint already resolves.
-- Cheap, no extra vendor calls for short/direct corridors.
CREATE OR REPLACE FUNCTION seed_probe_from_midpoint() RETURNS INTEGER AS $$
DECLARE
    r RECORD;
    n INTEGER := 0;
BEGIN
    FOR r IN
        SELECT segment_id,
               (i1.latitude  + i2.latitude)  / 2 AS lat,
               (i1.longitude + i2.longitude) / 2 AS lon
        FROM road_segment rs
        JOIN intersection i1 ON i1.intersection_id = rs.start_intersection_id
        JOIN intersection i2 ON i2.intersection_id = rs.end_intersection_id
        WHERE rs.is_active AND rs.probe_lat IS NULL
    LOOP
        PERFORM set_segment_probe(r.segment_id, r.lat, r.lon);
        n := n + 1;
    END LOOP;
    RETURN n;
END;
$$ LANGUAGE plpgsql;