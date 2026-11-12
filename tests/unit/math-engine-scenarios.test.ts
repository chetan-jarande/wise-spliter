import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import fc from 'fast-check';
import {
  SUPPORTED_CURRENCIES,
  convertForeignToBaseMinor,
  convertMinorAmountWithFx,
  divRoundHalfAwayFromZero,
  formatMinorToMajor,
  getCurrency,
  parseFxRateToScaled,
  parseMajorToMinor,
  parseMajorToMinorStrict,
  tryParseMajorToMinorBigInt,
} from '../../src/domain/money/currencies';
import {
  SplitParticipantInput,
  allocateProportionalMinorAmounts,
  calculateSplits,
  reconcileMultiPayerFxContributions,
  redenominateExpenseCurrency,
  redenominateSettlementCurrency,
  validateExpenseInvariants,
} from '../../src/domain/splits/split-calculator';
import {
  computeCrossGroupFriendsSummary,
  computeGroupNetBalances,
  computeRawPairwiseTransfers,
  explainMemberBalance,
  simplifyGroupDebts,
} from '../../src/domain/ledger/ledger-engine';
import {
  buildUpiPaymentUri,
  exportGroupToCsv,
  exportGroupToExcelBuffer,
  generateWhatsAppGroupSummary,
  parseRfc4180CsvRows,
  parseSplitwiseCsv,
  sanitizeSpreadsheetCell,
} from '../../src/portability/portability-engine';
import {
  ExpenseItem,
  GroupMember,
  GroupRecord,
  SettlementItem,
  SplitMode,
} from '../../src/types/ledger';

function makeMembers(count: number, groupId = 'grp_test'): GroupMember[] {
  return Array.from({ length: count }, (_, idx) => ({
    id: `mem_${String(idx).padStart(2, '0')}`,
    groupId,
    userId: `usr_${String(idx).padStart(2, '0')}`,
    invitedEmail: `member${idx}@example.com`,
    displayName: `Member ${idx}`,
    avatarInitials: `M${idx}`,
    upiId: `member${idx}@okicici`,
    role: idx === 0 ? 'admin' : 'member',
    memberOrder: idx,
    joinedAt: '2026-11-01T00:00:00Z',
    claimedAt: '2026-11-01T00:00:00Z',
  }));
}

function makeExpense(params: {
  id: string;
  groupId?: string | null;
  currency?: string;
  amountMinor: number;
  splitMode?: SplitMode;
  rotationSeed?: number;
  payers: Array<{ memberId: string; paidMinor: number; originalPaidMinor?: number }>;
  splits: ExpenseItem['splits'];
  deletedAt?: string | null;
  originalCurrency?: string;
  originalAmountMinor?: number;
  fxRateScaled?: number;
}): ExpenseItem {
  const currency = params.currency ?? 'INR';
  const origCurrency = params.originalCurrency ?? currency;
  const origAmount = params.originalAmountMinor ?? params.amountMinor;
  return {
    id: params.id,
    groupId: params.groupId !== undefined ? params.groupId : 'grp_test',
    title: `Bill ${params.id}`,
    category: 'food',
    tags: ['#test'],
    notes: '',
    expenseDate: '2026-11-11',
    originalCurrency: origCurrency,
    originalAmountMinor: origAmount,
    groupCurrency: currency,
    amountMinor: params.amountMinor,
    fxRateScaled: params.fxRateScaled ?? 100000000,
    fxStatus: origCurrency === currency ? 'identity' : 'live',
    fxAuditNote: null,
    splitMode: params.splitMode ?? 'equal',
    rotationSeed: params.rotationSeed ?? 0,
    payers: params.payers.map((p) => ({
      memberId: p.memberId,
      paidMinor: p.paidMinor,
      originalPaidMinor: p.originalPaidMinor ?? p.paidMinor,
    })),
    splits: params.splits,
    currentRevisionId: `rev_${params.id}_1`,
    revisionNumber: 1,
    hasUnresolvedConflict: false,
    conflictRevisionId: null,
    createdByMemberId: params.payers[0]?.memberId ?? 'mem_00',
    updatedByMemberId: params.payers[0]?.memberId ?? 'mem_00',
    createdAt: '2026-11-11T10:00:00Z',
    updatedAt: '2026-11-11T10:00:00Z',
    deletedAt: params.deletedAt ?? null,
    hlc: '019a73e4c200-0001-usr_00',
    comments: [],
    receipts: [],
  };
}

