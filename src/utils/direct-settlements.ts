import { computeCrossGroupFriendsSummary, directFriendKeys } from '../domain/ledger/ledger-engine';
import type { ExpenseItem, GroupRecord, SettlementItem } from '../types/ledger';
import type { SyncPushResult } from '../types/sync-contract';
import { isActiveGroupMember } from './group-permissions';

export interface DirectSettlementPlan {
  expenseId: string;
  fromMemberId: string;
  toMemberId: string;
  amountMinor: number;
  currency: string;
}

/**
 * One settlement per direct bill between me and the friend, anchored to that bill and using its
 * participant ids. The friend is matched across bills by `friendKey` (see `directFriendKeys`).
 * Each bill's net already accounts for settlements anchored to it.
 */
export function planDirectSettlements(params: {
  userEmail: string;
  friendKey: string;
  expenses: ExpenseItem[];
  settlements: SettlementItem[];
  fxRatesToInr: Record<string, number>;
}): DirectSettlementPlan[] {
  const me = params.userEmail.trim().toLowerCase();
  const friendKey = params.friendKey.trim().toLowerCase();
  const keys = directFriendKeys(params.userEmail, params.expenses);
  const plans: DirectSettlementPlan[] = [];
  for (const bill of params.expenses) {
    if (bill.groupId !== null || bill.deletedAt) continue;
    const parts = bill.adHocParticipants ?? [];
    const mine = parts.find((p) => p.invitedEmail?.trim().toLowerCase() === me);
    const friend = parts.find((p) => p !== mine && keys.get(p.id) === friendKey);
    if (!mine || !friend) continue;
    const anchored = params.settlements.filter((s) => s.expenseId === bill.id && !s.deletedAt);
    const entry = computeCrossGroupFriendsSummary(params.userEmail, [], [bill], anchored, params.fxRatesToInr).find(
      (f) => f.groupBreakdowns.some((b) => b.friendMemberId === friend.id)
    );
    const net = entry?.groupBreakdowns.reduce((sum, b) => sum + b.netMinor, 0) ?? 0;
    if (net === 0) continue;
    plans.push({
      expenseId: bill.id,
      fromMemberId: net > 0 ? friend.id : mine.id,
      toMemberId: net > 0 ? mine.id : friend.id,
      amountMinor: Math.abs(net),
      currency: bill.groupCurrency,
    });
  }
  return plans;
}

export function myParticipantId(bill: ExpenseItem, userEmail: string): string | null {
  const me = userEmail.trim().toLowerCase();
  return bill.adHocParticipants?.find((p) => p.invitedEmail?.trim().toLowerCase() === me)?.id ?? null;
}

/** The recorder must be the payer or the payee on the anchor bill. */
export function canRecordDirectSettlement(
  bill: ExpenseItem,
  userEmail: string,
  fromMemberId: string,
  toMemberId: string
): boolean {
  const ids = new Set((bill.adHocParticipants ?? []).map((p) => p.id));
  const mine = myParticipantId(bill, userEmail);
  return (
    ids.has(fromMemberId) &&
    ids.has(toMemberId) &&
    fromMemberId !== toMemberId &&
    mine !== null &&
    (mine === fromMemberId || mine === toMemberId)
  );
}

/** Either party, or the bill owner, may delete a direct settlement. */
export function canDeleteDirectSettlement(
  settlement: SettlementItem,
  bill: ExpenseItem,
  userEmail: string,
  userId: string
): boolean {
  const mine = myParticipantId(bill, userEmail);
  const isParty = mine !== null && (mine === settlement.fromMemberId || mine === settlement.toMemberId);
  const isOwner = bill.createdByMemberId === userId || (mine !== null && bill.createdByMemberId === mine);
  return isParty || isOwner;
}

