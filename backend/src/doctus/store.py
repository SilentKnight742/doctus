"""SQLite storage for subjects, concept nodes, edges, evidence, the
learner's trail, graph-change proposals and chat messages.

Every subject belongs to one anonymous visitor token, and every read
or write goes through a subject the visitor owns.
"""

import json
import sqlite3
import threading
import time
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
    origin_node_id INTEGER
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
    status          TEXT NOT NULL DEFAULT 'frontier'
                    CHECK (status IN ('covered', 'frontier', 'dismissed')),
    covered_at      REAL,
    last_extracted_message_id INTEGER,
    UNIQUE (subject_id, name_key)
);

-- kind 'prerequisite': from_id must be understood before to_id.
-- kind 'related': adjacent concepts; direction carries no meaning.
CREATE TABLE IF NOT EXISTS edges (
    id          INTEGER PRIMARY KEY,
    subject_id  INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    from_id     INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    to_id       INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL DEFAULT 'prerequisite'
                CHECK (kind IN ('prerequisite', 'related')),
    reason      TEXT NOT NULL DEFAULT '',
    UNIQUE (from_id, to_id, kind)
);

-- A verbatim quote from a chat message showing a concept was covered.
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

-- One row per extraction run, for stats and auditing.
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
    status: str = "frontier"
    covered_at: float | None = None
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


class Store:
    def __init__(self, path: str, clock=time.time):
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA foreign_keys = ON")
        self._db.executescript(SCHEMA)
        self._lock = threading.RLock()
        self._depth = 0
        self._clock = clock

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
            status=row["status"],
            covered_at=row["covered_at"],
            last_extracted_message_id=row["last_extracted_message_id"],
        )

    @staticmethod
    def _edge(row) -> Edge:
        return Edge(row["id"], row["from_id"], row["to_id"], row["kind"], row["reason"])

    # ---------- subjects ----------

    def create_subject(self, visitor: str, title: str, goal: str = "") -> dict:
        """Create a subject and its origin node (named after the title,
        `frontier` until the learner covers it)."""
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

    def insert_node(
        self, subject_id: int, name: str, summary: str, status: str = "frontier"
    ) -> Node:
        name = name.strip()
        if not name:
            raise ValueError("Node name cannot be empty.")
        with self.atomic():
            if self.find_node_by_name(subject_id, name):
                raise Conflict(f"A node named '{name}' already exists.")
            now = self._clock()
            cur = self._db.execute(
                """INSERT INTO nodes (subject_id, name, name_key, summary, created_at,
                                      status, covered_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (
                    subject_id,
                    name,
                    name_key(name),
                    summary.strip(),
                    now,
                    status,
                    now if status == "covered" else None,
                ),
            )
        return self.node_by_id(cur.lastrowid)

    def mark_covered(self, node_id: int):
        """Set a node to `covered` (from frontier or dismissed). Idempotent."""
        with self.atomic():
            self._db.execute(
                """UPDATE nodes SET status = 'covered', covered_at = ?
                   WHERE id = ? AND status != 'covered'""",
                (self._clock(), node_id),
            )

    def dismiss_node(self, visitor: str, node_id: int) -> Node:
        """Dismiss a frontier suggestion. Covered nodes and the origin stay."""
        node = self.get_node(visitor, node_id)
        subject = self.get_subject(visitor, node.subject_id)
        if subject["origin_node_id"] == node.id:
            raise Conflict("The origin node cannot be dismissed.")
        if node.status == "covered":
            raise Conflict("Covered nodes cannot be dismissed.")
        with self.atomic():
            self._db.execute("UPDATE nodes SET status = 'dismissed' WHERE id = ?", (node_id,))
        return self.node_by_id(node_id)

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

    def _would_create_cycle(self, subject_id: int, from_id: int, to_id: int) -> bool:
        """Adding prerequisite from -> to makes a cycle if `to` already leads to `from`.
        Only prerequisite edges count; related edges never form cycles."""
        if from_id == to_id:
            return True
        children: dict[int, list[int]] = {}
        for e in self.list_edges(subject_id):
            if e.kind == "prerequisite":
                children.setdefault(e.from_id, []).append(e.to_id)
        stack, seen = [to_id], set()
        while stack:
            current = stack.pop()
            if current == from_id:
                return True
            if current in seen:
                continue
            seen.add(current)
            stack.extend(children.get(current, []))
        return False

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
        if kind not in ("prerequisite", "related"):
            raise ValueError(f"Unknown edge kind: {kind}")
        if from_id == to_id:
            raise Conflict("A concept cannot link to itself (that would be a cycle).")
        with self.atomic():
            if kind == "prerequisite" and self._would_create_cycle(subject_id, from_id, to_id):
                raise Conflict("That prerequisite link would create a cycle.")
            if self.edge_exists(from_id, to_id, kind):
                raise Conflict(f"That {kind} link already exists.")
            cur = self._db.execute(
                """INSERT INTO edges (subject_id, from_id, to_id, kind, reason)
                   VALUES (?, ?, ?, ?, ?)""",
                (subject_id, from_id, to_id, kind, reason.strip()),
            )
        return Edge(cur.lastrowid, from_id, to_id, kind, reason.strip())

    # ---------- evidence, trail, extraction log ----------

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
        covered = self._one(
            "SELECT COUNT(*) AS c FROM nodes WHERE subject_id = ? AND status = 'covered'",
            (subject_id,),
        )["c"]
        return {
            "runs": row["runs"],
            "covered_nodes": covered,
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
