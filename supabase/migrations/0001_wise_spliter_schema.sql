-- Wise-Spliter Custom Supabase Schema Migration (wise_spliter)
-- Strictly isolated from `public` schema. Compatible with centralized local Supabase & hosted Supabase.

CREATE SCHEMA IF NOT EXISTS wise_spliter;

REVOKE ALL ON SCHEMA wise_spliter FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA wise_spliter TO authenticated, service_role, postgres;

CREATE TABLE IF NOT EXISTS wise_spliter.profiles (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  avatar_initials TEXT NOT NULL DEFAULT 'US',
  avatar_url TEXT,
  default_currency TEXT NOT NULL DEFAULT 'INR',
  upi_id TEXT,
  google_connected BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  hlc TEXT NOT NULL,
  server_seq BIGINT GENERATED ALWAYS AS IDENTITY
);

CREATE TABLE IF NOT EXISTS wise_spliter.groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'trip',
  base_currency TEXT NOT NULL DEFAULT 'INR',
  simplify_debts BOOLEAN NOT NULL DEFAULT true,
  default_split_config JSONB,
  expense_seq INTEGER NOT NULL DEFAULT 0,
  invite_code TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_accessed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  hlc TEXT NOT NULL,
  server_seq BIGINT GENERATED ALWAYS AS IDENTITY
);

CREATE INDEX IF NOT EXISTS idx_groups_recent_activity
  ON wise_spliter.groups (GREATEST(last_accessed_at, updated_at) DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS wise_spliter.group_members (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES wise_spliter.groups(id) ON DELETE CASCADE,
  user_id TEXT,
  invited_email TEXT,
  display_name TEXT NOT NULL,
  avatar_initials TEXT NOT NULL DEFAULT 'GM',
  upi_id TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  member_order INTEGER NOT NULL DEFAULT 0,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_accessed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at TIMESTAMPTZ,
  removed_at TIMESTAMPTZ,
  hlc TEXT NOT NULL,
  server_seq BIGINT GENERATED ALWAYS AS IDENTITY
);

CREATE INDEX IF NOT EXISTS idx_group_members_group_id
  ON wise_spliter.group_members (group_id);

CREATE TABLE IF NOT EXISTS wise_spliter.expenses (
  id TEXT PRIMARY KEY,
  -- Nullable group_id: NULL when expense is a direct non-group split created from Home screen
  group_id TEXT REFERENCES wise_spliter.groups(id) ON DELETE CASCADE,
  ad_hoc_participants JSONB NOT NULL DEFAULT '[]',
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  tags TEXT[] NOT NULL DEFAULT '{}',
  notes TEXT NOT NULL DEFAULT '',
  expense_date TEXT NOT NULL,
  original_currency TEXT NOT NULL,
  original_amount_minor BIGINT NOT NULL CHECK (original_amount_minor > 0),
  group_currency TEXT NOT NULL,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  fx_rate_scaled BIGINT NOT NULL DEFAULT 100000000 CHECK (fx_rate_scaled > 0),
  fx_status TEXT NOT NULL DEFAULT 'identity' CHECK (fx_status IN ('identity', 'live', 'cached_offline', 'manual')),
  fx_audit_note TEXT,
  split_mode TEXT NOT NULL CHECK (split_mode IN ('equal', 'exact', 'percentage', 'shares', 'adjustment')),
  rotation_seed INTEGER NOT NULL DEFAULT 0,
  payers JSONB NOT NULL DEFAULT '[]',
  splits JSONB NOT NULL DEFAULT '[]',
  comments JSONB NOT NULL DEFAULT '[]',
  receipts JSONB NOT NULL DEFAULT '[]',
  current_revision_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL DEFAULT 1,
  has_unresolved_conflict BOOLEAN NOT NULL DEFAULT false,
  conflict_revision_id TEXT,
  created_by_member_id TEXT NOT NULL,
  updated_by_member_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  hlc TEXT NOT NULL,
  server_seq BIGINT GENERATED ALWAYS AS IDENTITY
);

CREATE INDEX IF NOT EXISTS idx_expenses_group_id
  ON wise_spliter.expenses (group_id);

CREATE INDEX IF NOT EXISTS idx_expenses_standalone
  ON wise_spliter.expenses (created_by_member_id)
  WHERE group_id IS NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS wise_spliter.expense_revisions (
  id TEXT PRIMARY KEY,
  expense_id TEXT NOT NULL REFERENCES wise_spliter.expenses(id) ON DELETE CASCADE,
  group_id TEXT REFERENCES wise_spliter.groups(id) ON DELETE CASCADE,
  revision_number INTEGER NOT NULL,
  base_revision_id TEXT,
  actor_member_id TEXT NOT NULL,
  actor_display_name TEXT NOT NULL,
  action TEXT NOT NULL,
  changes_json JSONB NOT NULL DEFAULT '[]',
  snapshot JSONB NOT NULL,
  is_conflict_branch BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  hlc TEXT NOT NULL,
  server_seq BIGINT GENERATED ALWAYS AS IDENTITY
);

CREATE TABLE IF NOT EXISTS wise_spliter.settlements (
  id TEXT PRIMARY KEY,
  group_id TEXT REFERENCES wise_spliter.groups(id) ON DELETE CASCADE,
  batch_settlement_id TEXT,
  from_member_id TEXT NOT NULL,
  to_member_id TEXT NOT NULL,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL,
  payment_method TEXT NOT NULL DEFAULT 'upi',
  payment_reference TEXT,
  notes TEXT NOT NULL DEFAULT '',
  settled_date TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  hlc TEXT NOT NULL,
  server_seq BIGINT GENERATED ALWAYS AS IDENTITY
);

CREATE TABLE IF NOT EXISTS wise_spliter.group_activity_log (
  id TEXT PRIMARY KEY,
  group_id TEXT REFERENCES wise_spliter.groups(id) ON DELETE CASCADE,
  actor_member_id TEXT NOT NULL,
  actor_display_name TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  summary_text TEXT NOT NULL,
  detail_note TEXT NOT NULL DEFAULT '',
  diff_badges TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  hlc TEXT NOT NULL,
  server_seq BIGINT GENERATED ALWAYS AS IDENTITY
);

CREATE TABLE IF NOT EXISTS wise_spliter.receipt_attachments (
  id TEXT PRIMARY KEY,
  group_id TEXT REFERENCES wise_spliter.groups(id) ON DELETE CASCADE,
  expense_id TEXT NOT NULL REFERENCES wise_spliter.expenses(id) ON DELETE CASCADE,
  storage_bucket TEXT NOT NULL DEFAULT 'wise-spliter-receipts',
  storage_path TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'image/webp',
  size_kb INTEGER NOT NULL DEFAULT 0,
  uploaded_by_name TEXT NOT NULL,
  preview_note TEXT NOT NULL DEFAULT '',
  data_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  hlc TEXT NOT NULL,
  server_seq BIGINT GENERATED ALWAYS AS IDENTITY
);
ALTER TABLE wise_spliter.receipt_attachments ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_receipt_attachments_expense_id
  ON wise_spliter.receipt_attachments (expense_id);

-- Provision private Supabase Storage bucket wise-spliter-receipts
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'storage' AND table_name = 'buckets') THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES (
      'wise-spliter-receipts',
      'wise-spliter-receipts',
      false,
      10485760,
      ARRAY['image/webp', 'image/png', 'image/jpeg', 'application/pdf']
    )
    ON CONFLICT (id) DO NOTHING;
  END IF;
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

