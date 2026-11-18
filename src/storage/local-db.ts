import Dexie, { type Table } from 'dexie';
import {
  ExpenseItem,
  ExpenseRevision,
  GroupActivityItem,
  GroupMember,
  GroupRecord,
  MockLedgerDataset,
  SettlementItem,
} from '../types/ledger';
import type { SyncPushMutation } from '../types/sync-contract';

export interface SyncOutboxMutation {
  id: string;
  seq: number;
  mutation: SyncPushMutation;
  /** Earlier hlcs this device queued for the row (replaced before they were sent); the server never saw them. */
  queuedHlcs?: string[];
}

export interface LocalReceiptBlobRecord {
  id: string;
  expenseId: string;
  groupId: string | null;
  fileName: string;
  mimeType: string;
  sizeKb: number;
  dataUrl: string;
  storageBucket: string;
  storagePath: string;
  uploadedToCloud: boolean;
  createdAt: string;
  /** Signed-in user who attached it; null while signed out. Blobs outlive sign-out and show only to their owner. */
  ownerUserId?: string | null;
  /** The receipt's own id; `id` is the storage key (owner and receipt id). */
  receiptId?: string;
}

export interface KvStoreEntry {
  key: string;
  valueJson: string;
  updatedAt: string;
}

const DATASET_SNAPSHOT_KEY = 'wise_spliter_full_dataset_v1';

export class WiseSpliterLocalDatabase extends Dexie {
  groups!: Table<GroupRecord, string>;
  groupMembers!: Table<GroupMember, string>;
  expenses!: Table<ExpenseItem, string>;
  expenseRevisions!: Table<ExpenseRevision, string>;
  settlements!: Table<SettlementItem, string>;
  groupActivityLog!: Table<GroupActivityItem, string>;
  syncOutbox!: Table<SyncOutboxMutation, string>;
  localReceiptBlobs!: Table<LocalReceiptBlobRecord, string>;
  kvStore!: Table<KvStoreEntry, string>;

  constructor() {
    super('wise_spliter_local_db');
    const schemaStores = {
      groups: 'id, baseCurrency, updatedAt, deletedAt, hlc',
      groupMembers: 'id, groupId, userId, role, memberOrder',
      expenses: 'id, groupId, category, expenseDate, updatedAt, deletedAt, hlc',
      expenseRevisions: 'id, expenseId, groupId, revisionNumber, createdAt, hlc',
      settlements: 'id, groupId, batchSettlementId, settledDate, createdAt, deletedAt, hlc',
      groupActivityLog: 'id, groupId, entityType, entityId, action, createdAt, hlc',
      syncOutbox: 'id, entityType, action, createdAt, hlc',
      localReceiptBlobs: 'id, expenseId, groupId, uploadedToCloud, createdAt',
      kvStore: 'key, updatedAt',
    };
    this.version(1).stores(schemaStores);
    this.version(2).stores(schemaStores);
    this.version(3)
      .stores({ ...schemaStores, syncOutbox: 'id, seq' })
      .upgrade((tx) => tx.table('syncOutbox').clear());
  }
}

let dbInstance: WiseSpliterLocalDatabase | null = null;
let memoryDatasetSnapshot: MockLedgerDataset | null = null;
let memoryOutbox: SyncOutboxMutation[] = [];
const memoryKv = new Map<string, string>();
let lastOutboxSeq = 0;
let memoryReceiptBlobs: LocalReceiptBlobRecord[] = [];

function isIndexedDbSupported(): boolean {
  try {
    return typeof globalThis !== 'undefined' && typeof globalThis.indexedDB !== 'undefined';
  } catch {
    return false;
  }
}

export function getLocalDb(): WiseSpliterLocalDatabase | null {
  if (!isIndexedDbSupported()) {
    return null;
  }
  if (!dbInstance) {
    try {
      dbInstance = new WiseSpliterLocalDatabase();
    } catch {
      dbInstance = null;
    }
  }
  return dbInstance;
}

const ENTITY_TABLES = ['groups', 'expenses', 'expenseRevisions', 'settlements', 'groupActivityLog'] as const;
type EntityTable = (typeof ENTITY_TABLES)[number];
type EntityRow = { id: string };
const META_KEY = 'dataset_meta_v2';
const positions = new Map<EntityTable, Map<string, number>>();
const topPosition = new Map<EntityTable, number>();

