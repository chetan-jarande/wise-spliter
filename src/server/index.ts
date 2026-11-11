/**
 * Wise-Spliter Backend API Service (`node:http`)
 * Runs on API_PORT (default 4174) with zero external framework dependencies.
 * Bridges the frontend sync engine to the centralized Supabase `wise_spliter` schema
 * with HMAC/JWT authentication (HTTP 401), strict user & group-membership isolation (HTTP 403),
 * CORS allowlisting, security headers, and per-IP rate limiting (HTTP 429).
 */

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import initialMockData from '../data/mock-ledger-data.json';
import { MockLedgerDataset } from '../types/ledger';
import {
  authorizeDatasetSyncForUser,
  buildSecurityHeaders,
  checkRateLimit,
  filterDatasetForUser,
  issueSessionToken,
  verifyRequestAuth,
} from './securityAndAuth';
import {
  SUPABASE_SCHEMA,
  callPullChangesRpc,
  callPushMutationsRpc,
  checkSupabaseSchemaHealth,
  fetchDatasetFromSupabase,
  fetchExistingDbGroups,
  syncDatasetToSupabase,
  uploadReceiptToSupabaseStorage,
} from './supabaseAdmin';

const API_PORT = Number(process.env.API_PORT || 4174);
const API_HOST = process.env.API_HOST || '0.0.0.0';

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
    ...securityHeaders,
    ...(extraHeaders || {}),
  });
  res.end(body);
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve((text ? JSON.parse(text) : {}) as T);
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
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
  }

  return { valid: true };
}

function isUserAuthorizedOnExistingGroup(
  groupId: string,
  existingDbGroups: Awaited<ReturnType<typeof fetchExistingDbGroups>>,
  user: { userId: string; email: string }
): boolean {
  const dbGroup = existingDbGroups.find((g) => g.id === groupId);
  if (!dbGroup) {
    // New group not yet in DB
    return true;
  }
  const normUserId = user.userId.trim();
  const normEmail = user.email.trim().toLowerCase();
  if (dbGroup.created_by?.trim() === normUserId) {
    return true;
  }
  return (dbGroup.members ?? []).some(
    (m) =>
      m.user_id?.trim() === normUserId ||
      m.invited_email?.trim().toLowerCase() === normEmail
  );
}

