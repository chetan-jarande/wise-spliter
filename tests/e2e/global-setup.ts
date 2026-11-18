import { spawnSync } from 'node:child_process';

/**
 * Before e2e: clear what earlier runs piled onto the shared dev profiles, re-seed, reset their quotas
 * (scripts/reset-dev-data.mjs, local Supabase only). Run as a bun subprocess because the server
 * modules use JSON imports Playwright's loader cannot read. Refusals and errors are logged, not fatal.
 */
export default function globalSetup(): void {
  const r = spawnSync('bun', ['run', 'scripts/reset-dev-data.mjs'], { encoding: 'utf8', env: process.env, timeout: 60_000 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  if (r.status === 0) console.log(out);
  else console.warn(`[e2e] dev data reset skipped: ${out || r.error?.message || `exit ${r.status}`}`);
}
