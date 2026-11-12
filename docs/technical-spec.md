# Wise-Spliter — Technical Architecture & Feature Specification (Phase 1)

**Related Documents:**
* [Feature Requirements (Phase 1 & Phase 2)](./feature-requiremrnts.md)
* [System Architecture & Topology](./architecture.md)
* [Database Schema, Offline Sync, Audit History & Security Specification (`wise_spliter`)](./database-and-sync-spec.md)
* [Phase 1 Implementation Plan](./implementation-plan.md)
* [Engineering & Coding Standards](./coding-standards.md)

---

## 1. Executive Summary & Product Goals

**Wise-Spliter** is a 100% free, multi-platform (Desktop, iOS, Android, and Web) expense-splitting and bill-sharing application that combines:
1. **Settl's Mathematical Precision & Offline Speed:**
   * 170+ currencies with native `0`, `2`, and `3` decimal minor-unit integer arithmetic (`BigInt`).
   * Deterministic **Rotating Remainder** distribution so odd leftover paise/cents never penalize the same person twice, frozen at creation time so deleting or editing another bill never shifts historical paise.
   * Instant `< 1ms` local-first reads and writes with full offline operation during travel or flights.
2. **Splitwise's Multi-User Collaboration, Transparency & Ecosystem Parity:**
   * Passwordless **Google Sign-In (OAuth)** synced with a dedicated custom Supabase Postgres schema (`wise_spliter`).
   * Add friends immediately by **Name (+ optional Gmail / UPI ID)** so you can split bills at the dinner table even if a friend hasn't installed the app yet; their history auto-links if they sign in later.
   * **Group-Wide Activity & Update History Feed** plus **Per-Expense Immutable Edit History** and **Trash Recovery**, giving every member in the group 100% visibility into who added, modified, or settled any item.
   * **Whole-Expense Atomic Revisions** with explicit conflict detection and 1-tap diff resolution when multiple members edit the same expense offline.

---

## 2. Multi-Platform Tech Stack (Single Codebase, Zero Platform Branching)

| Layer | Technology Choice | Why It Fits Wise-Spliter |
| :--- | :--- | :--- |
| **Core Language** | **TypeScript 5.8 (`strict: true`, `noUncheckedIndexedAccess: true`)** | Native `bigint` works 100% identically on Desktop, iOS, Android, and Web (unlike Dart `int`, which changes bit-width on Web). |
| **App Framework & Bundler** | **Vite 6 + React 19** | Pure client-side bundle with 0ms view transitions and zero SSR network dependencies when offline. |
| **Multi-Platform Delivery** | **Offline Service Worker (`public/sw.js`) + PWA Manifest (`public/manifest.webmanifest`) + Capacitor (`@capacitor/core`)** | Installs natively as an offline-capable standalone app on **Desktop (Linux/macOS/Windows)**, **iOS**, and **Android** from one codebase; `public/sw.js` caches app shell and static assets for 100% flight/offline operation. |
| **UI, Icons & Design System** | **Tailwind CSS + Double-Bezel Primitives (`DesignPrimitives.tsx`) + `@phosphor-icons/react`** | Institutional-grade responsive layouts (`Plus Jakarta Sans` + `JetBrains Mono` tabular figures) with Minimalist Home Dashboard (`<= 3` recent groups), Modular `ExpenseEditorModal`, Progressive Group Workspace, and `HelpGuideModal` + `ContextualPageGuideBanner`. |
| **Local Offline Database** | **Dexie.js 4 (`IndexedDB`)** | ACID multi-table local transactions, reactive state, FIFO `sync_outbox` queue, and offline WebP receipt image storage in `local_receipt_blobs`. |
| **Backend API Gatekeeper** | **Node/Bun HTTP Service (`src/server/index.ts` & `src/server/supabaseAdmin.ts` on `:4174`)** | Keeps `SUPABASE_SECRET_KEY` (`service_role`) strictly server-side, validates financial conservation invariants before DB writes, handles `POST /api/receipts/upload` to private bucket `wise-spliter-receipts`, and binds `Accept-Profile` / `Content-Profile: wise_spliter`. |
| **Centralized & Cloud Supabase** | **Centralized Local Supabase (`SUPABASE_DIR = /home/chetan/projects/my-scripts/setup/dependencies`) & Hosted Supabase (`wise_spliter` schema)** | Google OAuth, isolated `wise_spliter` Postgres schema (`:54322`) & PostgREST (`:54321`), RPCs (`wise_spliter.schema_health`, `wise_spliter.push_mutations`, `wise_spliter.pull_changes`), and private receipt bucket `wise-spliter-receipts`. See [database-and-sync-spec.md](./database-and-sync-spec.md). |
| **Charts & Analytics** | **Recharts / Native SVG Telemetry (`AnalyticsAndSearchPage.tsx`)** | Interactive monthly spending trends, category breakdowns, and multi-parameter search/filtering. |
| **Data Portability** | **Multi-Sheet Excel (`.xlsx`), Printable `.pdf`, RFC-4180 `.csv`, Splitwise CSV/JSON Importer, UPI Links & Web Crypto (`AES-256-GCM`)** | Splitwise CSV/JSON import, multi-sheet `.xlsx` & `.pdf` statements, WhatsApp settlement summaries with `upi://pay` links, and encrypted `.wisesplit` backups. |
| **Verification Suite** | **Vitest + `fast-check` (Property-Based Testing) + Playwright** | Randomized property fuzz runs verifying financial conservation laws plus live end-to-end Playwright verification. |

