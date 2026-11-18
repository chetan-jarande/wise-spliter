import {
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { LIMITS } from '../../src/types/limits';
import mockData from '../../src/data/mock-ledger-data.json' with { type: 'json' };

// Expectations come from docs/feature-requiremrnts.md and Splitwise/Settl money semantics.
// The implementation was read only to find selectors.

const LEGACY_STATE_KEY = 'wise_spliter_ledger_state_v1'; // only used to seed a legacy snapshot the app migrates
const SYNC_PREFIX = 'E2E-EDGE-';
const BASE_URL = `http://localhost:${process.env.APP_PORT || 4173}`;
const ME = 'Arjun Mehta';

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required (see .env.example)`);
  return value;
}

interface Split { memberId: string; included: boolean; owedMinor: number; remainderMinor: number }
interface Payer { memberId: string; paidMinor: number }
interface Participant { id: string; displayName: string }
interface Expense {
  id: string;
  groupId: string | null;
  title: string;
  amountMinor: number;
  originalAmountMinor: number;
  originalCurrency: string;
  groupCurrency: string;
  fxAuditNote: string | null;
  payers: Payer[];
  splits: Split[];
  deletedAt: string | null;
  hasUnresolvedConflict: boolean;
  adHocParticipants?: Participant[];
}
interface Settlement {
  id: string;
  groupId: string | null;
  expenseId?: string | null;
  fromMemberId: string;
  toMemberId: string;
  amountMinor: number;
  currency: string;
  deletedAt: string | null;
}
interface Member { id: string; groupId: string; displayName: string; userId: string | null; role: string; invitedEmail: string | null; removedAt?: string | null }
interface Group { id: string; name: string; baseCurrency: string; simplifyDebts: boolean; deletedAt: string | null; members: Member[] }
interface Ledger {
  currentUser: { id: string; email: string; fullName: string };
  groups: Group[];
  expenses: Expense[];
  settlements: Settlement[];
}

const uniq = (label: string) => `${label} ${Math.random().toString(36).slice(2, 7)}`;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** "+₹1,234.56" -> 123456, "-KD0.334" -> -334, "¥1" -> 1 (formatter always prints every decimal). */
function parseMinor(text: string): number {
  const digits = text.replace(/[^0-9]/g, '');
  const value = Number(digits || '0');
  return /-/.test(text) ? -value : value;
}

/** Reads the ledger from the Dexie source of truth (IndexedDB `wise_spliter_local_db`). */
async function readLedger(page: Page): Promise<Ledger> {
  return page.evaluate(async () => {
    const empty = { currentUser: { id: '', email: '', fullName: '' }, groups: [], expenses: [], settlements: [] };
    const db = await new Promise<IDBDatabase | null>((res) => {
      const r = indexedDB.open('wise_spliter_local_db');
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(null);
    });
    if (!db) return empty;
    const all = (store: string) =>
      new Promise<unknown[]>((res) => {
        if (!db.objectStoreNames.contains(store)) return res([]);
        const req = db.transaction(store, 'readonly').objectStore(store).getAll();
        req.onsuccess = () => res(req.result as unknown[]);
        req.onerror = () => res([]);
      });
    const [groups, expenses, settlements, kv] = await Promise.all([all('groups'), all('expenses'), all('settlements'), all('kvStore')]);
    db.close();
    const meta = (kv as Array<{ key: string; valueJson: string }>).find((r) => r.key === 'dataset_meta_v2');
    const currentUser = meta ? (JSON.parse(meta.valueJson) as { currentUser?: typeof empty.currentUser }).currentUser : undefined;
    const strip = (rows: unknown[]) => rows.map((r) => { const { _o, ...rest } = r as { _o?: number }; void _o; return rest; });
    return { currentUser: currentUser ?? empty.currentUser, groups: strip(groups), expenses: strip(expenses), settlements: strip(settlements) };
  }) as Promise<Ledger>;
}

async function groupByName(page: Page, name: string): Promise<Group> {
  let found: Group | undefined;
  await expect
    .poll(async () => {
      found = (await readLedger(page)).groups?.find((g) => g.name === name);
      return Boolean(found);
    }, { message: `group "${name}" in local state` })
    .toBe(true);
  return found!;
}

async function expenseByTitle(page: Page, title: string): Promise<Expense> {
  let found: Expense | undefined;
  await expect
    .poll(async () => {
      found = (await readLedger(page)).expenses?.find((e) => e.title === title);
      return Boolean(found);
    }, { message: `expense "${title}" in local state` })
    .toBe(true);
  return found!;
}

const idOf = (group: Group, name: string) => {
  const m = group.members.find((x) => x.displayName === name);
  if (!m) throw new Error(`member ${name} not in ${group.name}`);
  return m.id;
};

/** Independent recomputation: paid - owed + settlements sent - settlements received. */
function ledgerNets(ledger: Ledger, groupId: string): Map<string, number> {
  const nets = new Map<string, number>();
  const add = (id: string, v: number) => nets.set(id, (nets.get(id) ?? 0) + v);
  for (const m of ledger.groups.find((g) => g.id === groupId)?.members ?? []) nets.set(m.id, 0);
  for (const e of ledger.expenses.filter((x) => x.groupId === groupId && !x.deletedAt)) {
    for (const p of e.payers) add(p.memberId, p.paidMinor);
    for (const s of e.splits.filter((x) => x.included)) add(s.memberId, -s.owedMinor);
  }
  for (const s of ledger.settlements.filter((x) => x.groupId === groupId && !x.deletedAt)) {
    add(s.fromMemberId, s.amountMinor);
    add(s.toMemberId, -s.amountMinor);
  }
  return nets;
}

function expectExpenseConserves(e: Expense) {
  const paid = sum(e.payers.map((p) => p.paidMinor));
  const owed = sum(e.splits.filter((s) => s.included).map((s) => s.owedMinor));
  expect(Number.isSafeInteger(e.amountMinor), `${e.title} amount is a safe integer`).toBe(true);
  expect(paid, `${e.title}: sum(payers) === amountMinor`).toBe(e.amountMinor);
  expect(owed, `${e.title}: sum(included splits) === amountMinor`).toBe(e.amountMinor);
  for (const s of e.splits) expect(s.owedMinor, `${e.title}: no negative share`).toBeGreaterThanOrEqual(0);
}

async function gotoTab(page: Page, tab: string) {
  await page.getByTestId(`nav-tab-${tab}`).first().click();
}

async function createGroup(page: Page, name: string, currency = 'INR'): Promise<Group> {
  await gotoTab(page, 'groups');
  await page.getByTestId('create-group-btn').click();
  await page.getByTestId('group-name-input').fill(name);
  await page.getByTestId('group-currency-select').selectOption(currency);
  await page.getByTestId('save-group-btn').click();
  await expect(page.getByRole('heading', { name, exact: true }).first()).toBeVisible();
  return groupByName(page, name);
}

async function addMember(page: Page, name: string, email?: string) {
  await page.getByTestId('add-member-btn').click();
  await page.getByTestId('member-name-input').fill(name);
  if (email) await page.getByTestId('member-email-input').fill(email);
  await page.getByTestId('save-member-btn').click();
}

async function setupGroup(page: Page, name: string, currency: string, others: string[]): Promise<Group> {
  await page.goto('/');
  await createGroup(page, name, currency);
  for (const o of others) {
    await addMember(page, o);
    await expect(page.getByText(o, { exact: true }).first()).toBeVisible();
  }
  let group = await groupByName(page, name);
  await expect.poll(async () => (group = await groupByName(page, name)).members.length).toBe(others.length + 1);
  return group;
}

async function openAllDetails(page: Page) {
  await page.locator('details').evaluateAll((ds) => ds.forEach((d) => ((d as HTMLDetailsElement).open = true)));
}

async function openGroup(page: Page, groupId: string) {
  await gotoTab(page, 'groups');
  const sel = page.getByTestId(`group-select-${groupId}`);
  if (await sel.count()) await sel.click();
  await expect(page.getByTestId('add-expense-btn')).toBeVisible();
}

const payerBox = (page: Page) =>
  page.getByTestId('multi-payer-toggle').locator('xpath=ancestor::div[contains(@class,"rounded-2xl")][1]');

async function pickPayer(page: Page, name: string) {
  await payerBox(page).getByRole('button', { name: new RegExp(`${escapeRe(name)}$`) }).click();
}

interface ExpenseSpec {
  title: string;
  amount: string;
  payer?: string;
  currency?: string;
  fxRate?: string;
  mode?: 'equal' | 'exact' | 'percentage' | 'shares' | 'adjustment';
  inputs?: Record<string, string>;
  exclude?: string[];
}

async function fillExpense(page: Page, group: Group, spec: ExpenseSpec) {
  await page.getByTestId('expense-title-input').fill(spec.title);
  if (spec.currency) await page.getByTestId('expense-currency-select').selectOption(spec.currency);
  await page.getByTestId('expense-amount-input').fill(spec.amount);
  if (spec.fxRate) await page.getByTestId('expense-fx-rate-input').fill(spec.fxRate);
  if (spec.payer) await pickPayer(page, spec.payer);
  if (spec.mode) await page.getByTestId(`split-mode-${spec.mode}`).click();
  for (const name of spec.exclude ?? []) await page.getByTestId(`split-include-${idOf(group, name)}`).uncheck();
  for (const [name, v] of Object.entries(spec.inputs ?? {})) {
    await page.getByTestId(`split-input-${idOf(group, name)}`).fill(v);
  }
}

async function saveExpense(page: Page) {
  await expect(page.getByTestId('save-expense-btn')).toBeEnabled();
  await page.getByTestId('save-expense-btn').click();
  await expect(page.getByTestId('expense-title-input')).toBeHidden();
}

async function addExpense(page: Page, group: Group, spec: ExpenseSpec): Promise<Expense> {
  await page.getByTestId('add-expense-btn').click();
  await fillExpense(page, group, spec);
  await saveExpense(page);
  return expenseByTitle(page, spec.title);
}

async function closeExpenseModal(page: Page) {
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByTestId('expense-title-input')).toBeHidden();
}

async function openEditExpense(page: Page, title: string) {
  const card = page
    .locator('div')
    .filter({ has: page.getByRole('heading', { name: title, exact: true }) })
    .filter({ has: page.getByRole('button', { name: 'Edit', exact: true }) })
    .last();
  await card.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(page.getByTestId('expense-title-input')).toHaveValue(title);
}

/** Member nets as rendered on the group workspace, keyed by display name. */
async function uiNets(page: Page): Promise<Record<string, number>> {
  await expect(page.getByTestId('explain-balance-btn').first()).toBeVisible();
  const rows = await page.getByTestId('explain-balance-btn').evaluateAll((btns) =>
    btns.map((b) => {
      const row = b.closest('.rounded-2xl')!;
      return {
        name: row.querySelector('span.text-sm.font-bold')?.textContent?.trim() ?? '',
        amount: row.querySelector('.font-extrabold')?.textContent ?? '',
      };
    })
  );
  return Object.fromEntries(rows.map((r) => [r.name, parseMinor(r.amount)]));
}

async function uiTransfers(page: Page): Promise<Array<{ from: string; to: string; amount: number }>> {
  return page.getByTestId('quick-settle-btn').evaluateAll((btns) =>
    btns.map((b) => {
      const head = b.closest('.rounded-2xl')!.firstElementChild!;
      const spans = [...head.querySelectorAll('span')].map((s) => s.textContent?.trim() ?? '');
      const amountText = head.lastElementChild?.textContent ?? '';
      const digits = Number(amountText.replace(/[^0-9]/g, '') || '0');
      return { from: spans[0] ?? '', to: spans[1] ?? '', amount: /-/.test(amountText) ? -digits : digits };
    })
  );
}

/** Ledger nets sum to zero and the UI shows exactly the independently recomputed nets. */
async function expectBalanced(page: Page, groupName: string): Promise<Record<string, number>> {
  const ledger = await readLedger(page);
  const group = ledger.groups.find((g) => g.name === groupName)!;
  for (const e of ledger.expenses.filter((x) => x.groupId === group.id && !x.deletedAt)) expectExpenseConserves(e);
  const nets = ledgerNets(ledger, group.id);
  expect(sum([...nets.values()]), 'group sum(net) === 0').toBe(0);
  const byName = Object.fromEntries(group.members.map((m) => [m.displayName, nets.get(m.id) ?? 0]));
  await openGroup(page, group.id);
  await expect.poll(() => uiNets(page)).toEqual(byName);
  return byName;
}

async function settleInStudio(page: Page, groupId: string, fromId: string, toId: string, major: string) {
  await gotoTab(page, 'friends');
  await page.getByTestId('settle-group-select').selectOption(groupId);
  await page.getByTestId('settle-from-member-select').selectOption(fromId);
  await page.getByTestId('settle-to-member-select').selectOption(toId);
  await page.getByTestId('settle-amount-input').fill(major);
  await page.getByTestId('record-settlement-submit-btn').click();
}

async function addDirectBill(page: Page, title: string, amount: string, friend: string) {
  await gotoTab(page, 'home');
  await page.getByTestId('home-quick-add-expense-btn').first().click();
  await expect(page.getByTestId('expense-group-scope-select')).toHaveValue('');
  await page.getByTestId('adhoc-friend-name-input').fill(friend);
  await page.getByTestId('add-adhoc-friend-btn').click();
  await page.getByTestId('expense-title-input').fill(title);
  await page.getByTestId('expense-amount-input').fill(amount);
  await saveExpense(page);
  return expenseByTitle(page, title);
}

/** What a direct-bill participant other than me owes on that bill (I paid). */
function friendShare(e: Expense, friendName: string): number {
  const p = e.adHocParticipants?.find((x) => x.displayName.trim().toLowerCase() === friendName.toLowerCase());
  return e.splits.find((s) => s.memberId === p?.id && s.included)?.owedMinor ?? 0;
}

async function readIndexedDbText(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const dbs = (await indexedDB.databases?.()) ?? [];
    const out: string[] = [];
    for (const info of dbs) {
      if (!info.name) continue;
      const db = await new Promise<IDBDatabase>((res, rej) => {
        const r = indexedDB.open(info.name!);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      for (const store of [...db.objectStoreNames]) {
        const rows = await new Promise<unknown[]>((res) => {
          const req = db.transaction(store, 'readonly').objectStore(store).getAll();
          req.onsuccess = () => res(req.result as unknown[]);
          req.onerror = () => res([]);
        });
        out.push(JSON.stringify(rows));
      }
      db.close();
    }
    return out.join('\n');
  });
}

// Deterministic daily FX rates (Frankfurter, EUR base) for every page this file opens.
const FX_RATES = [
  { date: '2026-11-13', base: 'EUR', quote: 'INR', rate: 104.15 },
  { date: '2026-11-13', base: 'EUR', quote: 'USD', rate: 1.1072 },
  { date: '2026-11-13', base: 'EUR', quote: 'KWD', rate: 0.34304 },
  { date: '2026-11-13', base: 'EUR', quote: 'JPY', rate: 177.06 },
];
test.beforeEach(async ({ context }) => {
  await context.route('https://api.frankfurter.dev/**', (route) =>
    route.fulfill({ json: FX_RATES, headers: { 'access-control-allow-origin': '*' } })
  );
});

// ---------------------------------------------------------------------------------------------
test.describe('Money: 0/2/3-decimal currencies and rotating remainders', () => {
  test('JPY: 1 yen split 3 ways gives the single yen to one member and rotates it across bills', async ({ page }) => {
    const name = uniq('Yen Lab');
    const group = await setupGroup(page, name, 'JPY', ['Bina Rao', 'Chirag Shah']);
    const winners: string[] = [];
    for (let i = 1; i <= 3; i += 1) {
      const e = await addExpense(page, group, { title: `Yen candy ${i}`, amount: '1' });
      expectExpenseConserves(e);
      const owed = e.splits.filter((s) => s.included).map((s) => s.owedMinor).sort();
      expect(owed).toEqual([0, 0, 1]);
      winners.push(e.splits.find((s) => s.owedMinor === 1)!.memberId);
    }
    expect(new Set(winners).size, 'each member gets the odd yen exactly once over 3 bills').toBe(3);
    const nets = await expectBalanced(page, name);
    expect(nets).toEqual({ [ME]: 2, 'Bina Rao': -1, 'Chirag Shah': -1 });
  });

  test('INR: 100.00 split 3 ways is 33.34 / 33.33 / 33.33 and the extra paisa rotates fairly', async ({ page }) => {
    const name = uniq('Paisa Lab');
    const group = await setupGroup(page, name, 'INR', ['Bina Rao', 'Chirag Shah']);
    const winners: string[] = [];
    for (let i = 1; i <= 3; i += 1) {
      const e = await addExpense(page, group, { title: `Paisa dinner ${i}`, amount: '100' });
      expectExpenseConserves(e);
      expect(e.splits.map((s) => s.owedMinor).sort()).toEqual([3333, 3333, 3334]);
      winners.push(e.splits.find((s) => s.remainderMinor === 1)!.memberId);
    }
    expect(new Set(winners).size).toBe(3);
    const nets = await expectBalanced(page, name);
    expect(nets).toEqual({ [ME]: 20000, 'Bina Rao': -10000, 'Chirag Shah': -10000 });
  });

  test('KWD: 1.000 KD split 3 ways is 0.334 / 0.333 / 0.333 and renders three decimals', async ({ page }) => {
    const name = uniq('Fils Lab');
    const group = await setupGroup(page, name, 'KWD', ['Bina Rao', 'Chirag Shah']);
    const e = await addExpense(page, group, { title: 'Fils tea', amount: '1' });
    expectExpenseConserves(e);
    expect(e.amountMinor).toBe(1000);
    expect(e.splits.map((s) => s.owedMinor).sort()).toEqual([333, 333, 334]);
    await expect(page.getByText('KD1.000').first()).toBeVisible();
    await expectBalanced(page, name);
  });
});

test.describe('Money: amount boundaries', () => {
  test('zero, negative and empty amounts cannot be saved', async ({ page }) => {
    const group = await setupGroup(page, uniq('Bounds Lab'), 'INR', ['Bina Rao']);
    await page.getByTestId('add-expense-btn').click();
    await page.getByTestId('expense-title-input').fill('Bad amount');
    for (const amount of ['', '0', '0.00', '-50', '-0.01']) {
      await page.getByTestId('expense-amount-input').fill(amount);
      await expect(page.getByTestId('save-expense-btn'), `amount "${amount}"`).toBeDisabled();
    }
    await closeExpenseModal(page);
    expect((await readLedger(page)).expenses.some((e) => e.title === 'Bad amount')).toBe(false);
    void group;
  });

  for (const c of [
    { currency: 'INR', amount: '10.005' },
    { currency: 'JPY', amount: '100.5' },
    { currency: 'KWD', amount: '1.0005' },
  ]) {
    test(`too many decimals for ${c.currency} (${c.amount}) is never silently rounded into the ledger`, async ({ page }) => {
      const group = await setupGroup(page, uniq(`Decimals ${c.currency}`), c.currency, ['Bina Rao']);
      const title = `Precise ${c.currency}`;
      await page.getByTestId('add-expense-btn').click();
      await fillExpense(page, group, { title, amount: c.amount });
      const save = page.getByTestId('save-expense-btn');
      if (await save.isDisabled()) return; // rejected: acceptable
      // Accepted: the total the user is shown before saving must be exactly what gets stored.
      const bar = (await page.getByTestId('split-reconciliation-bar').textContent()) ?? '';
      const shownTotal = /Total:\s*([^\d\s]*[\d,]+(?:\.\d+)?)/.exec(bar)?.[1] ?? '';
      expect(shownTotal, `reconciliation bar discloses the normalised total: "${bar}"`).not.toBe('');
      await save.click();
      const e = await expenseByTitle(page, title);
      expectExpenseConserves(e);
      expect(parseMinor(shownTotal), `shown total ${shownTotal} vs stored ${e.amountMinor}`).toBe(e.amountMinor);
    });
  }

  test('2^53-1 minor units (INR 90,071,992,547,409.91) is stored exactly and a 3-way split conserves every paisa', async ({ page }) => {
    const name = uniq('Max Safe');
    const group = await setupGroup(page, name, 'INR', ['Bina Rao', 'Chirag Shah']);
    const e = await addExpense(page, group, { title: 'Max safe integer bill', amount: '90071992547409.91' });
    expect(e.amountMinor).toBe(Number.MAX_SAFE_INTEGER);
    expectExpenseConserves(e);
    expect(e.splits.map((s) => s.owedMinor).sort((a, b) => a - b)).toEqual([
      3002399751580330, 3002399751580330, 3002399751580331,
    ]);
    await expectBalanced(page, name);
  });

  test('amounts above 2^53-1 minor units are rejected rather than rounded', async ({ page }) => {
    const group = await setupGroup(page, uniq('Over Max'), 'INR', ['Bina Rao']);
    await page.getByTestId('add-expense-btn').click();
    await fillExpense(page, group, { title: 'Too large bill', amount: '90071992547409.93' });
    await expect(page.getByTestId('save-expense-btn'), '2^53+1 minor units').toBeDisabled();
    await page.getByTestId('expense-amount-input').fill('1000000000000000000');
    await expect(page.getByTestId('save-expense-btn'), '1e18 major units').toBeDisabled();
    await closeExpenseModal(page);
  });
});

test.describe('Money: split mode validation', () => {
  test('percentage split must total exactly 100%', async ({ page }) => {
    const name = uniq('Pct Lab');
    const group = await setupGroup(page, name, 'INR', ['Bina Rao', 'Chirag Shah']);
    await page.getByTestId('add-expense-btn').click();
    await fillExpense(page, group, { title: 'Pct bill', amount: '100', mode: 'percentage', inputs: { [ME]: '50', 'Bina Rao': '30', 'Chirag Shah': '10' } });
    await expect(page.getByTestId('save-expense-btn'), '90%').toBeDisabled();
    await expect(page.getByTestId('split-reconciliation-bar')).not.toContainText('100% Reconciled');
    await page.getByTestId(`split-input-${idOf(group, 'Chirag Shah')}`).fill('30');
    await expect(page.getByTestId('save-expense-btn'), '110%').toBeDisabled();
    await page.getByTestId(`split-input-${idOf(group, 'Chirag Shah')}`).fill('20');
    await saveExpense(page);
    const e = await expenseByTitle(page, 'Pct bill');
    expectExpenseConserves(e);
    expect(Object.fromEntries(e.splits.map((s) => [s.memberId, s.owedMinor]))).toEqual({
      [idOf(group, ME)]: 5000, [idOf(group, 'Bina Rao')]: 3000, [idOf(group, 'Chirag Shah')]: 2000,
    });
    // 33.33 + 33.33 + 33.34 on an odd total still conserves every paisa
    await addExpense(page, group, { title: 'Pct thirds', amount: '100.01', mode: 'percentage', inputs: { [ME]: '33.33', 'Bina Rao': '33.33', 'Chirag Shah': '33.34' } });
    await expectBalanced(page, name);
  });

  test('exact split must equal the bill total', async ({ page }) => {
    const name = uniq('Exact Lab');
    const group = await setupGroup(page, name, 'INR', ['Bina Rao']);
    await page.getByTestId('add-expense-btn').click();
    await fillExpense(page, group, { title: 'Exact bill', amount: '100', mode: 'exact', inputs: { [ME]: '40', 'Bina Rao': '50' } });
    await expect(page.getByTestId('save-expense-btn')).toBeDisabled();
    await expect(page.getByTestId('split-reconciliation-bar')).toContainText('₹10.00 left to assign');
    await page.getByTestId(`split-input-${idOf(group, 'Bina Rao')}`).fill('70');
    await expect(page.getByTestId('save-expense-btn')).toBeDisabled();
    await expect(page.getByTestId('split-reconciliation-bar')).toContainText('₹10.00 over-assigned');
    await page.getByTestId(`split-input-${idOf(group, 'Bina Rao')}`).fill('60');
    await saveExpense(page);
    const e = await expenseByTitle(page, 'Exact bill');
    expectExpenseConserves(e);
    expect(e.splits.find((s) => s.memberId === idOf(group, 'Bina Rao'))!.owedMinor).toBe(6000);
    await expectBalanced(page, name);
  });

  test('shares with a zero weight owe nothing; all-zero shares are rejected', async ({ page }) => {
    const name = uniq('Shares Lab');
    const group = await setupGroup(page, name, 'INR', ['Bina Rao', 'Chirag Shah']);
    await page.getByTestId('add-expense-btn').click();
    await fillExpense(page, group, { title: 'Zero shares', amount: '90', mode: 'shares', inputs: { [ME]: '0', 'Bina Rao': '0', 'Chirag Shah': '0' } });
    await expect(page.getByTestId('save-expense-btn'), 'all-zero shares').toBeDisabled();
    await page.getByTestId(`split-input-${idOf(group, ME)}`).fill('2');
    await page.getByTestId(`split-input-${idOf(group, 'Chirag Shah')}`).fill('1');
    await saveExpense(page);
    const e = await expenseByTitle(page, 'Zero shares');
    expectExpenseConserves(e);
    const owed = Object.fromEntries(e.splits.map((s) => [s.memberId, s.owedMinor]));
    expect(owed[idOf(group, ME)]).toBe(6000);
    expect(owed[idOf(group, 'Bina Rao')]).toBe(0);
    expect(owed[idOf(group, 'Chirag Shah')]).toBe(3000);
    await expectBalanced(page, name);
  });

  test('adjustments: a valid +/- split saves, and one that drives a share below zero is rejected', async ({ page }) => {
    const name = uniq('Adjust Lab');
    const group = await setupGroup(page, name, 'INR', ['Bina Rao']);
    await page.getByTestId('add-expense-btn').click();
    await fillExpense(page, group, { title: 'Negative adjust', amount: '100', mode: 'adjustment', inputs: { [ME]: '0', 'Bina Rao': '-120' } });
    await expect(page.getByTestId('save-expense-btn'), 'Bina would owe -10.00').toBeDisabled();
    await page.getByTestId(`split-input-${idOf(group, 'Bina Rao')}`).fill('10');
    await page.getByTestId('expense-title-input').fill('Plus ten adjust');
    await saveExpense(page);
    const e = await expenseByTitle(page, 'Plus ten adjust');
    expectExpenseConserves(e);
    expect(e.splits.find((s) => s.memberId === idOf(group, 'Bina Rao'))!.owedMinor).toBe(5500);
    expect(e.splits.find((s) => s.memberId === idOf(group, ME))!.owedMinor).toBe(4500);
    await expectBalanced(page, name);
  });

  test('a payer who is not in the split is owed the whole bill', async ({ page }) => {
    const name = uniq('Outside Payer');
    const group = await setupGroup(page, name, 'INR', ['Bina Rao', 'Chirag Shah']);
    const e = await addExpense(page, group, { title: 'Gift for others', amount: '90', payer: ME, exclude: [ME] });
    expectExpenseConserves(e);
    expect(e.splits.find((s) => s.memberId === idOf(group, ME))?.included ?? false).toBe(false);
    const nets = await expectBalanced(page, name);
    expect(nets).toEqual({ [ME]: 9000, 'Bina Rao': -4500, 'Chirag Shah': -4500 });
  });

  test('multiple payers must cover the bill exactly (under- and over-payment blocked)', async ({ page }) => {
    const name = uniq('Multi Payer');
    const group = await setupGroup(page, name, 'INR', ['Bina Rao', 'Chirag Shah']);
    await page.getByTestId('add-expense-btn').click();
    await fillExpense(page, group, { title: 'Shared booking', amount: '100' });
    await page.getByTestId('multi-payer-toggle').click();
    const pay = (n: string) => page.getByTestId(`payer-input-${idOf(group, n)}`);
    await pay(ME).fill('60');
    await pay('Bina Rao').fill('30');
    await pay('Chirag Shah').fill('0');
    await expect(page.getByTestId('save-expense-btn'), 'payers 90 of 100').toBeDisabled();
    await pay('Bina Rao').fill('50');
    await expect(page.getByTestId('save-expense-btn'), 'payers 110 of 100').toBeDisabled();
    await pay('Bina Rao').fill('40');
    await saveExpense(page);
    const e = await expenseByTitle(page, 'Shared booking');
    expectExpenseConserves(e);
    expect(Object.fromEntries(e.payers.filter((p) => p.paidMinor > 0).map((p) => [p.memberId, p.paidMinor]))).toEqual({
      [idOf(group, ME)]: 6000, [idOf(group, 'Bina Rao')]: 4000,
    });
    await expectBalanced(page, name);
  });

  test('excluding everyone but one member puts the whole bill on them; excluding everyone is blocked', async ({ page }) => {
    const name = uniq('Solo Split');
    const group = await setupGroup(page, name, 'INR', ['Bina Rao', 'Chirag Shah']);
    const e = await addExpense(page, group, { title: 'Bina only', amount: '100', payer: ME, exclude: [ME, 'Chirag Shah'] });
    expectExpenseConserves(e);
    expect(e.splits.filter((s) => s.included).map((s) => s.memberId)).toEqual([idOf(group, 'Bina Rao')]);
    const nets = await expectBalanced(page, name);
    expect(nets).toEqual({ [ME]: 10000, 'Bina Rao': -10000, 'Chirag Shah': 0 });

    await page.getByTestId('add-expense-btn').click();
    await fillExpense(page, group, { title: 'Nobody', amount: '100', exclude: [ME, 'Bina Rao', 'Chirag Shah'] });
    await expect(page.getByTestId('save-expense-btn')).toBeDisabled();
    await closeExpenseModal(page);
  });
});

// ---------------------------------------------------------------------------------------------
test.describe('Balances', () => {
  test('mixed operations keep sum(net) at zero and the UI equal to an independent recomputation', async ({ page }) => {
    const name = uniq('Mixed Ops');
    const group = await setupGroup(page, name, 'INR', ['Bina Rao', 'Chirag Shah', 'Dev Iyer']);
    await addExpense(page, group, { title: 'Villa', amount: '1000.03', payer: ME });
    await expectBalanced(page, name);
    await addExpense(page, group, { title: 'Cab', amount: '77.77', payer: 'Bina Rao', mode: 'exact', inputs: { [ME]: '50', 'Bina Rao': '27.77', 'Chirag Shah': '0', 'Dev Iyer': '0' } });
    await addExpense(page, group, { title: 'Snacks', amount: '33.33', payer: 'Chirag Shah', mode: 'percentage', inputs: { [ME]: '25', 'Bina Rao': '25', 'Chirag Shah': '25', 'Dev Iyer': '25' } });
    await addExpense(page, group, { title: 'Fuel', amount: '501', payer: 'Dev Iyer', mode: 'shares', inputs: { [ME]: '1', 'Bina Rao': '2', 'Chirag Shah': '3', 'Dev Iyer': '0' } });
    await expectBalanced(page, name);
    await settleInStudio(page, group.id, idOf(group, 'Chirag Shah'), idOf(group, ME), '123.45');
    await expect.poll(async () => (await readLedger(page)).settlements.filter((s) => s.groupId === group.id).length).toBe(1);
    await expectBalanced(page, name);
    await openEditExpense(page, 'Villa');
    await page.getByTestId('expense-amount-input').fill('999.99');
    await saveExpense(page);
    await expect.poll(async () => (await expenseByTitle(page, 'Villa')).amountMinor).toBe(99999);
    await expectBalanced(page, name);
  });

  test('simplify debts on vs off: identical per-person nets, and the suggested transfers settle them exactly', async ({ page }) => {
    const name = uniq('Simplify');
    const group = await setupGroup(page, name, 'INR', ['Bina Rao', 'Chirag Shah', 'Dev Iyer']);
    // A chain: A pays for A+B, B pays for B+C, C pays for C+D (simplification can shorten it)
    await addExpense(page, group, { title: 'Chain 1', amount: '100', payer: ME, exclude: ['Chirag Shah', 'Dev Iyer'] });
    await addExpense(page, group, { title: 'Chain 2', amount: '100', payer: 'Bina Rao', exclude: [ME, 'Dev Iyer'] });
    await addExpense(page, group, { title: 'Chain 3', amount: '100.01', payer: 'Chirag Shah', exclude: [ME, 'Bina Rao'] });
    const nets = await expectBalanced(page, name);
    const toggle = page.getByTestId('toggle-simplify-debts-btn');
    const counts: number[] = [];
    for (const label of ['ON', 'OFF']) {
      if (!(await toggle.textContent())?.includes(label)) await toggle.click();
      await expect(toggle).toContainText(`Simplify Debts: ${label}`);
      expect(await uiNets(page), `nets with simplify ${label}`).toEqual(nets);
      const transfers = await uiTransfers(page);
      counts.push(transfers.length);
      const residual: Record<string, number> = { ...nets };
      for (const t of transfers) {
        expect(t.amount, `${t.from} -> ${t.to}`).toBeGreaterThan(0);
        residual[t.from] = (residual[t.from] ?? 0) + t.amount;
        residual[t.to] = (residual[t.to] ?? 0) - t.amount;
      }
      expect(residual, `transfers with simplify ${label} zero every balance`).toEqual(
        Object.fromEntries(Object.keys(nets).map((k) => [k, 0]))
      );
    }
    expect(counts[0], 'simplified never needs more payments than pairwise').toBeLessThanOrEqual(counts[1]!);
  });

  test('settling every suggested transfer clears all balances to exactly zero', async ({ page }) => {
    const name = uniq('Settle All');
    const group = await setupGroup(page, name, 'INR', ['Bina Rao', 'Chirag Shah']);
    await addExpense(page, group, { title: 'Odd 1', amount: '100', payer: ME });
    await addExpense(page, group, { title: 'Odd 2', amount: '55.55', payer: 'Bina Rao' });
    await addExpense(page, group, { title: 'Odd 3', amount: '0.01', payer: 'Chirag Shah' });
    await expectBalanced(page, name);
    for (let i = 0; i < 6 && (await page.getByTestId('quick-settle-btn').count()) > 0; i += 1) {
      await page.getByTestId('quick-settle-btn').first().click();
      await page.waitForTimeout(200);
    }
    await expect(page.getByText(`Everyone in ${name} is settled up!`)).toBeVisible();
    const nets = await expectBalanced(page, name);
    expect(Object.values(nets).every((v) => v === 0)).toBe(true);
  });

  test('a partial settlement reduces the debt by exactly the amount paid', async ({ page }) => {
    const name = uniq('Partial');
    const group = await setupGroup(page, name, 'INR', ['Bina Rao']);
    await addExpense(page, group, { title: 'Dinner', amount: '100', payer: ME });
    await settleInStudio(page, group.id, idOf(group, 'Bina Rao'), idOf(group, ME), '12.34');
    await expect.poll(async () => (await readLedger(page)).settlements.filter((s) => s.groupId === group.id).map((s) => s.amountMinor)).toEqual([1234]);
    expect(await expectBalanced(page, name)).toEqual({ [ME]: 3766, 'Bina Rao': -3766 });
  });

  test('settling more than owed is refused or flips the balance by the exact excess (never lost)', async ({ page }) => {
    const name = uniq('Overpay');
    const group = await setupGroup(page, name, 'INR', ['Bina Rao']);
    await addExpense(page, group, { title: 'Dinner', amount: '100', payer: ME });
    await settleInStudio(page, group.id, idOf(group, 'Bina Rao'), idOf(group, ME), '80');
    await page.waitForTimeout(500);
    const amounts = (await readLedger(page)).settlements.filter((s) => s.groupId === group.id && !s.deletedAt).map((s) => s.amountMinor);
    if (amounts.length === 0) return; // refused: acceptable
    expect(amounts, 'recorded settlement keeps the amount the user typed').toEqual([8000]);
    expect(await expectBalanced(page, name)).toEqual({ [ME]: -3000, 'Bina Rao': 3000 });
  });

  test('a settlement followed by an expense edit keeps the settlement and re-derives the balance', async ({ page }) => {
    const name = uniq('Settle Then Edit');
    const group = await setupGroup(page, name, 'INR', ['Bina Rao']);
    await addExpense(page, group, { title: 'Hotel', amount: '100', payer: ME });
    await settleInStudio(page, group.id, idOf(group, 'Bina Rao'), idOf(group, ME), '50');
    await expect.poll(async () => (await readLedger(page)).settlements.filter((s) => s.groupId === group.id).length).toBe(1);
    expect(await expectBalanced(page, name)).toEqual({ [ME]: 0, 'Bina Rao': 0 });
    await openEditExpense(page, 'Hotel');
    await page.getByTestId('expense-amount-input').fill('200');
    await saveExpense(page);
    await expect.poll(async () => (await expenseByTitle(page, 'Hotel')).amountMinor).toBe(20000);
    expect(await expectBalanced(page, name)).toEqual({ [ME]: 5000, 'Bina Rao': -5000 });
  });

  test('deleting and restoring an expense recomputes balances exactly', async ({ page }) => {
    const name = uniq('Trash Lab');
    const group = await setupGroup(page, name, 'INR', ['Bina Rao', 'Chirag Shah']);
    await addExpense(page, group, { title: 'Keeper', amount: '60', payer: ME });
    const before = await expectBalanced(page, name);
    const temp = await addExpense(page, group, { title: 'Temporary', amount: '100', payer: 'Bina Rao' });
    const withTemp = await expectBalanced(page, name);
    await page.getByTestId(`delete-expense-${temp.id}`).click();
    await expect.poll(async () => Boolean((await expenseByTitle(page, 'Temporary')).deletedAt)).toBe(true);
    expect(await expectBalanced(page, name)).toEqual(before);
    const trashRow = page.locator('div').filter({ hasText: 'Temporary' }).filter({ has: page.getByRole('button', { name: 'Restore', exact: true }) }).last();
    await trashRow.getByRole('button', { name: 'Restore', exact: true }).click();
    await expect.poll(async () => (await expenseByTitle(page, 'Temporary')).deletedAt).toBeNull();
    expect(await expectBalanced(page, name)).toEqual(withTemp);
  });

  test('deleting a direct settlement re-opens the debt, and the settlement can be restored', async ({ page }) => {
    await page.goto('/');
    const friend = uniq('Tara Singh');
    const bill = await addDirectBill(page, 'Tara lunch', '300', friend);
    const owed = friendShare(bill, friend);
    expect(owed).toBe(15000);
    await gotoTab(page, 'friends');
    await page.getByTestId(`settle-all-groups-${friend.toLowerCase()}`).click();
    await expect.poll(async () => (await readLedger(page)).settlements.filter((s) => s.expenseId === bill.id && !s.deletedAt).map((s) => s.amountMinor)).toEqual([owed]);
    await gotoTab(page, 'home');
    const st = (await readLedger(page)).settlements.find((s) => s.expenseId === bill.id)!;
    await page.getByTestId(`delete-settlement-${st.id}`).click();
    await expect.poll(async () => Boolean((await readLedger(page)).settlements.find((s) => s.id === st.id)?.deletedAt)).toBe(true);
    await gotoTab(page, 'friends');
    await expect(page.getByTestId(`friend-card-${friend.toLowerCase()}`)).toContainText('+₹150.00');
    // Restore: requirements promise one-tap recovery of soft-deleted items.
    await gotoTab(page, 'activity');
    const restore = page.getByRole('button', { name: /restore/i }).filter({ hasText: /settlement|payment/i });
    await expect(restore.first(), 'a restore control for the deleted settlement').toBeVisible({ timeout: 5000 });
    await restore.first().click();
    await expect.poll(async () => (await readLedger(page)).settlements.find((s) => s.id === st.id)?.deletedAt ?? null).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
test.describe('Currency', () => {
  async function seedForCurrency(page: Page, name: string) {
    const group = await setupGroup(page, name, 'INR', ['Bina Rao', 'Chirag Shah']);
    await addExpense(page, group, { title: 'Odd thirds', amount: '100.01', payer: ME });
    await addExpense(page, group, { title: 'Half paisa', amount: '50.55', payer: 'Bina Rao' });
    await settleInStudio(page, group.id, idOf(group, 'Chirag Shah'), idOf(group, ME), '10.01');
    await expect.poll(async () => (await readLedger(page)).settlements.filter((s) => s.groupId === group.id).length).toBe(1);
    await expectBalanced(page, name);
    return group;
  }

  async function changeCurrency(page: Page, target: string, mode: RegExp) {
    await page.getByTestId('change-group-currency-btn').click();
    await page.getByTestId('change-currency-target-select').selectOption(target);
    await page.getByRole('button', { name: mode }).click();
    await page.getByTestId('confirm-currency-change-btn').click();
  }

  test('relabel INR -> USD (same decimals) keeps every minor unit unchanged', async ({ page }) => {
    const name = uniq('Relabel USD');
    const group = await seedForCurrency(page, name);
    const before = await readLedger(page);
    await changeCurrency(page, 'USD', /Mode A: Re-label/);
    await expect.poll(async () => (await groupByName(page, name)).baseCurrency).toBe('USD');
    const after = await readLedger(page);
    for (const e of after.expenses.filter((x) => x.groupId === group.id)) {
      const old = before.expenses.find((x) => x.id === e.id)!;
      expect(e.groupCurrency).toBe('USD');
      expect(e.amountMinor).toBe(old.amountMinor);
      expect(e.splits.map((s) => s.owedMinor)).toEqual(old.splits.map((s) => s.owedMinor));
    }
    expect(after.settlements.find((s) => s.groupId === group.id)!.amountMinor).toBe(1001);
    await expectBalanced(page, name);
  });

  test('relabel INR -> JPY (2 -> 0 decimals) keeps every bill and the group balanced', async ({ page }) => {
    const name = uniq('Relabel JPY');
    const group = await seedForCurrency(page, name);
    await changeCurrency(page, 'JPY', /Mode A: Re-label/);
    await expect.poll(async () => (await groupByName(page, name)).baseCurrency).toBe('JPY');
    const after = await readLedger(page);
    const odd = after.expenses.find((e) => e.groupId === group.id && e.title === 'Odd thirds')!;
    expect(Math.abs(odd.amountMinor - 100), 'major value preserved (100.01 -> about 100 yen)').toBeLessThanOrEqual(1);
    for (const s of after.settlements.filter((x) => x.groupId === group.id)) expect(s.currency).toBe('JPY');
    await expectBalanced(page, name);
  });

  test('reconvert INR -> KWD via FX keeps every bill and settlement balanced in fils', async ({ page }) => {
    const name = uniq('Reconvert KWD');
    const group = await seedForCurrency(page, name);
    await page.getByTestId('change-group-currency-btn').click();
    await page.getByTestId('change-currency-target-select').selectOption('KWD');
    await page.getByRole('button', { name: /Mode B: Convert existing bills/ }).click();
    await page.getByTestId('currency-change-rate-input').fill('0.0037');
    await page.getByTestId('confirm-currency-change-btn').click();
    await expect.poll(async () => (await groupByName(page, name)).baseCurrency).toBe('KWD');
    const after = await readLedger(page);
    const odd = after.expenses.find((e) => e.groupId === group.id && e.title === 'Odd thirds')!;
    expect(Math.abs(odd.amountMinor - 370)).toBeLessThanOrEqual(1); // 100.01 * 0.0037 = 0.370 KD
    for (const s of after.settlements.filter((x) => x.groupId === group.id)) expect(s.currency).toBe('KWD');
    await expectBalanced(page, name);
  });

  test('mixed-currency bills convert to the base currency and keep the original amount and rate', async ({ page }) => {
    const name = uniq('Mixed FX');
    const group = await setupGroup(page, name, 'INR', ['Bina Rao']);
    const cases = [
      { title: 'Paris lunch', currency: 'EUR', amount: '50', fxRate: '91.2', original: 5000, converted: 456000 },
      { title: 'Tokyo ramen', currency: 'JPY', amount: '1000', fxRate: '0.56', original: 1000, converted: 56000 },
      { title: 'Kuwait juice', currency: 'KWD', amount: '1.234', fxRate: '271.5', original: 1234, converted: 33503 },
    ];
    for (const c of cases) {
      const e = await addExpense(page, group, { title: c.title, amount: c.amount, currency: c.currency, fxRate: c.fxRate });
      expect(e.originalCurrency).toBe(c.currency);
      expect(e.originalAmountMinor).toBe(c.original);
      expect(e.groupCurrency).toBe('INR');
      expect(Math.abs(e.amountMinor - c.converted), `${c.title} converted amount`).toBeLessThanOrEqual(1);
      expect(e.fxAuditNote ?? '').toContain(c.currency);
      expect(e.fxAuditNote ?? '').toContain(c.fxRate);
      expectExpenseConserves(e);
    }
    await expectBalanced(page, name);
  });
});

// ---------------------------------------------------------------------------------------------
test.describe('Direct (non-group) bills', () => {
  test('a bill with a friend who has no account shows the exact amount they owe', async ({ page }) => {
    await page.goto('/');
    const friend = uniq('Tara Singh');
    const bill = await addDirectBill(page, 'Solo direct', '300.01', friend);
    expect(bill.groupId).toBeNull();
    expectExpenseConserves(bill);
    const owed = friendShare(bill, friend);
    expect([15000, 15001]).toContain(owed);
    await expect(page.getByTestId('home-direct-expenses-list')).toContainText('Solo direct');
    await gotoTab(page, 'friends');
    await expect(page.getByTestId(`friend-card-${friend.toLowerCase()}`)).toContainText(`+₹${(owed / 100).toFixed(2)}`);
  });

  test('one friend across bills despite case/whitespace; settle all posts one exact settlement per bill', async ({ page }) => {
    await page.goto('/');
    const friend = uniq('Tara Singh');
    const b1 = await addDirectBill(page, 'Direct one', '300', friend);
    const b2 = await addDirectBill(page, 'Direct two', '101.01', `  ${friend.toUpperCase()}  `);
    const total = friendShare(b1, friend) + friendShare(b2, friend);
    expect(friendShare(b2, friend)).toBeGreaterThan(0);
    await gotoTab(page, 'friends');
    await expect(page.locator('[data-testid^="friend-card-"]').filter({ hasText: new RegExp(escapeRe(friend), 'i') })).toHaveCount(1);
    const card = page.getByTestId(`friend-card-${friend.toLowerCase()}`);
    await expect(card).toContainText(`+₹${(total / 100).toFixed(2)}`);
    await page.getByTestId(`settle-all-groups-${friend.toLowerCase()}`).click();
    await expect.poll(async () => {
      const l = await readLedger(page);
      return [b1, b2].map((b) => l.settlements.filter((s) => s.expenseId === b.id && !s.deletedAt).map((s) => s.amountMinor));
    }).toEqual([[friendShare(b1, friend)], [friendShare(b2, friend)]]);
    await expect(card).toContainText('Settled across all groups');
  });

  test('settling one direct bill clears only that bill', async ({ page }) => {
    await page.goto('/');
    const friend = uniq('Tara Singh');
    const b1 = await addDirectBill(page, 'Bill keep open', '200', friend);
    const b2 = await addDirectBill(page, 'Bill settle now', '80', friend);
    await gotoTab(page, 'friends');
    const card = page.getByTestId(`friend-card-${friend.toLowerCase()}`);
    const row = card.locator('div').filter({ hasText: 'Bill settle now' }).filter({ has: page.getByRole('button', { name: 'Load in Studio' }) }).last();
    await expect(row, 'a per-bill row for "Bill settle now"').toBeVisible({ timeout: 5000 });
    await row.getByRole('button', { name: 'Load in Studio' }).click();
    await expect(page.getByTestId('settle-amount-input'), 'studio loads this bill\'s balance').toHaveValue((friendShare(b2, friend) / 100).toFixed(2));
    const before = (await readLedger(page)).settlements.map((s) => s.id);
    await page.getByTestId('record-settlement-submit-btn').click();
    const created = (await readLedger(page)).settlements.filter((s) => !before.includes(s.id));
    expect(created.every((s) => s.expenseId === b2.id), `settlements created: ${JSON.stringify(created)}`).toBe(true);
    await expect.poll(async () => (await readLedger(page)).settlements.filter((s) => s.expenseId === b2.id && !s.deletedAt).map((s) => s.amountMinor)).toEqual([friendShare(b2, friend)]);
    expect((await readLedger(page)).settlements.some((s) => s.expenseId === b1.id && !s.deletedAt)).toBe(false);
    await expect(card).toContainText(`+₹${(friendShare(b1, friend) / 100).toFixed(2)}`);
  });
});

// ---------------------------------------------------------------------------------------------
test.describe('Group lifecycle', () => {
  test('admin removes members: one with no bills disappears, one with past bills stays in history and balanced', async ({ page }) => {
    const name = uniq('Remove Lab');
    const group = await setupGroup(page, name, 'INR', ['Bina Rao', 'Chirag Shah']);
    await addExpense(page, group, { title: 'Bina past bill', amount: '90', payer: ME, exclude: ['Chirag Shah'] });
    const before = await expectBalanced(page, name);
    const remove = async (n: string) => {
      const id = idOf(group, n);
      await openAllDetails(page);
      await page.getByTestId(`remove-member-${id}`).click();
      await page.getByTestId(`remove-member-confirm-${id}`).click();
      await expect.poll(async () => Boolean((await groupByName(page, name)).members.find((m) => m.id === id)?.removedAt), { message: `${n} marked removed` }).toBe(true);
    };
    await remove('Chirag Shah');
    await expect(page.getByTestId(`remove-member-${idOf(group, 'Chirag Shah')}`)).toHaveCount(0);
    await remove('Bina Rao');
    await expect(page.getByRole('heading', { name: 'Bina past bill', exact: true })).toBeVisible();
    await expect(page.getByText(/Paid by .*Arjun Mehta/).first()).toBeVisible();
    // Removal never rewrites history: the removed debtor still owes exactly what she owed.
    const l = await readLedger(page);
    const nets = ledgerNets(l, group.id);
    expect(sum([...nets.values()])).toBe(0);
    expect(nets.get(idOf(group, 'Bina Rao'))).toBe(before['Bina Rao']);
    expect(nets.get(idOf(group, ME))).toBe(before[ME]);
  });

  test('admin can delete a group and restore it from trash', async ({ page }) => {
    const name = uniq('Delete Lab');
    const group = await setupGroup(page, name, 'INR', ['Bina Rao']);
    await addExpense(page, group, { title: 'Pre-delete bill', amount: '40' });
    const before = await expectBalanced(page, name);
    await openAllDetails(page);
    await page.getByTestId('delete-group-btn').click();
    await page.getByTestId('delete-group-confirm-btn').click();
    await expect.poll(async () => Boolean((await groupByName(page, name)).deletedAt)).toBe(true);
    await gotoTab(page, 'groups');
    await expect(page.getByTestId(`group-select-${group.id}`)).toHaveCount(0);
    await gotoTab(page, 'activity');
    await page.getByTestId(`restore-group-${group.id}`).click();
    await expect.poll(async () => (await groupByName(page, name)).deletedAt).toBeNull();
    expect(await expectBalanced(page, name)).toEqual(before);
  });

  test('a non-admin cannot change currency (control disabled, forced click changes nothing) or delete the group', async ({ page }) => {
    const ledger = JSON.parse(JSON.stringify(mockData)) as typeof mockData;
    const tokyo = ledger.groups.find((g) => g.id === 'grp_tokyo_2026')!;
    for (const m of tokyo.members) if (m.userId === ledger.currentUser.id) m.role = 'member';
    await page.addInitScript(([key, snapshot]) => {
      if (!sessionStorage.getItem('edge_non_admin')) {
        localStorage.setItem(key!, snapshot!);
        sessionStorage.setItem('edge_non_admin', '1');
      }
    }, [LEGACY_STATE_KEY, JSON.stringify(ledger)]);
    await page.goto('/');
    await openGroup(page, 'grp_tokyo_2026');
    const btn = page.getByTestId('change-group-currency-btn');
    await expect(btn).toBeDisabled();
    await btn.click({ force: true });
    await expect(page.getByTestId('confirm-currency-change-btn')).toHaveCount(0);
    expect((await readLedger(page)).groups.find((g) => g.id === 'grp_tokyo_2026')!.baseCurrency).toBe('JPY');
    await openAllDetails(page);
    await expect(page.getByTestId('group-danger-zone')).toBeVisible();
    await expect(page.getByTestId('delete-group-btn'), 'no delete control for a non-admin').toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------------------------
test.describe('Offline-first', () => {
  test('a never-signed-in user works fully locally with zero API/Supabase calls, and reload keeps the data', async ({ page }) => {
    const backend: string[] = [];
    page.on('request', (req) => {
      const u = req.url();
      if (u.includes('/api/') || u.includes(':54321') || u.includes(`:${process.env.API_PORT || 4174}`)) backend.push(u);
    });
    const name = uniq('Offline Lab');
    const group = await setupGroup(page, name, 'KWD', ['Bina Rao']);
    await addExpense(page, group, { title: 'Offline bill', amount: '1.001', payer: 'Bina Rao' });
    await settleInStudio(page, group.id, idOf(group, ME), idOf(group, 'Bina Rao'), '0.200');
    await expect.poll(async () => (await readLedger(page)).settlements.filter((s) => s.groupId === group.id).length).toBe(1);
    await addDirectBill(page, 'Offline direct', '42', uniq('Tara Singh'));
    const before = await expectBalanced(page, name);
    await page.waitForTimeout(2500);
    await page.reload();
    await expect(page.getByTestId('home-dashboard-page')).toBeVisible();
    expect(await expectBalanced(page, name)).toEqual(before);
    await gotoTab(page, 'home');
    await expect(page.getByTestId('home-direct-expenses-list')).toContainText('Offline direct');
    await page.waitForTimeout(2000);
    expect(backend, 'no backend requests without sign-in').toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
test.describe('Input safety', () => {
  test('emoji, RTL and very long titles are stored and shown intact without breaking the layout', async ({ page }) => {
    const name = `👨‍👩‍👧 رحلة ${Math.random().toString(36).slice(2, 6)}`;
    const group = await setupGroup(page, name, 'INR', ['שרה כהן']);
    const longTitle = ('L'.repeat(40) + ' long '.repeat(50)).slice(0, LIMITS.expenseTitle);
    expect(longTitle.length).toBe(LIMITS.expenseTitle);
    const titles = ['🍕🍺 Pizza 🇮🇳 night', 'عشاء في المطعم', longTitle];
    for (const t of titles) {
      const e = await addExpense(page, group, { title: t, amount: '10' });
      expect(e.title).toBe(t);
      await expect(page.getByRole('heading', { name: t, exact: true })).toBeVisible();
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, 'no horizontal overflow from long titles').toBeLessThanOrEqual(0);
  });

  test('HTML and script in names and titles render as inert text (no XSS)', async ({ page }) => {
    const dialogs: string[] = [];
    page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
    const payload = `<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>`;
    const name = `<b>Grp</b>${Math.random().toString(36).slice(2, 6)}`;
    const group = await setupGroup(page, name, 'INR', [`<svg onload="window.__xss=3">`]);
    await addExpense(page, group, { title: payload, amount: '10' });
    await expect(page.getByText(payload).first()).toBeVisible();
    await addDirectBill(page, `<iframe src="javascript:window.__xss=4">`, '5', `<img src=y onerror="window.__xss=5">`);
    await gotoTab(page, 'friends');
    await gotoTab(page, 'activity');
    await gotoTab(page, 'analytics');
    await page.getByTestId('global-search-input').fill('<img');
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss ?? null)).toBeNull();
    expect(await page.locator('img[src="x"], img[src="y"], iframe[src^="javascript"]').count()).toBe(0);
    expect(dialogs).toEqual([]);
  });

  test('whitespace-only names are rejected for group, member, direct friend and expense title', async ({ page }) => {
    const name = uniq('Blank Lab');
    const group = await setupGroup(page, name, 'INR', ['Bina Rao']);
    const before = await readLedger(page);
    await page.getByTestId('create-group-btn').click();
    await page.getByTestId('group-name-input').fill('   ');
    await page.getByTestId('save-group-btn').click();
    await addMember(page, '    ');
    // A blank bill title may be blocked or replaced by a default, but never stored blank.
    await page.getByTestId('add-expense-btn').click();
    await fillExpense(page, group, { title: '   ', amount: '10' });
    if (await page.getByTestId('save-expense-btn').isEnabled()) await saveExpense(page);
    else await closeExpenseModal(page);
    await gotoTab(page, 'home');
    await page.getByTestId('home-quick-add-expense-btn').first().click();
    await page.getByTestId('adhoc-friend-name-input').fill('   ');
    await page.getByTestId('add-adhoc-friend-btn').click();
    await expect(page.getByTestId('adhoc-participants-panel')).toContainText('Direct Split Participants (1)');
    await closeExpenseModal(page);
    const after = await readLedger(page);
    expect(after.groups.length, 'no blank group').toBe(before.groups.length);
    expect((await groupByName(page, name)).members.length, 'no blank member').toBe(2);
    expect(after.groups.flatMap((g) => g.members).some((m) => m.displayName.trim() === '')).toBe(false);
    expect(after.expenses.some((e) => e.title.trim() === ''), 'no blank bill title stored').toBe(false);
  });

  test('a duplicate member name is refused or made distinguishable', async ({ page }) => {
    const name = uniq('Dupe Lab');
    await setupGroup(page, name, 'INR', ['Bina Rao']);
    await addMember(page, 'bina rao ');
    await addMember(page, ME);
    await page.waitForTimeout(500);
    const names = (await groupByName(page, name)).members.map((m) => m.displayName.trim().toLowerCase());
    expect(new Set(names).size, `member names ${JSON.stringify(names)}`).toBe(names.length);
  });
});

// ---------------------------------------------------------------------------------------------
test.describe('Export and backup', () => {
  test('CSV, XLSX and PDF exports download real files with the group data', async ({ page }) => {
    const name = uniq('Export Lab');
    const group = await setupGroup(page, name, 'INR', ['Bina Rao']);
    await addExpense(page, group, { title: 'Exported dinner', amount: '1234.56' });
    await gotoTab(page, 'portability');
    void group;
    const grab = async (click: () => Promise<void>) => {
      const dl = page.waitForEvent('download', { timeout: 10_000 });
      await click();
      const d = await dl;
      const path = await d.path();
      const { readFileSync } = await import('node:fs');
      return { name: d.suggestedFilename(), bytes: readFileSync(path) };
    };
    const csv = await grab(() => page.getByRole('button', { name: /Download \.CSV/ }).click());
    expect(csv.name).toMatch(/\.csv$/);
    expect(csv.bytes.toString('utf8')).toContain('Exported dinner');
    expect(csv.bytes.toString('utf8')).toContain('1234.56');
    const xlsx = await grab(() => page.getByTestId('download-xlsx-btn').click());
    expect(xlsx.name).toMatch(/\.xlsx$/);
    expect(xlsx.bytes.subarray(0, 2).toString('latin1')).toBe('PK');
    const pdf = await grab(() => page.getByTestId('download-pdf-btn').click());
    expect(pdf.name).toMatch(/\.pdf$/);
    expect(pdf.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  test('CSV export neutralises spreadsheet formulas in titles', async ({ page }) => {
    const name = uniq('Formula Lab');
    const group = await setupGroup(page, name, 'INR', ['Bina Rao']);
    await addExpense(page, group, { title: '=HYPERLINK("http://evil.example","x")', amount: '10' });
    await gotoTab(page, 'portability');
    const preview = (await page.getByTestId('csv-export-preview').textContent()) ?? '';
    expect(preview).toContain('HYPERLINK');
    expect(preview, 'cell must not start with a bare "="').not.toMatch(/(^|,|\n)"?=HYPERLINK/);
  });

  test('an encrypted backup restores the full ledger in a fresh browser', async ({ page, browser }) => {
    const name = uniq('Backup Lab');
    const group = await setupGroup(page, name, 'JPY', ['Bina Rao']);
    await addExpense(page, group, { title: 'Backed up bill', amount: '1001' });
    const original = await readLedger(page);
    await gotoTab(page, 'portability');
    await page.getByTestId('backup-passphrase-input').fill('correct horse battery staple');
    await page.getByTestId('backup-passphrase-confirm-input').fill('correct horse battery staple');
    await page.getByTestId('generate-encrypted-backup-btn').click();
    const output = page.getByTestId('encrypted-backup-output');
    await expect(output).toContainText('AES-256-GCM');
    const cipher = await output.inputValue();
    expect(cipher).not.toContain('Backed up bill');

    const ctx = await browser.newContext({ baseURL: BASE_URL });
    const fresh = await ctx.newPage();
    await fresh.goto('/');
    await gotoTab(fresh, 'portability');
    await fresh.getByTestId('backup-passphrase-input').fill('correct horse battery staple');
    await fresh.getByTestId('encrypted-backup-output').fill(cipher);
    await fresh.getByTestId('decrypt-restore-btn').click();
    await expect(fresh.getByTestId('backup-restore-success')).toBeVisible();
    const restored = await readLedger(fresh);
    expect(restored.groups.find((g) => g.name === name)).toEqual(original.groups.find((g) => g.name === name));
    expect(restored.expenses.find((e) => e.title === 'Backed up bill')).toEqual(original.expenses.find((e) => e.title === 'Backed up bill'));
    await ctx.close();
  });

  test('a wrong passphrase fails gracefully and leaves local data untouched', async ({ page }) => {
    const name = uniq('Wrong Pass');
    await setupGroup(page, name, 'INR', ['Bina Rao']);
    await gotoTab(page, 'portability');
    await page.getByTestId('backup-passphrase-input').fill('right-passphrase-123');
    await page.getByTestId('backup-passphrase-confirm-input').fill('right-passphrase-123');
    await page.getByTestId('generate-encrypted-backup-btn').click();
    await expect(page.getByTestId('encrypted-backup-output')).toContainText('AES-256-GCM');
    // Mutate after the backup so a wrongful restore would be visible.
    await openGroup(page, (await groupByName(page, name)).id);
    await addExpense(page, await groupByName(page, name), { title: 'After backup', amount: '5' });
    await gotoTab(page, 'portability');
    const before = await readLedger(page);
    await page.getByTestId('backup-passphrase-input').fill('wrong-passphrase-456');
    await page.getByTestId('decrypt-restore-btn').click();
    await expect(page.getByTestId('backup-error')).toBeVisible();
    await expect(page.getByTestId('backup-restore-success')).toHaveCount(0);
    expect(await readLedger(page)).toEqual(before);
    await page.getByTestId('encrypted-backup-output').fill('{"not":"a backup"}');
    await page.getByTestId('decrypt-restore-btn').click();
    await expect(page.getByTestId('backup-error')).toBeVisible();
    expect(await readLedger(page)).toEqual(before);
  });

  test('an empty passphrase is refused instead of sealing the backup with a built-in default', async ({ page }) => {
    await page.goto('/');
    await gotoTab(page, 'portability');
    await page.getByTestId('backup-passphrase-input').fill('');
    await page.getByTestId('backup-passphrase-confirm-input').fill('');
    await page.getByTestId('generate-encrypted-backup-btn').click({ timeout: 3000 }).catch(() => {}); // a disabled button also counts as refused
    await page.waitForTimeout(1000);
    await expect(page.getByTestId('encrypted-backup-output'), 'no ciphertext without a user passphrase').toHaveValue('');
  });
});

// ---------------------------------------------------------------------------------------------
test.describe('Accessibility basics at 375px', () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

  test('key buttons have accessible names and at least 44x44 px targets; no horizontal scroll', async ({ page }) => {
    await page.goto('/');
    const problems: string[] = [];
    const check = async (label: string, loc: Locator) => {
      if (!(await loc.count())) { problems.push(`${label}: missing`); return; }
      const el = loc.first();
      if (!(await el.isVisible())) { problems.push(`${label}: not visible`); return; }
      await el.scrollIntoViewIfNeeded({ timeout: 3000 });
      const box = await el.boundingBox();
      const accName = await el.evaluate((n) => (n.getAttribute('aria-label') ?? (n as HTMLElement).innerText ?? n.getAttribute('title') ?? '').trim());
      if (!accName) problems.push(`${label}: no accessible name`);
      if (!box || box.width < 44 || box.height < 44) problems.push(`${label}: ${Math.round(box?.width ?? 0)}x${Math.round(box?.height ?? 0)}`);
    };
    const noHScroll = async (where: string) => {
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (over > 0) problems.push(`${where}: horizontal overflow ${over}px`);
    };
    for (const t of ['home', 'groups', 'activity', 'friends', 'analytics']) {
      const tab = page.getByTestId(`mobile-nav-tab-${t}`);
      if (await tab.count()) await check(`mobile-nav-tab-${t}`, tab);
    }
    for (const id of ['mobile-fab-split-btn', 'header-user-pill', 'header-help-btn', 'theme-toggle-btn', 'header-offline-toggle', 'home-quick-add-expense-btn', 'home-quick-settle-btn']) {
      await check(id, page.getByTestId(id));
    }
    await noHScroll('home');
    await page.getByTestId('mobile-nav-tab-groups').click();
    for (const id of ['add-expense-btn', 'add-member-btn', 'toggle-simplify-debts-btn', 'change-group-currency-btn', 'explain-balance-btn', 'quick-settle-btn', 'create-group-btn']) {
      await check(id, page.getByTestId(id));
    }
    await check('expense Edit', page.getByRole('button', { name: 'Edit', exact: true }));
    await check('expense delete', page.locator('[data-testid^="delete-expense-"]'));
    await noHScroll('group workspace');
    await page.getByTestId('add-expense-btn').click();
    for (const id of ['save-expense-btn', 'multi-payer-toggle', 'split-mode-equal', 'split-mode-exact']) {
      await check(id, page.getByTestId(id));
    }
    await noHScroll('expense editor');
    expect(problems).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Two signed-in devices against the local stack. Arjun (A) owns a fresh group named with
// SYNC_PREFIX and invites Rohan (B) by email; B's sign-in claims the seat.
test.describe('Sign-in merge', () => {
  test('an open bill editor keeps what the user typed while the post-sign-in sync merges', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('header-user-pill').click();
    await page.getByTestId('demo-profile-login-btn').click();
    await expect(page.getByTestId('dev-auth-modal')).toBeHidden();
    await gotoTab(page, 'groups');
    await expect(page.locator('[data-testid^="group-select-"]').first()).toBeVisible({ timeout: 20_000 });
    await page.getByTestId('add-expense-btn').click();
    await page.getByTestId('expense-title-input').fill('Typed during sync');
    await page.getByTestId('expense-amount-input').fill('100');
    await page.waitForTimeout(8000); // the sign-in backfill pulls land in this window
    await expect(page.getByTestId('expense-title-input'), 'title survives the merge').toHaveValue('Typed during sync');
    await expect(page.getByTestId('expense-amount-input'), 'amount survives the merge').toHaveValue('100');
    await closeExpenseModal(page);
    await expect(page.getByTestId('add-expense-btn'), 'still on the group workspace (no jump to Home)').toBeVisible();
  });
});

test.describe('Sync across two signed-in devices', () => {
  test.describe.configure({ timeout: 180_000 });

  let ctxA: BrowserContext;
  let ctxB: BrowserContext;
  let A: Page;
  let B: Page;
  let api: APIRequestContext;
  let arjunToken = '';
  let groupName = '';
  let groupId = '';

  const signIn = async (page: Page, email: string) => {
    await page.getByTestId('header-user-pill').click();
    await page.getByTestId('dev-login-email-input').fill(email);
    await page.getByTestId('dev-login-password-input').fill(requireEnv('DEV_USER_PASSWORD'));
    const res = page.waitForResponse((r) => r.url().includes('/api/auth/login') && r.request().method() === 'POST');
    await page.getByTestId('dev-login-submit-btn').click();
    expect((await res).status()).toBe(200);
  };

  const sync = async (page: Page) => {
    await gotoTab(page, 'portability');
    const pull = page.waitForResponse((r) => r.url().includes('/api/ledger/pull'), { timeout: 20_000 }).catch(() => null);
    await page.getByTestId('trigger-sync-btn').click();
    await pull;
    await page.waitForTimeout(1500);
  };

  const setOnline = async (page: Page, online: boolean) => {
    const text = (await page.getByTestId('header-offline-toggle').textContent()) ?? '';
    const isOffline = /offline/i.test(text);
    if (isOffline === online) await page.getByTestId('header-offline-toggle').click();
  };

  const serverRows = async (entity: string) => {
    const res = await api.get(`/api/ledger/pull?cursor=0&limit=500&groupId=${groupId}`, { headers: { Authorization: `Bearer ${arjunToken}` } });
    if (res.status() === 403) return []; // the group has not reached the server yet
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { changes: Array<{ entity: string; id: string; deleted: boolean; data: Record<string, unknown> | null }> };
    return body.changes.filter((c) => c.entity === entity);
  };

  test.beforeAll(async ({ browser, playwright }) => {
    api = await playwright.request.newContext({ baseURL: BASE_URL });
    const login = await api.post('/api/auth/login', { data: { email: 'arjun.mehta@example.com', password: requireEnv('DEV_USER_PASSWORD') } });
    expect(login.status()).toBe(200);
    arjunToken = ((await login.json()) as { token: string }).token;

    ctxA = await browser.newContext({ baseURL: BASE_URL });
    ctxB = await browser.newContext({ baseURL: BASE_URL });
    A = await ctxA.newPage();
    B = await ctxB.newPage();
    await A.goto('/');
    await signIn(A, 'arjun.mehta@example.com');
    await expect(A.getByTestId('header-user-pill')).toContainText('Arjun Mehta');

    groupName = `${SYNC_PREFIX}${Date.now().toString(36)}`;
    await createGroup(A, groupName);
    await addMember(A, 'Rohan Verma', 'rohan.verma@example.com');
    const g = await groupByName(A, groupName);
    groupId = g.id;
    await expect.poll(async () => (await groupByName(A, groupName)).members.length).toBe(2);
    await addExpense(A, await groupByName(A, groupName), { title: 'Sync dinner', amount: '100', payer: ME });
    await expect.poll(async () => (await serverRows('expense')).length, { timeout: 30_000, message: 'A pushed the bill' }).toBe(1);

    await B.goto('/');
    await signIn(B, 'rohan.verma@example.com');
    await expect(B.getByTestId('header-user-pill')).toContainText('Rohan Verma');
    await expect.poll(async () => (await readLedger(B)).groups?.some((x) => x.id === groupId), { timeout: 30_000, message: 'B received the invited group' }).toBe(true);
  });

  test.afterAll(async () => {
    await ctxA?.close();
    await ctxB?.close();
    // Hard-delete every group this suite created (cascades to members, bills, settlements, history).
    const admin = createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SECRET_KEY'), {
      auth: { persistSession: false },
      db: { schema: process.env.SUPABASE_SCHEMA || 'wise_spliter' },
    });
    const { error } = await admin.from('groups').delete().like('name', `${SYNC_PREFIX}%`);
    if (error) {
      // Fall back to an admin soft delete through the API.
      await api?.post('/api/ledger/push', {
        headers: { Authorization: `Bearer ${arjunToken}` },
        data: { mutations: [{ entity: 'group', id: groupId, op: 'delete', hlc: `${(Date.now() + 5000).toString(16).padStart(12, '0')}-0001-e2e`, data: null }] },
      });
      console.warn(`[edge-cases] hard cleanup failed (${error.code ?? 'error'}); soft-deleted ${groupId} instead`);
    }
    await api?.dispose();
  });

  test('an edit on device A reaches device B after a sync', async () => {
    await openGroup(A, groupId);
    await openEditExpense(A, 'Sync dinner');
    await A.getByTestId('expense-amount-input').fill('150');
    await saveExpense(A);
    await expect.poll(async () => (await serverRows('expense'))[0]?.data?.amountMinor, { timeout: 30_000 }).toBe(15000);
    await sync(B);
    await expect.poll(async () => (await readLedger(B)).expenses.find((e) => e.groupId === groupId && e.title === 'Sync dinner')?.amountMinor, { timeout: 30_000 }).toBe(15000);
    await openGroup(B, groupId);
    await expect(B.getByText('₹150.00').first()).toBeVisible();
    expect(await expectBalanced(B, groupName)).toEqual({ [ME]: 7500, 'Rohan Verma': -7500 });
  });

  test('concurrent offline edits surface the conflict review instead of silently losing one', async () => {
    await setOnline(A, false);
    await setOnline(B, false);
    await openGroup(A, groupId);
    await openEditExpense(A, 'Sync dinner');
    await A.getByTestId('expense-amount-input').fill('200');
    await saveExpense(A);
    await openGroup(B, groupId);
    await openEditExpense(B, 'Sync dinner');
    await B.getByTestId('expense-amount-input').fill('300');
    await saveExpense(B);
    await setOnline(A, true);
    await sync(A);
    await setOnline(B, true);
    await sync(B);
    await sync(A);
    await openGroup(A, groupId);
    await openGroup(B, groupId);
    const bannerA = await A.getByTestId('conflict-resolution-banner').filter({ hasText: 'Sync dinner' }).count();
    const bannerB = await B.getByTestId('conflict-resolution-banner').filter({ hasText: 'Sync dinner' }).count();
    const amounts = async (p: Page) => (await readLedger(p)).expenses.find((e) => e.groupId === groupId && e.title === 'Sync dinner')?.amountMinor;
    expect(bannerA + bannerB, `conflict banner shown (A=${bannerA}, B=${bannerB}); amounts A=${await amounts(A)} B=${await amounts(B)}`).toBeGreaterThan(0);
    const resolver = bannerB ? B : A;
    await resolver.getByTestId('keep-active-revision-btn').first().click();
    await expect(resolver.getByTestId('conflict-resolution-banner').filter({ hasText: 'Sync dinner' })).toHaveCount(0);
    await sync(resolver);
    await sync(resolver === A ? B : A);
    await expect.poll(async () => [await amounts(A), await amounts(B)], { timeout: 30_000, message: 'devices converge' }).toEqual([await amounts(resolver), await amounts(resolver)]);
  });

  test('switching user with unsynced changes warns first', async () => {
    await setOnline(A, false);
    await openGroup(A, groupId);
    await addExpense(A, await groupByName(A, groupName), { title: 'Unsynced taxi', amount: '25' });
    await signIn(A, 'priya.nair@example.com');
    const warning = A.getByTestId('switch-user-warning');
    await expect(warning).toBeVisible();
    await expect(warning).toContainText('unsynced');
    await A.getByTestId('switch-user-cancel-btn').click();
    await expect(warning).toBeHidden();
    await expect(A.getByTestId('header-user-pill')).toContainText('Arjun Mehta');
    expect((await readLedger(A)).expenses.some((e) => e.title === 'Unsynced taxi'), 'cancel keeps the unsynced bill').toBe(true);
    await setOnline(A, true);
    await sync(A);
    await expect.poll(async () => (await serverRows('expense')).length, { timeout: 30_000 }).toBe(2);
  });

  test("a removed member's device drops the group on its next sync", async () => {
    const rohan = (await groupByName(A, groupName)).members.find((m) => m.displayName === 'Rohan Verma')!;
    const res = await api.post('/api/ledger/push', {
      headers: { Authorization: `Bearer ${arjunToken}` },
      data: {
        mutations: [{
          entity: 'group_member', id: rohan.id, op: 'upsert',
          hlc: `${(Date.now() + 2000).toString(16).padStart(12, '0')}-0001-usr_arjun_01`,
          data: { ...rohan, removedAt: new Date().toISOString() },
        }],
      },
    });
    expect(res.status()).toBe(200);
    expect(((await res.json()) as { results: Array<{ status: string }> }).results.map((r) => r.status)).toEqual(['applied']);
    await sync(B);
    await expect.poll(async () => (await readLedger(B)).groups.some((g) => g.id === groupId && !g.deletedAt), { timeout: 30_000 }).toBe(false);
    await gotoTab(B, 'groups');
    await expect(B.getByTestId(`group-select-${groupId}`)).toHaveCount(0);
  });

  test('signing out wipes the signed-in ledger from this device', async () => {
    expect((await readLedger(A)).groups.some((g) => g.id === groupId)).toBe(true);
    await gotoTab(A, 'portability');
    await A.getByTestId('sign-out-btn').click();
    await expect.poll(async () => A.evaluate((n) => Object.values({ ...localStorage }).some((v) => v.includes(n)), groupName), { timeout: 15_000 }).toBe(false);
    await expect.poll(async () => (await readIndexedDbText(A)).includes(groupName), { timeout: 15_000 }).toBe(false);
    await gotoTab(A, 'groups');
    await expect(A.getByText(groupName)).toHaveCount(0);
  });
});




