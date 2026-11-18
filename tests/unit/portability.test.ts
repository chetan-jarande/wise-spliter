import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import mockData from '../../src/data/mock-ledger-data.json';
import { diffDatasetToMutations } from '../../src/sync-engine/sync-client';
import {
  computeCrossGroupFriendsSummary,
  computeGroupNetBalances,
  computeRawPairwiseTransfers,
  explainMemberBalance,
  simplifyGroupDebts,
} from '../../src/domain/ledger/ledger-engine';
import { convertForeignToBaseMinor, parseFxRateToScaled } from '../../src/domain/money/currencies';
import {
  BackupRestoreError,
  DIRECT_EXPORT_SCOPE,
  MIN_BACKUP_PASSPHRASE_LENGTH,
  PBKDF2_ITERATIONS,
  backupPassphraseProblem,
  backupFileKind,
  buildBackupJson,
  buildSplitwiseImportPlan,
  bytesToBase64,
  encryptBackupPayload,
  exportGroupToCsv,
  exportGroupToExcelBuffer,
  exportGroupToPdfBytes,
  generateWhatsAppGroupSummary,
  openBackupBundle,
  openBackupFile,
  mergeLedgerEntities,
  decryptBackupPayload,
  parseSplitwiseCsv,
  parseSplitwiseImport,
  parseSplitwiseJson,
  resolveSplitwiseMembers,
  safeExportFileName,
  selectExportLedger,
  type ParsedSplitwiseImport,
  type SplitwiseImportFx,
} from '../../src/portability/portability-engine';
import type {
  ExpenseItem,
  GroupMember,
  GroupRecord,
  MockLedgerDataset,
  SettlementItem,
} from '../../src/types/ledger';

const FIXTURE = readFileSync(new URL('../fixtures/splitwise-export.csv', import.meta.url), 'utf8');
const FX = { INR: 1, USD: 83.5, JPY: 0.56, KWD: 271.2 };
const fxFor: SplitwiseImportFx = (c) =>
  c in FX
    ? { fxRateScaled: parseFxRateToScaled(String(FX[c as keyof typeof FX])), fxStatus: 'live', fxRateDate: '2026-10-01' }
    : null;

function member(id: string, displayName: string): GroupMember {
  return {
    id,
    groupId: 'grp_test',
    userId: null,
    invitedEmail: null,
    displayName,
    avatarInitials: displayName.slice(0, 2).toUpperCase(),
    upiId: null,
    role: 'member',
    memberOrder: 0,
    joinedAt: '2026-01-01T00:00:00.000Z',
    claimedAt: null,
  };
}

/** Per-name, per-currency nets straight from parsed rows (paid - owed, payer of a payment +, payee -). */
function parsedNets(parsed: ParsedSplitwiseImport): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  const add = (cur: string, name: string, v: number) => {
    out[cur] ??= {};
    out[cur][name] = (out[cur][name] ?? 0) + v;
  };
  for (const e of parsed.expenses) {
    for (const p of e.payers) add(e.currency, p.memberName, p.paidMinor);
    for (const s of e.splits) add(e.currency, s.memberName, -s.owedMinor);
  }
  for (const p of parsed.payments) {
    add(p.currency, p.fromName, p.amountMinor);
    add(p.currency, p.toName, -p.amountMinor);
  }
  for (const cur of Object.keys(out)) {
    for (const name of parsed.memberNames) out[cur]![name] ??= 0;
  }
  return out;
}

function asLedgerRows(plan: ReturnType<typeof buildSplitwiseImportPlan>, filter?: (cur: string) => boolean) {
  const expenses = plan.expenses
    .filter((e) => !filter || filter(e.originalCurrency))
    .map((e) => ({ ...e, deletedAt: null }) as unknown as ExpenseItem);
  const settlements = plan.settlements
    .filter((s) => !filter || filter(s.originalCurrency))
    .map((s) => ({ ...s, deletedAt: null }) as unknown as SettlementItem);
  return { expenses, settlements };
}

