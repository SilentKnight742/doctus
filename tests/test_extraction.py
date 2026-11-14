"""Exploration graph: evidence, frontier, trail, extraction trigger, distances."""

import pytest
from fastapi.testclient import TestClient

from doctus.api import create_app
from doctus.config import Settings
from doctus.extraction import apply_extraction, find_quote, normalise
from doctus.graph import distances_from
from doctus.llm import FakeLLM
from doctus.mastery import PlaceholderDecayModel
from doctus.prompts import Extraction
from doctus.store import Conflict, Store

V1 = {"X-Doctus-Visitor": "visitor-one-0000000"}
V2 = {"X-Doctus-Visitor": "visitor-two-0000000"}

TUTOR_LINE = "With Wechselpräpositionen, use the dative when nothing moves: Das Buch liegt auf dem Tisch."


# ---------- fixtures ----------

@pytest.fixture
def store():
    s = Store(":memory:")
    yield s
    s.close()


@pytest.fixture
def env():
    llm = FakeLLM()
    store = Store(":memory:")
    settings = Settings(
        db_path=":memory:", llm_provider="fake", gemini_api_key=None,
        gemini_model="x", max_proposals_per_update=5, recent_turns_in_context=8,
    )
    app = create_app(store=store, llm=llm, mastery=PlaceholderDecayModel(), settings=settings)
    return TestClient(app), llm, store


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


def _link(kind="related", direction="before", reason="r"):
    return {"kind": kind, "direction": direction, "reason": reason}


# ---------- evidence verification ----------

def test_quote_found_exactly():
    s = Store(":memory:")
    subj, origin = _subject(s)
    (m,) = [s.add_message(subj["id"], origin.id, "assistant", TUTOR_LINE)]
    assert find_quote("use the dative when nothing moves", [m]) is m


def test_quote_matches_despite_whitespace_and_case():
    s = Store(":memory:")
    subj, origin = _subject(s)
    m = s.add_message(subj["id"], origin.id, "assistant", TUTOR_LINE)
    assert find_quote("  USE the   dative\nwhen nothing MOVES ", [m]) is m
    assert normalise(" A \n b ") == "a b"


def test_quote_matches_despite_markdown_emphasis():
    s = Store(":memory:")
    subj, origin = _subject(s)
    m = s.add_message(subj["id"], origin.id, "assistant",
                      "It answers ***Wohin?*** so we need the **Accusative** case, e.g. `ins` Kino.")
    assert find_quote("It answers Wohin? so we need the Accusative case, e.g. ins Kino.", [m]) is m
    # a changed word still fails
    assert find_quote("It answers Wo? so we need the Accusative case", [m]) is None


def test_covered_concept_without_link_is_invalid():
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        Extraction.model_validate({"covered": [{"name": "X", "evidence": ["q"]}]})


def test_covered_concept_is_always_linked_to_current_node(store):
    s, origin = _subject(store)
    msgs = _chat(store, s, origin, ("q", "Two-way prepositions take accusative or dative."))
    _apply(store, s, origin, msgs, covered=[
        {"name": "Two-way prepositions", "evidence": ["take accusative or dative"],
         "link": _link("related")},
    ])
    node = store.find_node_by_name(s["id"], "Two-way prepositions")
    assert distances_from(origin.id, store.list_edges(s["id"]))[node.id] == 1


def test_fabricated_quote_is_dropped_and_counted(store):
    s, origin = _subject(store)
    msgs = _chat(store, s, origin, ("When do I use dative?", TUTOR_LINE))
    summary = _apply(store, s, origin, msgs, covered=[
        {"name": "Dativ for position", "summary": "x",
         "evidence": ["the dative marks static location in all cases"], "link": _link()},
        {"name": "No quotes at all", "summary": "x", "evidence": [], "link": _link()},
    ])
    assert store.find_node_by_name(s["id"], "Dativ for position") is None
    assert [d["name"] for d in summary.dropped] == ["Dativ for position", "No quotes at all"]
    assert summary.dropped[0]["reason"] == "evidence not found in chat"
    assert summary.dropped[1]["reason"] == "no evidence given"
    assert (summary.evidence_verified, summary.evidence_dropped) == (0, 1)


