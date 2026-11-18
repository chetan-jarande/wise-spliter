-- 0005: Phase 1 server support. Group bills and settlements must be in the group's base
-- currency; expense edits carry baseHlc so concurrent edits become a server-side conflict marker
-- every device pulls; comments become their own append-only entity (legacy JSON migrated);
-- join by invite code.
-- Every 0004 guarantee stays: deny-all FORCE RLS, assert_backend, service_role-only EXECUTE,
-- the commit-order lock, the per-actor push try-lock, quotas and participant binding. Idempotent.

SET client_min_messages = warning;

-- =============================================================================
-- 1. expense_comments: one row per comment, author set by the server
-- =============================================================================

CREATE TABLE IF NOT EXISTS wise_spliter.expense_comments (
  id TEXT PRIMARY KEY,
  expense_id TEXT NOT NULL REFERENCES wise_spliter.expenses(id) ON DELETE CASCADE,
  group_id TEXT,
  -- NULL for legacy rows (migrated from expense JSON) and after the author deleted their account.
  author_id TEXT REFERENCES wise_spliter.profiles(id) ON DELETE SET NULL,
  author_member_id TEXT,
  author_name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  edited_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  hlc TEXT COLLATE "C" NOT NULL,
  server_seq BIGINT NOT NULL,
  -- Migrated from expense JSON: author_name / author_member_id were client-written, never verified.
  legacy BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT chk_expense_comments_id CHECK (id ~ '^[A-Za-z0-9_-]{1,120}$'),
  CONSTRAINT chk_expense_comments_text CHECK (char_length(body) <= 1000
    AND (deleted_at IS NOT NULL OR char_length(btrim(body)) >= 1) AND char_length(author_name) <= 100
    AND char_length(COALESCE(author_member_id, '')) <= 80 AND char_length(hlc) <= 120)
);
ALTER TABLE wise_spliter.expense_comments ADD COLUMN IF NOT EXISTS legacy BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_expense_comments_group_seq ON wise_spliter.expense_comments (group_id, server_seq);
CREATE INDEX IF NOT EXISTS idx_expense_comments_expense ON wise_spliter.expense_comments (expense_id, server_seq);
CREATE INDEX IF NOT EXISTS idx_expense_comments_author ON wise_spliter.expense_comments (author_id) WHERE author_id IS NOT NULL;
ALTER TABLE wise_spliter.expense_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE wise_spliter.expense_comments FORCE ROW LEVEL SECURITY;

-- Scope and author never move; the author's account deletion (FK SET NULL) anonymizes the name.
CREATE OR REPLACE FUNCTION wise_spliter.guard_comment_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.expense_id IS DISTINCT FROM OLD.expense_id OR NEW.group_id IS DISTINCT FROM OLD.group_id
     OR (NEW.author_id IS DISTINCT FROM OLD.author_id AND NEW.author_id IS NOT NULL) THEN
    RAISE EXCEPTION 'expense_comments scope and author are immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.author_id IS NULL AND OLD.author_id IS NOT NULL THEN NEW.author_name := 'Deleted user'; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER trg_comment_guard BEFORE UPDATE ON wise_spliter.expense_comments
  FOR EACH ROW EXECUTE FUNCTION wise_spliter.guard_comment_update();
CREATE OR REPLACE TRIGGER trg_row_caps BEFORE INSERT ON wise_spliter.expense_comments
  FOR EACH ROW EXECUTE FUNCTION wise_spliter.enforce_row_caps();
CREATE OR REPLACE TRIGGER trg_zz_bump_server_seq BEFORE UPDATE ON wise_spliter.expense_comments
  FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION wise_spliter.bump_server_seq();
CREATE OR REPLACE TRIGGER trg_zz_assign_server_seq BEFORE INSERT ON wise_spliter.expense_comments
  FOR EACH ROW EXECUTE FUNCTION wise_spliter.bump_server_seq();

-- 500 comments per (author, bill), soft-deleted ones included, like every other quota.
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
    WHEN 'expense_comments' THEN cap := 500; v_owner := NEW.author_id; v_scope := NEW.expense_id;
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

