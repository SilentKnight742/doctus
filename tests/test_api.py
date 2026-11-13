import pytest
from fastapi.testclient import TestClient

from doctus.api import create_app
from doctus.config import Settings
from doctus.llm import FakeLLM
from doctus.mastery import DAY, PlaceholderDecayModel
from doctus.store import Store

V1 = {"X-Doctus-Visitor": "visitor-one-0000000"}
V2 = {"X-Doctus-Visitor": "visitor-two-0000000"}

SKELETON = {
    "concepts": [
        {"name": "Vectors", "summary": "Lists of numbers."},
        {"name": "Dot product", "summary": "Similarity of two vectors."},
        {"name": "Attention", "summary": "Weighted mixing of values."},
        {"name": "vectors", "summary": "duplicate in different case"},
    ],
    "links": [
        {"prerequisite": "Vectors", "concept": "Dot product", "reason": "operates on vectors"},
        {"prerequisite": "Dot product", "concept": "Attention", "reason": "scores use it"},
        {"prerequisite": "Attention", "concept": "Attention", "reason": "self link"},
        {"prerequisite": "Unknown thing", "concept": "Attention", "reason": "not proposed"},
    ],
}


class Clock:
    def __init__(self):
        self.now = 1_000_000.0

    def __call__(self):
        return self.now


@pytest.fixture
def env():
    clock = Clock()
    llm = FakeLLM()
    store = Store(":memory:", clock=clock)
    settings = Settings(
        db_path=":memory:", llm_provider="fake", gemini_api_key=None,
        gemini_model="x", max_proposals_per_update=5, recent_turns_in_context=8,
    )
    app = create_app(store=store, llm=llm, mastery=PlaceholderDecayModel(),
                     settings=settings, clock=clock)
    return TestClient(app), llm, store, clock


def _subject_with_graph(client, llm):
    subject = client.post("/api/subjects", json={"title": "Transformers", "goal": "read papers"},
                          headers=V1).json()
    llm.queue_json(SKELETON)
    proposals = client.post(f"/api/subjects/{subject['id']}/skeleton", headers=V1).json()
    for p in proposals:
        assert client.post(f"/api/proposals/{p['id']}/accept", headers=V1).status_code == 200
    return subject, client.get(f"/api/subjects/{subject['id']}/graph", headers=V1).json()


def test_visitor_header_required(env):
    client, *_ = env
    assert client.get("/api/subjects").status_code == 422


def test_skeleton_filters_duplicates_self_links_and_unknown_names(env):
    client, llm, *_ = env
    subject = client.post("/api/subjects", json={"title": "Transformers"}, headers=V1).json()
    llm.queue_json(SKELETON)
    proposals = client.post(f"/api/subjects/{subject['id']}/skeleton", headers=V1).json()
    kinds = [(p["kind"], p.get("name") or (p["prerequisite"], p["concept"])) for p in proposals]
    assert kinds == [
        ("node", "Vectors"),
        ("node", "Dot product"),
        ("node", "Attention"),
        ("edge", ("Vectors", "Dot product")),
        ("edge", ("Dot product", "Attention")),
    ]


def test_accepting_skeleton_builds_graph(env):
    client, llm, *_ = env
    _, graph = _subject_with_graph(client, llm)
    names = [n["name"] for n in graph["nodes"]]
    assert names == ["Transformers", "Vectors", "Dot product", "Attention"]  # origin first
    assert len(graph["edges"]) == 2
    assert graph["proposal_stats"]["accepted"] == 5
    assert all(n["level"] == 0 for n in graph["nodes"])


def test_other_visitor_cannot_see_graph(env):
    client, llm, *_ = env
    subject, _ = _subject_with_graph(client, llm)
    assert client.get(f"/api/subjects/{subject['id']}/graph", headers=V2).status_code == 404


