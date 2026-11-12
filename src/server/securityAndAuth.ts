/**
 * Wise-Spliter Backend Security, Authentication, User-Level Isolation,
 * CORS Allowlisting, Security Headers & Per-IP Rate Limiting (`src/server/securityAndAuth.ts`).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { MockLedgerDataset, ReceiptAttachment } from '../types/ledger';
import {
  type ExistingDbEntityOwnershipSnapshot,
  getSupabaseAdmin,
} from './supabaseAdmin';

export const DEFAULT_DEV_HMAC_SECRET =
  'wise_spliter_dev_hmac_secret_9f8e7d6c5b4a32109f8e7d6c5b4a3210';

export const DEMO_SANDBOX_USER = {
  userId: 'usr_arjun_01',
  email: 'arjun.mehta@gmail.com',
  fullName: 'Arjun Mehta',
} as const;

export const SESSION_COOKIE_NAME = 'ws_session' as const;
export const SAFE_IDENTIFIER_REGEX = /^[a-zA-Z0-9_-]{1,80}$/;
export const ALLOWED_RECEIPT_MIME_TYPES = new Set([
  'image/webp',
  'image/png',
  'image/jpeg',
  'application/pdf',
]);
export const MAX_RECEIPT_DATA_URL_CHARS = 6 * 1024 * 1024;

const NATIVE_PLATFORM_ORIGINS = [
  'capacitor://localhost',
  'ionic://localhost',
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
  'https://localhost',
  'http://localhost',
];

const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:4173',
  'http://127.0.0.1:4173',
  'http://localhost:4174',
  'http://127.0.0.1:4174',
  ...NATIVE_PLATFORM_ORIGINS,
];

const SESSION_TOKEN_TTL_SEC = 60 * 60 * 24 * 7; // 7 days

export type AuthMethod = 'demo' | 'password' | 'google' | 'session';

export interface AuthenticatedUser {
  userId: string;
  email: string;
  fullName?: string;
  authMethod?: AuthMethod;
}

export interface SessionTokenPayload {
  userId: string;
  email: string;
  fullName?: string;
  authMethod?: AuthMethod;
  iat: number;
  exp: number;
}

export interface ExistingDbGroupAuthRecord {
  id: string;
  created_by: string;
  members: Array<{
    user_id: string | null;
    invited_email: string | null;
    removed_at?: string | null;
  }>;
}

export function isDemoSandboxUser(candidate: {
  userId?: string | null;
  email?: string | null;
}): boolean {
  const uid = candidate.userId?.trim() ?? '';
  const em = candidate.email?.trim().toLowerCase() ?? '';
  return (
    uid === DEMO_SANDBOX_USER.userId && em === DEMO_SANDBOX_USER.email
  );
}

export function isValidSafeIdentifier(value: unknown): value is string {
  return typeof value === 'string' && SAFE_IDENTIFIER_REGEX.test(value.trim());
}

/**
 * Fails closed in production if `GRANT_TOKEN_SECRET` is unset, weak, or equal to `DEFAULT_DEV_HMAC_SECRET`.
 */
export function assertProductionSecretsConfigured(): void {
  if (process.env.NODE_ENV !== 'production') {
    return;
  }
  const secret = process.env.GRANT_TOKEN_SECRET?.trim() ?? '';
  if (
    !secret ||
    secret === DEFAULT_DEV_HMAC_SECRET ||
    secret.length < 32
  ) {
    throw new Error(
      '[security] FATAL: NODE_ENV=production requires a unique GRANT_TOKEN_SECRET of at least 32 characters.'
    );
  }

  const supabaseUrl = (process.env.SUPABASE_URL || '').trim();
  const supabaseSecret = (process.env.SUPABASE_SECRET_KEY || '').trim();
  const isLocalSupabase =
    !supabaseUrl ||
    supabaseUrl.includes('127.0.0.1') ||
    supabaseUrl.includes('localhost') ||
    supabaseUrl.includes('host.docker.internal');
  if (
    !isLocalSupabase &&
    (!supabaseSecret ||
      supabaseSecret === 'sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz')
  ) {
    throw new Error(
      '[security] FATAL: NODE_ENV=production against remote Supabase requires a production SUPABASE_SECRET_KEY.'
    );
  }
}

