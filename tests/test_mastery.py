import math

import pytest

from doctus.mastery import DAY, PlaceholderDecayModel

T0 = 1_000_000.0


@pytest.fixture
def model():
    return PlaceholderDecayModel()


def test_untested_node_has_zero_strength(model):
    assert model.strength({}, T0) == 0.0
    assert model.level({}, T0) == 0


def test_first_test_moves_strength_toward_score(model):
    state = model.record_test({}, 1.0, T0)
    assert state["m"] == pytest.approx(0.6)
    assert model.strength(state, T0) == pytest.approx(0.6)


def test_strength_decays_with_time(model):
    state = {"m": 0.8, "stability_days": 3.0, "last_test_at": T0}
    after_3_days = model.strength(state, T0 + 3 * DAY)
    assert after_3_days == pytest.approx(0.8 * math.exp(-1))
    assert model.level(state, T0 + 3 * DAY) == 1


def test_strong_score_doubles_stability_weak_halves_it(model):
    base = {"m": 0.5, "stability_days": 4.0, "last_test_at": T0}
    assert model.record_test(base, 0.9, T0)["stability_days"] == 8.0
    assert model.record_test(base, 0.2, T0)["stability_days"] == 2.0
    assert model.record_test(base, 0.6, T0)["stability_days"] == 4.0


def test_stability_is_clamped(model):
    state = {"m": 1.0, "stability_days": 150.0, "last_test_at": T0}
    assert model.record_test(state, 1.0, T0)["stability_days"] == 180.0


def test_level_never_exceeds_max(model):
    state = {"m": 1.0, "stability_days": 10.0, "last_test_at": T0}
    assert model.level(state, T0) == 5


def test_invalid_score_rejected(model):
    with pytest.raises(ValueError):
        model.record_test({}, 1.5, T0)


def test_history_is_bounded(model):
    state = {}
    for i in range(30):
        state = model.record_test(state, 0.7, T0 + i)
    assert len(state["history"]) == 20
