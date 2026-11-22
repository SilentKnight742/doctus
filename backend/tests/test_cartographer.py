"""Cartographer (evidence, relations, edge rules, background runs) and tutor split."""

import threading

import pytest
from fastapi.testclient import TestClient

from doctus.api import create_app
from doctus.cartographer import apply_extraction, find_quote, normalise
from doctus.config import Settings
from doctus.graph import distances_from
from doctus.llm import FakeLLM
from doctus.mastery import PlaceholderDecayModel
from doctus.prompts import CARTOGRAPHER_SYSTEM, Extraction
from doctus.store import Store

V1 = {"X-Doctus-Visitor": "visitor-one-0000000"}
V2 = {"X-Doctus-Visitor": "visitor-two-0000000"}

TUTOR_LINE = (
    "With Wechselpräpositionen, use the dative when nothing moves: Das Buch liegt auf dem Tisch."
)


# ---------- fixtures and helpers ----------


@pytest.fixture
def store():
    s = Store(":memory:")
    yield s
    s.close()


def _settings():
    return Settings(
        db_path=":memory:",
        llm_provider="fake",
        gemini_api_key=None,
        gemini_model="x",
        max_proposals_per_update=5,
        recent_turns_in_context=8,
    )


def _app(llm, store=None):
    store = store or Store(":memory:")
    app = create_app(store=store, llm=llm, mastery=PlaceholderDecayModel(), settings=_settings())
    return TestClient(app), store


@pytest.fixture
def env():
    llm = FakeLLM()
    client, store = _app(llm)
    return client, llm, store


def _subject(store, title="German"):
    s = store.create_subject("v1", title, "Wechselpräpositionen")
    return s, store.node_by_id(s["origin_node_id"])


def _chat(store, s, node, *pairs):
    msgs = []
    for user, tutor in pairs:
        msgs.append(store.add_message(s["id"], node.id, "user", user))
        msgs.append(store.add_message(s["id"], node.id, "assistant", tutor))
    return msgs


def _apply(store, s, node, msgs, **result):
    return apply_extraction(store, s, node, Extraction.model_validate(result), msgs)


def _concept(name, quote, attach_to="German", relation="related", reason="r"):
    return {
        "name": name,
        "summary": f"about {name}",
        "evidence": [quote] if quote else [],
        "link": {"attach_to": attach_to, "relation": relation, "reason": reason},
    }


def _calls(llm, kind):
    return [c for c in llm.calls if c["kind"] == kind]


def _new_subject(client, title="German"):
    subj = client.post(
        "/api/subjects", json={"title": title, "goal": "Wechselpräpositionen"}, headers=V1
    ).json()
    return subj, subj["origin_node_id"]


def _chat_api(client, node_id, message, **extra):
    return client.post(f"/api/nodes/{node_id}/chat", json={"message": message, **extra}, headers=V1)


# ---------- evidence verification ----------


def test_quote_found_exactly(store):
    s, origin = _subject(store)
    m = store.add_message(s["id"], origin.id, "assistant", TUTOR_LINE)
    assert find_quote("use the dative when nothing moves", [m]) is m


def test_quote_matches_despite_whitespace_and_case(store):
    s, origin = _subject(store)
    m = store.add_message(s["id"], origin.id, "assistant", TUTOR_LINE)
    assert find_quote("  USE the   dative\nwhen nothing MOVES ", [m]) is m
    assert normalise(" A \n b ") == "a b"


def test_quote_matches_despite_markdown_emphasis(store):
    s, origin = _subject(store)
    m = store.add_message(
        s["id"],
        origin.id,
        "assistant",
        "It answers ***Wohin?*** so we need the **Accusative** case, e.g. `ins` Kino.",
    )
    assert find_quote("It answers Wohin? so we need the Accusative case, e.g. ins Kino.", [m]) is m
    assert find_quote("It answers Wo? so we need the Accusative case", [m]) is None


