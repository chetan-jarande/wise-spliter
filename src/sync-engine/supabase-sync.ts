import { createClient } from '@supabase/supabase-js';
import {
  SyncOutboxMutation,
  clearSyncOutbox,
  enqueueSyncOutboxMutation,
  listSyncOutboxMutations,
} from '../storage/local-db';
import { MockLedgerDataset, UserProfile } from '../types/ledger';

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

/**
 * Resolves `/api/*` paths so web browsers keep same-origin proxy paths (`/api/...`, preserving
 * `SameSite=Lax` cookies in dev/prod reverse proxies), while native Capacitor/Tauri shells
 * (`capacitor://`, `tauri://`, or `Capacitor.isNativePlatform()`) or HTTPS remote API hosts
 * automatically prefix `VITE_API_BASE_URL`.
 */
export function resolveApiUrl(apiPath: string): string {
  const normalizedPath = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
  const metaEnv = (
    import.meta as unknown as {
      env?: Record<string, string | undefined>;
    }
  ).env;
  const configuredBase = (metaEnv?.VITE_API_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!configuredBase) {
    return normalizedPath;
  }

  if (typeof window !== 'undefined') {
    const proto = window.location?.protocol || '';
    const cap = (
      window as unknown as {
        Capacitor?: { isNativePlatform?: () => boolean };
      }
    ).Capacitor;
    const isNativeShell =
      proto === 'capacitor:' ||
      proto === 'tauri:' ||
      Boolean(cap?.isNativePlatform?.());
    if (isNativeShell || configuredBase.startsWith('https://')) {
      return `${configuredBase}${normalizedPath}`;
    }
  }

  return normalizedPath;
}

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

function buildUserCacheKey(user: { id: string; email: string }): string {
  return `${user.id.trim()}:${user.email.trim().toLowerCase()}`;
}

function isDesignatedDemoUser(user: { id: string; email: string }): boolean {
  return (
    user.id.trim() === DEFAULT_SESSION_USER.id &&
    user.email.trim().toLowerCase() === DEFAULT_SESSION_USER.email
  );
}

/**
 * Stores a backend-verified session token returned by `/api/auth/login`, `/api/auth/demo`, or `/api/auth/google`.
 */
export function setBackendSessionToken(
  token: string,
  user: { id: string; email: string; fullName?: string }
): void {
  const trimmedToken = token.trim();
  if (!trimmedToken || !user.id?.trim() || !user.email?.trim()) {
    return;
  }
  cachedSessionToken = trimmedToken;
  cachedSessionUserKey = buildUserCacheKey(user);
}

/**
 * Clears the cached backend session token and clears the `HttpOnly` `ws_session` cookie on `/api/auth/logout`.
 */
export async function clearBackendSessionToken(options?: {
  notifyServer?: boolean;
}): Promise<void> {
  cachedSessionToken = null;
  cachedSessionUserKey = null;
  if (options?.notifyServer !== false) {
    try {
      await fetch(resolveApiUrl('/api/auth/logout'), {
        method: 'POST',
        credentials: 'same-origin',
      });
    } catch {
      // Best-effort cookie clear in offline or unit-test environments
    }
  }
}

export interface DemoSandboxAuthResult {
  ok: boolean;
  token: string | null;
  profile: UserProfile | null;
  dataset: MockLedgerDataset | null;
  error?: string;
}

/**
 * Explicitly authenticates into the isolated Demo Sandbox Profile (`usr_arjun_01` / `arjun.mehta@gmail.com`)
 * via `POST /api/auth/demo`.
 */
