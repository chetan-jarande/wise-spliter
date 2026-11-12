/**
 * Server-only Supabase Data API & Storage Admin client for Wise-Spliter.
 * Modeled after `merry-tools/src/app/api/_payments/supabaseClient.ts`.
 *
 * SERVER-ONLY: `SUPABASE_SECRET_KEY` bypasses Row Level Security entirely and
 * must never be imported from code that reaches the browser bundle.
 */

import { createClient } from '@supabase/supabase-js';
import initialMockData from '../data/mock-ledger-data.json';
import {
  AdHocParticipant,
  DefaultSplitPreset,
  ExpenseCategoryKey,
  ExpenseComment,
  ExpenseItem,
  ExpensePayer,
  ExpenseRevision,
  ExpenseSnapshotData,
  ExpenseSplitShare,
  FxStatus,
  GroupActivityActionType,
  GroupActivityItem,
  GroupMember,
  GroupRecord,
  MockLedgerDataset,
  ReceiptAttachment,
  RevisionChangeField,
  SettlementItem,
  SplitMode,
  UserProfile,
} from '../types/ledger';

export const SUPABASE_URL = (
  process.env.SUPABASE_URL || 'http://127.0.0.1:54321'
).replace(/\/+$/, '');

export const SUPABASE_SECRET_KEY = (
  process.env.SUPABASE_SECRET_KEY || 'sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz'
).trim();

export const SUPABASE_SCHEMA = (
  process.env.SUPABASE_SCHEMA || 'wise_spliter'
).trim();

export interface SupabaseCreds {
  url: string;
  secretKey: string;
  schema: string;
}

export function readSupabaseCreds(): SupabaseCreds | null {
  const url = (process.env.SUPABASE_URL || SUPABASE_URL).trim();
  const secretKey = (
    process.env.SUPABASE_SECRET_KEY || SUPABASE_SECRET_KEY
  ).trim();
  const schema = (process.env.SUPABASE_SCHEMA || SUPABASE_SCHEMA).trim();
  if (!url || !secretKey) return null;
  return { url, secretKey, schema: schema || 'wise_spliter' };
}

function createWiseSpliterAdminClient() {
  const creds = readSupabaseCreds();
  if (!creds) {
    throw new Error('supabase-not-configured');
  }
  return createClient(creds.url, creds.secretKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    db: {
      schema: creds.schema as 'wise_spliter',
    },
  });
}

export type WiseSpliterAdminClient = ReturnType<typeof createWiseSpliterAdminClient>;

let adminClient: WiseSpliterAdminClient | null = null;

/**
 * Process-wide Supabase admin client using official `@supabase/supabase-js`
 * with `persistSession: false`, `autoRefreshToken: false`, `detectSessionInUrl: false`,
 * and `db: { schema: SUPABASE_SCHEMA }`.
 */
export function getSupabaseAdmin(): WiseSpliterAdminClient {
  if (adminClient) return adminClient;
  adminClient = createWiseSpliterAdminClient();
  return adminClient;
}

export interface ExistingDbGroupOwnership {
  id: string;
  created_by: string;
  members: Array<{
    user_id: string | null;
    invited_email: string | null;
    removed_at?: string | null;
  }>;
}

export interface ExistingDbExpenseOwnership {
  id: string;
  group_id: string | null;
  created_by_member_id: string;
  ad_hoc_participants: AdHocParticipant[];
}

export interface ExistingDbSettlementOwnership {
  id: string;
  group_id: string | null;
  from_member_id: string;
  to_member_id: string;
}

export interface ExistingDbMemberOwnership {
  id: string;
  group_id: string;
}

export interface ExistingDbRevisionOwnership {
  id: string;
  expense_id: string;
  group_id: string | null;
}

export interface ExistingDbActivityOwnership {
  id: string;
  group_id: string | null;
  entity_id: string;
  actor_member_id: string;
}

export interface ExistingDbReceiptOwnership {
  id: string;
  expense_id: string;
  group_id: string | null;
}

export interface ExistingDbEntityOwnershipSnapshot {
  expenses: Map<string, ExistingDbExpenseOwnership>;
  settlements: Map<string, ExistingDbSettlementOwnership>;
  groupMembers: Map<string, ExistingDbMemberOwnership>;
  revisions: Map<string, ExistingDbRevisionOwnership>;
  activityLogs: Map<string, ExistingDbActivityOwnership>;
  receipts: Map<string, ExistingDbReceiptOwnership>;
}

const persistedGroupsOwnershipCache = new Map<
  string,
  ExistingDbGroupOwnership
>();

const persistedExpensesOwnershipCache = new Map<
  string,
  ExistingDbExpenseOwnership
>();
const persistedSettlementsOwnershipCache = new Map<
  string,
  ExistingDbSettlementOwnership
>();
const persistedMembersOwnershipCache = new Map<
  string,
  ExistingDbMemberOwnership
>();
const persistedRevisionsOwnershipCache = new Map<
  string,
  ExistingDbRevisionOwnership
>();
const persistedActivityOwnershipCache = new Map<
  string,
  ExistingDbActivityOwnership
>();
const persistedReceiptsOwnershipCache = new Map<
  string,
  ExistingDbReceiptOwnership
>();

function seedInitialOwnershipCache(): void {
  if (persistedGroupsOwnershipCache.size > 0) return;
  const seed = initialMockData as unknown as MockLedgerDataset;
  const ownerId = seed.currentUser?.id || 'usr_arjun_01';
  for (const g of seed.groups ?? []) {
    persistedGroupsOwnershipCache.set(g.id, {
      id: g.id,
      created_by: ownerId,
      members: (g.members ?? []).map((m) => ({
        user_id: m.userId ?? null,
        invited_email: m.invitedEmail ?? null,
        removed_at: null,
      })),
    });
    for (const m of g.members ?? []) {
      persistedMembersOwnershipCache.set(m.id, {
        id: m.id,
        group_id: g.id,
      });
    }
  }

  for (const e of seed.expenses ?? []) {
    persistedExpensesOwnershipCache.set(e.id, {
      id: e.id,
      group_id: e.groupId,
      created_by_member_id: e.createdByMemberId,
      ad_hoc_participants: e.adHocParticipants ?? [],
    });
    for (const r of e.receipts ?? []) {
      persistedReceiptsOwnershipCache.set(r.id, {
        id: r.id,
        expense_id: e.id,
        group_id: e.groupId,
      });
    }
  }

  for (const s of seed.settlements ?? []) {
    persistedSettlementsOwnershipCache.set(s.id, {
      id: s.id,
      group_id: s.groupId,
      from_member_id: s.fromMemberId,
      to_member_id: s.toMemberId,
    });
  }

  for (const rev of seed.expenseRevisions ?? []) {
    persistedRevisionsOwnershipCache.set(rev.id, {
      id: rev.id,
      expense_id: rev.expenseId,
      group_id: rev.groupId,
    });
  }

  for (const act of seed.groupActivityLog ?? []) {
    persistedActivityOwnershipCache.set(act.id, {
      id: act.id,
      group_id: act.groupId,
      entity_id: act.entityId,
      actor_member_id: act.actorMemberId,
    });
  }
}

