import { createHmac, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handleApiRequest } from '../../src/server/index';
import * as sec from '../../src/server/securityAndAuth';
import * as adminMod from '../../src/server/supabaseAdmin';
import {
  SYNC_PULL_MAX_LIMIT,
  type SyncPullChange,
  type SyncPullResponse,
  type SyncPushMutation,
  type SyncPushResponse,
} from '../../src/types/sync-contract';

const env = (name: string, fallback = ''): string =>
  (process.env[name] ?? fallback).trim();

const SUPABASE_URL = env('SUPABASE_URL');
const SECRET_KEY = env('SUPABASE_SECRET_KEY');
const SCHEMA = env('SUPABASE_SCHEMA', 'wise_spliter');
const PUBLISHABLE_KEY =
  env('VITE_SUPABASE_PUBLISHABLE_KEY') || env('VITE_SUPABASE_ANON_KEY');
const ANON_KEY = env('VITE_SUPABASE_ANON_KEY') || PUBLISHABLE_KEY;

if (!SUPABASE_URL || !SECRET_KEY || !PUBLISHABLE_KEY || !env('GRANT_TOKEN_SECRET')) {
  throw new Error('Run via `make test`: .env.development must be sourced');
}
if (!['127.0.0.1', 'localhost'].includes(new URL(SUPABASE_URL).hostname)) {
  throw new Error('redteam-regression only runs against the LOCAL Supabase');
}

process.env.API_RATE_LIMIT = '1000000';

