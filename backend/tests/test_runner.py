"""The cartographer runner must leave no answered chat node unprocessed:
after any run, every chat node in the subject with an unextracted reply gets
its turn, whatever happened to the in-memory queue (a failed call, an
unexpected error, a restart)."""

import threading
import time

from conftest import V1, calls, chat, child, concept, extraction, make_client, new_subject
from doctus import cartographer as carto
from doctus.llm import FakeLLM, RateLimited
from doctus.store import Store


def _wait_idle(client, sid, json_calls=None, llm=None, timeout=10):
    deadline = time.time() + timeout
    while time.time() < deadline:
        status = client.get(f"/api/subjects/{sid}/canvas/status", headers=V1).json()
        done = json_calls is None or len(calls(llm, "json")) >= json_calls
        if status["cartographer"] != "running" and done:
            return status
        time.sleep(0.01)
    raise AssertionError("cartographer did not settle")


def _nodes(client, sid):
    view = client.get(f"/api/subjects/{sid}/canvas", headers=V1).json()
    return {n["id"]: n for n in view["nodes"]}


class GatedLLM(FakeLLM):
    """Holds each cartographer call until the test lets it through."""

    def __init__(self):
        super().__init__()
        self.entered = threading.Semaphore(0)
        self.gate = threading.Semaphore(0)

    def _raw_json(self, system, prompt, schema):
        self.entered.release()
        assert self.gate.acquire(timeout=10)
        return super()._raw_json(system, prompt, schema)


def _answer(llm, client, node_id, name, message=None):
    llm.queue_chat(f"{name} is taught here in full.")
    assert chat(client, node_id, message).status_code == 200


def test_two_nodes_answered_in_quick_succession_both_get_titles_and_concepts():
    llm = GatedLLM()
    client, _, _ = make_client(llm=llm, sync=False)
    s, root = new_subject(client, title="Chess")
    a = child(client, root, "Openings?").json()["id"]
    b = child(client, root, "Traps?").json()["id"]
    llm.queue_json(
        extraction(title="Openings", concepts=[concept("Openings", "Openings is taught")])
    )
    llm.queue_json(extraction(title="Traps", concepts=[concept("Traps", "Traps is taught")]))
    _answer(llm, client, a, "Openings")
    assert llm.entered.acquire(timeout=10)  # a's run is in its model call
    _answer(llm, client, b, "Traps")  # b answered while a's run is busy
    llm.gate.release()
    assert llm.entered.acquire(timeout=10)  # b's run follows
    llm.gate.release()
    _wait_idle(client, s["id"], 2, llm)
    nodes = _nodes(client, s["id"])
    assert (nodes[a]["title"], [c["name"] for c in nodes[a]["concepts"]]) == (
        "Openings",
        ["Openings"],
    )
    assert (nodes[b]["title"], [c["name"] for c in nodes[b]["concepts"]]) == ("Traps", ["Traps"])


def test_a_node_whose_run_failed_is_picked_up_by_the_next_run():
    client, llm, store = make_client()
    s, root = new_subject(client, title="Chess")
    a = child(client, root, "Openings?").json()["id"]
    b = child(client, root, "Traps?").json()["id"]
    llm.queue_json(RateLimited("Gemini rate limit reached; try again shortly."))
    _answer(llm, client, a, "Openings")  # a's run hits a 429
    assert _nodes(client, s["id"])[a]["title"] == ""
    # The learner moves on; a gets no further exchange of its own.
    # The sweep runs nodes in id order: a (the leftover) first, then b.
    llm.queue_json(
        extraction(title="Openings", concepts=[concept("Openings", "Openings is taught")])
    )
    llm.queue_json(extraction(title="Traps", concepts=[concept("Traps", "Traps is taught")]))
    _answer(llm, client, b, "Traps")
    nodes = _nodes(client, s["id"])
    assert nodes[b]["title"] == "Traps"
    assert nodes[a]["title"] == "Openings"
    assert [c["name"] for c in nodes[a]["concepts"]] == ["Openings"]
    assert store.unextracted_chat_nodes(s["id"]) == []
    assert store.graph_status(s["id"])["cartographer"] == "idle"