def test_no_node_without_verified_evidence(store):
    s, origin = _subject(store)
    msgs = _chat(store, s, origin, ("When do I use dative?", TUTOR_LINE))
    summary = _apply(
        store,
        s,
        origin,
        msgs,
        concepts=[
            _concept("Dativ for position", "the dative marks static location in all cases"),
            _concept("No quotes at all", None),
        ],
    )
    assert [n.name for n in store.list_nodes(s["id"])] == ["German"]
    assert [d["name"] for d in summary.dropped] == ["Dativ for position", "No quotes at all"]
    assert [d["reason"] for d in summary.dropped] == [
        "evidence not found in chat",
        "no evidence given",
    ]
    assert (summary.evidence_verified, summary.evidence_dropped) == (0, 1)
    assert not summary.changed


def test_one_good_quote_is_enough_and_is_stored(store):
    s, origin = _subject(store)
    msgs = _chat(store, s, origin, ("When do I use dative?", TUTOR_LINE))
    concept = _concept("Dativ for position", "Das Buch liegt auf dem Tisch.", relation="part_of")
    concept["evidence"].insert(0, "made up")
    summary = _apply(store, s, origin, msgs, concepts=[concept])
    node = store.find_node_by_name(s["id"], "Dativ for position")
    assert [(e.quote, e.message_id) for e in store.list_evidence(node.id)] == [
        ("Das Buch liegt auf dem Tisch.", msgs[1].id)
    ]
    assert summary.added == ["Dativ for position"]
    assert (summary.evidence_verified, summary.evidence_dropped) == (1, 1)


def test_current_topic_evidence_is_recorded(store):
    s, origin = _subject(store)
    msgs = _chat(store, s, origin, ("Explain", TUTOR_LINE))
    _apply(store, s, origin, msgs, current_node_evidence=["nothing moves"])
    assert [e.quote for e in store.list_evidence(origin.id)] == ["nothing moves"]


def test_existing_concept_is_reinforced_not_duplicated(store):
    s, origin = _subject(store)
    msgs = _chat(store, s, origin, ("q", TUTOR_LINE))
    _apply(store, s, origin, msgs, concepts=[_concept("Dativ", "nothing moves")])
    summary = _apply(store, s, origin, msgs, concepts=[_concept("dativ ", "Das Buch liegt")])
    assert summary.reinforced == ["Dativ"] and summary.added == []
    assert len(store.list_evidence(store.find_node_by_name(s["id"], "Dativ").id)) == 2


# ---------- relations and edge rules ----------


@pytest.mark.parametrize(
    ("relation", "expected"),
    [
        ("prerequisite_of", ("Dativ", "German", "prerequisite")),
        ("builds_on", ("German", "Dativ", "prerequisite")),
        ("part_of", ("Dativ", "German", "part_of")),
        ("contains", ("German", "Dativ", "part_of")),
        ("related", ("Dativ", "German", "related")),
    ],
)
def test_each_relation_maps_to_the_stored_direction(store, relation, expected):
    s, origin = _subject(store)
    msgs = _chat(store, s, origin, ("q", TUTOR_LINE))
    _apply(store, s, origin, msgs, concepts=[_concept("Dativ", "nothing moves", relation=relation)])
    names = {n.id: n.name for n in store.list_nodes(s["id"])}
    (edge,) = store.list_edges(s["id"])
    assert (names[edge.from_id], names[edge.to_id], edge.kind) == expected


def test_attach_to_another_concept_in_the_same_answer(store):
    s, origin = _subject(store)
    msgs = _chat(store, s, origin, ("q", "Kanto starters: Bulbasaur, Charmander, Squirtle."))
    _apply(
        store,
        s,
        origin,
        msgs,
        concepts=[
            # listed before its whole: order must not matter
            _concept("Bulbasaur line", "Bulbasaur", attach_to="Kanto starters", relation="part_of"),
            _concept("Kanto starters", "Kanto starters:", relation="part_of"),
        ],
    )
    bulba = store.find_node_by_name(s["id"], "Bulbasaur line")
    kanto = store.find_node_by_name(s["id"], "Kanto starters")
    assert store.part_of_parent(bulba.id).id == kanto.id
    assert store.part_of_parent(kanto.id).id == origin.id


