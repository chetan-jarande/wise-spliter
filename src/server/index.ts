/**
 * Wise-Spliter Backend API (`node:http`, API_PORT 4174). Authenticates callers with HMAC session
 * tokens and forwards every read and write to the wise_spliter RPCs with the verified actor id;
 * the database decides tenant access. Fails closed (503) when the database is unreachable.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createClient, type User } from '@supabase/supabase-js';
import type { SyncPushResult } from '../types/sync-contract';
import { SYNC_PULL_MAX_LIMIT, SYNC_PUSH_MAX_MUTATIONS } from '../types/sync-contract';
import {
  DEMO_SANDBOX_USER,
  assertNumericEnv,
  assertProductionSecretsConfigured,
  buildSecurityHeaders,
  envNum,
  checkAuthLoginRateLimit,
  checkJoinRateLimit,
  checkRateLimit,
  clearAuthLoginFailures,
  isDemoEnabled,
  isOriginAllowed,
  issueSessionToken,
  recordAuthLoginFailure,
  serializeClearSessionCookie,
  serializeSessionCookie,
  validateCsrfAndOrigin,
  verifyRequestAuth,
  type AuthResult,
} from './securityAndAuth';
import {
  PushBusy,
  DbForbidden,
  DbUnavailable,
  SUPABASE_SCHEMA,
  SUPABASE_URL,
  bumpTokenVersion,
  checkSupabaseSchemaHealth,
  claimMembers,
  deleteAccount,
  getProfileById,
  getSupabaseAdmin,
  joinGroup,
  pullChanges,
  pushMutations,
  requireEnv,
  resolveProfileForAuthUser,
  type SessionProfile,
} from './supabaseAdmin';
import { validateMutation, type ValidatedMutation } from './syncRows';

assertProductionSecretsConfigured();
assertNumericEnv();

/**
 * With GoTrue auto-confirm on, anyone can register a password account on someone else's email and
 * later inherit it when the owner signs in with Google. Production refuses to start in that mode
 * and re-checks every 10 minutes; the password and Google routes fail closed if it flips on.
 */
let confirmationCheck: { ok: boolean; at: number } | null = null;
export async function assertEmailConfirmationRequired(): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/settings`, { headers: { apikey: SUPABASE_PUBLISHABLE_KEY } });
  const settings = (await res.json()) as { mailer_autoconfirm?: unknown };
  const ok = res.ok && settings.mailer_autoconfirm === false;
  confirmationCheck = { ok, at: Date.now() };
  if (!ok) {
    throw new Error('[security] FATAL: production requires Supabase Auth email confirmation (mailer_autoconfirm must be false).');
  }
}

async function requireEmailConfirmationInProduction(): Promise<void> {
  if (process.env.NODE_ENV !== 'production') return;
  if (!confirmationCheck || Date.now() - confirmationCheck.at > 10 * 60_000) {
    await assertEmailConfirmationRequired().catch(() => undefined);
  }
  if (!confirmationCheck?.ok) throw new HttpError(503, 'Sign-in is disabled until email confirmation is enforced');
}

export function resetEmailConfirmationCacheForTests(): void {
  confirmationCheck = null;
}

export const API_PORT = Number(process.env.API_PORT || 4174);
export const API_HOST = (process.env.API_HOST || '127.0.0.1').trim();
export const MAX_JSON_BODY_BYTES = Math.max(1024, envNum('MAX_JSON_BODY_BYTES', 256 * 1024));

const SUPABASE_PUBLISHABLE_KEY =
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ||
  process.env.VITE_SUPABASE_ANON_KEY?.trim() ||
  requireEnv('VITE_SUPABASE_PUBLISHABLE_KEY');

class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

function sendJson(req: IncomingMessage, res: ServerResponse, status: number, payload: unknown, extra?: Record<string, string>): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...(status === 413 ? { Connection: 'close' } : {}),
    ...buildSecurityHeaders(req.headers['origin'] as string | undefined),
    ...(extra ?? {}),
  });
  res.end(JSON.stringify(payload), () => {
    if (status === 413 && !req.complete) req.destroy();
  });
}

async function readJsonBody(req: IncomingMessage, maxBytes = MAX_JSON_BODY_BYTES): Promise<Record<string, unknown>> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    req.pause();
    throw new HttpError(413, `Payload too large: maximum request body is ${maxBytes} bytes`);
  }
  const text = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      total += chunk.length;
      if (total > maxBytes) {
        done = true;
        req.pause();
        reject(new HttpError(413, `Payload too large: maximum request body is ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => !done && ((done = true), resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', (err) => !done && ((done = true), reject(err)));
  });
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new HttpError(400, 'Request body must be a JSON object');
}

