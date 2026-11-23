"""The branch canvas: tree integrity, migration, node endpoints, suggestions,
branch path, search and graph_version bumps."""

import sqlite3

import pytest

from conftest import (
    V1,
    V2,
    canvas_of,
    chat,
    child,
    concept,
    extraction,
    new_subject,
    sibling,
)
from doctus.store import SCHEMA, Conflict, NotFound, Store, clean_keyword, note_title

# ---------- store: tree integrity ----------


@pytest.fixture
def store():
    s = Store(":memory:")
    yield s
    s.close()


def _tree(store):
    """root ─ a ─ a1
    └ b (note)"""
    s = store.create_subject("v1", "German")
    root = s["root_canvas_node_id"]
    a = store.add_canvas_node("v1", root, "child", "chat", "What is the dative?")
    a1 = store.add_canvas_node("v1", a.id, "child", "chat", "Which prepositions?")
    b = store.add_canvas_node("v1", root, "child", "note", "# Plan\nlearn cases")
    return s, root, a, a1, b


def test_new_subject_has_one_root_chat_node(store):
    s = store.create_subject("v1", "German")
    (root,) = store.list_canvas_nodes(s["id"])
    assert root.id == s["root_canvas_node_id"]
    assert (root.parent_id, root.kind) == (None, "chat")
    assert store.list_nodes(s["id"]) == []  # no origin concept any more
    assert store.canvas_messages(root.id) == []


def test_every_node_has_one_parent_in_the_same_subject(store):
    s, root, a, a1, b = _tree(store)
    nodes = store.list_canvas_nodes(s["id"])
    assert [n.id for n in nodes] == [root, a.id, a1.id, b.id]  # parents first, in order
    assert [n.parent_id for n in nodes] == [None, root, a.id, root]
    assert {n.subject_id for n in nodes} == {s["id"]}
    with pytest.raises(sqlite3.IntegrityError):  # a second root is refused by the schema
        store._db.execute(
            "INSERT INTO canvas_nodes (subject_id, parent_id, kind, created_at) "
            "VALUES (?, NULL, 'chat', 0)",
            (s["id"],),
        )


def test_no_cycles_every_branch_reaches_the_root(store):
    s, root, *_ = _tree(store)
    for n in store.list_canvas_nodes(s["id"]):
        path = store.branch(n.id)
        assert path[0].id == root and path[-1].id == n.id
        assert len({p.id for p in path}) == len(path)
        assert all(path[i + 1].parent_id == path[i].id for i in range(len(path) - 1))


def test_sibling_is_inserted_right_after_its_anchor(store):
    _s, root, a, _a1, b = _tree(store)
    mid = store.add_canvas_node("v1", a.id, "sibling", "chat", "In between?")
    order = [c.id for c in store.canvas_children(root)]
    assert order == [a.id, mid.id, b.id]
    with pytest.raises(Conflict, match="root has no siblings"):
        store.add_canvas_node("v1", root, "sibling", "chat", "x")


def test_chat_node_needs_a_question_and_note_gets_a_title(store):
    _s, root, *_ = _tree(store)
    with pytest.raises(ValueError, match="first question"):
        store.add_canvas_node("v1", root, "child", "chat", "   ")
    note = store.add_canvas_node("v1", root, "child", "note", "\n## My **plan**  \nmore")
    assert note.title == "My **plan**" and note.keyword == "My"
    assert note_title("") == "" and clean_keyword("  (Dativ), case") == "Dativ"


def test_other_visitor_cannot_touch_nodes(store):
    _s, root, a, *_ = _tree(store)
    with pytest.raises(NotFound):
        store.add_canvas_node("v2", root, "child", "chat", "x")
    with pytest.raises(NotFound):
        store.delete_canvas_node("v2", a.id)


def test_delete_leaf_branch_needs_confirm_and_root_is_kept(store):
    s, root, a, a1, b = _tree(store)
    with pytest.raises(Conflict, match="root cannot be deleted"):
        store.delete_canvas_node("v1", root)
    with pytest.raises(Conflict, match="1 node"):
        store.delete_canvas_node("v1", a.id)
    assert store.delete_canvas_node("v1", b.id)["deleted"] == [b.id]
    result = store.delete_canvas_node("v1", a.id, branch=True)
    assert sorted(result["deleted"]) == [a.id, a1.id]
    assert [n.id for n in store.list_canvas_nodes(s["id"])] == [root]
    assert store.canvas_messages(a1.id) == []  # messages went with the nodes


