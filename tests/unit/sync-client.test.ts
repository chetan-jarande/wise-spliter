import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import mockData from '../../src/data/mock-ledger-data.json';
import type { MockLedgerDataset } from '../../src/types/ledger';
import {
  SYNC_PUSH_MAX_MUTATIONS,
  type SyncPullChange,
  type SyncPushMutation,
  type SyncPushStatus,
} from '../../src/types/sync-contract';
import {
  clearSyncOutbox,
  commitLocalChanges,
  deleteReceiptBlobsOwnedBy,
  enqueueSyncOutboxMutations,
  getLocalReceiptBlobsForExpense,
  isQuotaError,
  loadLegacyDexieSnapshot,
  loadLocalDataset,
  migrateLegacyOutboxComments,
  reassignReceiptBlobs,
  removeSyncOutboxMutations,
  setReceiptOwner,
  getDeviceId,
  getLocalDb,
  getSyncCursor,
  listSyncOutboxMutations,
  saveDatasetToIndexedDb,
  saveReceiptBlobLocally,
  setKvValue,
  setSyncCursor,
  wipeUserScopedData,
} from '../../src/storage/local-db';
import {
  SYNC_PUSH_MAX_BYTES,
  SessionChangedError,
  diffDatasetToMutations,
  evictExpenseData,
  evictGroupData,
  getPendingOrphans,
  getPushBatchSize,
  keepOnlyIds,
  makeHlc,
  mergePullChanges,
  newId,
  observeHlc,
  pullAll,
  pushNow,
  pushOutbox,
  resetPushBatchSize,
  setHlcDeviceId,
  takeServerVersions,
  convertQueuedToBase,
  dropRows,
  markRejected,
  scopesOf,
  unpinRows,
} from '../../src/sync-engine/sync-client';
import { randomHex } from '../../src/utils/ids';
import {
  adoptLocalIdentity,
  hasLocalData,
  recordedConversionRate,
  revisionInCurrentCurrency,
  takeLocalData,
  withExtraRows,
} from '../../src/state/ledger-transforms';
import { redenominateExpenseCurrency } from '../../src/domain/splits/split-calculator';
import type { ExpenseRevision, UserProfile } from '../../src/types/ledger';
import { isGroupAdminFor } from '../../src/utils/group-permissions';
import {
  canDeleteDirectSettlement,
  canRecordDirectSettlement,
  planDirectSettlements,
} from '../../src/utils/direct-settlements';
import { computeCrossGroupFriendsSummary } from '../../src/domain/ledger/ledger-engine';
import type { ExpenseItem, SettlementItem } from '../../src/types/ledger';
import {
  loadPersistedSession,
  resolveSessionToken,
  setBackendSessionToken,
} from '../../src/sync-engine/supabase-sync';

const clone = (): MockLedgerDataset => JSON.parse(JSON.stringify(mockData)) as MockLedgerDataset;

const mutation = (i: number, entity: SyncPushMutation['entity'] = 'expense'): SyncPushMutation => ({
  entity,
  id: `e${i}`,
  op: 'upsert',
  hlc: `019a73a00100-${i.toString(16).padStart(4, '0')}-usr_t`,
  data: { id: `e${i}` },
});

type FetchHandler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;
const realFetch = globalThis.fetch;
const calls: Array<{ url: string; init: RequestInit | undefined }> = [];

function mockFetch(handler: FetchHandler) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const pushedMutations = (init: RequestInit | undefined) =>
  (JSON.parse(String(init?.body)) as { mutations: SyncPushMutation[] }).mutations;

const ackAll =
  (status: (m: SyncPushMutation) => SyncPushStatus = () => 'applied'): FetchHandler =>
  (_url, init) =>
    json({ results: pushedMutations(init).map((m) => ({ entity: m.entity, id: m.id, status: status(m) })) });

