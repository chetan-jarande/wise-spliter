import {
  ExpenseItem,
  GroupMember,
  GroupRecord,
  MemberBalanceExplanation,
  SettlementItem,
  SuggestedTransfer,
} from '../../types/ledger';
import { formatMinorToMajor } from '../money/currencies';

export function computeGroupNetBalances(
  expenses: ExpenseItem[],
  settlements: SettlementItem[],
  members: GroupMember[]
): Map<string, number> {
  const balances = new Map<string, number>();
  for (const m of members) {
    balances.set(m.id, 0);
  }

  for (const exp of expenses) {
    if (exp.deletedAt) continue;
    for (const p of exp.payers) {
      balances.set(p.memberId, (balances.get(p.memberId) ?? 0) + Math.round(p.paidMinor));
    }
    for (const s of exp.splits) {
      if (!s.included) continue;
      balances.set(s.memberId, (balances.get(s.memberId) ?? 0) - Math.round(s.owedMinor));
    }
  }

  for (const stl of settlements) {
    if (stl.deletedAt) continue;
    balances.set(stl.fromMemberId, (balances.get(stl.fromMemberId) ?? 0) + Math.round(stl.amountMinor));
    balances.set(stl.toMemberId, (balances.get(stl.toMemberId) ?? 0) - Math.round(stl.amountMinor));
  }

  return balances;
}

export function computeRawPairwiseTransfers(
  expenses: ExpenseItem[],
  settlements: SettlementItem[],
  members: GroupMember[],
  currencyCode: string
): SuggestedTransfer[] {
  const memberNameMap = new Map(members.map((m) => [m.id, m.displayName]));
  const matrix = new Map<string, number>();
  const keyOf = (from: string, to: string) => `${from}:::${to}`;

  const addDebt = (debtor: string, creditor: string, amount: number) => {
    if (debtor === creditor || amount <= 0) return;
    const forward = keyOf(debtor, creditor);
    const reverse = keyOf(creditor, debtor);
    const currentReverse = matrix.get(reverse) ?? 0;
    if (currentReverse > 0) {
      if (currentReverse >= amount) {
        matrix.set(reverse, currentReverse - amount);
      } else {
        matrix.set(reverse, 0);
        matrix.set(forward, (matrix.get(forward) ?? 0) + (amount - currentReverse));
      }
    } else {
      matrix.set(forward, (matrix.get(forward) ?? 0) + amount);
    }
  };

  for (const exp of expenses) {
    if (exp.deletedAt || exp.amountMinor <= 0) continue;
    const total = exp.amountMinor;
    for (const s of exp.splits) {
      if (!s.included || s.owedMinor <= 0) continue;
      let assigned = 0;
      exp.payers.forEach((p, idx) => {
        const isLast = idx === exp.payers.length - 1;
        const shareToPayer = isLast
          ? s.owedMinor - assigned
          : Math.round((s.owedMinor * p.paidMinor) / total);
        assigned += shareToPayer;
        addDebt(s.memberId, p.memberId, shareToPayer);
      });
    }
  }

  for (const stl of settlements) {
    if (stl.deletedAt || stl.amountMinor <= 0) continue;
    addDebt(stl.toMemberId, stl.fromMemberId, stl.amountMinor);
  }

  const results: SuggestedTransfer[] = [];
  for (const [k, amountMinor] of matrix.entries()) {
    if (amountMinor <= 0) continue;
    const [fromMemberId, toMemberId] = k.split(':::');
    if (!fromMemberId || !toMemberId) continue;
    const fromName = memberNameMap.get(fromMemberId) ?? fromMemberId;
    const toName = memberNameMap.get(toMemberId) ?? toMemberId;
    results.push({
      fromMemberId,
      toMemberId,
      amountMinor,
      explanationNote: `Direct unsimplified bilateral balance: ${fromName} owes ${toName} ${formatMinorToMajor(amountMinor, currencyCode)} across shared group bills.`,
    });
  }

  return results.sort((a, b) => b.amountMinor - a.amountMinor);
}

function settleSubsetGreedy(
  subset: Array<{ memberId: string; net: number }>,
  memberNameMap: Map<string, string>,
  currencyCode: string
): SuggestedTransfer[] {
  const creditors = subset
    .filter((x) => x.net > 0)
    .map((x) => ({ ...x }))
    .sort((a, b) => b.net - a.net);
  const debtors = subset
    .filter((x) => x.net < 0)
    .map((x) => ({ memberId: x.memberId, debt: -x.net }))
    .sort((a, b) => b.debt - a.debt);

  const transfers: SuggestedTransfer[] = [];
  let i = 0;
  let j = 0;

  while (i < debtors.length && j < creditors.length) {
    const d = debtors[i]!;
    const c = creditors[j]!;
    const transferAmount = Math.min(d.debt, c.net);
    if (transferAmount > 0) {
      const fromName = memberNameMap.get(d.memberId) ?? d.memberId;
      const toName = memberNameMap.get(c.memberId) ?? c.memberId;
      transfers.push({
        fromMemberId: d.memberId,
        toMemberId: c.memberId,
        amountMinor: transferAmount,
        explanationNote: `Minimum-transfer graph path: ${fromName} pays ${toName} ${formatMinorToMajor(transferAmount, currencyCode)} to clear net group positions.`,
      });
    }
    d.debt -= transferAmount;
    c.net -= transferAmount;
    if (d.debt === 0) i++;
    if (c.net === 0) j++;
  }

  return transfers;
}

