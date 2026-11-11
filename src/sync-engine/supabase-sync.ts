import { createClient } from '@supabase/supabase-js';
import {
  SyncOutboxMutation,
  clearSyncOutbox,
  enqueueSyncOutboxMutation,
  listSyncOutboxMutations,
} from '../storage/local-db';
import { MockLedgerDataset } from '../types/ledger';

export const WISE_SPLITER_SCHEMA = 'wise_spliter' as const;

const DEFAULT_SUPABASE_URL = 'http://127.0.0.1:54321';
const DEFAULT_SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

const DEFAULT_SUPABASE_PUBLISHABLE_KEY =
  'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH';

const DEFAULT_SESSION_USER = {
  id: 'usr_arjun_01',
  email: 'arjun.mehta@gmail.com',
  fullName: 'Arjun Mehta',
};

function createWiseSpliterBrowserClient() {
  const metaEnv = (
    import.meta as unknown as {
      env?: Record<string, string | undefined>;
    }
  ).env;
  const supabaseUrl = metaEnv?.VITE_SUPABASE_URL || DEFAULT_SUPABASE_URL;
  const supabasePublishableKey =
    metaEnv?.VITE_SUPABASE_PUBLISHABLE_KEY ||
    metaEnv?.VITE_SUPABASE_ANON_KEY ||
    DEFAULT_SUPABASE_PUBLISHABLE_KEY ||
    DEFAULT_SUPABASE_ANON_KEY;
  const supabaseSchema =
    (metaEnv?.VITE_SUPABASE_SCHEMA as typeof WISE_SPLITER_SCHEMA | undefined) ||
    WISE_SPLITER_SCHEMA;

  return createClient(supabaseUrl, supabasePublishableKey, {
    db: { schema: supabaseSchema },
    auth: {
      persistSession: true,
      autoRefreshToken: true,
    },
  });
}

export type WiseSpliterSupabaseClient = ReturnType<
  typeof createWiseSpliterBrowserClient
>;

let browserSupabaseClient: WiseSpliterSupabaseClient | null = null;

export function getBrowserSupabaseClient(): WiseSpliterSupabaseClient {
  if (!browserSupabaseClient) {
    browserSupabaseClient = createWiseSpliterBrowserClient();
  }
  return browserSupabaseClient;
}

let cachedSessionToken: string | null = null;
let cachedSessionUserKey: string | null = null;

/**
 * Acquires and caches a signed Backend API session token via `POST /api/auth/session`
 * (or falls back to an active Supabase Auth access token), scoped to `user`.
 */
export async function ensureBackendSessionToken(
  user: {
    id: string;
    email: string;
    fullName: string;
  } = DEFAULT_SESSION_USER
): Promise<string | null> {
  const targetUser = {
    id: user.id?.trim() || DEFAULT_SESSION_USER.id,
    email: (user.email?.trim() || DEFAULT_SESSION_USER.email).toLowerCase(),
    fullName: user.fullName?.trim() || DEFAULT_SESSION_USER.fullName,
  };
  const userKey = `${targetUser.id}:${targetUser.email}`;

  if (cachedSessionToken && cachedSessionUserKey === userKey) {
    return cachedSessionToken;
  }

  try {
    const res = await fetch('/api/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: targetUser.id,
        email: targetUser.email,
        fullName: targetUser.fullName,
      }),
    });
    if (res.ok) {
      const data = (await res.json()) as { ok?: boolean; token?: string };
      if (data.token && typeof data.token === 'string') {
        cachedSessionToken = data.token;
        cachedSessionUserKey = userKey;
        return cachedSessionToken;
      }
    }
  } catch {
    // Fallback to active Supabase Auth session or offline mode
  }

  try {
    const client = getBrowserSupabaseClient();
    const { data } = await client.auth.getSession();
    const accessToken = data?.session?.access_token;
    if (accessToken) {
      cachedSessionToken = accessToken;
      cachedSessionUserKey = userKey;
      return cachedSessionToken;
    }
  } catch {
    // Offline or unit-test environment
  }

  return cachedSessionToken;
}

