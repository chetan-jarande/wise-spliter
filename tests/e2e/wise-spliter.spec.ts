import { expect, test } from '@playwright/test';
import mockData from '../../src/data/mock-ledger-data.json' with { type: 'json' };

test.describe('Wise-Spliter Full-Stack User Story E2E Suite (UI + Backend API + Supabase)', () => {
  test('User Story 1: Minimalist Home Dashboard, Interactive Help Guide, Top-3 Recent Groups & Direct Non-Group Split Flow', async ({
    page,
  }) => {
    await page.goto('/');

    // 1. Verify Minimalist Home Dashboard, Plain-English Standing, Quick-Start & Contextual Page Guide
    await expect(page.getByTestId('home-dashboard-page')).toBeVisible();
    await expect(page.getByTestId('home-plain-english-hero-summary')).toBeVisible();
    await expect(page.getByTestId('first-time-quickstart-strip')).toBeVisible();
    await expect(page.getByTestId('contextual-page-guide')).toBeVisible();
    await expect(page.getByTestId('home-you-are-owed-amount')).toBeVisible();
    await expect(page.getByTestId('home-you-owe-amount')).toBeVisible();
    await expect(page.getByTestId('home-net-balance-amount')).toBeVisible();

    // 2. Open and close Interactive Help Guide Modal
    await page.getByTestId('header-help-btn').click();
    const helpModal = page.getByTestId('help-guide-modal');
    await expect(helpModal).toBeVisible();
    await page.getByTestId('close-help-modal-btn').click();
    await expect(helpModal).toBeHidden();

    // 3. Verify Top 3 Recent Groups constraint (4 groups exist in mockData, strictly 3 shown on Home)
    expect(mockData.groups.length).toBe(4);
    const recentGroupsGrid = page.getByTestId('home-recent-groups-grid');
    await expect(recentGroupsGrid).toBeVisible();
    await expect(
      recentGroupsGrid.locator('[data-testid^="home-recent-group-card-"]')
    ).toHaveCount(3);

    // 4. Open Quick Add Expense from Home -> defaults to "" (No Group)
    await page.getByTestId('home-quick-add-expense-btn').click();
    const scopeSelect = page.getByTestId('expense-group-scope-select');
    await expect(scopeSelect).toBeVisible();
    await expect(scopeSelect).toHaveValue('');
    await expect(page.getByTestId('adhoc-participants-panel')).toBeVisible();

    // Add custom participant "Vikram Rao"
    await page.getByTestId('adhoc-friend-name-input').fill('Vikram Rao');
    await page.getByTestId('add-adhoc-friend-btn').click();
    await expect(page.getByTestId('adhoc-participants-panel')).toContainText('Vikram Rao');

    // Fill "Late Night Shawarma & Chai" (₹900) and verify Settl presets + Splitwise live sentence + Backend API sync
    await expect(page.getByTestId('ux-quick-amount-presets')).toBeVisible();
    await page.getByTestId('expense-title-input').fill('Late Night Shawarma & Chai');
    await page.getByTestId('expense-amount-input').fill('900');
    await expect(page.getByTestId('ux-live-split-sentence')).toBeVisible();

    const syncResPromise = page.waitForResponse(
      (res) =>
        res.url().includes('/api/ledger/sync') &&
        res.request().method() === 'POST'
    );
    await page.getByTestId('save-expense-btn').click();
    const syncRes = await syncResPromise;
    expect(syncRes.status()).toBe(200);

    const directExpensesList = page.getByTestId('home-direct-expenses-list');
    await expect(directExpensesList).toBeVisible();
    await expect(directExpensesList).toContainText('Late Night Shawarma & Chai');
    await expect(directExpensesList).toContainText('₹900.00');
    await expect(directExpensesList.getByTestId('expense-personal-impact-pill').first()).toBeVisible();
  });

  test('User Story 2: Progressive Group Workspace, Offline Conflict Resolution, Explain Balance & 5 Split Modes + Receipt Upload', async ({
    page,
  }) => {
    await page.goto('/');

    // 1. Open "Goa Villa & Scuba 2026" from Home
    await page.getByTestId('open-group-workspace-grp_goa_2026').click();
    await expect(page.getByTestId('group-minimal-insights-bar')).toBeVisible();
    await expect(page.getByTestId('group-auto-guide-strip')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Goa Villa & Scuba 2026' })).toBeVisible();

    // 2. Resolve concurrent offline conflict banner on "Thalassa Cliff Dinner"
    const conflictBanner = page.getByTestId('conflict-resolution-banner');
    await expect(conflictBanner).toBeVisible();
    await expect(conflictBanner).toContainText('Thalassa Cliff Dinner');

    const conflictSyncPromise = page.waitForResponse(
      (res) =>
        res.url().includes('/api/ledger/sync') &&
        res.request().method() === 'POST'
    );
    await page.getByTestId('keep-active-revision-btn').first().click();
    const conflictSyncRes = await conflictSyncPromise;
    expect(conflictSyncRes.status()).toBe(200);
    await expect(conflictBanner).toBeHidden();

    // 3. Open "Explain This Balance" modal and verify plain-English verdict + exact math identity
    await page.getByTestId('explain-balance-btn').first().click();
    const explainModal = page.getByTestId('explain-balance-modal');
    await expect(explainModal).toBeVisible();
    await expect(page.getByTestId('explain-plain-english-verdict')).toBeVisible();
    await expect(explainModal).toContainText(
      'Exact Ledger Identity: Total Paid - Total Share + Settlements Sent - Settlements Received = Net Balance'
    );
    await expect(explainModal).toContainText('Assagao Pool Villa');
    await page.getByTestId('close-explain-modal-btn').click();
    await expect(explainModal).toBeHidden();

    // 4. Open "Add Expense" inside group workspace and verify grp_goa_2026 is pre-selected
    await page.getByTestId('add-expense-btn').click();
    await expect(page.getByTestId('expense-group-scope-select')).toHaveValue('grp_goa_2026');

    await page.getByTestId('expense-title-input').fill('Beach Shack Sunset Snacks');
    await page.getByTestId('expense-amount-input').fill('1000');

    // Exercise all 5 split modes
    for (const mode of ['equal', 'exact', 'percentage', 'shares', 'adjustment'] as const) {
      await expect(page.getByTestId(`split-mode-${mode}`)).toBeVisible();
      await page.getByTestId(`split-mode-${mode}`).click();
    }
    await page.getByTestId('split-mode-equal').click();

    // Exercise Multi-Payer toggle
    const multiPayerToggle = page.getByTestId('multi-payer-toggle');
    await multiPayerToggle.click();
    await expect(multiPayerToggle).toContainText('Multiple Payers Active');
    await multiPayerToggle.click();

    // Exercise Foreign FX conversion (EUR -> INR)
    const currencySelect = page.getByTestId('expense-currency-select');
    await currencySelect.selectOption('EUR');
    await expect(page.getByTestId('expense-fx-rate-input')).toBeVisible();
    await currencySelect.selectOption('INR');

    // Verify rotating remainder on 3-way split of ₹1,000.00
    const fourthMemberId = mockData.groups[0]!.members[3]!.id;
    await page.getByTestId(`split-include-${fourthMemberId}`).uncheck();
    await expect(page.getByText('+1 paise/cents rotated').first()).toBeVisible();
    await expect(page.getByTestId('split-reconciliation-bar')).toContainText('100% Reconciled');

    // Attach WebP sample receipt and verify badge
    await page.getByTestId('attach-sample-receipt-btn').click();
    await expect(page.getByTestId('attached-receipt-badge').first()).toBeVisible();

    const receiptUploadPromise = page.waitForResponse(
      (res) =>
        res.url().includes('/api/receipts/upload') &&
        res.request().method() === 'POST'
    );
    const expenseSyncPromise = page.waitForResponse(
      (res) =>
        res.url().includes('/api/ledger/sync') &&
        res.request().method() === 'POST'
    );
    await page.getByTestId('save-expense-btn').click();
    const [receiptRes, expSyncRes] = await Promise.all([
      receiptUploadPromise,
      expenseSyncPromise,
    ]);
    expect(receiptRes.status()).toBe(200);
    expect(expSyncRes.status()).toBe(200);

    await expect(page.getByText('Beach Shack Sunset Snacks').first()).toBeVisible();
  });

  test('User Story 3: Group Management — Create Group, Add/Claim Member, Base Currency Re-denomination & Debt Simplification Toggle', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByTestId('nav-tab-groups').click();

    // 1. Toggle Debt Simplification ON/OFF
    const simplifyBtn = page.getByTestId('toggle-simplify-debts-btn');
    await expect(simplifyBtn).toContainText('Simplify Debts: ON');
    await simplifyBtn.click();
    await expect(simplifyBtn).toContainText('Simplify Debts: OFF');
    await simplifyBtn.click();
    await expect(simplifyBtn).toContainText('Simplify Debts: ON');

    // 2. Open "Change Base Currency" and re-denominate group currency
    await page.getByTestId('change-group-currency-btn').click();
    await page.getByTestId('confirm-currency-change-btn').click();

    // 3. Add a new member to the group and claim an unclaimed placeholder member
    await page.getByTestId('add-member-btn').click();
    await page.getByTestId('member-name-input').fill('Ananya Rao');
    await page.getByTestId('member-email-input').fill('ananya.rao@gmail.com');
    await page.getByTestId('save-member-btn').click();
    await expect(page.getByText('Ananya Rao').first()).toBeVisible();

    const claimBtn = page.locator('[data-testid^="claim-member-"]').first();
    if (await claimBtn.isVisible()) {
      await claimBtn.click();
    }

    // 4. Create a new group and verify Backend API sync
    await page.getByTestId('create-group-btn').click();
    await page.getByTestId('group-name-input').fill('Himalayan Trek 2026');

    const createGroupSyncPromise = page.waitForResponse(
      (res) =>
        res.url().includes('/api/ledger/sync') &&
        res.request().method() === 'POST'
    );
    await page.getByTestId('save-group-btn').click();
    const createGroupSyncRes = await createGroupSyncPromise;
    expect(createGroupSyncRes.status()).toBe(200);

    await expect(
      page.getByRole('heading', { name: 'Himalayan Trek 2026' })
    ).toBeVisible();
  });

  test('User Story 4: Transparent Activity History, Per-Expense Revision Restore & Trash Recovery Vault', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByTestId('nav-tab-activity').click();

    // 1. Verify Activity Feed and toggle scope (Group <-> Global)
    await expect(page.getByTestId('activity-feed-list')).toBeVisible();
    const scopeToggle = page.getByTestId('activity-scope-toggle');
    await expect(scopeToggle).toBeVisible();
    await scopeToggle.click();
    await expect(
      page.getByRole('heading', { name: /All Groups Global Activity Timeline/i })
    ).toBeVisible();
    await scopeToggle.click();

    // 2. Inspect revision-history-panel and restore a historical revision
    const revisionPanel = page.getByTestId('revision-history-panel');
    await expect(revisionPanel).toBeVisible();
    await expect(revisionPanel).toContainText('₹6,000.00');
    await expect(revisionPanel).toContainText('₹6,800.00');

    const revRestoreSyncPromise = page.waitForResponse(
      (res) =>
        res.url().includes('/api/ledger/sync') &&
        res.request().method() === 'POST'
    );
    await page
      .getByTestId(`restore-revision-${mockData.expenseRevisions[0]!.id}`)
      .click();
    const revRestoreSyncRes = await revRestoreSyncPromise;
    expect(revRestoreSyncRes.status()).toBe(200);

    // 3. Restore "Duplicate Entry: Late Night Gelato" from trash-recovery-panel
    const trashPanel = page.getByTestId('trash-recovery-panel');
    await expect(trashPanel).toBeVisible();
    await expect(
      trashPanel.getByText('Duplicate Entry: Late Night Gelato')
    ).toBeVisible();

    const trashRestoreSyncPromise = page.waitForResponse(
      (res) =>
        res.url().includes('/api/ledger/sync') &&
        res.request().method() === 'POST'
    );
    await page.getByTestId('restore-trash-exp_goa_trashed_gelato_06').click();
    const trashRestoreSyncRes = await trashRestoreSyncPromise;
    expect(trashRestoreSyncRes.status()).toBe(200);
    await expect(trashPanel).toContainText('Trash Vault is Clean');
  });

  test('User Story 5: Friends Cross-Group Net Balances, Atomic Batch Settle Up, UPI QR Studio & WhatsApp Summary', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByTestId('nav-tab-friends').click();

    // 1. Verify Cross-Group Friends List & UPI Deep-Link QR Studio
    await expect(page.getByTestId('friends-cross-group-list')).toBeVisible();
    await expect(page.getByTestId('settle-up-studio')).toBeVisible();

    const upiBox = page.getByTestId('upi-deep-link-box');
    await expect(upiBox).toBeVisible();
    await expect(page.getByTestId('upi-uri-text')).toContainText('upi://pay?');
    await expect(upiBox.locator('svg').first()).toBeVisible();

    // 2. Verify WhatsApp Summary Panel and Copy Action
    const whatsappPanel = page.getByTestId('whatsapp-summary-panel');
    await expect(whatsappPanel).toBeVisible();
    await expect(page.getByTestId('whatsapp-summary-markdown')).toContainText(
      'Wise-Spliter Summary - Goa Villa & Scuba 2026'
    );
    await page.getByTestId('copy-whatsapp-summary-btn').click();

    // 3. Execute 1-Tap Atomic Cross-Group Settle Up and record a settlement in Settle Up Studio
    const settleAllBtn = page
      .locator('[data-testid^="settle-all-groups-"]:not([disabled])')
      .first();
    await expect(settleAllBtn).toBeVisible();
    await settleAllBtn.click();

    const recordSettleSyncPromise = page.waitForResponse(
      (res) =>
        res.url().includes('/api/ledger/sync') &&
        res.request().method() === 'POST'
    );
    await page.getByTestId('record-settlement-submit-btn').click();
    const recordSettleSyncRes = await recordSettleSyncPromise;
    expect(recordSettleSyncRes.status()).toBe(200);
  });

  test('User Story 6: Insights & Global Search (0, 2, 3 Decimal Currencies), Portability (Splitwise/XLSX/PDF/AES-256-GCM), DevAuthModal Login & Backend API Security Isolation (401/403)', async ({
    page,
    request,
  }) => {
    await page.goto('/');

    // 1. Insights & Global Search across 0, 2, and 3 decimal currencies (JPY, INR, KWD)
    await page.getByTestId('nav-tab-analytics').click();
    await expect(page.getByTestId('analytics-kpi-grid')).toBeVisible();
    const categoryChart = page.getByTestId('analytics-category-breakdown');
    await expect(categoryChart).toBeVisible();
    await expect(
      categoryChart.locator(
        'svg[aria-label="Category Spend Proportional Donut Chart"]'
      )
    ).toBeVisible();

    const searchInput = page.getByTestId('global-search-input');
    // JPY (0-decimal)
    await searchInput.fill('Shinkansen');
    await expect(
      page.getByText('Nozomi Shinkansen Tokyo to Kyoto').first()
    ).toBeVisible();
    await expect(page.getByText('¥28,351').first()).toBeVisible();

    // KWD (3-decimal fils)
    await searchInput.fill('Souk');
    await expect(
      page
        .getByText('Souk Mubarakiya Grill Dinner (3-Decimal KWD Fils)')
        .first()
    ).toBeVisible();
    await expect(page.getByText('KD25.000').first()).toBeVisible();

    // INR (2-decimal paise)
    await searchInput.fill('Assagao');
    await expect(
      page.getByText('Assagao Pool Villa (Multi-Payer Booking)').first()
    ).toBeVisible();
    await expect(page.getByText('₹20,000.00').first()).toBeVisible();

    // 2. Portability: Splitwise CSV Import, XLSX/PDF Export & AES-256-GCM Encrypted Backup
    await page.getByTestId('nav-tab-portability').click();
    const syncPanel = page.getByTestId('cloud-sync-panel');
    await expect(syncPanel).toBeVisible();
    await expect(syncPanel).toContainText('wise_spliter');

    await page.getByTestId('load-sample-splitwise-btn').click();
    const importSyncPromise = page.waitForResponse(
      (res) =>
        res.url().includes('/api/ledger/sync') &&
        res.request().method() === 'POST'
    );
    await page.getByTestId('confirm-splitwise-import-btn').click();
    const importSyncRes = await importSyncPromise;
    expect(importSyncRes.status()).toBe(200);

    await page.getByTestId('download-xlsx-btn').click();
    await page.getByTestId('download-pdf-btn').click();
    await expect(page.getByTestId('csv-export-preview')).toContainText(
      'Date,Title,Category'
    );

    await page
      .getByTestId('backup-passphrase-input')
      .fill('my-vault-passphrase-2026');
    await page.getByTestId('generate-encrypted-backup-btn').click();
    await expect(page.getByTestId('encrypted-backup-output')).toContainText(
      'AES-256-GCM'
    );
    await page.getByTestId('decrypt-restore-btn').click();
    await expect(page.getByText(/Verified & Restored:/i)).toBeVisible();

    // 3. Backend API Security & User Isolation Verification via `request`
    // (3a) Unauthenticated GET /api/ledger/bootstrap and POST /api/ledger/sync -> HTTP 401
    const unauthBootstrapRes = await request.get('/api/ledger/bootstrap');
    expect(unauthBootstrapRes.status()).toBe(401);

    const unauthSyncRes = await request.post('/api/ledger/sync', {
      data: { dataset: mockData },
    });
    expect(unauthSyncRes.status()).toBe(401);

    // (3b) Security Breach Checks:
    //  - Unauthenticated POST /api/auth/session attempting to mint non-demo tokens MUST be rejected -> HTTP 401
    const unauthMintIntruderRes = await request.post('/api/auth/session', {
      data: {
        userId: 'usr_intruder_99',
        email: 'intruder@evil.com',
        fullName: 'Malicious Intruder',
      },
    });
    expect(unauthMintIntruderRes.status()).toBe(401);

    const unauthMintRohanRes = await request.post('/api/auth/session', {
      data: {
        userId: 'usr_rohan_02',
        email: 'rohan.verma@gmail.com',
        fullName: 'Rohan Verma',
      },
    });
    expect(unauthMintRohanRes.status()).toBe(401);

    //  - Disallowed cross-site Origin CSRF attempt on POST /api/auth/demo -> HTTP 403
    const csrfEvilOriginRes = await request.post('/api/auth/demo', {
      headers: {
        Origin: 'https://evil.attacker.example',
      },
      data: {},
    });
    expect(csrfEvilOriginRes.status()).toBe(403);

    //  - Authenticated as collaborator rohan.verma@gmail.com attempting cross-tenant impersonation or private group hijack -> HTTP 403
    const rohanApiLoginRes = await request.post('/api/auth/login', {
      data: {
        email: 'rohan.verma@gmail.com',
        password: 'WiseSpliter@2026',
      },
    });
    expect(rohanApiLoginRes.status()).toBe(200);
    const { token: rohanToken, profile: rohanProfile } =
      (await rohanApiLoginRes.json()) as {
        token: string;
        profile: { id: string; email: string; fullName: string };
      };
    expect(Boolean(rohanToken)).toBe(true);

    // Attempt 1: Collaborator tries to sync dataset impersonating usr_arjun_01 -> 403
    const intruderImpersonateRes = await request.post('/api/ledger/sync', {
      headers: {
        Authorization: `Bearer ${rohanToken}`,
      },
      data: {
        dataset: mockData,
      },
    });
    expect(intruderImpersonateRes.status()).toBe(403);

    // Attempt 2: Collaborator uses own profile but tries to hijack private group grp_tokyo_2026 (where Rohan is NOT a member) -> 403
    const tokyoGroup = mockData.groups.find(
      (g) => g.id === 'grp_tokyo_2026'
    )!;
    const intruderGroupHijackDataset = {
      ...mockData,
      currentUser: {
        ...mockData.currentUser,
        id: rohanProfile.id,
        email: rohanProfile.email,
        fullName: rohanProfile.fullName,
      },
      groups: [
        {
          ...tokyoGroup,
          members: [
            ...tokyoGroup.members,
            {
              id: 'mem_rohan_hijack_99',
              groupId: tokyoGroup.id,
              userId: rohanProfile.id,
              invitedEmail: rohanProfile.email,
              displayName: rohanProfile.fullName,
              avatarInitials: 'RV',
              upiId: null,
              role: 'member',
              memberOrder: 99,
              joinedAt: '2026-11-11T00:00:00Z',
              claimedAt: '2026-11-11T00:00:00Z',
            },
          ],
        },
      ],
      expenses: [],
      expenseRevisions: [],
      settlements: [],
      groupActivityLog: [],
    };
    const intruderGroupHijackRes = await request.post('/api/ledger/sync', {
      headers: {
        Authorization: `Bearer ${rohanToken}`,
      },
      data: {
        dataset: intruderGroupHijackDataset,
      },
    });
    expect(intruderGroupHijackRes.status()).toBe(403);

    // Attempt 3: Direct PostgREST :54321 bypass attempt on SECURITY DEFINER RPC pull_changes -> 401/403
    const directPostgrestBypassRes = await request.post(
      'http://127.0.0.1:54321/rest/v1/rpc/pull_changes',
      {
        headers: {
          'Accept-Profile': 'wise_spliter',
          'Content-Profile': 'wise_spliter',
          apikey: 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH',
        },
        data: { p_since_seq: 0 },
      }
    );
    expect([401, 403]).toContain(directPostgrestBypassRes.status());

    // (3c) Authenticated as arjun.mehta@gmail.com (usr_arjun_01), GET /api/ledger/bootstrap and POST /api/ledger/sync -> HTTP 200
    const arjunSessionRes = await request.post('/api/auth/session', {
      data: {
        userId: 'usr_arjun_01',
        email: 'arjun.mehta@gmail.com',
        fullName: 'Arjun Mehta',
      },
    });
    expect(arjunSessionRes.status()).toBe(200);
    const { token: arjunToken } = (await arjunSessionRes.json()) as {
      token: string;
    };
    expect(Boolean(arjunToken)).toBe(true);

    const arjunSyncRes = await request.post('/api/ledger/sync', {
      headers: {
        Authorization: `Bearer ${arjunToken}`,
      },
      data: {
        dataset: mockData,
      },
    });
    expect(arjunSyncRes.status()).toBe(200);
    const arjunSyncBody = (await arjunSyncRes.json()) as {
      ok: boolean;
      schema: string;
    };
    expect(arjunSyncBody.ok).toBe(true);
    expect(arjunSyncBody.schema).toBe('wise_spliter');

    const arjunBootstrapRes = await request.get('/api/ledger/bootstrap', {
      headers: {
        Authorization: `Bearer ${arjunToken}`,
      },
    });
    expect(arjunBootstrapRes.status()).toBe(200);
    const arjunBootstrapBody = (await arjunBootstrapRes.json()) as {
      ok: boolean;
      schema: string;
      dataset: { groups: unknown[]; expenses: unknown[] };
    };
    expect(arjunBootstrapBody.ok).toBe(true);
    expect(arjunBootstrapBody.schema).toBe('wise_spliter');
    expect(arjunBootstrapBody.dataset.groups.length).toBeGreaterThanOrEqual(4);
    expect(arjunBootstrapBody.dataset.expenses.length).toBeGreaterThanOrEqual(10);

    // 4. DevAuthModal Backend-Validated Login & User-Scoped Dataset Isolation
    await page.getByTestId('header-user-pill').click();
    const authModal = page.getByTestId('dev-auth-modal');
    await expect(authModal).toBeVisible();

    const emailInput = page.getByTestId('dev-login-email-input');
    const passwordInput = page.getByTestId('dev-login-password-input');
    const loginSubmitBtn = page.getByTestId('dev-login-submit-btn');

    await expect(emailInput).toBeVisible();
    await expect(passwordInput).toBeVisible();
    await expect(loginSubmitBtn).toBeVisible();
    await expect(authModal).not.toContainText('WiseSpliter@2026');

    // (4a) Submitting an unknown/invalid user via POST /api/auth/login returns HTTP 401
    await emailInput.fill('nonexistent@example.com');
    await passwordInput.fill('wrongpass');
    const invalidLoginResPromise = page.waitForResponse(
      (res) =>
        res.url().includes('/api/auth/login') &&
        res.request().method() === 'POST'
    );
    await loginSubmitBtn.click();
    const invalidLoginRes = await invalidLoginResPromise;
    expect(invalidLoginRes.status()).toBe(401);
    await expect(page.getByTestId('dev-login-error-banner')).toBeVisible();

    // (4b) Logging in as Rohan Verma validates against POST /api/auth/login (HTTP 200) and returns 3 isolated groups
    await emailInput.fill('rohan.verma@gmail.com');
    await passwordInput.fill('WiseSpliter@2026');
    const validLoginResPromise = page.waitForResponse(
      (res) =>
        res.url().includes('/api/auth/login') &&
        res.request().method() === 'POST'
    );
    await loginSubmitBtn.click();
    const validLoginRes = await validLoginResPromise;
    expect(validLoginRes.status()).toBe(200);

    const validLoginBody = (await validLoginRes.json()) as {
      ok: boolean;
      profile: { fullName: string; email: string };
      dataset: { groups: Array<{ id: string; name: string }> };
    };
    expect(validLoginBody.ok).toBe(true);
    expect(validLoginBody.profile.fullName).toBe('Rohan Verma');

    const rohanGroupNames = validLoginBody.dataset.groups.map((g) => g.name);
    expect(rohanGroupNames).toHaveLength(3);
    expect(rohanGroupNames).toEqual(
      expect.arrayContaining([
        'Goa Villa & Scuba 2026',
        'Apt 14B Indiranagar',
        'Kuwait & Dubai Stopover',
      ])
    );
    expect(rohanGroupNames).not.toContain('Tokyo & Kyoto Autumn');

    await expect(authModal).toBeHidden();
    await expect(page.getByTestId('header-user-pill')).toContainText(
      'Rohan Verma'
    );

    // (4c) 1-Tap Demo Profile Sandbox Login switches back to Arjun Mehta (Demo) via POST /api/auth/demo (HTTP 200)
    await page.getByTestId('header-user-pill').click();
    await expect(authModal).toBeVisible();
    const demoLoginBtn = page.getByTestId('demo-profile-login-btn');
    await expect(demoLoginBtn).toBeVisible();
    await expect(page.getByTestId('dev-google-oauth-btn')).toBeVisible();

    const demoLoginResPromise = page.waitForResponse(
      (res) =>
        res.url().includes('/api/auth/demo') &&
        res.request().method() === 'POST'
    );
    await demoLoginBtn.click();
    const demoLoginRes = await demoLoginResPromise;
    expect(demoLoginRes.status()).toBe(200);
    await expect(authModal).toBeHidden();
    await expect(page.getByTestId('header-user-pill')).toContainText(
      'Arjun Mehta'
    );
  });

  test('User Story 7: Math & UX Scenario - Settl Quick Presets, 3-Way Rotating Remainder, Personal Impact Badge & INR->KWD (3-Decimal) FX Re-conversion Sync', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByTestId('nav-tab-groups').click();

    // 1. Create an isolated 3-member group so baseline groups stay untouched
    await page.getByTestId('create-group-btn').click();
    await page.getByTestId('group-name-input').fill('Math & FX Precision Lab');
    const createSync = page.waitForResponse(
      (res) =>
        res.url().includes('/api/ledger/sync') &&
        res.request().method() === 'POST'
    );
    await page.getByTestId('save-group-btn').click();
    expect((await createSync).status()).toBe(200);
    await expect(page.getByTestId('empty-group-onboarding-card')).toBeVisible();

    // Add 2 friends -> 3 members total (indivisible 3-way remainder scenario)
    for (const friend of [
      { name: 'Neha Kulkarni', email: 'neha.k@example.com' },
      { name: 'Kabir Bedi', email: 'kabir.b@example.com' },
    ]) {
      await page.getByTestId('add-member-btn').click();
      await page.getByTestId('member-name-input').fill(friend.name);
      await page.getByTestId('member-email-input').fill(friend.email);
      await page.getByTestId('save-member-btn').click();
      await expect(page.getByText(friend.name).first()).toBeVisible();
    }

    // 2. Add a ₹1,000 bill using Settl quick-amount preset chips (2 x +₹500)
    await page.getByTestId('add-expense-btn').click();
    await page.getByTestId('expense-title-input').fill('3-Way Odd Paisa Dinner');
    await page.getByTestId('quick-amount-chip-500').click();
    await page.getByTestId('quick-amount-chip-500').click();
    await expect(page.getByTestId('expense-amount-input')).toHaveValue('1000');
    await expect(page.getByTestId('ux-live-split-sentence')).toContainText('equally');
    await expect(page.getByText('+1 paise/cents rotated').first()).toBeVisible();
    await expect(page.getByTestId('split-reconciliation-bar')).toContainText(
      '100% Reconciled'
    );

    const billSync = page.waitForResponse(
      (res) =>
        res.url().includes('/api/ledger/sync') &&
        res.request().method() === 'POST'
    );
    await page.getByTestId('save-expense-btn').click();
    expect((await billSync).status()).toBe(200);

    // Verify Splitwise-style personal impact pill ("you lent ₹666.66" since Arjun gets ₹333.34 share on seed 0)
    await expect(
      page.getByTestId('expense-personal-impact-pill').first()
    ).toContainText('you lent');

    // 3. Re-convert group base currency from INR (2 decimals) -> KWD (3 decimals, fils) via Mode B FX conversion
    // and verify the backend financial invariant gatekeeper accepts the re-denominated ledger (HTTP 200, not 422!)
    await page.getByTestId('change-group-currency-btn').click();
    await page.getByTestId('change-currency-target-select').selectOption('KWD');
    const reconvertModeBtn = page.getByRole('button', {
      name: /Mode B: Convert existing bills via FX rate/i,
    });
    await reconvertModeBtn.click();

    const reconvertSync = page.waitForResponse(
      (res) =>
        res.url().includes('/api/ledger/sync') &&
        res.request().method() === 'POST'
    );
    await page.getByTestId('confirm-currency-change-btn').click();
    expect((await reconvertSync).status()).toBe(200);

    // Toggle Simplify Debts OFF -> ON to exercise both raw bilateral and Bitmask-DP paths
    const simplifyBtn = page.getByTestId('toggle-simplify-debts-btn');
    await simplifyBtn.click();
    await expect(simplifyBtn).toContainText('Simplify Debts: OFF');
    await simplifyBtn.click();
    await expect(simplifyBtn).toContainText('Simplify Debts: ON');
  });
});
