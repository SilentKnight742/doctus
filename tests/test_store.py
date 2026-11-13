import pytest

from doctus.store import Conflict, NotFound, Store, name_key


@pytest.fixture
def store():
    s = Store(":memory:")
    yield s
    s.close()


def _accept_nodes(store, subject_id, *names):
    props = store.add_proposals(
        subject_id, [("node", {"name": n, "summary": f"about {n}"}) for n in names], "test"
    )
    for p in props:
        store.accept_proposal("v1", p.id)


def _accept_edge(store, subject_id, prereq, concept):
    (p,) = store.add_proposals(
        subject_id, [("edge", {"prerequisite": prereq, "concept": concept, "reason": ""})], "test"
    )
    return store.accept_proposal("v1", p.id)


def test_name_key_normalises_case_and_spaces():
    assert name_key("  Self   Attention ") == "self attention"


def test_subjects_are_scoped_to_visitor(store):
    s = store.create_subject("v1", "Transformers", "understand attention")
    assert [x["id"] for x in store.list_subjects("v1")] == [s["id"]]
    assert store.list_subjects("v2") == []
    with pytest.raises(NotFound):
        store.get_subject("v2", s["id"])


def test_empty_subject_title_rejected(store):
    with pytest.raises(ValueError):
        store.create_subject("v1", "   ")


def test_accepting_node_proposal_creates_node(store):
    s = store.create_subject("v1", "Transformers")
    _accept_nodes(store, s["id"], "Attention")
    nodes = store.list_nodes(s["id"])
    assert [n.name for n in nodes] == ["Transformers", "Attention"]  # origin first
    assert store.proposal_stats(s["id"]) == {"pending": 0, "accepted": 1, "rejected": 0}


def test_duplicate_node_name_conflicts_and_proposal_stays_pending(store):
    s = store.create_subject("v1", "Transformers")
    _accept_nodes(store, s["id"], "Attention")
    (p,) = store.add_proposals(s["id"], [("node", {"name": "attention "})], "test")
    with pytest.raises(Conflict):
        store.accept_proposal("v1", p.id)
    assert store.list_proposals(s["id"])[0].id == p.id


def test_edge_requires_both_nodes(store):
    s = store.create_subject("v1", "Transformers")
    _accept_nodes(store, s["id"], "Attention")
    with pytest.raises(Conflict, match="Softmax"):
        _accept_edge(store, s["id"], "Softmax", "Attention")


def test_edge_links_prerequisites_and_dependents(store):
    s = store.create_subject("v1", "Transformers")
    _accept_nodes(store, s["id"], "Softmax", "Attention")
    _accept_edge(store, s["id"], "Softmax", "Attention")
    attention = store.find_node_by_name(s["id"], "Attention")
    softmax = store.find_node_by_name(s["id"], "Softmax")
    assert [n.name for n in store.prerequisites(attention.id)] == ["Softmax"]
    assert [n.name for n in store.dependents(softmax.id)] == ["Attention"]


def test_cycle_is_rejected(store):
    s = store.create_subject("v1", "Transformers")
    _accept_nodes(store, s["id"], "A", "B", "C")
    _accept_edge(store, s["id"], "A", "B")
    _accept_edge(store, s["id"], "B", "C")
    with pytest.raises(Conflict, match="cycle"):
        _accept_edge(store, s["id"], "C", "A")


def test_self_edge_is_rejected(store):
    s = store.create_subject("v1", "Transformers")
    _accept_nodes(store, s["id"], "A")
    with pytest.raises(Conflict, match="cycle"):
        _accept_edge(store, s["id"], "A", "A")


def test_other_visitor_cannot_accept_proposals(store):
    s = store.create_subject("v1", "Transformers")
    (p,) = store.add_proposals(s["id"], [("node", {"name": "A"})], "test")
    with pytest.raises(NotFound):
        store.accept_proposal("v2", p.id)


def test_rejected_proposal_cannot_be_accepted(store):
    s = store.create_subject("v1", "Transformers")
    (p,) = store.add_proposals(s["id"], [("node", {"name": "A"})], "test")
    store.reject_proposal("v1", p.id)
    with pytest.raises(Conflict):
        store.accept_proposal("v1", p.id)
    assert [n.name for n in store.list_nodes(s["id"])] == ["Transformers"]  # origin only


def test_recent_messages_keeps_topic_and_subject_chats_apart(store):
    s = store.create_subject("v1", "Transformers")
    _accept_nodes(store, s["id"], "Attention")
    node = store.find_node_by_name(s["id"], "Attention")
    store.add_message(s["id"], None, "user", "subject chat")
    for i in range(5):
        store.add_message(s["id"], node.id, "user", f"topic {i}")
    topic = store.recent_messages(s["id"], node.id, limit=3)
    assert [m.content for m in topic] == ["topic 2", "topic 3", "topic 4"]
    subject = store.recent_messages(s["id"], None, limit=10)
    assert [m.content for m in subject] == ["subject chat"]
