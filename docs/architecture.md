# Wise-Spliter: System Architecture & Topology

**Related Specifications:**
* [Feature Requirements](./feature-requiremrnts.md)
* [Technical Architecture & Financial Algorithms](./technical-spec.md)
* [Database Schema, Offline Sync & Security Specification (`wise_spliter`)](./database-and-sync-spec.md)
* [Engineering & Coding Standards](./coding-standards.md)

---

## 1. Top-Level Architecture Overview (5 Core Layers)

Wise-Spliter is engineered as a 5-layer local-first, mathematically deterministic, multi-platform financial ledger. Every layer has strict boundaries and responsibilities:

### Layer 1: Multi-Platform Client UI (`src/ui/`, `src/App.tsx`)
* **Minimalist Home Dashboard:** Displays at most `<= 3` recently accessed or updated active groups (`GREATEST(last_accessed_at, updated_at) DESC`), personal net balance telemetry (`Net`, `Owed to you`, `You owe`), and a 1-tap **Quick Add Expense** workflow that supports both **Direct Non-Group Splits (`group_id = null` with `ad_hoc_participants`)** and **Group Bills**.
* **Progressive Group Workspace:** Presents a clean group header with concise balance insights, member roster management (instant add by Name + optional Gmail/UPI ID), interactive **Explain This Balance** lineage drawers, and automatic contextual step-by-step guidance (`HelpGuideModal`).
* **Activity, Revision & Trash Vault (`ActivityHistoryView`):** Exposes the group-wide chronological audit feed (`group_activity_log`), per-expense immutable edit history (`expense_revisions`) with field-level before/after diffs, 1-tap conflict resolution banners (`[Keep Local Version]` / `[Accept Remote Version]`), and soft-deleted bill recovery (`deleted_at IS NOT NULL`).
* **Friends Cross-Group & UPI/WhatsApp Settle Studio (`FriendsSettleView`):** Aggregates pairwise net balances across all shared groups plus standalone direct splits, generates standard NPCI `upi://pay` deep-links and scannable Desktop UPI QR codes, formats copyable WhatsApp settlement summaries, and executes atomic multi-group batch settlements (`batch_settlement_id`).
* **Analytics & Global Search (`AnalyticsSearchView`):** Provides multi-parameter filtering (query, group, category, split mode, conflict flag) alongside category distribution breakdowns and monthly cashflow velocity.
* **Portability & Encrypted Backup Vault (`PortabilityView`):** Delivers 1-click Splitwise CSV and JSON migration imports, RFC-4180 CSV ledger exports, printable statements, and **Web Crypto (`PBKDF2-SHA256` 600,000 iterations + `AES-256-GCM`)** `.wisesplit` encrypted backup archives.

