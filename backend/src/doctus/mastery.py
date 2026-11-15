"""How strongly a learner knows a concept, and how that changes.

THE RULE IS NOT DECIDED YET. Everything else in Doctus talks to the
`MasteryModel` interface only, so the rule can be replaced without
touching storage, the API or the UI.

Each node stores an opaque `state` dict owned by the model. The rest
of the app only ever asks for:
  * strength(state, now) -> 0..1, for colour, fading and "weak" lists
  * level(state, now)    -> integer shown to the learner
  * record_test(state, score, now) -> new state after a test
"""

import math
from abc import ABC, abstractmethod

DAY = 86_400.0


class MasteryModel(ABC):
    max_level = 5

    @abstractmethod
    def strength(self, state: dict, now: float) -> float:
        """Current strength in [0, 1]; 0 means untested or forgotten."""

    @abstractmethod
    def record_test(self, state: dict, score: float, now: float) -> dict:
        """Return the new state after a test scored in [0, 1]."""

    def level(self, state: dict, now: float) -> int:
        return min(self.max_level, math.floor(self.strength(state, now) * self.max_level))


class PlaceholderDecayModel(MasteryModel):
    """Provisional rule, to be replaced once the design is settled.

    strength = m * exp(-days_since_test / stability_days)
    After a test, m moves `learning_rate` of the way toward the score;
    stability doubles on a strong score and halves on a weak one.
    """

    def __init__(
        self,
        learning_rate: float = 0.6,
        initial_stability_days: float = 1.0,
        strong_score: float = 0.8,
        weak_score: float = 0.5,
        min_stability_days: float = 0.5,
        max_stability_days: float = 180.0,
    ):
        self.learning_rate = learning_rate
        self.initial_stability_days = initial_stability_days
        self.strong_score = strong_score
        self.weak_score = weak_score
        self.min_stability_days = min_stability_days
        self.max_stability_days = max_stability_days

    def strength(self, state: dict, now: float) -> float:
        if "last_test_at" not in state:
            return 0.0
        days = max(0.0, (now - state["last_test_at"]) / DAY)
        return state["m"] * math.exp(-days / state["stability_days"])

    def record_test(self, state: dict, score: float, now: float) -> dict:
        if not 0.0 <= score <= 1.0:
            raise ValueError("score must be between 0 and 1")
        current = self.strength(state, now)
        stability = state.get("stability_days", self.initial_stability_days)
        if score >= self.strong_score:
            stability *= 2
        elif score < self.weak_score:
            stability /= 2
        stability = min(self.max_stability_days, max(self.min_stability_days, stability))
        history = [*list(state.get("history", []))[-19:], {"at": now, "score": score}]
        return {
            "m": current + self.learning_rate * (score - current),
            "stability_days": stability,
            "last_test_at": now,
            "history": history,
        }
