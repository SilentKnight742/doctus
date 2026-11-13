"""SQLite storage for subjects, concept nodes, prerequisite edges,
graph-change proposals and chat messages.

Every subject belongs to one anonymous visitor token, and every read
or write goes through a subject the visitor owns.
"""

import json
import sqlite3
import threading
import time
from dataclasses import dataclass, field
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS subjects (
    id          INTEGER PRIMARY KEY,
    visitor     TEXT NOT NULL,
    title       TEXT NOT NULL,
    goal        TEXT NOT NULL DEFAULT '',
    created_at  REAL NOT NULL
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
    UNIQUE (subject_id, name_key)
);

-- prereq_id must be understood before node_id
CREATE TABLE IF NOT EXISTS edges (
    id          INTEGER PRIMARY KEY,
    subject_id  INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    prereq_id   INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    node_id     INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    reason      TEXT NOT NULL DEFAULT '',
    UNIQUE (prereq_id, node_id)
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


@dataclass
class Edge:
    id: int
    prereq_id: int
    node_id: int
    reason: str


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


class Store:
    def __init__(self, path: str, clock=time.time):
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA foreign_keys = ON")
        self._db.executescript(SCHEMA)
        self._lock = threading.Lock()
        self._clock = clock

    def close(self):
        self._db.close()

    # ---------- helpers ----------

    def _one(self, sql, args=()):
        return self._db.execute(sql, args).fetchone()

    def _all(self, sql, args=()):
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
        )

    # ---------- subjects ----------

    def create_subject(self, visitor: str, title: str, goal: str = "") -> dict:
        title = title.strip()
        if not title:
            raise ValueError("Subject title cannot be empty.")
        with self._lock, self._db:
            cur = self._db.execute(
                "INSERT INTO subjects (visitor, title, goal, created_at) VALUES (?, ?, ?, ?)",
                (visitor, title, goal.strip(), self._clock()),
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
        rows = self._all(
            "SELECT * FROM nodes WHERE subject_id = ? ORDER BY id", (subject_id,)
        )
        return [self._node(r) for r in rows]

    def find_node_by_name(self, subject_id: int, name: str) -> Node | None:
        row = self._one(
            "SELECT * FROM nodes WHERE subject_id = ? AND name_key = ?",
            (subject_id, name_key(name)),
        )
        return self._node(row) if row else None

    def _insert_node(self, subject_id: int, name: str, summary: str) -> Node:
        name = name.strip()
        if not name:
            raise ValueError("Node name cannot be empty.")
        if self.find_node_by_name(subject_id, name):
            raise Conflict(f"A node named '{name}' already exists.")
        cur = self._db.execute(
            """INSERT INTO nodes (subject_id, name, name_key, summary, created_at)
               VALUES (?, ?, ?, ?, ?)""",
            (subject_id, name, name_key(name), summary.strip(), self._clock()),
        )
        return self._node(self._one("SELECT * FROM nodes WHERE id = ?", (cur.lastrowid,)))

    def mark_visited(self, node_id: int):
        with self._lock, self._db:
            self._db.execute(
                "UPDATE nodes SET last_visited_at = ? WHERE id = ?", (self._clock(), node_id)
            )

    def set_mastery(self, node_id: int, mastery: dict):
        with self._lock, self._db:
            self._db.execute(
                "UPDATE nodes SET mastery = ? WHERE id = ?", (json.dumps(mastery), node_id)
            )

    # ---------- edges ----------

    def list_edges(self, subject_id: int) -> list[Edge]:
        rows = self._all(
            "SELECT * FROM edges WHERE subject_id = ? ORDER BY id", (subject_id,)
        )
        return [Edge(r["id"], r["prereq_id"], r["node_id"], r["reason"]) for r in rows]

    def prerequisites(self, node_id: int) -> list[Node]:
        rows = self._all(
            """SELECT n.* FROM edges e JOIN nodes n ON n.id = e.prereq_id
               WHERE e.node_id = ? ORDER BY n.id""",
            (node_id,),
        )
        return [self._node(r) for r in rows]

    def dependents(self, node_id: int) -> list[Node]:
        rows = self._all(
            """SELECT n.* FROM edges e JOIN nodes n ON n.id = e.node_id
               WHERE e.prereq_id = ? ORDER BY n.id""",
            (node_id,),
        )
        return [self._node(r) for r in rows]

    def _would_create_cycle(self, subject_id: int, prereq_id: int, node_id: int) -> bool:
        """Adding prereq -> node makes a cycle if node already leads to prereq."""
        if prereq_id == node_id:
            return True
        children: dict[int, list[int]] = {}
        for e in self.list_edges(subject_id):
            children.setdefault(e.prereq_id, []).append(e.node_id)
        stack, seen = [node_id], set()
        while stack:
            current = stack.pop()
            if current == prereq_id:
                return True
            if current in seen:
                continue
            seen.add(current)
            stack.extend(children.get(current, []))
        return False

    def _insert_edge(self, subject_id: int, prereq_id: int, node_id: int, reason: str) -> Edge:
        if self._would_create_cycle(subject_id, prereq_id, node_id):
            raise Conflict("That prerequisite link would create a cycle.")
        exists = self._one(
            "SELECT id FROM edges WHERE prereq_id = ? AND node_id = ?", (prereq_id, node_id)
        )
        if exists:
            raise Conflict("That prerequisite link already exists.")
        cur = self._db.execute(
            "INSERT INTO edges (subject_id, prereq_id, node_id, reason) VALUES (?, ?, ?, ?)",
            (subject_id, prereq_id, node_id, reason.strip()),
        )
        return Edge(cur.lastrowid, prereq_id, node_id, reason.strip())

    # ---------- proposals ----------

    def add_proposals(self, subject_id: int, items: list[tuple[str, dict]], origin: str) -> list[Proposal]:
        now = self._clock()
        ids = []
        with self._lock, self._db:
            for kind, payload in items:
                cur = self._db.execute(
                    """INSERT INTO proposals (subject_id, kind, payload, origin, created_at)
                       VALUES (?, ?, ?, ?, ?)""",
                    (subject_id, kind, json.dumps(payload), origin, now),
                )
                ids.append(cur.lastrowid)
        return [self._proposal(self._one("SELECT * FROM proposals WHERE id = ?", (i,))) for i in ids]

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
        with self._lock, self._db:
            if p.kind == "node":
                self._insert_node(p.subject_id, p.payload["name"], p.payload.get("summary", ""))
            else:
                prereq = self.find_node_by_name(p.subject_id, p.payload["prerequisite"])
                node = self.find_node_by_name(p.subject_id, p.payload["concept"])
                missing = [
                    n for n, found in (
                        (p.payload["prerequisite"], prereq),
                        (p.payload["concept"], node),
                    ) if found is None
                ]
                if missing:
                    raise Conflict(
                        "Accept these concepts first: " + ", ".join(missing)
                    )
                self._insert_edge(p.subject_id, prereq.id, node.id, p.payload.get("reason", ""))
            self._db.execute(
                "UPDATE proposals SET status = 'accepted' WHERE id = ?", (proposal_id,)
            )
        return self._get_proposal(visitor, proposal_id)

    def reject_proposal(self, visitor: str, proposal_id: int) -> Proposal:
        p = self._get_proposal(visitor, proposal_id)
        if p.status != "pending":
            raise Conflict(f"Proposal {proposal_id} is already {p.status}.")
        with self._lock, self._db:
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
        with self._lock, self._db:
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