describe('P1-7 Splitwise import', () => {
  const parsed = parseSplitwiseCsv(FIXTURE);
  const members = [member('m_arjun', 'Arjun Mehta'), member('m_rohan', 'rohan verma'), member('m_priya', 'Priya Nair')];

  it('parses expenses, payment rows, quoted commas and every Total balance row', () => {
    expect(parsed.memberNames).toEqual(['Arjun Mehta', 'Rohan Verma', 'Nair, Priya', 'Zoe Ito']);
    expect(parsed.expenses.map((e) => e.title)).toEqual([
      'Dinner, drinks & "tapas"',
      'Cab to airport',
      'Villa, Goa',
      'Solo coffee',
      'Museum, tickets',
      'Ramen',
      'Grill',
    ]);
    expect(parsed.payments).toEqual([
      { date: '2026-10-03', title: 'Rohan V. paid Arjun M.', fromName: 'Rohan Verma', toName: 'Arjun Mehta', currency: 'INR', amountMinor: 30000 },
      { date: '2026-10-07', title: 'Priya N. paid Arjun M.', fromName: 'Nair, Priya', toName: 'Arjun Mehta', currency: 'USD', amountMinor: 1000 },
    ]);
    expect(Object.keys(parsed.totalBalances).sort()).toEqual(['INR', 'JPY', 'KWD', 'USD']);
    expect(parsed.totalBalances.KWD).toEqual({ 'Arjun Mehta': -8334, 'Rohan Verma': 16666, 'Nair, Priya': -8332, 'Zoe Ito': 0 });
  });

  it('parsed rows reproduce the Splitwise Total balance row of every currency exactly', () => {
    expect(parsedNets(parsed)).toEqual(parsed.totalBalances);
    for (const e of parsed.expenses) {
      expect(e.payers.reduce((a, p) => a + p.paidMinor, 0)).toBe(e.amountMinor);
      expect(e.splits.reduce((a, s) => a + s.owedMinor, 0)).toBe(e.amountMinor);
    }
  });

  it('a zero-net row books nothing to anyone instead of an equal split paid by the first member', () => {
    const coffee = parsed.expenses.find((e) => e.title === 'Solo coffee')!;
    for (const name of parsed.memberNames) {
      const paid = coffee.payers.find((p) => p.memberName === name)?.paidMinor ?? 0;
      const owed = coffee.splits.find((s) => s.memberName === name)?.owedMinor ?? 0;
      expect(paid - owed, name).toBe(0);
    }
  });

  it('lists unmatched names, applies explicit mappings and never falls back to the first member', () => {
    const none = resolveSplitwiseMembers(parsed.memberNames, members, {});
    expect(none.toCreate).toEqual(['Nair, Priya', 'Zoe Ito']);
    expect(none.idByName.get('Arjun Mehta')).toBe('m_arjun');
    expect(none.idByName.get('Rohan Verma')).toBe('m_rohan');
    expect(none.idByName.has('Zoe Ito')).toBe(false);

    const mapped = resolveSplitwiseMembers(parsed.memberNames, members, { 'Nair, Priya': 'm_priya' });
    expect(mapped.toCreate).toEqual(['Zoe Ito']);
    expect(mapped.idByName.get('Nair, Priya')).toBe('m_priya');

    expect(() =>
      buildSplitwiseImportPlan({
        parsed,
        idByName: none.idByName,
        memberIds: members.map((m) => m.id),
        baseCurrency: 'INR',
        fxFor,
      })
    ).toThrow(/Zoe Ito/);
  });

  const resolved = resolveSplitwiseMembers(parsed.memberNames, members, { 'Nair, Priya': 'm_priya' });
  resolved.idByName.set('Zoe Ito', 'm_zoe');
  const memberIds = [...members.map((m) => m.id), 'm_zoe'];
  const plan = buildSplitwiseImportPlan({ parsed, idByName: resolved.idByName, memberIds, baseCurrency: 'INR', fxFor });
  const idToName = new Map([...resolved.idByName].map(([name, id]) => [id, name]));

  it('never converts a currency without a rate: the plan is empty and lists what needs a manual rate', () => {
    const noUsdNoJpy: SplitwiseImportFx = (c) => (c === 'USD' || c === 'JPY' ? null : fxFor(c));
    const blocked = buildSplitwiseImportPlan({ parsed, idByName: resolved.idByName, memberIds, baseCurrency: 'INR', fxFor: noUsdNoJpy });
    expect(blocked).toEqual({ expenses: [], settlements: [], missingRates: ['JPY', 'USD'] });
    expect(plan.missingRates).toEqual([]);
    expect(plan.expenses.find((e) => e.originalCurrency === 'USD')).toMatchObject({ fxStatus: 'live', fxRateDate: '2026-10-01' });
  });

  it('imports payment rows as settlements', () => {
    expect(plan.expenses).toHaveLength(7);
    expect(plan.settlements).toHaveLength(2);
    expect(plan.settlements[0]).toMatchObject({ fromMemberId: 'm_rohan', toMemberId: 'm_arjun', amountMinor: 30000, settledDate: '2026-10-03' });
    const usd = plan.settlements[1]!;
    expect(usd).toMatchObject({ fromMemberId: 'm_priya', toMemberId: 'm_arjun', originalCurrency: 'USD', originalAmountMinor: 1000 });
    expect(usd.amountMinor).toBe(Number(convertForeignToBaseMinor(1000, 'USD', 'INR', parseFxRateToScaled('83.5'))));
    expect(usd.notes).toContain('10.00 USD');
  });

  it('group balances for same-currency rows equal the Splitwise INR Total balance exactly', () => {
    const { expenses, settlements } = asLedgerRows(plan, (c) => c === 'INR');
    const nets = computeGroupNetBalances(expenses, settlements, memberIds.map((id) => member(id, id)));
    const byName = Object.fromEntries([...nets].map(([id, v]) => [idToName.get(id)!, v]));
    expect(byName).toEqual(parsed.totalBalances.INR);
  });

  it('original-currency nets equal every Splitwise Total balance row exactly; base nets sum to zero', () => {
    const orig: Record<string, Record<string, number>> = {};
    const add = (cur: string, id: string, v: number) => {
      orig[cur] ??= Object.fromEntries(parsed.memberNames.map((n) => [n, 0]));
      orig[cur][idToName.get(id)!] = (orig[cur][idToName.get(id)!] ?? 0) + v;
    };
    for (const e of plan.expenses) {
      expect(e.payers.reduce((a, p) => a + p.originalPaidMinor, 0)).toBe(e.originalAmountMinor);
      for (const p of e.payers) add(e.originalCurrency, p.memberId, p.originalPaidMinor);
      for (const s of e.splits) if (s.included) add(e.originalCurrency, s.memberId, -s.originalOwedMinor);
    }
    for (const s of plan.settlements) {
      add(s.originalCurrency, s.fromMemberId, s.originalAmountMinor);
      add(s.originalCurrency, s.toMemberId, -s.originalAmountMinor);
    }
    expect(orig).toEqual(parsed.totalBalances);

    const { expenses, settlements } = asLedgerRows(plan);
    for (const e of plan.expenses) {
      const amount = e.payers.reduce((a, p) => a + p.paidMinor, 0);
      expect(e.splits.filter((s) => s.included).reduce((a, s) => a + s.owedMinor, 0)).toBe(amount);
    }
    const nets = computeGroupNetBalances(expenses, settlements, memberIds.map((id) => member(id, id)));
    expect([...nets.values()].reduce((a, b) => a + b, 0)).toBe(0);
    for (const [id, net] of nets) {
      const name = idToName.get(id)!;
      const expected = Object.entries(parsed.totalBalances).reduce((acc, [cur, row]) => {
        const rate = cur === 'INR' ? 100000000 : parseFxRateToScaled(String(FX[cur as keyof typeof FX]));
        return acc + Number(convertForeignToBaseMinor(row[name] ?? 0, cur, 'INR', rate));
      }, 0);
      // Each converted row rounds to the nearest paisa; the drift is bounded by the foreign row count.
      expect(Math.abs(net - expected), name).toBeLessThanOrEqual(4);
    }
  });

  it('two Splitwise names mapped to one member merge into that member', () => {
    const merged = resolveSplitwiseMembers(parsed.memberNames, members, { 'Nair, Priya': 'm_priya', 'Zoe Ito': 'm_priya' });
    expect(merged.toCreate).toEqual([]);
    const p = buildSplitwiseImportPlan({ parsed, idByName: merged.idByName, memberIds: members.map((m) => m.id), baseCurrency: 'INR', fxFor });
    const { expenses, settlements } = asLedgerRows(p, (c) => c === 'INR');
    const nets = computeGroupNetBalances(expenses, settlements, members);
    expect(nets.get('m_priya')).toBe(-2650_00 - 2250_00);
  });

  it('parses the Splitwise API JSON shape, including payments and deleted rows', () => {
    const json = JSON.stringify({
      expenses: [
        {
          description: 'Groceries, weekly',
          cost: '90.0',
          currency_code: 'EUR',
          date: '2026-09-01T10:00:00Z',
          payment: false,
          deleted_at: null,
          category: { name: 'Groceries' },
          users: [
            { user: { first_name: 'Ann', last_name: 'Lee' }, paid_share: '90.0', owed_share: '30.0' },
            { user: { first_name: 'Ben', last_name: null }, paid_share: '0.0', owed_share: '60.0' },
          ],
        },
        {
          description: 'Payment',
          cost: '20.0',
          currency_code: 'EUR',
          date: '2026-09-02T10:00:00Z',
          payment: true,
          deleted_at: null,
          users: [
            { user: { first_name: 'Ben' }, paid_share: '20.0', owed_share: '0.0' },
            { user: { first_name: 'Ann', last_name: 'Lee' }, paid_share: '0.0', owed_share: '20.0' },
          ],
        },
        { description: 'Deleted', cost: '5', currency_code: 'EUR', date: '2026-09-03', deleted_at: '2026-09-04', users: [] },
      ],
    });
    const j = parseSplitwiseJson(json);
    expect(j.memberNames).toEqual(['Ann Lee', 'Ben']);
    expect(j.expenses).toHaveLength(1);
    expect(j.expenses[0]).toMatchObject({ title: 'Groceries, weekly', date: '2026-09-01', category: 'groceries', amountMinor: 9000 });
    expect(j.payments).toEqual([{ date: '2026-09-02', title: 'Payment', fromName: 'Ben', toName: 'Ann Lee', currency: 'EUR', amountMinor: 2000 }]);
    expect(parsedNets(j)).toEqual({ EUR: { 'Ann Lee': 4000, Ben: -4000 } });
    expect(parseSplitwiseImport(json).expenses).toHaveLength(1);
    expect(parseSplitwiseImport(FIXTURE).payments).toHaveLength(2);
    expect(parseSplitwiseImport('{not json').expenses).toEqual([]);
    expect(parseSplitwiseImport('').expenses).toEqual([]);
  });
});

