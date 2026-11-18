#!/usr/bin/env node
/**
 * Wise-Spliter migration runner. Applies supabase/migrations/*.sql through psql and records
 * each file in wise_spliter.schema_migrations, so it never reads or writes the shared
 * supabase_migrations history of the Supabase project (merry-tools lives in the same project).
 *
 *   node scripts/apply-migration.mjs local            apply pending files to the local DB, then verify
 *   node scripts/apply-migration.mjs remote           apply pending files to SUPABASE_DB_URL (hosted), then verify
 *   node scripts/apply-migration.mjs verify           read-only checks against SUPABASE_URL
 *   node scripts/apply-migration.mjs --print-sql      combined SQL for the dashboard SQL editor
 *   node scripts/apply-migration.mjs --print-script   the psql ledger script that local/remote run
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase', 'migrations');
const LOGS_DIR = path.join(REPO_ROOT, 'logs');

const REQUIRED_TABLES = [
  'profiles',
  'groups',
  'group_members',
  'expenses',
  'expense_revisions',
  'settlements',
  'group_activity_log',
  'receipt_attachments',
  'expense_comments',
];

const report = [];
const fails = [];

function check(cond, label) {
  report.push(`  ${cond ? 'PASS' : 'FAIL'} - ${label}`);
  if (!cond) fails.push(label);
  return cond;
}
const note = (msg) => report.push(`  note: ${msg}`);
const section = (title) => report.push(`\n${title}`);

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '<unparseable>';
  }
}

function isLoopbackHost(h) {
  return ['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0', 'host.docker.internal'].includes(h);
}

function isLoopback(url) {
  try {
    return isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

function classifySecretKey(key) {
  if (!key) return { ok: false, label: 'MISSING (SUPABASE_SECRET_KEY is not set)' };
  if (key.startsWith('sb_secret_')) return { ok: true, label: `sb_secret_... (${key.length} chars)` };
  if (key.startsWith('sb_publishable_')) return { ok: false, label: 'WRONG KIND: publishable key' };
  if (key.startsWith('eyJ')) return { ok: true, label: `legacy service_role JWT (${key.length} chars)` };
  return { ok: false, label: `UNRECOGNISED SHAPE (${key.length} chars)` };
}

function resolveCreds() {
  return {
    url: (process.env.SUPABASE_URL || '').trim(),
    secretKey: (process.env.SUPABASE_SECRET_KEY || '').trim(),
    publishableKey: (process.env.VITE_SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || '').trim(),
    schema: (process.env.SUPABASE_SCHEMA || 'wise_spliter').trim(),
    dbHost: (process.env.SUPABASE_DB_HOST || '127.0.0.1').trim(),
    dbPort: (process.env.SUPABASE_DB_PORT || '54322').trim(),
  };
}

function listMigrations() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => {
      const sql = readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
      if (!/^[0-9]{4}_[a-z0-9_]+\.sql$/.test(f)) throw new Error(`bad migration file name: ${f}`);
      return { version: f.replace(/\.sql$/, ''), sql, checksum: createHash('sha256').update(sql).digest('hex') };
    });
}

/**
 * One psql session: create the ledger, then apply each pending file in its own transaction.
 * strict=true (remote) refuses files whose content changed after they were applied;
 * strict=false (local) re-applies them, which is safe because every file is idempotent.
 */
const LOCKDOWN_SQL = [
  'REVOKE ALL ON SCHEMA wise_spliter FROM PUBLIC, anon, authenticated;',
  'REVOKE ALL ON ALL TABLES IN SCHEMA wise_spliter FROM PUBLIC, anon, authenticated;',
  'REVOKE ALL ON ALL SEQUENCES IN SCHEMA wise_spliter FROM PUBLIC, anon, authenticated;',
  'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA wise_spliter FROM PUBLIC, anon, authenticated;',
  'ALTER DEFAULT PRIVILEGES IN SCHEMA wise_spliter REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;',
  'ALTER DEFAULT PRIVILEGES IN SCHEMA wise_spliter REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated;',
  'ALTER DEFAULT PRIVILEGES IN SCHEMA wise_spliter REVOKE ALL ON FUNCTIONS FROM PUBLIC, anon, authenticated;',
];
// Postgres grants EXECUTE on new functions to PUBLIC; strip it after every file instead of
// touching global default privileges, which the other app in the project shares.
const PER_FILE_REVOKE = 'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA wise_spliter FROM PUBLIC, anon, authenticated;';
const LEDGER_DDL =
  'CREATE TABLE IF NOT EXISTS wise_spliter.schema_migrations (version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());';
