#!/usr/bin/env bun
/**
 * Wise-Spliter Dev-Only Demo Data & Custom User Profile Seeder (`scripts/seed-demo-data.mjs`)
 *
 * STRICTLY DEV-ONLY: Refuses to run when NODE_ENV=production or when SUPABASE_URL is not a
 * local loopback address (127.0.0.1 / localhost / ::1).
 *
 * Works independently whether the web/API app (`make dev`) is currently running OR stopped:
 * connects directly to the local Supabase instance (`SUPABASE_URL`), provisions the demo
 * user profile (default demo sandbox OR any custom Name + Email you pass!), populates all
 * groups, members, multi-currency expenses, revisions, settlements, and direct splits in
 * `wise_spliter.*`, and verifies the seeded records via `pullChanges`.
 *
 * Usage examples:
 *   make seed-demo
 *   make seed-demo USER_NAME="Chetan Jarande" USER_EMAIL="chetan@demo.local"
 *   make seed-demo USER_NAME="Chetan Jarande" USER_EMAIL="chetanjarande@gmail.com" AUTH_MODE="google"
 *   bun run scripts/seed-demo-data.mjs --name "Chetan Jarande" --email "chetan@demo.local"
 */

import { createClient } from '@supabase/supabase-js';
import initialMockData from '../src/data/mock-ledger-data.json';
import { DEV_DEFAULT_PASSWORD, DEV_DEMO_PROFILES } from '../src/data/dev-profiles';
import {
  assertDevOnlyEnvironment,
  buildDemoDatasetForUser,
} from '../src/server/demoSeedBuilder';
import {
  SUPABASE_SCHEMA,
  SUPABASE_URL,
  assertLocalSupabase,
  claimMembers,
  getSupabaseAdmin,
  pullChanges,
  requireEnv,
  resetDevQuotas,
  seedDevDataset,
} from '../src/server/supabaseAdmin';