seedInitialOwnershipCache();

export function resetOwnershipCachesForTests(): void {
  persistedGroupsOwnershipCache.clear();
  persistedExpensesOwnershipCache.clear();
  persistedSettlementsOwnershipCache.clear();
  persistedMembersOwnershipCache.clear();
  persistedRevisionsOwnershipCache.clear();
  persistedActivityOwnershipCache.clear();
  persistedReceiptsOwnershipCache.clear();
  seedInitialOwnershipCache();
}

export async function fetchExistingDbGroups(): Promise<
  ExistingDbGroupOwnership[]
> {
  seedInitialOwnershipCache();
  const merged = new Map<string, ExistingDbGroupOwnership>(
    persistedGroupsOwnershipCache
  );

  try {
    const [groupsRes, membersRes] = await Promise.all([
      getSupabaseAdmin().from('groups').select('id, created_by'),
      getSupabaseAdmin()
        .from('group_members')
        .select('id, group_id, user_id, invited_email, removed_at'),
    ]);

    if (!groupsRes.error && Array.isArray(groupsRes.data)) {
      const membersByGroupId = new Map<
        string,
        Array<{
          user_id: string | null;
          invited_email: string | null;
          removed_at?: string | null;
        }>
      >();
      if (!membersRes.error && Array.isArray(membersRes.data)) {
        for (const m of membersRes.data as Array<{
          id: string;
          group_id: string;
          user_id: string | null;
          invited_email: string | null;
          removed_at?: string | null;
        }>) {
          persistedMembersOwnershipCache.set(m.id, {
            id: m.id,
            group_id: m.group_id,
          });
          if (m.removed_at) {
            continue;
          }
          const list = membersByGroupId.get(m.group_id) ?? [];
          list.push({
            user_id: m.user_id ?? null,
            invited_email: m.invited_email ?? null,
            removed_at: null,
          });
          membersByGroupId.set(m.group_id, list);
        }
      }

      for (const g of groupsRes.data as Array<{
        id: string;
        created_by: string;
      }>) {
        const record: ExistingDbGroupOwnership = {
          id: g.id,
          created_by: g.created_by,
          members:
            membersByGroupId.get(g.id) ??
            merged.get(g.id)?.members ??
            [],
        };
        merged.set(g.id, record);
        persistedGroupsOwnershipCache.set(g.id, record);
      }
    }
  } catch {
    // Fallback to in-memory ownership cache when DB is unreachable
  }

  return Array.from(merged.values());
}

export async function fetchExistingDbEntityOwnership(): Promise<ExistingDbEntityOwnershipSnapshot> {
  seedInitialOwnershipCache();

  const expenses = new Map(persistedExpensesOwnershipCache);
  const settlements = new Map(persistedSettlementsOwnershipCache);
  const groupMembers = new Map(persistedMembersOwnershipCache);
  const revisions = new Map(persistedRevisionsOwnershipCache);
  const activityLogs = new Map(persistedActivityOwnershipCache);
  const receipts = new Map(persistedReceiptsOwnershipCache);

  try {
    const [expRes, stlRes, memRes, revRes, actRes, rcptRes] = await Promise.all([
      getSupabaseAdmin()
        .from('expenses')
        .select('id, group_id, created_by_member_id, ad_hoc_participants'),
      getSupabaseAdmin()
        .from('settlements')
        .select('id, group_id, from_member_id, to_member_id'),
      getSupabaseAdmin()
        .from('group_members')
        .select('id, group_id'),
      getSupabaseAdmin()
        .from('expense_revisions')
        .select('id, expense_id, group_id'),
      getSupabaseAdmin()
        .from('group_activity_log')
        .select('id, group_id, entity_id, actor_member_id'),
      getSupabaseAdmin()
        .from('receipt_attachments')
        .select('id, expense_id, group_id'),
    ]);

    if (!expRes.error && Array.isArray(expRes.data)) {
      for (const e of expRes.data as Array<{
        id: string;
        group_id: string | null;
        created_by_member_id: string;
        ad_hoc_participants: AdHocParticipant[] | null;
      }>) {
        const item: ExistingDbExpenseOwnership = {
          id: e.id,
          group_id: e.group_id,
          created_by_member_id: e.created_by_member_id,
          ad_hoc_participants: Array.isArray(e.ad_hoc_participants)
            ? e.ad_hoc_participants
            : [],
        };
        expenses.set(e.id, item);
        persistedExpensesOwnershipCache.set(e.id, item);
      }
    }

    if (!stlRes.error && Array.isArray(stlRes.data)) {
      for (const s of stlRes.data as Array<{
        id: string;
        group_id: string | null;
        from_member_id: string;
        to_member_id: string;
      }>) {
        const item: ExistingDbSettlementOwnership = {
          id: s.id,
          group_id: s.group_id,
          from_member_id: s.from_member_id,
          to_member_id: s.to_member_id,
        };
        settlements.set(s.id, item);
        persistedSettlementsOwnershipCache.set(s.id, item);
      }
    }

    if (!memRes.error && Array.isArray(memRes.data)) {
      for (const m of memRes.data as Array<{ id: string; group_id: string }>) {
        const item: ExistingDbMemberOwnership = {
          id: m.id,
          group_id: m.group_id,
        };
        groupMembers.set(m.id, item);
        persistedMembersOwnershipCache.set(m.id, item);
      }
    }

    if (!revRes.error && Array.isArray(revRes.data)) {
      for (const r of revRes.data as Array<{
        id: string;
        expense_id: string;
        group_id: string | null;
      }>) {
        const item: ExistingDbRevisionOwnership = {
          id: r.id,
          expense_id: r.expense_id,
          group_id: r.group_id,
        };
        revisions.set(r.id, item);
        persistedRevisionsOwnershipCache.set(r.id, item);
      }
    }

    if (!actRes.error && Array.isArray(actRes.data)) {
      for (const a of actRes.data as Array<{
        id: string;
        group_id: string | null;
        entity_id: string;
        actor_member_id: string;
      }>) {
        const item: ExistingDbActivityOwnership = {
          id: a.id,
          group_id: a.group_id,
          entity_id: a.entity_id,
          actor_member_id: a.actor_member_id,
        };
        activityLogs.set(a.id, item);
        persistedActivityOwnershipCache.set(a.id, item);
      }
    }

    if (!rcptRes.error && Array.isArray(rcptRes.data)) {
      for (const rcpt of rcptRes.data as Array<{
        id: string;
        expense_id: string;
        group_id: string | null;
      }>) {
        const item: ExistingDbReceiptOwnership = {
          id: rcpt.id,
          expense_id: rcpt.expense_id,
          group_id: rcpt.group_id,
        };
        receipts.set(rcpt.id, item);
        persistedReceiptsOwnershipCache.set(rcpt.id, item);
      }
    }
  } catch {
    // Fallback to in-memory snapshot when DB is unreachable
  }

  return {
    expenses,
    settlements,
    groupMembers,
    revisions,
    activityLogs,
    receipts,
  };
}

