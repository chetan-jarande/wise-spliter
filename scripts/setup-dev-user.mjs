#!/usr/bin/env bun
/**
 * Wise-Spliter Dev User & Ledger Seed Script (`scripts/setup-dev-user.mjs`)
 * Runnable via `bun run scripts/setup-dev-user.mjs` or `make setup-dev`.
 *
 * Provisions the 3 development profiles in centralized local Supabase Auth (`auth.users`)
 * and `wise_spliter.profiles`, seeds the full ledger dataset (`wise_spliter.*`),
 * verifies browser-client password login (`signInWithPassword`) + backend HMAC session minting,
 * and prints the terminal credential summary table.
 */

import { createClient } from '@supabase/supabase-js';
import initialMockData from '../src/data/mock-ledger-data.json';
import {
  DEV_DEFAULT_PASSWORD,
  DEV_DEMO_PROFILES,
} from '../src/data/dev-profiles';
import { issueSessionToken } from '../src/server/securityAndAuth';
import {
  SUPABASE_SCHEMA,
  SUPABASE_URL,
  getSupabaseAdmin,
  syncDatasetToSupabase,
} from '../src/server/supabaseAdmin';

const PUBLISHABLE_KEY = (
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH'
).trim();

const APP_PORT = process.env.APP_PORT || '4173';
const API_PORT = process.env.API_PORT || '4174';

async function main() {
  console.log(
    `[setup-dev-user] Connecting to Centralized Local Supabase (${SUPABASE_URL}, schema: ${SUPABASE_SCHEMA})...`
  );

  const supabase = getSupabaseAdmin();

  // 1. List existing users in Supabase Auth
  const { data: listData, error: listError } =
    await supabase.auth.admin.listUsers({
      page: 1,
      perPage: 1000,
    });

  if (listError) {
    throw new Error(
      `Failed listing Supabase Auth users at ${SUPABASE_URL}: ${listError.message}`
    );
  }

  const existingUsers = listData?.users ?? [];
  const nowIso = new Date().toISOString();

  // 2. Ensure all 3 DEV_DEMO_PROFILES exist in Supabase Auth (`auth.users`) and `wise_spliter.profiles`
  const profileRows = [];

  for (const profile of DEV_DEMO_PROFILES) {
    const targetEmail = profile.email.toLowerCase();
    const existingAuthUser = existingUsers.find(
      (u) => (u.email || '').toLowerCase() === targetEmail
    );

    if (!existingAuthUser) {
      const { error: createErr } = await supabase.auth.admin.createUser({
        email: profile.email,
        password: profile.password,
        email_confirm: true,
        user_metadata: {
          full_name: profile.fullName,
          app_user_id: profile.id,
        },
      });
      if (createErr) {
        throw new Error(
          `Failed creating Supabase Auth user ${profile.email}: ${createErr.message}`
        );
      }
      console.log(
        `[setup-dev-user] Created Supabase Auth user: ${profile.email} (${profile.id})`
      );
    } else {
      const { error: updateErr } = await supabase.auth.admin.updateUserById(
        existingAuthUser.id,
        {
          password: profile.password,
          email_confirm: true,
          user_metadata: {
            full_name: profile.fullName,
            app_user_id: profile.id,
          },
        }
      );
      if (updateErr) {
        throw new Error(
          `Failed updating Supabase Auth user ${profile.email}: ${updateErr.message}`
        );
      }
      console.log(
        `[setup-dev-user] Verified & updated Supabase Auth user: ${profile.email} (${profile.id})`
      );
    }

    const hlc = `${Date.now().toString(16).padStart(12, '0')}-0001-${profile.id}`;
    profileRows.push({
      id: profile.id,
      email: profile.email,
      full_name: profile.fullName,
      avatar_initials: profile.avatarInitials,
      avatar_url: null,
      default_currency: profile.defaultCurrency,
      upi_id: profile.upiId,
      google_connected: true,
      updated_at: nowIso,
      hlc,
    });
  }

  // 3. Seed full mock ledger dataset (groups, members, expenses, revisions, settlements, receipts, activity)
  const syncResult = await syncDatasetToSupabase(initialMockData);
  if (!syncResult.ok) {
    throw new Error(
      `Failed seeding dataset to ${SUPABASE_SCHEMA}: ${syncResult.error}`
    );
  }

  // Upsert all 3 profiles into wise_spliter.profiles so every collaborator profile is present
  const { error: profileUpsertError } = await supabase
    .from('profiles')
    .upsert(profileRows, { onConflict: 'id' });

  if (profileUpsertError) {
    throw new Error(
      `Failed upserting ${SUPABASE_SCHEMA}.profiles: ${profileUpsertError.message}`
    );
  }

  console.log(
    `[setup-dev-user] Seeded ${initialMockData.groups.length} groups, ${initialMockData.expenses.length} expenses, ${initialMockData.settlements.length} settlements, and ${profileRows.length} profiles into ${SUPABASE_SCHEMA}.*`
  );

  // 4. Verify login using a browser-style client (`signInWithPassword`) + backend session token
  const browserClient = createClient(SUPABASE_URL, PUBLISHABLE_KEY, {
    db: { schema: SUPABASE_SCHEMA },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

  const primaryProfile = DEV_DEMO_PROFILES[0];
  const { data: signInData, error: signInError } =
    await browserClient.auth.signInWithPassword({
      email: primaryProfile.email,
      password: DEV_DEFAULT_PASSWORD,
    });

  if (signInError || !signInData?.session?.access_token) {
    throw new Error(
      `Supabase signInWithPassword verification failed for ${primaryProfile.email}: ${signInError?.message || 'missing access_token'}`
    );
  }

  const backendToken = issueSessionToken({
    userId: primaryProfile.id,
    email: primaryProfile.email,
    fullName: primaryProfile.fullName,
  });

  if (!backendToken) {
    throw new Error('Failed to issue verified backend session token');
  }

  // 5. Print formatted summary table to terminal
  const divider = '='.repeat(108);
  const thinDivider = '-'.repeat(108);
  console.log(`\n${divider}`);
  console.log('  WISE-SPLITER DEV ENVIRONMENT & DEMO USER CREDENTIALS');
  console.log(divider);
  console.log(`  Frontend Dev URL   : http://localhost:${APP_PORT}`);
  console.log(`  Backend API URL    : http://localhost:${API_PORT}`);
  console.log(`  Supabase Data API  : ${SUPABASE_URL} (schema: ${SUPABASE_SCHEMA})`);
  console.log(`  Auth Verification  : Supabase Auth JWT + Backend HMAC Session Verified`);
  console.log(thinDivider);
  console.log(
    '  ' +
      'EMAIL'.padEnd(26) +
      'PASSWORD'.padEnd(20) +
      'UPI ID'.padEnd(24) +
      'GROUP ACCESS SCOPE'
  );
  console.log(thinDivider);
  for (const p of DEV_DEMO_PROFILES) {
    console.log(
      '  ' +
        p.email.padEnd(26) +
        p.password.padEnd(20) +
        p.upiId.padEnd(24) +
        p.roleLabel
    );
  }
  console.log(`${divider}\n`);
}

main().catch((err) => {
  console.error(
    '[setup-dev-user] ERROR:',
    err instanceof Error ? err.message : err
  );
  process.exit(1);
});
