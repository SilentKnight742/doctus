import pytest
from pydantic import BaseModel

from doctus.llm import FakeLLM, LLMError
from doctus.llm.base import _strip_fences


class Answer(BaseModel):
    value: int


def test_structured_parses_valid_json():
    llm = FakeLLM()
    llm.queue_json({"value": 3})
    assert llm.structured("sys", "prompt", Answer).value == 3


def test_structured_retries_once_with_error_feedback():
    llm = FakeLLM()
    llm.queue_json("not json at all")
    llm.queue_json({"value": 7})
    assert llm.structured("sys", "prompt", Answer).value == 7
    assert "previous answer was invalid" in llm.calls[1]["prompt"]


def test_structured_gives_up_after_two_bad_answers():
    llm = FakeLLM()
    llm.queue_json({"value": "seven"})
    llm.queue_json({"wrong": 1})
    with pytest.raises(LLMError):
        llm.structured("sys", "prompt", Answer)


def test_code_fences_are_stripped():
    assert _strip_fences('```json\n{"value": 1}\n```') == '{"value": 1}'
    assert _strip_fences('{"value": 1}') == '{"value": 1}'


def test_gemini_module_imports():
    from doctus.llm.gemini import GeminiLLM  # noqa: F401
