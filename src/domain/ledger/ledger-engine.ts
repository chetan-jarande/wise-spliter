import {
  ExpenseItem,
  GroupMember,
  GroupRecord,
  MemberBalanceExplanation,
  SettlementItem,
  SuggestedTransfer,
} from '../../types/ledger';
import {
  convertForeignToBaseMinor,
  formatMinorToMajor,
  parseFxRateToScaled,
} from '../money/currencies';
import { allocateProportionalMinorAmounts } from '../splits/split-calculator';

export function computeGroupNetBalances(
  expenses: ExpenseItem[],
  settlements: SettlementItem[],
  members: GroupMember[]
): Map<string, number> {
  const balances = new Map<string, bigint>();
  for (const m of members) {
    balances.set(m.id, 0n);
  }

  for (const exp of expenses) {
    if (exp.deletedAt) continue;
    for (const p of exp.payers) {
      const paid = Number.isFinite(p.paidMinor) ? BigInt(Math.round(p.paidMinor)) : 0n;
      balances.set(p.memberId, (balances.get(p.memberId) ?? 0n) + paid);
    }
    for (const s of exp.splits) {
      if (!s.included) continue;
      const owed = Number.isFinite(s.owedMinor) ? BigInt(Math.round(s.owedMinor)) : 0n;
      balances.set(s.memberId, (balances.get(s.memberId) ?? 0n) - owed);
    }
  }

  for (const stl of settlements) {
    if (stl.deletedAt || stl.fromMemberId === stl.toMemberId) continue;
    const amt = Number.isFinite(stl.amountMinor) ? BigInt(Math.round(stl.amountMinor)) : 0n;
    if (amt <= 0n) continue;
    balances.set(stl.fromMemberId, (balances.get(stl.fromMemberId) ?? 0n) + amt);
    balances.set(stl.toMemberId, (balances.get(stl.toMemberId) ?? 0n) - amt);
  }

  const out = new Map<string, number>();
  for (const [memberId, netBig] of balances.entries()) {
    out.set(memberId, netBig === 0n ? 0 : Number(netBig));
  }
  return out;
}

/**
 * Allocates bilateral debts on a single expense using net intra-bill surpluses and deficits:
 *   delta(m) = paid(m) - owed(m)
 * A payer who underpaid their own share (delta < 0) is a net debtor on that bill, never a creditor.
 * Uses Sequential Margin-Conserving Hamilton Largest Remainder so BOTH debtor row totals AND
 * creditor column surpluses reconcile 100% with zero rounding drift.
 */
