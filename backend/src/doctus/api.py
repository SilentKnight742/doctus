"""HTTP API.

Visitors are anonymous: the browser generates a random token once and
sends it as the `X-Doctus-Visitor` header. All data is scoped to it.

Tutor replies stream as server-sent events. A reply in progress can be
stopped with POST /api/canvas-nodes/{id}/stop (or by dropping the
connection); what was written so far is kept. Active streams are tracked in
memory, so the app assumes a single worker process.
"""

import json
import threading
import time
from collections.abc import Callable
from typing import Annotated, Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Path, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from . import tutor
from .cartographer import Busy, CartographerRunner
from .config import Settings, load_settings
from .graph import distances_from, propose_skeleton
from .llm import LLM, LLMError, RateLimited, make_llm
from .mastery import MasteryModel, PlaceholderDecayModel
from .store import CanvasNode, Conflict, Message, NotFound, Store

# SQLite integers are signed 64-bit; anything outside 1..MAX_ID cannot be an
# id, and would overflow the driver, so it is rejected as 422 up front.
MAX_ID = 2**63 - 1
Id = Annotated[int, Path(ge=1, le=MAX_ID)]
MESSAGE_MAX = 8000
NOTE_MAX = 20_000


class NewSubject(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    goal: str = Field(default="", max_length=1000)
    # Optional: the root chat starts with this question (answer it with
    # POST /canvas-nodes/{root}/chat and no message). Without it, the first
    # /chat {message} on the empty root starts the subject.
    first_question: str = Field(default="", max_length=MESSAGE_MAX)


class RenameSubject(BaseModel):
    title: str = Field(min_length=1, max_length=120)


class NewCanvasNode(BaseModel):
    kind: Literal["chat", "note"]
    # A chat node's first question, or a note's body.
    text: str = Field(default="", max_length=NOTE_MAX)


class EditCanvasNode(BaseModel):
    kind: Literal["chat", "note"] | None = None
    prompt: str | None = Field(default=None, min_length=1, max_length=MESSAGE_MAX)
    note_body: str | None = Field(default=None, max_length=NOTE_MAX)


class CanvasChatIn(BaseModel):
    # Omit to answer the node's pending first question.
    message: str | None = Field(default=None, min_length=1, max_length=MESSAGE_MAX)


class VisitIn(BaseModel):
    from_node_id: int | None = Field(default=None, ge=1, le=MAX_ID)


def visitor_token(x_doctus_visitor: str = Header(min_length=16, max_length=128)) -> str:
    return x_doctus_visitor


def sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


class Streams:
    """Tutor replies in progress, by canvas node (in memory: one worker)."""

    def __init__(self):
        self._lock = threading.Lock()
        self._active: dict[int, threading.Event] = {}

    def begin(self, canvas_node_id: int) -> threading.Event:
        with self._lock:
            if canvas_node_id in self._active:
                raise Conflict("A reply is already being written in this node.")
            stop = threading.Event()
            self._active[canvas_node_id] = stop
            return stop

    def stop(self, canvas_node_id: int) -> bool:
        with self._lock:
            event = self._active.get(canvas_node_id)
        if event is None:
            return False
        event.set()
        return True

    def end(self, canvas_node_id: int):
        with self._lock:
            self._active.pop(canvas_node_id, None)

    def active(self) -> set[int]:
        with self._lock:
            return set(self._active)


def _start_thread(fn: Callable[[], None]):
    threading.Thread(target=fn, daemon=True).start()


def create_app(
    store: Store | None = None,
    llm: LLM | None = None,
    mastery: MasteryModel | None = None,
    settings: Settings | None = None,
    clock=time.time,
    graph_llm: LLM | None = None,
    run_in_background: Callable[[Callable[[], None]], None] | None = None,
) -> FastAPI:
    """`llm` is the tutor's model; `graph_llm` the cartographer's (defaults to
    `llm`, or to DOCTUS_GRAPH_MODEL when that is set). `run_in_background`
    starts the cartographer after a reply (a thread by default; tests pass a
    synchronous runner)."""
    settings = settings or load_settings()
    store = store or Store(settings.db_path)
    llm = llm or make_llm(settings)
    if graph_llm is None:
        if settings.graph_model and settings.graph_model != settings.gemini_model:
            graph_llm = make_llm(settings, settings.graph_model)
        else:
            graph_llm = llm
    mastery = mastery or PlaceholderDecayModel()
    cartographer = CartographerRunner(store, graph_llm)
    streams = Streams()
    background_run = run_in_background or _start_thread

    app = FastAPI(title="Doctus", version="0.4.0")
    app.state.store = store
    app.state.cartographer = cartographer
    app.state.streams = streams

    def guard(fn, *args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except NotFound as exc:
            raise HTTPException(404, str(exc)) from exc
        except Conflict as exc:
            raise HTTPException(409, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        except RateLimited as exc:
            raise HTTPException(
                429, str(exc), headers={"Retry-After": str(exc.retry_after)}
            ) from exc
        except LLMError as exc:
            raise HTTPException(502, str(exc)) from exc

    def node_view(node, now):
        return {
            "id": node.id,
            "name": node.name,
            "summary": node.summary,
            "strength": round(mastery.strength(node.mastery, now), 3),
            "level": mastery.level(node.mastery, now),
            "last_visited_at": node.last_visited_at,
        }

    def proposal_view(p):
        return {"id": p.id, "kind": p.kind, "status": p.status, "origin": p.origin, **p.payload}

    def message_view(m: Message) -> dict:
        return {
            "id": m.id,
            "role": m.role,
            "content": m.content,
            "stopped": m.stopped,
            "created_at": m.created_at,
        }

    def canvas_node_view(n: CanvasNode, messages: list[Message], concepts, active) -> dict:
        return {
            "id": n.id,
            "parent_id": n.parent_id,
            "kind": n.kind,
            "sort_index": n.sort_index,
            "title": n.title,
            "keyword": n.keyword,
            "note_body": n.note_body,
            "is_root": n.parent_id is None,
            "answered": any(m.role == "assistant" for m in messages),
            # The latest message is a question still waiting for the tutor.
            "pending": bool(messages) and messages[-1].role == "user",
            "streaming": n.id in active,
            "concepts": [{"id": c.id, "name": c.name} for c in concepts],
            "messages": [message_view(m) for m in messages],
        }

    def link_views(subject_id: int, concept_ids: set[int] | None = None) -> list[dict]:
        """Concept links (prerequisite, related) mapped to the canvas nodes
        that home their two concepts. `part_of` is retired and left out."""
        homes = {c.id: c for c in store.list_nodes(subject_id)}
        out = []
        for e in store.list_edges(subject_id):
            if e.kind == "part_of":
                continue
            a, b = homes.get(e.from_id), homes.get(e.to_id)
            if a is None or b is None or a.home_canvas_node_id is None:
                continue
            if b.home_canvas_node_id is None:
                continue
            if concept_ids is not None and not ({a.id, b.id} & concept_ids):
                continue
            out.append(
                {
                    "id": e.id,
                    "kind": e.kind,
                    "reason": e.reason,
                    "from_concept": {"id": a.id, "name": a.name},
                    "to_concept": {"id": b.id, "name": b.name},
                    "from_node": a.home_canvas_node_id,
                    "to_node": b.home_canvas_node_id,
                }
            )
        return out

    def subject_status(subject_id: int) -> dict:
        return store.graph_status(subject_id)

    def record_trail(visitor: str, subject: dict, node, from_node_id: int | None) -> bool:
        """Add a trail step for arriving at `node`. Arriving from itself is
        not a step, and nothing is added when the last step is already this
        node. Returns True when a step was added."""
        if from_node_id == node.id:
            from_node_id = None
        if from_node_id is not None:
            came_from = guard(store.get_node, visitor, from_node_id)
            if came_from.subject_id != subject["id"]:
                raise HTTPException(422, "from_node_id belongs to another subject.")
        last = store.last_trail_step(subject["id"])
        if last is not None and last.node_id == node.id:
            return False
        store.add_trail_step(subject["id"], node.id, from_node_id)
        return True

    @app.get("/api/health")
    def health():
        return {"ok": True}

    # ---------- subjects ----------

    @app.get("/api/subjects")
    def list_subjects(visitor: str = Depends(visitor_token)):
        return store.list_subjects(visitor)

    @app.post("/api/subjects", status_code=201)
    def create_subject(body: NewSubject, visitor: str = Depends(visitor_token)):
        return guard(store.create_subject, visitor, body.title, body.goal, body.first_question)

    @app.patch("/api/subjects/{subject_id}")
    def rename_subject(subject_id: Id, body: RenameSubject, visitor: str = Depends(visitor_token)):
        return guard(store.rename_subject, visitor, subject_id, body.title)

    # ---------- canvas ----------

    @app.get("/api/subjects/{subject_id}/canvas")
    def get_canvas(subject_id: Id, visitor: str = Depends(visitor_token)):
        subject = guard(store.get_subject, visitor, subject_id)
        nodes = store.list_canvas_nodes(subject_id)
        messages = store.subject_canvas_messages(subject_id)
        homed: dict[int, list] = {}
        for c in store.list_nodes(subject_id):
            if c.home_canvas_node_id is not None:
                homed.setdefault(c.home_canvas_node_id, []).append(c)
        active = streams.active()
        return {
            "subject": subject,
            "root_id": subject["root_canvas_node_id"],
            "nodes": [
                canvas_node_view(n, messages.get(n.id, []), homed.get(n.id, []), active)
                for n in nodes
            ],
            "links": link_views(subject_id),
            "suggestions": [
                {"id": s.id, "canvas_node_id": s.canvas_node_id, "text": s.text}
                for s in store.list_suggestions(subject_id)
            ],
            **subject_status(subject_id),
        }

    @app.get("/api/subjects/{subject_id}/canvas/status")
    def canvas_status(subject_id: Id, visitor: str = Depends(visitor_token)):
        """Cheap poll target: graph_version plus cartographer idle|running|error."""
        guard(store.get_subject, visitor, subject_id)
        return subject_status(subject_id)

    @app.get("/api/subjects/{subject_id}/search")
    def search(
        subject_id: Id,
        q: Annotated[str, Query(min_length=1, max_length=200)],
        visitor: str = Depends(visitor_token),
    ):
        guard(store.get_subject, visitor, subject_id)
        return {"query": q, "results": guard(store.search, subject_id, q)}

    @app.get("/api/canvas-nodes/{node_id}")
    def get_canvas_node(node_id: Id, visitor: str = Depends(visitor_token)):
        """The node detail panel: its conversation, the concepts first taught
        here (with evidence) and their links, plus concepts homed elsewhere
        that gained evidence here."""
        node = guard(store.get_canvas_node, visitor, node_id)
        homed = store.concepts_homed([node.id])
        homed_ids = {c.id for c in homed}

        def concept_view(c):
            return {
                "id": c.id,
                "name": c.name,
                "summary": c.summary,
                "home_canvas_node_id": c.home_canvas_node_id,
                "evidence": store.evidence_with_nodes(c.id),
            }

        messages = store.canvas_messages(node.id)
        return {
            "node": canvas_node_view(node, messages, homed, streams.active()),
            "concepts": [concept_view(c) for c in reversed(homed)],
            "also_taught_here": [
                concept_view(c)
                for c in store.concepts_evidenced_in(node.id)
                if c.id not in homed_ids
            ],
            "links": link_views(node.subject_id, homed_ids),
            "suggestions": [{"id": s.id, "text": s.text} for s in store.node_suggestions(node.id)],
        }

    @app.get("/api/canvas-nodes/{node_id}/path")
    def branch_path(node_id: Id, visitor: str = Depends(visitor_token)):
        """The chain from the root to this node, readable as one document."""
        node = guard(store.get_canvas_node, visitor, node_id)
        return {
            "nodes": [
                {
                    "id": n.id,
                    "kind": n.kind,
                    "title": n.title,
                    "keyword": n.keyword,
                    "note_body": n.note_body,
                    "messages": [message_view(m) for m in store.canvas_messages(n.id)],
                }
                for n in store.branch(node.id)
            ]
        }

    def _created(node: CanvasNode) -> dict:
        messages = store.canvas_messages(node.id)
        return canvas_node_view(node, messages, [], streams.active())

    @app.post("/api/canvas-nodes/{node_id}/children", status_code=201)
    def add_child(node_id: Id, body: NewCanvasNode, visitor: str = Depends(visitor_token)):
        if body.kind == "chat" and len(body.text) > MESSAGE_MAX:
            raise HTTPException(422, f"A question can be at most {MESSAGE_MAX} characters.")
        return _created(
            guard(store.add_canvas_node, visitor, node_id, "child", body.kind, body.text)
        )

    @app.post("/api/canvas-nodes/{node_id}/siblings", status_code=201)
    def add_sibling(node_id: Id, body: NewCanvasNode, visitor: str = Depends(visitor_token)):
        if body.kind == "chat" and len(body.text) > MESSAGE_MAX:
            raise HTTPException(422, f"A question can be at most {MESSAGE_MAX} characters.")
        return _created(
            guard(store.add_canvas_node, visitor, node_id, "sibling", body.kind, body.text)
        )

    @app.patch("/api/canvas-nodes/{node_id}")
    def edit_canvas_node(node_id: Id, body: EditCanvasNode, visitor: str = Depends(visitor_token)):
        if body.kind is None and body.prompt is None and body.note_body is None:
            raise HTTPException(422, "Nothing to change: send kind, prompt or note_body.")
        if node_id in streams.active():
            raise HTTPException(409, "A reply is being written in this node.")
        node = guard(
            store.update_canvas_node,
            visitor,
            node_id,
            kind=body.kind,
            prompt=body.prompt,
            note_body=body.note_body,
        )
        return _created(node)

    @app.delete("/api/canvas-nodes/{node_id}")
    def delete_canvas_node(
        node_id: Id,
        confirm: Literal["branch"] | None = None,
        visitor: str = Depends(visitor_token),
    ):
        node = guard(store.get_canvas_node, visitor, node_id)
        if set(store.subtree_ids(node.id)) & streams.active():
            raise HTTPException(409, "A reply is being written in this branch; stop it first.")
        return guard(store.delete_canvas_node, visitor, node_id, branch=confirm == "branch")

    @app.post("/api/suggestions/{suggestion_id}/accept", status_code=201)
    def accept_suggestion(suggestion_id: Id, visitor: str = Depends(visitor_token)):
        """Creates a child chat node with the suggestion as its first question;
        stream the answer with POST /canvas-nodes/{id}/chat and no message."""
        return _created(guard(store.accept_suggestion, visitor, suggestion_id))

    # ---------- chat (streamed) ----------

    @app.post("/api/canvas-nodes/{node_id}/chat")
    def canvas_chat(
        node_id: Id, body: CanvasChatIn | None = None, visitor: str = Depends(visitor_token)
    ):
        """Stream the tutor's reply as server-sent events:
        `start` {user_message_id, context_used}, `delta` {text}...,
        then `done` {message_id, stopped, graph_version} or, for a failure
        mid-reply, `error` {status, message, retry_after?, message_id}.
        A failure before the first piece is a plain HTTP error (429 with
        Retry-After for rate limits); the question stays, waiting for a retry.
        """
        node = guard(store.get_canvas_node, visitor, node_id)
        if node.kind != "chat":
            raise HTTPException(409, "Only a chat node talks to the tutor.")
        subject = store.get_subject(visitor, node.subject_id)
        message = body.message.strip() if body and body.message else ""
        stop = guard(streams.begin, node.id)
        try:
            history = store.canvas_messages(node.id)
            waiting = bool(history) and history[-1].role == "user"
            if message:
                if waiting:
                    raise HTTPException(
                        409,
                        "This node has a question waiting for an answer; "
                        "send no message to answer it, or edit it.",
                    )
                question = store.add_canvas_message(node.id, "user", message)
            elif waiting:
                question = history[-1]
            else:
                raise HTTPException(422, "Send a message: there is no question to answer.")
            pieces, ctx = tutor.stream_reply(store, llm, subject, node, settings.context_chars)
            try:
                first = guard(next, pieces)
            except StopIteration:
                raise HTTPException(502, "The tutor returned an empty reply.") from None
        except BaseException:
            streams.end(node.id)
            raise

        written = [first]
        finished = {"done": False}

        def finish(stopped: bool) -> Message | None:
            """Save the reply (whole or as far as it got), then let the
            cartographer run. Runs once, whichever way the stream ends."""
            if finished["done"]:
                return None
            finished["done"] = True
            close = getattr(pieces, "close", None)
            if close:
                close()
            text = "".join(written)
            saved = None
            try:
                if text.strip():
                    saved = store.add_canvas_message(node.id, "assistant", text, stopped=stopped)
            finally:
                streams.end(node.id)
            if saved is not None:
                cartographer.request(subject["id"], node.id)
                background_run(lambda: cartographer.drain(subject["id"]))
            return saved

        def events():
            try:
                yield sse(
                    "start",
                    {
                        "user_message_id": question.id,
                        "context_used": ctx.used,
                    },
                )
                yield sse("delta", {"text": first})
                stopped = False
                for piece in pieces:
                    if stop.is_set():
                        stopped = True
                        break
                    written.append(piece)
                    yield sse("delta", {"text": piece})
                stopped = stopped or stop.is_set()
                saved = finish(stopped)
                yield sse(
                    "done",
                    {
                        "message_id": saved.id if saved else None,
                        "stopped": stopped,
                        **subject_status(subject["id"]),
                    },
                )
            except LLMError as exc:
                saved = finish(True)
                yield sse(
                    "error",
                    {
                        "status": 429 if isinstance(exc, RateLimited) else 502,
                        "message": str(exc),
                        **(
                            {"retry_after": exc.retry_after} if isinstance(exc, RateLimited) else {}
                        ),
                        "message_id": saved.id if saved else None,
                    },
                )
            finally:
                # The client went away mid-reply: keep what was written.
                finish(True)

        return StreamingResponse(
            events(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @app.post("/api/canvas-nodes/{node_id}/stop")
    def stop_reply(node_id: Id, visitor: str = Depends(visitor_token)):
        guard(store.get_canvas_node, visitor, node_id)
        if not streams.stop(node_id):
            raise HTTPException(409, "No reply is being written in this node.")
        return {"stopping": True}

    @app.post("/api/canvas-nodes/{node_id}/extract")
    def extract(node_id: Id, visitor: str = Depends(visitor_token)):
        """Run the cartographer on this node now, synchronously (same per-subject lock)."""
        node = guard(store.get_canvas_node, visitor, node_id)
        subject = store.get_subject(visitor, node.subject_id)
        try:
            summary = guard(cartographer.run_now, subject, node)
        except Busy as exc:
            raise HTTPException(409, str(exc)) from exc
        if summary is None:
            raise HTTPException(409, "No new exchange since the last cartographer run.")
        return summary

    # ---------- concept graph (M1/M2 view, kept read-only) ----------

    @app.get("/api/subjects/{subject_id}/graph")
    def get_graph(subject_id: Id, visitor: str = Depends(visitor_token)):
        subject = guard(store.get_subject, visitor, subject_id)
        now = clock()
        nodes = store.list_nodes(subject_id)
        edges = store.list_edges(subject_id)
        dist = distances_from(subject["origin_node_id"], edges)
        return {
            "subject": subject,
            "nodes": [{**node_view(n, now), "distance": dist.get(n.id)} for n in nodes],
            "edges": [
                {
                    "id": e.id,
                    "source": e.from_id,
                    "target": e.to_id,
                    "kind": e.kind,
                    "reason": e.reason,
                }
                for e in edges
            ],
            "trail": [
                {"node_id": t.node_id, "from_node_id": t.from_node_id, "at": t.at}
                for t in store.list_trail(subject_id)
            ],
            **store.graph_status(subject_id),
            "extraction_stats": store.extraction_stats(subject_id),
            "proposal_stats": store.proposal_stats(subject_id),
        }

    @app.get("/api/subjects/{subject_id}/graph/status")
    def graph_status(subject_id: Id, visitor: str = Depends(visitor_token)):
        guard(store.get_subject, visitor, subject_id)
        return store.graph_status(subject_id)

    @app.get("/api/nodes/{node_id}")
    def get_concept(node_id: Id, visitor: str = Depends(visitor_token)):
        """One concept: its evidence (with the canvas node of each quote) and edges."""
        node = guard(store.get_node, visitor, node_id)
        return {
            "node": {
                **node_view(node, clock()),
                "home_canvas_node_id": node.home_canvas_node_id,
            },
            "evidence": store.evidence_with_nodes(node.id),
            "edges": [
                {
                    "id": e.id,
                    "source": e.from_id,
                    "target": e.to_id,
                    "kind": e.kind,
                    "reason": e.reason,
                }
                for _, e in store.neighbours(node.id)
            ],
        }

    @app.post("/api/nodes/{node_id}/visit")
    def visit(node_id: Id, body: VisitIn | None = None, visitor: str = Depends(visitor_token)):
        """The learner opened this concept: record a trail step."""
        node = guard(store.get_node, visitor, node_id)
        subject = store.get_subject(visitor, node.subject_id)
        from_node_id = body.from_node_id if body else None
        recorded = record_trail(visitor, subject, node, from_node_id)
        return {
            "recorded": recorded,
            "trail": [
                {"node_id": t.node_id, "from_node_id": t.from_node_id, "at": t.at}
                for t in store.list_trail(subject["id"])
            ],
        }

    # ---------- proposals (starter map) ----------

    @app.post("/api/subjects/{subject_id}/skeleton")
    def skeleton(subject_id: Id, visitor: str = Depends(visitor_token)):
        subject = guard(store.get_subject, visitor, subject_id)
        proposals = guard(propose_skeleton, store, llm, subject)
        return [proposal_view(p) for p in proposals]

    @app.get("/api/subjects/{subject_id}/proposals")
    def list_proposals(subject_id: Id, visitor: str = Depends(visitor_token)):
        guard(store.get_subject, visitor, subject_id)
        return [proposal_view(p) for p in store.list_proposals(subject_id)]

    @app.post("/api/proposals/{proposal_id}/accept")
    def accept(proposal_id: Id, visitor: str = Depends(visitor_token)):
        return proposal_view(guard(store.accept_proposal, visitor, proposal_id))

    @app.post("/api/proposals/{proposal_id}/reject")
    def reject(proposal_id: Id, visitor: str = Depends(visitor_token)):
        return proposal_view(guard(store.reject_proposal, visitor, proposal_id))

    return app