def test_one_good_quote_is_enough_and_is_stored(store):
    s, origin = _subject(store)
    msgs = _chat(store, s, origin, ("When do I use dative?", TUTOR_LINE))
    summary = _apply(store, s, origin, msgs, covered=[
        {"name": "Dativ for position", "summary": "Static location takes dative.",
         "evidence": ["made up", "Das Buch liegt auf dem Tisch."],
         "link": _link("prerequisite", "after", "position builds on the origin topic")},
    ])
    node = store.find_node_by_name(s["id"], "Dativ for position")
    assert node.status == "covered" and node.covered_at is not None
    ev = store.list_evidence(node.id)
    assert [(e.quote, e.message_id) for e in ev] == [("Das Buch liegt auf dem Tisch.", msgs[1].id)]
    assert (summary.evidence_verified, summary.evidence_dropped) == (1, 1)
    # direction "after": the anchor (origin) comes first
    (edge,) = store.list_edges(s["id"])
    assert (edge.from_id, edge.to_id, edge.kind) == (origin.id, node.id, "prerequisite")


def test_current_node_evidenced_becomes_covered(store):
    s, origin = _subject(store)
    assert origin.status == "frontier"
    msgs = _chat(store, s, origin, ("Explain", TUTOR_LINE))
    summary = _apply(store, s, origin, msgs, current_node_evidence=["nothing moves"])
    assert store.node_by_id(origin.id).status == "covered"
    assert summary.promoted == ["German"]


# ---------- frontier ----------

def test_frontier_promoted_to_covered(store):
    s, origin = _subject(store)
    store.insert_node(s["id"], "Akkusativ", "Case for direct objects.", status="frontier")
    msgs = _chat(store, s, origin, ("And Akkusativ?", "Akkusativ answers wohin: Ich lege das Buch auf den Tisch."))
    summary = _apply(store, s, origin, msgs, covered=[
        {"name": "akkusativ", "evidence": ["Ich lege das Buch auf den Tisch."], "link": _link()},
    ])
    node = store.find_node_by_name(s["id"], "Akkusativ")
    assert node.status == "covered"
    assert summary.promoted == ["Akkusativ"] and summary.added == []


def test_frontier_capped_at_three_per_attach_point(store):
    s, origin = _subject(store)
    msgs = _chat(store, s, origin, ("hi", "hello"))
    summary = _apply(store, s, origin, msgs, frontier=[
        {"name": f"Topic {i}", "attach_to": "German", "link": _link()} for i in range(5)
    ])
    frontier = [n.name for n in store.list_nodes(s["id"]) if n.status == "frontier" and n.id != origin.id]
    assert frontier == ["Topic 0", "Topic 1", "Topic 2"]
    assert [x["item"] for x in summary.skipped] == ["Topic 3", "Topic 4"]


def test_frontier_unknown_attach_point_falls_back_to_current_node(store):
    s, origin = _subject(store)
    msgs = _chat(store, s, origin, ("hi", "hello"))
    _apply(store, s, origin, msgs, frontier=[
        {"name": "Contractions", "attach_to": "Not a node", "link": _link()},
    ])
    (edge,) = store.list_edges(s["id"])
    assert origin.id in (edge.from_id, edge.to_id)


def test_dismissed_names_are_not_re_suggested(store):
    s, origin = _subject(store)
    old = store.insert_node(s["id"], "Contractions", "", status="frontier")
    store.dismiss_node("v1", old.id)
    msgs = _chat(store, s, origin, ("hi", "hello"))
    summary = _apply(store, s, origin, msgs, frontier=[
        {"name": "contractions ", "attach_to": "German", "link": _link()},
    ])
    assert store.node_by_id(old.id).status == "dismissed"
    assert summary.skipped == [{"item": "contractions ", "reason": "name exists"}]
    assert summary.added == []


def test_dismiss_rules(store):
    s, origin = _subject(store)
    covered = store.insert_node(s["id"], "Dativ", "", status="covered")
    with pytest.raises(Conflict, match="origin"):
        store.dismiss_node("v1", origin.id)
    with pytest.raises(Conflict, match="Covered"):
        store.dismiss_node("v1", covered.id)


# ---------- edges ----------

