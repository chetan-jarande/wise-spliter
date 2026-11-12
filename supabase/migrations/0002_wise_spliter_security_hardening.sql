-- Wise-Spliter Security Hardening Migration (0002)
-- Remediates direct PostgREST (:54321) bypass, SECURITY DEFINER RPC data leaks,
-- over-broad table privileges, missing FORCE ROW LEVEL SECURITY, and private Storage RLS.
-- Idempotent: safe to re-run after 0001_wise_spliter_schema.sql on every `make migrate-up`.

-- =============================================================================
-- 1. Schema, Default Privilege & Table Least-Privilege Lockdown
-- =============================================================================

REVOKE ALL ON SCHEMA wise_spliter FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA wise_spliter TO authenticated, service_role, postgres;

REVOKE ALL ON ALL TABLES IN SCHEMA wise_spliter FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA wise_spliter FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA wise_spliter FROM PUBLIC, anon, authenticated;

ALTER DEFAULT PRIVILEGES IN SCHEMA wise_spliter
  REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA wise_spliter
  REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA wise_spliter
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;

GRANT ALL ON ALL TABLES IN SCHEMA wise_spliter TO service_role, postgres;
GRANT ALL ON ALL SEQUENCES IN SCHEMA wise_spliter TO service_role, postgres;

ALTER DEFAULT PRIVILEGES IN SCHEMA wise_spliter
  GRANT ALL ON TABLES TO service_role, postgres;
ALTER DEFAULT PRIVILEGES IN SCHEMA wise_spliter
  GRANT ALL ON SEQUENCES TO service_role, postgres;

-- Defense-in-depth least-privilege grants for `authenticated` (strictly gated by FORCE RLS below)
GRANT SELECT, INSERT, UPDATE ON
  wise_spliter.profiles,
  wise_spliter.groups,
  wise_spliter.group_members,
  wise_spliter.expenses,
  wise_spliter.settlements,
  wise_spliter.receipt_attachments
TO authenticated;

GRANT DELETE ON wise_spliter.groups TO authenticated;

-- Immutable audit tables: append-only (no UPDATE or DELETE for authenticated)
GRANT SELECT, INSERT ON
  wise_spliter.expense_revisions,
  wise_spliter.group_activity_log
TO authenticated;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA wise_spliter TO authenticated;

-- =============================================================================
-- 2. Performance Indexes for RLS Predicate Evaluation
-- =============================================================================

CREATE INDEX IF NOT EXISTS idx_profiles_lower_email
  ON wise_spliter.profiles (lower(email));

CREATE INDEX IF NOT EXISTS idx_groups_created_by
  ON wise_spliter.groups (created_by);

CREATE INDEX IF NOT EXISTS idx_group_members_active_user
  ON wise_spliter.group_members (group_id, user_id)
  WHERE removed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_group_members_active_email
  ON wise_spliter.group_members (group_id, lower(invited_email))
  WHERE invited_email IS NOT NULL AND removed_at IS NULL;

-- =============================================================================
-- 3. Safe Caller-Scoped RLS Predicate Helpers
--    NEVER trusts user_metadata or deprecated auth.role().
--    Resolves verified identity directly from auth.users via (SELECT auth.uid()).
-- =============================================================================

CREATE OR REPLACE FUNCTION wise_spliter.current_auth_email()
RETURNS TEXT
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT lower(u.email)
  FROM auth.users u
  WHERE u.id = (SELECT auth.uid())
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION wise_spliter.current_profile_id()
RETURNS TEXT
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT COALESCE(
    (
      SELECT p.id
      FROM wise_spliter.profiles p
      JOIN auth.users u ON lower(u.email) = lower(p.email)
      WHERE u.id = (SELECT auth.uid())
      LIMIT 1
    ),
    (SELECT auth.uid())::text
  );
$$;

CREATE OR REPLACE FUNCTION wise_spliter.is_group_member(p_group_id TEXT)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN (SELECT auth.uid()) IS NULL OR p_group_id IS NULL THEN false
    ELSE EXISTS (
      SELECT 1
      FROM wise_spliter.groups g
      WHERE g.id = p_group_id
        AND (
          g.created_by = (SELECT wise_spliter.current_profile_id())
          OR g.created_by = (SELECT auth.uid())::text
        )
    ) OR EXISTS (
      SELECT 1
      FROM wise_spliter.group_members gm
      WHERE gm.group_id = p_group_id
        AND gm.removed_at IS NULL
        AND (
          gm.user_id = (SELECT wise_spliter.current_profile_id())
          OR gm.user_id = (SELECT auth.uid())::text
          OR (
            gm.invited_email IS NOT NULL
            AND lower(gm.invited_email) = (SELECT wise_spliter.current_auth_email())
          )
        )
    )
  END;
