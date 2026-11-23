"""A deterministic stand-in model for tests and offline development.

Queue the answers you want with `queue_json` / `queue_chat`. When the
queue is empty it falls back to a simple canned answer, so the app
can be clicked through with no API key (DOCTUS_LLM=fake).

A queued chat answer may be a `FakeStream`: explicit chunks (an Exception
chunk is raised at that point) plus hooks run just before a given chunk is
produced, so tests can act in the middle of a streamed reply.
"""

import json
import re
from collections import deque
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field

from pydantic import BaseModel

from .base import LLM, Turn


@dataclass
class FakeStream:
    chunks: list[str | Exception]
    # chunk index -> callable run just before that chunk is produced
    on_chunk: dict[int, Callable[[], None]] = field(default_factory=dict)


class FakeLLM(LLM):
    def __init__(self):
        self.json_answers: deque[str | Exception] = deque()
        self.chat_answers: deque[str | Exception | FakeStream] = deque()
        self.calls: list[dict] = []

    def queue_json(self, answer: dict | str | Exception):
        """Queue a structured answer; an Exception instance is raised instead."""
        if isinstance(answer, dict):
            answer = json.dumps(answer)
        self.json_answers.append(answer)

    def queue_chat(self, answer: str | Exception | FakeStream):
        """Queue a chat reply; an Exception instance is raised instead."""
        self.chat_answers.append(answer)

    def _next_chat(self, turns: list[Turn]) -> str | Exception | FakeStream:
        if self.chat_answers:
            return self.chat_answers.popleft()
        return f"(offline reply) You said: {turns[-1].content}"

    def chat(self, system: str, turns: list[Turn]) -> str:
        self.calls.append({"kind": "chat", "system": system, "turns": list(turns)})
        answer = self._next_chat(turns)
        if isinstance(answer, FakeStream):
            return "".join(_answer(c) for c in answer.chunks)
        return _answer(answer)

    def chat_stream(self, system: str, turns: list[Turn]) -> Iterator[str]:
        self.calls.append({"kind": "chat", "system": system, "turns": list(turns)})
        answer = self._next_chat(turns)
        if isinstance(answer, FakeStream):
            stream = answer
        elif isinstance(answer, Exception):
            stream = FakeStream([answer])
        else:
            stream = FakeStream(re.findall(r"\S+\s*", answer) or [answer])
        try:
            for i, chunk in enumerate(stream.chunks):
                hook = stream.on_chunk.get(i)
                if hook:
                    hook()
                yield _answer(chunk)
        finally:
            self.calls.append({"kind": "stream_end"})

    def _raw_json(self, system: str, prompt: str, schema: type[BaseModel]) -> str:
        self.calls.append({"kind": "json", "system": system, "prompt": prompt, "schema": schema})
        if self.json_answers:
            return _answer(self.json_answers.popleft())
        return json.dumps(_canned(schema.__name__))


def _answer(item):
    if isinstance(item, Exception):
        raise item
    return item


def _canned(schema_name: str) -> dict:
    if schema_name == "GraphProposal":
        return {
            "concepts": [
                {"name": "Foundations", "summary": "Core ideas this subject builds on."},
                {"name": "Core technique", "summary": "The main method of the subject."},
            ],
            "links": [
                {
                    "prerequisite": "Foundations",
                    "concept": "Core technique",
                    "reason": "The technique builds on the foundations.",
                },
            ],
        }
    if schema_name == "CanvasExtraction":
        return {"title": "", "keyword": "", "concepts": [], "links": [], "suggestions": []}
    return {}
