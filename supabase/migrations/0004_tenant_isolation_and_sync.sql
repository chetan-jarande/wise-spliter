-- 0004: database-enforced tenant isolation, conditional cursor sync, size limits,
-- account deletion and schema slimming. Idempotent; applied once via the
-- wise_spliter.schema_migrations ledger (scripts/apply-migration.mjs).

SET client_min_messages = warning;

-- =============================================================================
-- 1. Privileges: only service_role (the API) and postgres touch this schema
-- =============================================================================

REVOKE ALL ON SCHEMA wise_spliter FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA wise_spliter TO service_role, postgres;
REVOKE ALL ON ALL TABLES IN SCHEMA wise_spliter FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA wise_spliter FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA wise_spliter FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA wise_spliter REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA wise_spliter REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA wise_spliter REVOKE ALL ON FUNCTIONS FROM PUBLIC, anon, authenticated;

-- =============================================================================
-- 2. Columns, types and normalization
-- =============================================================================

ALTER TABLE wise_spliter.profiles
  ADD COLUMN IF NOT EXISTS auth_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;
-- A profile re-created with the same id (e.g. Google re-sign-up after deletion) must not
-- revive tokens of the deleted one, so versions start at a random value.
ALTER TABLE wise_spliter.profiles ALTER COLUMN token_version SET DEFAULT (1000 + floor(random() * 1999999000))::int;
-- Profiles that existed before this migration started at 0: move them off the predictable value.
UPDATE wise_spliter.profiles SET token_version = (1000 + floor(random() * 1999999000))::int WHERE token_version < 1000;
ALTER TABLE wise_spliter.expenses ADD COLUMN IF NOT EXISTS owner_id TEXT;
ALTER TABLE wise_spliter.settlements ADD COLUMN IF NOT EXISTS owner_id TEXT;
ALTER TABLE wise_spliter.group_activity_log ADD COLUMN IF NOT EXISTS owner_id TEXT;
ALTER TABLE wise_spliter.receipt_attachments ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
-- Unused duplicates: the pointer always lives on-device and data_url is always NULL.
ALTER TABLE wise_spliter.receipt_attachments DROP CONSTRAINT IF EXISTS chk_receipt_local_only;
ALTER TABLE wise_spliter.receipt_attachments DROP COLUMN IF EXISTS data_url;
ALTER TABLE wise_spliter.receipt_attachments DROP COLUMN IF EXISTS storage_bucket;
ALTER TABLE wise_spliter.profiles DROP COLUMN IF EXISTS server_seq;

UPDATE wise_spliter.profiles SET email = lower(btrim(email)) WHERE email <> lower(btrim(email));
UPDATE wise_spliter.group_members SET invited_email = lower(btrim(invited_email))
  WHERE invited_email IS NOT NULL AND invited_email <> lower(btrim(invited_email));
UPDATE wise_spliter.group_members SET invited_email = NULL WHERE invited_email = '';

UPDATE wise_spliter.profiles p SET auth_user_id = u.id
FROM auth.users u
WHERE p.auth_user_id IS NULL AND lower(u.email) = p.email AND u.email_confirmed_at IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM wise_spliter.profiles q WHERE q.auth_user_id = u.id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_profiles_auth_user_id ON wise_spliter.profiles (auth_user_id);
-- google_connected gates password sign-in (a Google-linked profile never signs in by password), so it
-- is explicit, never defaulted, and backfilled from the auth account's verified providers.
ALTER TABLE wise_spliter.profiles ALTER COLUMN google_connected SET DEFAULT false;
UPDATE wise_spliter.profiles p SET google_connected = COALESCE(u.raw_app_meta_data -> 'providers' ? 'google', false)
FROM auth.users u WHERE u.id = p.auth_user_id
  AND p.google_connected IS DISTINCT FROM COALESCE(u.raw_app_meta_data -> 'providers' ? 'google', false);

UPDATE wise_spliter.expenses e SET owner_id = COALESCE(
  (SELECT p.id FROM wise_spliter.profiles p
    WHERE p.id = e.created_by_member_id
       OR p.email = (SELECT lower(x ->> 'invitedEmail') FROM jsonb_array_elements(e.ad_hoc_participants) x
                     WHERE x ->> 'id' = e.created_by_member_id LIMIT 1)
    LIMIT 1),
  (SELECT g.created_by FROM wise_spliter.groups g WHERE g.id = e.group_id),
  e.created_by_member_id)
WHERE e.owner_id IS NULL;
UPDATE wise_spliter.settlements s SET owner_id = COALESCE(
  (SELECT g.created_by FROM wise_spliter.groups g WHERE g.id = s.group_id), s.from_member_id)
WHERE s.owner_id IS NULL;
UPDATE wise_spliter.group_activity_log a SET owner_id = COALESCE(
  (SELECT g.created_by FROM wise_spliter.groups g WHERE g.id = a.group_id),
  (SELECT e.owner_id FROM wise_spliter.expenses e WHERE e.id = a.entity_id), a.actor_member_id)
WHERE a.owner_id IS NULL;

-- Typed dates (4 B instead of an 11 B text) and byte-ordered HLC comparison.
DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns WHERE table_schema = 'wise_spliter'
      AND table_name = 'expenses' AND column_name = 'expense_date') = 'text' THEN
    ALTER TABLE wise_spliter.expenses ALTER COLUMN expense_date TYPE DATE USING expense_date::date;
  END IF;
  IF (SELECT data_type FROM information_schema.columns WHERE table_schema = 'wise_spliter'
      AND table_name = 'settlements' AND column_name = 'settled_date') = 'text' THEN
    ALTER TABLE wise_spliter.settlements ALTER COLUMN settled_date TYPE DATE USING settled_date::date;
  END IF;
END $$;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['profiles','groups','group_members','expenses','expense_revisions',
                           'settlements','group_activity_log','receipt_attachments'] LOOP
    EXECUTE format('ALTER TABLE wise_spliter.%I ALTER COLUMN hlc TYPE TEXT COLLATE "C"', t);
  END LOOP;
END $$;

-- =============================================================================
-- 3. One change sequence for every synced table; UPDATE bumps server_seq
-- =============================================================================

CREATE SEQUENCE IF NOT EXISTS wise_spliter.change_seq;

DO $$
DECLARE t TEXT; mx BIGINT := 0; v BIGINT;
BEGIN
  FOREACH t IN ARRAY ARRAY['groups','group_members','expenses','expense_revisions',
                           'settlements','group_activity_log','receipt_attachments'] LOOP
    IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = format('wise_spliter.%I', t)::regclass
               AND attname = 'server_seq' AND attidentity <> '') THEN
      EXECUTE format('ALTER TABLE wise_spliter.%I ALTER COLUMN server_seq DROP IDENTITY', t);
    END IF;
    EXECUTE format('ALTER TABLE wise_spliter.%I ALTER COLUMN server_seq DROP DEFAULT', t);
    EXECUTE format('ALTER TABLE wise_spliter.%I ALTER COLUMN server_seq SET NOT NULL', t);
    EXECUTE format('SELECT COALESCE(max(server_seq), 0) FROM wise_spliter.%I', t) INTO v;
    mx := greatest(mx, v);
  END LOOP;
  SELECT CASE WHEN is_called THEN last_value ELSE 0 END INTO v FROM wise_spliter.change_seq;
  PERFORM setval('wise_spliter.change_seq', greatest(mx, v, 1));
END $$;

-- Commit order must equal server_seq order, or a cursor pull can step over a lower seq that
-- commits later and lose that change forever. Every writer takes this transaction lock before
-- drawing a seq (advisory key 7735001) and holds it until commit, so seqs become visible strictly in order.
-- ponytail: one global write lock (a few hundred write transactions/s); upgrade to per-group
-- sequences and cursors, or xid8 snapshot fencing, when write throughput needs it.
DROP FUNCTION IF EXISTS wise_spliter.lock_change_seq();

