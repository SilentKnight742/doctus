"""SQLite storage for subjects, concept nodes, edges, evidence, the
learner's trail, graph-change proposals and chat messages.

Every subject belongs to one anonymous visitor token, and every read
or write goes through a subject the visitor owns.
"""

import json
import sqlite3
import threading
import time
from collections import deque
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS subjects (
    id          INTEGER PRIMARY KEY,
    visitor     TEXT NOT NULL,
    title       TEXT NOT NULL,
    goal        TEXT NOT NULL DEFAULT '',
    created_at  REAL NOT NULL,
    origin_node_id INTEGER,
    -- bumped on every graph change, so clients can poll cheaply
    graph_version INTEGER NOT NULL DEFAULT 0,
    cartographer_state TEXT NOT NULL DEFAULT 'idle'
                CHECK (cartographer_state IN ('idle', 'running', 'error')),
    cartographer_error TEXT
);

CREATE TABLE IF NOT EXISTS nodes (
    id              INTEGER PRIMARY KEY,
    subject_id      INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    name_key        TEXT NOT NULL,
    summary         TEXT NOT NULL DEFAULT '',
    created_at      REAL NOT NULL,
    last_visited_at REAL,
    mastery         TEXT NOT NULL DEFAULT '{}',
    last_extracted_message_id INTEGER,
    UNIQUE (subject_id, name_key)
);

-- kind 'prerequisite': from_id must be understood before to_id.
-- kind 'part_of': from_id is a part of to_id (at most one parent per node).
-- kind 'related': adjacent concepts; direction carries no meaning.
CREATE TABLE IF NOT EXISTS edges (
    id          INTEGER PRIMARY KEY,
    subject_id  INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    from_id     INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    to_id       INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL DEFAULT 'prerequisite'
                CHECK (kind IN ('prerequisite', 'part_of', 'related')),
    reason      TEXT NOT NULL DEFAULT '',
    UNIQUE (from_id, to_id, kind)
);
CREATE INDEX IF NOT EXISTS edges_from ON edges (from_id);
CREATE INDEX IF NOT EXISTS edges_to ON edges (to_id);
CREATE INDEX IF NOT EXISTS edges_kind ON edges (kind);

-- A verbatim quote from a chat message showing a concept was taught.
CREATE TABLE IF NOT EXISTS node_evidence (
    id          INTEGER PRIMARY KEY,
    node_id     INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    message_id  INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    quote       TEXT NOT NULL
);

-- The order the learner visited nodes. Never mixed with edges.
CREATE TABLE IF NOT EXISTS trail (
    id           INTEGER PRIMARY KEY,
    subject_id   INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    node_id      INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    from_node_id INTEGER REFERENCES nodes(id) ON DELETE SET NULL,
    at           REAL NOT NULL
);

