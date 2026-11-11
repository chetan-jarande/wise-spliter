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

export interface SyncOutboxMutation {
  id: string;
  entityType: string;
  action: string;
  payloadJson: string;
  createdAt: string;
  hlc: string;
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
  }
}

let dbInstance: WiseSpliterLocalDatabase | null = null;
let memoryDatasetSnapshot: MockLedgerDataset | null = null;
let memoryOutbox: SyncOutboxMutation[] = [];
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

export async function saveDatasetToIndexedDb(dataset: MockLedgerDataset): Promise<void> {
  memoryDatasetSnapshot = dataset;
  const db = getLocalDb();
  if (!db) return;

  try {
    const nowIso = new Date().toISOString();
    const allMembers = dataset.groups.flatMap((g) => g.members ?? []);
    await db.transaction(
      'rw',
      [
        db.groups,
        db.groupMembers,
        db.expenses,
        db.expenseRevisions,
        db.settlements,
        db.groupActivityLog,
        db.kvStore,
      ],
      async () => {
        await Promise.all([
          db.groups.clear(),
          db.groupMembers.clear(),
          db.expenses.clear(),
          db.expenseRevisions.clear(),
          db.settlements.clear(),
          db.groupActivityLog.clear(),
        ]);

        await Promise.all([
          db.groups.bulkPut(dataset.groups),
          db.groupMembers.bulkPut(allMembers),
          db.expenses.bulkPut(dataset.expenses),
          db.expenseRevisions.bulkPut(dataset.expenseRevisions),
          db.settlements.bulkPut(dataset.settlements),
          db.groupActivityLog.bulkPut(dataset.groupActivityLog),
          db.kvStore.put({
            key: DATASET_SNAPSHOT_KEY,
            valueJson: JSON.stringify(dataset),
            updatedAt: nowIso,
          }),
        ]);
      }
    );
  } catch {
    // Gracefully ignore IndexedDB errors in restricted/headless environments
  }
}

export async function loadDatasetFromIndexedDb(): Promise<MockLedgerDataset | null> {
  const db = getLocalDb();
  if (db) {
    try {
      const snap = await db.kvStore.get(DATASET_SNAPSHOT_KEY);
      if (snap?.valueJson) {
        const parsed = JSON.parse(snap.valueJson) as MockLedgerDataset;
        const [groups, expenses, expenseRevisions, settlements, groupActivityLog] =
          await Promise.all([
            db.groups.toArray(),
            db.expenses.toArray(),
            db.expenseRevisions.toArray(),
            db.settlements.toArray(),
            db.groupActivityLog.toArray(),
          ]);

        return {
          ...parsed,
          groups: groups.length > 0 ? groups : parsed.groups,
          expenses: expenses.length > 0 ? expenses : parsed.expenses,
          expenseRevisions:
            expenseRevisions.length > 0 ? expenseRevisions : parsed.expenseRevisions,
          settlements: settlements.length > 0 ? settlements : parsed.settlements,
          groupActivityLog:
            groupActivityLog.length > 0 ? groupActivityLog : parsed.groupActivityLog,
        };
      }
    } catch {
      // Fallback to in-memory snapshot if IndexedDB read fails
    }
  }
  return memoryDatasetSnapshot;
}

export async function enqueueSyncOutboxMutation(op: {
  id: string;
  entityType: string;
  action: string;
  payloadJson: string;
  createdAt: string;
  hlc: string;
}): Promise<void> {
  memoryOutbox = [...memoryOutbox.filter((item) => item.id !== op.id), op];
  const db = getLocalDb();
  if (!db) return;

  try {
    await db.syncOutbox.put(op);
  } catch {
    // Ignore IndexedDB unavailability
  }
}

export async function listSyncOutboxMutations(): Promise<SyncOutboxMutation[]> {
  const db = getLocalDb();
  if (db) {
    try {
      const rows = await db.syncOutbox.orderBy('createdAt').toArray();
      if (rows.length > 0) {
        return rows;
      }
    } catch {
      // Fallback to memory outbox
    }
  }
  return [...memoryOutbox];
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

export async function saveReceiptBlobLocally(
  record: LocalReceiptBlobRecord
): Promise<void> {
  memoryReceiptBlobs = [
    ...memoryReceiptBlobs.filter((item) => item.id !== record.id),
    record,
  ];
  const db = getLocalDb();
  if (!db) return;

  try {
    await db.localReceiptBlobs.put(record);
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
        .toArray();
      if (rows.length > 0) {
        return rows;
      }
    } catch {
      // Fallback to memory blobs
    }
  }
  return memoryReceiptBlobs.filter((item) => item.expenseId === expenseId);
}

export async function listAllLocalReceiptBlobs(): Promise<LocalReceiptBlobRecord[]> {
  const db = getLocalDb();
  if (db) {
    try {
      const rows = await db.localReceiptBlobs.orderBy('createdAt').toArray();
      if (rows.length > 0) {
        return rows;
      }
    } catch {
      // Fallback to memory blobs
    }
  }
  return [...memoryReceiptBlobs];
}