describe('Suite 1: Minor-Unit Parsing, Formatting & BigInt FX Conversion (currencies.ts)', () => {
  it('parses Western and Indian lakh/crore grouping, currency symbols, leading/trailing decimals, and negative signs', () => {
    expect(parseMajorToMinor('1,250.50', 'INR')).toBe(125050);
    expect(parseMajorToMinor('1,00,000.00', 'INR')).toBe(10000000);
    expect(parseMajorToMinor('12,34,56,789.25', 'INR')).toBe(12345678925);
    expect(parseMajorToMinor('₹ 1,250.50', 'INR')).toBe(125050);
    expect(parseMajorToMinor('INR 1,250.50', 'INR')).toBe(125050);
    expect(parseMajorToMinor('1,250.50 INR', 'INR')).toBe(125050);

    // Leading and trailing decimals
    expect(parseMajorToMinor('.50', 'INR')).toBe(50);
    expect(parseMajorToMinor('-.50', 'INR')).toBe(-50);
    expect(parseMajorToMinor('100.', 'INR')).toBe(10000);
    expect(parseMajorToMinor('-100.', 'INR')).toBe(-10000);

    // Negative signs before or after currency symbol
    expect(parseMajorToMinor('-25.50', 'INR')).toBe(-2550);
    expect(parseMajorToMinor('-₹25.50', 'INR')).toBe(-2550);
    expect(parseMajorToMinor('₹-25.50', 'INR')).toBe(-2550);
    expect(parseMajorToMinor('₹ -0.05', 'INR')).toBe(-5);
    expect(parseMajorToMinor('-KD 25.005', 'KWD')).toBe(-25005);
    expect(parseMajorToMinor('KD-25.005', 'KWD')).toBe(-25005);

    // Zero normalization (never -0)
    expect(Object.is(parseMajorToMinor('-0.00', 'INR'), 0)).toBe(true);
    expect(Object.is(parseMajorToMinor('0', 'INR'), 0)).toBe(true);
  });

  it('preserves negative sign on sub-unit minor amounts (-0.05 / -5n) and handles > MAX_SAFE_INTEGER BigInts', () => {
    // Critical check: -5n / 100n === 0n in BigInt, formatMinorToMajor must NOT lose the minus sign!
    expect(formatMinorToMajor(-5, 'INR')).toBe('-₹0.05');
    expect(formatMinorToMajor(-5n, 'INR')).toBe('-₹0.05');
    expect(formatMinorToMajor(-5n, 'INR', false)).toBe('-0.05');
    expect(formatMinorToMajor(-2550, 'INR')).toBe('-₹25.50');
    expect(formatMinorToMajor(-5n, 'KWD')).toBe('-KD0.005');
    expect(formatMinorToMajor(-5n, 'JPY')).toBe('-¥5');

    // Zero and -0 must never print a minus sign
    expect(formatMinorToMajor(0, 'INR')).toBe('₹0.00');
    expect(formatMinorToMajor(-0, 'INR')).toBe('₹0.00');
    expect(formatMinorToMajor(0n, 'KWD')).toBe('KD0.000');

    // Arbitrary precision BigInt beyond Number.MAX_SAFE_INTEGER (9.007 * 10^15)
    const hugeMinor = 123456789012345678905n;
    expect(formatMinorToMajor(hugeMinor, 'INR')).toBe('₹1,234,567,890,123,456,789.05');
    expect(formatMinorToMajor(-hugeMinor, 'INR')).toBe('-₹1,234,567,890,123,456,789.05');
  });

  it('applies deterministic commercial half-away-from-zero rounding on excess fractional digits', () => {
    expect(parseMajorToMinor('10.999', 'INR')).toBe(1100);
    expect(parseMajorToMinor('10.995', 'INR')).toBe(1100);
    expect(parseMajorToMinor('10.994', 'INR')).toBe(1099);
    expect(parseMajorToMinor('-10.995', 'INR')).toBe(-1100);
    expect(parseMajorToMinor('-10.994', 'INR')).toBe(-1099);

    // 0-decimal JPY
    expect(parseMajorToMinor('100.5', 'JPY')).toBe(101);
    expect(parseMajorToMinor('100.49', 'JPY')).toBe(100);
    expect(parseMajorToMinor('-100.5', 'JPY')).toBe(-101);

    // 3-decimal KWD
    expect(parseMajorToMinor('25.1235', 'KWD')).toBe(25124);
    expect(parseMajorToMinor('25.1234', 'KWD')).toBe(25123);
  });

  it('rejects scientific notation, NaN, Infinity, multiple dots, malformed commas, and garbage strings', () => {
    const invalidInputs: Array<string | number> = [
      '1e5',
      '1E5',
      '1.25e2',
      '1e-5',
      'NaN',
      'Infinity',
      '-Infinity',
      'abc123',
      '12.34.56',
      '--25.50',
      '+-25.50',
      ',100.00',
      '100,.00',
      '1,,000.00',
      '10.5,0',
      NaN,
      Infinity,
      -Infinity,
      1e22,
    ];

    for (const bad of invalidInputs) {
      expect(tryParseMajorToMinorBigInt(bad, 'INR').ok).toBe(false);
      expect(parseMajorToMinor(bad, 'INR')).toBe(0);
      expect(() => parseMajorToMinorStrict(bad, 'INR')).toThrow(RangeError);
    }

    // Incomplete typing states return 0 safely in UI helper but throw in strict mode
    for (const typing of ['', '   ', '-', '+', '.', '-.']) {
      expect(parseMajorToMinor(typing, 'INR')).toBe(0);
      expect(() => parseMajorToMinorStrict(typing, 'INR')).toThrow(RangeError);
    }

    // Normalized uppercase currency catalog lookup on previously mixed-case extra codes
    expect(SUPPORTED_CURRENCIES['BOV']).toBeDefined();
    expect(getCurrency('bov').name).toBe('Bolivian Mvdol');
    expect(getCurrency('ZWGOLD').symbol).toBe('ZiG');
  });

  it('executes overflow-free BigInt FX conversions across 0, 2, and 3 decimal currencies and negative amounts', () => {
    // 10^11 JPY minor units converted to KWD (scale 1000) at 1 JPY = 0.002044 KWD (rateScaled = 204400)
    // Intermediate numerator = 10^11 * 204400 * 1000 = 2.044 * 10^19 > Number.MAX_SAFE_INTEGER!
    const hugeJpy = 100_000_000_000n;
    const kwdMinor = convertForeignToBaseMinor(hugeJpy, 'JPY', 'KWD', 204400n);
    expect(kwdMinor).toBe(204_400_000_000n);

    // Even larger: 10^11 EUR cents -> KWD fils at 1 EUR = 0.33333333 KWD (rateScaled = 33333333)
    // Numerator = 10^11 * 33333333 * 1000 = 3.3333333 * 10^21 >> MAX_SAFE_INTEGER
    const largeKwd = convertForeignToBaseMinor(100_000_000_000n, 'EUR', 'KWD', 33333333n);
    expect(largeKwd).toBe(333_333_330_000n);

    // Symmetric negative conversion check: -$1.00 USD at 84.50 INR must be -8450 paise (NOT -8449!)
    const negUsdToInr = convertMinorAmountWithFx({
      originalMinor: -100,
      fromCurrency: 'USD',
      toCurrency: 'INR',
      fxRateScaled: parseFxRateToScaled('84.50'),
      fxStatus: 'live',
      dateIso: '2026-11-11',
    });
    expect(negUsdToInr.convertedMinor).toBe(-8450);

    // Cross-exponent conversions: KWD (3) -> JPY (0), JPY (0) -> KWD (3), BHD (3) -> INR (2)
    // 1.005 KWD (1005 fils) at 1 KWD = 489.50 JPY -> 1.005 * 489.5 = 491.9475 -> 492 JPY
    expect(
      convertForeignToBaseMinor(1005n, 'KWD', 'JPY', parseFxRateToScaled('489.50'))
    ).toBe(492n);

    // Sub-unit FX audit note formatting (1 JPY = 0.002044 KWD must not print "0.00 KWD")
    const jpyToKwd = convertMinorAmountWithFx({
      originalMinor: 10000,
      fromCurrency: 'JPY',
      toCurrency: 'KWD',
      fxRateScaled: parseFxRateToScaled('0.002044'),
      fxStatus: 'manual',
      dateIso: '2026-11-11',
    });
    expect(jpyToKwd.convertedMinor).toBe(20440);
    expect(jpyToKwd.fxAuditNote).toContain('1 JPY = 0.002044 KWD');

    // Odd-denominator rational rounding check
    expect(divRoundHalfAwayFromZero(5n, 2n)).toBe(3n);
    expect(divRoundHalfAwayFromZero(-5n, 2n)).toBe(-3n);
    expect(divRoundHalfAwayFromZero(1n, 3n)).toBe(0n);
    expect(divRoundHalfAwayFromZero(2n, 3n)).toBe(1n);
    expect(divRoundHalfAwayFromZero(-2n, 3n)).toBe(-1n);
  });
});

