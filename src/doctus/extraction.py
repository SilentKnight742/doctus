"""Grows the exploration graph from a topic chat.

The model reads the new part of a conversation and reports concepts it
covered (with verbatim evidence) and frontier concepts it touched on. The
code below decides what actually changes:

  * a covered concept needs at least one quote that really appears in the
    conversation (compared after normalising whitespace and case);
  * frontier suggestions are capped per attach point and never revive a
    name that already exists, including dismissed ones;
  * edges skip duplicates, self-links and prerequisite cycles.

`apply_extraction` is deterministic and does no I/O besides the store.
"""

from dataclasses import dataclass, field

from .llm import LLM
from .prompts import EXTRACT_SYSTEM, Extraction, ExtractedLink
from .store import Conflict, Message, Node, Store, name_key

FRONTIER_CAP = 3
CONTEXT_MESSAGES = 2
MAX_QUOTES = 2
TRIGGER_EVERY = 3


def normalise(text: str) -> str:
    return " ".join(text.lower().split())


def find_quote(quote: str, messages: list[Message]) -> Message | None:
    """The message containing `quote` verbatim (modulo whitespace/case), if any."""
    q = normalise(quote)
    if not q:
        return None
    for m in messages:
        if q in normalise(m.content):
            return m
    return None


@dataclass
class ExtractionSummary:
    added: list[dict] = field(default_factory=list)       # {name, status}
    promoted: list[str] = field(default_factory=list)
    dropped: list[dict] = field(default_factory=list)     # {name, reason, quotes}
    skipped: list[dict] = field(default_factory=list)     # {item, reason}
    edges_added: list[dict] = field(default_factory=list)
    evidence_verified: int = 0
    evidence_dropped: int = 0

    def as_dict(self) -> dict:
        return {
            "added": self.added,
            "promoted": self.promoted,
            "dropped": self.dropped,
            "skipped": self.skipped,
            "edges_added": self.edges_added,
            "evidence_verified": self.evidence_verified,
            "evidence_dropped": self.evidence_dropped,
        }


# ---------- which messages go to the model ----------

def pending_user_messages(store: Store, node: Node) -> int:
    msgs = store.node_messages(node.id, after_id=node.last_extracted_message_id)
    return sum(1 for m in msgs if m.role == "user")


def extraction_window(store: Store, node: Node) -> tuple[list[Message], list[Message]]:
    """(context messages, new messages) for the next extraction."""
    new = store.node_messages(node.id, after_id=node.last_extracted_message_id)
    if not new:
        return [], []
    context = store.node_messages(node.id, before_id=new[0].id, limit=CONTEXT_MESSAGES)
    return context, new


# ---------- the model call ----------

def build_prompt(store: Store, subject: dict, node: Node,
                 context: list[Message], new: list[Message]) -> str:
    names = [n.name for n in store.list_nodes(subject["id"])
             if n.status != "dismissed" and n.id != node.id]
    lines = [
        f"Subject: {subject['title']}",
        f"Learner's goal: {subject['goal'] or 'not stated'}",
        f"Current concept: {node.name}",
        "Existing concepts: " + (", ".join(names) if names else "(none)"),
        "",
        "Conversation:",
    ]
    for m in context:
        lines.append(f"[context] {m.role}: {m.content}")
    for m in new:
        lines.append(f"{m.role}: {m.content}")
    return "\n".join(lines)


def run_extraction(store: Store, llm: LLM, subject: dict, node: Node) -> dict | None:
    """One model call over the messages since the last extraction, then apply.
    Returns the summary, or None when there is nothing new."""
    context, new = extraction_window(store, node)
    if not new:
        return None
    prompt = build_prompt(store, subject, node, context, new)
    result = llm.structured(EXTRACT_SYSTEM, prompt, Extraction)
    summary = apply_extraction(store, subject, node, result, context + new)
    store.set_last_extracted(node.id, new[-1].id)
    store.log_extraction(subject["id"], node.id, summary.evidence_verified,
                         summary.evidence_dropped, summary.as_dict())
    return summary.as_dict()