def test_delete_removes_unevidenced_concepts_and_rehomes_the_rest(store):
    s, root, a, _a1, _b = _tree(store)
    sid = s["id"]
    q_root = store.add_canvas_message(root, "assistant", "Cases mark roles. Dative is static.")
    q_a = store.add_canvas_message(a.id, "assistant", "The dative marks static location.")
    only_a = store.insert_node(sid, "Wo questions", "", home_canvas_node_id=a.id)
    store.add_evidence(only_a.id, q_a.id, "static location")
    shared = store.insert_node(sid, "Dative", "", home_canvas_node_id=a.id)
    store.add_evidence(shared.id, q_a.id, "dative marks")
    store.add_evidence(shared.id, q_root.id, "Dative is static")
    result = store.delete_canvas_node("v1", a.id, branch=True)
    assert result["concepts_removed"] == ["Wo questions"]
    assert result["concepts_moved"] == ["Dative"]
    assert store.find_node_by_name(sid, "Wo questions") is None
    assert store.find_node_by_name(sid, "Dative").home_canvas_node_id == root


# ---------- migration ----------


def test_migration_merges_m1_chats_into_one_root(tmp_path):
    path = str(tmp_path / "old.db")
    db = sqlite3.connect(path)
    db.executescript(SCHEMA)
    db.execute("INSERT INTO subjects (visitor, title, created_at) VALUES ('v1', 'German', 1)")
    db.execute(
        "INSERT INTO nodes (subject_id, name, name_key, created_at) VALUES (1, 'Dativ', 'dativ', 1)"
    )
    for i, (node, role) in enumerate([(None, "user"), (1, "user"), (1, "assistant")]):
        db.execute(
            "INSERT INTO messages (subject_id, node_id, role, content, created_at) "
            "VALUES (1, ?, ?, ?, ?)",
            (node, role, f"m{i}", i),
        )
    db.execute(
        "INSERT INTO extractions (subject_id, node_id, at, evidence_verified, evidence_dropped,"
        " summary) VALUES (1, 1, 1, 2, 0, '{}')"
    )
    db.commit()
    db.close()

    s = Store(path)
    subject = s.get_subject("v1", 1)
    (root,) = s.list_canvas_nodes(1)
    assert subject["root_canvas_node_id"] == root.id and root.parent_id is None
    assert [m.content for m in s.canvas_messages(root.id)] == ["m0", "m1", "m2"]
    assert root.last_extracted_message_id == 3  # old chats are not re-extracted
    assert s.find_node_by_name(1, "Dativ").home_canvas_node_id == root.id
    assert s.extraction_stats(1)["evidence_verified"] == 2
    assert s._one("PRAGMA user_version")[0] == 1
    s.close()
    assert (tmp_path / "old.db.pre-m3").exists()
    Store(path).close()  # a second open does not migrate again


# ---------- API: new subject flows ----------


def test_new_subject_with_first_question_then_answer(canvas):
    client, llm, _store = canvas
    s, root = new_subject(client, first_question="What are the German cases?")
    view = canvas_of(client, s["id"])
    (node,) = view["nodes"]
    assert node["pending"] and not node["answered"]
    assert node["messages"][0]["content"] == "What are the German cases?"
    llm.queue_chat("There are four.")
    res = chat(client, root)  # no message: answer the waiting question
    assert res.status_code == 200
    (node,) = canvas_of(client, s["id"])["nodes"]
    assert [m["role"] for m in node["messages"]] == ["user", "assistant"]
    assert node["answered"] and not node["pending"]


def test_new_subject_without_question_starts_with_first_chat(canvas):
    client, llm, _ = canvas
    s, root = new_subject(client)
    assert chat(client, root).status_code == 422  # nothing to answer yet
    llm.queue_chat("Hallo!")
    assert chat(client, root, "Teach me German").status_code == 200
    (node,) = canvas_of(client, s["id"])["nodes"]
    assert [m["content"] for m in node["messages"]] == ["Teach me German", "Hallo!"]


def test_follow_up_while_a_question_waits_is_409(canvas):
    client, *_ = canvas
    _, root = new_subject(client, first_question="Q1")
    res = chat(client, root, "Q2")
    assert res.status_code == 409 and "waiting" in res.json()["detail"]