// Present once 0004 ran; older files must never be replayed over it (0004 drops what 0001-0003 grant or touch).
const SCHEMA_0004_MARKER = "SELECT to_regclass('wise_spliter.expense_participants') IS NOT NULL AS ws_at_0004 \\gset";

/**
 * One psql session and ONE transaction: every pending file, the per-file revoke and the final
 * lockdown commit together or not at all, so a failure can never leave a re-granted schema behind.
 * strict=true (remote) refuses files whose content changed after they were applied; strict=false
 * (local) re-applies them, which is safe because every file is idempotent. Files older than 0004
 * that are missing from the ledger of a schema already at 0004 are adopted, not replayed.
 */
function buildLedgerScript(migrations, { strict }) {
  const out = [
    '\\set ON_ERROR_STOP on',
    'SET client_min_messages = warning;',
    'BEGIN;',
    'CREATE SCHEMA IF NOT EXISTS wise_spliter;',
    LEDGER_DDL,
    SCHEMA_0004_MARKER,
    '\\set ws_force false',
  ];
  for (const m of migrations) {
    const record = `INSERT INTO wise_spliter.schema_migrations (version, checksum) VALUES ('${m.version}', '${m.checksum}') ON CONFLICT (version) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = now();`;
    out.push(`UPDATE wise_spliter.schema_migrations SET checksum = '${m.checksum}' WHERE version = '${m.version}' AND checksum = 'pasted';`);
    if (strict) {
      out.push(
        `DO $ws$ BEGIN IF EXISTS (SELECT 1 FROM wise_spliter.schema_migrations WHERE version = '${m.version}' AND checksum <> '${m.checksum}') THEN RAISE EXCEPTION 'migration ${m.version} changed after it was applied; add a new migration instead'; END IF; END $ws$;`
      );
    }
    const apply = [`\\echo [migrate] applying ${m.version}`, m.sql.trimEnd(), PER_FILE_REVOKE, record];
    out.push(
      `SELECT :ws_force OR NOT EXISTS (SELECT 1 FROM wise_spliter.schema_migrations WHERE version = '${m.version}' AND checksum = '${m.checksum}') AS ws_pending \\gset`,
      '\\if :ws_pending',
      ...(m.version < '0004'
        ? ['\\if :ws_at_0004', `\\echo [migrate] adopting ${m.version} (schema already at 0004)`, record, '\\else', ...apply, '\\endif']
        : [...apply, '\\set ws_force true']),
      '\\else',
      `\\echo [migrate] up to date: ${m.version}`,
      '\\endif'
    );
  }
  out.push(...LOCKDOWN_SQL, 'COMMIT;');
  return out.join('\n') + '\n';
}

function printSql() {
  const migrations = listMigrations();
  console.log('-- Wise-Spliter migrations for the Supabase SQL editor (idempotent, in order).');
  console.log('-- Only for a project where wise_spliter does not exist yet: older files are not re-runnable');
  console.log('-- after later ones (0004 drops columns 0003 touches). Afterwards use `make migrate-remote`.');
  console.log('CREATE SCHEMA IF NOT EXISTS wise_spliter;');
  console.log(LEDGER_DDL);
  for (const m of migrations) {
    console.log(`\n-- FILE: ${m.version}.sql\n${m.sql}`);
    console.log(PER_FILE_REVOKE);
    console.log(
      `INSERT INTO wise_spliter.schema_migrations (version, checksum) VALUES ('${m.version}', '${m.checksum}') ON CONFLICT (version) DO UPDATE SET checksum = EXCLUDED.checksum, applied_at = now();`
    );
  }
  console.log(`\n-- Final lockdown\n${LOCKDOWN_SQL.join('\n')}`);
  process.exit(0);
}

function runPsqlLocal(script, creds) {
  const attempts = [
    ['docker', ['exec', '-i', 'supabase_db_dependencies', 'psql', '-X', '-q', '-U', 'postgres', '-d', 'postgres'], 'docker exec supabase_db_dependencies', {}],
    ['psql', ['-X', '-q', '-h', creds.dbHost, '-p', creds.dbPort, '-U', 'postgres', '-d', 'postgres', '-w'], `host psql (${creds.dbHost}:${creds.dbPort})`, { PGPASSWORD: process.env.SUPABASE_DB_PASSWORD || '' }],
  ];
  const errors = [];
  for (const [cmd, args, method, env] of attempts) {
    const res = spawnSync(cmd, args, { input: script, encoding: 'utf8', env: { ...process.env, ...env } });
    if (res.status === 0) return { ok: true, method, stdout: res.stdout };
    errors.push(`${method}: ${(res.stderr || res.error?.message || `exit ${res.status}`).trim()}`);
    // A real SQL error (not a missing tool / container) must not be retried elsewhere.
    if (/ERROR:/.test(res.stderr || '')) break;
  }
  return { ok: false, error: errors.join('\n') };
}

