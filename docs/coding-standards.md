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
* **Server-Only Secret Key (`SUPABASE_SECRET_KEY`) & Dev Seed Profiles (`src/data/dev-profiles.ts`):**
  * `SUPABASE_SECRET_KEY` (`service_role` / `sb_secret_...`) must only be read inside server-side code (`src/server/index.ts`, `src/server/supabaseAdmin.ts`, and CLI scripts in `scripts/`).
  * `src/data/dev-profiles.ts` is strictly a server/CLI seed module used by `make setup-dev` (`scripts/setup-dev-user.mjs`) to provision the 3 development accounts (`arjun.mehta@gmail.com`, `rohan.verma@gmail.com`, `priya.nair@gmail.com`) in Supabase Auth (`auth.users`) and `wise_spliter.profiles`. Never import `dev-profiles.ts` or hardcode passwords inside `src/ui/` or any browser component.
  * Never prefix secret keys with `VITE_` or bundle them into client code.
* **Backend Authentication (`HTTP 401`), Demo Sandbox (`POST /api/auth/demo`), Google OAuth (`POST /api/auth/google`), Login (`POST /api/auth/login`) & Multi-Tenant Isolation (`HTTP 403` IDOR Protection in `src/server/securityAndAuth.ts`):**
  * **1-Tap Demo Sandbox (`POST /api/auth/demo`), Google OAuth (`POST /api/auth/google`) & Email Login (`POST /api/auth/login` in `DevAuthModal.tsx`):** Clicking `header-user-pill` opens `DevAuthModal`, providing (a) 1-tap Demo Sandbox login (`demo-profile-login-btn` -> `POST /api/auth/demo`, restricted strictly to `usr_arjun_01`), (b) Google OAuth 2.0 redirect (`dev-google-oauth-btn` -> GoTrue OAuth -> `LedgerContext` `onAuthStateChange` -> `POST /api/auth/google` verifying `auth.getUser(accessToken)` and auto-claiming matching `invited_email` group members), and (c) backend-validated email/password login (`POST /api/auth/login` guarded by brute-force rate limiting). `POST /api/auth/session` rejects any unauthenticated non-demo session minting request with `HTTP 401`.
  * **Authentication (`HTTP 401`):** Every `/api/ledger/*` and `/api/receipts/*` endpoint verifies the caller via `verifyRequestAuth(req)`, accepting an `HttpOnly; SameSite=Lax; Path=/api` `ws_session` cookie (cleared via `POST /api/auth/logout`), an `Authorization: Bearer` HMAC-SHA256 session token (for native Capacitor/Tauri shells, verified via `timingSafeEqual`), or an official Supabase Auth JWT verified via `getSupabaseAdmin().auth.getUser(token)`. Missing, expired, or tampered tokens are rejected with `HTTP 401`.
  * **Authorization, Active Membership & Entity-PK Ownership Prevention (`HTTP 403`):**
    * `filterDatasetForUser(dataset, user)` scopes `GET /api/ledger/bootstrap` and `GET /api/ledger/pull-changes` so users only receive groups where they are an active member (`removed_at IS NULL`) and standalone direct splits (`groupId === null`) where `adHocParticipants` includes their identity.
    * `authorizeDatasetSyncForUser`, `authorizeMutationsForUser`, and `authorizeReceiptUploadForUser` enforce 5 strict rules across `POST /api/ledger/sync`, `POST /api/ledger/push-mutations`, and `POST /api/receipts/upload`: (1) Anti-Impersonation (`currentUser` must match the authenticated token), (2) Active Group Membership (`removed_at IS NULL`), (3) Existing DB Group Ownership Protection, (4) Expense Scope Protection, and (5) Cross-Tenant Entity PK Ownership & Storage Path-Traversal Protection (`/^[a-zA-Z0-9_-]{1,80}$/`). Violations are rejected with `HTTP 400` / `HTTP 403`.
  * **Hardening (`buildSecurityHeaders`, `validateCsrfAndOrigin`, Body Caps & `checkRateLimit`):** Binds to `127.0.0.1:4174` by default, rejects untrusted cross-site `Origin` / `Sec-Fetch-Site` state-mutating requests with `HTTP 403` (while permitting `capacitor://localhost` & `tauri://localhost`), caps request body size (`HTTP 413`), enforces production secret fail-fast guards, and gates `X-Forwarded-For` behind `TRUST_PROXY=true`.
* **Dedicated PostgreSQL Schema (`wise_spliter` — `0001` & `0002` Migrations):**
  * All database objects live inside `CREATE SCHEMA IF NOT EXISTS wise_spliter;`. Never create tables or functions in `public`.
  * Enforce `REVOKE ALL ON SCHEMA wise_spliter FROM PUBLIC, anon;`, `FORCE ROW LEVEL SECURITY` on all 8 tables with `(SELECT auth.uid())` active-membership policies, and `REVOKE EXECUTE` on `SECURITY DEFINER` RPCs (`schema_health`, `push_mutations`, `pull_changes`) from `PUBLIC, anon, authenticated` so only `service_role` can invoke them (`supabase/migrations/0002_wise_spliter_security_hardening.sql`).
  * All PostgREST calls from `src/server/supabaseAdmin.ts` bind to schema `wise_spliter` via `db: { schema: SUPABASE_SCHEMA }` (`Accept-Profile: wise_spliter` and `Content-Profile: wise_spliter`).
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

