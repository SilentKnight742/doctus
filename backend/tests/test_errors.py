"""Error handling: exact status codes, model failures, and a no-500 sweep."""

import itertools

import pytest
from fastapi.testclient import TestClient

from doctus.api import create_app
from doctus.config import Settings
from doctus.llm import FakeLLM, LLMError, RateLimited
from doctus.mastery import PlaceholderDecayModel
from doctus.store import Store

V1 = {"X-Doctus-Visitor": "visitor-one-0000000"}
V2 = {"X-Doctus-Visitor": "visitor-two-0000000"}
MISSING = 987654


@pytest.fixture
def env():
    llm = FakeLLM()
    store = Store(":memory:")
    settings = Settings(
        db_path=":memory:",
        llm_provider="fake",
        gemini_api_key=None,
        gemini_model="x",
        max_proposals_per_update=5,
        recent_turns_in_context=8,
    )
    app = create_app(store=store, llm=llm, mastery=PlaceholderDecayModel(), settings=settings)
    # 500s come back as responses, not raised exceptions, so the sweep can see them.
    return TestClient(app, raise_server_exceptions=False), llm, store


def _subject(client, headers=V1, title="German"):
    s = client.post("/api/subjects", json={"title": title}, headers=headers).json()
    return s["id"], s["origin_node_id"]


def _chat(client, node_id, message="hello", headers=V1, **extra):
    return client.post(
        f"/api/nodes/{node_id}/chat", json={"message": message, **extra}, headers=headers
    )


# ---------- 422 ----------


@pytest.mark.parametrize(
    "headers",
    [{}, {"X-Doctus-Visitor": ""}, {"X-Doctus-Visitor": "short"}, {"X-Doctus-Visitor": "x" * 129}],
)
def test_422_bad_visitor_header(env, headers):
    client, *_ = env
    assert client.get("/api/subjects", headers=headers).status_code == 422
    assert client.post("/api/subjects", json={"title": "T"}, headers=headers).status_code == 422


def test_422_message_empty_or_too_long(env):
    client, *_ = env
    _, origin = _subject(client)
    assert _chat(client, origin, "").status_code == 422
    assert _chat(client, origin, "x" * 8001).status_code == 422
    assert _chat(client, origin, "x" * 8000).status_code == 200


@pytest.mark.parametrize("title", ["", "   ", "x" * 121])
def test_422_bad_subject_title(env, title):
    client, *_ = env
    assert client.post("/api/subjects", json={"title": title}, headers=V1).status_code == 422


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("get", "/api/subjects/abc/graph"),
        ("get", "/api/subjects/1.5/graph/status"),
        ("get", "/api/nodes/abc"),
        ("post", "/api/nodes/abc/extract"),
        ("post", "/api/proposals/abc/accept"),
        # out of SQLite's integer range: used to overflow the driver (500)
        ("get", "/api/subjects/99999999999999999999/graph"),
        ("get", "/api/nodes/9223372036854775808"),
        ("get", "/api/nodes/0"),
        ("post", "/api/nodes/-1/extract"),
    ],
)
def test_422_non_integer_ids(env, method, path):
    client, *_ = env
    assert getattr(client, method)(path, headers=V1).status_code == 422


def test_422_bad_from_node_id(env):
    client, *_ = env
    _, origin = _subject(client)
    for bad in ("abc", 0, -1, 99999999999999999999):
        assert _chat(client, origin, from_node_id=bad).status_code == 422


@pytest.mark.parametrize(
    "body", ['{"title": "T"', "not json", '["a list"]', '{"title": 5}', '{"message": null}']
)
def test_422_malformed_json_body(env, body):
    client, *_ = env
    _, origin = _subject(client)
    h = {**V1, "Content-Type": "application/json"}
    assert client.post("/api/subjects", content=body, headers=h).status_code == 422
    assert client.post(f"/api/nodes/{origin}/chat", content=body, headers=h).status_code == 422


def test_422_from_node_id_from_another_subject(env):
    client, *_ = env
    _, origin_a = _subject(client, title="A")
    _, origin_b = _subject(client, title="B")
    res = _chat(client, origin_a, from_node_id=origin_b)
    assert res.status_code == 422
    assert "another subject" in res.json()["detail"]


# ---------- 404 ----------