describe('Suite 2: 5 Split Modes, Rotating Remainder, Multi-Payer FX & Re-denomination (split-calculator.ts)', () => {
  it('handles equal split edge cases: k=0, k=1, negative/NaN rotationSeed, and unordered participant determinism', () => {
    // k = 0 included
    const emptySplits = calculateSplits({
      totalMinor: 10000,
      originalTotalMinor: 10000,
      splitMode: 'equal',
      rotationSeed: 0,
      participants: [
        { memberId: 'b', memberOrder: 1, included: false, rawInputValue: 0 },
        { memberId: 'a', memberOrder: 0, included: false, rawInputValue: 0 },
      ],
    });
    expect(emptySplits.map((s) => s.owedMinor)).toEqual([0, 0]);

    // k = 1 included
    const soloSplits = calculateSplits({
      totalMinor: 99999,
      originalTotalMinor: 99999,
      splitMode: 'equal',
      rotationSeed: -7,
      participants: [
        { memberId: 'a', memberOrder: 0, included: true, rawInputValue: 1 },
        { memberId: 'b', memberOrder: 1, included: false, rawInputValue: 0 },
      ],
    });
    expect(soloSplits.map((s) => s.owedMinor)).toEqual([99999, 0]);

    // Negative rotationSeed (-1 mod 3 === +2) and NaN rotationSeed
    const threeMembers: SplitParticipantInput[] = [
      { memberId: 'm0', memberOrder: 0, included: true, rawInputValue: 1 },
      { memberId: 'm1', memberOrder: 1, included: true, rawInputValue: 1 },
      { memberId: 'm2', memberOrder: 2, included: true, rawInputValue: 1 },
    ];
    const negSeed = calculateSplits({
      totalMinor: 100,
      originalTotalMinor: 100,
      splitMode: 'equal',
      rotationSeed: -1,
      participants: threeMembers,
    });
    expect(negSeed.map((s) => s.owedMinor)).toEqual([33, 33, 34]);

    const nanSeed = calculateSplits({
      totalMinor: 100,
      originalTotalMinor: 100,
      splitMode: 'equal',
      rotationSeed: Number.NaN,
      participants: threeMembers,
    });
    expect(nanSeed.map((s) => s.owedMinor)).toEqual([34, 33, 33]);

    // Deterministic ordering even when memberOrder ties and input array is shuffled
    const tiedForward = calculateSplits({
      totalMinor: 100,
      originalTotalMinor: 100,
      splitMode: 'equal',
      rotationSeed: 0,
      participants: [
        { memberId: 'alice', memberOrder: 0, included: true, rawInputValue: 1 },
        { memberId: 'bob', memberOrder: 0, included: true, rawInputValue: 1 },
        { memberId: 'charlie', memberOrder: 0, included: true, rawInputValue: 1 },
      ],
    });
    const tiedReversed = calculateSplits({
      totalMinor: 100,
      originalTotalMinor: 100,
      splitMode: 'equal',
      rotationSeed: 0,
      participants: [
        { memberId: 'charlie', memberOrder: 0, included: true, rawInputValue: 1 },
        { memberId: 'bob', memberOrder: 0, included: true, rawInputValue: 1 },
        { memberId: 'alice', memberOrder: 0, included: true, rawInputValue: 1 },
      ],
    });
    expect(tiedForward).toEqual(tiedReversed);
  });

  it('validates shares & percentage modes: huge BigInt weights, all-zero guard, negative bps rejection, and Hamilton remainder', () => {
    // Huge weights where totalMinor * weight > Number.MAX_SAFE_INTEGER (10^10 * 5 * 10^7 = 5 * 10^17)
    const hugeShareSplits = calculateSplits({
      totalMinor: 10_000_000_000,
      originalTotalMinor: 10_000_000_000,
      splitMode: 'shares',
      rotationSeed: 0,
      participants: [
        { memberId: 'm0', memberOrder: 0, included: true, rawInputValue: 50_000_000 },
        { memberId: 'm1', memberOrder: 1, included: true, rawInputValue: 30_000_000 },
        { memberId: 'm2', memberOrder: 2, included: true, rawInputValue: 20_000_000 },
      ],
    });
    expect(hugeShareSplits.map((s) => s.owedMinor)).toEqual([
      5_000_000_000,
      3_000_000_000,
      2_000_000_000,
    ]);

    // All-zero shares must fail invariant validation
    const zeroShares = calculateSplits({
      totalMinor: 5000,
      originalTotalMinor: 5000,
      splitMode: 'shares',
      rotationSeed: 0,
      participants: [
        { memberId: 'm0', memberOrder: 0, included: true, rawInputValue: 0 },
        { memberId: 'm1', memberOrder: 1, included: true, rawInputValue: 0 },
      ],
    });
    const zeroCheck = validateExpenseInvariants({
      amountMinor: 5000,
      splitMode: 'shares',
      payers: [{ memberId: 'm0', paidMinor: 5000, originalPaidMinor: 5000 }],
      splits: zeroShares,
    });
    expect(zeroCheck.valid).toBe(false);
    expect(zeroCheck.errors.some((e) => e.includes('greater than zero'))).toBe(true);

    // Percentage: 3334, 3333, 3333 bps on ₹1.00 (100 paise) -> Hamilton remainders 3400, 3300, 3300 -> [34, 33, 33]
    const pctOneRupee = calculateSplits({
      totalMinor: 100,
      originalTotalMinor: 100,
      splitMode: 'percentage',
      rotationSeed: 2, // Even with seed=2, m0 has strictly larger remainder (3400 > 3300) so m0 wins +1!
      participants: [
        { memberId: 'm0', memberOrder: 0, included: true, rawInputValue: 3334 },
        { memberId: 'm1', memberOrder: 1, included: true, rawInputValue: 3333 },
        { memberId: 'm2', memberOrder: 2, included: true, rawInputValue: 3333 },
      ],
    });
    expect(pctOneRupee.map((s) => s.owedMinor)).toEqual([34, 33, 33]);

    // Percentage with zero-bps included participant (5000, 5000, 0 on ₹1.01) -> m2 gets 0
    const pctWithZero = calculateSplits({
      totalMinor: 101,
      originalTotalMinor: 101,
      splitMode: 'percentage',
      rotationSeed: 2,
      participants: [
        { memberId: 'm0', memberOrder: 0, included: true, rawInputValue: 5000 },
        { memberId: 'm1', memberOrder: 1, included: true, rawInputValue: 5000 },
        { memberId: 'm2', memberOrder: 2, included: true, rawInputValue: 0 },
      ],
    });
    expect(pctWithZero.map((s) => s.owedMinor)).toEqual([51, 50, 0]);

    // Negative bps loophole check: 12000 + (-2000) === 10000 MUST fail validation!
    const negBpsSplits = calculateSplits({
      totalMinor: 10000,
      originalTotalMinor: 10000,
      splitMode: 'percentage',
      rotationSeed: 0,
      participants: [
        { memberId: 'm0', memberOrder: 0, included: true, rawInputValue: 12000 },
        { memberId: 'm1', memberOrder: 1, included: true, rawInputValue: -2000 },
      ],
    });
    const negBpsCheck = validateExpenseInvariants({
      amountMinor: 10000,
      splitMode: 'percentage',
      payers: [{ memberId: 'm0', paidMinor: 10000, originalPaidMinor: 10000 }],
      splits: negBpsSplits,
    });
    expect(negBpsCheck.valid).toBe(false);
    expect(negBpsCheck.errors.some((e) => e.includes('negative'))).toBe(true);
  });

  it('rejects negative shares in exact and adjustment modes and pool < 0 in adjustment mode', () => {
    // Exact mode with [10000, -2000] on total 10000 must NOT silently clamp -2000 to 0!
    const exactNeg = calculateSplits({
      totalMinor: 10000,
      originalTotalMinor: 10000,
      splitMode: 'exact',
      rotationSeed: 0,
      participants: [
        { memberId: 'm0', memberOrder: 0, included: true, rawInputValue: 10000 },
        { memberId: 'm1', memberOrder: 1, included: true, rawInputValue: -2000 },
      ],
    });
    expect(exactNeg[1]?.owedMinor).toBe(-2000);
    const exactCheck = validateExpenseInvariants({
      amountMinor: 10000,
      splitMode: 'exact',
      payers: [{ memberId: 'm0', paidMinor: 10000, originalPaidMinor: 10000 }],
      splits: exactNeg,
    });
    expect(exactCheck.valid).toBe(false);
    expect(exactCheck.unallocatedSplitMinor).toBe(2000);

    // Adjustment mode where equalShare + a_i < 0: bill = 10000, adjustments = [0, -8000] -> pool = 18000 -> equalShare = 9000 (valid: [9000, 1000])
    // Now adjustments = [+7000, -7000] on bill = 10000 -> pool = 10000 -> equalShare = 5000 -> [12000, -2000] (INVALID: m1 < 0!)
    const adjNegResult = calculateSplits({
      totalMinor: 10000,
      originalTotalMinor: 10000,
      splitMode: 'adjustment',
      rotationSeed: 0,
      participants: [
        { memberId: 'm0', memberOrder: 0, included: true, rawInputValue: 7000 },
        { memberId: 'm1', memberOrder: 1, included: true, rawInputValue: -7000 },
      ],
    });
    expect(adjNegResult.map((s) => s.owedMinor)).toEqual([12000, -2000]);
    const adjNegCheck = validateExpenseInvariants({
      amountMinor: 10000,
      splitMode: 'adjustment',
      payers: [{ memberId: 'm0', paidMinor: 10000, originalPaidMinor: 10000 }],
      splits: adjNegResult,
    });
    expect(adjNegCheck.valid).toBe(false);
    expect(adjNegCheck.errors.some((e) => e.includes('negative'))).toBe(true);

    // Adjustment mode where sum(adjustments) > totalMinor (pool < 0): bill = 10000, adjustments = [6000, 6000]
    const adjPoolNeg = calculateSplits({
      totalMinor: 10000,
      originalTotalMinor: 10000,
      splitMode: 'adjustment',
      rotationSeed: 0,
      participants: [
        { memberId: 'm0', memberOrder: 0, included: true, rawInputValue: 6000 },
        { memberId: 'm1', memberOrder: 1, included: true, rawInputValue: 6000 },
      ],
    });
    const adjPoolCheck = validateExpenseInvariants({
      amountMinor: 10000,
      splitMode: 'adjustment',
      payers: [{ memberId: 'm0', paidMinor: 10000, originalPaidMinor: 10000 }],
      splits: adjPoolNeg,
    });
    expect(adjPoolCheck.valid).toBe(false);
    expect(adjPoolCheck.errors.some((e) => e.includes('exceed'))).toBe(true);
  });

  it('reconciles multi-payer foreign FX contributions and group currency re-denomination with zero subunit drift', () => {
    // 3 payers pay €33.33, €33.33, €33.34 (€100.00) converted to INR at 91.23 -> ₹9,123.00 (912300 paise)
    // Independent conversion would give round(3333 * 91.23) = 304070 + 304070 + round(3334 * 91.23) = 304161 -> sum = 912301 (1 paisa overflow!)
    const reconciled = reconcileMultiPayerFxContributions({
      payers: [
        { memberId: 'm0', originalPaidMinor: 3333 },
        { memberId: 'm1', originalPaidMinor: 3333 },
        { memberId: 'm2', originalPaidMinor: 3334 },
      ],
      originalCurrency: 'EUR',
      groupCurrency: 'INR',
      fxRateScaled: parseFxRateToScaled('91.23'),
      rotationSeed: 1,
    });
    expect(reconciled.amountMinor).toBe(912300);
    expect(reconciled.payers.reduce((a, p) => a + p.paidMinor, 0)).toBe(912300);
    expect(reconciled.payers.reduce((a, p) => a + p.originalPaidMinor, 0)).toBe(10000);

    // Skewed multi-payer expense [1, 5, 5, 5] (total 16) reconverted by 0.5x where naive idx=0 subtraction produced -1!
    const skewedExp = makeExpense({
      id: 'exp_skewed',
      currency: 'INR',
      amountMinor: 16,
      splitMode: 'exact',
      payers: [
        { memberId: 'mem_00', paidMinor: 1 },
        { memberId: 'mem_01', paidMinor: 5 },
        { memberId: 'mem_02', paidMinor: 5 },
        { memberId: 'mem_03', paidMinor: 5 },
      ],
      splits: [
        { memberId: 'mem_00', included: true, owedMinor: 1, originalOwedMinor: 1, rawInputValue: 1, remainderMinor: 0 },
        { memberId: 'mem_01', included: true, owedMinor: 5, originalOwedMinor: 5, rawInputValue: 5, remainderMinor: 0 },
        { memberId: 'mem_02', included: true, owedMinor: 5, originalOwedMinor: 5, rawInputValue: 5, remainderMinor: 0 },
        { memberId: 'mem_03', included: true, owedMinor: 5, originalOwedMinor: 5, rawInputValue: 5, remainderMinor: 0 },
      ],
    });

    const reconverted = redenominateExpenseCurrency({
      expense: skewedExp,
      newCurrency: 'USD',
      mode: 'reconvert',
      fxRateScaled: parseFxRateToScaled('0.50'),
    });
    expect(reconverted.amountMinor).toBe(8);
    expect(reconverted.payers.every((p) => p.paidMinor >= 0)).toBe(true);
    expect(reconverted.splits.every((s) => s.owedMinor >= 0)).toBe(true);
    expect(
      validateExpenseInvariants({
        amountMinor: reconverted.amountMinor,
        splitMode: reconverted.splitMode,
        payers: reconverted.payers,
        splits: reconverted.splits,
      }).valid
    ).toBe(true);

    // Relabel settlement INR (50000 -> ₹500.00) to KWD (500000 -> KD500.000) and JPY (500 -> ¥500)
    const baseSettlement: SettlementItem = {
      id: 'stl_1',
      groupId: 'grp_test',
      batchSettlementId: null,
      fromMemberId: 'mem_01',
      toMemberId: 'mem_00',
      amountMinor: 50000,
      currency: 'INR',
      paymentMethod: 'upi',
      paymentReference: null,
      notes: '',
      settledDate: '2026-11-11',
      createdAt: '2026-11-11T00:00:00Z',
      deletedAt: null,
      hlc: '019a-0001-usr',
    };
    const kwdStl = redenominateSettlementCurrency({
      settlement: baseSettlement,
      newCurrency: 'KWD',
      mode: 'relabel',
    });
    expect(kwdStl.amountMinor).toBe(500000);
    expect(kwdStl.currency).toBe('KWD');

    const jpyStl = redenominateSettlementCurrency({
      settlement: baseSettlement,
      newCurrency: 'JPY',
      mode: 'relabel',
    });
    expect(jpyStl.amountMinor).toBe(500);
    expect(jpyStl.currency).toBe('JPY');
  });
});

