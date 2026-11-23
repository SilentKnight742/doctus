from .base import LLM, LLMError, ModelBusy, RateLimited, Turn
from .fake import FakeLLM, FakeStream

__all__ = [
    "LLM",
    "FakeLLM",
    "FakeStream",
    "LLMError",
    "ModelBusy",
    "RateLimited",
    "Turn",
    "make_llm",
]


def make_llm(settings, model: str | None = None) -> LLM:
    """Build the configured provider; `model` overrides the chat model."""
    if settings.llm_provider == "fake":
        return FakeLLM()
    if settings.llm_provider == "gemini":
        from .gemini import GeminiLLM

        if not settings.gemini_api_key:
            raise RuntimeError("Set GEMINI_API_KEY, or DOCTUS_LLM=fake for offline use.")
        return GeminiLLM(api_key=settings.gemini_api_key, model=model or settings.gemini_model)
    raise RuntimeError(f"Unknown DOCTUS_LLM provider: {settings.llm_provider}")