### Step 2: Unit, Math Scenario, Property-Based (`fast-check`), IndexedDB & Red-Team Security Suite (47 Tests)
```bash
make test
```
* **Requirement:** `100%` of Vitest suites (`tests/unit/domain-and-portability.test.ts` - 15 tests, `tests/unit/math-engine-scenarios.test.ts` - 21 tests, and `tests/unit/security-breach.test.ts` - 11 tests; **47 tests total**) must pass, including:
  * `fast-check` property-based fuzz suites (1,600+ randomized cases) verifying split conservation, rotating remainder fairness, intra-bill net surplus/deficit bilateral debt conservation, $O(n \cdot 2^n)$ `BigInt` Bitmask-DP ($n \le 16$) vs. Greedy ($n > 16$), and currency re-denomination invariants across `0, 2, 3` decimal currencies.
  * Local-first `IndexedDB` (`Dexie.js`) persistence, `syncOutbox` FIFO queueing, offline WebP receipt blobs (`localReceiptBlobs`), formula-injection-safe `.csv`/`.xlsx`, and `.pdf` binary generation tests.
  * Red-team breach tests verifying `HTTP 401` on unauthenticated `/api/auth/session` impersonation and forged JWTs, `HTTP 403` on cross-site CSRF, cross-tenant PK overwrites, soft-removed member access, and `../` receipt path traversal, `HTTP 413` on oversized bodies, and direct PostgREST `:54321` `anon`/`authenticated` RPC lockdown.

### Step 3: Centralized Supabase Schema, `FORCE RLS` & RPC Isolation Verification
```bash
make migrate-verify
```
* **Requirement:** Runs `node scripts/apply-migration.mjs verify` against the centralized Supabase instance (`SUPABASE_DIR = /home/chetan/projects/my-scripts/setup/dependencies`), confirming `PASS` for all 8 tables, `FORCE ROW LEVEL SECURITY` (`count=8`), `service_role`-only access to `schema_health` / `pull_changes` / `push_mutations`, and `HTTP 401` rejection on direct `anon` PostgREST probes.

### Step 4: Clean Production Bundle Build
```bash
make build
```
* **Requirement:** Produces a clean, warning-free production build in `dist/` after passing strict typechecking and deprecation checks.

### Step 5: Live 7-Story End-to-End Playwright Acceptance Suite (`tests/e2e/wise-spliter.spec.ts`)
```bash
make e2e
```
* **Requirement:** All 7 full-stack Playwright E2E user stories in `tests/e2e/wise-spliter.spec.ts` must pass against the live running application (UI `:4173` + Backend API `:4174` + Supabase `:54321`):
  1. **User Story 1:** Minimalist Home Dashboard (`<= 3` recent groups), plain-English standing summary, First-Time Quick-Start strip, Contextual Page Guide (`ContextualPageGuideBanner`), Interactive Help Modal (`HelpGuideModal`), Settl quick-amount presets, Splitwise live split sentence, personal impact badges, and Direct Non-Group Split Flow (`group_id = null` with custom `ad_hoc_participants`) synced via `POST /api/ledger/sync`.
  2. **User Story 2:** Progressive Group Workspace (`group-minimal-insights-bar` + `group-auto-guide-strip`), Concurrent Offline Conflict Resolution (`conflict-resolution-banner`), `ExplainBalanceModal` plain-English verdict + exact ledger identity, all 5 Split Modes (`equal`, `exact`, `percentage`, `shares`, `adjustment`), Multi-Payer toggle, Foreign FX conversion, Rotating Remainder (`+1 paise/cents rotated`), and WebP Receipt Upload (`POST /api/receipts/upload`).
  3. **User Story 3:** Group Management - Debt Simplification toggle (`ON`/`OFF`), Base Currency Re-denomination (`relabel` / `reconvert`), Instant Unclaimed Member addition & claim flow, and New Group creation synced to Supabase.
  4. **User Story 4:** Transparent Activity History (Group vs. Global scope), Per-Expense Immutable Revision History inspector with 1-click revision restore, and Trash Recovery Vault restore.
  5. **User Story 5:** Friends Cross-Group Net Balances, 1-Tap Atomic Batch Settle Up across groups, UPI Deep-Link / QR Code Studio (`upi://pay?`), and WhatsApp Summary export.
  6. **User Story 6:** Insights & Global Search across `0, 2, 3` decimal currencies (`JPY`, `INR`, `KWD`), Portability (`Splitwise CSV import`, `.xlsx`, `.pdf`, `PBKDF2 + AES-256-GCM` `.wisesplit` backup round-trip), live Backend API & PostgREST Security Breach checks (`HTTP 401` on unauthenticated `/api/auth/session` minting, `HTTP 403` on CSRF / cross-user impersonation / private group hijack, direct `:54321` RPC rejection), collaborator login (`rohan.verma@gmail.com`), and 1-Tap Demo Sandbox Login (`POST /api/auth/demo`).
  7. **User Story 7:** Math & UX Precision Lab verifying Settl quick-amount preset chips, 3-way rotating remainder, Splitwise personal impact badge, and `INR -> KWD` (3-decimal fils) FX re-conversion passing strict backend invariant validation (`HTTP 200`).
