"""TomTom + analytics unit tests (no database, no network)."""
import time

from backend.services import tomtom
from backend.services.route_optimizer import _weight


def _seg(**kw):
    base = {"segment_id": 1, "a": 1, "b": 2, "name": "s",
            "distance_km": 10.0, "speed_limit": 80, "capacity": 100,
            "road_type": "highway", "avg_speed": 20.0,
            "vehicle_count": 10, "level": "MEDIUM"}
    base.update(kw)
    return base


def test_config_clamps_bounds():
    out = tomtom.configure({"interval_sec": 5, "batch_size": 99,
                            "daily_budget": -3})
    assert out["interval_sec"] == 60
    assert out["batch_size"] == 20
    assert out["daily_budget"] == 0
    # restore sane defaults for other tests / dev runs
    tomtom.configure({"interval_sec": 300, "batch_size": 4,
                      "daily_budget": 2000})


def test_poll_once_no_key(monkeypatch):
    monkeypatch.setattr(tomtom.settings, "tomtom_api_key", "")
    out = tomtom.poll_once()
    assert out == {"ok": False, "reason": "no_key"}


def test_poll_once_disabled(monkeypatch):
    monkeypatch.setattr(tomtom.settings, "tomtom_api_key", "DUMMY")
    tomtom.configure({"enabled": False})
    try:
        assert tomtom.poll_once() == {"ok": False, "reason": "disabled"}
    finally:
        tomtom.configure({"enabled": True})


def test_status_survives_without_db():
    s = tomtom.status()
    assert "key_set" in s and "budget_exhausted" in s
    assert s["fresh_sec"] == tomtom.FRESH_SEC


def test_weight_prefers_fresh_tomtom():
    seg = _seg(tomtom_speed=70.0, tomtom_age_s=60.0)
    w, speed = _weight(seg, False)
    assert speed == 70.0
    assert w == 10.0 / 70.0 * 60.0


def test_weight_ignores_stale_tomtom():
    seg = _seg(tomtom_speed=70.0, tomtom_age_s=99999.0)
    _, speed = _weight(seg, False)
    assert speed == 20.0  # falls back to the observed average


def test_weight_backward_compatible_without_tomtom_keys():
    seg = _seg()
    _, speed = _weight(seg, False)
    assert speed == 20.0


def test_weight_priority_ignores_tomtom():
    seg = _seg(tomtom_speed=70.0, tomtom_age_s=10.0)
    _, speed = _weight(seg, True)
    assert speed == 80.0


def test_analytics_corr_shapes_row():
    from backend.routes.analytics import _corr
    now = time.time()
    _ = now
    row = (60, "NH44 (Ludhiana - Amritsar)", 140.0, 62.5, 12, 0.048,
           "LOW", 80, True, 66.0)
    d = _corr(row)
    assert d["segment_id"] == 60
    assert d["tomtom_fresh"] is True
    assert d["tomtom_speed"] == 66.0
    assert d["density"] == 0.048
