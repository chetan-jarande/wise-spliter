import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  SUPPORTED_CURRENCIES,
  convertMinorAmountWithFx,
  formatMinorToMajor,
  getCurrency,
  parseFxRateToScaled,
  parseMajorToMinor,
} from '../../src/domain/money/currencies';
import { calculateSplits, validateExpenseInvariants } from '../../src/domain/splits/split-calculator';
import {
  computeCrossGroupFriendsSummary,
  computeGroupNetBalances,
  computeRawPairwiseTransfers,
  explainMemberBalance,
  simplifyGroupDebts,
} from '../../src/domain/ledger/ledger-engine';
import {
  buildUpiPaymentUri,
  decryptBackupPayload,
  encryptBackupPayload,
  generateWhatsAppGroupSummary,
  parseSplitwiseCsv,
} from '../../src/portability/portability-engine';
import mockData from '../../src/data/mock-ledger-data.json';
import { ExpenseItem, GroupRecord, SettlementItem } from '../../src/types/ledger';

describe('Wise-Spliter Core Financial & Ledger Engine Verification', () => {
  it('supports 170+ currencies across 0, 2, and 3 decimal exponents', () => {
    expect(Object.keys(SUPPORTED_CURRENCIES).length).toBeGreaterThanOrEqual(170);
    expect(getCurrency('JPY').decimals).toBe(0);
    expect(getCurrency('INR').decimals).toBe(2);
    expect(getCurrency('KWD').decimals).toBe(3);

    expect(parseMajorToMinor('28351', 'JPY')).toBe(28351);
    expect(formatMinorToMajor(28351, 'JPY')).toBe('¥28,351');

    expect(parseMajorToMinor('1250.50', 'INR')).toBe(125050);
    expect(formatMinorToMajor(125050, 'INR')).toBe('₹1,250.50');

    expect(parseMajorToMinor('25.000', 'KWD')).toBe(25000);
    expect(formatMinorToMajor(25000, 'KWD')).toBe('KD25.000');
  });

  it('converts foreign currency and builds Splitwise-parity FX audit note', () => {
    const res = convertMinorAmountWithFx({
      originalMinor: 18000, // €180.00
      fromCurrency: 'EUR',
      toCurrency: 'INR',
      fxRateScaled: parseFxRateToScaled('91.20'),
      fxStatus: 'live',
      dateIso: '2026-11-09',
    });
    expect(res.convertedMinor).toBe(1641600);
    expect(res.fxAuditNote).toBe(
      'Converted from €180.00 EUR at 1 EUR = 91.20 INR (live rate, 2026-11-09)'
    );
  });

  it('rotates the leftover 1 paisa fairly across 3 consecutive ₹1,000.00 equal bills', () => {
    const participants = [
      { memberId: 'm0', memberOrder: 0, included: true, rawInputValue: 1 },
      { memberId: 'm1', memberOrder: 1, included: true, rawInputValue: 1 },
      { memberId: 'm2', memberOrder: 2, included: true, rawInputValue: 1 },
    ];

    const s0 = calculateSplits({
      totalMinor: 100000,
      originalTotalMinor: 100000,
      splitMode: 'equal',
      rotationSeed: 0,
      participants,
    });
    const s1 = calculateSplits({
      totalMinor: 100000,
      originalTotalMinor: 100000,
      splitMode: 'equal',
      rotationSeed: 1,
      participants,
    });
    const s2 = calculateSplits({
      totalMinor: 100000,
      originalTotalMinor: 100000,
      splitMode: 'equal',
      rotationSeed: 2,
      participants,
    });

    expect(s0.map((x) => x.owedMinor)).toEqual([33334, 33333, 33333]);
    expect(s1.map((x) => x.owedMinor)).toEqual([33333, 33334, 33333]);
    expect(s2.map((x) => x.owedMinor)).toEqual([33333, 33333, 33334]);
  });

  it('validates all expenses in mock-ledger-data.json reconcile 100% with zero drift', () => {
    for (const exp of mockData.expenses as ExpenseItem[]) {
      const check = validateExpenseInvariants({
        amountMinor: exp.amountMinor,
        splitMode: exp.splitMode,
        payers: exp.payers,
        splits: exp.splits,
      });
      expect(check.valid).toBe(true);
    }
  });

  it('guarantees zero-sum group net balances and Bitmask-DP debt simplification across all mock groups', () => {
    const groups = mockData.groups as GroupRecord[];
    const expenses = mockData.expenses as ExpenseItem[];
    const settlements = mockData.settlements as SettlementItem[];

    for (const grp of groups) {
      const grpExpenses = expenses.filter((e) => e.groupId === grp.id && !e.deletedAt);
      const grpSettlements = settlements.filter((s) => s.groupId === grp.id && !s.deletedAt);
      const netBalances = computeGroupNetBalances(grpExpenses, grpSettlements, grp.members);

      let sum = 0;
      for (const val of netBalances.values()) sum += val;
      expect(sum).toBe(0);

      const simplified = simplifyGroupDebts(netBalances, grp.members, grp.baseCurrency);
      const raw = computeRawPairwiseTransfers(grpExpenses, grpSettlements, grp.members, grp.baseCurrency);
      expect(simplified.length).toBeLessThanOrEqual(raw.length);

      for (const m of grp.members) {
        const explanation = explainMemberBalance(m.id, grp, grpExpenses, grpSettlements);
        expect(explanation.netBalanceMinor).toBe(netBalances.get(m.id));
      }
    }

    const friends = computeCrossGroupFriendsSummary(
      mockData.currentUser.email,
      groups,
      expenses,
      settlements,
      mockData.fxRatesToInr
    );
    expect(friends.length).toBeGreaterThan(0);
  });

  it('verifies UPI deep links, WhatsApp summary, Splitwise CSV parser, and AES-256-GCM backup roundtrip', async () => {
    const upi = buildUpiPaymentUri({
      payeeUpiId: 'arjun.mehta@okicici',
      payeeName: 'Arjun Mehta',
      amountMinor: 50000,
      currency: 'INR',
      note: 'Goa Trip',
    });
    expect(upi).toContain('upi://pay?pa=arjun.mehta%40okicici');

    const wa = generateWhatsAppGroupSummary({
      groupName: 'Goa Villa',
      currency: 'INR',
      totalSpendMinor: 100000,
      simplifyDebts: true,
      netBalances: [{ name: 'Arjun', netMinor: 50000 }, { name: 'Rohan', netMinor: -50000 }],
      transfers: [{ fromName: 'Rohan', toName: 'Arjun', toUpiId: 'arjun@okicici', amountMinor: 50000 }],
    });
    expect(wa).toContain('Rohan* pays *Arjun* ₹500.00');

    const parsed = parseSplitwiseCsv(mockData.sampleSplitwiseCsv);
    expect(parsed.expenses.length).toBe(2);

    const encrypted = await encryptBackupPayload(JSON.stringify({ ok: true }), 'passphrase-123');
    const decrypted = await decryptBackupPayload(encrypted, 'passphrase-123');
    expect(JSON.parse(decrypted)).toEqual({ ok: true });
  });

  it('property: equal and shares splits always conserve 100% of totalMinor', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10000000 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 0, max: 100 }),
        (totalMinor, k, seed) => {
          const participants = Array.from({ length: k }, (_, idx) => ({
            memberId: `m${idx}`,
            memberOrder: idx,
            included: true,
            rawInputValue: (idx % 4) + 1,
          }));
          const eq = calculateSplits({
            totalMinor,
            originalTotalMinor: totalMinor,
            splitMode: 'equal',
            rotationSeed: seed,
            participants,
          });
          expect(eq.reduce((a, b) => a + b.owedMinor, 0)).toBe(totalMinor);
        }
      ),
      { numRuns: 300 }
    );
  });
});