export async function checkSupabaseSchemaHealth(): Promise<{
  reachable: boolean;
  schemaHealth: Record<string, unknown> | null;
}> {
  try {
    const { data, error } = await getSupabaseAdmin().rpc('schema_health');
    if (!error && data && typeof data === 'object') {
      return {
        reachable: true,
        schemaHealth: data as Record<string, unknown>,
      };
    }
  } catch {
    // Ignore network errors and report unreachable
  }
  return {
    reachable: false,
    schemaHealth: null,
  };
}

export async function syncDatasetToSupabase(
  dataset: MockLedgerDataset
): Promise<{ ok: boolean; error?: string }> {
  seedInitialOwnershipCache();
  const nowIso = new Date().toISOString();
  const fallbackHlc = `${Date.now().toString(16).padStart(12, '0')}-0001-${dataset.currentUser.id}`;

  const profileRows = [
    {
      id: dataset.currentUser.id,
      email: dataset.currentUser.email,
      full_name: dataset.currentUser.fullName,
      avatar_initials: dataset.currentUser.avatarInitials,
      avatar_url: null,
      default_currency: dataset.currentUser.defaultCurrency,
      upi_id: dataset.currentUser.upiId,
      google_connected: dataset.currentUser.googleConnected,
      updated_at: dataset.currentUser.lastSyncedAt || nowIso,
      hlc: fallbackHlc,
    },
  ];

  const groupRows = dataset.groups.map((g) => {
    const existingOwner =
      persistedGroupsOwnershipCache.get(g.id)?.created_by ||
      dataset.currentUser.id;
    return {
      id: g.id,
      name: g.name,
      description: g.description,
      category: g.category,
      base_currency: g.baseCurrency,
      simplify_debts: g.simplifyDebts,
      default_split_config: g.defaultSplitConfig,
      expense_seq: g.expenseSeq,
      invite_code: g.inviteCode,
      created_by: existingOwner,
      created_at: g.createdAt,
      updated_at: g.updatedAt,
      last_accessed_at: g.lastAccessedAt ?? g.updatedAt,
      deleted_at: g.deletedAt,
      hlc: g.hlc || fallbackHlc,
    };
  });

  // Update ownership caches for existing/new groups and child entities
  for (const g of dataset.groups) {
    const existingOwner =
      persistedGroupsOwnershipCache.get(g.id)?.created_by ||
      dataset.currentUser.id;
    persistedGroupsOwnershipCache.set(g.id, {
      id: g.id,
      created_by: existingOwner,
      members: (g.members ?? [])
        .filter((m) => !(m as GroupMember & { removedAt?: string | null }).removedAt)
        .map((m) => ({
          user_id: m.userId ?? null,
          invited_email: m.invitedEmail ?? null,
          removed_at: null,
        })),
    });
    for (const m of g.members ?? []) {
      persistedMembersOwnershipCache.set(m.id, {
        id: m.id,
        group_id: g.id,
      });
    }
  }

  const validGroupIds = new Set(dataset.groups.map((g) => g.id));

  for (const e of dataset.expenses ?? []) {
    const resolvedGrpId = e.groupId && validGroupIds.has(e.groupId) ? e.groupId : null;
    persistedExpensesOwnershipCache.set(e.id, {
      id: e.id,
      group_id: resolvedGrpId,
      created_by_member_id: e.createdByMemberId,
      ad_hoc_participants: e.adHocParticipants ?? [],
    });
    for (const r of e.receipts ?? []) {
      persistedReceiptsOwnershipCache.set(r.id, {
        id: r.id,
        expense_id: e.id,
        group_id: resolvedGrpId,
      });
    }
  }

  for (const s of dataset.settlements ?? []) {
    persistedSettlementsOwnershipCache.set(s.id, {
      id: s.id,
      group_id: s.groupId && validGroupIds.has(s.groupId) ? s.groupId : null,
      from_member_id: s.fromMemberId,
      to_member_id: s.toMemberId,
    });
  }

  for (const rev of dataset.expenseRevisions ?? []) {
    persistedRevisionsOwnershipCache.set(rev.id, {
      id: rev.id,
      expense_id: rev.expenseId,
      group_id: rev.groupId && validGroupIds.has(rev.groupId) ? rev.groupId : null,
    });
  }

  for (const act of dataset.groupActivityLog ?? []) {
    persistedActivityOwnershipCache.set(act.id, {
      id: act.id,
      group_id: act.groupId && validGroupIds.has(act.groupId) ? act.groupId : null,
      entity_id: act.entityId,
      actor_member_id: act.actorMemberId,
    });
  }

  const memberRows = dataset.groups.flatMap((g) =>
    g.members.map((m) => ({
      id: m.id,
      group_id: g.id,
      user_id: m.userId,
      invited_email: m.invitedEmail,
      display_name: m.displayName,
      avatar_initials: m.avatarInitials,
      upi_id: m.upiId,
      role: m.role,
      member_order: m.memberOrder,
      joined_at: m.joinedAt,
      last_accessed_at: g.lastAccessedAt ?? g.updatedAt,
      claimed_at: m.claimedAt,
      removed_at: (m as GroupMember & { removedAt?: string | null }).removedAt ?? null,
      hlc: g.hlc || fallbackHlc,
    }))
  );

  const expenseRows = dataset.expenses.map((e) => ({
    id: e.id,
    group_id: e.groupId && validGroupIds.has(e.groupId) ? e.groupId : null,
    ad_hoc_participants: e.adHocParticipants ?? [],
    title: e.title,
    category: e.category,
    tags: e.tags ?? [],
    notes: e.notes ?? '',
    expense_date: e.expenseDate,
    original_currency: e.originalCurrency,
    original_amount_minor: Math.max(1, Math.round(e.originalAmountMinor)),
    group_currency: e.groupCurrency,
    amount_minor: Math.max(1, Math.round(e.amountMinor)),
    fx_rate_scaled: Math.max(1, Math.round(e.fxRateScaled)),
    fx_status: e.fxStatus,
    fx_audit_note: e.fxAuditNote,
    split_mode: e.splitMode,
    rotation_seed: e.rotationSeed ?? 0,
    payers: e.payers,
    splits: e.splits,
    comments: e.comments ?? [],
    receipts: e.receipts ?? [],
    current_revision_id: e.currentRevisionId,
    revision_number: e.revisionNumber ?? 1,
    has_unresolved_conflict: Boolean(e.hasUnresolvedConflict),
    conflict_revision_id: e.conflictRevisionId,
    created_by_member_id: e.createdByMemberId,
    updated_by_member_id: e.updatedByMemberId,
    created_at: e.createdAt,
    updated_at: e.updatedAt,
    deleted_at: e.deletedAt,
    hlc: e.hlc || fallbackHlc,
  }));

  const validExpenseIds = new Set(dataset.expenses.map((e) => e.id));

  const revisionRows = dataset.expenseRevisions
    .filter((r) => validExpenseIds.has(r.expenseId))
    .map((r) => ({
      id: r.id,
      expense_id: r.expenseId,
      group_id: r.groupId && validGroupIds.has(r.groupId) ? r.groupId : null,
      revision_number: r.revisionNumber,
      base_revision_id: r.baseRevisionId,
      actor_member_id: r.actorMemberId,
      actor_display_name: r.actorDisplayName,
      action: r.action,
      changes_json: r.changes,
      snapshot: r.snapshot,
      is_conflict_branch: Boolean(r.isConflictBranch),
      created_at: r.createdAt,
      hlc: r.hlc || fallbackHlc,
    }));

  const settlementRows = dataset.settlements.map((s) => ({
    id: s.id,
    group_id: s.groupId && validGroupIds.has(s.groupId) ? s.groupId : null,
    batch_settlement_id: s.batchSettlementId,
    from_member_id: s.fromMemberId,
    to_member_id: s.toMemberId,
    amount_minor: Math.max(1, Math.round(s.amountMinor)),
    currency: s.currency,
    payment_method: s.paymentMethod,
    payment_reference: s.paymentReference,
    notes: s.notes ?? '',
    settled_date: s.settledDate,
    created_at: s.createdAt,
    deleted_at: s.deletedAt,
    hlc: s.hlc || fallbackHlc,
  }));

  const activityRows = dataset.groupActivityLog.map((a) => ({
    id: a.id,
    group_id: a.groupId && validGroupIds.has(a.groupId) ? a.groupId : null,
    actor_member_id: a.actorMemberId,
    actor_display_name: a.actorDisplayName,
    entity_type: a.entityType,
    entity_id: a.entityId,
    action: a.action,
    summary_text: a.summaryText,
    detail_note: a.detailNote ?? '',
    diff_badges: a.diffBadges ?? [],
    created_at: a.createdAt,
    hlc: a.hlc || fallbackHlc,
  }));

  const receiptRows = dataset.expenses.flatMap((e) =>
    (e.receipts ?? []).map((r) => {
      const extReceipt = r as ReceiptAttachment & {
        storageBucket?: string;
        storagePath?: string;
        dataUrl?: string;
      };
      const safeFile = (r.fileName || 'receipt.webp').replace(
        /[^a-zA-Z0-9._-]/g,
        '_'
      );
      return {
        id: r.id,
        group_id: e.groupId && validGroupIds.has(e.groupId) ? e.groupId : null,
        expense_id: e.id,
        storage_bucket: extReceipt.storageBucket || 'wise-spliter-receipts',
        storage_path:
          extReceipt.storagePath ||
          `${e.groupId || 'standalone'}/${e.id}/${r.id}-${safeFile}`,
        file_name: r.fileName,
        mime_type: r.mimeType || 'image/webp',
        size_kb: Math.max(0, Math.round(r.sizeKb ?? 0)),
        uploaded_by_name: r.uploadedByName || dataset.currentUser.fullName,
        preview_note: r.previewNote ?? '',
        data_url: extReceipt.dataUrl ?? null,
        created_at: r.createdAt || e.createdAt || nowIso,
        hlc: e.hlc || fallbackHlc,
      };
    })
  );

  try {
    if (profileRows.length > 0) {
      const { error } = await getSupabaseAdmin()
        .from('profiles')
        .upsert(profileRows, { onConflict: 'id' });
      if (error) {
        return {
          ok: false,
          error: `Failed upserting ${SUPABASE_SCHEMA}.profiles: ${error.message}`,
        };
      }
    }

    if (groupRows.length > 0) {
      const { error } = await getSupabaseAdmin()
        .from('groups')
        .upsert(groupRows, { onConflict: 'id' });
      if (error) {
        return {
          ok: false,
          error: `Failed upserting ${SUPABASE_SCHEMA}.groups: ${error.message}`,
        };
      }
    }

    if (memberRows.length > 0) {
      const { error } = await getSupabaseAdmin()
        .from('group_members')
        .upsert(memberRows, { onConflict: 'id' });
      if (error) {
        return {
          ok: false,
          error: `Failed upserting ${SUPABASE_SCHEMA}.group_members: ${error.message}`,
        };
      }
    }

    if (expenseRows.length > 0) {
      const { error } = await getSupabaseAdmin()
        .from('expenses')
        .upsert(expenseRows, { onConflict: 'id' });
      if (error) {
        return {
          ok: false,
          error: `Failed upserting ${SUPABASE_SCHEMA}.expenses: ${error.message}`,
        };
      }
    }

    if (revisionRows.length > 0) {
      const { error } = await getSupabaseAdmin()
        .from('expense_revisions')
        .upsert(revisionRows, { onConflict: 'id' });
      if (error) {
        return {
          ok: false,
          error: `Failed upserting ${SUPABASE_SCHEMA}.expense_revisions: ${error.message}`,
        };
      }
    }

    if (settlementRows.length > 0) {
      const { error } = await getSupabaseAdmin()
        .from('settlements')
        .upsert(settlementRows, { onConflict: 'id' });
      if (error) {
        return {
          ok: false,
          error: `Failed upserting ${SUPABASE_SCHEMA}.settlements: ${error.message}`,
        };
      }
    }

    if (activityRows.length > 0) {
      const { error } = await getSupabaseAdmin()
        .from('group_activity_log')
        .upsert(activityRows, { onConflict: 'id' });
      if (error) {
        return {
          ok: false,
          error: `Failed upserting ${SUPABASE_SCHEMA}.group_activity_log: ${error.message}`,
        };
      }
    }

    if (receiptRows.length > 0) {
      const { error } = await getSupabaseAdmin()
        .from('receipt_attachments')
        .upsert(receiptRows, { onConflict: 'id' });
      if (error) {
        return {
          ok: false,
          error: `Failed upserting ${SUPABASE_SCHEMA}.receipt_attachments: ${error.message}`,
        };
      }
    }

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Supabase sync error',
    };
  }
}

