import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import mockData from '../../src/data/mock-ledger-data.json' with { type: 'json' };

// Client state and sync: Dexie as the store, data made before sign-in, session expiry,
// revision restore across currencies, server conflicts and comment rows on two devices.

const BASE_URL = `http://localhost:${process.env.APP_PORT || 4173}`;
const PREFIX = 'E2E-STATE-';
const LEGACY_KEY = 'wise_spliter_ledger_state_v1';
const ROHAN = 'rohan.verma@example.com';
const ARJUN = 'arjun.mehta@example.com';

const SAMPLE_IDS = new Set<string>([
  ...mockData.groups.flatMap((g) => [g.id, ...g.members.map((m) => m.id)]),
  ...mockData.expenses.map((e) => e.id),
  ...mockData.expenseRevisions.map((r) => r.id),
  ...mockData.settlements.map((s) => s.id),
  ...mockData.groupActivityLog.map((a) => a.id),
]);

function password(): string {
  const value = process.env.DEV_USER_PASSWORD?.trim();
  if (!value) throw new Error('DEV_USER_PASSWORD is required (see .env.example)');
  return value;
}

const uniq = (label: string) => `${PREFIX}${label} ${Math.random().toString(36).slice(2, 7)}`;

interface Row { id: string; [k: string]: unknown }
interface Expense extends Row {
  title: string;
  groupId: string | null;
  amountMinor: number;
  groupCurrency: string;
  hasUnresolvedConflict: boolean;
  comments: Array<{ id: string; body: string }>;
}
interface Ledger {
  groups: Array<Row & { name: string; members: Array<{ id: string; userId: string | null; displayName: string }> }>;
  expenses: Expense[];
  expenseRevisions: Array<Row & { expenseId: string; revisionNumber: number }>;
  syncOutbox: Row[];
  localReceiptBlobs: Array<Row & { ownerUserId?: string | null; dataUrl: string }>;
}

async function readDb(page: Page): Promise<Ledger> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('wise_spliter_local_db');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const all = (store: string) =>
      new Promise<unknown[]>((res) => {
        if (!db.objectStoreNames.contains(store)) return res([]);
        const req = db.transaction(store, 'readonly').objectStore(store).getAll();
        req.onsuccess = () => res(req.result as unknown[]);
        req.onerror = () => res([]);
      });
    const stores = ['groups', 'expenses', 'expenseRevisions', 'syncOutbox', 'localReceiptBlobs'];
    const rows = await Promise.all(stores.map(all));
    db.close();
    return Object.fromEntries(stores.map((s, i) => [s, rows[i]])) as unknown as Ledger;
  });
}

async function expenseByTitle(page: Page, title: string): Promise<Expense> {
  let found: Expense | undefined;
  await expect
    .poll(async () => Boolean((found = (await readDb(page)).expenses.find((e) => e.title === title))), {
      message: `bill "${title}" saved on the device`,
    })
    .toBe(true);
  return found!;
}

async function gotoTab(page: Page, tab: string) {
  await page.getByTestId(`nav-tab-${tab}`).first().click();
}

async function createGroup(page: Page, name: string, currency = 'INR') {
  await gotoTab(page, 'groups');
  await page.getByTestId('create-group-btn').click();
  await page.getByTestId('group-name-input').fill(name);
  await page.getByTestId('group-currency-select').selectOption(currency);
  await page.getByTestId('save-group-btn').click();
  await expect(page.getByRole('heading', { name, exact: true }).first()).toBeVisible();
}

async function addMember(page: Page, name: string, email?: string) {
  await page.getByTestId('add-member-btn').click();
  await page.getByTestId('member-name-input').fill(name);
  if (email) await page.getByTestId('member-email-input').fill(email);
  await page.getByTestId('save-member-btn').click();
  await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
}

async function saveExpense(page: Page) {
  await expect(page.getByTestId('save-expense-btn')).toBeEnabled();
  await page.getByTestId('save-expense-btn').click();
  await expect(page.getByTestId('expense-title-input')).toBeHidden();
}

