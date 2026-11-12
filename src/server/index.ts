/**
 * Wise-Spliter Backend API Service (`node:http`)
 * Runs on API_PORT (default 4174) with zero external framework dependencies.
 * Bridges the frontend sync engine to the centralized Supabase `wise_spliter` schema
 * with HMAC/JWT authentication (HTTP 401), strict user & group-membership isolation (HTTP 403),
 * CORS allowlisting, security headers, and per-IP rate limiting (HTTP 429).
 */

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { createClient } from '@supabase/supabase-js';
import initialMockData from '../data/mock-ledger-data.json';
import { validateExpenseInvariants } from '../domain/splits/split-calculator';
import { MockLedgerDataset, UserProfile } from '../types/ledger';
import {
  DEMO_SANDBOX_USER,
  assertProductionSecretsConfigured,
  authorizeDatasetSyncForUser,
  authorizeMutationsForUser,
  authorizeReceiptUploadForUser,
  buildSecurityHeaders,
  checkAuthLoginRateLimit,
  checkRateLimit,
  clearAuthLoginFailures,
  extractBearerOrSessionToken,
  filterDatasetForUser,
  isDemoSandboxUser,
  isOriginAllowed,
  isUserMemberOfGroup,
  isUserParticipantInStandaloneExpense,
  issueSessionToken,
  recordAuthLoginFailure,
  serializeClearSessionCookie,
  serializeSessionCookie,
  validateCsrfAndOrigin,
  verifyRequestAuth,
} from './securityAndAuth';
import {
  SUPABASE_SCHEMA,
  SUPABASE_URL,
  callPullChangesRpc,
  callPushMutationsRpc,
  checkSupabaseSchemaHealth,
  claimPendingGroupMembershipsForEmail,
  fetchDatasetFromSupabase,
  fetchExistingDbEntityOwnership,
  fetchExistingDbGroups,
  getSupabaseAdmin,
  resolveDemoSandboxProfile,
  syncDatasetToSupabase,
  uploadReceiptToSupabaseStorage,
  upsertGoogleProfileAndClaimMembers,
} from './supabaseAdmin';

assertProductionSecretsConfigured();

export const API_PORT = Number(process.env.API_PORT || 4174);
export const API_HOST = (process.env.API_HOST || '127.0.0.1').trim();
const MAX_JSON_BODY_BYTES = Math.max(
  1024,
  Number(process.env.MAX_JSON_BODY_BYTES || 8 * 1024 * 1024)
);

const SUPABASE_PUBLISHABLE_KEY = (
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH'
).trim();

export class PayloadTooLargeError extends Error {
  public readonly statusCode = 413 as const;
  constructor(maxBytes: number) {
    super(`Payload too large: maximum allowed request body is ${maxBytes} bytes`);
    this.name = 'PayloadTooLargeError';
  }
}

function getRequestOrigin(req: IncomingMessage): string | undefined {
  const origin = req.headers['origin'];
  if (typeof origin === 'string') return origin;
  if (Array.isArray(origin)) return origin[0];
  return undefined;
}

function sendJson(
  req: IncomingMessage,
  res: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
  extraHeaders?: Record<string, string>
): void {
  const body = JSON.stringify(payload);
  const securityHeaders = buildSecurityHeaders(getRequestOrigin(req));
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    ...(statusCode === 413 ? { Connection: 'close' } : {}),
    ...securityHeaders,
    ...(extraHeaders || {}),
  });
  res.end(body, () => {
    if (statusCode === 413 && !req.complete) {
      req.destroy();
    }
  });
}