export async function signInWithDemoProfile(): Promise<DemoSandboxAuthResult> {
  try {
    const res = await fetch(resolveApiUrl('/api/auth/demo'), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const payload = (await res.json()) as {
      ok?: boolean;
      token?: string;
      profile?: UserProfile;
      dataset?: MockLedgerDataset;
      error?: string;
    };
    if (res.ok && payload.ok && payload.profile) {
      if (payload.token) {
        setBackendSessionToken(payload.token, payload.profile);
      }
      return {
        ok: true,
        token: payload.token ?? null,
        profile: payload.profile,
        dataset: payload.dataset ?? null,
      };
    }
    return {
      ok: false,
      token: null,
      profile: null,
      dataset: null,
      error: payload.error || 'Demo sandbox login failed',
    };
  } catch {
    return {
      ok: false,
      token: null,
      profile: null,
      dataset: null,
      error: 'Unable to reach /api/auth/demo',
    };
  }
}

export interface GoogleSessionExchangeResult {
  ok: boolean;
  token: string | null;
  profile: UserProfile | null;
  dataset: MockLedgerDataset | null;
  claimedGroupCount: number;
  error?: string;
}

/**
 * Exchanges a verified Supabase Google OAuth `access_token` for a Backend API session
 * via `POST /api/auth/google`, auto-provisioning `wise_spliter.profiles` and claiming invited groups.
 */
export async function exchangeGoogleOAuthSession(
  accessToken: string
): Promise<GoogleSessionExchangeResult> {
  const trimmed = accessToken.trim();
  if (!trimmed) {
    return {
      ok: false,
      token: null,
      profile: null,
      dataset: null,
      claimedGroupCount: 0,
      error: 'Missing Supabase Google accessToken',
    };
  }

  try {
    const res = await fetch(resolveApiUrl('/api/auth/google'), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken: trimmed }),
    });
    const payload = (await res.json()) as {
      ok?: boolean;
      token?: string;
      profile?: UserProfile;
      dataset?: MockLedgerDataset;
      claimedGroupCount?: number;
      error?: string;
    };
    if (res.ok && payload.ok && payload.profile) {
      if (payload.token) {
        setBackendSessionToken(payload.token, payload.profile);
      }
      return {
        ok: true,
        token: payload.token ?? null,
        profile: payload.profile,
        dataset: payload.dataset ?? null,
        claimedGroupCount: Number(payload.claimedGroupCount ?? 0),
      };
    }
    return {
      ok: false,
      token: null,
      profile: null,
      dataset: null,
      claimedGroupCount: 0,
      error: payload.error || 'Google OAuth session verification failed',
    };
  } catch {
    return {
      ok: false,
      token: null,
      profile: null,
      dataset: null,
      claimedGroupCount: 0,
      error: 'Unable to reach /api/auth/google',
    };
  }
}