const P = `rt${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
const DOMAIN = 'rt.test';
const NOW_ISO = new Date().toISOString();
const T0 = Date.now() - 10 * 60 * 1000;
const hlcAt = (ms: number, node = 'redteam'): string =>
  `${ms.toString(16).padStart(12, '0')}-0000-${node}`;
const HLC0 = hlcAt(T0);
let hlcTick = 0;
const nextHlc = (): string => hlcAt(Date.now() + 1000 * ++hlcTick);
const FILLERS = 1100;
const B_ROWS = 170;
const BIG = '9007199254740993';
const BIG_HALF_A = '4503599627370497';
const BIG_HALF_B = '4503599627370496';
const MAX_SAFE = '9007199254740991';
const MAX_SAFE_HALF_A = '4503599627370496';
const MAX_SAFE_HALF_B = '4503599627370495';

const admin = createClient(SUPABASE_URL, SECRET_KEY, {
  db: { schema: SCHEMA as 'wise_spliter' },
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

type Json = Record<string, unknown>;
interface TUser {
  key: string;
  id: string;
  email: string;
  password: string;
  name: string;
  authId: string;
  token: string;
}

const users: Record<string, TUser> = {};
const authIds: string[] = [];
const u = (key: string): TUser => {
  const found = users[key];
  if (!found) throw new Error(`fixture user ${key} missing`);
  return found;
};

const id = (suffix: string): string => `${P}-${suffix}`;
const G = {
  A: id('ga'),
  R: id('gr'),
  B: id('gb'),
  F: id('gf'),
  H: id('gh'),
  D: id('gd'),
  S: id('gs'),
  J: id('gj'),
  JI: id('gji'),
  JU: id('gju'),
  DEMO: id('gdemo'),
};
const MEM = {
  aA: id('mem-ga-a'),
  aM: id('mem-ga-m'),
  aR: id('mem-ga-r'),
  aU: id('mem-ga-u'),
  rR: id('mem-gr-r'),
  rA: id('mem-gr-a'),
  bB: id('mem-gb-b'),
  fB: id('mem-gf-b'),
  hA: id('mem-gh-a'),
  dD: id('mem-gd-d'),
  dA: id('mem-gd-a'),
  sD: id('mem-gs-d'),
  jB: id('mem-gj-b'),
  jJ: id('mem-gj-j'),
  jiB: id('mem-gji-b'),
  jiJ: id('mem-gji-j'),
  juB: id('mem-gju-b'),
  juJ: id('mem-gju-j'),
  demo: id('mem-gdemo'),
};
const EXP = {
  A: id('exp-a'),
  A2: id('exp-a2'),
  C: id('exp-c'),
  B: id('exp-b'),
  N: id('exp-n'),
  D1: id('exp-d1'),
  D2: id('exp-d2'),
  S: id('exp-s'),
};
const SET_A = id('set-a');

let server: Server;
let baseUrl = '';
const realFetch = globalThis.fetch;

interface ApiRes {
  status: number;
  text: string;
  json: Json | null;
  headers: Headers;
}

async function api(
  path: string,
  opts: {
    method?: string;
    token?: string;
    body?: unknown;
    rawBody?: string;
    headers?: Record<string, string>;
  } = {}
): Promise<ApiRes> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  let body: string | undefined;
  if (opts.rawBody !== undefined) body = opts.rawBody;
  else if (opts.body !== undefined) body = JSON.stringify(opts.body);
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await realFetch(`${baseUrl}${path}`, {
    method: opts.method ?? (body !== undefined ? 'POST' : 'GET'),
    headers,
    ...(body !== undefined ? { body } : {}),
  });
  const text = await res.text();
  let json: Json | null = null;
  try {
    json = JSON.parse(text) as Json;
  } catch {
    json = null;
  }
  return { status: res.status, text, json, headers: res.headers };
}

const push = (token: string, mutations: SyncPushMutation[]): Promise<ApiRes> =>
  api('/api/ledger/push', { token, body: { mutations } });

const resultFor = (r: ApiRes, rowId: string) =>
  (r.json as SyncPushResponse | null)?.results?.find((x) => x.id === rowId);

function expectRejected(r: ApiRes, rowId: string): void {
  expect(r.status, `push endpoint must exist: ${r.text.slice(0, 200)}`).not.toBe(404);
  if (r.status === 200) {
    expect(['forbidden', 'invalid'], r.text.slice(0, 300)).toContain(
      resultFor(r, rowId)?.status
    );
  } else {
    expect([400, 401, 403], r.text.slice(0, 300)).toContain(r.status);
  }
}

function expectInvalid(r: ApiRes, rowId: string): void {
  expect(r.status, `push endpoint must exist: ${r.text.slice(0, 200)}`).not.toBe(404);
  if (r.status === 200) {
    expect(resultFor(r, rowId)?.status, r.text.slice(0, 300)).toBe('invalid');
  } else {
    expect([400, 413], r.text.slice(0, 300)).toContain(r.status);
  }
}

function expectApplied(r: ApiRes, rowId: string): void {
  expect(r.status, r.text.slice(0, 300)).toBe(200);
  expect(resultFor(r, rowId)?.status, r.text.slice(0, 300)).toBe('applied');
}

async function pull(token: string, cursor: string, limit?: number): Promise<ApiRes> {
  const q = `cursor=${encodeURIComponent(cursor)}${limit !== undefined ? `&limit=${limit}` : ''}`;
  return api(`/api/ledger/pull?${q}`, { token });
}

async function pullAll(
  token: string,
  cursor = '0'
): Promise<{ status: number; changes: SyncPullChange[]; raw: string; cursor: string }> {
  const changes: SyncPullChange[] = [];
  let raw = '';
  let cur = cursor;
  for (let page = 0; page < 40; page++) {
    const r = await pull(token, cur, SYNC_PULL_MAX_LIMIT);
    if (r.status !== 200) return { status: r.status, changes, raw: raw + r.text, cursor: cur };
    raw += r.text;
    const body = r.json as unknown as SyncPullResponse;
    changes.push(...body.changes);
    if (!body.hasMore || body.nextCursor === cur) {
      cur = body.nextCursor;
      break;
    }
    cur = body.nextCursor;
  }
  return { status: 200, changes, raw, cursor: cur };
}

async function authStatus(token: string): Promise<number> {
  const r = await pull(token, '0', 1);
  if (r.status !== 404) return r.status;
  return (await api('/api/ledger/bootstrap', { token })).status;
}

async function dbRow(table: string, rowId: string): Promise<Json | null> {
  const { data, error } = await admin.from(table).select('*').eq('id', rowId).maybeSingle();
  if (error) throw new Error(`dbRow ${table}: ${error.message}`);
  return (data as Json | null) ?? null;
}

async function insert(table: string, rows: Json[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 550) {
    const { error } = await admin.from(table).insert(rows.slice(i, i + 550));
    if (error) throw new Error(`seed ${table}: ${error.message}`);
  }
}

const groupRow = (gid: string, createdBy: string, extra: Json = {}): Json => ({
  id: gid,
  name: `RT ${gid}`,
  invite_code: `WS-${randomBytes(5).toString('hex').toUpperCase()}`,
  created_by: createdBy,
  hlc: HLC0,
  ...extra,
});

const memberRow = (
  mid: string,
  gid: string,
  userId: string | null,
  email: string | null,
  role: 'admin' | 'member',
  extra: Json = {}
): Json => ({
  id: mid,
  group_id: gid,
  user_id: userId,
  invited_email: email,
  display_name: `RT ${mid}`,
  role,
  claimed_at: userId ? NOW_ISO : null,
  hlc: HLC0,
  ...extra,
});

const payersJson = (p: Array<[string, number | string]>) =>
  p.map(([memberId, v]) => ({ memberId, paidMinor: v, originalPaidMinor: v }));
const splitsJson = (s: Array<[string, number | string]>) =>
  s.map(([memberId, v]) => ({
    memberId,
    included: true,
    owedMinor: v,
    originalOwedMinor: v,
    rawInputValue: v,
    remainderMinor: 0,
  }));

const expenseRow = (
  eid: string,
  gid: string | null,
  amount: number,
  payers: Array<[string, number]>,
  splits: Array<[string, number]>,
  extra: Json = {}
): Json => ({
  id: eid,
  group_id: gid,
  owner_id: null,
  ad_hoc_participants: [],
  title: `RT ${eid}`,
  expense_date: '2026-11-15',
  original_currency: 'INR',
  original_amount_minor: amount,
  group_currency: 'INR',
  amount_minor: amount,
  split_mode: 'exact',
  payers: payersJson(payers),
  splits: splitsJson(splits),
  current_revision_id: `${eid}-rev1`,
  created_by_member_id: payers[0]?.[0] ?? 'none',
  updated_by_member_id: payers[0]?.[0] ?? 'none',
  hlc: HLC0,
  ...extra,
});

function expenseData(
  eid: string,
  gid: string | null,
  amount: number | string,
  payers: Array<[string, number | string]>,
  splits: Array<[string, number | string]>,
  hlc: string,
  over: Json = {}
): Json {
  const by = payers[0]?.[0] ?? 'none';
  return {
    id: eid,
    groupId: gid,
    adHocParticipants: [],
    title: `RT ${eid}`,
    category: 'general',
    tags: [],
    notes: '',
    expenseDate: '2026-11-15',
    originalCurrency: 'INR',
    originalAmountMinor: amount,
    groupCurrency: 'INR',
    amountMinor: amount,
    fxRateScaled: 100000000,
    fxStatus: 'identity',
    fxAuditNote: null,
    splitMode: 'exact',
    rotationSeed: 0,
    payers: payersJson(payers),
    splits: splitsJson(splits),
    currentRevisionId: `${eid}-rev-${hlc.slice(0, 12)}`,
    revisionNumber: 1,
    hasUnresolvedConflict: false,
    conflictRevisionId: null,
    createdByMemberId: by,
    updatedByMemberId: by,
    createdAt: NOW_ISO,
    updatedAt: new Date().toISOString(),
    deletedAt: null,
    hlc,
    comments: [],
    receipts: [],
    ...over,
  };
}

const groupData = (gid: string, hlc: string, over: Json = {}): Json => ({
  id: gid,
  name: `RT ${gid}`,
  description: '',
  category: 'friends',
  baseCurrency: 'INR',
  simplifyDebts: true,
  defaultSplitConfig: null,
  expenseSeq: 0,
  inviteCode: `${gid}-inv`,
  createdAt: NOW_ISO,
  updatedAt: new Date().toISOString(),
  deletedAt: null,
  hlc,
  ...over,
});

const memberData = (
  mid: string,
  gid: string,
  userId: string | null,
  email: string | null,
  role: 'admin' | 'member',
  hlc: string,
  over: Json = {}
): Json => ({
  id: mid,
  groupId: gid,
  userId,
  invitedEmail: email,
  displayName: `RT ${mid}`,
  avatarInitials: 'RT',
  upiId: null,
  role,
  memberOrder: 0,
  joinedAt: NOW_ISO,
  claimedAt: userId ? NOW_ISO : null,
  removedAt: null,
  hlc,
  ...over,
});

const mut = (
  entity: SyncPushMutation['entity'],
  rowId: string,
  op: 'upsert' | 'delete',
  hlc: string,
  data: Json | null
): SyncPushMutation => ({ entity, id: rowId, op, hlc, data });

const quoted = (s: string): string => `"${s}"`;

function signToken(payload: Json, twoPart = false): string {
  const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64url');
  const secret = env('GRANT_TOKEN_SECRET');
  const body = b64(JSON.stringify(payload));
  if (twoPart) {
    return `${body}.${b64(createHmac('sha256', secret).update(body).digest())}`;
  }
  const head = b64(JSON.stringify({ alg: 'HS256', typ: 'WS-JWT' }));
  const input = `${head}.${body}`;
  return `${input}.${b64(createHmac('sha256', secret).update(input).digest())}`;
}

async function createAuthUser(
  key: string,
  opts: { email?: string; confirm?: boolean; profile?: boolean } = {}
): Promise<TUser | null> {
  const email = opts.email ?? `${P}${key}@${DOMAIN}`;
  const password = `Rt!${randomBytes(12).toString('hex')}`;
  const name = `RT User ${key}`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: opts.confirm ?? true,
    user_metadata: { full_name: name },
  });
  if (error || !data.user) return null;
  authIds.push(data.user.id);
  const user: TUser = { key, id: id(`usr-${key}`), email, password, name, authId: data.user.id, token: '' };
  if (opts.profile ?? true) {
    const { error: pErr } = await admin.from('profiles').insert({
      id: user.id,
      email,
      full_name: name,
      avatar_initials: 'RT',
      hlc: HLC0,
    });
    if (pErr) throw new Error(`seed profile ${key}: ${pErr.message}`);
  }
  users[key] = user;
  return user;
}

async function login(email: string, password: string): Promise<ApiRes> {
  return api('/api/auth/login', { body: { email, password } });
}

async function supabaseJwt(email: string, password: string): Promise<string | null> {
  const client = createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data } = await client.auth.signInWithPassword({ email, password });
  return data.session?.access_token ?? null;
}

function resetLimiters(): void {
  const s = sec as unknown as Record<string, unknown>;
  const a = adminMod as unknown as Record<string, unknown>;
  for (const fn of [s.resetRateLimiterForTests, a.resetOwnershipCachesForTests]) {
    if (typeof fn === 'function') (fn as () => void)();
  }
}

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function seed(): Promise<void> {
  for (const key of ['a', 'b', 'm', 'r', 'o', 'd', 'l', 'j']) {
    const email = key === 'j' ? `${P}john@${DOMAIN}` : undefined;
    if (!(await createAuthUser(key, email ? { email } : {}))) throw new Error(`createUser ${key} failed`);
  }
  for (const key of ['a', 'b', 'm', 'r', 'o', 'd', 'l']) {
    const r = await login(u(key).email, u(key).password);
    const token = typeof r.json?.token === 'string' ? r.json.token : '';
    if (r.status !== 200 || !token) throw new Error(`fixture login ${key} failed: ${r.status}`);
    u(key).token = token;
  }

  const a = u('a').id;
  const b = u('b').id;
  const fillerGroups: Json[] = [];
  const fillerMembers: Json[] = [];
  const fillerExpenses: Json[] = [];
  const fillerSettlements: Json[] = [];
  for (let i = 0; i < FILLERS; i++) {
    const fg = id(`fg-${i}`);
    const fm = id(`fm-${i}`);
    fillerGroups.push(groupRow(fg, id(`fc-${Math.floor(i / 50)}`)));
    fillerMembers.push(memberRow(fm, fg, null, null, 'admin'));
    fillerExpenses.push(expenseRow(id(`fe-${i}`), fg, 100, [[fm, 100]], [[fm, 100]]));
    fillerSettlements.push({
      id: id(`fs-${i}`),
      group_id: fg,
      from_member_id: fm,
      to_member_id: `${fm}-to`,
      owner_id: id(`fc-${Math.floor(i / 50)}`),
      amount_minor: 1,
      currency: 'INR',
      settled_date: '2026-11-15',
      hlc: HLC0,
    });
  }
  await insert('groups', [...fillerGroups, groupRow(G.F, b)]);
  await insert('group_members', [...fillerMembers, memberRow(MEM.fB, G.F, b, u('b').email, 'admin')]);
  await insert('expenses', fillerExpenses);
  await insert('settlements', fillerSettlements);
  const bExpenses: Json[] = [];
  for (let i = 0; i < B_ROWS; i++) {
    bExpenses.push(expenseRow(id(`be-${i}`), G.F, 100, [[MEM.fB, 100]], [[MEM.fB, 100]]));
  }
  await insert('expenses', bExpenses);

  await insert('groups', [
    groupRow(G.A, a),
    groupRow(G.R, u('r').id),
    groupRow(G.B, b),
    groupRow(G.H, a),
    groupRow(G.D, u('d').id),
    groupRow(G.S, u('d').id),
    groupRow(G.J, b),
    groupRow(G.JI, b),
    groupRow(G.JU, b),
    groupRow(G.DEMO, sec.DEMO_SANDBOX_USER.userId),
  ]);
  await insert('group_members', [
    memberRow(MEM.aA, G.A, a, u('a').email, 'admin'),
    memberRow(MEM.aM, G.A, u('m').id, u('m').email, 'member'),
    memberRow(MEM.aR, G.A, u('r').id, u('r').email, 'member', { removed_at: NOW_ISO }),
    memberRow(MEM.rR, G.R, u('r').id, u('r').email, 'admin', { removed_at: NOW_ISO }),
    memberRow(MEM.rA, G.R, a, u('a').email, 'admin'),
    memberRow(MEM.bB, G.B, b, u('b').email, 'admin'),
    memberRow(MEM.hA, G.H, a, u('a').email, 'admin'),
    memberRow(MEM.dD, G.D, u('d').id, u('d').email, 'admin', { display_name: u('d').name }),
    memberRow(MEM.dA, G.D, a, u('a').email, 'member'),
    memberRow(MEM.sD, G.S, u('d').id, u('d').email, 'admin'),
    memberRow(MEM.jB, G.J, b, u('b').email, 'admin'),
    memberRow(MEM.jJ, G.J, u('j').id, u('j').email, 'member'),
    memberRow(MEM.jiB, G.JI, b, u('b').email, 'admin'),
    memberRow(MEM.jiJ, G.JI, null, u('j').email, 'member'),
    memberRow(MEM.juB, G.JU, b, u('b').email, 'admin'),
    memberRow(MEM.juJ, G.JU, null, u('j').email, 'member'),
    memberRow(MEM.demo, G.DEMO, sec.DEMO_SANDBOX_USER.userId, sec.DEMO_SANDBOX_USER.email, 'admin'),
  ]);
  const split: Array<[string, number]> = [
    [MEM.aA, 500],
    [MEM.aM, 500],
  ];
  await insert('expenses', [
    expenseRow(EXP.A, G.A, 1000, [[MEM.aA, 1000]], split),
    expenseRow(EXP.A2, G.A, 1000, [[MEM.aA, 1000]], split),
    expenseRow(EXP.C, G.A, 1000, [[MEM.aA, 1000]], split),
    expenseRow(EXP.B, G.B, 400, [[MEM.bB, 400]], [[MEM.bB, 400]]),
    expenseRow(EXP.N, null, 800, [[a, 800]], [[a, 400], [u('m').id, 400]], {
      created_by_member_id: a,
      owner_id: a,
      ad_hoc_participants: [
        { id: a, displayName: 'A', invitedEmail: u('a').email, upiId: null, avatarInitials: 'A', memberOrder: 0 },
        { id: u('m').id, displayName: 'M', invitedEmail: u('m').email, upiId: null, avatarInitials: 'M', memberOrder: 1 },
      ],
    }),
    expenseRow(EXP.D1, G.D, 1000, [[MEM.dD, 1000]], [[MEM.dD, 500], [MEM.dA, 500]]),
    expenseRow(EXP.D2, G.D, 600, [[MEM.dA, 600]], [[MEM.dD, 300], [MEM.dA, 300]]),
    expenseRow(EXP.S, null, 250, [[u('d').id, 250]], [[u('d').id, 250]], {
      created_by_member_id: u('d').id,
      owner_id: u('d').id,
      ad_hoc_participants: [
        { id: u('d').id, displayName: 'D', invitedEmail: u('d').email, upiId: null, avatarInitials: 'D', memberOrder: 0 },
      ],
    }),
  ]);
  await insert('settlements', [
    {
      id: SET_A,
      group_id: G.A,
      from_member_id: MEM.aM,
      to_member_id: MEM.aA,
      owner_id: a,
      amount_minor: 100,
      currency: 'INR',
      settled_date: '2026-11-15',
      hlc: HLC0,
    },
  ]);
}

async function cleanup(): Promise<void> {
  const like = `${P}%`;
  await admin.from('group_activity_log').delete().like('entity_id', like);
  await admin.from('expenses').delete().like('id', like);
  await admin.from('groups').delete().like('id', like);
  await admin.from('profiles').delete().like('id', like);
  await admin.from('profiles').delete().like('email', like);
  await admin.from('quota_usage').delete().like('owner_id', like);
  await admin.from('quota_usage').delete().like('scope_id', like);
  for (const authId of authIds) {
    await admin.from('profiles').delete().eq('id', authId);
    await admin.auth.admin.deleteUser(authId);
  }
}

describe('Red-team regression suite (C1-C4, H1-H5, roles, tokens, CORS, money)', () => {
  // The demo fixture group is created as the shared demo profile; its lifetime quota is given back afterwards.
  const SHARED = [sec.DEMO_SANDBOX_USER.userId];
  let quotaSnapshot: Json[] = [];

  beforeAll(async () => {
    quotaSnapshot = ((await admin.from('quota_usage').select('*').in('owner_id', SHARED)).data ?? []) as Json[];
    server = createServer((req, res) => {
      void handleApiRequest(req, res);
    });
    // H4b blocks the event loop for seconds; with the 5 s default the server can close a pooled
    // keep-alive socket right as the next test reuses it (ECONNRESET in TOK).
    server.keepAliveTimeout = 60_000;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    resetLimiters();
    try {
      await seed();
    } catch (err) {
      await cleanup();
      throw err;
    }
  }, 90_000);

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await cleanup();
    await admin.from('quota_usage').delete().in('owner_id', SHARED);
    if (quotaSnapshot.length) await admin.from('quota_usage').upsert(quotaSnapshot, { onConflict: 'kind,owner_id,scope_id' });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }, 60_000);

  beforeEach(() => {
    resetLimiters();
  });

  describe('C1: cross-tenant writes fail closed', () => {
    it('C1a: pushing an existing foreign expense id into my own group does not take it over (>1000 rows)', async () => {
      const before = await dbRow('expenses', EXP.A);
      const h = nextHlc();
      const r = await push(u('b').token, [
        mut('expense', EXP.A, 'upsert', h,
          expenseData(EXP.A, G.B, 1000, [[MEM.bB, 1000]], [[MEM.bB, 1000]], h, { title: 'HIJACKED' })),
      ]);
      expectRejected(r, EXP.A);
      const after = await dbRow('expenses', EXP.A);
      expect(after?.group_id).toBe(G.A);
      expect(after?.title).toBe(before?.title);
      expect(after?.hlc).toBe(before?.hlc);
    });

    it('C1b: creating an expense or member inside a group I do not belong to is forbidden', async () => {
      const h = nextHlc();
      const newExp = id('exp-b-into-a');
      const newMem = id('mem-b-into-a');
      const r = await push(u('b').token, [
        mut('expense', newExp, 'upsert', h,
          expenseData(newExp, G.A, 1000, [[MEM.aA, 1000]], [[MEM.aA, 1000]], h)),
        mut('group_member', newMem, 'upsert', h,
          memberData(newMem, G.A, u('b').id, u('b').email, 'admin', h)),
      ]);
      expectRejected(r, newExp);
      expectRejected(r, newMem);
      expect(await dbRow('expenses', newExp)).toBeNull();
      expect(await dbRow('group_members', newMem)).toBeNull();
    });

    it('C1c: updating or deleting a foreign group, expense or settlement is forbidden', async () => {
      const h = nextHlc();
      const r = await push(u('b').token, [
        mut('group', G.A, 'upsert', h, groupData(G.A, h, { name: 'PWNED', createdBy: u('b').id })),
        mut('expense', EXP.A2, 'delete', h, null),
        mut('settlement', SET_A, 'upsert', h, {
          id: SET_A, groupId: G.A, batchSettlementId: null, fromMemberId: MEM.aA, toMemberId: MEM.aM,
          amountMinor: 999999, currency: 'INR', paymentMethod: 'cash', paymentReference: null,
          notes: 'pwn', settledDate: '2026-11-15', createdAt: NOW_ISO, deletedAt: null, hlc: h,
        }),
      ]);
      expectRejected(r, G.A);
      expectRejected(r, EXP.A2);
      expectRejected(r, SET_A);
      const g = await dbRow('groups', G.A);
      expect(g?.name).toBe(`RT ${G.A}`);
      expect(g?.created_by).toBe(u('a').id);
      expect(g?.deleted_at).toBeNull();
      expect((await dbRow('expenses', EXP.A2))?.deleted_at).toBeNull();
      expect(Number((await dbRow('settlements', SET_A))?.amount_minor)).toBe(100);
    });

    it('C1d: when ownership lookups error, foreign writes still fail closed', async () => {
      const h = nextHlc();
      const newExp = id('exp-failclosed');
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
        if (url.startsWith(`${SUPABASE_URL}/rest/v1/`) && (method === 'GET' || method === 'HEAD')) {
          return new Response(
            JSON.stringify({ code: 'XX000', message: 'injected read failure', details: null, hint: null }),
            { status: 500, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return realFetch(input, init);
      }) as typeof fetch;
      let r: ApiRes;
      try {
        r = await push(u('b').token, [
          mut('expense', EXP.A, 'upsert', h,
            expenseData(EXP.A, G.B, 1000, [[MEM.bB, 1000]], [[MEM.bB, 1000]], h, { title: 'HIJACKED-FC' })),
          mut('expense', newExp, 'upsert', h,
            expenseData(newExp, G.A, 1000, [[MEM.aA, 1000]], [[MEM.aA, 1000]], h)),
        ]);
      } finally {
        globalThis.fetch = realFetch;
      }
      expect(r.status, r.text.slice(0, 200)).not.toBe(404);
      expect(resultFor(r, EXP.A)?.status).not.toBe('applied');
      expect(resultFor(r, newExp)?.status).not.toBe('applied');
      const after = await dbRow('expenses', EXP.A);
      expect(after?.group_id).toBe(G.A);
      expect(after?.title).toBe(`RT ${EXP.A}`);
      expect(await dbRow('expenses', newExp)).toBeNull();
    });
  });

  describe('C2: hlc ordering, cursor pull, pagination, tombstones', () => {
    it('C2a: a push with an older hlc than the server row is stale and changes nothing', async () => {
      const old = hlcAt(T0 - 60_000);
      const r = await push(u('a').token, [
        mut('expense', EXP.C, 'upsert', old,
          expenseData(EXP.C, G.A, 1000, [[MEM.aA, 1000]], [[MEM.aA, 500], [MEM.aM, 500]], old, { title: 'OLD' })),
      ]);
      expect(r.status, r.text.slice(0, 200)).toBe(200);
      expect(resultFor(r, EXP.C)?.status).toBe('stale');
      const row = await dbRow('expenses', EXP.C);
      expect(row?.title).toBe(`RT ${EXP.C}`);
      expect(row?.hlc).toBe(HLC0);
    });

    it('C2b: pull after a cursor returns rows UPDATED after it, not just inserts', async () => {
      const first = await pullAll(u('a').token, '0');
      expect(first.status, first.raw.slice(0, 200)).toBe(200);
      const h = nextHlc();
      const r = await push(u('a').token, [
        mut('expense', EXP.C, 'upsert', h,
          expenseData(EXP.C, G.A, 1000, [[MEM.aA, 1000]], [[MEM.aA, 500], [MEM.aM, 500]], h, { title: 'C2b updated' })),
      ]);
      expectApplied(r, EXP.C);
      const next = await pullAll(u('a').token, first.cursor);
      const change = next.changes.find((c) => c.id === EXP.C);
      expect(change, 'updated row missing from pull after cursor').toBeDefined();
      expect(change?.deleted).toBe(false);
      expect(JSON.stringify(change?.data)).toContain('C2b updated');
      expect(BigInt(next.cursor) > BigInt(first.cursor)).toBe(true);
    });

    it('C2c: pagination respects limit and nextCursor is strictly monotonic', async () => {
      let cursor = '0';
      const seen = new Set<string>();
      for (let page = 0; page < 3; page++) {
        const r = await pull(u('b').token, cursor, 50);
        expect(r.status, r.text.slice(0, 200)).toBe(200);
        const body = r.json as unknown as SyncPullResponse;
        expect(body.changes.length).toBeLessThanOrEqual(50);
        expect(body.changes.length).toBeGreaterThan(0);
        expect(body.hasMore).toBe(true);
        expect(BigInt(body.nextCursor) > BigInt(cursor)).toBe(true);
        for (const c of body.changes) {
          expect(BigInt(c.serverSeq) > BigInt(cursor)).toBe(true);
          expect(BigInt(c.serverSeq) <= BigInt(body.nextCursor)).toBe(true);
          const key = `${c.entity}:${c.id}:${c.serverSeq}`;
          expect(seen.has(key)).toBe(false);
          seen.add(key);
        }
        cursor = body.nextCursor;
      }
      const huge = await pull(u('b').token, '0', 1_000_000);
      expect(huge.status).toBe(200);
      expect((huge.json as unknown as SyncPullResponse).changes.length).toBeLessThanOrEqual(SYNC_PULL_MAX_LIMIT);
      for (const bad of ['-5', 'abc', '1e9']) {
        const r = await api(`/api/ledger/pull?cursor=0&limit=${bad}`, { token: u('b').token });
        if (r.status === 200) {
          expect((r.json as unknown as SyncPullResponse).changes.length).toBeLessThanOrEqual(SYNC_PULL_MAX_LIMIT);
        } else {
          expect(r.status).toBe(400);
        }
      }
      const badCursor = await api('/api/ledger/pull?cursor=1;drop&limit=5', { token: u('b').token });
      expect([200, 400]).toContain(badCursor.status);
    });

    it('C2d: soft delete comes back as deleted:true and a stale device cannot resurrect it', async () => {
      const first = await pullAll(u('a').token, '0');
      expect(first.status).toBe(200);
      const hDel = nextHlc();
      const del = await push(u('a').token, [mut('expense', EXP.A2, 'delete', hDel, null)]);
      expectApplied(del, EXP.A2);
      const next = await pullAll(u('a').token, first.cursor);
      const tomb = next.changes.find((c) => c.id === EXP.A2);
      expect(tomb?.deleted).toBe(true);
      expect((await dbRow('expenses', EXP.A2))?.deleted_at).not.toBeNull();

      const stale = hlcAt(T0 + 1000);
      const res = await push(u('a').token, [
        mut('expense', EXP.A2, 'upsert', stale,
          expenseData(EXP.A2, G.A, 1000, [[MEM.aA, 1000]], [[MEM.aA, 500], [MEM.aM, 500]], stale, { title: 'ZOMBIE' })),
      ]);
      expect(res.status).toBe(200);
      expect(resultFor(res, EXP.A2)?.status).toBe('stale');
      const row = await dbRow('expenses', EXP.A2);
      expect(row?.deleted_at).not.toBeNull();
      expect(row?.title).not.toBe('ZOMBIE');
    });
  });

  describe('C3: demo in production, payload limits, oversized fields', () => {
    it('C3a: in production /api/auth/demo is disabled and demo sessions cannot write', async () => {
      const demoDev = await api('/api/auth/demo', { body: {} });
      const demoToken =
        typeof demoDev.json?.token === 'string'
          ? demoDev.json.token
          : signToken({
              userId: sec.DEMO_SANDBOX_USER.userId,
              email: sec.DEMO_SANDBOX_USER.email,
              authMethod: 'demo',
              iat: Math.floor(Date.now() / 1000),
              exp: Math.floor(Date.now() / 1000) + 3600,
            });
      const newExp = id('exp-demo-prod');
      await withEnv({ NODE_ENV: 'production' }, async () => {
        const demo = await api('/api/auth/demo', { body: {} });
        expect([403, 404, 410]).toContain(demo.status);
        expect(demo.json?.token).toBeUndefined();
        const h = nextHlc();
        const r = await push(demoToken, [
          mut('expense', newExp, 'upsert', h,
            expenseData(newExp, G.DEMO, 100, [[MEM.demo, 100]], [[MEM.demo, 100]], h)),
        ]);
        expectRejected(r, newExp);
      });
      expect(await dbRow('expenses', newExp)).toBeNull();
    });

    it('C3b: request bodies over ~256 KB are rejected with 413', async () => {
      const h = nextHlc();
      const eid = id('exp-413');
      const big = expenseData(eid, G.A, 1000, [[MEM.aA, 1000]], [[MEM.aA, 1000]], h, {
        notes: 'z'.repeat(400_000),
      });
      const r = await push(u('a').token, [mut('expense', eid, 'upsert', h, big)]);
      expect(r.status).toBe(413);
      expect(await dbRow('expenses', eid)).toBeNull();
      const login413 = await api('/api/auth/login', {
        rawBody: JSON.stringify({ email: 'x@rt.test', password: 'p'.repeat(400_000) }),
      });
      expect(login413.status).toBe(413);
    });

    it('C3c: oversized strings and jsonb inside a small body are rejected by the API', async () => {
      const h = nextHlc();
      const eid = id('exp-longtitle');
      const gid = id('g-bigjson');
      const r1 = await push(u('a').token, [
        mut('expense', eid, 'upsert', h,
          expenseData(eid, G.A, 1000, [[MEM.aA, 1000]], [[MEM.aA, 1000]], h, { title: 'x'.repeat(20_000) })),
      ]);
      expectInvalid(r1, eid);
      const r2 = await push(u('a').token, [
        mut('group', gid, 'upsert', h, groupData(gid, h, { defaultSplitConfig: { blob: randomBytes(60_000).toString('hex') } })),
      ]);
      expectInvalid(r2, gid);
      expect(await dbRow('expenses', eid)).toBeNull();
      expect(await dbRow('groups', gid)).toBeNull();
    });

    it('C3d: DB CHECK constraints reject oversized text and jsonb even for service_role', async () => {
      const cases: Array<[string, Json]> = [
        ['expenses', expenseRow(id('exp-chk-title'), G.A, 100, [[MEM.aA, 100]], [[MEM.aA, 100]], { title: 'x'.repeat(100_000) })],
        ['groups', groupRow(id('g-chk-name'), u('a').id, { name: 'n'.repeat(100_000) })],
        ['groups', groupRow(id('g-chk-json'), u('a').id, { default_split_config: { blob: randomBytes(300_000).toString('hex') } })],
        ['expenses', expenseRow(id('exp-chk-payers'), G.A, 100, [[MEM.aA, 100]], [[MEM.aA, 100]], {
          payers: Array.from({ length: 20_000 }, (_, i) => ({ memberId: `m${i}`, paidMinor: 0, originalPaidMinor: 0 })),
        })],
      ];
      for (const [table, row] of cases) {
        const { error } = await admin.from(table).insert(row);
        expect(error, `${table} ${String(row.id)} accepted an oversized value`).not.toBeNull();
        expect(await dbRow(table, String(row.id))).toBeNull();
      }
    });
  });

  describe('C4: pull and bootstrap tenant isolation', () => {
    const aOnly = (): string[] => [G.A, G.R, G.H, G.D, EXP.A, EXP.A2, EXP.C, EXP.N, EXP.D1, EXP.D2, SET_A, MEM.aA, MEM.aM, MEM.rA];

    it('C4a: tenant B full pull never contains a row from a group B is not in', async () => {
      const all = await pullAll(u('b').token, '0');
      expect(all.status, all.raw.slice(0, 200)).toBe(200);
      expect(all.changes.length).toBeGreaterThan(B_ROWS);
      expect(all.raw).not.toContain(quoted(id('fe-0')));
      for (const forbidden of aOnly()) expect(all.raw).not.toContain(quoted(forbidden));
      const allowed = new Set([G.B, G.F, G.J, G.JI, G.JU]);
      for (const c of all.changes) {
        const d = c.data ?? {};
        const gid = c.entity === 'group' ? c.id : (d.groupId ?? d.group_id ?? null);
        expect(allowed.has(String(gid)), `leaked ${c.entity} ${c.id} of group ${String(gid)}`).toBe(true);
      }
    });

    it('C4b: an outsider with no groups gets nothing, and bootstrap is scoped too', async () => {
      const all = await pullAll(u('o').token, '0');
      expect(all.status).toBe(200);
      for (const forbidden of [...aOnly(), G.B, G.F, EXP.B]) expect(all.raw).not.toContain(quoted(forbidden));
      expect(all.changes.filter((c) => c.entity === 'group')).toHaveLength(0);
      const boot = await api('/api/ledger/bootstrap', { token: u('b').token });
      if (boot.status === 200) {
        for (const forbidden of aOnly()) expect(boot.text).not.toContain(quoted(forbidden));
      } else {
        expect([401, 403, 404, 410]).toContain(boot.status);
      }
    });

    it('C4c: response size is bounded by limit', async () => {
      const r = await pull(u('b').token, '0', 1);
      expect(r.status).toBe(200);
      const body = r.json as unknown as SyncPullResponse;
      expect(body.changes.length).toBe(1);
      expect(body.hasMore).toBe(true);
      expect(r.text.length).toBeLessThan(64 * 1024);
    });
  });

  describe('Non-group expenses', () => {
    it('NG: only participants can read or modify a non-group expense', async () => {
      const mAll = await pullAll(u('m').token, '0');
      expect(mAll.status).toBe(200);
      expect(mAll.raw).toContain(quoted(EXP.N));
      for (const attacker of ['b', 'o']) {
        const all = await pullAll(u(attacker).token, '0');
        expect(all.raw).not.toContain(quoted(EXP.N));
        const h = nextHlc();
        const data = expenseData(EXP.N, null, 800, [[u(attacker).id, 800]], [[u(attacker).id, 800]], h, {
          title: 'NG PWN',
          adHocParticipants: [
            { id: u(attacker).id, displayName: 'X', invitedEmail: u(attacker).email, upiId: null, avatarInitials: 'X', memberOrder: 0 },
          ],
        });
        expectRejected(await push(u(attacker).token, [mut('expense', EXP.N, 'upsert', h, data)]), EXP.N);
        expectRejected(await push(u(attacker).token, [mut('expense', EXP.N, 'delete', nextHlc(), null)]), EXP.N);
      }
      const row = await dbRow('expenses', EXP.N);
      expect(row?.title).toBe(`RT ${EXP.N}`);
      expect(row?.deleted_at).toBeNull();
    });
  });

  describe('Removed members and roles', () => {
    it('RM: a removed member, including a removed group creator, cannot read or write the group', async () => {
      const all = await pullAll(u('r').token, '0');
      expect(all.status).toBe(200);
      for (const forbidden of [G.A, G.R, EXP.A, EXP.C, SET_A, MEM.aA, MEM.rA]) {
        expect(all.raw).not.toContain(quoted(forbidden));
      }
      const h = nextHlc();
      const newExp = id('exp-removed');
      const r = await push(u('r').token, [
        mut('expense', newExp, 'upsert', h, expenseData(newExp, G.A, 100, [[MEM.aR, 100]], [[MEM.aR, 100]], h)),
        mut('group', G.R, 'upsert', h, groupData(G.R, h, { name: 'REMOVED CREATOR RENAME' })),
        mut('group_member', MEM.rR, 'upsert', h, memberData(MEM.rR, G.R, u('r').id, u('r').email, 'admin', h)),
      ]);
      expectRejected(r, newExp);
      expectRejected(r, G.R);
      expectRejected(r, MEM.rR);
      expect(await dbRow('expenses', newExp)).toBeNull();
      expect((await dbRow('groups', G.R))?.name).toBe(`RT ${G.R}`);
      expect((await dbRow('group_members', MEM.rR))?.removed_at).not.toBeNull();
    });

    it('ROLE: a plain member cannot remove others, promote themself or delete the group', async () => {
      const m = u('m');
      const h1 = nextHlc();
      const r1 = await push(m.token, [
        mut('group_member', MEM.aA, 'delete', h1, null),
        mut('group', G.A, 'delete', h1, null),
      ]);
      expectRejected(r1, MEM.aA);
      expectRejected(r1, G.A);
      const h2 = nextHlc();
      const r2 = await push(m.token, [
        mut('group_member', MEM.aA, 'upsert', h2,
          memberData(MEM.aA, G.A, u('a').id, u('a').email, 'admin', h2, { removedAt: new Date().toISOString() })),
      ]);
      expectRejected(r2, MEM.aA);
      const h3 = nextHlc();
      const r3 = await push(m.token, [
        mut('group_member', MEM.aM, 'upsert', h3, memberData(MEM.aM, G.A, m.id, m.email, 'admin', h3)),
      ]);
      expect(r3.status).not.toBe(404);
      expect(resultFor(r3, MEM.aM)?.status ?? 'rejected').not.toBe('applied');
      const aRow = await dbRow('group_members', MEM.aA);
      expect(aRow?.removed_at).toBeNull();
      expect(aRow?.user_id).toBe(u('a').id);
      expect((await dbRow('group_members', MEM.aM))?.role).toBe('member');
      expect((await dbRow('groups', G.A))?.deleted_at).toBeNull();
    });

    it('ROLE: created_by never changes through sync, even when the admin pushes it', async () => {
      const h = nextHlc();
      const r = await push(u('a').token, [
        mut('group', G.H, 'upsert', h,
          groupData(G.H, h, { name: 'RT renamed', createdBy: u('m').id, created_by: u('m').id })),
      ]);
      expect(r.status).not.toBe(404);
      expect((await dbRow('groups', G.H))?.created_by).toBe(u('a').id);
    });
  });

  describe('Money', () => {
    it('MONEY: sum(payers) != amount or sum(splits) != amount is rejected', async () => {
      const h = nextHlc();
      const e1 = id('exp-badpayers');
      const e2 = id('exp-badsplits');
      const r = await push(u('a').token, [
        mut('expense', e1, 'upsert', h, expenseData(e1, G.A, 1000, [[MEM.aA, 999]], [[MEM.aA, 500], [MEM.aM, 500]], h)),
        mut('expense', e2, 'upsert', h, expenseData(e2, G.A, 1000, [[MEM.aA, 1000]], [[MEM.aA, 500], [MEM.aM, 499]], h)),
      ]);
      expectInvalid(r, e1);
      expectInvalid(r, e2);
      expect(await dbRow('expenses', e1)).toBeNull();
      expect(await dbRow('expenses', e2)).toBeNull();
    });

    it('MONEY: amounts above 2^53-1 are rejected, never rounded', async () => {
      const eid = id('exp-big');
      const h = nextHlc();
      const asStrings = expenseData(eid, G.A, BIG, [[MEM.aA, BIG]], [[MEM.aA, BIG_HALF_A], [MEM.aM, BIG_HALF_B]], h);
      expectInvalid(await push(u('a').token, [mut('expense', eid, 'upsert', h, asStrings)]), eid);
      const raw = JSON.stringify({ mutations: [mut('expense', eid, 'upsert', h, asStrings)] })
        .replaceAll(`"${BIG}"`, BIG)
        .replaceAll(`"${BIG_HALF_A}"`, BIG_HALF_A)
        .replaceAll(`"${BIG_HALF_B}"`, BIG_HALF_B);
      expectInvalid(await api('/api/ledger/push', { token: u('a').token, rawBody: raw }), eid);
      expect(await dbRow('expenses', eid)).toBeNull();
    });

    it('MONEY: 2^53-1 survives push, DB and pull exactly', async () => {
      const eid = id('exp-maxsafe');
      const first = await pullAll(u('a').token, '0');
      const h = nextHlc();
      const data = expenseData(eid, G.A, MAX_SAFE, [[MEM.aA, MAX_SAFE]], [[MEM.aA, MAX_SAFE_HALF_A], [MEM.aM, MAX_SAFE_HALF_B]], h);
      expectApplied(await push(u('a').token, [mut('expense', eid, 'upsert', h, data)]), eid);
      const { data: dbData, error } = await admin
        .from('expenses')
        .select('amt:amount_minor::text, splits_text:splits::text')
        .eq('id', eid)
        .single();
      expect(error).toBeNull();
      const row = dbData as unknown as { amt: string; splits_text: string };
      expect(row.amt).toBe(MAX_SAFE);
      expect(row.splits_text).toContain(MAX_SAFE_HALF_A);
      const next = await pullAll(u('a').token, first.cursor);
      expect(next.changes.find((c) => c.id === eid)).toBeDefined();
      expect(next.raw).toContain(MAX_SAFE);
    });
  });

  describe('H1: exact email matching', () => {
    it('H1a: j_hn and jo% addresses cannot authenticate as john or claim his invites', async () => {
      const j = u('j');
      const attackers: TUser[] = [];
      for (const [key, email] of [
        ['w1', `${P}j_hn@${DOMAIN}`],
        ['w2', `${P}jo%@${DOMAIN}`],
      ] as const) {
        const w = await createAuthUser(key, { email, profile: false });
        if (w) attackers.push(w);
      }
      expect(attackers.length).toBeGreaterThan(0);
      const jGroups = [G.J, G.JI, G.JU];
      for (const w of attackers) {
        const lr = await login(w.email, w.password);
        if (lr.status === 200) {
          const prof = lr.json?.profile as Json | undefined;
          expect(prof?.id).not.toBe(j.id);
          expect(String(prof?.email).toLowerCase()).toBe(w.email.toLowerCase());
        } else {
          expect([401, 403]).toContain(lr.status);
        }
        const jwt = await supabaseJwt(w.email, w.password);
        if (!jwt) continue;
        const direct = await pullAll(jwt, '0');
        for (const g of jGroups) expect(direct.raw).not.toContain(quoted(g));
        const gr = await api('/api/auth/google', { body: { accessToken: jwt } });
        if (gr.status === 200) {
          const prof = gr.json?.profile as Json | undefined;
          expect(prof?.id).not.toBe(j.id);
          for (const g of jGroups) expect(gr.text).not.toContain(quoted(g));
          const tok = typeof gr.json?.token === 'string' ? gr.json.token : '';
          if (tok) {
            const viaTok = await pullAll(tok, '0');
            for (const g of jGroups) expect(viaTok.raw).not.toContain(quoted(g));
          }
        }
      }
      expect((await dbRow('group_members', MEM.jiJ))?.user_id).toBeNull();
      expect((await dbRow('group_members', MEM.juJ))?.user_id).toBeNull();
    });

    it('H1b: mixed case matches only the same address', async () => {
      const j = u('j');
      const lr = await login(j.email.toUpperCase(), j.password);
      expect(lr.status).toBe(200);
      expect((lr.json?.profile as Json | undefined)?.id).toBe(j.id);
      const tok = String(lr.json?.token ?? '');
      const all = await pullAll(tok, '0');
      expect(all.status).toBe(200);
      for (const g of [G.J, G.JI, G.JU]) expect(all.raw).toContain(quoted(g));
    });
  });

  describe('H2: identity verification', () => {
    it('H2a: a Supabase user with an unconfirmed email is rejected and cannot claim invites', async () => {
      const un = await createAuthUser('u', { confirm: false });
      expect(un).not.toBeNull();
      if (!un) return;
      await insert('group_members', [memberRow(MEM.aU, G.A, null, un.email, 'member')]);
      const lr = await login(un.email, un.password);
      expect([401, 403]).toContain(lr.status);
      const jwt = await supabaseJwt(un.email, un.password);
      if (jwt) {
        const gr = await api('/api/auth/google', { body: { accessToken: jwt } });
        expect([401, 403]).toContain(gr.status);
        expect([401, 403]).toContain(await authStatus(jwt));
      }
      expect((await dbRow('group_members', MEM.aU))?.user_id).toBeNull();
    });

    it('H2b: a JWT with no wise_spliter profile and no invite gets nothing', async () => {
      const n = await createAuthUser('n', { profile: false });
      expect(n).not.toBeNull();
      if (!n) return;
      const jwt = await supabaseJwt(n.email, n.password);
      expect(jwt).not.toBeNull();
      if (!jwt) return;
      const r = await pull(jwt, '0', SYNC_PULL_MAX_LIMIT);
      expect(r.status).not.toBe(404);
      if (r.status === 200) {
        expect((r.json as unknown as SyncPullResponse).changes).toHaveLength(0);
      } else {
        expect([401, 403]).toContain(r.status);
      }
      const boot = await api('/api/ledger/bootstrap', { token: jwt });
      if (boot.status === 200) {
        const ds = boot.json?.dataset as { groups?: unknown[]; expenses?: unknown[] } | undefined;
        expect(ds?.groups ?? []).toHaveLength(0);
        expect(ds?.expenses ?? []).toHaveLength(0);
      }
    });
  });

  describe('H3: direct PostgREST access is denied', () => {
    const TABLES = [
      'profiles', 'groups', 'group_members', 'expenses',
      'expense_revisions', 'settlements', 'group_activity_log', 'receipt_attachments',
    ];

    async function rest(path: string, key: string, bearer: string, init: RequestInit = {}) {
      const res = await realFetch(`${SUPABASE_URL}/rest/v1/${path}`, {
        ...init,
        headers: {
          apikey: key,
          Authorization: `Bearer ${bearer}`,
          'Accept-Profile': SCHEMA,
          'Content-Profile': SCHEMA,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
          ...(init.headers as Record<string, string> | undefined),
        },
      });
      const text = await res.text();
      return { status: res.status, text };
    }

    const denied = (r: { status: number; text: string }) =>
      r.status >= 400 || r.text.trim() === '[]' || r.text.trim() === '';

    it('H3: anon and authenticated roles cannot select, insert, update, delete or call RPCs', async () => {
      const jwtA = await supabaseJwt(u('a').email, u('a').password);
      expect(jwtA).not.toBeNull();
      const roles: Array<[string, string, string]> = [
        ['anon', ANON_KEY, ANON_KEY],
        ['authenticated', PUBLISHABLE_KEY, jwtA ?? ''],
      ];
      const leaks: string[] = [];
      for (const [role, key, bearer] of roles) {
        for (const t of TABLES) {
          const r = await rest(`${t}?select=*&limit=5`, key, bearer);
          if (!denied(r)) leaks.push(`${role} select ${t}: ${r.status}`);
        }
        const gSel = await rest(`groups?select=id&id=eq.${G.H}`, key, bearer);
        if (!denied(gSel)) leaks.push(`${role} select own group: ${gSel.status}`);
        const insId = id(`h3-${role}`);
        const ins = await rest('groups', key, bearer, {
          method: 'POST',
          body: JSON.stringify(groupRow(insId, u('a').id)),
        });
        if ((await dbRow('groups', insId)) !== null) leaks.push(`${role} insert groups: ${ins.status}`);
        await rest(`groups?id=eq.${G.H}`, key, bearer, {
          method: 'PATCH',
          body: JSON.stringify({ name: `H3 ${role}` }),
        });
        await rest(`group_members?id=eq.${MEM.hA}`, key, bearer, {
          method: 'PATCH',
          body: JSON.stringify({ role: 'member' }),
        });
        await rest(`groups?id=eq.${G.H}`, key, bearer, { method: 'DELETE' });
        const gh = await dbRow('groups', G.H);
        if (!gh) leaks.push(`${role} delete groups`);
        else if (String(gh.name).startsWith('H3')) leaks.push(`${role} update groups`);
        if ((await dbRow('group_members', MEM.hA))?.role !== 'admin') leaks.push(`${role} update group_members`);
        for (const fn of ['schema_health', 'pull_changes', 'push_mutations']) {
          const r = await rest(`rpc/${fn}`, key, bearer, { method: 'POST', body: '{}' });
          if (r.status < 400) leaks.push(`${role} rpc ${fn}: ${r.status}`);
        }
        const openapi = await rest('', key, bearer, { headers: { Accept: 'application/openapi+json' } });
        if (openapi.status < 400) {
          const doc = JSON.parse(openapi.text) as { paths?: Record<string, unknown> };
          const exposed = Object.keys(doc.paths ?? {}).filter((p) => p !== '/');
          if (exposed.length > 0) leaks.push(`${role} openapi exposes ${exposed.slice(0, 6).join(',')}`);
        }
      }
      expect(leaks).toEqual([]);
    });
  });

  describe('H4: login rate limiting', () => {
    it('H4a: spoofed X-Forwarded-For cannot bypass the login limiter when TRUST_PROXY is unset', async () => {
      await withEnv({ TRUST_PROXY: undefined, AUTH_RATE_LIMIT_MAX: '3', RATE_LIMIT_DISABLED: undefined }, async () => {
        resetLimiters();
        const statuses: number[] = [];
        for (let i = 1; i <= 5; i++) {
          const r = await api('/api/auth/login', {
            body: { email: `${P}nobody@${DOMAIN}`, password: 'wrong-password' },
            headers: { 'X-Forwarded-For': `198.51.100.${i}` },
          });
          statuses.push(r.status);
        }
        expect(statuses).toContain(429);
        expect(statuses.indexOf(429)).toBeLessThanOrEqual(3);
      });
      resetLimiters();
    });

    it('H4b: limiter state stays bounded under a flood of unique keys', () => {
      const rec = (sec as unknown as Record<string, unknown>).recordAuthLoginFailure;
      expect(typeof rec, 'recordAuthLoginFailure export is needed to measure limiter memory').toBe('function');
      if (typeof rec !== 'function') return;
      setFlagsFromString('--expose-gc');
      const gc = runInNewContext('gc') as () => void;
      const record = rec as (req: unknown, email: string) => void;
      const fakeReq = (i: number) => ({
        headers: { 'x-forwarded-for': `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}` },
        socket: { remoteAddress: '203.0.113.7' },
      });
      resetLimiters();
      gc();
      gc();
      const before = process.memoryUsage().heapUsed;
      for (let i = 0; i < 150_000; i++) record(fakeReq(i), `${P}flood${i}@${DOMAIN}`);
      gc();
      gc();
      const retained = process.memoryUsage().heapUsed - before;
      resetLimiters();
      expect(retained).toBeLessThan(8 * 1024 * 1024);
    }, 30_000);
  });

  describe('Token hygiene', () => {
    it('TOK: tokens without exp, 2-part tokens, expired tokens and tokens used after logout get 401', async () => {
      const a = u('a');
      expect(await authStatus(a.token)).toBe(200);
      const nowSec = Math.floor(Date.now() / 1000);
      const base = { userId: a.id, email: a.email, authMethod: 'password' };
      expect(await authStatus(signToken({ ...base, iat: nowSec })), 'token without exp').toBe(401);
      expect(await authStatus(signToken({ ...base, iat: nowSec, exp: nowSec + 3600 }, true)), '2-part token').toBe(401);
      expect(await authStatus(signToken({ ...base, iat: nowSec - 7200, exp: nowSec - 60 })), 'expired token').toBe(401);
      const l = u('l');
      expect(await authStatus(l.token)).toBe(200);
      const out = await api('/api/auth/logout', {
        method: 'POST',
        token: l.token,
        headers: { Cookie: `ws_session=${encodeURIComponent(l.token)}` },
      });
      expect(out.status).toBe(200);
      expect(await authStatus(l.token), 'token after logout').toBe(401);
    });
  });

  describe('CORS', () => {
    it('CORS: in production http://localhost is not an allowed origin', async () => {
      await withEnv(
        { NODE_ENV: 'production', ALLOWED_ORIGINS: 'https://app.redteam.test', DISABLE_NATIVE_ORIGINS: undefined },
        async () => {
          for (const origin of ['http://localhost', 'http://localhost:4173', 'http://127.0.0.1:4173']) {
            const pre = await api('/api/ledger/pull', { method: 'OPTIONS', headers: { Origin: origin } });
            expect(pre.status, `preflight ${origin}`).toBe(403);
            const post = await api('/api/auth/logout', { method: 'POST', body: {}, headers: { Origin: origin } });
            expect(post.status, `POST ${origin}`).toBe(403);
            expect(post.headers.get('access-control-allow-origin')).not.toBe(origin);
          }
        }
      );
    });
  });

  describe('H5: account deletion', () => {
    it('H5: delete anonymizes, keeps balances, drops solo data, kills tokens, keeps auth.users', async () => {
      const d = u('d');
      const before = { d1: await dbRow('expenses', EXP.D1), d2: await dbRow('expenses', EXP.D2) };
      const r = await api('/api/account/delete', { method: 'POST', token: d.token, body: {} });
      expect(r.status, r.text.slice(0, 200)).toBe(204);

      const mem = await dbRow('group_members', MEM.dD);
      expect(mem, 'member row must survive to keep balances').not.toBeNull();
      expect(mem?.user_id).not.toBe(d.id);
      expect(String(mem?.invited_email ?? '').toLowerCase()).not.toBe(d.email.toLowerCase());
      expect(mem?.display_name).not.toBe(d.name);

      const net = new Map<string, bigint>();
      for (const eid of [EXP.D1, EXP.D2]) {
        const row = await dbRow('expenses', eid);
        expect(row?.deleted_at ?? null).toBeNull();
        const prev = eid === EXP.D1 ? before.d1 : before.d2;
        expect(row?.payers).toEqual(prev?.payers);
        expect(row?.splits).toEqual(prev?.splits);
        for (const p of (row?.payers ?? []) as Array<{ memberId: string; paidMinor: number }>) {
          net.set(p.memberId, (net.get(p.memberId) ?? 0n) + BigInt(p.paidMinor));
        }
        for (const s of (row?.splits ?? []) as Array<{ memberId: string; owedMinor: number }>) {
          net.set(s.memberId, (net.get(s.memberId) ?? 0n) - BigInt(s.owedMinor));
        }
      }
      expect([...net.values()].reduce((x, y) => x + y, 0n)).toBe(0n);
      expect(net.get(MEM.dA)).toBe(-200n);

      const solo = await dbRow('expenses', EXP.S);
      expect(solo === null || solo.deleted_at !== null).toBe(true);
      const soloGroup = await dbRow('groups', G.S);
      expect(soloGroup === null || soloGroup.deleted_at !== null).toBe(true);

      const { data: profs } = await admin.from('profiles').select('id').eq('email', d.email);
      expect(profs ?? []).toHaveLength(0);

      expect(await authStatus(d.token)).toBe(401);
      const { data: authUser } = await admin.auth.admin.getUserById(d.authId);
      expect(authUser.user?.id).toBe(d.authId);
    });
  });
});
