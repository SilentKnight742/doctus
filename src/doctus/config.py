"""Runtime settings, read from environment variables."""

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    db_path: str
    llm_provider: str          # "gemini" or "fake"
    gemini_api_key: str | None
    gemini_model: str
    max_proposals_per_update: int
    recent_turns_in_context: int


def load_settings() -> Settings:
    return Settings(
        db_path=os.environ.get("DOCTUS_DB", "doctus.db"),
        llm_provider=os.environ.get("DOCTUS_LLM", "gemini"),
        gemini_api_key=os.environ.get("GEMINI_API_KEY"),
        # Model names change often; override with DOCTUS_GEMINI_MODEL.
        gemini_model=os.environ.get("DOCTUS_GEMINI_MODEL", "gemini-3.8-flash"),
        max_proposals_per_update=int(os.environ.get("DOCTUS_MAX_PROPOSALS", "5")),
        recent_turns_in_context=int(os.environ.get("DOCTUS_RECENT_TURNS", "8")),
    )
