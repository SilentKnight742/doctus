.DEFAULT_GOAL := help
.PHONY: help install dev dev-backend test lint fmt

help: ## list targets
	@grep -E '^[a-z-]+:.*##' $(MAKEFILE_LIST) | sed -E 's/:.*## /\t/'

install: ## install backend dependencies from the lockfile
	cd backend && uv sync --locked

dev: install ## run the backend (:8000); the frontend joins in M2
	@$(MAKE) dev-backend

dev-backend:
	cd backend && uv run uvicorn doctus.main:app --reload --port 8000

test: install ## run backend tests (offline; live Gemini tests are excluded)
	cd backend && uv run python -m pytest

lint: install ## ruff check and format check (no changes written)
	cd backend && uv run ruff check . && uv run ruff format --check .

fmt: install ## auto-format and auto-fix
	cd backend && uv run ruff format . && uv run ruff check --fix .