export const apiServer = createServer(async (req, res) => {
  const securityHeaders = buildSecurityHeaders(getRequestOrigin(req));

  if (req.method === 'OPTIONS') {
    res.writeHead(204, securityHeaders);
    res.end();
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
      schemaHealth: health.schemaHealth,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (req.method === 'POST' && reqUrl.pathname === '/api/auth/session') {
    try {
      const body = await readJsonBody<{
        userId?: string;
        email?: string;
        fullName?: string;
      }>(req);

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

      const token = issueSessionToken({ userId, email, fullName });
      sendJson(req, res, 200, {
        ok: true,
        token,
        user: {
          userId,
          email,
          ...(fullName ? { fullName } : {}),
        },
      });
      return;
    } catch (err) {
      sendJson(req, res, 400, {
        ok: false,
        error: err instanceof Error ? err.message : 'Invalid session request payload',
      });
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

      const existingDbGroups = await fetchExistingDbGroups();
      const authz = authorizeDatasetSyncForUser(
        dataset,
        existingDbGroups,
        auth.user
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
      sendJson(req, res, 400, {
        ok: false,
        error: err instanceof Error ? err.message : 'Invalid JSON payload',
      });
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
        id?: string;
        expenseId?: string;
        groupId?: string | null;
        userId?: string;
        fileName?: string;
        mimeType?: string;
        sizeKb?: number;
        uploadedByName?: string;
        previewNote?: string;
        dataUrl?: string;
        hlc?: string;
      }>(req);

      if (body.userId && body.userId.trim() !== auth.user.userId) {
        sendJson(req, res, 403, {
          ok: false,
          error: 'Forbidden: Cross-user receipt upload impersonation denied',
        });
        return;
      }

      if (body.groupId) {
        const existingDbGroups = await fetchExistingDbGroups();
        if (
          !isUserAuthorizedOnExistingGroup(
            body.groupId,
            existingDbGroups,
            auth.user
          )
        ) {
          sendJson(req, res, 403, {
            ok: false,
            error:
              'Forbidden: Cannot upload receipt to a group owned by other users',
          });
          return;
        }
      }

      const receiptId = body.id || `rcpt_${Date.now()}`;
      const expenseId = body.expenseId || 'exp_goa_villa_01';
      const uploadRes = await uploadReceiptToSupabaseStorage({
        id: receiptId,
        expenseId,
        groupId: body.groupId ?? null,
        fileName: body.fileName || 'receipt.webp',
        mimeType: body.mimeType || 'image/webp',
        sizeKb: Number(body.sizeKb ?? 18),
        uploadedByName: body.uploadedByName || 'Arjun Mehta',
        previewNote: body.previewNote || 'Compressed receipt image',
        dataUrl: body.dataUrl || '',
        hlc:
          body.hlc ||
          `${Date.now().toString(16).padStart(12, '0')}-0001-${auth.user.userId}`,
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
      sendJson(req, res, 400, {
        ok: false,
        error:
          err instanceof Error
            ? err.message
            : 'Invalid receipt upload payload',
      });
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
    const [rawResult, existingDbGroups] = await Promise.all([
      callPullChangesRpc(sinceSeq),
      fetchExistingDbGroups(),
    ]);

    const normUserId = auth.user.userId.trim();
    const normEmail = auth.user.email.trim().toLowerCase();
    const authorizedGroupIds = new Set(
      existingDbGroups
        .filter(
          (g) =>
            g.created_by?.trim() === normUserId ||
            (g.members ?? []).some(
              (m) =>
                m.user_id?.trim() === normUserId ||
                m.invited_email?.trim().toLowerCase() === normEmail
            )
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

    const filteredGroups = rawGroups.filter(
      (g) =>
        (typeof g.id === 'string' && authorizedGroupIds.has(g.id)) ||
        g.created_by === normUserId
    );
    const filteredExpenses = rawExpenses.filter((e) => {
      const grpId = (e.group_id ?? e.groupId ?? null) as string | null;
      if (grpId) {
        return authorizedGroupIds.has(grpId);
      }
      const adHoc = (e.ad_hoc_participants ?? e.adHocParticipants ?? []) as Array<{
        id?: string;
        invitedEmail?: string | null;
      }>;
      return (
        Array.isArray(adHoc) &&
        adHoc.some(
          (p) =>
            p.invitedEmail?.trim().toLowerCase() === normEmail ||
            p.id?.trim() === normUserId
        )
      );
    });
    const filteredSettlements = rawSettlements.filter((s) => {
      const grpId = (s.group_id ?? s.groupId ?? null) as string | null;
      if (grpId) {
        return authorizedGroupIds.has(grpId);
      }
      return (
        s.from_member_id === normUserId ||
        s.to_member_id === normUserId ||
        s.fromMemberId === normUserId ||
        s.toMemberId === normUserId
      );
    });

    sendJson(req, res, 200, {
      ...rawResult,
      groups: filteredGroups,
      expenses: filteredExpenses,
      settlements: filteredSettlements,
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
      const body = await readJsonBody<{ ops?: unknown[] } | unknown[]>(req);
      const ops = Array.isArray(body) ? body : body.ops ?? [];
      const existingDbGroups = await fetchExistingDbGroups();

      for (const rawOp of ops) {
        if (rawOp && typeof rawOp === 'object') {
          const op = rawOp as Record<string, unknown>;
          const opUserId =
            typeof op.userId === 'string'
              ? op.userId.trim()
              : typeof op.actorUserId === 'string'
                ? op.actorUserId.trim()
                : '';
          if (opUserId && opUserId !== auth.user.userId) {
            sendJson(req, res, 403, {
              ok: false,
              error: 'Forbidden: Cross-user mutation impersonation denied',
            });
            return;
          }

          const opGroupId =
            typeof op.groupId === 'string'
              ? op.groupId.trim()
              : typeof op.group_id === 'string'
                ? op.group_id.trim()
                : '';
          if (
            opGroupId &&
            !isUserAuthorizedOnExistingGroup(
              opGroupId,
              existingDbGroups,
              auth.user
            )
          ) {
            sendJson(req, res, 403, {
              ok: false,
              error:
                'Forbidden: Cannot push mutations to a group you are not a member of',
            });
            return;
          }
        }
      }

      const result = await callPushMutationsRpc(ops);
      sendJson(req, res, 200, result);
      return;
    } catch (err) {
      sendJson(req, res, 400, {
        ok: false,
        error: err instanceof Error ? err.message : 'Invalid mutations payload',
      });
      return;
    }
  }

  sendJson(req, res, 404, {
    ok: false,
    error: `Route not found: ${req.method} ${reqUrl.pathname}`,
  });
});

apiServer.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    // Allow importing apiServer in test suites when port is already bound
    return;
  }
  console.error('[wise-spliter-api] Server error:', err);
});

apiServer.listen(API_PORT, API_HOST, () => {
  console.log(
    `[wise-spliter-api] Listening on http://${API_HOST}:${API_PORT} (schema: ${SUPABASE_SCHEMA})`
  );
});
