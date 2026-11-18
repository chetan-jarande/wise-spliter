import {
  ExpenseComment,
  ExpenseItem,
  ExpenseRevision,
  FxStatus,
  GroupActivityItem,
  GroupMember,
  GroupRecord,
  MockLedgerDataset,
  ReceiptAttachment,
  SettlementItem,
} from '../types/ledger';
import {
  SYNC_PULL_MAX_LIMIT,
  SYNC_PUSH_MAX_MUTATIONS,
  type SyncEntityDataMap,
  type SyncEntityType,
  type SyncExpenseComment,
  type SyncPullChange,
  type SyncPullResponse,
  type SyncPushMutation,
  type SyncPushResponse,
  type SyncPushResult,
} from '../types/sync-contract';
import { redenominateExpenseCurrency, redenominateSettlementCurrency } from '../domain/splits/split-calculator';
import {
  getKvValue,
  getSyncCursor,
  listSyncOutboxMutations,
  outboxKey,
  setKvValue,
  removeSyncOutboxMutations,
  setSyncCursor,
} from '../storage/local-db';
import { resolveApiUrl } from './supabase-sync';

export { newId } from '../utils/ids';

let clockMs = 0;
let clockCounter = 0;
let deviceSuffix = '';

/** Per-device suffix so two devices of one user never mint equal HLCs. */
export function setHlcDeviceId(deviceId: string): void {
  deviceSuffix = /^[A-Za-z0-9]{1,16}$/.test(deviceId) ? `_${deviceId}` : '';
}

/** Monotonic HLC: `<48-bit ms hex>-<16-bit counter hex>-<node>` (docs/database-and-sync-spec.md 4.1). */
/** The server rejects HLCs more than 60 s ahead of its clock, so ours never run further ahead. */
export const HLC_MAX_DRIFT_MS = 60_000;

