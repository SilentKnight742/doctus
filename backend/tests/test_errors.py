"""Error handling: exact status codes, model failures, and a no-500 sweep
over every route (other visitor -> 404, bad ids -> 422, never a 500)."""

import itertools

import pytest

from conftest import V1, V2, chat, child, make_client, new_subject
from doctus.llm import LLMError, RateLimited

MISSING = 987654


@pytest.fixture
def env():
    return make_client()


def _setup(client):
    """A subject with a root chat, a child chat, a note and a suggestion."""
    s, root = new_subject(client)
    client.app.state.cartographer.llm.queue_json(
        {"title": "T", "keyword": "t", "suggestions": ["Next?"]}
    )
    chat(client, root, "hello")
    a = child(client, root, "child?").json()["id"]
    note = child(client, root, "note", kind="note").json()["id"]
    suggestion = client.get(f"/api/subjects/{s['id']}/canvas", headers=V1).json()["suggestions"]
    return {"subject": s["id"], "root": root, "child": a, "note": note, "sugg": suggestion[0]["id"]}


# Every route that takes an id: (method, path, json body for a valid call).
ID_ROUTES = [
    ("patch", "/api/subjects/{id}", {"title": "New"}),
    ("get", "/api/subjects/{id}/canvas", None),
    ("get", "/api/subjects/{id}/canvas/status", None),
    ("get", "/api/subjects/{id}/search?q=hello", None),
    ("get", "/api/subjects/{id}/graph", None),
    ("get", "/api/subjects/{id}/graph/status", None),
    ("get", "/api/subjects/{id}/proposals", None),
    ("post", "/api/subjects/{id}/skeleton", None),
    ("get", "/api/canvas-nodes/{id}", None),
    ("get", "/api/canvas-nodes/{id}/path", None),
    ("post", "/api/canvas-nodes/{id}/children", {"kind": "chat", "text": "q"}),
    ("post", "/api/canvas-nodes/{id}/siblings", {"kind": "note", "text": "n"}),
    ("patch", "/api/canvas-nodes/{id}", {"prompt": "edited"}),
    ("delete", "/api/canvas-nodes/{id}", None),
    ("post", "/api/canvas-nodes/{id}/chat", {"message": "hi"}),
    ("post", "/api/canvas-nodes/{id}/stop", None),
    ("post", "/api/canvas-nodes/{id}/extract", None),
    ("post", "/api/suggestions/{id}/accept", None),
    ("get", "/api/nodes/{id}", None),
    ("post", "/api/nodes/{id}/visit", None),
    ("post", "/api/proposals/{id}/accept", None),
    ("post", "/api/proposals/{id}/reject", None),
]


def _owner_id(ids, path):
    if path.startswith("/api/subjects"):
        return ids["subject"]
    if path.startswith("/api/suggestions"):
        return ids["sugg"]
    return ids["child"]


def _call(client, method, path, body, headers):
    kwargs = {"headers": headers}
    if body is not None:
        kwargs["json"] = body
    return getattr(client, method)(path, **kwargs)


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
    _, root = new_subject(client)
    assert chat(client, root, "").status_code == 422
    assert chat(client, root, "x" * 8001).status_code == 422
    assert chat(client, root, "x" * 8000).status_code == 200


@pytest.mark.parametrize("title", ["", "   ", "x" * 121])
def test_422_bad_subject_title(env, title):
    client, *_ = env
    assert client.post("/api/subjects", json={"title": title}, headers=V1).status_code == 422


def test_422_bad_first_question(env):
    client, *_ = env
    for bad in ({"title": "T", "first_question": "x" * 8001}, {"title": "T", "first_question": 5}):
        assert client.post("/api/subjects", json=bad, headers=V1).status_code == 422


@pytest.mark.parametrize(("method", "route", "body"), ID_ROUTES)
@pytest.mark.parametrize(
    "raw", ["abc", "1.5", "0", "-1", "99999999999999999999", "9223372036854775808"]
)
def test_422_bad_ids_on_every_route(env, method, route, body, raw):
    client, *_ = env
    res = _call(client, method, route.format(id=raw), body, V1)
    assert res.status_code == 422, (method, route, raw, res.text[:200])


