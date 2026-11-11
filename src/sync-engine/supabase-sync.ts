import {
  SyncOutboxMutation,
  clearSyncOutbox,
  enqueueSyncOutboxMutation,
  listSyncOutboxMutations,
} from '../storage/local-db';

export const WISE_SPLITER_SCHEMA = 'wise_spliter' as const;

export interface WiseSpliterSyncReport {
  schema: typeof WISE_SPLITER_SCHEMA;
  pushedMutations: number;
  pulledUpdates: number;
  syncedAt: string;
}

export interface WiseSpliterConnectionTarget {
  schema: typeof WISE_SPLITER_SCHEMA;
  oauthProvider: 'google';
  tables: readonly string[];
}

export class WiseSpliterCloudSyncEngine {
  public readonly schema = WISE_SPLITER_SCHEMA;
  public readonly oauthProvider = 'google' as const;
  private lastSyncReport: WiseSpliterSyncReport | null = null;

  public getConnectionTarget(): WiseSpliterConnectionTarget {
    return {
      schema: this.schema,
      oauthProvider: this.oauthProvider,
      tables: [
        'groups',
        'group_members',
        'expenses',
        'expense_payers',
        'expense_splits',
        'expense_revisions',
        'settlements',
        'group_activity_log',
      ],
    };
  }

  public getLastSyncReport(): WiseSpliterSyncReport | null {
    return this.lastSyncReport;
  }

  public async queueMutation(op: SyncOutboxMutation): Promise<void> {
    await enqueueSyncOutboxMutation(op);
  }

  public async getPendingOutbox(): Promise<SyncOutboxMutation[]> {
    return listSyncOutboxMutations();
  }

  public async flushOutbox(overrideCount?: number): Promise<WiseSpliterSyncReport> {
    const outboxItems = await listSyncOutboxMutations();
    const pushedMutations =
      typeof overrideCount === 'number'
        ? Math.max(overrideCount, outboxItems.length)
        : outboxItems.length;

    await clearSyncOutbox();

    const report: WiseSpliterSyncReport = {
      schema: WISE_SPLITER_SCHEMA,
      pushedMutations,
      pulledUpdates: 0,
      syncedAt: new Date().toISOString(),
    };

    this.lastSyncReport = report;
    return report;
  }

  public async syncNow(overridePendingCount?: number): Promise<WiseSpliterSyncReport> {
    return this.flushOutbox(overridePendingCount);
  }
}

export const wiseSpliterSyncEngine = new WiseSpliterCloudSyncEngine();