const posOf = (table: EntityTable) => {
  let map = positions.get(table);
  if (!map) positions.set(table, (map = new Map()));
  return map;
};

function resetPositions(): void {
  positions.clear();
  topPosition.clear();
}

function stripReceiptBytes(row: EntityRow): EntityRow {
  const e = row as ExpenseItem;
  if (!Array.isArray(e.receipts) || !e.receipts.some((r) => r.dataUrl)) return row;
  const stripped: ExpenseItem = { ...e, receipts: e.receipts.map(({ dataUrl: _omit, ...meta }) => meta) };
  return stripped;
}

function metaOf(d: MockLedgerDataset): Record<string, unknown> {
  const meta: Record<string, unknown> = { ...d };
  for (const t of ENTITY_TABLES) delete meta[t];
  return meta;
}

/**
 * Rows keep their in-memory order through an `_o` sort key (descending). New rows at the front get
 * keys above every stored one; any other reorder renumbers the table once.
 */
function planTable(table: EntityTable, prev: EntityRow[] | null, next: EntityRow[]) {
  const stored = prev ? posOf(table) : new Map<string, number>();
  let lead = 0;
  while (lead < next.length && !stored.has(next[lead]!.id)) lead++;
  let ordered = true;
  for (let i = lead, last = Infinity; i < next.length; i++) {
    const p = stored.get(next[i]!.id);
    if (p === undefined || p >= last) {
      ordered = false;
      break;
    }
    last = p;
  }
  const top = prev ? (topPosition.get(table) ?? 0) : 0;
  const assigned = new Map<string, number>();
  next.forEach((row, i) => {
    if (!ordered) assigned.set(row.id, next.length - i);
    else if (i < lead) assigned.set(row.id, top + lead - i);
  });
  const before = new Map((prev ?? []).map((r) => [r.id, r]));
  const puts = next
    .filter((row) => !prev || assigned.has(row.id) || before.get(row.id) !== row)
    .map((row) => ({ ...stripReceiptBytes(row), _o: assigned.get(row.id) ?? stored.get(row.id)! }));
  const keep = new Set(next.map((r) => r.id));
  const deletes = [...stored.keys()].filter((id) => !keep.has(id));
  const apply = () => {
    const map = ordered && prev ? stored : new Map<string, number>();
    deletes.forEach((id) => map.delete(id));
    assigned.forEach((p, id) => map.set(id, p));
    positions.set(table, map);
    topPosition.set(table, ordered ? Math.max(top, top + lead) : next.length);
  };
  return { puts, deletes, apply };
}

export function isQuotaError(err: unknown): boolean {
  const e = err as { name?: string; inner?: { name?: string } } | null;
  return e?.name === 'QuotaExceededError' || e?.inner?.name === 'QuotaExceededError';
}

/**
 * Writes what changed between `prev` (the last committed dataset, or null for a full rewrite) and
 * `next`, plus the outbox rows, in one Dexie transaction: a crash keeps both or neither. Throws on
 * failure so the caller can retry with the same baseline.
 */
export async function commitLocalChanges(
  prev: MockLedgerDataset | null,
  next: MockLedgerDataset,
  mutations: SyncPushMutation[]
): Promise<void> {
  const db = getLocalDb();
  if (!db) {
    memoryDatasetSnapshot = next;
    if (mutations.length > 0) memoryOutbox = coalesce(memoryOutbox, mutations).sort((a, b) => a.seq - b.seq);
    return;
  }
  const plans = ENTITY_TABLES.map((t) => [t, planTable(t, prev ? prev[t] : null, next[t])] as const);
  const meta = metaOf(next);
  const metaChanged = !prev || Object.keys(meta).some((k) => meta[k] !== (prev as unknown as Record<string, unknown>)[k]);
  await db.transaction('rw', [...ENTITY_TABLES.map((t) => db[t]), db.groupMembers, db.kvStore, db.syncOutbox], async () => {
    if (!prev) {
      await Promise.all([...ENTITY_TABLES.map((t) => db[t].clear()), db.groupMembers.clear()]);
      await db.kvStore.delete(DATASET_SNAPSHOT_KEY);
    }
    for (const [t, plan] of plans) {
      const table = db[t] as unknown as Table<EntityRow & { _o: number }, string>;
      if (plan.deletes.length > 0) await table.bulkDelete(plan.deletes);
      if (plan.puts.length > 0) await table.bulkPut(plan.puts);
    }
    if (metaChanged) {
      await db.kvStore.put({ key: META_KEY, valueJson: JSON.stringify(meta), updatedAt: new Date().toISOString() });
    }
    await putOutbox(db, mutations);
  });
  plans.forEach(([, plan]) => plan.apply());
}

