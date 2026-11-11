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

### 2.1 TypeScript Strictness, Zero-Deprecation Policy & Domain Modeling
* **Compiler Flags (`tsconfig.json`):**
  * `strict: true` and `noUncheckedIndexedAccess: true` are mandatory and must never be weakened.
  * `any`, `@ts-ignore`, and `@ts-expect-error` are banned. Narrow unknown inputs using explicit type guards.
* **Zero-Deprecation Policy (`scripts/check-deprecations.mjs`):**
  * `make typecheck` executes both `tsc --noEmit` and `node scripts/check-deprecations.mjs` (TypeScript Language Service suggestion diagnostics `reportsDeprecated`, `TS6385`, and `TS6387`). Zero `@deprecated` APIs, symbols, or overloads are permitted anywhere in the repository:
    * **Phosphor Icons (`@phosphor-icons/react`):** Always import canonical `*Icon` symbols (e.g., `HouseIcon as House`, `ReceiptIcon as Receipt`) rather than deprecated bare component aliases.
    * **React 19 Form Events:** Type form submission handlers with `React.SyntheticEvent<HTMLFormElement>` rather than deprecated `React.FormEvent<HTMLFormElement>`.
    * **Pure `Uint8Array` Base64 Encoding/Decoding:** Implement binary-to-base64 and base64-to-binary helpers (`bytesToBase64` / `base64ToBytes` in `src/portability/portability-engine.ts`) using pure bitwise `Uint8Array` operations rather than deprecated DOM `btoa` / `atob` binary-string helpers.
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

### 2.4 Security, Official `@supabase/supabase-js` SDK Pattern & Database Isolation Rules
* **Official `@supabase/supabase-js` Client/Server Pattern (Modeled on `merry-tools`):**
  * **Server Admin Client (`src/server/supabaseAdmin.ts`):** Instantiates a process-wide singleton via `createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, db: { schema: SUPABASE_SCHEMA } })`. All table queries (`.from(...).select/upsert`), RPC invocations (`.rpc('schema_health' | 'pull_changes' | 'push_mutations')`), and Storage operations (`.storage.from('wise-spliter-receipts').upload(...)`) go through the official SDK.
  * **Browser Sync Client (`src/sync-engine/supabase-sync.ts`):** Instantiates a public browser client via `createClient(VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY, { db: { schema: 'wise_spliter' }, auth: { persistSession: true, autoRefreshToken: true } })` for Google OAuth (`signInWithOAuth`) and session management while routing mutations through the authenticated Backend API Gatekeeper (`/api/*`).
  * **Environment Configuration (`.env.example`, `.env.development`, `.env.production`):** Follows the `merry-tools` convention where server-only secrets (`SUPABASE_SECRET_KEY`, `GRANT_TOKEN_SECRET`, `ALLOWED_ORIGINS`) have no prefix, and only public browser keys (`VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_SUPABASE_ANON_KEY`, `VITE_SUPABASE_SCHEMA`, `VITE_API_BASE_URL`) are prefixed with `VITE_`.
* **Server-Only Secret Key (`SUPABASE_SECRET_KEY`):**
  * `SUPABASE_SECRET_KEY` (`service_role` / `sb_secret_...`) must only be read inside server-side code (`src/server/index.ts`, `src/server/supabaseAdmin.ts`, and CLI scripts in `scripts/`).
  * Never prefix secret keys with `VITE_` or bundle them into client code.
* **Backend Authentication (`HTTP 401`) & User/Group Isolation (`HTTP 403` IDOR Protection in `src/server/securityAndAuth.ts`):**
  * **Authentication (`HTTP 401`):** Every `/api/ledger/*` and `/api/receipts/*` endpoint verifies the caller via `verifyRequestAuth(req)`, accepting either an HMAC-SHA256 session token issued by `POST /api/auth/session` (signed with `GRANT_TOKEN_SECRET` using timing-safe comparison) or an official Supabase Auth JWT verified via `getSupabaseAdmin().auth.getUser(token)`. Missing, expired, or tampered tokens are rejected with `HTTP 401`.
  * **Authorization & IDOR Prevention (`HTTP 403`):**
    * `filterDatasetForUser(dataset, user)` scopes `GET /api/ledger/bootstrap` and `GET /api/ledger/pull-changes` so users only receive groups where they are a member (`userId` or `invitedEmail`) and standalone direct splits (`groupId === null`) where `adHocParticipants` includes their identity.
    * `authorizeDatasetSyncForUser(dataset, existingDbGroups, user)` enforces 4 strict rules on `POST /api/ledger/sync`, `POST /api/ledger/push-mutations`, and `POST /api/receipts/upload`: (1) Anti-Impersonation (`currentUser` must match the authenticated token), (2) Group Membership Requirement, (3) Existing DB Group Ownership Protection (blocks non-members from hijacking existing group IDs), and (4) Expense Scope Protection. Violations are rejected with `HTTP 403`.
  * **Hardening (`buildSecurityHeaders` & `checkRateLimit`):** Every response includes strict security headers (`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Cross-Origin-Resource-Policy: same-origin`, `Permissions-Policy`, and allowlisted CORS) plus fixed-window per-IP rate limiting (`HTTP 429` with `Retry-After`).
