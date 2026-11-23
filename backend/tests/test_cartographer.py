"""Cartographer: evidence per canvas node, concept dedupe across nodes,
links, title/keyword, suggestions, the concept-name cap, background runs.
Plus the M1/M2 concept endpoints that stay (graph, concept detail, visit)."""

import threading

import pytest

from conftest import V1, V2, calls, canvas_of, chat, child, concept, extraction, make_client
from conftest import new_subject as api_subject
from doctus.cartographer import (
    MAX_CONCEPT_NAMES,
    apply_extraction,
    build_prompt,
    concept_names,
    extraction_window,
    find_quote,
    normalise,
)
from doctus.graph import distances_from
from doctus.llm import FakeLLM
from doctus.prompts import CanvasExtraction
from doctus.store import Store

TUTOR_LINE = (
    "With Wechselpräpositionen, use the dative when nothing moves: Das Buch liegt auf dem Tisch."
)


@pytest.fixture
def store():
    s = Store(":memory:")
    yield s
    s.close()


def _subject(store, title="German"):
    s = store.create_subject("v1", title, "Wechselpräpositionen")
    return s, store.canvas_node_by_id(s["root_canvas_node_id"])


def _exchange(store, node, *pairs):
    msgs = []
    for user, tutor in pairs:
        msgs.append(store.add_canvas_message(node.id, "user", user))
        msgs.append(store.add_canvas_message(node.id, "assistant", tutor))
    return msgs


def _apply(store, s, node, msgs, **fields):
    result = CanvasExtraction.model_validate(extraction(**fields))
    return apply_extraction(store, s, store.canvas_node_by_id(node.id), result, msgs)


def _link(source, target, kind="prerequisite", reason="r"):
    return {"source": source, "target": target, "kind": kind, "reason": reason}


# ---------- evidence ----------


def test_quote_matching_ignores_whitespace_case_and_markdown(store):
    _s, root = _subject(store)
    (m,) = [store.add_canvas_message(root.id, "assistant", TUTOR_LINE)]
    assert find_quote("use the dative when nothing moves", [m]) is m
    assert find_quote("  USE the   dative\nwhen nothing MOVES ", [m]) is m
    assert normalise(" A \n b ") == "a b"
    md = store.add_canvas_message(
        root.id, "assistant", "It answers ***Wohin?*** so we need the **Accusative** case."
    )
    assert find_quote("It answers Wohin? so we need the Accusative case", [md]) is md
    assert find_quote("It answers Wo? so we need the Accusative case", [md]) is None


def test_no_concept_without_verified_evidence(store):
    s, root = _subject(store)
    msgs = _exchange(store, root, ("When do I use dative?", TUTOR_LINE))
    summary = _apply(
        store,
        s,
        root,
        msgs,
        concepts=[
            concept("Dativ for position", "the dative marks static location in all cases"),
            concept("No quotes at all", None),
        ],
    )
    assert store.list_nodes(s["id"]) == []
    assert [(d["name"], d["reason"]) for d in summary.dropped] == [
        ("Dativ for position", "evidence not found in chat"),
        ("No quotes at all", "no evidence given"),
    ]
    assert (summary.evidence_verified, summary.evidence_dropped) == (0, 1)
    assert not summary.changed


def test_one_good_quote_is_enough_and_is_stored(store):
    s, root = _subject(store)
    msgs = _exchange(store, root, ("When do I use dative?", TUTOR_LINE))
    c = concept("Dativ for position", "Das Buch liegt auf dem Tisch.")
    c["evidence"].insert(0, "made up")
    summary = _apply(store, s, root, msgs, concepts=[c])
    node = store.find_node_by_name(s["id"], "Dativ for position")
    assert node.home_canvas_node_id == root.id
    assert [(e.quote, e.message_id) for e in store.list_evidence(node.id)] == [
        ("Das Buch liegt auf dem Tisch.", msgs[1].id)
    ]
    assert summary.added == ["Dativ for position"]
    assert (summary.evidence_verified, summary.evidence_dropped) == (1, 1)


