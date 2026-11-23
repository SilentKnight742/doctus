"""The cartographer: maps what a chat node taught, after the tutor replies.

One model call per run reads the latest exchange of a chat node and reports
the concepts it taught (each with verbatim evidence), links between concepts,
the node's title and keyword, and up to 3 follow-up suggestions. The code
here decides what actually changes:

  * a concept needs at least one quote that really appears in this canvas
    node's conversation (compared after normalising whitespace, case and
    markdown emphasis), otherwise it is not created;
  * concepts dedupe by normalised name within the subject: a new name is
    homed in this node, an existing one only gains evidence;
  * a link needs both ends to resolve to concepts; self-links, duplicates
    and prerequisite cycles are skipped;
  * the title is set from the first exchange and changes only when the model
    returns a different one (it is told to keep it unless the topic clearly
    shifted); the keyword is cut to one word; suggestions to 3.

`apply_extraction` is deterministic and touches only the store.
`CartographerRunner` serialises runs per subject and reruns once more when
messages arrived during a run.
"""

import logging
import threading
from dataclasses import dataclass, field

from .llm import LLM, LLMError
from .prompts import CARTOGRAPHER_SYSTEM, CanvasExtraction
from .store import (
    CanvasNode,
    Conflict,
    Message,
    NotFound,
    Store,
    clean_keyword,
    clean_title,
    name_key,
)

CONTEXT_MESSAGES = 2
MAX_QUOTES = 2
MAX_SUGGESTIONS = 3
SUGGESTION_MAX = 120
MAX_CONCEPT_NAMES = 150
MAX_ATTEMPTS_PER_DRAIN = 3  # a safety net against a node that never settles

log = logging.getLogger(__name__)

_MARKDOWN_EMPHASIS = str.maketrans("", "", "*_`")


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
    reinforced: list[str] = field(default_factory=list)  # existing concept, new evidence
    dropped: list[dict] = field(default_factory=list)  # {name, reason, quotes}
    skipped: list[dict] = field(default_factory=list)  # {item, reason}
    edges_added: list[dict] = field(default_factory=list)
    evidence_verified: int = 0
    evidence_dropped: int = 0
    title: str = ""
    keyword: str = ""
    title_changed: bool = False
    suggestions: list[str] = field(default_factory=list)
    suggestions_changed: bool = False

    @property
    def changed(self) -> bool:
        return bool(
            self.added
            or self.edges_added
            or self.evidence_verified
            or self.title_changed
            or self.suggestions_changed
        )

    def as_dict(self) -> dict:
        return {
            "added": self.added,
            "reinforced": self.reinforced,
            "dropped": self.dropped,
            "skipped": self.skipped,
            "edges_added": self.edges_added,
            "evidence_verified": self.evidence_verified,
            "evidence_dropped": self.evidence_dropped,
            "title": self.title,
            "keyword": self.keyword,
            "suggestions": self.suggestions,
        }


# ---------- which messages go to the model ----------


def extraction_window(store: Store, node: CanvasNode) -> tuple[list[Message], list[Message]]:
    """(context messages, new messages) for the next run on this node. The new
    messages end at the latest tutor reply: an unanswered question waits."""
    new = store.canvas_messages(node.id, after_id=node.last_extracted_message_id)
    while new and new[-1].role != "assistant":
        new.pop()
    if not new:
        return [], []
    context = store.canvas_messages(node.id, before_id=new[0].id, limit=CONTEXT_MESSAGES)
    return context, new


def concept_names(store: Store, subject_id: int, branch_ids: list[int]) -> list[str]:
    """Up to MAX_CONCEPT_NAMES names: concepts homed on this branch first, then
    the rest of the subject, most recent first within each group."""
    on_branch = store.concepts_homed(branch_ids)
    seen = {c.id for c in on_branch}
    rest = [c for c in store.concept_names_recent(subject_id) if c.id not in seen]
    return [c.name for c in [*on_branch, *rest][:MAX_CONCEPT_NAMES]]


def build_prompt(
    store: Store, subject: dict, node: CanvasNode, context: list[Message], new: list[Message]
) -> str:
    branch = store.branch(node.id)
    path = [n.title or "(untitled)" for n in branch[:-1]]
    children = [c.title for c in store.canvas_children(node.id) if c.title]
    names = concept_names(store, subject["id"], [n.id for n in branch])
    lines = [
        f"Subject: {subject['title']}",
        f"Learner's goal: {subject['goal'] or 'not stated'}",
        "Path to this conversation: " + (" > ".join(path) if path else "(this is the start)"),
        "Current title: "
        + (node.title or "(none yet: set it from this exchange)")
        + (f" (keyword: {node.keyword})" if node.keyword else ""),
        "Branches the learner already took from here: "
        + (", ".join(children) if children else "(none)"),
        "Existing concepts: " + (", ".join(names) if names else "(none)"),
        "",
        "Conversation:",
    ]
    lines += [f"[context] {m.role}: {m.content}" for m in context]
    lines += [f"{m.role}: {m.content}" for m in new]
    return "\n".join(lines)


def run_once(store: Store, llm: LLM, subject: dict, node: CanvasNode) -> dict | None:
    """One model call over the exchanges since the last run on this node, then
    apply. Returns the summary, or None when there is nothing new. Raises
    LLMError on model failure, leaving `last_extracted_message_id` as it was."""
    if node.kind != "chat":
        return None
    context, new = extraction_window(store, node)
    if not new:
        return None
    prompt = build_prompt(store, subject, node, context, new)
    result = llm.structured(CARTOGRAPHER_SYSTEM, prompt, CanvasExtraction)
    with store.atomic():
        try:
            node = store.canvas_node_by_id(node.id)
        except NotFound:
            return None  # deleted while the model was thinking
        summary = apply_extraction(store, subject, node, result, context + new)
        store.set_canvas_last_extracted(node.id, new[-1].id)
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