async function addGroupBill(page: Page, title: string, amount: string, withReceipt = false) {
  await page.getByTestId('add-expense-btn').click();
  await page.getByTestId('expense-title-input').fill(title);
  await page.getByTestId('expense-amount-input').fill(amount);
  if (withReceipt) {
    await page.getByTestId('attach-sample-receipt-btn').click();
    await expect(page.getByTestId('attached-receipt-badge').first()).toBeVisible();
  }
  await saveExpense(page);
  return expenseByTitle(page, title);
}

async function addDirectBill(page: Page, title: string, amount: string, friend: string) {
  await gotoTab(page, 'home');
  await page.getByTestId('home-quick-add-expense-btn').first().click();
  await page.getByTestId('adhoc-friend-name-input').fill(friend);
  await page.getByTestId('add-adhoc-friend-btn').click();
  await page.getByTestId('expense-title-input').fill(title);
  await page.getByTestId('expense-amount-input').fill(amount);
  await saveExpense(page);
  return expenseByTitle(page, title);
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

async function signIn(page: Page, email: string) {
  if (!(await page.getByTestId('dev-auth-modal').isVisible())) await page.getByTestId('header-user-pill').click();
  await page.getByTestId('dev-login-email-input').fill(email);
  await page.getByTestId('dev-login-password-input').fill(password());
  const res = page.waitForResponse((r) => r.url().includes('/api/auth/login') && r.request().method() === 'POST');
  await page.getByTestId('dev-login-submit-btn').click();
  expect((await res).status()).toBe(200);
}

async function sync(page: Page) {
  await gotoTab(page, 'portability');
  const pull = page.waitForResponse((r) => r.url().includes('/api/ledger/pull'), { timeout: 20_000 }).catch(() => null);
  await page.getByTestId('trigger-sync-btn').click();
  await pull;
  await page.waitForTimeout(1500);
}

async function setAppOnline(page: Page, online: boolean) {
  const text = (await page.getByTestId('header-offline-toggle').textContent()) ?? '';
  if (/offline/i.test(text) === online) await page.getByTestId('header-offline-toggle').click();
}

async function openGroup(page: Page, groupId: string) {
  await gotoTab(page, 'groups');
  const sel = page.getByTestId(`group-select-${groupId}`);
  if (await sel.count()) await sel.click();
  await expect(page.getByTestId('add-expense-btn')).toBeVisible();
}

/** Every mutation body the page pushes. */
function capturePushes(page: Page): Array<{ entity: string; id: string; data: Record<string, unknown> | null }> {
  const pushed: Array<{ entity: string; id: string; data: Record<string, unknown> | null }> = [];
  page.on('request', (req) => {
    if (!req.url().includes('/api/ledger/push')) return;
    try {
      pushed.push(...(JSON.parse(req.postData() ?? '{}') as { mutations: typeof pushed }).mutations);
    } catch {
      // not JSON
    }
  });
  return pushed;
}

test.describe('Device storage (P1-11)', () => {
  test('a bill survives a reload from Dexie, and a stale localStorage blob never overrides it', async ({ page }) => {
    await page.goto('/');
    const group = uniq('Store');
    await createGroup(page, group);
    await addGroupBill(page, 'Reload lunch', '42');
    await page.reload();
    await gotoTab(page, 'groups');
    await expect(page.getByRole('heading', { name: 'Reload lunch', exact: true }).first()).toBeVisible();
    expect(await page.evaluate((k) => localStorage.getItem(k), LEGACY_KEY)).toBeNull();

    const stale = structuredClone(mockData) as typeof mockData;
    stale.groups[0]!.name = `${PREFIX}Stale blob`;
    await page.evaluate(([k, v]) => localStorage.setItem(k!, v!), [LEGACY_KEY, JSON.stringify(stale)]);
    await page.reload();
    await expect.poll(async () => (await readDb(page)).expenses.some((e) => e.title === 'Reload lunch')).toBe(true);
    expect((await readDb(page)).groups.some((g) => g.name === `${PREFIX}Stale blob`)).toBe(false);
    await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), LEGACY_KEY)).toBeNull();
  });

  test('a device with only a legacy snapshot migrates it once', async ({ page }) => {
    const legacy = structuredClone(mockData) as typeof mockData;
    legacy.groups[0]!.name = `${PREFIX}Legacy Trip`;
    await page.addInitScript(([k, v]) => {
      if (!sessionStorage.getItem('legacy_seeded')) {
        localStorage.setItem(k!, v!);
        sessionStorage.setItem('legacy_seeded', '1');
      }
    }, [LEGACY_KEY, JSON.stringify(legacy)]);
    await page.goto('/');
    await expect.poll(async () => (await readDb(page)).groups.some((g) => g.name === `${PREFIX}Legacy Trip`)).toBe(true);
    await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), LEGACY_KEY)).toBeNull();
    await page.reload();
    await expect.poll(async () => (await readDb(page)).groups.some((g) => g.name === `${PREFIX}Legacy Trip`)).toBe(true);
  });
});