def test_topic_chat_uses_prerequisites_as_context(env):
    client, llm, *_ = env
    _, graph = _subject_with_graph(client, llm)
    attention = next(n for n in graph["nodes"] if n["name"] == "Attention")
    llm.queue_chat("Attention mixes values using dot-product scores.")
    res = client.post(f"/api/nodes/{attention['id']}/chat",
                      json={"message": "What is attention?"}, headers=V1).json()

    assert res["reply"].startswith("Attention mixes")
    assert [p["name"] for p in res["context_used"]["prerequisites"]] == ["Dot product"]
    system_prompt = llm.calls[-1]["system"]
    assert "Current concept: Attention" in system_prompt
    assert "Dot product" in system_prompt

    detail = client.get(f"/api/nodes/{attention['id']}", headers=V1).json()
    assert [m["role"] for m in detail["messages"]] == ["user", "assistant"]
    assert detail["node"]["last_visited_at"] is not None


def test_chat_history_is_sent_to_model(env):
    client, llm, *_ = env
    _, graph = _subject_with_graph(client, llm)
    node_id = graph["nodes"][0]["id"]
    client.post(f"/api/nodes/{node_id}/chat", json={"message": "first"}, headers=V1)
    client.post(f"/api/nodes/{node_id}/chat", json={"message": "second"}, headers=V1)
    turns = llm.calls[-1]["turns"]
    assert [t.content for t in turns][0] == "first"
    assert turns[-1].content == "second"


def test_update_graph_requires_chat_then_proposes(env):
    client, llm, *_ = env
    _, graph = _subject_with_graph(client, llm)
    attention = next(n for n in graph["nodes"] if n["name"] == "Attention")
    assert client.post(f"/api/nodes/{attention['id']}/update-graph",
                       headers=V1).status_code == 409

    client.post(f"/api/nodes/{attention['id']}/chat",
                json={"message": "and softmax?"}, headers=V1)
    llm.queue_json({
        "concepts": [{"name": "Softmax", "summary": "Turns scores into weights."},
                     {"name": "Attention", "summary": "already exists"}],
        "links": [{"prerequisite": "Softmax", "concept": "Attention", "reason": "normalises"}],
    })
    proposals = client.post(f"/api/nodes/{attention['id']}/update-graph", headers=V1).json()
    assert [(p["kind"], p.get("name")) for p in proposals] == [("node", "Softmax"), ("edge", None)]
    assert proposals[0]["origin"] == f"chat:node:{attention['id']}"


def test_edge_accept_before_node_gives_clear_409(env):
    client, llm, *_ = env
    subject = client.post("/api/subjects", json={"title": "T"}, headers=V1).json()
    llm.queue_json(SKELETON)
    proposals = client.post(f"/api/subjects/{subject['id']}/skeleton", headers=V1).json()
    edge = next(p for p in proposals if p["kind"] == "edge")
    res = client.post(f"/api/proposals/{edge['id']}/accept", headers=V1)
    assert res.status_code == 409
    assert "Accept these concepts first" in res.json()["detail"]


def test_bad_model_output_returns_502(env):
    client, llm, *_ = env
    subject = client.post("/api/subjects", json={"title": "T"}, headers=V1).json()
    llm.queue_json("garbage")
    llm.queue_json("still garbage")
    assert client.post(f"/api/subjects/{subject['id']}/skeleton", headers=V1).status_code == 502


def test_graph_shows_strength_decay(env):
    client, llm, store, clock = env
    _, graph = _subject_with_graph(client, llm)
    node_id = graph["nodes"][0]["id"]
    model = PlaceholderDecayModel()
    store.set_mastery(node_id, model.record_test({}, 1.0, clock.now))
    subject_id = graph["subject"]["id"]

    fresh = client.get(f"/api/subjects/{subject_id}/graph", headers=V1).json()["nodes"][0]
    clock.now += 5 * DAY
    later = client.get(f"/api/subjects/{subject_id}/graph", headers=V1).json()["nodes"][0]
    assert fresh["strength"] > later["strength"] > 0