function sessionResponse(req: IncomingMessage, res: ServerResponse, s: SessionProfile, authMethod: string, extra: object = {}): void {
  const token = issueSessionToken({ userId: s.profile.id, tokenVersion: s.tokenVersion });
  sendJson(req, res, 200, { ok: true, authMethod, token, profile: s.profile, ...extra }, { 'Set-Cookie': serializeSessionCookie(token) });
}

async function requireAuth(req: IncomingMessage): Promise<Extract<AuthResult, { authenticated: true }>> {
  const auth = await verifyRequestAuth(req);
  if (!auth.authenticated) throw new HttpError(auth.status, auth.error);
  return auth;
}

const isGoogleUser = (u: User): boolean => {
  const app = (u.app_metadata ?? {}) as { provider?: unknown; providers?: unknown };
  return app.provider === 'google' || (Array.isArray(app.providers) && app.providers.includes('google'));
};

function sessionUsedOAuth(accessToken: string): boolean {
  try {
    const claims = JSON.parse(Buffer.from(accessToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as { amr?: unknown };
    return Array.isArray(claims.amr) && claims.amr.some((m) => (m as { method?: unknown })?.method === 'oauth');
  } catch {
    return false;
  }
}

function displayNameOf(u: User): string | undefined {
  const meta = (u.user_metadata ?? {}) as Record<string, unknown>;
  const name = meta.full_name ?? meta.name;
  return typeof name === 'string' ? name : undefined;
}

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>;


const routes: Record<string, Handler> = {
  'GET /api/health': async (req, res) => {
    const health = await checkSupabaseSchemaHealth();
    sendJson(req, res, 200, { ok: true, service: 'wise-spliter-api', schema: SUPABASE_SCHEMA, supabaseReachable: health.reachable, timestamp: new Date().toISOString() });
  },

  // Server-side demo sessions exist only outside production; the production client demos offline.
  'POST /api/auth/demo': async (req, res) => {
    if (!isDemoEnabled()) throw new HttpError(404, 'Demo sandbox is offline-only in production');
    const body = await readJsonBody(req, 16 * 1024);
    for (const [k, v] of [['userId', DEMO_SANDBOX_USER.userId], ['email', DEMO_SANDBOX_USER.email]] as const) {
      if (typeof body[k] === 'string' && (body[k] as string).trim() && (body[k] as string).trim().toLowerCase() !== v) {
        throw new HttpError(403, 'Forbidden: the demo login only issues sessions for the demo profile');
      }
    }
    const demo = await getProfileById(DEMO_SANDBOX_USER.userId);
    if (!demo) throw new HttpError(503, 'Demo profile is not seeded (run make setup-dev)');
    sessionResponse(req, res, demo, 'demo');
  },

  'POST /api/auth/google': async (req, res) => {
    const body = await readJsonBody(req, 16 * 1024);
    const accessToken = typeof body.accessToken === 'string' ? body.accessToken.trim() : '';
    if (!accessToken) throw new HttpError(401, 'Missing Google access token');
    await requireEmailConfirmationInProduction();
    const { data, error } = await getSupabaseAdmin().auth.getUser(accessToken);
    const user = data?.user;
    // GoTrue verified the token above; its amr says how this session was authenticated. A session
    // from a password sign-in must not pass as Google, even once the account has a Google identity.
    if (error || !user?.email || !user.email_confirmed_at || !isGoogleUser(user) || !sessionUsedOAuth(accessToken)) {
      throw new HttpError(401, 'Invalid, unverified, or non-Google access token');
    }
    const session = await resolveProfileForAuthUser({ authUid: user.id, email: user.email, fullName: displayNameOf(user), create: true });
    if (!session) throw new HttpError(401, 'This Google account is linked to a different profile');
    const claimedGroupCount = await claimMembers(session.profile.id);
    sessionResponse(req, res, session, 'google', { claimedGroupCount });
  },

  'POST /api/auth/login': async (req, res) => {
    const body = await readJsonBody(req, 16 * 1024);
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const limit = checkAuthLoginRateLimit(req, email);
    if (!limit.allowed) {
      sendJson(req, res, 429, { ok: false, error: 'Too many failed login attempts. Please wait before trying again.', retryAfterSec: limit.retryAfterSec }, { 'Retry-After': String(limit.retryAfterSec ?? 900) });
      return;
    }
    // Count the attempt before awaiting GoTrue, so a concurrent burst cannot all pass the check;
    // a successful sign-in clears the (account, IP) counter.
    recordAuthLoginFailure(req, email);
    const reject = (): never => {
      throw new HttpError(401, 'Invalid email or password');
    };
    if (!email || !password || password.length > 256) return reject();
    await requireEmailConfirmationInProduction();

    const authClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data, error } = await authClient.auth.signInWithPassword({ email, password });
    const user = data?.user;
    if (error || !user?.email || !user.email_confirmed_at) return reject();
    // Only accounts that already have a wise_spliter profile; users of other apps in the project are not accepted.
    // A Google-linked account never signs in by password: a password set by whoever pre-registered
    // that email (before the owner used Google) must not open the owner's ledger.
    const session = await resolveProfileForAuthUser({ authUid: user!.id, email: user!.email!, create: false });
    if (!session || session.profile.googleConnected || isGoogleUser(user!)) return reject();
    clearAuthLoginFailures(req, email);
    await claimMembers(session!.profile.id);
    sessionResponse(req, res, session!, 'password');
  },

  // Revokes every token of the user (token_version bump) and clears the cookie.
  'POST /api/auth/logout': async (req, res) => {
    const auth = await verifyRequestAuth(req);
    if (!auth.authenticated && auth.status === 503) throw new HttpError(503, 'Could not revoke the session; try again');
    if (auth.authenticated) await bumpTokenVersion(auth.session.profile.id, auth.session.tokenVersion);
    sendJson(req, res, 200, { ok: true }, { 'Set-Cookie': serializeClearSessionCookie() });
  },

  // Sliding renewal: a valid, unrevoked token gets a fresh 12 h token with the same original
  // sign-in time; after the absolute lifetime (SESSION_MAX_LIFETIME_DAYS) a real sign-in is required.
  'POST /api/auth/session': async (req, res) => {
    const auth = await requireAuth(req);
    let token: string;
    try {
      token = issueSessionToken({ userId: auth.session.profile.id, tokenVersion: auth.session.tokenVersion, authTime: auth.payload.aat });
    } catch {
      throw new HttpError(401, 'Session expired; sign in again');
    }
    sendJson(req, res, 200, { ok: true, authMethod: 'session', token, profile: auth.session.profile }, { 'Set-Cookie': serializeSessionCookie(token) });
  },

  'GET /api/ledger/pull': async (req, res, url) => {
    const auth = await requireAuth(req);
    const cursor = url.searchParams.get('cursor') ?? '0';
    const groupId = url.searchParams.get('groupId');
    const expenseId = url.searchParams.get('expenseId');
    for (const v of [groupId, expenseId]) {
      if (v !== null && !/^[A-Za-z0-9_-]{1,80}$/.test(v)) throw new HttpError(400, 'invalid groupId or expenseId');
    }
    if (groupId !== null && expenseId !== null) throw new HttpError(400, 'pass groupId or expenseId, not both');
    const limitRaw = url.searchParams.get('limit') ?? String(SYNC_PULL_MAX_LIMIT);
    if (!/^\d{1,18}$/.test(cursor)) throw new HttpError(400, 'cursor must be a non-negative integer string');
    if (!/^\d{1,9}$/.test(limitRaw) || Number(limitRaw) < 1) throw new HttpError(400, 'limit must be a positive integer');
    const limit = Math.min(Number(limitRaw), SYNC_PULL_MAX_LIMIT);
    sendJson(req, res, 200, await pullChanges(auth.session.profile.id, cursor, limit, { groupId, expenseId }));
  },

  'POST /api/ledger/push': async (req, res) => {
    const auth = await requireAuth(req);
    const body = await readJsonBody(req);
    const raw = body.mutations;
    if (!Array.isArray(raw) || raw.length > SYNC_PUSH_MAX_MUTATIONS) {
      throw new HttpError(400, `mutations must be an array of at most ${SYNC_PUSH_MAX_MUTATIONS}`);
    }
    // One push in flight per account is enforced in the database (per-actor try-lock), so it
    // holds across API replicas; a busy account gets 429 and retries.
    try {
      sendJson(req, res, 200, { results: await applyMutations(auth.session.profile.id, raw) });
    } catch (err) {
      if (err instanceof PushBusy) throw new HttpError(429, 'Another push for this account is still running');
      throw err;
    }
  },

  // Join by invite code (40-bit server codes): rate limited per account and IP, plus a per-account
  // daily failed-code cap in the database. The client then backfills the group with ?groupId=.
  'POST /api/groups/join': async (req, res) => {
    const auth = await requireAuth(req);
    const limit = checkJoinRateLimit(req, auth.session.profile.id);
    if (!limit.allowed) {
      sendJson(req, res, 429, { ok: false, error: 'Too many join attempts. Please wait before trying again.', retryAfterSec: limit.retryAfterSec }, { 'Retry-After': String(limit.retryAfterSec ?? 600) });
      return;
    }
    const body = await readJsonBody(req, 4 * 1024);
    const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
    if (!/^WS-[0-9A-F]{10}$/.test(code)) throw new HttpError(400, 'Invalid invite code');
    const r = await joinGroup(auth.session.profile.id, code);
    if (r.error === 'locked') {
      const now = new Date();
      const retryAfterSec = Math.max(1, Math.ceil((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now.getTime()) / 1000));
      sendJson(req, res, 429, { ok: false, error: 'Too many wrong invite codes today. Try again tomorrow.', retryAfterSec }, { 'Retry-After': String(retryAfterSec) });
      return;
    }
    if (r.error === 'removed_by_admin') throw new HttpError(403, 'An admin removed you from this group; ask them to add you back');
    if (r.error !== undefined) throw new HttpError(r.error === 'group_full' ? 409 : 404, r.error === 'group_full' ? 'This group is full' : 'No group has this invite code');
    sendJson(req, res, 200, { ok: true, groupId: r.groupId, memberId: r.memberId, status: r.status });
  },

  // Receipt pointer only (the image stays on-device); same authorization as a push.
  'POST /api/receipts/upload': async (req, res) => {
    const auth = await requireAuth(req);
    const body = await readJsonBody(req);
    const { dataUrl: _blob, hlc, id, ...meta } = body;
    const [result] = await applyMutations(auth.session.profile.id, [
      {
        entity: 'receipt_pointer',
        id,
        op: 'upsert',
        hlc: typeof hlc === 'string' ? hlc : `${Date.now().toString(16).padStart(12, '0')}-0000-${auth.session.profile.id}`,
        data: meta,
      },
    ]);
    const status = result!.status === 'applied' || result!.status === 'stale' ? 200 : result!.status === 'forbidden' ? 403 : 400;
    sendJson(req, res, status, {
      ok: status === 200,
      bucket: 'local-device-only',
      localDeviceOnly: true,
      storageUploaded: false,
      receiptId: result!.id,
      metadataPersisted: result!.status === 'applied',
      ...(status === 200 ? {} : { error: result!.reason ?? result!.status }),
    });
  },

  // Deletes the wise_spliter profile and personal data; auth.users is shared with another app and kept.
  'POST /api/account/delete': async (req, res) => {
    const auth = await requireAuth(req);
    await deleteAccount(auth.session.profile.id);
    res.writeHead(204, { ...buildSecurityHeaders(req.headers['origin'] as string | undefined), 'Set-Cookie': serializeClearSessionCookie() });
    res.end();
  },
};

async function applyMutations(actor: string, raw: unknown[]): Promise<SyncPushResult[]> {
  const results: SyncPushResult[] = new Array(raw.length);
  const valid: Array<{ i: number; m: ValidatedMutation }> = [];
  raw.forEach((item, i) => {
    const v = validateMutation(item);
    if (v.ok) valid.push({ i, m: v.m });
    else results[i] = { id: v.id, entity: v.entity as SyncPushResult['entity'], status: 'invalid', reason: v.reason };
  });
  const applied = await pushMutations(actor, valid.map((v) => v.m));
  const byKey = new Map(applied.map((r) => [`${r.entity}:${r.id}`, r]));
  for (const { i, m } of valid) {
    results[i] = byKey.get(`${m.entity}:${m.id}`) ?? { id: m.id, entity: m.entity, status: 'invalid', reason: 'not processed' };
  }
  return results;
}

export async function handleApiRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const origin = req.headers['origin'];
    if (req.method === 'OPTIONS') {
      if (typeof origin === 'string' && !isOriginAllowed(origin)) throw new HttpError(403, 'Forbidden: disallowed CORS preflight origin');
      res.writeHead(204, buildSecurityHeaders(origin));
      res.end();
      return;
    }
    const csrf = validateCsrfAndOrigin(req);
    if (!csrf.allowed) throw new HttpError(csrf.status, csrf.error);
    const limit = checkRateLimit(req);
    if (!limit.allowed) {
      sendJson(req, res, 429, { ok: false, error: 'Rate limit exceeded. Please retry later.', retryAfterSec: limit.retryAfterSec }, { 'Retry-After': String(limit.retryAfterSec ?? 60) });
      return;
    }
    const url = new URL(req.url || '/', 'http://api.local');
    const handler = routes[`${req.method} ${url.pathname}`];
    if (!handler) throw new HttpError(404, 'Route not found');
    await handler(req, res, url);
  } catch (err) {
    if (res.headersSent) return;
    if (err instanceof HttpError) {
      sendJson(req, res, err.status, { ok: false, error: err.message });
    } else if (err instanceof DbForbidden) {
      sendJson(req, res, 403, { ok: false, error: 'Forbidden' });
    } else if (err instanceof DbUnavailable) {
      sendJson(req, res, 503, { ok: false, error: 'Service temporarily unavailable' });
    } else {
      console.error('[wise-spliter-api] unhandled error:', err);
      sendJson(req, res, 500, { ok: false, error: 'Internal server error' });
    }
  }
}

export const apiServer = createServer((req, res) => {
  void handleApiRequest(req, res);
});

apiServer.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') return;
  console.error('[wise-spliter-api] Server error:', err);
});

if (!process.env.VITEST && process.env.WISE_SPLITER_NO_AUTO_LISTEN !== '1') {
  if (process.env.NODE_ENV === 'production') {
    await assertEmailConfirmationRequired().catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
  }
  apiServer.listen(API_PORT, API_HOST, () => {
    console.log(`[wise-spliter-api] Listening on http://${API_HOST}:${API_PORT} (schema: ${SUPABASE_SCHEMA})`);
  });
}