def test_evidence_must_come_from_this_canvas_node(store):
    s, root = _subject(store)
    _exchange(store, root, ("dative?", TUTOR_LINE))
    a = store.add_canvas_node("v1", root.id, "child", "chat", "accusative?")
    store.add_canvas_message(a.id, "assistant", "The accusative is for movement.")
    context, new = extraction_window(store, store.canvas_node_by_id(a.id))
    assert all(m.canvas_node_id == a.id for m in context + new)
    summary = _apply(
        store, s, a, context + new, concepts=[concept("Dative", "use the dative when nothing")]
    )
    assert summary.dropped[0]["reason"] == "evidence not found in chat"
    assert store.find_node_by_name(s["id"], "Dative") is None


def test_concepts_dedupe_across_nodes_and_keep_their_first_home(store):
    s, root = _subject(store)
    msgs = _exchange(store, root, ("q", TUTOR_LINE))
    _apply(store, s, root, msgs, concepts=[concept("Dativ", "nothing moves")])
    a = store.add_canvas_node("v1", root.id, "child", "chat", "more")
    a_msgs = _exchange(store, a, ("again?", "Again: the Dativ means nothing moves."))
    summary = _apply(store, s, a, a_msgs, concepts=[concept("  dativ ", "the Dativ means")])
    (node,) = store.list_nodes(s["id"])
    assert summary.reinforced == ["Dativ"] and summary.added == []
    assert node.home_canvas_node_id == root.id
    assert [e.quote for e in store.list_evidence(node.id)] == ["nothing moves", "the Dativ means"]


# ---------- links ----------


def test_links_between_new_and_existing_concepts(store):
    s, root = _subject(store)
    msgs = _exchange(store, root, ("q", "Cases mark roles. The dative marks the indirect object."))
    summary = _apply(
        store,
        s,
        root,
        msgs,
        concepts=[concept("Cases", "Cases mark roles"), concept("Dative", "dative marks")],
        links=[_link("Cases", "Dative"), _link("Dative", "Cases", "related")],
    )
    edges = {(e.from_id, e.to_id, e.kind) for e in store.list_edges(s["id"])}
    cases = store.find_node_by_name(s["id"], "Cases").id
    dative = store.find_node_by_name(s["id"], "Dative").id
    assert edges == {(cases, dative, "prerequisite"), (dative, cases, "related")}
    assert len(summary.edges_added) == 2


def test_bad_links_are_skipped_with_reasons(store):
    s, root = _subject(store)
    msgs = _exchange(store, root, ("q", "A comes first. B builds on A."))
    summary = _apply(
        store,
        s,
        root,
        msgs,
        concepts=[concept("A", "A comes first"), concept("B", "B builds on A")],
        links=[
            _link("A", "B"),
            _link("A", "B"),  # duplicate
            _link("B", "A"),  # cycle
            _link("A", "a"),  # self
            _link("A", "Unknown"),
        ],
    )
    assert [s_["reason"] for s_ in summary.skipped] == [
        "duplicate",
        "prerequisite cycle",
        "self-link",
        "unknown concept",
    ]
    assert len(store.list_edges(s["id"])) == 1


def test_part_of_is_not_in_the_schema():
    with pytest.raises(ValueError):
        CanvasExtraction.model_validate(
            extraction(links=[{"source": "a", "target": "b", "kind": "part_of"}])
        )
    assert "part_of" not in CanvasExtraction.model_json_schema().__repr__()


# ---------- title, keyword, suggestions ----------