beforeEach(async () => {
  calls.length = 0;
  resetPushBatchSize();
  await clearSyncOutbox();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('outbox batching', () => {
  it('drains the outbox in batches of at most SYNC_PUSH_MAX_MUTATIONS with bearer auth', async () => {
    await enqueueSyncOutboxMutations(Array.from({ length: 450 }, (_, i) => mutation(i)));
    mockFetch(ackAll());

    const outcome = await pushOutbox('tok_user');

    expect(outcome).toMatchObject({ status: 'ok', applied: 450, stale: 0, rejected: [] });
    expect(calls.map((c) => pushedMutations(c.init).length)).toEqual([200, 200, 50]);
    expect(calls.every((c) => c.url.endsWith('/api/ledger/push'))).toBe(true);
    expect(new Headers(calls[0]!.init?.headers).get('Authorization')).toBe('Bearer tok_user');
    expect(SYNC_PUSH_MAX_MUTATIONS).toBe(200);
    expect(await listSyncOutboxMutations()).toHaveLength(0);
  });

  it('halves the batch after a 503 until it fits, then grows back gradually', async () => {
    await enqueueSyncOutboxMutations(Array.from({ length: 300 }, (_, i) => mutation(i)));
    mockFetch((url, init) =>
      pushedMutations(init).length > 50 ? json({ error: 'batch aborted' }, 503) : ackAll()(url, init)
    );

    const statuses: string[] = [];
    for (let attempt = 0; attempt < 30 && (await listSyncOutboxMutations()).length > 0; attempt++) {
      statuses.push((await pushOutbox('tok')).status);
    }
    const sizes = calls.map((c) => pushedMutations(c.init).length);

    expect(sizes.slice(0, 4)).toEqual([200, 100, 50, 62]);
    expect(statuses.slice(0, 2)).toEqual(['retry', 'retry']);
    expect(await listSyncOutboxMutations()).toHaveLength(0);
    expect(sizes.reduce((a, n) => a + (n <= 50 ? n : 0), 0)).toBe(300);

    await enqueueSyncOutboxMutations([mutation(999)]);
    mockFetch(() => json({ error: 'aborted' }, 503));
    for (let i = 0; i < 3; i++) await pushOutbox('tok');
    expect(getPushBatchSize()).toBe(1);
  });

  it('caps each batch by bytes as well as count', async () => {
    const big = (i: number): SyncPushMutation => ({ ...mutation(i), data: { id: `e${i}`, notes: 'x'.repeat(100_000) } });
    await enqueueSyncOutboxMutations([0, 1, 2, 3, 4].map(big));
    mockFetch(ackAll());

    await pushOutbox('tok');

    expect(calls.map((c) => pushedMutations(c.init).length)).toEqual([2, 2, 1]);
    expect(calls.every((c) => String(c.init?.body).length < SYNC_PUSH_MAX_BYTES + 1024)).toBe(true);
  });

  it('a 429 retries later without shrinking the batch', async () => {
    await enqueueSyncOutboxMutations(Array.from({ length: 10 }, (_, i) => mutation(i)));
    mockFetch(() => json({ error: 'busy' }, 429));
    expect((await pushOutbox('tok')).status).toBe('retry');
    expect(getPushBatchSize()).toBe(SYNC_PUSH_MAX_MUTATIONS);
    expect(await listSyncOutboxMutations()).toHaveLength(10);
  });

  it('halves on 413, and drops a lone mutation the server still refuses as too large', async () => {
    await enqueueSyncOutboxMutations([mutation(1), mutation(2)]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockFetch((url, init) =>
      pushedMutations(init).some((m) => m.id === 'e1') ? json({ error: 'too large' }, 413) : ackAll()(url, init)
    );

    expect((await pushOutbox('tok')).status).toBe('retry');
    expect(getPushBatchSize()).toBe(1);
    const second = await pushOutbox('tok');

    expect(second.status).toBe('ok');
    expect(second.rejected).toEqual([{ entity: 'expense', id: 'e1', status: 'invalid', reason: 'too large to sync' }]);
    expect(second.applied).toBe(1);
    expect(warn).toHaveBeenCalled();
    expect(await listSyncOutboxMutations()).toHaveLength(0);
  });

  it('coalesces repeat edits to one row per entity and keeps first-enqueued order', async () => {
    await enqueueSyncOutboxMutations([mutation(1, 'group'), mutation(2, 'expense')]);
    await enqueueSyncOutboxMutations([{ ...mutation(1, 'group'), hlc: '019a73a00200-0000-usr_t' }]);

    const rows = await listSyncOutboxMutations();
    expect(rows.map((r) => r.id)).toEqual(['group:e1', 'expense:e2']);
    expect(rows[0]!.mutation.hlc).toBe('019a73a00200-0000-usr_t');
  });

  it('keeps a newer local edit that was enqueued while the older version was in flight', async () => {
    await enqueueSyncOutboxMutations([mutation(1)]);
    mockFetch(async (url, init) => {
      if (calls.length === 1) {
        await enqueueSyncOutboxMutations([{ ...mutation(1), hlc: '019a73a00900-0000-usr_t' }]);
        return ackAll()(url, init);
      }
      return json({ results: [] });
    });

    const outcome = await pushOutbox('tok');
    const rows = await listSyncOutboxMutations();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.mutation.hlc).toBe('019a73a00900-0000-usr_t');
    expect(outcome.status).toBe('retry');
  });
});

describe('push status handling', () => {
  it('removes applied and stale, drops forbidden and invalid with a warning, keeps unanswered rows', async () => {
    await enqueueSyncOutboxMutations([mutation(1), mutation(2), mutation(3), mutation(4), mutation(5)]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const statuses: Record<string, SyncPushStatus> = { e1: 'applied', e2: 'stale', e3: 'forbidden', e4: 'invalid' };
    mockFetch((_url, init) =>
      json({
        results: pushedMutations(init)
          .filter((m) => statuses[m.id])
          .map((m) => ({ entity: m.entity, id: m.id, status: statuses[m.id] })),
      })
    );

    const outcome = await pushOutbox('tok');

    expect(outcome.applied).toBe(1);
    expect(outcome.stale).toBe(1);
    expect(outcome.rejected.map((r) => r.id)).toEqual(['e3', 'e4']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect((await listSyncOutboxMutations()).map((r) => r.id)).toEqual(['expense:e5']);
    expect(outcome.status).toBe('retry');
  });

  it('stale with someone else\'s serverHlc is a conflict and advances the clock; our own echoed hlc is not', async () => {
    const otherHlc = `${(Date.now() + 5_000).toString(16).padStart(12, '0')}-0003-usr_other_dev2`;
    await enqueueSyncOutboxMutations([mutation(1), mutation(2)]);
    mockFetch((_url, init) =>
      json({
        results: pushedMutations(init).map((m) => ({
          entity: m.entity,
          id: m.id,
          status: 'stale',
          serverHlc: m.id === 'e1' ? otherHlc : m.hlc,
        })),
      })
    );

    const outcome = await pushOutbox('tok');

    expect(outcome.stale).toBe(2);
    expect(outcome.conflicts.map((c) => [c.mutation.id, c.serverHlc])).toEqual([['e1', otherHlc]]);
    expect(makeHlc('usr_t') > otherHlc).toBe(true);
    expect(await listSyncOutboxMutations()).toHaveLength(0);
  });

  it('stops pushing when the session changes mid-flush', async () => {
    await enqueueSyncOutboxMutations(Array.from({ length: 250 }, (_, i) => mutation(i)));
    let current = true;
    mockFetch((url, init) => {
      current = false;
      return ackAll()(url, init);
    });

    await pushOutbox('tok', () => current);

    expect(calls).toHaveLength(1);
    expect(await listSyncOutboxMutations()).toHaveLength(50);
  });
});

describe('dataset diff to mutations', () => {
  it('emits only dirty entities, parents first, deletes as op delete, and no receipt bytes', () => {
    const prev = clone();
    const next = clone();
    const group = next.groups[0]!;
    group.name = 'Renamed';
    group.hlc = '019b00000000-0000-usr_t';
    group.lastAccessedAt = '2030-01-01T00:00:00.000Z';
    const untouchedHlcGroup = next.groups[1]!;
    untouchedHlcGroup.lastAccessedAt = '2030-01-01T00:00:00.000Z';
    group.members = [
      ...group.members,
      { ...group.members[0]!, id: 'mem_new', displayName: 'New Friend', userId: null },
    ];
    const deleted = next.expenses[0]!;
    deleted.deletedAt = '2030-01-01T00:00:00.000Z';
    deleted.hlc = '019b00000000-0001-usr_t';
    const withReceipt = next.expenses[1]!;
    withReceipt.hlc = '019b00000000-0002-usr_t';
    withReceipt.receipts = [
      {
        id: 'rcp_1',
        expenseId: withReceipt.id,
        fileName: 'r.webp',
        mimeType: 'image/webp',
        sizeKb: 3,
        uploadedByName: 'A',
        createdAt: '2030-01-01T00:00:00.000Z',
        previewNote: '',
        dataUrl: 'data:image/webp;base64,AAAA',
      },
    ];

    const out = diffDatasetToMutations(prev, next, 'usr_t');

    expect(out.map((m) => `${m.entity}:${m.id}:${m.op}`)).toEqual([
      `group:${group.id}:upsert`,
      'group_member:mem_new:upsert',
      `expense:${deleted.id}:delete`,
      `expense:${withReceipt.id}:upsert`,
      'receipt_pointer:rcp_1:upsert',
    ]);
    expect(out[0]!.data).not.toHaveProperty('members');
    expect(out[1]!.hlc).toBe(group.hlc);
    expect(out[2]!.data).toBeNull();
    expect(JSON.stringify(out)).not.toContain('data:image/');
    expect(diffDatasetToMutations(next, next, 'usr_t')).toEqual([]);
  });
});

describe('group row is only pushed for real group edits', () => {
  it('an expense action (expenseSeq bump, lastAccessedAt) produces no group mutation', () => {
    const prev = clone();
    const next = clone();
    next.groups[0]!.expenseSeq += 1;
    next.groups[0]!.lastAccessedAt = '2031-01-01T00:00:00.000Z';
    next.expenses = [{ ...next.expenses[0]!, id: 'exp_new', hlc: '019c00000000-0000-usr_t', receipts: [] }, ...next.expenses];

    const out = diffDatasetToMutations(prev, next, 'usr_t');

    expect(out.map((m) => m.entity)).toEqual(['expense']);
  });

  it('a single-field group edit sends only that field plus id, hlc and updatedAt; a new group sends its full row', () => {
    const prev = clone();
    const next = clone();
    const g = next.groups[0]!;
    g.simplifyDebts = !g.simplifyDebts;
    g.hlc = '019c00000000-0003-usr_t';
    const [m] = diffDatasetToMutations(prev, next, 'usr_t');
    expect(m!.data).toEqual({ id: g.id, hlc: g.hlc, simplifyDebts: g.simplifyDebts });

    g.updatedAt = '2031-01-01T00:00:00.000Z';
    expect(Object.keys(diffDatasetToMutations(prev, next, 'usr_t')[0]!.data!).sort()).toEqual(['hlc', 'id', 'simplifyDebts', 'updatedAt']);

    const created = clone();
    created.groups = [{ ...created.groups[0]!, id: 'grp_fresh', members: [] }, ...created.groups];
    const fresh = diffDatasetToMutations(clone(), created, 'usr_t').find((x) => x.id === 'grp_fresh')!;
    expect(fresh.data).toMatchObject({ id: 'grp_fresh', name: created.groups[0]!.name, baseCurrency: created.groups[0]!.baseCurrency });
  });

  it('un-deleting a group is pushed as op restore', () => {
    const prev = clone();
    prev.groups[0]!.deletedAt = '2030-01-01T00:00:00.000Z';
    const next = clone();
    next.groups[0]!.hlc = '019c00000000-0002-usr_t';
    const [m] = diffDatasetToMutations(prev, next, 'usr_t');
    expect([m!.entity, m!.op]).toEqual(['group', 'restore']);
  });

  it('a real group edit pushes the group without per-device fields', () => {
    const prev = clone();
    const next = clone();
    next.groups[0]!.simplifyDebts = !next.groups[0]!.simplifyDebts;
    next.groups[0]!.hlc = '019c00000000-0001-usr_t';
    const [m] = diffDatasetToMutations(prev, next, 'usr_t');
    expect(m!.entity).toBe('group');
    expect(m!.data).not.toHaveProperty('lastAccessedAt');
    expect(m!.data).not.toHaveProperty('members');
  });
});

describe('backup restore baseline', () => {
  it('pushes the user\'s own restored rows but never the bundled sample rows', () => {
    const sample = clone();
    const sampleIds = new Set<string>([
      ...sample.groups.flatMap((g) => [g.id, ...g.members.map((m) => m.id)]),
      ...sample.expenses.flatMap((e) => [e.id, ...e.receipts.map((r) => r.id)]),
      ...sample.expenseRevisions.map((r) => r.id),
      ...sample.settlements.map((x) => x.id),
      ...sample.groupActivityLog.map((a) => a.id),
    ]);
    const restored = clone();
    restored.expenses = [{ ...restored.expenses[0]!, id: 'exp_mine', receipts: [] }, ...restored.expenses];

    const out = diffDatasetToMutations(keepOnlyIds(restored, sampleIds), restored, 'usr_t');

    expect(out.map((m) => `${m.entity}:${m.id}`)).toEqual(['expense:exp_mine']);
  });
});

describe('pull merge (LWW by HLC)', () => {
  const base = clone();
  const expense = base.expenses[1]!;
  const change = (c: Partial<SyncPullChange>): SyncPullChange => ({
    entity: 'expense',
    id: expense.id,
    serverSeq: '1',
    deleted: false,
    data: null,
    ...c,
  });

  it('applies newer and equal remote HLCs, ignores older ones', () => {
    const older = mergePullChanges(base, [
      change({ data: { ...expense, title: 'Old', hlc: '000000000001-0000-usr_x' } }),
    ]);
    expect(older.expenses.find((e) => e.id === expense.id)!.title).toBe(expense.title);
    expect(older).not.toBe(base);

    const newer = mergePullChanges(base, [
      change({ data: { ...expense, title: 'New', hlc: 'ffffffffffff-0000-usr_x' } }),
    ]);
    expect(newer.expenses.find((e) => e.id === expense.id)!.title).toBe('New');

    const tie = mergePullChanges(base, [change({ data: { ...expense, title: 'Tie', hlc: expense.hlc } })]);
    expect(tie.expenses.find((e) => e.id === expense.id)!.title).toBe('Tie');
  });

  it('takes the server invite code even when a newer local group edit wins', () => {
    const local = clone();
    const g = local.groups[0]!;
    g.hlc = 'ffffffffffff-0000-usr_t';
    g.inviteCode = 'PROVISIONAL';
    const merged = mergePullChanges(local, [
      { entity: 'group', id: g.id, serverSeq: '1', deleted: false, data: { ...g, members: undefined, name: 'Old', inviteCode: 'SRV-CODE', hlc: '000000000001-0000-x' } },
    ]);
    expect(merged.groups[0]!.inviteCode).toBe('SRV-CODE');
    expect(merged.groups[0]!.name).toBe(g.name);
  });

  it('a tombstone for my own membership evicts the whole group; an unbilled other member is dropped', () => {
    const d = clone();
    const g = d.groups[0]!;
    const mine = { ...g.members[0]!, userId: 'usr_self' };
    g.members = [mine, ...g.members.slice(1)];
    const other = g.members[1]!;

    const unreferenced = { ...g.members[1]!, id: 'mem_never_billed' };
    g.members.push(unreferenced);
    const afterUnref = mergePullChanges(d, [{ entity: 'group_member', id: unreferenced.id, serverSeq: '1', deleted: true, data: null }], [], 'usr_self');
    expect(afterUnref.groups.find((x) => x.id === g.id)!.members.some((m) => m.id === unreferenced.id)).toBe(false);
    expect(afterUnref.expenses.some((e) => e.groupId === g.id)).toBe(true);

    const afterMine = mergePullChanges(d, [{ entity: 'group_member', id: mine.id, serverSeq: '2', deleted: false, data: { ...mine, removedAt: '2030-01-01T00:00:00.000Z' } }], [], 'usr_self');
    expect(afterMine.groups.some((x) => x.id === g.id)).toBe(false);
    expect(afterMine.expenses.some((e) => e.groupId === g.id)).toBe(false);
    expect(afterMine.settlements.some((s) => s.groupId === g.id)).toBe(false);
  });

  it('evicting a direct bill drops it with its settlements, revisions and activity only', () => {
    const d = clone();
    const bill = d.expenses.find((e) => e.groupId === null)!;
    d.settlements = [{ ...d.settlements[0]!, id: 'stl_b', groupId: null, expenseId: bill.id }, ...d.settlements];
    d.groupActivityLog = [{ ...d.groupActivityLog[0]!, id: 'act_b', entityId: 'stl_b' }, ...d.groupActivityLog];
    const out = evictExpenseData(d, bill.id);
    expect(out.expenses.some((e) => e.id === bill.id)).toBe(false);
    expect(out.settlements.some((s) => s.id === 'stl_b')).toBe(false);
    expect(out.expenseRevisions.some((r) => r.expenseId === bill.id)).toBe(false);
    expect(out.groupActivityLog.some((a) => a.id === 'act_b' || a.entityId === bill.id)).toBe(false);
    expect(out.expenses).toHaveLength(d.expenses.length - 1);
    expect(out.settlements).toHaveLength(d.settlements.length - 1);
  });

  it('keeps the larger expenseSeq when a pulled group wins', () => {
    const d = clone();
    const g = d.groups[0]!;
    g.expenseSeq = 40;
    const merged = mergePullChanges(d, [
      { entity: 'group', id: g.id, serverSeq: '1', deleted: false, data: { ...g, members: undefined, expenseSeq: 12, hlc: 'ffffffffffff-0000-x' } },
    ]);
    expect(merged.groups[0]!.expenseSeq).toBe(40);
  });

  it('advances the local clock past remote HLCs', () => {
    const near = `${(Date.now() + 10_000).toString(16).padStart(12, '0')}-0005-usr_x`;
    observeHlc(near);
    expect(makeHlc('usr_t') > near).toBe(true);
  });

  it('never mints HLCs more than 60 s ahead, even after observing a far-future one', () => {
    observeHlc('fffffffffff0-0005-usr_x');
    const ms = parseInt(makeHlc('usr_t').slice(0, 12), 16);
    expect(ms).toBeLessThanOrEqual(Date.now() + 60_000);
    const a = makeHlc('usr_t');
    const b = makeHlc('usr_t');
    expect(b > a).toBe(true);
  });

  it('inserts unknown entities and re-nests group_member rows under their group', () => {
    const group = base.groups[0]!;
    const merged = mergePullChanges(base, [
      change({ entity: 'settlement', id: 'stl_remote', data: { ...base.settlements[0]!, id: 'stl_remote', hlc: '019b00000000-0000-x' } }),
      change({ entity: 'group_member', id: 'mem_remote', data: { ...group.members[0]!, id: 'mem_remote', groupId: group.id, hlc: '019b00000000-0000-x' } }),
    ]);
    expect(merged.settlements[0]!.id).toBe('stl_remote');
    expect(merged.groups[0]!.members.map((m) => m.id)).toContain('mem_remote');
  });

  it('keeps local receipt bytes when a remote expense arrives without them', () => {
    const local = clone();
    local.expenses[1]!.receipts = [
      { id: 'rcp_1', expenseId: expense.id, fileName: 'r', mimeType: 'image/webp', sizeKb: 1, uploadedByName: 'A', createdAt: '', previewNote: '', dataUrl: 'data:image/webp;base64,AA' },
    ];
    const { dataUrl: _omit, ...pointer } = local.expenses[1]!.receipts[0]!;
    const merged = mergePullChanges(local, [
      change({ data: { ...expense, receipts: [pointer], hlc: 'ffffffffffff-0000-usr_x' } }),
    ]);
    expect(merged.expenses[1]!.receipts[0]!.dataUrl).toBe('data:image/webp;base64,AA');
  });
});

describe('tombstones', () => {
  const base = clone();

  it('soft-deletes expenses, settlements and groups so Trash still works', () => {
    const merged = mergePullChanges(base, [
      { entity: 'expense', id: base.expenses[1]!.id, serverSeq: '2', deleted: true, data: null },
      { entity: 'settlement', id: base.settlements[0]!.id, serverSeq: '3', deleted: true, data: null },
      { entity: 'group', id: base.groups[0]!.id, serverSeq: '4', deleted: true, data: null },
    ]);
    expect(merged.expenses[1]!.deletedAt).toEqual(expect.any(String));
    expect(merged.settlements[0]!.deletedAt).toEqual(expect.any(String));
    expect(merged.groups[0]!.deletedAt).toEqual(expect.any(String));
    expect(merged.groups[0]!.members).toEqual(base.groups[0]!.members);
  });

  it('removes activity and revisions, keeps a billed member as former, and ignores tombstones for unknown rows', () => {
    const member = base.groups[0]!.members[1]!;
    const merged = mergePullChanges(base, [
      { entity: 'group_activity', id: base.groupActivityLog[0]!.id, serverSeq: '5', deleted: true, data: null },
      { entity: 'expense_revision', id: base.expenseRevisions[0]!.id, serverSeq: '6', deleted: true, data: null },
      { entity: 'group_member', id: member.id, serverSeq: '7', deleted: true, data: null },
      { entity: 'expense', id: 'exp_unknown', serverSeq: '8', deleted: true, data: null },
    ]);
    expect(merged.groupActivityLog.some((a) => a.id === base.groupActivityLog[0]!.id)).toBe(false);
    expect(merged.expenseRevisions.some((r) => r.id === base.expenseRevisions[0]!.id)).toBe(false);
    expect(merged.groups[0]!.members.find((m) => m.id === member.id)!.removedAt).toEqual(expect.any(String));
    expect(merged.expenses).toHaveLength(base.expenses.length);
  });

  it('a newer local edit survives an older tombstone that carries data', () => {
    const exp = base.expenses[1]!;
    const merged = mergePullChanges(base, [
      { entity: 'expense', id: exp.id, serverSeq: '9', deleted: true, data: { ...exp, hlc: '000000000001-0000-x' } },
    ]);
    expect(merged.expenses[1]!.deletedAt).toBeNull();
  });
});

describe('cursor pull loop', () => {
  it('pages until hasMore is false and persists the cursor per user', async () => {
    await setSyncCursor('usr_a', '0');
    await setSyncCursor('usr_b', '77');
    const pages = [
      { changes: [{ entity: 'expense', id: 'x1', serverSeq: '10', deleted: false, data: {} }], nextCursor: '10', hasMore: true },
      { changes: [{ entity: 'expense', id: 'x2', serverSeq: '20', deleted: false, data: {} }], nextCursor: '20', hasMore: true },
      { changes: [], nextCursor: '20', hasMore: false },
    ];
    mockFetch(() => json(pages[calls.length - 1]));
    const applied: string[] = [];

    const outcome = await pullAll('usr_a', 'tok', async (changes) => {
      applied.push(...changes.map((c) => c.id));
    });

    expect(outcome).toEqual({ status: 'ok', pulled: 2 });
    expect(applied).toEqual(['x1', 'x2']);
    expect(calls.map((c) => new URL(c.url, 'http://x').searchParams.get('cursor'))).toEqual(['0', '10', '20']);
    expect(await getSyncCursor('usr_a')).toBe('20');
    expect(await getSyncCursor('usr_b')).toBe('77');
  });

  it('does not advance the cursor past a page it failed to apply or fetch', async () => {
    await setSyncCursor('usr_c', '5');
    mockFetch(() => json({ changes: [{ entity: 'group', id: 'g', serverSeq: '9', deleted: false, data: {} }], nextCursor: '9', hasMore: true }));
    await expect(pullAll('usr_c', 'tok', () => Promise.reject(new Error('switched')))).rejects.toThrow('switched');
    expect(await getSyncCursor('usr_c')).toBe('5');

    mockFetch(() => json({ error: 'expired' }, 401));
    expect((await pullAll('usr_c', 'tok', async () => {})).status).toBe('auth');
    mockFetch(() => json({ changes: 'bad', nextCursor: 'x', hasMore: false }));
    expect((await pullAll('usr_c', 'tok', async () => {})).status).toBe('retry');
    expect(await getSyncCursor('usr_c')).toBe('5');
  });
});

describe('orphan children', () => {
  const empty = (): MockLedgerDataset => ({
    ...clone(),
    groups: [],
    expenses: [],
    expenseRevisions: [],
    settlements: [],
    groupActivityLog: [],
  });
  const src = clone();
  const group = src.groups[0]!;
  const member = group.members[1]!;
  const exp = src.expenses[1]!;
  const groupChange = (seq: string): SyncPullChange => ({
    entity: 'group', id: group.id, serverSeq: seq, deleted: false, data: { ...group, members: undefined, hlc: '019b00000000-0000-x' },
  });
  const memberChange = (seq: string, extra: Record<string, unknown> = {}): SyncPullChange => ({
    entity: 'group_member', id: member.id, serverSeq: seq, deleted: false, data: { ...member, ...extra },
  });

  it('attaches a member that precedes its group in the same page', () => {
    const merged = mergePullChanges(empty(), [memberChange('1'), groupChange('2')]);
    expect(merged.groups[0]!.members.map((m) => m.id)).toEqual([member.id]);
  });

  it('buffers members and receipt pointers whose parent is missing instead of dropping them', () => {
    const orphans: SyncPullChange[] = [];
    const pointer: SyncPullChange = {
      entity: 'receipt_pointer', id: 'rcp_o', serverSeq: '3', deleted: false,
      data: { id: 'rcp_o', expenseId: exp.id, fileName: 'r', mimeType: 'image/webp', sizeKb: 1, uploadedByName: 'A', createdAt: '', previewNote: '' },
    };
    const gone: SyncPullChange = { ...memberChange('4'), id: 'mem_gone', deleted: true, data: null };
    const first = mergePullChanges(empty(), [memberChange('1'), pointer, gone], orphans);
    expect(first.groups).toHaveLength(0);
    expect(orphans.map((o) => o.id)).toEqual([member.id, 'rcp_o']);

    const later: SyncPullChange[] = [];
    const second = mergePullChanges(first, [
      ...orphans,
      groupChange('9'),
      { entity: 'expense', id: exp.id, serverSeq: '10', deleted: false, data: { ...exp, receipts: [], hlc: '019b00000000-0001-x' } },
    ], later);
    expect(later).toEqual([]);
    expect(second.groups[0]!.members.map((m) => m.id)).toEqual([member.id]);
    expect(second.expenses[0]!.receipts.map((r) => r.id)).toEqual(['rcp_o']);
  });

  it('a newer change for the same member supersedes a buffered orphan', () => {
    const merged = mergePullChanges(empty(), [
      memberChange('1', { displayName: 'Old Name' }),
      groupChange('5'),
      memberChange('7', { displayName: 'New Name' }),
    ]);
    expect(merged.groups[0]!.members[0]!.displayName).toBe('New Name');
  });

  it('pullAll keeps orphans in Dexie across pages and attaches them when the parent page arrives', async () => {
    await setSyncCursor('usr_o', '0');
    let snapshotAfterPage1: SyncPullChange[] = [];
    const pages = [
      { changes: [memberChange('11')], nextCursor: '11', hasMore: true },
      { changes: [groupChange('12')], nextCursor: '12', hasMore: false },
    ];
    mockFetch(async () => {
      if (calls.length === 2) snapshotAfterPage1 = await getPendingOrphans('usr_o');
      return json(pages[calls.length - 1]);
    });
    let local = empty();

    const outcome = await pullAll('usr_o', 'tok', async (changes) => {
      const orphans: SyncPullChange[] = [];
      local = mergePullChanges(local, changes, orphans);
      return orphans;
    });

    expect(outcome.status).toBe('ok');
    expect(snapshotAfterPage1.map((o) => o.id)).toEqual([member.id]);
    expect(local.groups[0]!.members.map((m) => m.id)).toEqual([member.id]);
    expect(await getPendingOrphans('usr_o')).toEqual([]);
  });
});

describe('join gap', () => {
  const src = clone();
  const group = src.groups[0]!;
  const me = { ...group.members[0]!, userId: 'usr_join' };
  const ownMember = (seq: string): SyncPullChange => ({
    entity: 'group_member', id: me.id, serverSeq: seq, deleted: false, data: { ...me },
  });
  const groupRow: SyncPullChange = {
    entity: 'group', id: group.id, serverSeq: '3', deleted: false, data: { ...group, members: undefined, hlc: '019b00000000-0000-x' },
  };
  const applyTo = (holder: { d: MockLedgerDataset }) => async (changes: SyncPullChange[]) => {
    const orphans: SyncPullChange[] = [];
    holder.d = mergePullChanges(holder.d, changes, orphans);
    return orphans;
  };
  const emptyLocal = (): { d: MockLedgerDataset } => ({ d: { ...clone(), groups: [], expenses: [], expenseRevisions: [], settlements: [], groupActivityLog: [] } });

  const params = () => calls.map((c) => new URL(c.url, 'http://x').searchParams);

  it('backfills groups the server reports as newly joined before moving the main cursor', async () => {
    await setSyncCursor('usr_join', '50');
    mockFetch((url) => {
      const q = new URL(url, 'http://x').searchParams;
      if (q.get('groupId') === group.id) {
        return q.get('cursor') === '0'
          ? json({ changes: [groupRow], nextCursor: '3', hasMore: true, backfillGroupIds: [] })
          : json({ changes: [], nextCursor: '3', hasMore: false, backfillGroupIds: [] });
      }
      return json({ changes: [ownMember('60')], nextCursor: '60', hasMore: false, backfillGroupIds: [group.id, '../bad'] });
    });
    const local = emptyLocal();

    const outcome = await pullAll('usr_join', 'tok', applyTo(local));

    expect(outcome.status).toBe('ok');
    expect(params().map((q) => `${q.get('groupId') ?? 'main'}@${q.get('cursor')}`)).toEqual([
      'main@50',
      `${group.id}@0`,
      `${group.id}@3`,
    ]);
    expect(local.d.groups[0]!.members.map((m) => m.id)).toEqual([me.id]);
    expect(await getSyncCursor('usr_join')).toBe('60');
    expect(await getPendingOrphans('usr_join')).toEqual([]);
  });

  it('backfills each group once per sync loop even if several main pages list it', async () => {
    await setSyncCursor('usr_join3', '50');
    mockFetch((url) => {
      const q = new URL(url, 'http://x').searchParams;
      if (q.get('groupId')) return json({ changes: [groupRow], nextCursor: '3', hasMore: false, backfillGroupIds: [] });
      return q.get('cursor') === '50'
        ? json({ changes: [ownMember('60')], nextCursor: '60', hasMore: true, backfillGroupIds: [group.id] })
        : json({ changes: [], nextCursor: '61', hasMore: false, backfillGroupIds: [group.id] });
    });

    await pullAll('usr_join3', 'tok', applyTo(emptyLocal()));

    expect(params().filter((q) => q.get('groupId')).length).toBe(1);
    expect(await getSyncCursor('usr_join3')).toBe('61');
  });

  it('a 403 on a group backfill skips and evicts that group without blocking the main cursor', async () => {
    await setSyncCursor('usr_lost', '50');
    await setKvValue('sync_orphans:usr_lost', [
      { entity: 'group_member', id: 'mem_orphan', serverSeq: '9', deleted: false, data: { id: 'mem_orphan', groupId: 'grp_lost' } },
    ]);
    mockFetch((url) => {
      const q = new URL(url, 'http://x').searchParams;
      if (q.get('groupId') === 'grp_lost') return json({ error: 'forbidden' }, 403);
      if (q.get('groupId') === group.id) return json({ changes: [groupRow], nextCursor: '3', hasMore: false, backfillGroupIds: [] });
      return json({ changes: [ownMember('60')], nextCursor: '60', hasMore: false, backfillGroupIds: ['grp_lost', group.id] });
    });
    const evicted: string[] = [];
    const local = emptyLocal();

    const outcome = await pullAll('usr_lost', 'tok', applyTo(local), async (scope, id) => {
      evicted.push(`${scope}:${id}`);
    });

    expect(outcome.status).toBe('ok');
    expect(evicted).toEqual(['group:grp_lost']);
    expect(params().filter((q) => q.get('groupId') === 'grp_lost')).toHaveLength(1);
    expect(local.d.groups[0]!.members.map((m) => m.id)).toEqual([me.id]);
    expect(await getSyncCursor('usr_lost')).toBe('60');
    expect((await getPendingOrphans('usr_lost')).map((o) => o.id)).toEqual([]);
  });

  it('evicting a group drops it and everything scoped to it, and the shared baseline pushes nothing', () => {
    const d = clone();
    const gid = d.groups[0]!.id;
    const out = evictGroupData(d, gid);
    expect(out.groups.some((g) => g.id === gid)).toBe(false);
    expect([...out.expenses, ...out.expenseRevisions, ...out.settlements, ...out.groupActivityLog].some((r) => r.groupId === gid)).toBe(false);
    expect(out.groups).toHaveLength(d.groups.length - 1);
    expect(out.expenses.filter((e) => e.groupId === null)).toEqual(d.expenses.filter((e) => e.groupId === null));
    expect(diffDatasetToMutations(evictGroupData(d, gid), out, 'usr_t')).toEqual([]);
  });

  it('backfills direct bills by expenseId, and evicts a bill whose backfill is forbidden', async () => {
    await setSyncCursor('usr_bill', '50');
    const exp = clone().expenses.find((e) => e.groupId === null)!;
    mockFetch((url) => {
      const q = new URL(url, 'http://x').searchParams;
      if (q.get('expenseId') === 'exp_gone') return json({ error: 'forbidden' }, 403);
      if (q.get('expenseId') === exp.id) {
        return json({
          changes: [{ entity: 'expense', id: exp.id, serverSeq: '7', deleted: false, data: { ...exp, hlc: '019b00000000-0000-x' } }],
          nextCursor: '7', hasMore: false, backfillGroupIds: [], backfillExpenseIds: [],
        });
      }
      return json({ changes: [], nextCursor: '61', hasMore: false, backfillGroupIds: [], backfillExpenseIds: [exp.id, 'exp_gone', exp.id] });
    });
    const evicted: string[] = [];
    const local = emptyLocal();

    const outcome = await pullAll('usr_bill', 'tok', applyTo(local), async (scope, id) => {
      evicted.push(`${scope}:${id}`);
    });

    expect(outcome.status).toBe('ok');
    expect(params().map((q) => q.get('expenseId') ?? 'main')).toEqual(['main', exp.id, 'exp_gone']);
    expect(params()[1]!.get('cursor')).toBe('0');
    expect(local.d.expenses.map((e) => e.id)).toEqual([exp.id]);
    expect(evicted).toEqual(['expense:exp_gone']);
    expect(await getSyncCursor('usr_bill')).toBe('61');
  });

  it('stops persisting anything once the session changes mid-pull', async () => {
    await setSyncCursor('usr_switch', '50');
    let current = true;
    mockFetch(() => json({ changes: [ownMember('60')], nextCursor: '60', hasMore: false, backfillGroupIds: [] }));

    await expect(
      pullAll('usr_switch', 'tok', async (changes) => {
        current = false;
        return changes;
      }, async () => {}, () => current)
    ).rejects.toBeInstanceOf(SessionChangedError);

    expect(await getSyncCursor('usr_switch')).toBe('50');
    expect(await getPendingOrphans('usr_switch')).toEqual([]);
  });

  it('keeps the main cursor when a backfill page fails, so the join is retried', async () => {
    await setSyncCursor('usr_join2', '50');
    mockFetch((url) =>
      new URL(url, 'http://x').searchParams.get('groupId')
        ? json({ error: 'boom' }, 500)
        : json({ changes: [ownMember('60')], nextCursor: '60', hasMore: false, backfillGroupIds: [group.id] })
    );

    const outcome = await pullAll('usr_join2', 'tok', applyTo(emptyLocal()));

    expect(outcome.status).toBe('retry');
    expect(await getSyncCursor('usr_join2')).toBe('50');
  });
});

describe('direct settlements (one per bill, friend matched by email)', () => {
  const ME = 'me@example.com';
  const meA = { id: '00000000-0000-4000-8000-00000000000a', displayName: 'Me', invitedEmail: ME, upiId: null, avatarInitials: 'ME', memberOrder: 0 };
  const friendOn = (id: string) => ({ id, displayName: 'Meera', invitedEmail: 'meera@example.com', upiId: null, avatarInitials: 'MI', memberOrder: 1 });
  const bill = (id: string, friendId: string, payerId: string, amount: number): ExpenseItem => ({
    ...clone().expenses.find((e) => e.groupId === null)!,
    id,
    groupId: null,
    deletedAt: null,
    groupCurrency: 'INR',
    originalCurrency: 'INR',
    amountMinor: amount,
    originalAmountMinor: amount,
    adHocParticipants: [meA, friendOn(friendId)],
    payers: [{ memberId: payerId, paidMinor: amount, originalPaidMinor: amount }],
    splits: [meA.id, friendId].map((memberId) => ({
      memberId, included: true, owedMinor: amount / 2, originalOwedMinor: amount / 2, rawInputValue: 1, remainderMinor: 0,
    })),
  });
  const friendNet = (expenses: ExpenseItem[], settlements: SettlementItem[]) =>
    computeCrossGroupFriendsSummary(ME, [], expenses, settlements, clone().fxRatesToInr).find(
      (f) => f.friendKey === 'meera@example.com'
    )?.netByCurrencyMinor?.INR ?? 0;

  it('creates one anchored settlement per bill and brings the friend balance to zero', () => {
    const f1 = '00000000-0000-4000-8000-0000000000f1';
    const f2 = '00000000-0000-4000-8000-0000000000f2';
    const bills = [bill('exp_b1', f1, meA.id, 1000), bill('exp_b2', f2, f2, 400), bill('exp_b3', f1, meA.id, 600)];
    const partial: SettlementItem = {
      ...clone().settlements[0]!, id: 'stl_p', groupId: null, expenseId: 'exp_b3', batchSettlementId: null,
      fromMemberId: f1, toMemberId: meA.id, amountMinor: 100, currency: 'INR', deletedAt: null,
    };

    expect(friendNet(bills, [partial])).toBe(500 - 200 + 300 - 100);
    const plans = planDirectSettlements({ userEmail: ME, friendKey: 'meera@example.com', expenses: bills, settlements: [partial], fxRatesToInr: clone().fxRatesToInr });

    expect(plans).toEqual([
      { expenseId: 'exp_b1', fromMemberId: f1, toMemberId: meA.id, amountMinor: 500, currency: 'INR' },
      { expenseId: 'exp_b2', fromMemberId: meA.id, toMemberId: f2, amountMinor: 200, currency: 'INR' },
      { expenseId: 'exp_b3', fromMemberId: f1, toMemberId: meA.id, amountMinor: 200, currency: 'INR' },
    ]);
    const settled = plans.map((p, i): SettlementItem => ({
      ...partial, id: `stl_${i}`, expenseId: p.expenseId, fromMemberId: p.fromMemberId, toMemberId: p.toMemberId, amountMinor: p.amountMinor,
    }));
    expect(friendNet(bills, [partial, ...settled])).toBe(0);
    expect(planDirectSettlements({ userEmail: ME, friendKey: 'meera@example.com', expenses: bills, settlements: [partial, ...settled], fxRatesToInr: {} })).toEqual([]);
  });
});

describe('direct settlement permissions', () => {
  const me = { id: '00000000-0000-4000-8000-00000000000a', displayName: 'Me', invitedEmail: 'me@example.com', upiId: null, avatarInitials: 'ME', memberOrder: 0 };
  const a = { ...me, id: '00000000-0000-4000-8000-0000000000a1', displayName: 'A', invitedEmail: 'a@example.com' };
  const b = { ...me, id: '00000000-0000-4000-8000-0000000000b1', displayName: 'B', invitedEmail: 'b@example.com' };
  const bill = (owner: string): ExpenseItem => ({ ...clone().expenses[0]!, id: 'exp_p', groupId: null, adHocParticipants: [me, a, b], createdByMemberId: owner });
  const stl = (from: string, to: string): SettlementItem => ({ ...clone().settlements[0]!, id: 'stl_p', groupId: null, expenseId: 'exp_p', fromMemberId: from, toMemberId: to, deletedAt: null });

  it('only the payer or payee on the anchor bill may record', () => {
    expect(canRecordDirectSettlement(bill(a.id), 'me@example.com', a.id, me.id)).toBe(true);
    expect(canRecordDirectSettlement(bill(a.id), 'ME@example.com', me.id, b.id)).toBe(true);
    expect(canRecordDirectSettlement(bill(me.id), 'me@example.com', a.id, b.id)).toBe(false);
    expect(canRecordDirectSettlement(bill(a.id), 'me@example.com', 'stranger', me.id)).toBe(false);
    expect(canRecordDirectSettlement(bill(a.id), 'outsider@example.com', a.id, b.id)).toBe(false);
  });

  it('either party or the bill owner may delete; anyone else may not', () => {
    expect(canDeleteDirectSettlement(stl(a.id, me.id), bill(b.id), 'me@example.com', 'usr_me')).toBe(true);
    expect(canDeleteDirectSettlement(stl(a.id, b.id), bill(me.id), 'me@example.com', 'usr_me')).toBe(true);
    expect(canDeleteDirectSettlement(stl(a.id, b.id), bill('usr_me'), 'me@example.com', 'usr_me')).toBe(true);
    expect(canDeleteDirectSettlement(stl(a.id, b.id), bill(a.id), 'me@example.com', 'usr_me')).toBe(false);
  });
});

describe('group admin rule', () => {
  it('only a member whose userId matches with role admin counts as admin', () => {
    const g = clone().groups[0]!;
    const me = g.members[0]!;
    expect(isGroupAdminFor({ ...g, members: [{ ...me, userId: 'usr_x', role: 'admin' }] }, 'usr_x')).toBe(true);
    expect(isGroupAdminFor({ ...g, members: [{ ...me, userId: 'usr_x', role: 'member' }] }, 'usr_x')).toBe(false);
    expect(isGroupAdminFor({ ...g, members: [{ ...me, userId: 'usr_y', role: 'admin' }] }, 'usr_x')).toBe(false);
  });
});

const blob = (id: string, ownerUserId?: string | null) => ({
  id, expenseId: 'e', groupId: null, fileName: 'f', mimeType: 'image/webp', sizeKb: 1,
  dataUrl: `data:${id}`, storageBucket: 'local-device-only', storagePath: 'p', uploadedToCloud: false, createdAt: '',
  ...(ownerUserId !== undefined ? { ownerUserId } : {}),
});

describe('user switch wipe', () => {
  it('clears synced tables, cursors, outbox and session but keeps receipt blobs', async () => {
    await saveDatasetToIndexedDb(clone());
    await enqueueSyncOutboxMutations([mutation(1)]);
    await setSyncCursor('usr_a', '42');
    await setBackendSessionToken('tok', { id: 'usr_a', email: 'a@example.com', fullName: 'A' });
    setReceiptOwner('usr_a');
    await saveReceiptBlobLocally(blob('rcp'));

    await wipeUserScopedData();

    const db = getLocalDb()!;
    const counts = await Promise.all(db.tables.filter((t) => t.name !== 'localReceiptBlobs').map((t) => t.count()));
    expect(counts.every((n) => n === 0)).toBe(true);
    expect(await getSyncCursor('usr_a')).toBe('0');
    expect(await loadPersistedSession()).toBeNull();
    expect(await getLocalReceiptBlobsForExpense('e')).toHaveLength(1);
    setReceiptOwner(null);
    await db.localReceiptBlobs.clear();
  });
});

describe('receipt blobs are kept per user (P1-9)', () => {
  afterEach(async () => {
    setReceiptOwner(null);
    await getLocalDb()!.localReceiptBlobs.clear();
  });

  it('survive sign-out, come back for the same user, and stay hidden from another user', async () => {
    setReceiptOwner('usr_a');
    await saveReceiptBlobLocally(blob('rcp_a'));
    await wipeUserScopedData();
    setReceiptOwner('usr_b');
    expect(await getLocalReceiptBlobsForExpense('e')).toEqual([]);
    setReceiptOwner('usr_a');
    expect((await getLocalReceiptBlobsForExpense('e')).map((r) => r.dataUrl)).toEqual(['data:rcp_a']);
  });

  it('signed-out blobs move into the account on import, legacy blobs get an owner, and owners can be purged', async () => {
    setReceiptOwner(null);
    await saveReceiptBlobLocally(blob('rcp_local'));
    await getLocalDb()!.localReceiptBlobs.put(blob('rcp_legacy'));
    await reassignReceiptBlobs(null, 'usr_a');
    await reassignReceiptBlobs(undefined, 'usr_a');
    setReceiptOwner('usr_a');
    expect((await getLocalReceiptBlobsForExpense('e')).map((r) => r.id).sort()).toEqual(['rcp_legacy', 'rcp_local']);
    await deleteReceiptBlobsOwnedBy('usr_a');
    expect(await getLocalDb()!.localReceiptBlobs.count()).toBe(0);
  });
});

describe('Dexie is the source of truth (P1-11)', () => {
  const bigLedger = (bills: number): MockLedgerDataset => {
    const d = clone();
    const base = d.expenses[0]!;
    const rev = d.expenseRevisions[0]!;
    const act = d.groupActivityLog[0]!;
    for (let i = 0; i < bills; i++) {
      const id = `exp_bulk_${i}`;
      d.expenses.unshift({ ...base, id, title: `Bill ${i}`, receipts: [], comments: [] });
      d.expenseRevisions.unshift({ ...rev, id: `rev_bulk_${i}`, expenseId: id });
      d.groupActivityLog.unshift({ ...act, id: `act_bulk_${i}`, entityId: id });
    }
    return d;
  };
  const stripBytes = (d: MockLedgerDataset) => ({
    ...d,
    expenses: d.expenses.map((e) => ({ ...e, receipts: e.receipts.map(({ dataUrl: _x, ...r }) => r) })),
  });

  beforeEach(async () => {
    await wipeUserScopedData();
  });

  it('reloads 2,000 bills with their revisions and activity, in the same order', async () => {
    const d = bigLedger(2000);
    await commitLocalChanges(null, d, []);
    const loaded = await loadLocalDataset(clone());
    expect(loaded!.expenses).toHaveLength(d.expenses.length);
    expect(loaded).toEqual(stripBytes(d));
  });

  it('writes only the changed rows, keeps order for new, edited and deleted rows', async () => {
    const d0 = bigLedger(50);
    await commitLocalChanges(null, d0, []);
    await loadLocalDataset(clone());
    const db = getLocalDb()!;
    const puts = vi.spyOn(db.expenses, 'bulkPut');
    const added = { ...d0.expenses[3]!, id: 'exp_new', title: 'New' };
    const d1: MockLedgerDataset = {
      ...d0,
      expenses: [added, ...d0.expenses.slice(0, 5), { ...d0.expenses[5]!, title: 'Edited' }, ...d0.expenses.slice(7)],
    };
    await commitLocalChanges(d0, d1, []);
    expect(puts).toHaveBeenCalledTimes(1);
    expect(puts.mock.calls[0]![0].map((r) => r.id)).toEqual(['exp_new', d0.expenses[5]!.id]);
    expect((await loadLocalDataset(clone()))!.expenses).toEqual(stripBytes(d1).expenses);
  });

  it('a reorder that is not a prepend renumbers once and still reloads in order', async () => {
    const d0 = bigLedger(5);
    await commitLocalChanges(null, d0, []);
    const d1 = { ...d0, expenses: [...d0.expenses].reverse() };
    await commitLocalChanges(d0, d1, []);
    expect((await loadLocalDataset(clone()))!.expenses.map((e) => e.id)).toEqual(d1.expenses.map((e) => e.id));
  });

  it('commits rows and outbox entries in one transaction: a failure keeps neither (atomicity)', async () => {
    const d0 = clone();
    await commitLocalChanges(null, d0, []);
    const d1 = { ...d0, expenses: [{ ...d0.expenses[0]!, title: 'Changed' }, ...d0.expenses.slice(1)] };
    const bad = { ...mutation(1), data: { fn: () => 1 } as unknown as Record<string, unknown> };
    await expect(commitLocalChanges(d0, d1, [mutation(2), bad])).rejects.toThrow();
    expect((await loadLocalDataset(clone()))!.expenses[0]!.title).toBe(d0.expenses[0]!.title);
    expect(await listSyncOutboxMutations()).toHaveLength(0);

    await commitLocalChanges(d0, d1, [mutation(2)]);
    expect((await loadLocalDataset(clone()))!.expenses[0]!.title).toBe('Changed');
    expect((await listSyncOutboxMutations()).map((r) => r.id)).toEqual(['expense:e2']);
  });

  it('migrates the legacy full snapshot once: a full commit removes it', async () => {
    await getLocalDb()!.kvStore.put({ key: 'wise_spliter_full_dataset_v1', valueJson: JSON.stringify(clone()), updatedAt: '' });
    const legacy = await loadLegacyDexieSnapshot();
    expect(legacy?.expenses).toHaveLength(clone().expenses.length);
    await commitLocalChanges(null, legacy!, []);
    expect(await loadLegacyDexieSnapshot()).toBeNull();
    expect(await loadLocalDataset(clone())).not.toBeNull();
  });

  it('recognises quota errors, wrapped by Dexie or not', () => {
    expect(isQuotaError({ name: 'QuotaExceededError' })).toBe(true);
    expect(isQuotaError({ name: 'AbortError', inner: { name: 'QuotaExceededError' } })).toBe(true);
    expect(isQuotaError(new Error('x'))).toBe(false);
  });
});

describe('session token', () => {
  const user = { id: 'usr_s', email: 's@example.com', fullName: 'S' };
  const tokenWithExp = (exp: number) =>
    `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.sig`;

  it('persists the identity but not the bearer token on web', async () => {
    await setBackendSessionToken('secret.token.value', user);
    const row = await getLocalDb()!.kvStore.get('auth_session_v1');
    expect(row?.valueJson).not.toContain('secret.token.value');
    expect(await loadPersistedSession()).toEqual(user);
  });

  it('refreshes via /api/auth/session before expiry and reports 401 as unauthorized', async () => {
    const soon = tokenWithExp(Math.floor(Date.now() / 1000) + 3600);
    await setBackendSessionToken(soon, user);
    mockFetch(() => json({ ok: true, token: 'fresh.token' }));
    expect(await resolveSessionToken(user)).toEqual({ token: 'fresh.token' });
    expect(calls[0]!.url).toBe('/api/auth/session');
    expect(new Headers(calls[0]!.init?.headers).get('Authorization')).toBe(`Bearer ${soon}`);

    await setBackendSessionToken(null, user);
    mockFetch(() => json({ ok: false }, 401));
    expect(await resolveSessionToken(user)).toEqual({ token: null, reason: 'unauthorized' });
  });

  it('never hands out a token cached for a different user', async () => {
    await setBackendSessionToken(tokenWithExp(Math.floor(Date.now() / 1000) + 7 * 86400), user);
    mockFetch(() => json({ ok: false }, 401));
    const other = await resolveSessionToken({ id: 'usr_other', email: 'o@example.com', fullName: 'O' });
    expect(other.token).toBeNull();
  });
});

describe('client id uniqueness (M7)', () => {
  it('generates unique, server-safe ids even within the same millisecond', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const ids = Array.from({ length: 10_000 }, () => newId('act'));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => /^act_[0-9a-f-]{36}$/.test(id) && id.length <= 80)).toBe(true);
  });

  it('invite code entropy is 64 bits of crypto randomness', () => {
    const codes = Array.from({ length: 5000 }, () => randomHex(8));
    expect(codes.every((c) => /^[0-9A-F]{16}$/.test(c))).toBe(true);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('HLCs carry a per-device suffix that the server accepts, and the device id survives a wipe', async () => {
    const id = await getDeviceId();
    setHlcDeviceId(id);
    const hlc = makeHlc('usr_t');
    expect(hlc.endsWith(`-usr_t_${id}`)).toBe(true);
    expect(hlc).toMatch(/^[0-9a-f]{12}-[0-9a-f]{4}-[A-Za-z0-9_-]{1,80}$/);
    await wipeUserScopedData();
    expect(await getDeviceId()).toBe(id);
    setHlcDeviceId('');
  });

  it('HLCs are strictly increasing within the same millisecond', () => {
    vi.spyOn(Date, 'now').mockReturnValue(4_000_000_000_000);
    const hlcs = Array.from({ length: 100 }, () => makeHlc('usr_t'));
    expect([...hlcs].sort()).toEqual(hlcs);
    expect(new Set(hlcs).size).toBe(100);
  });
});

describe('data made before the first sign-in (P0-1)', () => {
  const sampleIds = new Set([
    ...clone().groups.flatMap((g) => [g.id, ...g.members.map((m) => m.id)]),
    ...clone().expenses.map((e) => e.id),
    ...clone().expenseRevisions.map((r) => r.id),
    ...clone().settlements.map((s) => s.id),
    ...clone().groupActivityLog.map((a) => a.id),
  ]);
  const profile: UserProfile = { ...clone().currentUser, id: 'usr_new', email: 'new@example.com', fullName: 'New Person', avatarInitials: 'NP' };

  const signedOutDevice = () => {
    const d = clone();
    const me = d.currentUser;
    const sampleGroup = d.groups[0]!;
    const group = {
      ...sampleGroup,
      id: 'grp_mine',
      members: [
        { ...sampleGroup.members[0]!, id: 'mem_me', groupId: 'grp_mine', userId: me.id, invitedEmail: me.email, displayName: me.fullName },
        { ...sampleGroup.members[1]!, id: 'mem_friend', groupId: 'grp_mine', userId: null, invitedEmail: 'friend@example.com', displayName: 'Friend' },
      ],
    };
    const bill = { ...d.expenses[0]!, id: 'exp_mine', groupId: 'grp_mine', payers: [{ memberId: 'mem_me', paidMinor: 100, originalPaidMinor: 100 }] };
    const direct = {
      ...d.expenses[0]!, id: 'exp_direct', groupId: null, createdByMemberId: me.id,
      adHocParticipants: [{ id: 'p1', displayName: me.fullName, invitedEmail: me.email, upiId: null, avatarInitials: 'AM', memberOrder: 0 }],
    };
    const inSample = { ...d.expenses[0]!, id: 'exp_in_sample_group' };
    return withExtraRows(d, {
      ...d,
      groups: [group],
      expenses: [bill, direct, inSample],
      expenseRevisions: [{ ...d.expenseRevisions[0]!, id: 'rev_mine', expenseId: 'exp_mine' }],
      settlements: [{ ...d.settlements[0]!, id: 'stl_mine', groupId: 'grp_mine' }],
      groupActivityLog: [{ ...d.groupActivityLog[0]!, id: 'act_mine', groupId: 'grp_mine' }],
    });
  };

  it('finds only the user\'s own rows, never the sample ones or rows inside sample groups', () => {
    const { data, counts } = takeLocalData(signedOutDevice(), sampleIds);
    expect(counts).toEqual({ groups: 1, bills: 2, payments: 1, sampleBills: 1, samplePayments: 0 });
    expect(data.expenses.map((e) => e.id)).toEqual(['exp_mine', 'exp_direct']);
    expect(data.expenseRevisions.map((r) => r.id)).toEqual(['rev_mine']);
    expect(data.groupActivityLog.map((a) => a.id)).toEqual(['act_mine']);
    expect(takeLocalData(clone(), sampleIds).counts).toEqual({ groups: 0, bills: 0, payments: 0, sampleBills: 0, samplePayments: 0 });
  });

  it('maps only my own rows: other people and free text keep the old id and email', () => {
    const device = signedOutDevice();
    const me = device.currentUser;
    const local = takeLocalData(device, sampleIds).data;
    local.groups[0]!.members[1] = { ...local.groups[0]!.members[1]!, invitedEmail: 'friend@example.com' };
    local.expenses[0] = { ...local.expenses[0]!, notes: me.email, title: me.id };
    const mapped = adoptLocalIdentity(local, me, profile);
    expect(mapped.expenses[0]).toMatchObject({ notes: me.email, title: me.id });
    expect(mapped.groups[0]!.members[1]).toMatchObject({ userId: null, invitedEmail: 'friend@example.com', displayName: 'Friend' });
    expect(mapped.expenses[0]!.payers[0]!.memberId).toBe('mem_me');
  });

  it('maps the local me to the signed-in identity, and the push contains no sample rows', () => {
    const device = signedOutDevice();
    const local = adoptLocalIdentity(takeLocalData(device, sampleIds).data, device.currentUser, profile);
    const me = local.groups[0]!.members[0]!;
    expect(me).toMatchObject({ userId: 'usr_new', invitedEmail: 'new@example.com', displayName: 'New Person' });
    expect(local.groups[0]!.members[1]!.userId).toBeNull();
    const direct = local.expenses.find((e) => e.id === 'exp_direct')!;
    expect(direct.createdByMemberId).toBe('usr_new');
    expect(direct.adHocParticipants![0]).toMatchObject({ invitedEmail: 'new@example.com', displayName: 'New Person' });

    const baseline = { ...withoutRows(clone()), currentUser: profile };
    const pushed = diffDatasetToMutations(baseline, withExtraRows(baseline, local), 'usr_new');
    expect(pushed.some((m) => sampleIds.has(m.id))).toBe(false);
    expect(pushed.slice(0, 2).map((m) => `${m.entity}:${m.id}`)).toEqual(['group:grp_mine', 'group_member:mem_me']);
    expect(JSON.stringify(pushed)).not.toContain(clone().currentUser.email);
  });
});

const withoutRows = (d: MockLedgerDataset): MockLedgerDataset => ({
  ...d, groups: [], expenses: [], expenseRevisions: [], settlements: [], groupActivityLog: [],
});

describe('restoring an old revision across a currency change (P1-2)', () => {
  const inr = () => ({ ...clone().expenses[0]!, amountMinor: 100000, originalAmountMinor: 100000,
    payers: [{ memberId: 'mem_goa_arjun', paidMinor: 100000, originalPaidMinor: 100000 }],
    splits: clone().expenses[0]!.splits.map((s, i) => ({ ...s, owedMinor: i === 0 ? 100000 : 0, originalOwedMinor: i === 0 ? 100000 : 0, included: i === 0 })) });
  const snap = (e: ReturnType<typeof inr>, extra: Partial<ExpenseRevision['snapshot']> = {}) => ({
    title: e.title, category: e.category, amountMinor: e.amountMinor, originalCurrency: e.originalCurrency,
    originalAmountMinor: e.originalAmountMinor, fxRateScaled: e.fxRateScaled, fxStatus: e.fxStatus,
    splitMode: e.splitMode, payers: e.payers, splits: e.splits, notes: e.notes, ...extra,
  });
  const rev = (id: string, n: number, s: ExpenseRevision['snapshot'], action: ExpenseRevision['action'] = 'updated'): ExpenseRevision => ({
    id, expenseId: 'exp_goa_villa_01', groupId: 'grp_goa_2026', revisionNumber: n, baseRevisionId: null, actorMemberId: 'm',
    actorDisplayName: 'A', action, changes: [], snapshot: s, isConflictBranch: false, createdAt: `2026-11-1${n}T00:00:00Z`, hlc: '',
  });
  const RATE = 1_180_000;
  const setup = (convertedFrom?: { currency: string; fxRateScaled: number }) => {
    const v1 = inr();
    const usd = redenominateExpenseCurrency({ expense: v1, newCurrency: 'USD', mode: 'reconvert', fxRateScaled: RATE });
    const revisions = [
      rev('v1', 1, snap(v1, { groupCurrency: 'INR' })),
      rev('v2', 2, snap(usd, { groupCurrency: 'USD', ...(convertedFrom ? { convertedFrom } : {}) }), 'currency_reconverted'),
    ];
    return { usd, revisions };
  };

  it('a 1,000 INR v1 restored into a USD group is 11.80 USD, never 1,000 USD', () => {
    const { usd, revisions } = setup({ currency: 'INR', fxRateScaled: RATE });
    const out = revisionInCurrentCurrency(usd, revisions, 'v1', () => true);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.expense).toMatchObject({ groupCurrency: 'USD', amountMinor: 1180 });
    expect(out.expense.payers.reduce((a, p) => a + p.paidMinor, 0)).toBe(1180);
    expect(out.expense.splits.reduce((a, p) => a + p.owedMinor, 0)).toBe(1180);
  });

  it('refuses calmly when the conversion rate was not recorded', () => {
    const { usd, revisions } = setup();
    const out = revisionInCurrentCurrency(usd, revisions, 'v1', () => true);
    expect(out).toMatchObject({ ok: false });
    if (!out.ok) expect(out.reason).toMatch(/not restored/);
  });

  it('an old snapshot without its currency restores as is only when the currency never changed', () => {
    const e = inr();
    const legacy = [rev('v1', 1, snap({ ...e, fxStatus: 'manual' }))];
    expect(revisionInCurrentCurrency(e, legacy, 'v1', () => false)).toMatchObject({ ok: true, expense: { amountMinor: 100000 } });
    expect(revisionInCurrentCurrency(e, legacy, 'v1', () => true)).toMatchObject({ ok: false });
  });
});

describe('server-detected conflicts with baseHlc (P1-3)', () => {
  const S0 = '019a73a00100-0000-usr_b';
  const billAt = (d: MockLedgerDataset, patch: Partial<ExpenseItem>) => ({
    ...d,
    expenses: d.expenses.map((e, i) => (i === 0 ? { ...e, ...patch } : e)),
  });

  it('edits carry the server version they started from; new bills carry null', () => {
    const base = billAt(clone(), { hlc: S0 });
    const edited = billAt(base, { title: 'Edited', hlc: makeHlc('usr_a') });
    const [m] = diffDatasetToMutations(base, edited, 'usr_a');
    expect(m).toMatchObject({ entity: 'expense', op: 'upsert', baseHlc: S0 });
    const added = { ...base, expenses: [{ ...base.expenses[0]!, id: 'exp_new', hlc: makeHlc('usr_a') }, ...base.expenses] };
    expect(diffDatasetToMutations(base, added, 'usr_a').find((x) => x.id === 'exp_new')).toMatchObject({ baseHlc: null });
  });

  it('a second offline edit keeps the first one\'s base; an edit after a pull uses the pulled version', async () => {
    const first = { ...mutation(1), baseHlc: S0, hlc: '019a73a00200-0000-usr_a' };
    await enqueueSyncOutboxMutations([first]);
    await enqueueSyncOutboxMutations([{ ...mutation(1), baseHlc: first.hlc, hlc: '019a73a00300-0000-usr_a' }]);
    expect((await listSyncOutboxMutations())[0]!.mutation.baseHlc).toBe(S0);
    const pulled = '019a73a00400-0000-usr_b';
    await enqueueSyncOutboxMutations([{ ...mutation(1), baseHlc: pulled, hlc: '019a73a00500-0000-usr_a' }]);
    expect((await listSyncOutboxMutations())[0]!.mutation.baseHlc).toBe(pulled);
  });

  it('an edit queued while the previous one was in flight is rebased on it once it applies', async () => {
    const inFlight = { ...mutation(1), baseHlc: S0, hlc: '019a73a00200-0000-usr_a' };
    await enqueueSyncOutboxMutations([inFlight]);
    await enqueueSyncOutboxMutations([{ ...mutation(1), baseHlc: inFlight.hlc, hlc: '019a73a00300-0000-usr_a' }]);
    await removeSyncOutboxMutations([{ ...inFlight, applied: true }]);
    const [row] = await listSyncOutboxMutations();
    expect(row!.mutation).toMatchObject({ hlc: '019a73a00300-0000-usr_a', baseHlc: inFlight.hlc });
  });

  it('a conflict leaves the outbox, and both devices end up with the flagged server bill', async () => {
    const d = clone();
    const bill = d.expenses[0]!;
    const mine = { ...bill, title: 'Mine', hlc: '019a73a00900-0000-usr_a' };
    const serverBill = { ...bill, title: 'Theirs', hlc: '019a73a00800-0000-usr_b', hasUnresolvedConflict: true, conflictRevisionId: 'rev_conflict_a' };
    await enqueueSyncOutboxMutations([{ entity: 'expense', id: bill.id, op: 'upsert', hlc: mine.hlc, baseHlc: S0, data: { ...mine } }]);
    mockFetch((_url, init) =>
      json({
        results: pushedMutations(init).map((m) => ({
          entity: m.entity, id: m.id, status: 'conflict', serverHlc: serverBill.hlc,
          server: { hlc: serverBill.hlc, data: { ...serverBill } }, conflictRevisionId: 'rev_conflict_a',
        })),
      })
    );
    const outcome = await pushOutbox('tok');
    expect(outcome.rejected).toEqual([]);
    expect(outcome.serverConflicts).toHaveLength(1);
    expect(await listSyncOutboxMutations()).toHaveLength(0);

    const deviceA = takeServerVersions({ ...d, expenses: [mine, ...d.expenses.slice(1)] }, outcome.serverConflicts);
    expect(deviceA.expenses[0]).toMatchObject({ title: 'Theirs', hasUnresolvedConflict: true, conflictRevisionId: 'rev_conflict_a', hlc: serverBill.hlc });
    const deviceB = mergePullChanges({ ...d, expenses: [{ ...serverBill, hasUnresolvedConflict: false, conflictRevisionId: null }, ...d.expenses.slice(1)] }, [
      { entity: 'expense', id: bill.id, serverSeq: '9', deleted: false, data: { ...serverBill } },
    ]);
    expect(deviceB.expenses[0]).toMatchObject({ hasUnresolvedConflict: true, conflictRevisionId: 'rev_conflict_a' });

    const keepMine = billAt(deviceA, { title: 'Mine', hasUnresolvedConflict: false, hlc: makeHlc('usr_a') });
    const [resolution] = diffDatasetToMutations(deviceA, keepMine, 'usr_a');
    expect(resolution).toMatchObject({ baseHlc: serverBill.hlc, data: { hasUnresolvedConflict: false, conflictRevisionId: 'rev_conflict_a' } });
    const cleared = { ...resolution!.data, conflictRevisionId: null, hlc: '019a73a00a00-0000-srv' };
    const deviceBAfter = mergePullChanges(deviceB, [{ entity: 'expense', id: bill.id, serverSeq: '10', deleted: false, data: cleared }]);
    expect(deviceBAfter.expenses[0]).toMatchObject({ title: 'Mine', hasUnresolvedConflict: false });
  });
});

describe('comments are their own append-only rows (P1-4)', () => {
  const withComment = (d: MockLedgerDataset, c: Partial<ExpenseItem['comments'][number]>) => ({
    ...d,
    expenses: d.expenses.map((e, i) =>
      i === 0 ? { ...e, comments: [...e.comments, { id: 'cmt_x', expenseId: e.id, authorMemberId: 'm', authorName: 'Arjun Mehta', body: 'hi', createdAt: '2026-11-16T00:00:00Z', ...c }] } : e
    ),
  });

  it('a new comment pushes one expense_comment row and never the bill; the author is left to the server', () => {
    const d = clone();
    const out = diffDatasetToMutations(d, withComment(d, { isMine: true }), 'usr_a');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ entity: 'expense_comment', op: 'upsert', data: { id: 'cmt_x', expenseId: d.expenses[0]!.id, body: 'hi' } });
    expect(Object.keys(out[0]!.data!).sort()).toEqual(['body', 'createdAt', 'expenseId', 'id']);
    const billPush = diffDatasetToMutations(d, { ...d, expenses: [{ ...d.expenses[0]!, title: 'x', hlc: makeHlc('u') }, ...d.expenses.slice(1)] }, 'u');
    expect(billPush[0]!.data!.comments).toEqual([]);
  });

  it('two people commenting offline both end up on both devices, with no conflict flag', () => {
    const d = clone();
    const exp = d.expenses[0]!;
    const row = (id: string, author: string, mine: boolean): SyncPullChange => ({
      entity: 'expense_comment', id, serverSeq: id === 'c1' ? '5' : '6', deleted: false,
      data: { id, expenseId: exp.id, groupId: exp.groupId, authorMemberId: 'm', authorName: author, isMine: mine, body: author, createdAt: `2026-11-16T00:00:0${id === 'c1' ? 1 : 2}Z`, editedAt: null, deletedAt: null, hlc: `019a73a0010${id === 'c1' ? 1 : 2}-0000-x` },
    });
    const merged = mergePullChanges(d, [row('c2', 'B', false), row('c1', 'A', true)]);
    const after = mergePullChanges(merged, [{ entity: 'expense', id: exp.id, serverSeq: '7', deleted: false, data: { ...exp, comments: [], hlc: '019a73a0ffff-0000-x' } }]);
    const ids = after.expenses[0]!.comments.map((c) => c.id);
    expect(ids.slice(-2)).toEqual(['c1', 'c2']);
    expect(after.expenses[0]!.hasUnresolvedConflict).toBe(false);
    expect(diffDatasetToMutations(merged, after, 'u').filter((m) => m.entity === 'expense_comment')).toEqual([]);
  });

  it('a comment that arrives before its bill waits as an orphan; a deleted one disappears', () => {
    const orphans: SyncPullChange[] = [];
    const change: SyncPullChange = { entity: 'expense_comment', id: 'c9', serverSeq: '1', deleted: false, data: { id: 'c9', expenseId: 'exp_unknown', body: 'x', authorName: 'A', createdAt: '' } };
    mergePullChanges(clone(), [change], orphans);
    expect(orphans).toEqual([change]);
    const d = withComment(clone(), { hlc: '019a73a00100-0000-x' });
    const gone = mergePullChanges(d, [{ entity: 'expense_comment', id: 'cmt_x', serverSeq: '2', deleted: true, data: null }]);
    expect(gone.expenses[0]!.comments.some((c) => c.id === 'cmt_x')).toBe(false);
  });

  it('migrates my comments out of queued legacy bill edits, once', async () => {
    const d = clone();
    const legacyComments = [
      { id: 'cmt_mine', authorName: 'Arjun Mehta', body: 'mine', createdAt: '2026-11-16T00:00:00Z' },
      { id: 'cmt_theirs', authorName: 'Rohan Verma', body: 'theirs', createdAt: '2026-11-16T00:00:00Z' },
    ];
    await enqueueSyncOutboxMutations([{ entity: 'expense', id: d.expenses[0]!.id, op: 'upsert', hlc: makeHlc('u'), data: { comments: legacyComments } }]);
    expect(await migrateLegacyOutboxComments('Arjun Mehta', () => makeHlc('u'))).toBe(1);
    const rows = await listSyncOutboxMutations();
    expect(rows.map((r) => r.id)).toEqual([`expense:${d.expenses[0]!.id}`, 'expense_comment:cmt_mine']);
    expect(rows[0]!.mutation.data!.comments).toEqual([]);
    expect(rows[1]!.mutation.data).toEqual({ id: 'cmt_mine', expenseId: d.expenses[0]!.id, body: 'mine', createdAt: '2026-11-16T00:00:00Z' });
    expect(await migrateLegacyOutboxComments('Arjun Mehta', () => makeHlc('u'))).toBe(0);
  });
});