def test_unknown_attach_to_falls_back_to_related_on_current_node(store):
    s, origin = _subject(store)
    msgs = _chat(store, s, origin, ("q", TUTOR_LINE))
    summary = _apply(
        store,
        s,
        origin,
        msgs,
        concepts=[_concept("Dativ", "nothing moves", attach_to="Not a node", relation="part_of")],
    )
    (edge,) = store.list_edges(s["id"])
    assert edge.kind == "related"
    assert {edge.from_id, edge.to_id} == {origin.id, store.find_node_by_name(s["id"], "Dativ").id}
    assert summary.fallbacks == [{"name": "Dativ", "attach_to": "Not a node"}]


def test_single_part_of_parent_keeps_the_first(store):
    s, origin = _subject(store)
    whole2 = store.insert_node(s["id"], "Grammar", "")
    msgs = _chat(store, s, origin, ("q", TUTOR_LINE))
    _apply(
        store, s, origin, msgs, concepts=[_concept("Dativ", "nothing moves", relation="part_of")]
    )
    summary = _apply(
        store,
        s,
        origin,
        msgs,
        concepts=[_concept("Dativ", "Das Buch liegt", attach_to="Grammar", relation="part_of")],
    )
    dativ = store.find_node_by_name(s["id"], "Dativ")
    assert store.part_of_parent(dativ.id).id == origin.id
    assert summary.skipped == [
        {"item": "Dativ -> Grammar (part_of)", "reason": "second part_of parent"}
    ]
    assert whole2.id not in {e.to_id for e in store.list_edges(s["id"])}


def test_cycle_checks_are_per_kind(store):
    s, _ = _subject(store)
    a = store.insert_node(s["id"], "A", "")
    b = store.insert_node(s["id"], "B", "")
    c = store.insert_node(s["id"], "C", "")
    store.insert_edge(s["id"], a.id, b.id, "prerequisite", "")
    store.insert_edge(s["id"], b.id, c.id, "prerequisite", "")
    with pytest.raises(Exception, match="prerequisite cycle"):
        store.insert_edge(s["id"], c.id, a.id, "prerequisite", "")
    # part_of has its own cycle check...
    store.insert_edge(s["id"], a.id, b.id, "part_of", "")
    with pytest.raises(Exception, match="part_of cycle"):
        store.insert_edge(s["id"], b.id, a.id, "part_of", "")
    # ...and edges of one kind never block another kind
    store.insert_edge(s["id"], c.id, a.id, "part_of", "")
    store.insert_edge(s["id"], b.id, a.id, "related", "")
    assert sorted(e.kind for e in store.list_edges(s["id"])) == [
        "part_of",
        "part_of",
        "prerequisite",
        "prerequisite",
        "related",
    ]


def test_duplicates_and_cycles_are_skipped_in_a_run(store):
    s, origin = _subject(store)
    x = store.insert_node(s["id"], "X", "")
    store.insert_edge(s["id"], origin.id, x.id, "prerequisite", "")
    msgs = _chat(store, s, origin, ("q", "X is taught here in full."))
    summary = _apply(
        store, s, origin, msgs, concepts=[_concept("X", "X is taught", relation="prerequisite_of")]
    )
    assert summary.skipped == [
        {"item": "X -> German (prerequisite)", "reason": "prerequisite cycle"}
    ]
    summary = _apply(
        store, s, origin, msgs, concepts=[_concept("X", "X is taught", relation="builds_on")]
    )
    assert summary.skipped == [{"item": "German -> X (prerequisite)", "reason": "duplicate"}]


# ---------- tutor and cartographer are separate ----------


def test_tutor_and_cartographer_are_separate_calls(env):
    client, llm, _ = env
    _, origin_id = _new_subject(client)
    assert _chat_api(client, origin_id, "Teach me Wechselpräpositionen").status_code == 200
    assert [c["kind"] for c in llm.calls] == ["chat", "json"]
    tutor_sys, carto_sys = llm.calls[0]["system"], llm.calls[1]["system"]
    assert carto_sys == CARTOGRAPHER_SYSTEM
    for word in ("evidence", "concepts", "attach_to", "cartographer"):
        assert word not in tutor_sys
    assert "Never mention these" in tutor_sys


