"""Builds the tutor's private notes for a topic chat, and records exactly what
was used.

The notes say where the topic sits among what the learner has been taught:
its prerequisites, its part_of parent and parts, and other direct
neighbours. The `used` record is returned to the client so the UI can show a
"context used" panel. Recall strength is left out until a mastery rule exists.
"""

from dataclasses import dataclass

from .store import Node, Store

MAX_NEARBY = 10


@dataclass
class TopicContext:
    text: str
    used: dict


def _brief(n: Node) -> dict:
    return {"id": n.id, "name": n.name, "summary": n.summary}


def build_topic_context(store: Store, subject: dict, node: Node) -> TopicContext:
    prereqs = store.prerequisites(node.id)
    parent = store.part_of_parent(node.id)
    parts = store.parts(node.id)

    shown = {node.id, *(p.id for p in prereqs), *(p.id for p in parts)}
    if parent:
        shown.add(parent.id)
    nearby: list[Node] = []
    for other, _edge in store.neighbours(node.id):
        if other.id not in shown and len(nearby) < MAX_NEARBY:
            shown.add(other.id)
            nearby.append(other)

    def line(n: Node) -> str:
        return f"- {n.name}: {n.summary}" if n.summary else f"- {n.name}"

    lines = [
        f"Subject: {subject['title']}",
        f"Learner's goal: {subject['goal'] or 'not stated'}",
        f"Current topic: {node.name}" + (f" ({node.summary})" if node.summary else ""),
    ]
    if prereqs:
        lines += ["", "Taught earlier and needed first:", *map(line, prereqs)]
    if parent:
        lines += ["", f"Part of: {parent.name}"]
    if parts:
        lines += ["", "Its parts taught so far:", *map(line, parts)]
    if nearby:
        lines += ["", "Nearby topics taught so far:", *map(line, nearby)]

    return TopicContext(
        text="\n".join(lines),
        used={
            "node": _brief(node),
            "prerequisites": [_brief(p) for p in prereqs],
            "part_of": _brief(parent) if parent else None,
            "parts": [_brief(p) for p in parts],
            "nearby": [_brief(n) for n in nearby],
        },
    )