describe('session expiry while offline (item 8)', () => {
  it('a rejected token keeps every queued change, and the queue drains after signing in again', async () => {
    await enqueueSyncOutboxMutations([mutation(1), mutation(2)]);
    mockFetch(() => json({ error: 'expired' }, 401));
    expect((await pushOutbox('expired.token')).status).toBe('auth');
    expect(await listSyncOutboxMutations()).toHaveLength(2);

    const user = { id: 'usr_x', email: 'x@example.com', fullName: 'X' };
    await setBackendSessionToken(null, user);
    expect(await resolveSessionToken(user)).toEqual({ token: null, reason: 'unauthorized' });
    expect(await loadPersistedSession()).toEqual(user);

    await setBackendSessionToken('fresh.token', user);
    mockFetch(ackAll());
    expect(await pushOutbox((await resolveSessionToken(user)).token!)).toMatchObject({ status: 'ok', applied: 2 });
    expect(new Headers(calls.at(-1)!.init?.headers).get('Authorization')).toBe('Bearer fresh.token');
    expect(await listSyncOutboxMutations()).toHaveLength(0);
  });
});

describe('group currency changed while a bill was queued (currency_mismatch)', () => {
  it('keeps the mismatched row queued, skips it for the rest of the run, and acks the others', async () => {
    await enqueueSyncOutboxMutations([mutation(1), mutation(2)]);
    mockFetch((_url, init) =>
      json({
        results: pushedMutations(init).map((m) =>
          m.id === 'e1'
            ? { entity: m.entity, id: m.id, status: 'invalid', code: 'currency_mismatch', baseCurrency: 'USD' }
            : { entity: m.entity, id: m.id, status: 'applied' }
        ),
      })
    );
    const outcome = await pushOutbox('tok');
    expect(outcome).toMatchObject({ status: 'ok', applied: 1, rejected: [] });
    expect(outcome.currencyMismatches).toEqual([{ mutation: expect.objectContaining({ id: 'e1' }), baseCurrency: 'USD' }]);
    expect(calls).toHaveLength(1);
    expect((await listSyncOutboxMutations()).map((r) => r.id)).toEqual(['expense:e1']);
  });

  it('converts a queued INR bill or payment into the new base, keeping its baseHlc; without a rate it waits', () => {
    const e = { ...clone().expenses[0]!, amountMinor: 100000, originalAmountMinor: 100000,
      payers: [{ memberId: 'mem_goa_arjun', paidMinor: 100000, originalPaidMinor: 100000 }],
      splits: clone().expenses[0]!.splits.map((x, i) => ({ ...x, included: i < 2, owedMinor: i < 2 ? 50000 : 0, originalOwedMinor: i < 2 ? 50000 : 0 })) };
    const queued: SyncPushMutation = { entity: 'expense', id: e.id, op: 'upsert', hlc: 'h1', baseHlc: 'h0', data: { ...e } };
    const rate = { rateScaled: 1_180_000, status: 'live' as const, rateDate: '2026-11-16' };
    const out = convertQueuedToBase(queued, 'USD', rate, 'h2')!;
    expect(out).toMatchObject({ hlc: 'h2', baseHlc: 'h0', data: { groupCurrency: 'USD', amountMinor: 1180, originalCurrency: 'INR', hlc: 'h2' } });
    const d = out.data as unknown as ExpenseItem;
    expect(d.payers.reduce((a, p) => a + p.paidMinor, 0)).toBe(1180);
    expect(d.splits.reduce((a, p) => a + p.owedMinor, 0)).toBe(1180);
    expect(convertQueuedToBase(queued, 'USD', null, 'h2')).toBeNull();

    const st = { ...clone().settlements[0]!, currency: 'INR', amountMinor: 100000 };
    const paid = convertQueuedToBase({ entity: 'settlement', id: st.id, op: 'upsert', hlc: 'h1', data: { ...st } }, 'USD', rate, 'h3')!;
    expect(paid.data).toMatchObject({ currency: 'USD', amountMinor: 1180, hlc: 'h3' });
  });

  it('an admin\'s base-currency change jumps ahead of bills already queued for the group', async () => {
    await enqueueSyncOutboxMutations([mutation(1), mutation(2)]);
    await enqueueSyncOutboxMutations([{ entity: 'group', id: 'g1', op: 'upsert', hlc: makeHlc('u'), data: { id: 'g1', baseCurrency: 'USD' } }]);
    expect((await listSyncOutboxMutations()).map((r) => r.id)).toEqual(['group:g1', 'expense:e1', 'expense:e2']);
  });

  it('a group created and edited before it syncs still pushes its full row', async () => {
    await enqueueSyncOutboxMutations([{ entity: 'group', id: 'g2', op: 'upsert', hlc: 'h1', data: { id: 'g2', name: 'Trip', baseCurrency: 'INR' } }]);
    await enqueueSyncOutboxMutations([{ entity: 'group', id: 'g2', op: 'upsert', hlc: 'h2', data: { id: 'g2', hlc: 'h2', name: 'Trip 2' } }]);
    const [row] = await listSyncOutboxMutations();
    expect(row!.mutation).toMatchObject({ hlc: 'h2', data: { name: 'Trip 2', baseCurrency: 'INR' } });
  });
});