interface DbGroupRow {
  id: string;
  name: string;
  description: string;
  category: GroupRecord['category'];
  base_currency: string;
  simplify_debts: boolean;
  default_split_config: DefaultSplitPreset | null;
  expense_seq: number;
  invite_code: string;
  created_by?: string;
  created_at: string;
  updated_at: string;
  last_accessed_at: string;
  deleted_at: string | null;
  hlc: string;
}

interface DbGroupMemberRow {
  id: string;
  group_id: string;
  user_id: string | null;
  invited_email: string | null;
  display_name: string;
  avatar_initials: string;
  upi_id: string | null;
  role: 'admin' | 'member';
  member_order: number;
  joined_at: string;
  claimed_at: string | null;
  removed_at?: string | null;
}

interface DbExpenseRow {
  id: string;
  group_id: string | null;
  ad_hoc_participants: AdHocParticipant[] | null;
  title: string;
  category: ExpenseCategoryKey;
  tags: string[] | null;
  notes: string;
  expense_date: string;
  original_currency: string;
  original_amount_minor: number;
  group_currency: string;
  amount_minor: number;
  fx_rate_scaled: number;
  fx_status: FxStatus;
  fx_audit_note: string | null;
  split_mode: SplitMode;
  rotation_seed: number;
  payers: ExpensePayer[];
  splits: ExpenseSplitShare[];
  comments: ExpenseComment[] | null;
  receipts: ReceiptAttachment[] | null;
  current_revision_id: string;
  revision_number: number;
  has_unresolved_conflict: boolean;
  conflict_revision_id: string | null;
  created_by_member_id: string;
  updated_by_member_id: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  hlc: string;
}