def test_404_other_visitors_subject_and_node(env):
    client, *_ = env
    sid, origin = _subject(client)
    for res in (
        client.get(f"/api/subjects/{sid}/graph", headers=V2),
        client.get(f"/api/subjects/{sid}/graph/status", headers=V2),
        client.get(f"/api/subjects/{sid}/proposals", headers=V2),
        client.post(f"/api/subjects/{sid}/skeleton", headers=V2),
        client.get(f"/api/nodes/{origin}", headers=V2),
        _chat(client, origin, headers=V2),
        client.post(f"/api/nodes/{origin}/extract", headers=V2),
        client.post(f"/api/nodes/{origin}/update-graph", headers=V2),
    ):
        assert res.status_code == 404, res.request.url
    # and the owner's own node cannot be reached via another visitor's from_node_id
    _, other_origin = _subject(client, headers=V2, title="Theirs")
    assert _chat(client, origin, from_node_id=other_origin).status_code == 404


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("get", f"/api/subjects/{MISSING}/graph"),
        ("get", f"/api/subjects/{MISSING}/graph/status"),
        ("get", f"/api/subjects/{MISSING}/proposals"),
        ("post", f"/api/subjects/{MISSING}/skeleton"),
        ("get", f"/api/nodes/{MISSING}"),
        ("post", f"/api/nodes/{MISSING}/extract"),
        ("post", f"/api/nodes/{MISSING}/update-graph"),
        ("post", f"/api/proposals/{MISSING}/accept"),
        ("post", f"/api/proposals/{MISSING}/reject"),
    ],
)
def test_404_ids_that_do_not_exist(env, method, path):
    client, *_ = env
    assert getattr(client, method)(path, headers=V1).status_code == 404


def test_404_missing_node_in_chat_and_from_node_id(env):
    client, *_ = env
    _, origin = _subject(client)
    assert _chat(client, MISSING).status_code == 404
    assert _chat(client, origin, from_node_id=MISSING).status_code == 404


# ---------- 409 ----------


def test_409_manual_extract_with_no_new_messages(env):
    client, *_ = env
    _, origin = _subject(client)
    res = client.post(f"/api/nodes/{origin}/extract", headers=V1)
    assert res.status_code == 409
    _chat(client, origin)  # the background run consumes the new messages
    assert client.post(f"/api/nodes/{origin}/extract", headers=V1).status_code == 409


# ---------- model failures ----------


def test_cartographer_invalid_json_twice_then_recovers(env):
    client, llm, store = env
    sid, origin = _subject(client)
    llm.queue_json("not json")
    llm.queue_json("{still not json")
    res = _chat(client, origin, "first")
    assert res.status_code == 200
    status = client.get(f"/api/subjects/{sid}/graph/status", headers=V1).json()
    assert status["cartographer"] == "error"
    assert "invalid Extraction" in status["error"]
    llm.queue_json({"current_node_evidence": ["You said: second"]})
    assert _chat(client, origin, "second").status_code == 200
    status = client.get(f"/api/subjects/{sid}/graph/status", headers=V1).json()
    assert status == {"graph_version": 1, "cartographer": "idle", "error": None}
    assert store.node_by_id(origin).last_extracted_message_id == (
        store.node_messages(origin)[-1].id
    )


def test_rate_limited_tutor_returns_429_with_retry_after(env):
    client, llm, store = env
    _, origin = _subject(client)
    llm.queue_chat(RateLimited("Gemini rate limit reached; try again shortly.", retry_after=37))
    res = _chat(client, origin)
    assert res.status_code == 429
    assert res.headers["retry-after"] == "37"
    assert "rate limit" in res.json()["detail"]
    assert store.node_messages(origin) == []  # nothing saved for a failed reply


def test_other_tutor_failure_stays_502(env):
    client, llm, _ = env
    _, origin = _subject(client)
    llm.queue_chat(LLMError("Gemini API error (500): boom"))
    res = _chat(client, origin)
    assert res.status_code == 502
    assert "retry-after" not in res.headers


def test_rate_limited_manual_extract_returns_429_and_cartographer_records_it(env):
    client, llm, store = env
    sid, origin = _subject(client)
    store.add_message(sid, origin, "user", "hello")
    llm.queue_json(RateLimited("Gemini rate limit reached; try again shortly.", retry_after=5))
    res = client.post(f"/api/nodes/{origin}/extract", headers=V1)
    assert res.status_code == 429 and res.headers["retry-after"] == "5"
    status = client.get(f"/api/subjects/{sid}/graph/status", headers=V1).json()
    assert status["cartographer"] == "error" and "rate limit" in status["error"]