const sampleDataset = mockData as unknown as MockLedgerDataset;

describe('P1-10 encrypted backup', () => {
  it('uses the current OWASP PBKDF2-SHA256 work factor, a 128-bit salt and a fresh 96-bit IV', async () => {
    expect(PBKDF2_ITERATIONS).toBeGreaterThanOrEqual(600_000);
    const a = JSON.parse(await encryptBackupPayload('{"x":1}', 'a long enough passphrase')) as Record<string, string>;
    const b = JSON.parse(await encryptBackupPayload('{"x":1}', 'a long enough passphrase')) as Record<string, string>;
    expect(a.cipher).toBe('AES-256-GCM');
    expect(a.kdf).toBe(`PBKDF2-SHA256-${PBKDF2_ITERATIONS}`);
    expect(Buffer.from(a.iv!, 'base64')).toHaveLength(12);
    expect(Buffer.from(a.salt!, 'base64')).toHaveLength(16);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  }, 30_000);

  it('requires a confirmed passphrase of at least 12 characters', () => {
    expect(MIN_BACKUP_PASSPHRASE_LENGTH).toBe(12);
    expect(backupPassphraseProblem('', '')).toMatch(/at least 12/);
    expect(backupPassphraseProblem('short pass', 'short pass')).toMatch(/at least 12/);
    expect(backupPassphraseProblem('            ', '            ')).toMatch(/at least 12/);
    expect(backupPassphraseProblem('correct horse battery', 'correct horse batery')).toMatch(/do not match/);
    expect(backupPassphraseProblem('correct horse battery', 'correct horse battery')).toBeNull();
  });

  it('round-trips a dataset and fails calmly on empty, foreign, tampered or wrong-passphrase input', async () => {
    const pass = 'correct horse battery';
    const bundle = await encryptBackupPayload(buildBackupJson(sampleDataset, null), pass);
    const restored = await openBackupBundle(bundle, pass);
    expect(restored.groups.length).toBe(sampleDataset.groups.length);

    const code = async (text: string, p = pass) => {
      try {
        await openBackupBundle(text, p);
        return 'ok';
      } catch (err) {
        expect(err).toBeInstanceOf(BackupRestoreError);
        expect((err as Error).message).not.toMatch(/[\u2013\u2014]/);
        return (err as BackupRestoreError).code;
      }
    };
    expect(await code('')).toBe('empty');
    expect(await code('   \n')).toBe('empty');
    expect(await code(bundle, '')).toBe('passphrase');
    expect(await code(bundle, 'wrong horse battery')).toBe('passphrase');
    expect(await code('{"not":"a backup"}')).toBe('format');
    expect(await code('hello')).toBe('format');
    const parsed = JSON.parse(bundle) as Record<string, string>;
    const ct = Buffer.from(parsed.ciphertext!, 'base64');
    ct[0] = ct[0]! ^ 1;
    expect(await code(JSON.stringify({ ...parsed, ciphertext: ct.toString('base64') }))).toBe('passphrase');
    expect(await code(await encryptBackupPayload('{"groups":"nope"}', pass))).toBe('schema');
  }, 60_000);

  it('still opens legacy 100k-iteration backups', async () => {
    const enc = new TextEncoder();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const material = await crypto.subtle.importKey('raw', enc.encode('legacy passphrase'), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt']
    );
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(buildBackupJson(sampleDataset, null)));
    const legacy = JSON.stringify({
      format: 'wise-spliter-encrypted-v1',
      cipher: 'AES-256-GCM',
      kdf: 'PBKDF2-SHA256-100000',
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
      ciphertext: bytesToBase64(new Uint8Array(ct)),
    });
    expect((await openBackupBundle(legacy, 'legacy passphrase')).groups.length).toBe(sampleDataset.groups.length);
  }, 30_000);

  it('leaves receipt image bytes out unless the user opts in', () => {
    const withBytes = structuredClone(sampleDataset);
    const exp = withBytes.expenses[0]!;
    exp.receipts = [
      { id: 'rcp_1', expenseId: exp.id, fileName: 'r.webp', mimeType: 'image/webp', sizeKb: 1, uploadedByName: 'A', createdAt: '', previewNote: '', dataUrl: 'data:image/webp;base64,AAAA' },
      { id: 'rcp_2', expenseId: exp.id, fileName: 's.webp', mimeType: 'image/webp', sizeKb: 1, uploadedByName: 'A', createdAt: '', previewNote: '' },
    ];
    const plain = buildBackupJson(withBytes, null);
    expect(plain).not.toContain('data:image');
    expect(plain).toContain('rcp_1');
    const opted = buildBackupJson(withBytes, new Map([['rcp_2', 'data:image/webp;base64,BBBB']]));
    expect(opted).toContain('data:image/webp;base64,AAAA');
    expect(opted).toContain('data:image/webp;base64,BBBB');
    expect(withBytes.expenses[0]!.receipts[1]!.dataUrl).toBeUndefined();
  });
});

