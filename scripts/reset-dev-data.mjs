#!/usr/bin/env bun
/**
 * LOCAL ONLY (`make reset-dev-data`): removes what tests and e2e piled onto the dev profiles, then
 * re-seeds the sample ledger and resets the dev profiles' quota counters. Refuses a non-loopback
 * SUPABASE_URL or NODE_ENV=production. Rows touched in the last 30 minutes are kept (runs in flight).
 */
import initialMockData from '../src/data/mock-ledger-data.json';
import { DEV_DEMO_PROFILES } from '../src/data/dev-profiles';
import { assertLocalSupabase, resetDevData, resetDevQuotas, seedDevDataset } from '../src/server/supabaseAdmin';

const ids = DEV_DEMO_PROFILES.map((p) => p.id);
try {
  assertLocalSupabase('reset-dev-data');
  const t0 = Date.now();
  const removed = await resetDevData(ids, initialMockData);
  await resetDevQuotas(ids);
  await seedDevDataset(initialMockData);
  await resetDevQuotas(ids);
  console.log(`[reset-dev-data] removed ${JSON.stringify(removed)}, re-seeded in ${Date.now() - t0} ms`);
} catch (err) {
  console.error(`[reset-dev-data] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