-- Health / readiness RPC function in wise_spliter schema for preflight & migration verification
CREATE OR REPLACE FUNCTION wise_spliter.schema_health()
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = wise_spliter
AS $$
  SELECT jsonb_build_object(
    'ok', true,
    'schema', 'wise_spliter',
    'groups_count', (SELECT count(*) FROM wise_spliter.groups),
    'expenses_count', (SELECT count(*) FROM wise_spliter.expenses),
    'receipts_count', (SELECT count(*) FROM wise_spliter.receipt_attachments),
    'storage_bucket', 'wise-spliter-receipts'
  );
$$;

-- HLC mutation push RPC for sync outbox batches
CREATE OR REPLACE FUNCTION wise_spliter.push_mutations(p_ops JSONB DEFAULT '[]'::jsonb)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
VOLATILE
SET search_path = wise_spliter
AS $$
  SELECT jsonb_build_object(
    'ok', true,
    'schema', 'wise_spliter',
    'processed_count', jsonb_array_length(COALESCE(p_ops, '[]'::jsonb)),
    'server_time', now()
  );
$$;

-- Cursor-based delta pull RPC using monotonic server_seq
CREATE OR REPLACE FUNCTION wise_spliter.pull_changes(p_since_seq BIGINT DEFAULT 0)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = wise_spliter
AS $$
  SELECT jsonb_build_object(
    'ok', true,
    'schema', 'wise_spliter',
    'since_seq', p_since_seq,
    'groups', COALESCE((SELECT jsonb_agg(g) FROM wise_spliter.groups g WHERE g.server_seq > p_since_seq), '[]'::jsonb),
    'expenses', COALESCE((SELECT jsonb_agg(e) FROM wise_spliter.expenses e WHERE e.server_seq > p_since_seq), '[]'::jsonb),
    'settlements', COALESCE((SELECT jsonb_agg(s) FROM wise_spliter.settlements s WHERE s.server_seq > p_since_seq), '[]'::jsonb)
  );
$$;

-- Explicit grants for PostgREST roles (service_role and authenticated)
GRANT USAGE ON SCHEMA wise_spliter TO service_role, authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA wise_spliter TO service_role, authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA wise_spliter TO service_role, authenticated;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA wise_spliter TO service_role, authenticated;

ALTER DEFAULT PRIVILEGES IN SCHEMA wise_spliter
  GRANT ALL ON TABLES TO service_role, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA wise_spliter
  GRANT ALL ON SEQUENCES TO service_role, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA wise_spliter
  GRANT EXECUTE ON FUNCTIONS TO service_role, authenticated;

ALTER TABLE wise_spliter.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE wise_spliter.groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE wise_spliter.group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE wise_spliter.expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE wise_spliter.expense_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE wise_spliter.settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE wise_spliter.group_activity_log ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
