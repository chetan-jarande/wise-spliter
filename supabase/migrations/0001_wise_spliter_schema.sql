-- Wise-Spliter Custom Supabase Schema Migration (wise_spliter)
-- Strictly isolated from `public` schema.

CREATE SCHEMA IF NOT EXISTS wise_spliter;

REVOKE ALL ON SCHEMA wise_spliter FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA wise_spliter TO authenticated, service_role;

CREATE TABLE IF NOT EXISTS wise_spliter.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  avatar_url TEXT,
  default_currency TEXT NOT NULL DEFAULT 'INR',
  upi_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  hlc TEXT NOT NULL,
  server_seq BIGINT GENERATED ALWAYS AS IDENTITY
);

CREATE TABLE IF NOT EXISTS wise_spliter.groups (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'trip',
  base_currency TEXT NOT NULL DEFAULT 'INR',
  simplify_debts BOOLEAN NOT NULL DEFAULT true,
  default_split_config JSONB,
  expense_seq INTEGER NOT NULL DEFAULT 0,
  invite_code TEXT NOT NULL UNIQUE,
  created_by UUID NOT NULL REFERENCES wise_spliter.profiles(id),
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
  id UUID PRIMARY KEY,
  group_id UUID NOT NULL REFERENCES wise_spliter.groups(id) ON DELETE CASCADE,
  user_id UUID REFERENCES wise_spliter.profiles(id) ON DELETE SET NULL,
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

CREATE TABLE IF NOT EXISTS wise_spliter.expenses (
  id UUID PRIMARY KEY,
  -- Nullable group_id: NULL when expense is a direct non-group split created from Home screen
  group_id UUID REFERENCES wise_spliter.groups(id) ON DELETE CASCADE,
  ad_hoc_participants JSONB NOT NULL DEFAULT '[]',
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  tags TEXT[] NOT NULL DEFAULT '{}',
  notes TEXT NOT NULL DEFAULT '',
  expense_date DATE NOT NULL,
  original_currency TEXT NOT NULL,
  original_amount_minor BIGINT NOT NULL CHECK (original_amount_minor > 0),
  group_currency TEXT NOT NULL,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  fx_rate_scaled BIGINT NOT NULL DEFAULT 100000000 CHECK (fx_rate_scaled > 0),
  fx_status TEXT NOT NULL DEFAULT 'identity' CHECK (fx_status IN ('identity', 'live', 'cached_offline', 'manual')),
  fx_audit_note TEXT,
  split_mode TEXT NOT NULL CHECK (split_mode IN ('equal', 'exact', 'percentage', 'shares', 'adjustment')),
  rotation_seed INTEGER NOT NULL DEFAULT 0,
  payers JSONB NOT NULL,
  splits JSONB NOT NULL,
  current_revision_id UUID NOT NULL,
  revision_number INTEGER NOT NULL DEFAULT 1,
  has_unresolved_conflict BOOLEAN NOT NULL DEFAULT false,
  conflict_revision_id UUID,
  created_by UUID NOT NULL REFERENCES wise_spliter.profiles(id),
  updated_by UUID NOT NULL REFERENCES wise_spliter.profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  hlc TEXT NOT NULL,
  server_seq BIGINT GENERATED ALWAYS AS IDENTITY
);

CREATE INDEX IF NOT EXISTS idx_expenses_standalone_creator
  ON wise_spliter.expenses (created_by, expense_date DESC)
  WHERE group_id IS NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS wise_spliter.expense_revisions (
  id UUID PRIMARY KEY,
  expense_id UUID NOT NULL REFERENCES wise_spliter.expenses(id) ON DELETE CASCADE,
  group_id UUID REFERENCES wise_spliter.groups(id) ON DELETE CASCADE,
  revision_number INTEGER NOT NULL,
  base_revision_id UUID,
  actor_user_id UUID NOT NULL REFERENCES wise_spliter.profiles(id),
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
  id UUID PRIMARY KEY,
  group_id UUID REFERENCES wise_spliter.groups(id) ON DELETE CASCADE,
  batch_settlement_id UUID,
  from_member_id UUID NOT NULL,
  to_member_id UUID NOT NULL,
  from_display_name TEXT,
  to_display_name TEXT,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL,
  payment_method TEXT NOT NULL DEFAULT 'upi',
  payment_reference TEXT,
  notes TEXT NOT NULL DEFAULT '',
  settled_date DATE NOT NULL,
  created_by UUID REFERENCES wise_spliter.profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  hlc TEXT NOT NULL,
  server_seq BIGINT GENERATED ALWAYS AS IDENTITY
);

CREATE TABLE IF NOT EXISTS wise_spliter.group_activity_log (
  id UUID PRIMARY KEY,
  group_id UUID REFERENCES wise_spliter.groups(id) ON DELETE CASCADE,
  actor_user_id UUID NOT NULL REFERENCES wise_spliter.profiles(id),
  actor_display_name TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  action TEXT NOT NULL,
  summary_text TEXT NOT NULL,
  detail_note TEXT NOT NULL DEFAULT '',
  diff_badges TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  hlc TEXT NOT NULL,
  server_seq BIGINT GENERATED ALWAYS AS IDENTITY
);

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

CREATE OR REPLACE FUNCTION wise_spliter.can_access_expense(
  target_group_id UUID,
  creator_id UUID,
  ad_hoc_participants JSONB
)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = wise_spliter
AS $$
  SELECT CASE
    WHEN target_group_id IS NOT NULL THEN wise_spliter.is_group_member(target_group_id)
    ELSE (
      creator_id = auth.uid()
      OR ad_hoc_participants @> jsonb_build_array(jsonb_build_object('userId', auth.uid()::text))
    )
  END;
$$;

ALTER TABLE wise_spliter.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE wise_spliter.groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE wise_spliter.group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE wise_spliter.expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE wise_spliter.expense_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE wise_spliter.settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE wise_spliter.group_activity_log ENABLE ROW LEVEL SECURITY;