def test_title_set_from_first_exchange_then_kept(store):
    s, root = _subject(store)
    msgs = _exchange(store, root, ("q", "a"))
    summary = _apply(store, s, root, msgs, title="  German   noun cases ", keyword="cases, nouns")
    node = store.canvas_node_by_id(root.id)
    assert (node.title, node.keyword) == ("German noun cases", "cases")
    assert summary.title_changed and summary.changed
    again = _apply(store, s, root, msgs, title="German noun cases", keyword="cases")
    assert not again.title_changed and not again.changed
    empty = _apply(store, s, root, msgs, title="", keyword="")  # model forgot: keep it
    assert store.canvas_node_by_id(root.id).title == "German noun cases"
    assert not empty.title_changed
    long = _apply(store, s, root, msgs, title="x" * 100)
    assert len(store.canvas_node_by_id(root.id).title) == 60 and long.title_changed


def test_prompt_shows_the_current_title_or_asks_for_one(store):
    s, root = _subject(store)
    msgs = _exchange(store, root, ("q", "a"))
    prompt = build_prompt(store, s, root, [], msgs)
    assert "Current title: (none yet: set it from this exchange)" in prompt
    assert "Path to this conversation: (this is the start)" in prompt
    store.set_title_keyword(root.id, "German cases", "cases")
    a = store.add_canvas_node("v1", root.id, "child", "chat", "dative?")
    store.set_title_keyword(a.id, "Dative", "dative")
    prompt = build_prompt(store, s, store.canvas_node_by_id(root.id), [], msgs)
    assert "Current title: German cases (keyword: cases)" in prompt
    assert "Branches the learner already took from here: Dative" in prompt
    child_prompt = build_prompt(store, s, store.canvas_node_by_id(a.id), [], msgs)
    assert "Path to this conversation: German cases" in child_prompt


def test_suggestions_are_capped_deduped_and_skip_taken_branches(store):
    s, root = _subject(store)
    store.add_canvas_node("v1", root.id, "child", "chat", "What is the dative?")
    msgs = _exchange(store, root, ("q", "a"))
    summary = _apply(
        store,
        s,
        root,
        msgs,
        suggestions=[
            "what is the  dative?",  # already a branch
            "How do articles change?",
            "how do articles change?",  # duplicate
            "x" * 121,  # too long
            "",
            "Which prepositions take the dative?",
            "Why four cases?",
            "A fourth one?",
        ],
    )
    texts = [x.text for x in store.node_suggestions(root.id)]
    assert texts == [
        "How do articles change?",
        "Which prepositions take the dative?",
        "Why four cases?",
    ]
    assert summary.suggestions_changed
    replaced = _apply(store, s, root, msgs, suggestions=["Only this one?"])
    assert [x.text for x in store.node_suggestions(root.id)] == ["Only this one?"]
    assert replaced.suggestions_changed


# ---------- concept names sent to the model ----------


def test_concept_names_are_capped_branch_first_most_recent_first(store):
    s, root = _subject(store)
    a = store.add_canvas_node("v1", root.id, "child", "chat", "a")
    b = store.add_canvas_node("v1", root.id, "child", "chat", "b")  # sibling of a
    for i in range(MAX_CONCEPT_NAMES + 20):
        store.insert_node(s["id"], f"Other {i}", "", home_canvas_node_id=b.id)
    store.insert_node(s["id"], "Root old", "", home_canvas_node_id=root.id)
    store.insert_node(s["id"], "On branch new", "", home_canvas_node_id=a.id)
    names = concept_names(store, s["id"], [n.id for n in store.branch(a.id)])
    assert len(names) == MAX_CONCEPT_NAMES
    assert names[:2] == ["On branch new", "Root old"]
    assert names[2] == f"Other {MAX_CONCEPT_NAMES + 19}"  # then the rest, newest first


# ---------- window and runs ----------


def test_window_ends_at_the_latest_reply(store):
    _s, root = _subject(store)
    assert extraction_window(store, root) == ([], [])
    store.add_canvas_message(root.id, "user", "waiting")
    assert extraction_window(store, store.canvas_node_by_id(root.id)) == ([], [])
    store.add_canvas_message(root.id, "assistant", "answer")
    store.add_canvas_message(root.id, "user", "follow-up not answered yet")
    _ctx, new = extraction_window(store, store.canvas_node_by_id(root.id))
    assert [m.content for m in new] == ["waiting", "answer"]