test.describe('Data made before the first sign-in (P0-1)', () => {
  test.describe.configure({ timeout: 120_000 });

  test('"Bring my local data" keeps the bills, maps me to the account, and never pushes sample rows', async ({ page }) => {
    const pushed = capturePushes(page);
    await page.goto('/');
    const group = uniq('Before signin');
    await createGroup(page, group);
    await addMember(page, 'Kiran Local');
    await addGroupBill(page, 'Pre-login dinner', '120');
    await addDirectBill(page, 'Pre-login cab', '30', 'Meera Local');

    await signIn(page, ROHAN);
    const dialog = page.getByTestId('local-data-import-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('1 group');
    await expect(dialog).toContainText('2 bills');
    await page.getByTestId('local-data-import-btn').click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('header-user-pill')).toContainText('Rohan Verma');

    await expect.poll(() => pushed.some((m) => m.entity === 'expense' && m.data?.title === 'Pre-login dinner'), { timeout: 30_000 }).toBe(true);
    await expect.poll(() => pushed.some((m) => m.entity === 'expense' && m.data?.title === 'Pre-login cab'), { timeout: 30_000 }).toBe(true);
    await expect.poll(async () => (await readDb(page)).syncOutbox.length, { timeout: 30_000, message: 'everything synced' }).toBe(0);
    expect(pushed.filter((m) => SAMPLE_IDS.has(m.id))).toEqual([]);

    const ledger = await readDb(page);
    const mine = ledger.groups.find((g) => g.name === group)!;
    const me = mine.members.find((m) => m.userId);
    expect(me).toMatchObject({ displayName: 'Rohan Verma' });
    expect(me!.userId).not.toBe(mockData.currentUser.id);
    expect(ledger.expenses.some((e) => e.title === 'Pre-login dinner')).toBe(true);
  });

  test('"Start fresh" offers an encrypted backup, removes the local data, and the backup restores', async ({ page }) => {
    await page.goto('/');
    const group = uniq('Fresh');
    await createGroup(page, group);
    await addGroupBill(page, 'Throwaway snack', '9');
    await signIn(page, ROHAN);
    await page.getByTestId('local-data-fresh-btn').click();

    await page.getByTestId('local-data-passphrase-input').fill('short');
    await page.getByTestId('local-data-passphrase-confirm-input').fill('short');
    await page.getByTestId('local-data-backup-btn').click();
    await expect(page.getByTestId('local-data-backup-note')).toContainText('at least 12 characters');

    const secret = 'quiet harbour lantern 42';
    await page.getByTestId('local-data-passphrase-input').fill(secret);
    await page.getByTestId('local-data-passphrase-confirm-input').fill(secret);
    const downloading = page.waitForEvent('download');
    await page.getByTestId('local-data-backup-btn').click();
    const download = await downloading;
    expect(download.suggestedFilename()).toMatch(/^wise-spliter-backup-\d{4}-\d{2}-\d{2}\.wisesplit$/);
    const file = await download.path();
    const { readFile } = await import('node:fs/promises');
    const bundle = await readFile(file, 'utf8');
    expect(bundle).not.toContain('Throwaway snack');

    await page.getByTestId('local-data-wipe-btn').click();
    await expect(page.getByTestId('local-data-import-dialog')).toBeHidden();
    await expect(page.getByTestId('header-user-pill')).toContainText('Rohan Verma');
    await expect.poll(async () => (await readDb(page)).groups.some((g) => g.name === group)).toBe(false);

    await gotoTab(page, 'portability');
    await page.getByTestId('restore-backup-file-input').setInputFiles(file);
    await page.getByTestId('backup-passphrase-input').fill(secret);
    await page.getByTestId('decrypt-restore-btn').click();
    await expect(page.getByTestId('backup-restore-success')).toBeVisible();
    await expect.poll(async () => (await readDb(page)).expenses.some((e) => e.title === 'Throwaway snack')).toBe(true);
  });
});