$$;

CREATE OR REPLACE FUNCTION wise_spliter.is_standalone_expense_participant(
  p_ad_hoc JSONB,
  p_created_by TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN (SELECT auth.uid()) IS NULL THEN false
    WHEN p_created_by IN (
      (SELECT wise_spliter.current_profile_id()),
      (SELECT auth.uid())::text
    ) THEN true
    ELSE EXISTS (
      SELECT 1
      FROM jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(p_ad_hoc) = 'array' THEN p_ad_hoc
          ELSE '[]'::jsonb
        END
      ) AS elem
      WHERE (elem ->> 'id') IN (
        (SELECT wise_spliter.current_profile_id()),
        (SELECT auth.uid())::text
      )
      OR lower(COALESCE(elem ->> 'invitedEmail', elem ->> 'invited_email', '')) = (
        SELECT wise_spliter.current_auth_email()
      )
    )
  END;
$$;

CREATE OR REPLACE FUNCTION wise_spliter.can_access_expense(
  p_expense_id TEXT,
  p_group_id TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN (SELECT auth.uid()) IS NULL THEN false
    WHEN p_group_id IS NOT NULL THEN (SELECT wise_spliter.is_group_member(p_group_id))
    WHEN p_expense_id IS NULL THEN false
    ELSE EXISTS (
      SELECT 1
      FROM wise_spliter.expenses e
      WHERE e.id = p_expense_id
        AND (
          (e.group_id IS NOT NULL AND (SELECT wise_spliter.is_group_member(e.group_id)))
          OR (
            e.group_id IS NULL
            AND (SELECT wise_spliter.is_standalone_expense_participant(e.ad_hoc_participants, e.created_by_member_id))
          )
        )
    )
  END;
$$;

REVOKE EXECUTE ON FUNCTION wise_spliter.current_auth_email() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION wise_spliter.current_profile_id() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION wise_spliter.is_group_member(TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION wise_spliter.is_standalone_expense_participant(JSONB, TEXT) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION wise_spliter.can_access_expense(TEXT, TEXT) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION wise_spliter.current_auth_email() TO authenticated, service_role, postgres;
GRANT EXECUTE ON FUNCTION wise_spliter.current_profile_id() TO authenticated, service_role, postgres;
GRANT EXECUTE ON FUNCTION wise_spliter.is_group_member(TEXT) TO authenticated, service_role, postgres;
GRANT EXECUTE ON FUNCTION wise_spliter.is_standalone_expense_participant(JSONB, TEXT) TO authenticated, service_role, postgres;
GRANT EXECUTE ON FUNCTION wise_spliter.can_access_expense(TEXT, TEXT) TO authenticated, service_role, postgres;

-- =============================================================================
-- 4. Backend Gatekeeper-Only SECURITY DEFINER RPCs
--    Strictly restricted to `service_role` and `postgres` via BOTH SQL GRANTs
--    and runtime role assertion (blocks direct PostgREST :54321 tenant dumps).
-- =============================================================================

CREATE OR REPLACE FUNCTION wise_spliter.schema_health()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
BEGIN
  IF current_user NOT IN ('service_role', 'postgres') THEN
    RAISE EXCEPTION 'permission denied for function schema_health'
      USING ERRCODE = '42501';
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'schema', 'wise_spliter',
    'groups_count', (SELECT count(*) FROM wise_spliter.groups),
    'expenses_count', (SELECT count(*) FROM wise_spliter.expenses),
    'receipts_count', (SELECT count(*) FROM wise_spliter.receipt_attachments),
    'storage_bucket', 'wise-spliter-receipts',
    'rls_forced_count', (
      SELECT count(*)
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'wise_spliter'
        AND c.relkind = 'r'
        AND c.relrowsecurity = true
        AND c.relforcerowsecurity = true
    ),
    'authenticated_rpc_blocked', (
      NOT has_function_privilege('authenticated', 'wise_spliter.pull_changes(bigint)', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'wise_spliter.push_mutations(jsonb)', 'EXECUTE')
      AND NOT has_function_privilege('authenticated', 'wise_spliter.schema_health()', 'EXECUTE')
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION wise_spliter.push_mutations(p_ops JSONB DEFAULT '[]'::jsonb)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = ''
AS $$
BEGIN
  IF current_user NOT IN ('service_role', 'postgres') THEN
    RAISE EXCEPTION 'permission denied for function push_mutations'
      USING ERRCODE = '42501';
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'schema', 'wise_spliter',
    'processed_count', jsonb_array_length(
      CASE
        WHEN jsonb_typeof(COALESCE(p_ops, '[]'::jsonb)) = 'array' THEN COALESCE(p_ops, '[]'::jsonb)
        ELSE '[]'::jsonb
      END
    ),
    'server_time', now()
  );
END;
$$;

CREATE OR REPLACE FUNCTION wise_spliter.pull_changes(p_since_seq BIGINT DEFAULT 0)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
BEGIN
  IF current_user NOT IN ('service_role', 'postgres') THEN
    RAISE EXCEPTION 'permission denied for function pull_changes'
      USING ERRCODE = '42501';
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'schema', 'wise_spliter',
    'since_seq', p_since_seq,
    'groups', COALESCE((SELECT jsonb_agg(g) FROM wise_spliter.groups g WHERE g.server_seq > p_since_seq), '[]'::jsonb),
    'expenses', COALESCE((SELECT jsonb_agg(e) FROM wise_spliter.expenses e WHERE e.server_seq > p_since_seq), '[]'::jsonb),
    'settlements', COALESCE((SELECT jsonb_agg(s) FROM wise_spliter.settlements s WHERE s.server_seq > p_since_seq), '[]'::jsonb),
    'expense_revisions', COALESCE((SELECT jsonb_agg(r) FROM wise_spliter.expense_revisions r WHERE r.server_seq > p_since_seq), '[]'::jsonb),
    'group_activity_log', COALESCE((SELECT jsonb_agg(a) FROM wise_spliter.group_activity_log a WHERE a.server_seq > p_since_seq), '[]'::jsonb)
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION wise_spliter.schema_health() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION wise_spliter.push_mutations(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION wise_spliter.pull_changes(BIGINT) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION wise_spliter.schema_health() TO service_role, postgres;
GRANT EXECUTE ON FUNCTION wise_spliter.push_mutations(JSONB) TO service_role, postgres;
GRANT EXECUTE ON FUNCTION wise_spliter.pull_changes(BIGINT) TO service_role, postgres;

-- =============================================================================
-- 5. Enable & FORCE Row Level Security Across All 8 wise_spliter Tables
-- =============================================================================

ALTER TABLE wise_spliter.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE wise_spliter.profiles FORCE ROW LEVEL SECURITY;

ALTER TABLE wise_spliter.groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE wise_spliter.groups FORCE ROW LEVEL SECURITY;

ALTER TABLE wise_spliter.group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE wise_spliter.group_members FORCE ROW LEVEL SECURITY;

ALTER TABLE wise_spliter.expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE wise_spliter.expenses FORCE ROW LEVEL SECURITY;

ALTER TABLE wise_spliter.expense_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE wise_spliter.expense_revisions FORCE ROW LEVEL SECURITY;

ALTER TABLE wise_spliter.settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE wise_spliter.settlements FORCE ROW LEVEL SECURITY;

ALTER TABLE wise_spliter.group_activity_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE wise_spliter.group_activity_log FORCE ROW LEVEL SECURITY;

ALTER TABLE wise_spliter.receipt_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE wise_spliter.receipt_attachments FORCE ROW LEVEL SECURITY;

-- 5.1 Profiles Policies (strictly own profile only)
DROP POLICY IF EXISTS profiles_select_own ON wise_spliter.profiles;
CREATE POLICY profiles_select_own ON wise_spliter.profiles
  FOR SELECT TO authenticated
  USING (
    (
      id = (SELECT wise_spliter.current_profile_id())
      OR id = (SELECT auth.uid())::text
    )
    AND lower(email) = (SELECT wise_spliter.current_auth_email())
  );

DROP POLICY IF EXISTS profiles_insert_own ON wise_spliter.profiles;
CREATE POLICY profiles_insert_own ON wise_spliter.profiles
  FOR INSERT TO authenticated
  WITH CHECK (
    (
      id = (SELECT wise_spliter.current_profile_id())
      OR id = (SELECT auth.uid())::text
    )
    AND lower(email) = (SELECT wise_spliter.current_auth_email())
  );

DROP POLICY IF EXISTS profiles_update_own ON wise_spliter.profiles;
CREATE POLICY profiles_update_own ON wise_spliter.profiles
  FOR UPDATE TO authenticated
  USING (
    (
      id = (SELECT wise_spliter.current_profile_id())
      OR id = (SELECT auth.uid())::text
    )
    AND lower(email) = (SELECT wise_spliter.current_auth_email())
  )
  WITH CHECK (
    (
      id = (SELECT wise_spliter.current_profile_id())
      OR id = (SELECT auth.uid())::text
    )
    AND lower(email) = (SELECT wise_spliter.current_auth_email())
  );

-- 5.2 Groups Policies (active non-removed group members & creator)
DROP POLICY IF EXISTS groups_select_member ON wise_spliter.groups;
CREATE POLICY groups_select_member ON wise_spliter.groups
  FOR SELECT TO authenticated
  USING ((SELECT wise_spliter.is_group_member(id)));

DROP POLICY IF EXISTS groups_insert_creator ON wise_spliter.groups;
CREATE POLICY groups_insert_creator ON wise_spliter.groups
  FOR INSERT TO authenticated
  WITH CHECK (
    created_by = (SELECT wise_spliter.current_profile_id())
    OR created_by = (SELECT auth.uid())::text
  );

DROP POLICY IF EXISTS groups_update_member ON wise_spliter.groups;
CREATE POLICY groups_update_member ON wise_spliter.groups
  FOR UPDATE TO authenticated
  USING ((SELECT wise_spliter.is_group_member(id)))
  WITH CHECK ((SELECT wise_spliter.is_group_member(id)));

DROP POLICY IF EXISTS groups_delete_creator ON wise_spliter.groups;
CREATE POLICY groups_delete_creator ON wise_spliter.groups
  FOR DELETE TO authenticated
  USING (
    created_by = (SELECT wise_spliter.current_profile_id())
    OR created_by = (SELECT auth.uid())::text
  );

-- 5.3 Group Members Policies
DROP POLICY IF EXISTS group_members_select_member ON wise_spliter.group_members;
CREATE POLICY group_members_select_member ON wise_spliter.group_members
  FOR SELECT TO authenticated
  USING ((SELECT wise_spliter.is_group_member(group_id)));

DROP POLICY IF EXISTS group_members_insert_member ON wise_spliter.group_members;
CREATE POLICY group_members_insert_member ON wise_spliter.group_members
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT wise_spliter.is_group_member(group_id)));

DROP POLICY IF EXISTS group_members_update_member ON wise_spliter.group_members;
CREATE POLICY group_members_update_member ON wise_spliter.group_members
  FOR UPDATE TO authenticated
  USING ((SELECT wise_spliter.is_group_member(group_id)))
  WITH CHECK ((SELECT wise_spliter.is_group_member(group_id)));

-- 5.4 Expenses Policies (group bills + standalone non-group splits)
DROP POLICY IF EXISTS expenses_select_authorized ON wise_spliter.expenses;
CREATE POLICY expenses_select_authorized ON wise_spliter.expenses
  FOR SELECT TO authenticated
  USING (
    CASE
      WHEN group_id IS NOT NULL THEN (SELECT wise_spliter.is_group_member(group_id))
      ELSE (SELECT wise_spliter.is_standalone_expense_participant(ad_hoc_participants, created_by_member_id))
    END
  );

DROP POLICY IF EXISTS expenses_insert_authorized ON wise_spliter.expenses;
CREATE POLICY expenses_insert_authorized ON wise_spliter.expenses
  FOR INSERT TO authenticated
  WITH CHECK (
    CASE
      WHEN group_id IS NOT NULL THEN (SELECT wise_spliter.is_group_member(group_id))
      ELSE (SELECT wise_spliter.is_standalone_expense_participant(ad_hoc_participants, created_by_member_id))
    END
  );

DROP POLICY IF EXISTS expenses_update_authorized ON wise_spliter.expenses;
CREATE POLICY expenses_update_authorized ON wise_spliter.expenses
  FOR UPDATE TO authenticated
  USING (
    CASE
      WHEN group_id IS NOT NULL THEN (SELECT wise_spliter.is_group_member(group_id))
      ELSE (SELECT wise_spliter.is_standalone_expense_participant(ad_hoc_participants, created_by_member_id))
    END
  )
  WITH CHECK (
    CASE
      WHEN group_id IS NOT NULL THEN (SELECT wise_spliter.is_group_member(group_id))
      ELSE (SELECT wise_spliter.is_standalone_expense_participant(ad_hoc_participants, created_by_member_id))
    END
  );

-- 5.5 Expense Revisions Policies (append-only immutable history)
DROP POLICY IF EXISTS expense_revisions_select_authorized ON wise_spliter.expense_revisions;
CREATE POLICY expense_revisions_select_authorized ON wise_spliter.expense_revisions
  FOR SELECT TO authenticated
  USING ((SELECT wise_spliter.can_access_expense(expense_id, group_id)));

DROP POLICY IF EXISTS expense_revisions_insert_authorized ON wise_spliter.expense_revisions;
CREATE POLICY expense_revisions_insert_authorized ON wise_spliter.expense_revisions
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT wise_spliter.can_access_expense(expense_id, group_id)));