def test_subject_rename_and_list(canvas):
    client, *_ = canvas
    s, _ = new_subject(client)
    res = client.patch(f"/api/subjects/{s['id']}", json={"title": "Deutsch"}, headers=V1)
    assert res.status_code == 200 and res.json()["title"] == "Deutsch"
    assert (
        client.patch(f"/api/subjects/{s['id']}", json={"title": " "}, headers=V1).status_code == 422
    )
    assert (
        client.patch(f"/api/subjects/{s['id']}", json={"title": "x"}, headers=V2).status_code == 404
    )


# ---------- API: canvas shape ----------


def test_canvas_shows_nodes_concepts_links_and_suggestions(canvas):
    client, llm, _store = canvas
    s, root = new_subject(client)
    llm.queue_chat("Cases mark roles. The dative marks the indirect object.")
    llm.queue_json(
        extraction(
            title="German cases",
            keyword="cases",
            concepts=[
                concept("Cases", "Cases mark roles"),
                concept("Dative", "The dative marks the indirect object"),
            ],
            links=[{"source": "Cases", "target": "Dative", "kind": "prerequisite", "reason": "r"}],
            suggestions=["Which prepositions take the dative?"],
        )
    )
    chat(client, root, "What are cases?")
    a = child(client, root, "Tell me about the accusative").json()
    llm.queue_chat("The accusative marks the direct object.")
    llm.queue_json(
        extraction(
            title="Accusative",
            concepts=[concept("Accusative", "accusative marks the direct object")],
            links=[{"source": "Cases", "target": "Accusative", "kind": "related"}],
        )
    )
    chat(client, a["id"])

    view = canvas_of(client, s["id"])
    assert view["root_id"] == root
    nodes = {n["id"]: n for n in view["nodes"]}
    assert nodes[root]["title"] == "German cases" and nodes[root]["keyword"] == "cases"
    assert [c["name"] for c in nodes[root]["concepts"]] == ["Cases", "Dative"]
    assert nodes[a["id"]]["parent_id"] == root
    assert nodes[a["id"]]["keyword"] == "Accusative"  # falls back to the title's first word
    links = {(x["from_concept"]["name"], x["to_concept"]["name"]): x for x in view["links"]}
    assert links[("Cases", "Dative")]["kind"] == "prerequisite"
    assert (links[("Cases", "Dative")]["from_node"], links[("Cases", "Dative")]["to_node"]) == (
        root,
        root,
    )
    cross = links[("Cases", "Accusative")]
    assert (cross["kind"], cross["from_node"], cross["to_node"]) == ("related", root, a["id"])
    assert [x["text"] for x in view["suggestions"]] == ["Which prepositions take the dative?"]
    assert view["cartographer"] == "idle"


def test_part_of_edges_are_not_on_the_canvas(canvas):
    client, _, store = canvas
    s, root = new_subject(client)
    x = store.insert_node(s["id"], "X", "", home_canvas_node_id=root)
    y = store.insert_node(s["id"], "Y", "", home_canvas_node_id=root)
    store.insert_edge(s["id"], x.id, y.id, "part_of", "")
    assert canvas_of(client, s["id"])["links"] == []


def test_node_detail_lists_evidence_links_and_reinforced_concepts(canvas):
    client, llm, _ = canvas
    _s, root = new_subject(client)
    llm.queue_chat("The dative marks the indirect object.")
    llm.queue_json(extraction(concepts=[concept("Dative", "dative marks the indirect")]))
    chat(client, root, "dative?")
    a = child(client, root, "more dative").json()
    llm.queue_chat("Again: the dative answers wem.")
    llm.queue_json(extraction(concepts=[concept("dative ", "the dative answers wem")]))
    chat(client, a["id"])

    detail = client.get(f"/api/canvas-nodes/{root}", headers=V1).json()
    (dative,) = detail["concepts"]
    assert dative["home_canvas_node_id"] == root
    assert [e["canvas_node_id"] for e in dative["evidence"]] == [root, a["id"]]
    child_detail = client.get(f"/api/canvas-nodes/{a['id']}", headers=V1).json()
    assert child_detail["concepts"] == []
    assert [c["name"] for c in child_detail["also_taught_here"]] == ["Dative"]


# ---------- API: creating, editing, deleting ----------


