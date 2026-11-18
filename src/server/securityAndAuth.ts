/**
 * Session tokens, request authentication, CORS/CSRF, security headers and rate limiting.
 * Tenant authorization is NOT here: it runs inside the wise_spliter RPCs (migration 0004).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { isIPv6 } from 'node:net';
import { DbUnavailable, getProfileById, requireEnv, type SessionProfile } from './supabaseAdmin';

export const DEMO_SANDBOX_USER = {
  userId: 'usr_arjun_01',
  email: 'arjun.mehta@example.com',
  fullName: 'Arjun Mehta',
} as const;

// __Host- prefix: Secure, Path=/, no Domain, so no sibling subdomain can set or shadow it.
export const SESSION_COOKIE_NAME = '__Host-ws_session' as const;
export const SESSION_TOKEN_TTL_SEC = 12 * 60 * 60;
export const SAFE_IDENTIFIER_REGEX = /^[a-zA-Z0-9_-]{1,80}$/;

const isProduction = (): boolean => process.env.NODE_ENV === 'production';

/** Positive numeric env with default; a malformed value throws instead of silently becoming NaN. */
export function envNum(name: string, dflt: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`[config] ${name} must be a positive number (got "${raw}")`);
  return n;
}

export const NUMERIC_ENV_DEFAULTS: Record<string, number> = {
  RATE_LIMIT_WINDOW_SEC: 60,
  API_RATE_LIMIT: 120,
  AUTH_RATE_LIMIT_MAX: 10,
  AUTH_RATE_LIMIT_WINDOW_SEC: 900,
  RATE_LIMIT_MAX_KEYS: 10_000,
  SESSION_MAX_LIFETIME_DAYS: 30,
  MAX_JSON_BODY_BYTES: 256 * 1024,
};

/** Startup check: every tunable must parse, so a typo cannot disable a limiter. */
export function assertNumericEnv(): void {
  for (const [k, v] of Object.entries(NUMERIC_ENV_DEFAULTS)) envNum(k, v);
}

/** Tokens are only valid for the environment that issued them. */
export const tokenAudience = (): string => `wise-spliter:${process.env.SESSION_AUDIENCE?.trim() || process.env.NODE_ENV || 'development'}`;

export function isDemoEnabled(): boolean {
  return !isProduction();
}

export function assertProductionSecretsConfigured(): void {
  if (!isProduction()) return;
  const secret = process.env.GRANT_TOKEN_SECRET?.trim() ?? '';
  if (secret.length < 32) {
    throw new Error(
      '[security] FATAL: NODE_ENV=production requires a unique GRANT_TOKEN_SECRET of at least 32 characters.'
    );
  }
}

function getGrantTokenSecret(): string {
  assertProductionSecretsConfigured();
  return requireEnv('GRANT_TOKEN_SECRET');
}

const b64url = (input: string | Buffer): string =>
  (typeof input === 'string' ? Buffer.from(input, 'utf8') : input).toString('base64url');

const TOKEN_HEADER = b64url(JSON.stringify({ alg: 'HS256', typ: 'WS-JWT' }));

export interface SessionTokenPayload {
  aud: string;
  sub: string;
  tv: number;
  aat: number;
  iat: number;
  exp: number;
}

/** Absolute session lifetime from the original sign-in; sliding renewal stops after it. */
export const sessionMaxLifetimeSec = (): number =>
  Math.max(SESSION_TOKEN_TTL_SEC, envNum('SESSION_MAX_LIFETIME_DAYS', 30) * 86400);

/**
 * Signs `{ sub, tv, aat, iat, exp }`; identity details always come from the DB, never the token.
 * `aat` is the original sign-in time and is carried unchanged through renewals.
 */
export function issueSessionToken(user: { userId: string; tokenVersion: number; authTime?: number }): string {
  const sub = user.userId.trim();
  if (!SAFE_IDENTIFIER_REGEX.test(sub) && !/^[0-9a-f-]{36}$/.test(sub)) {
    throw new Error('Cannot issue session token: invalid subject');
  }
  const iat = Math.floor(Date.now() / 1000);
  const aat = user.authTime ?? iat;
  const exp = Math.min(iat + SESSION_TOKEN_TTL_SEC, aat + sessionMaxLifetimeSec());
  if (exp <= iat) throw new Error('Session reached its absolute lifetime; sign in again');
  const payload: SessionTokenPayload = { aud: tokenAudience(), sub, tv: user.tokenVersion, aat, iat, exp };
  const signingInput = `${TOKEN_HEADER}.${b64url(JSON.stringify(payload))}`;
  return `${signingInput}.${b64url(createHmac('sha256', getGrantTokenSecret()).update(signingInput).digest())}`;
}