def test_origin_and_topic_scopes(env):
    client, llm, store = env
    subj, origin_id = _new_subject(client)
    topic = store.insert_node(subj["id"], "Dativ", "")
    _chat_api(client, origin_id, "all of it")
    _chat_api(client, topic.id, "this one")
    origin_sys, topic_sys = (c["system"] for c in _calls(llm, "chat"))
    assert "Do not force an overview" in origin_sys and "Keep the focus" not in origin_sys
    assert "Keep the focus" in topic_sys and "Do not force an overview" not in topic_sys


def test_tutor_notes_show_neighbourhood_without_strength(env):
    client, llm, store = env
    subj, origin_id = _new_subject(client)
    sid = subj["id"]
    topic = store.insert_node(sid, "Dativ", "Static location.")
    pre = store.insert_node(sid, "Cases", "Nominative to dative.")
    part = store.insert_node(sid, "Wo questions", "")
    store.insert_edge(sid, topic.id, origin_id, "part_of", "")
    store.insert_edge(sid, pre.id, topic.id, "prerequisite", "")
    store.insert_edge(sid, part.id, topic.id, "part_of", "")
    for i in range(12):
        n = store.insert_node(sid, f"Near {i}", "")
        store.insert_edge(sid, topic.id, n.id, "related", "")
    used = _chat_api(client, topic.id, "hi").json()["context_used"]
    assert [p["name"] for p in used["prerequisites"]] == ["Cases"]
    assert used["part_of"]["name"] == "German"
    assert [p["name"] for p in used["parts"]] == ["Wo questions"]
    assert [n["name"] for n in used["nearby"]] == [f"Near {i}" for i in range(10)]
    notes = _calls(llm, "chat")[-1]["system"]
    assert "Part of: German" in notes and "- Cases: Nominative to dative." in notes
    assert "Near 9" in notes and "Near 10" not in notes
    assert "strength" not in notes.split("Private notes:")[1].split("\n\n", 1)[1]
    assert "untested" not in notes


# ---------- background runs ----------


def test_cartographer_runs_after_every_exchange_and_bumps_version(env):
    client, llm, store = env
    subj, origin_id = _new_subject(client)
    llm.queue_chat("The dative is for location: nothing moves.")
    llm.queue_json(
        {
            "concepts": [
                _concept("Dativ", "for location: nothing moves", relation="part_of"),
            ]
        }
    )
    res = _chat_api(client, origin_id, "dative?").json()
    assert res["cartographer"] == "running"  # status at response time
    status = client.get(f"/api/subjects/{subj['id']}/graph/status", headers=V1).json()
    assert status == {"graph_version": 1, "cartographer": "idle", "error": None}

    _chat_api(client, origin_id, "thanks")  # canned empty extraction: nothing changes
    assert len(_calls(llm, "json")) == 2
    status = client.get(f"/api/subjects/{subj['id']}/graph/status", headers=V1).json()
    assert status["graph_version"] == 1
    assert store.node_by_id(origin_id).last_extracted_message_id == (
        store.node_messages(origin_id)[-1].id
    )


def test_cartographer_failure_does_not_break_chat_and_next_exchange_catches_up(env):
    client, llm, store = env
    subj, origin_id = _new_subject(client)
    llm.queue_json("garbage")
    llm.queue_json("garbage")  # the one retry also fails
    res = _chat_api(client, origin_id, "first")
    assert res.status_code == 200 and res.json()["reply"]
    status = client.get(f"/api/subjects/{subj['id']}/graph/status", headers=V1).json()
    assert status["cartographer"] == "error" and "invalid" in status["error"]
    assert store.node_by_id(origin_id).last_extracted_message_id is None
    assert len(_calls(llm, "json")) == 2  # no retry loop

    _chat_api(client, origin_id, "second")
    prompt = _calls(llm, "json")[-1]["prompt"]
    assert "user: first" in prompt and "user: second" in prompt
    assert "[context]" not in prompt
    status = client.get(f"/api/subjects/{subj['id']}/graph/status", headers=V1).json()
    assert status["cartographer"] == "idle" and status["error"] is None


