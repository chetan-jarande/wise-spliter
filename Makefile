# Wise-Spliter. Run `make` or `make help` for the command list.
# Modeled on merry-tools/Makefile for centralized local Supabase
# (SUPABASE_DIR in .env.development) and custom schema `wise_spliter`.

PROJECT_NAME  = wise-spliter
COMPOSE       = docker compose --env-file .env.development
APP_PORT      = 4173
API_PORT      = 4174
SUPABASE_DIR ?= $(shell sed -n 's/^SUPABASE_DIR=//p' .env.development 2>/dev/null)
NEED_SUPABASE_DIR = @test -n "$(SUPABASE_DIR)" || { echo "ERROR: set SUPABASE_DIR in .env.development (see .env.example)."; exit 1; }

.DEFAULT_GOAL := help

.PHONY: help up dev dev-ui api prod build start apk apk-prod stop check-port install test e2e e2e-headed e2e-ui typecheck verify-agents clean \
        supabase-up supabase-down supabase-status supabase-ensure \
        migrate-up migrate-local migrate-remote migrate-verify migrate-verify-prod migrate-sql migrate-docker setup-dev reset-dev-data \
        docker-up-dev docker-down-dev docker-build docker-up docker-down docker-logs deploy-pyrite down


# =============================================================================
# One-shot: dependencies + migrations + dev user seed + full-stack dev server
# =============================================================================

up: dev

dev: setup-dev
	set -a && [ -f .env.development ] && . ./.env.development; set +a && node scripts/dev-stack.mjs

setup-dev: supabase-ensure migrate-up
	set -a && [ -f .env.development ] && . ./.env.development; set +a && bun run scripts/setup-dev-user.mjs

reset-dev-data: supabase-ensure
	set -a && [ -f .env.development ] && . ./.env.development; set +a && bun run scripts/reset-dev-data.mjs

dev-ui:
	set -a && [ -f .env.development ] && . ./.env.development; set +a && node scripts/dev-stack.mjs

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

apk:
	bash scripts/build-apk.sh

apk-prod:
	@test -f .env.production || { echo "ERROR: .env.production not found."; exit 1; }
	set -a && . ./.env.production && set +a && APK_RELEASE=1 bash scripts/build-apk.sh

test:
	set -a && [ -f .env.development ] && . ./.env.development; set +a && bun run test

# E2E notes:
#   - make e2e is headless; e2e-headed opens a visible Chrome window; e2e-ui opens Playwright UI mode.
#   - Pass any Playwright flag through E2E_ARGS, e.g. make e2e E2E_ARGS="-g 'User Story 1'".
#   - Headed and UI modes need a desktop session.
#   - The suite uses one worker and one shared dev database: never run two e2e runs at the same time.
#   - Browser binary: /usr/bin/google-chrome, or PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH.
#   - Each run resets dev quotas and test data first (tests/e2e/global-setup.ts, make reset-dev-data).
E2E_ARGS ?=

e2e:
	set -a && [ -f .env.development ] && . ./.env.development; set +a && bun run e2e $(E2E_ARGS)

e2e-headed:
	@$(MAKE) e2e E2E_ARGS="--headed $(E2E_ARGS)"

e2e-ui:
	@$(MAKE) e2e E2E_ARGS="--ui $(E2E_ARGS)"

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
# Centralized Supabase (SUPABASE_DIR)
# =============================================================================

supabase-up:
	$(NEED_SUPABASE_DIR)
	SUPABASE_DIR=$(SUPABASE_DIR) bash scripts/ensure-central-supabase.sh

supabase-down:
	$(NEED_SUPABASE_DIR)
	cd "$(SUPABASE_DIR)" && npx supabase stop

supabase-status:
	$(NEED_SUPABASE_DIR)
	cd "$(SUPABASE_DIR)" && npx supabase status

supabase-ensure:
	$(NEED_SUPABASE_DIR)
	@SUPABASE_DIR=$(SUPABASE_DIR) bash scripts/ensure-central-supabase.sh


