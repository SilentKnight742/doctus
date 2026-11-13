"""Opt-in live check against the real Gemini API.

Run with: python -m pytest -m live
Skipped unless GEMINI_API_KEY is set (in the environment or .env).
"""

import pytest
from pydantic import BaseModel

from doctus.config import load_settings
from doctus.llm import Turn

pytestmark = pytest.mark.live


class Capital(BaseModel):
    country: str
    capital: str


@pytest.fixture(scope="module")
def llm():
    settings = load_settings()
    if not settings.gemini_api_key:
        pytest.skip("GEMINI_API_KEY not set")
    from doctus.llm.gemini import GeminiLLM

    return GeminiLLM(api_key=settings.gemini_api_key, model=settings.gemini_model)


def test_live_chat(llm):
    reply = llm.chat(
        "You are terse.", [Turn(role="user", content="Reply with the single word: pong")]
    )
    assert isinstance(reply, str) and reply.strip()


def test_live_structured(llm):
    result = llm.structured(
        "Answer with JSON matching the schema.",
        "What is the capital of France?",
        Capital,
    )
    assert isinstance(result, Capital)
    assert "paris" in result.capital.lower()
