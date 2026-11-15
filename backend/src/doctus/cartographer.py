"""The cartographer: grows the graph from a topic chat, after the tutor replies.

The model reads the new part of a conversation and reports the concepts it
taught, each with verbatim evidence and one link. The code here decides what
actually changes:

  * a concept needs at least one quote that really appears in the
    conversation (compared after normalising whitespace, case and markdown
    emphasis), otherwise it is not created;
  * each link maps to a stored edge (prerequisite, part_of or related);
    an unknown attach point falls back to `related` on the current node;
  * edges skip self-links, duplicates, cycles (per kind) and a second
    part_of parent.

`apply_extraction` is deterministic and touches only the store.
`CartographerRunner` serialises runs per subject and reruns once more when
messages arrived during a run.
"""

import threading
from dataclasses import dataclass, field

from .llm import LLM, LLMError
from .prompts import CARTOGRAPHER_SYSTEM, ConceptLink, Extraction
from .store import Conflict, Message, Node, Store, name_key

CONTEXT_MESSAGES = 2
MAX_QUOTES = 2

_MARKDOWN_EMPHASIS = str.maketrans("", "", "*_`")

# relation -> (edge kind, concept is the edge's `from` end?)
RELATIONS: dict[str, tuple[str, bool]] = {
    "prerequisite_of": ("prerequisite", True),  # concept -> anchor
    "builds_on": ("prerequisite", False),  # anchor -> concept
    "part_of": ("part_of", True),  # concept -> anchor (whole)
    "contains": ("part_of", False),  # anchor -> concept (whole)
    "related": ("related", True),
}


def normalise(text: str) -> str:
    """Lowercase, drop markdown emphasis characters, collapse whitespace.
    Models often strip the tutor's **bold** / *italics* when quoting."""
    return " ".join(text.lower().translate(_MARKDOWN_EMPHASIS).split())


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
class RunSummary:
    added: list[str] = field(default_factory=list)
    reinforced: list[str] = field(default_factory=list)  # existing node, new evidence
    dropped: list[dict] = field(default_factory=list)  # {name, reason, quotes}
    skipped: list[dict] = field(default_factory=list)  # {item, reason}
    fallbacks: list[dict] = field(default_factory=list)  # {name, attach_to}
    edges_added: list[dict] = field(default_factory=list)
    evidence_verified: int = 0
    evidence_dropped: int = 0

    @property
    def changed(self) -> bool:
        return bool(self.added or self.edges_added or self.evidence_verified)

    def as_dict(self) -> dict:
        return {
            "added": self.added,
            "reinforced": self.reinforced,
            "dropped": self.dropped,
            "skipped": self.skipped,
            "fallbacks": self.fallbacks,
            "edges_added": self.edges_added,
            "evidence_verified": self.evidence_verified,
            "evidence_dropped": self.evidence_dropped,
        }


# ---------- which messages go to the model ----------


def extraction_window(store: Store, node: Node) -> tuple[list[Message], list[Message]]:
    """(context messages, new messages) for the next run on this node."""
    new = store.node_messages(node.id, after_id=node.last_extracted_message_id)
    if not new:
        return [], []
    context = store.node_messages(node.id, before_id=new[0].id, limit=CONTEXT_MESSAGES)
    return context, new


def build_prompt(
    store: Store, subject: dict, node: Node, context: list[Message], new: list[Message]
) -> str:
    names = [n.name for n in store.list_nodes(subject["id"]) if n.id != node.id]
    lines = [
        f"Subject: {subject['title']}",
        f"Learner's goal: {subject['goal'] or 'not stated'}",
        f"Current topic: {node.name}",
        "Existing concepts: " + (", ".join(names) if names else "(none)"),
        "",
        "Conversation:",
    ]
    lines += [f"[context] {m.role}: {m.content}" for m in context]
    lines += [f"{m.role}: {m.content}" for m in new]
    return "\n".join(lines)


def run_once(store: Store, llm: LLM, subject: dict, node: Node) -> dict | None:
    """One model call over the messages since the last run on this node, then
    apply. Returns the summary, or None when there is nothing new. Raises
    LLMError on model failure, leaving `last_extracted_message_id` as it was."""
    context, new = extraction_window(store, node)
    if not new:
        return None
    prompt = build_prompt(store, subject, node, context, new)
    result = llm.structured(CARTOGRAPHER_SYSTEM, prompt, Extraction)
    with store.atomic():
        summary = apply_extraction(store, subject, node, result, context + new)
        store.set_last_extracted(node.id, new[-1].id)
        store.log_extraction(
            subject["id"],
            node.id,
            summary.evidence_verified,
            summary.evidence_dropped,
            summary.as_dict(),
        )
        if summary.changed:
            store.bump_graph_version(subject["id"])
    return summary.as_dict()


# ---------- applying the result (deterministic) ----------


def _verify(quotes: list[str], messages: list[Message], summary: RunSummary):
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