/** Reads the ledger from Dexie, in its saved order. `defaults` fills fields older saves lack. */
export async function loadLocalDataset(defaults: MockLedgerDataset): Promise<MockLedgerDataset | null> {
  const db = getLocalDb();
  if (!db) return memoryDatasetSnapshot;
  const metaRow = await db.kvStore.get(META_KEY);
  if (!metaRow) return null;
  const meta = JSON.parse(metaRow.valueJson) as Partial<MockLedgerDataset>;
  resetPositions();
  const out: Record<string, unknown> = { ...defaults, ...meta };
  for (const t of ENTITY_TABLES) {
    const rows = (await db[t].toArray()) as unknown as Array<EntityRow & { _o: number }>;
    rows.sort((a, b) => b._o - a._o);
    const map = posOf(t);
    out[t] = rows.map(({ _o, ...row }) => {
      map.set(row.id, _o);
      return row;
    });
    topPosition.set(t, rows[0]?._o ?? 0);
  }
  return out as unknown as MockLedgerDataset;
}

/** Full JSON snapshot written by older app versions; migrated once by a full commit, which deletes it. */
export async function loadLegacyDexieSnapshot(): Promise<MockLedgerDataset | null> {
  const db = getLocalDb();
  if (!db) return null;
  try {
    const snap = await db.kvStore.get(DATASET_SNAPSHOT_KEY);
    return snap ? (JSON.parse(snap.valueJson) as MockLedgerDataset) : null;
  } catch {
    return null;
  }
}

/** Full rewrite, kept for callers that only need a one-off save. */
export async function saveDatasetToIndexedDb(dataset: MockLedgerDataset): Promise<void> {
  try {
    await commitLocalChanges(null, dataset, []);
  } catch {
    // Callers that need the error use commitLocalChanges
  }
}

export async function loadDatasetFromIndexedDb(): Promise<MockLedgerDataset | null> {
  try {
    const meta = await getKvValue<MockLedgerDataset>(META_KEY);
    return meta ? await loadLocalDataset(meta) : memoryDatasetSnapshot;
  } catch {
    return memoryDatasetSnapshot;
  }
}

export function outboxKey(m: { entity: string; id: string }): string {
  return `${m.entity}:${m.id}`;
}

function nextOutboxSeq(): number {
  lastOutboxSeq = Math.max(Date.now() * 1000, lastOutboxSeq + 1);
  return lastOutboxSeq;
}

function coalesce(
  existing: Array<SyncOutboxMutation | undefined>,
  mutations: SyncPushMutation[]
): SyncOutboxMutation[] {
  const byKey = new Map<string, SyncOutboxMutation>();
  existing.forEach((row) => row && byKey.set(row.id, row));
  for (const mutation of mutations) {
    const id = outboxKey(mutation);
    const prior = byKey.get(id);
    // Last writer wins here too: an older version (for example from a restored backup) never replaces a newer queued one.
    if (prior && mutation.hlc < prior.mutation.hlc) continue;
    const queuedHlcs = prior ? [...(prior.queuedHlcs ?? []), prior.mutation.hlc].slice(-50) : undefined;
    // An edit on top of any of our own queued versions still starts from the server version they started from.
    const stacked =
      prior !== undefined &&
      prior.mutation.baseHlc !== undefined &&
      typeof mutation.baseHlc === 'string' &&
      queuedHlcs!.includes(mutation.baseHlc);
    let merged = stacked ? { ...mutation, baseHlc: prior.mutation.baseHlc } : mutation;
    // Group upserts are PATCHes: a queued create or edit keeps its fields under a later edit.
    if (prior && mutation.entity === 'group' && mutation.op === 'upsert' && prior.mutation.op === 'upsert' && prior.mutation.data && mutation.data) {
      merged = { ...merged, data: { ...prior.mutation.data, ...mutation.data } };
    }
    byKey.set(id, { id, seq: prior?.seq ?? nextOutboxSeq(), mutation: merged, ...(queuedHlcs ? { queuedHlcs } : {}) });
  }
  return [...byKey.values()];
}

