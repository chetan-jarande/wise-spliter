import { createClient } from '@supabase/supabase-js';
import { deleteKvValue, getKvValue, setKvValue } from '../storage/local-db';
import { MockLedgerDataset, UserProfile } from '../types/ledger';

export const WISE_SPLITER_SCHEMA = 'wise_spliter' as const;

const DEFAULT_SESSION_USER = {
  id: 'usr_arjun_01',
  email: 'arjun.mehta@example.com',
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
    if (isNativeShell() || configuredBase.startsWith('https://')) {
      return `${configuredBase}${normalizedPath}`;
    }
  }

  return normalizedPath;
}

function isNativeShell(): boolean {
  if (typeof window === 'undefined') return false;
  const proto = window.location?.protocol || '';
  const cap = (
    window as unknown as {
      Capacitor?: { isNativePlatform?: () => boolean };
    }
  ).Capacitor;
  return proto === 'capacitor:' || proto === 'tauri:' || Boolean(cap?.isNativePlatform?.());
}

function createWiseSpliterBrowserClient() {
  const metaEnv = (
    import.meta as unknown as {
      env?: Record<string, string | undefined>;
    }
  ).env;
  const supabaseUrl = metaEnv?.VITE_SUPABASE_URL;
  const supabasePublishableKey =
    metaEnv?.VITE_SUPABASE_PUBLISHABLE_KEY || metaEnv?.VITE_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabasePublishableKey) {
    throw new Error(
      'VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY must be set at build time (see .env.example).'
    );
  }
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

export interface SessionIdentity {
  id: string;
  email: string;
  fullName: string;
}

interface PersistedSession extends SessionIdentity {
  token: string | null;
}

const SESSION_KV_KEY = 'auth_session_v1';
/** Sign-out never waits on a slow network longer than this. */
const LOGOUT_TIMEOUT_MS = 5000;
const REFRESH_BEFORE_EXPIRY_SEC = 2 * 60 * 60;

let cachedSession: PersistedSession | null = null;

export function isDesignatedDemoUser(user: { id: string; email: string }): boolean {
  return (
    user.id.trim() === DEFAULT_SESSION_USER.id &&
    user.email.trim().toLowerCase() === DEFAULT_SESSION_USER.email
  );
}

function tokenExpirySec(token: string): number | null {
  try {
    const payload = token.split('.')[1] ?? '';
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    return typeof exp === 'number' ? exp : null;
  } catch {
    return null;
  }
}

/** Web keeps the bearer token in memory (HttpOnly cookie re-mints it); native shells persist it in Dexie. */
function persistSession(): Promise<void> {
  if (!cachedSession) return deleteKvValue(SESSION_KV_KEY);
  return setKvValue(SESSION_KV_KEY, {
    ...cachedSession,
    token: isNativeShell() ? cachedSession.token : null,
  });
}

export async function loadPersistedSession(): Promise<SessionIdentity | null> {
  const stored = await getKvValue<PersistedSession>(SESSION_KV_KEY);
  if (!stored || typeof stored.id !== 'string' || typeof stored.email !== 'string') {
    return null;
  }
  cachedSession = {
    id: stored.id,
    email: stored.email,
    fullName: typeof stored.fullName === 'string' ? stored.fullName : stored.email,
    token: typeof stored.token === 'string' && stored.token ? stored.token : null,
  };
  return { id: cachedSession.id, email: cachedSession.email, fullName: cachedSession.fullName };
}

/**
 * Stores the signed-in identity and its backend-verified session token from
 * `/api/auth/login`, `/api/auth/demo`, `/api/auth/google` or `/api/auth/session`.
 */
export function setBackendSessionToken(
  token: string | null,
  user: { id: string; email: string; fullName?: string }
): Promise<void> {
  const id = user.id?.trim();
  const email = user.email?.trim().toLowerCase();
  if (!id || !email) return Promise.resolve();
  cachedSession = {
    id,
    email,
    fullName: user.fullName?.trim() || email,
    token: token?.trim() || null,
  };
  return persistSession();
}

/** Drops a token the server rejected but keeps the identity, so the same user can sign back in without losing local edits. */
export function markSessionTokenRejected(): Promise<void> {
  if (cachedSession) cachedSession = { ...cachedSession, token: null };
  return persistSession();
}

/**
 * Clears the session (memory + device) and the `HttpOnly` session cookie (`__Host-ws_session`, never read by the client) via `/api/auth/logout`.
 */
