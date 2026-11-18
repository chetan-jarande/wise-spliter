import { expect, test, type Page } from '@playwright/test';
import mockData from '../../src/data/mock-ledger-data.json' with { type: 'json' };

const STATE_KEY = 'wise_spliter_ledger_state_v1';
const ME = 'Arjun Mehta';

interface Member { id: string; displayName: string }
interface Group { id: string; name: string; members: Member[] }
interface Expense {
  id: string;
  groupId: string | null;
  title: string;
  payers: Array<{ memberId: string; paidMinor: number }>;
  splits: Array<{ memberId: string; included: boolean; owedMinor: number }>;
  adHocParticipants?: Member[];
  deletedAt: string | null;
}
interface Settlement {
  id: string;
  groupId: string | null;
  expenseId?: string | null;
  fromMemberId: string;
  toMemberId: string;
  amountMinor: number;
  settledDate: string;
  notes: string;
  paymentReference: string | null;
  deletedAt: string | null;
}
interface Ledger {
  groups: Group[];
  expenses: Expense[];
  settlements: Settlement[];
  groupActivityLog: Array<{ entityId: string; action: string }>;
}

const uniq = (label: string) => `${label} ${Math.random().toString(36).slice(2, 7)}`;
const daysAgo = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** The app keeps its ledger in IndexedDB (one table per entity); older builds used localStorage. */
const readLedger = (page: Page) =>
  page.evaluate(async (key) => {
    const legacy = localStorage.getItem(key);
    if (legacy) return JSON.parse(legacy) as Ledger;
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('wise_spliter_local_db');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const all = async (store: string) =>
      db.objectStoreNames.contains(store)
        ? new Promise<Array<Record<string, unknown>>>((res) => {
            const req = db.transaction(store, 'readonly').objectStore(store).getAll();
            req.onsuccess = () => res(req.result as Array<Record<string, unknown>>);
            req.onerror = () => res([]);
          })
        : [];
    const [groups, members, expenses, settlements, groupActivityLog] = await Promise.all(
      ['groups', 'groupMembers', 'expenses', 'settlements', 'groupActivityLog'].map(all)
    );
    db.close();
    return {
      groups: groups!.map((g) => ({
        ...g,
        members: (g.members as Member[] | undefined) ?? members!.filter((m) => m.groupId === g.id && !m.removedAt),
      })),
      expenses,
      settlements,
      groupActivityLog,
    } as unknown as Ledger;
  }, STATE_KEY);

async function gotoTab(page: Page, tab: string) {
  await page.getByTestId(`nav-tab-${tab}`).first().click();
}

async function groupByName(page: Page, name: string): Promise<Group> {
  let found: Group | undefined;
  await expect.poll(async () => Boolean((found = (await readLedger(page)).groups?.find((g) => g.name === name)))).toBe(true);
  return found!;
}

async function setupGroup(page: Page, name: string, others: string[]): Promise<Group> {
  await page.goto('/');
  await gotoTab(page, 'groups');
  await page.getByTestId('create-group-btn').click();
  await page.getByTestId('group-name-input').fill(name);
  await page.getByTestId('group-currency-select').selectOption('INR');
  await page.getByTestId('save-group-btn').click();
  await expect(page.getByRole('heading', { name, exact: true }).first()).toBeVisible();
  for (const o of others) {
    await page.getByTestId('add-member-btn').click();
    await page.getByTestId('member-name-input').fill(o);
    await page.getByTestId('save-member-btn').click();
    await expect(page.getByText(o, { exact: true }).first()).toBeVisible();
  }
  let group = await groupByName(page, name);
  await expect.poll(async () => (group = await groupByName(page, name)).members.length).toBe(others.length + 1);
  return group;
}

const idOf = (group: Group, name: string) => group.members.find((m) => m.displayName === name)!.id;