---

## 3. Repository & Module Structure

Every domain module is pure TypeScript with zero UI or network dependencies so it can be exhaustively verified in isolation:

```
wise-spliter/
├── docs/
│   ├── feature-requiremrnts.md
│   ├── technical-spec.md
│   ├── database-and-sync-spec.md
│   ├── architecture.md
│   ├── implementation-plan.md
│   └── coding-standards.md
├── public/
│   ├── manifest.webmanifest                  # Installable PWA manifest
│   └── sw.js                                 # Offline Service Worker caching app shell & static assets
├── scripts/
│   ├── apply-migration.mjs                   # Applies & verifies `0001` + `0002` `wise_spliter` migrations & RLS posture
│   ├── check-deprecations.mjs                # TypeScript zero-deprecation gate (`TS6385` / `TS6387`)
│   ├── dev-stack.mjs                         # Concurrent API (:4174) + Vite UI (:4173) dev orchestrator
│   └── setup-dev-user.mjs                    # Seeds dev accounts in Supabase Auth + `wise_spliter.*`
├── supabase/
│   └── migrations/
│       ├── 0001_wise_spliter_schema.sql      # Core `wise_spliter` tables, indexes, bucket & RPCs
│       └── 0002_wise_spliter_security_hardening.sql # `FORCE RLS`, `service_role`-only RPCs & Storage policies
├── src/
│   ├── types/
│   │   └── ledger.ts                         # Canonical TypeScript contracts (groups, direct splits, receipts, revisions)
│   ├── domain/
│   │   ├── money/
│   │   │   └── currencies.ts                 # 170+ ISO-4217 currencies (0, 2, 3 decimals), strict BigInt parser/formatter & FX converter
│   │   ├── splits/
│   │   │   └── split-calculator.ts           # 5 split modes, rotating remainder, multi-payer FX & currency re-denomination helpers
│   │   └── ledger/
│   │       └── ledger-engine.ts              # Net balances, Margin-Conserving Hamilton bilateral matrix, O(n*2^n) BigInt Bitmask-DP & provenance
│   ├── storage/
│   │   └── local-db.ts                       # Dexie IndexedDB mirror (`wise_spliter_local_db`), `syncOutbox` & `local_receipt_blobs`
│   ├── sync-engine/
│   │   └── supabase-sync.ts                  # `resolveApiUrl`, Demo/Google/Login session management, outbox flusher & receipt upload client
│   ├── server/
│   │   ├── index.ts                          # Backend API Gatekeeper on `127.0.0.1:4174` (`/api/auth/*`, `/api/ledger/*`, `/api/receipts/upload`)
│   │   ├── securityAndAuth.ts                # HMAC/JWT/Cookie auth, CSRF/Origin checks, 5-rule tenant & entity-PK authorization & rate limits
│   │   └── supabaseAdmin.ts                  # Server-only `SUPABASE_SECRET_KEY` adapter targeting `wise_spliter` schema & `wise-spliter-receipts` bucket
│   ├── portability/
│   │   └── portability-engine.ts             # RFC-4180 Splitwise importer, formula-safe CSV/XLSX/PDF exporters, UPI/WhatsApp & AES-256-GCM backup
│   ├── state/
│   │   └── LedgerContext.tsx                 # Reactive local-first state provider, OAuth callback listener & mutation coordinator
│   └── ui/
│       ├── primitives/
│       │   └── DesignPrimitives.tsx          # DoubleBezelCard, StatusBadge, PersonalExpenseImpactBadge, ContextualPageGuideBanner
│       ├── modals/
│       │   ├── DevAuthModal.tsx              # 1-Tap Demo Sandbox, Google OAuth 2.0 & Email/Password Sign-In modal
│       │   ├── ExpenseEditorModal.tsx        # Settl quick-amount presets, Splitwise live sentence, 5 split modes & offline WebP receipts
│       │   ├── ExplainBalanceModal.tsx       # Plain-English verdict + mathematical balance lineage & Bitmask-DP routing drawer
│       │   └── HelpGuideModal.tsx            # Interactive step-by-step Help & Feature Guide modal
│       └── pages/
│           ├── HomeDashboardPage.tsx         # Plain-English standing, Quick-Start strip, Top-3 recent groups & direct splits
│           ├── GroupsLedgerPage.tsx          # Progressive Group Workspace insights, personal impact pills, roster & currency re-denomination
│           ├── ActivityAndTrashPage.tsx      # Group/Global activity feed, immutable expense revisions, conflict resolution & Trash recovery
│           ├── FriendsAndSettlePage.tsx      # Cross-group multi-currency net balances, atomic batch settlement, UPI QR & WhatsApp summary
│           ├── AnalyticsAndSearchPage.tsx    # Spending analytics & instant multi-filter search with personal impact pills
│           └── PortabilityAndSyncPage.tsx    # Splitwise import, CSV/Multi-Sheet `.xlsx`/`.pdf` export, AES-256-GCM backup & cloud sync status
└── tests/
    ├── unit/
    │   ├── domain-and-portability.test.ts    # Core currency, split, Bitmask-DP, Dexie, portability & auth isolation unit tests (15)
    │   ├── math-engine-scenarios.test.ts     # Edge-case scenarios, FX re-denomination & `fast-check` property fuzz suites (21)
    │   └── security-breach.test.ts           # Live red-team breach, CSRF, PK-overwrite, path-traversal & PostgREST lockdown tests (11)
    └── e2e/
        └── wise-spliter.spec.ts              # 7-story full-stack Playwright E2E acceptance suite
```

---

## 4. Exact Mathematical & Financial Algorithms

### 4.1 ISO-4217 Minor-Unit Integer Representation (`src/domain/money/`)
* Floating-point math (`number` division for money) is **strictly banned**.
* Every currency $C$ defines an integer exponent $E_C \in \{0, 2, 3\}$:
  * $E_C = 0$: `JPY`, `KRW`, `VND`, `CLP`, `ISK`, `UGX`, etc. ($1 \text{ unit} = 1\text{n}$)
  * $E_C = 2$: `INR`, `USD`, `EUR`, `GBP`, `AED`, `AUD`, `CAD`, `SGD`, etc. ($1 \text{ unit} = 100\text{n}$)
  * $E_C = 3$: `KWD`, `BHD`, `OMR`, `JOD`, `TND`, `LYD` ($1 \text{ unit} = 1000\text{n}$)
* Parsing user input (e.g., `"125.50"` in `INR`) uses exact string splitting around the decimal point and pads the fractional part to $E_C$ digits to produce `12550n` without ever calling `parseFloat`.

### 4.2 Stateless Deterministic Rotating Remainder & The 5 Split Modes (`src/domain/splits/`)
When creating or updating an expense with total $T \in \mathbb{Z}^+$ (in group base-currency minor units) across $k$ included members sorted by their group `member_order` $(m_0, m_1, \dots, m_{k-1})$:

1. **Rotation Seed (`rotation_seed`):**
   * On expense creation, `rotation_seed` is set to the group's current `expense_seq` (and `group.expense_seq` increments by 1).
   * When editing an existing expense, its original `rotation_seed` is preserved unless the user explicitly resets splits.
   * Once saved, the resulting `owed_minor` values are **frozen inside `expense.splits`** so deleting or editing another expense in the group never mutates the paise of existing bills (100% Splitwise & Settl parity).

2. **Mode 1 — Equal Split (`split_mode = 'equal'`):**
   * Base share: $q = \lfloor T / k \rfloor$, remainder: $r = T \bmod k$ (where $0 \le r < k$).
   * Order the $k$ included members starting at offset $s = \text{rotation\_seed} \bmod k$:
     $$\text{RotatedIndex}(j) = (j - s + k) \bmod k$$
   * The first $r$ members in this rotated order receive $q + 1$ minor units (`remainder_minor = 1`); the remaining $k - r$ members receive $q$ minor units (`remainder_minor = 0`).
   * **Proof of Fairness:** Over any $k$ consecutive equal-split expenses with identical $r$, every single member receives the extra $+1$ paisa/cent the exact same number of times.

3. **Mode 2 — Shares / Ratios Split (`split_mode = 'shares'`):**
   * Each included member $i$ has positive integer share weight $w_i \in \mathbb{Z}^+$, with total weight $W = \sum_{i=0}^{k-1} w_i$.
   * Exact floor allocation: $q_i = \lfloor (T \times w_i) / W \rfloor$, numerator remainder: $\text{rem}_i = (T \times w_i) \bmod W$.
   * Leftover minor units to distribute: $\Delta = T - \sum q_i$ (always $0 \le \Delta < k$).
   * Sort the $k$ members by:
     1. Descending $\text{rem}_i$ (**Hamilton's Largest Remainder Rule**),
     2. Tie-breaker: ascending rotated position $(i - (\text{rotation\_seed} \bmod k) + k) \bmod k$.
   * Assign $+1$ minor unit to the top $\Delta$ members.

4. **Mode 3 — Percentage Split (`split_mode = 'percentage'`):**
   * Percentages are represented in **basis points** ($100.00\% = 10000 \text{ bps}$).
   * **Validation Gate:** Must satisfy $\sum_{i=0}^{k-1} \text{bps}_i == 10000$.
   * Computed identically to Shares Mode with $w_i = \text{bps}_i$ and $W = 10000$.

5. **Mode 4 — Exact Amounts (`split_mode = 'exact'`):**
   * User enters exact minor amounts $e_i$ per included member.
   * **Validation Gate:** Must satisfy $\sum_{i=0}^{k-1} e_i == T$. If $\sum e_i \neq T$, the UI displays the exact remaining/over-allocated amount (e.g., *"₹15.00 left to assign"*) and blocks saving until reconciled.

6. **Mode 5 — Adjustments `+/-` (`split_mode = 'adjustment'`):**
   * Each included member $i$ has a signed integer adjustment $a_i \in \mathbb{Z}$ (in minor units).
   * Let $A = \sum_{i=0}^{k-1} a_i$ and remaining pool $P = T - A$.
   * **Validation Gate:** $P \ge 0$ and for every member $i$, their final share $s_i = \text{EqualSplit}(P, k, \text{rotation\_seed})_i + a_i \ge 0$.

7. **Multiple Payers Validation:**
   * A single expense supports $1 \dots N$ payers.
   * **Validation Gate:** $\sum_{p \in \text{payers}} p.\text{paid\_minor} == T$.

---

### 4.3 Multi-Currency Conversion & Group Base Currency Changes (`src/domain/money/fx-converter.ts`)

1. **Entering a Foreign-Currency Expense:**
   * Suppose Group Base Currency is $G$ (exponent $E_G$, e.g., `INR`, $E_G = 2$) and the bill is entered in Currency $F$ (exponent $E_F$, e.g., `EUR`, $E_F = 2$ or `JPY`, $E_F = 0$).
   * Exchange rate $R$ ($1 \text{ major unit of } F = R \text{ major units of } G$) is stored as an integer scaled by $10^8$:
     $$R_{\text{scaled}} = \text{round}(R \times 10^8)$$
   * Converted amount in Group Base Currency minor units:
     $$\text{amount\_minor} = \text{round}\left( \frac{\text{original\_amount\_minor} \times R_{\text{scaled}} \times 10^{E_G}}{10^{E_F} \times 10^8} \right)$$
   * **Splitwise Parity FX Audit Note:** Automatically attaches `fx_audit_note` to the expense (e.g., `"Converted from €50.00 EUR at 1 EUR = 91.20 INR [Live rate / Offline cached rate]"`) and records it in `group_activity_log`.
2. **Changing a Group's Base Currency After Expenses Exist:**
   * Presents two explicit, lossless modes:
     * **Mode A — Re-label Currency Only:** Changes `base_currency` code (adjusting minor-unit scale factor $10^{E_{\text{new}} - E_{\text{old}}}$ if switching between 0/2/3 decimal currencies) without applying an exchange rate.
     * **Mode B — Convert Existing Ledger via Exchange Rate:** Converts all active expenses and settlements into the new `base_currency`, writes a `'currency_reconverted'` revision for each expense, and logs `'group_currency_changed'` in `group_activity_log`.

---

### 4.4 Balance Engine, Debt Simplification & "Explain This Balance" (`src/domain/ledger/`)

#### 1. Net Balance per Member (Conservation Law)
For every member $m$ in a group:
$$\text{Net}(m) = \sum_{e \in \text{ActiveExpenses}} \left(\text{Paid}(e, m) - \text{Owed}(e, m)\right) + \sum_{s \in \text{ActiveSettlements}} \left(\text{Sent}(s, m) - \text{Received}(s, m)\right)$$
* **Hard Invariant:** $\sum_{m \in \text{Group}} \text{Net}(m) \equiv 0\text{n}$.

#### 2. Mode A - Unsimplified (Raw Pairwise Bilateral Debts via Intra-Bill Net Surplus/Deficit Conservation)
When `group.simplify_debts == false`:
* For each active expense $e$, compute each participant's intra-bill net delta $\delta_e(m) = \text{Paid}(e, m) - \text{Owed}(e, m)$, partitioning participants into net debtors ($\delta_e(u) < 0$) and net creditors ($\delta_e(v) > 0$) so an underpaying co-payer is never treated as a creditor.
* Allocate each debtor's deficit $-\delta_e(u)$ across remaining creditor surpluses via **Sequential Margin-Conserving Hamilton Largest Remainder** (`allocateExpenseBilateralDebts`), strictly preserving both $\sum_v d_e(u \to v) = -\delta_e(u)$ and $\sum_u d_e(u \to v) = \delta_e(v)$.
* Pairwise net debt between any two members $(u, v)$ is:
  $$\text{PairwiseNet}(u, v) = \sum_e \left(d_e(u \to v) - d_e(v \to u)\right) - \text{DirectSettlements}(u \to v) + \text{DirectSettlements}(v \to u)$$

#### 3. Mode B - Simplified (Minimum-Transfer Graph Solver)
When `group.simplify_debts == true` (strictly isolated **within the group**):
* Collects all members with $\text{Net}(m) \neq 0\text{n}$ using exact `BigInt` subset sums (immune to 32-bit integer overflow).
* **Exact $O(n \cdot 2^n)$ Prefix-Zero-Sum Bitmask DP Partitioning ($n \le 16$ non-zero members):**
  * Finds the maximum number of disjoint non-empty zero-sum subsets $S_1, S_2, \dots, S_p$ in $O(n \cdot 2^n)$ (`< 2ms` at $n = 16$) by transitioning from minimal zero-sum transitions and reconstructing disjoint components.
  * Each zero-sum subset $S_r$ of size $|S_r|$ is settled in exactly $|S_r| - 1$ transfers by matching the largest creditor with the largest debtor inside $S_r$.
  * Total transfers = $n - p$, which is **mathematically proven to be the global minimum number of transactions**.
* **Deterministic `BigInt` Max-Creditor / Max-Debtor Greedy Fallback ($n > 16$):**
  * Dynamically pairs $\arg\max_{c} \text{Net}(c)$ with $\arg\min_{d} \text{Net}(d)$ until all balances reach `0n`.

#### 4. "Explain This Balance" Provenance Engine (`explain-balance.ts`)
Tapping any member or suggested settlement produces a structured `BalanceExplanation`:
1. **Arithmetic Summary:**
   * `Total Paid for Group Bills` ($+X$)
   * `Total Personal Share of Group Bills` ($-Y$)
   * `Settlements Paid` ($+S_{\text{out}}$) & `Settlements Received` ($-S_{\text{in}}$)
   * `Final Net Balance` ($= \text{Net}(m)$)
2. **Itemized Expense & Settlement Lineage:** Every active bill/settlement where $m$ paid or participated, showing exact date, payer, split mode, and $m$'s net delta on that bill.
3. **Simplification Routing Explanation (when `simplify_debts == true`):** Shows the transitive debt path that was collapsed (e.g., *"Instead of Aman paying Rahul ₹500 and Rahul paying Chetan ₹500, Aman pays Chetan ₹500 directly"*).

#### 5. Cross-Group Friend Net Balance & Atomic Multi-Group Settle Up (`cross-group-ledger.ts`)
* Across all active groups shared between the current user $U$ and a friend $F$ (matched by `user_id` or normalized `invited_email`), computes the pairwise balance in each group $g$.
* When the user taps **"Settle All Across Groups"** with friend $F$:
  * Generates a shared `batch_settlement_id` (UUIDv7) and creates the exact offsetting settlement row inside each shared group $g$ in a single atomic transaction, logging the settlement in each group's `group_activity_log`.

---

## 5. Settlements, UPI Deep-Links & WhatsApp Summary Sharing

1. **UPI Deep-Link Generator (`upi://pay`):**
   * Formats standard NPCI UPI URI:
     `upi://pay?pa=<receiver_upi_id>&pn=<encoded_name>&am=<major_amount_2_decimals>&cu=INR&tn=<encoded_group_note>`
   * Supports one-tap launch into Google Pay, PhonePe, Paytm, BHIM, or any installed UPI app on Android/iOS, plus a scannable **UPI QR Code modal** on Desktop!
2. **WhatsApp / Chat Summary Generator (`whatsapp-summary.ts`):**
   * **Text Summary:** Clean formatted message listing total group spend, each member's net balance, and minimum settlement transfers with clickable UPI payment links.
   * **Visual Summary Card:** High-contrast PNG summary card rendered via `html-to-image` for sharing directly into WhatsApp/Telegram/iMessage.

---

## 6. Data Ownership & Portability (`src/portability/`)

1. **Splitwise CSV & JSON Importer (`portability-engine.ts`):**
   * Parses official Splitwise CSV exports (detecting the date, description, category, cost, currency, and per-member net column headers) and Splitwise Pro JSON backups, reconstructing groups, members, expenses, and settlements with full validation.
2. **CSV, Multi-Sheet Excel (`.xlsx`), and Printable `.pdf` Statements (`portability-engine.ts`):**
   * Exports any group or filtered date range to RFC-4180 `.csv`, a **Multi-Sheet `.xlsx` workbook** (`Summary`, `Expenses`, `Settlements`, `Member Balances`), or a formatted printable `.pdf` statement.
3. **Encrypted Local/Cloud Backup (`.wisesplit`):**
   * Exports the entire local database state as a JSON payload compressed and encrypted via Web Crypto **PBKDF2 (`SHA-256`) + `AES-256-GCM`** with a user passphrase (or unencrypted JSON export option), restorable on any device offline.

---

## 7. Progressive Disclosure UI, Receipt Attachment Pipeline & Backend API Gatekeeper

1. **Minimalist Home Dashboard (`HomeDashboardPage.tsx`):**
   * Displays at most `<= 3` recently accessed or updated active groups sorted by `GREATEST(last_accessed_at, updated_at) DESC`, personal net balance cards (`Net Position`, `Owed to You`, `You Owe`), recent direct non-group splits (`group_id = null`), and primary quick actions (`+ Quick Add Expense`, `Settle Up`, `All Groups`, `Guided Help`).
2. **Modular `ExpenseEditorModal` (`src/ui/modals/ExpenseEditorModal.tsx`):**
   * Supports both **Direct Non-Group Splits (`group_id = null` with `ad_hoc_participants`)** when launched from the Home Screen without selecting a group, and **Group-Preselected Splits** when launched inside a specific group workspace.
   * Includes all 5 split modes (`equal`, `exact`, `percentage`, `shares`, `adjustment`), multiple payers, live FX conversion with audit note generation, and offline-capable WebP receipt image attachments.
3. **Progressive Group Workspace (`GroupsLedgerPage.tsx`) & Guided Onboarding (`HelpGuideModal` + `ContextualPageGuideBanner`):**
   * Opening a group updates its `last_accessed_at` timestamp and progressively reveals concise group-level balance insights, member roster management (instant add by Name + optional Gmail/UPI ID), "Explain This Balance" lineage modals (`ExplainBalanceModal`), and skippable contextual guidance (`ContextualPageGuideBanner` + `HelpGuideModal`).
4. **Receipt Image & Bill Attachment Architecture (`local_receipt_blobs` $\to$ `POST /api/receipts/upload` $\to$ `wise-spliter-receipts`):**
   * **Offline / Local Device:** Compressed WebP images are stored immediately in the Dexie.js IndexedDB table `local_receipt_blobs` so receipts work 100% offline during flights and trips.
   * **Online / Centralized & Cloud Supabase:** Uploaded via the Backend API Service (`POST /api/receipts/upload` on `:4174`) to the private **Supabase Storage bucket `wise-spliter-receipts`** at path `{group_id_or_direct}/{expense_id}/{receipt_id}.webp`, with structured metadata recorded in `wise_spliter.receipt_attachments` and `wise_spliter.expenses.receipts`.
5. **Centralized Supabase (`SUPABASE_DIR = /home/chetan/projects/my-scripts/setup/dependencies`) & Backend API Gatekeeper (`src/server/index.ts` on `:4174`):**
   * The Backend API Gatekeeper on port `4174` holds `SUPABASE_SECRET_KEY` (`service_role`) strictly on the server, validates financial conservation laws ($\sum \text{payers} == \text{amount\_minor} == \sum \text{splits}$) before database writes, and communicates with PostgREST (`:54321`) using `Accept-Profile: wise_spliter` and `Content-Profile: wise_spliter` alongside RPCs `wise_spliter.schema_health`, `wise_spliter.push_mutations`, and `wise_spliter.pull_changes`.
6. **Offline Service Worker (`public/sw.js`):**
   * Caches the application shell and static assets so Wise-Spliter boots and operates seamlessly without network connectivity.

---

## 8. Zero-Bug Verification & Testing Strategy

1. **Property-Based Fuzz Testing (`tests/property/` with `fast-check`):**
   * **Invariant 1 (Split Conservation):** For any currency exponent $\in \{0, 2, 3\}$, any total $T \in [1\text{n}, 10^{12}\text{n}]$, any subset of $1..25$ members, and any of the 5 split modes, $\sum \text{owed\_minor} === T$ and $\sum \text{paid\_minor} === T$.
   * **Invariant 2 (Rotating Remainder Fairness):** Over $k$ equal splits of the same amount $T$, the difference between the maximum and minimum total amount owed by any two participants is $0\text{n}$.
   * **Invariant 3 (Zero-Sum Group Ledger):** After any sequence of random expenses, multi-payers, edits, soft-deletes, restores, and partial settlements, $\sum_{m} \text{Net}(m) === 0\text{n}$.
   * **Invariant 4 (Debt Simplification Completeness):** Applying the transfers emitted by `simplifyGroupDebts()` reduces every member's balance to `0n` in $\le n - 1$ transfers.
   * **Invariant 5 (Sync Convergence & Idempotency):** Applying any batch of offline mutations twice (`op_id` replay) or out-of-order across two devices converges to the exact same active state and flags concurrent edits on the same expense without losing either revision.
2. **End-to-End Multi-User & Offline Tests (`tests/e2e/` with Playwright):**
   * Verifies full offline expense creation, group currency switching, Splitwise CSV import/export, conflict banner resolution, and Group Activity History feed updates.
