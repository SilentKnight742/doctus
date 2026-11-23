"""Streamed tutor replies: events, stop, partial replies, errors, and the
cartographer running only after the stream has finished."""

import time

from conftest import V1, V2, calls, canvas_of, chat, events, make_client, new_subject, reply_text
from doctus.llm import FakeStream, LLMError, RateLimited


def test_reply_streams_in_pieces_then_done(canvas):
    client, llm, store = canvas
    _s, root = new_subject(client)
    llm.queue_chat("Der, die, das: three genders.")
    res = chat(client, root, "Genders?")
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/event-stream")
    evs = events(res.text)
    names = [e for e, _ in evs]
    assert names[0] == "start" and names[-1] == "done"
    assert names.count("delta") == 5
    assert evs[0][1]["context_used"]["included_nodes"] == [root]
    done = evs[-1][1]
    assert done["stopped"] is False
    saved = store.message_by_id(done["message_id"])
    assert saved.content == reply_text(res.text) == "Der, die, das: three genders."
    assert saved.stopped is False


def test_cartographer_runs_only_after_the_stream_finishes(canvas):
    client, llm, store = canvas
    s, root = new_subject(client)
    seen = {}

    def mid_stream():
        seen["json_calls"] = len(calls(llm, "json"))
        seen["status"] = client.get(f"/api/subjects/{s['id']}/canvas/status", headers=V1).json()
        seen["streaming"] = canvas_of(client, s["id"])["nodes"][0]["streaming"]
        seen["assistant_saved"] = store.has_answer(root)

    llm.queue_chat(FakeStream(["one ", "two ", "three"], on_chunk={2: mid_stream}))
    chat(client, root, "count")
    assert seen == {
        "json_calls": 0,
        "status": {"graph_version": 1, "cartographer": "idle", "error": None},
        "streaming": True,
        "assistant_saved": False,
    }
    kinds = [c["kind"] for c in llm.calls]
    assert kinds == ["chat", "stream_end", "json"]
    assert canvas_of(client, s["id"])["nodes"][0]["streaming"] is False


def test_stop_keeps_what_was_written(canvas):
    client, llm, store = canvas
    s, root = new_subject(client)
    stop = {}

    def press_stop():
        stop["res"] = client.post(f"/api/canvas-nodes/{root}/stop", headers=V1)

    llm.queue_chat(FakeStream(["Accusative ", "is ", "for ", "objects."], on_chunk={2: press_stop}))
    res = chat(client, root, "Accusative?")
    assert stop["res"].status_code == 200
    done = events(res.text)[-1]
    assert done[0] == "done" and done[1]["stopped"] is True
    saved = store.message_by_id(done[1]["message_id"])
    assert (saved.content, saved.stopped) == ("Accusative is ", True)
    node = canvas_of(client, s["id"])["nodes"][0]
    assert node["messages"][-1]["stopped"] is True and node["answered"]
    # The cartographer ran on the stopped reply, after the stream ended.
    assert [c["kind"] for c in llm.calls] == ["chat", "stream_end", "json"]
    assert "assistant: Accusative is" in calls(llm, "json")[0]["prompt"]
    # A follow-up works after a stop.
    llm.queue_chat("Yes.")
    assert chat(client, root, "Go on").status_code == 200


def test_stop_needs_an_active_reply_and_the_owner(canvas):
    client, llm, _ = canvas
    _, root = new_subject(client)
    assert client.post(f"/api/canvas-nodes/{root}/stop", headers=V1).status_code == 409
    other = {}

    def hostile_stop():
        other["res"] = client.post(f"/api/canvas-nodes/{root}/stop", headers=V2)

    llm.queue_chat(FakeStream(["a ", "b"], on_chunk={1: hostile_stop}))
    res = chat(client, root, "x")
    assert other["res"].status_code == 404
    assert events(res.text)[-1][1]["stopped"] is False


def test_one_reply_at_a_time_and_no_edits_mid_reply(canvas):
    client, llm, _ = canvas
    _s, root = new_subject(client)
    child_id = client.post(
        f"/api/canvas-nodes/{root}/children", json={"kind": "chat", "text": "Q?"}, headers=V1
    ).json()["id"]
    seen = {}

    def meanwhile():
        seen["again"] = chat(client, child_id, None).status_code
        seen["edit"] = client.patch(
            f"/api/canvas-nodes/{child_id}", json={"prompt": "Q2?"}, headers=V1
        ).status_code
        seen["delete"] = client.delete(f"/api/canvas-nodes/{child_id}", headers=V1).status_code
        seen["other_node"] = chat(client, root, "root is free").status_code

    llm.queue_chat(FakeStream(["a ", "b"], on_chunk={1: meanwhile}))
    llm.queue_chat("root answer")
    assert chat(client, child_id).status_code == 200
    assert seen == {"again": 409, "edit": 409, "delete": 409, "other_node": 200}


def test_rate_limit_before_the_first_piece_is_a_429_and_the_question_waits(canvas):
    client, llm, store = canvas
    s, root = new_subject(client)
    llm.queue_chat(RateLimited("Gemini rate limit reached; try again shortly.", retry_after=37))
    res = chat(client, root, "Hello?")
    assert res.status_code == 429 and res.headers["retry-after"] == "37"
    assert "rate limit" in res.json()["detail"]
    node = canvas_of(client, s["id"])["nodes"][0]
    assert node["pending"] and not node["streaming"]
    assert calls(llm, "json") == []  # no cartographer run for an unanswered question
    llm.queue_chat("Hi!")
    assert chat(client, root).status_code == 200  # retry answers the waiting question
    assert [m.content for m in store.canvas_messages(root)] == ["Hello?", "Hi!"]


def test_other_failure_before_the_first_piece_is_a_502(canvas):
    client, llm, _ = canvas
    _, root = new_subject(client)
    llm.queue_chat(LLMError("Gemini API error (500): boom"))
    res = chat(client, root, "x")
    assert res.status_code == 502 and "retry-after" not in res.headers
    llm.queue_chat(FakeStream([]))
    assert chat(client, root).status_code == 502  # empty reply


def test_failure_mid_reply_keeps_the_partial_reply(canvas):
    client, llm, store = canvas
    _, root = new_subject(client)
    llm.queue_chat(FakeStream(["Half ", "an ", RateLimited("rate", retry_after=9)]))
    res = chat(client, root, "x")
    name, data = events(res.text)[-1]
    assert name == "error"
    assert (data["status"], data["retry_after"]) == (429, 9)
    saved = store.message_by_id(data["message_id"])
    assert (saved.content, saved.stopped) == ("Half an ", True)
    llm.queue_chat(FakeStream(["x ", LLMError("boom")]))
    name, data = events(chat(client, root, "again").text)[-1]
    assert (name, data["status"]) == ("error", 502) and "retry_after" not in data


def test_background_thread_runs_the_cartographer():
    client, llm, _ = make_client(sync=False)
    s, root = new_subject(client)
    llm.queue_json({"title": "Greetings", "keyword": "hello"})
    chat(client, root, "Hallo")
    deadline = time.time() + 5
    while time.time() < deadline:
        status = client.get(f"/api/subjects/{s['id']}/canvas/status", headers=V1).json()
        if status["cartographer"] == "idle" and calls(llm, "json"):
            break
        time.sleep(0.02)
    assert canvas_of(client, s["id"])["nodes"][0]["title"] == "Greetings"