def test_cartographer_runs_after_every_exchange_and_bumps_version(canvas):
    client, llm, store = canvas
    s, root = api_subject(client)
    llm.queue_chat("The dative is for location: nothing moves.")
    llm.queue_json(extraction(concepts=[concept("Dativ", "for location: nothing moves")]))
    chat(client, root, "dative?")
    status = client.get(f"/api/subjects/{s['id']}/canvas/status", headers=V1).json()
    assert status["cartographer"] == "idle" and status["error"] is None
    version = status["graph_version"]

    chat(client, root, "thanks")  # canned empty extraction: no graph change from the run
    assert len(calls(llm, "json")) == 2
    status = client.get(f"/api/subjects/{s['id']}/canvas/status", headers=V1).json()
    assert status["graph_version"] == version + 2  # the two new messages only
    assert store.canvas_node_by_id(root).last_extracted_message_id == (
        store.canvas_messages(root)[-1].id
    )


def test_failure_does_not_break_chat_and_the_next_exchange_catches_up(canvas):
    client, llm, store = canvas
    s, root = api_subject(client)
    llm.queue_json("garbage")
    llm.queue_json("garbage")  # the one retry also fails
    assert chat(client, root, "first").status_code == 200
    status = client.get(f"/api/subjects/{s['id']}/canvas/status", headers=V1).json()
    assert status["cartographer"] == "error" and "invalid CanvasExtraction" in status["error"]
    assert store.canvas_node_by_id(root).last_extracted_message_id is None
    chat(client, root, "second")
    prompt = calls(llm, "json")[-1]["prompt"]
    assert "user: first" in prompt and "user: second" in prompt and "[context]" not in prompt
    status = client.get(f"/api/subjects/{s['id']}/canvas/status", headers=V1).json()
    assert status["cartographer"] == "idle" and status["error"] is None


def test_node_deleted_before_its_run_is_skipped(canvas):
    client, llm, store = canvas
    s, root = api_subject(client)
    a = child(client, root, "A?").json()
    store.add_canvas_message(a["id"], "assistant", "answer")
    runner = client.app.state.cartographer
    runner.request(s["id"], a["id"])
    client.delete(f"/api/canvas-nodes/{a['id']}", headers=V1)
    runner.drain(s["id"])
    assert calls(llm, "json") == []
    assert store.graph_status(s["id"])["cartographer"] == "idle"


class BlockingLLM(FakeLLM):
    """Blocks the first cartographer call until released."""

    def __init__(self):
        super().__init__()
        self.started = threading.Event()
        self.release = threading.Event()
        self._blocked = False
        self.json_started = 0

    def _raw_json(self, system, prompt, schema):
        self.json_started += 1
        if not self._blocked:
            self._blocked = True
            self.started.set()
            assert self.release.wait(10)
        return super()._raw_json(system, prompt, schema)


def test_chat_during_a_run_and_rerun_after_mid_run_messages():
    llm = BlockingLLM()
    client, _, store = make_client(llm=llm, sync=False)
    s, root = api_subject(client)
    assert chat(client, root, "m1").status_code == 200
    try:
        assert llm.started.wait(10)
        status = client.get(f"/api/subjects/{s['id']}/canvas/status", headers=V1).json()
        assert status["cartographer"] == "running"
        assert chat(client, root, "m2").status_code == 200  # chat works mid-run
        assert llm.json_started == 1  # m2 waits for the active run
    finally:
        llm.release.set()
    for _ in range(500):
        status = client.get(f"/api/subjects/{s['id']}/canvas/status", headers=V1).json()
        if status["cartographer"] == "idle" and len(calls(llm, "json")) == 2:
            break
        threading.Event().wait(0.01)
    json_calls = calls(llm, "json")
    assert len(json_calls) == 2
    assert "user: m1" in json_calls[0]["prompt"] and "m2" not in json_calls[0]["prompt"]
    assert "[context] user: m1" in json_calls[1]["prompt"]
    assert "\nuser: m2" in json_calls[1]["prompt"]
    assert store.canvas_node_by_id(root).last_extracted_message_id == (
        store.canvas_messages(root)[-1].id
    )