-- One row per cartographer run, for stats and auditing.
CREATE TABLE IF NOT EXISTS extractions (
    id                INTEGER PRIMARY KEY,
    subject_id        INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    node_id           INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    at                REAL NOT NULL,
    evidence_verified INTEGER NOT NULL,
    evidence_dropped  INTEGER NOT NULL,
    summary           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS proposals (
    id          INTEGER PRIMARY KEY,
    subject_id  INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL CHECK (kind IN ('node', 'edge')),
    payload     TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'accepted', 'rejected')),
    origin      TEXT NOT NULL DEFAULT '',
    created_at  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY,
    subject_id  INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    node_id     INTEGER REFERENCES nodes(id) ON DELETE CASCADE,
    role        TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content     TEXT NOT NULL,
    created_at  REAL NOT NULL
);
"""


class NotFound(Exception):
    pass


class Conflict(Exception):
    pass


def name_key(name: str) -> str:
    """Normalised key used to stop near-identical duplicate nodes."""
    return " ".join(name.lower().split())


@dataclass
class Node:
    id: int
    subject_id: int
    name: str
    summary: str
    created_at: float
    last_visited_at: float | None
    mastery: dict[str, Any] = field(default_factory=dict)
    last_extracted_message_id: int | None = None


@dataclass
class Edge:
    id: int
    from_id: int
    to_id: int
    kind: str
    reason: str


@dataclass
class Evidence:
    id: int
    node_id: int
    message_id: int
    quote: str


@dataclass
class TrailStep:
    id: int
    node_id: int
    from_node_id: int | None
    at: float


@dataclass
class Proposal:
    id: int
    subject_id: int
    kind: str
    payload: dict[str, Any]
    status: str
    origin: str


@dataclass
class Message:
    id: int
    node_id: int | None
    role: str
    content: str
    created_at: float


EDGE_KINDS = ("prerequisite", "part_of", "related")
DIRECTED_KINDS = ("prerequisite", "part_of")  # cycle-checked


class Store:
    def __init__(self, path: str, clock=time.time):
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA foreign_keys = ON")
        # WAL lets readers proceed while a write is in progress.
        self._db.execute("PRAGMA journal_mode = WAL")
        self._db.executescript(SCHEMA)
        self._lock = threading.RLock()
        self._depth = 0
        self._clock = clock
        self.reset_running_cartographers()

    def close(self):
        self._db.close()

    @property
    def now(self) -> float:
        return self._clock()

    @contextmanager
    def atomic(self):
        """One transaction; nested calls join the outer one."""
        with self._lock:
            if self._depth:
                self._depth += 1
                try:
                    yield
                finally:
                    self._depth -= 1
                return
            self._depth = 1
            try:
                with self._db:
                    yield
            finally:
                self._depth = 0

    # ---------- helpers ----------

    # One connection is shared across threads (requests and background
    # cartographer runs), so every statement goes through the lock.
    def _one(self, sql, args=()):
        with self._lock:
            return self._db.execute(sql, args).fetchone()

    def _all(self, sql, args=()):
        with self._lock:
            return self._db.execute(sql, args).fetchall()

    @staticmethod
    def _node(row) -> Node:
        return Node(
            id=row["id"],
            subject_id=row["subject_id"],
            name=row["name"],
            summary=row["summary"],
            created_at=row["created_at"],
            last_visited_at=row["last_visited_at"],
            mastery=json.loads(row["mastery"]),
            last_extracted_message_id=row["last_extracted_message_id"],
        )

    @staticmethod
    def _edge(row) -> Edge:
        return Edge(row["id"], row["from_id"], row["to_id"], row["kind"], row["reason"])

    # ---------- subjects ----------

    def create_subject(self, visitor: str, title: str, goal: str = "") -> dict:
        """Create a subject and its origin node (named after the title)."""
        title = title.strip()
        if not title:
            raise ValueError("Subject title cannot be empty.")
        with self.atomic():
            cur = self._db.execute(
                "INSERT INTO subjects (visitor, title, goal, created_at) VALUES (?, ?, ?, ?)",
                (visitor, title, goal.strip(), self._clock()),
            )
            origin = self.insert_node(cur.lastrowid, title, goal.strip())
            self._db.execute(
                "UPDATE subjects SET origin_node_id = ? WHERE id = ?", (origin.id, cur.lastrowid)
            )
        return self.get_subject(visitor, cur.lastrowid)

    def list_subjects(self, visitor: str) -> list[dict]:
        rows = self._all(
            "SELECT * FROM subjects WHERE visitor = ? ORDER BY created_at DESC", (visitor,)
        )
        return [dict(r) for r in rows]

    def get_subject(self, visitor: str, subject_id: int) -> dict:
        row = self._one(
            "SELECT * FROM subjects WHERE id = ? AND visitor = ?", (subject_id, visitor)
        )
        if row is None:
            raise NotFound(f"Subject {subject_id} not found.")
        return dict(row)

    # ---------- graph version and cartographer state ----------

    def reset_running_cartographers(self):
        """After a restart no run can still be in progress."""
        with self.atomic():
            self._db.execute(
                "UPDATE subjects SET cartographer_state = 'idle' "
                "WHERE cartographer_state = 'running'"
            )

    def bump_graph_version(self, subject_id: int):
        with self.atomic():
            self._db.execute(
                "UPDATE subjects SET graph_version = graph_version + 1 WHERE id = ?",
                (subject_id,),
            )

    def set_cartographer_state(self, subject_id: int, state: str, error: str | None = None):
        with self.atomic():
            self._db.execute(
                "UPDATE subjects SET cartographer_state = ?, cartographer_error = ? WHERE id = ?",
                (state, error, subject_id),
            )

    def graph_status(self, subject_id: int) -> dict:
        row = self._one(
            """SELECT graph_version, cartographer_state, cartographer_error
               FROM subjects WHERE id = ?""",
            (subject_id,),
        )
        return {
            "graph_version": row["graph_version"],
            "cartographer": row["cartographer_state"],
            "error": row["cartographer_error"],
        }

    def subject_by_id(self, subject_id: int) -> dict:
        """Internal lookup without visitor scoping (background runs only)."""
        row = self._one("SELECT * FROM subjects WHERE id = ?", (subject_id,))
        if row is None:
            raise NotFound(f"Subject {subject_id} not found.")
        return dict(row)

    # ---------- nodes ----------

    def get_node(self, visitor: str, node_id: int) -> Node:
        row = self._one(
            """SELECT n.* FROM nodes n JOIN subjects s ON s.id = n.subject_id
               WHERE n.id = ? AND s.visitor = ?""",
            (node_id, visitor),
        )
        if row is None:
            raise NotFound(f"Node {node_id} not found.")
        return self._node(row)

    def list_nodes(self, subject_id: int) -> list[Node]:
        rows = self._all("SELECT * FROM nodes WHERE subject_id = ? ORDER BY id", (subject_id,))
        return [self._node(r) for r in rows]

    def find_node_by_name(self, subject_id: int, name: str) -> Node | None:
        row = self._one(
            "SELECT * FROM nodes WHERE subject_id = ? AND name_key = ?",
            (subject_id, name_key(name)),
        )
        return self._node(row) if row else None

    def node_by_id(self, node_id: int) -> Node:
        row = self._one("SELECT * FROM nodes WHERE id = ?", (node_id,))
        if row is None:
            raise NotFound(f"Node {node_id} not found.")
        return self._node(row)

    def insert_node(self, subject_id: int, name: str, summary: str) -> Node:
        name = name.strip()
        if not name:
            raise ValueError("Node name cannot be empty.")
        with self.atomic():
            if self.find_node_by_name(subject_id, name):
                raise Conflict(f"A node named '{name}' already exists.")
            cur = self._db.execute(
                """INSERT INTO nodes (subject_id, name, name_key, summary, created_at)
                   VALUES (?, ?, ?, ?, ?)""",
                (subject_id, name, name_key(name), summary.strip(), self._clock()),
            )
        return self.node_by_id(cur.lastrowid)

    def set_last_extracted(self, node_id: int, message_id: int):
        with self.atomic():
            self._db.execute(
                "UPDATE nodes SET last_extracted_message_id = ? WHERE id = ?",
                (message_id, node_id),
            )

    def mark_visited(self, node_id: int):
        with self.atomic():
            self._db.execute(
                "UPDATE nodes SET last_visited_at = ? WHERE id = ?", (self._clock(), node_id)
            )

    def set_mastery(self, node_id: int, mastery: dict):
        with self.atomic():
            self._db.execute(
                "UPDATE nodes SET mastery = ? WHERE id = ?", (json.dumps(mastery), node_id)
            )

    # ---------- edges ----------

    def list_edges(self, subject_id: int) -> list[Edge]:
        rows = self._all("SELECT * FROM edges WHERE subject_id = ? ORDER BY id", (subject_id,))
        return [self._edge(r) for r in rows]

    def prerequisites(self, node_id: int) -> list[Node]:
        rows = self._all(
            """SELECT n.* FROM edges e JOIN nodes n ON n.id = e.from_id
               WHERE e.to_id = ? AND e.kind = 'prerequisite' ORDER BY n.id""",
            (node_id,),
        )
        return [self._node(r) for r in rows]

    def dependents(self, node_id: int) -> list[Node]:
        rows = self._all(
            """SELECT n.* FROM edges e JOIN nodes n ON n.id = e.to_id
               WHERE e.from_id = ? AND e.kind = 'prerequisite' ORDER BY n.id""",
            (node_id,),
        )
        return [self._node(r) for r in rows]

    def neighbours(self, node_id: int) -> list[tuple[Node, Edge]]:
        """Every node joined to this one by any edge, either direction."""
        rows = self._all(
            """SELECT * FROM edges WHERE from_id = ? OR to_id = ? ORDER BY id""",
            (node_id, node_id),
        )
        out = []
        for r in rows:
            edge = self._edge(r)
            other = edge.to_id if edge.from_id == node_id else edge.from_id
            out.append((self.node_by_id(other), edge))
        return out

    def part_of_parent(self, node_id: int) -> Node | None:
        row = self._one(
            """SELECT n.* FROM edges e JOIN nodes n ON n.id = e.to_id
               WHERE e.from_id = ? AND e.kind = 'part_of'""",
            (node_id,),
        )
        return self._node(row) if row else None

    def parts(self, node_id: int) -> list[Node]:
        rows = self._all(
            """SELECT n.* FROM edges e JOIN nodes n ON n.id = e.from_id
               WHERE e.to_id = ? AND e.kind = 'part_of' ORDER BY n.id""",
            (node_id,),
        )
        return [self._node(r) for r in rows]

    def _would_create_cycle(self, kind: str, from_id: int, to_id: int) -> bool:
        """Adding from -> to of `kind` makes a cycle if `to` already reaches `from`
        along edges of the same kind. Each directed kind is checked on its own."""
        return from_id == to_id or from_id in self._forward_ids(to_id, kind)

    def edge_exists(self, from_id: int, to_id: int, kind: str) -> bool:
        if kind == "related":  # undirected for duplicate purposes
            row = self._one(
                """SELECT id FROM edges WHERE kind = 'related' AND
                   ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?))""",
                (from_id, to_id, to_id, from_id),
            )
        else:
            row = self._one(
                "SELECT id FROM edges WHERE from_id = ? AND to_id = ? AND kind = ?",
                (from_id, to_id, kind),
            )
        return row is not None

    def insert_edge(
        self, subject_id: int, from_id: int, to_id: int, kind: str, reason: str
    ) -> Edge:
        """Raises Conflict (with a short reason) for self-links, cycles,
        duplicates and a second part_of parent."""
        if kind not in EDGE_KINDS:
            raise ValueError(f"Unknown edge kind: {kind}")
        if from_id == to_id:
            raise Conflict("self-link")
        with self.atomic():
            if kind in DIRECTED_KINDS and self._would_create_cycle(kind, from_id, to_id):
                raise Conflict(f"{kind} cycle")
            if self.edge_exists(from_id, to_id, kind):
                raise Conflict("duplicate")
            if kind == "part_of" and self.part_of_parent(from_id) is not None:
                raise Conflict("second part_of parent")
            cur = self._db.execute(
                """INSERT INTO edges (subject_id, from_id, to_id, kind, reason)
                   VALUES (?, ?, ?, ?, ?)""",
                (subject_id, from_id, to_id, kind, reason.strip()),
            )
        return Edge(cur.lastrowid, from_id, to_id, kind, reason.strip())

    # ---------- traversal ----------
    # The graph is an adjacency list (nodes + edges). Directed walks use
    # recursive CTEs; the undirected shortest path uses BFS in Python.

    def _forward_ids(self, node_id: int, kind: str) -> set[int]:
        """Nodes reached from node_id by following `kind` edges along the arrow."""
        rows = self._all(
            """WITH RECURSIVE walk(id) AS (
                   SELECT to_id FROM edges WHERE from_id = ? AND kind = ?
                   UNION
                   SELECT e.to_id FROM edges e JOIN walk w ON e.from_id = w.id
                   WHERE e.kind = ?
               ) SELECT id FROM walk""",
            (node_id, kind, kind),
        )
        return {r["id"] for r in rows}

    def _backward_ids(self, node_id: int, kind: str) -> set[int]:
        """Nodes that reach node_id by following `kind` edges along the arrow."""
        rows = self._all(
            """WITH RECURSIVE walk(id) AS (
                   SELECT from_id FROM edges WHERE to_id = ? AND kind = ?
                   UNION
                   SELECT e.from_id FROM edges e JOIN walk w ON e.to_id = w.id
                   WHERE e.kind = ?
               ) SELECT id FROM walk""",
            (node_id, kind, kind),
        )
        return {r["id"] for r in rows}

    def _nodes(self, ids: set[int]) -> list[Node]:
        return [self.node_by_id(i) for i in sorted(ids)]

    def ancestors(self, node_id: int, kind: str) -> list[Node]:
        """`prerequisite`: everything that must come before this node.
        `part_of`: every whole this node is (transitively) part of."""
        if kind == "prerequisite":
            return self._nodes(self._backward_ids(node_id, kind))
        if kind == "part_of":
            return self._nodes(self._forward_ids(node_id, kind))
        raise ValueError("ancestors() needs a directed kind: prerequisite or part_of")

    def descendants(self, node_id: int, kind: str) -> list[Node]:
        """`prerequisite`: everything that builds on this node.
        `part_of`: every (transitive) part of this node."""
        if kind == "prerequisite":
            return self._nodes(self._forward_ids(node_id, kind))
        if kind == "part_of":
            return self._nodes(self._backward_ids(node_id, kind))
        raise ValueError("descendants() needs a directed kind: prerequisite or part_of")

    def part_of_root(self, node_id: int) -> Node:
        """The top-most whole this node belongs to (itself if it has no parent)."""
        current = self.node_by_id(node_id)
        seen = {current.id}
        while (parent := self.part_of_parent(current.id)) is not None and parent.id not in seen:
            seen.add(parent.id)
            current = parent
        return current

    def path(self, a: int, b: int) -> list[int] | None:
        """Shortest node-id path from a to b over all edges, ignoring direction
        and kind; None if they are not connected."""
        subject_id = self.node_by_id(a).subject_id
        adjacent: dict[int, set[int]] = {}
        for e in self.list_edges(subject_id):
            adjacent.setdefault(e.from_id, set()).add(e.to_id)
            adjacent.setdefault(e.to_id, set()).add(e.from_id)
        previous: dict[int, int | None] = {a: None}
        queue = deque([a])
        while queue:
            current = queue.popleft()
            if current == b:
                out = []
                step: int | None = b
                while step is not None:
                    out.append(step)
                    step = previous[step]
                return out[::-1]
            for nxt in sorted(adjacent.get(current, ())):
                if nxt not in previous:
                    previous[nxt] = current
                    queue.append(nxt)
        return None

    # ---------- evidence, trail, cartographer log ----------

    def add_evidence(self, node_id: int, message_id: int, quote: str) -> Evidence:
        with self.atomic():
            cur = self._db.execute(
                "INSERT INTO node_evidence (node_id, message_id, quote) VALUES (?, ?, ?)",
                (node_id, message_id, quote),
            )
        return Evidence(cur.lastrowid, node_id, message_id, quote)

    def list_evidence(self, node_id: int) -> list[Evidence]:
        rows = self._all("SELECT * FROM node_evidence WHERE node_id = ? ORDER BY id", (node_id,))
        return [Evidence(r["id"], r["node_id"], r["message_id"], r["quote"]) for r in rows]

    def last_trail_step(self, subject_id: int) -> TrailStep | None:
        row = self._one(
            "SELECT * FROM trail WHERE subject_id = ? ORDER BY id DESC LIMIT 1", (subject_id,)
        )
        return TrailStep(row["id"], row["node_id"], row["from_node_id"], row["at"]) if row else None

    def add_trail_step(self, subject_id: int, node_id: int, from_node_id: int | None) -> TrailStep:
        with self.atomic():
            at = self._clock()
            cur = self._db.execute(
                "INSERT INTO trail (subject_id, node_id, from_node_id, at) VALUES (?, ?, ?, ?)",
                (subject_id, node_id, from_node_id, at),
            )
        return TrailStep(cur.lastrowid, node_id, from_node_id, at)

    def list_trail(self, subject_id: int) -> list[TrailStep]:
        rows = self._all("SELECT * FROM trail WHERE subject_id = ? ORDER BY id", (subject_id,))
        return [TrailStep(r["id"], r["node_id"], r["from_node_id"], r["at"]) for r in rows]

    def log_extraction(
        self, subject_id: int, node_id: int, verified: int, dropped: int, summary: dict
    ):
        with self.atomic():
            self._db.execute(
                """INSERT INTO extractions (subject_id, node_id, at, evidence_verified,
                                            evidence_dropped, summary)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (subject_id, node_id, self._clock(), verified, dropped, json.dumps(summary)),
            )

    def extraction_stats(self, subject_id: int) -> dict[str, int]:
        row = self._one(
            """SELECT COUNT(*) AS runs, COALESCE(SUM(evidence_verified), 0) AS verified,
                      COALESCE(SUM(evidence_dropped), 0) AS dropped
               FROM extractions WHERE subject_id = ?""",
            (subject_id,),
        )
        nodes = self._one("SELECT COUNT(*) AS c FROM nodes WHERE subject_id = ?", (subject_id,))[
            "c"
        ]
        return {
            "runs": row["runs"],
            "nodes": nodes,
            "evidence_verified": row["verified"],
            "evidence_dropped": row["dropped"],
        }

    # ---------- proposals ----------

    def add_proposals(
        self, subject_id: int, items: list[tuple[str, dict]], origin: str
    ) -> list[Proposal]:
        now = self._clock()
        ids = []
        with self.atomic():
            for kind, payload in items:
                cur = self._db.execute(
                    """INSERT INTO proposals (subject_id, kind, payload, origin, created_at)
                       VALUES (?, ?, ?, ?, ?)""",
                    (subject_id, kind, json.dumps(payload), origin, now),
                )
                ids.append(cur.lastrowid)
        return [
            self._proposal(self._one("SELECT * FROM proposals WHERE id = ?", (i,))) for i in ids
        ]

    @staticmethod
    def _proposal(row) -> Proposal:
        return Proposal(
            id=row["id"],
            subject_id=row["subject_id"],
            kind=row["kind"],
            payload=json.loads(row["payload"]),
            status=row["status"],
            origin=row["origin"],
        )

    def list_proposals(self, subject_id: int, status: str = "pending") -> list[Proposal]:
        rows = self._all(
            "SELECT * FROM proposals WHERE subject_id = ? AND status = ? ORDER BY id",
            (subject_id, status),
        )
        return [self._proposal(r) for r in rows]

    def _get_proposal(self, visitor: str, proposal_id: int) -> Proposal:
        row = self._one(
            """SELECT p.* FROM proposals p JOIN subjects s ON s.id = p.subject_id
               WHERE p.id = ? AND s.visitor = ?""",
            (proposal_id, visitor),
        )
        if row is None:
            raise NotFound(f"Proposal {proposal_id} not found.")
        return self._proposal(row)

    def accept_proposal(self, visitor: str, proposal_id: int) -> Proposal:
        """Apply a pending proposal to the graph.

        Edge proposals refer to nodes by name, so both endpoint nodes
        must already exist (accept the node proposals first).
        """
        p = self._get_proposal(visitor, proposal_id)
        if p.status != "pending":
            raise Conflict(f"Proposal {proposal_id} is already {p.status}.")
        with self.atomic():
            if p.kind == "node":
                self.insert_node(p.subject_id, p.payload["name"], p.payload.get("summary", ""))
            else:
                prereq = self.find_node_by_name(p.subject_id, p.payload["prerequisite"])
                node = self.find_node_by_name(p.subject_id, p.payload["concept"])
                missing = [
                    n
                    for n, found in (
                        (p.payload["prerequisite"], prereq),
                        (p.payload["concept"], node),
                    )
                    if found is None
                ]
                if missing:
                    raise Conflict("Accept these concepts first: " + ", ".join(missing))
                self.insert_edge(
                    p.subject_id, prereq.id, node.id, "prerequisite", p.payload.get("reason", "")
                )
            self._db.execute(
                "UPDATE proposals SET status = 'accepted' WHERE id = ?", (proposal_id,)
            )
        return self._get_proposal(visitor, proposal_id)

    def reject_proposal(self, visitor: str, proposal_id: int) -> Proposal:
        p = self._get_proposal(visitor, proposal_id)
        if p.status != "pending":
            raise Conflict(f"Proposal {proposal_id} is already {p.status}.")
        with self.atomic():
            self._db.execute(
                "UPDATE proposals SET status = 'rejected' WHERE id = ?", (proposal_id,)
            )
        return self._get_proposal(visitor, proposal_id)

    def proposal_stats(self, subject_id: int) -> dict[str, int]:
        rows = self._all(
            "SELECT status, COUNT(*) AS c FROM proposals WHERE subject_id = ? GROUP BY status",
            (subject_id,),
        )
        stats = {"pending": 0, "accepted": 0, "rejected": 0}
        stats.update({r["status"]: r["c"] for r in rows})
        return stats

    # ---------- messages ----------

    def add_message(self, subject_id: int, node_id: int | None, role: str, content: str) -> Message:
        with self.atomic():
            cur = self._db.execute(
                """INSERT INTO messages (subject_id, node_id, role, content, created_at)
                   VALUES (?, ?, ?, ?, ?)""",
                (subject_id, node_id, role, content, self._clock()),
            )
        row = self._one("SELECT * FROM messages WHERE id = ?", (cur.lastrowid,))
        return Message(row["id"], row["node_id"], row["role"], row["content"], row["created_at"])

    def recent_messages(self, subject_id: int, node_id: int | None, limit: int) -> list[Message]:
        """Most recent messages for a topic chat (node_id) or the subject chat (None)."""
        if node_id is None:
            rows = self._all(
                """SELECT * FROM messages WHERE subject_id = ? AND node_id IS NULL
                   ORDER BY id DESC LIMIT ?""",
                (subject_id, limit),
            )
        else:
            rows = self._all(
                "SELECT * FROM messages WHERE node_id = ? ORDER BY id DESC LIMIT ?",
                (node_id, limit),
            )
        return [
            Message(r["id"], r["node_id"], r["role"], r["content"], r["created_at"])
            for r in reversed(rows)
        ]

    def node_messages(
        self,
        node_id: int,
        after_id: int | None = None,
        before_id: int | None = None,
        limit: int | None = None,
    ) -> list[Message]:
        """Messages of one topic chat in id order, optionally after/before an id.
        With `limit`, keeps the last `limit` of the matching messages."""
        sql, args = "SELECT * FROM messages WHERE node_id = ?", [node_id]
        if after_id is not None:
            sql += " AND id > ?"
            args.append(after_id)
        if before_id is not None:
            sql += " AND id < ?"
            args.append(before_id)
        sql += " ORDER BY id DESC"
        if limit is not None:
            sql += " LIMIT ?"
            args.append(limit)
        rows = self._all(sql, args)
        return [
            Message(r["id"], r["node_id"], r["role"], r["content"], r["created_at"])
            for r in reversed(rows)
        ]