describe('P1-14 exports', () => {
  const g = (id: string, currency: string, names: string[]): GroupRecord => ({
    ...(structuredClone(sampleDataset.groups[0]!) as GroupRecord),
    id,
    name: `Trip ${currency}`,
    baseCurrency: currency,
    members: names.map((n, i) => ({ ...member(`${id}_${i}`, n), groupId: id })),
  });
  const base = structuredClone(sampleDataset.expenses[0]!) as ExpenseItem;
  const exp = (over: Partial<ExpenseItem>): ExpenseItem => ({ ...base, receipts: [], deletedAt: null, ...over });
  const stl = (over: Partial<SettlementItem>): SettlementItem => ({
    id: 'stl_x',
    groupId: null,
    batchSettlementId: null,
    fromMemberId: '',
    toMemberId: '',
    amountMinor: 0,
    currency: 'INR',
    paymentMethod: 'cash',
    paymentReference: null,
    notes: '',
    settledDate: '2026-10-01',
    createdAt: '',
    deletedAt: null,
    hlc: '',
    ...over,
  });

  const jpy = g('g_jpy', 'JPY', ['Aki', 'Ben']);
  const kwd = g('g_kwd', 'KWD', ['Aki', 'Ben']);
  const receipt = { id: 'r', expenseId: 'x', fileName: 'r.webp', mimeType: 'image/webp', sizeKb: 1, uploadedByName: 'A', createdAt: '', previewNote: '', dataUrl: 'data:image/webp;base64,SECRETBYTES' };
  const twoWay = (grp: GroupRecord, id: string, amount: number, date: string): ExpenseItem =>
    exp({
      id,
      groupId: grp.id,
      title: `Bill ${id}`,
      expenseDate: date,
      originalCurrency: grp.baseCurrency,
      groupCurrency: grp.baseCurrency,
      originalAmountMinor: amount,
      amountMinor: amount,
      payers: [{ memberId: grp.members[0]!.id, paidMinor: amount, originalPaidMinor: amount }],
      splits: grp.members.map((m, i) => ({
        memberId: m.id,
        included: true,
        owedMinor: i === 0 ? amount - Math.floor(amount / 2) : Math.floor(amount / 2),
        originalOwedMinor: 0,
        rawInputValue: 0,
        remainderMinor: 0,
      })),
      receipts: [{ ...receipt, expenseId: id }],
    });
  const directParticipants = [
    { id: 'p_me', displayName: 'Me Myself', invitedEmail: null, upiId: null, avatarInitials: 'MM', memberOrder: 0 },
    { id: 'p_raj', displayName: 'Raj, Kumar', invitedEmail: null, upiId: null, avatarInitials: 'RK', memberOrder: 1 },
  ];
  const direct = exp({
    id: 'exp_direct',
    groupId: null,
    adHocParticipants: directParticipants,
    title: 'Direct lunch',
    expenseDate: '2026-10-05',
    originalCurrency: 'INR',
    groupCurrency: 'INR',
    originalAmountMinor: 123456,
    amountMinor: 123456,
    payers: [{ memberId: 'p_me', paidMinor: 123456, originalPaidMinor: 123456 }],
    splits: [
      { memberId: 'p_me', included: true, owedMinor: 61728, originalOwedMinor: 61728, rawInputValue: 0, remainderMinor: 0 },
      { memberId: 'p_raj', included: true, owedMinor: 61728, originalOwedMinor: 61728, rawInputValue: 0, remainderMinor: 0 },
    ],
    receipts: [{ ...receipt, expenseId: 'exp_direct' }],
  });
  const directStl = stl({ id: 'stl_direct', expenseId: 'exp_direct', fromMemberId: 'p_raj', toMemberId: 'p_me', amountMinor: 61728, currency: 'INR', settledDate: '2026-10-06' });
  const all = {
    groups: [jpy, kwd],
    expenses: [twoWay(jpy, 'j1', 1001, '2026-09-30'), twoWay(jpy, 'j2', 3001, '2026-10-02'), twoWay(kwd, 'k1', 25000, '2026-10-03'), direct],
    settlements: [stl({ id: 'stl_k', groupId: 'g_kwd', fromMemberId: 'g_kwd_1', toMemberId: 'g_kwd_0', amountMinor: 12500, currency: 'KWD', settledDate: '2026-10-04' }), directStl],
    directName: 'Direct bills',
    directCurrency: 'INR',
  };

  it('filters by an inclusive date range', () => {
    const sel = selectExportLedger({ ...all, scopeId: 'g_jpy', fromDate: '2026-10-01', toDate: '2026-10-31' });
    expect(sel.expenses.map((e) => e.id)).toEqual(['j2']);
    expect(selectExportLedger({ ...all, scopeId: 'g_jpy', fromDate: '', toDate: '2026-09-30' }).expenses.map((e) => e.id)).toEqual(['j1']);
    expect(selectExportLedger({ ...all, scopeId: 'g_jpy', fromDate: '2026-09-30', toDate: '2026-09-30' }).expenses).toHaveLength(1);
  });

  it('exports direct (non-group) bills and their settlements in CSV, XLSX and PDF', () => {
    const sel = selectExportLedger({ ...all, scopeId: DIRECT_EXPORT_SCOPE, fromDate: '', toDate: '' });
    expect(sel.expenses.map((e) => e.id)).toEqual(['exp_direct']);
    expect(sel.settlements.map((s) => s.id)).toEqual(['stl_direct']);
    expect(sel.scope.members.map((m) => m.displayName)).toEqual(['Me Myself', 'Raj, Kumar']);

    const csv = exportGroupToCsv(sel.scope, sel.expenses, sel.settlements);
    expect(csv.split('\n')[0]).toBe('Type,Date,Title,Category,Currency,Total,SplitMode,Me Myself,"Raj, Kumar"');
    expect(csv).toContain('EXPENSE,2026-10-05,"Direct lunch",');
    expect(csv).toContain('1234.56');
    expect(csv).toContain('SETTLEMENT,2026-10-06,"Raj, Kumar paid Me Myself (CASH)"');

    const wb = XLSX.read(exportGroupToExcelBuffer(sel.scope, sel.expenses, sel.settlements), { type: 'array' });
    expect(XLSX.utils.sheet_to_csv(wb.Sheets.Expenses!)).toContain('Direct lunch');
    expect(XLSX.utils.sheet_to_csv(wb.Sheets.Settlements!)).toContain('Raj, Kumar');

    const pdf = Buffer.from(exportGroupToPdfBytes(sel.scope, sel.expenses, sel.settlements)).toString('latin1');
    expect(pdf).toContain('Direct lunch');
    expect(pdf).toContain('INR 1,234.56');
  });

  it('prints 0, 2 and 3 decimals for JPY, INR and KWD in every format', () => {
    const j = selectExportLedger({ ...all, scopeId: 'g_jpy', fromDate: '', toDate: '' });
    const k = selectExportLedger({ ...all, scopeId: 'g_kwd', fromDate: '', toDate: '' });
    const jCsv = exportGroupToCsv(j.scope, j.expenses, j.settlements);
    expect(jCsv).toMatch(/,JPY,1001,/);
    expect(jCsv).toMatch(/,JPY,3001,/);
    expect(jCsv).not.toMatch(/1001\.0/);
    const kCsv = exportGroupToCsv(k.scope, k.expenses, k.settlements);
    expect(kCsv).toMatch(/,KWD,25\.000,/);
    expect(kCsv).toMatch(/,KWD,12\.500,/);

    const kWb = XLSX.read(exportGroupToExcelBuffer(k.scope, k.expenses, k.settlements), { type: 'array' });
    const summary = XLSX.utils.sheet_to_json<Record<string, string>>(kWb.Sheets.Summary!);
    expect(summary[0]).toMatchObject({ BaseCurrency: 'KWD', TotalGroupSpend: '25.000', NetBalance: '0.000' });
    expect(XLSX.utils.sheet_to_csv(kWb.Sheets.Settlements!)).toContain('12.500');
    const jWb = XLSX.read(exportGroupToExcelBuffer(j.scope, j.expenses, j.settlements), { type: 'array' });
    expect(XLSX.utils.sheet_to_json<Record<string, string>>(jWb.Sheets.Summary!)[0]).toMatchObject({ TotalGroupSpend: '4,002' });

    const kPdf = Buffer.from(exportGroupToPdfBytes(k.scope, k.expenses, k.settlements)).toString('latin1');
    expect(kPdf).toContain('KWD 25.000');
    expect(kPdf).toContain('KWD 12.500');
    const jPdf = Buffer.from(exportGroupToPdfBytes(j.scope, j.expenses, j.settlements)).toString('latin1');
    expect(jPdf).toContain('JPY 1,001 ');
  });

  it('summarises mixed-currency direct bills per currency instead of adding yen to rupees', () => {
    const usdBill = exp({ ...direct, id: 'exp_usd', title: 'USD bill', originalCurrency: 'USD', groupCurrency: 'USD', amountMinor: 1000, originalAmountMinor: 1000, payers: [{ memberId: 'p_me', paidMinor: 1000, originalPaidMinor: 1000 }], splits: direct.splits.map((s) => ({ ...s, owedMinor: 500 })) });
    const wb = XLSX.read(exportGroupToExcelBuffer({ name: 'Direct', baseCurrency: 'INR', simplifyDebts: false, members: directParticipants }, [direct, usdBill], []), { type: 'array' });
    const rows = XLSX.utils.sheet_to_json<Record<string, string>>(wb.Sheets.Summary!);
    expect(rows.map((r) => `${r.BaseCurrency} ${r.TotalGroupSpend}`)).toEqual(['INR 1,234.56', 'INR 1,234.56', 'USD 10.00', 'USD 10.00']);
  });

  it('never writes receipt image bytes into CSV, XLSX or PDF', () => {
    const j = selectExportLedger({ ...all, scopeId: 'g_jpy', fromDate: '', toDate: '' });
    expect(exportGroupToCsv(j.scope, j.expenses, j.settlements)).not.toContain('SECRETBYTES');
    expect(Buffer.from(exportGroupToExcelBuffer(j.scope, j.expenses, j.settlements)).toString('latin1')).not.toContain('SECRETBYTES');
    const wb = XLSX.read(exportGroupToExcelBuffer(j.scope, j.expenses, j.settlements), { type: 'array' });
    for (const name of wb.SheetNames) expect(XLSX.utils.sheet_to_csv(wb.Sheets[name]!)).not.toContain('SECRETBYTES');
    expect(Buffer.from(exportGroupToPdfBytes(j.scope, j.expenses, j.settlements)).toString('latin1')).not.toContain('SECRETBYTES');
  });

  it('builds safe file names', () => {
    expect(safeExportFileName('Goa Trip 2026', 'csv')).toBe('wise-spliter-goa-trip-2026.csv');
    expect(safeExportFileName('../../etc/passwd', 'pdf')).toBe('wise-spliter-etc-passwd.pdf');
    expect(safeExportFileName('東京 旅行', 'xlsx')).toBe('wise-spliter-東京-旅行.xlsx');
    expect(safeExportFileName('  ***  ', 'csv')).toBe('wise-spliter-ledger.csv');
    expect(safeExportFileName('CON', 'csv')).toBe('wise-spliter-con.csv');
    expect(safeExportFileName('Trip', 'csv', '2026-10-01', '2026-10-31')).toBe('wise-spliter-trip-2026-10-01-to-2026-10-31.csv');
    expect(safeExportFileName('Trip', 'csv', '', '2026-10-31')).toBe('wise-spliter-trip-to-2026-10-31.csv');
    expect(safeExportFileName('x'.repeat(300), 'csv').length).toBeLessThanOrEqual(80);
    expect(safeExportFileName('a\u0000b<c>:"|?*d', 'csv')).toBe('wise-spliter-a-b-c-d.csv');
  });
});