describe('Suite 3: Balance Engine, Multi-Payer Pairwise Matrix, Bitmask-DP & Multi-Currency Cross-Group (ledger-engine.ts)', () => {
  it('computes exact unsimplified pairwise debts when a multi-payer UNDERPAYS their own share (A paid 250, B paid 50, C paid 0 on 300 equal bill)', () => {
    const members = makeMembers(3);
    const [mA, mB, mC] = [members[0]!, members[1]!, members[2]!];

    // Bill = ₹300.00 (30000) split equally ₹100.00 (10000) each.
    // A paid ₹250.00 (surplus +15000), B paid ₹50.00 (deficit -5000!), C paid ₹0.00 (deficit -10000).
    // B underpaid their own share, so B owes A ₹50 and C owes A ₹100; C owes B ₹0!
    const bill = makeExpense({
      id: 'exp_underpaying_payer',
      amountMinor: 30000,
      payers: [
        { memberId: mA.id, paidMinor: 25000 },
        { memberId: mB.id, paidMinor: 5000 },
      ],
      splits: [
        { memberId: mA.id, included: true, owedMinor: 10000, originalOwedMinor: 10000, rawInputValue: 1, remainderMinor: 0 },
        { memberId: mB.id, included: true, owedMinor: 10000, originalOwedMinor: 10000, rawInputValue: 1, remainderMinor: 0 },
        { memberId: mC.id, included: true, owedMinor: 10000, originalOwedMinor: 10000, rawInputValue: 1, remainderMinor: 0 },
      ],
    });

    const pairwise = computeRawPairwiseTransfers([bill], [], members, 'INR');
    expect(pairwise).toHaveLength(2);
    expect(
      pairwise.find((t) => t.fromMemberId === mC.id && t.toMemberId === mA.id)?.amountMinor
    ).toBe(10000);
    expect(
      pairwise.find((t) => t.fromMemberId === mB.id && t.toMemberId === mA.id)?.amountMinor
    ).toBe(5000);
    // C must NEVER owe B!
    expect(
      pairwise.find((t) => t.fromMemberId === mC.id && t.toMemberId === mB.id)
    ).toBeUndefined();
  });

  it('conserves both row deficits and column surpluses on 2x2 unit rounding edge case (C1=+1, C2=+1, D1=-1, D2=-1)', () => {
    const members = makeMembers(4);
    const bill = makeExpense({
      id: 'exp_2x2_unit',
      amountMinor: 2,
      payers: [
        { memberId: members[0]!.id, paidMinor: 1 },
        { memberId: members[1]!.id, paidMinor: 1 },
      ],
      splits: [
        { memberId: members[0]!.id, included: false, owedMinor: 0, originalOwedMinor: 0, rawInputValue: 0, remainderMinor: 0 },
        { memberId: members[1]!.id, included: false, owedMinor: 0, originalOwedMinor: 0, rawInputValue: 0, remainderMinor: 0 },
        { memberId: members[2]!.id, included: true, owedMinor: 1, originalOwedMinor: 1, rawInputValue: 1, remainderMinor: 0 },
        { memberId: members[3]!.id, included: true, owedMinor: 1, originalOwedMinor: 1, rawInputValue: 1, remainderMinor: 0 },
      ],
    });

    const pairwise = computeRawPairwiseTransfers([bill], [], members, 'INR');
    expect(pairwise).toHaveLength(2);

    // Verify applying all pairwise transfers brings EVERY member's balance to 0
    const settlementEquiv: SettlementItem[] = pairwise.map((t, idx) => ({
      id: `stl_${idx}`,
      groupId: 'grp_test',
      batchSettlementId: null,
      fromMemberId: t.fromMemberId,
      toMemberId: t.toMemberId,
      amountMinor: t.amountMinor,
      currency: 'INR',
      paymentMethod: 'upi',
      paymentReference: null,
      notes: '',
      settledDate: '2026-11-11',
      createdAt: '2026-11-11T00:00:00Z',
      deletedAt: null,
      hlc: '019a-0001-usr',
    }));

    const postBalances = computeGroupNetBalances([bill], settlementEquiv, members);
    for (const bal of postBalances.values()) {
      expect(bal).toBe(0);
    }
  });

  it('proves Bitmask-DP (n <= 16) strictly beats Greedy on 6-person counterexample, handles >2^31 balances without Int32 overflow, and settles n=18 cleanly', () => {
    // 1. Disjoint 4-person zero-sum pairs: [+100, -100, +250, -250] -> strictly 2 transfers
    const members4 = makeMembers(4);
    const map4 = new Map<string, number>([
      [members4[0]!.id, 100],
      [members4[1]!.id, -100],
      [members4[2]!.id, 250],
      [members4[3]!.id, -250],
    ]);
    const dp4 = simplifyGroupDebts(map4, members4, 'INR');
    expect(dp4).toHaveLength(2);

    // 2. Explicit 6-person counterexample where Max-Greedy takes 5 transfers, while Bitmask-DP finds 2 zero-sum triples = 4 transfers!
    // Subset 1: {+1000, -600, -400} (2 transfers)
    // Subset 2: {+900, -700, -200} (2 transfers)
    // Max-Greedy picks +1000 & -700 first, breaking both subsets and requiring 5 transfers!
    const members6 = makeMembers(6);
    const balances6 = [1000, 900, -700, -600, -400, -200];
    const map6 = new Map<string, number>(
      members6.map((m, idx) => [m.id, balances6[idx]!])
    );
    const dpTransfers6 = simplifyGroupDebts(map6, members6, 'INR');
    expect(dpTransfers6).toHaveLength(4);

    // Simulate pure Max-Greedy on the exact same 6 balances to prove Greedy requires 5 transfers
    const simCreditors = [1000, 900];
    const simDebtors = [700, 600, 400, 200];
    let greedySteps = 0;
    while (simCreditors.some((c) => c > 0) && simDebtors.some((d) => d > 0)) {
      simCreditors.sort((a, b) => b - a);
      simDebtors.sort((a, b) => b - a);
      const amt = Math.min(simCreditors[0]!, simDebtors[0]!);
      simCreditors[0]! -= amt;
      simDebtors[0]! -= amt;
      greedySteps++;
    }
    expect(greedySteps).toBe(5);
    expect(dpTransfers6.length).toBeLessThan(greedySteps);

    // 3. Regression for Int32Array overflow (> 2,147,483,647 minor units) at n = 16!
    const members16 = makeMembers(16);
    const map16 = new Map<string, number>();
    for (let i = 0; i < 8; i++) {
      const largeAmt = 3_000_000_000 + i * 100_000_000; // > 2^31 - 1!
      map16.set(members16[2 * i]!.id, largeAmt);
      map16.set(members16[2 * i + 1]!.id, -largeAmt);
    }
    const dp16 = simplifyGroupDebts(map16, members16, 'INR');
    expect(dp16).toHaveLength(8); // 8 disjoint pairs found at n = 16!
    for (const t of dp16) {
      map16.set(t.fromMemberId, (map16.get(t.fromMemberId) ?? 0) + t.amountMinor);
      map16.set(t.toMemberId, (map16.get(t.toMemberId) ?? 0) - t.amountMinor);
    }
    for (const residual of map16.values()) {
      expect(residual).toBe(0);
    }

    // 4. n = 18 Greedy fallback: terminates in <= 17 (n - 1) transfers with 0 residual
    const members18 = makeMembers(18);
    const map18 = new Map<string, number>();
    let runningSum = 0;
    for (let i = 0; i < 17; i++) {
      const val = i % 2 === 0 ? (i + 1) * 137 : -(i + 1) * 113;
      map18.set(members18[i]!.id, val);
      runningSum += val;
    }
    map18.set(members18[17]!.id, -runningSum);

    const greedy18 = simplifyGroupDebts(map18, members18, 'INR');
    expect(greedy18.length).toBeLessThanOrEqual(17);
    for (const t of greedy18) {
      map18.set(t.fromMemberId, (map18.get(t.fromMemberId) ?? 0) + t.amountMinor);
      map18.set(t.toMemberId, (map18.get(t.toMemberId) ?? 0) - t.amountMinor);
    }
    for (const residual of map18.values()) {
      expect(residual).toBe(0);
    }
  });

  it('excludes soft-deleted expenses/settlements and self-settlements everywhere, and preserves multi-currency cross-group accuracy (KRW, BHD, JPY, KWD, INR)', () => {
    const members = makeMembers(2, 'grp_krw');
    const grpKrw: GroupRecord = {
      id: 'grp_krw',
      name: 'Seoul Trip',
      description: '0-decimal KRW test',
      category: 'trip',
      baseCurrency: 'KRW',
      simplifyDebts: true,
      defaultSplitConfig: null,
      expenseSeq: 2,
      inviteCode: 'SEOUL-1',
      createdAt: '2026-11-01T00:00:00Z',
      updatedAt: '2026-11-01T00:00:00Z',
      deletedAt: null,
      hlc: '019a-0001-usr',
      members,
    };

    const activeKrwExp = makeExpense({
      id: 'exp_krw_active',
      groupId: 'grp_krw',
      currency: 'KRW',
      amountMinor: 100000, // ₩100,000 KRW (0 decimals!)
      payers: [{ memberId: members[0]!.id, paidMinor: 100000 }],
      splits: [
        { memberId: members[0]!.id, included: true, owedMinor: 50000, originalOwedMinor: 50000, rawInputValue: 1, remainderMinor: 0 },
        { memberId: members[1]!.id, included: true, owedMinor: 50000, originalOwedMinor: 50000, rawInputValue: 1, remainderMinor: 0 },
      ],
    });

    const deletedKrwExp = makeExpense({
      id: 'exp_krw_deleted',
      groupId: 'grp_krw',
      currency: 'KRW',
      amountMinor: 999999,
      deletedAt: '2026-11-11T12:00:00Z',
      payers: [{ memberId: members[1]!.id, paidMinor: 999999 }],
      splits: [
        { memberId: members[0]!.id, included: true, owedMinor: 999999, originalOwedMinor: 999999, rawInputValue: 999999, remainderMinor: 0 },
      ],
    });

    const deletedSettlement: SettlementItem = {
      id: 'stl_deleted',
      groupId: 'grp_krw',
      batchSettlementId: null,
      fromMemberId: members[1]!.id,
      toMemberId: members[0]!.id,
      amountMinor: 50000,
      currency: 'KRW',
      paymentMethod: 'cash',
      paymentReference: null,
      notes: '',
      settledDate: '2026-11-11',
      createdAt: '2026-11-11T00:00:00Z',
      deletedAt: '2026-11-11T13:00:00Z',
      hlc: '019a-0002-usr',
    };

    const selfSettlement: SettlementItem = {
      ...deletedSettlement,
      id: 'stl_self',
      deletedAt: null,
      fromMemberId: members[0]!.id,
      toMemberId: members[0]!.id,
    };

    // Add a 3-decimal BHD group with the same friend
    const bhdMembers = [
      { ...members[0]!, id: 'mem_bhd_0', groupId: 'grp_bhd' },
      { ...members[1]!, id: 'mem_bhd_1', groupId: 'grp_bhd' },
    ];
    const grpBhd: GroupRecord = {
      ...grpKrw,
      id: 'grp_bhd',
      name: 'Manama Stopover',
      baseCurrency: 'BHD',
      members: bhdMembers,
    };
    const activeBhdExp = makeExpense({
      id: 'exp_bhd_active',
      groupId: 'grp_bhd',
      currency: 'BHD',
      amountMinor: 20000, // BD 20.000 (3 decimals = 20,000 fils; friend owes 10.000 BHD)
      payers: [{ memberId: 'mem_bhd_0', paidMinor: 20000 }],
      splits: [
        { memberId: 'mem_bhd_0', included: true, owedMinor: 10000, originalOwedMinor: 10000, rawInputValue: 1, remainderMinor: 0 },
        { memberId: 'mem_bhd_1', included: true, owedMinor: 10000, originalOwedMinor: 10000, rawInputValue: 1, remainderMinor: 0 },
      ],
    });

    // Verify explainMemberBalance matches computeGroupNetBalances (self-settlement & deleted items ignored)
    const krwNet = computeGroupNetBalances(
      [activeKrwExp, deletedKrwExp],
      [deletedSettlement, selfSettlement],
      members
    );
    const krwExplain = explainMemberBalance(
      members[0]!.id,
      grpKrw,
      [activeKrwExp, deletedKrwExp],
      [deletedSettlement, selfSettlement]
    );
    expect(krwNet.get(members[0]!.id)).toBe(50000);
    expect(krwExplain.netBalanceMinor).toBe(50000);

    // Verify cross-group summary across KRW (0-dec: 50,000 * 0.062 = ₹3,100.00 = 310000 paise)
    // and BHD (3-dec: 10.000 BHD * 224.2 = ₹2,242.00 = 224200 paise) -> Total = 534200 paise!
    const crossSummary = computeCrossGroupFriendsSummary(
      'member0@example.com',
      [grpKrw, grpBhd],
      [activeKrwExp, deletedKrwExp, activeBhdExp],
      [deletedSettlement, selfSettlement],
      { KRW: 0.062, BHD: 224.2, INR: 1 }
    );
    expect(crossSummary).toHaveLength(1);
    const friend = crossSummary[0]!;
    expect(friend.netByCurrencyMinor).toEqual({ KRW: 50000, BHD: 10000 });
    expect(friend.netInInrMinor).toBe(310000 + 224200);

    // Also verify standalone direct split (groupId: null) settles to 0 when standalone settlement is recorded
    const directExp: ExpenseItem = {
      ...makeExpense({
        id: 'exp_direct_1',
        groupId: null,
        currency: 'INR',
        amountMinor: 60000,
        payers: [{ memberId: 'adhoc_0', paidMinor: 60000 }],
        splits: [
          { memberId: 'adhoc_0', included: true, owedMinor: 30000, originalOwedMinor: 30000, rawInputValue: 1, remainderMinor: 0 },
          { memberId: 'adhoc_1', included: true, owedMinor: 30000, originalOwedMinor: 30000, rawInputValue: 1, remainderMinor: 0 },
        ],
      }),
      adHocParticipants: [
        {
          id: 'adhoc_0',
          displayName: 'Member 0',
          invitedEmail: 'member0@example.com',
          upiId: null,
          avatarInitials: 'M0',
          memberOrder: 0,
        },
        {
          id: 'adhoc_1',
          displayName: 'Direct Friend',
          invitedEmail: 'direct@example.com',
          upiId: null,
          avatarInitials: 'DF',
          memberOrder: 1,
        },
      ],
    };
    const directSettlement: SettlementItem = {
      id: 'stl_direct_1',
      groupId: null,
      batchSettlementId: 'batch_1',
      fromMemberId: 'adhoc_1',
      toMemberId: 'adhoc_0',
      amountMinor: 30000,
      currency: 'INR',
      paymentMethod: 'upi',
      paymentReference: null,
      notes: 'Settled direct bill',
      settledDate: '2026-11-11',
      createdAt: '2026-11-11T00:00:00Z',
      deletedAt: null,
      hlc: '019a-0003-usr',
    };

    const settledDirectSummary = computeCrossGroupFriendsSummary(
      'member0@example.com',
      [],
      [directExp],
      [directSettlement],
      { INR: 1 }
    );
    const directFriend = settledDirectSummary.find((f) => f.friendKey === 'direct@example.com');
    expect(directFriend?.netInInrMinor ?? 0).toBe(0);
    expect(directFriend?.groupBreakdowns ?? []).toHaveLength(0);
  });
});