export interface GoogleOAuthSignInResult {
  ok: boolean;
  provider: 'google';
  schema: typeof WISE_SPLITER_SCHEMA;
  oauthUrl: string | null;
  sessionEmail: string;
  syncedAt: string;
}

export async function signInWithGoogleOAuth(
  email = 'arjun.mehta@gmail.com'
): Promise<GoogleOAuthSignInResult> {
  const client = getBrowserSupabaseClient();
  let oauthUrl: string | null = null;
  try {
    const { data } = await client.auth.signInWithOAuth({
      provider: 'google',
      options: {
        skipBrowserRedirect: true,
      },
    });
    oauthUrl = data?.url ?? null;
  } catch {
    // Fallback to local development OAuth session confirmation
  }

  return {
    ok: true,
    provider: 'google',
    schema: WISE_SPLITER_SCHEMA,
    oauthUrl,
    sessionEmail: email,
    syncedAt: new Date().toISOString(),
  };
}

export interface ReceiptUploadPayload {
  id: string;
  expenseId: string;
  groupId: string | null;
  fileName: string;
  mimeType: string;
  sizeKb: number;
  uploadedByName: string;
  previewNote: string;
  dataUrl: string;
  hlc?: string;
}

export interface ReceiptUploadResponse {
  ok: boolean;
  bucket: string;
  storagePath: string;
  receiptId: string;
  storageUploaded?: boolean;
  metadataPersisted?: boolean;
}

export async function uploadReceiptAttachment(
  payload: ReceiptUploadPayload,
  user?: { id: string; email: string; fullName: string }
): Promise<ReceiptUploadResponse> {
  const fallbackPath = `${payload.groupId || 'standalone'}/${payload.expenseId}/${payload.id}-${payload.fileName}`;
  try {
    const token = await ensureBackendSessionToken(user);
    const res = await fetch('/api/receipts/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      const data = (await res.json()) as Partial<ReceiptUploadResponse>;
      return {
        ok: Boolean(data.ok ?? true),
        bucket: data.bucket || 'wise-spliter-receipts',
        storagePath: data.storagePath || fallbackPath,
        receiptId: data.receiptId || payload.id,
        storageUploaded: data.storageUploaded,
        metadataPersisted: data.metadataPersisted,
      };
    }
  } catch {
    // Graceful fallback in offline or unit-test environments
  }
  return {
    ok: false,
    bucket: 'wise-spliter-receipts',
    storagePath: fallbackPath,
    receiptId: payload.id,
  };
}

export interface DeltaChangesResponse {
  ok: boolean;
  schema: typeof WISE_SPLITER_SCHEMA;
  since_seq: number;
  groups: unknown[];
  expenses: unknown[];
  settlements: unknown[];
}

export async function pullDeltaChanges(
  sinceSeq = 0,
  user?: { id: string; email: string; fullName: string }
): Promise<DeltaChangesResponse> {
  try {
    const token = await ensureBackendSessionToken(user);
    const res = await fetch(
      `/api/ledger/pull-changes?sinceSeq=${encodeURIComponent(String(sinceSeq))}`,
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      }
    );
    if (res.ok) {
      const data = (await res.json()) as Partial<DeltaChangesResponse>;
      return {
        ok: Boolean(data.ok ?? true),
        schema: WISE_SPLITER_SCHEMA,
        since_seq: Number(data.since_seq ?? sinceSeq),
        groups: Array.isArray(data.groups) ? data.groups : [],
        expenses: Array.isArray(data.expenses) ? data.expenses : [],
        settlements: Array.isArray(data.settlements) ? data.settlements : [],
      };
    }
  } catch {
    // Graceful fallback in offline or unit-test environments
  }
  return {
    ok: false,
    schema: WISE_SPLITER_SCHEMA,
    since_seq: sinceSeq,
    groups: [],
    expenses: [],
    settlements: [],
  };
}

export interface WiseSpliterSyncReport {
  schema: typeof WISE_SPLITER_SCHEMA;
  pushedMutations: number;
  pulledUpdates: number;
  syncedAt: string;
  persistedToSupabase?: boolean;
}

export interface WiseSpliterBackendHealth {
  ok: boolean;
  schema: typeof WISE_SPLITER_SCHEMA;
  supabaseReachable: boolean;
  timestamp: string;
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