-- Who removed a member: join_group revives only rows the user left themselves (removed_by = user).
ALTER TABLE wise_spliter.group_members ADD COLUMN IF NOT EXISTS removed_by TEXT;
-- A direct-bill actor who is not a bound participant is recorded as NULL, never as a profile id.
ALTER TABLE wise_spliter.expense_revisions ALTER COLUMN actor_member_id DROP NOT NULL;
UPDATE wise_spliter.expense_revisions r SET actor_member_id = NULL
WHERE r.group_id IS NULL AND r.actor_member_id IN (SELECT id FROM wise_spliter.profiles)
  AND NOT EXISTS (SELECT 1 FROM wise_spliter.expense_participants ep
                  WHERE ep.expense_id = r.expense_id AND ep.participant_id = r.actor_member_id);

-- Invite codes are 40-bit server codes only; older guessable codes are re-minted.
UPDATE wise_spliter.groups SET invite_code = 'WS-' || upper(encode(extensions.gen_random_bytes(5), 'hex'))
WHERE invite_code !~ '^WS-[0-9A-F]{10}$';
ALTER TABLE wise_spliter.groups DROP CONSTRAINT IF EXISTS chk_groups_invite_code;
ALTER TABLE wise_spliter.groups ADD CONSTRAINT chk_groups_invite_code CHECK (invite_code ~ '^WS-[0-9A-F]{10}$');

