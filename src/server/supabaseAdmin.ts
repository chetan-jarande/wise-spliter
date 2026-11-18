/**
 * Server-only Supabase admin access for Wise-Spliter. `SUPABASE_SECRET_KEY` bypasses RLS, so every
 * tenant decision lives in the SECURITY DEFINER RPCs of migration 0004, called with the verified
 * actor id. Any database error throws DbUnavailable so callers fail closed.
 */

import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import type { MockLedgerDataset, UserProfile } from '../types/ledger';
import type { SyncEntityType, SyncPullChange, SyncPullResponse, SyncPushResult } from '../types/sync-contract';
import { fromDbRow, toDbRow, type ValidatedMutation } from './syncRows';

export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`[config] Missing required env var ${name}. Set it in .env.development (see .env.example).`);
  }
  return value;
}

export const SUPABASE_URL = requireEnv('SUPABASE_URL').replace(/\/+$/, '');
export const SUPABASE_SECRET_KEY = requireEnv('SUPABASE_SECRET_KEY');
export const SUPABASE_SCHEMA = (process.env.SUPABASE_SCHEMA || 'wise_spliter').trim();

export class DbUnavailable extends Error {
  constructor(context: string, cause?: { message?: string; code?: string } | null) {
    super(`database unavailable: ${context}`);
    this.name = 'DbUnavailable';
    if (cause) console.error(`[wise-spliter-api] ${context}:`, cause.code ?? '', cause.message ?? '');
  }
}

function createAdminClient() {
  return createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    db: { schema: SUPABASE_SCHEMA as 'wise_spliter' },
  });
}

let adminClient: ReturnType<typeof createAdminClient> | null = null;

export function getSupabaseAdmin(): ReturnType<typeof createAdminClient> {
  adminClient ??= createAdminClient();
  return adminClient;
}

export async function checkSupabaseSchemaHealth(): Promise<{ reachable: boolean }> {
  try {
    const { data, error } = await getSupabaseAdmin().rpc('schema_health');
    return { reachable: !error && Boolean(data) };
  } catch {
    return { reachable: false };
  }
}

const PROFILE_COLS = 'id, email, full_name, avatar_initials, default_currency, upi_id, google_connected, token_version';

interface ProfileRow {
  id: string;
  email: string;
  full_name: string;
  avatar_initials: string | null;
  default_currency: string | null;
  upi_id: string | null;
  google_connected: boolean | null;
  token_version: number;
}

export interface SessionProfile {
  profile: UserProfile;
  tokenVersion: number;
}

function toSessionProfile(row: ProfileRow): SessionProfile {
  return {
    tokenVersion: Number(row.token_version ?? 0),
    profile: {
      id: row.id,
      email: row.email,
      fullName: row.full_name,
      avatarInitials: row.avatar_initials || 'US',
      defaultCurrency: row.default_currency || 'INR',
      upiId: row.upi_id || '',
      googleConnected: Boolean(row.google_connected ?? false),
      supabaseSchema: SUPABASE_SCHEMA,
      syncState: 'synced',
      lastSyncedAt: new Date().toISOString(),
    },
  };
}

async function selectProfile(column: 'id' | 'auth_user_id' | 'email', value: string, unbound = false): Promise<SessionProfile | null> {
  let q = getSupabaseAdmin().from('profiles').select(PROFILE_COLS).eq(column, value);
  if (unbound) q = q.is('auth_user_id', null);
  const { data, error } = await q.maybeSingle();
  if (error) throw new DbUnavailable('profile lookup', error);
  return data ? toSessionProfile(data as ProfileRow) : null;
}

export const getProfileById = (id: string): Promise<SessionProfile | null> => selectProfile('id', id);

export async function bumpTokenVersion(id: string, current: number): Promise<void> {
  const { error } = await getSupabaseAdmin()
    .from('profiles')
    .update({ token_version: (current + 1) % 2_000_000_000 })
    .eq('id', id)
    .eq('token_version', current);
  if (error) throw new DbUnavailable('token revocation', error);
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const raw = parts.length >= 2 ? `${parts[0]![0] ?? ''}${parts[parts.length - 1]![0] ?? ''}` : name.trim().slice(0, 2);
  return raw.toUpperCase() || 'US';
}

