"""Shared fixtures for the canvas (M3) tests."""

import json

import pytest
from fastapi.testclient import TestClient

from doctus.api import create_app
from doctus.config import Settings
from doctus.llm import FakeLLM
from doctus.mastery import PlaceholderDecayModel
from doctus.store import Store

V1 = {"X-Doctus-Visitor": "visitor-one-0000000"}
V2 = {"X-Doctus-Visitor": "visitor-two-0000000"}


def settings(**overrides) -> Settings:
    return Settings(
        db_path=":memory:", llm_provider="fake", gemini_api_key=None, gemini_model="x", **overrides
    )


def make_client(llm=None, store=None, sync=True, **setting_overrides):
    """A client whose cartographer runs synchronously right after each reply
    (`sync=False` uses the real background thread)."""
    llm = llm or FakeLLM()
    store = store or Store(":memory:")
    app = create_app(
        store=store,
        llm=llm,
        mastery=PlaceholderDecayModel(),
        settings=settings(**setting_overrides),
        run_in_background=(lambda fn: fn()) if sync else None,
    )
    # 500s come back as responses, not raised exceptions, so sweeps can see them.
    return TestClient(app, raise_server_exceptions=False), llm, store


@pytest.fixture
def canvas():
    return make_client()


def events(text: str) -> list[tuple[str, dict]]:
    """Parse a server-sent-events body into (event, data) pairs."""
    out = []
    for block in text.strip().split("\n\n"):
        name, data = None, None
        for line in block.splitlines():
            if line.startswith("event: "):
                name = line[len("event: ") :]
            elif line.startswith("data: "):
                data = json.loads(line[len("data: ") :])
        if name:
            out.append((name, data))
    return out


def reply_text(text: str) -> str:
    return "".join(d["text"] for e, d in events(text) if e == "delta")


def new_subject(client, title="German", headers=V1, **extra) -> tuple[dict, int]:
    res = client.post("/api/subjects", json={"title": title, **extra}, headers=headers)
    assert res.status_code == 201, res.text
    s = res.json()
    return s, s["root_canvas_node_id"]


def chat(client, node_id, message=None, headers=V1):
    body = {} if message is None else {"message": message}
    return client.post(f"/api/canvas-nodes/{node_id}/chat", json=body, headers=headers)


def child(client, node_id, text, kind="chat", headers=V1):
    return client.post(
        f"/api/canvas-nodes/{node_id}/children", json={"kind": kind, "text": text}, headers=headers
    )


def sibling(client, node_id, text, kind="chat", headers=V1):
    return client.post(
        f"/api/canvas-nodes/{node_id}/siblings", json={"kind": kind, "text": text}, headers=headers
    )


def canvas_of(client, subject_id, headers=V1) -> dict:
    res = client.get(f"/api/subjects/{subject_id}/canvas", headers=headers)
    assert res.status_code == 200, res.text
    return res.json()


def extraction(**fields) -> dict:
    base = {"title": "", "keyword": "", "concepts": [], "links": [], "suggestions": []}
    return {**base, **fields}


def concept(name, quote, summary=None) -> dict:
    return {
        "name": name,
        "summary": summary if summary is not None else f"about {name}",
        "evidence": [quote] if quote else [],
    }


def calls(llm, kind):
    return [c for c in llm.calls if c["kind"] == kind]
