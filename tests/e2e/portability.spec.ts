import { readFileSync } from 'node:fs';
import { expect, test, type Download, type Page } from '@playwright/test';
import mockData from '../../src/data/mock-ledger-data.json' with { type: 'json' };

const FIXTURE = readFileSync(new URL('../fixtures/splitwise-export.csv', import.meta.url), 'utf8');
const PASS = 'correct horse battery staple';

interface Member { id: string; displayName: string }
interface Group { id: string; name: string; members: Member[] }
interface Ledger {
  groups: Group[];
  expenses: Array<{ groupId: string | null; deletedAt: string | null; payers: Array<{ memberId: string; paidMinor: number }>; splits: Array<{ memberId: string; included: boolean; owedMinor: number }> }>;
  settlements: Array<{ groupId: string | null; deletedAt: string | null; fromMemberId: string; toMemberId: string; amountMinor: number }>;
}

const uniq = (label: string) => `${label} ${Math.random().toString(36).slice(2, 7)}`;
const readLedger = (page: Page): Promise<Ledger> =>
  page.evaluate(
    () =>
      new Promise<Ledger>((resolve, reject) => {
        const open = indexedDB.open('wise_spliter_local_db');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const names = ['groups', 'expenses', 'settlements'] as const;
          const tx = db.transaction([...names], 'readonly');
          const out: Record<string, unknown[]> = {};
          for (const n of names) {
            const req = tx.objectStore(n).getAll();
            req.onsuccess = () => (out[n] = req.result as unknown[]);
          }
          tx.oncomplete = () => {
            db.close();
            resolve(out as unknown as Ledger);
          };
          tx.onerror = () => reject(tx.error);
        };
      })
  );
const snapshot = (page: Page) => readLedger(page).then((l) => JSON.stringify(l));

async function groupNamed(page: Page, name: string): Promise<Group> {
  let g: Group | undefined;
  await expect.poll(async () => (g = (await readLedger(page)).groups?.find((x) => x.name === name)) !== undefined).toBe(true);
  return g!;
}

async function createGroup(page: Page, name: string, others: string[]): Promise<Group> {
  await page.goto('/');
  await page.getByTestId('nav-tab-groups').first().click();
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
  await expect.poll(async () => (await groupNamed(page, name)).members.length).toBe(others.length + 1);
  return groupNamed(page, name);
}

async function openPortability(page: Page, groupId?: string) {
  await page.getByTestId('nav-tab-portability').first().click();
  if (groupId) await page.getByTestId('export-scope-select').selectOption(groupId);
}

async function download(page: Page, click: () => Promise<void>): Promise<{ name: string; text: string; path: string }> {
  const pending: Promise<Download> = page.waitForEvent('download', { timeout: 15_000 });
  await click();
  const d = await pending;
  const path = await d.path();
  return { name: d.suggestedFilename(), text: readFileSync(path, 'utf8'), path };
}

function nets(ledger: Ledger, group: Group): Record<string, number> {
  const byId = new Map(group.members.map((m) => [m.id, 0]));
  const add = (id: string, v: number) => byId.set(id, (byId.get(id) ?? 0) + v);
  for (const e of ledger.expenses.filter((x) => x.groupId === group.id && !x.deletedAt)) {
    for (const p of e.payers) add(p.memberId, p.paidMinor);
    for (const s of e.splits) if (s.included) add(s.memberId, -s.owedMinor);
  }
  for (const s of ledger.settlements.filter((x) => x.groupId === group.id && !x.deletedAt)) {
    add(s.fromMemberId, s.amountMinor);
    add(s.toMemberId, -s.amountMinor);
  }
  return Object.fromEntries(group.members.map((m) => [m.displayName, byId.get(m.id) ?? 0]));
}

const FX_ROUTE = 'https://api.frankfurter.dev/**';
const RATES = [
  { date: '2026-11-16', base: 'EUR', quote: 'INR', rate: 104.15 },
  { date: '2026-11-16', base: 'EUR', quote: 'USD', rate: 1.1072 },
  { date: '2026-11-16', base: 'EUR', quote: 'JPY', rate: 177.06 },
  { date: '2026-11-16', base: 'EUR', quote: 'KWD', rate: 0.34304 },
];
const mockRates = (page: Page, rates = RATES) =>
  page.route(FX_ROUTE, (route) => route.fulfill({ json: rates, headers: { 'access-control-allow-origin': '*' } }));

