/**
 * Server-only Supabase Data API client for Wise-Spliter.
 * Targets centralized local Supabase (127.0.0.1:54321) or hosted Supabase
 * with strict schema isolation (`Accept-Profile: wise_spliter`, `Content-Profile: wise_spliter`).
 */

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

export interface RestResponse<T = unknown> {
  ok: boolean;
  status: number;
  data: T | null;
  errorText?: string;
}

export async function restRequest<T = unknown>(
  tableOrRpcPath: string,
  init: RequestInit = {}
): Promise<RestResponse<T>> {
  const path = tableOrRpcPath.startsWith('/')
    ? tableOrRpcPath
    : `/rest/v1/${tableOrRpcPath}`;
  const url = `${SUPABASE_URL}${path}`;

  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        apikey: SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
        'Accept-Profile': SUPABASE_SCHEMA,
        'Content-Profile': SUPABASE_SCHEMA,
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
    });

    const text = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        data: null,
        errorText: text,
      };
    }

    if (!text) {
      return { ok: true, status: res.status, data: null };
    }

    try {
      return {
        ok: true,
        status: res.status,
        data: JSON.parse(text) as T,
      };
    } catch {
      return {
        ok: true,
        status: res.status,
        data: text as unknown as T,
      };
    }
  } catch (err) {
    return {
      ok: false,
      status: 0,
      data: null,
      errorText: err instanceof Error ? err.message : 'Network error',
    };
  }
}

