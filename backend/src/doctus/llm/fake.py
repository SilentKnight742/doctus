"""A deterministic stand-in model for tests and offline development.

Queue the answers you want with `queue_json` / `queue_chat`. When the
queue is empty it falls back to a simple canned answer, so the app
can be clicked through with no API key (DOCTUS_LLM=fake).
"""

import json
from collections import deque

from pydantic import BaseModel

from .base import LLM, Turn


class FakeLLM(LLM):
    def __init__(self):
        self.json_answers: deque[str | Exception] = deque()
        self.chat_answers: deque[str | Exception] = deque()
        self.calls: list[dict] = []

    def queue_json(self, answer: dict | str | Exception):
        """Queue a structured answer; an Exception instance is raised instead."""
        if isinstance(answer, dict):
            answer = json.dumps(answer)
        self.json_answers.append(answer)

    def queue_chat(self, answer: str | Exception):
        """Queue a chat reply; an Exception instance is raised instead."""
        self.chat_answers.append(answer)

    def chat(self, system: str, turns: list[Turn]) -> str:
        self.calls.append({"kind": "chat", "system": system, "turns": list(turns)})
        if self.chat_answers:
            return _answer(self.chat_answers.popleft())
        return f"(offline reply) You said: {turns[-1].content}"

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
    return {}
