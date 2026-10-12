-- ============================================================================
-- TrafficFlowDB — network expansion: 6 hubs + 10 corridors (all-India).
-- Closes the biggest gaps: Amritsar link, Uttarakhand link, Jaipur-Udaipur-
-- Ahmedabad split, Nagpur-Raipur-Vizag east link, Tamil Nadu feeders,
-- Bengaluru-Mysuru expressway, Pune-Nagpur Deccan link.
-- Idempotent: safe to re-run on every API boot.
-- ============================================================================

INSERT INTO intersection (intersection_id, name, latitude, longitude, scope) VALUES
    (128, 'Amritsar',         31.6340,  74.8723, 'national'),
    (129, 'Dehradun',         30.3165,  78.0322, 'national'),
    (130, 'Udaipur',          24.5854,  73.7125, 'national'),
    (131, 'Raipur',           21.2514,  81.6296, 'national'),
    (132, 'Tiruchirappalli',  10.7905,  78.7047, 'national'),
    (133, 'Mysuru',           12.2958,  76.6394, 'national')
ON CONFLICT (intersection_id) DO UPDATE SET scope = 'national';

SELECT setval('intersection_intersection_id_seq',
              (SELECT MAX(intersection_id) FROM intersection));

INSERT INTO road_segment
    (segment_id, start_intersection_id, end_intersection_id,
     segment_name, distance_km, speed_limit_kmh, road_type, capacity, is_active, scope)
VALUES
    (60, 103, 128, 'NH44 (Ludhiana - Amritsar)',            140,  80, 'highway', 250, TRUE, 'trunk'),
    (61, 101, 129, 'NH334 (Delhi - Dehradun)',              250,  80, 'highway', 250, TRUE, 'trunk'),
    (62, 104, 130, 'NH48 (Jaipur - Udaipur)',               400,  80, 'highway', 300, TRUE, 'trunk'),
    (63, 130, 126, 'NH48 (Udaipur - Ahmedabad)',            250,  80, 'highway', 300, TRUE, 'trunk'),
    (64, 120, 131, 'NH53 (Nagpur - Raipur)',                290,  80, 'highway', 250, TRUE, 'trunk'),
    (65, 131, 112, 'NH26 (Raipur - Visakhapatnam)',         550,  80, 'highway', 250, TRUE, 'trunk'),
    (66, 114, 132, 'NH38 (Chennai - Tiruchirappalli)',      330,  80, 'highway', 300, TRUE, 'trunk'),
    (67, 132, 117, 'NH38 (Tiruchirappalli - Madurai)',      140,  80, 'highway', 250, TRUE, 'trunk'),
    (68, 115, 133, 'NH275 (Bengaluru - Mysuru)',            145, 100, 'highway', 350, TRUE, 'trunk'),
    (69, 125, 120, 'NH65 (Pune - Nagpur)',                  725,  80, 'highway', 300, TRUE, 'trunk')
ON CONFLICT (segment_id) DO NOTHING;

SELECT setval('road_segment_segment_id_seq',
              (SELECT MAX(segment_id) FROM road_segment));

-- Free-flow snapshot rows for the new segments (same "no observations yet"
-- default the analyzer overwrites on first fix — not fake traffic).
INSERT INTO traffic_condition (segment_id, average_speed, vehicle_count, density, congestion_level)
SELECT s.segment_id, s.speed_limit_kmh::double precision, 0, 0, 'LOW'
FROM road_segment s
ON CONFLICT (segment_id) DO NOTHING;