function parseCliOptions(argv) {
  let fullName = process.env.USER_NAME?.trim() || undefined;
  let email = process.env.USER_EMAIL?.trim() || undefined;
  let upiId = process.env.USER_UPI?.trim() || undefined;
  let password = process.env.USER_PASSWORD?.trim() || undefined;
  let authModeRaw = (process.env.AUTH_MODE?.trim() || 'password').toLowerCase();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if ((arg === '--name' || arg === '-n') && next) {
      fullName = next.trim();
      i++;
    } else if (arg.startsWith('--name=')) {
      fullName = arg.slice('--name='.length).trim();
    } else if ((arg === '--email' || arg === '-e') && next) {
      email = next.trim();
      i++;
    } else if (arg.startsWith('--email=')) {
      email = arg.slice('--email='.length).trim();
    } else if (arg === '--upi' && next) {
      upiId = next.trim();
      i++;
    } else if (arg.startsWith('--upi=')) {
      upiId = arg.slice('--upi='.length).trim();
    } else if ((arg === '--password' || arg === '-p') && next) {
      password = next;
      i++;
    } else if (arg.startsWith('--password=')) {
      password = arg.slice('--password='.length);
    } else if (arg === '--auth-mode' && next) {
      authModeRaw = next.trim().toLowerCase();
      i++;
    } else if (arg.startsWith('--auth-mode=')) {
      authModeRaw = arg.slice('--auth-mode='.length).trim().toLowerCase();
    } else if (arg === '--google') {
      authModeRaw = 'google';
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Wise-Spliter Dev Demo Seeder (LOCAL DEV ONLY)

Usage:
  make seed-demo
  make seed-demo USER_NAME="Your Name" USER_EMAIL="you@demo.local" [USER_UPI="you@upi"] [AUTH_MODE=password|google]
  bun run scripts/seed-demo-data.mjs --name "Your Name" --email "you@demo.local" [--upi "you@upi"] [--auth-mode password|google]
`);
      process.exit(0);
    }
  }

  if (authModeRaw !== 'password' && authModeRaw !== 'google') {
    throw new Error(`Invalid AUTH_MODE "${authModeRaw}": expected "password" or "google".`);
  }

  return {
    fullName,
    email,
    upiId,
    password,
    authMode: authModeRaw,
  };
}

async function ensureAuthUserAndProfile(params) {
  const supabase = getSupabaseAdmin();
  const normalizedEmail = params.email.toLowerCase();
  const nowIso = new Date().toISOString();
  const hlc = `${Date.now().toString(16).padStart(12, '0')}-0001-${params.id}`;

  if (params.authMode === 'google') {
    // Leave auth_user_id unbound (null) if not yet signed in via Google OAuth, so when the
    // user clicks "Continue with Google" for this email, resolveProfileForAuthUser binds it
    // directly to this seeded profile and all its groups & bills.
    const { data: existingProfile } = await supabase
      .from('profiles')
      .select('id, auth_user_id')
      .eq('email', normalizedEmail)
      .maybeSingle();

    const profileIdToUse = existingProfile?.id ?? params.id;
    const { error: upsertErr } = await supabase.from('profiles').upsert(
      {
        id: profileIdToUse,
        email: normalizedEmail,
        full_name: params.fullName,
        avatar_initials: params.avatarInitials,
        avatar_url: null,
        default_currency: params.defaultCurrency,
        upi_id: params.upiId,
        google_connected: Boolean(existingProfile?.auth_user_id),
        updated_at: nowIso,
        hlc,
      },
      { onConflict: 'id' }
    );
    if (upsertErr) {
      throw new Error(`Failed upserting profile ${normalizedEmail}: ${upsertErr.message}`);
    }
    return {
      authUserId: existingProfile?.auth_user_id ?? null,
    };
  }

  // Password mode (default): provision auto-confirmed user in local GoTrue (`auth.users`)
  // so NO real email inbox is needed in local dev.
  const existingAuth = params.existingAuthUsers.find(
    (u) => (u.email || '').toLowerCase() === normalizedEmail
  );

  let authUserId;
  if (!existingAuth) {
    const { data: created, error: createErr } = await supabase.auth.admin.createUser({
      email: normalizedEmail,
      password: params.password,
      email_confirm: true,
      user_metadata: {
        full_name: params.fullName,
        app_user_id: params.id,
      },
    });
    if (createErr || !created.user) {
      throw new Error(
        `Failed creating local Supabase Auth user ${normalizedEmail}: ${createErr?.message ?? 'unknown'}`
      );
    }
    authUserId = created.user.id;
  } else {
    const { error: updateErr } = await supabase.auth.admin.updateUserById(existingAuth.id, {
      password: params.password,
      email_confirm: true,
      user_metadata: {
        full_name: params.fullName,
        app_user_id: params.id,
      },
    });
    if (updateErr) {
      throw new Error(
        `Failed updating local Supabase Auth user ${normalizedEmail}: ${updateErr.message}`
      );
    }
    authUserId = existingAuth.id;
  }

  const { error: profileErr } = await supabase.from('profiles').upsert(
    {
      id: params.id,
      auth_user_id: authUserId,
      email: normalizedEmail,
      full_name: params.fullName,
      avatar_initials: params.avatarInitials,
      avatar_url: null,
      default_currency: params.defaultCurrency,
      upi_id: params.upiId,
      google_connected: false,
      updated_at: nowIso,
      hlc,
    },
    { onConflict: 'id' }
  );

  if (profileErr) {
    throw new Error(`Failed upserting ${SUPABASE_SCHEMA}.profiles: ${profileErr.message}`);
  }

  return { authUserId };
}

async function main() {
  // 1. Hard Dev-Only Guard (blocks production and non-loopback Supabase URLs)
  assertDevOnlyEnvironment('seed-demo-data', process.env, SUPABASE_URL);
  assertLocalSupabase('seed-demo-data');

  const opts = parseCliOptions(process.argv.slice(2));
  const effectivePassword = opts.password || DEV_DEFAULT_PASSWORD;
  if (effectivePassword.length < 6) {
    throw new Error('Password must be at least 6 characters.');
  }

  const publishableKey =
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ||
    process.env.VITE_SUPABASE_ANON_KEY?.trim() ||
    requireEnv('VITE_SUPABASE_PUBLISHABLE_KEY');

  const supabase = getSupabaseAdmin();
  const { data: listData, error: listErr } = await supabase.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });
  if (listErr) {
    throw new Error(
      `Could not reach local Supabase Auth at ${SUPABASE_URL}: ${listErr.message}`
    );
  }
  const existingAuthUsers = listData?.users ?? [];

  // 2. Always ensure the 3 base collaborator/demo profiles exist so group member foreign links resolve
  for (const demo of DEV_DEMO_PROFILES) {
    await ensureAuthUserAndProfile({
      id: demo.id,
      email: demo.email,
      fullName: demo.fullName,
      avatarInitials: demo.avatarInitials,
      defaultCurrency: demo.defaultCurrency,
      upiId: demo.upiId,
      password: DEV_DEFAULT_PASSWORD,
      authMode: 'password',
      existingAuthUsers,
    });
  }

  // 3. Build target dataset (either canonical demo user or custom Name + Email user)
  const built = buildDemoDatasetForUser(initialMockData, {
    fullName: opts.fullName,
    email: opts.email,
    upiId: opts.upiId,
  });

  // If custom user already had an existing profile row with a different ID (e.g. prior Google sign-in),
  // reuse that profile ID so everything attaches to their existing account cleanly.
  const { data: preExistingProfile } = await supabase
    .from('profiles')
    .select('id')
    .eq('email', built.email)
    .maybeSingle();

  const finalProfileId = preExistingProfile?.id ?? built.profileId;

  if (finalProfileId !== built.profileId) {
    built.dataset.currentUser.id = finalProfileId;
    for (const grp of built.dataset.groups) {
      for (const mem of grp.members) {
        if (mem.userId === built.profileId) {
          mem.userId = finalProfileId;
        }
      }
    }
  }

  await ensureAuthUserAndProfile({
    id: finalProfileId,
    email: built.email,
    fullName: built.fullName,
    avatarInitials: built.avatarInitials,
    defaultCurrency: 'INR',
    upiId: built.upiId,
    password: effectivePassword,
    authMode: opts.authMode,
    existingAuthUsers,
  });

  // 4. Reset dev quotas for these profiles, seed dataset into wise_spliter.*, and claim memberships
  const quotaTargets = Array.from(
    new Set([...DEV_DEMO_PROFILES.map((p) => p.id), finalProfileId])
  );
  await resetDevQuotas(quotaTargets);
  await seedDevDataset(built.dataset);
  await claimMembers(finalProfileId);
  await resetDevQuotas(quotaTargets);

  // 5. Verify seeded rows via the database's tenant-isolated pull_changes RPC
  const pulled = await pullChanges(finalProfileId, '0', 500);
  const pulledGroups = pulled.changes.filter((c) => c.entity === 'group' && !c.deleted).length;
  const pulledExpenses = pulled.changes.filter((c) => c.entity === 'expense').length;

  // Verify password sign-in works end-to-end when in password mode
  if (opts.authMode === 'password') {
    const browserClient = createClient(SUPABASE_URL, publishableKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { error: signInErr } = await browserClient.auth.signInWithPassword({
      email: built.email,
      password: effectivePassword,
    });
    if (signInErr) {
      throw new Error(`Password login verification failed for ${built.email}: ${signInErr.message}`);
    }
  }

  const appPort = process.env.APP_PORT || '4173';
  const divider = '='.repeat(100);
  const thin = '-'.repeat(100);

  console.log(`\n${divider}`);
  console.log('  WISE-SPLITER DEV DEMO DATA SEEDED SUCCESSFULLY (LOCAL DEV ONLY)');
  console.log(divider);
  console.log(`  Target Database    : ${SUPABASE_URL} (schema: ${SUPABASE_SCHEMA})`);
  console.log(`  Profile ID         : ${finalProfileId}`);
  console.log(`  User Name          : ${built.fullName} (${built.avatarInitials})`);
  console.log(`  User Email         : ${built.email}`);
  console.log(`  UPI ID             : ${built.upiId}`);
  console.log(
    `  Auth Mode          : ${
      opts.authMode === 'google'
        ? 'Google OAuth Ready (click "Continue with Google" in UI)'
        : `Email + Password Verified (${opts.password ? 'customUSER_PASSWORD' : '$DEV_USER_PASSWORD from .env.development'})`
    }`
  );
  console.log(thin);
  console.log(
    `  Seeded & Verified  : ${pulledGroups} Groups | ${pulledExpenses} Bills (incl. Direct Split & Trash) | ${built.dataset.settlements.length} Settlement`
  );
  console.log(`  Groups Associated  : ${built.dataset.groups.map((g) => g.name).join(' · ')}`);
  console.log(thin);
  if (!built.isCustomUser) {
    console.log(
      `  How to Sign In     : Open http://localhost:${appPort} -> Account button -> Click "1-Tap Demo Sandbox"`
    );
    console.log(
      `                       OR enter Email "${built.email}" + $DEV_USER_PASSWORD`
    );
  } else if (opts.authMode === 'google') {
    console.log(
      `  How to Sign In     : Open http://localhost:${appPort} -> Account button -> Click "Continue with Google" (${built.email})`
    );
  } else {
    console.log(
      `  How to Sign In     : Open http://localhost:${appPort} -> Account button -> Sign in with:`
    );
    console.log(
      `                       Email: ${built.email}   |   Password: ${
        opts.password ? '(your USER_PASSWORD)' : 'value of DEV_USER_PASSWORD in .env.development'
      }`
    );
  }
  console.log(`${divider}\n`);
}

main().catch((err) => {
  console.error(
    '[seed-demo-data] ERROR:',
    err instanceof Error ? err.message : String(err)
  );
  process.exit(1);
});