describe('WhatsApp summary UPI links', () => {
  const summary = (currency: string, toUpiId: string | null, amountMinor: number) =>
    generateWhatsAppGroupSummary({
      groupName: 'Goa',
      currency,
      totalSpendMinor: 100000,
      simplifyDebts: true,
      netBalances: [],
      transfers: [{ fromName: 'Rohan', toName: 'Arjun', toUpiId, amountMinor }],
    });

  it('links only a valid payee UPI id, a positive amount and INR', () => {
    expect(summary('INR', 'arjun@okaxis', 50000)).toContain(
      'UPI Pay: upi://pay?pa=arjun%40okaxis&pn=Arjun&am=500.00&cu=INR&tn=Goa%20settlement'
    );
    for (const [cur, id, amt] of [
      ['INR', null, 50000],
      ['INR', '', 50000],
      ['INR', 'not-a-vpa', 50000],
      ['INR', 'javascript:alert(1)@x', 50000],
      ['INR', 'arjun@okaxis', 0],
      ['INR', 'arjun@okaxis', -500],
      ['INR', 'arjun@okaxis', 0.5],
      ['USD', 'arjun@okaxis', 50000],
      ['JPY', 'arjun@okaxis', 5000],
      ['KWD', 'arjun@okaxis', 25000],
    ] as const) {
      expect(summary(cur, id, amt), `${cur} ${String(id)} ${amt}`).not.toContain('UPI Pay');
    }
  });
});

describe('P1-10 plain device backup restore', () => {
  const pass = 'correct horse battery';
  const plain = JSON.stringify(sampleDataset, null, 2);
  const codeOf = async (text: string, p = '') => {
    try {
      await openBackupFile(text, p);
      return 'ok';
    } catch (err) {
      expect(err).toBeInstanceOf(BackupRestoreError);
      expect((err as Error).message).toContain('Nothing was changed');
      return (err as BackupRestoreError).code;
    }
  };

  it('detects plain ledgers and encrypted bundles by shape', async () => {
    expect(backupFileKind(plain)).toBe('plain');
    expect(backupFileKind(`\uFEFF${plain}`)).toBe('plain');
    expect(backupFileKind(await encryptBackupPayload('{}', pass))).toBe('encrypted');
    expect(backupFileKind('{"not":"a backup"}')).toBe('unknown');
    expect(backupFileKind('')).toBe('unknown');
  }, 30_000);

  it('restores a plain ledger without a passphrase and flags it as unencrypted', async () => {
    const res = await openBackupFile(plain, '');
    expect(res.encrypted).toBe(false);
    expect(res.entities.groups.length).toBe(sampleDataset.groups.length);
    const enc = await openBackupFile(await encryptBackupPayload(buildBackupJson(sampleDataset, null), pass), pass);
    expect(enc.encrypted).toBe(true);
  }, 30_000);

  it('rejects empty, foreign and malformed plain ledgers', async () => {
    expect(await codeOf('')).toBe('empty');
    expect(await codeOf('{"not":"a backup"}')).toBe('format');
    const broken = (mutate: (d: MockLedgerDataset) => void) => {
      const d = structuredClone(sampleDataset);
      mutate(d);
      return JSON.stringify(d);
    };
    expect(await codeOf('{"groups":[]}')).toBe('schema');
    expect(await codeOf(broken((d) => Object.assign(d.expenses[0]!, { amountMinor: '12' })))).toBe('schema');
    expect(await codeOf(broken((d) => Object.assign(d.expenses[0]!, { amountMinor: 1.5 })))).toBe('schema');
    expect(await codeOf(broken((d) => Object.assign(d.expenses[0]!, { payers: [{ memberId: 7, paidMinor: 1 }] })))).toBe('schema');
    expect(await codeOf(broken((d) => Object.assign(d.settlements[0]!, { amountMinor: 2 ** 60 })))).toBe('schema');
    expect(await codeOf(broken((d) => Object.assign(d.groups[0]!, { members: null })))).toBe('schema');
    expect(await codeOf(broken((d) => Object.assign(d, { currentUser: undefined }))), 'identity in a file is ignored').toBe('ok');
    expect(await codeOf(broken((d) => Object.assign(d, { expenses: 'x' })))).toBe('schema');
    expect(await codeOf(broken((d) => Object.assign(d.groups[0]!.members[0]!, { displayName: undefined })))).toBe('schema');
  });
});