@pytest.mark.parametrize(
    "body", ['{"title": "T"', "not json", '["a list"]', '{"title": 5}', '{"message": null}']
)
def test_422_malformed_json_body(env, body):
    client, *_ = env
    _, root = new_subject(client)
    h = {**V1, "Content-Type": "application/json"}
    assert client.post("/api/subjects", content=body, headers=h).status_code == 422
    res = client.post(f"/api/canvas-nodes/{root}/children", content=body, headers=h)
    assert res.status_code == 422


# ---------- 404 ----------


@pytest.mark.parametrize(("method", "route", "body"), ID_ROUTES)
def test_404_other_visitor_on_every_route(env, method, route, body):
    client, *_ = env
    ids = _setup(client)
    if route.startswith(("/api/nodes", "/api/proposals")):
        store = client.app.state.store
        if route.startswith("/api/nodes"):
            target = store.insert_node(ids["subject"], "Concept", "").id
        else:
            (p,) = store.add_proposals(ids["subject"], [("node", {"name": "P"})], "test")
            target = p.id
    else:
        target = _owner_id(ids, route)
    res = _call(client, method, route.format(id=target), body, V2)
    assert res.status_code == 404, (method, route, res.text[:200])


@pytest.mark.parametrize(("method", "route", "body"), ID_ROUTES)
def test_404_ids_that_do_not_exist(env, method, route, body):
    client, *_ = env
    res = _call(client, method, route.format(id=MISSING), body, V1)
    assert res.status_code == 404, (method, route, res.text[:200])


# ---------- 409 ----------


def test_409_manual_extract_with_no_new_exchange(env):
    client, *_ = env
    _, root = new_subject(client)
    assert client.post(f"/api/canvas-nodes/{root}/extract", headers=V1).status_code == 409
    chat(client, root, "hi")  # the run after the reply consumes the exchange
    assert client.post(f"/api/canvas-nodes/{root}/extract", headers=V1).status_code == 409


# ---------- model failures ----------


def test_cartographer_invalid_json_twice_then_recovers(env):
    client, llm, store = env
    s, root = new_subject(client)
    llm.queue_json("not json")
    llm.queue_json("{still not json")
    assert chat(client, root, "first").status_code == 200
    status = client.get(f"/api/subjects/{s['id']}/canvas/status", headers=V1).json()
    assert status["cartographer"] == "error" and "invalid CanvasExtraction" in status["error"]
    llm.queue_json({"title": "Second"})
    assert chat(client, root, "second").status_code == 200
    status = client.get(f"/api/subjects/{s['id']}/canvas/status", headers=V1).json()
    assert status["cartographer"] == "idle" and status["error"] is None
    assert store.canvas_node_by_id(root).last_extracted_message_id == (
        store.canvas_messages(root)[-1].id
    )


def test_rate_limited_manual_extract_returns_429_and_cartographer_records_it(env):
    client, llm, store = env
    s, root = new_subject(client)
    store.add_canvas_message(root, "user", "hello")
    store.add_canvas_message(root, "assistant", "hi")
    llm.queue_json(RateLimited("Gemini rate limit reached; try again shortly.", retry_after=5))
    res = client.post(f"/api/canvas-nodes/{root}/extract", headers=V1)
    assert res.status_code == 429 and res.headers["retry-after"] == "5"
    status = client.get(f"/api/subjects/{s['id']}/canvas/status", headers=V1).json()
    assert status["cartographer"] == "error" and "rate limit" in status["error"]


def test_rate_limited_background_run_does_not_break_chat(env):
    client, llm, _ = env
    s, root = new_subject(client)
    llm.queue_json(RateLimited("Gemini rate limit reached; try again shortly."))
    assert chat(client, root, "hi").status_code == 200
    status = client.get(f"/api/subjects/{s['id']}/canvas/status", headers=V1).json()
    assert status["cartographer"] == "error"