test.describe('Sign-in and sign-out guards', () => {
  test.describe.configure({ timeout: 120_000 });

  test('"Not now" keeps the device signed out with its data', async ({ page }) => {
    await page.goto('/');
    const group = uniq('Later');
    await createGroup(page, group);
    await signIn(page, ROHAN);
    await page.getByTestId('local-data-later-btn').click();
    await expect(page.getByTestId('local-data-import-dialog')).toBeHidden();
    await expect(page.getByTestId('header-user-pill')).not.toContainText('Rohan Verma');
    expect((await readDb(page)).groups.some((g) => g.name === group)).toBe(true);
  });

  test('the shared demo account is never offered this device\'s data', async ({ page }) => {
    await page.goto('/');
    await createGroup(page, uniq('Not for demo'));
    await signIn(page, ARJUN);
    const dialog = page.getByTestId('local-data-import-dialog');
    await expect(dialog).toContainText('shared demo account');
    await expect(page.getByTestId('local-data-import-btn')).toHaveCount(0);
    await page.getByTestId('local-data-later-btn').click();
  });

  test('bills imported into a sample group before sign-in open the dialog, never a silent no-op (User Story 6)', async ({ page }) => {
    await page.goto('/');
    await gotoTab(page, 'portability');
    await page.getByTestId('load-sample-splitwise-btn').click();
    await page.getByTestId('confirm-splitwise-import-btn').click();
    await page.getByTestId('header-user-pill').click();
    await page.getByTestId('dev-login-email-input').fill('nonexistent@example.com');
    await page.getByTestId('dev-login-password-input').fill('wrongpass');
    await page.getByTestId('dev-login-submit-btn').click();
    await expect(page.getByTestId('dev-login-error-banner')).toBeVisible();
    await signIn(page, ROHAN);
    const dialog = page.getByTestId('local-data-import-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('2 bills you added inside the sample groups cannot be copied');
    await expect(page.getByTestId('local-data-import-btn')).toHaveCount(0);
    await expect(page.getByTestId('toast-banner')).toHaveCount(0);
    await page.getByTestId('local-data-fresh-btn').click();
    await page.getByTestId('local-data-wipe-btn').click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('header-user-pill')).toContainText('Rohan Verma');
  });

  test('signing out with unsynced changes asks first, and "Stay signed in" keeps them', async ({ page, context }) => {
    await page.goto('/');
    await signIn(page, ROHAN);
    await createGroup(page, uniq('Unsynced'));
    await expect.poll(async () => (await readDb(page)).syncOutbox.length, { timeout: 30_000 }).toBe(0);
    await context.setOffline(true);
    await addGroupBill(page, 'Unsynced chai', '20');
    await gotoTab(page, 'portability');
    await page.getByTestId('sign-out-btn').click();
    const warning = page.getByTestId('sign-out-warning');
    await expect(warning).toBeVisible();
    await page.getByTestId('sign-out-cancel-btn').click();
    await expect(warning).toBeHidden();
    await expect(page.getByTestId('header-user-pill')).toContainText('Rohan Verma');
    expect((await readDb(page)).syncOutbox.length).toBeGreaterThan(0);

    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(async () => (await readDb(page)).syncOutbox.length, { timeout: 30_000 }).toBe(0);
    await page.getByTestId('sign-out-btn').click();
    await expect(page.getByTestId('header-user-pill')).not.toContainText('Rohan Verma');
    await expect(warning).toHaveCount(0);
  });
});