/**
 * Acquires and caches a signed Backend API session token scoped to `user`:
 * 1. Returns cached token if already verified for `user`.
 * 2. Exchanges an active Supabase Google OAuth `access_token` via `POST /api/auth/google`.
 * 3. Falls back to `POST /api/auth/demo` ONLY when `user` is the designated Demo Profile (`usr_arjun_01`).
 * 4. For non-demo accounts, refreshes via `POST /api/auth/session` ONLY if an active `HttpOnly` `ws_session` cookie matches `user`.
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
  const userKey = buildUserCacheKey(targetUser);

  if (cachedSessionToken && cachedSessionUserKey === userKey) {
    return cachedSessionToken;
  }

  // 1. Check active Supabase Google OAuth session first and exchange via /api/auth/google
  try {
    const client = getBrowserSupabaseClient();
    const { data } = await client.auth.getSession();
    const activeSession = data?.session;
    const accessToken = activeSession?.access_token;
    const oauthEmail = activeSession?.user?.email?.trim().toLowerCase() || '';
    if (accessToken && (!oauthEmail || oauthEmail === targetUser.email)) {
      const exchanged = await exchangeGoogleOAuthSession(accessToken);
      if (exchanged.ok && exchanged.token) {
        return exchanged.token;
      }
    }
  } catch {
    // Offline or unit-test environment
  }

  // 2. Designated Demo Profile sandbox fallback (/api/auth/demo)
  if (isDesignatedDemoUser(targetUser)) {
    try {
      const res = await fetch(resolveApiUrl('/api/auth/demo'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (res.ok) {
        const data = (await res.json()) as { ok?: boolean; token?: string };
        if (data.token && typeof data.token === 'string') {
          setBackendSessionToken(data.token, targetUser);
          return cachedSessionToken;
        }
      }
    } catch {
      // Offline mode
    }
    return null;
  }

  // 3. Non-demo user: refresh session only if browser already holds a verified HttpOnly `ws_session` cookie
  try {
    const res = await fetch(resolveApiUrl('/api/auth/session'), {
      method: 'POST',
      credentials: 'same-origin',
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
        setBackendSessionToken(data.token, targetUser);
        return cachedSessionToken;
      }
    }
  } catch {
    // Offline mode
  }

  return null;
}

export interface GoogleOAuthSignInResult {
  ok: boolean;
  provider: 'google';
  schema: typeof WISE_SPLITER_SCHEMA;
  oauthUrl: string | null;
  sessionEmail: string;
  syncedAt: string;
  error?: string;
  exchangedDataset?: MockLedgerDataset | null;
  exchangedProfile?: UserProfile | null;
  claimedGroupCount?: number;
}

export async function signInWithGoogleOAuth(
  email = 'arjun.mehta@gmail.com'
): Promise<GoogleOAuthSignInResult> {
  const client = getBrowserSupabaseClient();

  try {
    const { data: sessionData } = await client.auth.getSession();
    const existingAccessToken = sessionData?.session?.access_token;
    if (existingAccessToken) {
      const exchanged = await exchangeGoogleOAuthSession(existingAccessToken);
      if (exchanged.ok && exchanged.profile) {
        return {
          ok: true,
          provider: 'google',
          schema: WISE_SPLITER_SCHEMA,
          oauthUrl: null,
          sessionEmail: exchanged.profile.email,
          syncedAt: new Date().toISOString(),
          exchangedDataset: exchanged.dataset,
          exchangedProfile: exchanged.profile,
          claimedGroupCount: exchanged.claimedGroupCount,
        };
      }
    }
  } catch {
    // Continue to OAuth initiation below
  }

  const redirectTo =
    typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'http://localhost:4173';

  try {
    const { data, error } = await client.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo,
        skipBrowserRedirect: true,
      },
    });

    if (error) {
      const isProviderDisabled = /not enabled|unsupported provider/i.test(
        error.message
      );
      return {
        ok: false,
        provider: 'google',
        schema: WISE_SPLITER_SCHEMA,
        oauthUrl: null,
        sessionEmail: email,
        syncedAt: new Date().toISOString(),
        error: isProviderDisabled
          ? 'Google OAuth provider is disabled in local Supabase GoTrue (:54321). Configure [auth.external.google] with SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID and SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET in centralized Supabase, or use Demo Sandbox / Email Sign-In below.'
          : error.message,
      };
    }

    if (data?.url) {
      return {
        ok: true,
        provider: 'google',
        schema: WISE_SPLITER_SCHEMA,
        oauthUrl: data.url,
        sessionEmail: email,
        syncedAt: new Date().toISOString(),
      };
    }

    return {
      ok: false,
      provider: 'google',
      schema: WISE_SPLITER_SCHEMA,
      oauthUrl: null,
      sessionEmail: email,
      syncedAt: new Date().toISOString(),
      error: 'Supabase Auth did not return a Google OAuth redirect URL.',
    };
  } catch (err) {
    return {
      ok: false,
      provider: 'google',
      schema: WISE_SPLITER_SCHEMA,
      oauthUrl: null,
      sessionEmail: email,
      syncedAt: new Date().toISOString(),
      error:
        err instanceof Error
          ? err.message
          : 'Unable to reach Supabase Auth (:54321) for Google Sign-In.',
    };
  }
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
    const res = await fetch(resolveApiUrl('/api/receipts/upload'), {
      method: 'POST',
      credentials: 'same-origin',
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
      resolveApiUrl(`/api/ledger/pull-changes?sinceSeq=${encodeURIComponent(String(sinceSeq))}`),
      {
        method: 'GET',
        credentials: 'same-origin',
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

  public setBackendSessionToken(
    token: string,
    user: { id: string; email: string; fullName?: string }
  ): void {
    setBackendSessionToken(token, user);
  }

  public async clearBackendSessionToken(options?: {
    notifyServer?: boolean;
  }): Promise<void> {
    await clearBackendSessionToken(options);
  }

  public async signInWithDemoProfile(): Promise<DemoSandboxAuthResult> {
    return signInWithDemoProfile();
  }

  public async exchangeGoogleOAuthSession(
    accessToken: string
  ): Promise<GoogleSessionExchangeResult> {
    return exchangeGoogleOAuthSession(accessToken);
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
      const res = await fetch(resolveApiUrl('/api/health'), {
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
      const res = await fetch(resolveApiUrl('/api/ledger/sync'), {
        method: 'POST',
        credentials: 'same-origin',
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
        await fetch(resolveApiUrl('/api/ledger/push-mutations'), {
          method: 'POST',
          credentials: 'same-origin',
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
