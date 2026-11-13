"""The one interface every model provider implements.

Doctus only needs two things from a model:
  * a chat reply as plain text;
  * a structured answer validated against a Pydantic schema.

Structured output is never trusted as-is: it is parsed and validated,
and an invalid answer is retried once with the validation error fed
back to the model.
"""

import json
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import TypeVar

from pydantic import BaseModel, ValidationError

T = TypeVar("T", bound=BaseModel)


class LLMError(Exception):
    """The model failed or returned something unusable."""


@dataclass(frozen=True)
class Turn:
    role: str      # "user" or "assistant"
    content: str


class LLM(ABC):
    max_structured_attempts = 2

    @abstractmethod
    def chat(self, system: str, turns: list[Turn]) -> str:
        """Return the assistant's next reply."""

    @abstractmethod
    def _raw_json(self, system: str, prompt: str, schema: type[BaseModel]) -> str:
        """Return the model's raw JSON text for the schema."""

    def structured(self, system: str, prompt: str, schema: type[T]) -> T:
        last_error = ""
        for _ in range(self.max_structured_attempts):
            full_prompt = prompt
            if last_error:
                full_prompt += (
                    "\n\nYour previous answer was invalid:\n"
                    f"{last_error}\nReturn corrected JSON only."
                )
            raw = self._raw_json(system, full_prompt, schema)
            try:
                return schema.model_validate(json.loads(_strip_fences(raw)))
            except (json.JSONDecodeError, ValidationError) as exc:
                last_error = str(exc)[:1500]
        raise LLMError(f"Model returned invalid {schema.__name__}: {last_error}")


def _strip_fences(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else ""
        if text.rstrip().endswith("```"):
            text = text.rstrip()[:-3]
    return text.strip()