-- Payee VPAs in activity text: the first two characters of the name and the full @handle.
CREATE OR REPLACE FUNCTION wise_spliter.mask_upi(p TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN NULLIF(btrim(p), '') IS NULL THEN 'none'
    WHEN position('@' IN p) > 0 THEN left(split_part(p, '@', 1), 2) || '***@' || left(split_part(p, '@', 2), 60)
    ELSE left(p, 2) || '***' END;
$$;
-- Server-written activity rows (actor and text derived here, never from the client).
ALTER TABLE wise_spliter.group_activity_log ALTER COLUMN actor_member_id DROP NOT NULL;
CREATE OR REPLACE FUNCTION wise_spliter.log_upi_change(p_id TEXT, p_group TEXT, p_actor TEXT, p_actor_member TEXT,
  p_name TEXT, p_entity_type TEXT, p_entity TEXT, p_who TEXT, p_old TEXT, p_new TEXT, p_hlc TEXT)
RETURNS void LANGUAGE sql SET search_path = '' AS $$
  INSERT INTO wise_spliter.group_activity_log (id, group_id, actor_member_id, actor_display_name, entity_type, entity_id,
    action, summary_text, detail_note, diff_badges, created_at, owner_id, hlc)
  VALUES (p_id, p_group, p_actor_member, p_name, p_entity_type, p_entity, 'upi_changed',
    left(p_name || ' changed the UPI ID of ' || p_who, 500),
    wise_spliter.mask_upi(p_old) || ' to ' || wise_spliter.mask_upi(p_new), '{}', now(), p_actor, p_hlc)
  ON CONFLICT (id) DO NOTHING;
$$;

-- An hlc strictly after p_after, minted by the server (physical ms now, else p_after's counter + 1).
CREATE OR REPLACE FUNCTION wise_spliter.next_hlc(p_after TEXT)
RETURNS TEXT LANGUAGE sql VOLATILE SET search_path = '' AS $$
  SELECT CASE
    WHEN now_ms > phys THEN lpad(to_hex(now_ms), 12, '0') || '-0000-server'
    WHEN ctr < 65535 THEN lpad(to_hex(phys), 12, '0') || '-' || lpad(to_hex(ctr + 1), 4, '0') || '-server'
    ELSE lpad(to_hex(phys + 1), 12, '0') || '-0000-server' END
  FROM (SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms,
          ('x' || lpad(substr(p_after, 1, 12), 16, '0'))::bit(64)::bigint AS phys,
          ('x' || lpad(substr(p_after, 14, 4), 8, '0'))::bit(32)::int AS ctr) t;
$$;

-- Revision snapshots carry the bill's currency, so restoring across a base-currency change can convert.
CREATE OR REPLACE FUNCTION wise_spliter.expense_snapshot(e wise_spliter.expenses)
RETURNS JSONB LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT jsonb_build_object('title', e.title, 'category', e.category, 'amountMinor', e.amount_minor,
    'originalCurrency', e.original_currency, 'originalAmountMinor', e.original_amount_minor,
    'groupCurrency', e.group_currency,
    'fxRateScaled', e.fx_rate_scaled, 'fxStatus', e.fx_status, 'splitMode', e.split_mode,
    'payers', e.payers, 'splits', e.splits, 'notes', e.notes);
$$;

CREATE OR REPLACE FUNCTION wise_spliter.currency_mismatch(p_base TEXT)
RETURNS JSONB LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT jsonb_build_object('status', 'invalid', 'code', 'currency_mismatch', 'baseCurrency', p_base,
    'reason', 'currency must be the group base currency ' || p_base || '; re-convert and push again');
$$;

-- =============================================================================
-- 2. Sync RPCs: apply_mutation and pull_changes (0004 bodies plus the changes above)
-- =============================================================================


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
  co wise_spliter.expense_comments; cr wise_spliter.expense_comments;
  v_base TEXT;
  v_base_hlc TEXT COLLATE "C" := m ->> 'baseHlc';
  v_rotate BOOLEAN := COALESCE((d ->> 'rotate_invite_code')::boolean, false);
  v_rev TEXT;
  v_upi RECORD;
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
    IF am.role <> 'admin' AND (v_del OR v_restore OR v_rotate
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
        invite_code = CASE WHEN v_rotate THEN 'WS-' || upper(encode(extensions.gen_random_bytes(5), 'hex')) ELSE invite_code END,
        updated_at = now(), hlc = v_hlc
      WHERE id = v_id AND (v_restore OR v_rotate OR (name, description, category, base_currency, simplify_debts,
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
    END IF;
    IF mo.role = 'admin' AND mo.removed_at IS NULL AND (v_del OR mr.removed_at IS NOT NULL OR mr.role IS DISTINCT FROM 'admin')
       AND NOT EXISTS (SELECT 1 FROM wise_spliter.group_members WHERE group_id = mo.group_id AND id <> mo.id
         AND removed_at IS NULL AND role = 'admin' AND user_id IS NOT NULL)
       AND EXISTS (SELECT 1 FROM wise_spliter.group_members WHERE group_id = mo.group_id AND id <> mo.id
         AND removed_at IS NULL AND user_id IS NOT NULL) THEN
      RAISE EXCEPTION 'promote another admin before the last admin leaves' USING ERRCODE = '42501';
    END IF;
    IF v_del OR mr.removed_at IS NOT NULL THEN
      NULL;
    ELSIF am.role <> 'admin' AND (
         (mo.user_id IS NOT NULL AND am.id <> mo.id)
      OR mr.role IS DISTINCT FROM mo.role
      OR mo.removed_at IS NOT NULL
      OR mr.invited_email IS DISTINCT FROM mo.invited_email) THEN
      RAISE EXCEPTION 'admin only' USING ERRCODE = '42501';
    END IF;
    IF v_hlc <= mo.hlc THEN RETURN jsonb_build_object('status', 'stale', 'serverHlc', mo.hlc); END IF;
    -- A payee VPA decides where money goes: a claimed member's is theirs alone; anyone may fix a
    -- placeholder's, and the group sees who did.
    IF NOT v_del AND mr.removed_at IS NULL AND NULLIF(btrim(mr.upi_id), '') IS DISTINCT FROM NULLIF(btrim(mo.upi_id), '') THEN
      IF mo.user_id IS NOT NULL AND mo.user_id <> p_actor THEN
        RAISE EXCEPTION 'only that member can change their UPI ID' USING ERRCODE = '42501';
      END IF;
      IF mo.user_id IS NULL THEN
        PERFORM wise_spliter.log_upi_change('ua_' || md5(v_id || ':' || v_hlc), mo.group_id, p_actor, am.id, p_name,
          'member', mo.id, mo.display_name, mo.upi_id, mr.upi_id, v_hlc);
      END IF;
    END IF;
    IF v_del OR mr.removed_at IS NOT NULL THEN
      UPDATE wise_spliter.group_members SET removed_at = COALESCE(removed_at, now()),
        removed_by = CASE WHEN removed_at IS NULL THEN p_actor ELSE removed_by END, hlc = v_hlc
      WHERE id = v_id RETURNING server_seq INTO v_seq;
    ELSE
      UPDATE wise_spliter.group_members SET display_name = mr.display_name,
        avatar_initials = COALESCE(mr.avatar_initials, avatar_initials), upi_id = mr.upi_id,
        member_order = COALESCE(mr.member_order, member_order),
        role = COALESCE(mr.role, role), removed_at = NULL, removed_by = NULL,
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
        SELECT base_currency INTO v_base FROM wise_spliter.groups WHERE id = er.group_id;
        IF er.group_currency IS DISTINCT FROM v_base THEN
          RETURN wise_spliter.currency_mismatch(v_base);
        END IF;
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
        er.split_mode, COALESCE(er.rotation_seed, 0), er.payers, er.splits, '[]',
        COALESCE(er.receipts, '[]'), er.current_revision_id, COALESCE(er.revision_number, 1),
        false, NULL,
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
    -- baseHlc (the version this edit started from): a stored hlc other than it means someone else
    -- changed the bill meanwhile, so the edit is a conflict whatever its hlc or arrival order.
    IF v_hlc = eo.hlc OR (v_hlc < eo.hlc AND (v_del OR v_base_hlc IS NULL OR v_base_hlc = eo.hlc)) THEN
      RETURN jsonb_build_object('status', 'stale', 'serverHlc', eo.hlc);
    END IF;
    IF NOT v_del AND eo.group_id IS NOT NULL THEN
      SELECT base_currency INTO v_base FROM wise_spliter.groups WHERE id = eo.group_id;
      IF er.group_currency IS DISTINCT FROM v_base THEN RETURN wise_spliter.currency_mismatch(v_base); END IF;
    END IF;
    IF NOT v_del AND v_base_hlc IS DISTINCT FROM eo.hlc AND v_base_hlc IS NOT NULL THEN
      -- Keep the incoming version as a conflict revision and flag the bill under a fresh server hlc,
      -- so every device pulls the marker and any edit still based on the old hlc is a conflict too.
      -- Nothing of the incoming edit overwrites the stored bill. An identical retry changes nothing.
      v_rev := 'cf_' || md5(v_id || ':' || v_hlc);
      IF EXISTS (SELECT 1 FROM wise_spliter.expense_revisions WHERE id = v_rev AND expense_id = eo.id) THEN
        RETURN jsonb_build_object('status', 'conflict', 'serverHlc', eo.hlc, 'conflictRevisionId', v_rev,
          'serverSeq', eo.server_seq::text, 'server', to_jsonb(eo) - 'owner_id');
      END IF;
      INSERT INTO wise_spliter.expense_revisions (id, expense_id, group_id, revision_number, base_revision_id,
        actor_member_id, actor_display_name, action, changes_json, snapshot, is_conflict_branch, created_at, hlc)
      VALUES (v_rev, eo.id, eo.group_id, COALESCE(er.revision_number, eo.revision_number), NULL,
        COALESCE(am.id, (SELECT ep.participant_id FROM wise_spliter.expense_participants ep
          WHERE ep.expense_id = eo.id AND ep.profile_id = p_actor ORDER BY ep.participant_id LIMIT 1)),
        p_name, 'conflict_superseded', '[]', wise_spliter.expense_snapshot(er), true, now(), v_hlc)
      ON CONFLICT DO NOTHING;
      IF NOT EXISTS (SELECT 1 FROM wise_spliter.expense_revisions WHERE id = v_rev AND expense_id = eo.id) THEN
        RAISE EXCEPTION 'conflict revision id taken' USING ERRCODE = '42501';
      END IF;
      UPDATE wise_spliter.expenses SET has_unresolved_conflict = true, conflict_revision_id = v_rev,
        hlc = wise_spliter.next_hlc(CASE WHEN v_hlc > eo.hlc THEN v_hlc ELSE eo.hlc END)
      WHERE id = v_id RETURNING * INTO eo;
      RETURN jsonb_build_object('status', 'conflict', 'serverHlc', eo.hlc, 'conflictRevisionId', v_rev,
        'serverSeq', eo.server_seq::text, 'server', to_jsonb(eo) - 'owner_id');
    END IF;
    IF v_del THEN
      UPDATE wise_spliter.expenses SET deleted_at = COALESCE(deleted_at, now()), updated_at = now(), hlc = v_hlc
      WHERE id = v_id RETURNING server_seq INTO v_seq;
    ELSE
      -- Direct-bill payee VPAs: only the bill owner or that participant (once bound) changes one; logged.
      FOR v_upi IN
        SELECT o.value ->> 'id' AS pid, n.value ->> 'displayName' AS who, o.value ->> 'upiId' AS old_upi, n.value ->> 'upiId' AS new_upi
        FROM jsonb_array_elements(eo.ad_hoc_participants) o
        JOIN jsonb_array_elements(COALESCE(er.ad_hoc_participants, '[]')) n ON n.value ->> 'id' = o.value ->> 'id'
        WHERE eo.group_id IS NULL
          AND NULLIF(btrim(o.value ->> 'upiId'), '') IS DISTINCT FROM NULLIF(btrim(n.value ->> 'upiId'), '')
      LOOP
        IF eo.owner_id IS DISTINCT FROM p_actor AND NOT EXISTS (SELECT 1 FROM wise_spliter.expense_participants
            WHERE expense_id = eo.id AND participant_id = v_upi.pid AND profile_id = p_actor) THEN
          RAISE EXCEPTION 'only the bill owner or that participant can change their UPI ID' USING ERRCODE = '42501';
        END IF;
        PERFORM wise_spliter.log_upi_change('ua_' || md5(v_id || ':' || v_upi.pid || ':' || v_hlc), NULL, p_actor,
          (SELECT ep.participant_id FROM wise_spliter.expense_participants ep
            WHERE ep.expense_id = eo.id AND ep.profile_id = p_actor ORDER BY ep.participant_id LIMIT 1),
          p_name, 'expense', eo.id, v_upi.who, v_upi.old_upi, v_upi.new_upi, v_hlc);
      END LOOP;
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
        receipts = COALESCE(er.receipts, '[]'),
        current_revision_id = er.current_revision_id, revision_number = COALESCE(er.revision_number, revision_number),
        has_unresolved_conflict = has_unresolved_conflict AND NOT (er.has_unresolved_conflict IS FALSE
          AND er.conflict_revision_id IS NOT DISTINCT FROM conflict_revision_id),
        conflict_revision_id = CASE WHEN has_unresolved_conflict AND NOT (er.has_unresolved_conflict IS FALSE
          AND er.conflict_revision_id IS NOT DISTINCT FROM conflict_revision_id) THEN conflict_revision_id END,
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
        WHERE ep.expense_id = eo.id AND ep.profile_id = p_actor ORDER BY ep.participant_id LIMIT 1)),
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
      SELECT base_currency INTO v_base FROM wise_spliter.groups WHERE id = sr.group_id;
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
      IF sr.group_id IS NOT NULL AND sr.currency IS DISTINCT FROM v_base THEN RETURN wise_spliter.currency_mismatch(v_base); END IF;
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
    IF NOT v_del AND sr.group_id IS NOT NULL AND sr.currency IS DISTINCT FROM v_base THEN
      RETURN wise_spliter.currency_mismatch(v_base);
    END IF;
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

  -- ------------------------------------------------------- expense comment
  -- One row per comment. The author is the verified actor; access is access to the bill; only the
  -- author edits or deletes (a delete blanks the body). Legacy rows have no author and stay read-only.
  WHEN 'expense_comment' THEN
    cr := jsonb_populate_record(NULL::wise_spliter.expense_comments, d);
    SELECT * INTO co FROM wise_spliter.expense_comments WHERE id = v_id FOR UPDATE;
    IF FOUND THEN
      IF NOT v_del AND cr.expense_id IS DISTINCT FROM co.expense_id THEN
        RAISE EXCEPTION 'comment belongs to another expense' USING ERRCODE = '42501';
      END IF;
      IF co.author_id IS DISTINCT FROM p_actor THEN RAISE EXCEPTION 'only the author can change a comment' USING ERRCODE = '42501'; END IF;
      cr.expense_id := co.expense_id;
    ELSIF v_del THEN
      RAISE EXCEPTION 'nothing to delete' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO eo FROM wise_spliter.expenses WHERE id = cr.expense_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'unknown expense' USING ERRCODE = '42501'; END IF;
    IF eo.group_id IS NOT NULL THEN
      am := wise_spliter.actor_member(eo.group_id, p_actor);
      IF am.id IS NULL THEN RAISE EXCEPTION 'not a member' USING ERRCODE = '42501'; END IF;
    ELSIF NOT wise_spliter.can_access_direct_expense(eo.id, eo.owner_id, p_actor) THEN
      RAISE EXCEPTION 'not a participant' USING ERRCODE = '42501';
    END IF;
    IF NOT v_del AND eo.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'the bill is deleted' USING ERRCODE = '22023'; END IF;
    IF co.id IS NULL THEN
      INSERT INTO wise_spliter.expense_comments (id, expense_id, group_id, author_id, author_member_id, author_name,
        body, created_at, hlc)
      VALUES (v_id, eo.id, eo.group_id, p_actor, COALESCE(am.id, (SELECT ep.participant_id FROM wise_spliter.expense_participants ep
          WHERE ep.expense_id = eo.id AND ep.profile_id = p_actor ORDER BY ep.participant_id LIMIT 1)),
        p_name, cr.body, now(), v_hlc)
      ON CONFLICT DO NOTHING RETURNING server_seq INTO v_seq;
      IF v_seq IS NULL THEN RAISE EXCEPTION 'comment id taken' USING ERRCODE = '42501'; END IF;
      RETURN jsonb_build_object('status', 'applied', 'serverSeq', v_seq::text);
    END IF;
    IF v_hlc <= co.hlc THEN RETURN jsonb_build_object('status', 'stale', 'serverHlc', co.hlc); END IF;
    UPDATE wise_spliter.expense_comments SET
      body = CASE WHEN v_del THEN '' ELSE cr.body END,
      edited_at = CASE WHEN v_del THEN edited_at ELSE now() END,
      deleted_at = CASE WHEN v_del THEN COALESCE(deleted_at, now()) ELSE NULL END, hlc = v_hlc
    WHERE id = v_id RETURNING server_seq INTO v_seq;

  ELSE
    RAISE EXCEPTION 'unknown entity' USING ERRCODE = '22023';
  END CASE;

  RETURN jsonb_build_object('status', 'applied', 'serverSeq', v_seq::text);
END $$;

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
    (SELECT 'settlement', st.id, st.server_seq, st.deleted_at IS NOT NULL,
        to_jsonb(st) - 'owner_id' || jsonb_build_object('can_edit', st.group_id IS NOT NULL OR st.owner_id = p_actor)
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
    UNION ALL
    (SELECT 'expense_comment', c.id, c.server_seq, c.deleted_at IS NOT NULL,
        to_jsonb(c) - 'author_id' || jsonb_build_object('is_mine', c.author_id IS NOT DISTINCT FROM p_actor)
      FROM wise_spliter.expense_comments c
      WHERE (c.group_id IN (SELECT group_id FROM mg) OR (c.group_id IS NULL AND c.expense_id IN (SELECT id FROM dx)))
        AND c.server_seq > p_cursor
      ORDER BY c.server_seq LIMIT v_limit + 1)
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

-- =============================================================================
-- 3. Join by invite code
-- =============================================================================

-- Binds the caller's unclaimed placeholder carrying their verified email, else revives their own
-- earlier member row (same id, so old balances line up), else adds a member. Failed codes count
-- per account per UTC day in quota_usage (kind 'join_fail'), so the cap holds across API replicas.
CREATE OR REPLACE FUNCTION wise_spliter.join_group(p_actor TEXT, p_code TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_email TEXT; v_name TEXT; v_initials TEXT; v_status TEXT;
  v_day TEXT := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD');
  v_hlc TEXT := lpad(to_hex((extract(epoch FROM clock_timestamp()) * 1000)::bigint), 12, '0') || '-0000-server';
  g wise_spliter.groups; m wise_spliter.group_members;
BEGIN
  PERFORM wise_spliter.assert_backend();
  SELECT email, full_name, avatar_initials INTO v_email, v_name, v_initials FROM wise_spliter.profiles WHERE id = p_actor;
  IF NOT FOUND THEN RAISE EXCEPTION 'unknown actor' USING ERRCODE = '42501'; END IF;
  IF COALESCE((SELECT n FROM wise_spliter.quota_usage
      WHERE kind = 'join_fail' AND owner_id = p_actor AND scope_id = v_day), 0) >= 20 THEN
    RETURN jsonb_build_object('error', 'locked');
  END IF;
  SELECT * INTO g FROM wise_spliter.groups
  WHERE invite_code = upper(btrim(p_code)) AND upper(btrim(p_code)) ~ '^WS-[0-9A-F]{10}$' AND deleted_at IS NULL;
  IF NOT FOUND THEN
    DELETE FROM wise_spliter.quota_usage WHERE kind = 'join_fail' AND owner_id = p_actor AND scope_id <> v_day;
    INSERT INTO wise_spliter.quota_usage (kind, owner_id, scope_id, n) VALUES ('join_fail', p_actor, v_day, 1)
    ON CONFLICT (kind, owner_id, scope_id) DO UPDATE SET n = wise_spliter.quota_usage.n + 1;
    RETURN jsonb_build_object('error', 'not_found');
  END IF;
  PERFORM pg_advisory_xact_lock(7735001);
  PERFORM set_config('wise_spliter.actor', p_actor, true);
  -- Re-read under the lock: the group may have been deleted or its code rotated meanwhile.
  SELECT * INTO g FROM wise_spliter.groups WHERE id = g.id AND invite_code = upper(btrim(p_code)) AND deleted_at IS NULL;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'not_found'); END IF;
  m := wise_spliter.actor_member(g.id, p_actor);
  v_status := 'already_member';
  -- Someone else (an admin) removed this user: only an admin may add them back.
  IF m.id IS NULL AND EXISTS (SELECT 1 FROM wise_spliter.group_members WHERE group_id = g.id AND user_id = p_actor
      AND removed_at IS NOT NULL AND removed_by IS DISTINCT FROM p_actor) THEN
    RETURN jsonb_build_object('error', 'removed_by_admin');
  END IF;
  IF m.id IS NULL THEN
    -- Claiming an active placeholder does not change the active count; reviving does, so it checks the cap.
    v_status := 'claimed';
    UPDATE wise_spliter.group_members SET user_id = p_actor, claimed_at = now()
    WHERE id = (SELECT id FROM wise_spliter.group_members WHERE group_id = g.id AND invited_email = v_email
                  AND user_id IS NULL AND removed_at IS NULL ORDER BY member_order, id LIMIT 1)
    RETURNING * INTO m;
  END IF;
  IF m.id IS NULL AND (SELECT count(*) FROM (SELECT 1 FROM wise_spliter.group_members
      WHERE group_id = g.id AND removed_at IS NULL LIMIT 100) a) >= 100 THEN
    RETURN jsonb_build_object('error', 'group_full');
  END IF;
  IF m.id IS NULL THEN
    v_status := 'rejoined';
    -- A removed admin comes back as a plain member while the group still has an active admin.
    UPDATE wise_spliter.group_members SET removed_at = NULL, removed_by = NULL, hlc = CASE WHEN v_hlc > hlc THEN v_hlc ELSE hlc END,
      role = CASE WHEN EXISTS (SELECT 1 FROM wise_spliter.group_members x WHERE x.group_id = g.id
        AND x.removed_at IS NULL AND x.role = 'admin') THEN 'member' ELSE role END
    WHERE id = (SELECT id FROM wise_spliter.group_members WHERE group_id = g.id AND user_id = p_actor
                  AND removed_by = p_actor ORDER BY joined_at DESC, id LIMIT 1)
    RETURNING * INTO m;
  END IF;
  IF m.id IS NULL THEN
    v_status := 'joined';
    BEGIN
      INSERT INTO wise_spliter.group_members (id, group_id, user_id, invited_email, display_name, avatar_initials,
        upi_id, role, member_order, joined_at, claimed_at, hlc)
      VALUES ('gm_' || encode(extensions.gen_random_bytes(10), 'hex'), g.id, p_actor, v_email, v_name,
        COALESCE(NULLIF(v_initials, ''), 'GM'), NULL, 'member',
        least(1000, COALESCE((SELECT max(member_order) FROM wise_spliter.group_members WHERE group_id = g.id), -1) + 1),
        now(), now(), v_hlc)
      RETURNING * INTO m;
    EXCEPTION WHEN check_violation THEN
      RETURN jsonb_build_object('error', 'group_full');
    END;
  END IF;
  RETURN jsonb_build_object('groupId', g.id, 'memberId', m.id, 'status', v_status);
END $$;

-- =============================================================================
-- 4. Legacy comments: expense JSON -> read-only rows (no author), then the JSON is emptied.
--    Rows keep the original comment id, so devices still holding the nested copy dedupe by id; only a
--    repeated or malformed id (its first valid occurrence keeps it) gets a deterministic lc_ id.
-- =============================================================================

INSERT INTO wise_spliter.expense_comments (id, expense_id, group_id, author_id, author_member_id, author_name,
  body, created_at, hlc, legacy)
SELECT CASE WHEN row_number() OVER (PARTITION BY x ->> 'id' ORDER BY e.created_at, e.id, o) = 1
         AND x ->> 'id' ~ '^[A-Za-z0-9_-]{1,120}$'
         AND NOT EXISTS (SELECT 1 FROM wise_spliter.expense_comments c WHERE c.id = x ->> 'id')
       THEN x ->> 'id' ELSE 'lc_' || md5(e.id || ':' || o) END,
  e.id, e.group_id, NULL,
  CASE WHEN x ->> 'authorMemberId' ~ '^[A-Za-z0-9_-]{1,80}$' THEN x ->> 'authorMemberId' END,
  left(COALESCE(x ->> 'authorName', ''), 100), left(x ->> 'body', 1000),
  COALESCE(CASE WHEN pg_input_is_valid(x ->> 'createdAt', 'timestamptz') THEN (x ->> 'createdAt')::timestamptz END, e.created_at),
  e.hlc, true
FROM wise_spliter.expenses e, jsonb_array_elements(e.comments) WITH ORDINALITY AS t(x, o)
WHERE e.comments <> '[]' AND jsonb_typeof(x) = 'object' AND char_length(btrim(left(COALESCE(x ->> 'body', ''), 1000))) >= 1
ON CONFLICT (id) DO NOTHING;
UPDATE wise_spliter.expenses SET comments = '[]' WHERE comments <> '[]';
UPDATE wise_spliter.expense_comments SET legacy = true
WHERE author_id IS NULL AND author_name <> 'Deleted user' AND NOT legacy;

-- =============================================================================
-- 5. Grants: service_role only (deny-all RLS, no policies)
-- =============================================================================

REVOKE ALL ON ALL TABLES IN SCHEMA wise_spliter FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA wise_spliter FROM PUBLIC, anon, authenticated;
GRANT ALL ON wise_spliter.expense_comments TO service_role, postgres;
GRANT EXECUTE ON FUNCTION wise_spliter.join_group(TEXT, TEXT) TO service_role;

INSERT INTO wise_spliter.schema_migrations (version, checksum) VALUES ('0005_phase1_server_support', 'pasted')
ON CONFLICT (version) DO NOTHING;

NOTIFY pgrst, 'reload schema';
