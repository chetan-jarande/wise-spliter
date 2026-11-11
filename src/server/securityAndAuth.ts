/**
 * Wise-Spliter Backend Security, Authentication, User-Level Isolation,
 * CORS Allowlisting, Security Headers & Per-IP Rate Limiting (`src/server/securityAndAuth.ts`).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { MockLedgerDataset } from '../types/ledger';
import { getSupabaseAdmin } from './supabaseAdmin';

const DEFAULT_DEV_HMAC_SECRET =
  'wise_spliter_dev_hmac_secret_9f8e7d6c5b4a32109f8e7d6c5b4a3210';

const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:4173',
  'http://127.0.0.1:4173',
  'http://localhost:4174',
  'http://127.0.0.1:4174',
];

const SESSION_TOKEN_TTL_SEC = 60 * 60 * 24 * 7; // 7 days

export interface AuthenticatedUser {
  userId: string;
  email: string;
  fullName?: string;
}

export interface SessionTokenPayload {
  userId: string;
  email: string;
  fullName?: string;
  iat: number;
  exp: number;
}

export interface ExistingDbGroupAuthRecord {
  id: string;
  created_by: string;
  members: Array<{
    user_id: string | null;
    invited_email: string | null;
  }>;
}

function getGrantTokenSecret(): string {
  const secret = process.env.GRANT_TOKEN_SECRET?.trim();
  return secret || DEFAULT_DEV_HMAC_SECRET;
}

function base64UrlEncode(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlDecodeToString(input: string): string {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + '='.repeat(padLen);
  return Buffer.from(padded, 'base64').toString('utf8');
}

/**
 * Signs `{ userId, email: email.toLowerCase(), fullName, iat, exp }` with
 * `GRANT_TOKEN_SECRET` using `node:crypto` `createHmac('sha256', ...)`.
 */
export function issueSessionToken(user: {
  userId: string;
  email: string;
  fullName?: string;
}): string {
  const userId = user.userId.trim();
  const email = user.email.trim().toLowerCase();
  if (!userId || !email) {
    throw new Error('Cannot issue session token without userId and email');
  }

  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + SESSION_TOKEN_TTL_SEC;
  const headerB64 = base64UrlEncode(
    JSON.stringify({ alg: 'HS256', typ: 'WS-JWT' })
  );
  const payloadObj: SessionTokenPayload = {
    userId,
    email,
    ...(user.fullName ? { fullName: user.fullName.trim() } : {}),
    iat,
    exp,
  };
  const payloadB64 = base64UrlEncode(JSON.stringify(payloadObj));
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = createHmac('sha256', getGrantTokenSecret())
    .update(signingInput)
    .digest();
  const signatureB64 = base64UrlEncode(signature);

  return `${signingInput}.${signatureB64}`;
}

/**
 * Verifies an HMAC-SHA256 session token issued by `issueSessionToken`.
 */
export function verifySessionToken(token: string): SessionTokenPayload | null {
  try {
    const trimmed = token.trim();
    const parts = trimmed.split('.');
    if (parts.length !== 3 && parts.length !== 2) {
      return null;
    }

    const signingInput =
      parts.length === 3 ? `${parts[0]}.${parts[1]}` : parts[0]!;
    const payloadSegment = parts.length === 3 ? parts[1]! : parts[0]!;
    const signatureSegment = parts.length === 3 ? parts[2]! : parts[1]!;

    const expectedSig = createHmac('sha256', getGrantTokenSecret())
      .update(signingInput)
      .digest();
    const expectedB64 = base64UrlEncode(expectedSig);

    const actualBuf = Buffer.from(signatureSegment, 'utf8');
    const expectedBuf = Buffer.from(expectedB64, 'utf8');
    if (
      actualBuf.length !== expectedBuf.length ||
      !timingSafeEqual(actualBuf, expectedBuf)
    ) {
      return null;
    }

    const decodedJson = base64UrlDecodeToString(payloadSegment);
    const parsed = JSON.parse(decodedJson) as Partial<SessionTokenPayload>;
    if (
      !parsed ||
      typeof parsed.userId !== 'string' ||
      !parsed.userId.trim() ||
      typeof parsed.email !== 'string' ||
      !parsed.email.trim()
    ) {
      return null;
    }

    const nowSec = Math.floor(Date.now() / 1000);
    if (typeof parsed.exp === 'number' && parsed.exp < nowSec) {
      return null;
    }

    return {
      userId: parsed.userId.trim(),
      email: parsed.email.trim().toLowerCase(),
      ...(parsed.fullName ? { fullName: parsed.fullName } : {}),
      iat: typeof parsed.iat === 'number' ? parsed.iat : nowSec,
      exp:
        typeof parsed.exp === 'number'
          ? parsed.exp
          : nowSec + SESSION_TOKEN_TTL_SEC,
    };
  } catch {
    return null;
  }
}

