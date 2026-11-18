import { describe, expect, it } from 'vitest';
import mockData from '../../src/data/mock-ledger-data.json';
import type { ExpenseItem, MockLedgerDataset } from '../../src/types/ledger';
import {
  matchesAmountFilter,
  matchesDateRange,
  monthlySpend,
  parseInviteCode,
} from '../../src/utils/expense-search';
import { computeGroupNetBalances } from '../../src/domain/ledger/ledger-engine';

const data = mockData as unknown as MockLedgerDataset;
const bill = (over: Partial<ExpenseItem>): ExpenseItem =>
  ({ ...data.expenses[0]!, deletedAt: null, ...over }) as ExpenseItem;

describe('amount filter', () => {
  const inr = bill({ amountMinor: 25050, groupCurrency: 'INR', originalAmountMinor: 25050, originalCurrency: 'INR' });
  const kwd = bill({ amountMinor: 1234, groupCurrency: 'KWD', originalAmountMinor: 1234, originalCurrency: 'KWD' });
  const fx = bill({ amountMinor: 900000, groupCurrency: 'INR', originalAmountMinor: 10000, originalCurrency: 'EUR' });

  it('passes everything when unset or malformed', () => {
    expect(matchesAmountFilter(inr, { mode: 'any', min: '', max: '' })).toBe(true);
    expect(matchesAmountFilter(inr, { mode: 'exact', min: '', max: '' })).toBe(true);
    expect(matchesAmountFilter(inr, { mode: 'exact', min: 'abc', max: '' })).toBe(true);
  });

  it('matches exact amounts in the currency decimals', () => {
    expect(matchesAmountFilter(inr, { mode: 'exact', min: '250.50', max: '' })).toBe(true);
    expect(matchesAmountFilter(inr, { mode: 'exact', min: '250.5', max: '' })).toBe(true);
    expect(matchesAmountFilter(inr, { mode: 'exact', min: '250', max: '' })).toBe(false);
    expect(matchesAmountFilter(kwd, { mode: 'exact', min: '1.234', max: '' })).toBe(true);
  });

  it('matches the original currency amount too', () => {
    expect(matchesAmountFilter(fx, { mode: 'exact', min: '100', max: '' })).toBe(true);
    expect(matchesAmountFilter(fx, { mode: 'exact', min: '9000', max: '' })).toBe(true);
  });

  it('matches ranges inclusively, with open ends and swapped bounds', () => {
    expect(matchesAmountFilter(inr, { mode: 'between', min: '250.50', max: '250.50' })).toBe(true);
    expect(matchesAmountFilter(inr, { mode: 'between', min: '251', max: '' })).toBe(false);
    expect(matchesAmountFilter(inr, { mode: 'between', min: '', max: '250' })).toBe(false);
    expect(matchesAmountFilter(inr, { mode: 'between', min: '300', max: '200' })).toBe(true);
    expect(matchesAmountFilter(inr, { mode: 'between', min: '0', max: '1e3' })).toBe(true);
  });
});

describe('date range', () => {
  it('is inclusive and open ended', () => {
    expect(matchesDateRange('2026-03-15', '', '')).toBe(true);
    expect(matchesDateRange('2026-03-15', '2026-03-15', '2026-03-15')).toBe(true);
    expect(matchesDateRange('2026-03-15T10:00:00Z', '2026-03-15', '2026-03-15')).toBe(true);
    expect(matchesDateRange('2026-03-15', '2026-03-16', '')).toBe(false);
    expect(matchesDateRange('2026-03-15', '', '2026-03-14')).toBe(false);
    expect(matchesDateRange('2026-03-15', '2026-04-01', '2026-03-01')).toBe(true);
  });
});

describe('monthly spend', () => {
  it('returns nothing for no bills', () => {
    expect(monthlySpend([], 12)).toEqual([]);
  });

  it('fills gaps with zero, skips deleted bills, and keeps the last N months', () => {
    const rows = monthlySpend(
      [
        bill({ expenseDate: '2025-11-30', amountMinor: 100 }),
        bill({ expenseDate: '2026-01-02', amountMinor: 250 }),
        bill({ expenseDate: '2026-01-20', amountMinor: 50 }),
        bill({ expenseDate: '2026-01-21', amountMinor: 999, deletedAt: '2026-01-22' }),
      ],
      12
    );
    expect(rows).toEqual([
      { month: '2025-11', totalMinor: 100, count: 1 },
      { month: '2025-12', totalMinor: 0, count: 0 },
      { month: '2026-01', totalMinor: 300, count: 2 },
    ]);
    expect(monthlySpend([bill({ expenseDate: '2024-01-01' }), bill({ expenseDate: '2026-01-01' })], 3).map((r) => r.month))
      .toEqual(['2025-11', '2025-12', '2026-01']);
  });

  it('ignores malformed dates', () => {
    expect(monthlySpend([bill({ expenseDate: 'not a date', amountMinor: 5 })], 12)).toEqual([]);
  });
});

