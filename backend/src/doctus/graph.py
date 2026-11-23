"""Graph helpers, plus the older proposal flow (starter map).

The proposal flow turns model output into graph-change proposals the
learner reviews. It is outside the main exploration flow for now.

The model never edits the graph directly. Its suggestions are filtered
(duplicates, unknown names, self-links, over-limit items dropped) and
stored as pending proposals.
"""

from collections import deque

from .llm import LLM
from .prompts import SKELETON_SYSTEM, GraphProposal
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