function extractBearerOrSessionToken(req: IncomingMessage): string | null {
  const authHeader = req.headers['authorization'];
  if (typeof authHeader === 'string' && authHeader.trim().length > 0) {
    const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    if (match && match[1] && match[1].trim().length > 0) {
      return match[1].trim();
    }
  }

  const sessionHeader = req.headers['x-wise-spliter-session'];
  if (typeof sessionHeader === 'string' && sessionHeader.trim().length > 0) {
    return sessionHeader.trim();
  }
  if (Array.isArray(sessionHeader) && sessionHeader[0]?.trim()) {
    return sessionHeader[0].trim();
  }

  return null;
}

/**
 * Verifies incoming HTTP request authentication via either:
 * 1. HMAC-SHA256 session token signed with `GRANT_TOKEN_SECRET`, or
 * 2. Official Supabase Auth JWT verified via `getSupabaseAdmin().auth.getUser(token)`.
 */
export async function verifyRequestAuth(
  req: IncomingMessage
): Promise<
  | { authenticated: true; user: { userId: string; email: string } }
  | { authenticated: false; status: 401; error: string }
> {
  const token = extractBearerOrSessionToken(req);
  if (!token) {
    return {
      authenticated: false,
      status: 401,
      error: 'Authentication required: missing Bearer session token',
    };
  }

  // 1. Check HMAC-SHA256 session token
  const hmacPayload = verifySessionToken(token);
  if (hmacPayload) {
    return {
      authenticated: true,
      user: {
        userId: hmacPayload.userId,
        email: hmacPayload.email.toLowerCase(),
      },
    };
  }

  // 2. Fallback to Supabase OAuth JWT verification
  try {
    const supabaseAdmin = getSupabaseAdmin();
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (!error && data?.user && data.user.id && data.user.email) {
      return {
        authenticated: true,
        user: {
          userId: data.user.id,
          email: data.user.email.toLowerCase(),
        },
      };
    }
  } catch {
    // Fall through to 401 below
  }

  return {
    authenticated: false,
    status: 401,
    error: 'Invalid or expired authentication token',
  };
}

function isUserMemberOfGroup(
  members: Array<{
    userId?: string | null;
    user_id?: string | null;
    invitedEmail?: string | null;
    invited_email?: string | null;
  }>,
  user: { userId: string; email: string }
): boolean {
  const normUserId = user.userId.trim();
  const normEmail = user.email.trim().toLowerCase();

  return (members ?? []).some((m) => {
    const mUserId = (m.userId ?? m.user_id ?? '')?.trim();
    const mEmail = (m.invitedEmail ?? m.invited_email ?? '')
      ?.trim()
      .toLowerCase();
    return (
      (mUserId.length > 0 && mUserId === normUserId) ||
      (mEmail.length > 0 && mEmail === normEmail)
    );
  });
}

function isUserParticipantInStandaloneExpense(
  adHocParticipants:
    | Array<{
        id?: string;
        invitedEmail?: string | null;
      }>
    | undefined
    | null,
  user: { userId: string; email: string }
): boolean {
  const normUserId = user.userId.trim();
  const normEmail = user.email.trim().toLowerCase();

  return (adHocParticipants ?? []).some((p) => {
    const pEmail = p.invitedEmail?.trim().toLowerCase() ?? '';
    const pId = p.id?.trim() ?? '';
    return (
      (pEmail.length > 0 && pEmail === normEmail) ||
      (pId.length > 0 && pId === normUserId)
    );
  });
}

/**
 * Filters a full ledger dataset so the authenticated user ONLY receives:
 * - Groups where they are a member (by `userId` or `invitedEmail`)
 * - Expenses belonging to those authorized groups OR standalone (`groupId === null`)
 *   expenses where `adHocParticipants` includes `user.email.toLowerCase()`
 * - Corresponding `expenseRevisions`, `settlements`, and `groupActivityLog`.
 */