describe('pull-only, per-viewer fields never go back up', () => {
  it('drops canEdit from settlements and isMine from comments', () => {
    const d = clone();
    const st = { ...d.settlements[0]!, canEdit: true } as SettlementItem;
    const before = { ...d, settlements: [] };
    const after = {
      ...d,
      settlements: [st],
      expenses: d.expenses.map((e, i) => (i === 0 ? { ...e, comments: [{ id: 'c', expenseId: e.id, authorMemberId: 'm', authorName: 'A', body: 'b', createdAt: '', isMine: true }] } : e)),
    };
    const out = diffDatasetToMutations(before, after, 'u');
    const pushedSettlement = out.find((m) => m.entity === 'settlement')!;
    expect(pushedSettlement.data).not.toHaveProperty('canEdit');
    expect(pushedSettlement.data).toMatchObject({ id: st.id, amountMinor: st.amountMinor });
    expect(out.find((m) => m.entity === 'expense_comment')!.data).not.toHaveProperty('isMine');
  });
});

describe('former members stay visible (removedAt)', () => {
  const setup = () => {
    const d = clone();
    const g = d.groups[0]!;
    const billed = g.members.find((m) => d.expenses.some((e) => e.groupId === g.id && e.payers.some((p) => p.memberId === m.id)) && m.id !== g.members[0]!.id)
      ?? g.members[1]!;
    return { d, g, billed };
  };
  const membersOf = (d: MockLedgerDataset, groupId: string) => d.groups.find((x) => x.id === groupId)!.members;

  it('a pulled removal keeps the member row with removedAt, and a later re-add clears it', () => {
    const { d, g, billed } = setup();
    const removedAt = '2030-01-01T00:00:00.000Z';
    const after = mergePullChanges(d, [{ entity: 'group_member', id: billed.id, serverSeq: '1', deleted: false, data: { ...billed, removedAt } }], [], 'usr_self');
    expect(membersOf(after, g.id).find((m) => m.id === billed.id)).toMatchObject({ displayName: billed.displayName, removedAt });
    const back = mergePullChanges(after, [{ entity: 'group_member', id: billed.id, serverSeq: '2', deleted: false, data: { ...billed, removedAt: null } }], [], 'usr_self');
    expect(membersOf(back, g.id).find((m) => m.id === billed.id)!.removedAt).toBeNull();
  });

  it('a bare tombstone keeps a former-member entry while bills still name them, with the known name', () => {
    const { d, g, billed } = setup();
    const after = mergePullChanges(d, [{ entity: 'group_member', id: billed.id, serverSeq: '1', deleted: true, data: null }], [], 'usr_self');
    const kept = membersOf(after, g.id).find((m) => m.id === billed.id)!;
    expect(kept.displayName).toBe(billed.displayName);
    expect(kept.removedAt).toEqual(expect.any(String));
  });

  it('a bare tombstone for a billed member this device never saw adds a minimal former-member entry', () => {
    const { d, g } = setup();
    const ghost = 'mem_ghost';
    d.expenses = d.expenses.map((e, i) =>
      e.groupId === g.id && i === d.expenses.findIndex((x) => x.groupId === g.id)
        ? { ...e, splits: [...e.splits, { memberId: ghost, included: false, owedMinor: 0, originalOwedMinor: 0, rawInputValue: 0, remainderMinor: 0 }] }
        : e
    );
    const after = mergePullChanges(d, [{ entity: 'group_member', id: ghost, serverSeq: '1', deleted: true, data: { groupId: g.id } as Record<string, unknown> }], [], 'usr_self');
    expect(membersOf(after, g.id).find((m) => m.id === ghost)).toBeDefined();
    const bare = mergePullChanges({ ...d, groups: d.groups.map((x) => (x.id === g.id ? x : x)) }, [{ entity: 'group_member', id: 'mem_unknown', serverSeq: '1', deleted: true, data: null }], [], 'usr_self');
    expect(membersOf(bare, g.id).some((m) => m.id === 'mem_unknown')).toBe(false);
  });

  it('keeping a former member pushes nothing back', () => {
    const { d, g, billed } = setup();
    const change: SyncPullChange = { entity: 'group_member', id: billed.id, serverSeq: '1', deleted: false, data: { ...billed, removedAt: '2030-01-01T00:00:00.000Z' } };
    expect(diffDatasetToMutations(mergePullChanges(d, [change]), mergePullChanges(d, [change]), 'u')).toEqual([]);
    expect(membersOf(mergePullChanges(d, [change]), g.id)).toHaveLength(g.members.length);
  });
});