test.describe('Refused new rows', () => {
  test.describe.configure({ timeout: 120_000 });

  test('a new bill the server refuses stays on this device, flagged, and "Try again" saves it', async ({ page }) => {
    await page.goto('/');
    await signIn(page, ROHAN);
    await page.waitForLoadState('networkidle');
    await createGroup(page, uniq('Refused'));
    await expect.poll(async () => (await readDb(page)).syncOutbox.length, { timeout: 30_000 }).toBe(0);

    await page.route('**/api/ledger/push', async (route) => {
      const { mutations } = JSON.parse(route.request().postData() ?? '{}') as { mutations: Array<{ entity: string; id: string }> };
      await route.fulfill({
        json: { results: mutations.map((m) => ({ entity: m.entity, id: m.id, status: 'invalid', reason: 'notes is too long (max 2000)' })) },
      });
    });
    const bill = await addGroupBill(page, uniq('Refused lunch'), '18');
    await expect(page.getByTestId(`not-saved-expense-${bill.id}`)).toContainText('Could not save to your account: Notes is too long', { timeout: 30_000 });
    expect((await readDb(page)).expenses.some((e) => e.id === bill.id)).toBe(true);

    await page.unroute('**/api/ledger/push');
    await page.getByTestId(`not-saved-retry-${bill.id}`).click();
    await expect(page.getByTestId('not-saved-panel')).toHaveCount(0, { timeout: 30_000 });
    await expect.poll(async () => (await readDb(page)).syncOutbox.length, { timeout: 30_000 }).toBe(0);
    expect((await readDb(page)).expenses.find((e) => e.id === bill.id)).not.toHaveProperty('syncRejection', expect.any(String));
  });
});

test.describe('Session expiry while offline (item 8)', () => {
  test.describe.configure({ timeout: 120_000 });

  test('queued changes stay, a re-auth prompt appears, and the queue pushes after signing in again', async ({ page, context }) => {
    await page.goto('/');
    await signIn(page, ROHAN);
    const group = uniq('Expiry');
    await createGroup(page, group);
    await expect.poll(async () => (await readDb(page)).syncOutbox.length, { timeout: 30_000 }).toBe(0);

    const logout = await page.request.post('/api/auth/logout', { headers: { Origin: BASE_URL } });
    expect(logout.status()).toBe(200);

    await context.setOffline(true);
    await addGroupBill(page, 'Offline taxi', '15');
    await expect.poll(async () => (await readDb(page)).syncOutbox.length).toBeGreaterThan(0);
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));

    await expect(page.getByTestId('dev-auth-modal')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('toast-banner')).toContainText('sign-in has expired');
    expect((await readDb(page)).syncOutbox.length).toBeGreaterThan(0);

    const pushed = page.waitForRequest((r) => r.url().includes('/api/ledger/push') && (r.postData() ?? '').includes('Offline taxi'), { timeout: 30_000 });
    await signIn(page, ROHAN);
    await pushed;
    await expect.poll(async () => (await readDb(page)).syncOutbox.length, { timeout: 30_000 }).toBe(0);
  });
});

test.describe('Restoring an old version across a currency change (P1-2)', () => {
  test('v1 of a 1,000 INR bill restored after converting the group to USD is 11.80 USD', async ({ page }) => {
    await page.goto('/');
    const group = uniq('Restore FX');
    await createGroup(page, group);
    const bill = await addGroupBill(page, 'Hotel deposit', '1000');
    expect(bill).toMatchObject({ amountMinor: 100000, groupCurrency: 'INR' });

    await page.getByTestId('change-group-currency-btn').click();
    await page.getByTestId('change-currency-target-select').selectOption('USD');
    await page.getByRole('button', { name: /Mode B/ }).click();
    await page.getByTestId('currency-change-rate-input').fill('0.0118');
    await page.getByTestId('confirm-currency-change-btn').click();
    await expect.poll(async () => (await readDb(page)).expenses.find((e) => e.id === bill.id)?.groupCurrency).toBe('USD');

    const v1 = (await readDb(page)).expenseRevisions.find((r) => r.expenseId === bill.id && r.revisionNumber === 1)!;
    await gotoTab(page, 'activity');
    const restore = page.getByTestId(`restore-revision-${v1.id}`);
    if (!(await restore.isVisible())) await page.getByTestId('activity-scope-toggle').click();
    await restore.click();
    await expect
      .poll(async () => {
        const e = (await readDb(page)).expenses.find((x) => x.id === bill.id)!;
        return [e.groupCurrency, e.amountMinor];
      })
      .toEqual(['USD', 1180]);
  });
});