async function readJsonBody<T>(
  req: IncomingMessage,
  maxBytes: number = MAX_JSON_BODY_BYTES
): Promise<T> {
  const declaredLenHeader = req.headers['content-length'];
  const declaredLen =
    typeof declaredLenHeader === 'string' ? Number(declaredLenHeader) : NaN;
  if (Number.isFinite(declaredLen) && declaredLen > maxBytes) {
    req.pause();
    throw new PayloadTooLargeError(maxBytes);
  }

  return new Promise<T>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    req.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      totalBytes += buf.length;
      if (totalBytes > maxBytes) {
        settled = true;
        chunks.length = 0;
        req.pause();
        reject(new PayloadTooLargeError(maxBytes));
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve((text ? JSON.parse(text) : {}) as T);
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

function handleBodyError(
  req: IncomingMessage,
  res: ServerResponse,
  err: unknown,
  fallbackMessage: string
): void {
  if (err instanceof PayloadTooLargeError) {
    sendJson(req, res, 413, {
      ok: false,
      error: err.message,
    });
    return;
  }
  sendJson(req, res, 400, {
    ok: false,
    error: err instanceof Error ? err.message : fallbackMessage,
  });
}

function validateDatasetFinancialInvariants(dataset: MockLedgerDataset): {
  valid: boolean;
  violation?: string;
} {
  if (!dataset || !Array.isArray(dataset.expenses)) {
    return {
      valid: false,
      violation: 'Invalid dataset payload: missing expenses array',
    };
  }

  for (const exp of dataset.expenses) {
    if (exp.deletedAt) continue;
    const payerSum = (exp.payers ?? []).reduce(
      (acc, p) => acc + p.paidMinor,
      0
    );
    const splitSum = (exp.splits ?? [])
      .filter((s) => s.included)
      .reduce((acc, s) => acc + s.owedMinor, 0);

    if (payerSum !== exp.amountMinor || splitSum !== exp.amountMinor) {
      return {
        valid: false,
        violation: `Financial invariant failed on expense "${exp.title}" (${exp.id}): amountMinor=${exp.amountMinor}, payerSum=${payerSum}, splitSum=${splitSum}`,
      };
    }

    const domainCheck = validateExpenseInvariants({
      amountMinor: exp.amountMinor,
      splitMode: exp.splitMode,
      payers: exp.payers ?? [],
      splits: exp.splits ?? [],
    });
    if (!domainCheck.valid) {
      return {
        valid: false,
        violation: `Financial invariant failed on expense "${exp.title}" (${exp.id}): ${domainCheck.errors.join('; ')}`,
      };
    }
  }

  return { valid: true };
}

export async function handleApiRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const reqOrigin = getRequestOrigin(req);
  const securityHeaders = buildSecurityHeaders(reqOrigin);

  if (req.method === 'OPTIONS') {
    if (reqOrigin && !isOriginAllowed(reqOrigin)) {
      sendJson(req, res, 403, {
        ok: false,
        error: 'Forbidden: Disallowed CORS preflight origin',
      });
      return;
    }
    res.writeHead(204, securityHeaders);
    res.end();
    return;
  }

  const csrfCheck = validateCsrfAndOrigin(req);
  if (!csrfCheck.allowed) {
    sendJson(req, res, csrfCheck.status, {
      ok: false,
      error: csrfCheck.error,
    });
    return;
  }

  const rateLimit = checkRateLimit(req);
  if (!rateLimit.allowed) {
    sendJson(
      req,
      res,
      429,
      {
        ok: false,
        error: 'Rate limit exceeded. Please retry later.',
        retryAfterSec: rateLimit.retryAfterSec ?? 60,
      },
      {
        'Retry-After': String(rateLimit.retryAfterSec ?? 60),
      }
    );
    return;
  }

  const reqUrl = new URL(req.url || '/', `http://127.0.0.1:${API_PORT}`);

  if (req.method === 'GET' && reqUrl.pathname === '/api/health') {
    const health = await checkSupabaseSchemaHealth();
    sendJson(req, res, 200, {
      ok: true,
      service: 'wise-spliter-api',
      schema: SUPABASE_SCHEMA,
      authEnforced: true,
      userIsolationEnforced: true,
      supabaseReachable: health.reachable,
      schemaHealth: health.reachable
        ? { ok: true, schema: SUPABASE_SCHEMA }
        : null,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (req.method === 'POST' && reqUrl.pathname === '/api/auth/demo') {
    try {
      const body = await readJsonBody<{
        userId?: string;
        email?: string;
      }>(req, 16 * 1024);

      if (
        (typeof body.userId === 'string' &&
          body.userId.trim().length > 0 &&
          body.userId.trim() !== DEMO_SANDBOX_USER.userId) ||
        (typeof body.email === 'string' &&
          body.email.trim().length > 0 &&
          body.email.trim().toLowerCase() !== DEMO_SANDBOX_USER.email)
      ) {
        sendJson(req, res, 403, {
          ok: false,
          error:
            'Forbidden: Demo sandbox login only issues sessions for the designated demo profile',
        });
        return;
      }

      const demoProfile = await resolveDemoSandboxProfile();
      const token = issueSessionToken({
        userId: demoProfile.id,
        email: demoProfile.email,
        fullName: demoProfile.fullName,
        authMethod: 'demo',
      });

      const fallback = JSON.parse(
        JSON.stringify(initialMockData)
      ) as MockLedgerDataset;
      const dbResult = await fetchDatasetFromSupabase(fallback);
      const scopedDataset = filterDatasetForUser(
        {
          ...dbResult.dataset,
          currentUser: demoProfile,
        },
        {
          userId: demoProfile.id,
          email: demoProfile.email,
        }
      );

      sendJson(
        req,
        res,
        200,
        {
          ok: true,
          authMethod: 'demo',
          token,
          profile: demoProfile,
          dataset: scopedDataset,
        },
        {
          'Set-Cookie': serializeSessionCookie(token),
        }
      );
      return;
    } catch (err) {
      handleBodyError(req, res, err, 'Invalid demo login request');
      return;
    }
  }

  if (req.method === 'POST' && reqUrl.pathname === '/api/auth/google') {
    try {
      const body = await readJsonBody<{
        accessToken?: string;
      }>(req, 64 * 1024);

      const rawAccessToken =
        typeof body.accessToken === 'string' && body.accessToken.trim()
          ? body.accessToken.trim()
          : extractBearerOrSessionToken(req) || '';

      if (!rawAccessToken) {
        sendJson(req, res, 401, {
          ok: false,
          error: 'Authentication required: missing Supabase Google OAuth accessToken',
        });
        return;
      }

      const { data: userRes, error: userErr } =
        await getSupabaseAdmin().auth.getUser(rawAccessToken);
      if (userErr || !userRes?.user?.id || !userRes.user.email) {
        sendJson(req, res, 401, {
          ok: false,
          error: 'Invalid or expired Google OAuth access token',
        });
        return;
      }

      const meta = (userRes.user.user_metadata ?? {}) as Record<string, unknown>;
      const fullName =
        typeof meta.full_name === 'string'
          ? meta.full_name
          : typeof meta.name === 'string'
            ? meta.name
            : undefined;
      const avatarUrl =
        typeof meta.avatar_url === 'string' ? meta.avatar_url : null;

      const { profile: verifiedProfile, claimedGroupCount } =
        await upsertGoogleProfileAndClaimMembers({
          authUid: userRes.user.id,
          email: userRes.user.email,
          fullName,
          avatarUrl,
        });

      const token = issueSessionToken({
        userId: verifiedProfile.id,
        email: verifiedProfile.email,
        fullName: verifiedProfile.fullName,
        authMethod: 'google',
      });

      const fallback = JSON.parse(
        JSON.stringify(initialMockData)
      ) as MockLedgerDataset;
      const dbResult = await fetchDatasetFromSupabase(fallback);
      const scopedDataset = filterDatasetForUser(
        {
          ...dbResult.dataset,
          currentUser: verifiedProfile,
        },
        {
          userId: verifiedProfile.id,
          email: verifiedProfile.email,
        }
      );

      sendJson(
        req,
        res,
        200,
        {
          ok: true,
          authMethod: 'google',
          token,
          profile: verifiedProfile,
          dataset: scopedDataset,
          claimedGroupCount,
        },
        {
          'Set-Cookie': serializeSessionCookie(token),
        }
      );
      return;
    } catch (err) {
      handleBodyError(req, res, err, 'Invalid Google OAuth exchange request');
      return;
    }
  }

  if (req.method === 'POST' && reqUrl.pathname === '/api/auth/logout') {
    sendJson(
      req,
      res,
      200,
      { ok: true },
      {
        'Set-Cookie': serializeClearSessionCookie(),
      }
    );
    return;
  }

  if (req.method === 'POST' && reqUrl.pathname === '/api/auth/login') {
    try {
      const body = await readJsonBody<{
        email?: string;
        password?: string;
      }>(req, 32 * 1024);

      const email =
        typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      const password =
        typeof body.password === 'string' ? body.password : '';

      const loginLimit = checkAuthLoginRateLimit(req, email);
      if (!loginLimit.allowed) {
        sendJson(
          req,
          res,
          429,
          {
            ok: false,
            error:
              'Too many failed login attempts. Please wait before trying again.',
            retryAfterSec: loginLimit.retryAfterSec ?? 900,
          },
          {
            'Retry-After': String(loginLimit.retryAfterSec ?? 900),
          }
        );
        return;
      }

      if (!email || !password) {
        recordAuthLoginFailure(req, email);
        sendJson(req, res, 401, {
          ok: false,
          error: 'Invalid email or password',
        });
        return;
      }

      const authClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
        db: { schema: SUPABASE_SCHEMA as 'wise_spliter' },
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      });

      const { data: authData, error: authError } =
        await authClient.auth.signInWithPassword({
          email,
          password,
        });

      if (authError || !authData?.user) {
        recordAuthLoginFailure(req, email);
        sendJson(req, res, 401, {
          ok: false,
          error: 'Invalid email or password',
        });
        return;
      }

      const { data: profileRow, error: profileError } = await getSupabaseAdmin()
        .from('profiles')
        .select(
          'id, email, full_name, avatar_initials, default_currency, upi_id, google_connected'
        )
        .ilike('email', email)
        .maybeSingle();

      if (profileError || !profileRow) {
        recordAuthLoginFailure(req, email);
        sendJson(req, res, 401, {
          ok: false,
          error: 'Invalid email or password',
        });
        return;
      }

      clearAuthLoginFailures(req, email);

      const typedProfile = profileRow as {
        id: string;
        email: string;
        full_name: string;
        avatar_initials: string;
        default_currency: string | null;
        upi_id: string | null;
        google_connected: boolean | null;
      };

      const verifiedProfile: UserProfile = {
        id: String(typedProfile.id),
        email: String(typedProfile.email).toLowerCase(),
        fullName: String(typedProfile.full_name),
        avatarInitials: String(typedProfile.avatar_initials),
        defaultCurrency: String(typedProfile.default_currency || 'INR'),
        upiId: String(typedProfile.upi_id || ''),
        googleConnected: Boolean(typedProfile.google_connected ?? true),
        supabaseSchema: SUPABASE_SCHEMA,
        syncState: 'synced',
        lastSyncedAt: new Date().toISOString(),
      };

      await claimPendingGroupMembershipsForEmail(
        verifiedProfile.id,
        verifiedProfile.email
      );

      const token = issueSessionToken({
        userId: verifiedProfile.id,
        email: verifiedProfile.email,
        fullName: verifiedProfile.fullName,
        authMethod: 'password',
      });

      const fallback = JSON.parse(
        JSON.stringify(initialMockData)
      ) as MockLedgerDataset;
      const dbResult = await fetchDatasetFromSupabase(fallback);
      const scopedDataset = filterDatasetForUser(
        {
          ...dbResult.dataset,
          currentUser: verifiedProfile,
        },
        {
          userId: verifiedProfile.id,
          email: verifiedProfile.email,
        }
      );

      sendJson(
        req,
        res,
        200,
        {
          ok: true,
          authMethod: 'password',
          token,
          profile: verifiedProfile,
          dataset: scopedDataset,
        },
        {
          'Set-Cookie': serializeSessionCookie(token),
        }
      );
      return;
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        sendJson(req, res, 413, { ok: false, error: err.message });
        return;
      }
      sendJson(req, res, 401, {
        ok: false,
        error: 'Invalid email or password',
      });
      return;
    }
  }

  if (req.method === 'POST' && reqUrl.pathname === '/api/auth/session') {
    try {
      const body = await readJsonBody<{
        userId?: string;
        email?: string;
        fullName?: string;
      }>(req, 32 * 1024);

      const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
      const email =
        typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      const fullName =
        typeof body.fullName === 'string' && body.fullName.trim()
          ? body.fullName.trim()
          : undefined;

      if (!userId || !email) {
        sendJson(req, res, 400, {
          ok: false,
          error: 'Both non-empty `userId` and `email` are required',
        });
        return;
      }

      if (isDemoSandboxUser({ userId, email })) {
        const token = issueSessionToken({
          userId: DEMO_SANDBOX_USER.userId,
          email: DEMO_SANDBOX_USER.email,
          fullName: fullName || DEMO_SANDBOX_USER.fullName,
          authMethod: 'demo',
        });
        sendJson(
          req,
          res,
          200,
          {
            ok: true,
            authMethod: 'demo',
            token,
            user: {
              userId: DEMO_SANDBOX_USER.userId,
              email: DEMO_SANDBOX_USER.email,
              fullName: fullName || DEMO_SANDBOX_USER.fullName,
            },
          },
          {
            'Set-Cookie': serializeSessionCookie(token),
          }
        );
        return;
      }

      // Non-demo session requests MUST present a verified session cookie or Supabase Auth JWT matching the requested user
      const auth = await verifyRequestAuth(req);
      if (
        !auth.authenticated ||
        auth.user.email.toLowerCase() !== email ||
        auth.user.userId !== userId
      ) {
        sendJson(req, res, 401, {
          ok: false,
          error:
            'Unauthorized: Cannot mint session token for non-demo account without verified login or Google OAuth JWT',
        });
        return;
      }

      const token = issueSessionToken({
        userId,
        email,
        fullName,
        authMethod: auth.user.authMethod ?? 'session',
      });
      sendJson(
        req,
        res,
        200,
        {
          ok: true,
          authMethod: auth.user.authMethod ?? 'session',
          token,
          user: {
            userId,
            email,
            ...(fullName ? { fullName } : {}),
          },
        },
        {
          'Set-Cookie': serializeSessionCookie(token),
        }
      );
      return;
    } catch (err) {
      handleBodyError(req, res, err, 'Invalid session request payload');
      return;
    }
  }

  if (req.method === 'GET' && reqUrl.pathname === '/api/ledger/bootstrap') {
    const auth = await verifyRequestAuth(req);
    if (!auth.authenticated) {
      sendJson(req, res, auth.status, {
        ok: false,
        error: auth.error,
      });
      return;
    }

    const fallback = JSON.parse(
      JSON.stringify(initialMockData)
    ) as MockLedgerDataset;
    const result = await fetchDatasetFromSupabase(fallback);
    const scopedDataset = filterDatasetForUser(result.dataset, auth.user);

    sendJson(req, res, 200, {
      ok: true,
      source: result.source,
      schema: SUPABASE_SCHEMA,
      dataset: scopedDataset,
    });
    return;
  }

  if (req.method === 'POST' && reqUrl.pathname === '/api/ledger/sync') {
    const auth = await verifyRequestAuth(req);
    if (!auth.authenticated) {
      sendJson(req, res, auth.status, {
        ok: false,
        error: auth.error,
      });
      return;
    }

    try {
      const body = await readJsonBody<{ dataset?: MockLedgerDataset }>(req);
      const dataset = body.dataset;
      if (!dataset) {
        sendJson(req, res, 400, {
          ok: false,
          error: 'Missing `dataset` in request body',
        });
        return;
      }

      const [existingDbGroups, existingDbEntities] = await Promise.all([
        fetchExistingDbGroups(),
        fetchExistingDbEntityOwnership(),
      ]);
      const authz = authorizeDatasetSyncForUser(
        dataset,
        existingDbGroups,
        auth.user,
        existingDbEntities
      );
      if (!authz.authorized) {
        sendJson(req, res, authz.status ?? 403, {
          ok: false,
          error: authz.error ?? 'Forbidden',
        });
        return;
      }

      const invariantCheck = validateDatasetFinancialInvariants(dataset);
      if (!invariantCheck.valid) {
        sendJson(req, res, 422, {
          ok: false,
          error: invariantCheck.violation,
        });
        return;
      }

      const syncRes = await syncDatasetToSupabase(dataset);
      sendJson(req, res, 200, {
        ok: true,
        schema: SUPABASE_SCHEMA,
        persistedToSupabase: syncRes.ok,
        ...(syncRes.error ? { supabaseWarning: syncRes.error } : {}),
        syncedGroups: dataset.groups.length,
        syncedExpenses: dataset.expenses.length,
        syncedSettlements: dataset.settlements.length,
        syncedAt: new Date().toISOString(),
      });
      return;
    } catch (err) {
      handleBodyError(req, res, err, 'Invalid JSON payload');
      return;
    }
  }

  if (req.method === 'POST' && reqUrl.pathname === '/api/receipts/upload') {
    const auth = await verifyRequestAuth(req);
    if (!auth.authenticated) {
      sendJson(req, res, auth.status, {
        ok: false,
        error: auth.error,
      });
      return;
    }

    try {
      const body = await readJsonBody<{
        id?: unknown;
        expenseId?: unknown;
        groupId?: unknown;
        userId?: unknown;
        fileName?: unknown;
        mimeType?: unknown;
        sizeKb?: unknown;
        uploadedByName?: unknown;
        previewNote?: unknown;
        dataUrl?: unknown;
        hlc?: unknown;
      }>(req);

      const [existingDbGroups, existingDbEntities] = await Promise.all([
        fetchExistingDbGroups(),
        fetchExistingDbEntityOwnership(),
      ]);

      const authz = authorizeReceiptUploadForUser(
        body,
        existingDbGroups,
        existingDbEntities,
        auth.user
      );
      if (!authz.authorized) {
        sendJson(req, res, authz.status, {
          ok: false,
          error: authz.error,
        });
        return;
      }

      const { receiptId, expenseId, groupId, mimeType } = authz.sanitized;
      const uploadRes = await uploadReceiptToSupabaseStorage({
        id: receiptId,
        expenseId,
        groupId,
        actorUserId: auth.user.userId,
        fileName:
          typeof body.fileName === 'string' && body.fileName.trim()
            ? body.fileName.trim()
            : 'receipt.webp',
        mimeType,
        sizeKb: Number(body.sizeKb ?? 18),
        uploadedByName:
          typeof body.uploadedByName === 'string' && body.uploadedByName.trim()
            ? body.uploadedByName.trim()
            : auth.user.email,
        previewNote:
          typeof body.previewNote === 'string' && body.previewNote.trim()
            ? body.previewNote.trim()
            : 'Compressed receipt image',
        dataUrl: typeof body.dataUrl === 'string' ? body.dataUrl : '',
        hlc:
          typeof body.hlc === 'string' && body.hlc.trim()
            ? body.hlc.trim()
            : `${Date.now().toString(16).padStart(12, '0')}-0001-${auth.user.userId}`,
      });

      sendJson(req, res, 200, {
        ok: true,
        bucket: 'wise-spliter-receipts',
        storagePath: uploadRes.storagePath,
        receiptId: uploadRes.receiptId,
        storageUploaded: uploadRes.storageUploaded,
        metadataPersisted: uploadRes.metadataPersisted,
      });
      return;
    } catch (err) {
      handleBodyError(req, res, err, 'Invalid receipt upload payload');
      return;
    }
  }

  if (req.method === 'GET' && reqUrl.pathname === '/api/ledger/pull-changes') {
    const auth = await verifyRequestAuth(req);
    if (!auth.authenticated) {
      sendJson(req, res, auth.status, {
        ok: false,
        error: auth.error,
      });
      return;
    }

    const sinceSeq = Number(reqUrl.searchParams.get('sinceSeq') || '0');
    const safeSinceSeq = Number.isFinite(sinceSeq)
      ? Math.max(0, Math.floor(sinceSeq))
      : 0;
    const [rawResult, existingDbGroups] = await Promise.all([
      callPullChangesRpc(safeSinceSeq),
      fetchExistingDbGroups(),
    ]);

    const normUserId = auth.user.userId.trim();
    const normEmail = auth.user.email.trim().toLowerCase();
    const authorizedGroupIds = new Set(
      existingDbGroups
        .filter(
          (g) =>
            g.created_by?.trim() === normUserId ||
            isUserMemberOfGroup(g.members ?? [], auth.user)
        )
        .map((g) => g.id)
    );

    const rawGroups = Array.isArray(rawResult.groups)
      ? (rawResult.groups as Array<Record<string, unknown>>)
      : [];
    const rawExpenses = Array.isArray(rawResult.expenses)
      ? (rawResult.expenses as Array<Record<string, unknown>>)
      : [];
    const rawSettlements = Array.isArray(rawResult.settlements)
      ? (rawResult.settlements as Array<Record<string, unknown>>)
      : [];
    const rawRevisions = Array.isArray(rawResult.expense_revisions)
      ? (rawResult.expense_revisions as Array<Record<string, unknown>>)
      : [];
    const rawActivity = Array.isArray(rawResult.group_activity_log)
      ? (rawResult.group_activity_log as Array<Record<string, unknown>>)
      : [];

    const filteredGroups = rawGroups.filter(
      (g) => typeof g.id === 'string' && authorizedGroupIds.has(g.id)
    );

    const standaloneSelfIds = new Set<string>([normUserId]);
    const filteredExpenses = rawExpenses.filter((e) => {
      const grpId = (e.group_id ?? e.groupId ?? null) as string | null;
      if (grpId) {
        return authorizedGroupIds.has(grpId);
      }
      const adHoc = (e.ad_hoc_participants ?? e.adHocParticipants ?? []) as Array<{
        id?: string;
        invitedEmail?: string | null;
        invited_email?: string | null;
      }>;
      const createdBy = (e.created_by_member_id ??
        e.createdByMemberId ??
        null) as string | null;
      const allowed = isUserParticipantInStandaloneExpense(
        adHoc,
        auth.user,
        createdBy
      );
      if (allowed && Array.isArray(adHoc)) {
        for (const p of adHoc) {
          const pEmail = (p.invitedEmail ?? p.invited_email ?? '')
            .trim()
            .toLowerCase();
          const pId = p.id?.trim() ?? '';
          if (pId && (pEmail === normEmail || pId === normUserId)) {
            standaloneSelfIds.add(pId);
          }
        }
      }
      return allowed;
    });
    const authorizedExpenseIds = new Set(
      filteredExpenses
        .map((e) => (typeof e.id === 'string' ? e.id : ''))
        .filter(Boolean)
    );

    const filteredSettlements = rawSettlements.filter((s) => {
      const grpId = (s.group_id ?? s.groupId ?? null) as string | null;
      if (grpId) {
        return authorizedGroupIds.has(grpId);
      }
      const fromId = String(s.from_member_id ?? s.fromMemberId ?? '');
      const toId = String(s.to_member_id ?? s.toMemberId ?? '');
      return standaloneSelfIds.has(fromId) || standaloneSelfIds.has(toId);
    });

    const filteredRevisions = rawRevisions.filter((r) => {
      const grpId = (r.group_id ?? r.groupId ?? null) as string | null;
      if (grpId) {
        return authorizedGroupIds.has(grpId);
      }
      const expId = String(r.expense_id ?? r.expenseId ?? '');
      return authorizedExpenseIds.has(expId);
    });

    const filteredActivity = rawActivity.filter((a) => {
      const grpId = (a.group_id ?? a.groupId ?? null) as string | null;
      if (grpId) {
        return authorizedGroupIds.has(grpId);
      }
      const entityId = String(a.entity_id ?? a.entityId ?? '');
      const actorId = String(a.actor_member_id ?? a.actorMemberId ?? '');
      return (
        authorizedExpenseIds.has(entityId) || standaloneSelfIds.has(actorId)
      );
    });

    sendJson(req, res, 200, {
      ok: true,
      schema: SUPABASE_SCHEMA,
      since_seq: safeSinceSeq,
      groups: filteredGroups,
      expenses: filteredExpenses,
      settlements: filteredSettlements,
      expense_revisions: filteredRevisions,
      group_activity_log: filteredActivity,
    });
    return;
  }

  if (req.method === 'POST' && reqUrl.pathname === '/api/ledger/push-mutations') {
    const auth = await verifyRequestAuth(req);
    if (!auth.authenticated) {
      sendJson(req, res, auth.status, {
        ok: false,
        error: auth.error,
      });
      return;
    }

    try {
      const body = await readJsonBody<{ ops?: unknown } | unknown[]>(req);
      const ops = Array.isArray(body)
        ? body
        : body && typeof body === 'object' && 'ops' in body
          ? (body.ops as unknown[])
          : [];

      const [existingDbGroups, existingDbEntities] = await Promise.all([
        fetchExistingDbGroups(),
        fetchExistingDbEntityOwnership(),
      ]);

      const authz = authorizeMutationsForUser(
        ops,
        existingDbGroups,
        existingDbEntities,
        auth.user
      );
      if (!authz.authorized) {
        sendJson(req, res, authz.status ?? 403, {
          ok: false,
          error: authz.error ?? 'Forbidden',
        });
        return;
      }

      const result = await callPushMutationsRpc(ops);
      sendJson(req, res, 200, result);
      return;
    } catch (err) {
      handleBodyError(req, res, err, 'Invalid mutations payload');
      return;
    }
  }

  sendJson(req, res, 404, {
    ok: false,
    error: `Route not found: ${req.method} ${reqUrl.pathname}`,
  });
}

export const apiServer = createServer((req, res) => {
  void handleApiRequest(req, res);
});

apiServer.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    // Allow importing apiServer in test suites when port is already bound
    return;
  }
  console.error('[wise-spliter-api] Server error:', err);
});

if (!process.env.VITEST && process.env.WISE_SPLITER_NO_AUTO_LISTEN !== '1') {
  apiServer.listen(API_PORT, API_HOST, () => {
    console.log(
      `[wise-spliter-api] Listening on http://${API_HOST}:${API_PORT} (schema: ${SUPABASE_SCHEMA})`
    );
  });
}