const changesCurrency = (r: SyncOutboxMutation) =>
  r.mutation.entity === 'group' && r.mutation.op === 'upsert' && r.mutation.data !== null && 'baseCurrency' in r.mutation.data;

/** Coalesces into the outbox; a group's base-currency change jumps ahead of every queued bill and payment. */
async function putOutbox(db: WiseSpliterLocalDatabase, mutations: SyncPushMutation[]): Promise<void> {
  if (mutations.length === 0) return;
  let rows = coalesce(await db.syncOutbox.bulkGet(mutations.map(outboxKey)), mutations);
  if (rows.some(changesCurrency)) {
    const first = (await db.syncOutbox.orderBy('seq').first())?.seq ?? Infinity;
    const front = Math.min(first, ...rows.map((r) => r.seq)) - 1;
    rows = rows.map((r) => (changesCurrency(r) ? { ...r, seq: front } : r));
  }
  await db.syncOutbox.bulkPut(rows);
}

export async function enqueueSyncOutboxMutations(
  mutations: SyncPushMutation[]
): Promise<void> {
  if (mutations.length === 0) return;
  const db = getLocalDb();
  if (db) {
    try {
      await db.transaction('rw', db.syncOutbox, () => putOutbox(db, mutations));
      return;
    } catch {
      // Fall back to memory outbox
    }
  }
  const merged = coalesce(memoryOutbox, mutations);
  memoryOutbox = merged.sort((a, b) => a.seq - b.seq);
}

export async function listSyncOutboxMutations(limit?: number): Promise<SyncOutboxMutation[]> {
  const db = getLocalDb();
  if (db) {
    try {
      const ordered = db.syncOutbox.orderBy('seq');
      return await (limit ? ordered.limit(limit) : ordered).toArray();
    } catch {
      // Fallback to memory outbox
    }
  }
  return memoryOutbox.slice(0, limit ?? memoryOutbox.length);
}

export async function countSyncOutbox(): Promise<number> {
  const db = getLocalDb();
  if (db) {
    try {
      return await db.syncOutbox.count();
    } catch {
      // Fallback to memory outbox
    }
  }
  return memoryOutbox.length;
}

/** Removes acknowledged rows, unless a newer local edit replaced them while in flight. */
export async function removeSyncOutboxMutations(
  acked: Array<{ entity: string; id: string; hlc: string; applied?: boolean }>
): Promise<void> {
  const isAcked = (row: SyncOutboxMutation | undefined) =>
    row !== undefined &&
    acked.some((a) => outboxKey(a) === row.id && a.hlc === row.mutation.hlc);
  /** A newer edit queued while an applied one was in flight now starts from the applied version. */
  const rebased = (rows: Array<SyncOutboxMutation | undefined>) =>
    rows.flatMap((row) => {
      const a = row && !isAcked(row) && row.mutation.baseHlc !== undefined
        ? acked.find((x) => x.applied && outboxKey(x) === row.id)
        : undefined;
      return row && a ? [{ ...row, mutation: { ...row.mutation, baseHlc: a.hlc } }] : [];
    });
  const db = getLocalDb();
  if (db) {
    try {
      await db.transaction('rw', db.syncOutbox, async () => {
        const rows = await db.syncOutbox.bulkGet(acked.map(outboxKey));
        await db.syncOutbox.bulkDelete(rows.filter(isAcked).map((r) => r!.id));
        await db.syncOutbox.bulkPut(rebased(rows));
      });
      return;
    } catch {
      // Fall back to memory outbox
    }
  }
  const moved = new Map(rebased(memoryOutbox).map((r) => [r.id, r]));
  memoryOutbox = memoryOutbox.filter((row) => !isAcked(row)).map((row) => moved.get(row.id) ?? row);
}