describe('server-owned markers, imported comments and unknown revision actors', () => {
  it('a stale push never flags a bill on its own; only pulled server state shows the banner', async () => {
    const d = clone();
    const bill = d.expenses[1]!;
    await enqueueSyncOutboxMutations([{ entity: 'expense', id: bill.id, op: 'upsert', hlc: makeHlc('u'), baseHlc: bill.hlc, data: { ...bill } }]);
    mockFetch((_url, init) => json({ results: pushedMutations(init).map((m) => ({ entity: m.entity, id: m.id, status: 'stale', serverHlc: '019a73a0ffff-0000-x' })) }));
    const outcome = await pushOutbox('tok');
    expect(outcome.conflicts).toHaveLength(1);
    expect(outcome.serverConflicts).toEqual([]);
    const pulled = mergePullChanges(d, [{ entity: 'expense', id: bill.id, serverSeq: '3', deleted: false, data: { ...bill, hasUnresolvedConflict: true, conflictRevisionId: 'rev_c', hlc: 'fffffffffff0-0000-srv' } }]);
    expect(pulled.expenses[1]).toMatchObject({ hasUnresolvedConflict: true, conflictRevisionId: 'rev_c' });
  });

  it('pulled legacy comments are marked imported, and comments order by the server time', () => {
    const d = clone();
    const exp = d.expenses[0]!;
    const row = (id: string, createdAt: string, isLegacy: boolean): SyncPullChange => ({
      entity: 'expense_comment', id, serverSeq: '1', deleted: false,
      data: { id, expenseId: exp.id, groupId: exp.groupId, authorMemberId: null, authorName: 'Old note', isMine: false, isLegacy, body: id, createdAt, editedAt: null, deletedAt: null, hlc: '019a73a00100-0000-x' },
    });
    const merged = mergePullChanges(d, [row('late', '2026-11-16T10:00:00Z', false), row('old', '2026-01-01T00:00:00Z', true)]);
    const comments = merged.expenses[0]!.comments.filter((c) => c.id === 'late' || c.id === 'old');
    expect(comments.map((c) => [c.id, c.isLegacy])).toEqual([['old', true], ['late', false]]);
    expect(comments[0]!.authorMemberId).toBe('');
  });

  it('a revision whose actor is unknown shows as someone on this bill', () => {
    const d = clone();
    const rev = { ...d.expenseRevisions[0]!, id: 'rev_anon', actorMemberId: null, actorDisplayName: '' };
    const merged = mergePullChanges(d, [{ entity: 'expense_revision', id: 'rev_anon', serverSeq: '1', deleted: false, data: { ...rev } }]);
    expect(merged.expenseRevisions.find((r) => r.id === 'rev_anon')).toMatchObject({ actorMemberId: null, actorDisplayName: 'Someone on this bill' });
  });
});

