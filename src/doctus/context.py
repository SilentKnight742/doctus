"""Builds the context a topic chat is given, and records exactly what was used.

The `used` record is returned to the client so the UI can show a
"context used" panel: what the model actually saw for each reply.
"""

from dataclasses import dataclass

from .mastery import MasteryModel
from .store import Node, Store


@dataclass
class TopicContext:
    text: str
    used: dict


def _strength_label(strength: float) -> str:
    if strength == 0:
        return "untested"
    return f"{strength:.2f}"


def build_topic_context(
    store: Store, mastery: MasteryModel, subject: dict, node: Node, now: float
) -> TopicContext:
    prereqs = store.prerequisites(node.id)
    dependents = store.dependents(node.id)

    prereq_info = [
        {
            "id": p.id,
            "name": p.name,
            "summary": p.summary,
            "strength": round(mastery.strength(p.mastery, now), 3),
        }
        for p in prereqs
    ]

    lines = [
        f"Subject: {subject['title']}",
        f"Learner's goal: {subject['goal'] or 'not stated'}",
        "",
        f"Current concept: {node.name}",
        f"Summary: {node.summary or 'none yet'}",
        f"Learner's strength on it: {_strength_label(mastery.strength(node.mastery, now))}",
        "",
        "Prerequisites:" if prereq_info else "Prerequisites: none recorded",
    ]
    for p in prereq_info:
        lines.append(f"- {p['name']} (strength {_strength_label(p['strength'])}): {p['summary']}")
    if dependents:
        lines += ["", "Concepts that build on this one: " + ", ".join(d.name for d in dependents)]

    return TopicContext(
        text="\n".join(lines),
        used={
            "node": {"id": node.id, "name": node.name, "summary": node.summary},
            "prerequisites": prereq_info,
            "dependents": [{"id": d.id, "name": d.name} for d in dependents],
        },
    )