function allocateExpenseBilateralDebts(
  exp: ExpenseItem,
  memberOrderMap: Map<string, number>,
  onDebt: (debtorId: string, creditorId: string, amount: bigint) => void
): void {
  if (exp.deletedAt || exp.amountMinor <= 0) return;

  const netByMember = new Map<string, bigint>();
  for (const p of exp.payers) {
    const paid = Number.isFinite(p.paidMinor) ? BigInt(Math.round(p.paidMinor)) : 0n;
    if (paid > 0n) {
      netByMember.set(p.memberId, (netByMember.get(p.memberId) ?? 0n) + paid);
    }
  }
  for (const s of exp.splits) {
    if (!s.included) continue;
    const owed = Number.isFinite(s.owedMinor) ? BigInt(Math.round(s.owedMinor)) : 0n;
    if (owed > 0n) {
      netByMember.set(s.memberId, (netByMember.get(s.memberId) ?? 0n) - owed);
    }
  }

  const sortByMemberOrder = (a: string, b: string): number => {
    const ordA = memberOrderMap.get(a) ?? Number.MAX_SAFE_INTEGER;
    const ordB = memberOrderMap.get(b) ?? Number.MAX_SAFE_INTEGER;
    if (ordA !== ordB) return ordA - ordB;
    return a < b ? -1 : a > b ? 1 : 0;
  };

  const creditors: Array<{ memberId: string; remainingSurplus: bigint }> = [];
  const debtors: Array<{ memberId: string; deficit: bigint }> = [];

  const sortedIds = Array.from(netByMember.keys()).sort(sortByMemberOrder);
  for (const memberId of sortedIds) {
    const delta = netByMember.get(memberId)!;
    if (delta > 0n) {
      creditors.push({ memberId, remainingSurplus: delta });
    } else if (delta < 0n) {
      debtors.push({ memberId, deficit: -delta });
    }
  }

  if (creditors.length === 0 || debtors.length === 0) return;

  for (let dIdx = 0; dIdx < debtors.length; dIdx++) {
    const debtor = debtors[dIdx]!;
    const totalRemainingSurplus = creditors.reduce((acc, c) => acc + c.remainingSurplus, 0n);
    if (totalRemainingSurplus <= 0n) break;

    const poolToAllocate =
      debtor.deficit <= totalRemainingSurplus ? debtor.deficit : totalRemainingSurplus;
    const weights = creditors.map((c) => c.remainingSurplus);
    const alloc = allocateProportionalMinorAmounts(
      poolToAllocate,
      weights,
      exp.rotationSeed + dIdx
    );

    for (let cIdx = 0; cIdx < creditors.length; cIdx++) {
      const share = alloc.amounts[cIdx]!;
      if (share > 0n) {
        creditors[cIdx]!.remainingSurplus -= share;
        onDebt(debtor.memberId, creditors[cIdx]!.memberId, share);
      }
    }
  }
}

export function computeRawPairwiseTransfers(
  expenses: ExpenseItem[],
  settlements: SettlementItem[],
  members: GroupMember[],
  currencyCode: string
): SuggestedTransfer[] {
  const memberNameMap = new Map(members.map((m) => [m.id, m.displayName]));
  const memberOrderMap = new Map(members.map((m) => [m.id, m.memberOrder]));
  const matrix = new Map<string, bigint>();
  const keyOf = (from: string, to: string) => `${from}:::${to}`;

  const addDebt = (debtor: string, creditor: string, amount: bigint) => {
    if (debtor === creditor || amount <= 0n) return;
    const forward = keyOf(debtor, creditor);
    const reverse = keyOf(creditor, debtor);
    const currentReverse = matrix.get(reverse) ?? 0n;
    if (currentReverse > 0n) {
      if (currentReverse >= amount) {
        matrix.set(reverse, currentReverse - amount);
      } else {
        matrix.set(reverse, 0n);
        matrix.set(forward, (matrix.get(forward) ?? 0n) + (amount - currentReverse));
      }
    } else {
      matrix.set(forward, (matrix.get(forward) ?? 0n) + amount);
    }
  };

  for (const exp of expenses) {
    allocateExpenseBilateralDebts(exp, memberOrderMap, addDebt);
  }

  for (const stl of settlements) {
    if (stl.deletedAt || stl.fromMemberId === stl.toMemberId) continue;
    const amt = Number.isFinite(stl.amountMinor) ? BigInt(Math.round(stl.amountMinor)) : 0n;
    if (amt <= 0n) continue;
    addDebt(stl.toMemberId, stl.fromMemberId, amt);
  }

  const results: SuggestedTransfer[] = [];
  for (const [k, amountBig] of matrix.entries()) {
    if (amountBig <= 0n) continue;
    const [fromMemberId, toMemberId] = k.split(':::');
    if (!fromMemberId || !toMemberId) continue;
    const amountMinor = Number(amountBig);
    const fromName = memberNameMap.get(fromMemberId) ?? fromMemberId;
    const toName = memberNameMap.get(toMemberId) ?? toMemberId;
    results.push({
      fromMemberId,
      toMemberId,
      amountMinor,
      explanationNote: `Direct unsimplified bilateral balance: ${fromName} owes ${toName} ${formatMinorToMajor(amountMinor, currencyCode)} across shared group bills.`,
    });
  }

  return results.sort((a, b) => {
    if (b.amountMinor !== a.amountMinor) return b.amountMinor - a.amountMinor;
    if (a.fromMemberId !== b.fromMemberId) {
      return a.fromMemberId < b.fromMemberId ? -1 : 1;
    }
    return a.toMemberId < b.toMemberId ? -1 : a.toMemberId > b.toMemberId ? 1 : 0;
  });
}