describe('Suite 4: Portability Engine Security & Edge Cases (portability-engine.ts)', () => {
  it('neutralizes CSV and XLSX formula injection (=, +, -, @, tab, CR) while keeping negative numbers intact', () => {
    expect(sanitizeSpreadsheetCell('=CMD|\' /C calc\'!A0')).toBe('\'=CMD|\' /C calc\'!A0');
    expect(sanitizeSpreadsheetCell('+SUM(A1:A10)')).toBe('\'+SUM(A1:A10)');
    expect(sanitizeSpreadsheetCell('-2+3')).toBe('\'-2+3');
    expect(sanitizeSpreadsheetCell('@IMPORTXML("http://evil.example","//a")')).toBe(
      '\'@IMPORTXML("http://evil.example","//a")'
    );
    expect(sanitizeSpreadsheetCell('\t=1+1')).toBe('\'\t=1+1');
    expect(sanitizeSpreadsheetCell('Normal Dinner Title')).toBe('Normal Dinner Title');

    const members = makeMembers(2, 'grp_sec');
    const grp: GroupRecord = {
      id: 'grp_sec',
      name: '=EvilGroup()',
      description: '',
      category: 'trip',
      baseCurrency: 'INR',
      simplifyDebts: true,
      defaultSplitConfig: null,
      expenseSeq: 1,
      inviteCode: 'SEC-1',
      createdAt: '2026-11-01T00:00:00Z',
      updatedAt: '2026-11-01T00:00:00Z',
      deletedAt: null,
      hlc: '019a-0001-usr',
      members,
    };
    const maliciousExp = makeExpense({
      id: 'exp_csv_inj',
      groupId: 'grp_sec',
      amountMinor: 10000,
      payers: [{ memberId: members[0]!.id, paidMinor: 10000 }],
      splits: [
        { memberId: members[0]!.id, included: true, owedMinor: 5000, originalOwedMinor: 5000, rawInputValue: 1, remainderMinor: 0 },
        { memberId: members[1]!.id, included: true, owedMinor: 5000, originalOwedMinor: 5000, rawInputValue: 1, remainderMinor: 0 },
      ],
    });
    maliciousExp.title = '=HYPERLINK("http://evil.test","Click")';

    const csv = exportGroupToCsv(grp, [maliciousExp], []);
    const parsedRows = parseRfc4180CsvRows(csv);
    expect(parsedRows[1]?.[2]).toBe('\'=HYPERLINK("http://evil.test","Click")');
    // Numeric columns stay normal unprefixed numbers ("50.00" and "-50.00")
    expect(parsedRows[1]?.[7]).toBe('50.00');
    expect(parsedRows[1]?.[8]).toBe('-50.00');

    // Verify XLSX workbook cells also neutralize formulas while preserving numeric strings
    const xlsxBytes = exportGroupToExcelBuffer(grp, [maliciousExp], []);
    const wb = XLSX.read(xlsxBytes, { type: 'array' });
    const expensesSheet = wb.Sheets['Expenses']!;
    const jsonRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(expensesSheet);
    expect(jsonRows[0]?.['Title']).toBe('\'=HYPERLINK("http://evil.test","Click")');
    expect(jsonRows[0]?.['Member 1 (Net)']).toBe('-50.00');
  });

  it('parses Splitwise CSV with RFC-4180 quoted commas, escaped quotes, grouped amounts, and multi-creditor rows, plus multi-currency UPI URIs', () => {
    const complexSplitwiseCsv = [
      'Date,Description,Category,Cost,Currency,Arjun Mehta,Rohan Verma,Priya Nair',
      '2026-11-09,"Dinner, drinks, & ""tapas""",Food and drink,"1,200.00",INR,800.00,-400.00,-400.00',
      '2026-11-10,"Villa Advance, Goa",Hotel,"9,000.00",INR,3000.00,1000.00,-4000.00',
      '2026-11-11,Total balance, , ,INR,3800.00,600.00,-4400.00',
    ].join('\r\n');

    const parsed = parseSplitwiseCsv(complexSplitwiseCsv);
    expect(parsed.expenses).toHaveLength(2);

    const first = parsed.expenses[0]!;
    expect(first.title).toBe('Dinner, drinks, & "tapas"');
    expect(first.amountMinor).toBe(120000);
    expect(first.payers).toEqual([{ memberName: 'Arjun Mehta', paidMinor: 120000 }]);
    expect(first.splits.map((s) => s.owedMinor)).toEqual([40000, 40000, 40000]);

    // Multi-creditor row: Arjun net +3000, Rohan net +1000, Priya net -4000 on 9000 total
    const second = parsed.expenses[1]!;
    expect(second.title).toBe('Villa Advance, Goa');
    expect(second.amountMinor).toBe(900000);
    expect(second.payers.reduce((a, p) => a + p.paidMinor, 0)).toBe(900000);
    expect(second.splits.reduce((a, s) => a + s.owedMinor, 0)).toBe(900000);
    for (const name of parsed.memberNames) {
      const paid = second.payers.find((p) => p.memberName === name)?.paidMinor ?? 0;
      const owed = second.splits.find((s) => s.memberName === name)?.owedMinor ?? 0;
      const expectedNet =
        name === 'Arjun Mehta' ? 300000 : name === 'Rohan Verma' ? 100000 : -400000;
      expect(paid - owed).toBe(expectedNet);
    }

    // UPI URI formatting across currencies and negative guard
    expect(
      buildUpiPaymentUri({
        payeeUpiId: 'arjun@okicici',
        payeeName: 'Arjun Mehta',
        amountMinor: 125050,
        currency: ' inr ',
        note: 'Dinner settle',
      })
    ).toBe('upi://pay?pa=arjun%40okicici&pn=Arjun%20Mehta&am=1250.50&cu=INR&tn=Dinner%20settle');

    expect(
      buildUpiPaymentUri({
        payeeUpiId: 'arjun@okicici',
        payeeName: 'Arjun',
        amountMinor: 28351,
        currency: 'JPY',
        note: 'Rail',
      })
    ).toContain('am=28351&cu=JPY');

    expect(
      buildUpiPaymentUri({
        payeeUpiId: 'arjun@okicici',
        payeeName: 'Arjun',
        amountMinor: 25500,
        currency: 'KWD',
        note: 'Souk',
      })
    ).toContain('am=25.500&cu=KWD');

    expect(
      buildUpiPaymentUri({
        payeeUpiId: 'arjun@okicici',
        payeeName: 'Arjun',
        amountMinor: -5000,
        currency: 'INR',
        note: 'Guard',
      })
    ).toContain('am=0.00&cu=INR');

    // WhatsApp summary settled zero formatting for JPY (0-decimal)
    const waJpy = generateWhatsAppGroupSummary({
      groupName: 'Tokyo',
      currency: 'JPY',
      totalSpendMinor: 1000,
      simplifyDebts: true,
      netBalances: [{ name: 'Arjun', netMinor: 0 }],
      transfers: [],
    });
    expect(waJpy).toContain('settled (0)');
  });
});