def test_a_failure_is_reported_even_if_a_later_node_succeeds():
    client, llm, store = make_client()
    s, root = new_subject(client)
    a = child(client, root, "A?").json()["id"]
    b = child(client, root, "B?").json()["id"]
    store.add_canvas_message(a, "assistant", "answer a")
    store.add_canvas_message(b, "assistant", "answer b")
    llm.queue_json(RateLimited("Gemini rate limit reached; try again shortly."))  # a
    llm.queue_json(extraction(title="B"))  # b
    runner = client.app.state.cartographer
    runner.request(s["id"], a)
    runner.request(s["id"], b)
    runner.drain(s["id"])
    status = store.graph_status(s["id"])
    assert status["cartographer"] == "error" and "rate limit" in status["error"]
    assert len(calls(llm, "json")) == 2  # a failed node is not retried in the same drain
    assert store.unextracted_chat_nodes(s["id"]) == [a]


def test_an_unexpected_error_on_one_node_does_not_drop_the_others(monkeypatch):
    client, llm, store = make_client()
    s, root = new_subject(client)
    a = child(client, root, "A?").json()["id"]
    b = child(client, root, "B?").json()["id"]
    store.add_canvas_message(a, "assistant", "answer a")
    store.add_canvas_message(b, "assistant", "answer b")
    real = carto.apply_extraction

    def flaky(store_, subject, node, result, messages):
        if node.id == a:
            raise RuntimeError("boom")
        return real(store_, subject, node, result, messages)

    monkeypatch.setattr(carto, "apply_extraction", flaky)
    llm.queue_json(extraction(title="A"))
    llm.queue_json(extraction(title="B"))
    runner = client.app.state.cartographer
    runner.request(s["id"], a)
    runner.request(s["id"], b)
    runner.drain(s["id"])
    assert store.canvas_node_by_id(b).title == "B"
    status = store.graph_status(s["id"])
    assert status["cartographer"] == "error" and "boom" in status["error"]


def test_blank_concept_names_are_dropped_not_fatal():
    client, llm, store = make_client()
    s, root = new_subject(client)
    llm.queue_json(
        extraction(
            title="T",
            concepts=[concept("   ", "is taught here"), concept("Real", "is taught here")],
            links=[{"source": " ", "target": "Real", "kind": "related"}],
        )
    )
    _answer(llm, client, root, "Something", message="q")
    assert [c.name for c in store.list_nodes(s["id"])] == ["Real"]
    assert store.graph_status(s["id"])["cartographer"] == "idle"


def test_replies_left_over_from_a_restart_are_picked_up(tmp_path):
    path = str(tmp_path / "doctus.db")
    client, llm, _ = make_client(store=Store(path))
    s, root = new_subject(client)
    a = child(client, root, "A?").json()["id"]
    b = child(client, root, "B?").json()["id"]
    # a was answered, then the server restarted before its run (queue lost).
    client.app.state.store.add_canvas_message(a, "assistant", "answer a")
    client.app.state.store.close()

    client, llm, store = make_client(store=Store(path))
    llm.queue_json(extraction(title="A"))  # the sweep takes a (lower id) first
    llm.queue_json(extraction(title="B"))
    _answer(llm, client, b, "B")
    assert store.canvas_node_by_id(a).title == "A"
    assert store.canvas_node_by_id(b).title == "B"
    assert store.unextracted_chat_nodes(s["id"]) == []


def test_unanswered_questions_and_notes_are_not_swept(canvas):
    client, _llm, store = canvas
    s, root = new_subject(client, first_question="waiting")
    child(client, root, "a note", kind="note")
    child(client, root, "also waiting")
    assert store.unextracted_chat_nodes(s["id"]) == []
    store.add_canvas_message(root, "assistant", "answered")
    assert store.unextracted_chat_nodes(s["id"]) == [root]