export async function clearBackendSessionToken(options?: {
  notifyServer?: boolean;
}): Promise<void> {
  const token = cachedSession?.token;
  cachedSession = null;
  await persistSession();
  if (options?.notifyServer !== false) {
    try {
      await fetch(resolveApiUrl('/api/auth/logout'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(LOGOUT_TIMEOUT_MS),
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
 * Explicitly authenticates into the isolated Demo Sandbox Profile (`usr_arjun_01` / `arjun.mehta@example.com`)
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

export type SessionTokenResult =
  | { token: string; reason?: undefined }
  | { token: null; reason: 'unauthorized' | 'offline' };

async function mintViaSessionEndpoint(
  user: SessionIdentity,
  bearer: string | null
): Promise<Response | null> {
  try {
    return await fetch(resolveApiUrl('/api/auth/session'), {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify({ userId: user.id, email: user.email, fullName: user.fullName }),
    });
  } catch {
    return null;
  }
}

async function readToken(res: Response | null): Promise<string | null> {
  if (!res?.ok) return null;
  try {
    const data = (await res.json()) as { token?: unknown };
    return typeof data.token === 'string' && data.token ? data.token : null;
  } catch {
    return null;
  }
}

/**
 * Returns a bearer token for the signed-in `user` only:
 * 1. The cached token, refreshed via `/api/auth/session` when it is within a day of expiry.
 * 2. Otherwise re-mints through an active Supabase Google session, the Demo sandbox,
 *    or the `HttpOnly` session cookie (`__Host-ws_session`, never read by the client) (web).
 */
export async function resolveSessionToken(user: SessionIdentity): Promise<SessionTokenResult> {
  const target: SessionIdentity = {
    id: user.id.trim(),
    email: user.email.trim().toLowerCase(),
    fullName: user.fullName.trim() || user.email,
  };
  const matches = cachedSession?.id === target.id && cachedSession.email === target.email;
  const nowSec = Math.floor(Date.now() / 1000);
  const cachedToken = matches ? cachedSession?.token ?? null : null;
  const exp = cachedToken ? tokenExpirySec(cachedToken) : null;

  if (cachedToken && (exp === null || exp - nowSec > REFRESH_BEFORE_EXPIRY_SEC)) {
    return { token: cachedToken };
  }

  if (cachedToken && exp !== null && exp > nowSec) {
    const refreshed = await readToken(await mintViaSessionEndpoint(target, cachedToken));
    if (refreshed) {
      await setBackendSessionToken(refreshed, target);
      return { token: refreshed };
    }
    return { token: cachedToken };
  }

  try {
    const client = getBrowserSupabaseClient();
    const { data } = await client.auth.getSession();
    const accessToken = data?.session?.access_token;
    const oauthEmail = data?.session?.user?.email?.trim().toLowerCase() || '';
    if (accessToken && oauthEmail === target.email) {
      const exchanged = await exchangeGoogleOAuthSession(accessToken);
      if (exchanged.ok && exchanged.token && exchanged.profile?.id === target.id) {
        await setBackendSessionToken(exchanged.token, target);
        return { token: exchanged.token };
      }
    }
  } catch {
    // Supabase client not configured, offline, or unit-test environment
  }

  if (isDesignatedDemoUser(target)) {
    const demo = await signInWithDemoProfile();
    if (demo.ok && demo.token) {
      await setBackendSessionToken(demo.token, target);
      return { token: demo.token };
    }
    return { token: null, reason: 'offline' };
  }

  const res = await mintViaSessionEndpoint(target, null);
  const minted = await readToken(res);
  if (minted) {
    await setBackendSessionToken(minted, target);
    return { token: minted };
  }
  return { token: null, reason: res && (res.status === 401 || res.status === 403) ? 'unauthorized' : 'offline' };
}

export async function ensureBackendSessionToken(user: SessionIdentity): Promise<string | null> {
  return (await resolveSessionToken(user)).token;
}

export type AccountDeletionResult = 'deleted' | 'unauthorized' | 'failed';

export async function requestAccountDeletion(user: SessionIdentity): Promise<AccountDeletionResult> {
  const auth = await resolveSessionToken(user);
  if (!auth.token) return auth.reason === 'unauthorized' ? 'unauthorized' : 'failed';
  try {
    const res = await fetch(resolveApiUrl('/api/account/delete'), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Authorization: `Bearer ${auth.token}` },
    });
    if (res.ok) return 'deleted';
    return res.status === 401 ? 'unauthorized' : 'failed';
  } catch {
    return 'failed';
  }
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
  exchangedToken?: string | null;
  claimedGroupCount?: number;
}

export async function signInWithGoogleOAuth(
  email = ''
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
          exchangedToken: exchanged.token,
          claimedGroupCount: exchanged.claimedGroupCount,
        };
      }
    }
  } catch {
    // Continue to OAuth initiation below
  }

  const redirectTo =
    typeof window !== 'undefined' ? window.location?.origin : undefined;

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
          ? 'Google OAuth provider is disabled in local Supabase GoTrue. Configure [auth.external.google] with SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID and SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET in centralized Supabase, or use Demo Sandbox / Email Sign-In below.'
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
          : 'Unable to reach Supabase Auth for Google Sign-In.',
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
  user: SessionIdentity
): Promise<ReceiptUploadResponse> {
  const fallbackPath = `local-device/${payload.groupId || 'standalone'}/${payload.expenseId}/${payload.id}-${payload.fileName}`;
  const metadataOnlyPayload: ReceiptUploadPayload = {
    ...payload,
    dataUrl: '',
  };
  try {
    const token = await ensureBackendSessionToken(user);
    const res = await fetch(resolveApiUrl('/api/receipts/upload'), {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(metadataOnlyPayload),
    });
    if (res.ok) {
      const data = (await res.json()) as Partial<ReceiptUploadResponse>;
      return {
        ok: Boolean(data.ok ?? true),
        bucket: data.bucket || 'local-device-only',
        storagePath: data.storagePath || fallbackPath,
        receiptId: data.receiptId || payload.id,
        storageUploaded: false,
        metadataPersisted: data.metadataPersisted,
      };
    }
  } catch {
    // Graceful fallback in offline or unit-test environments
  }
  return {
    ok: false,
    bucket: 'local-device-only',
    storagePath: fallbackPath,
    receiptId: payload.id,
    storageUploaded: false,
  };
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

  public getSupabaseClient(): WiseSpliterSupabaseClient {
    return getBrowserSupabaseClient();
  }

  public async signInWithDemoProfile(): Promise<DemoSandboxAuthResult> {
    return signInWithDemoProfile();
  }

  public async exchangeGoogleOAuthSession(
    accessToken: string
  ): Promise<GoogleSessionExchangeResult> {
    return exchangeGoogleOAuthSession(accessToken);
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

  public async signInWithGoogleOAuth(
    email?: string
  ): Promise<GoogleOAuthSignInResult> {
    return signInWithGoogleOAuth(email);
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
}

export const wiseSpliterSyncEngine = new WiseSpliterCloudSyncEngine();
