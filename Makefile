.DEFAULT_GOAL := help
.PHONY: help install install-frontend dev dev-backend dev-frontend test test-backend test-frontend lint lint-backend lint-frontend fmt build

help: ## list targets
	@grep -E '^[a-z-]+:.*##' $(MAKEFILE_LIST) | sed -E 's/:.*## /\t/'

install: ## install backend dependencies from the lockfile
	cd backend && uv sync --locked

install-frontend: ## install frontend dependencies from the lockfile
	cd frontend && npm ci

frontend/node_modules:
	cd frontend && npm ci

dev: install frontend/node_modules ## run backend (:8000) and frontend (:5173) together; Ctrl-C stops both
	@trap 'kill 0' INT TERM EXIT; \
	$(MAKE) --no-print-directory dev-backend & \
	$(MAKE) --no-print-directory dev-frontend & \
	wait

dev-backend:
	cd backend && uv run uvicorn doctus.main:app --reload --port 8000

dev-frontend: frontend/node_modules
	cd frontend && npm run dev

test: test-backend test-frontend ## run all offline tests

test-backend: install ## backend tests (offline; live Gemini tests are excluded)
	cd backend && uv run python -m pytest

test-frontend: frontend/node_modules ## frontend unit tests (Vitest)
	cd frontend && npm test

lint: lint-backend lint-frontend ## lint and typecheck everything (no changes written)

lint-backend: install
	cd backend && uv run ruff check . && uv run ruff format --check .

lint-frontend: frontend/node_modules
	cd frontend && npm run lint && npm run typecheck

build: frontend/node_modules ## production build of the frontend
	cd frontend && npm run build

fmt: install ## auto-format and auto-fix the backend
	cd backend && uv run ruff format . && uv run ruff check --fix .
