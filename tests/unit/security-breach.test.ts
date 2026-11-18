import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEV_DEFAULT_PASSWORD, DEV_DEMO_PROFILES } from '../../src/data/dev-profiles';
import { API_HOST, handleApiRequest, resetEmailConfirmationCacheForTests } from '../../src/server/index';
import * as admin from '../../src/server/supabaseAdmin';
import {
  assertProductionSecretsConfigured,
  buildSecurityHeaders,
  checkRateLimit,
  extractClientIp,
  getAllowedOrigins,
  getRateLimitBucketCountForTests,
  assertNumericEnv,
  ipBucket,
  issueSessionToken,
  resetRateLimiterForTests,
  verifySessionToken,
} from '../../src/server/securityAndAuth';
import { getProfileById, getSupabaseAdmin, resolveProfileForAuthUser, SUPABASE_SCHEMA, SUPABASE_URL } from '../../src/server/supabaseAdmin';
import type { SyncPullResponse, SyncPushResponse, SyncPushResult } from '../../src/types/sync-contract';

const PUBLISHABLE_KEY = (process.env.VITE_SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || '').trim();
if (!PUBLISHABLE_KEY) throw new Error('VITE_SUPABASE_PUBLISHABLE_KEY is required (see .env.example)');

type Json = Record<string, unknown>;
const RUN = `sec${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
const id = (s: string) => `${RUN}_${s}`;
let tick = 0;
const hlc = (offsetMs = 0) => `${(Date.now() + offsetMs + ++tick).toString(16).padStart(12, '0')}-0001-sec`;
const OLD_HLC = '019a70f0c300-0001-sec';
const P1 = randomUUID();
const P2 = randomUUID();
const db = () => getSupabaseAdmin();

const ARJUN = 'usr_arjun_01';
const ROHAN = 'usr_rohan_02';
const ROHAN_EMAIL = DEV_DEMO_PROFILES.find((p) => p.id === ROHAN)!.email;
const PRIYA = 'usr_priya_03';
const G = id('grp');
const M = { arjun: id('m_arjun'), rohan: id('m_rohan'), kabir: id('m_kabir') };

async function tokenFor(userId: string): Promise<string> {
  const s = await getProfileById(userId);
  if (!s) throw new Error(`profile ${userId} missing: run make setup-dev`);
  return issueSessionToken({ userId, tokenVersion: s.tokenVersion });
}

function expense(eid: string, groupId: string | null, payer: string, owers: string[], amount: number | string, over: Json = {}): Json {
  const share = typeof amount === 'number' ? amount / owers.length : 0;
  return {
    id: eid, groupId, adHocParticipants: [], title: `Security ${eid}`, category: 'food', tags: [], notes: '',
    expenseDate: '2026-11-15', originalCurrency: 'INR', originalAmountMinor: amount, groupCurrency: 'INR',
    amountMinor: amount, fxRateScaled: 100000000, fxStatus: 'identity', fxAuditNote: null, splitMode: 'exact',
    rotationSeed: 0, payers: [{ memberId: payer, paidMinor: amount, originalPaidMinor: amount }],
    splits: [
      ...owers.map((m) => ({ memberId: m, included: true, owedMinor: share, originalOwedMinor: share, rawInputValue: share, remainderMinor: 0 })),
      ...(owers.includes(payer) ? [] : [{ memberId: payer, included: false, owedMinor: 0, originalOwedMinor: 0, rawInputValue: 0, remainderMinor: 0 }]),
    ],
    currentRevisionId: `${eid}_v1`, revisionNumber: 1, hasUnresolvedConflict: false, conflictRevisionId: null,
    createdByMemberId: payer, updatedByMemberId: payer, createdAt: '2026-11-15T00:00:00Z',
    updatedAt: '2026-11-15T00:00:00Z', deletedAt: null, hlc: '', comments: [], receipts: [], ...over,
  };
}

const mut = (entity: string, mid: string, data: Json | null, h = hlc(), op: 'upsert' | 'delete' | 'restore' = 'upsert') => ({ entity, id: mid, op, hlc: h, data });

describe('Wise-Spliter security regression suite (API + wise_spliter RPCs, local Supabase)', () => {
  let server: Server;
  let baseUrl = '';
  const tok: Record<string, string> = {};

  async function api(path: string, opts: { token?: string; method?: string; body?: unknown; headers?: Record<string, string>; raw?: string } = {}) {
    const res = await fetch(`${baseUrl}${path}`, {
      method: opts.method ?? (opts.body !== undefined || opts.raw ? 'POST' : 'GET'),
      headers: { 'Content-Type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}), ...(opts.headers ?? {}) },
      ...(opts.raw ? { body: opts.raw } : opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    const text = await res.text();
    let json: Json = {};
    try {
      json = text ? (JSON.parse(text) as Json) : {};
    } catch {
      json = {};
    }
    return { status: res.status, json, text, headers: res.headers };
  }

  async function push(token: string, mutations: unknown[]): Promise<Map<string, SyncPushResult>> {
    // 429 = another push for this account is in flight (the shared dev profiles are also used by other
    // suites, e2e and the dev app); 503 = the batch hit its lock/time budget under load and was rolled
    // back whole. Real clients retry both, so do we; the BUSY and 503 tests call the API directly.
    let r = await api('/api/ledger/push', { token, body: { mutations } });
    for (let i = 0; (r.status === 429 || r.status === 503) && i < 40; i++) {
      await new Promise((res) => setTimeout(res, 100 + Math.random() * 150));
      r = await api('/api/ledger/push', { token, body: { mutations } });
    }
    expect(r.status).toBe(200);
    return new Map((r.json as unknown as SyncPushResponse).results.map((x) => [x.id, x]));
  }

  async function pullAll(token: string, cursor = '0'): Promise<{ changes: SyncPullResponse['changes']; cursor: string }> {
    const changes: SyncPullResponse['changes'] = [];
    for (let page = 0; page < 200; page++) {
      const r = await api(`/api/ledger/pull?cursor=${cursor}&limit=500`, { token });
      expect(r.status).toBe(200);
      const body = r.json as unknown as SyncPullResponse;
      changes.push(...body.changes);
      cursor = body.nextCursor;
      if (!body.hasMore) break;
    }
    return { changes, cursor };
  }

  const row = async (table: string, rid: string) => (await db().from(table).select('*').eq('id', rid).maybeSingle()).data as Json | null;

  // Groups and rows created as the shared dev profiles count against their lifetime quotas; give the
  // counters back afterwards so repeated runs never exhaust them (per-run profiles are cleaned by prefix).
  const SHARED = [ARJUN, ROHAN, PRIYA];
  let quotaSnapshot: Json[] = [];

  beforeAll(async () => {
    quotaSnapshot = ((await db().from('quota_usage').select('*').in('owner_id', SHARED)).data ?? []) as Json[];
    process.env.API_RATE_LIMIT = '100000';
    server = createServer((req, res) => void handleApiRequest(req, res));
    server.keepAliveTimeout = 60_000;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const u of [ARJUN, ROHAN, PRIYA]) tok[u] = await tokenFor(u);

    // Arjun creates a group (admin bootstrap), adds Rohan and a placeholder; Rohan's slot is linked like a claim.
    const res = await push(tok[ARJUN]!, [
      mut('group', G, { name: 'Security Group', baseCurrency: 'INR', inviteCode: id('inv'), simplifyDebts: true }),
      mut('group_member', M.arjun, { groupId: G, userId: ARJUN, displayName: 'Arjun', role: 'admin', memberOrder: 0 }),
      mut('group_member', M.rohan, { groupId: G, invitedEmail: 'rohan.verma@example.com', displayName: 'Rohan', memberOrder: 1 }),
      mut('group_member', M.kabir, { groupId: G, displayName: 'Kabir', memberOrder: 2 }),
    ]);
    for (const k of [G, M.arjun, M.rohan, M.kabir]) expect(res.get(k)?.status).toBe('applied');
    await db().from('group_members').update({ user_id: ROHAN }).eq('id', M.rohan);
  });

  afterAll(async () => {
    await db().from('quota_usage').delete().in('owner_id', SHARED);
    if (quotaSnapshot.length) await db().from('quota_usage').upsert(quotaSnapshot, { onConflict: 'kind,owner_id,scope_id' });
    await db().from('groups').delete().like('id', `${RUN}%`);
    await db().from('expenses').delete().like('id', `${RUN}%`);
    await db().from('settlements').delete().like('id', `${RUN}%`);
    await db().from('profiles').delete().like('id', `${RUN}%`);
    await db().from('group_activity_log').delete().like('id', `${RUN}%`);
    await db().from('quota_usage').delete().like('owner_id', `${RUN}%`);
    await db().from('quota_usage').delete().like('scope_id', `${RUN}%`);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => resetRateLimiterForTests());

  it('binds to loopback, health exposes no row counts, retired routes are gone', async () => {
    expect(API_HOST).toBe('127.0.0.1');
    const health = await api('/api/health');
    expect(health.status).toBe(200);
    expect(health.text).not.toMatch(/_count/);
    for (const [method, path] of [['POST', '/api/ledger/sync'], ['GET', '/api/ledger/bootstrap'], ['GET', '/api/ledger/pull-changes'], ['POST', '/api/ledger/push-mutations']]) {
      expect((await api(path!, { method, token: tok[ARJUN] })).status).toBe(404);
    }
  });

  describe('C1: authorization is per-id in SQL, transactional with the write, and fails closed', () => {
    it('a non-member cannot overwrite an existing expense by reusing its id from their own group', async () => {
      const victim = id('exp_victim');
      expect((await push(tok[ARJUN]!, [mut('expense', victim, expense(victim, G, M.arjun, [M.arjun, M.rohan], 1000))])).get(victim)?.status).toBe('applied');
      const rohanGroup = id('grp_rohan');
      const r = await push(tok[PRIYA]!, [
        mut('group', rohanGroup, { name: 'Priya own', baseCurrency: 'INR', inviteCode: id('inv2') }),
        mut('group_member', id('m_priya'), { groupId: rohanGroup, userId: PRIYA, displayName: 'Priya', role: 'admin' }),
        mut('expense', victim, expense(victim, rohanGroup, id('m_priya'), [id('m_priya')], 5, { title: 'HIJACK' }), hlc(30_000)),
      ]);
      expect(r.get(victim)?.status).toBe('forbidden');
      expect((await row('expenses', victim))?.title).toBe(`Security ${victim}`);
    });

    it('a group id that does not exist yet is not a free pass for children (no "brand new" bypass)', async () => {
      const ghost = id('ghost_grp');
      const e = id('exp_ghost');
      const r = await push(tok[PRIYA]!, [mut('expense', e, expense(e, ghost, 'm_x', ['m_x'], 10)), mut('group_member', id('m_ghost'), { groupId: G, displayName: 'x' })]);
      expect(r.get(e)?.status).toBe('forbidden');
      expect(r.get(id('m_ghost'))?.status).toBe('forbidden');
    });

    it('returns 503 with a generic message (no Postgres text) when the database errors', async () => {
      const client = getSupabaseAdmin();
      const original = client.rpc.bind(client);
      (client as unknown as { rpc: unknown }).rpc = async () => ({ data: null, error: { message: 'relation "secret_table" does not exist', code: '42P01' } });
      try {
        for (const r of [await api('/api/ledger/push', { token: tok[ARJUN], body: { mutations: [mut('expense', id('x'), expense(id('x'), G, M.arjun, [M.arjun], 1))] } }), await api('/api/ledger/pull?cursor=0', { token: tok[ARJUN] })]) {
          expect(r.status).toBe(503);
          expect(r.text).not.toContain('secret_table');
        }
      } finally {
        (client as unknown as { rpc: unknown }).rpc = original;
      }
    });

    it('the server keeps no module-level ownership caches', () => {
      expect(Object.keys(admin)).not.toEqual(expect.arrayContaining(['fetchExistingDbGroups']));
      expect('resetOwnershipCachesForTests' in admin).toBe(false);
      expect('fetchDatasetFromSupabase' in admin).toBe(false);
    });
  });

  describe('C2: conditional upserts and cursor pull', () => {
    it('stale hlc is rejected, newer hlc applies and bumps server_seq so pull sees the UPDATE', async () => {
      const e = id('exp_c2');
      const first = await push(tok[ARJUN]!, [mut('expense', e, expense(e, G, M.arjun, [M.arjun], 500))]);
      const seq1 = BigInt(first.get(e)!.serverSeq!);
      const stale = await push(tok[ROHAN]!, [mut('expense', e, expense(e, G, M.rohan, [M.rohan], 700), OLD_HLC)]);
      expect(stale.get(e)?.status).toBe('stale');
      expect(Number((await row('expenses', e))?.amount_minor)).toBe(500);

      const fresh = await push(tok[ROHAN]!, [mut('expense', e, expense(e, G, M.rohan, [M.rohan], 700, { currentRevisionId: `${e}_v2`, revisionNumber: 2 }), hlc(1000))]);
      expect(BigInt(fresh.get(e)!.serverSeq!)).toBeGreaterThan(seq1);
      const pulled = await pullAll(tok[ARJUN]!, String(seq1));
      expect(pulled.changes.find((c) => c.id === e)?.data?.amountMinor).toBe(700);
      // The replaced v1 state is kept as a revision on first edit (v1 is not stored on create).
      expect((await row('expense_revisions', `${e}_v1`))?.action).toBe('created');
    });

    it('soft delete comes back as deleted:true and an older device cannot resurrect it', async () => {
      const e = id('exp_del');
      await push(tok[ARJUN]!, [mut('expense', e, expense(e, G, M.arjun, [M.arjun], 300))]);
      const before = (await pullAll(tok[ROHAN]!)).cursor;
      expect((await push(tok[ARJUN]!, [mut('expense', e, null, hlc(2000), 'delete')])).get(e)?.status).toBe('applied');
      expect((await push(tok[ROHAN]!, [mut('expense', e, expense(e, G, M.arjun, [M.arjun], 300), hlc(1000))])).get(e)?.status).toBe('stale');
      const change = (await pullAll(tok[ROHAN]!, before)).changes.find((c) => c.id === e);
      expect(change?.deleted).toBe(true);
    });

    it('a lower server_seq can never commit after a higher one was pulled (two concurrent DB sessions)', async () => {
      const slow = id('exp_slow');
      const fast = id('exp_fast');
      await push(tok[ARJUN]!, [
        mut('expense', slow, expense(slow, G, M.arjun, [M.arjun], 100)),
        mut('expense', fast, expense(fast, G, M.arjun, [M.arjun], 100)),
      ]);
      const start = (await pullAll(tok[ARJUN]!)).cursor;
      const psql = (sql: string) =>
        new Promise<number>((resolve) => {
          const p = spawn('docker', ['exec', '-i', 'supabase_db_dependencies', 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres', '-c', sql]);
          p.on('close', (code) => resolve(code ?? 1));
        });
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      // A draws its seq first but commits last; B starts later and would commit first without the lock.
      const a = psql(`BEGIN; UPDATE wise_spliter.expenses SET notes = 'slow' WHERE id = '${slow}'; SELECT pg_sleep(1.5); COMMIT;`);
      await sleep(400);
      const b = psql(`UPDATE wise_spliter.expenses SET notes = 'fast' WHERE id = '${fast}';`);
      await sleep(400);
      const mid = await pullAll(tok[ARJUN]!, start);
      expect([await a, await b]).toEqual([0, 0]);
      const after = await pullAll(tok[ARJUN]!, mid.cursor);
      const seen = new Set([...mid.changes, ...after.changes]
        .filter((c) => (c.id === slow && c.data?.notes === 'slow') || (c.id === fast && c.data?.notes === 'fast')).map((c) => c.id));
      expect(seen).toEqual(new Set([slow, fast]));
    }, 20_000);

    it('a group push that only changes per-device fields writes nothing and does not bump server_seq', async () => {
      const before = await row('groups', G);
      const r = await push(tok[ROHAN]!, [mut('group', G, { name: 'Security Group', baseCurrency: 'INR', inviteCode: id('inv'), simplifyDebts: true, lastAccessedAt: new Date().toISOString() }, hlc(5000))]);
      expect(r.get(G)?.status).toBe('applied');
      expect((await row('groups', G))?.server_seq).toBe(before?.server_seq);
    });

    it('pull pages respect limit, cursor is monotonic, and serverSeq values are strings', async () => {
      const r = await api('/api/ledger/pull?cursor=0&limit=5', { token: tok[ARJUN] });
      const body = r.json as unknown as SyncPullResponse;
      expect(body.changes.length).toBeLessThanOrEqual(5);
      expect(body.hasMore).toBe(true);
      const seqs = body.changes.map((c) => BigInt(c.serverSeq));
      expect([...seqs].sort((a, b) => (a < b ? -1 : 1))).toEqual(seqs);
      expect(typeof body.nextCursor).toBe('string');
      expect((await api('/api/ledger/pull?cursor=-1', { token: tok[ARJUN] })).status).toBe(400);
      const clamped = await api('/api/ledger/pull?cursor=0&limit=100000', { token: tok[ARJUN] });
      expect((clamped.json as unknown as SyncPullResponse).changes.length).toBeLessThanOrEqual(500);
    });
  });

  describe('C3: demo, body size, DB limits, row caps', () => {
    it('demo sessions are refused in production', async () => {
      const prev = { env: process.env.NODE_ENV, secret: process.env.GRANT_TOKEN_SECRET };
      process.env.NODE_ENV = 'production';
      process.env.GRANT_TOKEN_SECRET = 'prod_unique_hmac_secret_0123456789abcdef0123456789';
      try {
        expect((await api('/api/auth/demo', { body: {} })).status).toBe(404);
      } finally {
        process.env.NODE_ENV = prev.env;
        process.env.GRANT_TOKEN_SECRET = prev.secret;
      }
    });

    it('bodies over 256 KB get 413 and oversized fields are invalid', async () => {
      const big = await api('/api/ledger/push', { token: tok[ARJUN], raw: JSON.stringify({ mutations: [], pad: 'A'.repeat(300 * 1024) }) });
      expect(big.status).toBe(413);
      const e = id('exp_big_title');
      expect((await push(tok[ARJUN]!, [mut('expense', e, expense(e, G, M.arjun, [M.arjun], 1, { title: 'x'.repeat(201) }))])).get(e)?.status).toBe('invalid');
    });

    it('DB CHECKs and row caps hold even for the service role', async () => {
      const { error } = await db().from('groups').insert({ id: id('g_long'), name: 'x'.repeat(101), invite_code: `WS-${randomBytes(5).toString('hex').toUpperCase()}`, created_by: ARJUN, hlc: OLD_HLC });
      expect(error?.message).toMatch(/chk_groups_text/);
      const many = Array.from({ length: 501 }, (_, i) => ({ id: id(`cap_${i}`), name: 'cap', invite_code: `WS-${randomBytes(5).toString('hex').toUpperCase()}`, created_by: id('cap_owner'), hlc: OLD_HLC }));
      const caps = await db().from('groups').insert(many);
      expect(caps.error?.message).toMatch(/row cap/);
    });
  });

  describe('C4: reads are scoped in SQL', () => {
    it("a member never pulls another tenant's rows and a non-member pulls nothing of the group", async () => {
      const priya = await pullAll(tok[PRIYA]!);
      expect(priya.changes.some((c) => c.id === G || c.data?.groupId === G)).toBe(false);
      const rohan = await pullAll(tok[ROHAN]!);
      expect(rohan.changes.some((c) => c.data?.groupId === 'grp_tokyo_2026' || c.id === 'grp_tokyo_2026')).toBe(false);
      expect(rohan.changes.some((c) => c.id === G)).toBe(true);
    });
  });

  describe('H1/H2: exact verified identities only', () => {
    it('wildcard-looking emails never map to another profile, and stored emails must be lowercase', async () => {
      const victim = `${RUN}.victim@example.com`;
      await db().from('profiles').insert({ id: id('unbound'), email: victim, full_name: 'Unbound', hlc: OLD_HLC });
      for (const email of [victim.replace('.victim', '_victim'), `${RUN}%`, '%@example.com', victim.replace('victim', 'v_ctim')]) {
        const s = await resolveProfileForAuthUser({ authUid: '00000000-0000-4000-8000-000000000001', email, create: false });
        expect(s).toBeNull();
      }
      const { error } = await db().from('profiles').insert({ id: id('upper'), email: 'Upper@Example.com', full_name: 'U', hlc: OLD_HLC });
      expect(error?.message).toMatch(/chk_profiles_email/);
    });

    it('Google exchange rejects non-Google providers; raw Supabase JWTs are not accepted on data routes', async () => {
      expect((await api('/api/auth/google', { body: { accessToken: 'eyJhbGciOiJIUzI1NiJ9.forged.sig' } })).status).toBe(401);
      const client = createClient(SUPABASE_URL, PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
      const { data, error } = await client.auth.signInWithPassword({ email: 'priya.nair@example.com', password: DEV_DEFAULT_PASSWORD });
      expect(error).toBeNull();
      const jwt = data.session!.access_token;
      expect((await api('/api/auth/google', { body: { accessToken: jwt } })).status).toBe(401);
      expect((await api('/api/ledger/pull?cursor=0', { token: jwt })).status).toBe(401);
    });
  });

  describe('H3: PostgREST surface is closed to anon and authenticated', () => {
    it('authenticated JWT cannot select, insert or call RPCs on wise_spliter', async () => {
      const client = createClient(SUPABASE_URL, PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
      const { data } = await client.auth.signInWithPassword({ email: 'rohan.verma@example.com', password: DEV_DEFAULT_PASSWORD });
      const headers = { apikey: PUBLISHABLE_KEY, Authorization: `Bearer ${data.session!.access_token}`, 'Accept-Profile': SUPABASE_SCHEMA, 'Content-Profile': SUPABASE_SCHEMA, 'Content-Type': 'application/json' };
      for (const [path, init] of [
        ['/rest/v1/groups?select=id', {}],
        ['/rest/v1/profiles?select=id', {}],
        ['/rest/v1/group_members', { method: 'POST', body: JSON.stringify({ id: 'x', group_id: G, display_name: 'x', hlc: OLD_HLC }) }],
        ['/rest/v1/rpc/pull_changes', { method: 'POST', body: JSON.stringify({ p_actor: ROHAN, p_cursor: 0, p_limit: 1 }) }],
        ['/rest/v1/rpc/push_mutations', { method: 'POST', body: JSON.stringify({ p_actor: ROHAN, p_mutations: [] }) }],
      ] as const) {
        const res = await fetch(`${SUPABASE_URL}${path}`, { ...init, headers });
        expect([401, 403, 404]).toContain(res.status);
      }
    });

    it('a removed member, even the group creator, loses read and write access', async () => {
      const g = id('grp_rm');
      await push(tok[ROHAN]!, [
        mut('group', g, { name: 'Removed creator', baseCurrency: 'INR', inviteCode: id('inv_rm') }),
        mut('group_member', id('m_rm_rohan'), { groupId: g, userId: ROHAN, displayName: 'Rohan', role: 'admin' }),
      ]);
      expect((await push(tok[ROHAN]!, [mut('group_member', id('m_rm_rohan'), null, hlc(), 'delete')])).get(id('m_rm_rohan'))?.status).toBe('applied');
      const e = id('exp_rm');
      expect((await push(tok[ROHAN]!, [mut('expense', e, expense(e, g, id('m_rm_rohan'), [id('m_rm_rohan')], 10))])).get(e)?.status).toBe('forbidden');
      const changes = (await pullAll(tok[ROHAN]!)).changes;
      expect(changes.some((c) => c.id === g)).toBe(false);
      expect(changes.find((c) => c.id === id('m_rm_rohan'))?.deleted).toBe(true);
    });
  });

  describe('H4: rate limiting', () => {
    const fakeReq = (headers: Json, ip = '10.0.0.1') => ({ headers, socket: { remoteAddress: ip } }) as unknown as IncomingMessage;

    it('uses CF-Connecting-IP or the rightmost proxy hop, never a client-chosen leftmost hop', () => {
      const prev = process.env.TRUST_PROXY;
      try {
        process.env.TRUST_PROXY = 'true';
        expect(extractClientIp(fakeReq({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }))).toBe('203.0.113.9');
        process.env.TRUST_PROXY = 'cloudflare';
        expect(extractClientIp(fakeReq({ 'cf-connecting-ip': '198.51.100.7', 'x-forwarded-for': '6.6.6.6' }))).toBe('198.51.100.7');
        delete process.env.TRUST_PROXY;
        expect(extractClientIp(fakeReq({ 'x-forwarded-for': '6.6.6.6' }))).toBe('10.0.0.1');
      } finally {
        if (prev === undefined) delete process.env.TRUST_PROXY;
        else process.env.TRUST_PROXY = prev;
      }
    });

    it('keys on the user once authenticated and keeps the bucket map bounded', async () => {
      const prev = process.env.API_RATE_LIMIT;
      process.env.API_RATE_LIMIT = '2';
      try {
        const shared = '10.9.9.9';
        const a = fakeReq({ authorization: `Bearer ${tok[ARJUN]}` }, shared);
        const b = fakeReq({ authorization: `Bearer ${tok[ROHAN]}` }, shared);
        expect([checkRateLimit(a).allowed, checkRateLimit(a).allowed, checkRateLimit(a).allowed]).toEqual([true, true, false]);
        expect(checkRateLimit(b).allowed).toBe(true);
        process.env.API_RATE_LIMIT = '100000';
        for (let i = 0; i < 10_200; i++) checkRateLimit(fakeReq({}, `172.16.${i >> 8}.${i & 255}`));
        expect(getRateLimitBucketCountForTests()).toBeLessThanOrEqual(10_000);
      } finally {
        process.env.API_RATE_LIMIT = prev;
      }
    });

    it('a rotated, spoofed X-Forwarded-For does not reset the login limiter', async () => {
      process.env.AUTH_RATE_LIMIT_MAX = '3';
      try {
        for (let i = 0; i < 3; i++) {
          expect((await api('/api/auth/login', { body: { email: 'victim@example.com', password: 'x' }, headers: { 'X-Forwarded-For': `203.0.113.${i}` } })).status).toBe(401);
        }
        expect((await api('/api/auth/login', { body: { email: 'victim@example.com', password: 'x' }, headers: { 'X-Forwarded-For': '198.51.100.1' } })).status).toBe(429);
      } finally {
        delete process.env.AUTH_RATE_LIMIT_MAX;
      }
    });
  });

  describe('H5: account deletion', () => {
    it('anonymizes member rows, keeps the group for others, drops solo data and kills the token', async () => {
      const uid = id('deluser');
      await db().from('profiles').insert({ id: uid, email: `${uid}@example.com`, full_name: 'Delete Me', hlc: OLD_HLC });
      const t = await tokenFor(uid);
      const g = id('grp_del');
      const direct = id('exp_solo');
      const shared = id('exp_shared');
      const res = await push(t, [
        mut('group', g, { name: 'Shared', baseCurrency: 'INR', inviteCode: id('inv_del') }),
        mut('group_member', id('m_del'), { groupId: g, userId: uid, displayName: 'Delete Me', role: 'admin', upiId: 'me@upi' }),
        mut('group_member', id('m_other'), { groupId: g, displayName: 'Arjun' }),
        mut('expense', direct, expense(direct, null, P1, [P1, P2], 100, { adHocParticipants: [{ id: P1, displayName: 'Me' }, { id: P2, displayName: 'Friend' }] })),
      ]);
      expect(res.get(direct)?.status).toBe('applied');
      await db().from('group_members').update({ user_id: ARJUN }).eq('id', id('m_other'));
      expect((await push(t, [mut('expense', shared, expense(shared, g, id('m_del'), [id('m_del'), id('m_other')], 100))])).get(shared)?.status).toBe('applied');

      const { count: authBefore } = await db().schema('auth' as 'wise_spliter').from('users').select('id', { count: 'exact', head: true });
      const del = await api('/api/account/delete', { token: t, method: 'POST' });
      expect(del.status).toBe(204);
      expect(await row('profiles', uid)).toBeNull();
      const m = await row('group_members', id('m_del'));
      expect(m).toMatchObject({ user_id: null, invited_email: null, upi_id: null, display_name: 'Deleted user' });
      expect(await row('expenses', shared)).not.toBeNull();
      expect(await row('expenses', direct)).toBeNull();
      expect((await api('/api/ledger/pull?cursor=0', { token: t })).status).toBe(401);
      const { count: authAfter } = await db().schema('auth' as 'wise_spliter').from('users').select('id', { count: 'exact', head: true });
      expect(authAfter).toBe(authBefore);
    });
  });

  describe('M1/M2: ownership is immutable and roles are enforced', () => {
    it('created_by cannot change, even for the service role', async () => {
      const { error } = await db().from('groups').update({ created_by: ROHAN }).eq('id', G);
      expect(error?.message).toMatch(/immutable/);
    });

    it('a plain member cannot delete the group, promote themself or remove others', async () => {
      const r = await push(tok[ROHAN]!, [
        mut('group', G, null, hlc(), 'delete'),
        mut('group_member', M.rohan, { groupId: G, displayName: 'Rohan', role: 'admin', invitedEmail: 'rohan.verma@example.com', memberOrder: 1 }),
        mut('group_member', M.arjun, null, hlc(), 'delete'),
      ]);
      expect([r.get(G)?.status, r.get(M.rohan)?.status, r.get(M.arjun)?.status]).toEqual(['forbidden', 'forbidden', 'forbidden']);
      expect((await row('group_members', M.rohan))?.role).toBe('member');
      expect((await row('groups', G))?.deleted_at).toBeNull();
    });
  });

  describe('M3 and coordinator follow-ups: validation at the trust boundary', () => {
    it('rejects bad currency, date, ids, fractional or unsafe money, and accepts exact BigInt strings', async () => {
      const bad: Array<[string, Json]> = [
        ['cur', { originalCurrency: 'XXX', groupCurrency: 'XXX' }],
        ['date', { expenseDate: '2026-02-30' }],
        ['frac', { amountMinor: 10.5 }],
        ['unsafe', { amountMinor: 2 ** 53 + 2 }],
      ];
      const muts = bad.map(([k, over]) => mut('expense', id(`exp_bad_${k}`), expense(id(`exp_bad_${k}`), G, M.arjun, [M.arjun], 100, over)));
      muts.push(mut('expense', '../etc/passwd', expense('../etc/passwd', G, M.arjun, [M.arjun], 100)));
      const r = await api('/api/ledger/push', { token: tok[ARJUN], body: { mutations: muts } });
      for (const x of (r.json as unknown as SyncPushResponse).results) expect(x.status).toBe('invalid');

      // Money stays exact: decimal strings within 2^53-1 are accepted, anything larger is invalid, never rounded.
      const str = id('exp_strmoney');
      const big = id('exp_bigint');
      const r2 = await push(tok[ARJUN]!, [
        mut('expense', str, expense(str, G, M.arjun, [M.arjun], 100, { amountMinor: '100', originalAmountMinor: '100' })),
        mut('expense', big, expense(big, G, M.arjun, [M.arjun], '9007199254740993', {
          splits: [{ memberId: M.arjun, included: true, owedMinor: '9007199254740993', originalOwedMinor: '9007199254740993', rawInputValue: 1, remainderMinor: 0 }],
        })),
      ]);
      expect(r2.get(str)?.status).toBe('applied');
      expect(r2.get(big)?.status).toBe('invalid');
      const { error } = await db().from('settlements').insert({ id: id('stl_big'), group_id: G, from_member_id: M.arjun, to_member_id: M.rohan, amount_minor: '9007199254740993', currency: 'INR', settled_date: '2026-11-15', owner_id: ARJUN, hlc: OLD_HLC });
      expect(error?.message).toMatch(/chk_settlements_money/);
    });

    it('payers and splits must be active members of the group, or listed participants of a direct split', async () => {
      const removed = id('m_removed');
      await push(tok[ARJUN]!, [mut('group_member', removed, { groupId: G, displayName: 'Gone' })]);
      await push(tok[ARJUN]!, [mut('group_member', removed, null, hlc(), 'delete')]);
      const cases: Array<[string, Json]> = [
        ['foreign_member', expense(id('e1'), G, 'mem_goa_arjun', [M.arjun], 100)],
        ['removed_member', expense(id('e2'), G, M.arjun, [removed], 100)],
        ['direct_outsider', expense(id('e3'), null, P1, [randomUUID()], 100, { adHocParticipants: [{ id: P1, displayName: 'A' }] })],
      ];
      const r = await push(tok[ARJUN]!, cases.map(([, e]) => mut('expense', e.id as string, e)));
      for (const [, e] of cases) expect(r.get(e.id as string)?.status).toBe('invalid');
    });

    it('receipt pointers cannot move to another expense and their sha256 is immutable', async () => {
      const e = id('exp_rcpt');
      const rc = id('rcpt');
      const sha = 'a'.repeat(64);
      await push(tok[ARJUN]!, [mut('expense', e, expense(e, G, M.arjun, [M.arjun], 100))]);
      expect((await push(tok[ARJUN]!, [mut('receipt_pointer', rc, { expenseId: e, fileName: 'r.webp', sha256: sha })])).get(rc)?.status).toBe('applied');
      const r = await push(tok[ARJUN]!, [mut('receipt_pointer', rc, { expenseId: e, fileName: 'r.webp', sha256: 'b'.repeat(64) }, hlc(1000))]);
      expect(r.get(rc)?.status).toBe('forbidden');
      const moved = await db().from('receipt_attachments').update({ expense_id: 'exp_goa_villa_01' }).eq('id', rc);
      expect(moved.error?.message).toMatch(/immutable/);
      expect((await row('receipt_attachments', rc))?.sha256_hex).toBe(sha);
      const upload = await api('/api/receipts/upload', { token: tok[PRIYA], body: { id: id('rcpt2'), expenseId: e, dataUrl: 'data:x', hlc: hlc() } });
      expect(upload.status).toBe(403);
    });
  });

  describe('M4/M6: session tokens and CORS', () => {
    it('/api/auth/session renews a valid token, keeps the original sign-in time, and a revoked token cannot renew', async () => {
      // A per-run profile: logging out bumps token_version, which would revoke a shared dev profile's
      // sessions in every other suite, the e2e run and the dev app.
      const who = id('m4_renew');
      await db().from('profiles').insert({ id: who, email: `${who}@example.com`, full_name: 'Renew', hlc: OLD_HLC });
      const s = await getProfileById(who);
      const aat = Math.floor(Date.now() / 1000) - 3600;
      const t = issueSessionToken({ userId: who, tokenVersion: s!.tokenVersion, authTime: aat });
      await new Promise((r) => setTimeout(r, 1100));
      const renewed = await api('/api/auth/session', { token: t, body: {} });
      expect(renewed.status).toBe(200);
      const fresh = renewed.json.token as string;
      expect(verifySessionToken(fresh)!.exp).toBeGreaterThan(verifySessionToken(t)!.exp);
      expect(verifySessionToken(fresh)?.aat).toBe(aat);
      expect(renewed.headers.get('set-cookie')).toContain('ws_session=');
      expect((await api('/api/ledger/pull?cursor=0&limit=1', { token: fresh })).status).toBe(200);
      expect((await api('/api/auth/session', { body: { userId: who, email: `${who}@example.com` } })).status).toBe(401);

      expect((await api('/api/auth/logout', { token: fresh, body: {} })).status).toBe(200);
      for (const old of [t, fresh]) {
        expect((await api('/api/auth/session', { token: old, body: {} })).status).toBe(401);
        expect((await api('/api/ledger/pull?cursor=0', { token: old })).status).toBe(401);
      }
    });

    it('renewal never extends past the absolute lifetime and stops once it is reached', async () => {
      const s = await getProfileById(ARJUN);
      const now = Math.floor(Date.now() / 1000);
      const prev = process.env.SESSION_MAX_LIFETIME_DAYS;
      try {
        process.env.SESSION_MAX_LIFETIME_DAYS = '1';
        const nearEnd = issueSessionToken({ userId: ARJUN, tokenVersion: s!.tokenVersion, authTime: now - 86400 + 600 });
        expect(verifySessionToken(nearEnd)!.exp).toBe(now - 86400 + 600 + 86400);
        const renewed = await api('/api/auth/session', { token: nearEnd, body: {} });
        expect(renewed.status).toBe(200);
        expect(verifySessionToken(renewed.json.token as string)!.exp).toBeLessThanOrEqual(now + 600);

        const valid = issueSessionToken({ userId: ARJUN, tokenVersion: s!.tokenVersion, authTime: now - 13 * 3600 });
        process.env.SESSION_MAX_LIFETIME_DAYS = '0.5';
        expect((await api('/api/auth/session', { token: valid, body: {} })).status).toBe(401);
        expect((await api('/api/ledger/pull?cursor=0', { token: valid })).status).toBe(401);
      } finally {
        if (prev === undefined) delete process.env.SESSION_MAX_LIFETIME_DAYS;
        else process.env.SESSION_MAX_LIFETIME_DAYS = prev;
      }
    });

    it('production CORS drops http://localhost and preflights are cacheable', () => {
      const prev = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        expect(getAllowedOrigins()).not.toContain('http://localhost');
        expect(getAllowedOrigins()).toContain('capacitor://localhost');
        expect(buildSecurityHeaders('http://localhost')['Access-Control-Allow-Origin']).toBeUndefined();
      } finally {
        process.env.NODE_ENV = prev;
      }
      expect(buildSecurityHeaders('http://localhost:4173')['Access-Control-Max-Age']).toBe('600');
    });

    it('production refuses a missing or weak GRANT_TOKEN_SECRET', () => {
      const prev = { env: process.env.NODE_ENV, secret: process.env.GRANT_TOKEN_SECRET };
      try {
        process.env.NODE_ENV = 'production';
        process.env.GRANT_TOKEN_SECRET = 'short';
        expect(() => assertProductionSecretsConfigured()).toThrow(/FATAL/);
      } finally {
        process.env.NODE_ENV = prev.env;
        process.env.GRANT_TOKEN_SECRET = prev.secret;
      }
    });
  });

  describe('Round 2 reviewer regressions', () => {
    async function mkUser(tag: string) {
      const pid = id(tag);
      const email = `${pid}@example.com`;
      await db().from('profiles').insert({ id: pid, email, full_name: tag, hlc: OLD_HLC });
      return { pid, email, tok: await tokenFor(pid) };
    }
    const part = (pid: string, name: string, email?: string) => ({ id: pid, displayName: name, invitedEmail: email ?? null });
    const settle = (sid: string, from: string, to: string, expenseId: string | null, amount = 777) => ({
      id: sid, groupId: null, expenseId, fromMemberId: from, toMemberId: to, amountMinor: amount, currency: 'INR',
      paymentMethod: 'upi', paymentReference: 'UPI-REF-SECRET', notes: 'private note', settledDate: '2026-11-15',
    });

    it('CRIT: participant ids and emails written by an attacker never widen access to a victim direct split or settlement', async () => {
      const V = await mkUser('rv_victim');
      const A = await mkUser('rv_attacker');
      const W = await mkUser('rv_third');
      const pv = randomUUID();
      const pw = randomUUID();
      const ve = id('rv_ve');
      const vs = id('rv_vs');
      const r1 = await push(V.tok, [
        mut('expense', ve, expense(ve, null, pv, [pw], 1000, { adHocParticipants: [part(pv, 'V', V.email), part(pw, 'W', W.email)] })),
        mut('settlement', vs, settle(vs, pw, pv, ve)),
      ]);
      expect([r1.get(ve)?.status, r1.get(vs)?.status]).toEqual(['applied', 'applied']);
      expect((await pullAll(W.tok)).changes.some((c) => c.id === vs)).toBe(true);

      // Attacker reuses the victim's participant id and maps it to their own email.
      const ae = id('rv_ae');
      const az = randomUUID();
      expect((await push(A.tok, [mut('expense', ae, expense(ae, null, pv, [az], 1000, { adHocParticipants: [part(pv, 'me', A.email), part(az, 'z')] }))])).get(ae)?.status).toBe('applied');
      const leaked = (await pullAll(A.tok)).changes.filter((c) => c.id === vs || c.id === ve);
      expect(leaked).toEqual([]);

      // Forging into the victim's bill: forbidden; a settlement on the attacker's own bill stays on that bill.
      const fs1 = id('rv_fs1');
      const fs2 = id('rv_fs2');
      const forged = await push(A.tok, [mut('settlement', fs1, settle(fs1, pv, pw, ve, 999999)), mut('settlement', fs2, settle(fs2, pv, az, ae, 999999))]);
      expect(forged.get(fs1)?.status).toBe('forbidden');
      expect(forged.get(fs2)?.status).toBe('applied');
      expect((await pullAll(V.tok)).changes.some((c) => c.id === fs1 || c.id === fs2)).toBe(false);
      // Unanchored direct settlements are invalid.
      const fs3 = id('rv_fs3');
      expect((await push(A.tok, [mut('settlement', fs3, settle(fs3, pv, az, null))])).get(fs3)?.status).toBe('invalid');
    });

    it('CRIT: constant or non-UUID direct-split participant ids are rejected', async () => {
      const e = id('rv_roster');
      const roster = [part('adhoc_arjun', 'Arjun', 'arjun.mehta@example.com'), part('adhoc_rohan', 'Rohan', 'rohan.verma@example.com')];
      expect((await push(tok[PRIYA]!, [mut('expense', e, expense(e, null, 'adhoc_arjun', ['adhoc_rohan'], 4242, { adHocParticipants: roster }))])).get(e)?.status).toBe('invalid');
      const arjun = await pullAll(tok[ARJUN]!);
      expect(arjun.changes.some((c) => c.id === e)).toBe(false);
    });

    it('JOIN: a newly claimed group is announced in backfillGroupIds and its older rows page in by groupId', async () => {
      const V = await mkUser('rj_v');
      const W = await mkUser('rj_w');
      const g = id('rj_g');
      const mw = id('rj_mw');
      const mx = id('rj_mx');
      const mv = id('rj_mv');
      const ge = id('rj_ge');
      await push(W.tok, [mut('group', g, { name: 'G', baseCurrency: 'INR' }), mut('group_member', mw, { groupId: g, userId: W.pid, displayName: 'W', role: 'admin' })]);
      await push(W.tok, [mut('group_member', mx, { groupId: g, displayName: 'X' }), mut('expense', ge, expense(ge, g, mw, [mx], 100))]);
      const own = id('rj_own');
      const p = randomUUID();
      await push(V.tok, [mut('expense', own, expense(own, null, p, [p], 100, { adHocParticipants: [part(p, 'V', V.email)] }))]);
      const { cursor } = await pullAll(V.tok);
      expect(cursor).not.toBe('0');
      await push(W.tok, [mut('group_member', mv, { groupId: g, displayName: 'V', invitedEmail: V.email })]);
      await db().rpc('claim_members', { p_actor: V.pid });

      const inc = await api(`/api/ledger/pull?cursor=${cursor}&limit=500`, { token: V.tok });
      const body = inc.json as unknown as SyncPullResponse;
      expect(body.backfillGroupIds).toEqual([g]);
      expect(body.changes.some((c) => c.id === ge)).toBe(false);
      const back = await api(`/api/ledger/pull?groupId=${g}&cursor=0&limit=500`, { token: V.tok });
      expect((back.json as unknown as SyncPullResponse).changes.map((c) => c.id)).toEqual(expect.arrayContaining([g, mw, mx, mv, ge]));
      expect((await api(`/api/ledger/pull?groupId=${G}&cursor=0`, { token: V.tok })).status).toBe(403);
    });

    it('DELETE: shared direct splits and their settlements survive with everyone else\'s balances unchanged; re-created profiles do not revive tokens', async () => {
      const V = await mkUser('rd_v');
      const W = await mkUser('rd_w');
      const pv = randomUUID();
      const pw = randomUUID();
      const we = id('rd_we');
      const ve = id('rd_ve');
      const vs = id('rd_vs');
      const solo = id('rd_solo');
      const ps = randomUUID();
      await push(W.tok, [mut('expense', we, expense(we, null, pw, [pv], 5000, { adHocParticipants: [part(pw, 'W', W.email), part(pv, 'V', V.email)] }))]);
      const rv = await push(V.tok, [
        mut('settlement', vs, settle(vs, pv, pw, we, 5000)),
        mut('expense', ve, expense(ve, null, pv, [pw], 300, { adHocParticipants: [part(pv, 'V', V.email), part(pw, 'W', W.email)] })),
        mut('expense', solo, expense(solo, null, ps, [ps], 50, { adHocParticipants: [part(ps, 'just me', V.email)] })),
      ]);
      expect([rv.get(vs)?.status, rv.get(ve)?.status, rv.get(solo)?.status]).toEqual(['applied', 'applied', 'applied']);

      const net = (changes: SyncPullResponse['changes']) => {
        const n = new Map<string, bigint>();
        const add = (k: string, v: bigint) => n.set(k, (n.get(k) ?? 0n) + v);
        for (const c of changes) {
          if (c.deleted || !c.data) continue;
          if (c.entity === 'expense' && (c.id === we || c.id === ve)) {
            for (const p of c.data.payers as Array<{ memberId: string; paidMinor: number }>) add(`${c.id}:${p.memberId}`, BigInt(p.paidMinor));
            for (const sp of c.data.splits as Array<{ memberId: string; owedMinor: number }>) add(`${c.id}:${sp.memberId}`, -BigInt(sp.owedMinor));
          }
          if (c.entity === 'settlement' && c.id === vs) {
            add(`${we}:${c.data.fromMemberId}`, BigInt(c.data.amountMinor as number));
            add(`${we}:${c.data.toMemberId}`, -BigInt(c.data.amountMinor as number));
          }
        }
        return Object.fromEntries([...n].map(([k, v]) => [k, v.toString()]));
      };
      const before = await pullAll(W.tok);
      const oldTok = V.tok;
      expect((await api('/api/account/delete', { token: oldTok, method: 'POST' })).status).toBe(204);
      const after = await pullAll(W.tok);
      expect(net(after.changes)).toEqual(net(before.changes));
      expect(after.changes.filter((c) => [we, ve, vs].includes(c.id)).every((c) => !c.deleted)).toBe(true);
      expect(await row('expenses', solo)).toBeNull();
      const scrubbed = (await row('expenses', ve))?.ad_hoc_participants as Array<{ id: string; invitedEmail: string | null; displayName: string }>;
      expect(scrubbed.find((x) => x.id === pv)).toMatchObject({ invitedEmail: null, displayName: 'Deleted user' });

      await db().from('profiles').insert({ id: V.pid, email: V.email, full_name: 'again', hlc: OLD_HLC });
      expect((await api('/api/ledger/pull?cursor=0&limit=1', { token: oldTok })).status).toBe(401);
    });

    it('EDIT: expenses involving since-removed members can still be edited, deleted and restored', async () => {
      const g = id('re_g');
      const mw = id('re_mw');
      const mx = id('re_mx');
      const ge = id('re_ge');
      await push(tok[ARJUN]!, [mut('group', g, { name: 'G', baseCurrency: 'INR' }), mut('group_member', mw, { groupId: g, userId: ARJUN, displayName: 'A', role: 'admin' })]);
      await push(tok[ARJUN]!, [mut('group_member', mx, { groupId: g, displayName: 'X' }), mut('expense', ge, expense(ge, g, mw, [mx], 100))]);
      await push(tok[ARJUN]!, [mut('group_member', mx, null, hlc(), 'delete')]);
      const rename = await push(tok[ARJUN]!, [mut('expense', ge, expense(ge, g, mw, [mx], 100, { title: 'renamed', currentRevisionId: `${ge}_v2`, revisionNumber: 2 }), hlc(1000))]);
      expect(rename.get(ge)?.status).toBe('applied');
      expect((await push(tok[ARJUN]!, [mut('expense', ge, null, hlc(2000), 'delete')])).get(ge)?.status).toBe('applied');
      expect((await push(tok[ARJUN]!, [mut('expense', ge, expense(ge, g, mw, [mx], 100, { currentRevisionId: `${ge}_v3`, revisionNumber: 3 }), hlc(3000))])).get(ge)?.status).toBe('applied');
      // Adding a removed member to a bill is still refused.
      const ne = id('re_ne');
      expect((await push(tok[ARJUN]!, [mut('expense', ne, expense(ne, g, mw, [mx], 100))])).get(ne)?.status).toBe('invalid');
    });

    it('CAPS: one member cannot exhaust a shared cap; revision quota is per actor and admin edits keep working', async () => {
      const g = id('rc_g');
      const mw = id('rc_mw');
      const ma = id('rc_ma');
      const ge = id('rc_ge');
      await push(tok[ARJUN]!, [mut('group', g, { name: 'G', baseCurrency: 'INR' }), mut('group_member', mw, { groupId: g, userId: ARJUN, displayName: 'A', role: 'admin' })]);
      await push(tok[ARJUN]!, [mut('group_member', ma, { groupId: g, displayName: 'R' }), mut('expense', ge, expense(ge, g, mw, [ma], 1000))]);
      await db().from('group_members').update({ user_id: ROHAN }).eq('id', ma);
      const snap = { title: 't', category: 'food', amountMinor: 1000, originalCurrency: 'INR', originalAmountMinor: 1000, fxRateScaled: 100000000, fxStatus: 'identity', splitMode: 'exact', payers: [{ memberId: mw, paidMinor: 1000 }], splits: [{ memberId: ma, included: true, owedMinor: 1000 }] };
      const statuses = new Set<string>();
      for (let b = 0; b < 2; b++) {
        const ms = Array.from({ length: 150 }, (_, i) => mut('expense_revision', id(`rc_r${b}_${i}`), { expenseId: ge, revisionNumber: 2, actorMemberId: ma, action: 'updated', changes: [], snapshot: snap }));
        for (const r of (await push(tok[ROHAN]!, ms)).values()) statuses.add(r.status);
      }
      expect(statuses).toEqual(new Set(['applied', 'invalid']));
      const { count } = await db().from('expense_revisions').select('id', { count: 'exact', head: true }).eq('expense_id', ge).eq('actor_member_id', ma);
      expect(count).toBe(200);
      for (let k = 2; k <= 3; k++) {
        const r = await push(tok[ARJUN]!, [mut('expense', ge, expense(ge, g, mw, [ma], 1000, { title: `edit${k}`, currentRevisionId: `${ge}_v${k}`, revisionNumber: k }), hlc(k * 1000))]);
        expect(r.get(ge)?.status).toBe('applied');
      }
      expect((await row('expense_revisions', `${ge}_v1`))?.action).toBe('created');
    });

    it('DOS: a heavy push does not hold the global lock while validating, so an unrelated push stays fast', async () => {
      const A = await mkUser('rs_att');
      const st = (i: number) => mut('settlement', id(`rs_s${i}`), settle(id(`rs_s${i}`), 'nobody_a', 'nobody_b', id('missing')));
      const heavy = api('/api/ledger/push', { token: A.tok, body: { mutations: Array.from({ length: 200 }, (_, i) => st(i)) } });
      await new Promise((r) => setTimeout(r, 50));
      const B = await mkUser('rs_other');
      const t0 = performance.now();
      const other = await api('/api/ledger/push', { token: B.tok, body: { mutations: [mut('group', id('rs_none'), null, hlc(), 'delete')] } });
      const elapsed = performance.now() - t0;
      expect(other.status).toBe(200);
      expect(elapsed).toBeLessThan(1000);
      expect((await heavy).status).toBe(200);
    });

    it('AUTH: a password account pre-registered on someone else\'s email cannot open a Google-linked profile', async () => {
      const anon = createClient(SUPABASE_URL, PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
      const email = `${RUN}.prereg@example.com`;
      const password = 'attacker-chosen-Pw1!';
      const { data, error } = await anon.auth.signUp({ email, password });
      expect(error).toBeNull();
      const uid = data.user!.id;
      // Stand-in for the owner later signing in with Google: /api/auth/google creates the profile.
      const ins = await db().from('profiles').insert({ id: id('rg_v'), auth_user_id: uid, email, full_name: 'Victim', google_connected: true, hlc: OLD_HLC });
      expect(ins.error).toBeNull();
      const r = await api('/api/auth/login', { body: { email, password } });
      expect(r.status).toBe(401);
      expect(r.json.token).toBeUndefined();
    });

    it('LOW: SECURITY DEFINER RPCs reject non-backend roles even if EXECUTE is granted by mistake', () => {
      const sql = `BEGIN; GRANT USAGE ON SCHEMA wise_spliter TO anon; GRANT EXECUTE ON FUNCTION wise_spliter.pull_changes(text,bigint,integer,text,text) TO anon; SET LOCAL ROLE anon; SELECT wise_spliter.pull_changes('${ARJUN}', 0, 1, NULL, NULL); ROLLBACK;`;
      const r = spawnSync('docker', ['exec', '-i', 'supabase_db_dependencies', 'psql', '-X', '-q', '-U', 'postgres', '-d', 'postgres', '-c', sql], { encoding: 'utf8' });
      expect(r.stderr).toMatch(/permission denied: backend only/);
    });

    it('LOW: login lockout is per (account, IP), so a third party cannot lock the owner out', async () => {
      const prev = { proxy: process.env.TRUST_PROXY, max: process.env.AUTH_RATE_LIMIT_MAX };
      process.env.TRUST_PROXY = 'true';
      process.env.AUTH_RATE_LIMIT_MAX = '2';
      try {
        const from = (ip: string) => ({ 'X-Forwarded-For': ip });
        for (let i = 0; i < 2; i++) await api('/api/auth/login', { body: { email: 'owner@example.com', password: 'x' }, headers: from('203.0.113.66') });
        expect((await api('/api/auth/login', { body: { email: 'owner@example.com', password: 'x' }, headers: from('203.0.113.66') })).status).toBe(429);
        expect((await api('/api/auth/login', { body: { email: 'owner@example.com', password: 'x' }, headers: from('198.51.100.5') })).status).toBe(401);
      } finally {
        process.env.TRUST_PROXY = prev.proxy;
        if (prev.max === undefined) delete process.env.AUTH_RATE_LIMIT_MAX;
        else process.env.AUTH_RATE_LIMIT_MAX = prev.max;
        if (prev.proxy === undefined) delete process.env.TRUST_PROXY;
      }
    });

    it('LOW: invite codes are generated by the server, so client values never collide', async () => {
      const g1 = id('ri_g1');
      const g2 = id('ri_g2');
      const r = await push(tok[ARJUN]!, [
        mut('group', g1, { name: 'One', baseCurrency: 'INR', inviteCode: 'SAME-CODE' }),
        mut('group', g2, { name: 'Two', baseCurrency: 'INR', inviteCode: 'SAME-CODE' }),
      ]);
      expect([r.get(g1)?.status, r.get(g2)?.status]).toEqual(['applied', 'applied']);
      const codes = [(await row('groups', g1))?.invite_code, (await row('groups', g2))?.invite_code];
      expect(codes[0]).not.toBe(codes[1]);
      expect(codes.every((c) => typeof c === 'string' && c.startsWith('WS-'))).toBe(true);
    });

    it('LOW: RLS is deny-all (no policies left that could drift from the RPC rules)', async () => {
      const { data } = await db().rpc('schema_health');
      expect((data as { policies: number }).policies).toBe(0);
    });
  });

  describe('Round 3 reviewer regressions', () => {
    async function mkUser(tag: string) {
      const pid = id(tag);
      const email = `${pid}@example.com`;
      await db().from('profiles').insert({ id: pid, email, full_name: tag, hlc: OLD_HLC });
      return { pid, email, tok: await tokenFor(pid) };
    }
    const part = (pid: string, name: string, email?: string) => ({ id: pid, displayName: name, invitedEmail: email ?? null });
    const settle = (sid: string, from: string, to: string, expenseId: string | null, amount = 777) => ({
      id: sid, groupId: null, expenseId, fromMemberId: from, toMemberId: to, amountMinor: amount, currency: 'INR',
      paymentMethod: 'upi', paymentReference: null, notes: '', settledDate: '2026-11-15',
    });
    const health = async () => (await db().rpc('schema_health')).data as Record<string, unknown>;

    it('LOCK: checks fire before the seq/lock trigger, and a heavy writer does not stall others', async () => {
      expect((await health()).seq_triggers_last).toBe(true);
      const A = await mkUser('r3_dos');
      const B = await mkUser('r3_other');
      const g = id('r3_dg');
      const m = id('r3_dm');
      await push(A.tok, [mut('group', g, { name: 'G', baseCurrency: 'INR' }), mut('group_member', m, { groupId: g, userId: A.pid, displayName: 'A', role: 'admin' })]);
      const act = (i: number) => mut('group_activity', id(`r3_a${i}`), { groupId: g, actorMemberId: m, entityType: 'group', entityId: g, action: 'x', summaryText: 'x' });
      const heavy = api('/api/ledger/push', { token: A.tok, body: { mutations: Array.from({ length: 200 }, (_, i) => act(i)) } });
      await new Promise((r) => setTimeout(r, 30));
      const second = api('/api/ledger/push', { token: A.tok, body: { mutations: [act(999)] } });
      const t0 = performance.now();
      const other = await api('/api/ledger/push', { token: B.tok, body: { mutations: [mut('group', id('r3_none'), null, hlc(), 'delete')] } });
      expect(other.status).toBe(200);
      expect(performance.now() - t0).toBeLessThan(1000);
      const [s2, h] = [await second, await heavy];
      expect(h.status).toBe(200);
      // Same-account pushes never interleave: refused (429) while the heavy one runs, or, if the heavy
      // one already committed (a fast DB), applied strictly after it. BUSY covers the 429 path deterministically.
      expect([200, 429]).toContain(s2.status);
      if (s2.status === 200) {
        const { data } = await db().from('group_activity_log').select('id, server_seq').in('id', [id('r3_a199'), id('r3_a999')]);
        const seq = Object.fromEntries((data ?? []).map((x) => [x.id, BigInt(x.server_seq)]));
        expect(seq[id('r3_a999')]!).toBeGreaterThan(seq[id('r3_a199')]!);
      }
    });

    it('CLAIM: binding is one bounded UPDATE on participant rows, skips deleted bills and never rewrites bills', async () => {
      const owner = await mkUser('r3_co');
      const victimEmail = `${RUN}.claim@example.com`;
      const pa = randomUUID();
      const pv = randomUUID();
      const bill = (i: number, deleted: boolean) => ({
        id: id(`r3_cb${i}`), group_id: null, owner_id: owner.pid, title: 't', category: 'food', expense_date: '2026-11-15',
        original_currency: 'INR', original_amount_minor: 100, group_currency: 'INR', amount_minor: 100, split_mode: 'exact',
        ad_hoc_participants: [part(pa, 'A'), part(pv, 'V', victimEmail)], payers: [{ memberId: pa, paidMinor: 100 }],
        splits: [{ memberId: pv, included: true, owedMinor: 100 }], current_revision_id: `r3_cb${i}_v1`,
        created_by_member_id: pa, updated_by_member_id: pa, deleted_at: deleted ? '2026-11-15T00:00:00Z' : null, hlc: OLD_HLC,
      });
      expect((await db().from('expenses').insert([bill(0, false), bill(1, true)])).error).toBeNull();
      const before = await row('expenses', id('r3_cb0'));
      const v = await mkUser('r3_cv');
      await db().from('profiles').update({ email: victimEmail }).eq('id', v.pid);
      expect((await db().rpc('claim_members', { p_actor: v.pid })).error).toBeNull();
      const { data: binds } = await db().from('expense_participants').select('expense_id, profile_id').in('expense_id', [id('r3_cb0'), id('r3_cb1')]).eq('participant_id', pv);
      expect(Object.fromEntries((binds ?? []).map((b) => [b.expense_id, b.profile_id]))).toEqual({ [id('r3_cb0')]: v.pid, [id('r3_cb1')]: null });
      expect((await row('expenses', id('r3_cb0')))?.server_seq).toBe(before?.server_seq);
    }, 20_000);

    it('CLAIM: an email can be named on at most 2000 unclaimed bills', async () => {
      const owner = await mkUser('r3_cap');
      const email = `${RUN}.spam@example.com`;
      const pa = randomUUID();
      const pv = randomUUID();
      const rows = Array.from({ length: 2000 }, (_, i) => ({
        id: id(`r3_sp${i}`), group_id: null, owner_id: owner.pid, title: 't', category: 'food', expense_date: '2026-11-15',
        original_currency: 'INR', original_amount_minor: 1, group_currency: 'INR', amount_minor: 1, split_mode: 'exact',
        ad_hoc_participants: [part(pa, 'A'), part(pv, 'V', email)], payers: [{ memberId: pa, paidMinor: 1 }],
        splits: [{ memberId: pv, included: true, owedMinor: 1 }], current_revision_id: `r3_sp${i}_v1`,
        created_by_member_id: pa, updated_by_member_id: pa, hlc: OLD_HLC,
      }));
      for (let i = 0; i < rows.length; i += 500) expect((await db().from('expenses').insert(rows.slice(i, i + 500))).error).toBeNull();
      const e = id('r3_sp_over');
      const r = await push(owner.tok, [mut('expense', e, expense(e, null, pa, [pv], 1, { adHocParticipants: [part(pa, 'A'), part(pv, 'V', email)] }))]);
      expect(r.get(e)).toMatchObject({ status: 'invalid' });
      expect(r.get(e)?.reason).toMatch(/unclaimed bills/);
    }, 30_000);

    it('SETTLE: only a bound party records; parties or the bill owner delete; no anchoring to deleted bills; pull hides settlements whose party left', async () => {
      const V = await mkUser('r3_sv');
      const W = await mkUser('r3_sw');
      const A = await mkUser('r3_sa');
      const pv = randomUUID();
      const pw = randomUUID();
      const pa = randomUUID();
      const ve = id('r3_sve');
      const parts = [part(pv, 'V', V.email), part(pw, 'W', W.email), part(pa, 'A', A.email)];
      await push(V.tok, [mut('expense', ve, expense(ve, null, pv, [pw], 5000, { adHocParticipants: parts }))]);
      const s1 = id('r3_s1');
      const s2 = id('r3_s2');
      const s3 = id('r3_s3');
      expect((await push(A.tok, [mut('settlement', s1, settle(s1, pw, pv, ve))])).get(s1)?.status).toBe('forbidden');
      expect((await push(W.tok, [mut('settlement', s1, settle(s1, pw, pv, ve)), mut('settlement', s2, settle(s2, pw, pv, ve))])).get(s1)?.status).toBe('applied');
      expect((await push(A.tok, [mut('settlement', s3, settle(s3, pa, pv, ve))])).get(s3)?.status).toBe('applied');
      // V is a party of s1 and owns the bill: may delete. A is not a party of s2: may not.
      expect((await push(V.tok, [mut('settlement', s1, null, hlc(), 'delete')])).get(s1)?.status).toBe('applied');
      expect((await push(A.tok, [mut('settlement', s2, null, hlc(), 'delete')])).get(s2)?.status).toBe('forbidden');
      // Owner removes A from the bill: A's settlement becomes a tombstone that reaches devices that
      // already hold it (incremental pull), and re-adding A does not revive it.
      const { cursor } = await pullAll(W.tok);
      await push(V.tok, [mut('expense', ve, expense(ve, null, pv, [pw], 5000, { adHocParticipants: parts.slice(0, 2), currentRevisionId: `${ve}_v2`, revisionNumber: 2 }), hlc(1000))]);
      expect((await pullAll(W.tok, cursor)).changes.find((c) => c.id === s3)?.deleted).toBe(true);
      await push(V.tok, [mut('expense', ve, expense(ve, null, pv, [pw], 5000, { adHocParticipants: parts, currentRevisionId: `${ve}_v3`, revisionNumber: 3 }), hlc(1500))]);
      expect((await row('settlements', s3))?.deleted_at).not.toBeNull();
      await push(V.tok, [mut('expense', ve, null, hlc(2000), 'delete')]);
      const s4 = id('r3_s4');
      expect((await push(W.tok, [mut('settlement', s4, settle(s4, pw, pv, ve))])).get(s4)).toMatchObject({ status: 'invalid' });
    });

    it('DIRECT JOIN: a bill someone is added to later is announced in backfillExpenseIds and its children page in by expenseId', async () => {
      const V = await mkUser('r3_jv');
      const W = await mkUser('r3_jw');
      const pw = randomUUID();
      const pq = randomUUID();
      const pv = randomUUID();
      const we = id('r3_jwe');
      const ws = id('r3_jws');
      await push(W.tok, [mut('expense', we, expense(we, null, pw, [pq], 1000, { adHocParticipants: [part(pw, 'W', W.email), part(pq, 'Q')] }))]);
      expect((await push(W.tok, [mut('settlement', ws, settle(ws, pw, pq, we))])).get(ws)?.status).toBe('applied');
      const own = id('r3_jown');
      const p1 = randomUUID();
      await push(V.tok, [mut('expense', own, expense(own, null, p1, [p1], 1, { adHocParticipants: [part(p1, 'V', V.email)] }))]);
      const { cursor } = await pullAll(V.tok);
      expect((await api(`/api/ledger/pull?expenseId=${we}&cursor=0`, { token: V.tok })).status).toBe(403);
      await push(W.tok, [mut('expense', we, expense(we, null, pw, [pq], 1000, { adHocParticipants: [part(pw, 'W', W.email), part(pq, 'Q'), part(pv, 'V', V.email)], currentRevisionId: `${we}_v2`, revisionNumber: 2 }), hlc(1000))]);
      const inc = (await api(`/api/ledger/pull?cursor=${cursor}&limit=500`, { token: V.tok })).json as unknown as SyncPullResponse;
      expect(inc.backfillExpenseIds).toEqual([we]);
      expect(inc.changes.some((c) => c.id === ws)).toBe(false);
      const back = (await api(`/api/ledger/pull?expenseId=${we}&cursor=0&limit=500`, { token: V.tok })).json as unknown as SyncPullResponse;
      expect(back.changes.map((c) => c.id)).toEqual(expect.arrayContaining([we, ws]));
      const again = (await api(`/api/ledger/pull?cursor=${inc.nextCursor}&limit=500`, { token: V.tok })).json as unknown as SyncPullResponse;
      expect(again.backfillExpenseIds).toEqual([]);
    });

    it('CAPS: direct-bill revision quota uses the server-derived actor, and soft-deleted rows still count', async () => {
      const A = await mkUser('r3_qa');
      const pa = randomUUID();
      const pb = randomUUID();
      const de = id('r3_qde');
      await push(A.tok, [mut('expense', de, expense(de, null, pa, [pb], 1000, { adHocParticipants: [part(pa, 'A', A.email), part(pb, 'B')] }))]);
      const snap = { title: 't', category: 'food', amountMinor: 1000, originalCurrency: 'INR', originalAmountMinor: 1000, fxRateScaled: 100000000, fxStatus: 'identity', splitMode: 'exact', payers: [{ memberId: pa, paidMinor: 1000 }], splits: [{ memberId: pb, included: true, owedMinor: 1000 }] };
      let applied = 0;
      for (let b = 0; b < 2; b++) {
        const r = await push(A.tok, Array.from({ length: 150 }, (_, i) => mut('expense_revision', id(`r3_qr${b}_${i}`), { expenseId: de, revisionNumber: 2, actorMemberId: `spoof${b}_${i}`, action: 'updated', changes: [], snapshot: snap })));
        applied += [...r.values()].filter((x) => x.status === 'applied').length;
      }
      expect(applied).toBe(200);
      const gs = Array.from({ length: 500 }, (_, i) => id(`r3_qg${i}`));
      for (let i = 0; i < gs.length; i += 200) await push(A.tok, gs.slice(i, i + 200).map((g) => mut('group', g, { name: 'G', baseCurrency: 'INR' })));
      await db().from('groups').update({ deleted_at: new Date().toISOString() }).in('id', gs.slice(0, 200));
      const extra = id('r3_qgx');
      expect((await push(A.tok, [mut('group', extra, { name: 'G', baseCurrency: 'INR' })])).get(extra)?.status).toBe('invalid');
    });

    it('AUTH: a password-derived Supabase token is refused by the Google route even when the account lists Google', async () => {
      const anon = createClient(SUPABASE_URL, PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
      const email = `${RUN}.amr@example.com`;
      const password = 'Attacker-Pw-123!';
      const { data } = await anon.auth.signUp({ email, password });
      await db().auth.admin.updateUserById(data.user!.id, { app_metadata: { provider: 'email', providers: ['email', 'google'] } });
      const { data: s } = await anon.auth.signInWithPassword({ email, password });
      const amr = JSON.parse(Buffer.from(s.session!.access_token.split('.')[1]!, 'base64url').toString()) as { amr: Array<{ method: string }> };
      expect(amr.amr.map((m) => m.method)).toEqual(['password']);
      expect((await api('/api/auth/google', { body: { accessToken: s.session!.access_token } })).status).toBe(401);
    });

    it('AUTH: with auto-confirm on, production fails closed on the password and Google routes', async () => {
      const prev = { env: process.env.NODE_ENV, secret: process.env.GRANT_TOKEN_SECRET };
      process.env.NODE_ENV = 'production';
      process.env.GRANT_TOKEN_SECRET = 'prod_unique_hmac_secret_0123456789abcdef0123456789';
      resetEmailConfirmationCacheForTests();
      try {
        expect((await api('/api/auth/login', { body: { email: ROHAN_EMAIL, password: DEV_DEFAULT_PASSWORD } })).status).toBe(503);
        expect((await api('/api/auth/google', { body: { accessToken: 'x.y.z' } })).status).toBe(503);
      } finally {
        process.env.NODE_ENV = prev.env;
        process.env.GRANT_TOKEN_SECRET = prev.secret;
        resetEmailConfirmationCacheForTests();
      }
    });

    it('AUTH: successful sign-ins do not use up the per-IP login budget', async () => {
      process.env.AUTH_RATE_LIMIT_MAX = '2';
      try {
        for (let i = 0; i < 6; i++) {
          expect((await api('/api/auth/login', { body: { email: ROHAN_EMAIL, password: DEV_DEFAULT_PASSWORD } })).status).toBe(200);
        }
      } finally {
        delete process.env.AUTH_RATE_LIMIT_MAX;
      }
      tok[ROHAN] = await tokenFor(ROHAN);
    }, 20_000);

    it('AUTH: concurrent wrong passwords cannot all reach GoTrue past the limit', async () => {
      process.env.AUTH_RATE_LIMIT_MAX = '3';
      try {
        const codes = await Promise.all(Array.from({ length: 12 }, () => api('/api/auth/login', { body: { email: 'burst@example.com', password: `wrong-${Math.random()}` } }).then((r) => r.status)));
        expect(codes.filter((c) => c === 401)).toHaveLength(3);
        expect(codes.filter((c) => c === 429)).toHaveLength(9);
      } finally {
        delete process.env.AUTH_RATE_LIMIT_MAX;
      }
    });

    it('DELETE: a re-created profile has no owner rights over kept bills; parties can still delete the deleted user\'s settlements', async () => {
      const V = await mkUser('r3_dv');
      const W = await mkUser('r3_dw');
      const pv = randomUUID();
      const pw = randomUUID();
      const ve = id('r3_dve');
      const vs = id('r3_dvs');
      await push(V.tok, [mut('expense', ve, expense(ve, null, pv, [pw], 300, { adHocParticipants: [part(pv, 'V', V.email), part(pw, 'W', W.email)] }))]);
      await push(V.tok, [mut('settlement', vs, settle(vs, pw, pv, ve, 300))]);
      expect((await api('/api/account/delete', { token: V.tok, method: 'POST' })).status).toBe(204);
      expect(String((await row('expenses', ve))?.owner_id)).toMatch(/^deleted_/);
      await db().from('profiles').insert({ id: V.pid, email: V.email, full_name: 'again', hlc: OLD_HLC });
      const again = await tokenFor(V.pid);
      expect((await pullAll(again)).changes.some((c) => c.id === ve)).toBe(false);
      expect((await push(again, [mut('expense', ve, null, hlc(5000), 'delete')])).get(ve)?.status).toBe('forbidden');
      expect((await push(W.tok, [mut('settlement', vs, null, hlc(6000), 'delete')])).get(vs)?.status).toBe('applied');
    });

    it('TOKENS: aud is bound to the environment; existing profiles left the predictable token_version 0', async () => {
      const t = await tokenFor(ARJUN);
      expect(verifySessionToken(t)?.aud).toBe('wise-spliter:test');
      const prev = process.env.SESSION_AUDIENCE;
      process.env.SESSION_AUDIENCE = 'production';
      try {
        expect(verifySessionToken(t)).toBeNull();
      } finally {
        if (prev === undefined) delete process.env.SESSION_AUDIENCE;
        else process.env.SESSION_AUDIENCE = prev;
      }
      expect((await getProfileById(ARJUN))!.tokenVersion).toBeGreaterThanOrEqual(1000);
    });

    it('LOGOUT: a failed revocation is a 503, never a 200', async () => {
      const client = getSupabaseAdmin();
      const original = client.from.bind(client);
      (client as unknown as { from: unknown }).from = () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'down', code: '08006' } }) }) }) });
      try {
        expect((await api('/api/auth/logout', { token: tok[ARJUN], body: {} })).status).toBe(503);
      } finally {
        (client as unknown as { from: unknown }).from = original;
      }
    });

    it('HARDENING: IPv6 /64 buckets, numeric env validation, __Host- session cookie', async () => {
      expect(ipBucket('2001:db8:abcd:12:1::5')).toBe(ipBucket('2001:db8:abcd:12:ffff::9'));
      expect(ipBucket('2001:db8:abcd:13::1')).not.toBe(ipBucket('2001:db8:abcd:12::1'));
      expect(ipBucket('::ffff:10.1.2.3')).toBe('10.1.2.3');
      process.env.API_RATE_LIMIT = 'abc';
      try {
        expect(() => assertNumericEnv()).toThrow(/API_RATE_LIMIT/);
      } finally {
        process.env.API_RATE_LIMIT = '100000';
      }
      const demo = await api('/api/auth/demo', { body: {} });
      const cookie = demo.headers.get('set-cookie') ?? '';
      expect(cookie).toMatch(/^__Host-ws_session=/);
      expect(cookie).toContain('Path=/;');
      expect(cookie).toContain('Secure');
      const viaCookie = await api('/api/ledger/pull?cursor=0&limit=1', { headers: { Cookie: cookie.split(';')[0]! } });
      expect(viaCookie.status).toBe(200);
    });

    it('MIGRATIONS: one transaction, adoption instead of replay, and the same lockdown in --print-sql', () => {
      const script = spawnSync('node', ['scripts/apply-migration.mjs', '--print-script'], { encoding: 'utf8' }).stdout;
      expect(script.match(/^BEGIN;$/gm)).toHaveLength(1);
      expect(script.match(/^COMMIT;$/gm)).toHaveLength(1);
      expect(script).toContain('adopting 0001_wise_spliter_schema');
      expect(script.trimEnd().split('\n').slice(-4).join('\n')).toContain('ALTER DEFAULT PRIVILEGES IN SCHEMA wise_spliter REVOKE ALL ON FUNCTIONS');
      const sql = spawnSync('node', ['scripts/apply-migration.mjs', '--print-sql'], { encoding: 'utf8' }).stdout;
      expect(sql.match(/REVOKE ALL ON ALL FUNCTIONS IN SCHEMA wise_spliter FROM PUBLIC, anon, authenticated;/g)!.length).toBeGreaterThanOrEqual(5);
      expect(sql).toContain('ALTER DEFAULT PRIVILEGES IN SCHEMA wise_spliter REVOKE ALL ON TABLES');
    });
  });

  describe('Round 3 sync-review regressions', () => {
    async function mkUser(tag: string) {
      const pid = id(tag);
      await db().from('profiles').insert({ id: pid, email: `${pid}@example.com`, full_name: tag, hlc: OLD_HLC });
      return { pid, tok: await tokenFor(pid) };
    }
    async function mkGroup(owner: { pid: string; tok: string }, tag: string) {
      const g = id(`${tag}_g`);
      const m = id(`${tag}_m`);
      await push(owner.tok, [mut('group', g, { name: 'G', baseCurrency: 'INR' }), mut('group_member', m, { groupId: g, userId: owner.pid, displayName: 'O', role: 'admin' })]);
      return { g, m };
    }

    it('DEADLOCK: concurrent opposite-order pushes from two users never deadlock (lock taken first)', async () => {
      const A = await mkUser('s3_da');
      const B = await mkUser('s3_db');
      const { g, m } = await mkGroup(A, 's3_d');
      const mb = id('s3_d_mb');
      await push(A.tok, [mut('group_member', mb, { groupId: g, displayName: 'B' })]);
      await db().from('group_members').update({ user_id: B.pid }).eq('id', mb);
      const e1 = id('s3_e1');
      const e2 = id('s3_e2');
      await push(A.tok, [mut('expense', e1, expense(e1, g, m, [m, mb], 200)), mut('expense', e2, expense(e2, g, m, [m, mb], 200))]);
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) {
        const [r1, r2] = await Promise.all([
          api('/api/ledger/push', { token: A.tok, body: { mutations: [mut('expense', e1, expense(e1, g, m, [m, mb], 200, { title: `a${i}` }), hlc(i * 10)), mut('expense', e2, expense(e2, g, m, [m, mb], 200, { title: `a${i}` }), hlc(i * 10))] } }),
          api('/api/ledger/push', { token: B.tok, body: { mutations: [mut('expense', e2, expense(e2, g, m, [m, mb], 200, { title: `b${i}` }), hlc(i * 10 + 1)), mut('expense', e1, expense(e1, g, m, [m, mb], 200, { title: `b${i}` }), hlc(i * 10 + 1))] } }),
        ]);
        statuses.push(r1.status, r2.status);
      }
      expect(statuses.every((x) => x === 200)).toBe(true);
    });

    it('GROUP LWW: upserts never resurrect a deleted group; restore is an explicit admin op; stale returns serverHlc', async () => {
      const A = await mkUser('s3_ga');
      const B = await mkUser('s3_gb');
      const { g } = await mkGroup(A, 's3_l');
      const mb = id('s3_l_mb');
      await push(A.tok, [mut('group_member', mb, { groupId: g, displayName: 'B' })]);
      await db().from('group_members').update({ user_id: B.pid }).eq('id', mb);
      expect((await push(A.tok, [mut('group', g, null, hlc(1000), 'delete')])).get(g)?.status).toBe('applied');
      const stale = (await push(B.tok, [mut('group', g, { name: 'stale device', baseCurrency: 'INR' }, hlc(5000))])).get(g);
      expect(stale?.status).toBe('stale');
      expect(stale?.serverHlc).toBe((await row('groups', g))?.hlc);
      expect((await row('groups', g))?.deleted_at).not.toBeNull();
      expect((await push(B.tok, [mut('group', g, { name: 'G', baseCurrency: 'INR' }, hlc(6000), 'restore')])).get(g)?.status).toBe('forbidden');
      expect((await push(A.tok, [mut('group', g, { name: 'G', baseCurrency: 'INR' }, hlc(7000), 'restore')])).get(g)?.status).toBe('applied');
      expect((await row('groups', g))?.deleted_at).toBeNull();
      const e = id('s3_lx');
      expect((await push(A.tok, [mut('expense', e, null, hlc(), 'restore')])).get(e)?.status).toBe('invalid');
    });

    it('HLC: future skew is limited to 60 s', async () => {
      const A = await mkUser('s3_ha');
      const { g, m } = await mkGroup(A, 's3_h');
      const ok = id('s3_hok');
      const far = id('s3_hfar');
      const r = await push(A.tok, [
        mut('expense', ok, expense(ok, g, m, [m], 100), hlc(30_000)),
        mut('expense', far, expense(far, g, m, [m], 100), hlc(120_000)),
      ]);
      expect([r.get(ok)?.status, r.get(far)?.status]).toEqual(['applied', 'invalid']);
    });

    it('QUOTAS: receipt pointers are per (bill, actor); only active members count; hard deletes drop their counters', async () => {
      const A = await mkUser('s3_qa');
      const B = await mkUser('s3_qb');
      const { g, m } = await mkGroup(A, 's3_q');
      const mb = id('s3_q_mb');
      await push(A.tok, [mut('group_member', mb, { groupId: g, displayName: 'B' })]);
      await db().from('group_members').update({ user_id: B.pid }).eq('id', mb);
      const e = id('s3_qe');
      await push(A.tok, [mut('expense', e, expense(e, g, m, [m, mb], 200))]);
      const rp = (who: string, i: number) => mut('receipt_pointer', id(`s3_rp_${who}${i}`), { expenseId: e, fileName: 'r.webp', mimeType: 'image/webp', sizeKb: 1 });
      const ra = await push(A.tok, Array.from({ length: 51 }, (_, i) => rp('a', i)));
      expect([...ra.values()].filter((x) => x.status === 'applied')).toHaveLength(50);
      expect((await push(B.tok, [rp('b', 0)])).get(id('s3_rp_b0'))?.status).toBe('applied');
      // Active-member cap: removed members do not count.
      const ms = Array.from({ length: 98 }, (_, i) => mut('group_member', id(`s3_qm${i}`), { groupId: g, displayName: `M${i}` }));
      for (let i = 0; i < ms.length; i += 50) await push(A.tok, ms.slice(i, i + 50));
      const over = id('s3_qm_over');
      expect((await push(A.tok, [mut('group_member', over, { groupId: g, displayName: 'over' })])).get(over)?.status).toBe('invalid');
      await push(A.tok, [mut('group_member', id('s3_qm0'), null, hlc(), 'delete')]);
      expect((await push(A.tok, [mut('group_member', over, { groupId: g, displayName: 'over' }, hlc(1000))])).get(over)?.status).toBe('applied');
      await db().from('groups').delete().eq('id', g);
      const { count } = await db().from('quota_usage').select('kind', { count: 'exact', head: true }).in('scope_id', [g, e]);
      expect(count).toBe(0);
    });

    it('BUSY: one push per account is enforced in the database (works across API replicas)', async () => {
      const A = await mkUser('s3_ba');
      const hold = spawn('docker', ['exec', '-i', 'supabase_db_dependencies', 'psql', '-X', '-q', '-U', 'postgres', '-d', 'postgres', '-c',
        `BEGIN; SELECT pg_advisory_xact_lock(7735, hashtext('ws_push:${A.pid}')); SELECT pg_sleep(1.5); COMMIT;`]);
      await new Promise((r) => setTimeout(r, 500));
      const e = id('s3_be');
      const p = randomUUID();
      const busy = await api('/api/ledger/push', { token: A.tok, body: { mutations: [mut('expense', e, expense(e, null, p, [p], 1, { adHocParticipants: [{ id: p, displayName: 'A' }] }))] } });
      expect(busy.status).toBe(429);
      const other = await api('/api/ledger/push', { token: tok[ROHAN], body: { mutations: [mut('group', id('s3_bnone'), null, hlc(), 'delete')] } });
      expect(other.status).toBe(200);
      await new Promise((r) => hold.on('close', r));
      expect((await api('/api/ledger/push', { token: A.tok, body: { mutations: [mut('expense', e, expense(e, null, p, [p], 1, { adHocParticipants: [{ id: p, displayName: 'A' }] }))] } })).status).toBe(200);
    });

    it('GROUP PATCH: only present fields change; base currency is admin-only, simplify-debts is not', async () => {
      const A = await mkUser('s3_pa');
      const B = await mkUser('s3_pb');
      const { g } = await mkGroup(A, 's3_p');
      const mb = id('s3_p_mb');
      await push(A.tok, [mut('group', g, { baseCurrency: 'EUR' }, hlc(1000))]);
      await push(A.tok, [mut('group_member', mb, { groupId: g, displayName: 'B' })]);
      await db().from('group_members').update({ user_id: B.pid }).eq('id', mb);
      // B edits only the name from a copy that still says INR: the currency is untouched.
      expect((await push(B.tok, [mut('group', g, { name: 'Renamed' }, hlc(2000))])).get(g)?.status).toBe('applied');
      expect(await row('groups', g)).toMatchObject({ name: 'Renamed', base_currency: 'EUR' });
      expect((await push(B.tok, [mut('group', g, { name: 'Renamed', baseCurrency: 'INR' }, hlc(3000))])).get(g)?.status).toBe('forbidden');
      expect((await push(B.tok, [mut('group', g, { simplifyDebts: false }, hlc(4000))])).get(g)?.status).toBe('applied');
      expect(await row('groups', g)).toMatchObject({ base_currency: 'EUR', simplify_debts: false, name: 'Renamed' });
      expect((await push(A.tok, [mut('group', g, { baseCurrency: 'INR' }, hlc(5000))])).get(g)?.status).toBe('applied');
      expect((await row('groups', g))?.base_currency).toBe('INR');
    });

    it('INVITE: codes come from gen_random_bytes', async () => {
      const A = await mkUser('s3_ia');
      const { g } = await mkGroup(A, 's3_i');
      expect(String((await row('groups', g))?.invite_code)).toMatch(/^WS-[0-9A-F]{10}$/);
    });
  });

  describe('Phase 1 readiness: server support (P1-1, P1-3, P1-4, P1-5, P1-13)', () => {
    async function mkUser(tag: string) {
      const pid = id(tag);
      await db().from('profiles').insert({ id: pid, email: `${pid}@example.com`, full_name: `Name ${tag}`, hlc: OLD_HLC });
      return { pid, tok: await tokenFor(pid) };
    }
    /** Group owned by A (admin) with B as a claimed member. */
    async function mkPair(tag: string) {
      const A = await mkUser(`${tag}a`);
      const B = await mkUser(`${tag}b`);
      const g = id(`${tag}_g`);
      const ma = id(`${tag}_ma`);
      const mb = id(`${tag}_mb`);
      await push(A.tok, [mut('group', g, { name: 'G', baseCurrency: 'INR' }), mut('group_member', ma, { groupId: g, userId: A.pid, displayName: 'A', role: 'admin' })]);
      await push(A.tok, [mut('group_member', mb, { groupId: g, displayName: 'B' })]);
      await db().from('group_members').update({ user_id: B.pid }).eq('id', mb);
      return { A, B, g, ma, mb };
    }
    const join = (token: string, code: unknown) => api('/api/groups/join', { token, body: { code } });

    it('CURRENCY: group bills and settlements must be in the base currency; foreign bills carry their FX', async () => {
      const { A, B, g, ma, mb } = await mkPair('p11');
      const old = id('p11_old');
      expect((await push(B.tok, [mut('expense', old, expense(old, g, mb, [ma, mb], 1000))])).get(old)?.status).toBe('applied');
      expect((await push(A.tok, [mut('group', g, { baseCurrency: 'USD' })])).get(g)?.status).toBe('applied');
      // B was offline: a new INR bill and an edit of the old one are refused with a machine-readable code.
      const fresh = id('p11_new');
      const r = await push(B.tok, [
        mut('expense', fresh, expense(fresh, g, mb, [ma, mb], 1000)),
        { ...mut('expense', old, expense(old, g, mb, [ma, mb], 1000, { title: 'offline edit' })), baseHlc: String((await row('expenses', old))?.hlc) },
      ]);
      for (const k of [fresh, old]) expect(r.get(k)).toMatchObject({ status: 'invalid', code: 'currency_mismatch', baseCurrency: 'USD' });
      expect((await row('expenses', old))?.title).not.toBe('offline edit');
      // Re-converted: USD amounts, the original INR amount and the rate kept.
      const fx = expense(fresh, g, mb, [ma, mb], 12, { originalCurrency: 'INR', originalAmountMinor: 1000, groupCurrency: 'USD', fxRateScaled: 1200000, fxStatus: 'manual' });
      expect((await push(B.tok, [mut('expense', fresh, fx)])).get(fresh)?.status).toBe('applied');
      expect(await row('expenses', fresh)).toMatchObject({ group_currency: 'USD', amount_minor: 12, original_currency: 'INR', original_amount_minor: 1000 });
      const st = (s: string, cur: string) => mut('settlement', id(s), { groupId: g, fromMemberId: mb, toMemberId: ma, amountMinor: 5, currency: cur, settledDate: '2026-11-15' });
      const rs = await push(B.tok, [st('p11_s_inr', 'INR'), st('p11_s_usd', 'USD')]);
      expect(rs.get(id('p11_s_inr'))).toMatchObject({ status: 'invalid', code: 'currency_mismatch' });
      expect(rs.get(id('p11_s_usd'))?.status).toBe('applied');
      // Deleting a stale-currency bill stays possible.
      expect((await push(B.tok, [mut('expense', old, null, hlc(), 'delete')])).get(old)?.status).toBe('applied');
    });

    it('CONFLICT: concurrent edits from one base are flagged for every device, whatever the arrival order', async () => {
      const { A, B, g, ma, mb } = await mkPair('p13');
      for (const [tag, olderFirst] of [['x', true], ['y', false]] as const) {
        const e = id(`p13_${tag}`);
        await push(A.tok, [mut('expense', e, expense(e, g, ma, [ma, mb], 1000))]);
        const base = String((await row('expenses', e))?.hlc);
        const hA = hlc(1000);
        const hB = hlc(2000);
        const mA = { ...mut('expense', e, expense(e, g, ma, [ma, mb], 1000, { title: 'A edit', currentRevisionId: `${e}_a` }), hA), baseHlc: base };
        const mB = { ...mut('expense', e, expense(e, g, ma, [ma, mb], 1000, { title: 'B edit', currentRevisionId: `${e}_b` }), hB), baseHlc: base };
        const [first, second, firstTok, secondTok] = olderFirst ? [mA, mB, A.tok, B.tok] : [mB, mA, B.tok, A.tok];
        expect((await push(firstTok, [first])).get(e)?.status).toBe('applied');
        const c = (await push(secondTok, [second])).get(e)!;
        expect(c.status).toBe('conflict');
        // The marker gets a server hlc after both edits, so anything based on an older hlc conflicts too.
        expect(c.serverHlc! > first.hlc && c.serverHlc! > second.hlc).toBe(true);
        expect(c.server?.hlc).toBe(c.serverHlc);
        expect(c.server?.data).toMatchObject({ id: e, title: (first.data as Json).title, hasUnresolvedConflict: true, conflictRevisionId: c.conflictRevisionId });
        const stored = await row('expenses', e);
        expect(stored).toMatchObject({ title: (first.data as Json).title, hlc: c.serverHlc, has_unresolved_conflict: true, conflict_revision_id: c.conflictRevisionId });
        expect(await row('expense_revisions', c.conflictRevisionId!)).toMatchObject({ expense_id: e, is_conflict_branch: true, hlc: second.hlc });
        // Retrying the same push is idempotent.
        expect((await push(secondTok, [second])).get(e)).toMatchObject({ status: 'conflict', conflictRevisionId: c.conflictRevisionId });
        // Both devices pull the marker and the losing version.
        for (const t of [A.tok, B.tok]) {
          const { changes } = await pullAll(t);
          const ex = changes.filter((x) => x.entity === 'expense' && x.id === e).at(-1);
          expect(ex?.data).toMatchObject({ hasUnresolvedConflict: true, conflictRevisionId: c.conflictRevisionId });
          const rev = changes.find((x) => x.entity === 'expense_revision' && x.id === c.conflictRevisionId);
          expect((rev?.data as Json | undefined)?.snapshot).toMatchObject({ title: (second.data as Json).title });
        }
        // Keep mine: re-push with baseHlc = the server hlc, naming the conflict it resolves.
        const keep = { ...mut('expense', e, { ...(second.data as Json), hasUnresolvedConflict: false, conflictRevisionId: c.conflictRevisionId }, hlc(3000)), baseHlc: c.server!.hlc };
        expect((await push(secondTok, [keep])).get(e)?.status).toBe('applied');
        expect(await row('expenses', e)).toMatchObject({ title: (second.data as Json).title, has_unresolved_conflict: false, conflict_revision_id: null });
      }
      // An exact retry of an applied push is 'stale'; a push without baseHlc stays last-writer-wins.
      const e = id('p13_x');
      const cur = await row('expenses', e);
      expect((await push(B.tok, [{ ...mut('expense', e, expense(e, g, ma, [ma, mb], 1000), String(cur?.hlc)), baseHlc: OLD_HLC }])).get(e)?.status).toBe('stale');
      expect((await push(B.tok, [mut('expense', e, expense(e, g, ma, [ma, mb], 1000, { title: 'legacy' }), hlc(4000))])).get(e)?.status).toBe('applied');
      expect((await push(B.tok, [{ ...mut('expense', e, expense(e, g, ma, [ma, mb], 1000), hlc(5000)), baseHlc: 'nope' }])).get(e)?.status).toBe('invalid');
    });

    it('COMMENTS: own rows, author from the session, author-only edit and delete, scoped pull, legacy JSON ignored', async () => {
      const { A, B, g, ma, mb } = await mkPair('p14');
      const C = await mkUser('p14c');
      const e = id('p14_e');
      await push(A.tok, [mut('expense', e, expense(e, g, ma, [ma, mb], 1000))]);
      const ca = id('p14_ca');
      const cb = id('p14_cb');
      const cm = (cid: string, body: string, over: Json = {}) => mut('expense_comment', cid, { expenseId: e, body, authorName: 'Spoofed', authorMemberId: ma, ...over });
      // Two members comment concurrently: both rows survive.
      const [ra, rb] = await Promise.all([push(A.tok, [cm(ca, 'from A')]), push(B.tok, [cm(cb, 'from B')])]);
      expect([ra.get(ca)?.status, rb.get(cb)?.status]).toEqual(['applied', 'applied']);
      expect(await row('expense_comments', cb)).toMatchObject({ author_id: B.pid, author_member_id: mb, author_name: 'Name p14b', group_id: g, body: 'from B' });
      // Only the author edits or deletes; outsiders cannot write; lengths are enforced.
      expect((await push(A.tok, [cm(cb, 'hijack', {}), ])).get(cb)?.status).toBe('forbidden');
      expect((await push(A.tok, [mut('expense_comment', cb, null, hlc(), 'delete')])).get(cb)?.status).toBe('forbidden');
      expect((await push(C.tok, [cm(id('p14_cc'), 'outsider')])).get(id('p14_cc'))?.status).toBe('forbidden');
      expect((await push(B.tok, [cm(id('p14_long'), 'x'.repeat(1001))])).get(id('p14_long'))?.status).toBe('invalid');
      expect((await push(B.tok, [cm(id('p14_empty'), '')])).get(id('p14_empty'))?.status).toBe('invalid');
      expect((await push(B.tok, [mut('expense_comment', cb, { expenseId: id('p14_other'), body: 'move' }, hlc(1000))])).get(cb)?.status).toBe('forbidden');
      expect((await push(B.tok, [cm(cb, 'edited', {}), ])).get(cb)?.status).toBe('applied');
      expect(await row('expense_comments', cb)).toMatchObject({ body: 'edited', author_id: B.pid });
      expect((await row('expense_comments', cb))?.edited_at).not.toBeNull();
      // Pull: both members see both comments; isMine is per caller; the author's profile id is not exposed.
      for (const [t, mine] of [[A.tok, ca], [B.tok, cb]] as const) {
        const { changes } = await pullAll(t);
        const rows = changes.filter((x) => x.entity === 'expense_comment' && [ca, cb].includes(x.id));
        expect(rows.map((x) => x.id).sort()).toEqual([ca, cb].sort());
        for (const x of rows) {
          expect(x.data).toMatchObject({ expenseId: e, groupId: g, isMine: x.id === mine });
          expect(JSON.stringify(x.data)).not.toContain(B.pid);
        }
      }
      expect((await api(`/api/ledger/pull?groupId=${g}&cursor=0`, { token: A.tok })).text).toContain(cb);
      expect((await api('/api/ledger/pull?cursor=0', { token: C.tok })).text).not.toContain(cb);
      expect((await push(B.tok, [mut('expense_comment', cb, null, hlc(2000), 'delete')])).get(cb)?.status).toBe('applied');
      expect(await row('expense_comments', cb)).toMatchObject({ body: '' });
      // Comments inside the expense JSON are ignored on write and never returned.
      const legacy = [{ id: 'c1', expenseId: e, authorMemberId: mb, authorName: 'Forged', body: 'forged', createdAt: '2026-11-15T00:00:00Z' }];
      expect((await push(A.tok, [mut('expense', e, expense(e, g, ma, [ma, mb], 1000, { comments: legacy }), hlc(3000))])).get(e)?.status).toBe('applied');
      expect((await row('expenses', e))?.comments).toEqual([]);
      // Direct bills: participants comment, the bill's expenseId backfill carries them.
      const p1 = randomUUID();
      const p2 = randomUUID();
      const d = id('p14_d');
      await push(A.tok, [mut('expense', d, expense(d, null, p1, [p1, p2], 100, { adHocParticipants: [{ id: p1, displayName: 'A', invitedEmail: `${A.pid}@example.com` }, { id: p2, displayName: 'B', invitedEmail: `${B.pid}@example.com` }] }))]);
      const dc = id('p14_dc');
      expect((await push(B.tok, [mut('expense_comment', dc, { expenseId: d, body: 'direct' })])).get(dc)?.status).toBe('applied');
      expect(await row('expense_comments', dc)).toMatchObject({ author_member_id: p2, group_id: null });
      expect((await api(`/api/ledger/pull?expenseId=${d}&cursor=0`, { token: A.tok })).text).toContain(dc);
      expect((await push(C.tok, [mut('expense_comment', id('p14_dc2'), { expenseId: d, body: 'no' })])).get(id('p14_dc2'))?.status).toBe('forbidden');
      // Account deletion keeps the shared comment but erases who wrote it.
      expect((await api('/api/account/delete', { token: A.tok, method: 'POST' })).status).toBe(204);
      expect(await row('expense_comments', ca)).toMatchObject({ author_id: null, author_name: 'Deleted user', body: 'from A' });
    });

    it('COMMENTS: the 0005 migration moves legacy JSON comments into read-only rows (idempotent)', async () => {
      const { A, g, ma, mb } = await mkPair('p14m');
      const e = id('p14m_e');
      await push(A.tok, [mut('expense', e, expense(e, g, ma, [ma, mb], 1000))]);
      const keep = id('p14m_c1');
      const dup = id('p14m_dup');
      const legacy = [
        { id: keep, authorMemberId: mb, authorName: 'Old B', body: 'first', createdAt: '2026-11-01T00:00:00Z' },
        { id: dup, authorMemberId: ma, authorName: 'Old A', body: 'second' },
        { id: dup, authorMemberId: ma, authorName: 'Old A', body: 'third' },
        { id: 'bad id!', authorName: 'x', body: '' },
        { id: id('p14m_pad'), authorName: 'x', body: `${' '.repeat(1000)}x` },
      ];
      await db().from('expenses').update({ comments: legacy }).eq('id', e);
      const file = 'supabase/migrations/0005_phase1_server_support.sql';
      for (let i = 0; i < 2; i++) {
        const r = spawnSync('docker', ['exec', '-i', 'supabase_db_dependencies', 'psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-1', '-U', 'postgres', '-d', 'postgres'], { input: readFileSync(file, 'utf8'), encoding: 'utf8' });
        expect(r.status, r.stderr).toBe(0);
      }
      expect((await row('expenses', e))?.comments).toEqual([]);
      const { data } = await db().from('expense_comments').select('*').eq('expense_id', e).order('created_at');
      const byBody = Object.fromEntries((data ?? []).map((c) => [c.body, c]));
      expect(Object.keys(byBody).sort()).toEqual(['first', 'second', 'third']);
      for (const c of data ?? []) expect([c.author_id, c.author_name.startsWith('Old'), c.legacy]).toEqual([null, true, true]);
      // Original ids survive (devices holding the nested copy dedupe); only the repeated id gets an lc_ id.
      expect([byBody.first?.id, byBody.second?.id]).toEqual([keep, dup]);
      expect(String(byBody.third?.id)).toMatch(/^lc_[0-9a-f]{32}$/);
      const { changes } = await pullAll(A.tok);
      const pulled = changes.filter((x) => x.entity === 'expense_comment' && (x.data as Json)?.expenseId === e);
      expect(pulled).toHaveLength(3);
      for (const x of pulled) expect(x.data).toMatchObject({ isLegacy: true });
    });

    it('JOIN: invite code joins, claims a placeholder by email, rejoins, is rate limited and rotatable', async () => {
      const { A, B, g, mb } = await mkPair('p113');
      const C = await mkUser('p113c');
      const D = await mkUser('p113d');
      const mp = id('p113_mp');
      await push(A.tok, [mut('group_member', mp, { groupId: g, displayName: 'D placeholder', invitedEmail: `${D.pid}@example.com` })]);
      const code = String((await row('groups', g))?.invite_code);
      const jc = await join(C.tok, code.toLowerCase());
      expect(jc.status).toBe(200);
      expect(jc.json).toMatchObject({ ok: true, groupId: g, status: 'joined' });
      const mc = String(jc.json.memberId);
      expect(await row('group_members', mc)).toMatchObject({ group_id: g, user_id: C.pid, role: 'member', display_name: 'Name p113c' });
      expect((await join(C.tok, code)).json).toMatchObject({ status: 'already_member', memberId: mc });
      expect((await join(D.tok, code)).json).toMatchObject({ status: 'claimed', memberId: mp });
      expect((await row('group_members', mp))?.user_id).toBe(D.pid);
      expect((await api(`/api/ledger/pull?groupId=${g}&cursor=0`, { token: C.tok })).status).toBe(200);
      // Leave (own row), then rejoin into the same member row so old balances still line up.
      expect((await push(C.tok, [mut('group_member', mc, null, hlc(), 'delete')])).get(mc)?.status).toBe('applied');
      expect((await join(C.tok, code)).json).toMatchObject({ status: 'rejoined', memberId: mc });
      expect((await row('group_members', mc))?.removed_at).toBeNull();
      // An admin removes others; a plain member cannot; the last admin cannot leave while others stay.
      expect((await push(B.tok, [mut('group_member', mc, null, hlc(), 'delete')])).get(mc)?.status).toBe('forbidden');
      expect((await push(A.tok, [mut('group_member', mc, null, hlc(), 'delete')])).get(mc)?.status).toBe('applied');
      const ma = id('p113_ma');
      expect((await push(A.tok, [mut('group_member', ma, null, hlc(), 'delete')])).get(ma)?.status).toBe('forbidden');
      // Rotation is admin-only; the old code stops working.
      expect((await push(B.tok, [mut('group', g, { rotateInviteCode: true }, hlc(1000))])).get(g)?.status).toBe('forbidden');
      expect((await push(A.tok, [mut('group', g, { rotateInviteCode: true }, hlc(2000))])).get(g)?.status).toBe('applied');
      const code2 = String((await row('groups', g))?.invite_code);
      expect(code2).toMatch(/^WS-[0-9A-F]{10}$/);
      expect(code2).not.toBe(code);
      const E = await mkUser('p113e');
      expect((await join(E.tok, code)).status).toBe(404);
      expect((await join(E.tok, 'not a code')).status).toBe(400);
      expect((await join(E.tok, 42)).status).toBe(400);
      expect((await api('/api/groups/join', { body: { code: code2 } })).status).toBe(401);
      // Failed attempts: the per-account limiter, then the database cap that holds across replicas.
      for (let i = 0; i < 19; i++) {
        resetRateLimiterForTests();
        expect((await join(E.tok, `WS-${randomBytes(5).toString('hex').toUpperCase()}`)).status).toBe(404);
      }
      resetRateLimiterForTests();
      const locked = await join(E.tok, code2);
      expect(locked.status).toBe(429);
      expect(locked.headers.get('retry-after')).toBeTruthy();
      expect((await row('group_members', mb))?.user_id).toBe(B.pid);
      const F = await mkUser('p113f');
      for (let i = 0; i < 10; i++) await join(F.tok, `WS-${randomBytes(5).toString('hex').toUpperCase()}`);
      expect((await join(F.tok, code2)).status).toBe(429);
      resetRateLimiterForTests();
      expect((await join(F.tok, code2)).json).toMatchObject({ status: 'joined' });
      // A deleted group cannot be joined.
      await push(A.tok, [mut('group', g, null, hlc(3000), 'delete')]);
      const H = await mkUser('p113h');
      expect((await join(H.tok, code2)).status).toBe(404);
    });

    it('GROUP EDITS: any active member edits, deletes and restores group bills and payments; removed members and outsiders cannot; dates are bounded', async () => {
      const { A, B, g, ma, mb } = await mkPair('p15');
      const C = await mkUser('p15c');
      const mc = id('p15_mc');
      await push(A.tok, [mut('group_member', mc, { groupId: g, displayName: 'C' })]);
      await db().from('group_members').update({ user_id: C.pid }).eq('id', mc);
      const s = id('p15_s');
      const st = (over: Json = {}) => ({ groupId: g, fromMemberId: mb, toMemberId: ma, amountMinor: 500, currency: 'INR', settledDate: '2026-11-15', notes: '', ...over });
      const R = await mkUser('p15r');
      const mr = id('p15_mr');
      await push(A.tok, [mut('group_member', mr, { groupId: g, displayName: 'R' })]);
      await db().from('group_members').update({ user_id: R.pid }).eq('id', mr);
      await push(A.tok, [mut('group_member', mr, null, hlc(), 'delete')]);
      const O = await mkUser('p15o');
      expect((await push(B.tok, [mut('settlement', s, st())])).get(s)?.status).toBe('applied');
      // C is a plain member who did not record the payment: edit, delete and restore all apply; ownership stays B's.
      expect((await push(C.tok, [mut('settlement', s, st({ amountMinor: 400, settledDate: '2026-11-10', notes: 'fixed' }), hlc(1000))])).get(s)?.status).toBe('applied');
      expect(await row('settlements', s)).toMatchObject({ amount_minor: 400, settled_date: '2026-11-10', notes: 'fixed', owner_id: B.pid });
      expect((await push(C.tok, [mut('settlement', s, null, hlc(1100), 'delete')])).get(s)?.status).toBe('applied');
      expect((await push(C.tok, [mut('settlement', s, st({ amountMinor: 400 }), hlc(1200))])).get(s)?.status).toBe('applied');
      expect((await row('settlements', s))?.deleted_at).toBeNull();
      for (const t of [R.tok, O.tok]) {
        expect((await push(t, [mut('settlement', s, st({ amountMinor: 1 }), hlc(1300))])).get(s)?.status).toBe('forbidden');
        expect((await push(t, [mut('settlement', s, null, hlc(1300), 'delete')])).get(s)?.status).toBe('forbidden');
      }
      // Group bills follow the same rule.
      const eb = id('p15_eb');
      await push(B.tok, [mut('expense', eb, expense(eb, g, mb, [ma, mb], 1000))]);
      expect((await push(C.tok, [mut('expense', eb, expense(eb, g, mb, [ma, mb], 1000, { title: 'by C' }), hlc(1400))])).get(eb)?.status).toBe('applied');
      expect((await push(C.tok, [mut('expense', eb, null, hlc(1500), 'delete')])).get(eb)?.status).toBe('applied');
      expect((await push(C.tok, [mut('expense', eb, expense(eb, g, mb, [ma, mb], 1000, { title: 'by C' }), hlc(1600))])).get(eb)?.status).toBe('applied');
      expect(await row('expenses', eb)).toMatchObject({ title: 'by C', deleted_at: null, owner_id: B.pid, created_by_member_id: mb });
      for (const t of [R.tok, O.tok]) {
        expect((await push(t, [mut('expense', eb, expense(eb, g, mb, [ma, mb], 1000, { title: 'x' }), hlc(1700))])).get(eb)?.status).toBe('forbidden');
        expect((await push(t, [mut('expense', eb, null, hlc(1700), 'delete')])).get(eb)?.status).toBe('forbidden');
      }
      // canEdit is per caller and true for every member; the recorder's profile id never leaves the server.
      for (const [t, can] of [[B.tok, true], [A.tok, true], [C.tok, true]] as const) {
        const ch = (await pullAll(t)).changes.filter((x) => x.entity === 'settlement' && x.id === s).at(-1);
        expect(ch?.data).toMatchObject({ canEdit: can });
        expect(JSON.stringify(ch?.data)).not.toContain(B.pid);
      }
      expect((await push(B.tok, [mut('settlement', s, st({ canEdit: true }), hlc(2500))])).get(s)?.status).toBe('applied');
      const act = id('p15_act');
      expect((await push(B.tok, [mut('group_activity', act, { groupId: g, actorMemberId: mb, entityType: 'settlement', entityId: s, action: 'settlement_updated', summaryText: 'B edited a payment' })])).get(act)?.status).toBe('applied');
      expect((await push(A.tok, [mut('settlement', s, null, hlc(3000), 'delete')])).get(s)?.status).toBe('applied');
      const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
      const later = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
      const r = await push(B.tok, [
        mut('settlement', id('p15_ok'), st({ settledDate: tomorrow })),
        mut('settlement', id('p15_future'), st({ settledDate: later })),
        mut('settlement', id('p15_old'), st({ settledDate: '1999-12-31' })),
      ]);
      expect([r.get(id('p15_ok'))?.status, r.get(id('p15_future'))?.status, r.get(id('p15_old'))?.status]).toEqual(['applied', 'invalid', 'invalid']);
      const e = id('p15_e');
      await push(A.tok, [mut('expense', e, expense(e, g, ma, [ma, mb], 1000))]);
      const rev = id('p15_rev');
      const snap = { title: 't', category: 'food', amountMinor: 1000, originalCurrency: 'INR', originalAmountMinor: 1000, groupCurrency: 'INR', fxRateScaled: 100000000, fxStatus: 'identity', splitMode: 'exact', payers: [], splits: [], notes: '' };
      await push(A.tok, [mut('expense_revision', rev, { expenseId: e, revisionNumber: 2, actorMemberId: ma, action: 'updated', changes: [], snapshot: snap })]);
      expect(((await row('expense_revisions', rev))?.snapshot as Json).groupCurrency).toBe('INR');
      // Re-conversion revisions keep where they were converted from; malformed values are refused.
      const conv = id('p15_conv');
      const convSnap = { ...snap, convertedFrom: { currency: 'USD', fxRateScaled: '8350000000' } };
      await push(A.tok, [mut('expense_revision', conv, { expenseId: e, revisionNumber: 3, actorMemberId: ma, action: 'currency_reconverted', changes: [], snapshot: convSnap })]);
      expect(((await row('expense_revisions', conv))?.snapshot as Json).convertedFrom).toEqual({ currency: 'USD', fxRateScaled: 8350000000 });
      for (const [k, bad] of [['c1', { currency: 'usd', fxRateScaled: 1 }], ['c2', { currency: 'USD', fxRateScaled: 0 }], ['c3', { currency: 'USD', fxRateScaled: 1.5 }], ['c4', 'USD']] as const) {
        const rid = id(`p15_conv_${k}`);
        expect((await push(A.tok, [mut('expense_revision', rid, { expenseId: e, revisionNumber: 3, actorMemberId: ma, action: 'currency_reconverted', changes: [], snapshot: { ...snap, convertedFrom: bad } })])).get(rid)?.status).toBe('invalid');
      }
      await push(A.tok, [{ ...mut('expense', e, expense(e, g, ma, [ma, mb], 1000, { title: 'v2', currentRevisionId: `${e}_v2` }), hlc(5000)), baseHlc: String((await row('expenses', e))?.hlc) }]);
      expect(((await row('expense_revisions', `${e}_v1`))?.snapshot as Json).groupCurrency).toBe('INR');
    });

    it('DOCKER: the API container listens on all interfaces', () => {
      expect(readFileSync('docker-compose.yml', 'utf8')).toMatch(/API_HOST: 0\.0\.0\.0/);
    });
  });

  describe('Review of 0005 (independent reviewer findings)', () => {
    async function mkUser(tag: string) {
      const pid = id(tag);
      await db().from('profiles').insert({ id: pid, email: `${pid}@example.com`, full_name: `Name ${tag}`, hlc: OLD_HLC });
      return { pid, tok: await tokenFor(pid) };
    }
    async function mkGroup(tag: string) {
      const A = await mkUser(`${tag}a`);
      const g = id(`${tag}_g`);
      const ma = id(`${tag}_ma`);
      await push(A.tok, [mut('group', g, { name: 'G', baseCurrency: 'INR' }), mut('group_member', ma, { groupId: g, userId: A.pid, displayName: 'A', role: 'admin' })]);
      return { A, g, ma, code: String((await row('groups', g))?.invite_code) };
    }
    const join = (token: string, code: string) => api('/api/groups/join', { token, body: { code } });

    it('R1: an admin-removed member cannot rejoin by code; one who left can; an admin can add them back', async () => {
      const { A, g, code } = await mkGroup('rv1');
      const C = await mkUser('rv1c');
      const mc = String((await join(C.tok, code)).json.memberId);
      expect((await push(A.tok, [mut('group_member', mc, null, hlc(), 'delete')])).get(mc)?.status).toBe('applied');
      expect((await row('group_members', mc))?.removed_by).toBe(A.pid);
      const denied = await join(C.tok, code);
      expect(denied.status).toBe(403);
      expect(denied.json.error).toBe('An admin removed you from this group; ask them to add you back');
      expect((await row('group_members', mc))?.removed_at).not.toBeNull();
      expect((await api(`/api/ledger/pull?groupId=${g}&cursor=0`, { token: C.tok })).status).toBe(403);
      // The admin adds them back with an ordinary member upsert.
      expect((await push(A.tok, [mut('group_member', mc, { groupId: g, displayName: 'C', removedAt: null }, hlc(1000))])).get(mc)?.status).toBe('applied');
      expect(await row('group_members', mc)).toMatchObject({ removed_at: null, removed_by: null, user_id: C.pid });
      // Leaving yourself keeps the code path open.
      expect((await push(C.tok, [mut('group_member', mc, null, hlc(2000), 'delete')])).get(mc)?.status).toBe('applied');
      expect((await row('group_members', mc))?.removed_by).toBe(C.pid);
      expect((await join(C.tok, code)).json).toMatchObject({ status: 'rejoined', memberId: mc });
    });

    it('R2: only 40-bit WS- codes exist and are accepted', async () => {
      const { data } = await db().from('groups').select('id').not('invite_code', 'like', 'WS-%').limit(1);
      expect(data).toEqual([]);
      const { g } = await mkGroup('rv2');
      expect((await db().from('groups').update({ invite_code: 'HIMA-9454' }).eq('id', g)).error).not.toBeNull();
      const E = await mkUser('rv2e');
      expect((await join(E.tok, 'HIMA-9454')).status).toBe(400);
      expect(await admin.joinGroup(E.pid, 'GOA-2026-VILLA')).toEqual({ error: 'not_found' });
      const day = new Date().toISOString().slice(0, 10);
      expect((await db().from('quota_usage').select('n').match({ kind: 'join_fail', owner_id: E.pid, scope_id: day }).maybeSingle()).data?.n).toBe(1);
    });

    it('R3: the conflict marker moves the hlc, so an edit that has not seen it is a conflict too and cannot clear it', async () => {
      const { A, g, ma } = await mkGroup('rv3');
      const B = await mkUser('rv3b');
      const C = await mkUser('rv3c');
      const mb = id('rv3_mb');
      const mc = id('rv3_mc');
      await push(A.tok, [mut('group_member', mb, { groupId: g, displayName: 'B' }), mut('group_member', mc, { groupId: g, displayName: 'C' })]);
      await db().from('group_members').update({ user_id: B.pid }).eq('id', mb);
      await db().from('group_members').update({ user_id: C.pid }).eq('id', mc);
      const e = id('rv3_e');
      const ed = (title: string, over: Json = {}) => expense(e, g, ma, [ma, mb], 1000, { title, ...over });
      await push(A.tok, [mut('expense', e, ed('v0'))]);
      const h0 = String((await row('expenses', e))?.hlc);
      const h1 = hlc(1000);
      expect((await push(B.tok, [{ ...mut('expense', e, ed('B1'), h1), baseHlc: h0 }])).get(e)?.status).toBe('applied');
      const hc = hlc(2000);
      const c = (await push(C.tok, [{ ...mut('expense', e, ed('C1'), hc), baseHlc: h0 }])).get(e)!;
      expect(c.status).toBe('conflict');
      expect(c.serverHlc! > hc && c.serverHlc! > h1).toBe(true);
      expect(await row('expenses', e)).toMatchObject({ title: 'B1', hlc: c.serverHlc, has_unresolved_conflict: true });
      // B has not pulled the marker: its next edit is a conflict, and the flag stays.
      expect((await push(B.tok, [{ ...mut('expense', e, ed('B2', { hasUnresolvedConflict: false, conflictRevisionId: null }), hlc(3000)), baseHlc: h1 }])).get(e)?.status).toBe('conflict');
      const marked = await row('expenses', e);
      expect(marked).toMatchObject({ title: 'B1', has_unresolved_conflict: true });
      // An edit that has seen the marker but does not name it keeps the flag; naming it resolves it.
      const seen = String(marked?.hlc);
      expect((await push(B.tok, [{ ...mut('expense', e, ed('B3', { hasUnresolvedConflict: false, conflictRevisionId: null }), hlc(4000)), baseHlc: seen }])).get(e)?.status).toBe('applied');
      expect(await row('expenses', e)).toMatchObject({ title: 'B3', has_unresolved_conflict: true, conflict_revision_id: marked?.conflict_revision_id });
      const now = String((await row('expenses', e))?.hlc);
      expect((await push(B.tok, [{ ...mut('expense', e, ed('B4', { hasUnresolvedConflict: false, conflictRevisionId: marked?.conflict_revision_id }), hlc(5000)), baseHlc: now }])).get(e)?.status).toBe('applied');
      expect(await row('expenses', e)).toMatchObject({ title: 'B4', has_unresolved_conflict: false, conflict_revision_id: null });
      // Clients cannot plant a marker on a new or clean bill.
      const f = id('rv3_f');
      await push(A.tok, [mut('expense', f, expense(f, g, ma, [ma], 10, { hasUnresolvedConflict: true, conflictRevisionId: 'cf_forged' }))]);
      expect(await row('expenses', f)).toMatchObject({ has_unresolved_conflict: false, conflict_revision_id: null });
      // An identical retry of a conflicting push neither re-flags nor uses revision quota.
      const quota = async () => (await db().from('quota_usage').select('n').match({ kind: 'expense_revisions', owner_id: mc, scope_id: e }).maybeSingle()).data?.n;
      const before = [await quota(), (await row('expenses', e))?.server_seq];
      expect((await push(C.tok, [{ ...mut('expense', e, ed('C1'), hc), baseHlc: h0 }])).get(e)).toMatchObject({ status: 'conflict', conflictRevisionId: c.conflictRevisionId });
      expect([await quota(), (await row('expenses', e))?.server_seq]).toEqual(before);
    });

    it('R4/R5: join re-checks the group under the lock, and a rejoin respects the 100-member cap', async () => {
      const { A, g, code } = await mkGroup('rv4');
      const C = await mkUser('rv4c');
      const hold = spawn('docker', ['exec', '-i', 'supabase_db_dependencies', 'psql', '-X', '-q', '-U', 'postgres', '-d', 'postgres', '-c',
        `BEGIN; SELECT pg_advisory_xact_lock(7735001); SELECT pg_sleep(1.2); UPDATE wise_spliter.groups SET deleted_at = now() WHERE id = '${g}'; COMMIT;`]);
      await new Promise((r) => setTimeout(r, 400));
      const raced = await join(C.tok, code);
      await new Promise((r) => hold.on('close', r));
      expect(raced.status).toBe(404);
      expect((await db().from('group_members').select('id').eq('group_id', g).eq('user_id', C.pid)).data).toEqual([]);

      const f = await mkGroup('rv5');
      const D = await mkUser('rv5d');
      const md = String((await join(D.tok, f.code)).json.memberId);
      await push(D.tok, [mut('group_member', md, null, hlc(), 'delete')]);
      const ms = Array.from({ length: 99 }, (_, i) => mut('group_member', id(`rv5_m${i}`), { groupId: f.g, displayName: `M${i}` }));
      for (let i = 0; i < ms.length; i += 50) await push(f.A.tok, ms.slice(i, i + 50));
      const full = await join(D.tok, f.code);
      expect(full.status).toBe(409);
      expect((await row('group_members', md))?.removed_at).not.toBeNull();
      void A;
    }, 30_000);

    it('R7/R8: no profile ids in direct-bill revisions; comments use server time and need a live bill', async () => {
      const O = await mkUser('rv7o');
      const p1 = randomUUID();
      const p2 = randomUUID();
      const e = id('rv7_e');
      const d = (title: string) => expense(e, null, p1, [p1, p2], 100, { title, adHocParticipants: [{ id: p1, displayName: 'X' }, { id: p2, displayName: 'Y' }] });
      await push(O.tok, [mut('expense', e, d('v0'))]);
      const h0 = String((await row('expenses', e))?.hlc);
      await push(O.tok, [{ ...mut('expense', e, d('one'), hlc(1000)), baseHlc: h0 }]);
      const c = (await push(O.tok, [{ ...mut('expense', e, d('two'), hlc(2000)), baseHlc: h0 }])).get(e)!;
      expect(c.status).toBe('conflict');
      expect((await row('expense_revisions', c.conflictRevisionId!))?.actor_member_id).toBeNull();
      const rv = id('rv7_rev');
      const snap = { title: 't', category: 'food', amountMinor: 100, originalCurrency: 'INR', originalAmountMinor: 100, fxRateScaled: 100000000, fxStatus: 'identity', splitMode: 'exact', payers: [], splits: [], notes: '' };
      await push(O.tok, [mut('expense_revision', rv, { expenseId: e, revisionNumber: 2, actorMemberId: p1, action: 'updated', changes: [], snapshot: snap })]);
      expect((await row('expense_revisions', rv))?.actor_member_id).toBeNull();
      expect((await api(`/api/ledger/pull?expenseId=${e}&cursor=0`, { token: O.tok })).text).not.toContain(`"actorMemberId":"${O.pid}"`);
      // Comments: created_at is server time; deleted bills take no new comments or edits.
      const cm = id('rv8_c');
      const t0 = Date.now();
      await push(O.tok, [mut('expense_comment', cm, { expenseId: e, body: 'hi', createdAt: '2001-01-01T00:00:00Z' })]);
      expect(Math.abs(Date.parse(String((await row('expense_comments', cm))?.created_at)) - t0)).toBeLessThan(60_000);
      await push(O.tok, [mut('expense', e, null, hlc(3000), 'delete')]);
      const late = id('rv8_late');
      expect((await push(O.tok, [mut('expense_comment', late, { expenseId: e, body: 'late' })])).get(late)?.status).toBe('invalid');
      expect((await push(O.tok, [mut('expense_comment', cm, { expenseId: e, body: 'edit' }, hlc(4000))])).get(cm)?.status).toBe('invalid');
      expect((await push(O.tok, [mut('expense_comment', cm, null, hlc(5000), 'delete')])).get(cm)?.status).toBe('applied');
    });
  });

  describe('UPI payee safety (who may change a payee VPA)', () => {
    async function mkUser(tag: string) {
      const pid = id(tag);
      await db().from('profiles').insert({ id: pid, email: `${pid}@example.com`, full_name: `Name ${tag}`, hlc: OLD_HLC });
      return { pid, tok: await tokenFor(pid) };
    }
    const activity = async (entityId: string) =>
      ((await db().from('group_activity_log').select('*').eq('entity_id', entityId).eq('action', 'upi_changed').order('server_seq')).data ?? []) as Json[];

    it('UPI: a claimed member alone changes their VPA; placeholder changes are allowed and logged with masked values', async () => {
      const A = await mkUser('upa');
      const B = await mkUser('upb');
      const g = id('up_g');
      const ma = id('up_ma');
      const mb = id('up_mb');
      const mk = id('up_mk');
      await push(A.tok, [mut('group', g, { name: 'G', baseCurrency: 'INR' }), mut('group_member', ma, { groupId: g, userId: A.pid, displayName: 'A', role: 'admin' })]);
      await push(A.tok, [
        mut('group_member', mb, { groupId: g, displayName: 'B', upiId: 'bob.real@okhdfc' }),
        mut('group_member', mk, { groupId: g, displayName: 'Kabir', upiId: 'kabir@okaxis' }),
      ]);
      await db().from('group_members').update({ user_id: B.pid }).eq('id', mb);
      let n = 0;
      const member = (mid: string, name: string, upiId: string | null) => mut('group_member', mid, { groupId: g, displayName: name, upiId }, hlc(1000 * ++n));
      // Even an admin cannot redirect a claimed member's payments; renaming with the same VPA is fine.
      expect((await push(A.tok, [member(mb, 'B', 'attacker@okicici')])).get(mb)?.status).toBe('forbidden');
      expect((await push(A.tok, [member(mb, 'B', null)])).get(mb)?.status).toBe('forbidden');
      expect((await push(A.tok, [member(mb, 'Bobby', 'bob.real@okhdfc')])).get(mb)?.status).toBe('applied');
      expect((await row('group_members', mb))?.upi_id).toBe('bob.real@okhdfc');
      expect((await push(B.tok, [member(mb, 'Bobby', 'bob.new@okhdfc')])).get(mb)?.status).toBe('applied');
      expect((await row('group_members', mb))?.upi_id).toBe('bob.new@okhdfc');
      // Any member may fix a placeholder's VPA, and the group sees who did it.
      expect((await push(B.tok, [member(mk, 'Kabir', 'attacker@okicici')])).get(mk)?.status).toBe('applied');
      const [log] = await activity(mk);
      expect(log).toMatchObject({ group_id: g, actor_member_id: mb, actor_display_name: 'Name upb', owner_id: B.pid, entity_type: 'member',
        summary_text: 'Name upb changed the UPI ID of Kabir', detail_note: 'ka***@okaxis to at***@okicici' });
      expect(JSON.stringify(log)).not.toContain('attacker@');
      const pulled = (await pullAll(A.tok)).changes.find((x) => x.entity === 'group_activity' && x.id === log!.id);
      expect(pulled?.data).toMatchObject({ action: 'upi_changed', entityId: mk });
      // A rename that keeps the VPA logs nothing; clearing it is logged.
      await push(A.tok, [member(mk, 'Kabir S', 'attacker@okicici')]);
      expect(await activity(mk)).toHaveLength(1);
      await push(A.tok, [member(mk, 'Kabir S', null)]);
      expect((await activity(mk)).at(-1)?.detail_note).toBe('at***@okicici to none');
    });

    it('UPI: on a direct bill only the owner or that bound participant changes a participant VPA, and it is logged', async () => {
      const O = await mkUser('upo');
      const P = await mkUser('upp');
      const [po, pp, px] = [randomUUID(), randomUUID(), randomUUID()];
      const e = id('up_d');
      const parts = (pUpi: string | null, xUpi: string | null) => [
        { id: po, displayName: 'O', invitedEmail: `${O.pid}@example.com` },
        { id: pp, displayName: 'P', invitedEmail: `${P.pid}@example.com`, upiId: pUpi },
        { id: px, displayName: 'X', upiId: xUpi },
      ];
      const bill = (pUpi: string | null, xUpi: string | null) => expense(e, null, po, [po, pp, px], 300, { adHocParticipants: parts(pUpi, xUpi) });
      await push(O.tok, [mut('expense', e, bill('p@okhdfc', 'x@okaxis'))]);
      expect((await push(P.tok, [mut('expense', e, bill('p@okhdfc', 'p.alt@okhdfc'), hlc(1000))])).get(e)?.status).toBe('forbidden');
      expect((await push(P.tok, [mut('expense', e, bill('p.new@okhdfc', 'x@okaxis'), hlc(2000))])).get(e)?.status).toBe('applied');
      expect((await push(O.tok, [mut('expense', e, bill('p.new@okhdfc', 'x.new@okaxis'), hlc(3000))])).get(e)?.status).toBe('applied');
      const logs = await activity(e);
      expect(logs.map((l) => [l.actor_member_id, l.summary_text, l.detail_note])).toEqual([
        [pp, 'Name upp changed the UPI ID of P', 'p***@okhdfc to p.***@okhdfc'],
        [po, 'Name upo changed the UPI ID of X', 'x***@okaxis to x.***@okaxis'],
      ]);
      for (const t of [O.tok, P.tok]) expect((await pullAll(t)).changes.filter((x) => x.entity === 'group_activity' && (x.data as Json)?.entityId === e && (x.data as Json)?.action === 'upi_changed')).toHaveLength(2);
    });
  });

  it('apk-prod refuses http or loopback/LAN API URLs', () => {
    for (const url of ['http://api.example.com', 'https://127.0.0.1:4174', 'https://192.168.1.20', 'https://localhost']) {
      const r = spawnSync('bash', ['scripts/build-apk.sh'], { env: { ...process.env, APK_RELEASE: '1', VITE_API_BASE_URL: url }, encoding: 'utf8' });
      expect(r.status).toBe(2);
    }
  });
});