# =============================================================================
# Migrations (`wise_spliter` schema)
# =============================================================================

migrate-up:
	set -a && [ -f .env.development ] && . ./.env.development; set +a && node scripts/apply-migration.mjs local

migrate-local: migrate-up

# psql + wise_spliter.schema_migrations ledger; never touches the shared supabase_migrations history.
migrate-remote:
	@test -f .env.production || { echo "ERROR: .env.production not found. Copy .env.example -> .env.production and set SUPABASE_DB_URL."; exit 1; }
	set -a && . ./.env.production && set +a && node scripts/apply-migration.mjs remote

migrate-verify:
	set -a && [ -f .env.development ] && . ./.env.development; set +a && node scripts/apply-migration.mjs verify

migrate-verify-prod:
	@test -f .env.production || { echo "ERROR: .env.production not found."; exit 1; }
	set -a && . ./.env.production && set +a && node scripts/apply-migration.mjs verify

migrate-sql:
	@node scripts/apply-migration.mjs remote --print-sql

migrate-docker:
	node scripts/apply-migration.mjs --print-script --local | $(COMPOSE) --profile migrate run --rm -T --entrypoint psql migrate \
	  -X -q -h host.docker.internal -p $(or $(shell sed -n 's/^SUPABASE_DB_PORT=//p' .env.development 2>/dev/null),54322) -U postgres -d postgres


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

deploy-pyrite:
	bash scripts/deploy-to-pyrite.sh


# =============================================================================
# Help
# =============================================================================

help:
	@echo "Wise-Spliter Build, Database & Run Commands:"
	@echo "  make dev             - Ensure centralized Supabase is up, apply wise_spliter schema, seed dev users, and start API (4174) + UI (4173)"
	@echo "  make setup-dev       - Ensure Supabase + migrations and provision dev users & ledger seed in wise_spliter"
	@echo "  make reset-dev-data  - LOCAL ONLY: delete test/e2e groups and bills piled on the dev profiles (keeps the last 30 min), re-seed, reset their quotas"
	@echo "  make dev-ui          - Start API (4174) + UI (4173) directly without re-running supabase-ensure"
	@echo "  make api             - Run Backend API service on http://localhost:$(API_PORT)"
	@echo "  make supabase-up     - Start centralized Supabase in $(SUPABASE_DIR)"
	@echo "  make supabase-status - Check centralized Supabase status"
	@echo "  make migrate-up      - Apply pending supabase/migrations/*.sql locally (wise_spliter.schema_migrations ledger) and verify"
	@echo "  make migrate-remote  - Apply pending migrations to SUPABASE_DB_URL via psql (own ledger table, no supabase db push)"
	@echo "  make migrate-verify  - Verify local wise_spliter tables, FORCE RLS & RPCs (-prod for hosted)"
	@echo "  make migrate-sql     - Print combined idempotent SQL for zero-credential Supabase Dashboard paste"
	@echo "  make apk             - Build installable Android APK (releases/wise-spliter.apk) via Docker or host SDK"
	@echo "  make apk-prod        - Build installable Android APK using VITE_API_BASE_URL from .env.production"
	@echo "  make deploy-pyrite   - Build & push stateless Backend API image (linux/amd64) for Pyrite Cloud"
	@echo "  make docker-up-dev   - Run full stack in Docker development containers"
	@echo "  make test            - Run unit and property-based tests (Vitest + fast-check)"
	@echo "  make e2e             - Run Playwright end-to-end verification suite (headless); pass flags via E2E_ARGS=\"-g 'User Story 1'\""
	@echo "  make e2e-headed      - Same suite in a visible browser window (add E2E_ARGS to pick specs or tests)"
	@echo "  make e2e-ui          - Playwright UI mode: pick tests, step through, time-travel debugging"
	@echo "  make typecheck       - Run strict TypeScript compiler checks"
	@echo "  make build           - Build production bundle"
	@echo "  make stop            - Free ports $(APP_PORT) and $(API_PORT)"