def test_tutor_failures_map_to_429_and_502(env):
    client, llm, _ = env
    _, root = new_subject(client)
    llm.queue_chat(RateLimited("Gemini rate limit reached; try again shortly.", retry_after=37))
    res = chat(client, root, "x")
    assert res.status_code == 429 and res.headers["retry-after"] == "37"
    llm.queue_chat(LLMError("Gemini API error (500): boom"))
    res = chat(client, root)
    assert res.status_code == 502 and "retry-after" not in res.headers


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


def test_gemini_stream_raises_rate_limited_on_429(monkeypatch):
    from google.genai import errors

    from doctus.llm.gemini import GeminiLLM

    llm = GeminiLLM(api_key="test-key", model="x")

    def boom(**_):
        def gen():
            raise errors.APIError(429, {"error": {"code": 429, "details": [{"retryDelay": "8s"}]}})
            yield  # pragma: no cover

        return gen()

    monkeypatch.setattr(llm._client.models, "generate_content_stream", boom)
    with pytest.raises(RateLimited) as caught:
        next(llm.chat_stream("s", []))
    assert caught.value.retry_after == 8

    class Chunk:
        def __init__(self, text):
            self.text = text

    monkeypatch.setattr(
        llm._client.models,
        "generate_content_stream",
        lambda **_: iter([Chunk("Hal"), Chunk(None), Chunk("lo")]),
    )
    assert list(llm.chat_stream("s", [])) == ["Hal", "lo"]
    monkeypatch.setattr(llm._client.models, "generate_content_stream", lambda **_: iter([]))
    with pytest.raises(LLMError, match="empty"):
        list(llm.chat_stream("s", []))


# ---------- sweep: no 500 anywhere ----------

BAD_IDS = ["0", "-1", str(MISSING), "9223372036854775807", "99999999999999999999", "abc", "1e3"]
BAD_BODIES = [
    None,
    {},
    {"message": ""},
    {"message": None},
    {"message": 5},
    {"message": "x" * 8001},
    {"message": "\x00 null byte and emoji \U0001f600"},
    {"title": ""},
    {"title": None},
    {"title": "x" * 121},
    {"title": "ok", "goal": "x" * 1001},
    {"title": "\x00"},
    {"kind": "chat", "text": ""},
    {"kind": "note", "text": "x" * 20001},
    {"kind": "map"},
    {"kind": None, "prompt": None, "note_body": None},
    {"prompt": "  "},
    {"prompt": 5},
    {"note_body": "\x00"},
    {"from_node_id": "abc"},
    [1, 2, 3],
    "plain string",
]


def test_sweep_no_500_on_bad_ids_bodies_and_headers(env):
    client, *_ = env
    with client:  # one event-loop portal for the whole sweep (much faster)
        _sweep(client)


def _sweep(client):
    ids = _setup(client)
    seen = []
    headers_options = [V1, V2, {}, {"X-Doctus-Visitor": "short"}]
    for (method, route, _body), headers in itertools.product(ID_ROUTES, headers_options):
        real = [str(_owner_id(ids, route)), str(ids["note"]), str(ids["root"]), str(MISSING)]
        # Bad ids are checked in full as the owner (and per route in the 422 test).
        for raw in [*(BAD_IDS if headers is V1 else BAD_IDS[:2]), *real]:
            path = route.format(id=raw)
            # Every bad body against real ids as the owner; one junk body elsewhere.
            if method not in ("post", "patch"):
                bodies = [None]
            elif headers is V1 and raw in real:
                bodies = BAD_BODIES
            else:
                bodies = [None, {"junk": 1}]
            for body in bodies:
                res = _call(client, method, path, body, headers)
                seen.append(res.status_code)
                assert res.status_code < 500, (method, path, body, headers, res.text[:200])
    for body in BAD_BODIES:
        for headers in headers_options:
            res = client.post("/api/subjects", json=body, headers=headers)
            assert res.status_code < 500, (body, headers, res.text[:200])
    for q in ["", " ", "%", "_", "\\", "x" * 201, "\x00"]:
        res = client.get(f"/api/subjects/{ids['subject']}/search", params={"q": q}, headers=V1)
        assert res.status_code < 500, (q, res.text[:200])
    assert {404, 409, 422} <= set(seen)