/** Pure HMAC check: 3 parts, our header, a valid signature, unexpired bounded `exp`, `aat` within the absolute lifetime. */
export function verifySessionToken(token: string): SessionTokenPayload | null {
  try {
    const parts = token.trim().split('.');
    if (parts.length !== 3 || parts[0] !== TOKEN_HEADER) return null;
    const [header, body, sig] = parts as [string, string, string];
    const expected = Buffer.from(b64url(createHmac('sha256', getGrantTokenSecret()).update(`${header}.${body}`).digest()));
    const actual = Buffer.from(sig);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<SessionTokenPayload>;
    const now = Math.floor(Date.now() / 1000);
    const ints = [p.tv, p.aat, p.iat, p.exp];
    if (p.aud !== tokenAudience() || typeof p.sub !== 'string' || !p.sub || !ints.every((n) => Number.isSafeInteger(n))) return null;
    const { tv, aat, iat, exp } = p as SessionTokenPayload;
    if (exp <= now || exp - iat > SESSION_TOKEN_TTL_SEC || iat > now + 60 || aat > iat || now - aat > sessionMaxLifetimeSec()) {
      return null;
    }
    return { aud: p.aud, sub: p.sub, tv, aat, iat, exp };
  } catch {
    return null;
  }
}

function cookieAttrs(maxAge: number): string[] {
  return ['HttpOnly', 'Secure', 'Path=/', 'SameSite=Lax', `Max-Age=${maxAge}`];
}

export function serializeSessionCookie(token: string): string {
  return [`${SESSION_COOKIE_NAME}=${encodeURIComponent(token.trim())}`, ...cookieAttrs(SESSION_TOKEN_TTL_SEC)].join('; ');
}

export function serializeClearSessionCookie(): string {
  return [`${SESSION_COOKIE_NAME}=`, ...cookieAttrs(0)].join('; ');
}

export function parseRequestCookies(cookieHeader: string | string[] | undefined): Record<string, string> {
  const raw = Array.isArray(cookieHeader) ? cookieHeader.join('; ') : (cookieHeader ?? '');
  const out: Record<string, string> = {};
  for (const pair of raw.split(';')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    const val = pair.slice(eq + 1).trim();
    try {
      out[key] = decodeURIComponent(val);
    } catch {
      out[key] = val;
    }
  }
  return out;
}

export function extractBearerOrSessionToken(req: IncomingMessage): string | null {
  const auth = req.headers['authorization'];
  const m = typeof auth === 'string' ? /^Bearer\s+(\S+)$/i.exec(auth.trim()) : null;
  if (m?.[1]) return m[1];
  const header = req.headers['x-wise-spliter-session'];
  const h = Array.isArray(header) ? header[0] : header;
  if (h?.trim()) return h.trim();
  return parseRequestCookies(req.headers['cookie'])[SESSION_COOKIE_NAME]?.trim() || null;
}

export type AuthResult =
  | { authenticated: true; token: string; payload: SessionTokenPayload; session: SessionProfile }
  | { authenticated: false; status: 401 | 503; error: string };

/**
 * Only our HMAC session tokens are accepted on data routes. The token must match the profile's
 * current token_version (bumped on logout) and the profile must still exist (account deletion).
 */
