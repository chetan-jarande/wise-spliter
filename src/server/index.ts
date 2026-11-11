/**
 * Wise-Spliter Backend API Service (`node:http`)
 * Runs on API_PORT (default 4174) with zero external framework dependencies.
 * Bridges the frontend sync engine to the centralized Supabase `wise_spliter` schema.
 */

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import initialMockData from '../data/mock-ledger-data.json';
import { MockLedgerDataset } from '../types/ledger';
import {
  SUPABASE_SCHEMA,
  checkSupabaseSchemaHealth,
  fetchDatasetFromSupabase,
  syncDatasetToSupabase,
} from './supabaseAdmin';

const API_PORT = Number(process.env.API_PORT || 4174);
const API_HOST = process.env.API_HOST || '0.0.0.0';

function sendJson(
  res: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>
): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
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
    return { valid: false, violation: 'Invalid dataset payload: missing expenses array' };
  }

  for (const exp of dataset.expenses) {
    if (exp.deletedAt) continue;
    const payerSum = (exp.payers ?? []).reduce((acc, p) => acc + p.paidMinor, 0);
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

export const apiServer = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    });
    res.end();
    return;
  }

  const reqUrl = new URL(req.url || '/', `http://127.0.0.1:${API_PORT}`);

  if (req.method === 'GET' && reqUrl.pathname === '/api/health') {
    const health = await checkSupabaseSchemaHealth();
    sendJson(res, 200, {
      ok: true,
      service: 'wise-spliter-api',
      schema: SUPABASE_SCHEMA,
      supabaseReachable: health.reachable,
      schemaHealth: health.schemaHealth,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (req.method === 'GET' && reqUrl.pathname === '/api/ledger/bootstrap') {
    const fallback = JSON.parse(
      JSON.stringify(initialMockData)
    ) as MockLedgerDataset;
    const result = await fetchDatasetFromSupabase(fallback);
    sendJson(res, 200, {
      ok: true,
      source: result.source,
      schema: SUPABASE_SCHEMA,
      dataset: result.dataset,
    });
    return;
  }

  if (req.method === 'POST' && reqUrl.pathname === '/api/ledger/sync') {
    try {
      const body = await readJsonBody<{ dataset?: MockLedgerDataset }>(req);
      const dataset = body.dataset;
      if (!dataset) {
        sendJson(res, 400, {
          ok: false,
          error: 'Missing `dataset` in request body',
        });
        return;
      }

      const invariantCheck = validateDatasetFinancialInvariants(dataset);
      if (!invariantCheck.valid) {
        sendJson(res, 422, {
          ok: false,
          error: invariantCheck.violation,
        });
        return;
      }

      const syncRes = await syncDatasetToSupabase(dataset);
      sendJson(res, 200, {
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
      sendJson(res, 400, {
        ok: false,
        error: err instanceof Error ? err.message : 'Invalid JSON payload',
      });
      return;
    }
  }

  sendJson(res, 404, {
    ok: false,
    error: `Route not found: ${req.method} ${reqUrl.pathname}`,
  });
});

apiServer.listen(API_PORT, API_HOST, () => {
  console.log(
    `[wise-spliter-api] Listening on http://${API_HOST}:${API_PORT} (schema: ${SUPABASE_SCHEMA})`
  );
});