export function simplifyGroupDebts(
  netBalances: Map<string, number>,
  members: GroupMember[],
  currencyCode = 'INR'
): SuggestedTransfer[] {
  const memberNameMap = new Map(members.map((m) => [m.id, m.displayName]));
  const nonZero = Array.from(netBalances.entries())
    .map(([memberId, net]) => ({ memberId, net: Math.round(net) }))
    .filter((x) => x.net !== 0);

  const n = nonZero.length;
  if (n <= 1) return [];

  // Bitmask DP exact zero-sum subset decomposition for n <= 14
  if (n <= 14) {
    const totalMasks = 1 << n;
    const sumByMask = new Int32Array(totalMasks);
    for (let mask = 1; mask < totalMasks; mask++) {
      const lsb = mask & -mask;
      const bitIdx = Math.clz32(lsb) ^ 31;
      sumByMask[mask] = sumByMask[mask ^ lsb]! + nonZero[bitIdx]!.net;
    }

    const dp = new Int16Array(totalMasks).fill(-1);
    const parentChoice = new Int32Array(totalMasks).fill(0);
    dp[0] = 0;

    for (let mask = 1; mask < totalMasks; mask++) {
      if (sumByMask[mask] !== 0) continue;
      dp[mask] = 1;
      parentChoice[mask] = mask;
      for (let sub = (mask - 1) & mask; sub > 0; sub = (sub - 1) & mask) {
        if (sumByMask[sub] === 0 && dp[sub]! > 0 && dp[mask ^ sub]! > 0) {
          const candidate = dp[sub]! + dp[mask ^ sub]!;
          if (candidate > dp[mask]!) {
            dp[mask] = candidate;
            parentChoice[mask] = sub;
          }
        }
      }
    }

    const fullMask = totalMasks - 1;
    if (dp[fullMask]! > 1) {
      const transfers: SuggestedTransfer[] = [];
      const extractSubsets = (mask: number) => {
        if (mask === 0) return;
        const choice = parentChoice[mask]!;
        if (choice === mask || choice === 0) {
          const subsetItems = nonZero.filter((_, idx) => (mask & (1 << idx)) !== 0);
          transfers.push(...settleSubsetGreedy(subsetItems, memberNameMap, currencyCode));
        } else {
          extractSubsets(choice);
          extractSubsets(mask ^ choice);
        }
      };
      extractSubsets(fullMask);
      return transfers;
    }
  }

  return settleSubsetGreedy(nonZero, memberNameMap, currencyCode);
}

export function explainMemberBalance(
  memberId: string,
  group: GroupRecord,
  expenses: ExpenseItem[],
  settlements: SettlementItem[]
): MemberBalanceExplanation {
  const member = group.members.find((m) => m.id === memberId);
  const memberName = member?.displayName ?? memberId;
  const currency = group.baseCurrency;

  let totalPaidMinor = 0;
  let totalShareMinor = 0;
  let settlementsSentMinor = 0;
  let settlementsReceivedMinor = 0;

  const contributingItems: MemberBalanceExplanation['contributingItems'] = [];

  for (const exp of expenses) {
    if (exp.deletedAt) continue;
    const paid = exp.payers
      .filter((p) => p.memberId === memberId)
      .reduce((acc, p) => acc + p.paidMinor, 0);
    const splitEntry = exp.splits.find((s) => s.memberId === memberId && s.included);
    const owed = splitEntry ? splitEntry.owedMinor : 0;

    if (paid > 0 || owed > 0) {
      totalPaidMinor += paid;
      totalShareMinor += owed;
      contributingItems.push({
        id: exp.id,
        type: 'expense',
        title: exp.title,
        date: exp.expenseDate,
        paidMinor: paid,
        owedMinor: owed,
        netDeltaMinor: paid - owed,
        splitBadge: `${exp.splitMode.toUpperCase()}${splitEntry?.remainderMinor ? ' (+1 remainder unit)' : ''}`,
      });
    }
  }

  for (const stl of settlements) {
    if (stl.deletedAt) continue;
    if (stl.fromMemberId === memberId) {
      settlementsSentMinor += stl.amountMinor;
      contributingItems.push({
        id: stl.id,
        type: 'settlement',
        title: `Settlement paid to ${group.members.find((m) => m.id === stl.toMemberId)?.displayName ?? 'Member'}`,
        date: stl.settledDate,
        paidMinor: stl.amountMinor,
        owedMinor: 0,
        netDeltaMinor: stl.amountMinor,
        splitBadge: stl.paymentMethod.toUpperCase(),
      });
    } else if (stl.toMemberId === memberId) {
      settlementsReceivedMinor += stl.amountMinor;
      contributingItems.push({
        id: stl.id,
        type: 'settlement',
        title: `Settlement received from ${group.members.find((m) => m.id === stl.fromMemberId)?.displayName ?? 'Member'}`,
        date: stl.settledDate,
        paidMinor: 0,
        owedMinor: stl.amountMinor,
        netDeltaMinor: -stl.amountMinor,
        splitBadge: stl.paymentMethod.toUpperCase(),
      });
    }
  }

  const netBalanceMinor =
    totalPaidMinor - totalShareMinor + settlementsSentMinor - settlementsReceivedMinor;

  const equationText = `Paid ${formatMinorToMajor(totalPaidMinor, currency)} - Share ${formatMinorToMajor(
    totalShareMinor,
    currency
  )} + Sent ${formatMinorToMajor(settlementsSentMinor, currency)} - Received ${formatMinorToMajor(
    settlementsReceivedMinor,
    currency
  )} = ${netBalanceMinor >= 0 ? '+' : ''}${formatMinorToMajor(netBalanceMinor, currency)}`;

  return {
    memberId,
    memberName,
    currency,
    totalPaidMinor,
    totalShareMinor,
    settlementsSentMinor,
    settlementsReceivedMinor,
    netBalanceMinor,
    equationText,
    contributingItems,
  };
}