export function filterDatasetForUser(
  dataset: MockLedgerDataset,
  user: { userId: string; email: string }
): MockLedgerDataset {
  const normUserId = user.userId.trim();
  const normEmail = user.email.trim().toLowerCase();

  const authorizedGroups = (dataset.groups ?? []).filter((g) =>
    isUserMemberOfGroup(g.members ?? [], user)
  );
  const authorizedGroupIds = new Set(authorizedGroups.map((g) => g.id));

  const authorizedExpenses = (dataset.expenses ?? []).filter((e) => {
    if (e.groupId !== null) {
      return authorizedGroupIds.has(e.groupId);
    }
    return isUserParticipantInStandaloneExpense(e.adHocParticipants, user);
  });
  const authorizedExpenseIds = new Set(authorizedExpenses.map((e) => e.id));

  const authorizedRevisions = (dataset.expenseRevisions ?? []).filter((r) => {
    if (r.groupId !== null) {
      return authorizedGroupIds.has(r.groupId);
    }
    return authorizedExpenseIds.has(r.expenseId);
  });

  const authorizedSettlements = (dataset.settlements ?? []).filter((s) => {
    if (s.groupId !== null) {
      return authorizedGroupIds.has(s.groupId);
    }
    return s.fromMemberId === normUserId || s.toMemberId === normUserId;
  });

  const authorizedActivityLog = (dataset.groupActivityLog ?? []).filter((a) => {
    if (a.groupId !== null) {
      return authorizedGroupIds.has(a.groupId);
    }
    return authorizedExpenseIds.has(a.entityId);
  });

  const currentUserMatches =
    dataset.currentUser &&
    dataset.currentUser.id === normUserId &&
    dataset.currentUser.email.toLowerCase() === normEmail;

  return {
    ...dataset,
    currentUser: currentUserMatches
      ? dataset.currentUser
      : {
          ...dataset.currentUser,
          id: normUserId,
          email: normEmail,
        },
    groups: authorizedGroups,
    expenses: authorizedExpenses,
    expenseRevisions: authorizedRevisions,
    settlements: authorizedSettlements,
    groupActivityLog: authorizedActivityLog,
  };
}

/**
 * Enforces strict user-level & group-membership isolation before writing a dataset sync:
 * - Rule 1 (Anti-Impersonation): `incomingDataset.currentUser` must match `user`.
 * - Rule 2 (Group Membership Requirement): `user` must be a member of every group in `incomingDataset.groups`.
 * - Rule 3 (Existing Group Ownership Protection in DB): if a group ID already exists in `existingDbGroups`,
 *   `user` must already be a member or `created_by` of that existing group in the database.
 * - Rule 4 (Expense Scope Protection): every expense must belong to an authorized group or be a
 *   standalone expense (`groupId === null`) where `adHocParticipants` contains `user.email.toLowerCase()`.
 */
