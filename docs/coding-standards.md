# Wise-Spliter: Engineering & Coding Standards

**Related Specifications:**
* [System Architecture & Topology](./architecture.md)
* [Technical Architecture & Financial Algorithms](./technical-spec.md)
* [Database Schema, Offline Sync & Security Specification (`wise_spliter`)](./database-and-sync-spec.md)

---

## 1. Core Engineering Philosophy

1. **Facts Over Assumptions:**
   * Every architectural, schema, and financial decision must be grounded in verified repository state, deterministic math, and live database/API checks. Never assume a schema exists, a port is free, or floating-point rounding is "close enough."
2. **Zero Floating-Point Money Math:**
   * Standard IEEE-754 floating-point division (`number` arithmetic for currency allocation) is strictly forbidden. All monetary values are represented, split, converted, and persisted as exact integer minor units (`BigInt` in domain algorithms, `BIGINT` in PostgreSQL).
3. **Modular, Pure & Reusable Components:**
   * Domain algorithms in `src/domain/` must remain 100% pure TypeScript functions with zero React, DOM, or network dependencies so they can be fuzz-tested in isolation at 10,000+ iterations.
   * UI primitives (`DoubleBezelCard`, `StatusBadge`, modals, drawers) must be composable and driven by typed props rather than duplicated markup.
4. **Progressive Disclosure UX:**
   * Keep primary views calm, scannable, and uncluttered. The Home Dashboard displays at most `<= 3` recently accessed/updated groups (`Top-3 Recent Groups`) alongside a fast **Quick Add Expense** trigger (supporting both direct non-group splits and group bills). Advanced provenance equations, revision diffs, and onboarding guidance open on demand.
5. **Strict Anti-Slop Visual Craft:**
   * Every screen must look like an institutional-grade consumer fintech product: crisp 1px borders, tactile Double-Bezel cards, tabular monospace figures, high-contrast semantic badges, and full Light/Dark theme parity.

---

## 2. Code-Level Standards

### 2.1 TypeScript Strictness & Domain Modeling
* **Compiler Flags (`tsconfig.json`):**
  * `strict: true` and `noUncheckedIndexedAccess: true` are mandatory and must never be weakened.
  * `any`, `@ts-ignore`, and `@ts-expect-error` are banned. Narrow unknown inputs using explicit type guards.
* **Canonical Type Definitions (`src/types/ledger.ts`):**
  * All shared domain contracts (`CurrencyDefinition`, `SplitMode`, `FxStatus`, `AdHocParticipant`, `GroupRecord`, `GroupMember`, `ExpenseItem`, `ExpenseRevision`, `SettlementItem`, `GroupActivityItem`, `MemberBalanceExplanation`) live in `src/types/ledger.ts`.
  * Nullable foreign keys (such as `groupId: string | null` on `ExpenseItem` for direct non-group splits) must be explicitly typed and handled in every consumer.

### 2.2 Financial & Mathematical Invariants
* **Minor-Unit Representation Across `0, 2, 3` Decimal Currencies:**
  * Every ISO-4217 currency defines `decimals: 0 | 2 | 3` (`JPY = 0`, `INR/USD/EUR = 2`, `KWD/BHD/OMR = 3`).
  * Convert major-unit user strings to minor units exclusively via string splitting and digit padding (`parseMajorToMinor`), never `Math.round(parseFloat(val) * 100)`.
* **Frozen Stateless Rotating Remainders:**
  * When an equal or weighted split has an indivisible remainder $r = T \bmod k$, distribute $+1$ minor unit deterministically starting at offset $s = \text{rotation\_seed} \bmod k$.
  * Freeze the resulting `owedMinor` and `remainderMinor` inside `expense.splits` at save time so deleting or editing another bill never mutates historical paise/cents.
* **Hard Conservation Laws (Verified on Client & Backend API):**
  * **Payer Conservation:** $\sum_{p \in \text{payers}} p.\text{paidMinor} === \text{expense.amountMinor}$
  * **Split Conservation:** $\sum_{s \in \text{splits}, s.\text{included}} s.\text{owedMinor} === \text{expense.amountMinor}$
  * **Zero-Sum Group Ledger:** $\sum_{m \in \text{group}} \text{NetBalance}(m) === 0\text{n}$
  * **Percentage Basis Points:** In `percentage` split mode, included member basis points must sum to `10000` (`100.00%`).

### 2.3 UI/UX, Typography & Accessibility Rules
* **Iconography:**
  * Use `@phosphor-icons/react` exclusively (`duotone`, `regular`, `bold`, `fill` weights). Do not mix icon libraries or use raw unlabelled emojis as primary interactive controls.
* **Typography & Numeric Alignment:**
  * Primary UI & display font: `'Plus Jakarta Sans'`.
  * Financial amounts, exchange rates, HLC clocks, and equations: `'JetBrains Mono'` with `font-variant-numeric: tabular-nums` (`tabular-nums` class) so decimal columns align vertically to the pixel.
* **Strict Punctuation Hygiene (Zero Em/En-Dashes):**
  * Never render em-dashes (`—`) or en-dashes (`–`) in UI copy, labels, activity logs, or error messages. Use standard ASCII hyphens (`-`), colons (`:`), or bullets (`•`).
* **Double-Bezel Card Architecture:**
  * Surface containers use a two-layer bezel structure (`ws-bezel-outer` wrapping `ws-bezel-inner`) with subtle 1px structural borders and clean spatial hierarchy instead of heavy drop shadows or neon gradients.