/**
 * Queued bill edits from older versions carried new comments inside the bill, which the server now
 * ignores. Moves the user's own ones (by author name) into 'expense_comment' rows, once.
 */
export async function migrateLegacyOutboxComments(authorName: string, hlc: () => string): Promise<number> {
  const db = getLocalDb();
  if (!db) return 0;
  let moved = 0;
  await db.transaction('rw', db.syncOutbox, async () => {
    const rows = await db.syncOutbox
      .filter((r) => r.mutation.entity === 'expense' && Array.isArray(r.mutation.data?.comments) && (r.mutation.data.comments as unknown[]).length > 0)
      .toArray();
    const comments: SyncPushMutation[] = [];
    for (const row of rows) {
      for (const c of row.mutation.data!.comments as Array<Record<string, unknown>>) {
        if (c.authorName !== authorName || typeof c.id !== 'string') continue;
        comments.push({
          entity: 'expense_comment',
          id: c.id,
          op: 'upsert',
          hlc: hlc(),
          data: { id: c.id, expenseId: row.mutation.id, body: c.body, createdAt: c.createdAt },
        });
      }
    }
    await db.syncOutbox.bulkPut(rows.map((r) => ({ ...r, mutation: { ...r.mutation, data: { ...r.mutation.data, comments: [] } } })));
    await putOutbox(db, comments);
    moved = comments.length;
  });
  return moved;
}

export async function clearSyncOutbox(): Promise<void> {
  memoryOutbox = [];
  const db = getLocalDb();
  if (!db) return;

  try {
    await db.syncOutbox.clear();
  } catch {
    // Ignore IndexedDB unavailability
  }
}