test.describe('Splitwise import (P1-7)', () => {
  test.beforeEach(async ({ page }) => {
    await mockRates(page);
  });

  test('a currency without a known rate must get a manual rate before anything is imported', async ({ page }) => {
    await mockRates(page, RATES.filter((r) => r.quote !== 'JPY'));
    const name = uniq('SW NoRate');
    const group = await createGroup(page, name, ['Rohan Verma']);
    await openPortability(page, group.id);
    await page.getByTestId('splitwise-file-input').setInputFiles({ name: 'splitwise.csv', mimeType: 'text/csv', buffer: Buffer.from(FIXTURE) });
    await expect(page.getByTestId('splitwise-fx-rates')).toContainText('No exchange rate is available for JPY');
    await expect(page.getByTestId('splitwise-fx-rate-USD')).toHaveCount(0);
    await expect(page.getByTestId('confirm-splitwise-import-btn')).toBeDisabled();
    expect((await readLedger(page)).expenses.filter((e) => e.groupId === group.id)).toEqual([]);

    await page.getByTestId('splitwise-fx-rate-JPY').fill('0.56');
    await page.getByTestId('confirm-splitwise-import-btn').click();
    await expect(page.getByTestId('splitwise-import-result')).toContainText('Imported 7 bills and 2 payments');
    const bills = (await readLedger(page)).expenses.filter((e) => e.groupId === group.id) as unknown as Array<{ originalCurrency: string; fxStatus: string; fxAuditNote: string | null }>;
    for (const b of bills.filter((x) => x.originalCurrency === 'JPY')) {
      expect(b.fxStatus).toBe('manual');
      expect(b.fxAuditNote).toContain('1 JPY = 0.56 INR (manual rate');
    }
    expect(bills.filter((x) => x.originalCurrency === 'USD').every((b) => b.fxStatus === 'live')).toBe(true);
  });

  test('a Splitwise file with payments and unknown names imports with balances equal to Splitwise', async ({ page }) => {
    const name = uniq('SW Import');
    const group = await createGroup(page, name, ['Rohan Verma', 'Priya Nair']);
    await openPortability(page, group.id);

    const inrOnly = FIXTURE.split('\n').filter((l, i) => i === 0 || l.includes(',INR,')).join('\n');
    await page.getByTestId('splitwise-file-input').setInputFiles({ name: 'splitwise.csv', mimeType: 'text/csv', buffer: Buffer.from(inrOnly) });

    const mapping = page.getByTestId('splitwise-member-mapping');
    await expect(mapping).toContainText('Nair, Priya');
    await expect(mapping).toContainText('Zoe Ito');
    const priya = group.members.find((m) => m.displayName === 'Priya Nair')!;
    await page.getByTestId('splitwise-map-0').selectOption(priya.id);
    await page.getByTestId('confirm-splitwise-import-btn').click();
    await expect(page.getByTestId('splitwise-import-result')).toContainText('Imported 4 bills and 1 payments');

    let after: Group = group;
    await expect.poll(async () => (after = await groupNamed(page, name)).members.map((m) => m.displayName).sort()).toEqual(
      ['Arjun Mehta', 'Priya Nair', 'Rohan Verma', 'Zoe Ito']
    );
    await expect
      .poll(async () => nets(await readLedger(page), after))
      .toEqual({ 'Arjun Mehta': 325000, 'Rohan Verma': 165000, 'Priya Nair': -265000, 'Zoe Ito': -225000 });

    await page.getByTestId('export-from-date').fill('2026-10-02');
    await page.getByTestId('export-to-date').fill('2026-10-03');
    const csv = await download(page, () => page.getByRole('button', { name: /Download \.CSV/ }).click());
    expect(csv.name).toMatch(/^wise-spliter-sw-import-[a-z0-9]+-2026-10-02-to-2026-10-03\.csv$/);
    expect(csv.text).toContain('Cab to airport');
    expect(csv.text).toContain('SETTLEMENT,2026-10-03');
    expect(csv.text).not.toContain('tapas');
    expect(csv.text).not.toContain('Villa, Goa');
  });

  test('the full multi-currency fixture imports every bill and payment', async ({ page }) => {
    const name = uniq('SW Multi');
    const group = await createGroup(page, name, ['Rohan Verma']);
    await openPortability(page, group.id);
    await page.getByTestId('splitwise-file-input').setInputFiles({ name: 'splitwise.csv', mimeType: 'text/csv', buffer: Buffer.from(FIXTURE) });
    await page.getByTestId('confirm-splitwise-import-btn').click();
    await expect(page.getByTestId('splitwise-import-result')).toContainText('Imported 7 bills and 2 payments');
    let after: Group = group;
    await expect.poll(async () => (after = await groupNamed(page, name)).members.length).toBe(4);
    const n = await (async () => {
      let v: Record<string, number> = {};
      await expect.poll(async () => Object.keys((v = nets(await readLedger(page), after))).length).toBe(4);
      return v;
    })();
    expect(Object.values(n).reduce((a, b) => a + b, 0)).toBe(0);
    expect(Object.keys(n).sort()).toEqual(['Arjun Mehta', 'Nair, Priya', 'Rohan Verma', 'Zoe Ito']);
  });
});