def _link(
    store: Store,
    subject: dict,
    concept: Node,
    current: Node,
    link: ConceptLink,
    summary: RunSummary,
):
    anchor = store.find_node_by_name(subject["id"], link.attach_to)
    relation = link.relation
    if anchor is None:
        # Unknown attach point: keep the concept on the map, but do not trust
        # a direction we cannot check.
        anchor, relation = current, "related"
        summary.fallbacks.append({"name": concept.name, "attach_to": link.attach_to})
    kind, concept_first = RELATIONS[relation]
    a, b = (concept, anchor) if concept_first else (anchor, concept)
    label = f"{a.name} -> {b.name} ({kind})"
    if a.id == b.id:
        summary.skipped.append({"item": label, "reason": "self-link"})
        return
    try:
        store.insert_edge(subject["id"], a.id, b.id, kind, link.reason)
    except Conflict as exc:
        summary.skipped.append({"item": label, "reason": str(exc)})
        return
    summary.edges_added.append({"from": a.name, "to": b.name, "kind": kind, "reason": link.reason})


def apply_extraction(
    store: Store, subject: dict, node: Node, result: Extraction, messages: list[Message]
) -> RunSummary:
    summary = RunSummary()
    sid = subject["id"]
    with store.atomic():
        # Evidence for the current topic itself.
        good, bad = _verify(result.current_node_evidence, messages, summary)
        if bad and not good:
            summary.dropped.append(
                {"name": node.name, "reason": "evidence not found in chat", "quotes": bad}
            )
        for q, m in good:
            store.add_evidence(node.id, m.id, q)

        # Create (or reinforce) every evidenced concept first, so links can
        # point at concepts from the same answer in any order.
        placed: list[tuple[Node, ConceptLink]] = []
        for c in result.concepts:
            if name_key(c.name) == name_key(node.name):
                continue  # the current topic goes through current_node_evidence
            good, bad = _verify(c.evidence, messages, summary)
            if not good:
                reason = "no evidence given" if not c.evidence else "evidence not found in chat"
                summary.dropped.append({"name": c.name, "reason": reason, "quotes": bad})
                continue
            target = store.find_node_by_name(sid, c.name)
            if target is None:
                target = store.insert_node(sid, c.name, c.summary)
                summary.added.append(target.name)
            else:
                summary.reinforced.append(target.name)
            for q, m in good:
                store.add_evidence(target.id, m.id, q)
            placed.append((target, c.link))

        for target, link in placed:
            _link(store, subject, target, node, link, summary)
    return summary


# ---------- running in the background ----------


class Busy(Exception):
    """A cartographer run is already in progress for this subject."""


class CartographerRunner:
    """Serialises cartographer runs per subject.

    `request` marks a node as having new messages. `drain` (run in the
    background) processes marked nodes until none are left, so messages that
    arrive during a run are picked up by one more run right after it. A
    failed run is not retried; the next exchange catches up because
    `last_extracted_message_id` did not move.
    """

    def __init__(self, store: Store, llm: LLM):
        self.store = store
        self.llm = llm
        self._guard = threading.Lock()
        self._pending: dict[int, set[int]] = {}
        self._running: set[int] = set()

    def request(self, subject_id: int, node_id: int):
        with self._guard:
            self._pending.setdefault(subject_id, set()).add(node_id)
            if subject_id not in self._running:
                self.store.set_cartographer_state(subject_id, "running")

    def is_running(self, subject_id: int) -> bool:
        with self._guard:
            return subject_id in self._running

    def drain(self, subject_id: int):
        with self._guard:
            if subject_id in self._running:
                return  # the active drain picks up the new request
            self._running.add(subject_id)
        error: str | None = None
        try:
            while True:
                with self._guard:
                    nodes = self._pending.pop(subject_id, set())
                if not nodes:
                    break
                for node_id in sorted(nodes):
                    error = self._run_node(subject_id, node_id)
        finally:
            with self._guard:
                self._running.discard(subject_id)
                if self._pending.get(subject_id):
                    # Arrived between the last pop and now: hand it to a new drain.
                    restart = True
                else:
                    restart = False
                    self.store.set_cartographer_state(
                        subject_id, "error" if error else "idle", error
                    )
        if restart:
            self.drain(subject_id)

    def run_now(self, subject: dict, node: Node) -> dict | None:
        """Manual run (POST /extract) under the same per-subject lock."""
        with self._guard:
            if subject["id"] in self._running:
                raise Busy("The cartographer is already running for this subject.")
            self._running.add(subject["id"])
        self.store.set_cartographer_state(subject["id"], "running")
        try:
            summary = run_once(self.store, self.llm, subject, node)
        except LLMError as exc:
            self.store.set_cartographer_state(subject["id"], "error", str(exc))
            raise
        finally:
            with self._guard:
                self._running.discard(subject["id"])
        self.store.set_cartographer_state(subject["id"], "idle")
        return summary

    def _run_node(self, subject_id: int, node_id: int) -> str | None:
        node = self.store.node_by_id(node_id)
        subject = self.store.subject_by_id(subject_id)
        try:
            run_once(self.store, self.llm, subject, node)
        except LLMError as exc:
            return str(exc)
        return None
