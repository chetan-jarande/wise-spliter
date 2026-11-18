import { expect, test, type Page } from '@playwright/test';
import mockData from '../../src/data/mock-ledger-data.json' with { type: 'json' };

const STATE_KEY = 'wise_spliter_ledger_state_v1';
const GROUP = 'grp_apt_14b';
const FX_ROUTE = 'https://api.frankfurter.dev/**';

// VND is deliberately missing so the "no known rate" path is exercised.
const RATES = [
  { date: '2026-12-02', base: 'EUR', quote: 'INR', rate: 104.15 },
  { date: '2026-12-02', base: 'EUR', quote: 'USD', rate: 1.1072 },
  { date: '2026-12-01', base: 'EUR', quote: 'KWD', rate: 0.34304 },
  { date: '2026-12-02', base: 'EUR', quote: 'JPY', rate: 177.06 },
];

interface Expense {
  title: string;
  amountMinor: number;
  originalAmountMinor: number;
  fxRateScaled: number;
  fxStatus: string;
  fxAuditNote: string | null;
  expenseDate: string;
  groupId: string | null;
  groupCurrency: string;
  deletedAt: string | null;
  payers: Array<{ memberId: string; paidMinor: number }>;
  splits: Array<{ memberId: string; included: boolean; owedMinor: number }>;
}

async function mockRates(page: Page, calls: string[] = []) {
  await page.route(FX_ROUTE, (route) => {
    calls.push(route.request().url());
    return route.fulfill({ json: RATES, headers: { 'access-control-allow-origin': '*' } });
  });
}

interface Ledger {
  groups: Array<{ id: string; baseCurrency: string }>;
  expenses: Expense[];
  settlements: Array<{ groupId: string; deletedAt: string | null; fromMemberId: string; toMemberId: string; amountMinor: number; currency: string }>;
  groupActivityLog: Array<{ groupId: string; action: string; detailNote: string }>;
}

/** The ledger lives in IndexedDB tables; older builds kept it in localStorage. */
const readLedger = (page: Page) =>
  page.evaluate(async (key) => {
    const legacy = localStorage.getItem(key);
    if (legacy) return JSON.parse(legacy);
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('wise_spliter_local_db');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const all = (store: string) =>
      db.objectStoreNames.contains(store)
        ? new Promise<unknown[]>((res) => {
            const req = db.transaction(store, 'readonly').objectStore(store).getAll();
            req.onsuccess = () => res(req.result);
            req.onerror = () => res([]);
          })
        : Promise.resolve([]);
    const [groups, expenses, settlements, groupActivityLog] = await Promise.all(
      ['groups', 'expenses', 'settlements', 'groupActivityLog'].map(all)
    );
    db.close();
    return { groups, expenses, settlements, groupActivityLog };
  }, STATE_KEY) as Promise<Ledger>;

async function readExpense(page: Page, title: string): Promise<Expense> {
  let found: Expense | undefined;
  await expect
    .poll(async () => {
      found = (await readLedger(page)).expenses.find((e) => e.title === title);
      return Boolean(found);
    })
    .toBe(true);
  return found!;
}

function expectConserved(e: Expense) {
  expect(e.payers.reduce((a, p) => a + p.paidMinor, 0)).toBe(e.amountMinor);
  expect(e.splits.filter((s) => s.included).reduce((a, s) => a + s.owedMinor, 0)).toBe(e.amountMinor);
}

/** Same rule as the app: cross rate rounded half-up to 1e-8, then the amount rounded half-up. */
function expectedConversion(origMinor: bigint, fromPerEur: string, toPerEur: string, fromScale: bigint, toScale: bigint) {
  const scaled = (d: string) => BigInt(d.replace('.', '').padEnd(d.split('.')[0]!.length + 12, '0'));
  const f = scaled(fromPerEur);
  const t = scaled(toPerEur);
  const rate = (t * 100000000n * 2n + f) / (2n * f);
  const den = fromScale * 100000000n;
  return { rate: Number(rate), converted: Number((origMinor * rate * toScale * 2n + den) / (2n * den)) };
}