describe('Suite 5: Multi-Step Ledger Scenario & fast-check Property-Based Fuzz Suites', () => {
  it('executes a full multi-step international trip lifecycle preserving zero-sum & reconciliation at every step', () => {
    const members = makeMembers(4, 'grp_trip');
    let group: GroupRecord = {
      id: 'grp_trip',
      name: 'Euro-Asia Expedition',
      description: 'End-to-end math lifecycle verification',
      category: 'trip',
      baseCurrency: 'INR',
      simplifyDebts: true,
      defaultSplitConfig: null,
      expenseSeq: 0,
      inviteCode: 'TRIP-2026',
      createdAt: '2026-11-01T00:00:00Z',
      updatedAt: '2026-11-01T00:00:00Z',
      deletedAt: null,
      hlc: '019a-0000-usr',
      members,
    };

    const expenses: ExpenseItem[] = [];
    const settlements: SettlementItem[] = [];

    // Step 1: Multi-payer foreign EUR bill (€100.00 -> ₹9,123.00) split equally among 3 members (seed 0)
    const mp = reconcileMultiPayerFxContributions({
      payers: [
        { memberId: members[0]!.id, originalPaidMinor: 6000 },
        { memberId: members[1]!.id, originalPaidMinor: 4000 },
      ],
      originalCurrency: 'EUR',
      groupCurrency: 'INR',
      fxRateScaled: parseFxRateToScaled('91.23'),
      rotationSeed: group.expenseSeq,
    });
    const sp1 = calculateSplits({
      totalMinor: mp.amountMinor,
      originalTotalMinor: mp.originalAmountMinor,
      splitMode: 'equal',
      rotationSeed: group.expenseSeq++,
      participants: members.map((m, idx) => ({
        memberId: m.id,
        memberOrder: idx,
        included: idx < 3,
        rawInputValue: 1,
      })),
    });
    expenses.push(
      makeExpense({
        id: 'exp_1',
        groupId: group.id,
        currency: 'INR',
        originalCurrency: 'EUR',
        originalAmountMinor: mp.originalAmountMinor,
        amountMinor: mp.amountMinor,
        fxRateScaled: parseFxRateToScaled('91.23'),
        splitMode: 'equal',
        rotationSeed: 0,
        payers: mp.payers,
        splits: sp1,
      })
    );

    // Step 2: Adjustment split with +₹500 and -₹200 adjustments
    const sp2 = calculateSplits({
      totalMinor: 200000,
      originalTotalMinor: 200000,
      splitMode: 'adjustment',
      rotationSeed: group.expenseSeq++,
      participants: [
        { memberId: members[0]!.id, memberOrder: 0, included: true, rawInputValue: 50000 },
        { memberId: members[1]!.id, memberOrder: 1, included: true, rawInputValue: -20000 },
        { memberId: members[2]!.id, memberOrder: 2, included: true, rawInputValue: 0 },
        { memberId: members[3]!.id, memberOrder: 3, included: true, rawInputValue: 0 },
      ],
    });
    expenses.push(
      makeExpense({
        id: 'exp_2',
        groupId: group.id,
        currency: 'INR',
        amountMinor: 200000,
        splitMode: 'adjustment',
        rotationSeed: 1,
        payers: [{ memberId: members[2]!.id, paidMinor: 200000 }],
        splits: sp2,
      })
    );

    // Step 3: Record partial settlement of ₹1,000.00 from member 3 to member 0
    settlements.push({
      id: 'stl_step3',
      groupId: group.id,
      batchSettlementId: null,
      fromMemberId: members[3]!.id,
      toMemberId: members[0]!.id,
      amountMinor: 100000,
      currency: 'INR',
      paymentMethod: 'upi',
      paymentReference: null,
      notes: 'Partial settle',
      settledDate: '2026-11-11',
      createdAt: '2026-11-11T00:00:00Z',
      deletedAt: null,
      hlc: '019a-0003-usr',
    });

    // Step 4: Re-denominate entire group from INR -> USD (reconvert at 1 INR = 0.01183432 USD)
    const inrToUsdScaled = parseFxRateToScaled('0.01183432');
    const usdExpenses = expenses.map((e) =>
      redenominateExpenseCurrency({
        expense: e,
        newCurrency: 'USD',
        mode: 'reconvert',
        fxRateScaled: inrToUsdScaled,
      })
    );
    const usdSettlements = settlements.map((s) =>
      redenominateSettlementCurrency({
        settlement: s,
        newCurrency: 'USD',
        mode: 'reconvert',
        fxRateScaled: inrToUsdScaled,
      })
    );
    group = { ...group, baseCurrency: 'USD' };

    for (const exp of usdExpenses) {
      const v = validateExpenseInvariants({
        amountMinor: exp.amountMinor,
        splitMode: exp.splitMode,
        payers: exp.payers,
        splits: exp.splits,
      });
      expect(v.valid).toBe(true);
    }

    // Step 5: Settle remaining USD balances via simplifyGroupDebts and confirm every member reaches 0!
    const preSettleNet = computeGroupNetBalances(usdExpenses, usdSettlements, members);
    expect(Array.from(preSettleNet.values()).reduce((a, b) => a + b, 0)).toBe(0);

    const remainingTransfers = simplifyGroupDebts(preSettleNet, members, 'USD');
    const finalSettlements: SettlementItem[] = [
      ...usdSettlements,
      ...remainingTransfers.map((t, idx) => ({
        id: `stl_final_${idx}`,
        groupId: group.id,
        batchSettlementId: 'batch_final',
        fromMemberId: t.fromMemberId,
        toMemberId: t.toMemberId,
        amountMinor: t.amountMinor,
        currency: 'USD',
        paymentMethod: 'bank' as const,
        paymentReference: null,
        notes: 'Final clear',
        settledDate: '2026-11-12',
        createdAt: '2026-11-12T00:00:00Z',
        deletedAt: null,
        hlc: '019a-0005-usr',
      })),
    ];

    const finalNet = computeGroupNetBalances(usdExpenses, finalSettlements, members);
    for (const m of members) {
      expect(finalNet.get(m.id)).toBe(0);
      expect(explainMemberBalance(m.id, group, usdExpenses, finalSettlements).netBalanceMinor).toBe(
        0
      );
    }
  });

  it('property 1: all 5 split modes strictly conserve totalMinor and originalTotalMinor across 1..20 members up to 10^11 minor units', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000_000_000 }),
        fc.integer({ min: 1, max: 100_000_000_000 }),
        fc.integer({ min: 1, max: 16 }),
        fc.integer({ min: -500, max: 500 }),
        fc.constantFrom<SplitMode>('equal', 'shares', 'percentage', 'exact', 'adjustment'),
        (totalMinor, origTotalMinor, k, seed, mode) => {
          let participants: SplitParticipantInput[] = [];
          if (mode === 'equal') {
            participants = Array.from({ length: k }, (_, i) => ({
              memberId: `m_${i}`,
              memberOrder: i,
              included: true,
              rawInputValue: 1,
            }));
          } else if (mode === 'shares') {
            participants = Array.from({ length: k }, (_, i) => ({
              memberId: `m_${i}`,
              memberOrder: i,
              included: true,
              rawInputValue: ((i * 7 + 3) % 11) + 1,
            }));
          } else if (mode === 'percentage') {
            const baseBps = Math.floor(10000 / k);
            const remBps = 10000 - baseBps * k;
            participants = Array.from({ length: k }, (_, i) => ({
              memberId: `m_${i}`,
              memberOrder: i,
              included: true,
              rawInputValue: baseBps + (i < remBps ? 1 : 0),
            }));
          } else if (mode === 'exact') {
            const alloc = allocateProportionalMinorAmounts(
              BigInt(totalMinor),
              Array.from({ length: k }, (_, i) => BigInt(i + 1)),
              seed
            ).amounts;
            participants = alloc.map((amt, i) => ({
              memberId: `m_${i}`,
              memberOrder: i,
              included: true,
              rawInputValue: Number(amt),
            }));
          } else {
            // adjustment: ensure sum(adjustments) <= totalMinor and every share >= 0
            const maxAdj = Math.floor(totalMinor / (k * 2));
            participants = Array.from({ length: k }, (_, i) => ({
              memberId: `m_${i}`,
              memberOrder: i,
              included: true,
              rawInputValue: i === 0 ? maxAdj : 0,
            }));
          }

          const splits = calculateSplits({
            totalMinor,
            originalTotalMinor: origTotalMinor,
            splitMode: mode,
            rotationSeed: seed,
            participants,
          });

          const sumOwed = splits.reduce((acc, s) => acc + s.owedMinor, 0);
          const sumOrigOwed = splits.reduce((acc, s) => acc + s.originalOwedMinor, 0);
          expect(sumOwed).toBe(totalMinor);
          expect(sumOrigOwed).toBe(origTotalMinor);

          const inv = validateExpenseInvariants({
            amountMinor: totalMinor,
            splitMode: mode,
            payers: [
              {
                memberId: 'm_0',
                paidMinor: totalMinor,
                originalPaidMinor: origTotalMinor,
              },
            ],
            splits,
          });
          expect(inv.valid).toBe(true);
        }
      ),
      { numRuns: 400 }
    );
  });

  it('property 2: rotating remainder fairness - over k consecutive equal splits of identical T, every participant owes the exact same total', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50_000_000 }),
        fc.integer({ min: 1, max: 15 }),
        fc.integer({ min: -100, max: 100 }),
        (totalMinor, k, startSeed) => {
          const participants: SplitParticipantInput[] = Array.from({ length: k }, (_, idx) => ({
            memberId: `m_${idx}`,
            memberOrder: idx,
            included: true,
            rawInputValue: 1,
          }));
          const cumulative = new Map<string, number>();
          for (let step = 0; step < k; step++) {
            const res = calculateSplits({
              totalMinor,
              originalTotalMinor: totalMinor,
              splitMode: 'equal',
              rotationSeed: startSeed + step,
              participants,
            });
            for (const s of res) {
              cumulative.set(s.memberId, (cumulative.get(s.memberId) ?? 0) + s.owedMinor);
            }
          }
          const totals = Array.from(cumulative.values());
          const minVal = Math.min(...totals);
          const maxVal = Math.max(...totals);
          expect(maxVal - minVal).toBe(0);
          expect(minVal).toBe(totalMinor);
        }
      ),
      { numRuns: 250 }
    );
  });

  it('property 3: both unsimplified pairwise transfers and Bitmask-DP simplified transfers settle any random multi-payer ledger to exact 0n', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 10 }),
        fc.array(
          fc.record({
            amountMinor: fc.integer({ min: 10, max: 500_000 }),
            payerWeights: fc.array(fc.integer({ min: 0, max: 10 }), { minLength: 2, maxLength: 10 }),
            splitWeights: fc.array(fc.integer({ min: 0, max: 10 }), { minLength: 2, maxLength: 10 }),
            deleted: fc.boolean(),
            seed: fc.integer({ min: 0, max: 50 }),
          }),
          { minLength: 1, maxLength: 12 }
        ),
        (memberCount, rawBills) => {
          const members = makeMembers(memberCount);
          const expenses: ExpenseItem[] = rawBills.map((b, idx) => {
            const pWeights = members.map((_, mIdx) => BigInt((b.payerWeights[mIdx] ?? 0) + (mIdx === 0 ? 1 : 0)));
            const payerAlloc = allocateProportionalMinorAmounts(
              BigInt(b.amountMinor),
              pWeights,
              b.seed
            ).amounts;

            const sWeights = members.map((_, mIdx) => (b.splitWeights[mIdx] ?? 0) + (mIdx === memberCount - 1 ? 1 : 0));
            const splits = calculateSplits({
              totalMinor: b.amountMinor,
              originalTotalMinor: b.amountMinor,
              splitMode: 'shares',
              rotationSeed: b.seed,
              participants: members.map((m, mIdx) => ({
                memberId: m.id,
                memberOrder: mIdx,
                included: sWeights[mIdx]! > 0,
                rawInputValue: sWeights[mIdx]!,
              })),
            });

            return makeExpense({
              id: `fuzz_exp_${idx}`,
              amountMinor: b.amountMinor,
              splitMode: 'shares',
              rotationSeed: b.seed,
              deletedAt: b.deleted ? '2026-11-11T00:00:00Z' : null,
              payers: members
                .map((m, mIdx) => ({
                  memberId: m.id,
                  paidMinor: Number(payerAlloc[mIdx]!),
                }))
                .filter((p) => p.paidMinor > 0),
              splits,
            });
          });

          const netBalances = computeGroupNetBalances(expenses, [], members);
          const sumNet = Array.from(netBalances.values()).reduce((a, b) => a + b, 0);
          expect(sumNet).toBe(0);

          const rawTransfers = computeRawPairwiseTransfers(expenses, [], members, 'INR');
          const simplifiedTransfers = simplifyGroupDebts(netBalances, members, 'INR');
          const nonZeroCount = Array.from(netBalances.values()).filter((v) => v !== 0).length;

          expect(simplifiedTransfers.length).toBeLessThanOrEqual(rawTransfers.length);
          expect(simplifiedTransfers.length).toBeLessThanOrEqual(Math.max(0, nonZeroCount - 1));

          // Applying rawTransfers clears every member to 0
          const rawSettlements: SettlementItem[] = rawTransfers.map((t, idx) => ({
            id: `raw_stl_${idx}`,
            groupId: 'grp_test',
            batchSettlementId: null,
            fromMemberId: t.fromMemberId,
            toMemberId: t.toMemberId,
            amountMinor: t.amountMinor,
            currency: 'INR',
            paymentMethod: 'upi',
            paymentReference: null,
            notes: '',
            settledDate: '2026-11-11',
            createdAt: '2026-11-11T00:00:00Z',
            deletedAt: null,
            hlc: '019a-0001-usr',
          }));
          const afterRaw = computeGroupNetBalances(expenses, rawSettlements, members);
          for (const v of afterRaw.values()) expect(v).toBe(0);

          // Applying simplifiedTransfers clears every member to 0
          const simpSettlements: SettlementItem[] = simplifiedTransfers.map((t, idx) => ({
            ...rawSettlements[0]!,
            id: `simp_stl_${idx}`,
            fromMemberId: t.fromMemberId,
            toMemberId: t.toMemberId,
            amountMinor: t.amountMinor,
          }));
          if (simplifiedTransfers.length > 0) {
            const afterSimp = computeGroupNetBalances(expenses, simpSettlements, members);
            for (const v of afterSimp.values()) expect(v).toBe(0);
          }
        }
      ),
      { numRuns: 250 }
    );
  });

  it('property 4: redenominateExpenseCurrency (relabel & reconvert) preserves 100% expense invariants across 0/2/3 decimal currencies', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('INR', 'USD', 'EUR', 'JPY', 'KWD', 'BHD'),
        fc.constantFrom('INR', 'USD', 'EUR', 'JPY', 'KWD', 'BHD'),
        fc.constantFrom<'relabel' | 'reconvert'>('relabel', 'reconvert'),
        fc.integer({ min: 100_000, max: 500_000_000_000 }), // fxRateScaled from 0.001 to 5000
        fc.integer({ min: 1, max: 50_000_000 }),
        fc.constantFrom<SplitMode>('equal', 'shares', 'percentage', 'exact', 'adjustment'),
        (fromCurr, toCurr, mode, fxRateScaled, amountMinor, splitMode) => {
          const members = makeMembers(4);
          const payerAlloc = allocateProportionalMinorAmounts(
            BigInt(amountMinor),
            [3n, 2n, 1n, 0n],
            1
          ).amounts;

          const baseBps = [4000, 3000, 2000, 1000];
          const adjMax = Math.floor(amountMinor / 6);
          const splits = calculateSplits({
            totalMinor: amountMinor,
            originalTotalMinor: amountMinor,
            splitMode,
            rotationSeed: 2,
            participants: members.map((m, i) => ({
              memberId: m.id,
              memberOrder: i,
              included: true,
              rawInputValue:
                splitMode === 'percentage'
                  ? baseBps[i]!
                  : splitMode === 'shares'
                  ? i + 1
                  : splitMode === 'exact'
                  ? Number(
                      allocateProportionalMinorAmounts(BigInt(amountMinor), [4n, 3n, 2n, 1n], 2)
                        .amounts[i]!
                    )
                  : splitMode === 'adjustment'
                  ? i === 0
                    ? adjMax
                    : i === 1
                    ? -Math.floor(adjMax / 2)
                    : 0
                  : 1,
            })),
          });

          const exp = makeExpense({
            id: 'exp_redenom_fuzz',
            currency: fromCurr,
            amountMinor,
            splitMode,
            rotationSeed: 2,
            payers: members
              .map((m, i) => ({ memberId: m.id, paidMinor: Number(payerAlloc[i]!) }))
              .filter((p) => p.paidMinor > 0),
            splits,
          });

          const updated = redenominateExpenseCurrency({
            expense: exp,
            newCurrency: toCurr,
            mode,
            fxRateScaled,
          });

          const check = validateExpenseInvariants({
            amountMinor: updated.amountMinor,
            splitMode: updated.splitMode,
            payers: updated.payers,
            splits: updated.splits,
          });
          expect(check.valid).toBe(true);
        }
      ),
      { numRuns: 300 }
    );
  });

  it('property 5: formatMinorToMajor <-> parseMajorToMinor round-trip identity across 0, 2, and 3 decimal currencies', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('JPY', 'KRW', 'INR', 'USD', 'EUR', 'KWD', 'BHD', 'OMR'),
        fc.integer({ min: -500_000_000, max: 500_000_000 }),
        fc.boolean(),
        (currency, minorVal, withSymbol) => {
          const formatted = formatMinorToMajor(minorVal, currency, withSymbol);
          const parsed = parseMajorToMinor(formatted, currency);
          expect(parsed).toBe(minorVal === 0 ? 0 : minorVal);
        }
      ),
      { numRuns: 400 }
    );
  });
});