test.describe('Two signed-in devices (P1-3, P1-4, P1-9)', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });

  let ctxA: BrowserContext;
  let ctxB: BrowserContext;
  let A: Page;
  let B: Page;
  let groupId = '';

  const bill = async (page: Page, title: string) => (await readDb(page)).expenses.find((e) => e.groupId === groupId && e.title === title);

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000);
    ctxA = await browser.newContext({ baseURL: BASE_URL });
    ctxB = await browser.newContext({ baseURL: BASE_URL });
    A = await ctxA.newPage();
    B = await ctxB.newPage();
    await A.goto('/');
    await signIn(A, ARJUN);
    await expect(A.getByTestId('header-user-pill')).toContainText('Arjun Mehta');
    // The first pull of a busy dev account must land before the editor opens (it resets on new data).
    await A.waitForLoadState('networkidle');
    const name = uniq('Two devices');
    await createGroup(A, name);
    await addMember(A, 'Rohan Verma', ROHAN);
    groupId = (await readDb(A)).groups.find((g) => g.name === name)!.id;
    await addGroupBill(A, 'Race dinner', '100');
    await expect.poll(async () => (await readDb(A)).syncOutbox.length, { timeout: 30_000 }).toBe(0);

    await B.goto('/');
    await signIn(B, ROHAN);
    await expect.poll(async () => Boolean(await bill(B, 'Race dinner')), { timeout: 60_000, message: 'B pulled the bill' }).toBe(true);
    await B.waitForLoadState('networkidle');
  });

  test.afterAll(async () => {
    await ctxA?.close();
    await ctxB?.close();
  });

  test('an offline edit race shows the conflict banner on both devices, and Keep mine converges', async () => {
    await setAppOnline(A, false);
    await setAppOnline(B, false);
    await openGroup(A, groupId);
    await openEditExpense(A, 'Race dinner');
    await A.getByTestId('expense-amount-input').fill('200');
    await expect(A.getByTestId('expense-amount-input')).toHaveValue('200');
    await saveExpense(A);
    await openGroup(B, groupId);
    await openEditExpense(B, 'Race dinner');
    await B.getByTestId('expense-amount-input').fill('300');
    await expect(B.getByTestId('expense-amount-input')).toHaveValue('300');
    await saveExpense(B);
    await expect.poll(async () => (await bill(B, 'Race dinner'))?.amountMinor).toBe(30000);
    await expect.poll(async () => (await bill(A, 'Race dinner'))?.amountMinor).toBe(20000);

    await setAppOnline(A, true);
    await sync(A);
    await setAppOnline(B, true);
    await sync(B);
    await sync(A);

    for (const page of [A, B]) {
      await expect.poll(async () => (await bill(page, 'Race dinner'))?.hasUnresolvedConflict, { timeout: 30_000 }).toBe(true);
      await openGroup(page, groupId);
      await expect(page.getByTestId('conflict-resolution-banner').filter({ hasText: 'Race dinner' })).toBeVisible();
    }

    const marker = (await bill(B, 'Race dinner'))!.conflictRevisionId as string;
    expect(marker).toBeTruthy();
    const pushedByB = capturePushes(B);
    await B.getByTestId('conflict-resolution-banner').filter({ hasText: 'Race dinner' }).getByTestId('keep-conflict-revision-btn').click();
    await expect(B.getByTestId('conflict-resolution-banner').filter({ hasText: 'Race dinner' })).toHaveCount(0);
    await sync(B);
    const resolution = pushedByB.find((m) => m.entity === 'expense' && m.data?.title === 'Race dinner');
    expect(resolution?.data).toMatchObject({ hasUnresolvedConflict: false, conflictRevisionId: marker });
    await sync(A);
    for (const page of [A, B]) {
      await expect
        .poll(async () => {
          const e = await bill(page, 'Race dinner');
          return [e?.amountMinor, e?.hasUnresolvedConflict];
        }, { timeout: 30_000, message: 'devices converge on Rohan\'s version' })
        .toEqual([30000, false]);
    }
  });

  test('two people commenting offline both land on both devices, with no conflict', async () => {
    const postComment = async (page: Page, text: string) => {
      await openGroup(page, groupId);
      const card = page
        .locator('div')
        .filter({ has: page.getByRole('heading', { name: 'Race dinner', exact: true }) })
        .filter({ has: page.getByRole('button', { name: /Comments \(/ }) })
        .last();
      await card.getByRole('button', { name: /Comments \(/ }).click();
      await card.getByLabel('Comment on this bill').fill(text);
      await card.getByRole('button', { name: 'Post', exact: true }).click();
    };
    await setAppOnline(A, false);
    await setAppOnline(B, false);
    await postComment(A, 'Arjun offline note');
    await postComment(B, 'Rohan offline note');
    await setAppOnline(A, true);
    await sync(A);
    await setAppOnline(B, true);
    await sync(B);
    await sync(A);
    for (const page of [A, B]) {
      await expect
        .poll(async () => (await bill(page, 'Race dinner'))?.comments.map((c) => c.body).sort(), { timeout: 30_000 })
        .toEqual(['Arjun offline note', 'Rohan offline note']);
      expect((await bill(page, 'Race dinner'))?.hasUnresolvedConflict).toBe(false);
    }
  });

  test('my receipt photo survives signing out and back in', async () => {
    const title = uniq('Receipt lunch');
    await openGroup(A, groupId);
    const withReceipt = await addGroupBill(A, title, '64', true);
    await expect.poll(async () => (await readDb(A)).syncOutbox.length, { timeout: 30_000 }).toBe(0);
    await expect.poll(async () => (await readDb(A)).localReceiptBlobs.filter((b) => b.expenseId === withReceipt.id).length).toBeGreaterThan(0);
    await gotoTab(A, 'portability');
    await A.getByTestId('sign-out-btn').click();
    await expect.poll(async () => (await readDb(A)).expenses.some((e) => e.id === withReceipt.id)).toBe(false);
    const blobs = (await readDb(A)).localReceiptBlobs.filter((b) => b.expenseId === withReceipt.id);
    expect(blobs.length).toBeGreaterThan(0);

    await signIn(A, ARJUN);
    await expect.poll(async () => Boolean(await bill(A, title)), { timeout: 30_000 }).toBe(true);
    await openGroup(A, groupId);
    await openEditExpense(A, title);
    await expect(A.getByTestId('expense-receipt-section').locator('img[src^="data:image/"]').first()).toBeVisible({ timeout: 15_000 });
  });

  test('leaving a group waits for the server: offline it stays, online it goes', async () => {
    const tryLeave = async () => {
      await openGroup(B, groupId);
      if (!(await B.getByTestId('leave-group-btn').isVisible())) await B.getByTestId('group-settings').locator('summary').click();
      await B.getByTestId('leave-group-btn').click();
      await B.getByTestId('leave-group-confirm-btn').click();
    };
    await ctxB.setOffline(true);
    await tryLeave();
    await expect(B.getByTestId('toast-banner')).toContainText('offline');
    expect((await readDb(B)).groups.some((g) => g.id === groupId)).toBe(true);
    await ctxB.setOffline(false);
    await B.evaluate(() => window.dispatchEvent(new Event('online')));
    await tryLeave();
    await expect.poll(async () => (await readDb(B)).groups.some((g) => g.id === groupId), { timeout: 30_000 }).toBe(false);
  });
});
