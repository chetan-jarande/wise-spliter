import { expect, test, type Page } from '@playwright/test';
import mockData from '../../src/data/mock-ledger-data.json' with { type: 'json' };

const STATE_KEY = 'wise_spliter_ledger_state_v1';
const goaCode = mockData.groups.find((g) => g.id === 'grp_goa_2026')!.inviteCode;
type Ledger = typeof mockData;

async function seed(page: Page, mutate?: (l: Ledger) => void) {
  const ledger = JSON.parse(JSON.stringify(mockData)) as Ledger;
  mutate?.(ledger);
  await page.addInitScript(
    ([key, snapshot]) => {
      if (!sessionStorage.getItem('gs_seeded')) {
        localStorage.setItem(key, snapshot);
        sessionStorage.setItem('gs_seeded', '1');
      }
    },
    [STATE_KEY, JSON.stringify(ledger)] as const
  );
  await page.goto('/');
}

async function openGroup(page: Page, groupId: string) {
  const mobileNav = page.getByTestId('mobile-nav-tab-groups');
  if (await mobileNav.isVisible()) await mobileNav.click();
  else await page.getByTestId('nav-tab-groups').click();
  await page.getByTestId(`group-select-${groupId}`).click();
}

async function openAnalytics(page: Page) {
  const mobileNav = page.getByTestId('mobile-nav-tab-analytics');
  if (await mobileNav.isVisible()) await mobileNav.click();
  else await page.getByTestId('nav-tab-analytics').click();
}

const memberCard = (page: Page, name: string) =>
  page.locator('div.rounded-2xl', { has: page.getByTestId('explain-balance-btn') }).filter({ hasText: name });