# ---------- applying the result (deterministic) ----------

def _verify(quotes: list[str], messages: list[Message], summary: ExtractionSummary):
    """Split quotes into verified (quote, message) pairs and failures."""
    good, bad = [], []
    for q in quotes[:MAX_QUOTES]:
        m = find_quote(q, messages)
        if m is None:
            bad.append(q)
        else:
            good.append((q.strip(), m))
    summary.evidence_verified += len(good)
    summary.evidence_dropped += len(bad)
    return good, bad


def _link(store: Store, subject_id: int, concept: Node, anchor: Node,
          link: ExtractedLink | None, summary: ExtractionSummary):
    if link is None:
        return
    label = f"{concept.name} <-> {anchor.name} ({link.kind})"
    if concept.id == anchor.id:
        summary.skipped.append({"item": label, "reason": "self-link"})
        return
    if link.kind == "prerequisite" and link.direction == "after":
        first, second = anchor, concept
    else:
        first, second = concept, anchor
    if link.kind == "prerequisite":
        label = f"{first.name} -> {second.name} (prerequisite)"
    try:
        store.insert_edge(subject_id, first.id, second.id, link.kind, link.reason)
    except Conflict as exc:
        reason = "cycle" if "cycle" in str(exc) else "duplicate"
        summary.skipped.append({"item": label, "reason": reason})
        return
    summary.edges_added.append({
        "from": first.name, "to": second.name, "kind": link.kind, "reason": link.reason,
    })


def apply_extraction(store: Store, subject: dict, node: Node, result: Extraction,
                     messages: list[Message]) -> ExtractionSummary:
    summary = ExtractionSummary()
    sid = subject["id"]
    with store.atomic():
        # The current node itself.
        good, bad = _verify(result.current_node_evidence, messages, summary)
        if bad and not good:
            summary.dropped.append({
                "name": node.name, "reason": "evidence not found in chat", "quotes": bad,
            })
        if good:
            if node.status != "covered":
                store.mark_covered(node.id)
                summary.promoted.append(node.name)
            for q, m in good:
                store.add_evidence(node.id, m.id, q)

        # Covered concepts.
        for c in result.covered:
            if name_key(c.name) == name_key(node.name):
                continue  # handled above via current_node_evidence
            good, bad = _verify(c.evidence, messages, summary)
            if not good:
                summary.dropped.append({
                    "name": c.name,
                    "reason": "no evidence given" if not c.evidence else "evidence not found in chat",
                    "quotes": bad,
                })
                continue
            existing = store.find_node_by_name(sid, c.name)
            if existing is None:
                target = store.insert_node(sid, c.name, c.summary, status="covered")
                summary.added.append({"name": target.name, "status": "covered"})
            else:
                target = existing
                if existing.status != "covered":
                    store.mark_covered(existing.id)
                    summary.promoted.append(existing.name)
            for q, m in good:
                store.add_evidence(target.id, m.id, q)
            _link(store, sid, target, node, c.link, summary)

        # Frontier suggestions.
        per_anchor: dict[int, int] = {}
        for f in result.frontier:
            if store.find_node_by_name(sid, f.name) is not None:
                summary.skipped.append({"item": f.name, "reason": "name exists"})
                continue
            anchor = store.find_node_by_name(sid, f.attach_to)
            if anchor is None or anchor.status == "dismissed":
                anchor = node
            if per_anchor.get(anchor.id, 0) >= FRONTIER_CAP:
                summary.skipped.append({"item": f.name, "reason": f"frontier cap for {anchor.name}"})
                continue
            per_anchor[anchor.id] = per_anchor.get(anchor.id, 0) + 1
            target = store.insert_node(sid, f.name, f.summary, status="frontier")
            summary.added.append({"name": target.name, "status": "frontier"})
            _link(store, sid, target, anchor, f.link, summary)
    return summary
