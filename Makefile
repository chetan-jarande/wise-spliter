# Wise-Spliter. Run `make` or `make help` for the command list.
# Modeled on merry-tools/Makefile for centralized local Supabase
# (/home/chetan/projects/my-scripts/setup/dependencies) and custom schema `wise_spliter`.

PROJECT_NAME  = wise-spliter
COMPOSE       = docker compose --env-file .env.development
APP_PORT      = 4173
API_PORT      = 4174
SUPABASE_DIR  = /home/chetan/projects/my-scripts/setup/dependencies

.DEFAULT_GOAL := help

.PHONY: help up dev dev-ui api prod build start stop check-port install test e2e typecheck verify-agents clean \
        supabase-up supabase-down supabase-status supabase-ensure \
        migrate-up migrate-local migrate-verify migrate-sql migrate-docker setup-dev \
        docker-up-dev docker-down-dev docker-build docker-up docker-down docker-logs down


# =============================================================================
# One-shot: dependencies + migrations + dev user seed + full-stack dev server
# =============================================================================

up: dev

dev: setup-dev
	node scripts/dev-stack.mjs

setup-dev: supabase-ensure migrate-up
	set -a && [ -f .env.development ] && . ./.env.development; set +a && bun run scripts/setup-dev-user.mjs

dev-ui:
	node scripts/dev-stack.mjs

api:
	bun run src/server/index.ts

down:
	-$(COMPOSE) down --remove-orphans
	@$(MAKE) stop


# =============================================================================
# Local Build, Preview & Verification
# =============================================================================

install:
	bun install

prod: check-port build
	bun run start --port $(APP_PORT)

build:
	bun run build

start: build
	bun run start --port $(APP_PORT)

test:
	bun run test

e2e:
	bun run e2e

typecheck:
	bun run typecheck

verify-agents:
	node agents/orchestrate-personas.mjs --phase check

clean:
	rm -rf dist test-results playwright-report

check-port:
	@if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -Eq ':($(APP_PORT)|$(API_PORT)) '; then \
	  echo "ERROR: :$(APP_PORT) or :$(API_PORT) is in use. Run 'make stop' first."; exit 1; \
	fi

stop:
	@fuser -k $(APP_PORT)/tcp 2>/dev/null || true
	@fuser -k $(API_PORT)/tcp 2>/dev/null || true
	@sleep 1
	@echo "Ports $(APP_PORT) and $(API_PORT) free."


# =============================================================================
# Centralized Supabase (/home/chetan/projects/my-scripts/setup/dependencies)
# =============================================================================

supabase-up:
	SUPABASE_DIR=$(SUPABASE_DIR) bash scripts/ensure-central-supabase.sh

supabase-down:
	cd $(SUPABASE_DIR) && npx supabase stop

supabase-status:
	cd $(SUPABASE_DIR) && npx supabase status

supabase-ensure:
	@SUPABASE_DIR=$(SUPABASE_DIR) bash scripts/ensure-central-supabase.sh


# =============================================================================
# Migrations (`wise_spliter` schema)
# =============================================================================

migrate-up:
	set -a && [ -f .env.development ] && . ./.env.development; set +a && node scripts/apply-migration.mjs local

migrate-local: migrate-up

migrate-verify:
	set -a && [ -f .env.development ] && . ./.env.development; set +a && node scripts/apply-migration.mjs verify

migrate-sql:
	@node scripts/apply-migration.mjs --print-sql

migrate-docker:
	$(COMPOSE) --profile migrate run --rm migrate


# =============================================================================
# Docker Stack
# =============================================================================

docker-up-dev: supabase-ensure migrate-up
	$(COMPOSE) -f docker-compose.yml -f docker-compose.dev.yml up -d --build
	@echo "Frontend: http://localhost:$(APP_PORT)   API: http://localhost:$(API_PORT)/api/health"

docker-down-dev:
	-$(COMPOSE) -f docker-compose.yml -f docker-compose.dev.yml down --remove-orphans

docker-build:
	$(COMPOSE) build

docker-up: supabase-ensure migrate-up
	$(COMPOSE) up -d --build
	@echo "Frontend: http://localhost:$(APP_PORT)   API: http://localhost:$(API_PORT)/api/health"

docker-down:
	$(COMPOSE) down --remove-orphans

docker-logs:
	$(COMPOSE) logs -f


# =============================================================================
# Help
# =============================================================================

help:
	@echo "Wise-Spliter Build, Database & Run Commands:"
	@echo "  make dev             - Ensure centralized Supabase is up, apply wise_spliter schema, seed dev users, and start API (4174) + UI (4173)"
	@echo "  make setup-dev       - Ensure Supabase + migrations and provision dev users & ledger seed in wise_spliter"
	@echo "  make dev-ui          - Start API (4174) + UI (4173) directly without re-running supabase-ensure"
	@echo "  make api             - Run Backend API service on http://localhost:$(API_PORT)"
	@echo "  make supabase-up     - Start centralized Supabase in $(SUPABASE_DIR)"
	@echo "  make supabase-status - Check centralized Supabase status"
	@echo "  make migrate-up      - Apply supabase/migrations/*.sql to wise_spliter schema and verify"
	@echo "  make migrate-verify  - Verify wise_spliter tables & RPC in centralized Supabase"
	@echo "  make docker-up-dev   - Run full stack in Docker development containers"
	@echo "  make test            - Run unit and property-based tests (Vitest + fast-check)"
	@echo "  make e2e             - Run Playwright end-to-end verification suite"
	@echo "  make typecheck       - Run strict TypeScript compiler checks"
	@echo "  make build           - Build production bundle"
	@echo "  make stop            - Free ports $(APP_PORT) and $(API_PORT)"