-- Assigned only after the lock (a column DEFAULT would draw the seq before it).
CREATE OR REPLACE FUNCTION wise_spliter.bump_server_seq()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(7735001);
  NEW.server_seq := nextval('wise_spliter.change_seq');
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION wise_spliter.forbid_column_change()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  -- delete_account tombstones ownership of rows it keeps (transaction-local flag, never set by clients).
  IF to_jsonb(NEW) -> TG_ARGV[0] IS DISTINCT FROM to_jsonb(OLD) -> TG_ARGV[0]
     AND NOT (current_setting('wise_spliter.tombstone_owner', true) = 'on'
              AND to_jsonb(NEW) ->> TG_ARGV[0] LIKE 'deleted_%') THEN
    RAISE EXCEPTION '%.% is immutable', TG_TABLE_NAME, TG_ARGV[0] USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['groups','group_members','expenses','expense_revisions',
                           'settlements','group_activity_log','receipt_attachments'] LOOP
    -- BEFORE triggers fire in name order: every check (trg_<name>) runs first, the seq/lock
    -- trigger (trg_zz_...) last, so the global lock is taken only after all checks passed.
    EXECUTE format('DROP TRIGGER IF EXISTS trg_bump_server_seq ON wise_spliter.%I', t);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_assign_server_seq ON wise_spliter.%I', t);
    EXECUTE format('CREATE OR REPLACE TRIGGER trg_zz_bump_server_seq BEFORE UPDATE ON wise_spliter.%I
      FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION wise_spliter.bump_server_seq()', t);
    EXECUTE format('CREATE OR REPLACE TRIGGER trg_zz_assign_server_seq BEFORE INSERT ON wise_spliter.%I
      FOR EACH ROW EXECUTE FUNCTION wise_spliter.bump_server_seq()', t);
  END LOOP;
END $$;
CREATE OR REPLACE TRIGGER trg_groups_created_by_immutable BEFORE UPDATE OF created_by ON wise_spliter.groups
  FOR EACH ROW EXECUTE FUNCTION wise_spliter.forbid_column_change('created_by');
CREATE OR REPLACE TRIGGER trg_expenses_owner_immutable BEFORE UPDATE OF owner_id ON wise_spliter.expenses
  FOR EACH ROW EXECUTE FUNCTION wise_spliter.forbid_column_change('owner_id');
CREATE OR REPLACE TRIGGER trg_settlements_owner_immutable BEFORE UPDATE OF owner_id ON wise_spliter.settlements
  FOR EACH ROW EXECUTE FUNCTION wise_spliter.forbid_column_change('owner_id');
CREATE OR REPLACE TRIGGER trg_receipt_expense_immutable BEFORE UPDATE OF expense_id ON wise_spliter.receipt_attachments
  FOR EACH ROW EXECUTE FUNCTION wise_spliter.forbid_column_change('expense_id');
CREATE OR REPLACE TRIGGER trg_receipt_sha256_immutable BEFORE UPDATE OF sha256_hex ON wise_spliter.receipt_attachments
  FOR EACH ROW EXECUTE FUNCTION wise_spliter.forbid_column_change('sha256_hex');

-- Every payer and split must be an active member of the expense's group, or a listed
-- participant of a direct (non-group) expense. On UPDATE only ids that were not already on the
-- bill are checked, so history that involves since-removed members can still be edited and restored.
CREATE OR REPLACE FUNCTION wise_spliter.enforce_expense_member_scope()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM (
      SELECT x ->> 'memberId' AS mid FROM jsonb_array_elements(NEW.payers) x
      UNION SELECT x ->> 'memberId' FROM jsonb_array_elements(NEW.splits) x
      EXCEPT
      SELECT x ->> 'memberId' FROM jsonb_array_elements(CASE WHEN TG_OP = 'UPDATE' AND NEW.group_id IS NOT NULL AND OLD.group_id = NEW.group_id
        THEN OLD.payers || OLD.splits ELSE '[]'::jsonb END) x
    ) ids
    WHERE ids.mid IS NULL OR CASE
      WHEN NEW.group_id IS NOT NULL THEN NOT EXISTS (
        SELECT 1 FROM wise_spliter.group_members gm
        WHERE gm.id = ids.mid AND gm.group_id = NEW.group_id AND gm.removed_at IS NULL)
      ELSE NOT (NEW.ad_hoc_participants @> jsonb_build_array(jsonb_build_object('id', ids.mid)))
    END
  ) THEN
    RAISE EXCEPTION 'payer or split is not an active member or participant of expense %', NEW.id USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER trg_expense_member_scope
  BEFORE INSERT OR UPDATE OF payers, splits, ad_hoc_participants, group_id ON wise_spliter.expenses
  FOR EACH ROW EXECUTE FUNCTION wise_spliter.enforce_expense_member_scope();

-- =============================================================================
-- 4. CHECK constraints: identifiers, emails, enums, text lengths, jsonb sizes
-- =============================================================================

DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN SELECT * FROM (VALUES
    ('profiles', 'chk_profiles_id', $c$id ~ '^[A-Za-z0-9_-]{1,80}$'$c$),
    ('profiles', 'chk_profiles_email', $c$email = lower(email) AND char_length(email) BETWEEN 3 AND 254$c$),
    ('profiles', 'chk_profiles_text', $c$char_length(full_name) BETWEEN 1 AND 100 AND char_length(avatar_initials) <= 4
       AND char_length(COALESCE(avatar_url, '')) <= 2048 AND char_length(COALESCE(upi_id, '')) <= 100
       AND default_currency ~ '^[A-Z]{3}$' AND char_length(hlc) <= 120$c$),
    ('groups', 'chk_groups_id', $c$id ~ '^[A-Za-z0-9_-]{1,80}$'$c$),
    ('groups', 'chk_groups_text', $c$char_length(name) BETWEEN 1 AND 100 AND char_length(description) <= 500
       AND char_length(invite_code) BETWEEN 1 AND 40 AND char_length(created_by) <= 80 AND char_length(hlc) <= 120
       AND base_currency ~ '^[A-Z]{3}$' AND category IN ('trip', 'home', 'couple', 'friends', 'other')
       AND expense_seq >= 0 AND pg_column_size(default_split_config) <= 8192$c$),
    ('group_members', 'chk_group_members_id', $c$id ~ '^[A-Za-z0-9_-]{1,80}$'$c$),
    ('group_members', 'chk_group_members_email', $c$invited_email = lower(invited_email) AND char_length(invited_email) BETWEEN 3 AND 254$c$),
    ('group_members', 'chk_group_members_text', $c$char_length(display_name) BETWEEN 1 AND 100 AND char_length(avatar_initials) <= 4
       AND char_length(COALESCE(upi_id, '')) <= 100 AND char_length(COALESCE(user_id, '')) <= 80
       AND member_order BETWEEN 0 AND 1000 AND char_length(hlc) <= 120$c$),
    ('expenses', 'chk_expenses_id', $c$id ~ '^[A-Za-z0-9_-]{1,80}$'$c$),
    ('expenses', 'chk_expenses_owner', $c$group_id IS NOT NULL OR owner_id IS NOT NULL$c$),
    ('expenses', 'chk_expenses_text', $c$char_length(title) BETWEEN 1 AND 200 AND char_length(notes) <= 2000
       AND char_length(category) <= 40 AND cardinality(tags) <= 20 AND char_length(COALESCE(fx_audit_note, '')) <= 500
       AND original_currency ~ '^[A-Z]{3}$' AND group_currency ~ '^[A-Z]{3}$' AND char_length(hlc) <= 120
       AND char_length(current_revision_id) <= 120 AND char_length(created_by_member_id) <= 80
       AND char_length(updated_by_member_id) <= 80 AND rotation_seed >= 0 AND revision_number BETWEEN 1 AND 100000$c$),
    ('expenses', 'chk_expenses_json', $c$jsonb_typeof(payers) = 'array' AND jsonb_typeof(splits) = 'array'
       AND jsonb_typeof(ad_hoc_participants) = 'array' AND jsonb_typeof(comments) = 'array' AND jsonb_typeof(receipts) = 'array'
       AND jsonb_array_length(payers) BETWEEN 1 AND 100 AND jsonb_array_length(splits) BETWEEN 1 AND 100
       AND jsonb_array_length(ad_hoc_participants) <= 100 AND jsonb_array_length(comments) <= 200
       AND jsonb_array_length(receipts) <= 20 AND pg_column_size(payers) <= 16384 AND pg_column_size(splits) <= 32768
       AND pg_column_size(ad_hoc_participants) <= 32768 AND pg_column_size(comments) <= 65536
       AND pg_column_size(receipts) <= 16384$c$),
    -- Money round-trips through JSON numbers on the client: keep it exact (<= 2^53-1).
    ('expenses', 'chk_expenses_money', $c$amount_minor <= 9007199254740991 AND original_amount_minor <= 9007199254740991
       AND fx_rate_scaled <= 9007199254740991$c$),
    ('settlements', 'chk_settlements_money', $c$amount_minor <= 9007199254740991$c$),
    ('expense_revisions', 'chk_expense_revisions_id', $c$id ~ '^[A-Za-z0-9_-]{1,120}$'$c$),
    ('expense_revisions', 'chk_expense_revisions_text', $c$char_length(actor_display_name) <= 100 AND char_length(actor_member_id) <= 80
       AND action IN ('created', 'updated', 'deleted', 'restored', 'currency_reconverted', 'conflict_superseded', 'conflict_resolved')
       AND revision_number BETWEEN 1 AND 100000 AND char_length(hlc) <= 120
       AND jsonb_typeof(changes_json) = 'array' AND pg_column_size(changes_json) <= 16384
       AND jsonb_typeof(snapshot) = 'object' AND pg_column_size(snapshot) <= 65536$c$),
    ('settlements', 'chk_settlements_id', $c$id ~ '^[A-Za-z0-9_-]{1,80}$'$c$),
    ('settlements', 'chk_settlements_owner', $c$owner_id IS NOT NULL$c$),
    ('settlements', 'chk_settlements_text', $c$from_member_id <> to_member_id AND currency ~ '^[A-Z]{3}$'
       AND payment_method IN ('upi', 'cash', 'bank', 'paypal', 'venmo', 'other')
       AND char_length(COALESCE(payment_reference, '')) <= 200 AND char_length(notes) <= 500
       AND char_length(from_member_id) <= 80 AND char_length(to_member_id) <= 80
       AND char_length(COALESCE(batch_settlement_id, '')) <= 80 AND char_length(hlc) <= 120$c$),
    ('group_activity_log', 'chk_group_activity_id', $c$id ~ '^[A-Za-z0-9_-]{1,120}$'$c$),
    ('group_activity_log', 'chk_group_activity_owner', $c$owner_id IS NOT NULL$c$),
    ('group_activity_log', 'chk_group_activity_text', $c$entity_type IN ('group', 'member', 'expense', 'settlement', 'comment', 'currency')
       AND char_length(action) <= 60 AND char_length(summary_text) <= 500 AND char_length(detail_note) <= 2000
       AND cardinality(diff_badges) <= 10 AND char_length(actor_display_name) <= 100
       AND char_length(actor_member_id) <= 80 AND char_length(entity_id) <= 120 AND char_length(hlc) <= 120$c$),
    ('receipt_attachments', 'chk_receipt_id', $c$id ~ '^[A-Za-z0-9_-]{1,80}$'$c$),
    ('receipt_attachments', 'chk_receipt_text', $c$char_length(storage_path) <= 400 AND char_length(file_name) <= 120
       AND mime_type IN ('image/webp', 'image/png', 'image/jpeg', 'application/pdf')
       AND size_kb BETWEEN 0 AND 102400 AND char_length(uploaded_by_name) <= 100 AND char_length(preview_note) <= 500
       AND (sha256_hex IS NULL OR sha256_hex ~ '^[0-9a-f]{64}$') AND char_length(hlc) <= 120$c$)
  ) AS v(tbl, name, expr) LOOP
    EXECUTE format('ALTER TABLE wise_spliter.%I DROP CONSTRAINT IF EXISTS %I', c.tbl, c.name);
    EXECUTE format('ALTER TABLE wise_spliter.%I ADD CONSTRAINT %I CHECK (%s)', c.tbl, c.name, c.expr);
  END LOOP;
END $$;

-- =============================================================================
-- 5. Indexes: one per access predicate, no duplicates
-- =============================================================================

DROP INDEX IF EXISTS wise_spliter.idx_expenses_group_id;           -- prefix of idx_expenses_group_seq
DROP INDEX IF EXISTS wise_spliter.idx_group_members_group_id;      -- prefix of idx_group_members_group_seq
DROP INDEX IF EXISTS wise_spliter.idx_profiles_lower_email;        -- emails are stored lowercase; UNIQUE(email) serves lookups
DROP INDEX IF EXISTS wise_spliter.idx_group_members_active_email;  -- access is by claimed user_id, never by email
DROP INDEX IF EXISTS wise_spliter.idx_group_members_active_user;   -- replaced by the unique (user_id, group_id) index
DROP INDEX IF EXISTS wise_spliter.idx_groups_server_seq;           -- groups are pulled by id
DROP INDEX IF EXISTS wise_spliter.idx_groups_recent_activity;      -- recency is computed on-device; blocked HOT updates
DROP INDEX IF EXISTS wise_spliter.idx_expenses_standalone;         -- replaced by owner/participant indexes
DROP INDEX IF EXISTS wise_spliter.idx_receipt_attachments_expense_id; -- replaced by (expense_id, id)

CREATE UNIQUE INDEX IF NOT EXISTS ux_group_members_active_user
  ON wise_spliter.group_members (user_id, group_id) WHERE removed_at IS NULL AND user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_group_members_unclaimed_email
  ON wise_spliter.group_members (invited_email) WHERE user_id IS NULL AND removed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_group_members_user
  ON wise_spliter.group_members (user_id) WHERE user_id IS NOT NULL;
-- (owner_id, group_id) serves both the per-owner quota counts (with `group_id = X` or
-- `group_id IS NULL`) and the direct-split read path.
DROP INDEX IF EXISTS wise_spliter.idx_expenses_direct_owner_seq;
DROP INDEX IF EXISTS wise_spliter.idx_settlements_direct_owner;
DROP INDEX IF EXISTS wise_spliter.idx_group_activity_direct_owner;
CREATE INDEX IF NOT EXISTS idx_expenses_owner_scope ON wise_spliter.expenses (owner_id, group_id);
CREATE INDEX IF NOT EXISTS idx_settlements_owner_scope ON wise_spliter.settlements (owner_id, group_id);
CREATE INDEX IF NOT EXISTS idx_group_activity_owner_scope ON wise_spliter.group_activity_log (owner_id, group_id);
CREATE INDEX IF NOT EXISTS idx_group_activity_direct_entity
  ON wise_spliter.group_activity_log (entity_id) WHERE group_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_receipt_attachments_expense
  ON wise_spliter.receipt_attachments (expense_id);
CREATE INDEX IF NOT EXISTS idx_groups_created_by
  ON wise_spliter.groups (created_by);

-- Profiles are rewritten on every login; leave room for HOT updates (no indexed column changes).
ALTER TABLE wise_spliter.profiles SET (fillfactor = 90);

-- =============================================================================
-- 6. Per-tenant row caps (fire for every writer, including the service role)
-- =============================================================================

-- Quotas are per actor (owner_id / actor member) inside a scope, so one member cannot exhaust a
-- shared limit and freeze everybody else. They count every row the actor ever created there,
-- soft-deleted ones included, so delete-and-recreate cannot grow storage without bound. Counts
-- live in a counter row per (kind, owner, scope): O(1) per insert, locking only that actor's
-- counter, and the trigger fires before the seq/lock trigger.
CREATE TABLE IF NOT EXISTS wise_spliter.quota_usage (
  kind TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (kind, owner_id, scope_id)
);
CREATE INDEX IF NOT EXISTS idx_quota_usage_scope ON wise_spliter.quota_usage (scope_id);
ALTER TABLE wise_spliter.quota_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE wise_spliter.quota_usage FORCE ROW LEVEL SECURITY;
INSERT INTO wise_spliter.quota_usage (kind, owner_id, scope_id, n)
  SELECT 'groups', created_by, '', count(*) FROM wise_spliter.groups GROUP BY created_by
  UNION ALL SELECT 'group_members', '', group_id, count(*) FROM wise_spliter.group_members GROUP BY group_id
  UNION ALL SELECT 'expenses', COALESCE(owner_id, ''), COALESCE(group_id, ''), count(*) FROM wise_spliter.expenses GROUP BY owner_id, group_id
  UNION ALL SELECT 'expense_revisions', actor_member_id, expense_id, count(*) FROM wise_spliter.expense_revisions
    WHERE NOT (action = 'created' AND NOT is_conflict_branch) GROUP BY actor_member_id, expense_id
  UNION ALL SELECT 'settlements', COALESCE(owner_id, ''), COALESCE(group_id, ''), count(*) FROM wise_spliter.settlements GROUP BY owner_id, group_id
  UNION ALL SELECT 'group_activity_log', COALESCE(owner_id, ''), COALESCE(group_id, ''), count(*) FROM wise_spliter.group_activity_log GROUP BY owner_id, group_id
  UNION ALL SELECT 'receipt_attachments', '', expense_id, count(*) FROM wise_spliter.receipt_attachments GROUP BY expense_id
ON CONFLICT (kind, owner_id, scope_id) DO UPDATE SET n = greatest(wise_spliter.quota_usage.n, EXCLUDED.n);

CREATE OR REPLACE FUNCTION wise_spliter.enforce_row_caps()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_owner TEXT; v_scope TEXT; cap INT; n INT;
BEGIN
  CASE TG_TABLE_NAME
    WHEN 'groups' THEN cap := 500; v_owner := NEW.created_by; v_scope := '';
    WHEN 'group_members' THEN cap := 500; v_owner := current_setting('wise_spliter.actor', true); v_scope := NEW.group_id;
      IF (SELECT count(*) FROM (SELECT 1 FROM wise_spliter.group_members
          WHERE group_id = NEW.group_id AND removed_at IS NULL LIMIT 100) a) >= 100 THEN
        RAISE EXCEPTION 'row cap reached on group_members (100 active)' USING ERRCODE = '23514';
      END IF;
    WHEN 'expenses' THEN cap := 50000; v_owner := NEW.owner_id; v_scope := COALESCE(NEW.group_id, '');
    WHEN 'expense_revisions' THEN
      -- The single server-kept v1 snapshot (see apply_mutation) is not a client write.
      IF NEW.action = 'created' AND NOT NEW.is_conflict_branch THEN RETURN NEW; END IF;
      cap := 200; v_owner := NEW.actor_member_id; v_scope := NEW.expense_id;
    WHEN 'settlements' THEN cap := 50000; v_owner := NEW.owner_id; v_scope := COALESCE(NEW.group_id, '');
    WHEN 'group_activity_log' THEN cap := 200000; v_owner := NEW.owner_id; v_scope := COALESCE(NEW.group_id, '');
    WHEN 'receipt_attachments' THEN cap := 50; v_owner := current_setting('wise_spliter.actor', true); v_scope := NEW.expense_id;
    ELSE RETURN NEW;
  END CASE;
  INSERT INTO wise_spliter.quota_usage (kind, owner_id, scope_id, n) VALUES (TG_TABLE_NAME, COALESCE(v_owner, ''), COALESCE(v_scope, ''), 1)
  ON CONFLICT (kind, owner_id, scope_id) DO UPDATE SET n = wise_spliter.quota_usage.n + 1
  RETURNING quota_usage.n INTO n;
  IF n > cap THEN
    RAISE EXCEPTION 'row cap reached on % (%)', TG_TABLE_NAME, cap USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- Hard-deleted groups and bills take their per-scope counters with them.
CREATE OR REPLACE FUNCTION wise_spliter.drop_scope_quotas()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  DELETE FROM wise_spliter.quota_usage WHERE scope_id = OLD.id;
  RETURN NULL;
END $$;
CREATE OR REPLACE TRIGGER trg_drop_scope_quotas AFTER DELETE ON wise_spliter.groups
  FOR EACH ROW EXECUTE FUNCTION wise_spliter.drop_scope_quotas();
CREATE OR REPLACE TRIGGER trg_drop_scope_quotas AFTER DELETE ON wise_spliter.expenses
  FOR EACH ROW EXECUTE FUNCTION wise_spliter.drop_scope_quotas();

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['groups','group_members','expenses','expense_revisions',
                           'settlements','group_activity_log','receipt_attachments'] LOOP
    EXECUTE format('CREATE OR REPLACE TRIGGER trg_row_caps BEFORE INSERT ON wise_spliter.%I
      FOR EACH ROW EXECUTE FUNCTION wise_spliter.enforce_row_caps()', t);
  END LOOP;
END $$;

-- =============================================================================
-- 7. RLS is deny-all: FORCE RLS with no policies. The old membership helpers duplicated the RPC
--    rules with weaker logic, so they and their policies are dropped; the RPCs are the only path.
-- =============================================================================

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT policyname, tablename FROM pg_policies WHERE schemaname = 'wise_spliter' LOOP
    EXECUTE format('DROP POLICY %I ON wise_spliter.%I', r.policyname, r.tablename);
  END LOOP;
END $$;
DROP FUNCTION IF EXISTS wise_spliter.can_access_expense(TEXT, TEXT);
DROP FUNCTION IF EXISTS wise_spliter.is_standalone_expense_participant(JSONB, TEXT);
DROP FUNCTION IF EXISTS wise_spliter.is_group_member(TEXT);
DROP FUNCTION IF EXISTS wise_spliter.current_profile_id();
DROP FUNCTION IF EXISTS wise_spliter.current_auth_email();

-- Direct-split participants, bound to profiles by the server (never by client-written ids).
-- Participant ids are scoped to their expense: the same id in another expense is a different person.
CREATE TABLE IF NOT EXISTS wise_spliter.expense_participants (
  expense_id TEXT NOT NULL REFERENCES wise_spliter.expenses(id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL,
  invited_email TEXT CHECK (invited_email = lower(invited_email)),
  profile_id TEXT,
  PRIMARY KEY (expense_id, participant_id)
);
-- server_seq: a binding created or changed after a caller's cursor announces that bill in
-- backfillExpenseIds, so its older children (settlements, receipts, activity) are paged in.
ALTER TABLE wise_spliter.expense_participants ADD COLUMN IF NOT EXISTS server_seq BIGINT;
UPDATE wise_spliter.expense_participants ep SET server_seq = e.server_seq
FROM wise_spliter.expenses e WHERE e.id = ep.expense_id AND ep.server_seq IS NULL;
ALTER TABLE wise_spliter.expense_participants ALTER COLUMN server_seq SET NOT NULL;
DROP INDEX IF EXISTS wise_spliter.idx_expense_participants_profile;
CREATE INDEX IF NOT EXISTS idx_expense_participants_profile_seq ON wise_spliter.expense_participants (profile_id, server_seq) WHERE profile_id IS NOT NULL;
CREATE OR REPLACE TRIGGER trg_zz_bump_server_seq BEFORE UPDATE ON wise_spliter.expense_participants
  FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION wise_spliter.bump_server_seq();
CREATE OR REPLACE TRIGGER trg_zz_assign_server_seq BEFORE INSERT ON wise_spliter.expense_participants
  FOR EACH ROW EXECUTE FUNCTION wise_spliter.bump_server_seq();

-- An email can be named on at most 2000 bills nobody has claimed yet; this bounds both the
-- planted-bill spam and the work claim_members does on that person's first sign-in.
CREATE OR REPLACE FUNCTION wise_spliter.enforce_unbound_email_cap()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.profile_id IS NULL AND NEW.invited_email IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.invited_email IS DISTINCT FROM NEW.invited_email)
     AND (SELECT count(*) FROM (SELECT 1 FROM wise_spliter.expense_participants
          WHERE invited_email = NEW.invited_email AND profile_id IS NULL LIMIT 2000) s) >= 2000 THEN
    RAISE EXCEPTION 'too many unclaimed bills name %', NEW.invited_email USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER trg_unbound_email_cap BEFORE INSERT OR UPDATE OF invited_email, profile_id
  ON wise_spliter.expense_participants FOR EACH ROW EXECUTE FUNCTION wise_spliter.enforce_unbound_email_cap();
CREATE INDEX IF NOT EXISTS idx_expense_participants_unbound ON wise_spliter.expense_participants (invited_email)
  WHERE profile_id IS NULL AND invited_email IS NOT NULL;
ALTER TABLE wise_spliter.expense_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE wise_spliter.expense_participants FORCE ROW LEVEL SECURITY;

-- Rebuilds the participant rows of a direct expense. An email binds only to the profile holding
-- that email, and profiles exist only for verified sign-ins (server state, never client input).
CREATE OR REPLACE FUNCTION wise_spliter.sync_expense_participants()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.group_id IS NOT NULL THEN
    DELETE FROM wise_spliter.expense_participants WHERE expense_id = NEW.id;
    RETURN NULL;
  END IF;
  -- A participant leaving the bill takes the settlements naming them along as soft-deleted
  -- tombstones (new server_seq, newer hlc), so devices that already hold them drop them too.
  -- Re-adding the participant does not revive them; the recorder restores one with an upsert.
  UPDATE wise_spliter.settlements s SET deleted_at = now(),
    hlc = CASE WHEN NEW.hlc > s.hlc THEN NEW.hlc ELSE s.hlc END
  WHERE s.expense_id = NEW.id AND s.deleted_at IS NULL
    AND EXISTS (SELECT 1 FROM wise_spliter.expense_participants ep
      WHERE ep.expense_id = NEW.id AND ep.participant_id IN (s.from_member_id, s.to_member_id)
        AND NOT (NEW.ad_hoc_participants @> jsonb_build_array(jsonb_build_object('id', ep.participant_id))));
  DELETE FROM wise_spliter.expense_participants ep WHERE ep.expense_id = NEW.id
    AND NOT (NEW.ad_hoc_participants @> jsonb_build_array(jsonb_build_object('id', ep.participant_id)));
  INSERT INTO wise_spliter.expense_participants (expense_id, participant_id, invited_email, profile_id)
  SELECT NEW.id, x ->> 'id', NULLIF(lower(x ->> 'invitedEmail'), ''),
    (SELECT p.id FROM wise_spliter.profiles p
      WHERE p.email = NULLIF(lower(x ->> 'invitedEmail'), ''))
  FROM jsonb_array_elements(NEW.ad_hoc_participants) x
  WHERE x ->> 'id' IS NOT NULL
  ON CONFLICT (expense_id, participant_id) DO UPDATE
    SET invited_email = EXCLUDED.invited_email, profile_id = EXCLUDED.profile_id
    WHERE (wise_spliter.expense_participants.invited_email, wise_spliter.expense_participants.profile_id)
      IS DISTINCT FROM (EXCLUDED.invited_email, EXCLUDED.profile_id);
  RETURN NULL;
END $$;
CREATE OR REPLACE TRIGGER trg_sync_expense_participants
  AFTER INSERT OR UPDATE OF ad_hoc_participants, group_id ON wise_spliter.expenses
  FOR EACH ROW EXECUTE FUNCTION wise_spliter.sync_expense_participants();
UPDATE wise_spliter.expenses SET ad_hoc_participants = ad_hoc_participants WHERE group_id IS NULL;

-- Direct settlements are anchored to the direct expense they settle; both parties must be
-- participants of that expense. Legacy unanchored rows stay visible to their recorder only.
ALTER TABLE wise_spliter.settlements ADD COLUMN IF NOT EXISTS expense_id TEXT
  REFERENCES wise_spliter.expenses(id) ON DELETE CASCADE;
UPDATE wise_spliter.settlements s SET expense_id = a.eid
FROM (
  SELECT s2.id AS sid, (SELECT e.id FROM wise_spliter.expenses e
    WHERE e.group_id IS NULL AND e.owner_id = s2.owner_id
      AND e.ad_hoc_participants @> jsonb_build_array(jsonb_build_object('id', s2.from_member_id))
      AND e.ad_hoc_participants @> jsonb_build_array(jsonb_build_object('id', s2.to_member_id))
    ORDER BY e.created_at DESC LIMIT 1) AS eid
  FROM wise_spliter.settlements s2 WHERE s2.group_id IS NULL AND s2.expense_id IS NULL) a
WHERE s.id = a.sid AND a.eid IS NOT NULL;
ALTER TABLE wise_spliter.settlements DROP CONSTRAINT IF EXISTS chk_settlements_anchor;
ALTER TABLE wise_spliter.settlements ADD CONSTRAINT chk_settlements_anchor
  CHECK ((group_id IS NULL) = (expense_id IS NOT NULL)) NOT VALID;
CREATE INDEX IF NOT EXISTS idx_settlements_direct_expense ON wise_spliter.settlements (expense_id, server_seq) WHERE expense_id IS NOT NULL;
DROP INDEX IF EXISTS wise_spliter.idx_settlements_direct_from;
DROP INDEX IF EXISTS wise_spliter.idx_settlements_direct_to;
DROP INDEX IF EXISTS wise_spliter.idx_expenses_direct_participants;

-- =============================================================================
-- 8. Sync RPCs (service_role only). The API passes the verified actor profile id.
-- =============================================================================

DROP FUNCTION IF EXISTS wise_spliter.push_mutations(JSONB);
DROP FUNCTION IF EXISTS wise_spliter.pull_changes(BIGINT);
DROP FUNCTION IF EXISTS wise_spliter.money_json(BIGINT);

CREATE OR REPLACE FUNCTION wise_spliter.actor_member(p_group_id TEXT, p_actor TEXT)
RETURNS wise_spliter.group_members LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT * FROM wise_spliter.group_members
  WHERE user_id = p_actor AND group_id = p_group_id AND removed_at IS NULL;
$$;

DROP FUNCTION IF EXISTS wise_spliter.can_access_direct_expense(JSONB, TEXT, TEXT, TEXT);
CREATE OR REPLACE FUNCTION wise_spliter.can_access_direct_expense(p_expense_id TEXT, p_owner TEXT, p_actor TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT p_owner = p_actor OR EXISTS (
    SELECT 1 FROM wise_spliter.expense_participants
    WHERE expense_id = p_expense_id AND profile_id = p_actor);
$$;

CREATE OR REPLACE FUNCTION wise_spliter.expense_snapshot(e wise_spliter.expenses)
RETURNS JSONB LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT jsonb_build_object('title', e.title, 'category', e.category, 'amountMinor', e.amount_minor,
    'originalCurrency', e.original_currency, 'originalAmountMinor', e.original_amount_minor,
    'fxRateScaled', e.fx_rate_scaled, 'fxStatus', e.fx_status, 'splitMode', e.split_mode,
    'payers', e.payers, 'splits', e.splits, 'notes', e.notes);
$$;

CREATE OR REPLACE FUNCTION wise_spliter.apply_mutation(p_actor TEXT, p_email TEXT, p_name TEXT, m JSONB)
RETURNS JSONB LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_entity TEXT := m ->> 'entity';
  v_id TEXT := m ->> 'id';
  v_del BOOLEAN := (m ->> 'op') = 'delete';
  v_restore BOOLEAN := (m ->> 'op') = 'restore';
  v_hlc TEXT COLLATE "C" := m ->> 'hlc';
  d JSONB := CASE WHEN jsonb_typeof(m -> 'data') = 'object' THEN m -> 'data' ELSE '{}'::jsonb END;
  v_seq BIGINT;
  v_role TEXT;
  am wise_spliter.group_members;
  g wise_spliter.groups;  gr wise_spliter.groups;
  mo wise_spliter.group_members; mr wise_spliter.group_members;
  eo wise_spliter.expenses; er wise_spliter.expenses;
  so wise_spliter.settlements; sr wise_spliter.settlements;
  rr wise_spliter.expense_revisions;
  ar wise_spliter.group_activity_log;
  po wise_spliter.receipt_attachments; pr wise_spliter.receipt_attachments;
BEGIN
  IF v_id IS NULL OR v_id !~ '^[A-Za-z0-9_-]{1,120}$' OR v_hlc IS NULL
     OR v_hlc !~ '^[0-9a-f]{12}-[0-9a-f]{4}-[A-Za-z0-9_-]{1,80}$'
     OR ('x' || substr(v_hlc, 1, 12))::bit(48)::bigint > (extract(epoch FROM now()) * 1000)::bigint + 60000 THEN
    RAISE EXCEPTION 'invalid id or hlc' USING ERRCODE = '22023';
  END IF;
  IF v_restore AND v_entity <> 'group' THEN RAISE EXCEPTION 'restore is a group operation' USING ERRCODE = '22023'; END IF;

  CASE v_entity
  -- ---------------------------------------------------------------- group
  WHEN 'group' THEN
    SELECT * INTO g FROM wise_spliter.groups WHERE id = v_id FOR UPDATE;
    IF NOT FOUND THEN
      IF v_del THEN RAISE EXCEPTION 'nothing to delete' USING ERRCODE = '22023'; END IF;
      gr := jsonb_populate_record(NULL::wise_spliter.groups, d);
      -- Invite codes are server-generated (the client's value is ignored), retried on collision.
      FOR i IN 1..3 LOOP
        INSERT INTO wise_spliter.groups (id, name, description, category, base_currency, simplify_debts,
          default_split_config, expense_seq, invite_code, created_by, created_at, updated_at, last_accessed_at, deleted_at, hlc)
        VALUES (v_id, gr.name, COALESCE(gr.description, ''), COALESCE(gr.category, 'trip'), gr.base_currency,
          COALESCE(gr.simplify_debts, true), gr.default_split_config, COALESCE(gr.expense_seq, 0),
          'WS-' || upper(encode(extensions.gen_random_bytes(5), 'hex')),
          p_actor, COALESCE(gr.created_at, now()), now(), COALESCE(gr.last_accessed_at, now()), NULL, v_hlc)
        ON CONFLICT DO NOTHING RETURNING server_seq INTO v_seq;
        EXIT WHEN v_seq IS NOT NULL OR EXISTS (SELECT 1 FROM wise_spliter.groups WHERE id = v_id);
      END LOOP;
      IF v_seq IS NULL THEN RAISE EXCEPTION 'group id taken' USING ERRCODE = '42501'; END IF;
      RETURN jsonb_build_object('status', 'applied', 'serverSeq', v_seq::text);
    END IF;
    am := wise_spliter.actor_member(v_id, p_actor);
    IF am.id IS NULL THEN RAISE EXCEPTION 'not a member' USING ERRCODE = '42501'; END IF;
    gr := jsonb_populate_record(NULL::wise_spliter.groups, d);
    -- Deleting and restoring are explicit admin operations. A plain upsert never changes the deleted
    -- state, and a deleted group ignores upserts, so a device with stale state cannot resurrect it.
    -- Changing the base currency re-denominates the whole ledger, so it is admin-only too.
    IF am.role <> 'admin' AND (v_del OR v_restore
        OR (d ? 'base_currency' AND gr.base_currency IS DISTINCT FROM g.base_currency)) THEN
      RAISE EXCEPTION 'admin only' USING ERRCODE = '42501';
    END IF;
    IF v_hlc <= g.hlc OR (NOT v_del AND NOT v_restore AND g.deleted_at IS NOT NULL) THEN
      RETURN jsonb_build_object('status', 'stale', 'serverHlc', g.hlc);
    END IF;
    IF v_del THEN
      UPDATE wise_spliter.groups SET deleted_at = COALESCE(deleted_at, now()), updated_at = now(), hlc = v_hlc
      WHERE id = v_id RETURNING server_seq INTO v_seq;
    ELSE
      -- PATCH: only the fields present in data change (absent keys keep their stored value), so an
      -- edit of one setting from a stale copy cannot revert the others. last_accessed_at is a
      -- per-device recency hint and never forces a shared write.
      gr.name := CASE WHEN d ? 'name' THEN gr.name ELSE g.name END;
      gr.description := CASE WHEN d ? 'description' THEN COALESCE(gr.description, '') ELSE g.description END;
      gr.category := CASE WHEN d ? 'category' THEN COALESCE(gr.category, g.category) ELSE g.category END;
      gr.base_currency := CASE WHEN d ? 'base_currency' THEN gr.base_currency ELSE g.base_currency END;
      gr.simplify_debts := CASE WHEN d ? 'simplify_debts' THEN COALESCE(gr.simplify_debts, g.simplify_debts) ELSE g.simplify_debts END;
      gr.default_split_config := CASE WHEN d ? 'default_split_config' THEN gr.default_split_config ELSE g.default_split_config END;
      gr.expense_seq := greatest(g.expense_seq, CASE WHEN d ? 'expense_seq' THEN COALESCE(gr.expense_seq, 0) ELSE 0 END);
      UPDATE wise_spliter.groups SET name = gr.name, description = gr.description, category = gr.category,
        base_currency = gr.base_currency, simplify_debts = gr.simplify_debts,
        default_split_config = gr.default_split_config, expense_seq = gr.expense_seq,
        deleted_at = CASE WHEN v_restore THEN NULL ELSE deleted_at END,
        updated_at = now(), hlc = v_hlc
      WHERE id = v_id AND (v_restore OR (name, description, category, base_currency, simplify_debts,
          default_split_config, expense_seq)
        IS DISTINCT FROM (gr.name, gr.description, gr.category, gr.base_currency, gr.simplify_debts,
          gr.default_split_config, gr.expense_seq))
      RETURNING server_seq INTO v_seq;
      IF v_seq IS NULL THEN RETURN jsonb_build_object('status', 'applied', 'reason', 'no_shared_change'); END IF;
    END IF;

  -- --------------------------------------------------------------- member
  WHEN 'group_member' THEN
    mr := jsonb_populate_record(NULL::wise_spliter.group_members, d);
    SELECT * INTO mo FROM wise_spliter.group_members WHERE id = v_id FOR UPDATE;
    IF NOT FOUND THEN
      IF v_del OR mr.group_id IS NULL THEN RAISE EXCEPTION 'unknown member' USING ERRCODE = '22023'; END IF;
      SELECT * INTO g FROM wise_spliter.groups WHERE id = mr.group_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'unknown group' USING ERRCODE = '22023'; END IF;
      am := wise_spliter.actor_member(mr.group_id, p_actor);
      IF am.id IS NULL THEN
        -- Bootstrap: the creator may add their own admin row to a group that has no members yet.
        IF g.created_by = p_actor AND mr.user_id = p_actor
           AND NOT EXISTS (SELECT 1 FROM wise_spliter.group_members WHERE group_id = g.id) THEN
          INSERT INTO wise_spliter.group_members (id, group_id, user_id, invited_email, display_name, avatar_initials,
            upi_id, role, member_order, joined_at, claimed_at, hlc)
          VALUES (v_id, g.id, p_actor, p_email, mr.display_name, COALESCE(mr.avatar_initials, 'GM'), mr.upi_id,
            'admin', COALESCE(mr.member_order, 0), now(), now(), v_hlc)
          ON CONFLICT DO NOTHING RETURNING server_seq INTO v_seq;
        ELSE
          RAISE EXCEPTION 'not a member' USING ERRCODE = '42501';
        END IF;
      ELSE
        INSERT INTO wise_spliter.group_members (id, group_id, user_id, invited_email, display_name, avatar_initials,
          upi_id, role, member_order, joined_at, claimed_at, hlc)
        VALUES (v_id, g.id, NULL, mr.invited_email, mr.display_name, COALESCE(mr.avatar_initials, 'GM'), mr.upi_id,
          CASE WHEN am.role = 'admin' THEN COALESCE(mr.role, 'member') ELSE 'member' END,
          COALESCE(mr.member_order, 0), now(), NULL, v_hlc)
        ON CONFLICT DO NOTHING RETURNING server_seq INTO v_seq;
      END IF;
      IF v_seq IS NULL THEN RAISE EXCEPTION 'member id taken' USING ERRCODE = '42501'; END IF;
      RETURN jsonb_build_object('status', 'applied', 'serverSeq', v_seq::text);
    END IF;
    IF NOT v_del AND mr.group_id IS DISTINCT FROM mo.group_id THEN
      RAISE EXCEPTION 'member belongs to another group' USING ERRCODE = '42501';
    END IF;
    am := wise_spliter.actor_member(mo.group_id, p_actor);
    IF am.id IS NULL THEN RAISE EXCEPTION 'not a member' USING ERRCODE = '42501'; END IF;
    IF v_del OR mr.removed_at IS NOT NULL THEN
      IF am.role <> 'admin' AND am.id <> mo.id THEN RAISE EXCEPTION 'admin only' USING ERRCODE = '42501'; END IF;
    ELSIF am.role <> 'admin' AND (
         (mo.user_id IS NOT NULL AND am.id <> mo.id)
      OR mr.role IS DISTINCT FROM mo.role
      OR mo.removed_at IS NOT NULL
      OR mr.invited_email IS DISTINCT FROM mo.invited_email) THEN
      RAISE EXCEPTION 'admin only' USING ERRCODE = '42501';
    END IF;
    IF v_hlc <= mo.hlc THEN RETURN jsonb_build_object('status', 'stale', 'serverHlc', mo.hlc); END IF;
    IF v_del OR mr.removed_at IS NOT NULL THEN
      UPDATE wise_spliter.group_members SET removed_at = COALESCE(removed_at, now()), hlc = v_hlc
      WHERE id = v_id RETURNING server_seq INTO v_seq;
    ELSE
      UPDATE wise_spliter.group_members SET display_name = mr.display_name,
        avatar_initials = COALESCE(mr.avatar_initials, avatar_initials), upi_id = mr.upi_id,
        member_order = COALESCE(mr.member_order, member_order),
        role = COALESCE(mr.role, role), removed_at = NULL,
        invited_email = CASE WHEN user_id IS NULL THEN mr.invited_email ELSE invited_email END,
        hlc = v_hlc
      WHERE id = v_id RETURNING server_seq INTO v_seq;
    END IF;

  -- -------------------------------------------------------------- expense
  WHEN 'expense' THEN
    er := jsonb_populate_record(NULL::wise_spliter.expenses, d);
    SELECT * INTO eo FROM wise_spliter.expenses WHERE id = v_id FOR UPDATE;
    IF NOT FOUND THEN
      IF v_del THEN RAISE EXCEPTION 'nothing to delete' USING ERRCODE = '22023'; END IF;
      IF er.group_id IS NOT NULL THEN
        am := wise_spliter.actor_member(er.group_id, p_actor);
        IF am.id IS NULL THEN RAISE EXCEPTION 'not a member' USING ERRCODE = '42501'; END IF;
      END IF;
      IF er.group_id IS NULL AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(er.ad_hoc_participants, '[]')) x
          WHERE NOT (x ->> 'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
            AND NOT (COALESCE(eo.ad_hoc_participants, '[]') @> jsonb_build_array(jsonb_build_object('id', x ->> 'id')))) THEN
        RAISE EXCEPTION 'new direct-split participant ids must be fresh UUIDs' USING ERRCODE = '22023';
      END IF;
      INSERT INTO wise_spliter.expenses (id, group_id, ad_hoc_participants, title, category, tags, notes, expense_date,
        original_currency, original_amount_minor, group_currency, amount_minor, fx_rate_scaled, fx_status, fx_audit_note,
        split_mode, rotation_seed, payers, splits, comments, receipts, current_revision_id, revision_number,
        has_unresolved_conflict, conflict_revision_id, created_by_member_id, updated_by_member_id, created_at,
        updated_at, deleted_at, owner_id, hlc)
      VALUES (v_id, er.group_id, CASE WHEN er.group_id IS NULL THEN COALESCE(er.ad_hoc_participants, '[]') ELSE '[]' END,
        er.title, er.category, COALESCE(er.tags, '{}'), COALESCE(er.notes, ''), er.expense_date, er.original_currency,
        er.original_amount_minor, er.group_currency, er.amount_minor, er.fx_rate_scaled, er.fx_status, er.fx_audit_note,
        er.split_mode, COALESCE(er.rotation_seed, 0), er.payers, er.splits, COALESCE(er.comments, '[]'),
        COALESCE(er.receipts, '[]'), er.current_revision_id, COALESCE(er.revision_number, 1),
        COALESCE(er.has_unresolved_conflict, false), er.conflict_revision_id,
        COALESCE(am.id, er.created_by_member_id), COALESCE(am.id, er.updated_by_member_id),
        COALESCE(er.created_at, now()), now(), er.deleted_at, p_actor, v_hlc)
      ON CONFLICT DO NOTHING RETURNING server_seq INTO v_seq;
      IF v_seq IS NULL THEN RAISE EXCEPTION 'expense id taken' USING ERRCODE = '42501'; END IF;
      RETURN jsonb_build_object('status', 'applied', 'serverSeq', v_seq::text);
    END IF;
    IF NOT v_del AND er.group_id IS DISTINCT FROM eo.group_id THEN
      RAISE EXCEPTION 'expense belongs to another scope' USING ERRCODE = '42501';
    END IF;
    IF eo.group_id IS NOT NULL THEN
      am := wise_spliter.actor_member(eo.group_id, p_actor);
      IF am.id IS NULL THEN RAISE EXCEPTION 'not a member' USING ERRCODE = '42501'; END IF;
    ELSIF NOT wise_spliter.can_access_direct_expense(eo.id, eo.owner_id, p_actor) THEN
      RAISE EXCEPTION 'not a participant' USING ERRCODE = '42501';
    END IF;
    IF v_hlc <= eo.hlc THEN RETURN jsonb_build_object('status', 'stale', 'serverHlc', eo.hlc); END IF;
    IF v_del THEN
      UPDATE wise_spliter.expenses SET deleted_at = COALESCE(deleted_at, now()), updated_at = now(), hlc = v_hlc
      WHERE id = v_id RETURNING server_seq INTO v_seq;
    ELSE
      IF er.group_id IS NULL AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(er.ad_hoc_participants, '[]')) x
          WHERE NOT (x ->> 'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
            AND NOT (COALESCE(eo.ad_hoc_participants, '[]') @> jsonb_build_array(jsonb_build_object('id', x ->> 'id')))) THEN
        RAISE EXCEPTION 'new direct-split participant ids must be fresh UUIDs' USING ERRCODE = '22023';
      END IF;
      -- v1 is not stored on create; keep that one state (only v1) the first time it is replaced.
      IF eo.revision_number = 1 AND er.current_revision_id IS DISTINCT FROM eo.current_revision_id
         AND NOT EXISTS (SELECT 1 FROM wise_spliter.expense_revisions WHERE id = eo.current_revision_id) THEN
        INSERT INTO wise_spliter.expense_revisions (id, expense_id, group_id, revision_number, base_revision_id,
          actor_member_id, actor_display_name, action, changes_json, snapshot, created_at, hlc)
        VALUES (eo.current_revision_id, eo.id, eo.group_id, eo.revision_number, NULL, eo.created_by_member_id, '',
          'created', '[]', wise_spliter.expense_snapshot(eo), eo.created_at, eo.hlc);
      END IF;
      UPDATE wise_spliter.expenses SET
        ad_hoc_participants = CASE WHEN group_id IS NULL THEN COALESCE(er.ad_hoc_participants, '[]') ELSE '[]' END,
        title = er.title, category = er.category, tags = COALESCE(er.tags, '{}'), notes = COALESCE(er.notes, ''),
        expense_date = er.expense_date, original_currency = er.original_currency,
        original_amount_minor = er.original_amount_minor, group_currency = er.group_currency,
        amount_minor = er.amount_minor, fx_rate_scaled = er.fx_rate_scaled, fx_status = er.fx_status,
        fx_audit_note = er.fx_audit_note, split_mode = er.split_mode, payers = er.payers, splits = er.splits,
        comments = COALESCE(er.comments, '[]'), receipts = COALESCE(er.receipts, '[]'),
        current_revision_id = er.current_revision_id, revision_number = COALESCE(er.revision_number, revision_number),
        has_unresolved_conflict = COALESCE(er.has_unresolved_conflict, false),
        conflict_revision_id = er.conflict_revision_id,
        updated_by_member_id = COALESCE(am.id, er.updated_by_member_id),
        deleted_at = CASE WHEN er.deleted_at IS NULL THEN NULL ELSE COALESCE(deleted_at, now()) END,
        updated_at = now(), hlc = v_hlc
      WHERE id = v_id RETURNING server_seq INTO v_seq;
    END IF;

  -- ------------------------------------------------- append-only revision
  WHEN 'expense_revision' THEN
    IF v_del THEN RAISE EXCEPTION 'revisions are append-only' USING ERRCODE = '22023'; END IF;
    rr := jsonb_populate_record(NULL::wise_spliter.expense_revisions, d);
    IF EXISTS (SELECT 1 FROM wise_spliter.expense_revisions WHERE id = v_id) THEN
      RETURN jsonb_build_object('status', 'stale');
    END IF;
    SELECT * INTO eo FROM wise_spliter.expenses WHERE id = rr.expense_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'unknown expense' USING ERRCODE = '22023'; END IF;
    IF eo.group_id IS NOT NULL THEN
      am := wise_spliter.actor_member(eo.group_id, p_actor);
      IF am.id IS NULL THEN RAISE EXCEPTION 'not a member' USING ERRCODE = '42501'; END IF;
    ELSIF NOT wise_spliter.can_access_direct_expense(eo.id, eo.owner_id, p_actor) THEN
      RAISE EXCEPTION 'not a participant' USING ERRCODE = '42501';
    END IF;
    IF rr.action = 'created' AND NOT COALESCE(rr.is_conflict_branch, false) THEN
      RETURN jsonb_build_object('status', 'applied', 'reason', 'derived_from_expense');
    END IF;
    INSERT INTO wise_spliter.expense_revisions (id, expense_id, group_id, revision_number, base_revision_id,
      actor_member_id, actor_display_name, action, changes_json, snapshot, is_conflict_branch, created_at, hlc)
    VALUES (v_id, eo.id, eo.group_id, rr.revision_number, rr.base_revision_id,
      COALESCE(am.id, (SELECT ep.participant_id FROM wise_spliter.expense_participants ep
        WHERE ep.expense_id = eo.id AND ep.profile_id = p_actor ORDER BY ep.participant_id LIMIT 1), p_actor),
      p_name, rr.action, COALESCE(rr.changes_json, '[]'), rr.snapshot, COALESCE(rr.is_conflict_branch, false),
      COALESCE(rr.created_at, now()), v_hlc)
    ON CONFLICT DO NOTHING RETURNING server_seq INTO v_seq;
    IF v_seq IS NULL THEN RETURN jsonb_build_object('status', 'stale'); END IF;

  -- ----------------------------------------------------------- settlement
  WHEN 'settlement' THEN
    sr := jsonb_populate_record(NULL::wise_spliter.settlements, d);
    SELECT * INTO so FROM wise_spliter.settlements WHERE id = v_id FOR UPDATE;
    IF FOUND THEN
      IF NOT v_del AND sr.group_id IS DISTINCT FROM so.group_id THEN
        RAISE EXCEPTION 'settlement belongs to another scope' USING ERRCODE = '42501';
      END IF;
      sr.group_id := so.group_id;
    ELSIF v_del THEN
      RAISE EXCEPTION 'nothing to delete' USING ERRCODE = '22023';
    END IF;
    IF sr.group_id IS NOT NULL THEN
      am := wise_spliter.actor_member(sr.group_id, p_actor);
      IF am.id IS NULL THEN RAISE EXCEPTION 'not a member' USING ERRCODE = '42501'; END IF;
      IF NOT v_del AND (SELECT count(*) FROM wise_spliter.group_members
          WHERE group_id = sr.group_id AND id IN (sr.from_member_id, sr.to_member_id)) <> 2 THEN
        RAISE EXCEPTION 'settlement members outside group' USING ERRCODE = '22023';
      END IF;
    ELSE
      -- Direct settlement: anchored to one live direct bill. Recording or editing needs the actor
      -- bound to one of the two parties; deleting is open to either bound party, the bill owner,
      -- or the recorder.
      IF so.id IS NOT NULL AND NOT v_del AND sr.expense_id IS DISTINCT FROM so.expense_id THEN
        RAISE EXCEPTION 'settlement anchor is immutable' USING ERRCODE = '42501';
      END IF;
      sr.expense_id := COALESCE(so.expense_id, sr.expense_id);
      IF sr.expense_id IS NULL THEN
        IF NOT (v_del AND so.id IS NOT NULL AND so.owner_id = p_actor) THEN
          RAISE EXCEPTION 'a direct settlement needs expenseId' USING ERRCODE = '22023';
        END IF;
      ELSE
        SELECT * INTO eo FROM wise_spliter.expenses WHERE id = sr.expense_id AND group_id IS NULL;
        IF NOT FOUND THEN RAISE EXCEPTION 'unknown anchor bill' USING ERRCODE = '42501'; END IF;
        IF v_del THEN
          IF NOT (so.owner_id = p_actor OR eo.owner_id = p_actor OR EXISTS (
              SELECT 1 FROM wise_spliter.expense_participants WHERE expense_id = eo.id AND profile_id = p_actor
                AND participant_id IN (so.from_member_id, so.to_member_id))) THEN
            RAISE EXCEPTION 'only a party, the bill owner or the recorder can delete this settlement' USING ERRCODE = '42501';
          END IF;
        ELSE
          IF eo.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'anchor bill is deleted' USING ERRCODE = '22023'; END IF;
          IF so.id IS NOT NULL AND so.owner_id <> p_actor THEN
            RAISE EXCEPTION 'only the recorder can change a direct settlement' USING ERRCODE = '42501';
          END IF;
          IF (SELECT count(*) FROM wise_spliter.expense_participants
              WHERE expense_id = eo.id AND participant_id IN (sr.from_member_id, sr.to_member_id)) <> 2 THEN
            RAISE EXCEPTION 'settlement parties are not participants of the anchor bill' USING ERRCODE = '42501';
          END IF;
          IF NOT EXISTS (SELECT 1 FROM wise_spliter.expense_participants WHERE expense_id = eo.id
              AND profile_id = p_actor AND participant_id IN (sr.from_member_id, sr.to_member_id)) THEN
            RAISE EXCEPTION 'the recorder must be one of the two parties' USING ERRCODE = '42501';
          END IF;
        END IF;
      END IF;
    END IF;
    IF so.id IS NULL THEN
      INSERT INTO wise_spliter.settlements (id, group_id, expense_id, batch_settlement_id, from_member_id, to_member_id, amount_minor,
        currency, payment_method, payment_reference, notes, settled_date, created_at, deleted_at, owner_id, hlc)
      VALUES (v_id, sr.group_id, CASE WHEN sr.group_id IS NULL THEN sr.expense_id END, sr.batch_settlement_id, sr.from_member_id, sr.to_member_id, sr.amount_minor,
        sr.currency, COALESCE(sr.payment_method, 'upi'), sr.payment_reference, COALESCE(sr.notes, ''), sr.settled_date,
        COALESCE(sr.created_at, now()), sr.deleted_at, p_actor, v_hlc)
      ON CONFLICT DO NOTHING RETURNING server_seq INTO v_seq;
      IF v_seq IS NULL THEN RAISE EXCEPTION 'settlement id taken' USING ERRCODE = '42501'; END IF;
      RETURN jsonb_build_object('status', 'applied', 'serverSeq', v_seq::text);
    END IF;
    IF v_hlc <= so.hlc THEN RETURN jsonb_build_object('status', 'stale', 'serverHlc', so.hlc); END IF;
    IF v_del THEN
      UPDATE wise_spliter.settlements SET deleted_at = COALESCE(deleted_at, now()), hlc = v_hlc
      WHERE id = v_id RETURNING server_seq INTO v_seq;
    ELSE
      UPDATE wise_spliter.settlements SET batch_settlement_id = sr.batch_settlement_id,
        from_member_id = sr.from_member_id, to_member_id = sr.to_member_id, amount_minor = sr.amount_minor,
        currency = sr.currency, payment_method = COALESCE(sr.payment_method, payment_method),
        payment_reference = sr.payment_reference, notes = COALESCE(sr.notes, ''), settled_date = sr.settled_date,
        deleted_at = CASE WHEN sr.deleted_at IS NULL THEN NULL ELSE COALESCE(deleted_at, now()) END, hlc = v_hlc
      WHERE id = v_id RETURNING server_seq INTO v_seq;
    END IF;

  -- -------------------------------------------------- append-only activity
  WHEN 'group_activity' THEN
    IF v_del THEN RAISE EXCEPTION 'activity is append-only' USING ERRCODE = '22023'; END IF;
    ar := jsonb_populate_record(NULL::wise_spliter.group_activity_log, d);
    IF EXISTS (SELECT 1 FROM wise_spliter.group_activity_log WHERE id = v_id) THEN
      RETURN jsonb_build_object('status', 'stale');
    END IF;
    IF ar.group_id IS NOT NULL THEN
      am := wise_spliter.actor_member(ar.group_id, p_actor);
      IF am.id IS NULL THEN RAISE EXCEPTION 'not a member' USING ERRCODE = '42501'; END IF;
    ELSE
      -- Direct activity is shared through its expense only, so the writer must be able to open it.
      SELECT * INTO eo FROM wise_spliter.expenses WHERE id = ar.entity_id;
      IF (FOUND AND (eo.group_id IS NOT NULL OR NOT wise_spliter.can_access_direct_expense(eo.id, eo.owner_id, p_actor)))
         OR (NOT FOUND AND ar.entity_type IN ('expense', 'comment')) THEN
        RAISE EXCEPTION 'not a participant' USING ERRCODE = '42501';
      END IF;
    END IF;
    INSERT INTO wise_spliter.group_activity_log (id, group_id, actor_member_id, actor_display_name, entity_type,
      entity_id, action, summary_text, detail_note, diff_badges, created_at, owner_id, hlc)
    VALUES (v_id, ar.group_id, COALESCE(am.id, ar.actor_member_id), p_name, ar.entity_type, ar.entity_id, ar.action,
      ar.summary_text, COALESCE(ar.detail_note, ''), COALESCE(ar.diff_badges, '{}'), COALESCE(ar.created_at, now()),
      p_actor, v_hlc)
    ON CONFLICT DO NOTHING RETURNING server_seq INTO v_seq;
    IF v_seq IS NULL THEN RETURN jsonb_build_object('status', 'stale'); END IF;

  -- ------------------------------------------------------ receipt pointer
  WHEN 'receipt_pointer' THEN
    pr := jsonb_populate_record(NULL::wise_spliter.receipt_attachments, d);
    SELECT * INTO po FROM wise_spliter.receipt_attachments WHERE id = v_id FOR UPDATE;
    IF FOUND THEN
      IF NOT v_del AND pr.expense_id IS DISTINCT FROM po.expense_id THEN
        RAISE EXCEPTION 'receipt belongs to another expense' USING ERRCODE = '42501';
      END IF;
      pr.expense_id := po.expense_id;
    ELSIF v_del THEN
      RAISE EXCEPTION 'nothing to delete' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO eo FROM wise_spliter.expenses WHERE id = pr.expense_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'unknown expense' USING ERRCODE = '42501'; END IF;
    IF eo.group_id IS NOT NULL THEN
      am := wise_spliter.actor_member(eo.group_id, p_actor);
      IF am.id IS NULL THEN RAISE EXCEPTION 'not a member' USING ERRCODE = '42501'; END IF;
    ELSIF NOT wise_spliter.can_access_direct_expense(eo.id, eo.owner_id, p_actor) THEN
      RAISE EXCEPTION 'not a participant' USING ERRCODE = '42501';
    END IF;
    IF po.id IS NULL THEN
      INSERT INTO wise_spliter.receipt_attachments (id, group_id, expense_id, storage_path, file_name, mime_type,
        size_kb, uploaded_by_name, preview_note, sha256_hex, created_at, hlc)
      VALUES (v_id, eo.group_id, eo.id, pr.storage_path, pr.file_name, COALESCE(pr.mime_type, 'image/webp'),
        COALESCE(pr.size_kb, 0), p_name, COALESCE(pr.preview_note, ''), pr.sha256_hex, COALESCE(pr.created_at, now()), v_hlc)
      ON CONFLICT DO NOTHING RETURNING server_seq INTO v_seq;
      IF v_seq IS NULL THEN RAISE EXCEPTION 'receipt id taken' USING ERRCODE = '42501'; END IF;
      RETURN jsonb_build_object('status', 'applied', 'serverSeq', v_seq::text);
    END IF;
    IF v_hlc <= po.hlc THEN RETURN jsonb_build_object('status', 'stale', 'serverHlc', po.hlc); END IF;
    UPDATE wise_spliter.receipt_attachments SET
      storage_path = CASE WHEN v_del THEN storage_path ELSE pr.storage_path END,
      file_name = CASE WHEN v_del THEN file_name ELSE pr.file_name END,
      preview_note = CASE WHEN v_del THEN preview_note ELSE COALESCE(pr.preview_note, '') END,
      sha256_hex = CASE WHEN v_del THEN sha256_hex ELSE pr.sha256_hex END,
      deleted_at = CASE WHEN v_del THEN COALESCE(deleted_at, now()) ELSE NULL END, hlc = v_hlc
    WHERE id = v_id RETURNING server_seq INTO v_seq;

  ELSE
    RAISE EXCEPTION 'unknown entity' USING ERRCODE = '22023';
  END CASE;

  RETURN jsonb_build_object('status', 'applied', 'serverSeq', v_seq::text);
END $$;

-- SECURITY DEFINER bodies run as their owner, so current_user is useless as a caller check.
-- The `role` setting still names the caller (PostgREST sets it to the JWT role).
CREATE OR REPLACE FUNCTION wise_spliter.assert_backend()
RETURNS void LANGUAGE plpgsql STABLE SET search_path = '' AS $$
BEGIN
  IF COALESCE(NULLIF(current_setting('role', true), 'none'), session_user) NOT IN ('service_role', 'postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'permission denied: backend only' USING ERRCODE = '42501';
  END IF;
END $$;

-- Per-mutation subtransaction: one bad mutation never aborts the rest of the batch. The global
-- commit-order lock is taken by the seq trigger at the first write only, so validation and
-- rejected mutations never hold it. Lock waits and the batch are time-boxed; a timeout or a
-- deadlock aborts the whole batch (HTTP 503) so the client retries it, never half-reports it.
CREATE OR REPLACE FUNCTION wise_spliter.push_mutations(p_actor TEXT, p_mutations JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_email TEXT; v_name TEXT; m JSONB; r JSONB; out JSONB := '[]'::jsonb; v_con TEXT;
BEGIN
  PERFORM wise_spliter.assert_backend();
  PERFORM set_config('lock_timeout', '2s', true);
  SELECT email, full_name INTO v_email, v_name FROM wise_spliter.profiles WHERE id = p_actor;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown actor' USING ERRCODE = '42501'; END IF;
  -- One push in flight per account, held in the database so it works across API replicas.
  -- A try-lock never waits, so it adds no wait edge: lock order is per-actor try-lock, then the
  -- commit-order lock, then rows and quota counters.
  IF NOT pg_try_advisory_xact_lock(7735, hashtext('ws_push:' || p_actor)) THEN
    RETURN jsonb_build_object('busy', true);
  END IF;
  -- The commit-order lock before any row or quota-counter lock, so concurrent pushes queue instead
  -- of deadlocking. The work done under it is O(1) per mutation (indexed lookups and counter rows);
  -- heavy validation already happened in the API.
  PERFORM pg_advisory_xact_lock(7735001);
  PERFORM set_config('wise_spliter.actor', p_actor, true);
  IF jsonb_typeof(p_mutations) <> 'array' OR jsonb_array_length(p_mutations) > 200 THEN
    RAISE EXCEPTION 'expected at most 200 mutations' USING ERRCODE = '22023';
  END IF;

  FOR m IN
    SELECT x FROM jsonb_array_elements(p_mutations) WITH ORDINALITY AS t(x, n)
    ORDER BY array_position(ARRAY['group','group_member','expense','expense_revision','settlement',
      'group_activity','receipt_pointer'], x ->> 'entity'), n
  LOOP
    IF clock_timestamp() - statement_timestamp() > interval '2 seconds' THEN
      RAISE EXCEPTION 'push batch exceeded its time budget' USING ERRCODE = '57014';
    END IF;
    BEGIN
      r := wise_spliter.apply_mutation(p_actor, v_email, v_name, m);
    EXCEPTION
      WHEN lock_not_available OR deadlock_detected THEN
        RAISE;
      WHEN insufficient_privilege THEN
        r := jsonb_build_object('status', 'forbidden', 'reason', SQLERRM);
      WHEN unique_violation OR foreign_key_violation THEN
        r := jsonb_build_object('status', 'forbidden', 'reason', 'conflicts with existing data');
      WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_con = CONSTRAINT_NAME;
        r := jsonb_build_object('status', 'invalid', 'reason', CASE
          WHEN v_con <> '' THEN 'violates ' || v_con
          WHEN SQLSTATE IN ('22023', '23514') THEN SQLERRM
          ELSE 'rejected (' || SQLSTATE || ')' END);
    END;
    out := out || jsonb_build_array(jsonb_build_object('id', m ->> 'id', 'entity', m ->> 'entity') || r);
  END LOOP;
  RETURN jsonb_build_object('results', out);
END $$;

-- Cursor pull scoped to what the actor can read. Every branch is index-driven and limited.
-- Gap-free because seqs are drawn under the commit-order lock (see bump_server_seq).
-- Direct (non-group) rows are reachable only through server-bound expense_participants or
-- ownership, never through ids or emails the client wrote.
-- p_group / p_expense: page one group's or one direct bill's rows from any cursor (backfill).
-- Without them, backfillGroupIds lists groups whose own membership row changed after p_cursor
-- (joined, re-added, claimed) and backfillExpenseIds lists direct bills whose binding to the
-- caller changed after p_cursor (added later, or claimed): their older rows sit below the cursor.
DROP FUNCTION IF EXISTS wise_spliter.pull_changes(TEXT, BIGINT, INTEGER);
DROP FUNCTION IF EXISTS wise_spliter.pull_changes(TEXT, BIGINT, INTEGER, TEXT);
CREATE OR REPLACE FUNCTION wise_spliter.pull_changes(p_actor TEXT, p_cursor BIGINT, p_limit INTEGER,
  p_group TEXT DEFAULT NULL, p_expense TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_limit INT := least(greatest(COALESCE(p_limit, 200), 1), 500); res JSONB;
  v_scoped BOOLEAN := p_group IS NOT NULL OR p_expense IS NOT NULL;
  e wise_spliter.expenses;
BEGIN
  PERFORM wise_spliter.assert_backend();
  PERFORM 1 FROM wise_spliter.profiles WHERE id = p_actor;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown actor' USING ERRCODE = '42501'; END IF;
  IF p_group IS NOT NULL AND p_expense IS NOT NULL THEN RAISE EXCEPTION 'one scope only' USING ERRCODE = '22023'; END IF;
  IF p_group IS NOT NULL AND (wise_spliter.actor_member(p_group, p_actor)).id IS NULL THEN
    RAISE EXCEPTION 'not a member' USING ERRCODE = '42501';
  END IF;
  IF p_expense IS NOT NULL THEN
    SELECT * INTO e FROM wise_spliter.expenses WHERE id = p_expense AND group_id IS NULL;
    IF NOT FOUND OR NOT wise_spliter.can_access_direct_expense(e.id, e.owner_id, p_actor) THEN
      RAISE EXCEPTION 'not a participant' USING ERRCODE = '42501';
    END IF;
  END IF;

  WITH mg AS MATERIALIZED (
    SELECT group_id FROM wise_spliter.group_members
    WHERE user_id = p_actor AND removed_at IS NULL AND p_expense IS NULL AND (p_group IS NULL OR group_id = p_group)
  ), dx AS MATERIALIZED (
    SELECT p_expense AS id WHERE p_expense IS NOT NULL
    UNION
    SELECT x.id FROM wise_spliter.expenses x WHERE NOT v_scoped AND x.owner_id = p_actor AND x.group_id IS NULL
    UNION
    SELECT ep.expense_id FROM wise_spliter.expense_participants ep WHERE NOT v_scoped AND ep.profile_id = p_actor
  ), ch AS (
    (SELECT 'group' AS entity, g.id, g.server_seq AS seq, g.deleted_at IS NOT NULL AS deleted, to_jsonb(g) AS data
      FROM wise_spliter.groups g WHERE g.id IN (SELECT group_id FROM mg) AND g.server_seq > p_cursor
      ORDER BY g.server_seq LIMIT v_limit + 1)
    UNION ALL
    -- Own rows in groups the actor has left come back as bare tombstones (no data).
    (SELECT 'group_member', m.id, m.server_seq, m.removed_at IS NOT NULL,
        CASE WHEN m.group_id IN (SELECT group_id FROM mg) THEN to_jsonb(m) END
      FROM wise_spliter.group_members m
      WHERE (m.group_id IN (SELECT group_id FROM mg) OR (NOT v_scoped AND m.user_id = p_actor)) AND m.server_seq > p_cursor
      ORDER BY m.server_seq LIMIT v_limit + 1)
    UNION ALL
    (SELECT 'expense', x.id, x.server_seq, x.deleted_at IS NOT NULL, to_jsonb(x) - 'owner_id'
      FROM wise_spliter.expenses x
      WHERE (x.group_id IN (SELECT group_id FROM mg) OR x.id IN (SELECT id FROM dx)) AND x.server_seq > p_cursor
      ORDER BY x.server_seq LIMIT v_limit + 1)
    UNION ALL
    (SELECT 'expense_revision', r.id, r.server_seq, false, to_jsonb(r)
      FROM wise_spliter.expense_revisions r
      WHERE (r.group_id IN (SELECT group_id FROM mg) OR (r.group_id IS NULL AND r.expense_id IN (SELECT id FROM dx)))
        AND r.server_seq > p_cursor
      ORDER BY r.server_seq LIMIT v_limit + 1)
    UNION ALL
    -- Direct settlements: visible with their bill while both parties are still on it; tombstones
    -- (deleted_at set, e.g. when a party left the bill) always sync so devices drop them.
    (SELECT 'settlement', st.id, st.server_seq, st.deleted_at IS NOT NULL, to_jsonb(st) - 'owner_id'
      FROM wise_spliter.settlements st
      WHERE (st.group_id IN (SELECT group_id FROM mg)
          OR (st.group_id IS NULL AND ((st.expense_id IN (SELECT id FROM dx)
                AND (st.deleted_at IS NOT NULL OR (EXISTS (SELECT 1 FROM wise_spliter.expense_participants ep
                  WHERE ep.expense_id = st.expense_id AND ep.participant_id = st.from_member_id)
                AND EXISTS (SELECT 1 FROM wise_spliter.expense_participants ep
                  WHERE ep.expense_id = st.expense_id AND ep.participant_id = st.to_member_id))))
              OR (NOT v_scoped AND st.expense_id IS NULL AND st.owner_id = p_actor))))
        AND st.server_seq > p_cursor
      ORDER BY st.server_seq LIMIT v_limit + 1)
    UNION ALL
    (SELECT 'group_activity', a.id, a.server_seq, false, to_jsonb(a) - 'owner_id'
      FROM wise_spliter.group_activity_log a
      WHERE (a.group_id IN (SELECT group_id FROM mg)
          OR (a.group_id IS NULL AND ((NOT v_scoped AND a.owner_id = p_actor)
              OR (a.entity_id IN (SELECT id FROM dx) AND EXISTS (
                SELECT 1 FROM wise_spliter.expenses x WHERE x.id = a.entity_id
                  AND wise_spliter.can_access_direct_expense(x.id, x.owner_id, a.owner_id))))))
        AND a.server_seq > p_cursor
      ORDER BY a.server_seq LIMIT v_limit + 1)
    UNION ALL
    (SELECT 'receipt_pointer', rp.id, rp.server_seq, rp.deleted_at IS NOT NULL, to_jsonb(rp)
      FROM wise_spliter.receipt_attachments rp
      WHERE (rp.group_id IN (SELECT group_id FROM mg) OR (rp.group_id IS NULL AND rp.expense_id IN (SELECT id FROM dx)))
        AND rp.server_seq > p_cursor
      ORDER BY rp.server_seq LIMIT v_limit + 1)
  ), page AS (
    SELECT * FROM ch ORDER BY seq LIMIT v_limit + 1
  ), shown AS (
    SELECT * FROM page ORDER BY seq LIMIT v_limit
  ), binds AS (
    SELECT ep.expense_id, ep.server_seq FROM wise_spliter.expense_participants ep
    JOIN wise_spliter.expenses x ON x.id = ep.expense_id AND x.owner_id <> p_actor
    WHERE NOT v_scoped AND p_cursor > 0 AND ep.profile_id = p_actor AND ep.server_seq > p_cursor
  )
  SELECT jsonb_build_object(
    'changes', COALESCE((SELECT jsonb_agg(jsonb_build_object('entity', entity, 'id', id, 'serverSeq', seq::text,
       'deleted', deleted, 'data', data) ORDER BY seq) FROM shown), '[]'::jsonb),
    -- Binding rows are not in the change stream; once everything readable is delivered
    -- (no more pages) the cursor may move past them, which is safe under the commit-order lock.
    'nextCursor', greatest(COALESCE((SELECT max(seq) FROM shown), p_cursor),
       CASE WHEN (SELECT count(*) FROM page) > v_limit THEN 0 ELSE COALESCE((SELECT max(server_seq) FROM binds), 0) END)::text,
    'hasMore', (SELECT count(*) FROM page) > v_limit,
    'backfillGroupIds', COALESCE((SELECT jsonb_agg(m.group_id ORDER BY m.group_id) FROM wise_spliter.group_members m
       WHERE NOT v_scoped AND p_cursor > 0 AND m.user_id = p_actor AND m.removed_at IS NULL AND m.server_seq > p_cursor), '[]'::jsonb),
    'backfillExpenseIds', COALESCE((SELECT jsonb_agg(DISTINCT expense_id) FROM binds), '[]'::jsonb))
  INTO res;
  RETURN res;
END $$;

-- Links unclaimed placeholder rows to a verified account (exact lowercase email match).
CREATE OR REPLACE FUNCTION wise_spliter.claim_members(p_actor TEXT)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_email TEXT; n INT;
BEGIN
  PERFORM wise_spliter.assert_backend();
  PERFORM pg_advisory_xact_lock(7735001);
  SELECT email INTO v_email FROM wise_spliter.profiles WHERE id = p_actor;
  IF v_email IS NULL THEN RETURN 0; END IF;
  WITH pick AS (
    SELECT DISTINCT ON (gm.group_id) gm.id FROM wise_spliter.group_members gm
    WHERE gm.invited_email = v_email AND gm.user_id IS NULL AND gm.removed_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM wise_spliter.group_members x
                      WHERE x.group_id = gm.group_id AND x.user_id = p_actor AND x.removed_at IS NULL)
    ORDER BY gm.group_id, gm.member_order
  )
  UPDATE wise_spliter.group_members gm SET user_id = p_actor, claimed_at = now()
  FROM pick WHERE gm.id = pick.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  -- Direct splits that named this verified email before the profile existed: one bounded UPDATE
  -- on the binding rows only (live bills; the email cap keeps it <= 2000). The bills reach the
  -- caller through backfillExpenseIds, so no bill row is rewritten here.
  UPDATE wise_spliter.expense_participants ep SET profile_id = p_actor
  WHERE (ep.expense_id, ep.participant_id) IN (
    SELECT x.expense_id, x.participant_id FROM wise_spliter.expense_participants x
    JOIN wise_spliter.expenses e ON e.id = x.expense_id AND e.deleted_at IS NULL
    WHERE x.invited_email = v_email AND x.profile_id IS NULL LIMIT 2000);
  RETURN n;
END $$;

-- Account deletion. auth.users is shared with another app and is never touched here.
CREATE OR REPLACE FUNCTION wise_spliter.delete_account(p_actor TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_email TEXT; v_members TEXT[]; v_groups TEXT[]; n_direct INT; n_groups INT;
BEGIN
  PERFORM wise_spliter.assert_backend();
  PERFORM pg_advisory_xact_lock(7735001);
  SELECT email INTO v_email FROM wise_spliter.profiles WHERE id = p_actor FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown actor' USING ERRCODE = '42501'; END IF;

  SELECT array_agg(id), array_agg(DISTINCT group_id) INTO v_members, v_groups
  FROM wise_spliter.group_members WHERE user_id = p_actor;

  -- Member rows stay so other members' balances still add up; only identity is erased.
  UPDATE wise_spliter.group_members SET user_id = NULL, invited_email = NULL, upi_id = NULL,
    display_name = 'Deleted user', avatar_initials = 'DU'
  WHERE id = ANY(COALESCE(v_members, '{}'));
  -- Scoped by group_id so the (group_id, server_seq) indexes drive these, never a table scan.
  UPDATE wise_spliter.expense_revisions SET actor_display_name = 'Deleted user'
  WHERE group_id = ANY(COALESCE(v_groups, '{}')) AND actor_member_id = ANY(COALESCE(v_members, '{}'));
  UPDATE wise_spliter.group_activity_log SET actor_display_name = 'Deleted user'
  WHERE group_id = ANY(COALESCE(v_groups, '{}')) AND actor_member_id = ANY(COALESCE(v_members, '{}'));

  -- Groups nobody can open any more are the user's own data.
  WITH gone AS (
    DELETE FROM wise_spliter.groups g WHERE g.id = ANY(COALESCE(v_groups, '{}'))
      AND NOT EXISTS (SELECT 1 FROM wise_spliter.group_members m
                      WHERE m.group_id = g.id AND m.user_id IS NOT NULL AND m.removed_at IS NULL)
    RETURNING 1)
  SELECT count(*) INTO n_groups FROM gone;

  -- Direct splits only this user can see are deleted. Shared ones (anyone else named or bound) stay,
  -- with their settlements, so everybody else's balances are unchanged; only identity is scrubbed.
  WITH gone AS (
    DELETE FROM wise_spliter.expenses e WHERE e.group_id IS NULL AND e.owner_id = p_actor
      AND NOT EXISTS (SELECT 1 FROM wise_spliter.expense_participants ep WHERE ep.expense_id = e.id
        AND ((ep.profile_id IS NOT NULL AND ep.profile_id <> p_actor)
          OR (ep.profile_id IS NULL AND ep.invited_email IS NOT NULL AND ep.invited_email <> v_email)))
    RETURNING 1)
  SELECT count(*) INTO n_direct FROM gone;
  DELETE FROM wise_spliter.settlements WHERE group_id IS NULL AND expense_id IS NULL AND owner_id = p_actor;
  DELETE FROM wise_spliter.group_activity_log a WHERE a.group_id IS NULL AND a.owner_id = p_actor
    AND NOT EXISTS (SELECT 1 FROM wise_spliter.expenses e WHERE e.id = a.entity_id);
  UPDATE wise_spliter.group_activity_log SET actor_display_name = 'Deleted user'
  WHERE owner_id = p_actor AND group_id IS NULL;

  UPDATE wise_spliter.expenses e SET ad_hoc_participants = (
    SELECT jsonb_agg(CASE WHEN x ->> 'id' IN (SELECT ep.participant_id FROM wise_spliter.expense_participants ep
        WHERE ep.expense_id = e.id AND (ep.profile_id = p_actor OR (ep.profile_id IS NULL AND ep.invited_email = v_email)))
      THEN x || jsonb_build_object('displayName', 'Deleted user', 'invitedEmail', NULL, 'upiId', NULL, 'avatarInitials', 'DU')
      ELSE x END ORDER BY o)
    FROM jsonb_array_elements(e.ad_hoc_participants) WITH ORDINALITY AS t(x, o))
  WHERE e.group_id IS NULL AND e.id IN (
    SELECT ep.expense_id FROM wise_spliter.expense_participants ep WHERE ep.profile_id = p_actor
    UNION SELECT ep.expense_id FROM wise_spliter.expense_participants ep WHERE ep.profile_id IS NULL AND ep.invited_email = v_email);

  -- Rows kept for others lose their owner: a profile later re-created with the same id (same auth
  -- uid on a Google re-sign-up) must get no rights over them.
  PERFORM set_config('wise_spliter.tombstone_owner', 'on', true);
  UPDATE wise_spliter.expenses SET owner_id = 'deleted_' || substr(md5(p_actor || clock_timestamp()::text), 1, 16)
  WHERE owner_id = p_actor;
  UPDATE wise_spliter.settlements SET owner_id = 'deleted_' || substr(md5(p_actor || clock_timestamp()::text), 1, 16)
  WHERE owner_id = p_actor;
  UPDATE wise_spliter.group_activity_log SET owner_id = 'deleted_' || substr(md5(p_actor || clock_timestamp()::text), 1, 16)
  WHERE owner_id = p_actor;
  UPDATE wise_spliter.groups SET created_by = 'deleted_' || substr(md5(p_actor || clock_timestamp()::text), 1, 16)
  WHERE created_by = p_actor;
  PERFORM set_config('wise_spliter.tombstone_owner', 'off', true);

  DELETE FROM wise_spliter.profiles WHERE id = p_actor;
  RETURN jsonb_build_object('deletedGroups', n_groups, 'deletedDirectExpenses', n_direct);
END $$;

CREATE OR REPLACE FUNCTION wise_spliter.schema_health()
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM wise_spliter.assert_backend();
  RETURN jsonb_build_object(
    'ok', true,
    'schema', 'wise_spliter',
    'rls_forced_count', (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'wise_spliter' AND c.relkind = 'r' AND c.relrowsecurity AND c.relforcerowsecurity
        AND c.relname <> 'schema_migrations'),
    'public_table_grants', (SELECT count(*) FROM information_schema.role_table_grants
      WHERE table_schema = 'wise_spliter' AND grantee IN ('anon', 'authenticated', 'PUBLIC')),
    'public_function_grants', (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'wise_spliter' AND (has_function_privilege('anon', p.oid, 'EXECUTE')
        OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))),
    'authenticated_schema_usage', has_schema_privilege('authenticated', 'wise_spliter', 'USAGE'),
    'check_constraints', (SELECT count(*) FROM pg_constraint WHERE connamespace = 'wise_spliter'::regnamespace
      AND contype = 'c' AND conname LIKE 'chk_%'),
    'seq_triggers', (SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_zz_bump_server_seq' AND NOT tgisinternal),
    'seq_insert_triggers', (SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_zz_assign_server_seq' AND NOT tgisinternal),
    'seq_triggers_last', NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE c.relnamespace = 'wise_spliter'::regnamespace AND NOT t.tgisinternal AND t.tgname > 'trg_zz_'
        AND t.tgname NOT LIKE 'trg_zz_%'),
    'seq_defaults', (SELECT count(*) FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
      JOIN pg_class c ON c.oid = d.adrelid WHERE c.relnamespace = 'wise_spliter'::regnamespace AND a.attname = 'server_seq'),
    'cap_triggers', (SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_row_caps' AND NOT tgisinternal),
    'immutable_triggers', (SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'trg_%_immutable' AND NOT tgisinternal),
    'scope_triggers', (SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_expense_member_scope' AND NOT tgisinternal),
    'identity_server_seq', (SELECT count(*) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
      WHERE c.relnamespace = 'wise_spliter'::regnamespace AND a.attname = 'server_seq' AND a.attidentity <> ''),
    'policies', (SELECT count(*) FROM pg_policies WHERE schemaname = 'wise_spliter'),
    'lowercase_email_checks', (SELECT count(*) FROM pg_constraint WHERE connamespace = 'wise_spliter'::regnamespace
      AND conname IN ('chk_profiles_email', 'chk_group_members_email'))
  );
END $$;

-- =============================================================================
-- 9. RLS stays FORCEd on every table with no policies (deny-all, see section 7)
-- =============================================================================

-- Receipts never reach Storage (0003). The old select policy called wise_spliter helpers for
-- every storage.objects row, which would now fail for the other app sharing this project.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'storage' AND table_name = 'objects') THEN
    DROP POLICY IF EXISTS ws_receipts_select_member ON storage.objects;
  END IF;
END $$;

-- Ledger of applied migration files (created by the runner too; kept here so a pasted run has it).
CREATE TABLE IF NOT EXISTS wise_spliter.schema_migrations (
  version TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE wise_spliter.schema_migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE wise_spliter.schema_migrations FORCE ROW LEVEL SECURITY;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['profiles','groups','group_members','expenses','expense_revisions',
                           'settlements','group_activity_log','receipt_attachments','expense_participants','quota_usage'] LOOP
    EXECUTE format('ALTER TABLE wise_spliter.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE wise_spliter.%I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- =============================================================================
-- 10. Final grants: service_role only
-- =============================================================================

REVOKE ALL ON ALL TABLES IN SCHEMA wise_spliter FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA wise_spliter FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA wise_spliter FROM PUBLIC, anon, authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA wise_spliter TO service_role, postgres;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA wise_spliter TO service_role, postgres;
GRANT EXECUTE ON FUNCTION wise_spliter.schema_health(), wise_spliter.push_mutations(TEXT, JSONB),
  wise_spliter.pull_changes(TEXT, BIGINT, INTEGER, TEXT, TEXT), wise_spliter.claim_members(TEXT),
  wise_spliter.delete_account(TEXT) TO service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA wise_spliter REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA wise_spliter REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA wise_spliter REVOKE ALL ON FUNCTIONS FROM PUBLIC, anon, authenticated;

-- When pasted in the SQL editor instead of run by scripts/apply-migration.mjs, record 0001-0004 so
-- the runner never replays the older files over this schema. 'pasted' is reconciled to the real
-- checksum by the runner.
INSERT INTO wise_spliter.schema_migrations (version, checksum) VALUES
  ('0001_wise_spliter_schema', 'pasted'), ('0002_wise_spliter_security_hardening', 'pasted'),
  ('0003_local_only_receipt_pointers', 'pasted'), ('0004_tenant_isolation_and_sync', 'pasted')
ON CONFLICT (version) DO NOTHING;

NOTIFY pgrst, 'reload schema';