export interface FriendCrossGroupSummary {
  friendKey: string;
  displayName: string;
  email: string | null;
  upiId: string | null;
  avatarInitials: string;
  isClaimedAccount: boolean;
  netInInrMinor: number;
  groupBreakdowns: Array<{
    groupId: string;
    groupName: string;
    currency: string;
    myMemberId: string;
    friendMemberId: string;
    netMinor: number; // Positive means friend owes current user; negative means current user owes friend
  }>;
}

export function computeCrossGroupFriendsSummary(
  currentUserEmail: string,
  groups: GroupRecord[],
  expenses: ExpenseItem[],
  settlements: SettlementItem[],
  fxRatesToInr: Record<string, number>
): FriendCrossGroupSummary[] {
  const friendMap = new Map<string, FriendCrossGroupSummary>();

  for (const grp of groups) {
    if (grp.deletedAt) continue;
    const myMember = grp.members.find(
      (m) => m.invitedEmail?.toLowerCase() === currentUserEmail.toLowerCase()
    );
    if (!myMember) continue;

    const grpExpenses = expenses.filter((e) => e.groupId === grp.id && !e.deletedAt);
    const grpSettlements = settlements.filter((s) => s.groupId === grp.id && !s.deletedAt);

    const transfers = grp.simplifyDebts
      ? simplifyGroupDebts(
          computeGroupNetBalances(grpExpenses, grpSettlements, grp.members),
          grp.members,
          grp.baseCurrency
        )
      : computeRawPairwiseTransfers(grpExpenses, grpSettlements, grp.members, grp.baseCurrency);

    for (const m of grp.members) {
      if (m.id === myMember.id) continue;
      const friendKey = (m.invitedEmail ?? m.displayName).toLowerCase();

      // Calculate direct transfer balance between myMember and m
      let netMinor = 0;
      for (const t of transfers) {
        if (t.fromMemberId === m.id && t.toMemberId === myMember.id) {
          netMinor += t.amountMinor;
        } else if (t.fromMemberId === myMember.id && t.toMemberId === m.id) {
          netMinor -= t.amountMinor;
        }
      }

      if (!friendMap.has(friendKey)) {
        friendMap.set(friendKey, {
          friendKey,
          displayName: m.displayName,
          email: m.invitedEmail,
          upiId: m.upiId,
          avatarInitials: m.avatarInitials,
          isClaimedAccount: m.userId !== null,
          netInInrMinor: 0,
          groupBreakdowns: [],
        });
      }

      const entry = friendMap.get(friendKey)!;
      if (m.userId !== null) entry.isClaimedAccount = true;
      if (m.upiId && !entry.upiId) entry.upiId = m.upiId;

      if (netMinor !== 0) {
        entry.groupBreakdowns.push({
          groupId: grp.id,
          groupName: grp.name,
          currency: grp.baseCurrency,
          myMemberId: myMember.id,
          friendMemberId: m.id,
          netMinor,
        });

        const rateToInr = fxRatesToInr[grp.baseCurrency] ?? 1;
        const decimals = grp.baseCurrency === 'JPY' ? 0 : grp.baseCurrency === 'KWD' ? 3 : 2;
        const majorVal = netMinor / Math.pow(10, decimals);
        entry.netInInrMinor += Math.round(majorVal * rateToInr * 100);
      }
    }
  }

  return Array.from(friendMap.values()).sort(
    (a, b) => Math.abs(b.netInInrMinor) - Math.abs(a.netInInrMinor)
  );
}