def test_startup_resets_running_state(tmp_path):
    path = str(tmp_path / "doctus.db")
    s = Store(path)
    subj = s.create_subject("v1", "German")
    s.set_cartographer_state(subj["id"], "running")
    s.close()
    s = Store(path)
    assert s.graph_status(subj["id"])["cartographer"] == "idle"
    assert s._one("PRAGMA journal_mode")[0] == "wal"
    s.close()


def test_manual_extract_uses_the_same_lock(canvas):
    client, _llm, store = canvas
    s, root = api_subject(client)
    url = f"/api/canvas-nodes/{root}/extract"
    assert client.post(url, headers=V1).status_code == 409
    store.add_canvas_message(root, "user", "hello")
    store.add_canvas_message(root, "assistant", "hi")
    runner = client.app.state.cartographer
    runner._running.add(s["id"])  # a background run is in progress
    res = client.post(url, headers=V1)
    assert res.status_code == 409 and "already running" in res.json()["detail"]
    runner._running.discard(s["id"])
    assert client.post(url, headers=V1).status_code == 200
    assert client.post(url, headers=V1).status_code == 409
    assert client.post(url, headers=V2).status_code == 404


def test_title_and_suggestions_reach_the_canvas(canvas):
    client, llm, _ = canvas
    s, root = api_subject(client)
    llm.queue_json(extraction(title="Greetings", keyword="hallo", suggestions=["How formal?"]))
    chat(client, root, "Hallo")
    view = canvas_of(client, s["id"])
    assert (view["nodes"][0]["title"], view["nodes"][0]["keyword"]) == ("Greetings", "hallo")
    assert [x["text"] for x in view["suggestions"]] == ["How formal?"]


# ---------- M1/M2 concept endpoints that stay ----------


def test_concept_detail_graph_and_visit(canvas):
    client, _, store = canvas
    s, _root = api_subject(client)
    a = store.insert_node(s["id"], "Dativ", "")
    b = store.insert_node(s["id"], "Dativ endings", "")
    store.insert_edge(s["id"], b.id, a.id, "part_of", "")
    detail = client.get(f"/api/nodes/{b.id}", headers=V1).json()
    assert [(e["source"], e["target"], e["kind"]) for e in detail["edges"]] == [
        (b.id, a.id, "part_of")
    ]
    assert distances_from(a.id, store.list_edges(s["id"]))[b.id] == 1
    res = client.post(f"/api/nodes/{a.id}/visit", headers=V1)
    assert res.json()["recorded"] is True
    res = client.post(f"/api/nodes/{b.id}/visit", json={"from_node_id": a.id}, headers=V1)
    assert res.json()["trail"][-1] == {
        "node_id": b.id,
        "from_node_id": a.id,
        "at": res.json()["trail"][-1]["at"],
    }
    again = client.post(f"/api/nodes/{b.id}/visit", json={}, headers=V1)
    assert again.json()["recorded"] is False
    graph = client.get(f"/api/subjects/{s['id']}/graph", headers=V1).json()
    assert [n["name"] for n in graph["nodes"]] == ["Dativ", "Dativ endings"]
    assert len(graph["trail"]) == 2
    assert client.post(f"/api/nodes/{a.id}/visit", headers=V2).status_code == 404
    assert client.get(f"/api/subjects/{s['id']}/graph", headers=V2).status_code == 404


def test_old_chat_routes_are_gone(canvas):
    client, _, store = canvas
    s, _root = api_subject(client)
    a = store.insert_node(s["id"], "Dativ", "")
    for path in ("chat", "extract", "update-graph", "dismiss"):
        res = client.post(f"/api/nodes/{a.id}/{path}", json={"message": "x"}, headers=V1)
        assert res.status_code in (404, 405), path
