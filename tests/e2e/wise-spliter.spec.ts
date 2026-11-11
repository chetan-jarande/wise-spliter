import { expect, test } from '@playwright/test';
import mockData from '../../src/data/mock-ledger-data.json' with { type: 'json' };

test.describe('Wise-Spliter Phase 1 Full Acceptance & E2E Suite', () => {
  test('Home Dashboard (Minimalism, Top 3 Recent Groups, Contextual Guide, Direct Non-Group Split) -> Progressive Disclosure Group Workspace & Ledger', async ({
    page,
    request,
  }) => {
    // 0. Backend API & Centralized Supabase `wise_spliter` Schema Verification
    const bootstrapRes = await request.get('/api/ledger/bootstrap');
    expect(bootstrapRes.ok()).toBe(true);
    const bootstrapBody = (await bootstrapRes.json()) as {
      ok: boolean;
      schema: string;
      dataset: { groups: unknown[]; expenses: unknown[] };
    };
    expect(bootstrapBody.ok).toBe(true);
    expect(bootstrapBody.schema).toBe('wise_spliter');
    expect(bootstrapBody.dataset.groups.length).toBeGreaterThanOrEqual(4);
    expect(bootstrapBody.dataset.expenses.length).toBeGreaterThanOrEqual(10);

    const healthRes = await request.get('/api/health');
    expect(healthRes.ok()).toBe(true);
    const healthBody = (await healthRes.json()) as {
      ok: boolean;
      schema: string;
      supabaseReachable: boolean;
      schemaHealth?: {
        ok: boolean;
        schema: string;
        groups_count: number;
        expenses_count: number;
      };
    };
    expect(healthBody.ok).toBe(true);
    expect(healthBody.schema).toBe('wise_spliter');
    expect(healthBody.supabaseReachable).toBe(true);
    expect(healthBody.schemaHealth?.ok).toBe(true);
    expect(healthBody.schemaHealth?.schema).toBe('wise_spliter');
    expect(healthBody.schemaHealth?.groups_count).toBeGreaterThanOrEqual(4);
    expect(healthBody.schemaHealth?.expenses_count).toBeGreaterThanOrEqual(10);

    await page.goto('/');

    // 1. Home Screen Minimalism & Contextual Help Guide
    await expect(page.getByTestId('home-dashboard-page')).toBeVisible();
    await expect(page.getByTestId('contextual-page-guide')).toBeVisible();

    await page.getByTestId('header-help-btn').click();
    const helpModal = page.getByTestId('help-guide-modal');
    await expect(helpModal).toBeVisible();
    await page.getByTestId('close-help-modal-btn').click();
    await expect(helpModal).toBeHidden();

    // Verify Top 3 Recent Groups constraint: exactly 3 group cards shown even though mock-ledger-data.json has 4 groups
    expect(mockData.groups.length).toBe(4);
    const recentGroupsGrid = page.getByTestId('home-recent-groups-grid');
    await expect(recentGroupsGrid).toBeVisible();
    await expect(
      recentGroupsGrid.locator('[data-testid^="home-recent-group-card-"]')
    ).toHaveCount(3);

    // 2. Modular Add Expense from Home (No Group Selected -> Direct Split Between Added Users)
    await page.getByTestId('home-quick-add-expense-btn').click();
    const scopeSelect = page.getByTestId('expense-group-scope-select');
    await expect(scopeSelect).toBeVisible();
    await expect(scopeSelect).toHaveValue('');
    await expect(page.getByTestId('adhoc-participants-panel')).toBeVisible();

    await page.getByTestId('adhoc-friend-name-input').fill('Vikram Rao');
    await page.getByTestId('add-adhoc-friend-btn').click();
    await expect(page.getByTestId('adhoc-participants-panel')).toContainText('Vikram Rao');

    await page.getByTestId('expense-title-input').fill('Late Night Shawarma & Chai');
    await page.getByTestId('expense-amount-input').fill('900');
    await page.getByTestId('save-expense-btn').click();

    const directExpensesList = page.getByTestId('home-direct-expenses-list');
    await expect(directExpensesList).toBeVisible();
    await expect(directExpensesList).toContainText('Late Night Shawarma & Chai');

    // 3. Progressive Disclosure on Opening a Group & Group-Preselected Add Expense
    await page.getByTestId('open-group-workspace-grp_goa_2026').click();

    await expect(page.getByTestId('group-minimal-insights-bar')).toBeVisible();
    await expect(page.getByTestId('group-auto-guide-strip')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Goa Villa & Scuba 2026' })).toBeVisible();

    // Verify all 4 groups from mock-ledger-data.json are rendered in the Group Switcher Bar
    for (const grp of mockData.groups) {
      await expect(page.getByTestId(`group-select-${grp.id}`)).toBeVisible();
    }

    // 4. Verify Concurrent Offline Conflict Resolution Banner is visible for Thalassa Cliff Dinner
    const conflictBanner = page.getByTestId('conflict-resolution-banner');
    await expect(conflictBanner).toBeVisible();
    await expect(conflictBanner).toContainText('Thalassa Cliff Dinner');

    // Resolve the conflict by keeping the active revision
    await page.getByTestId('keep-active-revision-btn').first().click();
    await expect(conflictBanner).toBeHidden();

    // 5. Open "Explain This Balance" provenance modal for a group member and verify exact math equation
    await page.getByTestId('explain-balance-btn').first().click();
    const explainModal = page.getByTestId('explain-balance-modal');
    await expect(explainModal).toBeVisible();
    await expect(explainModal).toContainText(
      'Exact Ledger Identity: Total Paid - Total Share + Settlements Sent - Settlements Received = Net Balance'
    );
    await expect(explainModal).toContainText('Assagao Pool Villa');
    await page.getByTestId('close-explain-modal-btn').click();
    await expect(explainModal).toBeHidden();

    // 6. Open "Add Expense" modal inside the group workspace and verify group is pre-selected to grp_goa_2026
    await page.getByTestId('add-expense-btn').click();
    await expect(page.getByTestId('expense-group-scope-select')).toHaveValue('grp_goa_2026');

    await page.getByTestId('expense-title-input').fill('Beach Shack Sunset Snacks');
    await page.getByTestId('expense-amount-input').fill('1000');

    // Verify all 5 split mode buttons exist and switch cleanly
    for (const mode of ['equal', 'exact', 'percentage', 'shares', 'adjustment'] as const) {
      await expect(page.getByTestId(`split-mode-${mode}`)).toBeVisible();
      await page.getByTestId(`split-mode-${mode}`).click();
    }
    await page.getByTestId('split-mode-equal').click();

    // Verify Multi-Payer toggle opens per-member payer inputs and toggles back
    const multiPayerToggle = page.getByTestId('multi-payer-toggle');
    await multiPayerToggle.click();
    await expect(multiPayerToggle).toContainText('Multiple Payers Active');
    await multiPayerToggle.click();

    // Verify Foreign Currency FX conversion preview
    const currencySelect = page.getByTestId('expense-currency-select');
    await currencySelect.selectOption('EUR');
    await expect(page.getByTestId('expense-fx-rate-input')).toBeVisible();
    await currencySelect.selectOption('INR');

    // Verify rotating remainder indicator on 3-way split of ₹1,000.00 (exclude 4th member Kabir)
    const fourthMemberId = mockData.groups[0]!.members[3]!.id;
    await page.getByTestId(`split-include-${fourthMemberId}`).uncheck();
    await expect(page.getByText('+1 paise/cents rotated').first()).toBeVisible();

    await expect(page.getByTestId('split-reconciliation-bar')).toContainText('100% Reconciled');
    await page.getByTestId('save-expense-btn').click();

    await expect(page.getByText('Beach Shack Sunset Snacks').first()).toBeVisible();
  });

  test('Tabs 2-5: navigates across Activity & Trash, Friends & Settle (UPI QR + WhatsApp), Insights & Search (INR/JPY/KWD), and Portability & Encrypted Backups', async ({
    page,
  }) => {
    await page.goto('/');

    // Tab 2: Activity & History + Action Types Catalog pills + Revision History restore + Trash Recovery
    await page.getByTestId('nav-tab-activity').click();
    await expect(page.getByTestId('activity-feed-list')).toBeVisible();
    await expect(page.getByText('Filter by Action Type Catalog')).toBeVisible();
    await page.getByRole('button', { name: new RegExp(mockData.actionTypesCatalog[0]!.label, 'i') }).click();
    await expect(page.getByText(`action_code: ${mockData.actionTypesCatalog[0]!.action}`)).toBeVisible();
    await page.getByRole('button', { name: /All Actions/i }).click();

    const revisionPanel = page.getByTestId('revision-history-panel');
    await expect(revisionPanel).toBeVisible();
    await expect(revisionPanel).toContainText('₹6,000.00');
    await expect(revisionPanel).toContainText('₹6,800.00');
    await page.getByTestId(`restore-revision-${mockData.expenseRevisions[0]!.id}`).click();

    await expect(page.getByTestId('trash-recovery-panel')).toBeVisible();
    await expect(page.getByText('Duplicate Entry: Late Night Gelato').first()).toBeVisible();
    await page.getByTestId('restore-trash-exp_goa_trashed_gelato_06').click();

    // Tab 3: Friends Cross-Group Net Balances, 1-click Atomic Settle All, UPI QR Studio, and WhatsApp Summary
    await page.getByTestId('nav-tab-friends').click();
    const friendsList = page.getByTestId('friends-cross-group-list');
    await expect(friendsList).toBeVisible();
    await expect(page.getByTestId('settle-up-studio')).toBeVisible();
    const upiBox = page.getByTestId('upi-deep-link-box');
    await expect(upiBox).toBeVisible();
    await expect(page.getByTestId('upi-uri-text')).toContainText('upi://pay?');
    await expect(upiBox.locator('svg').first()).toBeVisible();

    const whatsappPanel = page.getByTestId('whatsapp-summary-panel');
    await expect(whatsappPanel).toBeVisible();
    await expect(page.getByTestId('whatsapp-summary-markdown')).toContainText('Wise-Spliter Summary - Goa Villa & Scuba 2026');
    await page.getByTestId('copy-whatsapp-summary-btn').click();

    // Test 1-Tap Atomic Settle All Across Groups on a friend with open balance
    const settleAllBtn = page.locator('[data-testid^="settle-all-groups-"]:not([disabled])').first();
    await expect(settleAllBtn).toBeVisible();
    await settleAllBtn.click();

    // Tab 4: Insights & Global Search across 0, 2, and 3 decimal currencies (INR, JPY, KWD)
    await page.getByTestId('nav-tab-analytics').click();
    await expect(page.getByTestId('analytics-kpi-grid')).toBeVisible();
    const categoryChart = page.getByTestId('analytics-category-breakdown');
    await expect(categoryChart).toBeVisible();
    await expect(
      categoryChart.locator('svg[aria-label="Category Spend Proportional Donut Chart"]')
    ).toBeVisible();
    await expect(
      categoryChart.locator('svg[aria-label="Category Horizontal SVG Bar Chart"]')
    ).toBeVisible();

    const searchInput = page.getByTestId('global-search-input');
    // Search JPY (0-decimal)
    await searchInput.fill('Shinkansen');
    await expect(page.getByText('Nozomi Shinkansen Tokyo to Kyoto').first()).toBeVisible();
    await expect(page.getByText('¥28,351').first()).toBeVisible();

    // Search KWD (3-decimal fils)
    await searchInput.fill('Souk Mubarakiya');
    await expect(page.getByText('Souk Mubarakiya Grill Dinner (3-Decimal KWD Fils)').first()).toBeVisible();
    await expect(page.getByText('KD25.000').first()).toBeVisible();

    // Search INR (2-decimal paise)
    await searchInput.fill('Assagao');
    await expect(page.getByText('Assagao Pool Villa (Multi-Payer Booking)').first()).toBeVisible();
    await expect(page.getByText('₹20,000.00').first()).toBeVisible();

    // Tab 5: Portability, Supabase wise_spliter + Google OAuth, Offline Toggle, Splitwise CSV Import/Export & AES-256-GCM Backup/Restore
    await page.getByTestId('nav-tab-portability').click();
    const syncPanel = page.getByTestId('cloud-sync-panel');
    await expect(syncPanel).toBeVisible();
    await expect(syncPanel).toContainText('wise_spliter');
    await expect(syncPanel).toContainText('Google OAuth Verified');

    await page.getByTestId('toggle-offline-btn').click();
    await expect(syncPanel).toContainText('Offline IndexedDB Mode');
    await page.getByTestId('toggle-offline-btn').click();
    await expect(syncPanel).toContainText('Online & Synced');

    await page.getByTestId('load-sample-splitwise-btn').click();
    await page.getByTestId('confirm-splitwise-import-btn').click();

    await expect(page.getByTestId('csv-export-preview')).toContainText('Date,Title,Category');

    await page.getByTestId('backup-passphrase-input').fill('my-vault-passphrase-2026');
    await page.getByTestId('generate-encrypted-backup-btn').click();
    await expect(page.getByTestId('encrypted-backup-output')).toContainText('AES-256-GCM');
    await page.getByTestId('decrypt-restore-btn').click();
    await expect(page.getByText(/Verified & Restored:/i)).toBeVisible();
  });
});