describe('P1-10 crafted backups cannot produce a crashing ledger', () => {
  const pass = 'correct horse battery';
  const sample = () => structuredClone(sampleDataset);
  const firstGroupExpense = (d: MockLedgerDataset) => d.expenses.find((e) => e.groupId !== null && !e.deletedAt)!;
  const groupSettlement = (d: MockLedgerDataset) => d.settlements.find((x) => x.groupId !== null)!;
  const rejectCode = async (data: unknown, known: GroupRecord[] = []) => {
    try {
      await openBackupFile(JSON.stringify(data), '', known);
      return 'accepted';
    } catch (err) {
      expect(err).toBeInstanceOf(BackupRestoreError);
      expect((err as Error).message).toContain('Nothing was changed');
      return (err as BackupRestoreError).code;
    }
  };

  it('rejects the reviewer probe and every malformed item, plain or encrypted', async () => {
    const probe = { currentUser: { id: 'u' }, groups: [], expenses: [], settlements: [], expenseRevisions: [null, 5], groupActivityLog: [null] };
    expect(await rejectCode(probe)).toBe('schema');
    await expect(openBackupFile(await encryptBackupPayload(JSON.stringify(probe), pass), pass)).rejects.toMatchObject({ code: 'schema' });

    const cases: Array<[string, (d: MockLedgerDataset) => void]> = [
      ['activity null', (d) => Object.assign(d, { groupActivityLog: [null] })],
      ['activity missing summary', (d) => Object.assign(d.groupActivityLog[0]!, { summaryText: undefined })],
      ['revision bad snapshot', (d) => Object.assign(d.expenseRevisions[0]!, { snapshot: null })],
      ['negative amount', (d) => Object.assign(firstGroupExpense(d), { amountMinor: -500 })],
      ['amount above 2^53', (d) => Object.assign(firstGroupExpense(d), { amountMinor: 2 ** 60 })],
      ['payers do not sum', (d) => Object.assign(firstGroupExpense(d).payers[0]!, { paidMinor: firstGroupExpense(d).payers[0]!.paidMinor + 1 })],
      ['split negative', (d) => Object.assign(firstGroupExpense(d).splits[0]!, { owedMinor: -1 })],
      ['unknown group', (d) => Object.assign(firstGroupExpense(d), { groupId: 'grp_nope' })],
      ['payer not a member', (d) => Object.assign(firstGroupExpense(d).payers[0]!, { memberId: 'mem_stranger' })],
      ['unknown currency', (d) => Object.assign(firstGroupExpense(d), { originalCurrency: 'ZZZ' })],
      ['receipt null', (d) => Object.assign(firstGroupExpense(d), { receipts: [null] })],
      ['bad category', (d) => Object.assign(firstGroupExpense(d), { category: 'pizza' })],
      ['settlement to self', (d) => Object.assign(groupSettlement(d), { toMemberId: groupSettlement(d).fromMemberId })],
      ['settlement zero', (d) => Object.assign(groupSettlement(d), { amountMinor: 0 })],
      ['settlement unknown member', (d) => Object.assign(groupSettlement(d), { fromMemberId: 'mem_stranger' })],
      ['group bad currency', (d) => Object.assign(d.groups[0]!, { baseCurrency: 'ZZZ' })],
      ['member wrong group', (d) => Object.assign(d.groups[0]!.members[0]!, { groupId: 'grp_other' })],
      ['duplicate expense id', (d) => d.expenses.push(structuredClone(d.expenses[0]!))],
      ['proto currency', (d) => Object.assign(firstGroupExpense(d), { originalCurrency: '__proto__' })],
    ];
    for (const [label, mutate] of cases) {
      const d = sample();
      mutate(d);
      expect(await rejectCode(d), label).toBe('schema');
    }
    const d = sample();
    Object.assign(firstGroupExpense(d).payers[0]!, { paidMinor: firstGroupExpense(d).payers[0]!.paidMinor + 1 });
    await expect(openBackupFile(JSON.stringify(d), '')).rejects.toThrow(/bill \d+ \(".+"\) does not add up/);
  });

  it('a restore merges only the five entity arrays and keeps catalogs, rates and the signed-in user', async () => {
    const foreign = { ...sample(), currentUser: { ...sampleDataset.currentUser, id: 'usr_attacker', email: 'evil@example.com' }, fxRatesToInr: undefined, currenciesCatalog: [] };
    const { entities } = await openBackupFile(JSON.stringify(foreign), '');
    expect(Object.keys(entities).sort()).toEqual(['expenseRevisions', 'expenses', 'groupActivityLog', 'groups', 'settlements']);
    const current = { ...sample(), currentUser: { ...sampleDataset.currentUser, id: 'usr_me' } };
    const merged = mergeLedgerEntities(current, entities).dataset;
    expect(merged.currentUser.id).toBe('usr_me');
    expect(merged.fxRatesToInr).toEqual(sampleDataset.fxRatesToInr);
    expect(merged.currenciesCatalog).toEqual(sampleDataset.currenciesCatalog);
    expect(merged.groups.length).toBe(sampleDataset.groups.length);
  });

  it('accepts bills for a group that exists only in the current ledger, and merges by id', async () => {
    const d = sample();
    const groupId = firstGroupExpense(d).groupId!;
    const onlyBills = { ...d, groups: d.groups.filter((g) => g.id !== groupId) };
    expect(await rejectCode(onlyBills)).toBe('schema');
    const { entities } = await openBackupFile(JSON.stringify(onlyBills), '', sampleDataset.groups);
    const merged = mergeLedgerEntities(sample(), entities).dataset;
    expect(merged.groups.map((g) => g.id).sort()).toEqual(sampleDataset.groups.map((g) => g.id).sort());
    expect(merged.expenses.length).toBe(sampleDataset.expenses.length);
  });

  it('a restored ledger runs through every ledger engine view without throwing', async () => {
    const { entities } = await openBackupFile(
      await encryptBackupPayload(buildBackupJson(sampleDataset, null), pass),
      pass
    );
    const d = mergeLedgerEntities(structuredClone(sampleDataset), entities).dataset;
    for (const g of d.groups) {
      const ex = d.expenses.filter((e) => e.groupId === g.id);
      const st = d.settlements.filter((x) => x.groupId === g.id);
      const nets = computeGroupNetBalances(ex, st, g.members);
      expect([...nets.values()].reduce((a, b) => a + b, 0)).toBe(0);
      simplifyGroupDebts(nets, g.members, g.baseCurrency);
      computeRawPairwiseTransfers(ex, st, g.members, g.baseCurrency);
      for (const m of g.members) explainMemberBalance(m.id, g, ex, st);
    }
    expect(() => computeCrossGroupFriendsSummary(d.currentUser.email, d.groups, d.expenses, d.settlements, d.fxRatesToInr)).not.toThrow();
  }, 30_000);
});

describe('P1-10 KDF parameters', () => {
  it('accepts only the current 600k, the legacy 100k label, or no label; anything else is refused fast', async () => {
    const base = JSON.parse(await encryptBackupPayload('{}', 'correct horse battery')) as Record<string, unknown>;
    const codeFor = async (kdf: unknown) => {
      const t = performance.now();
      try {
        await decryptBackupPayload(JSON.stringify({ ...base, kdf }), 'wrong passphrase here');
        return ['ok', 0] as const;
      } catch (err) {
        return [(err as BackupRestoreError).code, performance.now() - t] as const;
      }
    };
    for (const kdf of ['PBKDF2-SHA256-10000000', 'PBKDF2-SHA256-10000001', 'PBKDF2-SHA256-99999', 'PBKDF2-SHA256-0600000', 'scrypt', 'PBKDF2-SHA256-200000', 5]) {
      const [code, ms] = await codeFor(kdf);
      expect(code, String(kdf)).toBe('format');
      expect(ms, String(kdf)).toBeLessThan(200);
    }
    for (const kdf of ['PBKDF2-SHA256-600000', 'PBKDF2-SHA256-100000', undefined]) {
      expect((await codeFor(kdf))[0], String(kdf)).toBe('passphrase');
    }
  }, 30_000);
});

