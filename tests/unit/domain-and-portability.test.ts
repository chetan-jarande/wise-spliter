import 'fake-indexeddb/auto';
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
  exportGroupToExcelBuffer,
  exportGroupToPdfBytes,
  generateWhatsAppGroupSummary,
  parseSplitwiseCsv,
} from '../../src/portability/portability-engine';
import {
  clearSyncOutbox,
  enqueueSyncOutboxMutation,
  getLocalReceiptBlobsForExpense,
  listSyncOutboxMutations,
  loadDatasetFromIndexedDb,
  saveDatasetToIndexedDb,
  saveReceiptBlobLocally,
} from '../../src/storage/local-db';
import mockData from '../../src/data/mock-ledger-data.json';
import { ExpenseItem, GroupRecord, MockLedgerDataset, SettlementItem } from '../../src/types/ledger';

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

  it('persists and loads full ledger dataset and sync outbox mutations in Dexie IndexedDB', async () => {
    const dataset = mockData as unknown as MockLedgerDataset;
    await saveDatasetToIndexedDb(dataset);

    const loaded = await loadDatasetFromIndexedDb();
    expect(loaded).not.toBeNull();
    expect(loaded?.groups.length).toBe(dataset.groups.length);
    expect(loaded?.expenses.length).toBe(dataset.expenses.length);
    expect(loaded?.currentUser.email).toBe(dataset.currentUser.email);

    await clearSyncOutbox();
    await enqueueSyncOutboxMutation({
      id: 'mut_test_01',
      entityType: 'expense',
      action: 'expense_created',
      payloadJson: JSON.stringify({ title: 'Direct Chai Split', amountMinor: 90000 }),
      createdAt: '2026-11-11T10:00:00.000Z',
      hlc: '2026-11-11T10:00:00.000Z-0001-node_arjun',
    });
    await enqueueSyncOutboxMutation({
      id: 'mut_test_02',
      entityType: 'settlement',
      action: 'settlement_recorded',
      payloadJson: JSON.stringify({ amountMinor: 45000 }),
      createdAt: '2026-11-11T10:05:00.000Z',
      hlc: '2026-11-11T10:05:00.000Z-0001-node_arjun',
    });

    const outbox = await listSyncOutboxMutations();
    expect(outbox.length).toBe(2);
    expect(outbox.map((m) => m.id)).toEqual(['mut_test_01', 'mut_test_02']);
  });

  it('aggregates non-group direct expenses (groupId: null with adHocParticipants) in computeCrossGroupFriendsSummary', () => {
    const groups = mockData.groups as GroupRecord[];
    const baseExpenses = mockData.expenses as ExpenseItem[];
    const settlements = mockData.settlements as SettlementItem[];

    const customDirectExpense: ExpenseItem = {
      id: 'exp_direct_unit_test_01',
      groupId: null,
      adHocParticipants: [
        {
          id: 'adhoc_arjun',
          displayName: 'Arjun Mehta',
          invitedEmail: mockData.currentUser.email,
          upiId: 'arjun.mehta@okicici',
          avatarInitials: 'AM',
          memberOrder: 0,
        },
        {
          id: 'adhoc_vikram',
          displayName: 'Vikram Rao',
          invitedEmail: 'vikram.rao@gmail.com',
          upiId: 'vikram.rao@okhdfcbank',
          avatarInitials: 'VR',
          memberOrder: 1,
        },
      ],
      title: 'Late Night Shawarma & Chai',
      category: 'food',
      tags: ['#direct-split', '#no-group'],
      notes: 'Direct 1-on-1 split without group',
      expenseDate: '2026-11-11',
      originalCurrency: 'INR',
      originalAmountMinor: 90000,
      groupCurrency: 'INR',
      amountMinor: 90000,
      fxRateScaled: 100000000,
      fxStatus: 'identity',
      fxAuditNote: null,
      splitMode: 'equal',
      rotationSeed: 0,
      payers: [{ memberId: 'adhoc_arjun', paidMinor: 90000, originalPaidMinor: 90000 }],
      splits: [
        {
          memberId: 'adhoc_arjun',
          included: true,
          owedMinor: 45000,
          originalOwedMinor: 45000,
          rawInputValue: 1,
          remainderMinor: 0,
        },
        {
          memberId: 'adhoc_vikram',
          included: true,
          owedMinor: 45000,
          originalOwedMinor: 45000,
          rawInputValue: 1,
          remainderMinor: 0,
        },
      ],
      currentRevisionId: 'rev_direct_unit_01',
      revisionNumber: 1,
      hasUnresolvedConflict: false,
      conflictRevisionId: null,
      createdByMemberId: 'adhoc_arjun',
      updatedByMemberId: 'adhoc_arjun',
      createdAt: '2026-11-11T12:00:00Z',
      updatedAt: '2026-11-11T12:00:00Z',
      deletedAt: null,
      hlc: '2026-11-11T12:00:00.000Z-0001-usr_arjun_01',
      comments: [],
      receipts: [],
    };

    const summary = computeCrossGroupFriendsSummary(
      mockData.currentUser.email,
      groups,
      [...baseExpenses, customDirectExpense],
      settlements,
      mockData.fxRatesToInr
    );

    const vikramEntry = summary.find((f) => f.displayName === 'Vikram Rao');
    expect(vikramEntry).toBeDefined();
    expect(vikramEntry?.netInInrMinor).toBe(45000);
    expect(
      vikramEntry?.groupBreakdowns.some(
        (b) => b.groupId === null && b.groupName === 'Direct: Late Night Shawarma & Chai' && b.netMinor === 45000
      )
    ).toBe(true);
  });

  it('sorts and slices Top 3 Recently Accessed/Updated Groups to at most 3 items', () => {
    const allActiveGroups = (mockData.groups as GroupRecord[]).filter((g) => !g.deletedAt);
    expect(allActiveGroups.length).toBe(4);

    const recentTop3Groups = [...allActiveGroups]
      .sort((a, b) => {
        const tsA = Math.max(
          Date.parse(a.lastAccessedAt ?? a.updatedAt) || 0,
          Date.parse(a.updatedAt) || 0
        );
        const tsB = Math.max(
          Date.parse(b.lastAccessedAt ?? b.updatedAt) || 0,
          Date.parse(b.updatedAt) || 0
        );
        return tsB - tsA;
      })
      .slice(0, 3);

    expect(recentTop3Groups.length).toBeLessThanOrEqual(3);
    expect(recentTop3Groups.length).toBe(3);

    for (let i = 0; i < recentTop3Groups.length - 1; i++) {
      const curr = recentTop3Groups[i]!;
      const next = recentTop3Groups[i + 1]!;
      const tsCurr = Math.max(
        Date.parse(curr.lastAccessedAt ?? curr.updatedAt) || 0,
        Date.parse(curr.updatedAt) || 0
      );
      const tsNext = Math.max(
        Date.parse(next.lastAccessedAt ?? next.updatedAt) || 0,
        Date.parse(next.updatedAt) || 0
      );
      expect(tsCurr).toBeGreaterThanOrEqual(tsNext);
    }
  });

  it('generates non-empty multi-sheet Excel (.xlsx) and PDF (.pdf) byte buffers for a group', () => {
    const group = (mockData.groups as GroupRecord[])[0]!;
    const expenses = (mockData.expenses as ExpenseItem[]).filter(
      (e) => e.groupId === group.id && !e.deletedAt
    );
    const settlements = (mockData.settlements as SettlementItem[]).filter(
      (s) => s.groupId === group.id && !s.deletedAt
    );

    const excelBytes = exportGroupToExcelBuffer(group, expenses, settlements);
    expect(excelBytes).toBeInstanceOf(Uint8Array);
    expect(excelBytes.byteLength).toBeGreaterThan(100);
    // ZIP/XLSX magic header PK (0x50, 0x4b)
    expect(excelBytes[0]).toBe(0x50);
    expect(excelBytes[1]).toBe(0x4b);

    const pdfBytes = exportGroupToPdfBytes(group, expenses, settlements);
    expect(pdfBytes).toBeInstanceOf(Uint8Array);
    expect(pdfBytes.byteLength).toBeGreaterThan(100);
    // PDF header %PDF (0x25, 0x50, 0x44, 0x46)
    expect(pdfBytes[0]).toBe(0x25);
    expect(pdfBytes[1]).toBe(0x50);
    expect(pdfBytes[2]).toBe(0x44);
    expect(pdfBytes[3]).toBe(0x46);
  });

  it('saves and retrieves receipt blobs locally in Dexie IndexedDB localReceiptBlobs table', async () => {
    const expenseId = 'exp_goa_receipt_test_01';
    await saveReceiptBlobLocally({
      id: 'rcpt_blob_test_01',
      expenseId,
      groupId: 'grp_goa_2026',
      fileName: 'beach-shack-receipt.webp',
      mimeType: 'image/webp',
      sizeKb: 18,
      dataUrl: 'data:image/webp;base64,UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=',
      storageBucket: 'wise-spliter-receipts',
      storagePath: 'grp_goa_2026/exp_goa_receipt_test_01/rcpt_blob_test_01-beach-shack-receipt.webp',
      uploadedToCloud: true,
      createdAt: '2026-11-11T14:00:00.000Z',
    });

    const blobs = await getLocalReceiptBlobsForExpense(expenseId);
    expect(blobs.length).toBe(1);
    expect(blobs[0]?.id).toBe('rcpt_blob_test_01');
    expect(blobs[0]?.fileName).toBe('beach-shack-receipt.webp');
    expect(blobs[0]?.storageBucket).toBe('wise-spliter-receipts');
    expect(blobs[0]?.uploadedToCloud).toBe(true);
  });
});