function settleSubsetGreedy(
  subset: Array<{ memberId: string; net: bigint }>,
  memberNameMap: Map<string, string>,
  currencyCode: string
): SuggestedTransfer[] {
  const creditors = subset
    .filter((x) => x.net > 0n)
    .map((x) => ({ memberId: x.memberId, net: x.net }));
  const debtors = subset
    .filter((x) => x.net < 0n)
    .map((x) => ({ memberId: x.memberId, debt: -x.net }));

  const transfers: SuggestedTransfer[] = [];

  // Deterministic Max-Creditor / Max-Debtor matching
  while (true) {
    let bestCIdx = -1;
    for (let j = 0; j < creditors.length; j++) {
      const c = creditors[j]!;
      if (c.net <= 0n) continue;
      if (
        bestCIdx === -1 ||
        c.net > creditors[bestCIdx]!.net ||
        (c.net === creditors[bestCIdx]!.net && c.memberId < creditors[bestCIdx]!.memberId)
      ) {
        bestCIdx = j;
      }
    }

    let bestDIdx = -1;
    for (let i = 0; i < debtors.length; i++) {
      const d = debtors[i]!;
      if (d.debt <= 0n) continue;
      if (
        bestDIdx === -1 ||
        d.debt > debtors[bestDIdx]!.debt ||
        (d.debt === debtors[bestDIdx]!.debt && d.memberId < debtors[bestDIdx]!.memberId)
      ) {
        bestDIdx = i;
      }
    }

    if (bestCIdx === -1 || bestDIdx === -1) break;

    const d = debtors[bestDIdx]!;
    const c = creditors[bestCIdx]!;
    const transferBig = d.debt < c.net ? d.debt : c.net;

    if (transferBig > 0n) {
      const transferAmount = Number(transferBig);
      const fromName = memberNameMap.get(d.memberId) ?? d.memberId;
      const toName = memberNameMap.get(c.memberId) ?? c.memberId;
      transfers.push({
        fromMemberId: d.memberId,
        toMemberId: c.memberId,
        amountMinor: transferAmount,
        explanationNote: `Minimum-transfer graph path: ${fromName} pays ${toName} ${formatMinorToMajor(transferAmount, currencyCode)} to clear net group positions.`,
      });
    }

    d.debt -= transferBig;
    c.net -= transferBig;
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
    .map(([memberId, net]) => ({
      memberId,
      net: Number.isFinite(net) ? BigInt(Math.round(net)) : 0n,
    }))
    .filter((x) => x.net !== 0n)
    .sort((a, b) => (a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0));

  const n = nonZero.length;
  if (n <= 1) return [];

  // Exact O(n * 2^n) Bitmask-DP maximum zero-sum subset partitioning for n <= 16
  // Uses BigInt subset sums so balances > 2^31 - 1 never overflow 32-bit integers.
  if (n <= 16) {
    const totalMasks = 1 << n;
    const sumByMask: bigint[] = new Array<bigint>(totalMasks);
    sumByMask[0] = 0n;
    for (let mask = 1; mask < totalMasks; mask++) {
      const lsb = mask & -mask;
      const bitIdx = Math.clz32(lsb) ^ 31;
      sumByMask[mask] = sumByMask[mask ^ lsb]! + nonZero[bitIdx]!.net;
    }

    const fullMask = totalMasks - 1;
    if (sumByMask[fullMask] === 0n) {
      const dp = new Int16Array(totalMasks);
      const prevBit = new Int8Array(totalMasks).fill(-1);
      dp[0] = 0;

      for (let mask = 1; mask < totalMasks; mask++) {
        let bestPrev = -1;
        let chosenBit = -1;
        let m = mask;
        while (m !== 0) {
          const lsb = m & -m;
          const bitIdx = Math.clz32(lsb) ^ 31;
          const withoutBit = mask ^ lsb;
          const prevVal = dp[withoutBit]!;
          if (prevVal > bestPrev) {
            bestPrev = prevVal;
            chosenBit = bitIdx;
          }
          m ^= lsb;
        }
        dp[mask] = bestPrev + (sumByMask[mask] === 0n ? 1 : 0);
        prevBit[mask] = chosenBit;
      }

      if (dp[fullMask]! > 1) {
        const subsets: Array<Array<{ memberId: string; net: bigint }>> = [];
        let curr = fullMask;
        let currentSubset: Array<{ memberId: string; net: bigint }> = [];

        while (curr > 0) {
          const bit = prevBit[curr]!;
          if (bit < 0) break;
          currentSubset.push(nonZero[bit]!);
          const next = curr ^ (1 << bit);
          if (next === 0 || sumByMask[next] === 0n) {
            subsets.push(currentSubset);
            currentSubset = [];
          }
          curr = next;
        }

        const transfers: SuggestedTransfer[] = [];
        for (const sub of subsets) {
          transfers.push(...settleSubsetGreedy(sub, memberNameMap, currencyCode));
        }
        return transfers;
      }
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

  let totalPaidMinor = 0n;
  let totalShareMinor = 0n;
  let settlementsSentMinor = 0n;
  let settlementsReceivedMinor = 0n;

  const contributingItems: MemberBalanceExplanation['contributingItems'] = [];

  for (const exp of expenses) {
    if (exp.deletedAt) continue;
    const paidBig = exp.payers
      .filter((p) => p.memberId === memberId)
      .reduce(
        (acc, p) => acc + (Number.isFinite(p.paidMinor) ? BigInt(Math.round(p.paidMinor)) : 0n),
        0n
      );
    const splitEntry = exp.splits.find((s) => s.memberId === memberId && s.included);
    const owedBig =
      splitEntry && Number.isFinite(splitEntry.owedMinor)
        ? BigInt(Math.round(splitEntry.owedMinor))
        : 0n;

    if (paidBig !== 0n || owedBig !== 0n) {
      totalPaidMinor += paidBig;
      totalShareMinor += owedBig;
      const paid = Number(paidBig);
      const owed = Number(owedBig);
      contributingItems.push({
        id: exp.id,
        type: 'expense',
        title: exp.title,
        date: exp.expenseDate,
        paidMinor: paid,
        owedMinor: owed,
        netDeltaMinor: Number(paidBig - owedBig),
        splitBadge: `${exp.splitMode.toUpperCase()}${splitEntry?.remainderMinor ? ' (+1 remainder unit)' : ''}`,
      });
    }
  }

  for (const stl of settlements) {
    if (stl.deletedAt || stl.fromMemberId === stl.toMemberId) continue;
    const amtBig = Number.isFinite(stl.amountMinor) ? BigInt(Math.round(stl.amountMinor)) : 0n;
    if (amtBig <= 0n) continue;
    const amt = Number(amtBig);

    if (stl.fromMemberId === memberId) {
      settlementsSentMinor += amtBig;
      contributingItems.push({
        id: stl.id,
        type: 'settlement',
        title: `Settlement paid to ${group.members.find((m) => m.id === stl.toMemberId)?.displayName ?? 'Member'}`,
        date: stl.settledDate,
        paidMinor: amt,
        owedMinor: 0,
        netDeltaMinor: amt,
        splitBadge: stl.paymentMethod.toUpperCase(),
      });
    } else if (stl.toMemberId === memberId) {
      settlementsReceivedMinor += amtBig;
      contributingItems.push({
        id: stl.id,
        type: 'settlement',
        title: `Settlement received from ${group.members.find((m) => m.id === stl.fromMemberId)?.displayName ?? 'Member'}`,
        date: stl.settledDate,
        paidMinor: 0,
        owedMinor: amt,
        netDeltaMinor: -amt,
        splitBadge: stl.paymentMethod.toUpperCase(),
      });
    }
  }

  const netBig =
    totalPaidMinor - totalShareMinor + settlementsSentMinor - settlementsReceivedMinor;
  const netBalanceMinor = netBig === 0n ? 0 : Number(netBig);
  const paidNum = Number(totalPaidMinor);
  const shareNum = Number(totalShareMinor);
  const sentNum = Number(settlementsSentMinor);
  const recvNum = Number(settlementsReceivedMinor);

  const equationText = `Paid ${formatMinorToMajor(paidNum, currency)} - Share ${formatMinorToMajor(
    shareNum,
    currency
  )} + Sent ${formatMinorToMajor(sentNum, currency)} - Received ${formatMinorToMajor(
    recvNum,
    currency
  )} = ${netBalanceMinor >= 0 ? '+' : ''}${formatMinorToMajor(netBalanceMinor, currency)}`;

  return {
    memberId,
    memberName,
    currency,
    totalPaidMinor: paidNum,
    totalShareMinor: shareNum,
    settlementsSentMinor: sentNum,
    settlementsReceivedMinor: recvNum,
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
  netByCurrencyMinor?: Record<string, number>;
  groupBreakdowns: Array<{
    groupId: string | null;
    groupName: string;
    currency: string;
    myMemberId: string;
    friendMemberId: string;
    netMinor: number; // Positive means friend owes current user; negative means current user owes friend
  }>;
}

function convertCurrencyMinorToInrMinor(
  minorAmount: number,
  currencyCode: string,
  fxRatesToInr: Record<string, number>
): number {
  const normCode = currencyCode.trim().toUpperCase();
  if (minorAmount === 0) return 0;
  if (normCode === 'INR') return Math.round(minorAmount);

  const rawRate =
    fxRatesToInr[normCode] ??
    fxRatesToInr[currencyCode] ??
    1;
  const rateScaled = parseFxRateToScaled(rawRate);
  const converted = convertForeignToBaseMinor(minorAmount, normCode, 'INR', rateScaled);
  return converted === 0n ? 0 : Number(converted);
}

export function computeCrossGroupFriendsSummary(
  currentUserEmail: string,
  groups: GroupRecord[],
  expenses: ExpenseItem[],
  settlements: SettlementItem[],
  fxRatesToInr: Record<string, number>
): FriendCrossGroupSummary[] {
  const normUserEmail = currentUserEmail.trim().toLowerCase();
  const friendMap = new Map<string, FriendCrossGroupSummary>();

  const ensureFriendEntry = (params: {
    friendKey: string;
    displayName: string;
    email: string | null;
    upiId: string | null;
    avatarInitials: string;
    isClaimedAccount: boolean;
  }): FriendCrossGroupSummary => {
    if (!friendMap.has(params.friendKey)) {
      friendMap.set(params.friendKey, {
        friendKey: params.friendKey,
        displayName: params.displayName,
        email: params.email,
        upiId: params.upiId,
        avatarInitials: params.avatarInitials,
        isClaimedAccount: params.isClaimedAccount,
        netInInrMinor: 0,
        netByCurrencyMinor: {},
        groupBreakdowns: [],
      });
    }
    const entry = friendMap.get(params.friendKey)!;
    if (params.isClaimedAccount) entry.isClaimedAccount = true;
    if (params.upiId && !entry.upiId) entry.upiId = params.upiId;
    if (params.email && !entry.email) entry.email = params.email;
    return entry;
  };

  for (const grp of groups) {
    if (grp.deletedAt) continue;
    const myMember = grp.members.find(
      (m) => m.invitedEmail?.trim().toLowerCase() === normUserEmail
    );
    if (!myMember) continue;

    const grpExpenses = expenses.filter((e) => e.groupId === grp.id && !e.deletedAt);
    const grpSettlements = settlements.filter((s) => s.groupId === grp.id && !s.deletedAt);
    const normCurrency = grp.baseCurrency.trim().toUpperCase();

    const transfers = grp.simplifyDebts
      ? simplifyGroupDebts(
          computeGroupNetBalances(grpExpenses, grpSettlements, grp.members),
          grp.members,
          normCurrency
        )
      : computeRawPairwiseTransfers(grpExpenses, grpSettlements, grp.members, normCurrency);

    for (const m of grp.members) {
      if (m.id === myMember.id) continue;
      const friendKey = (m.invitedEmail?.trim() || m.displayName.trim()).toLowerCase();

      let netMinor = 0;
      for (const t of transfers) {
        if (t.fromMemberId === m.id && t.toMemberId === myMember.id) {
          netMinor += t.amountMinor;
        } else if (t.fromMemberId === myMember.id && t.toMemberId === m.id) {
          netMinor -= t.amountMinor;
        }
      }

      const entry = ensureFriendEntry({
        friendKey,
        displayName: m.displayName,
        email: m.invitedEmail,
        upiId: m.upiId,
        avatarInitials: m.avatarInitials,
        isClaimedAccount: m.userId !== null,
      });

      if (netMinor !== 0) {
        entry.groupBreakdowns.push({
          groupId: grp.id,
          groupName: grp.name,
          currency: normCurrency,
          myMemberId: myMember.id,
          friendMemberId: m.id,
          netMinor,
        });
      }
    }
  }

  // Aggregate Direct Non-Group Expenses (groupId === null) & Direct Settlements (groupId === null)
  const standaloneExpenses = expenses.filter((e) => e.groupId === null && !e.deletedAt);
  const adHocDirectory = new Map<
    string,
    {
      id: string;
      displayName: string;
      invitedEmail: string | null;
      upiId: string | null;
      avatarInitials: string;
    }
  >();

  for (const exp of standaloneExpenses) {
    const participants = exp.adHocParticipants ?? [];
    for (const p of participants) {
      if (!adHocDirectory.has(p.id)) {
        adHocDirectory.set(p.id, {
          id: p.id,
          displayName: p.displayName,
          invitedEmail: p.invitedEmail,
          upiId: p.upiId,
          avatarInitials: p.avatarInitials,
        });
      }
    }

    const me = participants.find(
      (p) => p.invitedEmail?.trim().toLowerCase() === normUserEmail
    );
    if (!me || exp.amountMinor <= 0) continue;

    const orderMap = new Map(participants.map((p) => [p.id, p.memberOrder]));
    const pairwiseWithMe = new Map<string, bigint>();

    allocateExpenseBilateralDebts(exp, orderMap, (debtorId, creditorId, amountBig) => {
      if (creditorId === me.id && debtorId !== me.id) {
        pairwiseWithMe.set(debtorId, (pairwiseWithMe.get(debtorId) ?? 0n) + amountBig);
      } else if (debtorId === me.id && creditorId !== me.id) {
        pairwiseWithMe.set(creditorId, (pairwiseWithMe.get(creditorId) ?? 0n) - amountBig);
      }
    });

    const normCurrency = exp.groupCurrency.trim().toUpperCase();
    for (const p of participants) {
      if (p.id === me.id) continue;
      const deltaBig = pairwiseWithMe.get(p.id) ?? 0n;
      if (deltaBig === 0n) continue;

      const friendKey = (p.invitedEmail?.trim() || p.displayName.trim()).toLowerCase();
      const entry = ensureFriendEntry({
        friendKey,
        displayName: p.displayName,
        email: p.invitedEmail,
        upiId: p.upiId,
        avatarInitials: p.avatarInitials,
        isClaimedAccount: false,
      });

      entry.groupBreakdowns.push({
        groupId: null,
        groupName: `Direct: ${exp.title}`,
        currency: normCurrency,
        myMemberId: me.id,
        friendMemberId: p.id,
        netMinor: Number(deltaBig),
      });
    }
  }

  // Offset any Direct Non-Group Settlements (groupId === null) against standalone breakdowns
  const standaloneSettlements = settlements.filter(
    (s) => s.groupId === null && !s.deletedAt && s.fromMemberId !== s.toMemberId && s.amountMinor > 0
  );
  for (const stl of standaloneSettlements) {
    const fromMeta = adHocDirectory.get(stl.fromMemberId);
    const toMeta = adHocDirectory.get(stl.toMemberId);
    const fromIsMe = fromMeta?.invitedEmail?.trim().toLowerCase() === normUserEmail;
    const toIsMe = toMeta?.invitedEmail?.trim().toLowerCase() === normUserEmail;
    if (!fromIsMe && !toIsMe) continue;

    const friendMeta = fromIsMe ? toMeta : fromMeta;
    const myId = fromIsMe ? stl.fromMemberId : stl.toMemberId;
    const friendId = fromIsMe ? stl.toMemberId : stl.fromMemberId;
    const friendKey = friendMeta
      ? (friendMeta.invitedEmail?.trim() || friendMeta.displayName.trim()).toLowerCase()
      : friendId.toLowerCase();

    const entry = friendMap.get(friendKey);
    const stlCurrency = stl.currency.trim().toUpperCase();
    // When I pay friend, friend owes me more (+stl.amountMinor); when friend pays me, friend owes me less (-stl.amountMinor)
    let remainingDelta = fromIsMe ? Math.round(stl.amountMinor) : -Math.round(stl.amountMinor);

    if (entry) {
      for (const bd of entry.groupBreakdowns) {
        if (bd.groupId !== null || bd.currency !== stlCurrency || remainingDelta === 0) continue;
        // Offset opposing balances first
        if ((bd.netMinor > 0 && remainingDelta < 0) || (bd.netMinor < 0 && remainingDelta > 0)) {
          const offsetMag = Math.min(Math.abs(bd.netMinor), Math.abs(remainingDelta));
          const signedOffset = remainingDelta > 0 ? offsetMag : -offsetMag;
          bd.netMinor += signedOffset;
          remainingDelta -= signedOffset;
        }
      }
      entry.groupBreakdowns = entry.groupBreakdowns.filter((bd) => bd.netMinor !== 0);

      if (remainingDelta !== 0) {
        entry.groupBreakdowns.push({
          groupId: null,
          groupName: 'Direct Settlement Balance',
          currency: stlCurrency,
          myMemberId: myId,
          friendMemberId: friendId,
          netMinor: remainingDelta,
        });
      }
    }
  }

  // Compute exact per-currency totals and BigInt-accurate INR normalized totals
  for (const entry of friendMap.values()) {
    let totalInr = 0;
    const byCurr: Record<string, number> = {};
    for (const bd of entry.groupBreakdowns) {
      const code = bd.currency.trim().toUpperCase();
      byCurr[code] = (byCurr[code] ?? 0) + bd.netMinor;
      totalInr += convertCurrencyMinorToInrMinor(bd.netMinor, code, fxRatesToInr);
    }
    entry.netByCurrencyMinor = byCurr;
    entry.netInInrMinor = totalInr === 0 ? 0 : totalInr;
  }

  return Array.from(friendMap.values()).sort(
    (a, b) => Math.abs(b.netInInrMinor) - Math.abs(a.netInInrMinor)
  );
}