test.describe('Groups management, search and input safety', () => {
  test('P1-6: no fake Google claim; placeholders show Invite Pending and an admin can add their email', async ({ page }) => {
    await seed(page);
    await openGroup(page, 'grp_goa_2026');
    await expect(page.locator('[data-testid^="claim-member-"]')).toHaveCount(0);
    await expect(page.getByText('Link Google Account')).toHaveCount(0);
    await expect(memberCard(page, 'Kabir Kapoor').getByText('Invite Pending')).toBeVisible();

    await page.getByTestId('member-add-email-mem_goa_kabir').click();
    const input = page.getByTestId('member-email-edit-input-mem_goa_kabir');
    await input.fill('not-an-email');
    await page.getByTestId('member-email-save-mem_goa_kabir').click();
    await expect(page.getByTestId('toast-banner')).toContainText('valid email');

    await input.fill('rohan.verma@example.com');
    await page.getByTestId('member-email-save-mem_goa_kabir').click();
    await expect(page.getByTestId('toast-banner')).toContainText('already uses that email');

    await input.fill('  Kabir.New@Example.com ');
    await page.getByTestId('member-email-save-mem_goa_kabir').click();
    await expect(page.getByTestId('toast-banner')).toContainText('kabir.new@example.com');
    await expect(memberCard(page, 'Kabir Kapoor')).toContainText('kabir.new@example.com');
    await expect(memberCard(page, 'Kabir Kapoor').getByText('Invite Pending')).toBeVisible();
    // Joined members have no email editor; their email comes from their account.
    await expect(page.getByTestId('member-add-email-mem_goa_rohan')).toHaveCount(0);
  });

  test('Removing a member with history keeps them as a former member and balances stay whole', async ({ page }) => {
    await seed(page);
    await openGroup(page, 'grp_goa_2026');
    const before = (await memberCard(page, 'Priya Nair').locator('.tabular-nums').first().textContent())!.trim();
    expect(before).not.toMatch(/^[+-]?\D*0\.00$/);

    await page.getByTestId('remove-member-mem_goa_priya').click();
    await expect(page.getByTestId('remove-member-balance-warning-mem_goa_priya')).toBeVisible();
    await page.getByTestId('remove-member-confirm-mem_goa_priya').click();

    await expect(memberCard(page, 'Priya Nair')).toHaveCount(0);
    const former = page.getByTestId('former-members');
    await expect(former).toContainText('Former members (1)');
    await former.locator('summary').click();
    await expect(former).toContainText('Priya Nair');
    await expect(former.locator('.tabular-nums').first()).toHaveText(before);
    await expect(page.getByTestId('former-member-badge').first()).toBeVisible();

    await expect(page.getByText('Group Members (3)')).toBeVisible();
  });

  test('Admin roles: promote and demote, and the last admin cannot step down', async ({ page }) => {
    await seed(page);
    await openGroup(page, 'grp_goa_2026');
    await page.getByTestId('member-role-mem_goa_arjun').click();
    await expect(page.getByTestId('toast-banner')).toContainText('needs an admin');

    await page.getByTestId('member-role-mem_goa_rohan').click();
    await expect(memberCard(page, 'Rohan Verma').getByText('Admin', { exact: true })).toBeVisible();
    await page.getByTestId('member-role-mem_goa_rohan').click();
    await expect(memberCard(page, 'Rohan Verma').getByText('Admin', { exact: true })).toHaveCount(0);
  });

  test('Non-admins see no admin controls but can still leave', async ({ page }) => {
    await seed(page, (l) => {
      for (const m of l.groups.find((g) => g.id === 'grp_goa_2026')!.members) if (m.userId === l.currentUser.id) m.role = 'member';
    });
    await openGroup(page, 'grp_goa_2026');
    await expect(page.locator('[data-testid^="remove-member-"]')).toHaveCount(0);
    await expect(page.locator('[data-testid^="member-role-"]')).toHaveCount(0);
    await page.getByTestId('group-settings').locator('summary').click();
    await expect(page.getByTestId('delete-group-btn')).toHaveCount(0);
    await expect(page.getByTestId('leave-group-btn')).toBeVisible();
  });

  test('Leaving warns about an open balance and then drops the group from this device', async ({ page }) => {
    await seed(page, (l) => {
      const goa = l.groups.find((g) => g.id === 'grp_goa_2026')!;
      goa.members.find((m) => m.id === 'mem_goa_rohan')!.role = 'admin';
    });
    await openGroup(page, 'grp_goa_2026');
    await page.getByTestId('group-settings').locator('summary').click();
    await page.getByTestId('leave-group-btn').click();
    await expect(page.getByTestId('leave-group-balance-warning')).toContainText(/You (still owe|are still owed)/);
    await page.getByTestId('leave-group-confirm-btn').click();
    await expect(page.getByTestId('toast-banner')).toContainText('You left');
    await expect(page.getByTestId('group-select-grp_goa_2026')).toHaveCount(0);
    await openAnalytics(page);
    await page.getByTestId('global-search-input').fill('Assagao');
    await expect(page.locator('[data-testid^="search-result-title-"]')).toHaveCount(0);
  });

  test('The only admin cannot leave while others remain', async ({ page }) => {
    await seed(page);
    await openGroup(page, 'grp_goa_2026');
    await page.getByTestId('group-settings').locator('summary').click();
    await page.getByTestId('leave-group-btn').click();
    await page.getByTestId('leave-group-confirm-btn').click();
    await expect(page.getByTestId('toast-banner')).toContainText('Make someone else an admin');
    await expect(page.getByTestId('group-select-grp_goa_2026')).toBeVisible();
  });

  test('Deleting a group asks first, moves it to Trash, and it can be restored', async ({ page }) => {
    await seed(page);
    await openGroup(page, 'grp_apt_14b');
    await page.getByTestId('group-settings').locator('summary').click();
    await page.getByTestId('delete-group-btn').click();
    await expect(page.getByRole('alertdialog', { name: 'Delete group' })).toContainText('moves to Trash');
    await page.getByTestId('delete-group-confirm-btn').click();
    await expect(page.getByTestId('group-select-grp_apt_14b')).toHaveCount(0);

    await page.getByTestId('nav-tab-activity').click();
    await page.getByTestId('restore-group-grp_apt_14b').click();
    await openGroup(page, 'grp_apt_14b');
    await expect(page.getByTestId('group-title')).toHaveText('Apt 14B Indiranagar');
  });

  test('Invite link: share sheet fallback copies the link, and the join field validates codes and links', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await seed(page);
    await openGroup(page, 'grp_goa_2026');
    await page.getByTestId('invite-btn').click();
    expect(goaCode).toMatch(/^WS-[0-9A-F]{10}$/);
    await expect(page.getByTestId('invite-code-text')).toHaveText(goaCode);
    await expect(page.getByTestId('invite-link-text')).toHaveText(new RegExp(`/\\?join=${goaCode}$`));
    await expect(page.getByTestId('invite-sign-in-note')).toBeVisible();
    await page.getByTestId('invite-copy-link-btn').click();
    await expect(page.getByTestId('toast-banner')).toContainText('Invite link copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(new RegExp(`\\?join=${goaCode}$`));

    await page.getByTestId('invite-rotate-btn').click();
    await expect(page.getByTestId('invite-rotate-confirm')).toContainText('stop working');
    await page.getByTestId('invite-rotate-confirm-btn').click();
    await expect(page.getByTestId('toast-banner')).toContainText('Sign in to get a new invite code');

    await page.getByTestId('join-group-btn').click();
    const input = page.getByTestId('join-group-input');
    await input.fill('<script>alert(1)</script>');
    await expect(page.getByTestId('join-group-error')).toBeVisible();
    await expect(page.getByTestId('join-group-submit')).toBeDisabled();
    await input.fill('GOA-2026-VILLA');
    await expect(page.getByTestId('join-group-error')).toContainText('WS-');
    await expect(page.getByTestId('join-group-submit')).toBeDisabled();
    await input.fill('https://example.test/?join=ws-ab12cd34ef');
    await expect(page.getByTestId('join-group-error')).toHaveCount(0);
    await page.getByTestId('join-group-submit').click();
    await expect(page.getByTestId('toast-banner')).toContainText('Sign in to join a group');
  });

  test('Opening an invite link shows a join card on Home with the code filled in', async ({ page }) => {
    await page.goto('/?join=ws-ab12cd34ef');
    const card = page.getByTestId('home-join-invite-card');
    await expect(card).toBeVisible();
    await expect(card.getByTestId('join-group-input')).toHaveValue('WS-AB12CD34EF');
    await card.getByTestId('home-join-invite-dismiss').click();
    await expect(card).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get('join')).toBeNull();
  });

  test('Search by exact amount, amount range and date range', async ({ page }) => {
    await seed(page);
    await openAnalytics(page);
    const results = page.locator('[data-testid^="search-result-title-"]');
    const total = await results.count();
    expect(total).toBeGreaterThan(5);

    await page.getByTestId('search-amount-mode').selectOption('exact');
    await page.getByTestId('search-amount-min').fill('1000');
    await expect(results).toHaveCount(1);
    await expect(page.getByTestId('search-result-title-exp_goa_cab_rot_02')).toBeVisible();

    await page.getByTestId('search-amount-min').fill('180');
    await expect(page.getByTestId('search-result-title-exp_goa_scuba_fx_03')).toBeVisible();

    await page.getByTestId('search-amount-mode').selectOption('between');
    await page.getByTestId('search-amount-min').fill('2000');
    await page.getByTestId('search-amount-max').fill('7000');
    const titles = await results.allTextContents();
    expect(titles.length).toBeGreaterThan(0);
    for (const id of ['exp_goa_scooter_exact_05', 'exp_goa_dinner_conflict_04', 'exp_apt_groceries_02']) {
      await expect(page.getByTestId(`search-result-title-${id}`)).toBeVisible();
    }
    await expect(page.getByTestId('search-result-title-exp_goa_villa_01')).toHaveCount(0);

    await page.getByTestId('search-amount-mode').selectOption('any');
    await page.getByTestId('search-date-from').fill('2026-11-08');
    await page.getByTestId('search-date-to').fill('2026-11-09');
    await expect(results).toHaveCount(3);
    await page.getByRole('button', { name: 'Clear Filters' }).click();
    await expect(results).toHaveCount(total);
  });

  test('Monthly spending chart: bars per month, keyboard readout and a table view', async ({ page }) => {
    await seed(page, (l) => {
      const base = l.expenses.find((e) => e.id === 'exp_goa_cab_rot_02')!;
      l.expenses.push(
        { ...base, id: 'exp_sep', expenseDate: '2026-09-14', amountMinor: 300000 },
        { ...base, id: 'exp_jul', expenseDate: '2026-07-02', amountMinor: 50000 }
      );
    });
    await openGroup(page, 'grp_goa_2026');
    await openAnalytics(page);
    const chart = page.getByTestId('analytics-monthly-chart');
    await expect(chart.locator('[data-testid^="monthly-bar-"]')).toHaveCount(5);
    await expect(chart.getByTestId('monthly-chart-readout')).toContainText('November 2026');
    await chart.getByTestId('monthly-bar-2026-09').focus();
    await expect(chart.getByTestId('monthly-chart-readout')).toContainText('September 2026');
    await expect(chart.getByTestId('monthly-chart-readout')).toContainText('1 bill');
    await chart.getByText('Show as a table').click();
    await expect(chart.getByTestId('monthly-chart-table').locator('tbody tr')).toHaveCount(5);
    await expect(chart.getByTestId('monthly-chart-table')).toContainText('August 2026');
  });

  test('Emoji, RTL, very long and HTML titles render as text and truncate with a tooltip', async ({ page }) => {
    const long = `🏖️ ${'Very long trip title '.repeat(12)}end`;
    const html = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>';
    const rtl = 'رحلة إلى دبي';
    await seed(page, (l) => {
      const goa = l.groups.find((g) => g.id === 'grp_goa_2026')!;
      goa.name = long;
      goa.members.find((m) => m.id === 'mem_goa_kabir')!.displayName = html;
      const e = l.expenses.find((x) => x.id === 'exp_goa_cab_rot_02')!;
      e.title = html;
      l.expenses.find((x) => x.id === 'exp_goa_scooter_exact_05')!.title = rtl;
    });
    let dialogs = 0;
    page.on('dialog', (d) => {
      dialogs += 1;
      void d.dismiss();
    });
    await openGroup(page, 'grp_goa_2026');
    const title = page.getByTestId('group-title');
    await expect(title).toHaveAttribute('title', long);
    expect(await title.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    await expect(page.getByTestId('expense-title-exp_goa_cab_rot_02')).toHaveText(html);
    await expect(page.getByTestId('expense-title-exp_goa_scooter_exact_05')).toHaveText(rtl);
    await expect(page.getByTestId('expense-title-exp_goa_scooter_exact_05')).toHaveAttribute('dir', 'auto');
    await expect(page.getByText(html).first()).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
    await expect(page.locator('img[src="x"]')).toHaveCount(0);
    expect(dialogs).toBe(0);
  });

  test('Currency change pre-fills only a known rate; an unknown pair asks for a typed rate', async ({ page }) => {
    await page.route('**/api.frankfurter.dev/**', (route) =>
      route.fulfill({
        json: [
          { base: 'EUR', quote: 'INR', rate: 90, date: '2026-11-13' },
          { base: 'EUR', quote: 'USD', rate: 1.08, date: '2026-11-13' },
        ],
      })
    );
    await seed(page);
    await openGroup(page, 'grp_goa_2026');
    await page.getByTestId('change-group-currency-btn').click();
    await page.getByTestId('change-currency-target-select').selectOption('USD');
    await expect(page.getByTestId('currency-change-rate-input')).toHaveValue('0.012');
    await expect(page.getByTestId('currency-rate-status')).toContainText('rate from 2026-11-13');
    await page.getByTestId('change-currency-target-select').selectOption('BTN');
    await expect(page.getByTestId('currency-change-rate-input')).toHaveValue('');
    await expect(page.getByTestId('currency-rate-status')).toContainText('No rate known for INR to BTN');
    await page.getByTestId('currency-change-rate-input').fill('0.5');
    await expect(page.getByTestId('currency-rate-status')).toContainText('Your rate');
  });

  test('Mobile 375px: groups and insights fit the screen and new controls are 44px', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await seed(page);
    await openGroup(page, 'grp_goa_2026');
    await page.getByTestId('invite-btn').click();
    await page.getByTestId('group-settings').locator('summary').click();
    await page.getByTestId('join-group-btn').click();
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(await overflow()).toBeLessThanOrEqual(0);
    for (const id of [
      'join-group-btn',
      'create-group-btn',
      'invite-btn',
      'invite-share-btn',
      'invite-copy-link-btn',
      'invite-rotate-btn',
      'leave-group-btn',
      'delete-group-btn',
      'join-group-submit',
      'remove-member-mem_goa_kabir',
      'member-add-email-mem_goa_kabir',
      'member-role-mem_goa_rohan',
    ]) {
      const box = await page.getByTestId(id).boundingBox();
      expect(box, id).not.toBeNull();
      expect(box!.height, id).toBeGreaterThanOrEqual(44);
    }

    await openAnalytics(page);
    await page.getByTestId('search-amount-mode').selectOption('between');
    expect(await overflow()).toBeLessThanOrEqual(0);
    for (const id of ['search-amount-mode', 'search-amount-min', 'search-amount-max', 'search-date-from', 'search-date-to']) {
      const box = await page.getByTestId(id).boundingBox();
      expect(box!.height, id).toBeGreaterThanOrEqual(44);
    }
    const bar = await page.locator('[data-testid^="monthly-bar-"]').last().boundingBox();
    expect(bar!.width).toBeGreaterThanOrEqual(44);
  });

  test('375px: stat tiles fit big amounts, and the last control on each page clears the FAB', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const scale = (e: Ledger['expenses'][number], k: number) => {
      e.amountMinor *= k;
      e.originalAmountMinor *= k;
      for (const p of e.payers) {
        p.paidMinor *= k;
        p.originalPaidMinor *= k;
      }
      for (const sp of e.splits) {
        sp.owedMinor *= k;
        sp.originalOwedMinor *= k;
      }
    };
    await seed(page, (l) => {
      scale(l.expenses.find((e) => e.id === 'exp_goa_villa_01')!, 6173);
      scale(l.expenses.find((e) => e.id === 'exp_kwd_souk_01')!, 4938);
    });

    const tilesFit = async (gridTestId: string) => {
      const bad = await page.getByTestId(gridTestId).evaluate((grid) => {
        const out: string[] = [];
        for (const tile of Array.from(grid.children)) {
          const t = tile.getBoundingClientRect();
          for (const el of Array.from(tile.querySelectorAll('*'))) {
            const r = el.getBoundingClientRect();
            if (r.width === 0) continue;
            if (r.left < t.left - 0.5 || r.right > t.right + 0.5 || r.top < t.top - 0.5 || r.bottom > t.bottom + 0.5) {
              out.push(`${(el.textContent ?? '').trim().slice(0, 30)} ${Math.round(r.left)}-${Math.round(r.right)} vs ${Math.round(t.left)}-${Math.round(t.right)}`);
            }
          }
          const amount = tile.querySelector('.tabular-nums');
          const lines = new Set(Array.from(amount?.getClientRects() ?? []).map((r) => Math.round(r.top)));
          if (lines.size > 1) out.push(`wrapped: ${amount!.textContent}`);
        }
        return out;
      });
      expect(bad, gridTestId).toEqual([]);
    };

    const clearsFab = async (where: string) => {
      const fab = page.getByTestId('mobile-fab-split-btn');
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(200);
      const overlap = await page.evaluate(() => {
        const fabEl = document.querySelector('[data-testid="mobile-fab-split-btn"]');
        if (!fabEl) return null;
        const f = fabEl.getBoundingClientRect();
        const controls = Array.from(
          document.querySelectorAll('main button, main a[href], main input, main select, main summary')
        ).filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 1 && r.height > 1 && getComputedStyle(el).visibility !== 'hidden';
        });
        const last = controls[controls.length - 1]!;
        const r = last.getBoundingClientRect();
        const hit = r.left < f.right && r.right > f.left && r.top < f.bottom && r.bottom > f.top;
        return hit ? `${last.tagName} "${(last.textContent ?? '').trim().slice(0, 30)}"` : '';
      });
      expect(await fab.count(), where).toBe(1);
      expect(overlap, where).toBe('');
    };

    await tilesFit('home-stat-tiles');
    await clearsFab('home');
    await openGroup(page, 'grp_goa_2026');
    await tilesFit('group-minimal-insights-bar');
    await clearsFab('groups');
    await page.getByTestId('mobile-nav-tab-friends').click();
    await tilesFit('friends-stat-tiles');
    await openAnalytics(page);
    await tilesFit('analytics-kpi-grid');

    await openGroup(page, 'grp_kuwait_stopover');
    await tilesFit('group-minimal-insights-bar');
    await page.setViewportSize({ width: 640, height: 900 });
    await page.getByTestId('mobile-nav-tab-home').click();
    await tilesFit('home-stat-tiles');
  });

  test('UPI payee safety: edit your own or a placeholder UPI, never another account; changes show who did it', async ({ page }) => {
    await seed(page, (l) => {
      const goa = l.groups.find((g) => g.id === 'grp_goa_2026')!;
      l.groupActivityLog.unshift({
        ...l.groupActivityLog.find((a) => a.groupId === goa.id)!,
        id: 'act_upi_seed',
        groupId: goa.id,
        actorMemberId: 'mem_goa_rohan',
        actorDisplayName: 'Rohan Verma',
        entityType: 'member',
        entityId: 'mem_goa_kabir',
        action: 'upi_changed',
        summaryText: 'Rohan Verma changed the UPI ID of Kabir Kapoor',
        detailNote: 'ka***@upi.test to ka***@okaxis',
        diffBadges: [],
        createdAt: '2026-11-12T10:00:00.000Z',
      });
    });
    await openGroup(page, 'grp_goa_2026');
    await expect(page.getByTestId('member-upi-changed-mem_goa_kabir')).toHaveText('UPI changed by Rohan Verma');
    await expect(page.getByTestId('member-upi-changed-mem_goa_rohan')).toHaveCount(0);

    await page.getByTestId('member-upi-edit-mem_goa_rohan').click();
    await expect(page.getByTestId('member-upi-locked-mem_goa_rohan')).toHaveText('Only Rohan Verma can change their UPI ID.');
    await expect(page.getByTestId('member-upi-input-mem_goa_rohan')).toHaveCount(0);

    await page.getByTestId('member-upi-edit-mem_goa_kabir').click();
    const input = page.getByTestId('member-upi-input-mem_goa_kabir');
    await input.fill('not a vpa');
    await page.getByTestId('member-upi-save-mem_goa_kabir').click();
    await expect(page.getByTestId('toast-banner')).toContainText('name@bank');
    await input.fill('kabir.k@okhdfc');
    await page.getByTestId('member-upi-save-mem_goa_kabir').click();
    await expect(memberCard(page, 'Kabir Kapoor')).toContainText('UPI: kabir.k@okhdfc');

    await page.getByTestId('member-upi-edit-mem_goa_arjun').click();
    await page.getByTestId('member-upi-input-mem_goa_arjun').fill('arjun.new@okicici');
    await page.getByTestId('member-upi-save-mem_goa_arjun').click();
    await expect(memberCard(page, 'Arjun Mehta')).toContainText('UPI: arjun.new@okicici');

    await page.getByTestId('nav-tab-activity').click();
    const row = page.getByText('Rohan Verma changed the UPI ID of Kabir Kapoor');
    await expect(row).toBeVisible();
    await expect(page.getByText('ka***@upi.test to ka***@okaxis')).toBeVisible();
    await expect(page.getByText('UPI ID changed', { exact: true }).first()).toBeVisible();
  });

  test('Imported comments are labelled, and unknown actors read as someone in the group', async ({ page }) => {
    await seed(page, (l) => {
      const cab = l.expenses.find((e) => e.id === 'exp_goa_cab_rot_02')!;
      (cab.comments as unknown[]).push({
        id: 'cmt_legacy_1',
        expenseId: cab.id,
        authorMemberId: 'mem_goa_rohan',
        authorName: 'Rohan (imported)',
        body: 'Paid the driver in cash',
        createdAt: '2026-11-08T10:00:00.000Z',
        isLegacy: true,
      });
      const rev = l.expenseRevisions.find((r) => r.id === 'rev_goa_04_v2_rohan')!;
      (rev as { actorMemberId: string | null }).actorMemberId = null;
      rev.actorDisplayName = '';
      const act = l.groupActivityLog.find((a) => a.groupId === 'grp_goa_2026')!;
      (act as { actorMemberId: string | null }).actorMemberId = null;
      act.actorDisplayName = '';
    });
    await openGroup(page, 'grp_goa_2026');
    const card = page.locator('div.rounded-\\[1\\.5rem\\]', { has: page.getByTestId('expense-title-exp_goa_cab_rot_02') }).last();
    await card.getByRole('button', { name: /Comments/ }).first().click();
    await expect(page.getByTestId('comment-imported-cmt_legacy_1')).toHaveText('imported');
    await expect(page.getByText('Paid the driver in cash')).toBeVisible();

    await page.getByTestId('nav-tab-activity').click();
    await expect(page.getByText('by Someone in this group').first()).toBeVisible();
    await expect(page.getByText(/by mem_|by null|by undefined/)).toHaveCount(0);
    await page.getByLabel('Search activity log').fill('Someone in this group');
    await expect(page.getByText(/no activity|nothing/i)).toHaveCount(0);
  });
});