export function authorizeDatasetSyncForUser(
  incomingDataset: MockLedgerDataset,
  existingDbGroups: Array<{
    id: string;
    created_by: string;
    members: Array<{ user_id: string | null; invited_email: string | null }>;
  }>,
  user: { userId: string; email: string }
): { authorized: boolean; status?: 403; error?: string } {
  const normUserId = user.userId.trim();
  const normEmail = user.email.trim().toLowerCase();

  // Rule 1: Anti-Impersonation
  if (
    !incomingDataset?.currentUser ||
    incomingDataset.currentUser.id !== normUserId ||
    incomingDataset.currentUser.email?.trim().toLowerCase() !== normEmail
  ) {
    return {
      authorized: false,
      status: 403,
      error: 'Forbidden: Cross-user profile impersonation denied',
    };
  }

  // Rule 2: Group Membership Requirement
  const incomingGroups = incomingDataset.groups ?? [];
  for (const grp of incomingGroups) {
    if (!isUserMemberOfGroup(grp.members ?? [], user)) {
      return {
        authorized: false,
        status: 403,
        error:
          'Forbidden: Cannot create or modify a group you are not a member of',
      };
    }
  }

  // Rule 3: Existing Group Ownership Protection in DB
  const existingGroupsMap = new Map(
    (existingDbGroups ?? []).map((g) => [g.id, g])
  );
  for (const grp of incomingGroups) {
    const existingDbGroup = existingGroupsMap.get(grp.id);
    if (existingDbGroup) {
      const isCreator = existingDbGroup.created_by?.trim() === normUserId;
      const isExistingMember = isUserMemberOfGroup(
        existingDbGroup.members ?? [],
        user
      );
      if (!isCreator && !isExistingMember) {
        return {
          authorized: false,
          status: 403,
          error:
            'Forbidden: Cannot modify an existing group owned by other users',
        };
      }
    }
  }

  // Rule 4: Expense Scope Protection
  const authorizedGroupIds = new Set(incomingGroups.map((g) => g.id));
  for (const [id, dbGrp] of existingGroupsMap.entries()) {
    if (
      dbGrp.created_by?.trim() === normUserId ||
      isUserMemberOfGroup(dbGrp.members ?? [], user)
    ) {
      authorizedGroupIds.add(id);
    }
  }

  for (const exp of incomingDataset.expenses ?? []) {
    if (exp.groupId !== null) {
      if (!authorizedGroupIds.has(exp.groupId)) {
        return {
          authorized: false,
          status: 403,
          error: 'Forbidden: Unauthorized expense target',
        };
      }
    } else {
      if (!isUserParticipantInStandaloneExpense(exp.adHocParticipants, user)) {
        return {
          authorized: false,
          status: 403,
          error: 'Forbidden: Unauthorized expense target',
        };
      }
    }
  }

  return { authorized: true };
}

interface RateLimitBucket {
  count: number;
  resetAtMs: number;
}

const ipRateLimitBuckets = new Map<string, RateLimitBucket>();

function extractClientIp(req: IncomingMessage): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    return xff.split(',')[0]!.trim();
  }
  if (Array.isArray(xff) && xff[0]?.trim()) {
    return xff[0].split(',')[0]!.trim();
  }
  return req.socket?.remoteAddress || '127.0.0.1';
}

export function resetRateLimiterForTests(): void {
  ipRateLimitBuckets.clear();
}

/**
 * Fixed-window per-IP rate limiter (default 120 req/min per IP).
 */
export function checkRateLimit(req: IncomingMessage): {
  allowed: boolean;
  retryAfterSec?: number;
} {
  if (
    process.env.RATE_LIMIT_DISABLED === '1' ||
    process.env.RATE_LIMIT_DISABLED === 'true'
  ) {
    return { allowed: true };
  }

  const windowSec = Math.max(
    1,
    Number(process.env.RATE_LIMIT_WINDOW_SEC || 60)
  );
  const maxRequests = Math.max(1, Number(process.env.API_RATE_LIMIT || 120));
  const nowMs = Date.now();
  const ip = extractClientIp(req);

  const existing = ipRateLimitBuckets.get(ip);
  if (!existing || nowMs >= existing.resetAtMs) {
    ipRateLimitBuckets.set(ip, {
      count: 1,
      resetAtMs: nowMs + windowSec * 1000,
    });
    return { allowed: true };
  }

  existing.count += 1;
  if (existing.count > maxRequests) {
    const retryAfterSec = Math.max(
      1,
      Math.ceil((existing.resetAtMs - nowMs) / 1000)
    );
    return {
      allowed: false,
      retryAfterSec,
    };
  }

  return { allowed: true };
}

export function getAllowedOrigins(): string[] {
  const raw = process.env.ALLOWED_ORIGINS?.trim();
  if (!raw) {
    return DEFAULT_ALLOWED_ORIGINS;
  }
  const parsed = raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : DEFAULT_ALLOWED_ORIGINS;
}

export function resolveAllowedCorsOrigin(reqOrigin?: string): string {
  const allowed = getAllowedOrigins();
  if (reqOrigin && allowed.includes(reqOrigin.trim())) {
    return reqOrigin.trim();
  }
  return allowed[0] ?? 'http://localhost:4173';
}

/**
 * Builds hardened HTTP security headers and allowlisted CORS headers.
 */
export function buildSecurityHeaders(
  reqOrigin?: string
): Record<string, string> {
  const allowedOrigin = resolveAllowedCorsOrigin(reqOrigin);
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type,Authorization,X-Wise-Spliter-Session',
    Vary: 'Origin',
  };
}
