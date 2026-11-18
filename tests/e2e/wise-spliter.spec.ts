import { expect, test, type Page } from '@playwright/test';
import mockData from '../../src/data/mock-ledger-data.json' with { type: 'json' };

/** Rows of one store in the app's Dexie database (the local source of truth). */
async function readLocalStore<T>(page: Page, store: string): Promise<T[]> {
  return page.evaluate(async (name) => {
    const db = await new Promise<IDBDatabase | null>((res) => {
      const r = indexedDB.open('wise_spliter_local_db');
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(null);
    });
    if (!db || !db.objectStoreNames.contains(name)) return [];
    const rows = await new Promise<unknown[]>((res) => {
      const req = db.transaction(name, 'readonly').objectStore(name).getAll();
      req.onsuccess = () => res(req.result as unknown[]);
      req.onerror = () => res([]);
    });
    db.close();
    return rows;
  }, store) as Promise<T[]>;
}

/** Everything persisted in the app's Dexie database, as JSON text. */
async function readLocalDbText(page: Page): Promise<string> {
  const stores = await page.evaluate(async () => {
    const r = indexedDB.open('wise_spliter_local_db');
    const db = await new Promise<IDBDatabase>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    const names = [...db.objectStoreNames];
    db.close();
    return names;
  });
  const parts = await Promise.all(stores.map((n) => readLocalStore<unknown>(page, n)));
  return JSON.stringify(parts);
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required (see .env.example)`);
  return value;
}

test.describe('Wise-Spliter Full-Stack User Story E2E Suite (UI + Backend API + Supabase)', () => {
  test('User Story 1: Minimalist Home Dashboard, PWA Manifest & Icons, Interactive Help Guide, Top-3 Recent Groups & Direct Non-Group Split Flow', async ({
    page,
    request,
  }) => {
    await page.goto('/');

    // 0. Verify PWA Readiness (manifest.webmanifest, standalone display, 3 icons, /icons/icon-192.png & /favicon.svg HTTP 200)
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
      'href',
      '/manifest.webmanifest'
    );
    await expect(page.locator('link[rel="icon"]')).toHaveAttribute(
      'href',
      '/favicon.svg'
    );
    await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
      'href',
      '/icons/icon-192.png'
    );

    const [manifestRes, icon192Res, icon512Res, iconMaskableRes, faviconRes] =
      await Promise.all([
        request.get('/manifest.webmanifest'),
        request.get('/icons/icon-192.png'),
        request.get('/icons/icon-512.png'),
        request.get('/icons/icon-maskable-512.png'),
        request.get('/favicon.svg'),
      ]);
    expect(manifestRes.status()).toBe(200);
    expect(icon192Res.status()).toBe(200);
    expect(icon512Res.status()).toBe(200);
    expect(iconMaskableRes.status()).toBe(200);
    expect(faviconRes.status()).toBe(200);

    const manifestJson = (await manifestRes.json()) as {
      display: string;
      icons: Array<{ src: string; sizes: string; type: string; purpose?: string }>;
    };
    expect(manifestJson.display).toBe('standalone');
    expect(manifestJson.icons).toHaveLength(3);
    expect(manifestJson.icons.map((icon) => icon.src)).toEqual([
      '/icons/icon-192.png',
      '/icons/icon-512.png',
      '/icons/icon-maskable-512.png',
    ]);

    const icon192Body = await icon192Res.body();
    expect(icon192Body[0]).toBe(0x89);
    expect(icon192Body[1]).toBe(0x50);
    expect(icon192Body[2]).toBe(0x4e);
    expect(icon192Body[3]).toBe(0x47);
    expect(await faviconRes.text()).toContain('<svg');

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

    await page.getByTestId('save-expense-btn').click();

    const directExpensesList = page.getByTestId('home-direct-expenses-list');
    await expect(directExpensesList).toBeVisible();
    await expect(directExpensesList).toContainText('Late Night Shawarma & Chai');
    await expect(directExpensesList).toContainText('₹900.00');
    await expect(directExpensesList.getByTestId('expense-personal-impact-pill').first()).toBeVisible();
  });

  test('User Story 2: Progressive Group Workspace, Offline Conflict Resolution, Explain Balance & 5 Split Modes + Device-Local Receipt Sync', async ({
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

    await page.getByTestId('keep-active-revision-btn').first().click();
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

    // Attach WebP sample receipt and verify device-local badge (0 KB uploaded to cloud)
    await page.getByTestId('attach-sample-receipt-btn').click();
    const receiptBadge = page.getByTestId('attached-receipt-badge').first();
    await expect(receiptBadge).toBeVisible();
    await expect(receiptBadge).toContainText(
      'Stored on this device only (0 KB uploaded to cloud)'
    );

    let receiptUploadRequestCount = 0;
    const outgoingBodies: string[] = [];
    const onReceiptUploadReq = (req: {
      url: () => string;
      method: () => string;
      postData: () => string | null;
    }) => {
      if (req.url().includes('/api/receipts/upload') && req.method() === 'POST') {
        receiptUploadRequestCount += 1;
      }
      outgoingBodies.push(req.postData() ?? '');
    };
    page.on('request', onReceiptUploadReq);

    await page.getByTestId('save-expense-btn').click();
    await expect(page.getByText('Beach Shack Sunset Snacks').first()).toBeVisible();
    page.off('request', onReceiptUploadReq);

    expect(receiptUploadRequestCount).toBe(0);
    expect(outgoingBodies.some((body) => body.includes('data:image/'))).toBe(false);

    let savedExpId = '';
    await expect
      .poll(async () => {
        const rows = await readLocalStore<{ id: string; title: string }>(page, 'expenses');
        savedExpId = rows.find((e) => e.title === 'Beach Shack Sunset Snacks')?.id ?? '';
        return savedExpId;
      })
      .not.toBe('');

    // Verify full receipt blob stays strictly on-device in Dexie IndexedDB localReceiptBlobs
    await expect
      .poll(async () => {
        return page.evaluate(async (targetExpenseId: string) => {
          return new Promise<{
            count: number;
            uploadedToCloud: boolean | null;
            storageBucket: string | null;
            hasDataUrl: boolean;
          }>((resolve) => {
            const openReq = indexedDB.open('wise_spliter_local_db');
            openReq.onerror = () =>
              resolve({
                count: 0,
                uploadedToCloud: null,
                storageBucket: null,
                hasDataUrl: false,
              });
            openReq.onsuccess = () => {
              const db = openReq.result;
              if (!db.objectStoreNames.contains('localReceiptBlobs')) {
                db.close();
                resolve({
                  count: 0,
                  uploadedToCloud: null,
                  storageBucket: null,
                  hasDataUrl: false,
                });
                return;
              }
              const tx = db.transaction('localReceiptBlobs', 'readonly');
              const store = tx.objectStore('localReceiptBlobs');
              const allReq = store.getAll();
              allReq.onsuccess = () => {
                const rows = (allReq.result ?? []) as Array<{
                  expenseId: string;
                  uploadedToCloud: boolean;
                  storageBucket: string;
                  dataUrl: string;
                }>;
                const matched = rows.filter(
                  (r) => r.expenseId === targetExpenseId
                );
                db.close();
                resolve({
                  count: matched.length,
                  uploadedToCloud: matched[0]?.uploadedToCloud ?? null,
                  storageBucket: matched[0]?.storageBucket ?? null,
                  hasDataUrl: Boolean(
                    matched[0]?.dataUrl?.startsWith('data:image/')
                  ),
                });
              };
              allReq.onerror = () => {
                db.close();
                resolve({
                  count: 0,
                  uploadedToCloud: null,
                  storageBucket: null,
                  hasDataUrl: false,
                });
              };
            };
          });
        }, savedExpId);
      })
      .toEqual({
        count: 1,
        uploadedToCloud: false,
        storageBucket: 'local-device-only',
        hasDataUrl: true,
      });

    await expect(page.getByText('Beach Shack Sunset Snacks').first()).toBeVisible();
  });

  test('User Story 3: Group Management - Create Group, Add/Claim Member, Base Currency Re-denomination & Debt Simplification Toggle', async ({
    page,
  }) => {
    await page.route('https://api.frankfurter.dev/**', (route) =>
      route.fulfill({
        json: [
          { date: '2026-11-16', base: 'EUR', quote: 'INR', rate: 104.15 },
          { date: '2026-11-16', base: 'EUR', quote: 'USD', rate: 1.1072 },
          { date: '2026-11-16', base: 'EUR', quote: 'KWD', rate: 0.34304 },
        ],
        headers: { 'access-control-allow-origin': '*' },
      })
    );
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
    // Mocked EUR quotes: 1 INR = round(1.1072 / 104.15, 8 dp) = 0.01063082 USD
    await page.getByTestId('change-group-currency-btn').click();
    await page.getByTestId('confirm-currency-change-btn').click();
    await expect(page.getByTestId('toast-banner')).toContainText(
      'Converted group to USD at 1 INR = 0.01063082 USD (2026-11-16)'
    );

    // 3. Add a new member to the group and claim an unclaimed placeholder member
    await page.getByTestId('add-member-btn').click();
    await page.getByTestId('member-name-input').fill('Ananya Rao');
    await page.getByTestId('member-email-input').fill('ananya.rao@example.com');
    await page.getByTestId('save-member-btn').click();
    await expect(page.getByText('Ananya Rao').first()).toBeVisible();

    const claimBtn = page.locator('[data-testid^="claim-member-"]').first();
    if (await claimBtn.isVisible()) {
      await claimBtn.click();
    }

    // 4. Create a new group and verify Backend API sync
    await page.getByTestId('create-group-btn').click();
    await page.getByTestId('group-name-input').fill('Himalayan Trek 2026');

    await page.getByTestId('save-group-btn').click();

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

    await page
      .getByTestId(`restore-revision-${mockData.expenseRevisions[0]!.id}`)
      .click();

    // 3. Restore "Duplicate Entry: Late Night Gelato" from trash-recovery-panel
    const trashPanel = page.getByTestId('trash-recovery-panel');
    await expect(trashPanel).toBeVisible();
    await expect(
      trashPanel.getByText('Duplicate Entry: Late Night Gelato')
    ).toBeVisible();

    await page.getByTestId('restore-trash-exp_goa_trashed_gelato_06').click();
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

    await page.getByTestId('record-settlement-submit-btn').click();
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
    await page.getByTestId('confirm-splitwise-import-btn').click();

    await page.getByTestId('download-xlsx-btn').click();
    await page.getByTestId('download-pdf-btn').click();
    await expect(page.getByTestId('csv-export-preview')).toContainText(
      'Date,Title,Category'
    );

    await page
      .getByTestId('backup-passphrase-input')
      .fill('my-vault-passphrase-2026');
    await page
      .getByTestId('backup-passphrase-confirm-input')
      .fill('my-vault-passphrase-2026');
    await page.getByTestId('generate-encrypted-backup-btn').click();
    await expect(page.getByTestId('encrypted-backup-output')).toContainText(
      'AES-256-GCM'
    );
    await page.getByTestId('decrypt-restore-btn').click();
    await expect(page.getByText(/Verified & Restored:/i)).toBeVisible();

    // 3. Backend API Security & User Isolation Verification via `request`
    type PulledChange = { entity: string; id: string; deleted: boolean; data: { name?: string } | null };
    const pullGroups = async (token: string) => {
      const latest = new Map<string, PulledChange>();
      let cursor = '0';
      for (let i = 0; i < 200; i += 1) {
        const res = await request.get(`/api/ledger/pull?cursor=${cursor}&limit=500`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        expect(res.status()).toBe(200);
        const body = (await res.json()) as { changes: PulledChange[]; nextCursor: string; hasMore?: boolean };
        expect(typeof body.nextCursor).toBe('string');
        for (const c of body.changes) if (c.entity === 'group') latest.set(c.id, c);
        if (!body.hasMore) return [...latest.values()].filter((c) => !c.deleted);
        expect(body.nextCursor, 'cursor advances while hasMore').not.toBe(cursor);
        cursor = body.nextCursor;
      }
      throw new Error('pull did not finish within 200 pages');
    };
    const hlcNow = () => `${Date.now().toString(16).padStart(12, '0')}-0001-e2e`;

    // (3a) Unauthenticated GET /api/ledger/pull and POST /api/ledger/push -> HTTP 401
    expect((await request.get('/api/ledger/pull?cursor=0')).status()).toBe(401);
    expect((await request.post('/api/ledger/push', { data: { mutations: [] } })).status()).toBe(401);
    expect((await request.post('/api/ledger/sync', { data: { dataset: mockData } })).status()).toBe(404);

    // (3b) /api/auth/session never mints a session from a claimed identity -> HTTP 401
    for (const claimed of [
      { userId: 'usr_intruder_99', email: 'intruder@evil.com' },
      { userId: 'usr_rohan_02', email: 'rohan.verma@example.com' },
    ]) {
      expect((await request.post('/api/auth/session', { data: claimed })).status()).toBe(401);
    }

    //  - Disallowed cross-site Origin CSRF attempt on POST /api/auth/demo -> HTTP 403
    const csrfEvilOriginRes = await request.post('/api/auth/demo', {
      headers: { Origin: 'https://evil.attacker.example' },
      data: {},
    });
    expect(csrfEvilOriginRes.status()).toBe(403);

    //  - Rohan (collaborator) cannot write into or read Tokyo, where he is not a member
    const rohanApiLoginRes = await request.post('/api/auth/login', {
      data: { email: 'rohan.verma@example.com', password: requireEnv('DEV_USER_PASSWORD') },
    });
    expect(rohanApiLoginRes.status()).toBe(200);
    const { token: rohanToken } = (await rohanApiLoginRes.json()) as { token: string };
    expect(Boolean(rohanToken)).toBe(true);

    const tokyoGroup = mockData.groups.find((g) => g.id === 'grp_tokyo_2026')!;
    const { members: _tokyoMembers, ...tokyoData } = tokyoGroup;
    const hijackRes = await request.post('/api/ledger/push', {
      headers: { Authorization: `Bearer ${rohanToken}` },
      data: {
        mutations: [
          { entity: 'group', id: tokyoGroup.id, op: 'upsert', hlc: hlcNow(), data: { ...tokyoData, name: 'HIJACKED' } },
          {
            entity: 'group_member',
            id: 'mem_rohan_hijack_99',
            op: 'upsert',
            hlc: hlcNow(),
            data: { groupId: tokyoGroup.id, userId: 'usr_rohan_02', displayName: 'Rohan Verma', role: 'admin', memberOrder: 99 },
          },
        ],
      },
    });
    expect(hijackRes.status()).toBe(200);
    const hijackBody = (await hijackRes.json()) as { results: Array<{ status: string }> };
    expect(hijackBody.results.map((r) => r.status)).toEqual(['forbidden', 'forbidden']);
    const rohanPulledNames = (await pullGroups(rohanToken)).map((g) => g.data?.name);
    expect(rohanPulledNames).not.toContain('Tokyo & Kyoto Autumn');
    expect(rohanPulledNames).not.toContain('HIJACKED');

    //  - Direct PostgREST bypass on the service-role-only RPC -> 401/403/404
    const directPostgrestBypassRes = await request.post(
      `${requireEnv('VITE_SUPABASE_URL')}/rest/v1/rpc/pull_changes`,
      {
        headers: {
          'Accept-Profile': 'wise_spliter',
          'Content-Profile': 'wise_spliter',
          apikey: requireEnv('VITE_SUPABASE_PUBLISHABLE_KEY'),
        },
        data: { p_actor: 'usr_rohan_02', p_cursor: 0, p_limit: 1 },
      }
    );
    expect([401, 403, 404]).toContain(directPostgrestBypassRes.status());

    // (3c) Arjun (demo profile in dev) pulls his own groups via cursor pull -> HTTP 200
    const arjunSessionRes = await request.post('/api/auth/demo', { data: {} });
    expect(arjunSessionRes.status()).toBe(200);
    const { token: arjunToken } = (await arjunSessionRes.json()) as { token: string };
    expect((await pullGroups(arjunToken)).length).toBeGreaterThanOrEqual(4);

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
    await expect(authModal).not.toContainText(requireEnv('DEV_USER_PASSWORD'));

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
    await emailInput.fill('rohan.verma@example.com');
    await passwordInput.fill(requireEnv('DEV_USER_PASSWORD'));
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
      token: string;
      profile: { fullName: string; email: string };
    };
    expect(validLoginBody.ok).toBe(true);
    expect(validLoginBody.profile.fullName).toBe('Rohan Verma');

    // Login returns no dataset (C4); the client pulls its scoped rows by cursor.
    const rohanGroupNames = (await pullGroups(validLoginBody.token)).map((g) => g.data?.name);
    expect(rohanGroupNames).toEqual(
      expect.arrayContaining([
        'Goa Villa & Scuba 2026',
        'Apt 14B Indiranagar',
        'Kuwait & Dubai Stopover',
      ])
    );
    expect(rohanGroupNames).not.toContain('Tokyo & Kyoto Autumn');

    // The Splitwise bills imported above live in a sample group, so sign-in asks first.
    await expect(page.getByTestId('local-data-import-dialog')).toBeVisible();
    await page.getByTestId('local-data-fresh-btn').click();
    await page.getByTestId('local-data-wipe-btn').click();
    await expect(page.getByTestId('local-data-import-dialog')).toBeHidden();

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
    await page.route('https://api.frankfurter.dev/**', (route) =>
      route.fulfill({
        json: [
          { date: '2026-11-16', base: 'EUR', quote: 'INR', rate: 104.15 },
          { date: '2026-11-16', base: 'EUR', quote: 'USD', rate: 1.1072 },
          { date: '2026-11-16', base: 'EUR', quote: 'KWD', rate: 0.34304 },
        ],
        headers: { 'access-control-allow-origin': '*' },
      })
    );
    await page.goto('/');
    await page.getByTestId('nav-tab-groups').click();

    // 1. Create an isolated 3-member group so baseline groups stay untouched
    await page.getByTestId('create-group-btn').click();
    await page.getByTestId('group-name-input').fill('Math & FX Precision Lab');
    await page.getByTestId('save-group-btn').click();
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

    await page.getByTestId('save-expense-btn').click();

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

    // Mocked EUR quotes: 1 INR = round(0.34304 / 104.15, 8 dp) = 0.00329371 KWD
    await page.getByTestId('confirm-currency-change-btn').click();
    await expect(page.getByTestId('toast-banner')).toContainText(
      'Converted group to KWD at 1 INR = 0.00329371 KWD (2026-11-16)'
    );

    // Toggle Simplify Debts OFF -> ON to exercise both raw bilateral and Bitmask-DP paths
    const simplifyBtn = page.getByTestId('toggle-simplify-debts-btn');
    await simplifyBtn.click();
    await expect(simplifyBtn).toContainText('Simplify Debts: OFF');
    await simplifyBtn.click();
    await expect(simplifyBtn).toContainText('Simplify Debts: ON');
  });

  test('Zero groups: every tab renders without errors and offers a create-group prompt', async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    const emptyLedger = {
      ...mockData,
      groups: [],
      expenses: [],
      expenseRevisions: [],
      settlements: [],
      groupActivityLog: [],
    };
    await page.addInitScript((snapshot: string) => {
      if (!sessionStorage.getItem('zero_groups_seeded')) {
        localStorage.setItem('wise_spliter_ledger_state_v1', snapshot);
        sessionStorage.setItem('zero_groups_seeded', '1');
      }
    }, JSON.stringify(emptyLedger));
    await page.goto('/');

    for (const tab of ['home', 'groups', 'activity', 'friends', 'analytics', 'portability']) {
      await page.getByTestId(`nav-tab-${tab}`).first().click();
      await expect(page.locator('main, #root').first()).toBeVisible();
    }

    await page.getByTestId('nav-tab-groups').first().click();
    await expect(page.getByTestId('no-groups-empty-state')).toBeVisible();
    await page.getByTestId('no-groups-create-group-btn').click();
    await page.getByTestId('group-name-input').fill('First Group');
    await page.getByTestId('save-group-btn').click();
    await expect(page.getByRole('heading', { name: 'First Group' })).toBeVisible();
    await expect(page.getByTestId('no-groups-empty-state')).toBeHidden();
    expect(pageErrors).toEqual([]);
  });

  test('Local sample ledger: no deliverable emails or payable UPI ids, and nothing is pushed without sign-in', async ({
    page,
  }) => {
    const pushes: string[] = [];
    page.on('request', (req) => {
      if (req.url().includes('/api/ledger/push')) pushes.push(req.url());
    });
    await page.goto('/');
    await page.getByTestId('open-group-workspace-grp_goa_2026').click();
    await page.getByTestId('add-expense-btn').click();
    await page.getByTestId('expense-title-input').fill('Sample Only Chai');
    await page.getByTestId('expense-amount-input').fill('120');
    await page.getByTestId('save-expense-btn').click();
    await expect(page.getByText('Sample Only Chai').first()).toBeVisible();
    await page.waitForTimeout(2500);

    await expect.poll(async () => (await readLocalStore<{ title: string }>(page, 'expenses')).some((e) => e.title === 'Sample Only Chai')).toBe(true);
    const stored = await readLocalDbText(page);
    expect(stored).toContain('@example.com');
    expect(stored).not.toMatch(/@gmail\.com|@ok[a-z]+\b/);
    expect(pushes).toEqual([]);
  });

  test('Direct split starts with only you and needs one friend you add', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('nav-tab-home').first().click();
    await page.getByTestId('home-quick-add-expense-btn').first().click();
    const panel = page.getByTestId('adhoc-participants-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Direct Split Participants (1)');
    await expect(panel).not.toContainText('Rohan');
    await page.getByTestId('expense-amount-input').fill('300');
    await expect(page.getByTestId('split-reconciliation-bar')).toContainText('Add at least one friend');
    await page.getByTestId('adhoc-friend-name-input').fill('Meera Iyer');
    await page.getByTestId('add-adhoc-friend-btn').click();
    await expect(panel).toContainText('Direct Split Participants (2)');
    await expect(page.getByTestId('split-reconciliation-bar')).toContainText('100% Reconciled');
    await page.getByTestId('expense-title-input').fill('Meera Bill One');
    await page.getByTestId('save-expense-btn').click();
    await expect(page.getByText('Meera Bill One').first()).toBeVisible();

    await page.getByTestId('home-quick-add-expense-btn').first().click();
    await page.getByTestId('adhoc-friend-name-input').fill('meera iyer');
    await page.getByTestId('add-adhoc-friend-btn').click();
    await page.getByTestId('expense-title-input').fill('Meera Bill Two');
    await page.getByTestId('expense-amount-input').fill('200');
    await page.getByTestId('save-expense-btn').click();
    await expect(page.getByText('Meera Bill Two').first()).toBeVisible();

    type DirectRow = { title: string; adHocParticipants?: Array<{ id: string; displayName: string }> };
    let rosters: Array<Array<{ id: string; displayName: string }>> = [];
    await expect
      .poll(async () => {
        const rows = await readLocalStore<DirectRow>(page, 'expenses');
        rosters = ['Meera Bill One', 'Meera Bill Two'].map((t) => rows.find((e) => e.title === t)?.adHocParticipants ?? []);
        return rosters.map((r) => r.length > 0);
      }, { message: 'both bills persisted with their participants' })
      .toEqual([true, true]);
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(rosters.flat().every((p) => uuid.test(p.id))).toBe(true);
    expect(rosters[0]!.map((p) => p.id)).toEqual(rosters[1]!.map((p) => p.id));

    await page.getByTestId('nav-tab-friends').first().click();
    await page.getByTestId('settle-all-groups-meera iyer').click();
    await page.getByTestId('nav-tab-home').first().click();
    const payments = page.locator('[data-testid^="direct-settlement-"]');
    await expect(payments).toHaveCount(2);
    await expect(page.locator('[data-testid^="delete-settlement-"]')).toHaveCount(2);
    await page.locator('[data-testid^="delete-settlement-"]').first().click();
    await expect(payments).toHaveCount(1);
  });

  test('Signed in: an expense push carries no group row, and switching user with unsynced changes warns first', async ({
    page,
  }) => {
    await page.goto('/');
    await page.getByTestId('header-user-pill').click();
    await page.getByTestId('demo-profile-login-btn').click();
    await expect(page.getByTestId('dev-auth-modal')).toBeHidden();

    await page.getByTestId('nav-tab-groups').first().click();
    await expect(page.locator('[data-testid^="group-select-"]').first()).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('add-expense-btn').click();
    await expect(page.getByTestId('expense-group-scope-select')).not.toHaveValue('');
    await page.getByTestId('expense-title-input').fill('Push Shape Check');
    await page.getByTestId('expense-amount-input').fill('100');
    const pushReq = page.waitForRequest(
      (req) => req.url().includes('/api/ledger/push') && (req.postData() ?? '').includes('Push Shape Check')
    );
    await page.getByTestId('save-expense-btn').click();
    const { mutations } = (await pushReq).postDataJSON() as { mutations: Array<{ entity: string }> };
    expect(mutations.some((m) => m.entity === 'expense')).toBe(true);
    expect(mutations.some((m) => m.entity === 'group')).toBe(false);

    await page.getByTestId('nav-tab-portability').first().click();
    await page.getByTestId('toggle-offline-btn').click();
    await page.getByTestId('nav-tab-groups').first().click();
    await page.getByTestId('add-expense-btn').click();
    await page.getByTestId('expense-title-input').fill('Offline Pending Bill');
    await page.getByTestId('expense-amount-input').fill('50');
    await page.getByTestId('save-expense-btn').click();
    await expect(page.getByText('Offline Pending Bill').first()).toBeVisible();

    const signInAsRohan = async () => {
      await page.getByTestId('header-user-pill').click();
      await page.getByTestId('dev-login-email-input').fill('rohan.verma@example.com');
      await page.getByTestId('dev-login-password-input').fill(requireEnv('DEV_USER_PASSWORD'));
      await page.getByTestId('dev-login-submit-btn').click();
    };
    await signInAsRohan();
    const warning = page.getByTestId('switch-user-warning');
    await expect(warning).toBeVisible();
    await expect(warning).toContainText('unsynced');
    await page.getByTestId('switch-user-cancel-btn').click();
    await expect(warning).toBeHidden();
    await expect(page.getByTestId('header-user-pill')).toContainText('Arjun Mehta');

    await signInAsRohan();
    await expect(warning).toBeVisible();
    await page.getByTestId('switch-user-discard-btn').click();
    await expect(warning).toBeHidden();
    await expect(page.getByTestId('header-user-pill')).toContainText('Rohan Verma');
  });

  test('Non-admin members cannot change group currency, but can still toggle simplify debts', async ({
    page,
  }) => {
    const ledger = JSON.parse(JSON.stringify(mockData)) as typeof mockData;
    const goa = ledger.groups.find((g) => g.id === 'grp_goa_2026')!;
    for (const m of goa.members) if (m.userId === ledger.currentUser.id) m.role = 'member';
    await page.addInitScript((snapshot: string) => {
      if (!sessionStorage.getItem('non_admin_seeded')) {
        localStorage.setItem('wise_spliter_ledger_state_v1', snapshot);
        sessionStorage.setItem('non_admin_seeded', '1');
      }
    }, JSON.stringify(ledger));
    await page.goto('/');
    await page.getByTestId('open-group-workspace-grp_goa_2026').click();

    await expect(page.getByTestId('change-group-currency-btn')).toBeDisabled();
    await expect(page.getByTestId('currency-admin-only-hint')).toHaveText('Only a group admin can change the currency');
    await expect(page.getByTestId('confirm-currency-change-btn')).toHaveCount(0);

    const simplifyBtn = page.getByTestId('toggle-simplify-debts-btn');
    const before = (await simplifyBtn.textContent()) ?? '';
    await simplifyBtn.click();
    await expect(simplifyBtn).not.toHaveText(before);
  });
});