### Layer 2: Pure Financial & Graph Domain Engine (`src/domain/`)
* **Zero-Float Minor-Unit Money Math (`src/domain/money/`):** Supports 170+ ISO-4217 currencies across `0`, `2`, and `3` decimal exponents (`JPY = 0`, `INR/USD/EUR = 2`, `KWD/BHD/OMR = 3`). All parsing, formatting, and foreign-exchange conversions (`fx_rate_scaled = round(rate * 10^8)`) operate exclusively on `BigInt` and integer minor units.
* **5 Split Modes & Stateless Deterministic Rotating Remainder (`src/domain/splits/`):** Implements `equal`, `exact`, `percentage` (10,000 basis points), `shares` (Hamilton's Largest Remainder Rule), and `adjustment` (`+/-` minor units). Leftover sub-units (`T mod k`) rotate deterministically using the frozen `rotation_seed = group.expense_seq` at creation time so historical paise/cents never shift when other expenses are edited or deleted.
* **Bitmask-DP Minimum-Transfer Debt Simplifier & Provenance (`src/domain/ledger/`):** Enforces the zero-sum group conservation law ($\sum_{m} \text{Net}(m) \equiv 0\text{n}$). Supports both raw bilateral pairwise debts (`simplify_debts = false`) and exact **Bitmask Dynamic Programming ($O(3^n)$ for $n \le 16$, greedy max-heap fallback for $n > 16$)** to find the mathematically minimum number of settlement transfers ($n - p$ where $p$ is the maximum count of disjoint zero-sum subsets), paired with full **Explain This Balance** equation lineage.

### Layer 3: Local-First IndexedDB & Outbox Engine (`src/storage/local-db.ts`, `src/state/LedgerContext.tsx`)
* **Dexie.js Local Mirror (`WiseSpliterLocalDatabase`):** Mirrors `groups`, `expenses`, `expenseRevisions`, `settlements`, `groupActivityLog`, and `kvStore` inside browser `IndexedDB` (`wise_spliter_local_db`), with an automatic in-memory fallback for restricted headless contexts.
* **Sub-Millisecond Offline Reads/Writes & `syncOutbox` FIFO Queue:** Every user action commits immediately to the local state and `IndexedDB` in `< 1ms` and appends an ordered mutation record (`id`, `entityType`, `action`, `payloadJson`, `createdAt`, `hlc`) to `syncOutbox`. Whether the user is on an airplane or flaky travel Wi-Fi, the app remains 100% interactive and flushes `syncOutbox` to the Backend API when connectivity is available.

### Layer 4: Backend API & Sync Gatekeeper Service (`src/server/index.ts` & `src/server/supabaseAdmin.ts` on Port `4174`, Proxied at `/api/*`)
This layer explicitly governs **"Why we have a Backend API and Who Updates the Database"**:
* **Strict Secret Isolation:** The browser client **NEVER** holds or receives `SUPABASE_SECRET_KEY` (`service_role`). All privileged credentials remain strictly inside the Node/Bun Backend API process (`src/server/`).
* **Mathematical Invariant Gatekeeper:** Before any expense or settlement mutation touches PostgreSQL, the Backend API validates hard financial invariants:
  $$\sum_{p \in \text{payers}} p.\text{paid\_minor} == \text{amount\_minor} == \sum_{s \in \text{splits}, s.\text{included}} s.\text{owed\_minor}$$
  Payloads that violate conservation laws or have invalid split parameters are rejected with `HTTP 400` before reaching the database.
* **Atomic Conflict Resolution & HLC Ordering:** The Backend API compares incoming `base_revision_id` and monotonic **Hybrid Logical Clock (`hlc`)** timestamps against the current persisted row. Concurrent offline edits on the same expense are never silently overwritten; both snapshots are preserved in `expense_revisions`, `has_unresolved_conflict = true` is flagged, and a structured audit entry is appended to `group_activity_log`.
* **Initial Ledger Seeding & PostgREST Profile Binding:** When the `wise_spliter` schema is empty on first boot, the Backend API automatically seeds the baseline reference dataset. All database reads and writes execute atomically through `src/server/supabaseAdmin.ts` against Supabase PostgREST using explicit schema profile headers:
  * `Accept-Profile: wise_spliter`
  * `Content-Profile: wise_spliter`

### Layer 5: Centralized Local & Cloud Supabase Stack (`SUPABASE_DIR = /home/chetan/projects/my-scripts/setup/dependencies`, Schema `wise_spliter`)
* **Shared Local Supabase Infrastructure:** Connects to the centralized local Supabase stack running at `/home/chetan/projects/my-scripts/setup/dependencies` (or hosted Supabase in cloud deployments), comprising **PostgreSQL 17** (`127.0.0.1:54322`), **PostgREST Data API** (`127.0.0.1:54321`), **GoTrue Auth**, and **Supabase Studio** (`127.0.0.1:54323`).
* **Dedicated Schema Isolation (`CREATE SCHEMA wise_spliter;`):** All tables, indexes, sequences, RLS policies, and the `wise_spliter.schema_health()` readiness RPC reside exclusively inside the `wise_spliter` schema (`supabase/migrations/0001_wise_spliter_schema.sql`). Zero application tables pollute `public`, and `REVOKE ALL ON SCHEMA wise_spliter FROM PUBLIC, anon;` guarantees strict tenant and role isolation.

---

## 2. Architecture & Data-Flow Diagrams

### Diagram 1: System & Deployment Topology (`flowchart TB`)

```mermaid
flowchart TB
  subgraph ClientLayer["Layer 1-3: Multi-Platform Client Browser / PWA (:4173)"]
    UI["Layer 1: React 19 UI Views\n(Home Top-3 & Quick-Add, Groups, Activity/Revisions,\nFriends UPI/WhatsApp Settle, Analytics, Portability)"]
    Domain["Layer 2: Pure Financial & Graph Domain Engine\n(170+ ISO-4217 Currencies, BigInt Minor Units,\n5 Split Modes, Rotating Remainder, Bitmask-DP Simplifier)"]
    LocalDB["Layer 3: Local-First Storage & State\n(LedgerContext + Dexie.js IndexedDB Mirror\n+ FIFO syncOutbox Queue)"]

    UI -->|"User Actions & Queries"| Domain
    Domain -->|"Validated Entities & Balances"| LocalDB
    LocalDB -->|"<1ms Reactive State"| UI
  end

  subgraph NetworkBridge["Vite Dev Proxy / Docker Bridge Network"]
    Proxy["HTTP Proxy (/api/* -> :4174)"]
  end

  subgraph ServerLayer["Layer 4: Backend API & Sync Gatekeeper (:4174)"]
    API["Backend API Service (src/server/index.ts)\n- Enforces Payers == Amount == Splits Invariants\n- Resolves base_revision_id + HLC Conflicts\n- Seeds Initial Ledger State When Empty"]
    Admin["Supabase Admin Adapter (src/server/supabaseAdmin.ts)\n- Holds SUPABASE_SECRET_KEY (service_role) Server-Only\n- Binds Accept-Profile & Content-Profile: wise_spliter"]

    API --> Admin
  end

  subgraph SupabaseLayer["Layer 5: Centralized Supabase Stack (SUPABASE_DIR)"]
    Kong["Supabase API Gateway / PostgREST (:54321)\n/rest/v1/* & /rest/v1/rpc/schema_health"]
    GoTrue["GoTrue Auth Service\n(Google OAuth & JWT Verification)"]
    Studio["Supabase Studio (:54323)"]
    PG[("PostgreSQL 17 (:54322)\n Isolated Schema: wise_spliter\n(profiles, groups, group_members, expenses,\nexpense_revisions, settlements, group_activity_log)")]

    Kong --> PG
    GoTrue --> PG
    Studio --> PG
  end

  LocalDB <-->|"REST JSON & Outbox Flush (/api/ledger, /api/sync)"| Proxy
  Proxy <--> API
  Admin <-->|"HTTPS / PostgREST + SUPABASE_SECRET_KEY"| Kong
```

---

### Diagram 2: Write, Offline Outbox Queue, Invariant Validation & Conflict Resolution Flow (`sequenceDiagram`)

```mermaid
sequenceDiagram
  autonumber
  actor User as User (Mobile / Desktop)
  participant UI as Layer 1: Client UI
  participant Domain as Layer 2: Domain Engine
  participant Dexie as Layer 3: Dexie IndexedDB & syncOutbox
  participant API as Layer 4: Backend API (:4174)
  participant PG as Layer 5: Supabase PostgREST (wise_spliter)

  Note over User,PG: Scenario A: Group Expense or Direct Non-Group Split (group_id = null)
  User->>UI: Submit Quick-Add Expense (Group Bill OR Direct Split with ad_hoc_participants)
  UI->>Domain: parseMajorToMinor() + calculateExpenseSplits(mode, rotationSeed)
  Domain->>Domain: validateExpenseInvariants(amountMinor, payers, splits)
  Domain-->>UI: Deterministic Splits + Frozen Remainder + HLC Timestamp

  UI->>Dexie: Commit Expense + Revision Snapshot + Activity Item (<1ms ACID Transaction)
  Dexie->>Dexie: Enqueue Mutation in FIFO syncOutbox (op_id, base_revision_id, hlc)
  Dexie-->>UI: Instant Optimistic UI Update (Works 100% Offline)

  alt Device is Offline (Flight / Remote Travel)
    Note over Dexie: Mutations accumulate safely in IndexedDB syncOutbox
  else Device is Online / Reconnects
    Dexie->>API: POST /api/expenses or POST /api/sync/flush (Outbox Payload)
    API->>API: Verify Invariants: sum(payers) == amount_minor == sum(splits)

    alt Invariant Check Fails
      API-->>Dexie: HTTP 400 Bad Request (Rejected before touching DB)
    else Invariant Check Passes
      API->>PG: GET /rest/v1/expenses?id=eq.{id} (Accept-Profile: wise_spliter)
      PG-->>API: Current Persisted Expense Row (or Empty)

      alt New Expense OR base_revision_id == current_revision_id
        API->>PG: UPSERT wise_spliter.expenses (group_id or NULL + ad_hoc_participants)
        API->>PG: INSERT wise_spliter.expense_revisions (action='created'|'updated')
        API->>PG: INSERT wise_spliter.group_activity_log (summary_text, diff_badges)
        PG-->>API: 201 Created / 200 OK
        API-->>Dexie: Ack Sync Success -> Clear op_id from syncOutbox
      else Concurrent Offline Edit Detected (base_revision_id != current_revision_id)
        API->>API: Compare Incoming HLC vs Persisted HLC (Zero Silent Field Mixing)
        API->>PG: INSERT wise_spliter.expense_revisions (Preserve Both Complete Snapshots)
        API->>PG: UPDATE wise_spliter.expenses SET has_unresolved_conflict=true, conflict_revision_id={branch_id}
        API->>PG: INSERT wise_spliter.group_activity_log (action='expense_conflict_flagged')
        PG-->>API: 200 OK (Conflict Recorded Atomically)
        API-->>Dexie: Return Updated Dataset with Conflict State
        Dexie-->>UI: Surface 1-Tap Conflict Resolution Banner ([Keep Mine] / [Accept Remote])
      end
    end
  end
```

---

### Diagram 3: `wise_spliter` Database Schema Entity-Relationship Model (`erDiagram`)

```mermaid
erDiagram
  PROFILES {
    text id PK
    text email UK
    text full_name
    text avatar_initials
    text default_currency
    text upi_id
    boolean google_connected
    timestamptz created_at
    timestamptz updated_at
    text hlc
    bigint server_seq
  }

  GROUPS {
    text id PK
    text name
    text description
    text category
    text base_currency
    boolean simplify_debts
    jsonb default_split_config
    integer expense_seq
    text invite_code UK
    text created_by
    timestamptz created_at
    timestamptz updated_at
    timestamptz last_accessed_at
    timestamptz deleted_at
    text hlc
    bigint server_seq
  }

  GROUP_MEMBERS {
    text id PK
    text group_id FK
    text user_id
    text invited_email
    text display_name
    text avatar_initials
    text upi_id
    text role
    integer member_order
    timestamptz joined_at
    timestamptz last_accessed_at
    timestamptz claimed_at
    timestamptz removed_at
    text hlc
    bigint server_seq
  }

  EXPENSES {
    text id PK
    text group_id FK "NULL for direct non-group splits"
    jsonb ad_hoc_participants "Roster when group_id IS NULL"
    text title
    text category
    text original_currency
    bigint original_amount_minor
    text group_currency
    bigint amount_minor
    bigint fx_rate_scaled
    text fx_status
    text split_mode
    integer rotation_seed
    jsonb payers
    jsonb splits
    text current_revision_id
    integer revision_number
    boolean has_unresolved_conflict
    text conflict_revision_id
    text created_by_member_id
    text updated_by_member_id
    timestamptz deleted_at
    text hlc
    bigint server_seq
  }

  EXPENSE_REVISIONS {
    text id PK
    text expense_id FK
    text group_id FK "Nullable for direct splits"
    integer revision_number
    text base_revision_id
    text actor_member_id
    text actor_display_name
    text action
    jsonb changes_json
    jsonb snapshot
    boolean is_conflict_branch
    timestamptz created_at
    text hlc
    bigint server_seq
  }

  SETTLEMENTS {
    text id PK
    text group_id FK "Nullable for direct settlements"
    text batch_settlement_id
    text from_member_id
    text to_member_id
    bigint amount_minor
    text currency
    text payment_method
    text payment_reference
    text settled_date
    timestamptz deleted_at
    text hlc
    bigint server_seq
  }

  GROUP_ACTIVITY_LOG {
    text id PK
    text group_id FK "Nullable for direct activity"
    text actor_member_id
    text actor_display_name
    text entity_type
    text entity_id
    text action
    text summary_text
    text detail_note
    text_array diff_badges
    timestamptz created_at
    text hlc
    bigint server_seq
  }

  PROFILES ||--o{ GROUPS : "creates (created_by)"
  PROFILES ||--o{ GROUP_MEMBERS : "links on Google Sign-In (user_id)"
  GROUPS ||--o{ GROUP_MEMBERS : "contains roster"
  GROUPS |o--o{ EXPENSES : "scopes (nullable group_id)"
  EXPENSES ||--o{ EXPENSE_REVISIONS : "records immutable snapshots"
  GROUPS |o--o{ EXPENSE_REVISIONS : "scopes history"
  GROUPS |o--o{ SETTLEMENTS : "settles balances"
  GROUPS |o--o{ GROUP_ACTIVITY_LOG : "audits mutations"
```

---

## 3. One-Shot Local Development & Docker Orchestration (`make dev` & `make docker-up-dev`)

Wise-Spliter is designed so a developer can boot the entire 5-layer stack with a single command (`make dev` on the host or `make docker-up-dev` in containers).

### 3.1 Host One-Shot Workflow (`make dev`)
Running `make dev` executes the following end-to-end startup pipeline:
1. **Centralized Supabase Stack Verification (`SUPABASE_DIR = /home/chetan/projects/my-scripts/setup/dependencies`):**
   * Checks whether the shared local Supabase containers (`supabase_db_dependencies` on `:54322`, PostgREST on `:54321`, Studio on `:54323`) are healthy and running; starts them from `SUPABASE_DIR` if stopped.
2. **Idempotent Schema Migration & Readiness Verification (`node scripts/apply-migration.mjs local`):**
   * Applies `supabase/migrations/0001_wise_spliter_schema.sql` to `supabase_db_dependencies` via `psql` (`ON_ERROR_STOP=1`).
   * Ensures `wise_spliter` is exposed in PostgREST schemas and reloads PostgREST (`NOTIFY pgrst, 'reload schema';`).
   * Probes every table (`profiles`, `groups`, `group_members`, `expenses`, `expense_revisions`, `settlements`, `group_activity_log`) and invokes `POST /rest/v1/rpc/schema_health` with `Accept-Profile: wise_spliter` to verify `HTTP 200` readiness.
3. **Backend API Gatekeeper Startup (`Port 4174`):**
   * Starts `src/server/index.ts` on `http://127.0.0.1:4174` with `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, and `SUPABASE_SCHEMA=wise_spliter`.
   * Checks if `wise_spliter.groups` is empty and automatically seeds the initial multi-currency ledger dataset if needed.
4. **Frontend Vite Server Startup (`Port 4173`):**
   * Launches the React 19 + Vite client on `http://localhost:4173` with `/api/*` proxied directly to `http://127.0.0.1:4174`.

### 3.2 Containerized Orchestration (`make docker-up-dev`)
Running `make docker-up-dev` orchestrates the containerized development stack via Docker Compose:
* Connects the Wise-Spliter Backend (`:4174`) and Frontend (`:4173`) containers to the centralized Supabase stack via `host.docker.internal:54321` / `:54322`.
* Runs the migration verifier (`scripts/apply-migration.mjs`) prior to serving traffic so the `wise_spliter` schema is guaranteed ready before the UI accepts requests.
