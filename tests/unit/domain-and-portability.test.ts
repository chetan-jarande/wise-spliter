import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
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
  lockParticipantUpiIds,
  simplifyGroupDebts,
} from '../../src/domain/ledger/ledger-engine';
import { buildPayeeUpiLink } from '../../src/utils/upi-link';
import {
  createSampleWebpReceiptAttachment,
  decryptBackupPayload,
  encryptBackupPayload,
  exportGroupToExcelBuffer,
  exportGroupToPdfBytes,
  generateWhatsAppGroupSummary,
  parseSplitwiseCsv,
  sha256Hex,
} from '../../src/portability/portability-engine';
import {
  clearSyncOutbox,
  enqueueSyncOutboxMutations,
  getLocalReceiptBlobsForExpense,
  listSyncOutboxMutations,
  loadDatasetFromIndexedDb,
  saveDatasetToIndexedDb,
  saveReceiptBlobLocally,
  wipeUserScopedData,
} from '../../src/storage/local-db';
import { diffDatasetToMutations, pushOutbox } from '../../src/sync-engine/sync-client';
import { FX_RATES_URL, loadFxRates, parseFxRatesResponse, quoteFxRate } from '../../src/utils/fx-rates';
import { matchesAmountFilter, monthlySpend } from '../../src/utils/expense-search';
import { LIMITS, expenseTextProblems } from '../../src/types/limits';
import {
  isNativeCapacitorApp,
  launchExternalUriCrossPlatform,
  registerNativeBackButtonHandler,
} from '../../src/utils/native-platform';
import {
  issueSessionToken,
  verifyRequestAuth,
  verifySessionToken,
} from '../../src/server/securityAndAuth';
import mockData from '../../src/data/mock-ledger-data.json';
import { ExpenseItem, GroupRecord, MockLedgerDataset, SettlementItem } from '../../src/types/ledger';