export async function verifyRequestAuth(req: IncomingMessage): Promise<AuthResult> {
  const token = extractBearerOrSessionToken(req);
  const payload = token ? verifySessionToken(token) : null;
  if (!token || !payload || (!isDemoEnabled() && payload.sub === DEMO_SANDBOX_USER.userId)) {
    return { authenticated: false, status: 401, error: 'Invalid or missing session token' };
  }
  try {
    const session = await getProfileById(payload.sub);
    if (!session || session.tokenVersion !== payload.tv) {
      return { authenticated: false, status: 401, error: 'Invalid or missing session token' };
    }
    return { authenticated: true, token, payload, session };
  } catch (err) {
    if (err instanceof DbUnavailable) return { authenticated: false, status: 503, error: 'Service temporarily unavailable' };
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------
// Rate limiting
// ponytail: per-process fixed windows; several API replicas each allow the full quota.
// Upgrade to a shared store (Postgres or Redis token bucket) when running more than one instance.
// ---------------------------------------------------------------------------------------------

interface RateLimitBucket {
  count: number;
  resetAtMs: number;
}

const MAX_BUCKETS = Math.max(100, envNum('RATE_LIMIT_MAX_KEYS', 10_000));
const requestBuckets = new Map<string, RateLimitBucket>();
const loginFailureBuckets = new Map<string, RateLimitBucket>();
const joinBuckets = new Map<string, RateLimitBucket>();

/**
 * Map insertion order equals window start order (expired keys are re-inserted at the end), so
 * evicting the first key drops the oldest window in O(1) and a key flood cannot grow memory.
 */
function hit(map: Map<string, RateLimitBucket>, key: string, windowSec: number, nowMs: number): RateLimitBucket {
  const b = map.get(key);
  if (b && nowMs < b.resetAtMs) {
    b.count += 1;
    return b;
  }
  map.delete(key);
  while (map.size >= MAX_BUCKETS) map.delete(map.keys().next().value as string);
  const fresh = { count: 1, resetAtMs: nowMs + windowSec * 1000 };
  map.set(key, fresh);
  return fresh;
}

export function getRateLimitBucketCountForTests(): number {
  return requestBuckets.size + loginFailureBuckets.size;
}

export function resetRateLimiterForTests(): void {
  requestBuckets.clear();
  loginFailureBuckets.clear();
  joinBuckets.clear();
}

const rateLimitDisabled = (): boolean => ['1', 'true'].includes(process.env.RATE_LIMIT_DISABLED ?? '');

/**
 * TRUST_PROXY=cloudflare: CF-Connecting-IP (set by Cloudflare, overwritten on every request).
 * TRUST_PROXY=true|1: the rightmost X-Forwarded-For hop, the one our own proxy appended.
 * Otherwise the socket address; client-supplied headers are ignored.
 */
export function extractClientIp(req: IncomingMessage): string {
  const mode = process.env.TRUST_PROXY?.trim().toLowerCase();
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join(',') : (v ?? ''));
  if (mode === 'cloudflare') {
    const cf = first(req.headers['cf-connecting-ip']).trim();
    if (cf) return cf;
  } else if (mode === 'true' || mode === '1') {
    const hops = first(req.headers['x-forwarded-for']).split(',').map((h) => h.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1]!;
  }
  return req.socket?.remoteAddress || 'unknown';
}

/** IPv6 clients usually own a whole /64, so they are limited per /64; IPv4 (and mapped v4) per address. */
export function ipBucket(ip: string): string {
  const v4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (v4) return v4[1]!;
  if (!isIPv6(ip)) return ip;
  const [head = '', tail = ''] = ip.toLowerCase().split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const full = ip.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  return `${full.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/** Authenticated callers are limited per user (a shared NAT/proxy IP does not pool them). */
export function rateLimitKey(req: IncomingMessage): string {
  const token = extractBearerOrSessionToken(req);
  const payload = token ? verifySessionToken(token) : null;
  return payload ? `u:${payload.sub}` : `ip:${ipBucket(extractClientIp(req))}`;
}

export function checkRateLimit(req: IncomingMessage): { allowed: boolean; retryAfterSec?: number } {
  if (rateLimitDisabled()) return { allowed: true };
  const windowSec = envNum('RATE_LIMIT_WINDOW_SEC', 60);
  const max = envNum('API_RATE_LIMIT', 120);
  const nowMs = Date.now();
  const b = hit(requestBuckets, rateLimitKey(req), windowSec, nowMs);
  return b.count > max ? { allowed: false, retryAfterSec: Math.max(1, Math.ceil((b.resetAtMs - nowMs) / 1000)) } : { allowed: true };
}

/** (account, IP) so a third party cannot lock a victim out from elsewhere, plus a per-IP total. */
function loginKeys(req: IncomingMessage, email: string): [string, string] {
  const ip = ipBucket(extractClientIp(req));
  return [`acct:${ip}:${email.trim().toLowerCase() || 'unknown'}`, `ip:${ip}`];
}

/** Failed logins: max per (account, IP) and 2x that per IP, within the window. */
export function checkAuthLoginRateLimit(req: IncomingMessage, email: string): { allowed: boolean; retryAfterSec?: number } {
  if (rateLimitDisabled()) return { allowed: true };
  const max = envNum('AUTH_RATE_LIMIT_MAX', 10);
  const nowMs = Date.now();
  const [acct, ip] = loginKeys(req, email);
  for (const [key, limit] of [[acct, max], [ip, max * 2]] as const) {
    const b = loginFailureBuckets.get(key);
    if (b && nowMs < b.resetAtMs && b.count >= limit) {
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((b.resetAtMs - nowMs) / 1000)) };
    }
  }
  return { allowed: true };
}

export function recordAuthLoginFailure(req: IncomingMessage, email: string): void {
  const windowSec = envNum('AUTH_RATE_LIMIT_WINDOW_SEC', 900);
  for (const key of loginKeys(req, email)) hit(loginFailureBuckets, key, windowSec, Date.now());
}

/** A successful sign-in: forget the (account, IP) failures and give back the attempt it used on the IP. */
export function clearAuthLoginFailures(req: IncomingMessage, email: string): void {
  const [acct, ip] = loginKeys(req, email);
  loginFailureBuckets.delete(acct);
  const b = loginFailureBuckets.get(ip);
  if (b && b.count > 0) b.count -= 1;
}

/**
 * Invite-code joins: every attempt counts, 10 per account and 30 per IP per 10 minutes. The
 * per-account failed-code cap (20 per UTC day) lives in the database (join_group).
 */
export function checkJoinRateLimit(req: IncomingMessage, userId: string): { allowed: boolean; retryAfterSec?: number } {
  if (rateLimitDisabled()) return { allowed: true };
  const nowMs = Date.now();
  let retry = 0;
  for (const [key, max] of [[`u:${userId}`, 10], [`ip:${ipBucket(extractClientIp(req))}`, 30]] as const) {
    const b = hit(joinBuckets, key, 600, nowMs);
    if (b.count > max) retry = Math.max(retry, Math.ceil((b.resetAtMs - nowMs) / 1000));
  }
  return retry ? { allowed: false, retryAfterSec: retry } : { allowed: true };
}

// ---------------------------------------------------------------------------------------------
// CORS, CSRF and security headers
// ---------------------------------------------------------------------------------------------

const NATIVE_PLATFORM_ORIGINS = ['capacitor://localhost', 'ionic://localhost', 'tauri://localhost', 'https://tauri.localhost', 'https://localhost'];
const DEV_ONLY_ORIGINS = [
  'http://localhost',
  'http://tauri.localhost',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
  'http://localhost:4174',
  'http://127.0.0.1:4174',
];

export function getAllowedOrigins(): string[] {
  const configured = (process.env.ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean);
  const native = process.env.DISABLE_NATIVE_ORIGINS === 'true' ? [] : NATIVE_PLATFORM_ORIGINS;
  const base = isProduction()
    ? configured.filter((o) => o.startsWith('https://') || !/^http:\/\//.test(o))
    : [...configured, ...DEV_ONLY_ORIGINS];
  return Array.from(new Set([...base, ...native]));
}

export function isOriginAllowed(origin: string): boolean {
  const o = origin.trim();
  return Boolean(o) && o !== 'null' && getAllowedOrigins().includes(o);
}

export function validateCsrfAndOrigin(req: IncomingMessage): { allowed: true } | { allowed: false; status: 403; error: string } {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes((req.method || 'GET').toUpperCase())) return { allowed: true };
  const rawOrigin = req.headers['origin'];
  const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;
  if (typeof origin === 'string' && origin.trim()) {
    return isOriginAllowed(origin)
      ? { allowed: true }
      : { allowed: false, status: 403, error: 'Forbidden: disallowed cross-origin request' };
  }
  const site = req.headers['sec-fetch-site'];
  if ((Array.isArray(site) ? site[0] : site)?.trim().toLowerCase() === 'cross-site') {
    return { allowed: false, status: 403, error: 'Forbidden: cross-site request blocked' };
  }
  return { allowed: true };
}

export function buildSecurityHeaders(reqOrigin?: string): Record<string, string> {
  const trusted = Boolean(reqOrigin && isOriginAllowed(reqOrigin));
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Cache-Control': 'no-store',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    ...(trusted
      ? {
          'Access-Control-Allow-Origin': reqOrigin!.trim(),
          'Access-Control-Allow-Credentials': 'true',
          'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Wise-Spliter-Session',
          'Access-Control-Max-Age': '600',
        }
      : {}),
    Vary: 'Origin',
    ...(isProduction() ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
  };
}
