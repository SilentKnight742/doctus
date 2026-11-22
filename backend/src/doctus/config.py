"""Runtime settings, read from environment variables."""

import os
from dataclasses import dataclass

from dotenv import find_dotenv, load_dotenv


@dataclass(frozen=True)
class Settings:
    db_path: str
    llm_provider: str  # "gemini" or "fake"
    gemini_api_key: str | None
    gemini_model: str
    # Model for the cartographer; None means the chat model.
    graph_model: str | None = None
    # Characters of branch conversation sent to the tutor (whole ancestor
    # nodes are trimmed, oldest first, beyond this).
    context_chars: int = 24_000


def load_settings() -> Settings:
    # Read .env from the working directory if present; real env vars win.
    load_dotenv(find_dotenv(usecwd=True), override=False)
    return Settings(
        db_path=os.environ.get("DOCTUS_DB", "doctus.db"),
        llm_provider=os.environ.get("DOCTUS_LLM", "gemini"),
        gemini_api_key=os.environ.get("GEMINI_API_KEY"),
        # Model names change often; override with DOCTUS_GEMINI_MODEL.
        gemini_model=os.environ.get("DOCTUS_GEMINI_MODEL", "gemini-3.5-flash-lite"),
        graph_model=os.environ.get("DOCTUS_GRAPH_MODEL") or None,
        context_chars=int(os.environ.get("DOCTUS_CONTEXT_CHARS", "24000")),
    )