def test_child_and_sibling_endpoints(canvas):
    client, *_ = canvas
    _s, root = new_subject(client)
    a = child(client, root, "A?").json()
    n = sibling(client, a["id"], "my note", kind="note").json()
    assert (a["parent_id"], a["pending"], a["messages"][0]["content"]) == (root, True, "A?")
    assert (n["parent_id"], n["kind"], n["title"]) == (root, "note", "my note")
    assert sibling(client, root, "x").status_code == 409
    assert child(client, root, "").status_code == 422
    assert child(client, root, "x" * 8001).status_code == 422
    assert child(client, root, "x" * 8001, kind="note").status_code == 201
    assert child(client, root, "x", kind="map").status_code == 422


def test_edit_prompt_only_before_an_answer(canvas):
    client, llm, _ = canvas
    _, root = new_subject(client)
    a = child(client, root, "Waht is dative?").json()
    res = client.patch(
        f"/api/canvas-nodes/{a['id']}", json={"prompt": "What is the dative?"}, headers=V1
    )
    assert res.status_code == 200
    assert res.json()["messages"][0]["content"] == "What is the dative?"
    llm.queue_chat("It marks the indirect object.")
    chat(client, a["id"])
    res = client.patch(f"/api/canvas-nodes/{a['id']}", json={"prompt": "changed"}, headers=V1)
    assert res.status_code == 409 and "already has an answer" in res.json()["detail"]
    res = client.patch(f"/api/canvas-nodes/{a['id']}", json={"kind": "note"}, headers=V1)
    assert res.status_code == 409


def test_switch_between_note_and_chat_before_sending(canvas):
    client, _llm, _ = canvas
    _, root = new_subject(client)
    a = child(client, root, "Is this a question?").json()
    n = client.patch(f"/api/canvas-nodes/{a['id']}", json={"kind": "note"}, headers=V1).json()
    assert (n["kind"], n["note_body"], n["messages"]) == ("note", "Is this a question?", [])
    assert chat(client, a["id"], "hi").status_code == 409  # notes do not talk to the tutor
    edited = client.patch(
        f"/api/canvas-nodes/{a['id']}", json={"note_body": "Yes it is"}, headers=V1
    )
    assert edited.json()["title"] == "Yes it is"
    c = client.patch(f"/api/canvas-nodes/{a['id']}", json={"kind": "chat"}, headers=V1).json()
    assert (c["kind"], c["note_body"], c["pending"]) == ("chat", "", True)
    assert c["messages"][0]["content"] == "Yes it is"
    assert client.patch(f"/api/canvas-nodes/{a['id']}", json={}, headers=V1).status_code == 422
    res = client.patch(f"/api/canvas-nodes/{a['id']}", json={"note_body": "x"}, headers=V1)
    assert res.status_code == 409  # a chat has no note body


def test_delete_endpoint_needs_confirm_for_a_branch(canvas):
    client, *_ = canvas
    s, root = new_subject(client)
    a = child(client, root, "A?").json()
    child(client, a["id"], "A1?")
    res = client.delete(f"/api/canvas-nodes/{a['id']}", headers=V1)
    assert res.status_code == 409 and "confirm=branch" in res.json()["detail"]
    assert client.delete(f"/api/canvas-nodes/{a['id']}?confirm=yes", headers=V1).status_code == 422
    res = client.delete(f"/api/canvas-nodes/{a['id']}?confirm=branch", headers=V1)
    assert res.status_code == 200 and len(res.json()["deleted"]) == 2
    assert client.delete(f"/api/canvas-nodes/{root}", headers=V1).status_code == 409
    assert [n["id"] for n in canvas_of(client, s["id"])["nodes"]] == [root]


# ---------- suggestions ----------


def test_accepting_a_suggestion_creates_a_child_and_removes_it(canvas):
    client, llm, _ = canvas
    s, root = new_subject(client)
    llm.queue_chat("Cases mark roles.")
    llm.queue_json(extraction(title="Cases", suggestions=["What is the dative?", "And genitive?"]))
    chat(client, root, "cases?")
    sugg = canvas_of(client, s["id"])["suggestions"]
    assert client.post(f"/api/suggestions/{sugg[0]['id']}/accept", headers=V2).status_code == 404
    res = client.post(f"/api/suggestions/{sugg[0]['id']}/accept", headers=V1)
    assert res.status_code == 201
    node = res.json()
    assert (node["parent_id"], node["pending"]) == (root, True)
    assert node["messages"][0]["content"] == "What is the dative?"
    left = canvas_of(client, s["id"])["suggestions"]
    assert [x["text"] for x in left] == ["And genitive?"]
    assert client.post(f"/api/suggestions/{sugg[0]['id']}/accept", headers=V1).status_code == 404
    llm.queue_chat("The dative marks the indirect object.")
    assert chat(client, node["id"]).status_code == 200


