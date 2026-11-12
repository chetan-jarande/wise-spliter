import {
  ExpenseItem,
  ExpensePayer,
  ExpenseSplitShare,
  SettlementItem,
  SplitMode,
} from '../../types/ledger';
import {
  convertForeignToBaseMinor,
  convertMinorAmountWithFx,
  divRoundHalfAwayFromZero,
  getMinorScaleFactor,
} from '../money/currencies';

export interface SplitParticipantInput {
  memberId: string;
  memberOrder: number;
  included: boolean;
  rawInputValue: number;
}

/**
 * Pure BigInt Hamilton Largest Remainder allocator with deterministic rotating tie-breaker.
 * Guarantees exact conservation: sum(amounts) === pool when pool >= 0n and sum(weights) > 0n.
 */
export function allocateProportionalMinorAmounts(
  pool: bigint,
  weights: bigint[],
  rotationSeed = 0
): { amounts: bigint[]; remainders: number[] } {
  const k = weights.length;
  if (k === 0 || pool <= 0n) {
    return { amounts: weights.map(() => 0n), remainders: weights.map(() => 0) };
  }

  const sanitizedWeights = weights.map((w) => (w > 0n ? w : 0n));
  const totalWeight = sanitizedWeights.reduce((acc, w) => acc + w, 0n);
  if (totalWeight <= 0n) {
    return { amounts: weights.map(() => 0n), remainders: weights.map(() => 0) };
  }

  const safeSeed = Number.isFinite(rotationSeed) ? Math.trunc(rotationSeed) : 0;
  const seedOffset = ((safeSeed % k) + k) % k;

  const floors = sanitizedWeights.map((w) => (pool * w) / totalWeight);
  const rems = sanitizedWeights.map((w) => (pool * w) % totalWeight);
  const leftover = Number(pool - floors.reduce((acc, q) => acc + q, 0n));

  const indices = sanitizedWeights.map((_, idx) => idx);
  indices.sort((a, b) => {
    const remDiff = rems[b]! - rems[a]!;
    if (remDiff > 0n) return 1;
    if (remDiff < 0n) return -1;
    const rotA = (((a - seedOffset) % k) + k) % k;
    const rotB = (((b - seedOffset) % k) + k) % k;
    return rotA - rotB;
  });

  const remainderFlags = sanitizedWeights.map(() => 0);
  const finalAmounts = [...floors];
  for (let r = 0; r < leftover; r++) {
    const winnerIdx = indices[r]!;
    finalAmounts[winnerIdx] = finalAmounts[winnerIdx]! + 1n;
    remainderFlags[winnerIdx] = 1;
  }

  return { amounts: finalAmounts, remainders: remainderFlags };
}