async function addGroupExpense(page: Page, title: string, amount: string, payer: string) {
  await page.getByTestId('add-expense-btn').click();
  await page.getByTestId('expense-title-input').fill(title);
  await page.getByTestId('expense-amount-input').fill(amount);
  await page
    .getByTestId('multi-payer-toggle')
    .locator('xpath=ancestor::div[contains(@class,"rounded-2xl")][1]')
    .getByRole('button', { name: new RegExp(`${payer}$`) })
    .click();
  await page.getByTestId('save-expense-btn').click();
  await expect(page.getByTestId('expense-title-input')).toBeHidden();
}

async function addDirectBill(page: Page, title: string, amount: string, friend: string): Promise<Expense> {
  await gotoTab(page, 'home');
  await page.getByTestId('home-quick-add-expense-btn').first().click();
  await page.getByTestId('adhoc-friend-name-input').fill(friend);
  await page.getByTestId('add-adhoc-friend-btn').click();
  await page.getByTestId('expense-title-input').fill(title);
  await page.getByTestId('expense-amount-input').fill(amount);
  await page.getByTestId('save-expense-btn').click();
  await expect(page.getByTestId('expense-title-input')).toBeHidden();
  let found: Expense | undefined;
  await expect.poll(async () => Boolean((found = (await readLedger(page)).expenses.find((e) => e.title === title)))).toBe(true);
  return found!;
}

const groupSettlements = async (page: Page, groupId: string) =>
  (await readLedger(page)).settlements.filter((s) => s.groupId === groupId && !s.deletedAt);

async function openStudio(page: Page, group: Group, from: string, to: string) {
  await gotoTab(page, 'friends');
  await page.getByTestId('settle-group-select').selectOption(group.id);
  await page.getByTestId('settle-from-member-select').selectOption(idOf(group, from));
  await page.getByTestId('settle-to-member-select').selectOption(idOf(group, to));
}