def test_cycle_check_applies_to_prerequisite_edges_only(store):
    s, origin = _subject(store)
    a = store.insert_node(s["id"], "A", "")
    b = store.insert_node(s["id"], "B", "")
    store.insert_edge(s["id"], a.id, b.id, "prerequisite", "")
    with pytest.raises(Conflict, match="cycle"):
        store.insert_edge(s["id"], b.id, a.id, "prerequisite", "")
    # related edges in either direction are fine, and do not block prerequisites
    store.insert_edge(s["id"], b.id, a.id, "related", "")
    c = store.insert_node(s["id"], "C", "")
    store.insert_edge(s["id"], c.id, a.id, "related", "")
    store.insert_edge(s["id"], a.id, c.id, "prerequisite", "")
    assert len(store.list_edges(s["id"])) == 4


def test_extraction_skips_duplicate_self_and_cyclic_edges(store):
    s, origin = _subject(store)
    x = store.insert_node(s["id"], "X", "", status="covered")
    store.insert_edge(s["id"], origin.id, x.id, "prerequisite", "")
    msgs = _chat(store, s, origin, ("q", "X is taught here in full."))
    summary = _apply(store, s, origin, msgs, covered=[
        # X -> origin would close a cycle with origin -> X
        {"name": "X", "evidence": ["X is taught here"], "link": _link("prerequisite", "before")},
    ])
    assert summary.skipped == [{"item": "X -> German (prerequisite)", "reason": "cycle"}]
    summary = _apply(store, s, origin, msgs, covered=[
        {"name": "X", "evidence": ["X is taught here"], "link": _link("prerequisite", "after")},
    ])
    assert summary.skipped[0]["reason"] == "duplicate"


# ---------- distance ----------

def test_distance_from_origin_ignores_direction(store):
    s, origin = _subject(store)
    a = store.insert_node(s["id"], "A", "")
    b = store.insert_node(s["id"], "B", "")
    lone = store.insert_node(s["id"], "Lone", "")
    store.insert_edge(s["id"], a.id, origin.id, "prerequisite", "")   # points at origin
    store.insert_edge(s["id"], a.id, b.id, "related", "")
    dist = distances_from(origin.id, store.list_edges(s["id"]))
    assert dist == {origin.id: 0, a.id: 1, b.id: 2}
    assert lone.id not in dist


# ---------- API: trigger, window, trail, visitors ----------

def _new_subject(client):
    subj = client.post("/api/subjects", json={"title": "German", "goal": "Wechselpräpositionen"},
                       headers=V1).json()
    return subj, subj["origin_node_id"]


def _topic(client, store):
    """A subject plus one ordinary (non-origin) topic node to chat in."""
    subj, _ = _new_subject(client)
    node = store.insert_node(subj["id"], "Dativ", "", status="frontier")
    return subj, node.id


def test_new_subject_has_frontier_origin(env):
    client, *_ = env
    subj, origin_id = _new_subject(client)
    graph = client.get(f"/api/subjects/{subj['id']}/graph", headers=V1).json()
    (node,) = graph["nodes"]
    assert (node["id"], node["name"], node["status"], node["distance"]) == (origin_id, "German", "frontier", 0)


def test_extraction_triggers_on_third_message_not_before(env):
    client, llm, store = env
    subj, node_id = _topic(client, store)
    for i in range(2):
        res = client.post(f"/api/nodes/{node_id}/chat", json={"message": f"m{i}"}, headers=V1).json()
        assert res["extraction"] is None
    assert not [c for c in llm.calls if c["kind"] == "json"]

    llm.queue_json({"current_node_evidence": ["You said: m2"]})
    res = client.post(f"/api/nodes/{node_id}/chat", json={"message": "m2"}, headers=V1).json()
    assert res["extraction"]["promoted"] == ["Dativ"]
    assert len([c for c in llm.calls if c["kind"] == "json"]) == 1

    # the counter restarts after an extraction
    res = client.post(f"/api/nodes/{node_id}/chat", json={"message": "m3"}, headers=V1).json()
    assert res["extraction"] is None


