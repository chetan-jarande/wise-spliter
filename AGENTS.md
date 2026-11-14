# AGENTS.md - Wise-Spliter Operating Rules

> Always-on directives. Read [coding-standards.md](./docs/coding-standards.md) before modifying code (authoritative rules & rationale) and [architecture.md](./docs/architecture.md) for the 5-layer topology.

## 1. Reasoning, Feasibility & Architecture Gate
- **Challenge First:** Never follow instructions blindly. Evaluate feasibility, edge cases, and $10^6$-user scale impact before coding; use `brainstorming` + `ponytail` to propose simpler, faster, or safer alternatives with explicit trade-offs.
- **Facts Over Assumptions:** Verify behavior from source code, live DB checks, and current official docs (`React 19`, `TS 5.8`, `Vite 6`, `Tailwind v4`, `Dexie 4`, `@supabase/supabase-js v2` via `find-docs`, `context7-cli`, `web_fetch`, `supabase`). Ask the user when requirements, credentials, or tools are missing.
- **Architecture Lockstep:** Justify any topology, schema, sync, or auth change to the user **before** coding, and update affected [docs/](./docs) specs in the same task.

## 2. Grandmaster Code Quality & $10^6$-User Scale
- **Minimal Code, Full Boundary Coverage:** Shortest deterministic diff covering `0`, negatives, ties, `> 2^53` `BigInt`, and malformed inputs at optimal complexity ($O(n \cdot 2^n)$ Bitmask-DP $n \le 16$; $O(n \log n)$ Hamilton/greedy).
- **Strict TypeScript:** `strict: true`, `noUncheckedIndexedAccess: true`; zero `any`, `@ts-ignore`, or `@deprecated` symbols ([check-deprecations.mjs](./scripts/check-deprecations.mjs)). Keep [src/domain/](./src/domain) 100% pure.
- **Scale Non-Negotiables:** Keep [src/server/](./src/server) stateless. Ban unbounded `SELECT *`, JS cross-tenant filtering, and unbounded in-memory `Map` caches; require indexed SQL predicates + cursor pagination (`server_seq > $cursor LIMIT $n`) and `< 1ms` local Dexie writes (`syncOutbox`).

## 3. Money, Security & Multi-Platform Invariants
- **Zero-Float Money:** Exact `BigInt` minor units across `0/2/3`-decimal currencies ([currencies.ts](./src/domain/money/currencies.ts)), frozen rotating remainders, `sum(payers) === amountMinor === sum(included splits)`, and group `sum(net) === 0n`.
- **Tenant Security (`wise_spliter`):** Keep `SUPABASE_SECRET_KEY` & `GRANT_TOKEN_SECRET` server-only; never import `dev-profiles.ts` in `src/ui/`. Preserve `FORCE ROW LEVEL SECURITY` (`removed_at IS NULL`) across all 8 tables and `service_role`-only RPCs ([0002_wise_spliter_security_hardening.sql](./supabase/migrations/0002_wise_spliter_security_hardening.sql)).
- **Single App (Web, Android, iOS, Desktop):** Pure Vite + Capacitor/Tauri bundle; route all API calls via `resolveApiUrl('/api/...')` in [supabase-sync.ts](./src/sync-engine/supabase-sync.ts).

## 4. UI Pattern Reference Map (Reuse - Never Duplicate)
| Concern | Canonical File | Mandatory Constraint |
|---|---|---|
| Tokens & Fonts | `design-system/wise-spliter/MASTER.md`, `src/index.css` | `Plus Jakarta Sans` + `JetBrains Mono` (`tabular-nums`); Light/Dark parity |
| Primitives | `src/ui/primitives/DesignPrimitives.tsx` | Reuse `DoubleBezelCard`, `StatusBadge`, `CurrencyAmount`, `PersonalExpenseImpactBadge` |
| Shell & Mobile | `src/App.tsx` | `<= 5` nav tabs, `>= 44x44px` targets, mobile FAB, responsive `375px -> 1440px` |
| Calm Disclosure | `src/ui/pages/HomeDashboardPage.tsx`, `src/ui/pages/GroupsLedgerPage.tsx` | Plain-English verdict first, `<= 3` recent groups, `<details class="ws-disclosure">` for HLC/math |
| Modals & Auth | `src/ui/modals/ExpenseEditorModal.tsx`, `src/ui/modals/DevAuthModal.tsx` | Quick presets, live split sentence, calm `0.00` bar; Demo + Google + Email auth |
| Copy & Selectors | `tests/e2e/wise-spliter.spec.ts` | Phosphor `*Icon` only; **zero `U+2014`/`U+2013` dashes**; preserve all `data-testid`s |

## 5. Independent Verification Council & DoD
- **Builder != Verifier:** Builders must NOT self-certify tests. Run [ORCHESTRATOR.md](./agents/ORCHESTRATOR.md) (`node agents/orchestrate-personas.mjs --phase all`) to dispatch `test-author-e2e`, `red-team-hacker`, and `ux-performance-breaker` -> adjudicated by `fact-checker-arbiter`.
- **Git & Gates:** Sole author `Chetan Jarande <chetanjarande@gmail.com>`; **zero `Co-authored-by:` lines**; commit only when asked. All 5 gates must exit `0`: `make typecheck && make migrate-verify && make test && make build && make e2e`.