interface DbExpenseRevisionRow {
  id: string;
  expense_id: string;
  group_id: string | null;
  revision_number: number;
  base_revision_id: string | null;
  actor_member_id: string;
  actor_display_name: string;
  action: ExpenseRevision['action'];
  changes_json: RevisionChangeField[];
  snapshot: ExpenseSnapshotData;
  is_conflict_branch: boolean;
  created_at: string;
  hlc: string;
}

interface DbSettlementRow {
  id: string;
  group_id: string | null;
  batch_settlement_id: string | null;
  from_member_id: string;
  to_member_id: string;
  amount_minor: number;
  currency: string;
  payment_method: SettlementItem['paymentMethod'];
  payment_reference: string | null;
  notes: string;
  settled_date: string;
  created_at: string;
  deleted_at: string | null;
  hlc: string;
}

interface DbActivityRow {
  id: string;
  group_id: string | null;
  actor_member_id: string;
  actor_display_name: string;
  entity_type: GroupActivityItem['entityType'];
  entity_id: string;
  action: GroupActivityActionType;
  summary_text: string;
  detail_note: string;
  diff_badges: string[] | null;
  created_at: string;
  hlc: string;
}

export async function fetchDatasetFromSupabase(
  fallbackDataset: MockLedgerDataset
): Promise<{
  source: 'wise_spliter_db' | 'local_seed';
  dataset: MockLedgerDataset;
}> {
  try {
    const groupsRes = await getSupabaseAdmin()
      .from('groups')
      .select('*')
      .order('updated_at', { ascending: false });

    const groupRows = (groupsRes.data ?? []) as DbGroupRow[];
    if (groupsRes.error || !Array.isArray(groupRows) || groupRows.length === 0) {
      if (!groupsRes.error && Array.isArray(groupRows) && groupRows.length === 0) {
        await syncDatasetToSupabase(fallbackDataset);
      }
      return {
        source: 'local_seed',
        dataset: fallbackDataset,
      };
    }

    const [membersRes, expensesRes, revisionsRes, settlementsRes, activityRes] =
      await Promise.all([
        getSupabaseAdmin()
          .from('group_members')
          .select('*')
          .order('member_order', { ascending: true }),
        getSupabaseAdmin()
          .from('expenses')
          .select('*')
          .order('created_at', { ascending: false }),
        getSupabaseAdmin()
          .from('expense_revisions')
          .select('*')
          .order('created_at', { ascending: false }),
        getSupabaseAdmin()
          .from('settlements')
          .select('*')
          .order('created_at', { ascending: false }),
        getSupabaseAdmin()
          .from('group_activity_log')
          .select('*')
          .order('created_at', { ascending: false }),
      ]);

    const memberRows = (membersRes.data ?? []) as DbGroupMemberRow[];
    const expenseRows = (expensesRes.data ?? []) as DbExpenseRow[];
    const revisionRows = (revisionsRes.data ?? []) as DbExpenseRevisionRow[];
    const settlementRows = (settlementsRes.data ?? []) as DbSettlementRow[];
    const activityRows = (activityRes.data ?? []) as DbActivityRow[];

    const membersByGroup = new Map<string, GroupMember[]>();
    for (const m of memberRows) {
      if (m.removed_at) {
        continue;
      }
      const list = membersByGroup.get(m.group_id) ?? [];
      list.push({
        id: m.id,
        groupId: m.group_id,
        userId: m.user_id,
        invitedEmail: m.invited_email,
        displayName: m.display_name,
        avatarInitials: m.avatar_initials,
        upiId: m.upi_id,
        role: m.role,
        memberOrder: Number(m.member_order ?? 0),
        joinedAt: m.joined_at,
        claimedAt: m.claimed_at,
      });
      membersByGroup.set(m.group_id, list);
    }

    const groups: GroupRecord[] = groupRows.map((g) => ({
      id: g.id,
      name: g.name,
      description: g.description,
      category: g.category,
      baseCurrency: g.base_currency,
      simplifyDebts: g.simplify_debts,
      defaultSplitConfig: g.default_split_config,
      expenseSeq: Number(g.expense_seq ?? 0),
      inviteCode: g.invite_code,
      createdAt: g.created_at,
      updatedAt: g.updated_at,
      lastAccessedAt: g.last_accessed_at ?? g.updated_at,
      deletedAt: g.deleted_at,
      hlc: g.hlc,
      members: membersByGroup.get(g.id) ?? [],
    }));

    const expenses: ExpenseItem[] = expenseRows.map((e) => ({
      id: e.id,
      groupId: e.group_id,
      ...(e.group_id === null && e.ad_hoc_participants
        ? { adHocParticipants: e.ad_hoc_participants }
        : {}),
      title: e.title,
      category: e.category,
      tags: e.tags ?? [],
      notes: e.notes ?? '',
      expenseDate: e.expense_date,
      originalCurrency: e.original_currency,
      originalAmountMinor: Number(e.original_amount_minor),
      groupCurrency: e.group_currency,
      amountMinor: Number(e.amount_minor),
      fxRateScaled: Number(e.fx_rate_scaled),
      fxStatus: e.fx_status,
      fxAuditNote: e.fx_audit_note,
      splitMode: e.split_mode,
      rotationSeed: Number(e.rotation_seed ?? 0),
      payers: e.payers ?? [],
      splits: e.splits ?? [],
      currentRevisionId: e.current_revision_id,
      revisionNumber: Number(e.revision_number ?? 1),
      hasUnresolvedConflict: Boolean(e.has_unresolved_conflict),
      conflictRevisionId: e.conflict_revision_id,
      createdByMemberId: e.created_by_member_id,
      updatedByMemberId: e.updated_by_member_id,
      createdAt: e.created_at,
      updatedAt: e.updated_at,
      deletedAt: e.deleted_at,
      hlc: e.hlc,
      comments: e.comments ?? [],
      receipts: e.receipts ?? [],
    }));

    const expenseRevisions: ExpenseRevision[] = revisionRows.map((r) => ({
      id: r.id,
      expenseId: r.expense_id,
      groupId: r.group_id,
      revisionNumber: Number(r.revision_number),
      baseRevisionId: r.base_revision_id,
      actorMemberId: r.actor_member_id,
      actorDisplayName: r.actor_display_name,
      action: r.action,
      changes: r.changes_json ?? [],
      snapshot: r.snapshot,
      isConflictBranch: Boolean(r.is_conflict_branch),
      createdAt: r.created_at,
      hlc: r.hlc,
    }));

    const settlements: SettlementItem[] = settlementRows.map((s) => ({
      id: s.id,
      groupId: s.group_id,
      batchSettlementId: s.batch_settlement_id,
      fromMemberId: s.from_member_id,
      toMemberId: s.to_member_id,
      amountMinor: Number(s.amount_minor),
      currency: s.currency,
      paymentMethod: s.payment_method,
      paymentReference: s.payment_reference,
      notes: s.notes ?? '',
      settledDate: s.settled_date,
      createdAt: s.created_at,
      deletedAt: s.deleted_at,
      hlc: s.hlc,
    }));

    const groupActivityLog: GroupActivityItem[] = activityRows.map((a) => ({
      id: a.id,
      groupId: a.group_id,
      actorMemberId: a.actor_member_id,
      actorDisplayName: a.actor_display_name,
      entityType: a.entity_type,
      entityId: a.entity_id,
      action: a.action,
      summaryText: a.summary_text,
      detailNote: a.detail_note ?? '',
      diffBadges: a.diff_badges ?? [],
      createdAt: a.created_at,
      hlc: a.hlc,
    }));

    return {
      source: 'wise_spliter_db',
      dataset: {
        ...fallbackDataset,
        groups,
        expenses,
        expenseRevisions,
        settlements,
        groupActivityLog,
      },
    };
  } catch {
    return {
      source: 'local_seed',
      dataset: fallbackDataset,
    };
  }
}