describe('receipt blobs keyed by owner and receipt id', () => {
  afterEach(async () => {
    setReceiptOwner(null);
    await getLocalDb()!.localReceiptBlobs.clear();
  });

  it('two people\'s copies of one receipt never overwrite each other, and reads give the receipt id', async () => {
    setReceiptOwner('usr_a');
    await saveReceiptBlobLocally(blob('rcp_same'));
    setReceiptOwner('usr_b');
    await saveReceiptBlobLocally({ ...blob('rcp_same'), dataUrl: 'data:b' });
    expect(await getLocalDb()!.localReceiptBlobs.count()).toBe(2);
    expect((await getLocalReceiptBlobsForExpense('e')).map((r) => [r.id, r.dataUrl])).toEqual([['rcp_same', 'data:b']]);
    setReceiptOwner('usr_a');
    expect((await getLocalReceiptBlobsForExpense('e')).map((r) => [r.id, r.dataUrl])).toEqual([['rcp_same', 'data:rcp_same']]);
  });

  it('moving signed-out blobs into an account keeps them readable under the new owner', async () => {
    setReceiptOwner(null);
    await saveReceiptBlobLocally(blob('rcp_moving'));
    await reassignReceiptBlobs(null, 'usr_a');
    setReceiptOwner('usr_a');
    expect((await getLocalReceiptBlobsForExpense('e')).map((r) => r.id)).toEqual(['rcp_moving']);
    setReceiptOwner(null);
    expect(await getLocalReceiptBlobsForExpense('e')).toEqual([]);
  });
});