* **Dedicated PostgreSQL Schema (`wise_spliter`):**
  * All database objects live inside `CREATE SCHEMA IF NOT EXISTS wise_spliter;`. Never create tables or functions in `public`.
  * Enforce `REVOKE ALL ON SCHEMA wise_spliter FROM PUBLIC, anon;` and enable Row-Level Security (`ALTER TABLE ... ENABLE ROW LEVEL SECURITY;`) on every table in `wise_spliter`.
  * All PostgREST calls from `src/server/supabaseAdmin.ts` bind to schema `wise_spliter` via `db: { schema: SUPABASE_SCHEMA }` (`Accept-Profile: wise_spliter` and `Content-Profile: wise_spliter`).
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

### Step 1: Strict Static Type & Zero-Deprecation Verification
```bash
make typecheck
```
* **Requirement:** `tsc --noEmit && node scripts/check-deprecations.mjs` must exit with `0` TypeScript errors and `0` deprecated symbol diagnostics across all client, domain, storage, server, and test files.

### Step 2: Unit, Property-Based (`fast-check`), IndexedDB & Security Test Suite (15 Tests)
```bash
make test
```
* **Requirement:** `100%` of Vitest suites (`tests/unit/domain-and-portability.test.ts` - 15 tests) must pass, including:
  * `fast-check` property-based fuzz tests verifying split conservation, rotating remainder fairness, zero-sum group balances, and Bitmask-DP debt simplification completeness across `0, 2, 3` decimal currencies.
  * Local-first `IndexedDB` (`Dexie.js`) persistence, `syncOutbox` FIFO queueing, offline WebP receipt blobs (`localReceiptBlobs`), and multi-sheet `.xlsx` / `.pdf` binary generation tests.
  * Backend authentication (`issueSessionToken` / `verifyRequestAuth` `HTTP 401`) and user/group isolation (`authorizeDatasetSyncForUser` / `filterDatasetForUser` `HTTP 403` IDOR protection) unit tests.

### Step 3: Centralized Supabase Schema & RPC Verification
```bash
make migrate-verify
```
* **Requirement:** Runs `node scripts/apply-migration.mjs verify` against the centralized Supabase instance (`SUPABASE_DIR = /home/chetan/projects/my-scripts/setup/dependencies`), confirming `PASS` for all 8 tables (`profiles`, `groups`, `group_members`, `expenses`, `expense_revisions`, `settlements`, `group_activity_log`, `receipt_attachments`) and all 3 `wise_spliter` RPCs (`schema_health`, `pull_changes`, `push_mutations`) over PostgREST.

### Step 4: Clean Production Bundle Build
```bash
make build
```
* **Requirement:** Produces a clean, warning-free production build in `dist/` after passing strict typechecking and deprecation checks.

### Step 5: Live 6-Story End-to-End Playwright Acceptance Suite (`tests/e2e/wise-spliter.spec.ts`)
```bash
make e2e
```
* **Requirement:** All 6 full-stack Playwright E2E user stories in `tests/e2e/wise-spliter.spec.ts` must pass against the live running application (UI `:4173` + Backend API `:4174` + Supabase `:54321`):
  1. **User Story 1:** Minimalist Home Dashboard (`<= 3` recent groups), Contextual Page Guide (`ContextualPageGuideBanner`), Interactive Help Modal (`HelpGuideModal`), and Direct Non-Group Split Flow (`group_id = null` with custom `ad_hoc_participants`) synced via `POST /api/ledger/sync`.
  2. **User Story 2:** Progressive Group Workspace (`group-minimal-insights-bar` + `group-auto-guide-strip`), Concurrent Offline Conflict Resolution (`conflict-resolution-banner`), `ExplainBalanceModal` mathematical lineage, all 5 Split Modes (`equal`, `exact`, `percentage`, `shares`, `adjustment`), Multi-Payer toggle, Foreign FX conversion, Rotating Remainder (`+1 paise/cents rotated`), and WebP Receipt Upload (`POST /api/receipts/upload`).
  3. **User Story 3:** Group Management - Debt Simplification toggle (`ON`/`OFF`), Base Currency Re-denomination (`relabel` / `reconvert`), Instant Unclaimed Member addition & claim flow, and New Group creation synced to Supabase.
  4. **User Story 4:** Transparent Activity History (Group vs. Global scope), Per-Expense Immutable Revision History inspector with 1-click revision restore, and Trash Recovery Vault restore.
  5. **User Story 5:** Friends Cross-Group Net Balances, 1-Tap Atomic Batch Settle Up across groups, UPI Deep-Link / QR Code Studio (`upi://pay?`), and WhatsApp Summary export.
  6. **User Story 6:** Insights & Global Search across `0, 2, 3` decimal currencies (`JPY`, `INR`, `KWD`), Portability (`Splitwise CSV import`, `.xlsx`, `.pdf`, `PBKDF2 + AES-256-GCM` `.wisesplit` backup round-trip), and live Backend API Security Isolation (`HTTP 401` unauthenticated rejection + `HTTP 403` cross-user impersonation & group hijack rejection).