def _suggestions(store: Store, node: CanvasNode, texts: list[str]) -> list[str]:
    taken = {normalise(c.title) for c in store.canvas_children(node.id) if c.title}
    for child in store.canvas_children(node.id):
        first = store.canvas_messages(child.id)
        if first:
            taken.add(normalise(first[0].content))
    out: list[str] = []
    for t in texts:
        t = " ".join(t.split())
        if not t or len(t) > SUGGESTION_MAX or normalise(t) in taken:
            continue
        if normalise(t) in {normalise(o) for o in out}:
            continue
        out.append(t)
        if len(out) == MAX_SUGGESTIONS:
            break
    return out


def apply_extraction(
    store: Store,
    subject: dict,
    node: CanvasNode,
    result: CanvasExtraction,
    messages: list[Message],
) -> RunSummary:
    summary = RunSummary()
    sid = subject["id"]
    with store.atomic():
        # Title and keyword: set from the first exchange; the model is told to
        # return the current title unless the topic clearly shifted.
        title = clean_title(result.title) or node.title
        keyword = clean_keyword(result.keyword) or node.keyword or clean_keyword(title)
        if (title, keyword) != (node.title, node.keyword):
            store.set_title_keyword(node.id, title, keyword)
            summary.title_changed = True
        summary.title, summary.keyword = title, keyword

        for c in result.concepts:
            if not c.name.strip():
                summary.dropped.append({"name": c.name, "reason": "empty name", "quotes": []})
                continue
            good, bad = _verify(c.evidence, messages, summary)
            if not good:
                reason = "no evidence given" if not c.evidence else "evidence not found in chat"
                summary.dropped.append({"name": c.name, "reason": reason, "quotes": bad})
                continue
            target = store.find_node_by_name(sid, c.name)
            if target is None:
                target = store.insert_node(sid, c.name, c.summary, home_canvas_node_id=node.id)
                summary.added.append(target.name)
            else:
                summary.reinforced.append(target.name)
            for q, m in good:
                store.add_evidence(target.id, m.id, q)

        for link in result.links:
            a = store.find_node_by_name(sid, link.source)
            b = store.find_node_by_name(sid, link.target)
            label = f"{link.source} -> {link.target} ({link.kind})"
            if a is None or b is None:
                summary.skipped.append({"item": label, "reason": "unknown concept"})
                continue
            if name_key(a.name) == name_key(b.name):
                summary.skipped.append({"item": label, "reason": "self-link"})
                continue
            try:
                store.insert_edge(sid, a.id, b.id, link.kind, link.reason)
            except Conflict as exc:
                summary.skipped.append({"item": label, "reason": str(exc)})
                continue
            summary.edges_added.append(
                {"from": a.name, "to": b.name, "kind": link.kind, "reason": link.reason}
            )

        summary.suggestions = _suggestions(store, node, result.suggestions)
        summary.suggestions_changed = store.replace_suggestions(node.id, summary.suggestions)
    return summary


# ---------- running in the background ----------


class Busy(Exception):
    """A cartographer run is already in progress for this subject."""


class CartographerRunner:
    """Serialises cartographer runs per subject.

    `request` marks a chat node as having a new exchange. `drain` (run in the
    background) processes marked nodes, and on every pass also sweeps the
    database for any chat node in the subject whose latest reply has not been
    processed. So a node is never left behind because its own run failed
    (a 429, say), because an unexpected error stopped a run, or because the
    server restarted and lost the in-memory queue: the next run anywhere in
    the subject picks it up. A node that fails is not retried within the
    same drain, and its error stays reported even if later nodes succeed.
    """

    def __init__(self, store: Store, llm: LLM):
        self.store = store
        self.llm = llm
        self._guard = threading.Lock()
        self._pending: dict[int, set[int]] = {}
        self._running: set[int] = set()

    def request(self, subject_id: int, canvas_node_id: int):
        with self._guard:
            self._pending.setdefault(subject_id, set()).add(canvas_node_id)
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
        failed: set[int] = set()
        attempts: dict[int, int] = {}
        try:
            while True:
                with self._guard:
                    nodes = self._pending.pop(subject_id, set())
                # Every answered node still unprocessed, not only the requested ones.
                nodes |= set(self.store.unextracted_chat_nodes(subject_id))
                nodes = {
                    n
                    for n in nodes
                    if n not in failed and attempts.get(n, 0) < MAX_ATTEMPTS_PER_DRAIN
                }
                if not nodes:
                    break
                for node_id in sorted(nodes):
                    attempts[node_id] = attempts.get(node_id, 0) + 1
                    node_error = self._run_node(subject_id, node_id)
                    if node_error:
                        failed.add(node_id)
                        error = f"Node {node_id}: {node_error}"
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

    def run_now(self, subject: dict, node: CanvasNode) -> dict | None:
        """Manual run (POST /canvas-nodes/{id}/extract) under the same per-subject lock."""
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

    def _run_node(self, subject_id: int, canvas_node_id: int) -> str | None:
        try:
            node = self.store.canvas_node_by_id(canvas_node_id)
        except NotFound:
            return None  # deleted before its run
        subject = self.store.subject_by_id(subject_id)
        try:
            run_once(self.store, self.llm, subject, node)
        except LLMError as exc:
            return str(exc)
        except Exception as exc:
            # Never let one node's bug stop the others from being processed.
            log.exception("Cartographer run failed on canvas node %s", canvas_node_id)
            return f"Unexpected error: {exc}"
        return None