test.describe('Encrypted backup (P1-10)', () => {
  test('no default passphrase, strength and confirmation required, empty restore never succeeds', async ({ page }) => {
    await page.goto('/');
    await openPortability(page);
    await expect(page.getByTestId('backup-passphrase-input')).toHaveValue('');
    await expect(page.getByTestId('backup-include-receipts-toggle')).not.toBeChecked();

    await page.getByTestId('decrypt-restore-btn').click();
    await expect(page.getByTestId('backup-error')).toContainText('Nothing was changed');
    await expect(page.getByTestId('backup-restore-success')).toHaveCount(0);

    await page.getByTestId('backup-passphrase-input').fill('short pass');
    await page.getByTestId('backup-passphrase-confirm-input').fill('short pass');
    await page.getByTestId('generate-encrypted-backup-btn').click();
    await expect(page.getByTestId('backup-error')).toContainText('at least 12');
    await expect(page.getByTestId('encrypted-backup-output')).toHaveValue('');

    await page.getByTestId('backup-passphrase-input').fill(PASS);
    await page.getByTestId('backup-passphrase-confirm-input').fill(`${PASS}!`);
    await page.getByTestId('generate-encrypted-backup-btn').click();
    await expect(page.getByTestId('backup-error')).toContainText('do not match');
    await expect(page.getByTestId('encrypted-backup-output')).toHaveValue('');

    await page.getByTestId('restore-backup-file-input').setInputFiles({ name: 'empty.wisesplit', mimeType: 'application/json', buffer: Buffer.alloc(0) });
    await expect(page.getByTestId('backup-error')).toContainText('empty.wisesplit');
    await page.getByTestId('decrypt-restore-btn').click();
    await expect(page.getByTestId('backup-error')).toContainText('Nothing was changed');
    await expect(page.getByTestId('backup-restore-success')).toHaveCount(0);
  });

  test('a downloaded .wisesplit file restores in a fresh browser; a wrong passphrase changes nothing', async ({ page, browser, baseURL }) => {
    const name = uniq('Backup File');
    await createGroup(page, name, ['Bina Rao']);
    await openPortability(page);
    await page.getByTestId('backup-passphrase-input').fill(PASS);
    await page.getByTestId('backup-passphrase-confirm-input').fill(PASS);
    await page.getByTestId('generate-encrypted-backup-btn').click();
    await expect(page.getByTestId('encrypted-backup-output')).toContainText('PBKDF2-SHA256-600000');
    const file = await download(page, () => page.getByTestId('download-encrypted-backup-btn').click());
    expect(file.name).toMatch(/^wise-spliter-backup-\d{4}-\d{2}-\d{2}\.wisesplit$/);
    expect(file.text).not.toContain(name);
    expect(file.text).not.toContain('data:image');

    const ctx = await browser.newContext({ baseURL });
    const fresh = await ctx.newPage();
    await fresh.goto('/');
    await openPortability(fresh);
    await fresh.getByTestId('restore-backup-file-input').setInputFiles(file.path);
    await expect(fresh.getByText(/Using .*\.wisesplit/)).toBeVisible();
    const before = await snapshot(fresh);

    await fresh.getByTestId('backup-passphrase-input').fill('wrong horse battery staple');
    await fresh.getByTestId('decrypt-restore-btn').click();
    await expect(fresh.getByTestId('backup-error')).toContainText(/Decryption failed/);
    await expect(fresh.getByTestId('backup-restore-success')).toHaveCount(0);
    expect(await snapshot(fresh)).toBe(before);

    await fresh.getByTestId('backup-passphrase-input').fill(PASS);
    await fresh.getByTestId('decrypt-restore-btn').click();
    await expect(fresh.getByTestId('backup-restore-success')).toContainText('Verified & Restored');
    await expect.poll(async () => (await readLedger(fresh)).groups?.some((g) => g.name === name)).toBe(true);
    await ctx.close();
  });
});