/** YYYY-MM-DD in the device's local time zone. */
export function localIsoDate(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * A partial or full payback with a friend across direct bills in one currency. The direction is
 * the sign of the friend's net in that currency, and `maxMinor` is that net, so paying the most
 * allowed always ends at exactly 0. The amount is allocated to bills owed in that direction, oldest
 * first (expense date, then created time, then id), one anchored settlement per bill. Paying the
 * full net settles every open bill, both ways, so each bill reads 0. `expenseId` limits it to that
 * one bill. Plans are empty when the amount is not in (0, maxMinor]. `payeeUpiId` is the friend's
 * UPI id from the bills being paid only, and null when they have none or disagree.
 */
export function planDirectPayback(params: {
  userEmail: string;
  friendKey: string;
  currency: string;
  amountMinor: bigint;
  expenseId?: string | null;
  expenses: ExpenseItem[];
  settlements: SettlementItem[];
  fxRatesToInr: Record<string, number>;
}): { maxMinor: bigint; friendPays: boolean; plans: DirectSettlementPlan[]; payeeUpiId: string | null } {
  const me = params.userEmail.trim().toLowerCase();
  const currency = params.currency.trim().toUpperCase();
  const bills = new Map(params.expenses.map((e) => [e.id, e]));
  const open = planDirectSettlements(params).filter(
    (p) => p.currency.trim().toUpperCase() === currency && (!params.expenseId || p.expenseId === params.expenseId)
  );
  const friendPaysOn = (p: DirectSettlementPlan) =>
    bills.get(p.expenseId)?.adHocParticipants?.find((x) => x.id === p.toMemberId)?.invitedEmail?.trim().toLowerCase() === me;
  const net = open.reduce((sum, p) => sum + (friendPaysOn(p) ? 1n : -1n) * BigInt(p.amountMinor), 0n);
  const friendPays = net > 0n;
  const maxMinor = friendPays ? net : -net;
  const sortKey = (p: DirectSettlementPlan) => {
    const b = bills.get(p.expenseId);
    return `${b?.expenseDate ?? ''}|${b?.createdAt ?? ''}|${p.expenseId}`;
  };
  open.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
  const sameWay = open.filter((p) => friendPaysOn(p) === friendPays);
  const plans: DirectSettlementPlan[] = [];
  if (params.amountMinor > 0n && params.amountMinor === maxMinor) {
    plans.push(...open);
  } else if (params.amountMinor > 0n && params.amountMinor < maxMinor) {
    let left = params.amountMinor;
    for (const p of sameWay) {
      if (left === 0n) break;
      const take = BigInt(p.amountMinor) < left ? BigInt(p.amountMinor) : left;
      plans.push({ ...p, amountMinor: Number(take) });
      left -= take;
    }
  }
  const vpas = new Set(
    (plans.length > 0 ? plans : sameWay)
      .filter((p) => !friendPaysOn(p))
      .map((p) => bills.get(p.expenseId)?.adHocParticipants?.find((x) => x.id === p.toMemberId)?.upiId?.trim())
      .filter((v): v is string => !!v)
  );
  const payeeUpiId = !friendPays && vpas.size === 1 ? [...vpas][0]! : null;
  return { maxMinor, friendPays, plans, payeeUpiId };
}

/** Group payments: any active member of the group may change or remove one. */
export function canChangeGroupSettlement(
  _settlement: SettlementItem,
  group: GroupRecord,
  userId: string,
  userEmail: string
): boolean {
  return isActiveGroupMember(group, userId, userEmail);
}

/** Names where rejected payments were meant to land, for a calm toast; null when none were payments. */
export function describeRejectedSettlements(
  rejected: SyncPushResult[],
  data: { settlements: SettlementItem[]; groups: GroupRecord[]; expenses: ExpenseItem[] }
): string | null {
  const places = new Set<string>();
  for (const r of rejected) {
    if (r.entity !== 'settlement') continue;
    const s = data.settlements.find((x) => x.id === r.id);
    if (!s) continue;
    const name = s.groupId
      ? data.groups.find((g) => g.id === s.groupId)?.name
      : data.expenses.find((e) => e.id === s.expenseId)?.title;
    places.add(name ? `"${name}"` : 'a shared bill');
  }
  if (places.size === 0) return null;
  const list = [...places];
  const where = list.length === 1 ? list[0] : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
  return `${list.length === 1 ? 'The payment for' : 'Payments for'} ${where} could not be saved to your account. A new payment stays here, marked so you can fix or remove it; a change to an existing one went back to the saved version.`;
}

/** Why a deleted payment cannot come back (calm copy), or null when it can. Mirrors the server rules. */
export function whyCannotRestoreSettlement(
  settlement: SettlementItem,
  data: { groups: GroupRecord[]; expenses: ExpenseItem[] },
  userId: string,
  userEmail: string
): string | null {
  if (settlement.groupId) {
    const grp = data.groups.find((g) => g.id === settlement.groupId);
    if (!grp || !canChangeGroupSettlement(settlement, grp, userId, userEmail)) {
      return 'Only members of this group can bring back its payments.';
    }
    return grp.deletedAt ? `Restore the group "${grp.name}" first, then its payment.` : null;
  }
  const bill = data.expenses.find((e) => e.id === settlement.expenseId);
  if (!bill || !canDeleteDirectSettlement(settlement, bill, userEmail, userId)) {
    return 'Only the two people in this payment or the bill owner can bring it back.';
  }
  if (bill.deletedAt) return `Restore the bill "${bill.title}" first, then its payment.`;
  const ids = new Set((bill.adHocParticipants ?? []).map((p) => p.id));
  return ids.has(settlement.fromMemberId) && ids.has(settlement.toMemberId)
    ? null
    : `Someone in this payment is no longer on "${bill.title}", so it cannot come back.`;
}