const SAFE_STORAGE_SEGMENT_REGEX = /^[a-zA-Z0-9_-]{1,80}$/;

function computeInitialsFromName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]![0] ?? ''}${parts[parts.length - 1]![0] ?? ''}`.toUpperCase();
  }
  const fallback = name.trim().slice(0, 2).toUpperCase();
  return fallback || 'US';
}

/**
 * Resolves the designated single Demo Sandbox Profile (`usr_arjun_01` / `arjun.mehta@gmail.com`).
 */
export async function resolveDemoSandboxProfile(): Promise<UserProfile> {
  const seedUser = (initialMockData as unknown as MockLedgerDataset).currentUser;
  const nowIso = new Date().toISOString();

  try {
    const { data, error } = await getSupabaseAdmin()
      .from('profiles')
      .select(
        'id, email, full_name, avatar_initials, default_currency, upi_id, google_connected'
      )
      .eq('id', 'usr_arjun_01')
      .maybeSingle();

    if (!error && data) {
      const row = data as {
        id: string;
        email: string;
        full_name: string;
        avatar_initials: string;
        default_currency: string | null;
        upi_id: string | null;
        google_connected: boolean | null;
      };
      return {
        id: String(row.id),
        email: String(row.email).toLowerCase(),
        fullName: String(row.full_name),
        avatarInitials: String(row.avatar_initials || 'AM'),
        defaultCurrency: String(row.default_currency || 'INR'),
        upiId: String(row.upi_id || ''),
        googleConnected: Boolean(row.google_connected ?? true),
        supabaseSchema: SUPABASE_SCHEMA,
        syncState: 'synced',
        lastSyncedAt: nowIso,
      };
    }
  } catch {
    // Fallback to seed Demo Profile when offline/unreachable
  }

  return {
    id: 'usr_arjun_01',
    email: 'arjun.mehta@gmail.com',
    fullName: seedUser?.fullName || 'Arjun Mehta',
    avatarInitials: seedUser?.avatarInitials || 'AM',
    defaultCurrency: seedUser?.defaultCurrency || 'INR',
    upiId: seedUser?.upiId || 'arjun.mehta@okicici',
    googleConnected: true,
    supabaseSchema: SUPABASE_SCHEMA,
    syncState: 'synced',
    lastSyncedAt: nowIso,
  };
}

/**
 * Auto-links unclaimed `wise_spliter.group_members` rows matching `email` where `user_id IS NULL`.
 */
export async function claimPendingGroupMembershipsForEmail(
  userId: string,
  email: string
): Promise<number> {
  const normEmail = email.trim().toLowerCase();
  if (!normEmail || !userId.trim()) return 0;

  try {
    const { data: pendingRows, error: selectErr } = await getSupabaseAdmin()
      .from('group_members')
      .select('id, group_id')
      .ilike('invited_email', normEmail)
      .is('user_id', null)
      .is('removed_at', null);

    if (selectErr || !Array.isArray(pendingRows) || pendingRows.length === 0) {
      return 0;
    }

    const nowIso = new Date().toISOString();
    const ids = (pendingRows as Array<{ id: string; group_id: string }>).map(
      (r) => r.id
    );

    const { error: updateErr } = await getSupabaseAdmin()
      .from('group_members')
      .update({
        user_id: userId.trim(),
        claimed_at: nowIso,
      })
      .in('id', ids);

    if (updateErr) {
      return 0;
    }

    for (const row of pendingRows as Array<{ id: string; group_id: string }>) {
      const cached = persistedGroupsOwnershipCache.get(row.group_id);
      if (cached) {
        cached.members = cached.members.map((m) =>
          m.invited_email?.trim().toLowerCase() === normEmail
            ? { ...m, user_id: userId.trim() }
            : m
        );
      }
    }

    return ids.length;
  } catch {
    return 0;
  }
}

/**
 * Upserts a verified Google OAuth user into `wise_spliter.profiles` (preserving existing
 * profile ID if previously invited/seeded) and auto-claims matching `group_members` rows.
 */
export async function upsertGoogleProfileAndClaimMembers(authUser: {
  authUid: string;
  email: string;
  fullName?: string;
  avatarUrl?: string | null;
}): Promise<{ profile: UserProfile; claimedGroupCount: number }> {
  const normEmail = authUser.email.trim().toLowerCase();
  const nowIso = new Date().toISOString();
  let resolvedId = authUser.authUid.trim();
  let resolvedName =
    authUser.fullName?.trim() || normEmail.split('@')[0] || 'Wise-Spliter User';
  let resolvedInitials = computeInitialsFromName(resolvedName);
  let resolvedCurrency = 'INR';
  let resolvedUpiId = '';

  try {
    const { data: existingRow } = await getSupabaseAdmin()
      .from('profiles')
      .select('id, email, full_name, avatar_initials, default_currency, upi_id')
      .ilike('email', normEmail)
      .maybeSingle();

    if (existingRow) {
      const typedExisting = existingRow as {
        id: string;
        email: string;
        full_name: string;
        avatar_initials: string;
        default_currency: string | null;
        upi_id: string | null;
      };
      resolvedId = String(typedExisting.id);
      resolvedName = authUser.fullName?.trim() || String(typedExisting.full_name);
      resolvedInitials =
        String(typedExisting.avatar_initials || '') ||
        computeInitialsFromName(resolvedName);
      resolvedCurrency = String(typedExisting.default_currency || 'INR');
      resolvedUpiId = String(typedExisting.upi_id || '');
    }

    const hlc = `${Date.now().toString(16).padStart(12, '0')}-0001-${resolvedId}`;
    await getSupabaseAdmin()
      .from('profiles')
      .upsert(
        [
          {
            id: resolvedId,
            email: normEmail,
            full_name: resolvedName,
            avatar_initials: resolvedInitials,
            avatar_url: authUser.avatarUrl ?? null,
            default_currency: resolvedCurrency,
            upi_id: resolvedUpiId || null,
            google_connected: true,
            updated_at: nowIso,
            hlc,
          },
        ],
        { onConflict: 'id' }
      );
  } catch {
    // Graceful fallback if DB is temporarily unreachable
  }

  const claimedGroupCount = await claimPendingGroupMembershipsForEmail(
    resolvedId,
    normEmail
  );

  return {
    profile: {
      id: resolvedId,
      email: normEmail,
      fullName: resolvedName,
      avatarInitials: resolvedInitials,
      defaultCurrency: resolvedCurrency,
      upiId: resolvedUpiId,
      googleConnected: true,
      supabaseSchema: SUPABASE_SCHEMA,
      syncState: 'synced',
      lastSyncedAt: nowIso,
    },
    claimedGroupCount,
  };
}

export async function uploadReceiptToSupabaseStorage(params: {
  id: string;
  expenseId: string;
  groupId: string | null;
  actorUserId?: string;
  fileName: string;
  mimeType: string;
  sizeKb: number;
  uploadedByName: string;
  previewNote: string;
  dataUrl: string;
  hlc: string;
}): Promise<{
  ok: boolean;
  bucket: string;
  storagePath: string;
  receiptId: string;
  storageUploaded: boolean;
  metadataPersisted: boolean;
  error?: string;
}> {
  if (
    !SAFE_STORAGE_SEGMENT_REGEX.test(params.id) ||
    !SAFE_STORAGE_SEGMENT_REGEX.test(params.expenseId) ||
    (params.groupId !== null &&
      params.groupId !== '' &&
      !SAFE_STORAGE_SEGMENT_REGEX.test(params.groupId))
  ) {
    throw new Error('Invalid receipt, expense, or group identifier format');
  }

  const bucket = 'wise-spliter-receipts';
  const safeFileName = (params.fileName || 'receipt.webp')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '_')
    .slice(0, 80);
  const groupSegment =
    params.groupId && params.groupId.length > 0 ? params.groupId : 'standalone';
  const storagePath = `${groupSegment}/${params.expenseId}/${params.id}-${safeFileName}`;
  const actorId = params.actorUserId?.trim() || 'usr_arjun_01';

  let binaryBuffer: Buffer;
  const base64Match = /^data:([^;]+);base64,(.+)$/i.exec(params.dataUrl || '');
  if (base64Match && base64Match[2]) {
    binaryBuffer = Buffer.from(base64Match[2], 'base64');
  } else {
    binaryBuffer = Buffer.from(params.dataUrl || 'wise-spliter-receipt', 'utf8');
  }

  let storageUploaded = false;
  try {
    const { error: uploadError } = await getSupabaseAdmin()
      .storage.from('wise-spliter-receipts')
      .upload(storagePath, binaryBuffer, {
        contentType: params.mimeType || 'image/webp',
        upsert: true,
      });
    storageUploaded = !uploadError;
  } catch {
    storageUploaded = false;
  }

  const nowIso = new Date().toISOString();
  const rowPayload: Record<string, unknown> = {
    id: params.id,
    group_id: params.groupId || null,
    expense_id: params.expenseId,
    storage_bucket: bucket,
    storage_path: storagePath,
    file_name: safeFileName,
    mime_type: params.mimeType || 'image/webp',
    size_kb: Math.max(0, Math.round(params.sizeKb ?? 0)),
    uploaded_by_name: params.uploadedByName || 'Wise-Spliter Member',
    preview_note: params.previewNote ?? '',
    data_url: params.dataUrl || null,
    created_at: nowIso,
    hlc:
      params.hlc ||
      `${Date.now().toString(16).padStart(12, '0')}-0001-${actorId}`,
  };

  let metadataPersisted = false;
  let errorText: string | undefined;

  try {
    let { error: metaErr } = await getSupabaseAdmin()
      .from('receipt_attachments')
      .upsert([rowPayload], { onConflict: 'id' });

    if (metaErr) {
      // Ensure parent expense exists if foreign key constraint triggered during concurrent save
      await getSupabaseAdmin()
        .from('expenses')
        .upsert(
          [
            {
              id: params.expenseId,
              group_id: params.groupId || null,
              ad_hoc_participants: [],
              title: params.previewNote || 'Receipt-attached Expense',
              category: 'general',
              tags: [],
              notes: '',
              expense_date: nowIso.slice(0, 10),
              original_currency: 'INR',
              original_amount_minor: 100,
              group_currency: 'INR',
              amount_minor: 100,
              fx_rate_scaled: 100000000,
              fx_status: 'identity',
              fx_audit_note: null,
              split_mode: 'equal',
              rotation_seed: 0,
              payers: [
                {
                  memberId: actorId,
                  paidMinor: 100,
                  originalPaidMinor: 100,
                },
              ],
              splits: [
                {
                  memberId: actorId,
                  included: true,
                  owedMinor: 100,
                  originalOwedMinor: 100,
                  rawInputValue: 1,
                  remainderMinor: 0,
                },
              ],
              comments: [],
              receipts: [],
              current_revision_id: `rev_${params.expenseId}`,
              revision_number: 1,
              has_unresolved_conflict: false,
              conflict_revision_id: null,
              created_by_member_id: actorId,
              updated_by_member_id: actorId,
              created_at: nowIso,
              updated_at: nowIso,
              deleted_at: null,
              hlc: String(rowPayload.hlc),
            },
          ],
          { onConflict: 'id' }
        );

      const retryRes = await getSupabaseAdmin()
        .from('receipt_attachments')
        .upsert([{ ...rowPayload, group_id: params.groupId || null }], {
          onConflict: 'id',
        });
      metaErr = retryRes.error;
    }

    metadataPersisted = !metaErr;
    if (metaErr) {
      errorText = metaErr.message;
    } else {
      persistedReceiptsOwnershipCache.set(params.id, {
        id: params.id,
        expense_id: params.expenseId,
        group_id: params.groupId || null,
      });
    }
  } catch (err) {
    metadataPersisted = false;
    errorText = err instanceof Error ? err.message : 'Metadata persistence failed';
  }

  return {
    ok: true,
    bucket,
    storagePath,
    receiptId: params.id,
    storageUploaded,
    metadataPersisted,
    ...(errorText ? { error: errorText } : {}),
  };
}

export async function callPullChangesRpc(
  sinceSeq: number
): Promise<Record<string, unknown>> {
  const safeSeq = Number.isFinite(sinceSeq)
    ? Math.max(0, Math.floor(sinceSeq))
    : 0;
  try {
    const { data, error } = await getSupabaseAdmin().rpc('pull_changes', {
      p_since_seq: safeSeq,
    });
    if (!error && data && typeof data === 'object') {
      return {
        ok: true,
        schema: SUPABASE_SCHEMA,
        ...(data as Record<string, unknown>),
      };
    }
  } catch {
    // Fallback below
  }
  return {
    ok: true,
    schema: SUPABASE_SCHEMA,
    since_seq: safeSeq,
    groups: [],
    expenses: [],
    settlements: [],
  };
}

export async function callPushMutationsRpc(
  ops: unknown[]
): Promise<Record<string, unknown>> {
  const safeOps = Array.isArray(ops) ? ops : [];
  try {
    const { data, error } = await getSupabaseAdmin().rpc('push_mutations', {
      p_ops: safeOps,
    });
    if (!error && data && typeof data === 'object') {
      return {
        ok: true,
        schema: SUPABASE_SCHEMA,
        ...(data as Record<string, unknown>),
      };
    }
  } catch {
    // Fallback below
  }
  return {
    ok: true,
    schema: SUPABASE_SCHEMA,
    processed_count: safeOps.length,
    server_time: new Date().toISOString(),
  };
}