export async function getKvValue<T>(key: string): Promise<T | null> {
  let raw: string | undefined = memoryKv.get(key);
  const db = getLocalDb();
  if (db) {
    try {
      raw = (await db.kvStore.get(key))?.valueJson;
    } catch {
      // Fall back to memory kv
    }
  }
  if (raw === undefined) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function setKvValue(key: string, value: unknown): Promise<void> {
  const valueJson = JSON.stringify(value);
  memoryKv.set(key, valueJson);
  const db = getLocalDb();
  if (!db) return;
  try {
    await db.kvStore.put({ key, valueJson, updatedAt: new Date().toISOString() });
  } catch {
    // Ignore IndexedDB unavailability
  }
}

export async function deleteKvValue(key: string): Promise<void> {
  memoryKv.delete(key);
  const db = getLocalDb();
  if (!db) return;
  try {
    await db.kvStore.delete(key);
  } catch {
    // Ignore IndexedDB unavailability
  }
}

const cursorKey = (userId: string) => `sync_cursor:${userId}`;

export async function getSyncCursor(userId: string): Promise<string> {
  const value = await getKvValue<string>(cursorKey(userId));
  return typeof value === 'string' && /^\d+$/.test(value) ? value : '0';
}

export async function setSyncCursor(userId: string, cursor: string): Promise<void> {
  await setKvValue(cursorKey(userId), cursor);
}

const DEVICE_ID_KEY = 'device_id';

/** Random per-install id, kept across user switches, used to keep HLCs unique per device. */
export async function getDeviceId(): Promise<string> {
  const stored = await getKvValue<string>(DEVICE_ID_KEY);
  if (typeof stored === 'string' && /^[0-9a-f]{12}$/.test(stored)) return stored;
  const fresh = [...globalThis.crypto.getRandomValues(new Uint8Array(6))]
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
  await setKvValue(DEVICE_ID_KEY, fresh);
  return fresh;
}

/** Clears every user-scoped table, cursor, outbox and kv entry. Receipt blobs stay, keyed by owner. */
export async function wipeUserScopedData(): Promise<void> {
  const deviceId = await getKvValue<string>(DEVICE_ID_KEY);
  memoryDatasetSnapshot = null;
  memoryOutbox = [];
  memoryKv.clear();
  resetPositions();
  const db = getLocalDb();
  if (!db) {
    if (deviceId) memoryKv.set(DEVICE_ID_KEY, JSON.stringify(deviceId));
    return;
  }
  const tables = db.tables.filter((t) => t.name !== 'localReceiptBlobs');
  try {
    await db.transaction('rw', tables, async () => {
      await Promise.all(tables.map((table) => table.clear()));
    });
  } catch {
    // Ignore IndexedDB unavailability
  }
  if (deviceId) await setKvValue(DEVICE_ID_KEY, deviceId);
}

let receiptOwner: string | null = null;

/** Receipt reads return only blobs this user (null = signed out) attached. */
export function setReceiptOwner(userId: string | null): void {
  receiptOwner = userId;
}

const ownedBy = (owner: string | null) => (r: LocalReceiptBlobRecord) => (r.ownerUserId ?? null) === owner;

/** Stored under owner and receipt id, so two people's copies of one receipt never overwrite each other. */
const blobKey = (owner: string | null | undefined, receiptId: string) => `${owner ?? '~'}:${receiptId}`;
const stored = (r: LocalReceiptBlobRecord, owner: string | null): LocalReceiptBlobRecord => {
  const receiptId = r.receiptId ?? r.id;
  return { ...r, ownerUserId: owner, receiptId, id: blobKey(owner, receiptId) };
};
const shown = (r: LocalReceiptBlobRecord): LocalReceiptBlobRecord => ({ ...r, id: r.receiptId ?? r.id });

/** Moves blobs between owners (signed-out data brought into an account, or legacy blobs without an owner). */
export async function reassignReceiptBlobs(from: string | null | undefined, to: string | null): Promise<void> {
  const matches = (r: LocalReceiptBlobRecord) => (from === undefined ? !('ownerUserId' in r) : ownedBy(from)(r));
  memoryReceiptBlobs = memoryReceiptBlobs.map((r) => (matches(r) ? stored(r, to) : r));
  const db = getLocalDb();
  if (!db) return;
  try {
    await db.transaction('rw', db.localReceiptBlobs, async () => {
      const rows = await db.localReceiptBlobs.filter(matches).toArray();
      await db.localReceiptBlobs.bulkDelete(rows.map((r) => r.id));
      await db.localReceiptBlobs.bulkPut(rows.map((r) => stored(r, to)));
    });
  } catch {
    // Ignore IndexedDB unavailability
  }
}

export async function deleteReceiptBlobsOwnedBy(owner: string | null): Promise<void> {
  memoryReceiptBlobs = memoryReceiptBlobs.filter((r) => !ownedBy(owner)(r));
  const db = getLocalDb();
  if (!db) return;
  try {
    await db.localReceiptBlobs.filter(ownedBy(owner)).delete();
  } catch {
    // Ignore IndexedDB unavailability
  }
}

export async function saveReceiptBlobLocally(
  record: LocalReceiptBlobRecord
): Promise<void> {
  const owned = stored(record, record.ownerUserId ?? receiptOwner);
  memoryReceiptBlobs = [...memoryReceiptBlobs.filter((item) => item.id !== owned.id), owned];
  const db = getLocalDb();
  if (!db) return;

  try {
    await db.localReceiptBlobs.put(owned);
  } catch {
    // Ignore IndexedDB unavailability
  }
}

export async function getLocalReceiptBlobsForExpense(
  expenseId: string
): Promise<LocalReceiptBlobRecord[]> {
  const db = getLocalDb();
  if (db) {
    try {
      const rows = await db.localReceiptBlobs
        .where('expenseId')
        .equals(expenseId)
        .filter(ownedBy(receiptOwner))
        .toArray();
      if (rows.length > 0) {
        return rows.map(shown);
      }
    } catch {
      // Fallback to memory blobs
    }
  }
  return memoryReceiptBlobs.filter((item) => item.expenseId === expenseId && ownedBy(receiptOwner)(item)).map(shown);
}

export async function listAllLocalReceiptBlobs(): Promise<LocalReceiptBlobRecord[]> {
  const db = getLocalDb();
  if (db) {
    try {
      const rows = await db.localReceiptBlobs.orderBy('createdAt').filter(ownedBy(receiptOwner)).toArray();
      if (rows.length > 0) {
        return rows.map(shown);
      }
    } catch {
      // Fallback to memory blobs
    }
  }
  return memoryReceiptBlobs.filter(ownedBy(receiptOwner)).map(shown);
}