async function openNewExpense(page: Page) {
  await page.getByTestId('nav-tab-groups').first().click();
  await page.getByTestId(`group-select-${GROUP}`).click();
  await page.getByTestId('add-expense-btn').click();
  await expect(page.getByTestId('expense-title-input')).toBeVisible();
}

test.describe('Money and FX', () => {
  test.use({ timezoneId: 'Asia/Kolkata', locale: 'en-IN' });

  test('a new expense defaults to the local today, even just after local midnight', async ({ page }) => {
    await mockRates(page);
    await page.clock.setFixedTime(new Date('2026-12-02T19:00:00Z'));
    await page.goto('/');
    await openNewExpense(page);
    await expect(page.getByTestId('expense-date-input')).toHaveValue('2026-12-03');
  });

  test('a currency with no known rate blocks saving until a manual rate is entered', async ({ page }) => {
    await mockRates(page);
    await page.clock.setFixedTime(new Date('2026-12-03T06:00:00Z'));
    await page.goto('/');
    await openNewExpense(page);
    await page.getByTestId('expense-title-input').fill('Pho in Hanoi');
    await page.getByTestId('expense-currency-select').selectOption('VND');
    await page.getByTestId('expense-amount-input').fill('1000000');
    await expect(page.getByTestId('fx-rate-missing')).toBeVisible();
    await expect(page.getByTestId('expense-fx-rate-input')).toHaveValue('');
    await expect(page.getByTestId('save-expense-btn')).toBeDisabled();

    await page.getByTestId('expense-fx-rate-input').fill('0.0035');
    await expect(page.getByTestId('fx-rate-missing')).toBeHidden();
    await expect(page.getByTestId('fx-audit-note')).toContainText('(manual rate, 2026-12-03)');
    await page.getByTestId('save-expense-btn').click();

    const e = await readExpense(page, 'Pho in Hanoi');
    expect(e.fxStatus).toBe('manual');
    expect(e.fxAuditNote).not.toContain('live');
    expect(e.originalAmountMinor).toBe(1_000_000);
    expect(e.amountMinor).toBe(350_000);
    expectConserved(e);
  });

  test('a fetched rate is live today, converts in BigInt and is stored with its date', async ({ page }) => {
    const calls: string[] = [];
    await mockRates(page, calls);
    await page.clock.setFixedTime(new Date('2026-12-03T06:00:00Z'));
    await page.goto('/');
    await openNewExpense(page);
    await page.getByTestId('expense-title-input').fill('Airport taxi');
    await page.getByTestId('expense-currency-select').selectOption('USD');
    await page.getByTestId('expense-amount-input').fill('12.51');
    const { rate, converted } = expectedConversion(1251n, '1.1072', '104.15', 100n, 100n);
    await expect(page.getByTestId('fx-audit-note')).toContainText('(live rate, 2026-12-02)');
    await page.getByTestId('save-expense-btn').click();

    const e = await readExpense(page, 'Airport taxi');
    expect(e.fxStatus).toBe('live');
    expect(e.fxRateScaled).toBe(rate);
    expect(e.amountMinor).toBe(converted);
    expect(e.fxAuditNote).toContain('Converted from $12.51 USD at 1 USD = ');
    expectConserved(e);
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });

  test('an older cache is flagged cached_offline with the rate date when the API is unreachable', async ({ page }) => {
    await mockRates(page);
    await page.clock.setFixedTime(new Date('2026-12-03T06:00:00Z'));
    await page.goto('/');
    await openNewExpense(page);
    await page.getByTestId('expense-currency-select').selectOption('USD');
    await expect(page.getByTestId('fx-audit-note')).toContainText('live rate');

    await page.unroute(FX_ROUTE);
    await page.route(FX_ROUTE, (route) => route.abort('internetdisconnected'));
    await page.clock.setFixedTime(new Date('2026-12-06T06:00:00Z'));
    await page.reload();
    await openNewExpense(page);
    await page.getByTestId('expense-title-input').fill('Offline dinner');
    await page.getByTestId('expense-currency-select').selectOption('USD');
    await page.getByTestId('expense-amount-input').fill('20');
    await expect(page.getByTestId('fx-audit-note')).toContainText('(cached offline rate, 2026-12-02)');
    await page.getByTestId('save-expense-btn').click();
    const e = await readExpense(page, 'Offline dinner');
    expect(e.fxStatus).toBe('cached_offline');
    expectConserved(e);
  });

  test('the payer can untick themselves from the split and is owed the whole bill', async ({ page }) => {
    await mockRates(page);
    await page.goto('/');
    await openNewExpense(page);
    const [me, ...others] = mockData.groups.find((g) => g.id === GROUP)!.members.map((m) => m.id);
    await page.getByTestId('expense-title-input').fill('Dinner I skipped');
    await page.getByTestId('expense-amount-input').fill('900');
    await page.getByTestId(`split-include-${me}`).uncheck();
    await page.getByTestId('save-expense-btn').click();

    const e = await readExpense(page, 'Dinner I skipped');
    expect(e.payers).toEqual([expect.objectContaining({ memberId: me, paidMinor: 90000 })]);
    expect(e.splits.find((s) => s.memberId === me)).toMatchObject({ included: false, owedMinor: 0 });
    expect(others.map((id) => e.splits.find((s) => s.memberId === id)?.owedMinor)).toEqual([45000, 45000]);
    expectConserved(e);
  });

  test('Friends INR totals use fetched rates with their date and list currencies without a rate', async ({ page }) => {
    await page.route(FX_ROUTE, (route) =>
      route.fulfill({ json: RATES.filter((r) => r.quote !== 'KWD'), headers: { 'access-control-allow-origin': '*' } })
    );
    await page.clock.setFixedTime(new Date('2026-12-03T06:00:00Z'));
    await page.goto('/');
    await page.getByTestId('nav-tab-friends').first().click();
    await expect(page.getByTestId('friends-fx-label')).toHaveText('Foreign balances converted at live rates, 2026-12-02', { timeout: 15_000 });
    await expect(page.getByTestId('friends-unconverted-balances')).toContainText('KWD');
    await expect(page.getByTestId('friends-unconverted-balances')).not.toContainText('JPY');
  });

  test('former members are not offered for new bills or payments but stay read-only on bills that include them', async ({ page }) => {
    await mockRates(page);
    await page.goto('/');
    await page.getByTestId('nav-tab-groups').first().click();
    await page.getByTestId(`group-select-${GROUP}`).click();
    await page.getByTestId('remove-member-mem_apt_neha').click();
    await page.getByTestId('remove-member-confirm-mem_apt_neha').click();
    await expect(page.getByTestId('former-members')).toContainText('Former members (1)');

    await page.getByTestId('add-expense-btn').click();
    await expect(page.getByTestId('split-include-mem_apt_rohan')).toBeVisible();
    await expect(page.getByTestId('split-include-mem_apt_neha')).toHaveCount(0);
    await expect(page.getByTestId('payer-chip-mem_apt_neha')).toHaveCount(0);
    await page.getByRole('button', { name: 'Close modal' }).click();

    const before = (await readLedger(page)).expenses.find((e) => e.title.startsWith("Nature's Basket"))!;
    await page
      .getByTestId('expense-title-exp_apt_groceries_02')
      .locator('xpath=ancestor::div[.//button[normalize-space()="Edit"]][1]')
      .getByRole('button', { name: 'Edit', exact: true })
      .click();
    await expect(page.getByTestId('former-member-chip-mem_apt_neha')).toBeVisible();
    await expect(page.getByTestId('split-include-mem_apt_neha')).toBeDisabled();
    await page.getByTestId('save-expense-btn').click();
    await expect.poll(async () => (await readLedger(page)).expenses.find((e) => e.title === before.title)?.splits).toEqual(before.splits);

    await page.getByTestId('nav-tab-friends').first().click();
    await page.getByTestId('settle-group-select').selectOption(GROUP);
    const from = page.getByTestId('settle-from-member-select');
    await expect(from).toBeVisible();
    await expect(from.locator('option[value="mem_apt_neha"]')).toHaveCount(0);
    await expect(page.getByTestId('settle-to-member-select').locator('option[value="mem_apt_neha"]')).toHaveCount(0);
  });

  test('the currency picker offers only ISO 4217 codes', async ({ page }) => {
    await mockRates(page);
    await page.goto('/');
    await openNewExpense(page);
    const codes = await page.getByTestId('expense-currency-select').locator('option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
    expect(codes.length).toBeGreaterThanOrEqual(160);
    expect(codes.filter((c) => !/^[A-Z]{3}$/.test(c))).toEqual([]);
    expect(codes).not.toContain('SOMALILAND');
  });

  test('"12,50" in an en-IN amount field is rejected, never read as 1,250.00', async ({ page }) => {
    await mockRates(page);
    await page.goto('/');
    await openNewExpense(page);
    await page.getByTestId('expense-title-input').fill('Comma typo');
    await page.getByTestId('expense-amount-input').fill('12,50');
    await expect(page.getByTestId('expense-amount-input')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByTestId('save-expense-btn')).toBeDisabled();
    await page.getByTestId('expense-amount-input').fill('1,250.50');
    await page.getByTestId('save-expense-btn').click();
    expect((await readExpense(page, 'Comma typo')).amountMinor).toBe(125050);
  });

  test('converting the whole group records the rate and date and keeps every bill and the group balanced', async ({ page }) => {
    await mockRates(page);
    await page.clock.setFixedTime(new Date('2026-12-03T06:00:00Z'));
    await page.goto('/');
    await page.getByTestId('nav-tab-groups').first().click();
    await page.getByTestId(`group-select-${GROUP}`).click();
    await page.getByTestId('change-group-currency-btn').click();
    await page.getByTestId('change-currency-target-select').selectOption('KWD');
    await page.getByRole('button', { name: /Mode B: Convert existing bills/ }).click();
    await page.getByTestId('currency-change-rate-input').fill('0.0033');
    await page.getByTestId('confirm-currency-change-btn').click();

    await expect.poll(async () => (await readLedger(page)).groups.find((g) => g.id === GROUP)?.baseCurrency).toBe('KWD');
    const ledger = await readLedger(page);
    const bills = ledger.expenses.filter((e) => e.groupId === GROUP);
    const nets = new Map<string, number>();
    for (const e of bills) {
      expect(e.groupCurrency).toBe('KWD');
      expectConserved(e);
      if (e.deletedAt) continue;
      for (const p of e.payers) nets.set(p.memberId, (nets.get(p.memberId) ?? 0) + p.paidMinor);
      for (const s of e.splits) if (s.included) nets.set(s.memberId, (nets.get(s.memberId) ?? 0) - s.owedMinor);
    }
    for (const s of ledger.settlements.filter((x) => x.groupId === GROUP)) {
      expect(s.currency).toBe('KWD');
      if (s.deletedAt) continue;
      nets.set(s.fromMemberId, (nets.get(s.fromMemberId) ?? 0) + s.amountMinor);
      nets.set(s.toMemberId, (nets.get(s.toMemberId) ?? 0) - s.amountMinor);
    }
    expect([...nets.values()].reduce((a, b) => a + b, 0)).toBe(0);
    const act = ledger.groupActivityLog.find((a) => a.groupId === GROUP && a.action === 'group_currency_changed')!;
    expect(act.detailNote).toMatch(/1 INR = 0\.0033 KWD \((live|cached offline|manual) rate, \d{4}-\d{2}-\d{2}\)/);
  });
});

test.describe('Money and FX in a decimal-comma locale', () => {
  test.use({ timezoneId: 'Europe/Berlin', locale: 'de-DE' });

  test('percent splits, manual rates and the group rate read "," as the decimal separator', async ({ page }) => {
    await mockRates(page);
    await page.goto('/');
    await openNewExpense(page);
    const [arjun, rohan, neha] = mockData.groups.find((g) => g.id === GROUP)!.members.map((m) => m.id);
    await page.getByTestId('expense-title-input').fill('Komma Pho');
    await page.getByTestId('expense-currency-select').selectOption('VND');
    await page.getByTestId('expense-amount-input').fill('1.000.000');
    await page.getByTestId('expense-fx-rate-input').fill('0,0035');
    await page.getByTestId('split-mode-percentage').click();
    await page.getByTestId(`split-input-${arjun}`).fill('50');
    await page.getByTestId(`split-input-${rohan}`).fill('25,5');
    await page.getByTestId(`split-input-${neha}`).fill('24,5');
    await page.getByTestId('save-expense-btn').click();
    const e = await readExpense(page, 'Komma Pho');
    expect(e.amountMinor).toBe(350_000);
    expect([arjun, rohan, neha].map((id) => e.splits.find((s) => s.memberId === id)?.owedMinor)).toEqual([175_000, 89_250, 85_750]);

    await page.getByTestId('change-group-currency-btn').click();
    await page.getByTestId('change-currency-target-select').selectOption('KWD');
    await page.getByRole('button', { name: /Mode B: Convert existing bills/ }).click();
    const rate = page.getByTestId('currency-change-rate-input');
    await rate.fill('abc');
    await expect(page.getByTestId('confirm-currency-change-btn')).toBeDisabled();
    await rate.fill('0,0033');
    await page.getByTestId('confirm-currency-change-btn').click();
    await expect.poll(async () => (await readLedger(page)).groups.find((g) => g.id === GROUP)?.baseCurrency).toBe('KWD');
    const act = (await readLedger(page)).groupActivityLog.find((a) => a.groupId === GROUP && a.action === 'group_currency_changed')!;
    expect(act.detailNote).toContain('1 INR = 0.0033 KWD (manual rate');
  });
});

test.describe('Expense editor and background sync', () => {
  test('a sync landing while the editor is open keeps what the user typed', async ({ page }) => {
    await mockRates(page);
    await page.goto('/');
    await page.getByTestId('header-user-pill').click();
    await page.getByTestId('demo-profile-login-btn').click();
    await expect(page.getByTestId('dev-auth-modal')).toBeHidden();
    await page.getByTestId('nav-tab-groups').first().click();
    await expect(page.locator('[data-testid^="group-select-"]').first()).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('add-expense-btn').click();
    await page.getByTestId('expense-title-input').fill('Typed before sync');
    await page.getByTestId('expense-amount-input').fill('432.10');

    for (let i = 0; i < 2; i++) {
      const pulled = page.waitForResponse((r) => r.url().includes('/api/ledger/pull'), { timeout: 20_000 });
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await pulled;
    }
    await page.waitForTimeout(500);
    await expect(page.getByTestId('expense-title-input')).toHaveValue('Typed before sync');
    await expect(page.getByTestId('expense-amount-input')).toHaveValue('432.10');
  });
});

test.describe('Bill field limits', () => {
  test('the editor caps text at the server limits and explains too many tags calmly', async ({ page }) => {
    await mockRates(page);
    await page.goto('/');
    await openNewExpense(page);
    await expect(page.getByTestId('expense-title-input')).toHaveAttribute('maxlength', '200');
    await expect(page.getByTestId('expense-notes-input')).toHaveAttribute('maxlength', '2000');
    await page.getByTestId('expense-title-input').fill('x'.repeat(250));
    await expect(page.getByTestId('expense-title-input')).toHaveValue('x'.repeat(200));
    await page.getByTestId('expense-amount-input').fill('100');
    await page.getByTestId('expense-tags-input').fill(Array.from({ length: 21 }, (_, i) => `t${i}`).join(', '));
    await expect(page.getByTestId('expense-text-problems')).toHaveText('Use at most 20 tags.');
    await expect(page.getByTestId('save-expense-btn')).toBeDisabled();
    await page.getByTestId('expense-tags-input').fill('dinner, ' + 'a'.repeat(41));
    await expect(page.getByTestId('expense-text-problems')).toHaveText('Keep each tag to 40 characters.');
    await page.getByTestId('expense-tags-input').fill('dinner');
    await expect(page.getByTestId('save-expense-btn')).toBeEnabled();
  });
});
