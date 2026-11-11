#!/usr/bin/env node
/**
 * Wise-Spliter Migration & Schema Verification Runner
 * Modeled on merry-tools/scripts/apply-migration.mjs for the centralized local
 * Supabase instance (/home/chetan/projects/my-scripts/setup/dependencies).
 *
 * Modes:
 *   node scripts/apply-migration.mjs local       - Apply supabase/migrations/*.sql to centralized local DB & verify
 *   node scripts/apply-migration.mjs verify      - Read-only verification of wise_spliter schema, tables, and RPC grants
 *   node scripts/apply-migration.mjs --print-sql - Print combined SQL to stdout
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase', 'migrations');
const LOGS_DIR = path.join(REPO_ROOT, 'logs');

const SUPABASE_URL = (process.env.SUPABASE_URL || 'http://127.0.0.1:54321').trim();
const SUPABASE_SECRET_KEY = (
  process.env.SUPABASE_SECRET_KEY || 'sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz'
).trim();
const SUPABASE_SCHEMA = (process.env.SUPABASE_SCHEMA || 'wise_spliter').trim();
const DB_HOST = (process.env.SUPABASE_DB_HOST || '127.0.0.1').trim();
const DB_PORT = (process.env.SUPABASE_DB_PORT || '54322').trim();

const REQUIRED_TABLES = [
  'profiles',
  'groups',
  'group_members',
  'expenses',
  'expense_revisions',
  'settlements',
  'group_activity_log',
];

const report = [];
const fails = [];

function check(cond, label) {
  report.push(`  ${cond ? 'PASS' : 'FAIL'} - ${label}`);
  if (!cond) fails.push(label);
  return cond;
}

function section(title) {
  report.push(`\n${title}`);
}

function listMigrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => path.join(MIGRATIONS_DIR, f));
}

function applySqlToCentralLocalDb(sqlFilePath) {
  const sqlContent = readFileSync(sqlFilePath, 'utf8');

  const dockerExec = spawnSync(
    'docker',
    [
      'exec',
      '-i',
      'supabase_db_dependencies',
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-d',
      'postgres',
    ],
    { input: sqlContent, encoding: 'utf8' }
  );

  if (dockerExec.status === 0) {
    return { ok: true, method: 'docker exec supabase_db_dependencies' };
  }

  const hostPsql = spawnSync(
    'psql',
    [
      '-v',
      'ON_ERROR_STOP=1',
      '-h',
      DB_HOST,
      '-p',
      DB_PORT,
      '-U',
      'postgres',
      '-d',
      'postgres',
    ],
    {
      input: sqlContent,
      encoding: 'utf8',
      env: { ...process.env, PGPASSWORD: 'postgres' },
    }
  );

  if (hostPsql.status === 0) {
    return { ok: true, method: `host psql (${DB_HOST}:${DB_PORT})` };
  }

  const dockerRun = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '-i',
      '--add-host=host.docker.internal:host-gateway',
      '-e',
      'PGPASSWORD=postgres',
      'postgres:17-alpine',
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-h',
      'host.docker.internal',
      '-p',
      DB_PORT,
      '-U',
      'postgres',
      '-d',
      'postgres',
    ],
    { input: sqlContent, encoding: 'utf8' }
  );

  if (dockerRun.status === 0) {
    return { ok: true, method: 'docker run postgres:17-alpine' };
  }

  return {
    ok: false,
    error: dockerExec.stderr || hostPsql.stderr || dockerRun.stderr || 'Unknown psql error',
  };
}

async function apiProbe(pathAndQuery, init = {}) {
  const target = SUPABASE_URL.replace(/\/+$/, '') + pathAndQuery;
  try {
    const res = await fetch(target, {
      ...init,
      headers: {
        apikey: SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
        'Accept-Profile': SUPABASE_SCHEMA,
        'Content-Profile': SUPABASE_SCHEMA,
        ...(init.headers || {}),
      },
    });
    const text = await res.text();
    return { status: res.status, ok: res.ok, text };
  } catch (err) {
    return { status: 0, ok: false, transportError: err.message };
  }
}

async function verifySchemaAndTables() {
  section(`[Verify] Probing Data API (${SUPABASE_URL}) for schema "${SUPABASE_SCHEMA}"`);

  for (const table of REQUIRED_TABLES) {
    const res = await apiProbe(`/rest/v1/${table}?limit=1`);
    if (res.transportError) {
      check(false, `Table ${SUPABASE_SCHEMA}.${table} reachable (${res.transportError})`);
      continue;
    }
    check(
      res.ok,
      `Table ${SUPABASE_SCHEMA}.${table} exposed & accessible to service_role (HTTP ${res.status})`
    );
  }

  const rpc = await apiProbe('/rest/v1/rpc/schema_health', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  check(
    rpc.ok && rpc.text.includes('"wise_spliter"'),
    `RPC ${SUPABASE_SCHEMA}.schema_health() callable (HTTP ${rpc.status})`
  );
}

function finish() {
  report.push(
    `\n===== SUMMARY: ${fails.length ? `${fails.length} FAILURE(S)` : 'ALL CHECKS PASSED'} =====`
  );
  const output = report.join('\n');
  console.log(output);

  try {
    mkdirSync(LOGS_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    writeFileSync(path.join(LOGS_DIR, `migration-${stamp}.log`), output + '\n', 'utf8');
  } catch {
    // Best-effort logging
  }

  process.exit(fails.length ? 1 : 0);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--print-sql')) {
    for (const file of listMigrationFiles()) {
      console.log(`-- FILE: ${path.basename(file)}\n` + readFileSync(file, 'utf8'));
    }
    process.exit(0);
  }

  const mode = args[0] || 'local';
  const files = listMigrationFiles();

  if (mode === 'local' || mode === 'apply') {
    section(`[Apply] Applying ${files.length} migration file(s) to centralized local Supabase DB`);
    for (const file of files) {
      const base = path.basename(file);
      const res = applySqlToCentralLocalDb(file);
      check(
        res.ok,
        `Applied ${base}${res.ok ? ` via ${res.method}` : `: ${res.error}`}`
      );
    }
  }

  await verifySchemaAndTables();
  finish();
}

main();