test.describe('Exports (P1-14)', () => {
  test('direct (non-group) bills export to CSV, XLSX and PDF with safe file names', async ({ page }) => {
    await page.goto('/');
    await openPortability(page);
    await page.getByTestId('export-scope-select').selectOption('direct');
    await expect(page.getByTestId('csv-export-preview')).toContainText('Blue Tokai');
    const csv = await download(page, () => page.getByRole('button', { name: /Download \.CSV/ }).click());
    expect(csv.name).toBe('wise-spliter-direct-bills.csv');
    expect(csv.text).toContain('Blue Tokai');
    expect(csv.text).toContain(',INR,840.00,');
    const xlsx = await download(page, () => page.getByTestId('download-xlsx-btn').click());
    expect(xlsx.name).toBe('wise-spliter-direct-bills.xlsx');
    const pdf = await download(page, () => page.getByTestId('download-pdf-btn').click());
    expect(pdf.name).toBe('wise-spliter-direct-bills.pdf');
    expect(pdf.text.startsWith('%PDF-')).toBe(true);
    expect(pdf.text).toContain('Blue Tokai');
  });
});

test.describe('Plain device backup restore (Start fresh file)', () => {
  test.describe.configure({ timeout: 120_000 });
  const SAMPLE_IDS = new Set<string>([
    ...mockData.groups.flatMap((g) => [g.id, ...g.members.map((m) => m.id)]),
    ...mockData.expenses.map((e) => e.id),
    ...mockData.expenseRevisions.map((r) => r.id),
    ...mockData.settlements.map((s) => s.id),
    ...mockData.groupActivityLog.map((a) => a.id),
  ]);

  test('the encrypted backup offered by "Start fresh" restores after sign-in, with no sample rows pushed', async ({ page }) => {
    const devPassword = process.env.DEV_USER_PASSWORD?.trim();
    if (!devPassword) throw new Error('DEV_USER_PASSWORD is required (see .env.example)');
    const pushedIds: string[] = [];
    page.on('request', (req) => {
      if (!req.url().includes('/api/ledger/push')) return;
      try {
        pushedIds.push(...(JSON.parse(req.postData() ?? '{}') as { mutations: Array<{ id: string }> }).mutations.map((m) => m.id));
      } catch {
        // not JSON
      }
    });

    const name = uniq('Fresh Restore');
    await createGroup(page, name, ['Bina Rao']);
    if (!(await page.getByTestId('dev-auth-modal').isVisible())) await page.getByTestId('header-user-pill').click();
    await page.getByTestId('dev-login-email-input').fill('rohan.verma@example.com');
    await page.getByTestId('dev-login-password-input').fill(devPassword);
    await page.getByTestId('dev-login-submit-btn').click();
    await page.getByTestId('local-data-fresh-btn').click();
    await page.getByTestId('local-data-passphrase-input').fill(PASS);
    await page.getByTestId('local-data-passphrase-confirm-input').fill(PASS);
    const file = await download(page, () => page.getByTestId('local-data-backup-btn').click());
    expect(file.name).toMatch(/\.wisesplit$/);
    expect(file.text).not.toContain(name);
    await page.getByTestId('local-data-wipe-btn').click();
    await expect(page.getByTestId('local-data-import-dialog')).toBeHidden();
    await expect.poll(async () => (await readLedger(page)).groups.some((g) => g.name === name)).toBe(false);

    await openPortability(page);
    await page.getByTestId('restore-backup-file-input').setInputFiles(file.path);
    await expect(page.getByTestId('backup-plain-note')).toHaveCount(0);
    await page.getByTestId('backup-passphrase-input').fill(PASS);
    await page.getByTestId('decrypt-restore-btn').click();
    await expect(page.getByTestId('backup-restore-success')).toContainText('AES-256-GCM');
    const restoredGroup = await groupNamed(page, name);
    await page.getByTestId('trigger-sync-btn').click();
    await expect.poll(() => pushedIds.includes(restoredGroup.id), { timeout: 30_000, message: 'restored group pushed' }).toBe(true);
    expect(pushedIds.filter((id) => SAMPLE_IDS.has(id))).toEqual([]);
  });

  test('a plain JSON device backup downloaded by an older version still restores, flagged as unencrypted', async ({ page }) => {
    const name = uniq('Plain Old');
    const src = mockData.groups[0]!;
    const gid = `grp_plain_${Math.random().toString(36).slice(2, 8)}`;
    const group = { ...src, id: gid, name, members: src.members.map((m) => ({ ...m, id: `${m.id}_${gid}`, groupId: gid })) };
    const plain = JSON.stringify({ ...mockData, groups: [group], expenses: [], settlements: [], expenseRevisions: [], groupActivityLog: [] });
    await page.goto('/');
    await openPortability(page);
    await page.getByTestId('restore-backup-file-input').setInputFiles({ name: 'wise-spliter-device-backup-2026-11-01.json', mimeType: 'application/json', buffer: Buffer.from(plain) });
    await expect(page.getByTestId('backup-plain-note')).toBeVisible();
    await page.getByTestId('decrypt-restore-btn').click();
    await expect(page.getByTestId('backup-restore-success')).toContainText('unencrypted backup file');
    await expect.poll(async () => (await readLedger(page)).groups.some((g) => g.name === name)).toBe(true);
  });

  test('a malformed plain JSON file is refused and nothing changes', async ({ page }) => {
    await page.goto('/');
    await openPortability(page);
    const before = await snapshot(page);
    const bad = JSON.stringify({ ...mockData, expenses: [{ ...mockData.expenses[0], amountMinor: 'lots' }] });
    await page.getByTestId('restore-backup-file-input').setInputFiles({ name: 'device-backup.json', mimeType: 'application/json', buffer: Buffer.from(bad) });
    await expect(page.getByTestId('backup-plain-note')).toBeVisible();
    await page.getByTestId('decrypt-restore-btn').click();
    await expect(page.getByTestId('backup-error')).toContainText('Nothing was changed');
    await expect(page.getByTestId('backup-restore-success')).toHaveCount(0);
    expect(await snapshot(page)).toBe(before);
  });
});