function getGrantTokenSecret(): string {
  assertProductionSecretsConfigured();
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
  authMethod?: AuthMethod;
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
    ...(user.authMethod ? { authMethod: user.authMethod } : {}),
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
      ...(parsed.authMethod ? { authMethod: parsed.authMethod } : {}),
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

export function serializeSessionCookie(token: string): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token.trim())}`,
    'HttpOnly',
    'Path=/api',
    'SameSite=Lax',
    `Max-Age=${SESSION_TOKEN_TTL_SEC}`,
  ];
  if (process.env.NODE_ENV === 'production') {
    parts.push('Secure');
  }
  return parts.join('; ');
}

export function serializeClearSessionCookie(): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    'HttpOnly',
    'Path=/api',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (process.env.NODE_ENV === 'production') {
    parts.push('Secure');
  }
  return parts.join('; ');
}

export function parseRequestCookies(
  cookieHeader: string | string[] | undefined
): Record<string, string> {
  const raw = Array.isArray(cookieHeader)
    ? cookieHeader.join('; ')
    : cookieHeader ?? '';
  const out: Record<string, string> = {};
  if (!raw) return out;

  for (const pair of raw.split(';')) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = pair.slice(0, eqIdx).trim();
    const val = pair.slice(eqIdx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(val);
    } catch {
      out[key] = val;
    }
  }
  return out;
}

export function extractBearerOrSessionToken(
  req: IncomingMessage
): string | null {
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

  const cookies = parseRequestCookies(req.headers['cookie']);
  const cookieToken = cookies[SESSION_COOKIE_NAME]?.trim();
  if (cookieToken) {
    return cookieToken;
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
  | {
      authenticated: true;
      user: { userId: string; email: string; authMethod?: AuthMethod };
    }
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
        ...(hmacPayload.authMethod ? { authMethod: hmacPayload.authMethod } : {}),
      },
    };
  }

  // 2. Fallback to Supabase OAuth / Auth JWT verification
  try {
    const supabaseAdmin = getSupabaseAdmin();
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (!error && data?.user && data.user.id && data.user.email) {
      const verifiedEmail = data.user.email.trim().toLowerCase();
      let canonicalUserId = data.user.id;
      try {
        const { data: profileRow } = await supabaseAdmin
          .from('profiles')
          .select('id')
          .ilike('email', verifiedEmail)
          .maybeSingle();
        if (profileRow && typeof (profileRow as { id?: unknown }).id === 'string') {
          canonicalUserId = (profileRow as { id: string }).id;
        }
      } catch {
        // Keep Supabase Auth UUID if profiles lookup is unavailable
      }
      return {
        authenticated: true,
        user: {
          userId: canonicalUserId,
          email: verifiedEmail,
          authMethod: 'google',
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

export function isUserMemberOfGroup(
  members: Array<{
    userId?: string | null;
    user_id?: string | null;
    invitedEmail?: string | null;
    invited_email?: string | null;
    removedAt?: string | null;
    removed_at?: string | null;
  }>,
  user: { userId: string; email: string }
): boolean {
  const normUserId = user.userId.trim();
  const normEmail = user.email.trim().toLowerCase();

  return (members ?? []).some((m) => {
    if (m.removedAt || m.removed_at) {
      return false;
    }
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

export function isUserAuthorizedOnExistingGroup(
  groupId: string,
  existingDbGroups: ExistingDbGroupAuthRecord[],
  user: { userId: string; email: string }
): boolean {
  const dbGroup = existingDbGroups.find((g) => g.id === groupId);
  if (!dbGroup) {
    // Brand-new group not yet persisted in DB
    return true;
  }
  const normUserId = user.userId.trim();
  if (dbGroup.created_by?.trim() === normUserId) {
    return true;
  }
  return isUserMemberOfGroup(dbGroup.members ?? [], user);
}

export function isUserParticipantInStandaloneExpense(
  adHocParticipants:
    | Array<{
        id?: string;
        invitedEmail?: string | null;
        invited_email?: string | null;
      }>
    | undefined
    | null,
  user: { userId: string; email: string },
  createdByMemberId?: string | null
): boolean {
  const normUserId = user.userId.trim();
  const normEmail = user.email.trim().toLowerCase();

  if (createdByMemberId && createdByMemberId.trim() === normUserId) {
    return true;
  }

  return (adHocParticipants ?? []).some((p) => {
    const pEmail = (p.invitedEmail ?? p.invited_email ?? '')
      .trim()
      .toLowerCase();
    const pId = p.id?.trim() ?? '';
    return (
      (pEmail.length > 0 && pEmail === normEmail) ||
      (pId.length > 0 && pId === normUserId)
    );
  });
}

function collectAuthorizedStandaloneParticipantIds(
  expenses: Array<{
    groupId?: string | null;
    group_id?: string | null;
    createdByMemberId?: string | null;
    created_by_member_id?: string | null;
    adHocParticipants?: Array<{
      id?: string;
      invitedEmail?: string | null;
      invited_email?: string | null;
    }> | null;
    ad_hoc_participants?: Array<{
      id?: string;
      invitedEmail?: string | null;
      invited_email?: string | null;
    }> | null;
  }>,
  user: { userId: string; email: string }
): Set<string> {
  const normUserId = user.userId.trim();
  const normEmail = user.email.trim().toLowerCase();
  const ids = new Set<string>([normUserId]);

  for (const e of expenses) {
    const grpId = e.groupId ?? e.group_id ?? null;
    if (grpId !== null) continue;
    const adHoc = e.adHocParticipants ?? e.ad_hoc_participants ?? [];
    const createdBy = e.createdByMemberId ?? e.created_by_member_id ?? null;
    if (!isUserParticipantInStandaloneExpense(adHoc, user, createdBy)) {
      continue;
    }
    for (const p of adHoc ?? []) {
      const pEmail = (p.invitedEmail ?? p.invited_email ?? '')
        .trim()
        .toLowerCase();
      const pId = p.id?.trim() ?? '';
      if (pId && (pEmail === normEmail || pId === normUserId)) {
        ids.add(pId);
      }
    }
  }

  return ids;
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
    return isUserParticipantInStandaloneExpense(
      e.adHocParticipants,
      user,
      e.createdByMemberId
    );
  });
  const authorizedExpenseIds = new Set(authorizedExpenses.map((e) => e.id));
  const standaloneSelfIds = collectAuthorizedStandaloneParticipantIds(
    authorizedExpenses,
    user
  );

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
    return (
      standaloneSelfIds.has(s.fromMemberId) ||
      standaloneSelfIds.has(s.toMemberId)
    );
  });
  const authorizedSettlementIds = new Set(
    authorizedSettlements.map((s) => s.id)
  );

  const authorizedActivityLog = (dataset.groupActivityLog ?? []).filter((a) => {
    if (a.groupId !== null) {
      return authorizedGroupIds.has(a.groupId);
    }
    return (
      authorizedExpenseIds.has(a.entityId) ||
      authorizedSettlementIds.has(a.entityId) ||
      standaloneSelfIds.has(a.actorMemberId)
    );
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
 * Enforces strict user-level, active group-membership & primary-key anti-hijack isolation
 * before writing a dataset sync:
 * - Rule 1 (Anti-Impersonation): `incomingDataset.currentUser` must match `user`.
 * - Rule 2 (Active Group Membership Requirement): `user` must be an active (non-removed) member of every group in `incomingDataset.groups`.
 * - Rule 3 (Existing Group Ownership Protection in DB): if a group ID already exists in `existingDbGroups`,
 *   `user` must already be an active non-removed member or `created_by` of that existing group in the database.
 * - Rule 4 (Child Entity Scope Protection): every incoming expense, settlement, revision, activity log, and receipt
 *   must belong to an authorized group or authorized standalone split.
 * - Rule 5 (Existing DB Primary-Key Overwrite Protection): prevents Tenant B from upserting an `id`
 *   that already exists in `existingDbEntities` belonging to Tenant A's group or private split.
 */
export function authorizeDatasetSyncForUser(
  incomingDataset: MockLedgerDataset,
  existingDbGroups: ExistingDbGroupAuthRecord[],
  user: { userId: string; email: string },
  existingDbEntities?: ExistingDbEntityOwnershipSnapshot
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

  // Rule 2: Active Group Membership Requirement
  const incomingGroups = incomingDataset.groups ?? [];
  for (const grp of incomingGroups) {
    if (!isUserMemberOfGroup(grp.members ?? [], user)) {
      return {
        authorized: false,
        status: 403,
        error:
          'Forbidden: Cannot create or modify a group you are not an active member of',
      };
    }
  }

  // Rule 3: Existing Group Ownership Protection in DB
  const existingGroupsMap = new Map(
    (existingDbGroups ?? []).map((g) => [g.id, g])
  );
  const authorizedExistingGroupIds = new Set<string>();
  for (const [id, dbGrp] of existingGroupsMap.entries()) {
    if (
      dbGrp.created_by?.trim() === normUserId ||
      isUserMemberOfGroup(dbGrp.members ?? [], user)
    ) {
      authorizedExistingGroupIds.add(id);
    }
  }

  for (const grp of incomingGroups) {
    const existingDbGroup = existingGroupsMap.get(grp.id);
    if (existingDbGroup && !authorizedExistingGroupIds.has(grp.id)) {
      return {
        authorized: false,
        status: 403,
        error:
          'Forbidden: Cannot modify an existing group owned by other users',
      };
    }

    if (existingDbEntities) {
      for (const m of grp.members ?? []) {
        const existingMem = existingDbEntities.groupMembers.get(m.id);
        if (
          existingMem &&
          (existingMem.group_id !== grp.id ||
            (existingGroupsMap.has(existingMem.group_id) &&
              !authorizedExistingGroupIds.has(existingMem.group_id)))
        ) {
          return {
            authorized: false,
            status: 403,
            error:
              'Forbidden: Cannot overwrite a group member ID belonging to another group',
          };
        }
      }
    }
  }

  // Rule 4 & Rule 5: Expense, Settlement, Revision, Activity & Receipt Scope + PK Anti-Overwrite
  const authorizedGroupIds = new Set<string>([
    ...incomingGroups.map((g) => g.id),
    ...authorizedExistingGroupIds,
  ]);

  const isExistingExpenseAuthorized = (expId: string): boolean => {
    if (!existingDbEntities) return true;
    const existingExp = existingDbEntities.expenses.get(expId);
    if (!existingExp) return true;
    if (existingExp.group_id !== null) {
      return authorizedExistingGroupIds.has(existingExp.group_id);
    }
    return isUserParticipantInStandaloneExpense(
      existingExp.ad_hoc_participants,
      user,
      existingExp.created_by_member_id
    );
  };

  const incomingExpenses = incomingDataset.expenses ?? [];
  for (const exp of incomingExpenses) {
    if (exp.groupId !== null) {
      if (!authorizedGroupIds.has(exp.groupId)) {
        return {
          authorized: false,
          status: 403,
          error: 'Forbidden: Unauthorized expense target',
        };
      }
    } else {
      if (
        !isUserParticipantInStandaloneExpense(
          exp.adHocParticipants,
          user,
          exp.createdByMemberId
        )
      ) {
        return {
          authorized: false,
          status: 403,
          error: 'Forbidden: Unauthorized standalone expense target',
        };
      }
    }

    if (!isExistingExpenseAuthorized(exp.id)) {
      return {
        authorized: false,
        status: 403,
        error:
          'Forbidden: Cannot overwrite an existing expense ID owned by other users',
      };
    }

    if (existingDbEntities) {
      for (const rcpt of (exp.receipts ?? []) as ReceiptAttachment[]) {
        const existingRcpt = existingDbEntities.receipts.get(rcpt.id);
        if (existingRcpt) {
          if (
            existingRcpt.group_id !== null &&
            !authorizedExistingGroupIds.has(existingRcpt.group_id)
          ) {
            return {
              authorized: false,
              status: 403,
              error:
                'Forbidden: Cannot overwrite an existing receipt ID owned by other users',
            };
          }
          if (!isExistingExpenseAuthorized(existingRcpt.expense_id)) {
            return {
              authorized: false,
              status: 403,
              error:
                'Forbidden: Cannot overwrite an existing receipt ID owned by other users',
            };
          }
        }
      }
    }
  }

  const authorizedExpenseIds = new Set(incomingExpenses.map((e) => e.id));
  if (existingDbEntities) {
    for (const [expId] of existingDbEntities.expenses.entries()) {
      if (isExistingExpenseAuthorized(expId)) {
        authorizedExpenseIds.add(expId);
      }
    }
  }

  const standaloneSelfIds = collectAuthorizedStandaloneParticipantIds(
    [
      ...incomingExpenses,
      ...(existingDbEntities
        ? Array.from(existingDbEntities.expenses.values())
        : []),
    ],
    user
  );

  for (const stl of incomingDataset.settlements ?? []) {
    if (stl.groupId !== null) {
      if (!authorizedGroupIds.has(stl.groupId)) {
        return {
          authorized: false,
          status: 403,
          error: 'Forbidden: Unauthorized settlement group target',
        };
      }
    } else if (
      !standaloneSelfIds.has(stl.fromMemberId) &&
      !standaloneSelfIds.has(stl.toMemberId)
    ) {
      return {
        authorized: false,
        status: 403,
        error: 'Forbidden: Unauthorized standalone settlement target',
      };
    }

    if (existingDbEntities) {
      const existingStl = existingDbEntities.settlements.get(stl.id);
      if (existingStl) {
        const existingAuthorized =
          existingStl.group_id !== null
            ? authorizedExistingGroupIds.has(existingStl.group_id)
            : standaloneSelfIds.has(existingStl.from_member_id) ||
              standaloneSelfIds.has(existingStl.to_member_id);
        if (!existingAuthorized) {
          return {
            authorized: false,
            status: 403,
            error:
              'Forbidden: Cannot overwrite an existing settlement ID owned by other users',
          };
        }
      }
    }
  }

  for (const rev of incomingDataset.expenseRevisions ?? []) {
    if (rev.groupId !== null && !authorizedGroupIds.has(rev.groupId)) {
      return {
        authorized: false,
        status: 403,
        error: 'Forbidden: Unauthorized expense revision target',
      };
    }
    if (rev.groupId === null && !authorizedExpenseIds.has(rev.expenseId)) {
      return {
        authorized: false,
        status: 403,
        error: 'Forbidden: Unauthorized standalone expense revision target',
      };
    }
    if (existingDbEntities) {
      const existingRev = existingDbEntities.revisions.get(rev.id);
      if (existingRev) {
        const existingOk =
          existingRev.group_id !== null
            ? authorizedExistingGroupIds.has(existingRev.group_id)
            : isExistingExpenseAuthorized(existingRev.expense_id);
        if (!existingOk) {
          return {
            authorized: false,
            status: 403,
            error:
              'Forbidden: Cannot overwrite an existing revision ID owned by other users',
          };
        }
      }
    }
  }

  for (const act of incomingDataset.groupActivityLog ?? []) {
    if (act.groupId !== null && !authorizedGroupIds.has(act.groupId)) {
      return {
        authorized: false,
        status: 403,
        error: 'Forbidden: Unauthorized activity log group target',
      };
    }
    if (existingDbEntities) {
      const existingAct = existingDbEntities.activityLogs.get(act.id);
      if (existingAct) {
        const existingOk =
          existingAct.group_id !== null
            ? authorizedExistingGroupIds.has(existingAct.group_id)
            : standaloneSelfIds.has(existingAct.actor_member_id) ||
              authorizedExpenseIds.has(existingAct.entity_id);
        if (!existingOk) {
          return {
            authorized: false,
            status: 403,
            error:
              'Forbidden: Cannot overwrite an existing activity log ID owned by other users',
          };
        }
      }
    }
  }

  return { authorized: true };
}

/**
 * Validates every mutation operation in `/api/ledger/push-mutations` (including nested `payload` and `payloadJson`).
 */
export function authorizeMutationsForUser(
  ops: unknown[],
  existingDbGroups: ExistingDbGroupAuthRecord[],
  existingDbEntities: ExistingDbEntityOwnershipSnapshot | undefined,
  user: { userId: string; email: string }
): { authorized: boolean; status?: 400 | 403; error?: string } {
  if (!Array.isArray(ops)) {
    return {
      authorized: false,
      status: 400,
      error: 'Invalid mutations batch: expected an array of operations',
    };
  }
  if (ops.length > 500) {
    return {
      authorized: false,
      status: 400,
      error: 'Invalid mutations batch: maximum 500 operations per request',
    };
  }

  const normUserId = user.userId.trim();
  const existingGroupsMap = new Map(
    (existingDbGroups ?? []).map((g) => [g.id, g])
  );
  const authorizedExistingGroupIds = new Set<string>();
  for (const [id, dbGrp] of existingGroupsMap.entries()) {
    if (
      dbGrp.created_by?.trim() === normUserId ||
      isUserMemberOfGroup(dbGrp.members ?? [], user)
    ) {
      authorizedExistingGroupIds.add(id);
    }
  }

  const standaloneSelfIds = collectAuthorizedStandaloneParticipantIds(
    existingDbEntities ? Array.from(existingDbEntities.expenses.values()) : [],
    user
  );

  const checkPayloadRecord = (
    rec: Record<string, unknown>
  ): { authorized: boolean; status?: 400 | 403; error?: string } => {
    const opUserId =
      typeof rec.userId === 'string'
        ? rec.userId.trim()
        : typeof rec.actorUserId === 'string'
          ? rec.actorUserId.trim()
          : '';
    if (opUserId && opUserId !== normUserId) {
      return {
        authorized: false,
        status: 403,
        error: 'Forbidden: Cross-user mutation impersonation denied',
      };
    }

    const opGroupId =
      typeof rec.groupId === 'string'
        ? rec.groupId.trim()
        : typeof rec.group_id === 'string'
          ? rec.group_id.trim()
          : '';
    if (
      opGroupId &&
      existingGroupsMap.has(opGroupId) &&
      !authorizedExistingGroupIds.has(opGroupId)
    ) {
      return {
        authorized: false,
        status: 403,
        error:
          'Forbidden: Cannot push mutations to a group you are not an active member of',
      };
    }

    const opExpenseId =
      typeof rec.expenseId === 'string'
        ? rec.expenseId.trim()
        : typeof rec.expense_id === 'string'
          ? rec.expense_id.trim()
          : rec.entityType === 'expense' && typeof rec.entityId === 'string'
            ? rec.entityId.trim()
            : '';
    if (opExpenseId && existingDbEntities) {
      const existingExp = existingDbEntities.expenses.get(opExpenseId);
      if (existingExp) {
        const expOk =
          existingExp.group_id !== null
            ? authorizedExistingGroupIds.has(existingExp.group_id)
            : isUserParticipantInStandaloneExpense(
                existingExp.ad_hoc_participants,
                user,
                existingExp.created_by_member_id
              );
        if (!expOk) {
          return {
            authorized: false,
            status: 403,
            error:
              'Forbidden: Cannot push mutations targeting another user expense',
          };
        }
      }
    }

    const opSettlementId =
      typeof rec.settlementId === 'string'
        ? rec.settlementId.trim()
        : typeof rec.settlement_id === 'string'
          ? rec.settlement_id.trim()
          : rec.entityType === 'settlement' && typeof rec.entityId === 'string'
            ? rec.entityId.trim()
            : '';
    if (opSettlementId && existingDbEntities) {
      const existingStl = existingDbEntities.settlements.get(opSettlementId);
      if (existingStl) {
        const stlOk =
          existingStl.group_id !== null
            ? authorizedExistingGroupIds.has(existingStl.group_id)
            : standaloneSelfIds.has(existingStl.from_member_id) ||
              standaloneSelfIds.has(existingStl.to_member_id);
        if (!stlOk) {
          return {
            authorized: false,
            status: 403,
            error:
              'Forbidden: Cannot push mutations targeting another user settlement',
          };
        }
      }
    }

    return { authorized: true };
  };

  for (const rawOp of ops) {
    if (!rawOp || typeof rawOp !== 'object' || Array.isArray(rawOp)) {
      return {
        authorized: false,
        status: 400,
        error: 'Invalid mutation item: expected JSON object',
      };
    }
    const op = rawOp as Record<string, unknown>;
    const topCheck = checkPayloadRecord(op);
    if (!topCheck.authorized) return topCheck;

    if (op.payload && typeof op.payload === 'object' && !Array.isArray(op.payload)) {
      const nestedCheck = checkPayloadRecord(op.payload as Record<string, unknown>);
      if (!nestedCheck.authorized) return nestedCheck;
    }

    if (typeof op.payloadJson === 'string' && op.payloadJson.trim().length > 0) {
      try {
        const parsed = JSON.parse(op.payloadJson) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const jsonCheck = checkPayloadRecord(parsed as Record<string, unknown>);
          if (!jsonCheck.authorized) return jsonCheck;
        }
      } catch {
        return {
          authorized: false,
          status: 400,
          error: 'Invalid mutation payloadJson: malformed JSON string',
        };
      }
    }
  }

  return { authorized: true };
}

/**
 * Validates receipt upload identifiers (blocking `../` Storage path traversal), MIME type,
 * payload bounds, and cross-tenant ownership of `groupId`, `expenseId`, and `receipt.id`.
 */
export function authorizeReceiptUploadForUser(
  body: {
    id?: unknown;
    expenseId?: unknown;
    groupId?: unknown;
    userId?: unknown;
    mimeType?: unknown;
    dataUrl?: unknown;
  },
  existingDbGroups: ExistingDbGroupAuthRecord[],
  existingDbEntities: ExistingDbEntityOwnershipSnapshot | undefined,
  user: { userId: string; email: string }
):
  | {
      authorized: true;
      sanitized: {
        receiptId: string;
        expenseId: string;
        groupId: string | null;
        mimeType: string;
      };
    }
  | { authorized: false; status: 400 | 403 | 413; error: string } {
  if (typeof body.userId === 'string' && body.userId.trim().length > 0) {
    if (body.userId.trim() !== user.userId.trim()) {
      return {
        authorized: false,
        status: 403,
        error: 'Forbidden: Cross-user receipt upload impersonation denied',
      };
    }
  }

  const rawReceiptId =
    body.id === undefined || body.id === null || body.id === ''
      ? `rcpt_${Date.now()}`
      : body.id;
  if (!isValidSafeIdentifier(rawReceiptId)) {
    return {
      authorized: false,
      status: 400,
      error:
        'Invalid receipt `id`: must match /^[a-zA-Z0-9_-]{1,80}$/ (path traversal blocked)',
    };
  }
  const receiptId = rawReceiptId.trim();

  if (!isValidSafeIdentifier(body.expenseId)) {
    return {
      authorized: false,
      status: 400,
      error:
        'Invalid or missing `expenseId`: must match /^[a-zA-Z0-9_-]{1,80}$/ (path traversal blocked)',
    };
  }
  const expenseId = body.expenseId.trim();

  let groupId: string | null = null;
  if (body.groupId !== undefined && body.groupId !== null && body.groupId !== '') {
    if (!isValidSafeIdentifier(body.groupId)) {
      return {
        authorized: false,
        status: 400,
        error:
          'Invalid `groupId`: must match /^[a-zA-Z0-9_-]{1,80}$/ (path traversal blocked)',
      };
    }
    groupId = body.groupId.trim();
  }

  const mimeType =
    typeof body.mimeType === 'string' && body.mimeType.trim().length > 0
      ? body.mimeType.trim().toLowerCase()
      : 'image/webp';
  if (!ALLOWED_RECEIPT_MIME_TYPES.has(mimeType)) {
    return {
      authorized: false,
      status: 400,
      error:
        'Unsupported receipt MIME type: allowed image/webp, image/png, image/jpeg, application/pdf',
    };
  }

  if (
    typeof body.dataUrl === 'string' &&
    body.dataUrl.length > MAX_RECEIPT_DATA_URL_CHARS
  ) {
    return {
      authorized: false,
      status: 413,
      error: 'Receipt attachment exceeds maximum allowed size',
    };
  }

  if (
    groupId &&
    !isUserAuthorizedOnExistingGroup(groupId, existingDbGroups, user)
  ) {
    return {
      authorized: false,
      status: 403,
      error:
        'Forbidden: Cannot upload receipt to a group you are not an active member of',
    };
  }

  if (existingDbEntities) {
    const existingExp = existingDbEntities.expenses.get(expenseId);
    if (existingExp) {
      const expOk =
        existingExp.group_id !== null
          ? isUserAuthorizedOnExistingGroup(
              existingExp.group_id,
              existingDbGroups,
              user
            )
          : isUserParticipantInStandaloneExpense(
              existingExp.ad_hoc_participants,
              user,
              existingExp.created_by_member_id
            );
      if (!expOk) {
        return {
          authorized: false,
          status: 403,
          error:
            'Forbidden: Cannot attach receipt to an expense owned by other users',
        };
      }
      if (
        groupId !== null &&
        existingExp.group_id !== null &&
        groupId !== existingExp.group_id
      ) {
        return {
          authorized: false,
          status: 403,
          error: 'Forbidden: Receipt groupId mismatches existing expense group',
        };
      }
    }

    const existingRcpt = existingDbEntities.receipts.get(receiptId);
    if (existingRcpt) {
      const rcptOk =
        existingRcpt.group_id !== null
          ? isUserAuthorizedOnExistingGroup(
              existingRcpt.group_id,
              existingDbGroups,
              user
            )
          : (() => {
              const parentExp = existingDbEntities.expenses.get(
                existingRcpt.expense_id
              );
              if (!parentExp) return false;
              return parentExp.group_id !== null
                ? isUserAuthorizedOnExistingGroup(
                    parentExp.group_id,
                    existingDbGroups,
                    user
                  )
                : isUserParticipantInStandaloneExpense(
                    parentExp.ad_hoc_participants,
                    user,
                    parentExp.created_by_member_id
                  );
            })();
      if (!rcptOk) {
        return {
          authorized: false,
          status: 403,
          error:
            'Forbidden: Cannot overwrite an existing receipt ID owned by other users',
        };
      }
    }
  }

  return {
    authorized: true,
    sanitized: {
      receiptId,
      expenseId,
      groupId,
      mimeType,
    },
  };
}

interface RateLimitBucket {
  count: number;
  resetAtMs: number;
}

const ipRateLimitBuckets = new Map<string, RateLimitBucket>();
const authLoginFailureBuckets = new Map<string, RateLimitBucket>();

function isTrustedProxyEnabled(): boolean {
  const val = process.env.TRUST_PROXY?.trim().toLowerCase();
  return val === 'true' || val === '1';
}

export function extractClientIp(req: IncomingMessage): string {
  if (isTrustedProxyEnabled()) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.trim()) {
      return xff.split(',')[0]!.trim();
    }
    if (Array.isArray(xff) && xff[0]?.trim()) {
      return xff[0].split(',')[0]!.trim();
    }
  }
  return req.socket?.remoteAddress || '127.0.0.1';
}

export function resetRateLimiterForTests(): void {
  ipRateLimitBuckets.clear();
  authLoginFailureBuckets.clear();
}

/**
 * Strict brute-force rate limiter for `/api/auth/login` (default max 10 failed attempts per 15 min per IP+email).
 */
export function checkAuthLoginRateLimit(
  req: IncomingMessage,
  email: string
): {
  allowed: boolean;
  retryAfterSec?: number;
} {
  if (
    process.env.RATE_LIMIT_DISABLED === '1' ||
    process.env.RATE_LIMIT_DISABLED === 'true'
  ) {
    return { allowed: true };
  }

  const maxFailures = Math.max(
    1,
    Number(process.env.AUTH_RATE_LIMIT_MAX || 10)
  );
  const maxIpFailures = maxFailures * 2;
  const nowMs = Date.now();
  const ip = extractClientIp(req);
  const normEmail = email.trim().toLowerCase() || 'unknown';

  const accountKey = `acct:${ip}:${normEmail}`;
  const ipKey = `ip:${ip}`;

  const acctBucket = authLoginFailureBuckets.get(accountKey);
  if (acctBucket && nowMs < acctBucket.resetAtMs && acctBucket.count >= maxFailures) {
    return {
      allowed: false,
      retryAfterSec: Math.max(
        1,
        Math.ceil((acctBucket.resetAtMs - nowMs) / 1000)
      ),
    };
  }

  const ipBucket = authLoginFailureBuckets.get(ipKey);
  if (ipBucket && nowMs < ipBucket.resetAtMs && ipBucket.count >= maxIpFailures) {
    return {
      allowed: false,
      retryAfterSec: Math.max(
        1,
        Math.ceil((ipBucket.resetAtMs - nowMs) / 1000)
      ),
    };
  }

  return { allowed: true };
}

export function recordAuthLoginFailure(
  req: IncomingMessage,
  email: string
): void {
  const windowSec = Math.max(
    1,
    Number(process.env.AUTH_RATE_LIMIT_WINDOW_SEC || 900)
  );
  const nowMs = Date.now();
  const ip = extractClientIp(req);
  const normEmail = email.trim().toLowerCase() || 'unknown';

  for (const key of [`acct:${ip}:${normEmail}`, `ip:${ip}`]) {
    const existing = authLoginFailureBuckets.get(key);
    if (!existing || nowMs >= existing.resetAtMs) {
      authLoginFailureBuckets.set(key, {
        count: 1,
        resetAtMs: nowMs + windowSec * 1000,
      });
    } else {
      existing.count += 1;
    }
  }
}

export function clearAuthLoginFailures(
  req: IncomingMessage,
  email: string
): void {
  const ip = extractClientIp(req);
  const normEmail = email.trim().toLowerCase();
  if (normEmail) {
    authLoginFailureBuckets.delete(`acct:${ip}:${normEmail}`);
  }
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
  if (parsed.length === 0) {
    return DEFAULT_ALLOWED_ORIGINS;
  }
  if (process.env.DISABLE_NATIVE_ORIGINS === 'true') {
    return parsed;
  }
  return Array.from(new Set([...parsed, ...NATIVE_PLATFORM_ORIGINS]));
}

export function isOriginAllowed(origin: string): boolean {
  const trimmed = origin.trim();
  if (!trimmed || trimmed === 'null') {
    return false;
  }
  return getAllowedOrigins().includes(trimmed);
}

export function resolveAllowedCorsOrigin(reqOrigin?: string): string {
  const allowed = getAllowedOrigins();
  if (reqOrigin && isOriginAllowed(reqOrigin)) {
    return reqOrigin.trim();
  }
  return allowed[0] ?? 'http://localhost:4173';
}

/**
 * Enforces Origin & Sec-Fetch-Site CSRF protection on state-mutating requests (`POST`, `PUT`, `PATCH`, `DELETE`).
 * Blocks cross-site browser requests (including sandboxed `Origin: null` frames) with `HTTP 403` before execution.
 */
export function validateCsrfAndOrigin(
  req: IncomingMessage
): { allowed: true } | { allowed: false; status: 403; error: string } {
  const method = (req.method || 'GET').toUpperCase();
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    return { allowed: true };
  }

  const rawOrigin = req.headers['origin'];
  const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;
  if (typeof origin === 'string' && origin.trim().length > 0) {
    if (!isOriginAllowed(origin)) {
      return {
        allowed: false,
        status: 403,
        error: `Forbidden: Disallowed cross-origin state-mutating request (${origin.trim()})`,
      };
    }
    return { allowed: true };
  }

  const rawSecFetchSite = req.headers['sec-fetch-site'];
  const secFetchSite = (
    Array.isArray(rawSecFetchSite) ? rawSecFetchSite[0] : rawSecFetchSite
  )
    ?.trim()
    .toLowerCase();
  if (secFetchSite === 'cross-site') {
    return {
      allowed: false,
      status: 403,
      error: 'Forbidden: Cross-site request blocked by Sec-Fetch-Site policy',
    };
  }

  return { allowed: true };
}

/**
 * Builds hardened HTTP security headers and allowlisted CORS headers.
 */
export function buildSecurityHeaders(
  reqOrigin?: string
): Record<string, string> {
  const allowedOrigin = resolveAllowedCorsOrigin(reqOrigin);
  const originExplicitlyTrusted = Boolean(
    reqOrigin && isOriginAllowed(reqOrigin)
  );

  const headers: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Cache-Control': 'no-store',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type,Authorization,X-Wise-Spliter-Session',
    Vary: 'Origin',
  };

  if (originExplicitlyTrusted) {
    headers['Access-Control-Allow-Credentials'] = 'true';
  }

  if (process.env.NODE_ENV === 'production') {
    headers['Strict-Transport-Security'] =
      'max-age=31536000; includeSubDomains';
  }

  return headers;
}
