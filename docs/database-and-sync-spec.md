# Wise-Spliter — Database Schema, Offline Sync, Audit History & Security Specification

**Related Documents:**
* [Feature Requirements](./feature-requiremrnts.md)
* [Main Technical Architecture & Algorithms Specification](./technical-spec.md)

---

## 1. Core Design Principles

1. **Isolated Custom Postgres Schema (`wise_spliter`):**
   * All cloud tables, views, enums, triggers, RPC functions, and Row-Level Security (RLS) policies reside strictly inside `CREATE SCHEMA wise_spliter;`.
   * Zero application tables are created in `public`.
2. **Local-First Primary Source of Truth:**
   * The client application maintains a complete 1:1 mirror of the user's groups, members, expenses, revisions, settlements, activity logs, comments, receipts, and FX cache in **Dexie.js (IndexedDB)**.
   * Every UI read and write executes locally in `< 1ms` inside an ACID IndexedDB transaction (`db.transaction('rw', ...)`).
3. **Whole-Expense Atomic Revisions (No Unsafe Partial Financial Merging):**
   * Following **Splitwise's financial integrity model**, an Expense's financial state (`total + currency + fx_rate + payers + splits`) is an **indivisible atomic unit**.
   * Concurrent offline edits to the **same expense** are never silently mixed field-by-field (which could produce a total/split combination neither user intended). Instead, each edit carries `base_revision_id` and a **Hybrid Logical Clock (`hlc`)**. If a `base_revision_id` mismatch occurs during sync, both complete revisions are preserved in `expense_revisions`, the latest `hlc` revision becomes active, and `has_unresolved_conflict = true` surfaces a 1-tap **[Keep Mine] / [Keep Theirs] / [Compare Diff]** banner on the bill.