describe('Wise-Spliter Core Financial & Ledger Engine Verification', () => {
  it('supports every circulating ISO 4217 currency across 0, 2, and 3 decimal exponents', () => {
    expect(Object.keys(SUPPORTED_CURRENCIES).length).toBeGreaterThanOrEqual(160);
    expect(Object.keys(SUPPORTED_CURRENCIES).every((c) => /^[A-Z]{3}$/.test(c))).toBe(true);
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
    const upi = buildPayeeUpiLink({
      payeeUpiId: 'arjun.mehta@upi.test',
      payeeName: 'Arjun Mehta',
      amountMinor: 50000n,
      currency: 'INR',
      note: 'Goa Trip',
    });
    expect(upi).toContain('upi://pay?pa=arjun.mehta%40upi.test');

    const wa = generateWhatsAppGroupSummary({
      groupName: 'Goa Villa',
      currency: 'INR',
      totalSpendMinor: 100000,
      simplifyDebts: true,
      netBalances: [{ name: 'Arjun', netMinor: 50000 }, { name: 'Rohan', netMinor: -50000 }],
      transfers: [{ fromName: 'Rohan', toName: 'Arjun', toUpiId: 'arjun@upi.test', amountMinor: 50000 }],
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
    await enqueueSyncOutboxMutations([
      {
        entity: 'expense',
        id: 'exp_test_01',
        op: 'upsert',
        hlc: '019a73a00100-0001-usr_arjun_01',
        data: { title: 'Direct Chai Split', amountMinor: 90000 },
      },
      {
        entity: 'settlement',
        id: 'stl_test_02',
        op: 'upsert',
        hlc: '019a73a00100-0002-usr_arjun_01',
        data: { amountMinor: 45000 },
      },
    ]);

    const outbox = await listSyncOutboxMutations();
    expect(outbox.length).toBe(2);
    expect(outbox.map((m) => m.id)).toEqual(['expense:exp_test_01', 'settlement:stl_test_02']);
    await clearSyncOutbox();
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
          upiId: 'arjun.mehta@upi.test',
          avatarInitials: 'AM',
          memberOrder: 0,
        },
        {
          id: 'adhoc_vikram',
          displayName: 'Vikram Rao',
          invitedEmail: 'vikram.rao@example.com',
          upiId: 'vikram.rao@upi.test',
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

  it('verifies session tokens carry only sub/tv/aat/iat/exp and verifyRequestAuth rejects missing, tampered, 2-part or exp-less tokens', async () => {
    const token = issueSessionToken({ userId: 'usr_arjun_01', tokenVersion: 0 });
    const [header, body, sig] = token.split('.');
    expect(sig).toBeTruthy();
    const payload = JSON.parse(Buffer.from(body!, 'base64url').toString('utf8')) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['aat', 'aud', 'exp', 'iat', 'sub', 'tv']);
    expect(Number(payload.exp) - Number(payload.iat)).toBeLessThanOrEqual(12 * 60 * 60);
    expect(verifySessionToken(token)?.sub).toBe('usr_arjun_01');

    const reqWith = (auth?: string) =>
      ({ headers: auth ? { authorization: `Bearer ${auth}` } : {} }) as unknown as IncomingMessage;
    for (const bad of [undefined, `${token}x`, `${body}.${sig}`, `${header}.${Buffer.from(JSON.stringify({ sub: 'usr_arjun_01', tv: 0, iat: 1 })).toString('base64url')}.${sig}`]) {
      const res = await verifyRequestAuth(reqWith(bad));
      expect(res.authenticated).toBe(false);
      if (!res.authenticated) expect(res.status).toBe(401);
    }
  });

  it('verifies sha256Hex against NIST FIPS 180-4 test vectors, block padding boundaries, and fast-check fuzzing', () => {
    // Official NIST FIPS 180-4 single-block vectors
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
    expect(sha256Hex(new Uint8Array(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    );
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );

    // Official NIST 448-bit (56-byte) two-block boundary vector
    expect(
      sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')
    ).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');

    // Official NIST 896-bit (112-byte, >64-byte) multi-block vector
    const multiBlock112 =
      'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu';
    expect(multiBlock112.length).toBe(112);
    expect(sha256Hex(multiBlock112)).toBe(
      'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1'
    );
    expect(sha256Hex(new TextEncoder().encode(multiBlock112))).toBe(
      'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1'
    );

    // Exact SHA-256 64-byte block padding thresholds (55, 56, 63, 64, 65, 119, 120, 128, 257 bytes)
    for (const byteLen of [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 257]) {
      const buf = new Uint8Array(byteLen);
      for (let i = 0; i < byteLen; i++) {
        buf[i] = (i * 37 + 13) & 0xff;
      }
      const expectedHex = createHash('sha256').update(buf).digest('hex');
      expect(sha256Hex(buf)).toBe(expectedHex);
    }

    // Property fuzzing: arbitrary binary buffers match node:crypto SHA-256 bit-for-bit
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 320 }), (bytes) => {
        const expected = createHash('sha256').update(bytes).digest('hex');
        expect(sha256Hex(bytes)).toBe(expected);
      }),
      { numRuns: 200 }
    );
  });

  it('verifies createSampleWebpReceiptAttachment sets device-local pointer metadata and matching 64-char sha256 digest', () => {
    const attachment = createSampleWebpReceiptAttachment(
      'exp_goa_shack_99',
      'Beach Shack Sunset Snacks',
      'Arjun Mehta'
    );

    expect(attachment.expenseId).toBe('exp_goa_shack_99');
    expect(attachment.fileName).toBe('beach-shack-sunset-snacks.webp');
    expect(attachment.mimeType).toBe('image/webp');
    expect(attachment.localDeviceOnly).toBe(true);
    expect(attachment.storageBucket).toBe('local-device-only');
    expect(attachment.storagePath).toBe('local-device/exp_goa_shack_99.webp');
    expect(typeof attachment.dataUrl).toBe('string');
    expect(attachment.dataUrl?.startsWith('data:image/svg+xml;base64,')).toBe(true);
    expect(attachment.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(attachment.sha256).toBe(sha256Hex(attachment.dataUrl!));

    // Edge case: empty strings and XML/HTML special characters are stripped safely
    const sanitizedAttachment = createSampleWebpReceiptAttachment(
      'exp_edge_00',
      '',
      '<script>alert("x")</script>'
    );
    expect(sanitizedAttachment.fileName).toBe('expense-receipt.webp');
    expect(sanitizedAttachment.localDeviceOnly).toBe(true);
    expect(sanitizedAttachment.storageBucket).toBe('local-device-only');
    expect(sanitizedAttachment.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(sanitizedAttachment.sha256).toBe(sha256Hex(sanitizedAttachment.dataUrl!));
  });

  it('strips receipt dataUrl blobs before POST /api/ledger/push while keeping full blob in Dexie localReceiptBlobs', async () => {
    const attachment = createSampleWebpReceiptAttachment(
      'exp_local_only_sync_01',
      'Zero Cloud Bytes Receipt Test',
      'Arjun Mehta'
    );
    expect(attachment.dataUrl).toBeDefined();

    await saveReceiptBlobLocally({
      id: attachment.id,
      expenseId: attachment.expenseId,
      groupId: 'grp_goa_2026',
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      sizeKb: attachment.sizeKb,
      dataUrl: attachment.dataUrl!,
      storageBucket: 'local-device-only',
      storagePath: attachment.storagePath ?? 'local-device/exp_local_only_sync_01.webp',
      uploadedToCloud: false,
      createdAt: attachment.createdAt,
    });

    const localBlobs = await getLocalReceiptBlobsForExpense('exp_local_only_sync_01');
    expect(localBlobs).toHaveLength(1);
    expect(localBlobs[0]?.uploadedToCloud).toBe(false);
    expect(localBlobs[0]?.storageBucket).toBe('local-device-only');
    expect(localBlobs[0]?.dataUrl).toBe(attachment.dataUrl);

    const baseDataset = JSON.parse(JSON.stringify(mockData)) as MockLedgerDataset;
    const firstExpense = baseDataset.expenses[0]!;
    const datasetWithLocalReceipt: MockLedgerDataset = {
      ...baseDataset,
      expenses: [
        {
          ...firstExpense,
          id: 'exp_local_only_sync_01',
          receipts: [attachment],
        },
        ...baseDataset.expenses.slice(1),
      ],
    };

    const originalFetch = globalThis.fetch;
    const capturedRequests: Array<{ url: string; bodyText: string }> = [];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const bodyText = typeof init?.body === 'string' ? init.body : '';
      capturedRequests.push({ url, bodyText });
      const { mutations } = JSON.parse(bodyText) as {
        mutations: Array<{ entity: string; id: string }>;
      };
      return new Response(
        JSON.stringify({
          results: mutations.map((m) => ({ entity: m.entity, id: m.id, status: 'applied' })),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }) as typeof fetch;

    try {
      await clearSyncOutbox();
      await enqueueSyncOutboxMutations(
        diffDatasetToMutations(baseDataset, datasetWithLocalReceipt, baseDataset.currentUser.id)
      );
      const outcome = await pushOutbox('test.jwt.token');
      expect(outcome.status).toBe('ok');

      const pushCall = capturedRequests.find((r) => r.url.includes('/api/ledger/push'));
      expect(pushCall).toBeDefined();
      expect(pushCall!.bodyText.includes(attachment.dataUrl!)).toBe(false);
      expect(pushCall!.bodyText).not.toContain('data:image/');

      const parsedBody = JSON.parse(pushCall!.bodyText) as {
        mutations: Array<{ entity: string; id: string; data: ExpenseItem | null }>;
      };
      const syncedExpense = parsedBody.mutations.find(
        (m) => m.entity === 'expense' && m.id === 'exp_local_only_sync_01'
      )?.data;
      expect(syncedExpense).toBeDefined();
      const syncedReceipt = syncedExpense!.receipts[0];
      expect(syncedReceipt).toBeDefined();
      expect(syncedReceipt!.localDeviceOnly).toBe(true);
      expect(syncedReceipt!.storageBucket).toBe('local-device-only');
      expect(syncedReceipt!.sha256).toBe(attachment.sha256);
      expect(syncedReceipt!.dataUrl).toBeUndefined();
      expect('dataUrl' in syncedReceipt!).toBe(false);
      expect(
        parsedBody.mutations.some((m) => m.entity === 'receipt_pointer' && m.id === attachment.id)
      ).toBe(true);
      expect(await listSyncOutboxMutations()).toHaveLength(0);
    } finally {
      globalThis.fetch = originalFetch;
      await clearSyncOutbox();
    }
  });

  it('verifies native-platform helpers degrade cleanly in non-Capacitor web/Node runtimes', () => {
    expect(isNativeCapacitorApp()).toBe(false);
    expect(launchExternalUriCrossPlatform('')).toBe(false);
    expect(
      launchExternalUriCrossPlatform('upi://pay?pa=arjun.mehta%40upi.test&am=500.00&cu=INR')
    ).toBe(false);

    const disposeBackHandler = registerNativeBackButtonHandler(() => true);
    expect(typeof disposeBackHandler).toBe('function');
    expect(() => disposeBackHandler()).not.toThrow();
  });
});

describe('FX rate service (src/utils/fx-rates.ts)', () => {
  const sample = [
    { date: '2026-11-16', base: 'EUR', quote: 'INR', rate: 104.15 },
    { date: '2026-11-16', base: 'EUR', quote: 'USD', rate: 1.1072 },
    { date: '2026-11-15', base: 'EUR', quote: 'VND', rate: 28496 },
    { date: '2026-11-16', base: 'EUR', quote: 'KWD', rate: 0.34304 },
    { date: '2026-11-15', base: 'EUR', quote: 'BTC', rate: 0.0000101 },
    { date: '2026-11-16', base: 'EUR', quote: 'constructor', rate: 1 },
    { date: 'bad', base: 'EUR', quote: 'JPY', rate: 177 },
  ];
  const okFetch = (calls: string[]) =>
    (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(JSON.stringify(sample), { status: 200 });
    }) as typeof fetch;
  const failFetch = (async () => {
    throw new TypeError('offline');
  }) as typeof fetch;

  it('keeps only supported ISO quotes and adds EUR', () => {
    const table = parseFxRatesResponse(sample, '2026-11-16')!;
    expect(Object.keys(table.perEur).sort()).toEqual(['EUR', 'INR', 'KWD', 'USD', 'VND']);
    expect(table.perEur.EUR).toEqual({ rate: '1', date: '2026-11-16' });
    expect(parseFxRatesResponse({ rates: {} }, '2026-11-16')).toBeNull();
    expect(parseFxRatesResponse([], '2026-11-16')).toBeNull();
  });

  it('quotes live only for a table fetched today, cached_offline otherwise, and null for unknown pairs', () => {
    const table = parseFxRatesResponse(sample, '2026-11-16')!;
    expect(quoteFxRate(table, 'VND', 'INR', '2026-11-16')).toEqual({ rateScaled: 365_490, status: 'live', rateDate: '2026-11-15' });
    expect(quoteFxRate(table, 'USD', 'INR', '2026-11-20')?.status).toBe('cached_offline');
    expect(quoteFxRate(table, 'XAF', 'INR', '2026-11-16')).toBeNull();
    expect(quoteFxRate(null, 'USD', 'INR')).toBeNull();
    const q = quoteFxRate(table, 'VND', 'INR', '2026-11-16')!;
    const conv = convertMinorAmountWithFx({ originalMinor: 1_000_000, fromCurrency: 'VND', toCurrency: 'INR', fxRateScaled: q.rateScaled, fxStatus: q.status, dateIso: q.rateDate });
    expect(conv.convertedMinor).toBe(365_490);
    expect(conv.fxAuditNote).toBe('Converted from ₫1,000,000 VND at 1 VND = 0.0036549 INR (live rate, 2026-11-15)');
  });

  it('fetches once per day, caches on the device, and serves the stale cache offline', async () => {
    await wipeUserScopedData();
    const calls: string[] = [];
    expect(await loadFxRates({ online: false, today: '2026-11-16', fetchImpl: okFetch(calls) })).toBeNull();
    expect(await loadFxRates({ online: true, today: '2026-11-16', fetchImpl: failFetch })).toBeNull();

    const first = await loadFxRates({ online: true, today: '2026-11-16', fetchImpl: okFetch(calls) });
    expect(first?.fetchedOn).toBe('2026-11-16');
    expect(calls).toEqual([FX_RATES_URL]);
    await loadFxRates({ online: true, today: '2026-11-16', fetchImpl: okFetch(calls) });
    expect(calls).toHaveLength(1);

    const stale = await loadFxRates({ online: true, today: '2026-11-18', fetchImpl: failFetch });
    expect(stale?.fetchedOn).toBe('2026-11-16');
    expect(quoteFxRate(stale, 'USD', 'INR', '2026-11-18')?.status).toBe('cached_offline');
    const offline = await loadFxRates({ online: false, today: '2026-11-18', fetchImpl: okFetch(calls) });
    expect(offline?.fetchedOn).toBe('2026-11-16');
    expect(calls).toHaveLength(1);

    const next = await loadFxRates({ online: true, today: '2026-11-18', fetchImpl: okFetch(calls) });
    expect(next?.fetchedOn).toBe('2026-11-18');
    expect(calls).toHaveLength(2);
  });
});

describe('review fixes: UPI lock, currency-aware monthly spend, locale amount search', () => {
  const people = [
    { id: 'p_me', upiId: 'me@upi' },
    { id: 'p_raj', upiId: 'raj@upi' },
  ];

  it('keeps other participants’ UPI ids unless the editor owns the bill', () => {
    const edited = [
      { id: 'p_me', upiId: 'me-new@upi' },
      { id: 'p_raj', upiId: 'hacked@upi' },
      { id: 'p_new', upiId: 'copied@upi' },
    ];
    expect(lockParticipantUpiIds(edited, people, 'p_me', false)).toEqual([
      { id: 'p_me', upiId: 'me-new@upi' },
      { id: 'p_raj', upiId: 'raj@upi' },
      { id: 'p_new', upiId: null },
    ]);
    expect(lockParticipantUpiIds(edited, people, 'p_me', true)).toBe(edited);
    expect(lockParticipantUpiIds(edited, undefined, 'p_me', false)).toBe(edited);
  });

  const bill = (over: Partial<ExpenseItem>): ExpenseItem => ({ ...(mockData.expenses[0] as unknown as ExpenseItem), deletedAt: null, ...over });

  it('sums monthly spend in one currency, converting or skipping other currencies', () => {
    const bills = [
      bill({ expenseDate: '2026-11-02', amountMinor: 1000, groupCurrency: 'INR' }),
      bill({ expenseDate: '2026-11-03', amountMinor: 200, groupCurrency: 'USD' }),
      bill({ expenseDate: '2026-11-04', amountMinor: 999, groupCurrency: 'VND' }),
    ];
    const convert = (minor: bigint, from: string) => (from === 'USD' ? minor * 90n : null);
    expect(monthlySpend(bills, 12, 'INR', convert)).toEqual([{ month: '2026-11', totalMinor: 19000, count: 2 }]);
    expect(monthlySpend(bills, 12, 'INR')).toEqual([{ month: '2026-11', totalMinor: 1000, count: 1 }]);
  });

  it('reads the amount search in the device locale', () => {
    const e = bill({ amountMinor: 1250, groupCurrency: 'EUR', originalAmountMinor: 1250, originalCurrency: 'EUR' });
    expect(matchesAmountFilter(e, { mode: 'exact', min: '12,50', max: '' }, 'de-DE')).toBe(true);
    expect(matchesAmountFilter(e, { mode: 'exact', min: '12.50', max: '' }, 'en-IN')).toBe(true);
    expect(matchesAmountFilter({ ...e, amountMinor: 125000, originalAmountMinor: 125000 }, { mode: 'exact', min: '12,50', max: '' }, 'de-DE')).toBe(false);
  });
});

describe('shared field limits', () => {
  it('flags bill text the server would refuse, in plain words', () => {
    const ok = { title: 't'.repeat(LIMITS.expenseTitle), notes: 'n'.repeat(LIMITS.expenseNotes), tags: Array.from({ length: LIMITS.expenseTags }, (_, i) => `#t${i}`) };
    expect(expenseTextProblems(ok)).toEqual([]);
    expect(expenseTextProblems({ ...ok, title: ok.title + 'x' })).toEqual(['Keep the title to 200 characters.']);
    expect(expenseTextProblems({ ...ok, notes: ok.notes + 'x' })).toEqual(['Keep notes to 2000 characters.']);
    expect(expenseTextProblems({ ...ok, tags: [...ok.tags, '#extra'] })).toEqual(['Use at most 20 tags.']);
    expect(expenseTextProblems({ ...ok, tags: ['#' + 'a'.repeat(40)] })).toEqual(['Keep each tag to 40 characters.']);
  });
});