-- 5.6 Settlements Policies
DROP POLICY IF EXISTS settlements_select_authorized ON wise_spliter.settlements;
CREATE POLICY settlements_select_authorized ON wise_spliter.settlements
  FOR SELECT TO authenticated
  USING (
    CASE
      WHEN group_id IS NOT NULL THEN (SELECT wise_spliter.is_group_member(group_id))
      ELSE (
        from_member_id IN ((SELECT wise_spliter.current_profile_id()), (SELECT auth.uid())::text)
        OR to_member_id IN ((SELECT wise_spliter.current_profile_id()), (SELECT auth.uid())::text)
      )
    END
  );

DROP POLICY IF EXISTS settlements_insert_authorized ON wise_spliter.settlements;
CREATE POLICY settlements_insert_authorized ON wise_spliter.settlements
  FOR INSERT TO authenticated
  WITH CHECK (
    CASE
      WHEN group_id IS NOT NULL THEN (SELECT wise_spliter.is_group_member(group_id))
      ELSE (
        from_member_id IN ((SELECT wise_spliter.current_profile_id()), (SELECT auth.uid())::text)
        OR to_member_id IN ((SELECT wise_spliter.current_profile_id()), (SELECT auth.uid())::text)
      )
    END
  );

DROP POLICY IF EXISTS settlements_update_authorized ON wise_spliter.settlements;
CREATE POLICY settlements_update_authorized ON wise_spliter.settlements
  FOR UPDATE TO authenticated
  USING (
    CASE
      WHEN group_id IS NOT NULL THEN (SELECT wise_spliter.is_group_member(group_id))
      ELSE (
        from_member_id IN ((SELECT wise_spliter.current_profile_id()), (SELECT auth.uid())::text)
        OR to_member_id IN ((SELECT wise_spliter.current_profile_id()), (SELECT auth.uid())::text)
      )
    END
  )
  WITH CHECK (
    CASE
      WHEN group_id IS NOT NULL THEN (SELECT wise_spliter.is_group_member(group_id))
      ELSE (
        from_member_id IN ((SELECT wise_spliter.current_profile_id()), (SELECT auth.uid())::text)
        OR to_member_id IN ((SELECT wise_spliter.current_profile_id()), (SELECT auth.uid())::text)
      )
    END
  );

