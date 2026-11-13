from .base import LLM, LLMError, Turn
from .fake import FakeLLM

__all__ = ["LLM", "LLMError", "Turn", "FakeLLM", "make_llm"]


def make_llm(settings) -> LLM:
    if settings.llm_provider == "fake":
        return FakeLLM()
    if settings.llm_provider == "gemini":
        from .gemini import GeminiLLM

        if not settings.gemini_api_key:
            raise RuntimeError("Set GEMINI_API_KEY, or DOCTUS_LLM=fake for offline use.")
        return GeminiLLM(api_key=settings.gemini_api_key, model=settings.gemini_model)
    raise RuntimeError(f"Unknown DOCTUS_LLM provider: {settings.llm_provider}")