class BlockingLLM(FakeLLM):
    """Blocks the first cartographer call until released."""

    def __init__(self):
        super().__init__()
        self.started = threading.Event()
        self.release = threading.Event()
        self._blocked = False

    json_started = 0

    def _raw_json(self, system, prompt, schema):
        self.json_started += 1
        if not self._blocked:
            self._blocked = True
            self.started.set()
            assert self.release.wait(10)
        return super()._raw_json(system, prompt, schema)


def test_chat_during_cartographer_run_and_rerun_after_mid_run_messages():
    llm = BlockingLLM()
    client, store = _app(llm)
    subj, origin_id = _new_subject(client)
    first: list = []
    worker = threading.Thread(target=lambda: first.append(_chat_api(client, origin_id, "m1")))
    worker.start()
    try:
        assert llm.started.wait(10)
        status = client.get(f"/api/subjects/{subj['id']}/graph/status", headers=V1).json()
        assert status["cartographer"] == "running"

        # Chat works while the run is blocked mid-call.
        second = _chat_api(client, origin_id, "m2")
        assert second.status_code == 200
        # m2's run did not start a second model call: it waits for the active run.
        assert llm.json_started == 1
    finally:
        llm.release.set()
        worker.join(10)
    assert first[0].status_code == 200

    # The run picked up m2 right after it finished: a second call, m2 new, m1 as context.
    calls = _calls(llm, "json")
    assert len(calls) == 2
    assert "user: m1" in calls[0]["prompt"] and "m2" not in calls[0]["prompt"]
    assert "[context] user: m1" in calls[1]["prompt"] and "\nuser: m2" in calls[1]["prompt"]
    assert store.node_by_id(origin_id).last_extracted_message_id == (
        store.node_messages(origin_id)[-1].id
    )
    status = client.get(f"/api/subjects/{subj['id']}/graph/status", headers=V1).json()
    assert status["cartographer"] == "idle"


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


def test_manual_extract_uses_the_same_lock(env):
    client, _llm, store = env
    subj, origin_id = _new_subject(client)
    assert client.post(f"/api/nodes/{origin_id}/extract", headers=V1).status_code == 409
    store.add_message(subj["id"], origin_id, "user", "hello")
    runner = client.app.state.cartographer
    runner._running.add(subj["id"])  # a background run is in progress
    res = client.post(f"/api/nodes/{origin_id}/extract", headers=V1)
    assert res.status_code == 409 and "already running" in res.json()["detail"]
    runner._running.discard(subj["id"])
    assert client.post(f"/api/nodes/{origin_id}/extract", headers=V1).status_code == 200
    assert client.post(f"/api/nodes/{origin_id}/extract", headers=V1).status_code == 409


# ---------- API shape and scoping ----------


def test_new_subject_starts_with_only_the_origin(env):
    client, *_ = env
    subj, origin_id = _new_subject(client)
    graph = client.get(f"/api/subjects/{subj['id']}/graph", headers=V1).json()
    (node,) = graph["nodes"]
    assert (node["id"], node["name"], node["distance"]) == (origin_id, "German", 0)
    assert "status" not in node
    assert graph["graph_version"] == 0 and graph["cartographer"] == "idle"


def test_dismiss_endpoint_is_gone(env):
    client, *_ = env
    _, origin_id = _new_subject(client)
    assert client.post(f"/api/nodes/{origin_id}/dismiss", headers=V1).status_code in (404, 405)


def test_trail_records_from_node_id_and_ignores_self(env):
    client, _, store = env
    subj, origin_id = _new_subject(client)
    other = store.insert_node(subj["id"], "Dativ", "")
    _chat_api(client, origin_id, "a", from_node_id=origin_id)  # self: no from
    _chat_api(client, origin_id, "b")  # same node: no step
    _chat_api(client, other.id, "c", from_node_id=origin_id)
    graph = client.get(f"/api/subjects/{subj['id']}/graph", headers=V1).json()
    assert [(t["node_id"], t["from_node_id"]) for t in graph["trail"]] == [
        (origin_id, None),
        (other.id, origin_id),
    ]
    assert graph["edges"] == []  # trail steps are never edges