/**
 * Maps a verified Supabase auth user to a wise_spliter profile: by auth_user_id first, then by an
 * exact lowercase email on a profile that is not yet bound (and binds it). Creates a profile only
 * when `create` is set (Google sign-up); password logins of users from other apps get null.
 */
export async function resolveProfileForAuthUser(u: {
  authUid: string;
  email: string;
  fullName?: string;
  create: boolean;
}): Promise<SessionProfile | null> {
  const email = u.email.trim().toLowerCase();
  const bound = await selectProfile('auth_user_id', u.authUid);
  if (bound) return bound.profile.email === email ? bound : null;

  const legacy = await selectProfile('email', email, true);
  if (legacy) {
    const { error } = await getSupabaseAdmin()
      .from('profiles')
      .update({ auth_user_id: u.authUid, ...(u.create ? { google_connected: true } : {}) })
      .eq('id', legacy.profile.id)
      .is('auth_user_id', null);
    if (error) throw new DbUnavailable('profile bind', error);
    return legacy;
  }
  if (!u.create) return null;

  const fullName = (u.fullName?.trim() || email.split('@')[0] || 'Wise-Spliter User').slice(0, 100);
  const { data, error } = await getSupabaseAdmin()
    .from('profiles')
    .insert({
      id: u.authUid,
      auth_user_id: u.authUid,
      email,
      full_name: fullName,
      avatar_initials: initialsOf(fullName),
      google_connected: true,
      hlc: `${Date.now().toString(16).padStart(12, '0')}-0000-${u.authUid}`,
    })
    .select(PROFILE_COLS)
    .single();
  if (error) throw new DbUnavailable('profile create', error);
  return toSessionProfile(data as ProfileRow);
}

export class DbForbidden extends Error {}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await getSupabaseAdmin().rpc(fn, args);
  if (error?.code === '42501') throw new DbForbidden(fn);
  if (error) throw new DbUnavailable(fn, error);
  return data as T;
}

export const claimMembers = (actor: string): Promise<number> => rpc<number>('claim_members', { p_actor: actor });

export const deleteAccount = (actor: string): Promise<unknown> => rpc('delete_account', { p_actor: actor });

export class PushBusy extends Error {}

export async function pushMutations(actor: string, mutations: ValidatedMutation[]): Promise<SyncPushResult[]> {
  if (mutations.length === 0) return [];
  const res = await rpc<{ results?: Array<Omit<SyncPushResult, 'server'> & { server?: Record<string, unknown> }>; busy?: boolean }>(
    'push_mutations', { p_actor: actor, p_mutations: mutations });
  if (res.busy) throw new PushBusy();
  return (res.results ?? []).map(({ server, ...r }) =>
    server ? { ...r, server: { hlc: String(server.hlc), data: fromDbRow('expense', server) ?? {} } } : r);
}

export type JoinGroupResult =
  | { groupId: string; memberId: string; status: 'joined' | 'claimed' | 'rejoined' | 'already_member'; error?: undefined }
  | { error: 'not_found' | 'locked' | 'group_full' | 'removed_by_admin' };

export const joinGroup = (actor: string, code: string): Promise<JoinGroupResult> =>
  rpc<JoinGroupResult>('join_group', { p_actor: actor, p_code: code });

export async function pullChanges(
  actor: string,
  cursor: string,
  limit: number,
  scope: { groupId?: string | null; expenseId?: string | null } = {}
): Promise<SyncPullResponse> {
  const res = await rpc<{
    changes: Array<{ entity: SyncEntityType; id: string; serverSeq: string; deleted: boolean; data: Record<string, unknown> }>;
    nextCursor: string;
    hasMore: boolean;
    backfillGroupIds: string[];
    backfillExpenseIds: string[];
  }>('pull_changes', { p_actor: actor, p_cursor: cursor, p_limit: limit, p_group: scope.groupId ?? null, p_expense: scope.expenseId ?? null });
  const changes: SyncPullChange[] = res.changes.map((c) => ({
    entity: c.entity,
    id: c.id,
    serverSeq: String(c.serverSeq),
    deleted: c.deleted,
    data: fromDbRow(c.entity, c.data),
  }));
  return { changes, nextCursor: String(res.nextCursor), hasMore: res.hasMore, backfillGroupIds: res.backfillGroupIds ?? [], backfillExpenseIds: res.backfillExpenseIds ?? [] };
}

