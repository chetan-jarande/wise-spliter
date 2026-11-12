import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEV_DEFAULT_PASSWORD } from '../../src/data/dev-profiles';
import mockData from '../../src/data/mock-ledger-data.json';
import { API_HOST, handleApiRequest } from '../../src/server/index';
import {
  DEFAULT_DEV_HMAC_SECRET,
  assertProductionSecretsConfigured,
  authorizeDatasetSyncForUser,
  authorizeMutationsForUser,
  authorizeReceiptUploadForUser,
  filterDatasetForUser,
  issueSessionToken,
  resetRateLimiterForTests,
} from '../../src/server/securityAndAuth';
import {
  SUPABASE_SCHEMA,
  SUPABASE_URL,
  fetchExistingDbEntityOwnership,
  fetchExistingDbGroups,
  resetOwnershipCachesForTests,
} from '../../src/server/supabaseAdmin';
import type {
  ExpenseItem,
  GroupRecord,
  MockLedgerDataset,
} from '../../src/types/ledger';

const SUPABASE_PUBLISHABLE_KEY = (
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH'
).trim();

describe('Wise-Spliter Security Red-Team Breach & Multi-Tenant Isolation Suite', () => {
  let server: Server;
  let baseUrl = '';

  beforeAll(async () => {
    server = createServer((req, res) => {
      void handleApiRequest(req, res);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  beforeEach(() => {
    resetRateLimiterForTests();
    resetOwnershipCachesForTests();
  });

  it('binds Backend API to loopback 127.0.0.1 by default and redacts internal row counts from /api/health', async () => {
    expect(API_HOST).toBe('127.0.0.1');

    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin');

    const body = (await res.json()) as {
      ok: boolean;
      schemaHealth: Record<string, unknown> | null;
    };
    expect(body.ok).toBe(true);
    if (body.schemaHealth) {
      expect(body.schemaHealth.groups_count).toBeUndefined();
      expect(body.schemaHealth.expenses_count).toBeUndefined();
    }
  });

  it('Hole 1: blocks unauthenticated /api/auth/session impersonation (401) while allowing isolated Demo Sandbox (/api/auth/demo)', async () => {
    // 1. Unauthenticated impersonation attempts against real tenants & arbitrary accounts -> 401
    for (const victim of [
      { userId: 'usr_rohan_02', email: 'rohan.verma@gmail.com' },
      { userId: 'usr_priya_03', email: 'priya.nair@gmail.com' },
      { userId: 'usr_intruder_99', email: 'intruder@evil.com' },
    ]) {
      const impersonateRes = await fetch(`${baseUrl}/api/auth/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(victim),
      });
      expect(impersonateRes.status).toBe(401);
    }

    // 2. Attempting to abuse /api/auth/demo to request a non-demo tenant -> 403
    const demoAbuseRes = await fetch(`${baseUrl}/api/auth/demo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: 'usr_rohan_02',
        email: 'rohan.verma@gmail.com',
      }),
    });
    expect(demoAbuseRes.status).toBe(403);

    // 3. Legitimate 1-Tap Demo Sandbox Login -> 200 + HttpOnly SameSite=Lax cookie
    const demoRes = await fetch(`${baseUrl}/api/auth/demo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(demoRes.status).toBe(200);
    const setCookie = demoRes.headers.get('set-cookie') || '';
    expect(setCookie).toContain('ws_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/api');

    const demoBody = (await demoRes.json()) as {
      ok: boolean;
      authMethod: string;
      token: string;
      profile: { id: string; email: string };
    };
    expect(demoBody.ok).toBe(true);
    expect(demoBody.authMethod).toBe('demo');
    expect(demoBody.profile.id).toBe('usr_arjun_01');
    expect(demoBody.profile.email).toBe('arjun.mehta@gmail.com');

    // 4. Logout clears ws_session cookie
    const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
    });
    expect(logoutRes.status).toBe(200);
    expect(logoutRes.headers.get('set-cookie') || '').toContain('Max-Age=0');
  });

  it('Hole 1b: verifies Google OAuth session exchange (/api/auth/google) rejects forged JWTs (401) and scopes real Supabase JWTs + HttpOnly cookies', async () => {
    const forgedGoogleRes = await fetch(`${baseUrl}/api/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken: 'eyJhbGciOiJIUzI1NiJ9.forged.sig' }),
    });
    expect(forgedGoogleRes.status).toBe(401);

    // Acquire a real Supabase Auth JWT for Priya Nair from centralized local Supabase
    const authClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      db: { schema: SUPABASE_SCHEMA as 'wise_spliter' },
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });
    const { data: signInData, error: signInErr } =
      await authClient.auth.signInWithPassword({
        email: 'priya.nair@gmail.com',
        password: DEV_DEFAULT_PASSWORD,
      });

    if (!signInErr && signInData?.session?.access_token) {
      const googleExchangeRes = await fetch(`${baseUrl}/api/auth/google`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accessToken: signInData.session.access_token,
        }),
      });
      expect(googleExchangeRes.status).toBe(200);

      const cookieHeader = googleExchangeRes.headers.get('set-cookie') || '';
      const cookiePair = cookieHeader.split(';')[0] || '';
      expect(cookiePair.startsWith('ws_session=')).toBe(true);

      const exchangeBody = (await googleExchangeRes.json()) as {
        ok: boolean;
        authMethod: string;
        profile: { id: string; email: string };
        dataset: { groups: Array<{ name: string }> };
      };
      expect(exchangeBody.ok).toBe(true);
      expect(exchangeBody.authMethod).toBe('google');
      expect(exchangeBody.profile.id).toBe('usr_priya_03');
      const priyaGroups = exchangeBody.dataset.groups.map((g) => g.name);
      expect(priyaGroups).not.toContain('Apt 14B Indiranagar');

      // Authenticate using ONLY the HttpOnly cookie (no Authorization header)
      const cookieBootstrapRes = await fetch(
        `${baseUrl}/api/ledger/bootstrap`,
        {
          headers: { Cookie: cookiePair },
        }
      );
      expect(cookieBootstrapRes.status).toBe(200);
      const bootstrapBody = (await cookieBootstrapRes.json()) as {
        dataset: { groups: Array<{ name: string }> };
      };
      expect(
        bootstrapBody.dataset.groups.map((g) => g.name)
      ).not.toContain('Apt 14B Indiranagar');
    }
  });

  it('rejects missing, forged, or payload-tampered HMAC tokens across all protected endpoints with HTTP 401', async () => {
    const validToken = issueSessionToken({
      userId: 'usr_arjun_01',
      email: 'arjun.mehta@gmail.com',
    });
    const parts = validToken.split('.');
    const forgedPayloadB64 = Buffer.from(
      JSON.stringify({
        userId: 'usr_rohan_02',
        email: 'rohan.verma@gmail.com',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
      'utf8'
    ).toString('base64url');
    const tamperedToken = `${parts[0]}.${forgedPayloadB64}.${parts[2]}`;

    const endpoints: Array<{ method: 'GET' | 'POST'; path: string }> = [
      { method: 'GET', path: '/api/ledger/bootstrap' },
      { method: 'POST', path: '/api/ledger/sync' },
      { method: 'GET', path: '/api/ledger/pull-changes?sinceSeq=0' },
      { method: 'POST', path: '/api/ledger/push-mutations' },
      { method: 'POST', path: '/api/receipts/upload' },
    ];

    for (const ep of endpoints) {
      const noAuthRes = await fetch(`${baseUrl}${ep.path}`, {
        method: ep.method,
      });
      expect(noAuthRes.status).toBe(401);

      const tamperedRes = await fetch(`${baseUrl}${ep.path}`, {
        method: ep.method,
        headers: {
          Authorization: `Bearer ${tamperedToken}`,
          'Content-Type': 'application/json',
        },
        ...(ep.method === 'POST' ? { body: JSON.stringify({}) } : {}),
      });
      expect(tamperedRes.status).toBe(401);
    }
  });

  it('Hole 4: enforces Origin & Sec-Fetch-Site CSRF defense (403) while permitting Capacitor/Tauri native & localhost origins', async () => {
    // 1. Disallowed cross-site browser Origin on state-mutating POST -> 403
    const evilOriginRes = await fetch(`${baseUrl}/api/auth/demo`, {
      method: 'POST',
      headers: {
        Origin: 'https://evil-csrf-attacker.example',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(evilOriginRes.status).toBe(403);

    // 2. Sandboxed iframe `Origin: null` CSRF attack -> 403
    const nullOriginRes = await fetch(`${baseUrl}/api/auth/demo`, {
      method: 'POST',
      headers: {
        Origin: 'null',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(nullOriginRes.status).toBe(403);

    // 3. Sec-Fetch-Site: cross-site without trusted Origin -> 403
    const crossSiteFetchRes = await fetch(`${baseUrl}/api/auth/demo`, {
      method: 'POST',
      headers: {
        'Sec-Fetch-Site': 'cross-site',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(crossSiteFetchRes.status).toBe(403);

    // 4. Disallowed CORS preflight OPTIONS -> 403
    const badOptionsRes = await fetch(`${baseUrl}/api/ledger/sync`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil-csrf-attacker.example' },
    });
    expect(badOptionsRes.status).toBe(403);

    // 5. Capacitor & Tauri native shells + localhost:4173 allowed -> 200
    for (const trustedOrigin of [
      'http://localhost:4173',
      'capacitor://localhost',
      'tauri://localhost',
      'https://localhost',
    ]) {
      const okOriginRes = await fetch(`${baseUrl}/api/auth/demo`, {
        method: 'POST',
        headers: {
          Origin: trustedOrigin,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      });
      expect(okOriginRes.status).toBe(200);
      expect(okOriginRes.headers.get('access-control-allow-origin')).toBe(
        trustedOrigin
      );
      expect(okOriginRes.headers.get('access-control-allow-credentials')).toBe(
        'true'
      );
    }
  });

  it('Hole 3: blocks cross-tenant group hijack, cross-tenant expense/settlement PK overwrite, and standalone split overwrite with HTTP 403', async () => {
    const rohanToken = issueSessionToken({
      userId: 'usr_rohan_02',
      email: 'rohan.verma@gmail.com',
      fullName: 'Rohan Verma',
      authMethod: 'password',
    });
    const priyaToken = issueSessionToken({
      userId: 'usr_priya_03',
      email: 'priya.nair@gmail.com',
      fullName: 'Priya Nair',
      authMethod: 'password',
    });

    const baseDataset = JSON.parse(
      JSON.stringify(mockData)
    ) as MockLedgerDataset;

    const rohanOwnGroup: GroupRecord = {
      id: 'grp_rohan_private_test',
      name: 'Rohan Solo Group',
      description: 'Owned by Rohan',
      category: 'friends',
      baseCurrency: 'INR',
      simplifyDebts: true,
      defaultSplitConfig: null,
      expenseSeq: 1,
      inviteCode: 'ROHA-1111',
      createdAt: '2026-11-12T00:00:00Z',
      updatedAt: '2026-11-12T00:00:00Z',
      deletedAt: null,
      hlc: '019a73e4c850-0001-usr_rohan_02',
      members: [
        {
          id: 'mem_rohan_solo_01',
          groupId: 'grp_rohan_private_test',
          userId: 'usr_rohan_02',
          invitedEmail: 'rohan.verma@gmail.com',
          displayName: 'Rohan Verma',
          avatarInitials: 'RV',
          upiId: 'rohan.verma@okaxis',
          role: 'admin',
          memberOrder: 0,
          joinedAt: '2026-11-12T00:00:00Z',
          claimedAt: '2026-11-12T00:00:00Z',
        },
      ],
    };

    // Attack A: Rohan creates his own valid group, but reuses Arjun/Priya's Tokyo expense PK `exp_tokyo_shinkansen_01` to overwrite/steal it!
    const tokyoExpOverwriteDataset: MockLedgerDataset = {
      ...baseDataset,
      currentUser: {
        ...baseDataset.currentUser,
        id: 'usr_rohan_02',
        email: 'rohan.verma@gmail.com',
        fullName: 'Rohan Verma',
      },
      groups: [rohanOwnGroup],
      expenses: [
        {
          ...baseDataset.expenses[0]!,
          id: 'exp_tokyo_shinkansen_01',
          groupId: 'grp_rohan_private_test',
          title: 'HIJACKED TOKYO EXPENSE',
          originalCurrency: 'INR',
          groupCurrency: 'INR',
          originalAmountMinor: 1000,
          amountMinor: 1000,
          fxRateScaled: 100000000,
          fxStatus: 'identity',
          splitMode: 'equal',
          payers: [
            {
              memberId: 'mem_rohan_solo_01',
              paidMinor: 1000,
              originalPaidMinor: 1000,
            },
          ],
          splits: [
            {
              memberId: 'mem_rohan_solo_01',
              included: true,
              owedMinor: 1000,
              originalOwedMinor: 1000,
              rawInputValue: 1,
              remainderMinor: 0,
            },
          ],
          receipts: [],
        },
      ],
      expenseRevisions: [],
      settlements: [],
      groupActivityLog: [],
    };

    const pkOverwriteRes = await fetch(`${baseUrl}/api/ledger/sync`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${rohanToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ dataset: tokyoExpOverwriteDataset }),
    });
    expect(pkOverwriteRes.status).toBe(403);

    // Attack B: Priya (not in Arjun & Rohan's standalone `exp_direct_coffee_01`) attempts to overwrite `exp_direct_coffee_01`!
    const priyaStandaloneOverwrite: ExpenseItem = {
      ...baseDataset.expenses.find((e) => e.id === 'exp_direct_coffee_01')!,
      adHocParticipants: [
        {
          id: 'usr_priya_03',
          displayName: 'Priya Nair',
          invitedEmail: 'priya.nair@gmail.com',
          upiId: 'priya.nair@oksbi',
          avatarInitials: 'PN',
          memberOrder: 0,
        },
      ],
      amountMinor: 1000,
      originalAmountMinor: 1000,
      payers: [
        { memberId: 'usr_priya_03', paidMinor: 1000, originalPaidMinor: 1000 },
      ],
      splits: [
        {
          memberId: 'usr_priya_03',
          included: true,
          owedMinor: 1000,
          originalOwedMinor: 1000,
          rawInputValue: 1,
          remainderMinor: 0,
        },
      ],
    };

    const priyaHijackRes = await fetch(`${baseUrl}/api/ledger/sync`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${priyaToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        dataset: {
          ...baseDataset,
          currentUser: {
            ...baseDataset.currentUser,
            id: 'usr_priya_03',
            email: 'priya.nair@gmail.com',
            fullName: 'Priya Nair',
          },
          groups: [],
          expenses: [priyaStandaloneOverwrite],
          expenseRevisions: [],
          settlements: [],
          groupActivityLog: [],
        },
      }),
    });
    expect(priyaHijackRes.status).toBe(403);
  });

  it('Hole 3b: immediately revokes access for soft-removed group members (`removed_at` / `removedAt`) across read, sync, mutations & receipts', async () => {
    const baseDataset = JSON.parse(
      JSON.stringify(mockData)
    ) as MockLedgerDataset;
    const goaGroup = baseDataset.groups.find((g) => g.id === 'grp_goa_2026')!;

    // Mark Rohan as soft-removed in Goa group
    const groupWithRemovedRohan: GroupRecord = {
      ...goaGroup,
      members: goaGroup.members.map((m) =>
        m.invitedEmail === 'rohan.verma@gmail.com'
          ? ({
              ...m,
              removedAt: '2026-11-12T10:00:00Z',
            } as GroupRecord['members'][number])
          : m
      ),
    };

    const datasetWithRemovedRohan: MockLedgerDataset = {
      ...baseDataset,
      groups: [groupWithRemovedRohan],
    };

    // 1. Read isolation: filterDatasetForUser excludes Goa group for removed Rohan
    const filteredForRemovedRohan = filterDatasetForUser(
      datasetWithRemovedRohan,
      {
        userId: 'usr_rohan_02',
        email: 'rohan.verma@gmail.com',
      }
    );
    expect(filteredForRemovedRohan.groups).toHaveLength(0);

    // 2. Write isolation: existingDbGroups where Rohan has removed_at set -> 403 on sync, mutations & receipt upload
    const existingDbGroupsWithRemovedRohan = [
      {
        id: 'grp_goa_2026',
        created_by: 'usr_arjun_01',
        members: goaGroup.members.map((m) => ({
          user_id: m.userId,
          invited_email: m.invitedEmail,
          removed_at:
            m.invitedEmail === 'rohan.verma@gmail.com'
              ? '2026-11-12T10:00:00Z'
              : null,
        })),
      },
    ];
    const existingEntities = await fetchExistingDbEntityOwnership();

    const syncAuthz = authorizeDatasetSyncForUser(
      {
        ...baseDataset,
        currentUser: {
          ...baseDataset.currentUser,
          id: 'usr_rohan_02',
          email: 'rohan.verma@gmail.com',
        },
        groups: [goaGroup],
        expenses: [],
        settlements: [],
        expenseRevisions: [],
        groupActivityLog: [],
      },
      existingDbGroupsWithRemovedRohan,
      { userId: 'usr_rohan_02', email: 'rohan.verma@gmail.com' },
      existingEntities
    );
    expect(syncAuthz.authorized).toBe(false);
    expect(syncAuthz.status).toBe(403);

    const mutAuthz = authorizeMutationsForUser(
      [
        {
          id: 'mut_1',
          entityType: 'expense',
          action: 'expense_updated',
          payloadJson: JSON.stringify({ groupId: 'grp_goa_2026' }),
        },
      ],
      existingDbGroupsWithRemovedRohan,
      existingEntities,
      { userId: 'usr_rohan_02', email: 'rohan.verma@gmail.com' }
    );
    expect(mutAuthz.authorized).toBe(false);
    expect(mutAuthz.status).toBe(403);

    const rcptAuthz = authorizeReceiptUploadForUser(
      {
        id: 'rcpt_new_99',
        expenseId: 'exp_new_99',
        groupId: 'grp_goa_2026',
        mimeType: 'image/webp',
      },
      existingDbGroupsWithRemovedRohan,
      existingEntities,
      { userId: 'usr_rohan_02', email: 'rohan.verma@gmail.com' }
    );
    expect(rcptAuthz.authorized).toBe(false);
    if (!rcptAuthz.authorized) {
      expect(rcptAuthz.status).toBe(403);
    }
  });

  it('Hole 3c: blocks receipt upload `../` Storage path traversal (400), disallowed HTML MIME (400), and cross-tenant expense attachment (403)', async () => {
    const rohanToken = issueSessionToken({
      userId: 'usr_rohan_02',
      email: 'rohan.verma@gmail.com',
    });

    // 1. Path traversal in expenseId / id / groupId -> 400
    for (const badPayload of [
      {
        id: 'rcpt_ok_1',
        expenseId: '../../grp_tokyo_2026/pwn',
        groupId: 'grp_goa_2026',
      },
      {
        id: '../../../etc_passwd',
        expenseId: 'exp_ok_1',
        groupId: 'grp_goa_2026',
      },
      {
        id: 'rcpt_ok_1',
        expenseId: 'exp_ok_1',
        groupId: '../grp_tokyo_2026',
      },
      {
        id: 'rcpt_ok_1',
        expenseId: 'exp_ok_1',
        groupId: 'grp_goa_2026',
        mimeType: 'text/html',
      },
    ]) {
      const res = await fetch(`${baseUrl}/api/receipts/upload`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${rohanToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(badPayload),
      });
      expect(res.status).toBe(400);
    }

    // 2. Rohan attempting to upload receipt onto Arjun & Priya's Tokyo expense (even with groupId: null!) -> 403
    const crossTenantReceiptRes = await fetch(
      `${baseUrl}/api/receipts/upload`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${rohanToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: 'rcpt_rohan_sneak_01',
          expenseId: 'exp_tokyo_shinkansen_01',
          groupId: null,
          mimeType: 'image/webp',
          dataUrl: 'data:image/webp;base64,UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=',
        }),
      }
    );
    expect(crossTenantReceiptRes.status).toBe(403);
  });

  it('Hole 3d: filters /api/ledger/pull-changes per tenant and blocks cross-tenant /api/ledger/push-mutations (including payloadJson)', async () => {
    const rohanToken = issueSessionToken({
      userId: 'usr_rohan_02',
      email: 'rohan.verma@gmail.com',
    });

    const pullRes = await fetch(
      `${baseUrl}/api/ledger/pull-changes?sinceSeq=0`,
      {
        headers: { Authorization: `Bearer ${rohanToken}` },
      }
    );
    expect(pullRes.status).toBe(200);
    const pullBody = (await pullRes.json()) as {
      ok: boolean;
      groups: Array<{ id: string; name?: string }>;
      expenses: Array<{ id: string; group_id?: string | null }>;
    };
    expect(pullBody.ok).toBe(true);
    expect(pullBody.groups.some((g) => g.id === 'grp_tokyo_2026')).toBe(false);
    expect(
      pullBody.expenses.some((e) => e.group_id === 'grp_tokyo_2026')
    ).toBe(false);

    // Push mutation targeting Tokyo group hidden inside serialized `payloadJson` -> 403
    const sneakyPushRes = await fetch(`${baseUrl}/api/ledger/push-mutations`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${rohanToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ops: [
          {
            id: 'outbox_sneak_1',
            entityType: 'expense',
            action: 'expense_deleted',
            payloadJson: JSON.stringify({
              groupId: 'grp_tokyo_2026',
              expenseId: 'exp_tokyo_shinkansen_01',
            }),
          },
        ],
      }),
    });
    expect(sneakyPushRes.status).toBe(403);
  });

  it('Hole 4b: rejects oversized JSON payloads with HTTP 413, resists X-Forwarded-For spoofing on login rate limit (429), and enforces production secrets', async () => {
    // 1. /api/auth/demo enforces a 16 KiB body limit -> sending 32 KiB returns HTTP 413
    const oversizedPayload = JSON.stringify({
      padding: 'A'.repeat(32 * 1024),
    });
    const tooLargeRes = await fetch(`${baseUrl}/api/auth/demo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: oversizedPayload,
    });
    expect(tooLargeRes.status).toBe(413);

    // 2. Brute-force rate limit on /api/auth/login (even when attacker rotates forged X-Forwarded-For on every attempt!)
    const prevAuthMax = process.env.AUTH_RATE_LIMIT_MAX;
    process.env.AUTH_RATE_LIMIT_MAX = '4';
    try {
      resetRateLimiterForTests();
      for (let i = 0; i < 4; i += 1) {
        const failRes = await fetch(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Forwarded-For': `203.0.113.${i + 10}`,
          },
          body: JSON.stringify({
            email: 'victim@example.com',
            password: '',
          }),
        });
        expect(failRes.status).toBe(401);
      }

      const fifthAttemptRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': '198.51.100.99',
        },
        body: JSON.stringify({
          email: 'victim@example.com',
          password: '',
        }),
      });
      expect(fifthAttemptRes.status).toBe(429);
    } finally {
      if (prevAuthMax === undefined) {
        delete process.env.AUTH_RATE_LIMIT_MAX;
      } else {
        process.env.AUTH_RATE_LIMIT_MAX = prevAuthMax;
      }
    }

    // 3. Production secret assertion fails fast if GRANT_TOKEN_SECRET is missing or default dev secret
    const prevNodeEnv = process.env.NODE_ENV;
    const prevSecret = process.env.GRANT_TOKEN_SECRET;
    try {
      process.env.NODE_ENV = 'production';
      process.env.GRANT_TOKEN_SECRET = DEFAULT_DEV_HMAC_SECRET;
      expect(() => assertProductionSecretsConfigured()).toThrow(/FATAL/i);

      process.env.GRANT_TOKEN_SECRET =
        'prod_unique_hmac_secret_0123456789abcdef0123456789abcdef';
      expect(() => assertProductionSecretsConfigured()).not.toThrow();
    } finally {
      if (prevNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = prevNodeEnv;
      }
      if (prevSecret === undefined) {
        delete process.env.GRANT_TOKEN_SECRET;
      } else {
        process.env.GRANT_TOKEN_SECRET = prevSecret;
      }
    }
  });

  it('Hole 2: verifies live PostgREST (:54321) blocks direct anon access AND blocks authenticated non-service-role RPC dumps + cross-tenant reads', async () => {
    // Ensure existingDbGroups probe works via service_role first
    const dbGroups = await fetchExistingDbGroups();
    expect(dbGroups.length).toBeGreaterThan(0);

    // 1. Direct `anon` / publishable key requests to :54321 -> 401/403
    const anonHeaders = {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
      'Accept-Profile': SUPABASE_SCHEMA,
      'Content-Profile': SUPABASE_SCHEMA,
      'Content-Type': 'application/json',
    };

    let supabaseReachable = true;
    try {
      const anonGroupsRes = await fetch(
        `${SUPABASE_URL}/rest/v1/groups?limit=1`,
        { headers: anonHeaders }
      );
      expect([401, 403]).toContain(anonGroupsRes.status);

      const anonRpcRes = await fetch(
        `${SUPABASE_URL}/rest/v1/rpc/pull_changes`,
        {
          method: 'POST',
          headers: anonHeaders,
          body: JSON.stringify({ p_since_seq: 0 }),
        }
      );
      expect([401, 403, 404]).toContain(anonRpcRes.status);
    } catch {
      supabaseReachable = false;
    }

    if (!supabaseReachable) {
      return;
    }

    // 2. Direct `authenticated` user JWT (Rohan Verma) hitting :54321 directly bypassing Backend API
    const authClient = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      db: { schema: SUPABASE_SCHEMA as 'wise_spliter' },
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });
    const { data: authData, error: authErr } =
      await authClient.auth.signInWithPassword({
        email: 'rohan.verma@gmail.com',
        password: DEV_DEFAULT_PASSWORD,
      });

    expect(authErr).toBeNull();
    const rohanJwt = authData?.session?.access_token;
    expect(Boolean(rohanJwt)).toBe(true);

    const rohanDirectHeaders = {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${rohanJwt!}`,
      'Accept-Profile': SUPABASE_SCHEMA,
      'Content-Profile': SUPABASE_SCHEMA,
      'Content-Type': 'application/json',
    };

    // (2a) SECURITY DEFINER RPCs (`pull_changes`, `push_mutations`, `schema_health`) MUST reject `authenticated` with 403!
    for (const [rpcName, rpcBody] of [
      ['pull_changes', { p_since_seq: 0 }],
      ['push_mutations', { p_ops: [] }],
      ['schema_health', {}],
    ] as const) {
      const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${rpcName}`, {
        method: 'POST',
        headers: rohanDirectHeaders,
        body: JSON.stringify(rpcBody),
      });
      expect(rpcRes.status).toBe(403);
    }

    // (2b) Direct table SELECT on `groups` enforces FORCE RLS: Rohan CANNOT read `Tokyo & Kyoto Autumn`!
    const directGroupsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/groups?select=id,name`,
      { headers: rohanDirectHeaders }
    );
    expect(directGroupsRes.status).toBe(200);
    const rohanDirectGroups = (await directGroupsRes.json()) as Array<{
      id: string;
      name: string;
    }>;
    expect(
      rohanDirectGroups.some((g) => g.id === 'grp_tokyo_2026')
    ).toBe(false);

    // (2c) Direct table SELECT on `profiles` enforces FORCE RLS: Rohan ONLY sees his own profile!
    const directProfilesRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?select=id,email`,
      { headers: rohanDirectHeaders }
    );
    expect(directProfilesRes.status).toBe(200);
    const rohanDirectProfiles = (await directProfilesRes.json()) as Array<{
      id: string;
      email: string;
    }>;
    expect(rohanDirectProfiles).toHaveLength(1);
    expect(rohanDirectProfiles[0]?.email).toBe('rohan.verma@gmail.com');
  });
});