-- 5.7 Group Activity Log Policies (append-only)
DROP POLICY IF EXISTS group_activity_log_select_authorized ON wise_spliter.group_activity_log;
CREATE POLICY group_activity_log_select_authorized ON wise_spliter.group_activity_log
  FOR SELECT TO authenticated
  USING (
    CASE
      WHEN group_id IS NOT NULL THEN (SELECT wise_spliter.is_group_member(group_id))
      ELSE actor_member_id IN ((SELECT wise_spliter.current_profile_id()), (SELECT auth.uid())::text)
    END
  );

DROP POLICY IF EXISTS group_activity_log_insert_authorized ON wise_spliter.group_activity_log;
CREATE POLICY group_activity_log_insert_authorized ON wise_spliter.group_activity_log
  FOR INSERT TO authenticated
  WITH CHECK (
    CASE
      WHEN group_id IS NOT NULL THEN (SELECT wise_spliter.is_group_member(group_id))
      ELSE actor_member_id IN ((SELECT wise_spliter.current_profile_id()), (SELECT auth.uid())::text)
    END
  );

-- 5.8 Receipt Attachments Policies
DROP POLICY IF EXISTS receipt_attachments_select_authorized ON wise_spliter.receipt_attachments;
CREATE POLICY receipt_attachments_select_authorized ON wise_spliter.receipt_attachments
  FOR SELECT TO authenticated
  USING ((SELECT wise_spliter.can_access_expense(expense_id, group_id)));

