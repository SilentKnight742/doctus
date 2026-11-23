"""Store traversal helpers over the adjacency list."""

import pytest

from doctus.store import Store


@pytest.fixture
def g():
    """German
       ├─ part: Cases ─ part: Dativ ─ part: Dativ endings
       └─ part: Wechselpräpositionen
    prerequisites: Cases -> Wechselpräpositionen -> Contractions
    related: Contractions ~ Dativ endings;  Lone has no edges."""
    s = Store(":memory:")
    subj = s.create_subject("v1", "German")
    sid = subj["id"]
    n = {"German": s.insert_node(sid, "German", "")}
    for name in ("Cases", "Dativ", "Dativ endings", "Wechselpräpositionen", "Contractions", "Lone"):
        n[name] = s.insert_node(sid, name, "")
    edges = [
        ("Cases", "German", "part_of"),
        ("Dativ", "Cases", "part_of"),
        ("Dativ endings", "Dativ", "part_of"),
        ("Wechselpräpositionen", "German", "part_of"),
        ("Cases", "Wechselpräpositionen", "prerequisite"),
        ("Wechselpräpositionen", "Contractions", "prerequisite"),
        ("Contractions", "Dativ endings", "related"),
    ]
    for a, b, kind in edges:
        s.insert_edge(sid, n[a].id, n[b].id, kind, "")
    yield s, {k: v.id for k, v in n.items()}
    s.close()


def _names(nodes):
    return sorted(x.name for x in nodes)


def test_part_of_ancestors_are_wholes_and_descendants_are_parts(g):
    s, n = g
    assert _names(s.ancestors(n["Dativ endings"], "part_of")) == ["Cases", "Dativ", "German"]
    assert _names(s.descendants(n["German"], "part_of")) == [
        "Cases",
        "Dativ",
        "Dativ endings",
        "Wechselpräpositionen",
    ]


def test_prerequisite_ancestors_come_before_and_descendants_build_on(g):
    s, n = g
    assert _names(s.ancestors(n["Contractions"], "prerequisite")) == [
        "Cases",
        "Wechselpräpositionen",
    ]
    assert _names(s.descendants(n["Cases"], "prerequisite")) == [
        "Contractions",
        "Wechselpräpositionen",
    ]


def test_related_has_no_ancestors(g):
    s, n = g
    with pytest.raises(ValueError):
        s.ancestors(n["Contractions"], "related")


def test_part_of_root(g):
    s, n = g
    assert s.part_of_root(n["Dativ endings"]).name == "German"
    assert s.part_of_root(n["German"]).name == "German"
    assert s.part_of_root(n["Lone"]).name == "Lone"


def test_path_is_shortest_over_all_edges_ignoring_direction(g):
    s, n = g
    names = {v: k for k, v in n.items()}
    path = s.path(n["Contractions"], n["Cases"])
    assert [names[i] for i in path] == ["Contractions", "Wechselpräpositionen", "Cases"]
    assert s.path(n["Dativ endings"], n["Dativ endings"]) == [n["Dativ endings"]]
    assert s.path(n["Lone"], n["German"]) is None


def test_edge_indexes_exist(g):
    s, _ = g
    names = {r["name"] for r in s._all("SELECT name FROM sqlite_master WHERE type = 'index'")}
    assert {"edges_from", "edges_to", "edges_kind"} <= names