4. **Transparent Group-Wide Activity & Update History (`group_activity_log`):**
   * Every mutation in a group automatically writes a human-readable, structured entry to `group_activity_log` (visible to all members in the group's **Activity / Updates** tab) as well as `expense_revisions` (visible on the specific expense).

---

## 2. Supabase PostgreSQL Schema (`wise_spliter`)

### 2.1 Schema Initialization & Permissions

```sql
CREATE SCHEMA IF NOT EXISTS wise_spliter;

-- Revoke anonymous access; only authenticated Google OAuth users can access wise_spliter
REVOKE ALL ON SCHEMA wise_spliter FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA wise_spliter TO authenticated, service_role;
```

### 2.2 Tables & Exact Column Definitions

#### 1. `wise_spliter.profiles`
Stores authenticated users (populated automatically via trigger on `auth.users` after Google OAuth sign-in).

```sql
CREATE TABLE wise_spliter.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE, -- normalized lowercase trimmed email
  full_name TEXT NOT NULL,
  avatar_url TEXT,
  default_currency TEXT NOT NULL DEFAULT 'INR',
  upi_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  hlc TEXT NOT NULL,
  server_seq BIGINT GENERATED ALWAYS AS IDENTITY
);
CREATE INDEX idx_profiles_email ON wise_spliter.profiles (lower(email));
```

#### 2. `wise_spliter.groups`
Stores shared expense groups. Supports soft-delete (`deleted_at`) for Trash Recovery and editable `base_currency`.

```sql
CREATE TABLE wise_spliter.groups (
  id UUID PRIMARY KEY, -- Client-generated UUIDv7
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'trip', -- 'trip' | 'home' | 'couple' | 'friends' | 'other'
  cover_image_url TEXT,
  base_currency TEXT NOT NULL DEFAULT 'INR', -- ISO-4217 code (170+ supported)
  simplify_debts BOOLEAN NOT NULL DEFAULT true,
  default_split_config JSONB, -- Optional saved preset: { mode, member_weights / percentages }
  expense_seq INTEGER NOT NULL DEFAULT 0, -- Monotonic counter used for stateless remainder rotation at expense creation
  invite_code TEXT NOT NULL UNIQUE, -- Shareable token for group invite link
  created_by UUID NOT NULL REFERENCES wise_spliter.profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ, -- Non-null when in Trash
  deleted_by UUID REFERENCES wise_spliter.profiles(id),
  hlc TEXT NOT NULL,
  server_seq BIGINT GENERATED ALWAYS AS IDENTITY
);
CREATE INDEX idx_groups_server_seq ON wise_spliter.groups (server_seq);
```

#### 3. `wise_spliter.group_members` (Splitwise Unclaimed $\to$ Auto-Linked Member Model)
Allows signed-in users to add friends immediately by **Name + (Optional Gmail / UPI ID)** so bills can be split right away without waiting for friends to install the app. When a friend signs in with Google (matching `invited_email`) or opens the group's `invite_code`, their `user_id` links automatically to their existing `group_members` row.

```sql
CREATE TABLE wise_spliter.group_members (
  id UUID PRIMARY KEY, -- Client-generated UUIDv7 (referenced by expenses & settlements)
  group_id UUID NOT NULL REFERENCES wise_spliter.groups(id) ON DELETE CASCADE,
  user_id UUID REFERENCES wise_spliter.profiles(id) ON DELETE SET NULL, -- NULL until claimed/linked
  invited_email TEXT, -- Normalized lowercase Gmail; auto-links on sign-in when matched
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  upi_id TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  member_order INTEGER NOT NULL DEFAULT 0, -- Deterministic index in group (0..k-1) for remainder rotation
  added_by UUID NOT NULL REFERENCES wise_spliter.profiles(id),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at TIMESTAMPTZ,
  removed_at TIMESTAMPTZ,
  hlc TEXT NOT NULL,
  server_seq BIGINT GENERATED ALWAYS AS IDENTITY,
  UNIQUE (group_id, user_id),
  UNIQUE (group_id, invited_email)
);
CREATE INDEX idx_group_members_group_user ON wise_spliter.group_members (group_id, user_id);
CREATE INDEX idx_group_members_invited_email ON wise_spliter.group_members (lower(invited_email)) WHERE invited_email IS NOT NULL AND user_id IS NULL;
CREATE INDEX idx_group_members_server_seq ON wise_spliter.group_members (group_id, server_seq);
```

#### 4. `wise_spliter.expenses`
Stores active and soft-deleted bills. Every monetary value is stored in **integer minor units (`BIGINT`)**.

```sql
CREATE TABLE wise_spliter.expenses (
  id UUID PRIMARY KEY, -- Client-generated UUIDv7
  group_id UUID NOT NULL REFERENCES wise_spliter.groups(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  tags TEXT[] NOT NULL DEFAULT '{}',
  notes TEXT NOT NULL DEFAULT '',
  expense_date DATE NOT NULL,

  -- Multi-Currency & Splitwise-style FX Audit Fields
  original_currency TEXT NOT NULL, -- Currency entered by user (e.g., 'EUR')
  original_amount_minor BIGINT NOT NULL CHECK (original_amount_minor > 0),
  group_currency TEXT NOT NULL, -- Group's base_currency at calculation time (e.g., 'INR')
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0), -- Converted amount in group_currency minor units
  fx_rate_scaled BIGINT NOT NULL DEFAULT 100000000 CHECK (fx_rate_scaled > 0), -- Rate * 10^8 (100000000 = 1.0)
  fx_status TEXT NOT NULL DEFAULT 'identity' CHECK (fx_status IN ('identity', 'live', 'cached_offline', 'manual')),
  fx_fetched_at TIMESTAMPTZ,
  fx_audit_note TEXT, -- e.g. 'Converted from €50.00 EUR at 1 EUR = 91.20 INR (2026-11-11)'

  -- Atomic Financial Split & Payer Bundle
  split_mode TEXT NOT NULL CHECK (split_mode IN ('equal', 'exact', 'percentage', 'shares', 'adjustment')),
  rotation_seed INTEGER NOT NULL DEFAULT 0, -- Frozen group expense_seq used when computing equal/share remainders
  payers JSONB NOT NULL,
  /*
    payers schema:
    [
      {
        "member_id": "uuid",
        "paid_minor": 10000,          // in group_currency minor units
        "original_paid_minor": 10000  // in original_currency minor units
      }
    ]
  */
  splits JSONB NOT NULL,
  /*
    splits schema (frozen at save time so deleting other bills never shifts historical paise):
    [
      {
        "member_id": "uuid",
        "included": true,
        "owed_minor": 3334,           // in group_currency minor units
        "original_owed_minor": 3334,  // in original_currency minor units
        "raw_input_value": 1,         // weight, basis_points (e.g. 3333), adjustment_minor, or exact_minor
        "remainder_minor": 1          // 1 if this member received the rotating remainder subunit, else 0
      }
    ]
  */

  -- Revision & Conflict Tracking
  current_revision_id UUID NOT NULL,
  revision_number INTEGER NOT NULL DEFAULT 1,
  has_unresolved_conflict BOOLEAN NOT NULL DEFAULT false,
  conflict_revision_id UUID, -- Points to the superseded concurrent offline revision in expense_revisions

  created_by UUID NOT NULL REFERENCES wise_spliter.profiles(id),
  updated_by UUID NOT NULL REFERENCES wise_spliter.profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  deleted_by UUID REFERENCES wise_spliter.profiles(id),
  hlc TEXT NOT NULL,
  server_seq BIGINT GENERATED ALWAYS AS IDENTITY
);
CREATE INDEX idx_expenses_group_date ON wise_spliter.expenses (group_id, expense_date DESC);
CREATE INDEX idx_expenses_group_seq ON wise_spliter.expenses (group_id, server_seq);
```

#### 5. `wise_spliter.expense_revisions` (Immutable Per-Expense Edit History & Conflict Store)
Stores the full snapshot and structured diff of every create, edit, delete, restore, currency re-denomination, or concurrent offline conflict on an expense.

```sql
CREATE TABLE wise_spliter.expense_revisions (
  id UUID PRIMARY KEY, -- Client-generated UUIDv7
  expense_id UUID NOT NULL REFERENCES wise_spliter.expenses(id) ON DELETE CASCADE,
  group_id UUID NOT NULL REFERENCES wise_spliter.groups(id) ON DELETE CASCADE,
  revision_number INTEGER NOT NULL,
  base_revision_id UUID, -- The revision the user was viewing when they made this edit
  actor_user_id UUID NOT NULL REFERENCES wise_spliter.profiles(id),
  actor_display_name TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN (
    'created', 'updated', 'deleted', 'restored',
    'currency_reconverted', 'conflict_superseded', 'conflict_resolved'
  )),
  changes_json JSONB NOT NULL DEFAULT '[]',
  /*
    changes_json example:
    [
      { "field": "amount_minor", "from": 50000, "to": 60000, "label": "Changed total from ₹500.00 to ₹600.00" },
      { "field": "splits", "label": "Excluded Aman from split" }
    ]
  */
  snapshot JSONB NOT NULL, -- Complete immutable copy of the expense row at this revision
  is_conflict_branch BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  hlc TEXT NOT NULL,
  server_seq BIGINT GENERATED ALWAYS AS IDENTITY
);
CREATE INDEX idx_expense_revisions_expense ON wise_spliter.expense_revisions (expense_id, revision_number DESC);
CREATE INDEX idx_expense_revisions_group_seq ON wise_spliter.expense_revisions (group_id, server_seq);
```

#### 6. `wise_spliter.settlements`
Stores full, partial, and atomic cross-group debt settlements.

```sql
CREATE TABLE wise_spliter.settlements (
  id UUID PRIMARY KEY, -- Client-generated UUIDv7
  group_id UUID NOT NULL REFERENCES wise_spliter.groups(id) ON DELETE CASCADE,
  batch_settlement_id UUID, -- Shared UUID when settling across multiple groups in 1 tap from Friends tab
  from_member_id UUID NOT NULL REFERENCES wise_spliter.group_members(id),
  to_member_id UUID NOT NULL REFERENCES wise_spliter.group_members(id),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0), -- In group's base_currency minor units
  currency TEXT NOT NULL,
  original_currency TEXT,
  original_amount_minor BIGINT,
  fx_rate_scaled BIGINT DEFAULT 100000000,
  payment_method TEXT NOT NULL DEFAULT 'upi' CHECK (payment_method IN ('upi', 'cash', 'bank', 'paypal', 'venmo', 'other')),
  payment_reference TEXT,
  notes TEXT NOT NULL DEFAULT '',
  settled_date DATE NOT NULL,
  created_by UUID NOT NULL REFERENCES wise_spliter.profiles(id),
  updated_by UUID NOT NULL REFERENCES wise_spliter.profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  hlc TEXT NOT NULL,
  server_seq BIGINT GENERATED ALWAYS AS IDENTITY,
  CHECK (from_member_id <> to_member_id)
);
CREATE INDEX idx_settlements_group_seq ON wise_spliter.settlements (group_id, server_seq);
CREATE INDEX idx_settlements_batch ON wise_spliter.settlements (batch_settlement_id) WHERE batch_settlement_id IS NOT NULL;
```

#### 7. `wise_spliter.group_activity_log` (Group-Wide Transparent Update History)
Provides complete transparency to every member in a group. Every action in the group—who added a bill, who changed an amount from X to Y, who removed a participant, who settled up, who changed group currency, or when an offline edit conflict occurred—is recorded here and visible in the group's **Activity / History** feed.

```sql
CREATE TABLE wise_spliter.group_activity_log (
  id UUID PRIMARY KEY, -- UUIDv7
  group_id UUID NOT NULL REFERENCES wise_spliter.groups(id) ON DELETE CASCADE,
  actor_user_id UUID NOT NULL REFERENCES wise_spliter.profiles(id),
  actor_display_name TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('group', 'member', 'expense', 'settlement', 'comment', 'currency')),
  entity_id UUID NOT NULL,
  action TEXT NOT NULL,
  /*
    Examples of action:
    'group_created', 'group_updated', 'group_currency_changed',
    'member_added', 'member_claimed', 'member_removed',
    'expense_created', 'expense_updated', 'expense_deleted', 'expense_restored', 'expense_conflict_flagged',
    'settlement_recorded', 'settlement_updated', 'settlement_deleted',
    'comment_added'
  */
  summary_text TEXT NOT NULL, -- e.g. 'Chetan updated "Beach Dinner": Total ₹1,000.00 → ₹1,200.00'
  metadata JSONB NOT NULL DEFAULT '{}', -- Structured before/after diff, revision_id, amount_minor, currency
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  hlc TEXT NOT NULL,
  server_seq BIGINT GENERATED ALWAYS AS IDENTITY
);
CREATE INDEX idx_group_activity_group_created ON wise_spliter.group_activity_log (group_id, created_at DESC);
CREATE INDEX idx_group_activity_group_seq ON wise_spliter.group_activity_log (group_id, server_seq);
```

#### 8. `wise_spliter.comments` & `wise_spliter.receipt_attachments`

```sql
CREATE TABLE wise_spliter.comments (
  id UUID PRIMARY KEY,
  group_id UUID NOT NULL REFERENCES wise_spliter.groups(id) ON DELETE CASCADE,
  expense_id UUID REFERENCES wise_spliter.expenses(id) ON DELETE CASCADE,
  settlement_id UUID REFERENCES wise_spliter.settlements(id) ON DELETE CASCADE,
  author_user_id UUID NOT NULL REFERENCES wise_spliter.profiles(id),
  author_display_name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  hlc TEXT NOT NULL,
  server_seq BIGINT GENERATED ALWAYS AS IDENTITY
);

CREATE TABLE wise_spliter.receipt_attachments (
  id UUID PRIMARY KEY,
  group_id UUID NOT NULL REFERENCES wise_spliter.groups(id) ON DELETE CASCADE,
  expense_id UUID NOT NULL REFERENCES wise_spliter.expenses(id) ON DELETE CASCADE,
  storage_path TEXT NOT NULL, -- Path inside private bucket `wise-spliter-receipts`
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  uploaded_by UUID NOT NULL REFERENCES wise_spliter.profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  hlc TEXT NOT NULL,
  server_seq BIGINT GENERATED ALWAYS AS IDENTITY
);
```

#### 9. `wise_spliter.fx_rates_cache` & `wise_spliter.applied_sync_ops` (Idempotency Ledger)

```sql
CREATE TABLE wise_spliter.fx_rates_cache (
  base_currency TEXT PRIMARY KEY,
  rates_scaled JSONB NOT NULL, -- Map of ISO-4217 -> integer rate scaled by 10^8
  provider TEXT NOT NULL DEFAULT 'open_exchange_rates',
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE wise_spliter.applied_sync_ops (
  op_id UUID PRIMARY KEY, -- Client mutation UUIDv7 from sync_outbox
  user_id UUID NOT NULL REFERENCES wise_spliter.profiles(id),
  group_id UUID NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  result_status TEXT NOT NULL -- 'applied' | 'conflict_superseded' | 'noop_duplicate'
);
```

---

## 3. Local IndexedDB Schema (`Dexie.js`)

The local database on Desktop, iOS, Android, and Web mirrors `wise_spliter` tables 1:1 and adds three local-only operational stores:

```ts
// src/storage/local-db.ts
export class WiseSpliterLocalDB extends Dexie {
  profiles!: Table<LocalProfile, string>;
  groups!: Table<LocalGroup, string>;
  group_members!: Table<LocalGroupMember, string>;
  expenses!: Table<LocalExpense, string>;
  expense_revisions!: Table<LocalExpenseRevision, string>;
  settlements!: Table<LocalSettlement, string>;
  group_activity_log!: Table<LocalGroupActivity, string>;
  comments!: Table<LocalComment, string>;
  receipt_attachments!: Table<LocalReceiptAttachment, string>;
  fx_rates_cache!: Table<LocalFxRateCache, string>;

  // Local-only stores for 100% offline operation:
  sync_outbox!: Table<SyncOutboxEntry, string>; // Pending offline mutations in FIFO order
  sync_cursors!: Table<SyncCursorState, string>; // Tracks last_pulled_server_seq per group/table
  local_receipt_blobs!: Table<LocalReceiptBlob, string>; // Stores compressed image Blobs until uploaded
}
```

---

## 4. Multi-User Offline Sync & Conflict Resolution Algorithm

### 4.1 Hybrid Logical Clock (`HLC`) Format
Every device maintains a monotonic **Hybrid Logical Clock** formatted as a lexicographically sortable string:
```
<48-bit-unix-ms-hex>-<16-bit-logical-counter-hex>-<device-node-id>
Example: "019a73e4c210-0001-9f8b2c"
```

### 4.2 Atomic Expense Invariant Enforcement (Client + Database Trigger)
Before any expense write is accepted (both locally in Dexie and in Postgres `wise_spliter.apply_sync_batch`), a strict validation function verifies:
1. $\sum_{p \in \text{payers}} p.\text{paid\_minor} == \text{expense.amount\_minor}$
2. $\sum_{s \in \text{splits}, s.\text{included}} s.\text{owed\_minor} == \text{expense.amount\_minor}$
3. Every `member_id` in `payers` and `splits` belongs to `expense.group_id`.

### 4.3 Step-by-Step Resolution When Multiple Group Members Edit Offline & Online
When a device comes online and pushes its `sync_outbox` entries via `wise_spliter.apply_sync_batch(ops JSONB)`:

1. **Idempotency Check (`op_id`):**
   * If `op.op_id` already exists in `wise_spliter.applied_sync_ops`, skip immediately (`noop_duplicate`). This guarantees flaky travel Wi-Fi retries never create duplicate bills or settlements.
2. **Case A — Creating New Expenses, Settlements, or Comments Offline:**
   * Since primary keys are client-generated `UUIDv7`, new expenses created offline by User A and User B insert cleanly with zero collision, append to `expense_revisions` (`action = 'created'`), and append to `group_activity_log`.
3. **Case B — Updating an Existing Expense (`op.base_revision_id == current_expense.current_revision_id`):**
   * No other user edited this expense since the author last synced.
   * The expense row updates atomically to `revision_number + 1`, a new `expense_revisions` entry is inserted with the exact field-by-field diff (`changes_json`), and `group_activity_log` records the update for the whole group to see.
4. **Case C — Concurrent Offline Edit on the Same Expense (`op.base_revision_id != current_expense.current_revision_id`):**
   * Another group member already modified this expense while the current user was offline!
   * **Zero Silent Mixing & Zero Data Loss:**
     1. Both complete versions are stored as immutable snapshots in `wise_spliter.expense_revisions`.
     2. Compare `op.hlc` vs `current_expense.hlc`:
        * If `op.hlc > current_expense.hlc`: `op`'s snapshot becomes the active row on `wise_spliter.expenses`, and `conflict_revision_id` points to the previous `current_revision_id`.
        * If `op.hlc < current_expense.hlc`: `current_expense` remains active, `op`'s snapshot is saved in `expense_revisions` with `is_conflict_branch = true`, and `conflict_revision_id` points to `op.revision_id`.
     3. Set `has_unresolved_conflict = true` on `wise_spliter.expenses`.
     4. Insert a prominent entry in `wise_spliter.group_activity_log` (`action = 'expense_conflict_flagged'`, summary: *"Concurrent offline edits detected on 'Dinner' by Chetan and Rahul — review & confirm version"*).
     5. In the UI, any group member can tap **[Keep Chetan's Version]**, **[Keep Rahul's Version]**, or **[Edit & Resolve]**, which clears `has_unresolved_conflict` and logs `'conflict_resolved'` in `group_activity_log`.

### 4.4 Automatic Claiming of Unclaimed Group Members on Google Sign-In
When a user signs in with Google OAuth (`auth.users`):
```sql
-- Triggered automatically upon profile creation/login:
UPDATE wise_spliter.group_members
SET user_id = NEW.id,
    avatar_url = COALESCE(avatar_url, NEW.avatar_url),
    claimed_at = now()
WHERE lower(invited_email) = lower(NEW.email)
  AND user_id IS NULL;
```
Additionally, if a friend joins via a group's shareable invite link (`/join/:invite_code`), they can select their unclaimed member slot (`user_id IS NULL`) to link their Google account to all of their existing expenses and balances in that group.

---

## 5. Security & Row-Level_Security (RLS) Architecture

Every table in `wise_spliter` has `ALTER TABLE ... ENABLE ROW LEVEL SECURITY;` and `FORCE ROW LEVEL SECURITY;`.

### 5.1 Fast Security-Definer Membership Helper
To avoid recursive RLS performance bottlenecks, membership checks use an indexed `SECURITY DEFINER` function:

```sql
CREATE OR REPLACE FUNCTION wise_spliter.is_group_member(target_group_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = wise_spliter
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM wise_spliter.group_members gm
    WHERE gm.group_id = target_group_id
      AND gm.user_id = auth.uid()
      AND gm.removed_at IS NULL
  );
$$;
```

### 5.2 Table Policies
* **`wise_spliter.groups`:** `SELECT`, `UPDATE` allowed only when `wise_spliter.is_group_member(id)` is true; `INSERT` allowed when `created_by = auth.uid()`.
* **`wise_spliter.group_members`, `expenses`, `expense_revisions`, `settlements`, `group_activity_log`, `comments`, `receipt_attachments`:** `SELECT`, `INSERT`, `UPDATE` allowed only when `wise_spliter.is_group_member(group_id)` is true.
* **`Storage Bucket (wise-spliter-receipts)`:** Private bucket; object paths follow `{group_id}/{expense_id}/{attachment_id}.webp` and storage RLS verifies `wise_spliter.is_group_member((storage.foldername(name))[1]::uuid)`.