# ---------- branch path and search ----------


def test_branch_path_reads_root_to_node(canvas):
    client, llm, _ = canvas
    _s, root = new_subject(client)
    llm.queue_chat("Overview.")
    chat(client, root, "Teach me German")
    a = child(client, root, "Dative?").json()
    child(client, root, "Sibling?")  # not on the path
    n = child(client, a["id"], "my note", kind="note").json()
    path = client.get(f"/api/canvas-nodes/{n['id']}/path", headers=V1).json()["nodes"]
    assert [p["id"] for p in path] == [root, a["id"], n["id"]]
    assert [m["content"] for m in path[0]["messages"]] == ["Teach me German", "Overview."]
    assert path[2]["note_body"] == "my note"
    assert client.get(f"/api/canvas-nodes/{n['id']}/path", headers=V2).status_code == 404


def test_search_finds_titles_messages_notes_and_concepts(canvas):
    client, llm, _store = canvas
    s, root = new_subject(client)
    llm.queue_chat("The Dativ answers wem.")
    llm.queue_json(
        extraction(title="Dativ basics", concepts=[concept("Dativ case", "Dativ answers")])
    )
    chat(client, root, "Explain it")
    n = child(client, root, "remember: dativ after mit", kind="note").json()
    other, _ = new_subject(client, title="Other")
    res = client.get(f"/api/subjects/{s['id']}/search", params={"q": "DATIV"}, headers=V1).json()
    found = {(r["field"], r["canvas_node_id"]) for r in res["results"]}
    assert ("title", root) in found and ("message", root) in found
    assert ("concept", root) in found and ("note", n["id"]) in found
    assert ("title", n["id"]) in found
    pct = client.get(f"/api/subjects/{s['id']}/search", params={"q": "%"}, headers=V1).json()
    assert pct["results"] == []  # LIKE wildcards are escaped
    assert (
        client.get(f"/api/subjects/{s['id']}/search", params={"q": ""}, headers=V1).status_code
        == 422
    )
    assert (
        client.get(f"/api/subjects/{s['id']}/search", params={"q": " "}, headers=V1).status_code
        == 422
    )
    assert client.get(f"/api/subjects/{s['id']}/search?q=x", headers=V2).status_code == 404
    assert (
        client.get(f"/api/subjects/{other['id']}/search?q=dativ", headers=V1).json()["results"]
        == []
    )


# ---------- graph_version ----------


def test_graph_version_bumps_on_every_canvas_change(canvas):
    client, llm, _ = canvas
    s, root = new_subject(client)

    def version():
        return client.get(f"/api/subjects/{s['id']}/canvas/status", headers=V1).json()[
            "graph_version"
        ]

    steps = []

    def step(label, fn):
        before = version()
        fn()
        steps.append((label, version() > before))

    llm.queue_json(extraction(suggestions=["Next?"]))
    step("first exchange", lambda: chat(client, root, "Hi"))
    a = {}
    step("create child", lambda: a.update(child(client, root, "A?").json()))
    step("create sibling note", lambda: a.update(note=sibling(client, a["id"], "n", "note").json()))
    step(
        "edit prompt",
        lambda: client.patch(f"/api/canvas-nodes/{a['id']}", json={"prompt": "A2?"}, headers=V1),
    )
    step(
        "switch kind",
        lambda: client.patch(f"/api/canvas-nodes/{a['id']}", json={"kind": "note"}, headers=V1),
    )
    step(
        "edit note",
        lambda: client.patch(
            f"/api/canvas-nodes/{a['note']['id']}", json={"note_body": "m"}, headers=V1
        ),
    )
    sugg = canvas_of(client, s["id"])["suggestions"][0]
    step(
        "accept suggestion",
        lambda: client.post(f"/api/suggestions/{sugg['id']}/accept", headers=V1),
    )
    step("delete", lambda: client.delete(f"/api/canvas-nodes/{a['id']}", headers=V1))
    step(
        "rename subject",
        lambda: client.patch(f"/api/subjects/{s['id']}", json={"title": "D"}, headers=V1),
    )
    assert [label for label, bumped in steps if not bumped] == []