export function calculateSplits(params: {
  totalMinor: number;
  originalTotalMinor: number;
  splitMode: SplitMode;
  rotationSeed: number;
  participants: SplitParticipantInput[];
}): ExpenseSplitShare[] {
  const safeTotalNum = Number.isFinite(params.totalMinor) ? Math.round(params.totalMinor) : 0;
  const safeOrigNum = Number.isFinite(params.originalTotalMinor)
    ? Math.round(params.originalTotalMinor)
    : 0;
  const total = BigInt(Math.max(0, safeTotalNum));
  const origTotal = BigInt(Math.max(0, safeOrigNum));

  // Deterministic ordering by memberOrder, then lexicographic memberId tie-breaker
  const ordered = [...params.participants].sort((a, b) => {
    const orderDiff = a.memberOrder - b.memberOrder;
    if (orderDiff !== 0) return orderDiff;
    return a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0;
  });

  const active = ordered.filter((p) => p.included);
  const k = active.length;

  if (k === 0 || total === 0n) {
    return ordered.map((p) => ({
      memberId: p.memberId,
      included: p.included,
      owedMinor: 0,
      originalOwedMinor: 0,
      rawInputValue: p.included ? p.rawInputValue : 0,
      remainderMinor: 0,
    }));
  }

  const safeSeed = Number.isFinite(params.rotationSeed) ? Math.trunc(params.rotationSeed) : 0;
  const activeMap = new Map<
    string,
    { owed: bigint; origOwed: bigint; remFlag: number; raw: number }
  >();

  if (params.splitMode === 'equal') {
    const weights = active.map(() => 1n);
    const mainAlloc = allocateProportionalMinorAmounts(total, weights, safeSeed);
    const origAlloc = allocateProportionalMinorAmounts(origTotal, weights, safeSeed);
    active.forEach((p, idx) => {
      activeMap.set(p.memberId, {
        owed: mainAlloc.amounts[idx]!,
        origOwed: origAlloc.amounts[idx]!,
        remFlag: mainAlloc.remainders[idx]!,
        raw: 1,
      });
    });
  } else if (params.splitMode === 'shares' || params.splitMode === 'percentage') {
    const rawInts = active.map((p) =>
      Number.isFinite(p.rawInputValue) ? Math.round(p.rawInputValue) : 0
    );
    const weights = rawInts.map((v) => BigInt(Math.max(0, v)));
    const mainAlloc = allocateProportionalMinorAmounts(total, weights, safeSeed);
    const origAlloc = allocateProportionalMinorAmounts(origTotal, weights, safeSeed);
    active.forEach((p, idx) => {
      activeMap.set(p.memberId, {
        owed: mainAlloc.amounts[idx]!,
        origOwed: origAlloc.amounts[idx]!,
        remFlag: mainAlloc.remainders[idx]!,
        raw: rawInts[idx]!,
      });
    });
  } else if (params.splitMode === 'adjustment') {
    const rawInts = active.map((p) =>
      Number.isFinite(p.rawInputValue) ? Math.round(p.rawInputValue) : 0
    );
    const adjustments = rawInts.map((v) => BigInt(v));
    const adjSum = adjustments.reduce((acc, a) => acc + a, 0n);
    const pool = total - adjSum;
    const weights = active.map(() => 1n);
    const baseAlloc =
      pool >= 0n
        ? allocateProportionalMinorAmounts(pool, weights, safeSeed)
        : { amounts: active.map(() => 0n), remainders: active.map(() => 0) };

    const finalOweds = active.map((_, idx) => baseAlloc.amounts[idx]! + adjustments[idx]!);
    const allNonNegative = finalOweds.every((v) => v >= 0n);
    const origOweds =
      allNonNegative && total > 0n
        ? allocateProportionalMinorAmounts(origTotal, finalOweds, safeSeed).amounts
        : finalOweds.map((v) => (total > 0n ? (v * origTotal) / total : 0n));

    active.forEach((p, idx) => {
      activeMap.set(p.memberId, {
        owed: finalOweds[idx]!,
        origOwed: origOweds[idx]!,
        remFlag: baseAlloc.remainders[idx]!,
        raw: rawInts[idx]!,
      });
    });
  } else {
    // exact mode: preserve signed values so negative shares fail validation cleanly
    const rawInts = active.map((p) =>
      Number.isFinite(p.rawInputValue) ? Math.round(p.rawInputValue) : 0
    );
    const exactVals = rawInts.map((v) => BigInt(v));
    const exactSum = exactVals.reduce((acc, v) => acc + v, 0n);
    const allNonNegative = exactVals.every((v) => v >= 0n);
    const origOweds =
      allNonNegative && exactSum > 0n
        ? allocateProportionalMinorAmounts(origTotal, exactVals, safeSeed).amounts
        : exactVals.map((v) => (total > 0n ? (v * origTotal) / total : v));

    active.forEach((p, idx) => {
      activeMap.set(p.memberId, {
        owed: exactVals[idx]!,
        origOwed: origOweds[idx]!,
        remFlag: 0,
        raw: rawInts[idx]!,
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
      owedMinor: entry.owed === 0n ? 0 : Number(entry.owed),
      originalOwedMinor: entry.origOwed === 0n ? 0 : Number(entry.origOwed),
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
  const total = Number.isFinite(params.amountMinor) ? Math.round(params.amountMinor) : 0;
  if (!Number.isFinite(params.amountMinor) || total <= 0) {
    errors.push('Total bill amount must be greater than zero.');
  }

  if (params.payers.length === 0) {
    errors.push('At least one payer is required.');
  }
  if (params.payers.some((p) => !Number.isFinite(p.paidMinor) || Math.round(p.paidMinor) < 0)) {
    errors.push('Payer contribution cannot be negative.');
  }

  const payerSum = params.payers.reduce(
    (acc, p) => acc + (Number.isFinite(p.paidMinor) ? Math.round(p.paidMinor) : 0),
    0
  );
  const includedSplits = params.splits.filter((s) => s.included);
  const splitSum = includedSplits.reduce(
    (acc, s) => acc + (Number.isFinite(s.owedMinor) ? Math.round(s.owedMinor) : 0),
    0
  );

  const unallocatedPayerMinor = total - payerSum;
  const unallocatedSplitMinor = total - splitSum;

  if (includedSplits.length === 0) {
    errors.push('At least one group member must be included in the split.');
  }
  if (params.splits.some((s) => !s.included && Math.round(s.owedMinor) !== 0)) {
    errors.push('Excluded participants must have zero owed share.');
  }
  if (unallocatedPayerMinor !== 0) {
    errors.push('Payer contributions must equal 100% of the total bill.');
  }
  if (unallocatedSplitMinor !== 0) {
    errors.push('Participant split shares must reconcile 100% with the total bill.');
  }

  if (params.splitMode === 'percentage') {
    if (includedSplits.some((s) => !Number.isFinite(s.rawInputValue) || Math.round(s.rawInputValue) < 0)) {
      errors.push('Percentage basis points cannot be negative.');
    }
    const totalBps = includedSplits.reduce(
      (acc, s) => acc + (Number.isFinite(s.rawInputValue) ? Math.round(s.rawInputValue) : 0),
      0
    );
    if (totalBps !== 10000) {
      errors.push(
        `Percentage shares must add up to 100.00% (currently ${(totalBps / 100).toFixed(2)}%).`
      );
    }
  } else if (params.splitMode === 'shares') {
    if (includedSplits.some((s) => !Number.isFinite(s.rawInputValue) || Math.round(s.rawInputValue) < 0)) {
      errors.push('Share weights cannot be negative.');
    }
    const totalShares = includedSplits.reduce(
      (acc, s) => acc + (Number.isFinite(s.rawInputValue) ? Math.round(s.rawInputValue) : 0),
      0
    );
    if (includedSplits.length > 0 && totalShares <= 0) {
      errors.push('Total share weights must be greater than zero.');
    }
  } else if (params.splitMode === 'adjustment') {
    const adjSum = includedSplits.reduce(
      (acc, s) => acc + (Number.isFinite(s.rawInputValue) ? Math.round(s.rawInputValue) : 0),
      0
    );
    if (adjSum > total) {
      errors.push('Sum of adjustments cannot exceed the total bill amount.');
    }
  }

  if (includedSplits.some((s) => !Number.isFinite(s.owedMinor) || Math.round(s.owedMinor) < 0)) {
    errors.push('No participant share can be negative after adjustment.');
  }

  return {
    valid: errors.length === 0,
    errors,
    unallocatedPayerMinor,
    unallocatedSplitMinor,
  };
}

/**
 * Converts multi-payer foreign-currency contributions into group base currency
 * while strictly guaranteeing sum(paidMinor) === amountMinor with zero 1-subunit FX drift.
 */
export function reconcileMultiPayerFxContributions(params: {
  payers: Array<{ memberId: string; originalPaidMinor: number }>;
  originalCurrency: string;
  groupCurrency: string;
  fxRateScaled: number;
  targetAmountMinor?: number;
  rotationSeed?: number;
}): {
  amountMinor: number;
  originalAmountMinor: number;
  payers: ExpensePayer[];
} {
  const origWeights = params.payers.map((p) =>
    BigInt(Math.max(0, Number.isFinite(p.originalPaidMinor) ? Math.round(p.originalPaidMinor) : 0))
  );
  const origTotal = origWeights.reduce((acc, w) => acc + w, 0n);

  const convertedTotal =
    params.targetAmountMinor !== undefined && Number.isFinite(params.targetAmountMinor)
      ? BigInt(Math.max(0, Math.round(params.targetAmountMinor)))
      : convertForeignToBaseMinor(
          origTotal,
          params.originalCurrency,
          params.groupCurrency,
          params.fxRateScaled
        );

  const alloc = allocateProportionalMinorAmounts(
    convertedTotal,
    origWeights,
    params.rotationSeed ?? 0
  );

  return {
    amountMinor: convertedTotal === 0n ? 0 : Number(convertedTotal),
    originalAmountMinor: origTotal === 0n ? 0 : Number(origTotal),
    payers: params.payers.map((p, idx) => ({
      memberId: p.memberId,
      paidMinor: alloc.amounts[idx]! === 0n ? 0 : Number(alloc.amounts[idx]!),
      originalPaidMinor: origWeights[idx]! === 0n ? 0 : Number(origWeights[idx]!),
    })),
  };
}

/**
 * Pure domain helper for changing a group's base currency on an ExpenseItem (`relabel` or `reconvert`).
 * Strictly preserves sum(payers) === newAmountMinor === sum(included splits) and all split-mode invariants.
 */
export function redenominateExpenseCurrency(params: {
  expense: ExpenseItem;
  newCurrency: string;
  mode: 'relabel' | 'reconvert';
  fxRateScaled?: number;
  updatedAt?: string;
  hlc?: string;
}): ExpenseItem {
  const { expense, mode } = params;
  const oldCode = expense.groupCurrency.trim().toUpperCase();
  const targetCode = params.newCurrency.trim().toUpperCase();
  const oldScale = getMinorScaleFactor(oldCode);
  const newScale = getMinorScaleFactor(targetCode);
  const rateBig =
    params.fxRateScaled !== undefined &&
    Number.isFinite(params.fxRateScaled) &&
    Math.round(params.fxRateScaled) > 0
      ? BigInt(Math.round(params.fxRateScaled))
      : 100000000n;

  if (oldCode === targetCode && (mode === 'relabel' || rateBig === 100000000n)) {
    return { ...expense, groupCurrency: targetCode };
  }

  const oldTotalBig = BigInt(Math.max(0, Math.round(expense.amountMinor)));
  let newTotalBig: bigint;
  if (mode === 'relabel') {
    newTotalBig = divRoundHalfAwayFromZero(oldTotalBig * newScale, oldScale);
  } else {
    newTotalBig = convertForeignToBaseMinor(oldTotalBig, oldCode, targetCode, rateBig);
  }
  if (oldTotalBig > 0n && newTotalBig < 1n) {
    newTotalBig = 1n;
  }

  const relabelOriginalToo =
    mode === 'relabel' && expense.originalCurrency.trim().toUpperCase() === oldCode;
  const nextOriginalCurrency = relabelOriginalToo ? targetCode : expense.originalCurrency;
  const nextOriginalAmountBig = relabelOriginalToo
    ? newTotalBig
    : BigInt(Math.max(0, Math.round(expense.originalAmountMinor)));

  // 1. Reconcile payers proportionally via Hamilton Largest Remainder
  const payerWeights = expense.payers.map((p) => {
    const w = BigInt(Math.max(0, Math.round(p.paidMinor)));
    return w > 0n ? w : 0n;
  });
  const effectivePayerWeights =
    payerWeights.reduce((a, b) => a + b, 0n) > 0n
      ? payerWeights
      : expense.payers.map((_, i) => (i === 0 ? 1n : 0n));
  const payerAlloc = allocateProportionalMinorAmounts(
    newTotalBig,
    effectivePayerWeights,
    expense.rotationSeed
  );

  const newPayers: ExpensePayer[] = expense.payers.map((p, idx) => {
    const nextPaid = Number(payerAlloc.amounts[idx]!);
    return {
      ...p,
      paidMinor: nextPaid,
      originalPaidMinor: relabelOriginalToo ? nextPaid : p.originalPaidMinor,
    };
  });

  // 2. Reconcile splits while preserving splitMode invariants
  let newSplits: ExpenseSplitShare[];
  if (
    expense.splitMode === 'equal' ||
    expense.splitMode === 'shares' ||
    expense.splitMode === 'percentage'
  ) {
    newSplits = calculateSplits({
      totalMinor: Number(newTotalBig),
      originalTotalMinor: Number(nextOriginalAmountBig),
      splitMode: expense.splitMode,
      rotationSeed: expense.rotationSeed,
      participants: expense.splits.map((s, idx) => ({
        memberId: s.memberId,
        memberOrder: idx,
        included: s.included,
        rawInputValue: s.rawInputValue,
      })),
    });
  } else if (expense.splitMode === 'exact') {
    const includedIndices: number[] = [];
    const owedWeights: bigint[] = [];
    expense.splits.forEach((s, idx) => {
      if (s.included) {
        includedIndices.push(idx);
        owedWeights.push(BigInt(Math.max(0, Math.round(s.owedMinor))));
      }
    });
    const effectiveSplitWeights =
      owedWeights.reduce((a, b) => a + b, 0n) > 0n
        ? owedWeights
        : owedWeights.map(() => 1n);
    const splitAlloc = allocateProportionalMinorAmounts(
      newTotalBig,
      effectiveSplitWeights,
      expense.rotationSeed
    );
    const origSplitAlloc = allocateProportionalMinorAmounts(
      nextOriginalAmountBig,
      effectiveSplitWeights,
      expense.rotationSeed
    );
    const includedAllocMap = new Map<number, { owed: number; orig: number }>();
    includedIndices.forEach((splitIdx, i) => {
      includedAllocMap.set(splitIdx, {
        owed: Number(splitAlloc.amounts[i]!),
        orig: Number(origSplitAlloc.amounts[i]!),
      });
    });

    newSplits = expense.splits.map((s, idx) => {
      const alloc = includedAllocMap.get(idx);
      if (!alloc) {
        return {
          ...s,
          included: false,
          owedMinor: 0,
          originalOwedMinor: 0,
          rawInputValue: 0,
          remainderMinor: 0,
        };
      }
      return {
        ...s,
        included: true,
        owedMinor: alloc.owed,
        originalOwedMinor: relabelOriginalToo ? alloc.owed : alloc.orig,
        rawInputValue: alloc.owed,
        remainderMinor: 0,
      };
    });
  } else {
    // adjustment mode: try scaled adjustments first; fall back to min-anchored exact adjustments if rounding violates pool >= 0 or share >= 0
    const scaledAdjInputs = expense.splits.map((s, idx) => {
      if (!s.included) {
        return { memberId: s.memberId, memberOrder: idx, included: false, rawInputValue: 0 };
      }
      const oldAdj = BigInt(Math.round(s.rawInputValue));
      const nextAdj =
        oldTotalBig > 0n
          ? divRoundHalfAwayFromZero(oldAdj * newTotalBig, oldTotalBig)
          : 0n;
      return {
        memberId: s.memberId,
        memberOrder: idx,
        included: true,
        rawInputValue: nextAdj === 0n ? 0 : Number(nextAdj),
      };
    });

    const candidateSplits = calculateSplits({
      totalMinor: Number(newTotalBig),
      originalTotalMinor: Number(nextOriginalAmountBig),
      splitMode: 'adjustment',
      rotationSeed: expense.rotationSeed,
      participants: scaledAdjInputs,
    });
    const candidateValid = validateExpenseInvariants({
      amountMinor: Number(newTotalBig),
      splitMode: 'adjustment',
      payers: newPayers,
      splits: candidateSplits,
    });

    if (candidateValid.valid) {
      newSplits = candidateSplits;
    } else {
      const includedIndices: number[] = [];
      const owedWeights: bigint[] = [];
      expense.splits.forEach((s, idx) => {
        if (s.included) {
          includedIndices.push(idx);
          owedWeights.push(BigInt(Math.max(0, Math.round(s.owedMinor))));
        }
      });
      const effectiveWeights =
        owedWeights.reduce((a, b) => a + b, 0n) > 0n ? owedWeights : owedWeights.map(() => 1n);
      const owedAlloc = allocateProportionalMinorAmounts(
        newTotalBig,
        effectiveWeights,
        expense.rotationSeed
      ).amounts;
      const minOwed = owedAlloc.reduce((m, v) => (v < m ? v : m), owedAlloc[0] ?? 0n);
      const fallbackParticipants = expense.splits.map((s, idx) => {
        const incPos = includedIndices.indexOf(idx);
        if (incPos === -1) {
          return { memberId: s.memberId, memberOrder: idx, included: false, rawInputValue: 0 };
        }
        const adj = owedAlloc[incPos]! - minOwed;
        return {
          memberId: s.memberId,
          memberOrder: idx,
          included: true,
          rawInputValue: Number(adj),
        };
      });
      newSplits = calculateSplits({
        totalMinor: Number(newTotalBig),
        originalTotalMinor: Number(nextOriginalAmountBig),
        splitMode: 'adjustment',
        rotationSeed: expense.rotationSeed,
        participants: fallbackParticipants,
      });
    }
  }

  // Update FX metadata cleanly when reconverting
  let nextFxRateScaled = expense.fxRateScaled;
  let nextFxStatus = expense.fxStatus;
  let nextFxAuditNote = expense.fxAuditNote;

  if (nextOriginalCurrency.trim().toUpperCase() === targetCode) {
    nextFxRateScaled = 100000000;
    nextFxStatus = 'identity';
    nextFxAuditNote = null;
  } else if (mode === 'reconvert') {
    const origScale = getMinorScaleFactor(nextOriginalCurrency);
    if (nextOriginalAmountBig > 0n) {
      const impliedRateScaled = divRoundHalfAwayFromZero(
        newTotalBig * origScale * 100000000n,
        nextOriginalAmountBig * newScale
      );
      nextFxRateScaled = impliedRateScaled > 0n ? Number(impliedRateScaled) : 100000000;
      nextFxStatus = expense.fxStatus === 'identity' ? 'manual' : expense.fxStatus;
      nextFxAuditNote = convertMinorAmountWithFx({
        originalMinor: Number(nextOriginalAmountBig),
        fromCurrency: nextOriginalCurrency,
        toCurrency: targetCode,
        fxRateScaled: nextFxRateScaled,
        fxStatus: nextFxStatus,
        dateIso: expense.expenseDate,
      }).fxAuditNote;
    }
  }

  return {
    ...expense,
    originalCurrency: nextOriginalCurrency,
    originalAmountMinor: Number(nextOriginalAmountBig),
    groupCurrency: targetCode,
    amountMinor: Number(newTotalBig),
    fxRateScaled: nextFxRateScaled,
    fxStatus: nextFxStatus,
    fxAuditNote: nextFxAuditNote,
    payers: newPayers,
    splits: newSplits,
    ...(params.updatedAt ? { updatedAt: params.updatedAt } : {}),
    ...(params.hlc ? { hlc: params.hlc } : {}),
  };
}

/**
 * Pure domain helper for changing a group's base currency on a SettlementItem (`relabel` or `reconvert`).
 */
export function redenominateSettlementCurrency(params: {
  settlement: SettlementItem;
  newCurrency: string;
  mode: 'relabel' | 'reconvert';
  fxRateScaled?: number;
  hlc?: string;
}): SettlementItem {
  const { settlement, mode } = params;
  const oldCode = settlement.currency.trim().toUpperCase();
  const targetCode = params.newCurrency.trim().toUpperCase();
  const oldScale = getMinorScaleFactor(oldCode);
  const newScale = getMinorScaleFactor(targetCode);
  const rateBig =
    params.fxRateScaled !== undefined &&
    Number.isFinite(params.fxRateScaled) &&
    Math.round(params.fxRateScaled) > 0
      ? BigInt(Math.round(params.fxRateScaled))
      : 100000000n;

  if (oldCode === targetCode && (mode === 'relabel' || rateBig === 100000000n)) {
    return { ...settlement, currency: targetCode };
  }

  const oldAmtBig = BigInt(Math.max(0, Math.round(settlement.amountMinor)));
  let newAmtBig: bigint;
  if (mode === 'relabel') {
    newAmtBig = divRoundHalfAwayFromZero(oldAmtBig * newScale, oldScale);
  } else {
    newAmtBig = convertForeignToBaseMinor(oldAmtBig, oldCode, targetCode, rateBig);
  }
  if (oldAmtBig > 0n && newAmtBig < 1n) {
    newAmtBig = 1n;
  }

  return {
    ...settlement,
    currency: targetCode,
    amountMinor: Number(newAmtBig),
    ...(params.hlc ? { hlc: params.hlc } : {}),
  };
}