describe('invite code parsing', () => {
  it('accepts a code or an invite link', () => {
    expect(parseInviteCode('  ws-ab12cd34ef ')).toBe('WS-AB12CD34EF');
    expect(parseInviteCode('https://app.example/?join=WS-AB12CD34EF')).toBe('WS-AB12CD34EF');
    expect(parseInviteCode('https://app.example/?foo=1&join=ws-60a2026001#x')).toBe('WS-60A2026001');
  });

  it('rejects junk', () => {
    expect(parseInviteCode('')).toBeNull();
    expect(parseInviteCode('<script>alert(1)</script>')).toBeNull();
    expect(parseInviteCode('ab')).toBeNull();
    expect(parseInviteCode('x'.repeat(41))).toBeNull();
    expect(parseInviteCode('https://app.example/?join=')).toBeNull();
    expect(parseInviteCode('GOA-2026-VILLA')).toBeNull();
    expect(parseInviteCode('WS-AB12CD34E')).toBeNull();
    expect(parseInviteCode('WS-AB12CD34EFG')).toBeNull();
    expect(parseInviteCode('WS-AB12CD34EG')).toBeNull();
    expect(parseInviteCode('XS-AB12CD34EF')).toBeNull();
  });
});

describe('removed members keep balances whole', () => {
  it('sum of net stays zero when a member with history is marked removed', () => {
    const goa = data.groups.find((g) => g.id === 'grp_goa_2026')!;
    const expenses = data.expenses.filter((e) => e.groupId === goa.id);
    const settlements = data.settlements.filter((s) => s.groupId === goa.id);
    const members = goa.members.map((m, i) => (i === 1 ? { ...m, removedAt: '2026-11-01T00:00:00Z' } : m));
    const net = computeGroupNetBalances(expenses, settlements, members);
    expect([...net.values()].reduce((a, b) => a + b, 0)).toBe(0);
    expect(net.has(goa.members[1]!.id)).toBe(true);
  });
});

describe('duplicate member names', () => {
  it('matches trimmed, collapsed, case-folded NFC names among active members only', async () => {
    const { activeMemberNamed, normalizePersonName } = await import('../../src/utils/group-permissions');
    expect(normalizePersonName('  bina   RAO ')).toBe('bina rao');
    expect(normalizePersonName('José')).toBe(normalizePersonName('José'));
    const goa = data.groups.find((g) => g.id === 'grp_goa_2026')!;
    expect(activeMemberNamed(goa, ' rohan  verma')?.id).toBe('mem_goa_rohan');
    const withFormer = { ...goa, members: goa.members.map((m) => (m.id === 'mem_goa_rohan' ? { ...m, removedAt: '2026-11-01' } : m)) };
    expect(activeMemberNamed(withFormer, 'Rohan Verma')).toBeUndefined();
  });
});

describe('isGroupAdminFor', () => {
  it('ignores removed admins and never matches an unclaimed seat', async () => {
    const { isGroupAdminFor } = await import('../../src/utils/group-permissions');
    const goa = data.groups.find((g) => g.id === 'grp_goa_2026')!;
    const me = data.currentUser.id;
    expect(isGroupAdminFor(goa, me)).toBe(true);
    const removed = { ...goa, members: goa.members.map((m) => (m.userId === me ? { ...m, removedAt: '2026-11-01' } : m)) };
    expect(isGroupAdminFor(removed, me)).toBe(false);
    const unclaimedAdmin = { ...goa, members: goa.members.map((m) => (m.id === 'mem_goa_kabir' ? { ...m, role: 'admin' as const } : m)) };
    expect(isGroupAdminFor(unclaimedAdmin, '')).toBe(false);
  });
});

describe('UPI payee safety', () => {
  it('only the member themself or anyone for a placeholder may edit a UPI ID', async () => {
    const { canEditMemberUpi, describeRejectedUpi } = await import('../../src/utils/group-permissions');
    const goa = data.groups.find((g) => g.id === 'grp_goa_2026')!;
    const by = (id: string) => goa.members.find((m) => m.id === id)!;
    const me = data.currentUser.id;
    expect(canEditMemberUpi(by('mem_goa_arjun'), me)).toBe(true);
    expect(canEditMemberUpi(by('mem_goa_kabir'), me)).toBe(true);
    expect(canEditMemberUpi(by('mem_goa_rohan'), me)).toBe(false);
    expect(canEditMemberUpi(by('mem_goa_rohan'), '')).toBe(false);
    expect(canEditMemberUpi({ ...by('mem_goa_kabir'), removedAt: '2026-11-01' }, me)).toBe(false);

    const rej = (id: string, status: 'forbidden' | 'invalid') => ({ id, entity: 'group_member' as const, status });
    expect(describeRejectedUpi([rej('mem_goa_rohan', 'forbidden')], data.groups, me)).toBe('Only Rohan Verma can change their UPI ID.');
    expect(describeRejectedUpi([rej('mem_goa_rohan', 'invalid')], data.groups, me)).toBeNull();
    expect(describeRejectedUpi([rej('mem_goa_kabir', 'forbidden')], data.groups, me)).toBeNull();
    expect(describeRejectedUpi([rej('mem_goa_arjun', 'forbidden')], data.groups, me)).toBeNull();
  });
});

describe('actorLabel', () => {
  it('falls back calmly when the actor is unknown', async () => {
    const { actorLabel } = await import('../../src/utils/group-permissions');
    expect(actorLabel({ actorDisplayName: 'Rohan Verma', groupId: 'g' })).toBe('Rohan Verma');
    expect(actorLabel({ actorDisplayName: '  ', groupId: 'g' })).toBe('Someone in this group');
    expect(actorLabel({ actorDisplayName: null, groupId: null })).toBe('Someone on this bill');
  });
});
