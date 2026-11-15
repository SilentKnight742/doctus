"""Graph helpers, plus the older proposal flow (starter map / update-graph).

The proposal flow turns model output into graph-change proposals the
learner reviews. It is outside the main exploration flow for now.

The model never edits the graph directly. Its suggestions are filtered
(duplicates, unknown names, self-links, over-limit items dropped) and
stored as pending proposals.
"""

from collections import deque

from .llm import LLM, Turn
from .prompts import SKELETON_SYSTEM, UPDATE_SYSTEM, GraphProposal
from .store import Edge, Proposal, Store, name_key


def distances_from(origin_id: int | None, edges: list[Edge]) -> dict[int, int]:
    """Hops from the origin over all edges, ignoring direction and kind.
    Nodes not reachable from the origin are absent."""
    if origin_id is None:
        return {}
    adjacent: dict[int, set[int]] = {}
    for e in edges:
        adjacent.setdefault(e.from_id, set()).add(e.to_id)
        adjacent.setdefault(e.to_id, set()).add(e.from_id)
    dist = {origin_id: 0}
    queue = deque([origin_id])
    while queue:
        current = queue.popleft()
        for nxt in adjacent.get(current, ()):
            if nxt not in dist:
                dist[nxt] = dist[current] + 1
                queue.append(nxt)
    return dist


def _filter(
    store: Store, subject_id: int, proposal: GraphProposal, max_items: int | None
) -> list[tuple[str, dict]]:
    existing = {name_key(n.name): n.name for n in store.list_nodes(subject_id)}
    pending = store.list_proposals(subject_id)
    pending_nodes = {name_key(p.payload["name"]) for p in pending if p.kind == "node"}
    pending_edges = {
        (name_key(p.payload["prerequisite"]), name_key(p.payload["concept"]))
        for p in pending
        if p.kind == "edge"
    }
    existing_edges = {
        (name_key(a.name), name_key(b.name))
        for a in store.list_nodes(subject_id)
        for b in store.dependents(a.id)
    }

    items: list[tuple[str, dict]] = []
    new_names: dict[str, str] = {}
    for c in proposal.concepts:
        key = name_key(c.name)
        if key in existing or key in pending_nodes or key in new_names:
            continue
        new_names[key] = c.name.strip()
        items.append(("node", {"name": c.name.strip(), "summary": c.summary.strip()}))

    known = {**existing, **new_names}
    known_keys = set(known) | pending_nodes
    for link in proposal.links:
        a, b = name_key(link.prerequisite), name_key(link.concept)
        if a == b or a not in known_keys or b not in known_keys:
            continue
        if (a, b) in existing_edges or (a, b) in pending_edges:
            continue
        pending_edges.add((a, b))
        items.append(
            (
                "edge",
                {
                    "prerequisite": known.get(a, link.prerequisite.strip()),
                    "concept": known.get(b, link.concept.strip()),
                    "reason": link.reason.strip(),
                },
            )
        )

    if max_items is not None:
        items = items[:max_items]
    return items


def propose_skeleton(store: Store, llm: LLM, subject: dict) -> list[Proposal]:
    prompt = f"Subject: {subject['title']}\nGoal: {subject['goal'] or 'not stated'}"
    result = llm.structured(SKELETON_SYSTEM, prompt, GraphProposal)
    items = _filter(store, subject["id"], result, max_items=None)
    return store.add_proposals(subject["id"], items, origin="skeleton")


def propose_update(
    store: Store, llm: LLM, subject: dict, node_id: int, turns: list[Turn], max_items: int
) -> list[Proposal]:
    nodes = store.list_nodes(subject["id"])
    current_map = (
        "\n".join(
            f"- {n.name}"
            + (
                " (needs: " + ", ".join(p.name for p in store.prerequisites(n.id)) + ")"
                if store.prerequisites(n.id)
                else ""
            )
            for n in nodes
        )
        or "(empty)"
    )
    focus = next((n.name for n in nodes if n.id == node_id), "?")
    conversation = "\n".join(f"{t.role}: {t.content}" for t in turns)
    prompt = (
        f"Subject: {subject['title']}\nCurrent map:\n{current_map}\n\n"
        f"Conversation about '{focus}':\n{conversation}"
    )
    result = llm.structured(UPDATE_SYSTEM.format(max_items=max_items), prompt, GraphProposal)
    items = _filter(store, subject["id"], result, max_items=max_items)
    return store.add_proposals(subject["id"], items, origin=f"chat:node:{node_id}")
