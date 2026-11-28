"""Gemini provider, using the google-genai SDK."""

import math
from collections.abc import Iterator

from google import genai
from google.genai import errors, types
from pydantic import BaseModel

from .base import LLM, LLMError, ModelBusy, RateLimited, Turn

DEFAULT_RETRY_AFTER = 60
BUSY_RETRY_AFTER = 20


def retry_after_seconds(exc, default: int = DEFAULT_RETRY_AFTER) -> int:
    """Seconds to wait, from the error's RetryInfo ("retryDelay": "37s"), else a
    Retry-After header, else a default. Always at least 1."""
    details = getattr(exc, "details", None)
    if isinstance(details, dict):
        for item in (details.get("error") or {}).get("details") or []:
            delay = item.get("retryDelay") if isinstance(item, dict) else None
            if isinstance(delay, str) and delay.endswith("s"):
                try:
                    return max(1, math.ceil(float(delay[:-1])))
                except ValueError:
                    pass
    headers = getattr(getattr(exc, "response", None), "headers", None) or {}
    try:
        return max(1, int(headers.get("retry-after", "")))
    except (TypeError, ValueError):
        return default


class GeminiLLM(LLM):
    def __init__(self, api_key: str, model: str):
        self._client = genai.Client(api_key=api_key)
        self._model = model

    def _call(self, contents, config: types.GenerateContentConfig) -> str:
        try:
            response = self._client.models.generate_content(
                model=self._model, contents=contents, config=config
            )
        except errors.APIError as exc:
            raise _mapped(exc) from exc
        text = response.text
        if not text:
            raise LLMError("Gemini returned an empty response (possibly blocked).")
        return text

    def chat(self, system: str, turns: list[Turn]) -> str:
        return self._call(
            _contents(turns),
            types.GenerateContentConfig(system_instruction=system, temperature=0.7),
        )

    def chat_stream(self, system: str, turns: list[Turn]) -> Iterator[str]:
        wrote = False
        try:
            stream = self._client.models.generate_content_stream(
                model=self._model,
                contents=_contents(turns),
                config=types.GenerateContentConfig(system_instruction=system, temperature=0.7),
            )
            try:
                for chunk in stream:
                    text = chunk.text
                    if text:
                        wrote = True
                        yield text
            finally:
                close = getattr(stream, "close", None)
                if close:
                    close()
        except errors.APIError as exc:
            raise _mapped(exc) from exc
        if not wrote:
            raise LLMError("Gemini returned an empty response (possibly blocked).")

    def _raw_json(self, system: str, prompt: str, schema: type[BaseModel]) -> str:
        return self._call(
            prompt,
            types.GenerateContentConfig(
                system_instruction=system,
                temperature=0.2,
                response_mime_type="application/json",
                response_json_schema=schema.model_json_schema(),
            ),
        )


def _contents(turns: list[Turn]):
    return [
        types.Content(
            role="model" if t.role == "assistant" else "user",
            parts=[types.Part(text=t.content)],
        )
        for t in turns
    ]


def _mapped(exc) -> LLMError:
    code = getattr(exc, "code", None)
    if code == 429:
        return RateLimited(
            "Gemini rate limit reached; try again shortly.",
            retry_after=retry_after_seconds(exc),
        )
    if code == 503:
        return ModelBusy(
            "Gemini is busy (model overloaded); try again in a moment.",
            retry_after=retry_after_seconds(exc, BUSY_RETRY_AFTER),
        )
    return LLMError(f"Gemini API error ({code or '?'}): {exc}")