test.describe('Review hardening', () => {
  test('a crafted backup is refused, nothing changes, and every page still renders', async ({ page }) => {
    await page.goto('/');
    await openPortability(page);
    const before = await snapshot(page);
    const probe = { currentUser: { id: 'u' }, groups: [], expenses: [], settlements: [], expenseRevisions: [null, 5], groupActivityLog: [null] };
    await page.getByTestId('restore-backup-file-input').setInputFiles({ name: 'crafted.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(probe)) });
    await page.getByTestId('decrypt-restore-btn').click();
    await expect(page.getByTestId('backup-error')).toContainText('Nothing was changed');
    await expect(page.getByTestId('backup-restore-success')).toHaveCount(0);
    expect(await snapshot(page)).toBe(before);
    for (const tab of ['home', 'groups', 'activity', 'friends', 'analytics', 'portability']) {
      const nav = page.getByTestId(`nav-tab-${tab}`).first();
      if (await nav.count()) await nav.click();
      await expect(page.locator('#root')).not.toBeEmpty();
    }
  });

  test('malformed Splitwise JSON shows a calm error; bad CSV rows are listed and balance mismatches warned', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/');
    await openPortability(page);
    const input = page.getByTestId('splitwise-file-input');
    await input.setInputFiles({ name: 'sw.json', mimeType: 'application/json', buffer: Buffer.from('{not json') });
    await expect(page.getByTestId('splitwise-parse-error')).toContainText('not valid JSON');
    await input.setInputFiles({
      name: 'sw.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify([{ description: 'Null user', cost: '5', currency_code: 'INR', date: '2026-02-03', users: [null] }, { description: 'Obj users', cost: '5', currency_code: 'INR', date: '2026-02-03', users: { a: 1 } }])),
    });
    await expect(page.getByTestId('splitwise-skipped-rows')).toContainText('Null user');
    await expect(page.getByTestId('splitwise-skipped-rows')).toContainText('Obj users');

    const csv = [
      'Date,Description,Category,Cost,Currency,Arjun Mehta,Rohan Verma',
      '2026-01-01,Dinner,Dining out,90.00,INR,45.00,-45.00',
      '2026-01-02,Bad cost,General,abc,INR,10.00,-10.00',
      ',Total balance,,,INR,55.00,-55.00',
    ].join('\n');
    await input.setInputFiles({ name: 'sw.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await expect(page.getByTestId('splitwise-skipped-rows')).toContainText('Line 3, Bad cost');
    await expect(page.getByTestId('splitwise-balance-mismatch')).toContainText('Arjun Mehta (INR): Splitwise says 55.00, this import gives 45.00');
    await page.getByTestId('confirm-splitwise-import-btn').click();
    await expect(page.getByTestId('splitwise-import-result')).toContainText('1 row was skipped');
    expect(errors).toEqual([]);
  });

  test('an export that fails says so instead of reporting success', async ({ page }) => {
    await page.goto('/');
    await openPortability(page);
    await page.evaluate(() => {
      URL.createObjectURL = () => {
        throw new Error('blocked');
      };
    });
    await page.getByTestId('download-xlsx-btn').click();
    await expect(page.getByTestId('toast-banner')).toContainText('could not be created');
    await page.getByTestId('download-pdf-btn').click();
    await expect(page.getByTestId('toast-banner')).toContainText('could not be created');
  });
});

test.describe('Restoring an older backup (final review)', () => {
  test('a bill edited after the backup keeps the newer edit and the message says so', async ({ page }) => {
    const name = uniq('Older Backup');
    const group = await createGroup(page, name, ['Bina Rao']);
    await page.getByTestId('add-expense-btn').click();
    await page.getByTestId('expense-title-input').fill('Before backup');
    await page.getByTestId('expense-amount-input').fill('100');
    await page.getByTestId('save-expense-btn').click();
    await expect(page.getByTestId('expense-title-input')).toBeHidden();

    await openPortability(page);
    await page.getByTestId('backup-passphrase-input').fill(PASS);
    await page.getByTestId('backup-passphrase-confirm-input').fill(PASS);
    await page.getByTestId('generate-encrypted-backup-btn').click();
    await expect(page.getByTestId('encrypted-backup-output')).toContainText('AES-256-GCM');
    const cipher = await page.getByTestId('encrypted-backup-output').inputValue();

    await page.getByTestId('nav-tab-groups').first().click();
    const pick = page.getByTestId(`group-select-${group.id}`);
    if (await pick.count()) await pick.click();
    const card = page
      .locator('div')
      .filter({ has: page.getByRole('heading', { name: 'Before backup', exact: true }) })
      .filter({ has: page.getByRole('button', { name: 'Edit', exact: true }) })
      .last();
    await card.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByTestId('expense-title-input').fill('Edited after backup');
    await page.getByTestId('save-expense-btn').click();
    await expect(page.getByTestId('expense-title-input')).toBeHidden();

    await openPortability(page);
    await page.getByTestId('encrypted-backup-output').fill(cipher);
    await page.getByTestId('backup-passphrase-input').fill(PASS);
    await page.getByTestId('decrypt-restore-btn').click();
    await expect(page.getByTestId('backup-restore-success')).toContainText("kept this device's newer copy of 1 item");
    const titles = (await readLedger(page)).expenses.filter((e) => e.groupId === group.id).map((e) => (e as unknown as { title: string }).title);
    expect(titles).toEqual(['Edited after backup']);
  });
});