/**
 * Dev-only seed for `make setup-dev`: writes the mock dataset with the service role, owned by
 * dataset.currentUser. Refuses anything but a loopback Supabase.
 */
export function assertLocalSupabase(what: string): void {
  const host = new URL(SUPABASE_URL).hostname;
  if (process.env.NODE_ENV === 'production' || !['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error(`${what} only runs against a local Supabase`);
  }
}

/**
 * Dev and test only: forget the lifetime quota counters of the shared dev profiles, which repeated
 * test and e2e runs exhaust (production keeps counting every row ever created).
 */
export async function resetDevQuotas(profileIds: string[]): Promise<void> {
  assertLocalSupabase('resetDevQuotas');
  const { error } = await getSupabaseAdmin().from('quota_usage').delete().in('owner_id', profileIds);
  if (error) throw new Error(`reset quota_usage: ${error.message}`);
}

/**
 * Dev only: hard-deletes what tests and e2e left on the dev profiles, i.e. every group they belong to
 * or created except the seed groups, their direct bills and unanchored settlements, and their direct
 * activity (children cascade; quota counters go with their scope). Rows touched in the last
 * `graceMinutes` are kept so a test run in flight is never pulled out from under itself.
 */
export async function resetDevData(profileIds: string[], dataset: MockLedgerDataset, graceMinutes = 30): Promise<Record<string, number>> {
  assertLocalSupabase('resetDevData');
  const db = getSupabaseAdmin();
  const cutoff = new Date(Date.now() - graceMinutes * 60_000).toISOString();
  const seed = (rows: Array<{ id: string }>) => new Set(rows.map((r) => r.id));
  const keepGroups = seed(dataset.groups);
  const keepExpenses = seed(dataset.expenses);
  const ids = async (q: PromiseLike<{ data: unknown; error: { message: string } | null }>, col = 'id'): Promise<string[]> => {
    const { data, error } = await q;
    if (error) throw new Error(`reset-dev-data: ${error.message}`);
    return [...new Set(((data ?? []) as Array<Record<string, string>>).map((r) => r[col]!))];
  };
  const del = async (table: string, list: string[]): Promise<number> => {
    for (let i = 0; i < list.length; i += 200) {
      const { error } = await db.from(table).delete().in('id', list.slice(i, i + 200));
      if (error) throw new Error(`reset-dev-data ${table}: ${error.message}`);
    }
    return list.length;
  };
  const candidates = [
    ...(await ids(db.from('group_members').select('group_id').in('user_id', profileIds), 'group_id')),
    ...(await ids(db.from('groups').select('id').in('created_by', profileIds))),
  ].filter((g) => !keepGroups.has(g));
  const groups = candidates.length ? await ids(db.from('groups').select('id').in('id', [...new Set(candidates)]).lt('updated_at', cutoff)) : [];
  const directCandidates = [
    ...(await ids(db.from('expenses').select('id').is('group_id', null).in('owner_id', profileIds))),
    ...(await ids(db.from('expense_participants').select('expense_id').in('profile_id', profileIds), 'expense_id')),
  ].filter((e) => !keepExpenses.has(e));
  const direct = directCandidates.length
    ? await ids(db.from('expenses').select('id').is('group_id', null).in('id', [...new Set(directCandidates)]).lt('updated_at', cutoff))
    : [];
  const loose = await ids(db.from('settlements').select('id').is('group_id', null).is('expense_id', null).in('owner_id', profileIds));
  const activity = (await ids(db.from('group_activity_log').select('id').is('group_id', null).in('owner_id', profileIds).lt('created_at', cutoff)))
    .filter((a) => !dataset.groupActivityLog.some((s) => s.id === a));
  const removed: Record<string, number> = {
    groups: await del('groups', groups),
    directExpenses: await del('expenses', direct),
    unanchoredSettlements: await del('settlements', loose.filter((s) => !dataset.settlements.some((x) => x.id === s))),
    directActivity: await del('group_activity_log', activity),
  };
  // Inside the seed groups and the seed direct bill: keep exactly the seed rows (plus in-flight ones).
  // client created_at values are not trusted for the window; the hlc's 48-bit ms prefix is, within 60 s.
  const cutoffHlc = `${(Date.now() - graceMinutes * 60_000).toString(16).padStart(12, '0')}-`;
  const seedGroups = [...keepGroups];
  const seedDirect = [...keepExpenses].filter((e) => !dataset.expenses.find((x) => x.id === e)?.groupId);
  const keep = {
    group_members: seed(dataset.groups.flatMap((g) => g.members)),
    expenses: keepExpenses,
    expense_revisions: seed(dataset.expenseRevisions),
    settlements: seed(dataset.settlements),
    group_activity_log: seed(dataset.groupActivityLog),
    expense_comments: seed(dataset.expenses.flatMap((e) => e.comments ?? [])),
    receipt_attachments: new Set<string>(),
  };
  const prune = async (table: keyof typeof keep, col: string, values: string[]): Promise<number> =>
    values.length
      ? del(table, (await ids(db.from(table).select('id').in(col, values).lt('hlc', cutoffHlc))).filter((x) => !keep[table].has(x)))
      : 0;
  for (const t of ['expenses', 'group_members', 'settlements', 'expense_revisions', 'group_activity_log', 'expense_comments', 'receipt_attachments'] as const) {
    removed[`seed.${t}`] = (await prune(t, 'group_id', seedGroups)) + (t === 'expenses' || t === 'group_members' ? 0
      : await prune(t, t === 'group_activity_log' ? 'entity_id' : 'expense_id', seedDirect));
  }
  return removed;
}

export async function seedDevDataset(dataset: MockLedgerDataset): Promise<void> {
  assertLocalSupabase('seedDevDataset');
  const owner = dataset.currentUser.id;
  const hlc = (h: string | undefined) => h || `${Date.now().toString(16).padStart(12, '0')}-0000-${owner}`;
  const rows = (entity: SyncEntityType, items: Array<{ id: string; hlc?: string } & object>, extra: (x: never) => object = () => ({})) =>
    items.map((x) => {
      const row: Record<string, unknown> = { id: x.id, ...toDbRow(entity, x.id, x as Record<string, unknown>), ...extra(x as never), hlc: hlc(x.hlc) };
      for (const k of ['created_at', 'last_accessed_at']) if (row[k] === null) delete row[k];
      return row;
    });

  const groupHlc = new Map(dataset.groups.map((g) => [g.id, g.hlc]));
  const writes: Array<[string, object[]]> = [
    ['groups', rows('group', dataset.groups.map(({ members: _m, ...g }) => g), () => ({ created_by: owner, invite_code: `WS-${randomBytes(5).toString('hex').toUpperCase()}` }))],
    [
      'group_members',
      dataset.groups.flatMap((g) =>
        g.members.map((m) => ({
          id: m.id,
          ...toDbRow('group_member', m.id, m as unknown as Record<string, unknown>),
          joined_at: m.joinedAt,
          claimed_at: m.claimedAt,
          hlc: hlc(groupHlc.get(g.id)),
        }))
      ),
    ],
    ['expenses', rows('expense', dataset.expenses, () => ({ owner_id: owner }))],
    ['expense_revisions', rows('expense_revision', dataset.expenseRevisions, (r: { groupId: string | null; actorDisplayName: string }) => ({ group_id: r.groupId, actor_display_name: r.actorDisplayName }))],
    ['settlements', rows('settlement', dataset.settlements, () => ({ owner_id: owner }))],
    ['group_activity_log', rows('group_activity', dataset.groupActivityLog, (a: { actorDisplayName: string }) => ({ owner_id: owner, actor_display_name: a.actorDisplayName }))],
    [
      'expense_comments',
      dataset.expenses.flatMap((e) =>
        (e.comments ?? []).map((c) => ({
          id: c.id, expense_id: e.id, group_id: e.groupId, author_member_id: c.authorMemberId, author_name: c.authorName,
          body: c.body, created_at: c.createdAt, hlc: hlc(e.hlc), legacy: true,
        }))
      ),
    ],
  ];
  for (const [table, data] of writes) {
    if (data.length === 0) continue;
    const { error } = await getSupabaseAdmin().from(table).upsert(data, { onConflict: 'id', defaultToNull: false });
    if (error) throw new Error(`seed ${table}: ${error.message}`);
  }
}