describe('P1-7 Splitwise import never crashes, never silently drops or rewrites rows', () => {
  const header = 'Date,Description,Category,Cost,Currency,Alice,Bob,Carol';
  const csv = (...rows: string[]) => [header, ...rows].join('\n');

  it('skips bad rows with a reason instead of dropping or rewriting them', () => {
    const parsed = parseSplitwiseImport(
      csv(
        '2026-01-01,"Dinner, late",Dining out,90.00,INR,60.00,-30.00,-30.00',
        '2026-01-02,Settle,Payment,30.00,INR,0.00,30.00,-30.00',
        '2026-01-05,Bad cost,General,abc,INR,1.00,-1.00,0.00',
        '2026-01-06,Overflow,General,99999999999999999.00,INR,1.00,-1.00,0.00',
        '2026-01-07,Mismatch deltas,General,10.00,INR,50.00,-1.00,0.00',
        '2026-01-08,Malformed share,General,10.00,INR,5.00,"-5,0",0.00',
        '2026-01-09,Share above cost,General,10.00,INR,50.00,-50.00,0.00',
        '2026-13-45,Bad date,General,10.00,INR,5.00,-5.00,0.00',
        '01/02/2026,US date,General,10.00,INR,5.00,-5.00,0.00',
        '2026-01-10,Unknown currency,General,10.00,ABC,5.00,-5.00,0.00',
        '2026-01-11,Short row,General,10.00',
        '2026-01-12,Bad payment,Payment,30.00,INR,0.00,30.00,-20.00'
      )
    );
    expect(parsed.error).toBeNull();
    expect(parsed.expenses.map((e) => e.title)).toEqual(['Dinner, late']);
    expect(parsed.payments).toHaveLength(1);
    expect(parsed.skipped.map((x) => [x.line, x.title])).toEqual([
      [4, 'Bad cost'],
      [5, 'Overflow'],
      [6, 'Mismatch deltas'],
      [7, 'Malformed share'],
      [8, 'Share above cost'],
      [9, 'Bad date'],
      [10, 'US date'],
      [11, 'Unknown currency'],
      [12, 'Short row'],
      [13, 'Bad payment'],
    ]);
    for (const x of parsed.skipped) {
      expect(x.reason.length, x.title).toBeGreaterThan(10);
      expect(x.reason).not.toMatch(/[\u2013\u2014]/);
    }
    expect(parsed.skipped.find((x) => x.title === 'Malformed share')!.reason).toContain('Bob');
  });

  it('compares what will be imported with the Splitwise Total balance rows', () => {
    const good = parseSplitwiseImport(
      csv('2026-01-01,Dinner,Dining out,90.00,INR,60.00,-30.00,-30.00', ',Total balance,,,INR,60.00,-30.00,-30.00')
    );
    expect(good.balanceMismatches).toEqual([]);
    const bad = parseSplitwiseImport(
      csv(
        '2026-01-01,Dinner,Dining out,90.00,INR,60.00,-30.00,-30.00',
        '2026-01-02,Bad cost,General,abc,INR,10.00,-10.00,0.00',
        ',Total balance,,,INR,70.00,-40.00,-30.00'
      )
    );
    expect(bad.balanceMismatches).toEqual([
      { currency: 'INR', memberName: 'Alice', expectedMinor: 7000, importedMinor: 6000 },
      { currency: 'INR', memberName: 'Bob', expectedMinor: -4000, importedMinor: -3000 },
    ]);
    expect(parseSplitwiseImport(FIXTURE).balanceMismatches).toEqual([]);
  });

  it('malformed Splitwise JSON never throws and reports a calm error or skipped rows', () => {
    const users = (u: unknown) => JSON.stringify([{ description: 'x', cost: '5', currency_code: 'INR', date: '2026-02-03', users: u }]);
    for (const u of [[null], { a: 1 }, 'nope', [{ user: null, paid_share: '5' }], [5]]) {
      const r = parseSplitwiseImport(users(u));
      expect(r.expenses, JSON.stringify(u)).toEqual([]);
      expect(r.skipped).toHaveLength(1);
    }
    const huge = parseSplitwiseImport(JSON.stringify([{ description: 'Num cost', cost: 1e21, currency_code: 'INR', date: '2026-02-03', users: [{ user: { first_name: 'A' }, paid_share: 1e21, owed_share: 1e21 }] }]));
    expect(huge.expenses).toEqual([]);
    expect(huge.skipped[0]!.title).toBe('Num cost');
    for (const bad of ['{not json', '{"expenses": 5}', 'null', '[1, "x", null]', '{"expenses":[{"expense":null}]}']) {
      expect(() => parseSplitwiseImport(bad), bad).not.toThrow();
      const r = parseSplitwiseImport(bad);
      expect(r.expenses).toEqual([]);
    }
    expect(parseSplitwiseImport('{not json').error).toMatch(/not valid JSON/);
    expect(parseSplitwiseImport('{"expenses": 5}').error).toMatch(/Splitwise/);
  });
});

describe('P1-14 exports with duplicate member names', () => {
  it('keys XLSX member columns by id and labels duplicates apart', () => {
    const scope = { name: 'G', baseCurrency: 'INR', simplifyDebts: false, members: [{ id: 'm1', displayName: 'Sam' }, { id: 'm2', displayName: 'Sam' }, { id: 'm3', displayName: 'Ana' }] };
    const exp = {
      ...(structuredClone(sampleDataset.expenses[0]!) as ExpenseItem),
      groupId: 'g', title: 'Lunch', expenseDate: '2026-01-01', originalCurrency: 'INR', groupCurrency: 'INR', originalAmountMinor: 300, amountMinor: 300,
      payers: [{ memberId: 'm1', paidMinor: 300, originalPaidMinor: 300 }],
      splits: ['m1', 'm2', 'm3'].map((memberId) => ({ memberId, included: true, owedMinor: 100, originalOwedMinor: 100, rawInputValue: 0, remainderMinor: 0 })),
      receipts: [], deletedAt: null,
    } as ExpenseItem;
    const wb = XLSX.read(exportGroupToExcelBuffer(scope, [exp], []), { type: 'array' });
    const row = XLSX.utils.sheet_to_json<Record<string, string>>(wb.Sheets.Expenses!)[0]!;
    expect(row['Sam (Net)']).toBe('2.00');
    expect(row['Sam [2] (Net)']).toBe('-1.00');
    expect(row['Ana (Net)']).toBe('-1.00');
    expect(exportGroupToCsv(scope, [exp], []).split('\n')[0]).toBe('Type,Date,Title,Category,Currency,Total,SplitMode,Sam,Sam [2],Ana');
  });
});