def test_rate_limited_background_run_does_not_break_chat(env):
    client, llm, _ = env
    sid, origin = _subject(client)
    llm.queue_json(RateLimited("Gemini rate limit reached; try again shortly."))
    assert _chat(client, origin).status_code == 200
    status = client.get(f"/api/subjects/{sid}/graph/status", headers=V1).json()
    assert status["cartographer"] == "error"


def test_gemini_429_maps_to_rate_limited_with_retry_delay():
    from google.genai import errors

    from doctus.llm.gemini import DEFAULT_RETRY_AFTER, retry_after_seconds

    body = {
        "error": {
            "code": 429,
            "status": "RESOURCE_EXHAUSTED",
            "details": [
                {"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "36.4s"}
            ],
        }
    }
    assert retry_after_seconds(errors.APIError(429, body)) == 37
    assert retry_after_seconds(errors.APIError(429, {"error": {}})) == DEFAULT_RETRY_AFTER


def test_gemini_client_raises_rate_limited_on_429(monkeypatch):
    from google.genai import errors

    from doctus.llm.gemini import GeminiLLM

    llm = GeminiLLM(api_key="test-key", model="x")
    body = {"error": {"code": 429, "details": [{"retryDelay": "12s"}]}}

    def boom(**_):
        raise errors.APIError(429, body)

    monkeypatch.setattr(llm._client.models, "generate_content", boom)
    with pytest.raises(RateLimited) as caught:
        llm.chat("s", [])
    assert caught.value.retry_after == 12

    def other(**_):
        raise errors.APIError(503, {"error": {"code": 503}})

    monkeypatch.setattr(llm._client.models, "generate_content", other)
    with pytest.raises(LLMError) as caught:
        llm.chat("s", [])
    assert not isinstance(caught.value, RateLimited)


# ---------- sweep: no 500 anywhere ----------

BAD_IDS = ["0", "-1", str(MISSING), "9223372036854775807", "99999999999999999999", "abc", "1e3"]
BAD_BODIES = [
    None,
    {},
    {"message": ""},
    {"message": None},
    {"message": 5},
    {"message": "x" * 8001},
    {"message": "hi", "from_node_id": "abc"},
    {"message": "hi", "from_node_id": -1},
    {"message": "hi", "from_node_id": 99999999999999999999},
    {"message": "\x00 null byte and emoji \U0001f600"},
    {"title": ""},
    {"title": None},
    {"title": "x" * 121},
    {"title": "ok", "goal": "x" * 1001},
    {"title": "\x00"},
    [1, 2, 3],
    "plain string",
]
ROUTES = [
    ("get", "/api/subjects/{id}/graph"),
    ("get", "/api/subjects/{id}/graph/status"),
    ("get", "/api/subjects/{id}/proposals"),
    ("post", "/api/subjects/{id}/skeleton"),
    ("get", "/api/nodes/{id}"),
    ("post", "/api/nodes/{id}/chat"),
    ("post", "/api/nodes/{id}/extract"),
    ("post", "/api/nodes/{id}/update-graph"),
    ("post", "/api/proposals/{id}/accept"),
    ("post", "/api/proposals/{id}/reject"),
]


def test_sweep_no_500_on_bad_ids_bodies_and_headers(env):
    client, *_ = env
    _, origin = _subject(client)
    seen = []
    headers_options = [V1, V2, {}, {"X-Doctus-Visitor": "short"}]
    ids = [*BAD_IDS, str(origin)]
    for (method, route), raw_id, headers in itertools.product(ROUTES, ids, headers_options):
        path = route.format(id=raw_id)
        # Only chat reads a body; other routes get one junk body to prove they ignore it.
        if route.endswith("/chat"):
            bodies = BAD_BODIES
        else:
            bodies = [None, {"junk": 1}] if method == "post" else [None]
        for body in bodies:
            kwargs = {"headers": headers}
            if body is not None:
                kwargs["json"] = body
            res = getattr(client, method)(path, **kwargs)
            seen.append(res.status_code)
            assert res.status_code < 500, (method, path, body, headers, res.text[:200])
    for body in BAD_BODIES:
        for headers in headers_options:
            res = client.post("/api/subjects", json=body, headers=headers)
            assert res.status_code < 500, (body, headers, res.text[:200])
    assert {404, 409, 422} <= set(seen)
