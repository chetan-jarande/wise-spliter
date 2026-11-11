import { ExpensePayer, ExpenseSplitShare, SplitMode } from '../../types/ledger';

export interface SplitParticipantInput {
  memberId: string;
  memberOrder: number;
  included: boolean;
  rawInputValue: number;
}

export function calculateSplits(params: {
  totalMinor: number;
  originalTotalMinor: number;
  splitMode: SplitMode;
  rotationSeed: number;
  participants: SplitParticipantInput[];
}): ExpenseSplitShare[] {
  const total = BigInt(Math.max(0, Math.round(params.totalMinor)));
  const origTotal = BigInt(Math.max(0, Math.round(params.originalTotalMinor)));
  const ordered = [...params.participants].sort((a, b) => a.memberOrder - b.memberOrder);
  const active = ordered.filter((p) => p.included);
  const k = active.length;

  if (k === 0 || total === 0n) {
    return ordered.map((p) => ({
      memberId: p.memberId,
      included: p.included,
      owedMinor: 0,
      originalOwedMinor: 0,
      rawInputValue: p.rawInputValue,
      remainderMinor: 0,
    }));
  }

  const seedOffset = ((params.rotationSeed % k) + k) % k;

  const allocateByWeights = (
    pool: bigint,
    weights: bigint[]
  ): { amounts: bigint[]; remainders: number[] } => {
    const totalWeight = weights.reduce((acc, w) => acc + w, 0n);
    if (totalWeight <= 0n) {
      return { amounts: weights.map(() => 0n), remainders: weights.map(() => 0) };
    }
    const floors = weights.map((w) => (pool * w) / totalWeight);
    const rems = weights.map((w) => (pool * w) % totalWeight);
    const leftover = Number(pool - floors.reduce((acc, q) => acc + q, 0n));

    const indices = weights.map((_, idx) => idx);
    indices.sort((a, b) => {
      const remDiff = rems[b]! - rems[a]!;
      if (remDiff > 0n) return 1;
      if (remDiff < 0n) return -1;
      const rotA = (a - seedOffset + k) % k;
      const rotB = (b - seedOffset + k) % k;
      return rotA - rotB;
    });

    const remainderFlags = weights.map(() => 0);
    const finalAmounts = [...floors];
    for (let r = 0; r < leftover; r++) {
      const winnerIdx = indices[r]!;
      finalAmounts[winnerIdx] = finalAmounts[winnerIdx]! + 1n;
      remainderFlags[winnerIdx] = 1;
    }

    return { amounts: finalAmounts, remainders: remainderFlags };
  };

  const activeMap = new Map<string, { owed: bigint; origOwed: bigint; remFlag: number; raw: number }>();

  if (params.splitMode === 'equal') {
    const weights = active.map(() => 1n);
    const mainAlloc = allocateByWeights(total, weights);
    const origAlloc = allocateByWeights(origTotal, weights);
    active.forEach((p, idx) => {
      activeMap.set(p.memberId, {
        owed: mainAlloc.amounts[idx]!,
        origOwed: origAlloc.amounts[idx]!,
        remFlag: mainAlloc.remainders[idx]!,
        raw: 1,
      });
    });
  } else if (params.splitMode === 'shares' || params.splitMode === 'percentage') {
    const weights = active.map((p) => BigInt(Math.max(0, Math.round(p.rawInputValue))));
    const mainAlloc = allocateByWeights(total, weights);
    const origAlloc = allocateByWeights(origTotal, weights);
    active.forEach((p, idx) => {
      activeMap.set(p.memberId, {
        owed: mainAlloc.amounts[idx]!,
        origOwed: origAlloc.amounts[idx]!,
        remFlag: mainAlloc.remainders[idx]!,
        raw: p.rawInputValue,
      });
    });
  } else if (params.splitMode === 'adjustment') {
    const adjustments = active.map((p) => BigInt(Math.round(p.rawInputValue)));
    const adjSum = adjustments.reduce((acc, a) => acc + a, 0n);
    const pool = total - adjSum;
    const weights = active.map(() => 1n);
    const baseAlloc = pool >= 0n ? allocateByWeights(pool, weights) : { amounts: active.map(() => 0n), remainders: active.map(() => 0) };
    active.forEach((p, idx) => {
      const finalOwed = baseAlloc.amounts[idx]! + adjustments[idx]!;
      const ratioOrig = total > 0n ? (finalOwed * origTotal) / total : 0n;
      activeMap.set(p.memberId, {
        owed: finalOwed,
        origOwed: ratioOrig,
        remFlag: baseAlloc.remainders[idx]!,
        raw: p.rawInputValue,
      });
    });
  } else {
    // exact mode
    active.forEach((p) => {
      const exactVal = BigInt(Math.max(0, Math.round(p.rawInputValue)));
      const ratioOrig = total > 0n ? (exactVal * origTotal) / total : exactVal;
      activeMap.set(p.memberId, {
        owed: exactVal,
        origOwed: ratioOrig,
        remFlag: 0,
        raw: p.rawInputValue,
      });
    });
  }

  return ordered.map((p) => {
    const entry = activeMap.get(p.memberId);
    if (!entry) {
      return {
        memberId: p.memberId,
        included: false,
        owedMinor: 0,
        originalOwedMinor: 0,
        rawInputValue: 0,
        remainderMinor: 0,
      };
    }
    return {
      memberId: p.memberId,
      included: true,
      owedMinor: Number(entry.owed),
      originalOwedMinor: Number(entry.origOwed),
      rawInputValue: entry.raw,
      remainderMinor: entry.remFlag,
    };
  });
}

export function validateExpenseInvariants(params: {
  amountMinor: number;
  splitMode: SplitMode;
  payers: ExpensePayer[];
  splits: ExpenseSplitShare[];
}): {
  valid: boolean;
  errors: string[];
  unallocatedPayerMinor: number;
  unallocatedSplitMinor: number;
} {
  const errors: string[] = [];
  const total = Math.round(params.amountMinor);
  if (total <= 0) {
    errors.push('Total bill amount must be greater than zero.');
  }

  const payerSum = params.payers.reduce((acc, p) => acc + Math.round(p.paidMinor), 0);
  const splitSum = params.splits
    .filter((s) => s.included)
    .reduce((acc, s) => acc + Math.round(s.owedMinor), 0);

  const unallocatedPayerMinor = total - payerSum;
  const unallocatedSplitMinor = total - splitSum;

  if (params.splits.filter((s) => s.included).length === 0) {
    errors.push('At least one group member must be included in the split.');
  }
  if (unallocatedPayerMinor !== 0) {
    errors.push('Payer contributions must equal 100% of the total bill.');
  }
  if (unallocatedSplitMinor !== 0) {
    errors.push('Participant split shares must reconcile 100% with the total bill.');
  }

  if (params.splitMode === 'percentage') {
    const totalBps = params.splits
      .filter((s) => s.included)
      .reduce((acc, s) => acc + Math.round(s.rawInputValue), 0);
    if (totalBps !== 10000) {
      errors.push(`Percentage shares must add up to 100.00% (currently ${(totalBps / 100).toFixed(2)}%).`);
    }
  }

  if (params.splits.some((s) => s.included && s.owedMinor < 0)) {
    errors.push('No participant share can be negative after adjustment.');
  }

  return {
    valid: errors.length === 0,
    errors,
    unallocatedPayerMinor,
    unallocatedSplitMinor,
  };
}