def _trail(client, subject_id):
    graph = client.get(f"/api/subjects/{subject_id}/graph", headers=V1).json()
    return [(t["node_id"], t["from_node_id"]) for t in graph["trail"]]


def test_visit_records_trail_with_from_node_id(env):
    client, _, store = env
    subj, origin_id = _new_subject(client)
    other = store.insert_node(subj["id"], "Dativ", "")
    res = client.post(f"/api/nodes/{origin_id}/visit", headers=V1)
    assert res.status_code == 200 and res.json()["recorded"] is True
    res = client.post(f"/api/nodes/{other.id}/visit", json={"from_node_id": origin_id}, headers=V1)
    assert res.json()["recorded"] is True
    assert res.json()["trail"][-1]["from_node_id"] == origin_id
    assert _trail(client, subj["id"]) == [(origin_id, None), (other.id, origin_id)]


def test_visit_dedupes_and_ignores_self(env):
    client, *_ = env
    subj, origin_id = _new_subject(client)
    url = f"/api/nodes/{origin_id}/visit"
    client.post(url, json={"from_node_id": origin_id}, headers=V1)  # self: no from
    again = client.post(url, json={}, headers=V1)  # same node again: no step
    assert again.json()["recorded"] is False
    # A chat right after opening does not add a second step either.
    _chat_api(client, origin_id, "hello")
    assert _trail(client, subj["id"]) == [(origin_id, None)]
    assert client.get(f"/api/subjects/{subj['id']}/graph", headers=V1).json()["edges"] == []


def test_visit_checks_scope_and_subject(env):
    client, *_ = env
    subj, origin_id = _new_subject(client)
    _other_subj, other_origin = _new_subject(client)
    assert client.post(f"/api/nodes/{origin_id}/visit", headers=V2).status_code == 404
    res = client.post(
        f"/api/nodes/{origin_id}/visit", json={"from_node_id": other_origin}, headers=V1
    )
    assert res.status_code == 422
    res = client.post(f"/api/nodes/{origin_id}/visit", json={"from_node_id": 0}, headers=V1)
    assert res.status_code == 422
    assert _trail(client, subj["id"]) == []


def test_nodes_are_flat_and_list_their_edges(env):
    client, _, store = env
    subj, origin_id = _new_subject(client)
    child = store.insert_node(subj["id"], "Dativ", "")
    grandchild = store.insert_node(subj["id"], "Dativ endings", "")
    store.insert_edge(subj["id"], child.id, origin_id, "part_of", "")
    store.insert_edge(subj["id"], grandchild.id, child.id, "part_of", "")
    detail = client.get(f"/api/nodes/{grandchild.id}", headers=V1).json()
    assert detail["node"]["id"] == grandchild.id
    assert [(e["source"], e["target"], e["kind"]) for e in detail["edges"]] == [
        (grandchild.id, child.id, "part_of")
    ]
    dist = distances_from(origin_id, store.list_edges(subj["id"]))
    assert dist[grandchild.id] == 2


def test_graph_status_and_extract_are_visitor_scoped(env):
    client, *_ = env
    subj, origin_id = _new_subject(client)
    _chat_api(client, origin_id, "hello")
    assert client.get(f"/api/subjects/{subj['id']}/graph/status", headers=V2).status_code == 404
    assert client.get(f"/api/subjects/{subj['id']}/graph", headers=V2).status_code == 404
    assert client.get(f"/api/nodes/{origin_id}", headers=V2).status_code == 404
    assert client.post(f"/api/nodes/{origin_id}/extract", headers=V2).status_code == 404
    res = client.post(f"/api/nodes/{origin_id}/chat", json={"message": "x"}, headers=V2)
    assert res.status_code == 404