export function makeHlc(node: string): string {
  const now = Date.now();
  clockMs = Math.min(clockMs, now + HLC_MAX_DRIFT_MS);
  if (now > clockMs) {
    clockMs = now;
    clockCounter = 0;
  } else if (clockCounter < 0xffff) {
    clockCounter += 1;
  } else {
    clockMs += 1;
    clockCounter = 0;
  }
  const nodeId = `${node}${deviceSuffix}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(-80);
  return `${clockMs.toString(16).padStart(12, '0')}-${clockCounter.toString(16).padStart(4, '0')}-${nodeId}`;
}

export function observeHlc(remote: string): void {
  const m = /^([0-9a-f]{12})-([0-9a-f]{4})-/.exec(remote);
  if (!m) return;
  const remoteMs = parseInt(m[1]!, 16);
  const ms = Math.min(remoteMs, Date.now() + HLC_MAX_DRIFT_MS);
  const counter = ms === remoteMs ? parseInt(m[2]!, 16) : 0;
  if (ms > clockMs || (ms === clockMs && counter > clockCounter)) {
    clockMs = ms;
    clockCounter = counter;
  }
}

type Row = { id: string; hlc?: string; deletedAt?: string | null };
type Data = Record<string, unknown>;

function stripReceipt({ dataUrl: _omit, ...meta }: ReceiptAttachment): SyncEntityDataMap['receipt_pointer'] {
  return { ...meta, localDeviceOnly: true, storageBucket: 'local-device-only' };
}

const asData = <K extends SyncEntityType>(_entity: K, data: SyncEntityDataMap[K]): Data => ({ ...data });

const withoutRejection = ({ syncRejection: _local, ...e }: ExpenseItem): ExpenseItem => e;

const toData = {
  group: ({ members: _members, lastAccessedAt: _perDevice, syncRejection: _local, ...g }: GroupRecord) => asData('group', g),
  member: (m: GroupMember) => asData('group_member', m),
  expense: (e: ExpenseItem) =>
    asData('expense', { ...withoutRejection(e), comments: [], receipts: (e.receipts ?? []).map(stripReceipt) }),
  revision: (r: ExpenseRevision) => asData('expense_revision', r),
  /** canEdit (like isMine on comments) is per viewer and pull-only; it never goes back up. */
  settlement: ({ canEdit: _perViewer, syncRejection: _local, ...s }: SettlementItem & { canEdit?: boolean }) =>
    asData('settlement', s),
  activity: (a: GroupActivityItem) => asData('group_activity', a),
  receipt: (r: ReceiptAttachment) => asData('receipt_pointer', stripReceipt(r)),
  /** The server sets the author, group and timestamps of a comment from the verified actor. */
  comment: (c: ExpenseComment): Data => ({ id: c.id, expenseId: c.expenseId, body: c.body, createdAt: c.createdAt }),
};

/** Groups are PATCHed server-side: send only the keys that changed, plus id and hlc. */
function changedFields(before: Data, after: Data, hlc: string): Data {
  const patch: Data = { id: after.id, hlc };
  for (const [key, value] of Object.entries(after)) {
    if (JSON.stringify(before[key]) !== JSON.stringify(value)) patch[key] = value;
  }
  return patch;
}

function diffRows<T extends Row>(
  entity: SyncEntityType,
  prev: T[],
  next: T[],
  serialize: (row: T) => Data,
  hlcFor: (row: T, isNew: boolean) => string,
  out: SyncPushMutation[],
  baseHlcs?: ReadonlyMap<string, string>
): void {
  const before = new Map(prev.map((r) => [r.id, r]));
  for (const row of next) {
    const old = before.get(row.id);
    before.delete(row.id);
    if (old === row) continue;
    const changed =
      !old ||
      (row.hlc !== undefined
        ? row.hlc !== old.hlc
        : JSON.stringify(serialize(old)) !== JSON.stringify(serialize(row)));
    if (!changed) continue;
    const deleted = Boolean(row.deletedAt);
    const restored = entity === 'group' && Boolean(old?.deletedAt) && !deleted;
    const hlc = row.hlc ?? hlcFor(row, !old);
    out.push({
      entity,
      id: row.id,
      op: deleted ? 'delete' : restored ? 'restore' : 'upsert',
      hlc,
      // A row the server refused as new is still new to it, whatever its local hlc.
      ...(entity === 'expense'
        ? { baseHlc: old && 'syncRejection' in old && old.syncRejection ? null : (old && baseHlcs?.get(row.id)) || old?.hlc || null }
        : {}),
      data: deleted
        ? null
        : entity === 'group' && old && !('syncRejection' in old && old.syncRejection)
          ? changedFields(serialize(old), serialize(row), hlc)
          : serialize(row),
    });
  }
  for (const old of before.values()) {
    out.push({
      entity,
      id: old.id,
      op: 'delete',
      hlc: hlcFor(old, false),
      ...(entity === 'expense' ? { baseHlc: old.hlc || null } : {}),
      data: null,
    });
  }
}

/**
 * Diff baseline that treats `ids` as already synced, so restoring a backup pushes the user's
 * own rows but never the bundled sample rows.
 */
export function keepOnlyIds(d: MockLedgerDataset, ids: ReadonlySet<string>): MockLedgerDataset {
  return {
    ...d,
    groups: d.groups.filter((g) => ids.has(g.id)).map((g) => ({ ...g, members: g.members.filter((m) => ids.has(m.id)) })),
    expenses: d.expenses
      .filter((e) => ids.has(e.id))
      .map((e) => ({ ...e, receipts: (e.receipts ?? []).filter((r) => ids.has(r.id)) })),
    expenseRevisions: d.expenseRevisions.filter((r) => ids.has(r.id)),
    settlements: d.settlements.filter((s) => ids.has(s.id)),
    groupActivityLog: d.groupActivityLog.filter((a) => ids.has(a.id)),
  };
}

/** Drops a group the user can no longer access, with everything scoped to it. Nothing is pushed for this. */
export function evictGroupData(d: MockLedgerDataset, groupId: string): MockLedgerDataset {
  return {
    ...d,
    groups: d.groups.filter((g) => g.id !== groupId),
    expenses: d.expenses.filter((e) => e.groupId !== groupId),
    expenseRevisions: d.expenseRevisions.filter((r) => r.groupId !== groupId),
    settlements: d.settlements.filter((s) => s.groupId !== groupId),
    groupActivityLog: d.groupActivityLog.filter((a) => a.groupId !== groupId),
  };
}

/** Drops a direct bill the user can no longer access, with its revisions, settlements and activity. */
export function evictExpenseData(d: MockLedgerDataset, expenseId: string): MockLedgerDataset {
  const settlementIds = new Set(d.settlements.filter((s) => s.expenseId === expenseId).map((s) => s.id));
  return {
    ...d,
    expenses: d.expenses.filter((e) => e.id !== expenseId),
    expenseRevisions: d.expenseRevisions.filter((r) => r.expenseId !== expenseId),
    settlements: d.settlements.filter((s) => !settlementIds.has(s.id)),
    groupActivityLog: d.groupActivityLog.filter(
      (a) => a.entityId !== expenseId && !settlementIds.has(a.entityId)
    ),
  };
}

/** One mutation per dirty entity, parents first so a batch never references an unknown group. */
/**
 * `baseHlcs` names, per expense id, the version an editor opened (when a pull replaced the bill while
 * it was open), so the save is checked against that version and a lost remote edit becomes a conflict.
 */
export function diffDatasetToMutations(
  prev: MockLedgerDataset,
  next: MockLedgerDataset,
  node: string,
  baseHlcs?: ReadonlyMap<string, string>
): SyncPushMutation[] {
  const out: SyncPushMutation[] = [];
  const fresh = () => makeHlc(node);
  diffRows('group', prev.groups, next.groups, toData.group, fresh, out);
  const groupHlc = new Map(next.groups.map((g) => [g.id, g.hlc]));
  diffRows(
    'group_member',
    prev.groups.flatMap((g) => g.members ?? []),
    next.groups.flatMap((g) => g.members ?? []),
    toData.member,
    (m, isNew) => (isNew ? (groupHlc.get(m.groupId) ?? fresh()) : fresh()),
    out
  );
  diffRows('expense', prev.expenses, next.expenses, toData.expense, fresh, out, baseHlcs);
  const expenseHlc = new Map(next.expenses.map((e) => [e.id, e.hlc]));
  diffRows(
    'receipt_pointer',
    prev.expenses.flatMap((e) => e.receipts ?? []),
    next.expenses.flatMap((e) => e.receipts ?? []),
    toData.receipt,
    (r, isNew) => (isNew ? (expenseHlc.get(r.expenseId) ?? fresh()) : fresh()),
    out
  );
  const unsyncedComments = (d: MockLedgerDataset) => d.expenses.flatMap((e) => (e.comments ?? []).filter((c) => c.isMine && !c.hlc));
  const comments: SyncPushMutation[] = [];
  diffRows('expense_comment', unsyncedComments(prev), unsyncedComments(next), toData.comment, fresh, comments);
  out.push(...comments.filter((m) => m.op === 'upsert'));
  diffRows('expense_revision', prev.expenseRevisions, next.expenseRevisions, toData.revision, fresh, out);
  diffRows('settlement', prev.settlements, next.settlements, toData.settlement, fresh, out);
  diffRows('group_activity', prev.groupActivityLog, next.groupActivityLog, toData.activity, fresh, out);
  return out;
}

function remoteWins(local: Row | undefined, remoteHlc: string | null): boolean {
  return !local?.hlc || !remoteHlc || remoteHlc >= local.hlc;
}

function upsertById<T extends Row>(rows: T[], row: T): T[] {
  const idx = rows.findIndex((r) => r.id === row.id);
  if (idx === -1) return [row, ...rows];
  const copy = rows.slice();
  copy[idx] = row;
  return copy;
}

function softDelete<T extends Row>(rows: T[], id: string, data: Data | null): T[] {
  const local = rows.find((r) => r.id === id);
  if (data) {
    const deletedAt = typeof data.deletedAt === 'string' ? data.deletedAt : (local?.deletedAt ?? new Date().toISOString());
    return upsertById(rows, { ...(local ?? {}), ...data, id, deletedAt } as unknown as T);
  }
  if (!local) return rows;
  return upsertById(rows, { ...local, deletedAt: local.deletedAt ?? new Date().toISOString() });
}

function arr<T>(value: unknown, fallback: T[]): T[] {
  return Array.isArray(value) ? (value as T[]) : fallback;
}

const seqOf = (c: SyncPullChange): bigint => (/^\d+$/.test(c.serverSeq) ? BigInt(c.serverSeq) : 0n);
const CHILD_RANK: Partial<Record<SyncEntityType, number>> = { group_member: 1, receipt_pointer: 1, expense_comment: 1 };

/** Latest change per entity, children after parents (pull pages are ordered by server_seq, not by dependency). */
function orderForMerge(changes: SyncPullChange[]): SyncPullChange[] {
  const latest = new Map<string, SyncPullChange>();
  for (const c of changes) {
    const key = `${c.entity}:${c.id}`;
    const seen = latest.get(key);
    if (!seen || seqOf(c) >= seqOf(seen)) latest.set(key, c);
  }
  return [...latest.values()].sort((a, b) => (CHILD_RANK[a.entity] ?? 0) - (CHILD_RANK[b.entity] ?? 0));
}

/**
 * Applies pulled changes with per-entity last-writer-wins by HLC. Always returns a new dataset.
 * Members and receipt pointers whose parent is not here yet are pushed to `orphans`, never dropped.
 */
export function mergePullChanges(
  dataset: MockLedgerDataset,
  changes: SyncPullChange[],
  orphans: SyncPullChange[] = [],
  selfUserId?: string
): MockLedgerDataset {
  let { groups, expenses, expenseRevisions, settlements, groupActivityLog } = dataset;

  for (const change of orderForMerge(changes)) {
    const { entity, id, deleted } = change;
    const data = change.data && typeof change.data === 'object' ? change.data : null;
    const remoteHlc = typeof data?.hlc === 'string' ? data.hlc : null;
    if (remoteHlc) observeHlc(remoteHlc);

    switch (entity) {
      case 'group': {
        const local = groups.find((g) => g.id === id);
        if (!remoteWins(local, remoteHlc)) {
          const serverCode = typeof data?.inviteCode === 'string' ? data.inviteCode : null;
          if (serverCode) groups = groups.map((g) => (g.id === id ? { ...g, inviteCode: serverCode } : g));
          break;
        }
        if (deleted) {
          groups = softDelete(groups, id, data ? { ...data, members: arr(data.members, local?.members ?? []) } : null);
        } else if (data) {
          groups = upsertById(groups, {
            ...(data as unknown as GroupRecord),
            id,
            members: arr<GroupMember>(data.members, local?.members ?? []),
            expenseSeq: Math.max(Number(data.expenseSeq) || 0, local?.expenseSeq ?? 0),
            lastAccessedAt: local?.lastAccessedAt ?? (data.lastAccessedAt as string | undefined),
          });
        }
        break;
      }
      case 'group_member': {
        const groupId =
          typeof data?.groupId === 'string'
            ? data.groupId
            : groups.find((g) => g.members.some((m) => m.id === id))?.id;
        if (!groups.some((g) => g.id === groupId)) {
          if (!deleted && data) orphans.push(change);
          break;
        }
        const removed = deleted || !data || Boolean(data.removedAt);
        const memberUserId =
          (typeof data?.userId === 'string' ? data.userId : null) ??
          groups.find((g) => g.id === groupId)?.members.find((m) => m.id === id)?.userId;
        if (removed && selfUserId && memberUserId === selfUserId) {
          const kept = evictGroupData(
            { ...dataset, groups, expenses, expenseRevisions, settlements, groupActivityLog },
            groupId!
          );
          ({ groups, expenses, expenseRevisions, settlements, groupActivityLog } = kept);
          break;
        }
        groups = groups.map((g) => {
          if (g.id !== groupId) return g;
          const local = g.members.find((m) => m.id === id);
          let member: GroupMember | null;
          if (data) {
            const row = { ...(data as unknown as SyncEntityDataMap['group_member']), id, groupId: g.id };
            member = removed ? { ...row, removedAt: row.removedAt ?? new Date().toISOString() } : { ...row, removedAt: null };
          } else {
            // A bare tombstone: keep a former-member entry while bills or payments still name them.
            const referenced =
              expenses.some((e) => e.groupId === g.id && (e.payers.some((p) => p.memberId === id) || e.splits.some((x) => x.memberId === id))) ||
              settlements.some((x) => x.groupId === g.id && (x.fromMemberId === id || x.toMemberId === id));
            member = referenced
              ? {
                  ...(local ?? {
                    id, groupId: g.id, userId: null, invitedEmail: null, displayName: 'Former member', avatarInitials: 'FM',
                    upiId: null, role: 'member' as const, memberOrder: g.members.length, joinedAt: '', claimedAt: null,
                  }),
                  removedAt: local?.removedAt ?? new Date().toISOString(),
                }
              : null;
          }
          if (!member) return { ...g, members: g.members.filter((m) => m.id !== id) };
          return { ...g, members: local ? g.members.map((m) => (m.id === id ? member : m)) : [...g.members, member] };
        });
        break;
      }
      case 'expense': {
        const local = expenses.find((e) => e.id === id);
        if (!remoteWins(local, remoteHlc)) break;
        if (deleted) {
          expenses = softDelete(expenses, id, data);
        } else if (data) {
          const localReceipts = new Map((local?.receipts ?? []).map((r) => [r.id, r]));
          const receipts = arr<ReceiptAttachment>(data.receipts, local?.receipts ?? []).map((r) => {
            const dataUrl = localReceipts.get(r.id)?.dataUrl;
            return dataUrl ? { ...r, dataUrl } : r;
          });
          expenses = upsertById(expenses, {
            ...(data as unknown as ExpenseItem),
            id,
            tags: arr(data.tags, local?.tags ?? []),
            payers: arr(data.payers, local?.payers ?? []),
            splits: arr(data.splits, local?.splits ?? []),
            comments: local?.comments ?? arr(data.comments, []),
            receipts,
          });
        }
        break;
      }
      case 'settlement': {
        const local = settlements.find((s) => s.id === id);
        if (!remoteWins(local, remoteHlc)) break;
        if (deleted) settlements = softDelete(settlements, id, data);
        else if (data) settlements = upsertById(settlements, { ...(data as unknown as SettlementItem), id });
        break;
      }
      case 'expense_revision': {
        const local = expenseRevisions.find((r) => r.id === id);
        if (!remoteWins(local, remoteHlc)) break;
        if (deleted || !data) expenseRevisions = expenseRevisions.filter((r) => r.id !== id);
        else {
          const rev = data as unknown as ExpenseRevision;
          const actorDisplayName = rev.actorDisplayName?.trim() ? rev.actorDisplayName : 'Someone on this bill';
          expenseRevisions = upsertById(expenseRevisions, { ...rev, id, actorMemberId: rev.actorMemberId ?? null, actorDisplayName });
        }
        break;
      }
      case 'group_activity': {
        const local = groupActivityLog.find((a) => a.id === id);
        if (!remoteWins(local, remoteHlc)) break;
        if (deleted || !data) groupActivityLog = groupActivityLog.filter((a) => a.id !== id);
        else {
          const act = data as unknown as GroupActivityItem;
          groupActivityLog = upsertById(groupActivityLog, { ...act, id, actorMemberId: act.actorMemberId ?? null });
        }
        break;
      }
      case 'receipt_pointer': {
        const expenseId = typeof data?.expenseId === 'string' ? data.expenseId : null;
        const hasParent = expenseId
          ? expenses.some((e) => e.id === expenseId)
          : expenses.some((e) => e.receipts.some((r) => r.id === id));
        if (!hasParent) {
          if (!deleted && data) orphans.push(change);
          break;
        }
        expenses = expenses.map((e) => {
          if (expenseId ? e.id !== expenseId : !e.receipts.some((r) => r.id === id)) return e;
          const rest = e.receipts.filter((r) => r.id !== id);
          if (deleted || !data) return { ...e, receipts: rest };
          const { dataUrl: _omit, ...pointer } = data as unknown as ReceiptAttachment;
          const localUrl = e.receipts.find((r) => r.id === id)?.dataUrl;
          return { ...e, receipts: [...rest, { ...pointer, id, ...(localUrl ? { dataUrl: localUrl } : {}) }] };
        });
        break;
      }
      case 'expense_comment': {
        const expenseId = typeof data?.expenseId === 'string' ? data.expenseId : null;
        const owns = (e: ExpenseItem) => (expenseId ? e.id === expenseId : e.comments.some((c) => c.id === id));
        if (!expenses.some(owns)) {
          if (!deleted && data) orphans.push(change);
          break;
        }
        expenses = expenses.map((e) => {
          if (!owns(e)) return e;
          const local = e.comments.find((c) => c.id === id);
          if (local?.hlc && remoteHlc && remoteHlc < local.hlc) return e;
          const rest = e.comments.filter((c) => c.id !== id);
          if (deleted || !data || data.deletedAt) return { ...e, comments: rest };
          const c = data as unknown as SyncExpenseComment;
          const comment: ExpenseComment = {
            id,
            expenseId: e.id,
            authorMemberId: c.authorMemberId ?? '',
            authorName: c.authorName,
            body: c.body,
            createdAt: c.createdAt,
            hlc: c.hlc,
            isMine: c.isMine,
            isLegacy: c.isLegacy === true,
            editedAt: c.editedAt,
          };
          return { ...e, comments: [...rest, comment].sort((a, b) => a.createdAt.localeCompare(b.createdAt)) };
        });
        break;
      }
    }
  }

  return { ...dataset, groups, expenses, expenseRevisions, settlements, groupActivityLog };
}

export type SyncCallStatus = 'ok' | 'auth' | 'retry';

export interface StaleConflict {
  mutation: SyncPushMutation;
  serverHlc: string;
}

export interface ServerConflict {
  mutation: SyncPushMutation;
  server: { hlc: string; data: Record<string, unknown> };
}

export interface PushOutcome {
  status: SyncCallStatus;
  applied: number;
  stale: number;
  rejected: SyncPushResult[];
  /** Stale results whose stored row was written by someone else (serverHlc differs from ours). */
  conflicts: StaleConflict[];
  /** Expense edits the server kept as a conflict revision; `server` is the bill to show, flag set. */
  serverConflicts: ServerConflict[];
  /** Bills and payments written in a currency the group has since left; still queued, skipped this run. */
  currencyMismatches: CurrencyMismatch[];
}

export interface CurrencyMismatch {
  mutation: SyncPushMutation;
  baseCurrency: string;
}

/** Writes rows as given, whatever their local hlc (local receipt bytes and comments stay). */
export function forceRows(d: MockLedgerDataset, changes: SyncPullChange[]): MockLedgerDataset {
  if (changes.length === 0) return d;
  const ids = new Set(changes.map((c) => `${c.entity}:${c.id}`));
  const unpin = <T extends { id: string; hlc: string }>(entity: SyncEntityType, rows: T[]) =>
    rows.map((r) => (ids.has(`${entity}:${r.id}`) ? { ...r, hlc: '' } : r));
  return mergePullChanges(
    { ...d, expenses: unpin('expense', d.expenses), settlements: unpin('settlement', d.settlements) },
    changes
  );
}

/**
 * Re-expresses a queued bill or payment in the group's new base currency (`rateScaled` from its
 * current currency, unused when they already match) with a fresh hlc. The edit keeps its baseHlc,
 * so a bill the admin re-converted meanwhile comes back as a conflict for the user to pick.
 */
export function convertQueuedToBase(
  m: SyncPushMutation,
  baseCurrency: string,
  rate: { rateScaled: number; status: FxStatus; rateDate: string } | null,
  hlc: string
): SyncPushMutation | null {
  if (!m.data || m.op !== 'upsert') return null;
  const from = String(m.entity === 'expense' ? m.data.groupCurrency : m.data.currency).toUpperCase();
  const target = baseCurrency.toUpperCase();
  if (from !== target && !rate) return null;
  const fx = { mode: 'reconvert' as const, newCurrency: target, fxRateScaled: rate?.rateScaled, hlc };
  if (m.entity === 'expense') {
    const e = m.data as unknown as ExpenseItem;
    const data = from === target ? { ...e, hlc } : redenominateExpenseCurrency({ ...fx, expense: e, fxStatus: rate?.status, fxRateDate: rate?.rateDate });
    return { ...m, hlc, data: { ...data } };
  }
  if (m.entity === 'settlement') {
    const st = m.data as unknown as SettlementItem;
    const data = from === target ? { ...st, hlc } : redenominateSettlementCurrency({ ...fx, settlement: st });
    return { ...m, hlc, data: { ...data } };
  }
  return null;
}

/**
 * Takes the server's bill for each 'conflict' result, whatever the local hlc, so this device shows
 * the same flagged bill (and banner) as every other one. Local receipt bytes and comments stay.
 */
export function takeServerVersions(d: MockLedgerDataset, conflicts: ServerConflict[]): MockLedgerDataset {
  return forceRows(
    d,
    conflicts.map((c) => ({
      entity: 'expense' as const,
      id: c.mutation.id,
      serverSeq: '0',
      deleted: false,
      data: { ...c.server.data, hlc: c.server.hlc },
    }))
  );
}

async function syncFetch(path: string, token: string, init?: RequestInit): Promise<Response | null> {
  try {
    return await fetch(resolveApiUrl(path), {
      ...init,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        Authorization: `Bearer ${token}`,
      },
    });
  } catch {
    return null;
  }
}

let pushBatchSize = SYNC_PUSH_MAX_MUTATIONS;
/** Stays under the server's 256 KB request cap with room for the envelope. */
export const SYNC_PUSH_MAX_BYTES = 240 * 1024;
const encoder = new TextEncoder();

/** Current adaptive batch size: halved on a 503 (aborted batch), grown back by a quarter per success. */
export function getPushBatchSize(): number {
  return pushBatchSize;
}

export function resetPushBatchSize(): void {
  pushBatchSize = SYNC_PUSH_MAX_MUTATIONS;
}

/** Drains the outbox in batches. Only applied/stale/forbidden/invalid rows leave the outbox. */
export async function pushOutbox(
  token: string,
  shouldContinue: () => boolean = () => true
): Promise<PushOutcome> {
  const outcome: PushOutcome = {
    status: 'ok', applied: 0, stale: 0, rejected: [], conflicts: [], serverConflicts: [], currencyMismatches: [],
  };
  const parked = new Set<string>();
  for (let round = 0; round < 1000 && shouldContinue(); round++) {
    const candidates = (await listSyncOutboxMutations(pushBatchSize + parked.size)).filter((r) => !parked.has(r.id));
    if (candidates.length === 0) return outcome;
    const batch: typeof candidates = [];
    let bytes = 0;
    for (const row of candidates) {
      const size = encoder.encode(JSON.stringify(row.mutation)).length + 1;
      if (batch.length > 0 && bytes + size > SYNC_PUSH_MAX_BYTES) break;
      batch.push(row);
      bytes += size;
    }

    const res = await syncFetch('/api/ledger/push', token, {
      method: 'POST',
      body: JSON.stringify({ mutations: batch.map((row) => row.mutation) }),
    });
    if (res?.status === 401) return { ...outcome, status: 'auth' };
    if (res?.status === 413 && batch.length === 1) {
      const only = batch[0]!.mutation;
      const result: SyncPushResult = { entity: only.entity, id: only.id, status: 'invalid', reason: 'too large to sync' };
      console.warn('[sync] mutation too large for the server; a new row stays here marked not saved, an edit goes back to the saved version', result);
      outcome.rejected.push(result);
      await removeSyncOutboxMutations([only]);
      continue;
    }
    if (res?.status === 503 || res?.status === 413) {
      pushBatchSize = Math.max(1, Math.floor(batch.length / 2));
    }
    if (!res?.ok) return { ...outcome, status: 'retry' };

    let results: SyncPushResult[];
    try {
      const body = (await res.json()) as Partial<SyncPushResponse>;
      if (!Array.isArray(body.results)) return { ...outcome, status: 'retry' };
      results = body.results;
    } catch {
      return { ...outcome, status: 'retry' };
    }

    const sent = new Map(batch.map((row) => [row.id, row.mutation]));
    const acked: Array<{ entity: string; id: string; hlc: string; applied?: boolean }> = [];
    const rejected: SyncPushResult[] = [];
    let newlyParked = 0;
    for (const result of results) {
      const mutation = sent.get(`${result.entity}:${result.id}`);
      if (!mutation) continue;
      if (result.status === 'invalid' && result.code === 'currency_mismatch' && typeof result.baseCurrency === 'string') {
        parked.add(outboxKey(mutation));
        newlyParked += 1;
        outcome.currencyMismatches.push({ mutation, baseCurrency: result.baseCurrency });
        continue;
      }
      acked.push({ ...mutation, applied: result.status === 'applied' });
      if (result.status === 'applied') outcome.applied += 1;
      else if (result.status === 'conflict') {
        const server = result.server;
        if (typeof result.serverHlc === 'string') observeHlc(result.serverHlc);
        if (server && typeof server.hlc === 'string' && server.data && typeof server.data === 'object') {
          observeHlc(server.hlc);
          outcome.serverConflicts.push({ mutation, server });
        }
      } else if (result.status === 'stale') {
        outcome.stale += 1;
        const serverHlc = typeof result.serverHlc === 'string' ? result.serverHlc : null;
        if (serverHlc) observeHlc(serverHlc);
        if (serverHlc && serverHlc !== mutation.hlc) outcome.conflicts.push({ mutation, serverHlc });
      } else rejected.push(result);
    }
    if (rejected.length > 0) {
      console.warn('[sync] server rejected mutations; new rows stay here marked not saved, edits go back to the saved version', rejected);
      outcome.rejected.push(...rejected);
    }
    if (acked.length === 0 && newlyParked === 0) return { ...outcome, status: 'retry' };
    await removeSyncOutboxMutations(acked);
    pushBatchSize = Math.min(SYNC_PUSH_MAX_MUTATIONS, pushBatchSize + Math.max(1, Math.floor(pushBatchSize / 4)));
  }
  return outcome;
}

type RowKey = { entity: SyncEntityType; id: string };
const keyOf = (k: RowKey) => `${k.entity}:${k.id}`;

/** The group or direct bill whose pull scope holds each refused row. */
export function scopesOf(d: MockLedgerDataset, keys: RowKey[]): { groupIds: string[]; expenseIds: string[] } {
  const groupIds = new Set<string>();
  const expenseIds = new Set<string>();
  const ofExpense = (expenseId: string | null | undefined) => {
    const e = d.expenses.find((x) => x.id === expenseId);
    if (e) (e.groupId ? groupIds.add(e.groupId) : expenseIds.add(e.id));
  };
  for (const { entity, id } of keys) {
    switch (entity) {
      case 'group':
        groupIds.add(id);
        break;
      case 'group_member': {
        const g = d.groups.find((x) => x.members.some((m) => m.id === id));
        if (g) groupIds.add(g.id);
        break;
      }
      case 'expense':
        ofExpense(id);
        break;
      case 'settlement': {
        const st = d.settlements.find((x) => x.id === id);
        if (st?.groupId) groupIds.add(st.groupId);
        else ofExpense(st?.expenseId);
        break;
      }
      case 'expense_revision':
        ofExpense(d.expenseRevisions.find((x) => x.id === id)?.expenseId);
        break;
      case 'group_activity': {
        const a = d.groupActivityLog.find((x) => x.id === id);
        if (a?.groupId) groupIds.add(a.groupId);
        else ofExpense(a?.entityId);
        break;
      }
      case 'receipt_pointer':
      case 'expense_comment':
        ofExpense(d.expenses.find((e) => (entity === 'receipt_pointer' ? e.receipts : e.comments).some((x) => x.id === id))?.id);
        break;
    }
  }
  return { groupIds: [...groupIds], expenseIds: [...expenseIds] };
}

/** Clears the hlc of refused rows so the server's copy wins the next merge, whatever the local clock. */
export function unpinRows(d: MockLedgerDataset, keys: RowKey[]): MockLedgerDataset {
  const ids = new Set(keys.map(keyOf));
  const unpin = <T extends { id: string; hlc?: string }>(entity: SyncEntityType, rows: T[]) =>
    rows.map((r) => (ids.has(`${entity}:${r.id}`) ? { ...r, hlc: '' } : r));
  return {
    ...d,
    groups: unpin('group', d.groups),
    expenses: unpin('expense', d.expenses).map((e) => ({ ...e, comments: unpin('expense_comment', e.comments) })),
    expenseRevisions: unpin('expense_revision', d.expenseRevisions),
    settlements: unpin('settlement', d.settlements),
    groupActivityLog: unpin('group_activity', d.groupActivityLog),
  };
}

/**
 * Flags refused rows the server never had, keeping them (and anything inside them) on this device so
 * the user can fix and retry or remove them. The flag is local only and never pushed.
 */
export function markRejected(
  d: MockLedgerDataset,
  refused: Array<RowKey & { reason?: string }>,
  mintHlc: () => string
): MockLedgerDataset {
  const why = new Map(refused.map((r) => [keyOf(r), calmReason(r.reason)]));
  // The refetch unpinned these rows; the server never had them, so they get a fresh hlc back.
  const flag = <T extends { id: string; hlc?: string; syncRejection?: string | null }>(entity: SyncEntityType, rows: T[]) =>
    rows.map((r) =>
      why.has(`${entity}:${r.id}`) ? { ...r, hlc: r.hlc || mintHlc(), syncRejection: why.get(`${entity}:${r.id}`)! } : r
    );
  return {
    ...d,
    groups: flag('group', d.groups),
    expenses: flag('expense', d.expenses).map((e) => ({ ...e, comments: flag('expense_comment', e.comments) })),
    settlements: flag('settlement', d.settlements),
  };
}

function calmReason(reason: string | undefined): string {
  const text = (reason ?? '').trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : 'The server did not accept it';
}

/** Removes rows on the user's request (a group takes its contents with it). */
export function dropRows(d: MockLedgerDataset, keys: RowKey[]): MockLedgerDataset {
  const ids = new Set(keys.map(keyOf));
  const has = (entity: SyncEntityType, id: string) => ids.has(`${entity}:${id}`);
  let out = d;
  for (const k of keys) if (k.entity === 'group') out = evictGroupData(out, k.id);
  return {
    ...out,
    groups: out.groups.map((g) => ({ ...g, members: g.members.filter((m) => !has('group_member', m.id)) })),
    expenses: out.expenses
      .filter((e) => !has('expense', e.id))
      .map((e) => ({
        ...e,
        receipts: e.receipts.filter((r) => !has('receipt_pointer', r.id)),
        comments: e.comments.filter((c) => !has('expense_comment', c.id)),
      })),
    expenseRevisions: out.expenseRevisions.filter((r) => !has('expense_revision', r.id) && !has('expense', r.expenseId)),
    settlements: out.settlements.filter((x) => !has('settlement', x.id)),
    groupActivityLog: out.groupActivityLog.filter((a) => !has('group_activity', a.id)),
  };
}

/** Sends mutations at once, outside the outbox, for steps that must wait for the server's answer. */
export async function pushNow(
  token: string,
  mutations: SyncPushMutation[]
): Promise<SyncPushResult[] | 'auth' | 'offline'> {
  const res = await syncFetch('/api/ledger/push', token, { method: 'POST', body: JSON.stringify({ mutations }) });
  if (res?.status === 401) return 'auth';
  if (!res?.ok) return 'offline';
  try {
    const body = (await res.json()) as Partial<SyncPushResponse>;
    return Array.isArray(body.results) ? body.results : 'offline';
  } catch {
    return 'offline';
  }
}

export interface PullOutcome {
  status: SyncCallStatus;
  pulled: number;
}

const orphansKey = (userId: string) => `sync_orphans:${userId}`;

export async function getPendingOrphans(userId: string): Promise<SyncPullChange[]> {
  const stored = await getKvValue<SyncPullChange[]>(orphansKey(userId));
  return Array.isArray(stored) ? stored : [];
}

type PageResult = { status: 'ok'; body: SyncPullResponse } | { status: 'auth' | 'retry' | 'forbidden' };

async function fetchPullPage(query: string, token: string): Promise<PageResult> {
  const res = await syncFetch(`/api/ledger/pull?${query}&limit=${SYNC_PULL_MAX_LIMIT}`, token, { method: 'GET' });
  if (res?.status === 401) return { status: 'auth' };
  if (res?.status === 403) return { status: 'forbidden' };
  if (!res?.ok) return { status: 'retry' };
  try {
    const body = (await res.json()) as SyncPullResponse;
    if (!Array.isArray(body.changes) || !/^\d+$/.test(String(body.nextCursor))) return { status: 'retry' };
    return { status: 'ok', body };
  } catch {
    return { status: 'retry' };
  }
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;

export type BackfillScope = 'group' | 'expense';

export class SessionChangedError extends Error {
  constructor() {
    super('session changed');
  }
}

const belongsTo = (o: SyncPullChange, scope: BackfillScope, id: string) =>
  scope === 'group' ? o.data?.groupId === id : o.data?.expenseId === id;

/**
 * Pages through `/api/ledger/pull` until `hasMore` is false. Groups and direct bills the server
 * lists in `backfillGroupIds` / `backfillExpenseIds` are paged from cursor 0 (once per call) before
 * the main cursor moves on; a 403 on one of them skips it and evicts it locally. Children whose
 * parent has not arrived yet come back from `apply` and are kept in Dexie. Nothing is persisted
 * once `isCurrent` turns false, and the cursor is saved only after every step of a page succeeds.
 */
export async function pullAll(
  userId: string,
  token: string,
  apply: (changes: SyncPullChange[]) => Promise<SyncPullChange[] | void>,
  evict: (scope: BackfillScope, id: string) => Promise<void> = async () => {},
  isCurrent: () => boolean = () => true,
  /** Scopes to re-read from cursor 0 first, for example to bring back the server's copy of refused rows. */
  refetch: { groupIds: string[]; expenseIds: string[] } = { groupIds: [], expenseIds: [] }
): Promise<PullOutcome> {
  const guard = () => {
    if (!isCurrent()) throw new SessionChangedError();
  };
  let cursor = await getSyncCursor(userId);
  let orphans = await getPendingOrphans(userId);
  let pulled = 0;
  const backfilled = new Set<string>();
  const applyPage = async (changes: SyncPullChange[]) => {
    if (changes.length === 0) return;
    guard();
    orphans = (await apply([...orphans, ...changes])) ?? [];
    pulled += changes.length;
  };

  const backfill = async (scope: BackfillScope, id: string, evictOnForbidden = true): Promise<SyncCallStatus> => {
    const key = `${scope}:${id}`;
    if (!SAFE_ID.test(id) || backfilled.has(key)) return 'ok';
    backfilled.add(key);
    const param = scope === 'group' ? 'groupId' : 'expenseId';
    let scopeCursor = '0';
    for (;;) {
      const fill = await fetchPullPage(`${param}=${encodeURIComponent(id)}&cursor=${scopeCursor}`, token);
      if (fill.status === 'forbidden') {
        if (!evictOnForbidden) return 'ok';
        guard();
        orphans = orphans.filter((o) => !belongsTo(o, scope, id));
        await evict(scope, id);
        return 'ok';
      }
      if (fill.status !== 'ok') return fill.status;
      await applyPage(fill.body.changes);
      const next = String(fill.body.nextCursor);
      if (!fill.body.hasMore || next === scopeCursor) return 'ok';
      scopeCursor = next;
    }
  };

  for (const [scope, ids] of [['group', refetch.groupIds], ['expense', refetch.expenseIds]] as const) {
    for (const id of ids) {
      const status = await backfill(scope, id, false);
      if (status !== 'ok') return { status, pulled };
    }
  }

  for (;;) {
    const page = await fetchPullPage(`cursor=${encodeURIComponent(cursor)}`, token);
    if (page.status !== 'ok') return { status: page.status === 'forbidden' ? 'retry' : page.status, pulled };
    await applyPage(page.body.changes);

    for (const [scope, ids] of [
      ['group', page.body.backfillGroupIds],
      ['expense', page.body.backfillExpenseIds],
    ] as const) {
      for (const id of ids ?? []) {
        const status = await backfill(scope, id);
        if (status !== 'ok') return { status, pulled };
      }
    }

    guard();
    await setKvValue(orphansKey(userId), orphans);
    guard();
    const nextCursor = String(page.body.nextCursor);
    await setSyncCursor(userId, nextCursor);
    if (!page.body.hasMore || nextCursor === cursor) return { status: 'ok', pulled };
    cursor = nextCursor;
  }
}