DROP POLICY IF EXISTS receipt_attachments_insert_authorized ON wise_spliter.receipt_attachments;
CREATE POLICY receipt_attachments_insert_authorized ON wise_spliter.receipt_attachments
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT wise_spliter.can_access_expense(expense_id, group_id)));

DROP POLICY IF EXISTS receipt_attachments_update_authorized ON wise_spliter.receipt_attachments;
CREATE POLICY receipt_attachments_update_authorized ON wise_spliter.receipt_attachments
  FOR UPDATE TO authenticated
  USING ((SELECT wise_spliter.can_access_expense(expense_id, group_id)))
  WITH CHECK ((SELECT wise_spliter.can_access_expense(expense_id, group_id)));

-- =============================================================================
-- 6. Private Supabase Storage Bucket (`wise-spliter-receipts`) Hardening & RLS
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'storage' AND table_name = 'buckets'
  ) THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES (
      'wise-spliter-receipts',
      'wise-spliter-receipts',
      false,
      10485760,
      ARRAY['image/webp', 'image/png', 'image/jpeg', 'application/pdf']
    )
    ON CONFLICT (id) DO UPDATE SET
      public = false,
      file_size_limit = 10485760,
      allowed_mime_types = ARRAY['image/webp', 'image/png', 'image/jpeg', 'application/pdf'];
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'storage' AND table_name = 'objects'
  ) THEN
    EXECUTE 'DROP POLICY IF EXISTS ws_receipts_select_member ON storage.objects';
    EXECUTE $pol$
      CREATE POLICY ws_receipts_select_member ON storage.objects
      FOR SELECT TO authenticated
      USING (
        bucket_id = 'wise-spliter-receipts'
        AND (
          CASE
            WHEN (storage.foldername(name))[1] IS NOT NULL
                 AND (storage.foldername(name))[1] <> 'standalone'
            THEN (SELECT wise_spliter.is_group_member((storage.foldername(name))[1]))
            ELSE (SELECT wise_spliter.can_access_expense((storage.foldername(name))[2], NULL))
          END
        )
      )
    $pol$;

    EXECUTE 'DROP POLICY IF EXISTS ws_receipts_insert_member ON storage.objects';
    EXECUTE $pol$
      CREATE POLICY ws_receipts_insert_member ON storage.objects
      FOR INSERT TO authenticated
      WITH CHECK (
        bucket_id = 'wise-spliter-receipts'
        AND (
          CASE
            WHEN (storage.foldername(name))[1] IS NOT NULL
                 AND (storage.foldername(name))[1] <> 'standalone'
            THEN (SELECT wise_spliter.is_group_member((storage.foldername(name))[1]))
            ELSE (SELECT wise_spliter.can_access_expense((storage.foldername(name))[2], NULL))
          END
        )
      )
    $pol$;

    EXECUTE 'DROP POLICY IF EXISTS ws_receipts_update_member ON storage.objects';
    EXECUTE $pol$
      CREATE POLICY ws_receipts_update_member ON storage.objects
      FOR UPDATE TO authenticated
      USING (
        bucket_id = 'wise-spliter-receipts'
        AND (
          CASE
            WHEN (storage.foldername(name))[1] IS NOT NULL
                 AND (storage.foldername(name))[1] <> 'standalone'
            THEN (SELECT wise_spliter.is_group_member((storage.foldername(name))[1]))
            ELSE (SELECT wise_spliter.can_access_expense((storage.foldername(name))[2], NULL))
          END
        )
      )
      WITH CHECK (
        bucket_id = 'wise-spliter-receipts'
        AND (
          CASE
            WHEN (storage.foldername(name))[1] IS NOT NULL
                 AND (storage.foldername(name))[1] <> 'standalone'
            THEN (SELECT wise_spliter.is_group_member((storage.foldername(name))[1]))
            ELSE (SELECT wise_spliter.can_access_expense((storage.foldername(name))[2], NULL))
          END
        )
      )
    $pol$;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
