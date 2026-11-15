"""HTTP API.

Visitors are anonymous: the browser generates a random token once and
sends it as the `X-Doctus-Visitor` header. All data is scoped to it.
"""

import time
from typing import Annotated

from fastapi import BackgroundTasks, Depends, FastAPI, Header, HTTPException, Path
from pydantic import BaseModel, Field

from . import tutor
from .cartographer import Busy, CartographerRunner
from .config import Settings, load_settings
from .context import build_topic_context
from .graph import distances_from, propose_skeleton, propose_update
from .llm import LLM, LLMError, RateLimited, Turn, make_llm
from .mastery import MasteryModel, PlaceholderDecayModel
from .store import Conflict, NotFound, Store

# SQLite integers are signed 64-bit; anything outside 1..MAX_ID cannot be an
# id, and would overflow the driver, so it is rejected as 422 up front.
MAX_ID = 2**63 - 1
Id = Annotated[int, Path(ge=1, le=MAX_ID)]


class NewSubject(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    goal: str = Field(default="", max_length=1000)


class ChatIn(BaseModel):
    message: str = Field(min_length=1, max_length=8000)
    # The node the learner came from; recorded on the trail when they
    # arrive at this node's chat.
    from_node_id: int | None = Field(default=None, ge=1, le=MAX_ID)


def visitor_token(x_doctus_visitor: str = Header(min_length=16, max_length=128)) -> str:
    return x_doctus_visitor


def create_app(
    store: Store | None = None,
    llm: LLM | None = None,
    mastery: MasteryModel | None = None,
    settings: Settings | None = None,
    clock=time.time,
    graph_llm: LLM | None = None,
) -> FastAPI:
    """`llm` is the tutor's model; `graph_llm` the cartographer's (defaults to
    `llm`, or to DOCTUS_GRAPH_MODEL when that is set)."""
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

    app = FastAPI(title="Doctus", version="0.3.0")
    app.state.store = store
    app.state.cartographer = cartographer

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

    @app.get("/api/health")
    def health():
        return {"ok": True}

    # ---------- subjects ----------

    @app.get("/api/subjects")
    def list_subjects(visitor: str = Depends(visitor_token)):
        return store.list_subjects(visitor)

    @app.post("/api/subjects", status_code=201)
    def create_subject(body: NewSubject, visitor: str = Depends(visitor_token)):
        return guard(store.create_subject, visitor, body.title, body.goal)

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
        """Cheap poll target: graph_version plus cartographer idle|running|error."""
        guard(store.get_subject, visitor, subject_id)
        return store.graph_status(subject_id)

    # ---------- proposals ----------

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

    # ---------- topic chat ----------

    @app.get("/api/nodes/{node_id}")
    def get_node(node_id: Id, visitor: str = Depends(visitor_token)):
        node = guard(store.get_node, visitor, node_id)
        subject = store.get_subject(visitor, node.subject_id)
        now = clock()
        ctx = build_topic_context(store, subject, node)
        messages = store.recent_messages(subject["id"], node.id, limit=200)
        return {
            "node": node_view(node, now),
            "evidence": [
                {"message_id": e.message_id, "quote": e.quote} for e in store.list_evidence(node.id)
            ],
            # Every edge touching this node, by id. Nodes are flat: a node
            # opened from another is just a node joined to it by an edge.
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
            "context": ctx.used,
            "messages": [
                {"id": m.id, "role": m.role, "content": m.content, "created_at": m.created_at}
                for m in messages
            ],
        }

    @app.post("/api/nodes/{node_id}/chat")
    def topic_chat(
        node_id: Id,
        body: ChatIn,
        background: BackgroundTasks,
        visitor: str = Depends(visitor_token),
    ):
        node = guard(store.get_node, visitor, node_id)
        subject = store.get_subject(visitor, node.subject_id)
        from_node_id = body.from_node_id
        if from_node_id == node.id:
            from_node_id = None  # arriving from itself is not a step
        if from_node_id is not None:
            came_from = guard(store.get_node, visitor, from_node_id)
            if came_from.subject_id != subject["id"]:
                raise HTTPException(422, "from_node_id belongs to another subject.")
        answer, ctx, history_turns = guard(
            tutor.reply,
            store,
            llm,
            subject,
            node,
            body.message,
            settings.recent_turns_in_context,
        )
        # Save only after the model answered, so a failed call leaves no orphan message.
        store.add_message(subject["id"], node.id, "user", body.message)
        store.add_message(subject["id"], node.id, "assistant", answer)
        store.mark_visited(node.id)
        last = store.last_trail_step(subject["id"])
        if last is None or last.node_id != node.id:
            store.add_trail_step(subject["id"], node.id, from_node_id)

        # The cartographer runs after the response is sent, so the reply is
        # never delayed. Poll /graph/status for the result.
        cartographer.request(subject["id"], node.id)
        background.add_task(cartographer.drain, subject["id"])
        return {
            "reply": answer,
            "context_used": {**ctx.used, "recent_turns": history_turns},
            **store.graph_status(subject["id"]),
        }

    @app.post("/api/nodes/{node_id}/extract")
    def extract(node_id: Id, visitor: str = Depends(visitor_token)):
        """Run the cartographer now, synchronously (same per-subject lock)."""
        node = guard(store.get_node, visitor, node_id)
        subject = store.get_subject(visitor, node.subject_id)
        try:
            summary = guard(cartographer.run_now, subject, node)
        except Busy as exc:
            raise HTTPException(409, str(exc)) from exc
        if summary is None:
            raise HTTPException(409, "No new messages since the last cartographer run.")
        return summary

    @app.post("/api/nodes/{node_id}/update-graph")
    def update_graph(node_id: Id, visitor: str = Depends(visitor_token)):
        node = guard(store.get_node, visitor, node_id)
        subject = store.get_subject(visitor, node.subject_id)
        history = store.recent_messages(subject["id"], node.id, settings.recent_turns_in_context)
        if not history:
            raise HTTPException(409, "Chat about this concept first.")
        turns = [Turn(m.role, m.content) for m in history]
        proposals = guard(
            propose_update,
            store,
            llm,
            subject,
            node.id,
            turns,
            settings.max_proposals_per_update,
        )
        return [proposal_view(p) for p in proposals]

    return app
