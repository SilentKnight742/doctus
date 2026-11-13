"""HTTP API.

Visitors are anonymous: the browser generates a random token once and
sends it as the `X-Doctus-Visitor` header. All data is scoped to it.
"""

import time

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from .config import Settings, load_settings
from .context import build_topic_context
from .graph import propose_skeleton, propose_update
from .llm import LLM, LLMError, Turn, make_llm
from .mastery import MasteryModel, PlaceholderDecayModel
from .prompts import TUTOR_SYSTEM
from .store import Conflict, NotFound, Store


class NewSubject(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    goal: str = Field(default="", max_length=1000)


class ChatIn(BaseModel):
    message: str = Field(min_length=1, max_length=8000)


def visitor_token(x_doctus_visitor: str = Header(min_length=16, max_length=128)) -> str:
    return x_doctus_visitor


def create_app(
    store: Store | None = None,
    llm: LLM | None = None,
    mastery: MasteryModel | None = None,
    settings: Settings | None = None,
    clock=time.time,
) -> FastAPI:
    settings = settings or load_settings()
    store = store or Store(settings.db_path)
    llm = llm or make_llm(settings)
    mastery = mastery or PlaceholderDecayModel()

    app = FastAPI(title="Doctus", version="0.1.0")

    def guard(fn, *args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except NotFound as exc:
            raise HTTPException(404, str(exc))
        except Conflict as exc:
            raise HTTPException(409, str(exc))
        except ValueError as exc:
            raise HTTPException(422, str(exc))
        except LLMError as exc:
            raise HTTPException(502, str(exc))

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
    def get_graph(subject_id: int, visitor: str = Depends(visitor_token)):
        subject = guard(store.get_subject, visitor, subject_id)
        now = clock()
        nodes = store.list_nodes(subject_id)
        return {
            "subject": subject,
            "nodes": [node_view(n, now) for n in nodes],
            "edges": [
                {"id": e.id, "source": e.prereq_id, "target": e.node_id, "reason": e.reason}
                for e in store.list_edges(subject_id)
            ],
            "proposal_stats": store.proposal_stats(subject_id),
        }

    # ---------- proposals ----------

    @app.post("/api/subjects/{subject_id}/skeleton")
    def skeleton(subject_id: int, visitor: str = Depends(visitor_token)):
        subject = guard(store.get_subject, visitor, subject_id)
        proposals = guard(propose_skeleton, store, llm, subject)
        return [proposal_view(p) for p in proposals]

    @app.get("/api/subjects/{subject_id}/proposals")
    def list_proposals(subject_id: int, visitor: str = Depends(visitor_token)):
        guard(store.get_subject, visitor, subject_id)
        return [proposal_view(p) for p in store.list_proposals(subject_id)]

    @app.post("/api/proposals/{proposal_id}/accept")
    def accept(proposal_id: int, visitor: str = Depends(visitor_token)):
        return proposal_view(guard(store.accept_proposal, visitor, proposal_id))

    @app.post("/api/proposals/{proposal_id}/reject")
    def reject(proposal_id: int, visitor: str = Depends(visitor_token)):
        return proposal_view(guard(store.reject_proposal, visitor, proposal_id))

    # ---------- topic chat ----------

    @app.get("/api/nodes/{node_id}")
    def get_node(node_id: int, visitor: str = Depends(visitor_token)):
        node = guard(store.get_node, visitor, node_id)
        subject = store.get_subject(visitor, node.subject_id)
        now = clock()
        ctx = build_topic_context(store, mastery, subject, node, now)
        messages = store.recent_messages(subject["id"], node.id, limit=200)
        return {
            "node": node_view(node, now),
            "context": ctx.used,
            "messages": [
                {"id": m.id, "role": m.role, "content": m.content, "created_at": m.created_at}
                for m in messages
            ],
        }

    @app.post("/api/nodes/{node_id}/chat")
    def topic_chat(node_id: int, body: ChatIn, visitor: str = Depends(visitor_token)):
        node = guard(store.get_node, visitor, node_id)
        subject = store.get_subject(visitor, node.subject_id)
        now = clock()
        ctx = build_topic_context(store, mastery, subject, node, now)
        history = store.recent_messages(subject["id"], node.id, settings.recent_turns_in_context)
        turns = [Turn(m.role, m.content) for m in history] + [Turn("user", body.message)]
        reply = guard(llm.chat, TUTOR_SYSTEM.format(context=ctx.text), turns)
        # Save only after the model answered, so a failed call leaves no orphan message.
        store.add_message(subject["id"], node.id, "user", body.message)
        store.add_message(subject["id"], node.id, "assistant", reply)
        store.mark_visited(node.id)
        return {
            "reply": reply,
            "context_used": {**ctx.used, "recent_turns": len(history)},
        }

    @app.post("/api/nodes/{node_id}/update-graph")
    def update_graph(node_id: int, visitor: str = Depends(visitor_token)):
        node = guard(store.get_node, visitor, node_id)
        subject = store.get_subject(visitor, node.subject_id)
        history = store.recent_messages(subject["id"], node.id, settings.recent_turns_in_context)
        if not history:
            raise HTTPException(409, "Chat about this concept first.")
        turns = [Turn(m.role, m.content) for m in history]
        proposals = guard(
            propose_update, store, llm, subject, node.id, turns,
            settings.max_proposals_per_update,
        )
        return [proposal_view(p) for p in proposals]

    return app