def test_last_extracted_message_advances_and_window_has_two_context_messages(env):
    client, llm, store = env
    subj, node_id = _topic(client, store)
    for i in range(3):
        client.post(f"/api/nodes/{node_id}/chat", json={"message": f"first-{i}"}, headers=V1)
    node = store.node_by_id(node_id)
    last_id = store.node_messages(node_id)[-1].id
    assert node.last_extracted_message_id == last_id

    for i in range(3):
        client.post(f"/api/nodes/{node_id}/chat", json={"message": f"second-{i}"}, headers=V1)
    prompt = [c for c in llm.calls if c["kind"] == "json"][-1]["prompt"]
    convo = prompt.split("Conversation:\n", 1)[1].splitlines()
    assert len(convo) == 2 + 6
    assert convo[0] == "[context] user: first-2"
    assert convo[1].startswith("[context] assistant:")
    assert convo[2] == "user: second-0"
    assert "first-1" not in prompt
    assert store.node_by_id(node_id).last_extracted_message_id == store.node_messages(node_id)[-1].id


def test_manual_extract_and_nothing_new(env):
    client, llm, store = env
    subj, node_id = _topic(client, store)
    assert client.post(f"/api/nodes/{node_id}/extract", headers=V1).status_code == 409
    client.post(f"/api/nodes/{node_id}/chat", json={"message": "hello"}, headers=V1)
    res = client.post(f"/api/nodes/{node_id}/extract", headers=V1)
    assert res.status_code == 200
    assert client.post(f"/api/nodes/{node_id}/extract", headers=V1).status_code == 409


def test_failed_extraction_keeps_chat_reply(env):
    client, llm, store = env
    subj, node_id = _topic(client, store)
    for i in range(2):
        client.post(f"/api/nodes/{node_id}/chat", json={"message": f"m{i}"}, headers=V1)
    llm.queue_json("garbage")
    llm.queue_json("garbage")
    res = client.post(f"/api/nodes/{node_id}/chat", json={"message": "m2"}, headers=V1)
    assert res.status_code == 200
    assert "error" in res.json()["extraction"]
    assert store.node_by_id(node_id).last_extracted_message_id is None


def test_origin_first_reply_builds_graph_immediately(env):
    client, llm, store = env
    subj, origin_id = _new_subject(client)
    llm.queue_json({"current_node_evidence": ["You said: overview please"]})
    res = client.post(f"/api/nodes/{origin_id}/chat",
                      json={"message": "overview please"}, headers=V1).json()
    assert res["extraction"]["promoted"] == ["German"]
    # afterwards the origin follows the normal every-3rd-message rule
    for i in range(2):
        res = client.post(f"/api/nodes/{origin_id}/chat", json={"message": f"m{i}"}, headers=V1).json()
        assert res["extraction"] is None
    res = client.post(f"/api/nodes/{origin_id}/chat", json={"message": "m2"}, headers=V1).json()
    assert res["extraction"] is not None


def test_tutor_gives_big_picture_in_origin_and_stays_focused_in_topics(env):
    client, llm, store = env
    subj, node_id = _topic(client, store)
    client.post(f"/api/nodes/{subj['origin_node_id']}/chat", json={"message": "all of it"}, headers=V1)
    client.post(f"/api/nodes/{node_id}/chat", json={"message": "this one"}, headers=V1)
    origin_sys, topic_sys = [c["system"] for c in llm.calls if c["kind"] == "chat"]
    assert "starting point" in origin_sys and "Stay on it" not in origin_sys
    assert "Stay on it" in topic_sys and "starting point" not in topic_sys
    assert "in full, in your first reply" in origin_sys and "in full, in your first reply" in topic_sys


def test_from_node_id_equal_to_node_is_ignored(env):
    client, llm, store = env
    subj, origin_id = _new_subject(client)
    client.post(f"/api/nodes/{origin_id}/chat",
                json={"message": "a", "from_node_id": origin_id}, headers=V1)
    trail = client.get(f"/api/subjects/{subj['id']}/graph", headers=V1).json()["trail"]
    assert [(t["node_id"], t["from_node_id"]) for t in trail] == [(origin_id, None)]