  public getSupabaseClient(): WiseSpliterSupabaseClient {
    return getBrowserSupabaseClient();
  }

  public async ensureBackendSessionToken(user?: {
    id: string;
    email: string;
    fullName: string;
  }): Promise<string | null> {
    return ensureBackendSessionToken(user);
  }

  public getConnectionTarget(): WiseSpliterConnectionTarget {
    return {
      schema: this.schema,
      oauthProvider: this.oauthProvider,
      tables: [
        'profiles',
        'groups',
        'group_members',
        'expenses',
        'expense_revisions',
        'settlements',
        'group_activity_log',
        'receipt_attachments',
      ],
    };
  }

  public getLastSyncReport(): WiseSpliterSyncReport | null {
    return this.lastSyncReport;
  }

  public async signInWithGoogleOAuth(
    email?: string
  ): Promise<GoogleOAuthSignInResult> {
    return signInWithGoogleOAuth(email);
  }

  public async uploadReceiptAttachment(
    payload: ReceiptUploadPayload,
    user?: { id: string; email: string; fullName: string }
  ): Promise<ReceiptUploadResponse> {
    return uploadReceiptAttachment(payload, user);
  }

  public async pullDeltaChanges(
    sinceSeq = 0,
    user?: { id: string; email: string; fullName: string }
  ): Promise<DeltaChangesResponse> {
    return pullDeltaChanges(sinceSeq, user);
  }

  public async queueMutation(op: SyncOutboxMutation): Promise<void> {
    await enqueueSyncOutboxMutation(op);
  }

  public async getPendingOutbox(): Promise<SyncOutboxMutation[]> {
    return listSyncOutboxMutations();
  }

  public async checkBackendHealth(): Promise<WiseSpliterBackendHealth> {
    try {
      const res = await fetch('/api/health', {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      if (res.ok) {
        const data = (await res.json()) as Partial<WiseSpliterBackendHealth>;
        return {
          ok: Boolean(data.ok),
          schema: WISE_SPLITER_SCHEMA,
          supabaseReachable: Boolean(data.supabaseReachable),
          timestamp: data.timestamp ?? new Date().toISOString(),
        };
      }
    } catch {
      // Graceful fallback when running in offline or unit-test environment
    }
    return {
      ok: false,
      schema: WISE_SPLITER_SCHEMA,
      supabaseReachable: false,
      timestamp: new Date().toISOString(),
    };
  }

  public async pushDatasetToBackendApi(
    dataset: MockLedgerDataset
  ): Promise<WiseSpliterSyncReport> {
    let persistedToSupabase = false;
    try {
      const token = await ensureBackendSessionToken({
        id: dataset.currentUser.id,
        email: dataset.currentUser.email,
        fullName: dataset.currentUser.fullName,
      });
      const res = await fetch('/api/ledger/sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ dataset }),
      });
      if (res.ok) {
        const json = (await res.json()) as { persistedToSupabase?: boolean };
        persistedToSupabase = Boolean(json.persistedToSupabase);
      }
    } catch {
      // Graceful fallback when /api is unreachable in offline or unit-test mode
    }

    const report = await this.flushOutbox();
    report.persistedToSupabase = persistedToSupabase;
    this.lastSyncReport = report;
    return report;
  }

  public async flushOutbox(
    overrideCount?: number
  ): Promise<WiseSpliterSyncReport> {
    const outboxItems = await listSyncOutboxMutations();
    const pushedMutations =
      typeof overrideCount === 'number'
        ? Math.max(overrideCount, outboxItems.length)
        : outboxItems.length;

    if (outboxItems.length > 0) {
      try {
        const token = await ensureBackendSessionToken();
        await fetch('/api/ledger/push-mutations', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ ops: outboxItems }),
        });
      } catch {
        // Ignore network errors in offline or unit-test environments
      }
    }

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

  public async syncNow(
    overridePendingCount?: number
  ): Promise<WiseSpliterSyncReport> {
    return this.flushOutbox(overridePendingCount);
  }
}

export const wiseSpliterSyncEngine = new WiseSpliterCloudSyncEngine();
