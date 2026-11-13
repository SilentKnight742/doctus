"""Gemini provider, using the google-genai SDK."""

from google import genai
from google.genai import errors, types
from pydantic import BaseModel

from .base import LLM, LLMError, Turn


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
            # 429 = free-tier rate limit; surface it clearly.
            raise LLMError(f"Gemini API error ({getattr(exc, 'code', '?')}): {exc}") from exc
        text = response.text
        if not text:
            raise LLMError("Gemini returned an empty response (possibly blocked).")
        return text

    def chat(self, system: str, turns: list[Turn]) -> str:
        contents = [
            types.Content(
                role="model" if t.role == "assistant" else "user",
                parts=[types.Part(text=t.content)],
            )
            for t in turns
        ]
        return self._call(
            contents,
            types.GenerateContentConfig(system_instruction=system, temperature=0.7),
        )

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