* **Accessibility & Mobile Ergonomics:**
  * Every icon-only button must include an explicit, descriptive `aria-label`.
  * Mobile bottom navigation must contain `<= 5` top-level items with touch hit targets `>= 44px x 44px`.
  * Every component must maintain WCAG AA contrast across both **Light Mode** (`data-theme="light"`) and **Dark Mode** (`data-theme="dark"`).

### 2.4 Security & Database Isolation Rules
* **Server-Only Secret Key (`SUPABASE_SECRET_KEY`):**
  * `SUPABASE_SECRET_KEY` (`service_role`) must only be read inside server-side code (`src/server/index.ts`, `src/server/supabaseAdmin.ts`, and CLI scripts in `scripts/`).
  * Never prefix secret keys with `VITE_` or bundle them into client code.
* **Dedicated PostgreSQL Schema (`wise_spliter`):**
  * All database objects live inside `CREATE SCHEMA IF NOT EXISTS wise_spliter;`. Never create tables or functions in `public`.
  * Enforce `REVOKE ALL ON SCHEMA wise_spliter FROM PUBLIC, anon;` and enable Row-Level Security (`ALTER TABLE ... ENABLE ROW LEVEL SECURITY;`) on every table in `wise_spliter`.
  * All PostgREST calls from `src/server/supabaseAdmin.ts` must explicitly set `Accept-Profile: wise_spliter` and `Content-Profile: wise_spliter`.
  * Database readiness and delta synchronization use the dedicated schema RPCs: `wise_spliter.schema_health()`, `wise_spliter.push_mutations`, and `wise_spliter.pull_changes`.
* **Receipt Image & Bill Attachment Storage Rules:**
  * **Offline / Local Device:** Compressed WebP images are stored immediately in the Dexie.js IndexedDB table `local_receipt_blobs` so receipt attachments work 100% offline during flights and trips.
  * **Online / Centralized & Cloud Supabase:** Uploaded via the Backend API Service (`POST /api/receipts/upload` on `:4174`) to the private **Supabase Storage bucket `wise-spliter-receipts`** at path `{group_id_or_direct}/{expense_id}/{receipt_id}.webp`, with structured metadata recorded in `wise_spliter.receipt_attachments` and `wise_spliter.expenses.receipts`.
* **XSS & Code Execution Prevention:**
  * Never use `eval()`, `new Function()`, or `dangerouslySetInnerHTML`. All imported CSV/JSON/backup payloads must be parsed as structured data and validated before rendering.

### 2.5 Git Author & Commit Hygiene Rule
* **Sole Author on All Commits:** Every commit in this repository must be authored exclusively by:
  * `Chetan Jarande <chetanjarande@gmail.com>`
* **Zero Co-Author Trailers:** Never include `Co-authored-by:` trailers (or any AI/assistant attribution trailers) in commit messages.
* **Canonical Remote Repository:** `https://github.com/chetan-jarande/wise-spliter`

---

## 3. Definition of Done (DoD) & Mandatory Verification Workflow

No feature, bugfix, or schema change is considered complete until all 5 verification gates pass sequentially with zero errors:

### Step 1: Strict Static Type Verification
```bash
make typecheck
```
* **Requirement:** `tsc --noEmit` must exit with `0` TypeScript errors across client, domain, storage, server, and test files.

### Step 2: Unit, Property-Based (`fast-check`) & IndexedDB Test Suite
```bash
make test
```
* **Requirement:** `100%` of Vitest suites must pass, including:
  * `fast-check` property-based fuzz tests verifying split conservation, rotating remainder fairness, zero-sum group balances, and Bitmask-DP debt simplification completeness across `0, 2, 3` decimal currencies.
  * Local-first `IndexedDB` (`Dexie.js`) persistence, `syncOutbox` FIFO queueing, and HLC conflict detection tests.

### Step 3: Centralized Supabase Schema & RPC Verification
```bash
make migrate-verify
```
* **Requirement:** Runs `node scripts/apply-migration.mjs verify` against the centralized Supabase instance (`SUPABASE_DIR = /home/chetan/projects/my-scripts/setup/dependencies`), confirming `PASS` for all 7 tables (`profiles`, `groups`, `group_members`, `expenses`, `expense_revisions`, `settlements`, `group_activity_log`) and `wise_spliter.schema_health()` RPC over PostgREST.

### Step 4: Clean Production Bundle Build
```bash
make build
```
* **Requirement:** Produces a clean, warning-free production build in `dist/` after passing strict typechecking.

### Step 5: Live End-to-End Playwright Acceptance Suite
```bash
make e2e
```
* **Requirement:** `100%` of Playwright E2E acceptance tests pass against the live running application, verifying:
  * Minimalist Home Dashboard (`<= 3` recent groups) and Quick-Add Expense for both Group Bills and Direct Non-Group Splits (`group_id = null`).
  * Equal, Exact, Percentage, Shares, and Adjustment splits with rotating remainder fairness.
  * Bitmask-DP simplified vs. raw pairwise debt toggles and "Explain This Balance" lineage drawers.
  * Per-expense immutable revision history, concurrent offline conflict resolution, and Trash recovery.
  * UPI deep-link / QR modal generation, WhatsApp summary export, Splitwise CSV/JSON import, and AES-256-GCM encrypted backup round-trips.