function applyMigrationsLocal(creds) {
  section('[Apply] Local Supabase DB via psql + wise_spliter.schema_migrations ledger');
  if (creds.url && !isLoopback(creds.url)) {
    check(false, `SUPABASE_URL points at ${hostOf(creds.url)} (not loopback); refusing local apply`);
    return;
  }
  const migrations = listMigrations();
  const res = runPsqlLocal(buildLedgerScript(migrations, { strict: false }), creds);
  if (res.ok) {
    for (const line of res.stdout.split('\n').filter((l) => l.startsWith('[migrate]'))) note(line);
  }
  check(res.ok, res.ok ? `${migrations.length} migration file(s) checked via ${res.method}` : `psql apply failed:\n${res.error}`);
}

function applyMigrationsRemote() {
  section('[Remote] Hosted Supabase via psql + wise_spliter.schema_migrations ledger');
  const dbUrl = (process.env.SUPABASE_DB_URL || '').trim();
  if (!check(Boolean(dbUrl), 'SUPABASE_DB_URL is set (postgres connection string; omit the password to be prompted)')) {
    note('Find it under Project Settings -> Database -> Connection string (session pooler). Never commit it.');
    return false;
  }
  let host = '';
  try {
    host = new URL(dbUrl).hostname;
  } catch {
    check(false, 'SUPABASE_DB_URL is not a valid URL');
    return false;
  }
  if (!check(!isLoopbackHost(host), 'SUPABASE_DB_URL is not a loopback host (use `make migrate-up` locally)')) return false;

  const dir = mkdtempSync(path.join(tmpdir(), 'ws-migrate-'));
  const file = path.join(dir, 'ledger.sql');
  try {
    writeFileSync(file, buildLedgerScript(listMigrations(), { strict: true }), { mode: 0o600 });
    console.log(`\n[apply-migration] psql -> ${host} (password prompt comes from psql itself)\n`);
    const res = spawnSync('psql', ['-X', '-q', dbUrl, '-f', file], { stdio: 'inherit' });
    return check(res.status === 0, `psql ledger apply (${res.error ? res.error.message : `exit ${res.status}`})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function apiProbe(creds, pathAndQuery, init = {}) {
  try {
    const res = await fetch(creds.url.replace(/\/+$/, '') + pathAndQuery, {
      ...init,
      headers: {
        apikey: creds.secretKey,
        Authorization: `Bearer ${creds.secretKey}`,
        'Accept-Profile': creds.schema,
        'Content-Profile': creds.schema,
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
      signal: AbortSignal.timeout(10_000),
    });
    return { status: res.status, ok: res.ok, text: await res.text() };
  } catch (err) {
    return { status: 0, ok: false, text: '', transportError: err.message };
  }
}

async function verifySchema(creds) {
  section(`[Verify] Target ${creds.url ? hostOf(creds.url) : '<missing>'}`);
  const keyInfo = classifySecretKey(creds.secretKey);
  if (!check(Boolean(creds.url), 'SUPABASE_URL is set') | !check(keyInfo.ok, `SUPABASE_SECRET_KEY shape: ${keyInfo.label}`)) return;

  for (const table of REQUIRED_TABLES) {
    const res = await apiProbe(creds, `/rest/v1/${table}?select=id&limit=1`);
    if (res.status === 406 || res.text.includes('PGRST106')) {
      check(false, `schema "${creds.schema}" is not exposed in the Data API (add it under Data API -> Exposed schemas)`);
      return;
    }
    check(res.ok, `service_role reads ${creds.schema}.${table} (HTTP ${res.status || res.transportError})`);
  }

  const rpc = await apiProbe(creds, '/rest/v1/rpc/schema_health', { method: 'POST', body: '{}' });
  let h = null;
  try {
    h = rpc.ok ? JSON.parse(rpc.text) : null;
  } catch {
    h = null;
  }
  if (!check(Boolean(h), `schema_health() callable by service_role (HTTP ${rpc.status})`)) return;
  check(Number(h.rls_forced_count) >= REQUIRED_TABLES.length, `FORCE RLS on all ${REQUIRED_TABLES.length} tables (count=${h.rls_forced_count})`);
  check(h.public_table_grants === 0, `no table grants to anon/authenticated/PUBLIC (count=${h.public_table_grants})`);
  check(h.public_function_grants === 0, `no function EXECUTE for anon/authenticated (count=${h.public_function_grants})`);
  check(h.authenticated_schema_usage === false, 'authenticated has no USAGE on the schema');
  check(Number(h.check_constraints) >= 22, `size/format CHECK constraints present (count=${h.check_constraints})`);
  check(Number(h.lowercase_email_checks) === 2, 'email = lower(email) CHECKs on profiles and group_members');
  check(Number(h.seq_triggers) === 9, `server_seq bump-on-UPDATE triggers (count=${h.seq_triggers})`);
  check(h.seq_triggers_last === true, 'seq/lock triggers fire after every check trigger');
  check(Number(h.seq_insert_triggers) === 9 && Number(h.seq_defaults) === 0, 'server_seq assigned under the commit-order lock on INSERT (no column defaults)');
  check(Number(h.cap_triggers) === 8, `per-tenant row-cap triggers (count=${h.cap_triggers})`);
  check(Number(h.immutable_triggers) === 5, `created_by/owner_id/receipt immutability triggers (count=${h.immutable_triggers})`);
  check(Number(h.scope_triggers) === 1, 'expense payer/split membership trigger present');
  check(Number(h.identity_server_seq) === 0, 'server_seq draws from the shared change_seq (no identity columns)');

  const probeActor = '__migrate_verify_probe__';
  for (const [fn, body] of [
    ['push_mutations', { p_actor: probeActor, p_mutations: [] }],
    ['pull_changes', { p_actor: probeActor, p_cursor: 0, p_limit: 1 }],
  ]) {
    const res = await apiProbe(creds, `/rest/v1/rpc/${fn}`, { method: 'POST', body: JSON.stringify(body) });
    check(res.text.includes('unknown actor'), `${fn}(actor, ...) exists and rejects unknown actors (HTTP ${res.status})`);
  }

  check(Number(h.policies) === 0, `RLS is deny-all: FORCEd with no policies (count=${h.policies})`);

  if (creds.publishableKey) {
    section('[Verify] Auth: email confirmation (pre-registration takeover guard)');
    const st = await apiProbe(creds, '/auth/v1/settings', { headers: { apikey: creds.publishableKey, Authorization: `Bearer ${creds.publishableKey}` } });
    let autoconfirm = null;
    try {
      autoconfirm = JSON.parse(st.text).mailer_autoconfirm;
    } catch {
      autoconfirm = null;
    }
    if (isLoopback(creds.url)) note(`local GoTrue mailer_autoconfirm=${autoconfirm} (production must be false)`);
    else check(autoconfirm === false, `GoTrue mailer_autoconfirm is false (got ${autoconfirm})`);

    section('[Verify] anon cannot reach the schema');
    const anon = { apikey: creds.publishableKey, Authorization: `Bearer ${creds.publishableKey}` };
    const t = await apiProbe(creds, '/rest/v1/groups?limit=1', { headers: anon });
    check(!t.ok && [401, 403].includes(t.status), `anon table read rejected (HTTP ${t.status})`);
    const r = await apiProbe(creds, '/rest/v1/rpc/pull_changes', {
      method: 'POST',
      headers: anon,
      body: JSON.stringify({ p_actor: 'x', p_cursor: 0, p_limit: 1 }),
    });
    check(!r.ok && [401, 403, 404].includes(r.status), `anon RPC call rejected (HTTP ${r.status})`);
  }
}

function finish(tag) {
  report.push(`\n===== SUMMARY: ${fails.length ? `${fails.length} FAILURE(S)` : 'ALL CHECKS PASSED'} =====`);
  const output = report.join('\n');
  console.log(output);
  try {
    mkdirSync(LOGS_DIR, { recursive: true });
    writeFileSync(path.join(LOGS_DIR, `migration-${tag}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`), output + '\n');
  } catch {
    // logging is best-effort
  }
  process.exit(fails.length ? 1 : 0);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--print-sql')) return printSql();
  if (args.includes('--print-script')) {
    process.stdout.write(buildLedgerScript(listMigrations(), { strict: !args.includes('--local') }));
    return;
  }
  const mode = args.find((a) => !a.startsWith('-')) || 'local';
  const creds = resolveCreds();

  // Verification always runs after an apply attempt, failed or not, so a half-state is reported loudly.
  if (mode === 'remote') {
    applyMigrationsRemote();
    if (creds.url && !isLoopback(creds.url)) await verifySchema(creds);
    else check(false, 'SUPABASE_URL must point at the hosted project so the result can be verified');
    return finish('prod');
  }
  if (mode === 'local' || mode === 'apply') applyMigrationsLocal(creds);
  else if (mode !== 'verify') check(false, `unknown mode "${mode}"`);
  await verifySchema(creds);
  finish(creds.url && isLoopback(creds.url) ? 'local' : 'prod');
}

main();