test.describe('Settle up', () => {
  test('P0-3: owing a member with no UPI id disables UPI pay and never links to anyone else', async ({ page }) => {
    const group = await setupGroup(page, uniq('No UPI'), ['Bina Rao']);
    await addGroupExpense(page, 'Cab', '100', 'Bina Rao');
    await openStudio(page, group, ME, 'Bina Rao');
    await page.getByTestId('settle-amount-input').fill('50');

    for (const app of ['gpay', 'phonepe', 'paytm']) await expect(page.getByTestId(`upi-launch-${app}`)).toBeDisabled();
    await expect(page.getByTestId('copy-upi-uri-btn')).toBeDisabled();
    await expect(page.getByTestId('upi-missing-hint')).toHaveText('Ask Bina to add their UPI id.');
    await expect(page.getByTestId('upi-payee-id')).toHaveText('No UPI id for Bina Rao yet');
    const uri = (await page.getByTestId('upi-uri-text').textContent()) ?? '';
    expect(uri).not.toContain('upi://');
    expect(uri).not.toMatch(/@|\.test\b/);
  });

  test('P1-5: empty, zero and more-than-owed amounts are refused, never defaulted', async ({ page }) => {
    const group = await setupGroup(page, uniq('Refuse'), ['Bina Rao']);
    await addGroupExpense(page, 'Dinner', '100', ME);
    await openStudio(page, group, 'Bina Rao', ME);
    const submit = page.getByTestId('record-settlement-submit-btn');

    for (const typed of ['', '0', '0.00', 'abc']) {
      await page.getByTestId('settle-amount-input').fill(typed);
      await submit.click();
      await expect(page.getByTestId('settle-amount-error')).toHaveText('Enter an amount above zero.');
    }
    await page.getByTestId('settle-amount-input').fill('50.01');
    await submit.click();
    await expect(page.getByTestId('settle-amount-error')).toContainText('more than Bina owes');
    await page.waitForTimeout(300);
    expect(await groupSettlements(page, group.id)).toEqual([]);
  });

  test('P1-5: a dated group payment can be edited, removed and restored; balances follow and activity shows each step', async ({ page }) => {
    const group = await setupGroup(page, uniq('Edit Pay'), ['Bina Rao']);
    await addGroupExpense(page, 'Dinner', '100', ME);
    await openStudio(page, group, 'Bina Rao', ME);
    await expect(page.getByTestId('settle-date-input')).toHaveValue(daysAgo(0));
    await page.getByTestId('settle-amount-input').fill('20');
    await page.getByTestId('settle-date-input').fill(daysAgo(3));
    await page.getByTestId('settle-notes-input').fill('Cash at dinner');
    await page.getByTestId('payment-method-cash').click();
    await page.getByTestId('record-settlement-submit-btn').click();

    await expect.poll(async () => (await groupSettlements(page, group.id)).length).toBe(1);
    const [stl] = await groupSettlements(page, group.id);
    expect(stl).toMatchObject({ amountMinor: 2000, settledDate: daysAgo(3), notes: 'Cash at dinner', paymentReference: null });

    await page.getByTestId(`edit-group-settlement-${stl!.id}`).click();
    await expect(page.getByTestId('settle-amount-input')).toHaveValue('20.00');
    await page.getByTestId('settle-amount-input').fill('30');
    await page.getByTestId('settle-date-input').fill(daysAgo(2));
    await page.getByTestId('record-settlement-submit-btn').click();
    await expect.poll(async () => (await groupSettlements(page, group.id)).map((s) => [s.id, s.amountMinor, s.settledDate])).toEqual([
      [stl!.id, 3000, daysAgo(2)],
    ]);

    await page.getByTestId(`remove-group-settlement-${stl!.id}`).click();
    await expect.poll(async () => (await groupSettlements(page, group.id)).length).toBe(0);
    const ledger = await readLedger(page);
    expect(ledger.groupActivityLog.filter((a) => a.entityId === stl!.id).map((a) => a.action).sort()).toEqual([
      'settlement_deleted',
      'settlement_recorded',
      'settlement_updated',
    ]);
    await openStudio(page, group, 'Bina Rao', ME);
    await page.getByTestId('settle-amount-full-btn').click();
    await expect(page.getByTestId('settle-amount-input')).toHaveValue('50.00');

    await gotoTab(page, 'activity');
    await page.getByTestId(`restore-settlement-${stl!.id}`).click();
    await expect.poll(async () => (await groupSettlements(page, group.id)).map((s) => [s.id, s.amountMinor])).toEqual([[stl!.id, 3000]]);
    expect((await readLedger(page)).groupActivityLog.some((a) => a.entityId === stl!.id && a.action === 'settlement_restored')).toBe(true);
    await openStudio(page, group, 'Bina Rao', ME);
    await page.getByTestId('settle-amount-full-btn').click();
    await expect(page.getByTestId('settle-amount-input')).toHaveValue('20.00');
  });

  test('any group member, not only the recorder or an admin, can edit and remove a group payment', async ({ page }) => {
    const seeded = JSON.parse(JSON.stringify(mockData)) as typeof mockData;
    const goa = seeded.groups.find((g) => g.id === 'grp_goa_2026')!;
    for (const m of goa.members) m.role = m.id === 'mem_goa_rohan' ? 'admin' : 'member';
    const stl = seeded.settlements.find((x) => x.id === 'stl_goa_01')!;
    stl.toMemberId = 'mem_goa_priya';
    await page.addInitScript(
      ([key, snapshot]) => {
        if (!sessionStorage.getItem('su_seeded')) {
          localStorage.setItem(key, snapshot);
          sessionStorage.setItem('su_seeded', '1');
        }
      },
      [STATE_KEY, JSON.stringify(seeded)] as const
    );
    await page.goto('/');
    await gotoTab(page, 'friends');
    await page.getByTestId('settle-group-select').selectOption('grp_goa_2026');

    await page.getByTestId('edit-group-settlement-stl_goa_01').click();
    await page.getByTestId('settle-amount-input').fill('2500');
    await page.getByTestId('record-settlement-submit-btn').click();
    await expect.poll(async () => (await groupSettlements(page, 'grp_goa_2026')).find((x) => x.id === 'stl_goa_01')?.amountMinor).toBe(250000);

    await page.getByTestId('remove-group-settlement-stl_goa_01').click();
    await expect.poll(async () => (await groupSettlements(page, 'grp_goa_2026')).some((x) => x.id === 'stl_goa_01')).toBe(false);
  });

  test('P1-8: a dated partial payback across direct bills, then the rest, ends at exactly 0; removing one restores it', async ({ page }) => {
    await page.goto('/');
    const friend = uniq('Tara Singh');
    const key = friend.toLowerCase();
    const older = await addDirectBill(page, uniq('Older bill'), '300', friend);
    const newer = await addDirectBill(page, uniq('Newer bill'), '100', friend);
    await gotoTab(page, 'friends');
    const card = page.getByTestId(`friend-card-${key}`);
    await expect(card).toContainText('+₹200.00');

    await page.getByTestId(`direct-payback-${key}`).click();
    await expect(page.getByTestId('direct-payback-panel')).toContainText('owes you ₹200.00');
    await page.getByTestId('settle-amount-input').fill('180');
    await page.getByTestId('settle-date-input').fill(daysAgo(1));
    await page.getByTestId('record-settlement-submit-btn').click();

    const anchored = async () => {
      const l = await readLedger(page);
      return [older, newer].map((b) => l.settlements.filter((s) => s.expenseId === b.id && !s.deletedAt).map((s) => s.amountMinor).sort((x, y) => x - y));
    };
    await expect.poll(anchored).toEqual([[15000], [3000]]);
    expect((await readLedger(page)).settlements.filter((s) => s.expenseId === older.id).map((s) => s.settledDate)).toEqual([daysAgo(1)]);
    await expect(card).toContainText('+₹20.00');

    await page.getByTestId('settle-amount-full-btn').click();
    await expect(page.getByTestId('settle-amount-input')).toHaveValue('20.00');
    await page.getByTestId('record-settlement-submit-btn').click();
    await expect.poll(anchored).toEqual([[15000], [2000, 3000]]);
    await expect(card).toContainText('Settled across all groups');

    await gotoTab(page, 'home');
    const first = (await readLedger(page)).settlements.find((s) => s.expenseId === older.id)!;
    await page.getByTestId(`delete-settlement-${first.id}`).click();
    await gotoTab(page, 'friends');
    await expect(page.getByTestId(`friend-card-${key}`)).toContainText('+₹150.00');
  });

  test('two placeholder friends with the same name in different groups stay separate', async ({ page }) => {
    const rahul = uniq('Rahul');
    for (const label of ['Rahul A', 'Rahul B']) {
      await setupGroup(page, uniq(label), [rahul]);
      await addGroupExpense(page, uniq('Snacks'), '100', ME);
    }
    await gotoTab(page, 'friends');
    await expect(page.locator('[data-testid^="friend-card-"]').filter({ hasText: rahul })).toHaveCount(2);
  });
});

test.describe('Settle up in a decimal-comma locale', () => {
  test.use({ locale: 'de-DE' });

  test('reads "12,50" as 12.50, like the expense amount', async ({ page }) => {
    const group = await setupGroup(page, uniq('Komma'), ['Bina Rao']);
    await addGroupExpense(page, 'Dinner', '100', ME);
    await openStudio(page, group, 'Bina Rao', ME);
    await page.getByTestId('settle-amount-input').fill('12,50');
    await page.getByTestId('record-settlement-submit-btn').click();
    await expect.poll(async () => (await groupSettlements(page, group.id)).map((s) => s.amountMinor)).toEqual([1250]);
  });
});
