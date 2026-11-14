# Wise-Spliter Multi-Agent Verification Council (`agents/ORCHESTRATOR.md`)

Enforces **Builder != Verifier**: the agent writing feature code never self-certifies tests. After baseline gates pass, `agents/orchestrate-personas.mjs` dispatches **3 Phase-A specialist personas in parallel**, followed by **1 Phase-B arbiter** that verifies every claim against live output and casts the binding `SHIP` / `BLOCK` vote.

## 1. Persona Roster

| Phase | Persona ID | Prompt Spec | Skills | Scope & Output |
|---|---|---|---|---|
| **A (Parallel)** | `test-author-e2e` | [`personas/test-author-e2e.md`](./personas/test-author-e2e.md) | `test-driven-development`, `verification-before-completion` | Writes independent E2E user journeys (`tests/e2e/`) & `fast-check` edge cases (`tests/unit/`); never edits `src/**` |
| **A (Parallel)** | `red-team-hacker` | [`personas/red-team-hacker.md`](./personas/red-team-hacker.md) | `security-and-hardening`, `security-review`, `supabase` | Probes auth forgery, IDOR, PK overwrite, CSRF, path traversal & PostgREST `:54321`; writes PoCs in `tests/unit/security-breach.test.ts` |
| **A (Parallel)** | `ux-performance-breaker` | [`personas/ux-performance-breaker.md`](./personas/ux-performance-breaker.md) | `ui-ux-pro-max`, `ponytail-review`, `investigate-first` | Read-only audit of zero-knowledge UX, `375px` mobile usability, $10^6$-user DB/algo scale bottlenecks & code bloat |
| **B (Arbiter)** | `fact-checker-arbiter` | [`personas/fact-checker-arbiter.md`](./personas/fact-checker-arbiter.md) | `verification-before-completion`, `receiving-code-review` | Re-runs commands, rejects unverified opinions, checks [`docs/`](../docs) lockstep sync & tallies final `SHIP` / `BLOCK` |

## 2. Commands

```bash
make verify-agents                                                       # Validate AGENTS.md budget + persona specs
node agents/orchestrate-personas.mjs --phase all                         # Run all 5 deterministic gates + ready persona packets
node agents/orchestrate-personas.mjs --phase prompts --persona red-team-hacker
node agents/orchestrate-personas.mjs --phase evaluate --report /tmp/persona-report.json
```

## 3. Quorum Rules
- **Immediate `BLOCK`:** Any failing deterministic gate (`typecheck`, `migrate-verify`, `test`, `build`, `e2e`) OR `>= 1` `CRITICAL`/`HIGH` finding verified by `fact-checker-arbiter` with a `file:line` + reproducible proof.
- **Evidence Filter:** Claims lacking `file:line` and runnable proof are marked `REJECTED_FALSE_POSITIVE`.
- **`SHIP` Threshold:** `5/5` gates green + `0` verified `CRITICAL`/`HIGH` blockers + `>= 3/4` `SHIP` votes (including `fact-checker-arbiter`).

