.PHONY: help install dev start build preview test e2e typecheck clean

PORT ?= 4173

help:
	@echo "Wise-Spliter Build & Run Commands:"
	@echo "  make install    - Install project dependencies via Bun"
	@echo "  make dev        - Start local development server on http://localhost:$(PORT)"
	@echo "  make start      - Build and start production preview server on http://localhost:$(PORT)"
	@echo "  make build      - Run TypeScript check and build production bundle"
	@echo "  make test       - Run unit and property-based tests (Vitest + fast-check)"
	@echo "  make e2e        - Run Playwright end-to-end verification suite"
	@echo "  make typecheck  - Run strict TypeScript compiler checks"
	@echo "  make clean      - Remove build artifacts and test reports"

install:
	bun install

dev:
	bun run dev --port $(PORT)

start: build
	bun run start --port $(PORT)

build:
	bun run build

test:
	bun run test

e2e:
	bun run e2e

typecheck:
	bun run typecheck

clean:
	rm -rf dist test-results playwright-report
