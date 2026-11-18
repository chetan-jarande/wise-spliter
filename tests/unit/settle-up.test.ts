import { describe, expect, it } from 'vitest';
import mockData from '../../src/data/mock-ledger-data.json';
import { computeCrossGroupFriendsSummary } from '../../src/domain/ledger/ledger-engine';
import type { ExpenseItem, GroupRecord, MockLedgerDataset, SettlementItem } from '../../src/types/ledger';
import {
  canChangeGroupSettlement,
  describeRejectedSettlements,
  localIsoDate,
  planDirectPayback,
  whyCannotRestoreSettlement,
} from '../../src/utils/direct-settlements';
import { buildPayeeUpiLink, isValidUpiId } from '../../src/utils/upi-link';

const clone = (): MockLedgerDataset => JSON.parse(JSON.stringify(mockData)) as MockLedgerDataset;

describe('UPI link building', () => {
  const base = { payeeName: 'Rohan Verma', amountMinor: 12345n, currency: 'INR', note: 'Goa trip' };

  it('validates handle@psp', () => {
    for (const ok of ['rohan@okaxis', 'rohan.verma@ybl', 'r_v-1@paytm', 'demo.user@upi.test']) expect(isValidUpiId(ok)).toBe(true);
    for (const bad of ['', '   ', 'rohan', '@okaxis', 'rohan@', 'ro han@okaxis', 'rohan@ok axis', 'a@b@c', 'rohan@1bank', 'x@okaxis', null, undefined]) {
      expect(isValidUpiId(bad), String(bad)).toBe(false);
    }
  });

  it('builds a link only to the payee\'s own valid id', () => {
    expect(buildPayeeUpiLink({ ...base, payeeUpiId: null })).toBeNull();
    expect(buildPayeeUpiLink({ ...base, payeeUpiId: '' })).toBeNull();
    expect(buildPayeeUpiLink({ ...base, payeeUpiId: 'not-a-vpa' })).toBeNull();
    expect(buildPayeeUpiLink({ ...base, payeeUpiId: ' rohan@okaxis ' })).toBe(
      'upi://pay?pa=rohan%40okaxis&pn=Rohan%20Verma&am=123.45&cu=INR&tn=Goa%20trip'
    );
  });

  it('rejects zero, negative and non-INR amounts', () => {
    expect(buildPayeeUpiLink({ ...base, payeeUpiId: 'rohan@okaxis', amountMinor: 0n })).toBeNull();
    expect(buildPayeeUpiLink({ ...base, payeeUpiId: 'rohan@okaxis', amountMinor: -5n })).toBeNull();
    expect(buildPayeeUpiLink({ ...base, payeeUpiId: 'rohan@okaxis', currency: 'USD' })).toBeNull();
  });

  it('encodes every parameter so none can inject another', () => {
    const link = buildPayeeUpiLink({
      payeeUpiId: 'rohan@okaxis',
      payeeName: 'R & V=1',
      amountMinor: 2n ** 60n,
      currency: 'inr',
      note: 'a+b #1 &pa=evil@ybl',
    })!;
    const q = new URLSearchParams(link.slice('upi://pay?'.length));
    expect(q.getAll('pa')).toEqual(['rohan@okaxis']);
    expect(q.get('pn')).toBe('R & V=1');
    expect(q.get('tn')).toBe('a+b #1 &pa=evil@ybl');
    expect(q.get('am')).toBe('11529215046068469.76');
    expect(q.get('cu')).toBe('INR');
    expect(link).not.toMatch(/[ #+]/);
  });
});

describe('local date', () => {
  it('uses local calendar fields, not UTC', () => {
    expect(localIsoDate(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
    expect(localIsoDate(new Date(2026, 11, 31, 0, 1))).toBe('2026-12-31');
  });
});

describe('partial direct payback (oldest bill first)', () => {
  const ME = 'me@example.com';
  const me = { id: '00000000-0000-4000-8000-00000000000a', displayName: 'Me', invitedEmail: ME, upiId: null, avatarInitials: 'ME', memberOrder: 0 };
  const tara = { id: '00000000-0000-4000-8000-0000000000f1', displayName: 'Tara', invitedEmail: null, upiId: null, avatarInitials: 'TA', memberOrder: 1 };
  const bill = (id: string, date: string, payerId: string, amount: number, currency = 'INR'): ExpenseItem => ({
    ...clone().expenses.find((e) => e.groupId === null)!,
    id, groupId: null, deletedAt: null, expenseDate: date, createdAt: `${date}T10:00:00Z`,
    groupCurrency: currency, originalCurrency: currency, amountMinor: amount, originalAmountMinor: amount,
    adHocParticipants: [me, tara],
    payers: [{ memberId: payerId, paidMinor: amount, originalPaidMinor: amount }],
    splits: [me.id, tara.id].map((memberId) => ({
      memberId, included: true, owedMinor: amount / 2, originalOwedMinor: amount / 2, rawInputValue: 1, remainderMinor: 0,
    })),
  });
  const bills = [
    bill('exp_new', '2026-11-10', me.id, 3000),
    bill('exp_old', '2026-11-01', me.id, 1000),
    bill('exp_mid', '2026-11-05', tara.id, 400),
    bill('exp_usd', '2026-10-01', me.id, 800, 'USD'),
  ];
  const toSettlements = (plans: ReturnType<typeof planDirectPayback>['plans'], tag: string): SettlementItem[] =>
    plans.map((p, i) => ({
      ...clone().settlements[0]!, id: `stl_${tag}_${i}`, groupId: null, expenseId: p.expenseId, batchSettlementId: null,
      fromMemberId: p.fromMemberId, toMemberId: p.toMemberId, amountMinor: p.amountMinor, currency: p.currency, deletedAt: null,
    }));
  const plan = (amountMinor: bigint, settlements: SettlementItem[], extra: { expenseId?: string; currency?: string } = {}) =>
    planDirectPayback({ userEmail: ME, friendKey: 'tara', currency: 'INR', amountMinor, expenses: bills, settlements, fxRatesToInr: {}, ...extra });
  const inrNet = (settlements: SettlementItem[]) =>
    computeCrossGroupFriendsSummary(ME, [], bills, settlements, {}).find((f) => f.friendKey === 'tara')?.netByCurrencyMinor?.INR ?? 0;

  it('caps at the friend net and allocates oldest first, one anchored settlement per bill', () => {
    expect(inrNet([])).toBe(500 + 1500 - 200);
    const first = plan(700n, []);
    expect(first.maxMinor).toBe(1800n);
    expect(first.friendPays).toBe(true);
    expect(first.plans.map((p) => [p.expenseId, p.amountMinor, p.fromMemberId, p.toMemberId])).toEqual([
      ['exp_old', 500, tara.id, me.id],
      ['exp_new', 200, tara.id, me.id],
    ]);
    const paid = toSettlements(first.plans, 'a');
    expect(inrNet(paid)).toBe(1100);

    const rest = plan(1100n, paid);
    expect(rest.maxMinor).toBe(1100n);
    const all = [...paid, ...toSettlements(rest.plans, 'b')];
    expect(inrNet(all)).toBe(0);
    expect(plan(1n, all).maxMinor).toBe(0n);
  });

  it('refuses empty, zero and more than owed', () => {
    expect(plan(0n, []).plans).toEqual([]);
    expect(plan(-1n, []).plans).toEqual([]);
    expect(plan(1801n, []).plans).toEqual([]);
    const full = plan(1800n, []).plans;
    expect(full.map((p) => [p.expenseId, p.amountMinor, p.fromMemberId])).toEqual([
      ['exp_old', 500, tara.id],
      ['exp_mid', 200, me.id],
      ['exp_new', 1500, tara.id],
    ]);
  });

  it('a full payback also closes the bill owed the other way, so every bill reads 0', () => {
    const settled = toSettlements(plan(1800n, []).plans, 'f');
    const rows = computeCrossGroupFriendsSummary(ME, [], bills, settled, {}).find((f) => f.friendKey === 'tara')!.groupBreakdowns;
    expect(rows.filter((r) => r.currency === 'INR')).toEqual([]);
    expect(plan(1n, settled).maxMinor).toBe(0n);
  });

  it('deleting a payment restores the balance', () => {
    const paid = toSettlements(plan(700n, []).plans, 'a');
    expect(inrNet(paid)).toBe(1100);
    expect(inrNet(paid.map((s, i) => (i === 0 ? { ...s, deletedAt: '2026-11-12T00:00:00Z' } : s)))).toBe(1600);
  });

  it('can be limited to one bill and to one currency', () => {
    expect(plan(1500n, [], { expenseId: 'exp_new' }).plans.map((p) => [p.expenseId, p.amountMinor])).toEqual([['exp_new', 1500]]);
    expect(plan(1501n, [], { expenseId: 'exp_new' }).plans).toEqual([]);
    const usd = plan(400n, [], { currency: 'usd' });
    expect(usd.plans.map((p) => [p.expenseId, p.amountMinor, p.currency])).toEqual([['exp_usd', 400, 'USD']]);
  });

  it('works the other way when I owe the friend', () => {
    const owe = planDirectPayback({
      userEmail: ME, friendKey: 'tara', currency: 'INR', amountMinor: 200n, expenses: [bills[2]!], settlements: [], fxRatesToInr: {},
    });
    expect(owe.friendPays).toBe(false);
    expect(owe.plans).toEqual([{ expenseId: 'exp_mid', fromMemberId: me.id, toMemberId: tara.id, amountMinor: 200, currency: 'INR' }]);
  });
});

describe('who a direct payback pays (UPI id) and who the friend is', () => {
  const ME = 'me@x.com';
  const me = { id: 'p_me', displayName: 'Me', invitedEmail: ME, upiId: 'me@okaxis', avatarInitials: 'ME', memberOrder: 0 };
  const person = (id: string, name: string, upiId: string | null, email: string | null = null) =>
    ({ id, displayName: name, invitedEmail: email, upiId, avatarInitials: 'XX', memberOrder: 1 });
  const bill = (id: string, date: string, payerId: string, amount: number, other: ReturnType<typeof person>): ExpenseItem => ({
    ...clone().expenses.find((e) => e.groupId === null)!,
    id, groupId: null, deletedAt: null, expenseDate: date, createdAt: `${date}T00:00:00Z`,
    groupCurrency: 'INR', originalCurrency: 'INR', amountMinor: amount, originalAmountMinor: amount,
    adHocParticipants: [me, other],
    payers: [{ memberId: payerId, paidMinor: amount, originalPaidMinor: amount }],
    splits: [me.id, other.id].map((memberId) => ({ memberId, included: true, owedMinor: amount / 2, originalOwedMinor: amount / 2, rawInputValue: 1, remainderMinor: 0 })),
  });
  const pay = (friendKey: string, expenses: ExpenseItem[], amountMinor: bigint) =>
    planDirectPayback({ userEmail: ME, friendKey, currency: 'INR', amountMinor, expenses, settlements: [], fxRatesToInr: {} });

  it('takes the UPI id only from the bill being paid, never from an unrelated bill', () => {
    const real = person('p_b9', 'Bob', 'bob@okhdfc', 'bob@x.com');
    const planted = person('p_bm', 'Bob', 'mallory@okaxis', 'bob@x.com');
    const expenses = [bill('e_planted', '2026-01-01', me.id, 2000, planted), bill('e_real', '2026-02-01', real.id, 6000, real)];
    const p = pay('bob@x.com', expenses, 1000n);
    expect(p.friendPays).toBe(false);
    expect(p.plans.map((x) => x.expenseId)).toEqual(['e_real']);
    expect(p.payeeUpiId).toBe('bob@okhdfc');
    const full = pay('bob@x.com', expenses, 2000n);
    expect(full.plans.map((x) => x.expenseId)).toEqual(['e_planted', 'e_real']);
    expect(full.payeeUpiId).toBe('bob@okhdfc');
  });

  it('gives no UPI id when the bills being paid disagree, have none, or I am the one being paid', () => {
    const b1 = person('p_b1', 'Bob', 'bob@okhdfc', 'bob@x.com');
    const b2 = person('p_b2', 'Bob', 'mallory@okaxis', 'bob@x.com');
    const both = [bill('e1', '2026-01-01', b1.id, 2000, b1), bill('e2', '2026-01-02', b2.id, 2000, b2)];
    expect(pay('bob@x.com', both, 2000n).payeeUpiId).toBeNull();
    const none = person('p_b3', 'Bob', null, 'bob@x.com');
    expect(pay('bob@x.com', [bill('e3', '2026-01-03', none.id, 2000, none)], 1000n).payeeUpiId).toBeNull();
    expect(pay('bob@x.com', [bill('e4', '2026-01-04', me.id, 2000, b1)], 1000n).payeeUpiId).toBeNull();
  });

  it('shows a friend card UPI id only when every record for that friend agrees', () => {
    const real = person('p_b9', 'Bob', 'bob@okhdfc', 'bob@x.com');
    const alsoReal = person('p_b8', 'Bob', ' bob@okhdfc ', 'bob@x.com');
    const planted = person('p_bm', 'Bob', 'mallory@okaxis', 'bob@x.com');
    const card = (expenses: ExpenseItem[]) =>
      computeCrossGroupFriendsSummary(ME, [], expenses, [], {}).find((f) => f.friendKey === 'bob@x.com')!;
    const agree = card([bill('e1', '2026-01-01', me.id, 2000, real), bill('e2', '2026-01-02', me.id, 2000, alsoReal)]);
    expect([agree.upiId, agree.upiIdVaries]).toEqual(['bob@okhdfc', false]);
    const settledPlant = { ...bill('e3', '2026-01-03', me.id, 2000, planted), amountMinor: 0, originalAmountMinor: 0 };
    for (const mixed of [
      [bill('e1', '2026-01-01', me.id, 2000, real), bill('e3', '2026-01-03', me.id, 2000, planted)],
      [bill('e3', '2026-01-03', me.id, 2000, planted), bill('e1', '2026-01-01', me.id, 2000, real)],
      [bill('e1', '2026-01-01', me.id, 2000, real), settledPlant],
    ]) {
      const c = card(mixed);
      expect([c.upiId, c.upiIdVaries]).toEqual([null, true]);
    }
  });

  it('keeps two different contacts with the same name and no email apart, so a payback never spans both', () => {
    const r1 = person('p_r1', 'Rahul', null);
    const r2 = person('p_r2', ' rahul ', null);
    const expenses = [bill('e_r1', '2026-01-01', me.id, 2000, r1), bill('e_r2', '2026-01-02', me.id, 4000, r2)];
    const friends = computeCrossGroupFriendsSummary(ME, [], expenses, [], {}).filter((f) => f.displayName.trim() === 'Rahul' || f.displayName.trim() === 'rahul');
    expect(friends.map((f) => [f.friendKey, f.netInInrMinor]).sort()).toEqual([['rahul|p_r1', 1000], ['rahul|p_r2', 2000]]);
    const p = pay('rahul|p_r2', expenses, 2000n);
    expect(p.maxMinor).toBe(2000n);
    expect(p.plans.map((x) => x.expenseId)).toEqual(['e_r2']);
    const one = computeCrossGroupFriendsSummary(ME, [], [expenses[0]!, bill('e_r1b', '2026-01-03', me.id, 600, r1)], [], {});
    expect(one.map((f) => [f.friendKey, f.netInInrMinor])).toEqual([['rahul', 1300]]);
  });
});

describe('friends across groups', () => {
  const twoGroupsWithRahul = (emailA: string | null, emailB: string | null) => {
    const d = clone();
    const goa = d.groups.find((g) => g.id === 'grp_goa_2026')!;
    const apt = d.groups.find((g) => g.id === 'grp_apt_14b')!;
    const rahul = (g: GroupRecord, email: string | null) => ({
      ...g.members[1]!, id: `mem_rahul_${g.id}`, groupId: g.id, userId: null, invitedEmail: email, displayName: 'Rahul', upiId: null,
    });
    goa.members.push(rahul(goa, emailA));
    apt.members.push(rahul(apt, emailB));
    const owesMe = (g: GroupRecord, id: string): ExpenseItem => {
      const me = g.members[0]!.id;
      const r = `mem_rahul_${g.id}`;
      return {
        ...d.expenses.find((e) => e.groupId === g.id)!, id, deletedAt: null, amountMinor: 1000, originalAmountMinor: 1000,
        payers: [{ memberId: me, paidMinor: 1000, originalPaidMinor: 1000 }],
        splits: [me, r].map((memberId) => ({ memberId, included: true, owedMinor: 500, originalOwedMinor: 500, rawInputValue: 1, remainderMinor: 0 })),
      };
    };
    const expenses = [owesMe(goa, 'exp_r1'), owesMe(apt, 'exp_r2')];
    return computeCrossGroupFriendsSummary(d.currentUser.email, [goa, apt], expenses, [], {}).filter((f) => f.displayName === 'Rahul');
  };

  it('keeps two placeholder "Rahul"s in different groups apart', () => {
    const rahuls = twoGroupsWithRahul(null, null);
    expect(rahuls).toHaveLength(2);
    expect(rahuls.map((r) => r.netInInrMinor)).toEqual([500, 500]);
  });

  it('links them when the same email is on both', () => {
    const rahuls = twoGroupsWithRahul('Rahul@Example.com', 'rahul@example.com ');
    expect(rahuls).toHaveLength(1);
    expect(rahuls[0]!.netInInrMinor).toBe(1000);
  });
});

describe('group settlement permissions', () => {
  const g = clone().groups.find((x) => x.id === 'grp_goa_2026')!;
  const stl: SettlementItem = { ...clone().settlements[0]!, fromMemberId: 'mem_goa_kabir', toMemberId: 'mem_goa_arjun' };
  const other = g.members.find((m) => m.role !== 'admin' && m.id !== stl.fromMemberId && m.id !== stl.toMemberId)!;

  it('lets any active member change it, even one who is not a party or the recorder', () => {
    expect(canChangeGroupSettlement(stl, g, other.userId!, other.invitedEmail!)).toBe(true);
    const kabir = g.members.find((m) => m.id === 'mem_goa_kabir')!;
    expect(canChangeGroupSettlement(stl, g, 'usr_kabir_new', kabir.invitedEmail!)).toBe(true);
  });

  it('refuses non-members and members who were removed', () => {
    expect(canChangeGroupSettlement(stl, g, 'usr_stranger', 'stranger@example.com')).toBe(false);
    const removed = { ...g, members: g.members.map((m) => (m.id === other.id ? { ...m, removedAt: '2026-11-12T00:00:00Z' } : m)) };
    expect(canChangeGroupSettlement(stl, removed, other.userId!, other.invitedEmail!)).toBe(false);
  });
});

describe('rejected payments message', () => {
  it('names the group or bill whose payment failed, and ignores other entities', () => {
    const d = clone();
    const s = d.settlements[0]!;
    const msg = describeRejectedSettlements([{ id: s.id, entity: 'settlement', status: 'forbidden' }], d);
    expect(msg).toContain('"Goa Villa & Scuba 2026"');
    expect(msg).not.toMatch(/[\u2013\u2014]/);
    expect(describeRejectedSettlements([{ id: 'x', entity: 'expense', status: 'invalid' }], d)).toBeNull();
    const two = describeRejectedSettlements(
      [{ id: s.id, entity: 'settlement', status: 'forbidden' }, { id: 'stl_b', entity: 'settlement', status: 'forbidden' }],
      { ...d, settlements: [s, { ...s, id: 'stl_b', groupId: 'grp_apt_14b' }] }
    );
    expect(two).toContain('"Goa Villa & Scuba 2026" and "Apt 14B Indiranagar"');
  });
});

describe('restoring a deleted payment', () => {
  const d = clone();
  const removed = (over: Partial<SettlementItem>): SettlementItem => ({ ...d.settlements[0]!, deletedAt: '2026-11-12T00:00:00Z', ...over });
  const arjun = { id: d.currentUser.id, email: d.currentUser.email };

  it('lets a group member restore, but not once the group is deleted or for a non-member', () => {
    expect(whyCannotRestoreSettlement(removed({}), d, arjun.id, arjun.email)).toBeNull();
    const gone = { ...d, groups: d.groups.map((g) => (g.id === 'grp_goa_2026' ? { ...g, deletedAt: '2026-11-13T00:00:00Z' } : g)) };
    expect(whyCannotRestoreSettlement(removed({}), gone, arjun.id, arjun.email)).toContain('Restore the group');
    expect(whyCannotRestoreSettlement(removed({}), d, 'usr_x', 'x@example.com')).toContain('Only members');
  });

  it('for a direct payment, needs a party or the owner, a live bill, and both people still on it', () => {
    const me = { id: '00000000-0000-4000-8000-00000000000a', displayName: 'Me', invitedEmail: 'me@example.com', upiId: null, avatarInitials: 'ME', memberOrder: 0 };
    const f = { ...me, id: '00000000-0000-4000-8000-0000000000f1', displayName: 'F', invitedEmail: null };
    const bill: ExpenseItem = { ...d.expenses.find((e) => e.groupId === null)!, id: 'exp_r', deletedAt: null, adHocParticipants: [me, f], createdByMemberId: f.id };
    const st = removed({ groupId: null, expenseId: 'exp_r', fromMemberId: f.id, toMemberId: me.id });
    expect(whyCannotRestoreSettlement(st, { groups: [], expenses: [bill] }, 'usr_me', 'me@example.com')).toBeNull();
    expect(whyCannotRestoreSettlement(st, { groups: [], expenses: [{ ...bill, deletedAt: '2026-11-13T00:00:00Z' }] }, 'usr_me', 'me@example.com')).toContain('Restore the bill');
    expect(whyCannotRestoreSettlement(st, { groups: [], expenses: [{ ...bill, adHocParticipants: [me] }] }, 'usr_me', 'me@example.com')).toContain('no longer on');
    expect(whyCannotRestoreSettlement(st, { groups: [], expenses: [bill] }, 'usr_o', 'other@example.com')).toContain('Only the two people');
  });
});