describe('pushNow (steps that wait for the server)', () => {
  it('returns the results, or says auth or offline', async () => {
    mockFetch(ackAll());
    expect(await pushNow('tok', [mutation(1)])).toEqual([{ entity: 'expense', id: 'e1', status: 'applied' }]);
    mockFetch(() => json({}, 401));
    expect(await pushNow('tok', [mutation(1)])).toBe('auth');
    mockFetch(() => json({}, 503));
    expect(await pushNow('tok', [mutation(1)])).toBe('offline');
    expect(await listSyncOutboxMutations()).toEqual([]);
  });
});

describe('refused edits go back to the server copy', () => {
  it('finds the scope of each refused row: a group, or a direct bill', () => {
    const d = clone();
    const g = d.groups[0]!;
    const direct = { ...d.expenses[0]!, id: 'exp_direct_x', groupId: null };
    const withDirect = { ...d, expenses: [direct, ...d.expenses] };
    expect(scopesOf(withDirect, [
      { entity: 'group_member', id: g.members[1]!.id },
      { entity: 'expense', id: 'exp_direct_x' },
      { entity: 'settlement', id: d.settlements[0]!.id },
      { entity: 'expense', id: 'exp_unknown' },
    ])).toEqual({ groupIds: [...new Set([g.id, d.settlements[0]!.groupId!])], expenseIds: ['exp_direct_x'] });
  });

  it('an unpinned row takes the server copy even when the local edit has a newer hlc', () => {
    const d = clone();
    const bill = d.expenses[0]!;
    const refusedLocal = { ...d, expenses: [{ ...bill, title: 'Refused edit', hlc: 'ffffffffff00-0000-me' }, ...d.expenses.slice(1)] };
    const serverCopy: SyncPullChange = { entity: 'expense', id: bill.id, serverSeq: '1', deleted: false, data: { ...bill, title: 'Server copy' } };
    expect(mergePullChanges(refusedLocal, [serverCopy]).expenses[0]!.title).toBe('Refused edit');
    const restored = mergePullChanges(unpinRows(refusedLocal, [{ entity: 'expense', id: bill.id }]), [serverCopy]);
    expect(restored.expenses[0]!.title).toBe('Server copy');
    expect(diffDatasetToMutations(unpinRows(refusedLocal, [{ entity: 'expense', id: bill.id }]), restored, 'u').filter((m) => m.entity === 'expense')).toHaveLength(1);
  });

  it('a refused member edit is restored by the next merge (members always take the pulled row)', () => {
    const d = clone();
    const g = d.groups[0]!;
    const member = g.members[1]!;
    const local = { ...d, groups: d.groups.map((x, i) => (i === 0 ? { ...x, members: x.members.map((m) => (m.id === member.id ? { ...m, upiId: 'refused@upi' } : m)) } : x)) };
    const back = mergePullChanges(local, [{ entity: 'group_member', id: member.id, serverSeq: '2', deleted: false, data: { ...member } }]);
    expect(back.groups[0]!.members.find((m) => m.id === member.id)!.upiId).toBe(member.upiId);
  });

  it('rows the server never accepted are removed, a new group with everything in it', () => {
    const d = clone();
    const g = d.groups[0]!;
    const dropped = dropRows(d, [{ entity: 'expense', id: d.expenses[1]!.id }, { entity: 'group_member', id: g.members[1]!.id }]);
    expect(dropped.expenses.some((e) => e.id === d.expenses[1]!.id)).toBe(false);
    expect(dropped.groups[0]!.members.some((m) => m.id === g.members[1]!.id)).toBe(false);
    const noGroup = dropRows(d, [{ entity: 'group', id: g.id }]);
    expect(noGroup.groups.some((x) => x.id === g.id)).toBe(false);
    expect(noGroup.expenses.some((e) => e.groupId === g.id)).toBe(false);
  });

  it('pullAll re-reads the scopes it is asked to before the main cursor', async () => {
    await setSyncCursor('usr_refetch', '9');
    mockFetch(() => json({ changes: [], nextCursor: '9', hasMore: false, backfillGroupIds: [], backfillExpenseIds: [] }));
    const out = await pullAll('usr_refetch', 'tok', async () => [], async () => {}, () => true, { groupIds: ['grp_a'], expenseIds: ['exp_b'] });
    expect(out.status).toBe('ok');
    const queries = calls.map((c) => new URL(c.url, 'http://x').searchParams);
    expect(queries.map((q) => [q.get('groupId'), q.get('expenseId'), q.get('cursor')])).toEqual([
      ['grp_a', null, '0'],
      [null, 'exp_b', '0'],
      [null, null, '9'],
    ]);
  });
});