describe('P1-10 restoring an older backup never overwrites newer rows', () => {
  const later = (hlc: string) => `${(parseInt(hlc.slice(0, 12), 16) + 1000).toString(16).padStart(12, '0')}${hlc.slice(12)}`;
  const earlier = (hlc: string) => `${(parseInt(hlc.slice(0, 12), 16) - 1000).toString(16).padStart(12, '0')}${hlc.slice(12)}`;

  it('keeps the newer copy per id, reports it, and only new or newer rows reach the sync diff', async () => {
    const device = structuredClone(sampleDataset);
    const backup = structuredClone(sampleDataset);
    const [a, b, c] = device.expenses.filter((e) => e.groupId !== null);
    // a: edited on the device after the backup was made
    Object.assign(a!, { title: 'Edited on device', hlc: later(a!.hlc) });
    // b: deleted on the device after the backup
    Object.assign(b!, { deletedAt: '2026-11-20T10:00:00.000Z', hlc: later(b!.hlc) });
    // c: the backup holds a newer edit than the device
    const bb = backup.expenses.find((e) => e.id === c!.id)!;
    Object.assign(bb, { title: 'Newer in backup', hlc: later(bb.hlc) });
    Object.assign(c!, { hlc: earlier(c!.hlc) });
    // a brand new bill only in the backup
    const fresh = { ...structuredClone(bb), id: 'exp_only_in_backup', title: 'Only in backup', receipts: [], comments: [] };
    backup.expenses.push(fresh);

    const { entities } = await openBackupFile(JSON.stringify(backup), '');
    const { dataset, report } = mergeLedgerEntities(device, entities);
    const byId = new Map(dataset.expenses.map((e) => [e.id, e]));
    expect(byId.get(a!.id)!.title).toBe('Edited on device');
    expect(byId.get(b!.id)!.deletedAt).toBe('2026-11-20T10:00:00.000Z');
    expect(byId.get(c!.id)!.title).toBe('Newer in backup');
    expect(byId.get('exp_only_in_backup')!.title).toBe('Only in backup');
    expect(report.keptNewer).toBe(2);
    expect(report.restored).toBe(2);
    expect(report.takenExpenseIds.sort()).toEqual([c!.id, 'exp_only_in_backup'].sort());

    const pushed = diffDatasetToMutations(device, dataset, 'usr_test');
    expect(pushed.map((m) => m.id).sort()).toEqual([c!.id, 'exp_only_in_backup'].sort());
    expect(pushed.find((m) => m.id === c!.id)!.baseHlc).toBe(c!.hlc);
    expect(pushed.find((m) => m.id === 'exp_only_in_backup')!.baseHlc).toBeNull();
  });

  it('a newer backup group row never revives a member removed on this device, and only adds missing members', async () => {
    const device = structuredClone(sampleDataset);
    const backup = structuredClone(sampleDataset);
    const dg = device.groups[0]!;
    const removed = dg.members[0]!;
    removed.removedAt = '2026-11-20T10:00:00.000Z';
    const bg = backup.groups.find((g) => g.id === dg.id)!;
    Object.assign(bg, { name: 'Renamed in backup', hlc: later(bg.hlc) });
    bg.members.push({ ...structuredClone(bg.members[0]!), id: 'mem_only_in_backup', displayName: 'Backup Only' });

    const { entities } = await openBackupFile(JSON.stringify(backup), '');
    const merged = mergeLedgerEntities(device, entities).dataset.groups.find((g) => g.id === dg.id)!;
    expect(merged.name).toBe('Renamed in backup');
    expect(merged.members.find((m) => m.id === removed.id)!.removedAt).toBe('2026-11-20T10:00:00.000Z');
    expect(merged.members.filter((m) => m.id === removed.id)).toHaveLength(1);
    expect(merged.members.some((m) => m.id === 'mem_only_in_backup')).toBe(true);
  });
});

describe('P1-10 backups carry only rows the server would accept', () => {
  const sample = () => structuredClone(sampleDataset);
  const firstGroupExpense = (d: MockLedgerDataset) => d.expenses.find((e) => e.groupId !== null && !e.deletedAt)!;
  const codeFor = async (mutate: (d: MockLedgerDataset) => void) => {
    const d = sample();
    mutate(d);
    try {
      await openBackupFile(JSON.stringify(d), '');
      return 'accepted';
    } catch (err) {
      return (err as BackupRestoreError).code;
    }
  };

  it('validates revision snapshots like bills', async () => {
    expect(await codeFor((d) => Object.assign(d.expenseRevisions[0]!.snapshot, { amountMinor: -9 }))).toBe('schema');
    expect(
      await codeFor((d) => {
        const p = d.expenseRevisions[0]!.snapshot.payers[0]!;
        Object.assign(p, { paidMinor: p.paidMinor + 1 });
      })
    ).toBe('schema');
  });

  it('validates dates, timestamps and HLCs', async () => {
    expect(await codeFor(() => undefined)).toBe('accepted');
    const cases: Array<[string, (d: MockLedgerDataset) => void]> = [
      ['impossible bill date', (d) => Object.assign(firstGroupExpense(d), { expenseDate: '2026-02-30' })],
      ['US bill date', (d) => Object.assign(firstGroupExpense(d), { expenseDate: '11/02/2026' })],
      ['payment before 2000', (d) => Object.assign(d.settlements[0]!, { settledDate: '1999-12-31' })],
      ['payment far future', (d) => Object.assign(d.settlements[0]!, { settledDate: '2999-01-01' })],
      ['created not a timestamp', (d) => Object.assign(firstGroupExpense(d), { createdAt: 'yesterday' })],
      ['deleted not a timestamp', (d) => Object.assign(firstGroupExpense(d), { deletedAt: 'soon' })],
      ['group updated garbage', (d) => Object.assign(d.groups[0]!, { updatedAt: 'x'.repeat(41) })],
      ['member joined garbage', (d) => Object.assign(d.groups[0]!.members[0]!, { joinedAt: 'nope' })],
      ['bill hlc', (d) => Object.assign(firstGroupExpense(d), { hlc: 'abc' })],
      ['group hlc', (d) => Object.assign(d.groups[0]!, { hlc: '' })],
      ['payment hlc', (d) => Object.assign(d.settlements[0]!, { hlc: 'ZZZZZZZZZZZZ-0000-x' })],
      ['revision hlc', (d) => Object.assign(d.expenseRevisions[0]!, { hlc: '1' })],
      ['activity hlc', (d) => Object.assign(d.groupActivityLog[0]!, { hlc: '1' })],
      ['activity created', (d) => Object.assign(d.groupActivityLog[0]!, { createdAt: 'later' })],
    ];
    for (const [label, mutate] of cases) expect(await codeFor(mutate), label).toBe('schema');
  });
});

describe('P1-7 Splitwise JSON keeps different people with the same name apart', () => {
  it('keys people on the Splitwise user id and labels same-name people distinctly', () => {
    const person = (id: number, first: string, paid: string, owed: string) => ({ user: { id, first_name: first, last_name: null }, paid_share: paid, owed_share: owed });
    const parsed = parseSplitwiseImport(
      JSON.stringify([
        { description: 'Lunch', cost: '30', currency_code: 'INR', date: '2026-02-01', users: [person(1, 'Sam', '30', '10'), person(2, 'Sam', '0', '10'), person(3, 'Ana', '0', '10')] },
        { description: 'Cab', cost: '10', currency_code: 'INR', date: '2026-02-02', users: [person(2, 'Sam', '10', '5'), person(3, 'Ana', '0', '5')] },
      ])
    );
    expect(parsed.memberNames).toEqual(['Sam (Splitwise #1)', 'Sam (Splitwise #2)', 'Ana']);
    const net = (name: string) =>
      parsed.expenses.reduce(
        (acc, e) => acc + (e.payers.find((p) => p.memberName === name)?.paidMinor ?? 0) - (e.splits.find((x) => x.memberName === name)?.owedMinor ?? 0),
        0
      );
    expect(net('Sam (Splitwise #1)')).toBe(2000);
    expect(net('Sam (Splitwise #2)')).toBe(-500);
    expect(net('Ana')).toBe(-1500);
  });
});