def test_nodes_are_flat_and_list_their_edges(env):
    client, llm, store = env
    subj, origin_id = _new_subject(client)
    child = store.insert_node(subj["id"], "Dativ", "", status="frontier")
    grandchild = store.insert_node(subj["id"], "Dativ endings", "", status="frontier")
    store.insert_edge(subj["id"], origin_id, child.id, "prerequisite", "r1")
    store.insert_edge(subj["id"], child.id, grandchild.id, "related", "r2")
    # a node two steps from the origin is addressed by its own id alone
    detail = client.get(f"/api/nodes/{grandchild.id}", headers=V1).json()
    assert detail["node"]["id"] == grandchild.id
    assert [(e["source"], e["target"], e["kind"]) for e in detail["edges"]] == [
        (child.id, grandchild.id, "related")
    ]
    mid = client.get(f"/api/nodes/{child.id}", headers=V1).json()
    assert len(mid["edges"]) == 2


def test_trail_records_from_node_id(env):
    client, llm, store = env
    subj, origin_id = _new_subject(client)
    other = store.insert_node(subj["id"], "Dativ", "", status="frontier")
    client.post(f"/api/nodes/{origin_id}/chat", json={"message": "a"}, headers=V1)
    client.post(f"/api/nodes/{origin_id}/chat", json={"message": "b"}, headers=V1)  # same node: no step
    client.post(f"/api/nodes/{other.id}/chat", json={"message": "c", "from_node_id": origin_id}, headers=V1)
    graph = client.get(f"/api/subjects/{subj['id']}/graph", headers=V1).json()
    assert [(t["node_id"], t["from_node_id"]) for t in graph["trail"]] == [
        (origin_id, None), (other.id, origin_id),
    ]
    # trail steps are never graph edges
    assert graph["edges"] == []


def test_graph_reports_extraction_stats(env):
    client, llm, store = env
    subj, node_id = _topic(client, store)
    client.post(f"/api/nodes/{node_id}/chat", json={"message": "hello there"}, headers=V1)
    llm.queue_json({"current_node_evidence": ["hello there", "not in the chat"]})
    client.post(f"/api/nodes/{node_id}/extract", headers=V1)
    stats = client.get(f"/api/subjects/{subj['id']}/graph", headers=V1).json()["extraction_stats"]
    assert stats == {"runs": 1, "covered_nodes": 1, "evidence_verified": 1, "evidence_dropped": 1}


def test_topic_context_includes_covered_neighbours_and_frontier(env):
    client, llm, store = env
    subj, origin_id = _new_subject(client)
    cov = store.insert_node(subj["id"], "Dativ", "Static location.", status="covered")
    fr = store.insert_node(subj["id"], "Contractions", "", status="frontier")
    store.insert_edge(subj["id"], cov.id, origin_id, "related", "")
    store.insert_edge(subj["id"], origin_id, fr.id, "related", "")
    res = client.post(f"/api/nodes/{origin_id}/chat", json={"message": "hi"}, headers=V1).json()
    used = res["context_used"]
    assert [c["name"] for c in used["covered_neighbours"]] == ["Dativ"]
    assert [f["name"] for f in used["frontier"]] == ["Contractions"]
    system = [c for c in llm.calls if c["kind"] == "chat"][-1]["system"]
    assert "Dativ: Static location." in system and "Contractions" in system


def test_other_visitor_cannot_extract_dismiss_or_read(env):
    client, llm, store = env
    subj, origin_id = _new_subject(client)
    fr = store.insert_node(subj["id"], "Contractions", "", status="frontier")
    client.post(f"/api/nodes/{origin_id}/chat", json={"message": "hello"}, headers=V1)
    assert client.post(f"/api/nodes/{origin_id}/extract", headers=V2).status_code == 404
    assert client.post(f"/api/nodes/{fr.id}/dismiss", headers=V2).status_code == 404
    assert client.get(f"/api/nodes/{origin_id}", headers=V2).status_code == 404
    assert client.get(f"/api/subjects/{subj['id']}/graph", headers=V2).status_code == 404
    assert client.post(f"/api/nodes/{origin_id}/chat",
                       json={"message": "x", "from_node_id": fr.id}, headers=V2).status_code == 404
    assert store.node_by_id(fr.id).status == "frontier"
    # and the owner can
    assert client.post(f"/api/nodes/{fr.id}/dismiss", headers=V1).json()["status"] == "dismissed"