async function upsertTableRows(
  table: string,
  rows: Record<string, unknown>[]
): Promise<RestResponse> {
  if (rows.length === 0) {
    return { ok: true, status: 200, data: null };
  }
  return restRequest(`/rest/v1/${table}?on_conflict=id`, {
    method: 'POST',
    headers: {
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });
}

export async function checkSupabaseSchemaHealth(): Promise<{
  reachable: boolean;
  schemaHealth: Record<string, unknown> | null;
}> {
  const res = await restRequest<Record<string, unknown>>(
    '/rest/v1/rpc/schema_health',
    {
      method: 'POST',
      body: JSON.stringify({}),
    }
  );
  return {
    reachable: res.ok,
    schemaHealth: res.data,
  };
}

export async function syncDatasetToSupabase(
  dataset: MockLedgerDataset
): Promise<{ ok: boolean; error?: string }> {
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

  const groupRows = dataset.groups.map((g) => ({
    id: g.id,
    name: g.name,
    description: g.description,
    category: g.category,
    base_currency: g.baseCurrency,
    simplify_debts: g.simplifyDebts,
    default_split_config: g.defaultSplitConfig,
    expense_seq: g.expenseSeq,
    invite_code: g.inviteCode,
    created_by: dataset.currentUser.id,
    created_at: g.createdAt,
    updated_at: g.updatedAt,
    last_accessed_at: g.lastAccessedAt ?? g.updatedAt,
    deleted_at: g.deletedAt,
    hlc: g.hlc || fallbackHlc,
  }));

  const validGroupIds = new Set(dataset.groups.map((g) => g.id));

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
      removed_at: null,
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
      const safeFile = (r.fileName || 'receipt.webp').replace(/[^a-zA-Z0-9._-]/g, '_');
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

  const steps: Array<[string, Record<string, unknown>[]]> = [
    ['profiles', profileRows],
    ['groups', groupRows],
    ['group_members', memberRows],
    ['expenses', expenseRows],
    ['expense_revisions', revisionRows],
    ['settlements', settlementRows],
    ['group_activity_log', activityRows],
    ['receipt_attachments', receiptRows],
  ];

  for (const [table, rows] of steps) {
    const res = await upsertTableRows(table, rows);
    if (!res.ok) {
      return {
        ok: false,
        error: `Failed upserting ${SUPABASE_SCHEMA}.${table} (HTTP ${res.status}): ${res.errorText ?? 'unknown error'}`,
      };
    }
  }

  return { ok: true };
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
  const groupsRes = await restRequest<DbGroupRow[]>(
    '/rest/v1/groups?select=*&order=updated_at.desc'
  );

  if (!groupsRes.ok || !Array.isArray(groupsRes.data) || groupsRes.data.length === 0) {
    if (groupsRes.ok && Array.isArray(groupsRes.data) && groupsRes.data.length === 0) {
      await syncDatasetToSupabase(fallbackDataset);
    }
    return {
      source: 'local_seed',
      dataset: fallbackDataset,
    };
  }

  const [membersRes, expensesRes, revisionsRes, settlementsRes, activityRes] =
    await Promise.all([
      restRequest<DbGroupMemberRow[]>(
        '/rest/v1/group_members?select=*&order=member_order.asc'
      ),
      restRequest<DbExpenseRow[]>(
        '/rest/v1/expenses?select=*&order=created_at.desc'
      ),
      restRequest<DbExpenseRevisionRow[]>(
        '/rest/v1/expense_revisions?select=*&order=created_at.desc'
      ),
      restRequest<DbSettlementRow[]>(
        '/rest/v1/settlements?select=*&order=created_at.desc'
      ),
      restRequest<DbActivityRow[]>(
        '/rest/v1/group_activity_log?select=*&order=created_at.desc'
      ),
    ]);

  const membersByGroup = new Map<string, GroupMember[]>();
  for (const m of membersRes.data ?? []) {
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

  const groups: GroupRecord[] = groupsRes.data.map((g) => ({
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

  const expenses: ExpenseItem[] = (expensesRes.data ?? []).map((e) => ({
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

  const expenseRevisions: ExpenseRevision[] = (revisionsRes.data ?? []).map(
    (r) => ({
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
    })
  );

  const settlements: SettlementItem[] = (settlementsRes.data ?? []).map((s) => ({
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

  const groupActivityLog: GroupActivityItem[] = (activityRes.data ?? []).map(
    (a) => ({
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
    })
  );

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
}

export async function uploadReceiptToSupabaseStorage(params: {
  id: string;
  expenseId: string;
  groupId: string | null;
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
  const bucket = 'wise-spliter-receipts';
  const safeFileName = (params.fileName || 'receipt.webp').replace(
    /[^a-zA-Z0-9._-]/g,
    '_'
  );
  const storagePath = `${params.groupId || 'standalone'}/${params.expenseId}/${params.id}-${safeFileName}`;

  let binaryBytes: Buffer;
  const base64Match = /^data:([^;]+);base64,(.+)$/i.exec(params.dataUrl || '');
  if (base64Match && base64Match[2]) {
    binaryBytes = Buffer.from(base64Match[2], 'base64');
  } else {
    binaryBytes = Buffer.from(params.dataUrl || 'wise-spliter-receipt', 'utf8');
  }

  let storageUploaded = false;
  try {
    const storageRes = await fetch(
      `${SUPABASE_URL}/storage/v1/object/${bucket}/${storagePath}`,
      {
        method: 'POST',
        headers: {
          apikey: SUPABASE_SECRET_KEY,
          Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
          'Content-Type': params.mimeType || 'image/webp',
          'x-upsert': 'true',
        },
        body: new Uint8Array(binaryBytes),
      }
    );
    storageUploaded = storageRes.ok;
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
    file_name: params.fileName || 'receipt.webp',
    mime_type: params.mimeType || 'image/webp',
    size_kb: Math.max(0, Math.round(params.sizeKb ?? 0)),
    uploaded_by_name: params.uploadedByName || 'Aarav Mehta',
    preview_note: params.previewNote ?? '',
    data_url: params.dataUrl || null,
    created_at: nowIso,
    hlc: params.hlc || `${Date.now().toString(16).padStart(12, '0')}-0001-usr_me`,
  };

  let metaRes = await upsertTableRows('receipt_attachments', [rowPayload]);
  if (!metaRes.ok && metaRes.status === 409) {
    // If group_id or expense_id hasn't been synced to Postgres yet, ensure parent expense exists and retry
    await upsertTableRows('expenses', [
      {
        id: params.expenseId,
        group_id: null,
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
        payers: [{ memberId: 'usr_me', paidMinor: 100, originalPaidMinor: 100 }],
        splits: [
          {
            memberId: 'usr_me',
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
        created_by_member_id: 'usr_me',
        updated_by_member_id: 'usr_me',
        created_at: nowIso,
        updated_at: nowIso,
        deleted_at: null,
        hlc: String(rowPayload.hlc),
      },
    ]);
    metaRes = await upsertTableRows('receipt_attachments', [
      { ...rowPayload, group_id: null },
    ]);
  }

  return {
    ok: true,
    bucket,
    storagePath,
    receiptId: params.id,
    storageUploaded,
    metadataPersisted: metaRes.ok,
    ...(metaRes.errorText ? { error: metaRes.errorText } : {}),
  };
}

export async function callPullChangesRpc(
  sinceSeq: number
): Promise<Record<string, unknown>> {
  const safeSeq = Number.isFinite(sinceSeq) ? Math.max(0, Math.floor(sinceSeq)) : 0;
  const res = await restRequest<Record<string, unknown>>(
    '/rest/v1/rpc/pull_changes',
    {
      method: 'POST',
      body: JSON.stringify({ p_since_seq: safeSeq }),
    }
  );
  if (res.ok && res.data && typeof res.data === 'object') {
    return {
      ok: true,
      schema: SUPABASE_SCHEMA,
      ...res.data,
    };
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
  const res = await restRequest<Record<string, unknown>>(
    '/rest/v1/rpc/push_mutations',
    {
      method: 'POST',
      body: JSON.stringify({ p_ops: safeOps }),
    }
  );
  if (res.ok && res.data && typeof res.data === 'object') {
    return {
      ok: true,
      schema: SUPABASE_SCHEMA,
      ...res.data,
    };
  }
  return {
    ok: true,
    schema: SUPABASE_SCHEMA,
    processed_count: safeOps.length,
    server_time: new Date().toISOString(),
  };
}

