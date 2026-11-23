"""SQLite storage for subjects, the branch canvas, concepts, edges, evidence,
the learner's trail, graph-change proposals and chat messages.

Two kinds of "node" live here:
  * canvas nodes (`canvas_nodes`): the branching tree the learner grows,
    `chat` nodes holding a conversation and `note` nodes holding text;
  * concepts (the `nodes` table, kept under its old name): evidence-backed
    ideas the cartographer found taught, each homed in the canvas node where
    it was first taught.

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

# Schema version 1: the branch canvas (M3). Applied to new and existing
# databases alike; existing subjects get one root chat node holding all of
# their messages (M1/M2 per-concept chats are merged into it, in id order).
MIGRATION_1 = """
CREATE TABLE canvas_nodes (
    id          INTEGER PRIMARY KEY,
    subject_id  INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    parent_id   INTEGER REFERENCES canvas_nodes(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL CHECK (kind IN ('chat', 'note')),
    sort_index  INTEGER NOT NULL DEFAULT 0,
    title       TEXT NOT NULL DEFAULT '',
    keyword     TEXT NOT NULL DEFAULT '',
    note_body   TEXT NOT NULL DEFAULT '',
    created_at  REAL NOT NULL,
    last_extracted_message_id INTEGER
);
CREATE UNIQUE INDEX canvas_one_root ON canvas_nodes (subject_id) WHERE parent_id IS NULL;
CREATE INDEX canvas_parent ON canvas_nodes (parent_id);

-- Follow-up questions the cartographer offered under a chat node.
CREATE TABLE suggestions (
    id             INTEGER PRIMARY KEY,
    subject_id     INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    canvas_node_id INTEGER NOT NULL REFERENCES canvas_nodes(id) ON DELETE CASCADE,
    text           TEXT NOT NULL,
    created_at     REAL NOT NULL
);

ALTER TABLE messages ADD COLUMN canvas_node_id INTEGER
    REFERENCES canvas_nodes(id) ON DELETE CASCADE;
ALTER TABLE messages ADD COLUMN stopped INTEGER NOT NULL DEFAULT 0;
CREATE INDEX messages_canvas ON messages (canvas_node_id);
ALTER TABLE nodes ADD COLUMN home_canvas_node_id INTEGER
    REFERENCES canvas_nodes(id) ON DELETE SET NULL;
ALTER TABLE subjects ADD COLUMN root_canvas_node_id INTEGER;

-- Cartographer runs are now per canvas node, and node_id (a concept) is legacy.
ALTER TABLE extractions RENAME TO extractions_m1;
CREATE TABLE extractions (
    id                INTEGER PRIMARY KEY,
    subject_id        INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    node_id           INTEGER REFERENCES nodes(id) ON DELETE CASCADE,
    canvas_node_id    INTEGER REFERENCES canvas_nodes(id) ON DELETE SET NULL,
    at                REAL NOT NULL,
    evidence_verified INTEGER NOT NULL,
    evidence_dropped  INTEGER NOT NULL,
    summary           TEXT NOT NULL
);
INSERT INTO extractions (id, subject_id, node_id, at, evidence_verified,
                         evidence_dropped, summary)
    SELECT id, subject_id, node_id, at, evidence_verified, evidence_dropped, summary
    FROM extractions_m1;
DROP TABLE extractions_m1;
"""

CANVAS_KINDS = ("chat", "note")
TITLE_MAX = 60
KEYWORD_MAX = 24


def note_title(body: str) -> str:
    """A note's title: its first non-empty line without Markdown heading marks."""
    for line in body.splitlines():
        line = line.strip().lstrip("#").strip()
        if line:
            return clean_title(line)
    return ""


def clean_title(text: str) -> str:
    text = " ".join(text.split())
    if len(text) > TITLE_MAX:
        text = text[: TITLE_MAX - 1].rstrip() + "…"
    return text


def clean_keyword(text: str) -> str:
    """One word: the first token, without surrounding punctuation."""
    for token in text.split():
        token = token.strip(".,;:!?\"'()[]{}*_`")
        if token:
            return token[:KEYWORD_MAX]
    return ""


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
    home_canvas_node_id: int | None = None


@dataclass
class CanvasNode:
    id: int
    subject_id: int
    parent_id: int | None
    kind: str
    sort_index: int
    title: str
    keyword: str
    note_body: str
    created_at: float
    last_extracted_message_id: int | None = None


@dataclass
class Suggestion:
    id: int
    canvas_node_id: int
    text: str


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
    canvas_node_id: int | None = None
    stopped: bool = False  # a reply the learner stopped (kept as written)


def _message(row) -> Message:
    return Message(
        row["id"],
        row["node_id"],
        row["role"],
        row["content"],
        row["created_at"],
        row["canvas_node_id"],
        bool(row["stopped"]),
    )


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
        self._migrate(path)
        self.reset_running_cartographers()

    def close(self):
        self._db.close()

    def _migrate(self, path: str):
        version = self._db.execute("PRAGMA user_version").fetchone()[0]
        if version >= 1:
            return
        has_data = self._db.execute("SELECT COUNT(*) FROM subjects").fetchone()[0] > 0
        if has_data and path != ":memory:":
            # Keep a copy of the pre-canvas database (dev data, but cheap insurance).
            backup = sqlite3.connect(path + ".pre-m3")
            with backup:
                self._db.backup(backup)
            backup.close()
        # One transaction: a failure part-way leaves the database at version 0.
        # (executescript would commit each step, so statements run one by one.)
        with self._db:
            for statement in MIGRATION_1.split(";"):
                if statement.strip():
                    self._db.execute(statement)
            for s in self._db.execute("SELECT id FROM subjects").fetchall():
                sid = s["id"]
                last = self._db.execute(
                    "SELECT MAX(id) FROM messages WHERE subject_id = ?", (sid,)
                ).fetchone()[0]
                cur = self._db.execute(
                    """INSERT INTO canvas_nodes (subject_id, parent_id, kind, sort_index,
                                                 created_at, last_extracted_message_id)
                       VALUES (?, NULL, 'chat', 0, ?, ?)""",
                    (sid, self._clock(), last),
                )
                root = cur.lastrowid
                self._db.execute(
                    "UPDATE subjects SET root_canvas_node_id = ? WHERE id = ?", (root, sid)
                )
                self._db.execute(
                    "UPDATE messages SET canvas_node_id = ? WHERE subject_id = ?", (root, sid)
                )
                self._db.execute(
                    "UPDATE nodes SET home_canvas_node_id = ? WHERE subject_id = ?", (root, sid)
                )
            self._db.execute("PRAGMA user_version = 1")

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
            home_canvas_node_id=row["home_canvas_node_id"],
        )

    @staticmethod
    def _canvas(row) -> CanvasNode:
        return CanvasNode(
            id=row["id"],
            subject_id=row["subject_id"],
            parent_id=row["parent_id"],
            kind=row["kind"],
            sort_index=row["sort_index"],
            title=row["title"],
            keyword=row["keyword"],
            note_body=row["note_body"],
            created_at=row["created_at"],
            last_extracted_message_id=row["last_extracted_message_id"],
        )

    @staticmethod
    def _edge(row) -> Edge:
        return Edge(row["id"], row["from_id"], row["to_id"], row["kind"], row["reason"])

    # ---------- subjects ----------

    def create_subject(
        self, visitor: str, title: str, goal: str = "", first_question: str = ""
    ) -> dict:
        """Create a subject and its root chat node. With `first_question`, the
        root starts with that question, waiting for the tutor's answer."""
        title = title.strip()
        if not title:
            raise ValueError("Subject title cannot be empty.")
        with self.atomic():
            cur = self._db.execute(
                "INSERT INTO subjects (visitor, title, goal, created_at) VALUES (?, ?, ?, ?)",
                (visitor, title, goal.strip(), self._clock()),
            )
            sid = cur.lastrowid
            root = self._insert_canvas(sid, None, "chat", 0, "")
            self._db.execute(
                "UPDATE subjects SET root_canvas_node_id = ? WHERE id = ?", (root, sid)
            )
            if first_question.strip():
                self.add_canvas_message(root, "user", first_question.strip())
        return self.get_subject(visitor, sid)

    def rename_subject(self, visitor: str, subject_id: int, title: str) -> dict:
        title = title.strip()
        if not title:
            raise ValueError("Subject title cannot be empty.")
        self.get_subject(visitor, subject_id)
        with self.atomic():
            self._db.execute("UPDATE subjects SET title = ? WHERE id = ?", (title, subject_id))
            self.bump_graph_version(subject_id)
        return self.get_subject(visitor, subject_id)

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

    def insert_node(
        self, subject_id: int, name: str, summary: str, home_canvas_node_id: int | None = None
    ) -> Node:
        name = name.strip()
        if not name:
            raise ValueError("Node name cannot be empty.")
        with self.atomic():
            if self.find_node_by_name(subject_id, name):
                raise Conflict(f"A node named '{name}' already exists.")
            cur = self._db.execute(
                """INSERT INTO nodes (subject_id, name, name_key, summary, created_at,
                                      home_canvas_node_id)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (
                    subject_id,
                    name,
                    name_key(name),
                    summary.strip(),
                    self._clock(),
                    home_canvas_node_id,
                ),
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
        self,
        subject_id: int,
        canvas_node_id: int | None,
        verified: int,
        dropped: int,
        summary: dict,
    ):
        with self.atomic():
            self._db.execute(
                """INSERT INTO extractions (subject_id, canvas_node_id, at, evidence_verified,
                                            evidence_dropped, summary)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (subject_id, canvas_node_id, self._clock(), verified, dropped, json.dumps(summary)),
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
        """M1/M2 concept-keyed chat message (kept for the old trail/graph tests)."""
        with self.atomic():
            cur = self._db.execute(
                """INSERT INTO messages (subject_id, node_id, role, content, created_at)
                   VALUES (?, ?, ?, ?, ?)""",
                (subject_id, node_id, role, content, self._clock()),
            )
        return self.message_by_id(cur.lastrowid)

    def message_by_id(self, message_id: int) -> Message:
        row = self._one("SELECT * FROM messages WHERE id = ?", (message_id,))
        if row is None:
            raise NotFound(f"Message {message_id} not found.")
        return _message(row)

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
        return [_message(r) for r in reversed(rows)]

    def node_messages(
        self,
        node_id: int,
        after_id: int | None = None,
        before_id: int | None = None,
        limit: int | None = None,
    ) -> list[Message]:
        """Messages of one M1/M2 topic chat in id order."""
        return self._messages_where("node_id", node_id, after_id, before_id, limit)

    def canvas_messages(
        self,
        canvas_node_id: int,
        after_id: int | None = None,
        before_id: int | None = None,
        limit: int | None = None,
    ) -> list[Message]:
        """Messages of one chat node in id order, optionally after/before an id.
        With `limit`, keeps the last `limit` of the matching messages."""
        return self._messages_where("canvas_node_id", canvas_node_id, after_id, before_id, limit)

    def _messages_where(self, column, value, after_id, before_id, limit) -> list[Message]:
        sql, args = f"SELECT * FROM messages WHERE {column} = ?", [value]  # noqa: S608
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
        return [_message(r) for r in reversed(self._all(sql, args))]

    def add_canvas_message(
        self, canvas_node_id: int, role: str, content: str, stopped: bool = False
    ) -> Message:
        node = self.canvas_node_by_id(canvas_node_id)
        with self.atomic():
            cur = self._db.execute(
                """INSERT INTO messages (subject_id, canvas_node_id, role, content,
                                         created_at, stopped)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (node.subject_id, node.id, role, content, self._clock(), int(stopped)),
            )
            self.bump_graph_version(node.subject_id)
        return self.message_by_id(cur.lastrowid)

    def subject_canvas_messages(self, subject_id: int) -> dict[int, list[Message]]:
        """Every canvas message of the subject, grouped by chat node, in order."""
        rows = self._all(
            """SELECT * FROM messages WHERE subject_id = ? AND canvas_node_id IS NOT NULL
               ORDER BY id""",
            (subject_id,),
        )
        out: dict[int, list[Message]] = {}
        for r in rows:
            out.setdefault(r["canvas_node_id"], []).append(_message(r))
        return out

    def unextracted_chat_nodes(self, subject_id: int) -> list[int]:
        """Chat nodes with a tutor reply the cartographer has not processed yet."""
        rows = self._all(
            """SELECT c.id FROM canvas_nodes c
               WHERE c.subject_id = ? AND c.kind = 'chat' AND EXISTS (
                   SELECT 1 FROM messages m
                   WHERE m.canvas_node_id = c.id AND m.role = 'assistant'
                     AND m.id > COALESCE(c.last_extracted_message_id, 0))
               ORDER BY c.id""",
            (subject_id,),
        )
        return [r["id"] for r in rows]

    def has_answer(self, canvas_node_id: int) -> bool:
        row = self._one(
            "SELECT 1 FROM messages WHERE canvas_node_id = ? AND role = 'assistant' LIMIT 1",
            (canvas_node_id,),
        )
        return row is not None

    # ---------- canvas ----------
    # A tree per subject: every node has one parent (the root has none), and
    # nodes are never moved, so no operation here can form a cycle.

    def _insert_canvas(
        self, subject_id: int, parent_id: int | None, kind: str, sort_index: int, body: str
    ) -> int:
        cur = self._db.execute(
            """INSERT INTO canvas_nodes (subject_id, parent_id, kind, sort_index, title,
                                         keyword, note_body, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                subject_id,
                parent_id,
                kind,
                sort_index,
                note_title(body) if kind == "note" else "",
                clean_keyword(note_title(body)) if kind == "note" else "",
                body if kind == "note" else "",
                self._clock(),
            ),
        )
        return cur.lastrowid

    def get_canvas_node(self, visitor: str, canvas_node_id: int) -> CanvasNode:
        row = self._one(
            """SELECT c.* FROM canvas_nodes c JOIN subjects s ON s.id = c.subject_id
               WHERE c.id = ? AND s.visitor = ?""",
            (canvas_node_id, visitor),
        )
        if row is None:
            raise NotFound(f"Canvas node {canvas_node_id} not found.")
        return self._canvas(row)

    def canvas_node_by_id(self, canvas_node_id: int) -> CanvasNode:
        row = self._one("SELECT * FROM canvas_nodes WHERE id = ?", (canvas_node_id,))
        if row is None:
            raise NotFound(f"Canvas node {canvas_node_id} not found.")
        return self._canvas(row)

    def list_canvas_nodes(self, subject_id: int) -> list[CanvasNode]:
        """Every node of the subject, parents before children, siblings in order."""
        rows = self._all(
            "SELECT * FROM canvas_nodes WHERE subject_id = ? ORDER BY sort_index, id",
            (subject_id,),
        )
        nodes = [self._canvas(r) for r in rows]
        children: dict[int | None, list[CanvasNode]] = {}
        for n in nodes:
            children.setdefault(n.parent_id, []).append(n)
        out: list[CanvasNode] = []
        stack = list(reversed(children.get(None, [])))
        while stack:
            n = stack.pop()
            out.append(n)
            stack.extend(reversed(children.get(n.id, [])))
        return out

    def canvas_children(self, canvas_node_id: int) -> list[CanvasNode]:
        rows = self._all(
            "SELECT * FROM canvas_nodes WHERE parent_id = ? ORDER BY sort_index, id",
            (canvas_node_id,),
        )
        return [self._canvas(r) for r in rows]

    def subtree_ids(self, canvas_node_id: int) -> list[int]:
        """This node and everything below it."""
        rows = self._all(
            """WITH RECURSIVE below(id) AS (
                   SELECT ?
                   UNION
                   SELECT c.id FROM canvas_nodes c JOIN below b ON c.parent_id = b.id
               ) SELECT id FROM below""",
            (canvas_node_id,),
        )
        return [r["id"] for r in rows]

    def branch(self, canvas_node_id: int) -> list[CanvasNode]:
        """The path from the root down to this node (inclusive)."""
        path: list[CanvasNode] = []
        current: CanvasNode | None = self.canvas_node_by_id(canvas_node_id)
        seen: set[int] = set()
        while current is not None and current.id not in seen:
            seen.add(current.id)
            path.append(current)
            current = (
                self.canvas_node_by_id(current.parent_id) if current.parent_id is not None else None
            )
        return path[::-1]

    def add_canvas_node(
        self, visitor: str, anchor_id: int, where: str, kind: str, text: str
    ) -> CanvasNode:
        """Add a chat node (with `text` as its first question) or a note (with
        `text` as its body), as the last child of the anchor (`where="child"`)
        or right after it among its siblings (`where="sibling"`)."""
        if kind not in CANVAS_KINDS:
            raise ValueError(f"Unknown canvas node kind: {kind}")
        anchor = self.get_canvas_node(visitor, anchor_id)
        text = text.strip()
        if kind == "chat" and not text:
            raise ValueError("A chat node needs its first question.")
        with self.atomic():
            if where == "child":
                parent_id = anchor.id
                row = self._one(
                    """SELECT COALESCE(MAX(sort_index), -1) AS m FROM canvas_nodes
                       WHERE parent_id = ?""",
                    (parent_id,),
                )
                index = row["m"] + 1
            elif where == "sibling":
                if anchor.parent_id is None:
                    raise Conflict("The root has no siblings; add a child instead.")
                parent_id = anchor.parent_id
                index = anchor.sort_index + 1
                self._db.execute(
                    """UPDATE canvas_nodes SET sort_index = sort_index + 1
                       WHERE parent_id = ? AND sort_index >= ?""",
                    (parent_id, index),
                )
            else:
                raise ValueError(f"Unknown position: {where}")
            new_id = self._insert_canvas(anchor.subject_id, parent_id, kind, index, text)
            if kind == "chat":
                self.add_canvas_message(new_id, "user", text)
            self.bump_graph_version(anchor.subject_id)
        return self.canvas_node_by_id(new_id)

    def update_canvas_node(
        self,
        visitor: str,
        canvas_node_id: int,
        kind: str | None = None,
        prompt: str | None = None,
        note_body: str | None = None,
    ) -> CanvasNode:
        """Switch kind, edit a chat's first question, or edit a note's body.
        Switching kind and editing the question only work before an answer."""
        node = self.get_canvas_node(visitor, canvas_node_id)
        with self.atomic():
            if kind is not None and kind != node.kind:
                if kind not in CANVAS_KINDS:
                    raise ValueError(f"Unknown canvas node kind: {kind}")
                if self.has_answer(node.id):
                    raise Conflict("This node already has an answer; its kind cannot change.")
                if kind == "note":
                    messages = self.canvas_messages(node.id)
                    body = messages[0].content if messages else ""
                    self._db.execute("DELETE FROM messages WHERE canvas_node_id = ?", (node.id,))
                    self._db.execute("DELETE FROM suggestions WHERE canvas_node_id = ?", (node.id,))
                    self._set_note(node.id, body)
                else:
                    body = node.note_body.strip()
                    self._db.execute(
                        """UPDATE canvas_nodes SET kind = 'chat', note_body = '', title = '',
                                                   keyword = '' WHERE id = ?""",
                        (node.id,),
                    )
                    if body:
                        self.add_canvas_message(node.id, "user", body)
                self._db.execute("UPDATE canvas_nodes SET kind = ? WHERE id = ?", (kind, node.id))
                node = self.canvas_node_by_id(node.id)
            if prompt is not None:
                if node.kind != "chat":
                    raise Conflict("Only a chat node has a question to edit.")
                if self.has_answer(node.id):
                    raise Conflict("This question already has an answer; ask a follow-up instead.")
                prompt = prompt.strip()
                if not prompt:
                    raise ValueError("The question cannot be empty.")
                first = self.canvas_messages(node.id)
                if first:
                    self._db.execute(
                        "UPDATE messages SET content = ? WHERE id = ?", (prompt, first[0].id)
                    )
                else:
                    self.add_canvas_message(node.id, "user", prompt)
            if note_body is not None:
                if node.kind != "note":
                    raise Conflict("Only a note has a body to edit.")
                self._set_note(node.id, note_body)
            self.bump_graph_version(node.subject_id)
        return self.canvas_node_by_id(node.id)

    def _set_note(self, canvas_node_id: int, body: str):
        title = note_title(body)
        self._db.execute(
            "UPDATE canvas_nodes SET note_body = ?, title = ?, keyword = ? WHERE id = ?",
            (body, title, clean_keyword(title), canvas_node_id),
        )

    def delete_canvas_node(self, visitor: str, canvas_node_id: int, branch: bool = False) -> dict:
        """Delete a node; one with children needs `branch=True` (the whole
        branch goes). Concepts left with no evidence are deleted; a concept
        whose home went but that has evidence elsewhere moves to the node of
        its earliest remaining evidence."""
        node = self.get_canvas_node(visitor, canvas_node_id)
        if node.parent_id is None:
            raise Conflict("The root cannot be deleted.")
        ids = self.subtree_ids(node.id)
        if len(ids) > 1 and not branch:
            raise Conflict(
                f"This node has {len(ids) - 1} node(s) below it; "
                "pass confirm=branch to delete the whole branch."
            )
        marks = ",".join("?" * len(ids))
        with self.atomic():
            affected = {
                r["id"]
                for r in self._all(
                    f"""SELECT id FROM nodes WHERE home_canvas_node_id IN ({marks})
                        UNION
                        SELECT e.node_id FROM node_evidence e JOIN messages m
                          ON m.id = e.message_id WHERE m.canvas_node_id IN ({marks})""",  # noqa: S608
                    (*ids, *ids),
                )
            }
            self._db.execute(f"DELETE FROM canvas_nodes WHERE id IN ({marks})", ids)  # noqa: S608
            removed, moved = [], []
            for concept_id in sorted(affected):
                concept = self.node_by_id(concept_id)
                first = self._one(
                    """SELECT m.canvas_node_id FROM node_evidence e
                       JOIN messages m ON m.id = e.message_id
                       WHERE e.node_id = ? AND m.canvas_node_id IS NOT NULL
                       ORDER BY m.id LIMIT 1""",
                    (concept_id,),
                )
                if first is None:
                    self._db.execute("DELETE FROM nodes WHERE id = ?", (concept_id,))
                    removed.append(concept.name)
                elif concept.home_canvas_node_id is None:
                    self._db.execute(
                        "UPDATE nodes SET home_canvas_node_id = ? WHERE id = ?",
                        (first["canvas_node_id"], concept_id),
                    )
                    moved.append(concept.name)
            self.bump_graph_version(node.subject_id)
        return {"deleted": ids, "concepts_removed": removed, "concepts_moved": moved}

    def set_title_keyword(self, canvas_node_id: int, title: str, keyword: str):
        with self.atomic():
            self._db.execute(
                "UPDATE canvas_nodes SET title = ?, keyword = ? WHERE id = ?",
                (title, keyword, canvas_node_id),
            )

    def set_canvas_last_extracted(self, canvas_node_id: int, message_id: int):
        with self.atomic():
            self._db.execute(
                "UPDATE canvas_nodes SET last_extracted_message_id = ? WHERE id = ?",
                (message_id, canvas_node_id),
            )

    # ---------- concepts on the canvas ----------

    def concepts_homed(self, canvas_node_ids: list[int]) -> list[Node]:
        """Concepts first taught in these canvas nodes, newest first."""
        if not canvas_node_ids:
            return []
        marks = ",".join("?" * len(canvas_node_ids))
        rows = self._all(
            f"SELECT * FROM nodes WHERE home_canvas_node_id IN ({marks}) ORDER BY id DESC",  # noqa: S608
            canvas_node_ids,
        )
        return [self._node(r) for r in rows]

    def concepts_evidenced_in(self, canvas_node_id: int) -> list[Node]:
        """Concepts with at least one evidence quote from this node's messages."""
        rows = self._all(
            """SELECT DISTINCT n.* FROM nodes n JOIN node_evidence e ON e.node_id = n.id
               JOIN messages m ON m.id = e.message_id
               WHERE m.canvas_node_id = ? ORDER BY n.id""",
            (canvas_node_id,),
        )
        return [self._node(r) for r in rows]

    def concepts_evidenced_by_node(self, subject_id: int) -> dict[int, list[Node]]:
        """For every canvas node of the subject, the concepts with at least one
        (verified) evidence quote from that node's messages, in one query."""
        rows = self._all(
            """SELECT DISTINCT m.canvas_node_id AS taught_in, n.* FROM nodes n
               JOIN node_evidence e ON e.node_id = n.id
               JOIN messages m ON m.id = e.message_id
               WHERE n.subject_id = ? AND m.canvas_node_id IS NOT NULL
               ORDER BY m.canvas_node_id, n.id""",
            (subject_id,),
        )
        out: dict[int, list[Node]] = {}
        for r in rows:
            out.setdefault(r["taught_in"], []).append(self._node(r))
        return out

    def evidence_with_nodes(self, concept_id: int) -> list[dict]:
        rows = self._all(
            """SELECT e.quote, e.message_id, m.canvas_node_id FROM node_evidence e
               JOIN messages m ON m.id = e.message_id WHERE e.node_id = ? ORDER BY e.id""",
            (concept_id,),
        )
        return [dict(r) for r in rows]

    def concept_names_recent(self, subject_id: int) -> list[Node]:
        rows = self._all("SELECT * FROM nodes WHERE subject_id = ? ORDER BY id DESC", (subject_id,))
        return [self._node(r) for r in rows]

    # ---------- suggestions ----------

    def replace_suggestions(self, canvas_node_id: int, texts: list[str]) -> bool:
        """Swap the node's open suggestions for `texts`; True if they changed."""
        node = self.canvas_node_by_id(canvas_node_id)
        with self.atomic():
            old = [s.text for s in self.node_suggestions(canvas_node_id)]
            if old == texts:
                return False
            self._db.execute("DELETE FROM suggestions WHERE canvas_node_id = ?", (canvas_node_id,))
            for text in texts:
                self._db.execute(
                    """INSERT INTO suggestions (subject_id, canvas_node_id, text, created_at)
                       VALUES (?, ?, ?, ?)""",
                    (node.subject_id, canvas_node_id, text, self._clock()),
                )
        return True

    def node_suggestions(self, canvas_node_id: int) -> list[Suggestion]:
        rows = self._all(
            "SELECT * FROM suggestions WHERE canvas_node_id = ? ORDER BY id", (canvas_node_id,)
        )
        return [Suggestion(r["id"], r["canvas_node_id"], r["text"]) for r in rows]

    def list_suggestions(self, subject_id: int) -> list[Suggestion]:
        rows = self._all(
            "SELECT * FROM suggestions WHERE subject_id = ? ORDER BY id", (subject_id,)
        )
        return [Suggestion(r["id"], r["canvas_node_id"], r["text"]) for r in rows]

    def accept_suggestion(self, visitor: str, suggestion_id: int) -> CanvasNode:
        """A child chat node whose first question is the suggestion's text."""
        row = self._one(
            """SELECT g.* FROM suggestions g JOIN subjects s ON s.id = g.subject_id
               WHERE g.id = ? AND s.visitor = ?""",
            (suggestion_id, visitor),
        )
        if row is None:
            raise NotFound(f"Suggestion {suggestion_id} not found.")
        with self.atomic():
            node = self.add_canvas_node(
                visitor, row["canvas_node_id"], "child", "chat", row["text"]
            )
            self._db.execute("DELETE FROM suggestions WHERE id = ?", (suggestion_id,))
        return node

    # ---------- search ----------

    def search(self, subject_id: int, query: str, limit: int = 50) -> list[dict]:
        """Case-insensitive substring search over node titles, messages, notes
        and concepts. Each hit names the canvas node to move to."""
        q = query.strip()
        if not q:
            raise ValueError("Search needs some text.")
        pattern = "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        like = "LIKE ? ESCAPE '\\'"
        hits: list[dict] = []

        def add(rows, field_name, text_key):
            for r in rows:
                hits.append(
                    {
                        "canvas_node_id": r["canvas_node_id"],
                        "field": field_name,
                        "snippet": snippet(r[text_key], q),
                        **({"concept_id": r["concept_id"]} if field_name == "concept" else {}),
                        **({"message_id": r["message_id"]} if field_name == "message" else {}),
                    }
                )

        add(
            self._all(
                f"""SELECT id AS canvas_node_id, title FROM canvas_nodes
                    WHERE subject_id = ? AND title {like} ORDER BY id""",  # noqa: S608
                (subject_id, pattern),
            ),
            "title",
            "title",
        )
        add(
            self._all(
                f"""SELECT id AS canvas_node_id, note_body FROM canvas_nodes
                    WHERE subject_id = ? AND kind = 'note' AND note_body {like}
                    ORDER BY id""",  # noqa: S608
                (subject_id, pattern),
            ),
            "note",
            "note_body",
        )
        add(
            self._all(
                f"""SELECT id AS concept_id, home_canvas_node_id AS canvas_node_id,
                           name || ': ' || summary AS text FROM nodes
                    WHERE subject_id = ? AND home_canvas_node_id IS NOT NULL
                      AND (name {like} OR summary {like}) ORDER BY id""",  # noqa: S608
                (subject_id, pattern, pattern),
            ),
            "concept",
            "text",
        )
        add(
            self._all(
                f"""SELECT id AS message_id, canvas_node_id, content FROM messages
                    WHERE subject_id = ? AND canvas_node_id IS NOT NULL AND content {like}
                    ORDER BY id""",  # noqa: S608
                (subject_id, pattern),
            ),
            "message",
            "content",
        )
        return hits[:limit]


def snippet(text: str, query: str, width: int = 60) -> str:
    """About `width` characters of `text` on each side of the first match."""
    flat = " ".join(text.split())
    at = flat.lower().find(query.lower())
    if at < 0:
        return flat[: 2 * width]
    start, end = max(0, at - width), min(len(flat), at + len(query) + width)
    return ("…" if start else "") + flat[start:end] + ("…" if end < len(flat) else "")