describe('a save checks against the version the editor opened', () => {
  it('an edit started at h1, with a remote h2 pulled before save, sends baseHlc h1', async () => {
    const d = clone();
    const h1 = '019a73a10000-0000-usr_a';
    const h2 = '019a73a20000-0000-usr_b';
    const opened = { ...d, expenses: [{ ...d.expenses[0]!, hlc: h1 }, ...d.expenses.slice(1)] };
    const pulled = mergePullChanges(opened, [
      { entity: 'expense', id: d.expenses[0]!.id, serverSeq: '2', deleted: false, data: { ...d.expenses[0]!, title: 'Remote edit', hlc: h2 } },
    ]);
    const saved = { ...pulled, expenses: [{ ...pulled.expenses[0]!, title: 'My edit', hlc: makeHlc('usr_a') }, ...pulled.expenses.slice(1)] };
    const [m] = diffDatasetToMutations(pulled, saved, 'usr_a', new Map([[d.expenses[0]!.id, h1]]));
    expect(m).toMatchObject({ entity: 'expense', baseHlc: h1, data: { title: 'My edit' } });
    expect(diffDatasetToMutations(pulled, saved, 'usr_a')[0]!.baseHlc).toBe(h2);

    await enqueueSyncOutboxMutations([m!]);
    expect((await listSyncOutboxMutations())[0]!.mutation.baseHlc).toBe(h1);
  });
});

describe('bills imported into a sample group before sign-in (User Story 6 regression)', () => {
  it('count as local data, so signing in asks first instead of dropping them silently', () => {
    const d = clone();
    const sampleIds = new Set([...d.groups.map((g) => g.id), ...d.expenses.map((e) => e.id), ...d.settlements.map((x) => x.id)]);
    const imported = [0, 1].map((i) => ({ ...d.expenses[0]!, id: `exp_splitwise_${i}`, title: `Splitwise ${i}` }));
    const device = { ...d, expenses: [...imported, ...d.expenses] };
    const { counts, data } = takeLocalData(device, sampleIds);
    expect(counts).toEqual({ groups: 0, bills: 0, payments: 0, sampleBills: 2, samplePayments: 0 });
    expect(data.expenses).toEqual([]);
    expect(hasLocalData(counts)).toBe(true);
    expect(hasLocalData(takeLocalData(clone(), sampleIds).counts)).toBe(false);
  });
});

describe('final review: refused new rows, sample payments, queued bases, admin rates', () => {
  it('a refused new bill stays on the device, flagged with a calm reason, and the flag never goes up', () => {
    const d = clone();
    const bill = { ...d.expenses[0]!, id: 'exp_refused', notes: 'x'.repeat(2500) };
    const local = { ...d, expenses: [bill, ...d.expenses] };
    const unpinned = unpinRows(local, [{ entity: 'expense', id: 'exp_refused' }]);
    const flagged = markRejected(unpinned, [{ entity: 'expense', id: 'exp_refused', reason: 'notes is too long (max 2000)' }], () => '019a73a0aaaa-0000-u');
    expect(flagged.expenses.find((e) => e.id === 'exp_refused')!.hlc).toBe('019a73a0aaaa-0000-u');
    expect(flagged.expenses.find((e) => e.id === 'exp_refused')).toMatchObject({ syncRejection: 'Notes is too long (max 2000)', notes: bill.notes });
    const edited = { ...flagged, expenses: flagged.expenses.map((e) => (e.id === 'exp_refused' ? { ...e, notes: 'short', hlc: makeHlc('u') } : e)) };
    const [m] = diffDatasetToMutations(flagged, edited, 'u');
    expect(m).toMatchObject({ entity: 'expense', id: 'exp_refused', baseHlc: null });
    expect(m!.data).not.toHaveProperty('syncRejection');
  });

  it('a refused new group keeps its bills; retry sends the group whole, with its members, as new', () => {
    const d = clone();
    const g = d.groups[0]!;
    const flagged = markRejected(d, [{ entity: 'group', id: g.id }], () => makeHlc('u'));
    expect(flagged.groups[0]!.syncRejection).toBe('The server did not accept it');
    expect(flagged.expenses.filter((e) => e.groupId === g.id)).toHaveLength(d.expenses.filter((e) => e.groupId === g.id).length);
    const baseline = dropRows(flagged, [{ entity: 'group', id: g.id }]);
    const cleared = { ...flagged, groups: flagged.groups.map((x) => (x.id === g.id ? { ...x, syncRejection: null } : x)) };
    const out = diffDatasetToMutations(baseline, cleared, 'u');
    const groupPush = out.find((m) => m.entity === 'group' && m.id === g.id)!;
    expect(groupPush.data).toMatchObject({ name: g.name, baseCurrency: g.baseCurrency });
    expect(groupPush.data).not.toHaveProperty('syncRejection');
    expect(out.filter((m) => m.entity === 'group_member').map((m) => m.id)).toEqual(g.members.map((m) => m.id));
    expect(out.findIndex((m) => m.entity === 'group')).toBeLessThan(out.findIndex((m) => m.entity === 'group_member'));
  });

  it('a refetch for refused rows never evicts a group the server answers 403 for', async () => {
    await setSyncCursor('usr_refused', '3');
    mockFetch((url) =>
      url.includes('groupId=') ? json({ error: 'no' }, 403) : json({ changes: [], nextCursor: '3', hasMore: false, backfillGroupIds: [], backfillExpenseIds: [] })
    );
    const evicted: string[] = [];
    const out = await pullAll('usr_refused', 'tok', async () => [], async (_s, id) => void evicted.push(id), () => true, { groupIds: ['grp_new'], expenseIds: [] });
    expect(out.status).toBe('ok');
    expect(evicted).toEqual([]);
  });

  it('a payment recorded inside a sample group counts as local data', () => {
    const d = clone();
    const sampleIds = new Set([...d.groups.map((g) => g.id), ...d.settlements.map((x) => x.id)]);
    const device = { ...d, settlements: [{ ...d.settlements[0]!, id: 'stl_local', groupId: d.groups[0]!.id }, ...d.settlements] };
    const { counts } = takeLocalData(device, sampleIds);
    expect(counts.samplePayments).toBe(1);
    expect(hasLocalData(counts)).toBe(true);
  });

  it('a save reopened from any earlier queued version keeps the original server base', async () => {
    const S0 = '019a73a00000-0000-srv';
    await enqueueSyncOutboxMutations([{ ...mutation(7), hlc: '019a73a00100-0000-me', baseHlc: S0 }]);
    await enqueueSyncOutboxMutations([{ ...mutation(7), hlc: '019a73a00200-0000-me', baseHlc: '019a73a00100-0000-me' }]);
    await enqueueSyncOutboxMutations([{ ...mutation(7), hlc: '019a73a00300-0000-me', baseHlc: '019a73a00100-0000-me' }]);
    const [row] = await listSyncOutboxMutations();
    expect(row!.mutation).toMatchObject({ hlc: '019a73a00300-0000-me', baseHlc: S0 });
  });

  it('an older version never replaces a newer queued one', async () => {
    await enqueueSyncOutboxMutations([{ ...mutation(8), hlc: '019a73a00500-0000-me', data: { title: 'newer' } }]);
    await enqueueSyncOutboxMutations([{ ...mutation(8), hlc: '019a73a00200-0000-me', data: { title: 'older backup copy' } }]);
    expect((await listSyncOutboxMutations())[0]!.mutation.data).toEqual({ title: 'newer' });
  });

  it('queued bills re-convert at the rate the admin recorded, when one is recorded', () => {
    const d = clone();
    const rev = (createdAt: string, fxRateScaled: number) => ({
      ...d.expenseRevisions[0]!, id: `rev_${createdAt}`, groupId: 'grp_x', action: 'currency_reconverted' as const, createdAt,
      snapshot: { ...d.expenseRevisions[0]!.snapshot, groupCurrency: 'USD', convertedFrom: { currency: 'INR', fxRateScaled } },
    });
    const revisions = [rev('2026-11-10T00:00:00Z', 1_190_000), rev('2026-11-12T00:00:00Z', 1_180_000)];
    expect(recordedConversionRate(revisions, 'grp_x', 'INR', 'USD')).toEqual({ rateScaled: 1_180_000, status: 'manual', rateDate: '2026-11-12' });
    expect(recordedConversionRate(revisions, 'grp_x', 'INR', 'EUR')).toBeNull();
    expect(recordedConversionRate(revisions, 'grp_other', 'INR', 'USD')).toBeNull();
  });
});

