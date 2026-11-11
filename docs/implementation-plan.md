# Wise-Spliter (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build **Wise-Spliter Phase 1**—a 100% free, local-first, multi-platform (Desktop, iOS, Android, Web) expense-splitting application with Settl's integer subunit precision and rotating remainders, plus Splitwise's Google OAuth multi-user collaboration, transparent group activity history, atomic offline conflict resolution, and full data portability.

**Architecture:** A single-codebase TypeScript 5.8 + React 19 + Vite 6 application backed by a pure, zero-dependency Financial & Graph Domain Engine (`src/domain/`), an ACID local IndexedDB database (`Dexie.js` in `src/storage/local-db.ts` including `local_receipt_blobs` for offline WebP receipts and `syncOutbox` FIFO queue) that serves 100% of reads/writes offline, a Backend API Gatekeeper (`src/server/index.ts` & `src/server/supabaseAdmin.ts` on `:4174`), and an asynchronous Sync Engine (`src/sync-engine/supabase-sync.ts`) that synchronizes mutations and receipt uploads with the centralized local/cloud Supabase stack (`SUPABASE_DIR = /home/chetan/projects/my-scripts/setup/dependencies`, schema `wise_spliter`, private Storage bucket `wise-spliter-receipts`). Packaged with an Offline Service Worker (`public/sw.js`) and PWA manifest (`public/manifest.webmanifest`).

**Tech Stack:** TypeScript 5.8 (`strict: true`, `noUncheckedIndexedAccess: true`), Vite 6, React 19, Tailwind CSS, `@phosphor-icons/react`, Dexie.js 4, Node/Bun Backend API Gatekeeper (`:4174`), Supabase PostgreSQL 17 & PostgREST (`wise_spliter` schema + RPCs `schema_health`, `push_mutations`, `pull_changes` + private bucket `wise-spliter-receipts`), Multi-Sheet `.xlsx` & `.pdf` exporters, RFC-4180 `.csv`, Splitwise CSV/JSON importer, Web Crypto API (`AES-256-GCM`), Vitest, `fast-check`, and Playwright.

**Spec:**
* [feature-requiremrnts.md](./feature-requiremrnts.md)
* [architecture.md](./architecture.md)
* [technical-spec.md](./technical-spec.md)
* [database-and-sync-spec.md](./database-and-sync-spec.md)
* [coding-standards.md](./coding-standards.md)

## Global Constraints

* **Zero Floating-Point Money Math:** All monetary amounts, shares, adjustments, and balances MUST be represented as `bigint` / exact integer minor units (`paise`, `cents`, `fils`, `yen`). Never use floating-point division for currency allocation.
* **170+ ISO-4217 Currencies (0, 2, and 3 Decimals):** Must support 0-decimal (`JPY`, `KRW`, `VND`), 2-decimal (`INR`, `USD`, `EUR`, `GBP`), and 3-decimal (`KWD`, `BHD`, `OMR`, `JOD`, `TND`) currencies natively.
* **Stateless Deterministic Rotating Remainder (Frozen on Save):** Leftover minor units (`0 <= r < k`) rotate across group members deterministically using `rotation_seed = group.expense_seq` and are frozen in `expense.splits` on save so deleting or editing another bill never shifts historical paise.
* **Modular Quick-Add (`ExpenseEditorModal`) & Minimalist Home Dashboard (`<= 3` Recent Groups):** The Home Dashboard (`HomeDashboardPage.tsx`) displays at most `<= 3` recently accessed/updated groups via `last_accessed_at` (`GREATEST(last_accessed_at, updated_at) DESC`). `ExpenseEditorModal` supports both `group_id = null` direct non-group splits with `ad_hoc_participants` and group-preselected splits when opened inside a group.
* **Progressive Group Workspace & Interactive Help (`HelpGuideModal` + `ContextualPageGuideBanner`):** Group workspaces (`GroupsLedgerPage.tsx`) progressively reveal concise balance insights, member roster management, and automatic next-step guidance alongside skippable page banners (`ContextualPageGuideBanner`) and an interactive `HelpGuideModal`.
* **Receipt Image & Bill Attachment Architecture:**
  * **Offline / Local Device:** Compressed WebP images are stored immediately in Dexie.js IndexedDB table `local_receipt_blobs` so receipts work 100% offline during flights/trips.
  * **Online / Centralized & Cloud Supabase:** Uploaded via the Backend API Service (`POST /api/receipts/upload` on `:4174`) to the private **Supabase Storage bucket `wise-spliter-receipts`** at path `{group_id_or_direct}/{expense_id}/{receipt_id}.webp`, with structured metadata recorded in `wise_spliter.receipt_attachments` and `wise_spliter.expenses.receipts`.
* **Isolated Per-Group Simplification + Atomic Multi-Group Friend Settle Up:** Multi-person graph debt simplification (`Bitmask DP` for $n \le 16$, greedy fallback for $n > 16$) runs strictly within each group; settling up from the Friends tab generates a shared `batch_settlement_id` posting offsetting settlements into each shared group atomically.
* **Whole-Expense Atomic Revisions + Conflict Diff Banner:** Never auto-merge partial fields of concurrent financial edits on the same expense. Track `base_revision_id` and `hlc`; if a concurrent offline edit occurs, store both snapshots in `expense_revisions`, mark `has_unresolved_conflict = true`, and allow 1-tap resolution (`[Keep Mine]` / `[Keep Theirs]`).
* **Transparent Group Activity & Update History (`group_activity_log`):** Every mutation in a group must record a human-readable and structured diff entry in `group_activity_log` visible to all group members.
* **Centralized Supabase (`SUPABASE_DIR = /home/chetan/projects/my-scripts/setup/dependencies`) & Isolated Schema (`wise_spliter`):** All cloud tables, views, triggers, RPCs (`wise_spliter.schema_health`, `wise_spliter.push_mutations`, `wise_spliter.pull_changes`), and RLS policies reside in `CREATE SCHEMA wise_spliter;`, never `public`, mediated by the Backend API Gatekeeper (`src/server/index.ts` on `:4174`).

---

## Subsystem Decomposition & Milestone Completion Status

| Milestone | Scope & Key Deliverables | Status |
| :--- | :--- | :--- |
| **Milestone 1 (Tasks 1–4)** | **Core Financial Math, 5 Split Modes, Bitmask-DP Simplifier & HLC Revision Engine (`src/domain/`)** — 170+ ISO-4217 currencies (`0, 2, 3` decimals), stateless rotating remainder, Bitmask-DP minimum-transfer solver, "Explain This Balance" lineage, and HLC revision diffing verified by Vitest + `fast-check` property tests. | ✅ **Completed** |
| **Milestone 2 (Tasks 5–6)** | **Local Offline DB (`Dexie.js`), Centralized Supabase (`wise_spliter`), Backend API Gatekeeper (`:4174`) & Receipt Attachment Pipeline (`src/storage/`, `src/server/`, `src/sync-engine/`, `supabase/`)** — Dexie `wise_spliter_local_db` + `syncOutbox` + `local_receipt_blobs`, `0001_wise_spliter_schema.sql` (`schema_health`, `push_mutations`, `pull_changes`), Backend API Gatekeeper (`src/server/index.ts`), and `POST /api/receipts/upload` $\to$ `wise-spliter-receipts` (`{group_id_or_direct}/{expense_id}/{receipt_id}.webp`). | ✅ **Completed** |
| **Milestone 3 (Task 7)** | **Portability Suite, UPI Deep-Links, WhatsApp Summary, Multi-Sheet `.xlsx` & `.pdf` Exports & AES-256-GCM Backups (`src/portability/`)** — Splitwise CSV/JSON importer, RFC-4180 `.csv`, Multi-Sheet `.xlsx` & `.pdf` statements, NPCI `upi://pay` deep-links + QR modal, WhatsApp summary generator, and Web Crypto `AES-256-GCM` `.wisesplit` archives. | ✅ **Completed** |
| **Milestone 4 (Task 8)** | **Minimalist Home Dashboard (`<= 3` Recent Groups), Modular `ExpenseEditorModal`, Progressive Group Workspace, `HelpGuideModal` + `ContextualPageGuideBanner`, Offline Service Worker (`public/sw.js`) & Playwright E2E Suite (`src/ui/`, `tests/e2e/`)** — Complete responsive UI across Desktop and Mobile with live Playwright E2E verification. | ✅ **Completed** |

---

### Task 1: Project Scaffolding & ISO-4217 Multi-Currency Minor-Unit & FX Engine (✅ Completed)

**Files:**
- Create: `wise-spliter/package.json`
- Create: `wise-spliter/tsconfig.json`
- Create: `wise-spliter/vite.config.ts`
- Create: `wise-spliter/src/domain/money/currencies.ts`
- Create: `wise-spliter/src/domain/money/minor-units.ts`
- Create: `wise-spliter/src/domain/money/fx-converter.ts`
- Test: `wise-spliter/tests/unit/money.test.ts`

**Interfaces:**
- Consumes: None (foundational module)
- Produces:
  - `CurrencyCode` (`string`), `CurrencyMetadata` (`{ code: string; name: string; symbol: string; decimals: 0 | 2 | 3 }`)
  - `getCurrency(code: string): CurrencyMetadata`
  - `parseMajorToMinor(majorInput: string, currencyCode: string): bigint`
  - `formatMinorToMajor(minorAmount: bigint, currencyCode: string, includeSymbol?: boolean): string`
  - `convertMinorAmountWithFx(params: { originalMinor: bigint; fromCurrency: string; toCurrency: string; fxRateScaled: bigint; fxStatus: 'identity' | 'live' | 'cached_offline' | 'manual'; dateIso: string }): { convertedMinor: bigint; fxAuditNote: string | null }`
  - `parseFxRateToScaled(rateDecimal: string): bigint` (`1.0` $\to$ `100000000n`)

- [x] **Step 1: Initialize project configuration and write the failing money & FX tests**

Create `wise-spliter/package.json`, `wise-spliter/tsconfig.json`, `wise-spliter/vite.config.ts`, and `wise-spliter/tests/unit/money.test.ts`:

```ts
// wise-spliter/tests/unit/money.test.ts
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { getCurrency, SUPPORTED_CURRENCIES } from '../../src/domain/money/currencies';
import { formatMinorToMajor, parseMajorToMinor } from '../../src/domain/money/minor-units';
import { convertMinorAmountWithFx, parseFxRateToScaled } from '../../src/domain/money/fx-converter';

describe('ISO-4217 Currencies & Minor-Unit BigInt Math', () => {
  it('supports 170+ currencies across 0, 2, and 3 decimal exponents', () => {
    expect(Object.keys(SUPPORTED_CURRENCIES).length).toBeGreaterThanOrEqual(170);
    expect(getCurrency('JPY').decimals).toBe(0);
    expect(getCurrency('INR').decimals).toBe(2);
    expect(getCurrency('USD').decimals).toBe(2);
    expect(getCurrency('KWD').decimals).toBe(3);
  });

  it('parses and formats 0, 2, and 3 decimal currencies without floating-point drift', () => {
    expect(parseMajorToMinor('1250', 'JPY')).toBe(1250n);
    expect(formatMinorToMajor(1250n, 'JPY', true)).toBe('¥1,250');

    expect(parseMajorToMinor('10.50', 'INR')).toBe(1050n);
    expect(parseMajorToMinor('0.1', 'INR') + parseMajorToMinor('0.2', 'INR')).toBe(30n);
    expect(formatMinorToMajor(1050n, 'INR', true)).toBe('₹10.50');

    expect(parseMajorToMajorRoundtrip('15.750', 'KWD')).toBe('15.750');
  });

  it('converts foreign currency to group base currency and builds Splitwise FX audit note', () => {
    const rateScaled = parseFxRateToScaled('91.20'); // 1 EUR = 91.20 INR
    expect(rateScaled).toBe(9120000000n);

    const res = convertMinorAmountWithFx({
      originalMinor: 5000n, // €50.00
      fromCurrency: 'EUR',
      toCurrency: 'INR',
      fxRateScaled: rateScaled,
      fxStatus: 'live',
      dateIso: '2026-11-11',
    });

    expect(res.convertedMinor).toBe(456000n); // ₹4,560.00 in paise
    expect(res.fxAuditNote).toBe(
      'Converted from €50.00 EUR at 1 EUR = 91.20 INR (live rate, 2026-11-11)'
    );
  });

  it('satisfies roundtrip property for all arbitrary bigint minor amounts', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -100000000000n, max: 100000000000n }),
        fc.constantFrom('JPY', 'INR', 'USD', 'EUR', 'KWD', 'BHD'),
        (minor, code) => {
          const formatted = formatMinorToMajor(minor, code, false);
          expect(parseMajorToMinor(formatted, code)).toBe(minor);
        }
      ),
      { numRuns: 500 }
    );
  });
});

function parseMajorToMajorRoundtrip(val: string, code: string): string {
  return formatMinorToMajor(parseMajorToMinor(val, code), code, false);
}
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd /home/chetan/projects/wise-spliter && bun test tests/unit/money.test.ts`
Expected: FAIL with module not found `../../src/domain/money/currencies`.

- [x] **Step 3: Implement `currencies.ts`, `minor-units.ts`, and `fx-converter.ts`**

Implement the 170+ ISO-4217 currency registry (`0 | 2 | 3` decimals), exact string-based `parseMajorToMinor` / `formatMinorToMajor` using `bigint` arithmetic (no `parseFloat`), and `convertMinorAmountWithFx` with half-away-from-zero integer rounding and Splitwise-style FX audit note generation.

- [x] **Step 4: Run test to verify it passes**

Run: `cd /home/chetan/projects/wise-spliter && bun test tests/unit/money.test.ts`
Expected: PASS (all unit and property tests green).

- [x] **Step 5: Commit**

```bash
git add package.json tsconfig.json vite.config.ts src/domain/money/ tests/unit/money.test.ts
git commit -m "feat(money): add ISO-4217 170+ currency minor-unit BigInt engine and FX converter"
```

---

### Task 2: The 5 Split Modes, Stateless Deterministic Rotating Remainder & Strict Invariant Validator (✅ Completed)

**Files:**
- Create: `wise-spliter/src/domain/splits/rotating-remainder.ts`
- Create: `wise-spliter/src/domain/splits/split-calculator.ts`
- Create: `wise-spliter/src/domain/splits/invariant-validator.ts`
- Test: `wise-spliter/tests/unit/splits.test.ts`

**Interfaces:**
- Consumes: `src/domain/money/minor-units.ts`
- Produces:
  - `SplitMode`: `'equal' | 'exact' | 'percentage' | 'shares' | 'adjustment'`
  - `SplitParticipantInput`: `{ memberId: string; memberOrder: number; included: boolean; rawInputValue?: bigint }`
  - `CalculatedSplitShare`: `{ memberId: string; included: boolean; owedMinor: bigint; originalOwedMinor: bigint; rawInputValue: bigint; remainderMinor: bigint }`
  - `PayerEntry`: `{ memberId: string; paidMinor: bigint; originalPaidMinor: bigint }`
  - `calculateSplits(params: { totalMinor: bigint; originalTotalMinor: bigint; splitMode: SplitMode; rotationSeed: number; participants: SplitParticipantInput[] }): CalculatedSplitShare[]`
  - `validateExpenseInvariants(params: { amountMinor: bigint; payers: PayerEntry[]; splits: CalculatedSplitShare[] }): { valid: boolean; errors: string[]; unallocatedPayerMinor: bigint; unallocatedSplitMinor: bigint }`

- [x] **Step 1: Write the failing unit & property-based tests for all 5 split modes and rotating remainders**

```ts
// wise-spliter/tests/unit/splits.test.ts
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { calculateSplits } from '../../src/domain/splits/split-calculator';
import { validateExpenseInvariants } from '../../src/domain/splits/invariant-validator';

describe('5 Split Modes & Stateless Deterministic Rotating Remainder', () => {
  const threeMembers = [
    { memberId: 'm1', memberOrder: 0, included: true },
    { memberId: 'm2', memberOrder: 1, included: true },
    { memberId: 'm3', memberOrder: 2, included: true },
  ];

  it('rotates the leftover 1 paisa fairly across 3 consecutive ₹10.00 equal bills', () => {
    const bill0 = calculateSplits({
      totalMinor: 1000n,
      originalTotalMinor: 1000n,
      splitMode: 'equal',
      rotationSeed: 0,
      participants: threeMembers,
    });
    const bill1 = calculateSplits({
      totalMinor: 1000n,
      originalTotalMinor: 1000n,
      splitMode: 'equal',
      rotationSeed: 1,
      participants: threeMembers,
    });
    const bill2 = calculateSplits({
      totalMinor: 1000n,
      originalTotalMinor: 1000n,
      splitMode: 'equal',
      rotationSeed: 2,
      participants: threeMembers,
    });

    expect(bill0.map((s) => s.owedMinor)).toEqual([334n, 333n, 333n]);
    expect(bill1.map((s) => s.owedMinor)).toEqual([333n, 334n, 333n]);
    expect(bill2.map((s) => s.owedMinor)).toEqual([333n, 333n, 334n]);

    // Total across 3 bills is 1000n per person (exact fairness)
    const totals = [0, 1, 2].map(
      (i) => bill0[i]!.owedMinor + bill1[i]!.owedMinor + bill2[i]!.owedMinor
    );
    expect(totals).toEqual([1000n, 1000n, 1000n]);
  });

  it('calculates shares, percentage (basis points), exact, and +/- adjustment splits accurately', () => {
    // Shares: 2:1:1 on ₹100.00 (10000 paise) -> 5000, 2500, 2500
    const sharesRes = calculateSplits({
      totalMinor: 10000n,
      originalTotalMinor: 10000n,
      splitMode: 'shares',
      rotationSeed: 0,
      participants: [
        { memberId: 'm1', memberOrder: 0, included: true, rawInputValue: 2n },
        { memberId: 'm2', memberOrder: 1, included: true, rawInputValue: 1n },
        { memberId: 'm3', memberOrder: 2, included: true, rawInputValue: 1n },
      ],
    });
    expect(sharesRes.map((s) => s.owedMinor)).toEqual([5000n, 2500n, 2500n]);

    // Percentage: 33.33% (3333 bps), 33.33% (3333 bps), 33.34% (3334 bps) on ₹10.00 (1000 paise)
    const pctRes = calculateSplits({
      totalMinor: 1000n,
      originalTotalMinor: 1000n,
      splitMode: 'percentage',
      rotationSeed: 0,
      participants: [
        { memberId: 'm1', memberOrder: 0, included: true, rawInputValue: 3333n },
        { memberId: 'm2', memberOrder: 1, included: true, rawInputValue: 3333n },
        { memberId: 'm3', memberOrder: 2, included: true, rawInputValue: 3334n },
      ],
    });
    expect(pctRes.reduce((acc, s) => acc + s.owedMinor, 0n)).toBe(1000n);
    expect(pctRes[2]!.owedMinor).toBe(334n);

    // Adjustment: m1 had +₹200 extra drink on ₹1,100 bill -> remaining ₹900 split 3 ways (300 each) -> 500, 300, 300
    const adjRes = calculateSplits({
      totalMinor: 110000n,
      originalTotalMinor: 110000n,
      splitMode: 'adjustment',
      rotationSeed: 0,
      participants: [
        { memberId: 'm1', memberOrder: 0, included: true, rawInputValue: 20000n },
        { memberId: 'm2', memberOrder: 1, included: true, rawInputValue: 0n },
        { memberId: 'm3', memberOrder: 2, included: true, rawInputValue: 0n },
      ],
    });
    expect(adjRes.map((s) => s.owedMinor)).toEqual([50000n, 30000n, 30000n]);
  });

  it('rejects expenses when payers or splits do not reconcile to 100% of total', () => {
    const splits = calculateSplits({
      totalMinor: 1000n,
      originalTotalMinor: 1000n,
      splitMode: 'equal',
      rotationSeed: 0,
      participants: threeMembers,
    });
    const badCheck = validateExpenseInvariants({
      amountMinor: 1000n,
      payers: [{ memberId: 'm1', paidMinor: 900n, originalPaidMinor: 900n }],
      splits,
    });
    expect(badCheck.valid).toBe(false);
    expect(badCheck.unallocatedPayerMinor).toBe(100n);
  });

  it('property: equal and shares splits always sum to totalMinor for any amount and group size', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 1000000000n }),
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 0, max: 500 }),
        (totalMinor, count, seed) => {
          const participants = Array.from({ length: count }, (_, i) => ({
            memberId: `m${i}`,
            memberOrder: i,
            included: true,
            rawInputValue: BigInt((i % 5) + 1),
          }));
          const equalSplits = calculateSplits({
            totalMinor,
            originalTotalMinor: totalMinor,
            splitMode: 'equal',
            rotationSeed: seed,
            participants,
          });
          const shareSplits = calculateSplits({
            totalMinor,
            originalTotalMinor: totalMinor,
            splitMode: 'shares',
            rotationSeed: seed,
            participants,
          });
          expect(equalSplits.reduce((a, b) => a + b.owedMinor, 0n)).toBe(totalMinor);
          expect(shareSplits.reduce((a, b) => a + b.owedMinor, 0n)).toBe(totalMinor);
        }
      ),
      { numRuns: 1000 }
    );
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd /home/chetan/projects/wise-spliter && bun test tests/unit/splits.test.ts`
Expected: FAIL with module not found `../../src/domain/splits/split-calculator`.

- [x] **Step 3: Implement `rotating-remainder.ts`, `split-calculator.ts`, and `invariant-validator.ts`**

Implement Hamilton's Largest Remainder method with deterministic rotation tie-breaking `(memberIndex - (rotationSeed % k) + k) % k` and strict reconciliation validation.

- [x] **Step 4: Run test to verify it passes**

Run: `cd /home/chetan/projects/wise-spliter && bun test tests/unit/splits.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/domain/splits/ tests/unit/splits.test.ts
git commit -m "feat(splits): implement 5 split modes, stateless rotating remainder, and invariant validator"
```

---

### Task 3: Group Balance Engine, Raw vs. Bitmask-DP Debt Simplifier, Cross-Group Ledger & "Explain This Balance" (✅ Completed)

**Files:**
- Create: `wise-spliter/src/domain/ledger/ledger-engine.ts`
- Create: `wise-spliter/src/domain/ledger/types.ts`
- Create: `wise-spliter/src/domain/ledger/group-balances.ts`
- Create: `wise-spliter/src/domain/ledger/debt-simplifier.ts`
- Create: `wise-spliter/src/domain/ledger/explain-balance.ts`
- Create: `wise-spliter/src/domain/ledger/cross-group-ledger.ts`
- Test: `wise-spliter/tests/unit/ledger.test.ts`

**Interfaces:**
- Consumes: `src/domain/splits/split-calculator.ts`
- Produces:
  - `computeGroupNetBalances(expenses: LedgerExpense[], settlements: LedgerSettlement[], memberIds: string[]): Map<string, bigint>`
  - `computeRawPairwiseTransfers(expenses: LedgerExpense[], settlements: LedgerSettlement[], memberIds: string[]): SuggestedTransfer[]`
  - `simplifyGroupDebts(netBalances: Map<string, bigint>): SuggestedTransfer[]`
  - `explainMemberBalance(memberId: string, expenses: LedgerExpense[], settlements: LedgerSettlement[], memberNames: Record<string, string>, simplify: boolean): BalanceExplanation`
  - `computeCrossGroupFriendSummary(currentUserId: string, groups: CrossGroupInput[]): Map<string, FriendCrossGroupBalance>`
  - `buildCrossGroupSettlementBatch(friendBalance: FriendCrossGroupBalance, batchId: string, dateIso: string): LedgerSettlement[]`

- [x] **Step 1: Write the failing unit & property tests for raw vs. simplified debts, Bitmask-DP optimality, explain-balance, and cross-group settlement batches**

```ts
// wise-spliter/tests/unit/ledger.test.ts
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  computeGroupNetBalances,
  computeRawPairwiseTransfers,
} from '../../src/domain/ledger/group-balances';
import { simplifyGroupDebts } from '../../src/domain/ledger/debt-simplifier';
import { explainMemberBalance } from '../../src/domain/ledger/explain-balance';
import {
  buildCrossGroupSettlementBatch,
  computeCrossGroupFriendSummary,
} from '../../src/domain/ledger/cross-group-ledger';

describe('Group Ledger, Bitmask-DP Simplifier & Explain Balance', () => {
  it('collapses transitive debt A -> B -> C into a single transfer A -> C when simplified', () => {
    const expenses = [
      {
        id: 'e1',
        title: 'Dinner',
        expenseDate: '2026-11-10',
        amountMinor: 10000n,
        payers: [{ memberId: 'B', paidMinor: 10000n, originalPaidMinor: 10000n }],
        splits: [
          { memberId: 'A', included: true, owedMinor: 10000n, originalOwedMinor: 10000n, rawInputValue: 1n, remainderMinor: 0n },
        ],
      },
      {
        id: 'e2',
        title: 'Cab',
        expenseDate: '2026-11-11',
        amountMinor: 10000n,
        payers: [{ memberId: 'C', paidMinor: 10000n, originalPaidMinor: 10000n }],
        splits: [
          { memberId: 'B', included: true, owedMinor: 10000n, originalOwedMinor: 10000n, rawInputValue: 1n, remainderMinor: 0n },
        ],
      },
    ];

    const raw = computeRawPairwiseTransfers(expenses, [], ['A', 'B', 'C']);
    expect(raw).toEqual([
      { fromMemberId: 'A', toMemberId: 'B', amountMinor: 10000n },
      { fromMemberId: 'B', toMemberId: 'C', amountMinor: 10000n },
    ]);

    const nets = computeGroupNetBalances(expenses, [], ['A', 'B', 'C']);
    const simplified = simplifyGroupDebts(nets);
    expect(simplified).toEqual([{ fromMemberId: 'A', toMemberId: 'C', amountMinor: 10000n }]);
  });

  it('finds strictly fewer transfers with Bitmask-DP than greedy when disjoint zero-sum subsets exist', () => {
    // Classic counterexample where naive Max-Creditor/Max-Debtor greedy uses 4 transfers, but Bitmask-DP uses 3:
    // Creditors: C1 = +10, C2 = +9
    // Debtors: D1 = -7, D2 = -6, D3 = -6
    // Notice {C1(+10), C2(+9), D1(-7), D2(-6), D3(-6)} vs disjoint subsets:
    // Better counterexample: C1=+7, C2=+8, D1=-5, D2=-5, D3=-5 -> 4 transfers
    // Disjoint zero-sum subsets example:
    // Subset 1: A=+6, B=-6 (1 transfer)
    // Subset 2: C=+10, D=-5, E=-5 (2 transfers) -> Total = 3 transfers!
    const balances = new Map<string, bigint>([
      ['A', 600n],
      ['B', -600n],
      ['C', 1000n],
      ['D', -500n],
      ['E', -500n],
    ]);
    const transfers = simplifyGroupDebts(balances);
    expect(transfers.length).toBe(3);
  });

  it('explains a member balance with exact arithmetic breakdown and contributing bills', () => {
    const expenses = [
      {
        id: 'e1',
        title: 'Hotel',
        expenseDate: '2026-11-10',
        amountMinor: 20000n,
        payers: [{ memberId: 'A', paidMinor: 20000n, originalPaidMinor: 20000n }],
        splits: [
          { memberId: 'A', included: true, owedMinor: 10000n, originalOwedMinor: 10000n, rawInputValue: 1n, remainderMinor: 0n },
          { memberId: 'B', included: true, owedMinor: 10000n, originalOwedMinor: 10000n, rawInputValue: 1n, remainderMinor: 0n },
        ],
      },
    ];
    const settlements = [
      { id: 's1', fromMemberId: 'B', toMemberId: 'A', amountMinor: 4000n, settledDate: '2026-11-11' },
    ];
    const exp = explainMemberBalance('A', expenses, settlements, { A: 'Chetan', B: 'Rahul' }, true);
    expect(exp.totalPaidMinor).toBe(20000n);
    expect(exp.totalShareMinor).toBe(10000n);
    expect(exp.settlementsReceivedMinor).toBe(4000n);
    expect(exp.netBalanceMinor).toBe(6000n);
    expect(exp.lineItems.length).toBe(2);
  });

  it('computes cross-group net balance and generates atomic offsetting settlement batches per group', () => {
    const summary = computeCrossGroupFriendSummary('u_chetan', [
      {
        groupId: 'g_flat',
        groupName: 'Flat 402',
        currency: 'INR',
        myMemberId: 'm_c1',
        members: [
          { memberId: 'm_c1', userId: 'u_chetan', email: 'c@test.com', name: 'Chetan' },
          { memberId: 'm_r1', userId: 'u_rahul', email: 'r@test.com', name: 'Rahul' },
        ],
        pairwiseTransfers: [{ fromMemberId: 'm_r1', toMemberId: 'm_c1', amountMinor: 100000n }], // Rahul owes Chetan ₹1,000
      },
      {
        groupId: 'g_goa',
        groupName: 'Goa Trip',
        currency: 'INR',
        myMemberId: 'm_c2',
        members: [
          { memberId: 'm_c2', userId: 'u_chetan', email: 'c@test.com', name: 'Chetan' },
          { memberId: 'm_r2', userId: 'u_rahul', email: 'r@test.com', name: 'Rahul' },
        ],
        pairwiseTransfers: [{ fromMemberId: 'm_c2', toMemberId: 'm_r2', amountMinor: 40000n }], // Chetan owes Rahul ₹400
      },
    ]);

    const rahul = summary.get('u_rahul')!;
    expect(rahul.netByCurrency.get('INR')).toBe(60000n); // Net: Rahul owes Chetan ₹600
    const batch = buildCrossGroupSettlementBatch(rahul, 'batch-1', '2026-11-11');
    expect(batch).toHaveLength(2);
    expect(batch[0]).toMatchObject({ groupId: 'g_flat', fromMemberId: 'm_r1', toMemberId: 'm_c1', amountMinor: 100000n });
    expect(batch[1]).toMatchObject({ groupId: 'g_goa', fromMemberId: 'm_c2', toMemberId: 'm_r2', amountMinor: 40000n });
  });

  it('property: applying simplified transfers always zeroes out every member net balance', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            payerIdx: fc.integer({ min: 0, max: 6 }),
            amount: fc.bigInt({ min: 10n, max: 500000n }),
          }),
          { minLength: 1, maxLength: 15 }
        ),
        (rawBills) => {
          const members = ['m0', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6'];
          const expenses = rawBills.map((b, idx) => ({
            id: `e${idx}`,
            title: `Bill ${idx}`,
            expenseDate: '2026-11-11',
            amountMinor: b.amount * 7n,
            payers: [{ memberId: `m${b.payerIdx}`, paidMinor: b.amount * 7n, originalPaidMinor: b.amount * 7n }],
            splits: members.map((m) => ({
              memberId: m,
              included: true,
              owedMinor: b.amount,
              originalOwedMinor: b.amount,
              rawInputValue: 1n,
              remainderMinor: 0n,
            })),
          }));
          const nets = computeGroupNetBalances(expenses, [], members);
          let sum = 0n;
          for (const v of nets.values()) sum += v;
          expect(sum).toBe(0n);

          const simplified = simplifyGroupDebts(nets);
          const afterSettlement = computeGroupNetBalances(
            expenses,
            simplified.map((t, i) => ({
              id: `s${i}`,
              fromMemberId: t.fromMemberId,
              toMemberId: t.toMemberId,
              amountMinor: t.amountMinor,
              settledDate: '2026-11-11',
            })),
            members
          );
          for (const v of afterSettlement.values()) {
            expect(v).toBe(0n);
          }
        }
      ),
      { numRuns: 300 }
    );
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd /home/chetan/projects/wise-spliter && bun test tests/unit/ledger.test.ts`
Expected: FAIL with module not found.

- [x] **Step 3: Implement `group-balances.ts`, `debt-simplifier.ts`, `explain-balance.ts`, and `cross-group-ledger.ts`**

Implement the exact balance conservation formulas, Bitmask-DP zero-sum subset partition solver (`n <= 16`) with greedy fallback (`n > 16`), lineage provenance builder, and cross-group atomic settlement batch generator.

- [x] **Step 4: Run test to verify it passes**

Run: `cd /home/chetan/projects/wise-spliter && bun test tests/unit/ledger.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/domain/ledger/ tests/unit/ledger.test.ts
git commit -m "feat(ledger): add group balance engine, Bitmask-DP debt simplifier, explain-balance, and cross-group settlements"
```

---

### Task 4: HLC Clock, Atomic Revision Diff Generator & Concurrent Offline Conflict Resolver (✅ Completed)

**Files:**
- Create: `wise-spliter/src/domain/sync/hlc.ts`
- Create: `wise-spliter/src/domain/sync/revision-diff.ts`
- Create: `wise-spliter/src/domain/sync/atomic-conflict-resolver.ts`
- Test: `wise-spliter/tests/unit/sync-conflict.test.ts`

**Interfaces:**
- Consumes: `src/domain/money/minor-units.ts`, `src/domain/ledger/types.ts`
- Produces:
  - `HybridLogicalClock`: `{ now(wallMs?: number): string; receive(remoteHlc: string, wallMs?: number): string; compare(a: string, b: string): number }`
  - `computeExpenseRevisionDiff(prev: ExpenseSnapshot | null, next: ExpenseSnapshot, memberNames: Record<string, string>): { changes: RevisionChangeItem[]; summaryText: string }`
  - `resolveIncomingExpenseRevision(current: ExpenseRecord, incoming: IncomingExpenseMutation): ConflictResolutionResult`

- [x] **Step 1: Write the failing tests for HLC monotonicity, structured diff generation, and atomic offline conflict flagging**

```ts
// wise-spliter/tests/unit/sync-conflict.test.ts
import { describe, expect, it } from 'vitest';
import { createHlcClock } from '../../src/domain/sync/hlc';
import { computeExpenseRevisionDiff } from '../../src/domain/sync/revision-diff';
import { resolveIncomingExpenseRevision } from '../../src/domain/sync/atomic-conflict-resolver';

describe('HLC, Revision Diff & Atomic Offline Conflict Resolver', () => {
  it('generates strictly monotonic HLC timestamps across local ticks and remote events', () => {
    const clockA = createHlcClock('nodeA');
    const t1 = clockA.now(1700000000000);
    const t2 = clockA.now(1700000000000); // same millisecond
    expect(t2 > t1).toBe(true);

    // Remote clock is ahead by 5 seconds
    const remoteClock = createHlcClock('nodeB');
    const remoteHlc = remoteClock.now(1700000005000);
    const t3 = clockA.receive(remoteHlc, 1700000001000);
    expect(t3 > remoteHlc).toBe(true);
  });

  it('generates human-readable group activity summary and structured field diffs when an expense is edited', () => {
    const prev = {
      id: 'e1',
      title: 'Beach Dinner',
      category: 'food',
      expenseDate: '2026-11-11',
      amountMinor: 100000n,
      groupCurrency: 'INR',
      originalAmountMinor: 100000n,
      originalCurrency: 'INR',
      splitMode: 'equal' as const,
      payers: [{ memberId: 'm1', paidMinor: 100000n, originalPaidMinor: 100000n }],
      splits: [
        { memberId: 'm1', included: true, owedMinor: 50000n, originalOwedMinor: 50000n, rawInputValue: 1n, remainderMinor: 0n },
        { memberId: 'm2', included: true, owedMinor: 50000n, originalOwedMinor: 50000n, rawInputValue: 1n, remainderMinor: 0n },
      ],
    };
    const next = {
      ...prev,
      amountMinor: 120000n,
      originalAmountMinor: 120000n,
      payers: [{ memberId: 'm1', paidMinor: 120000n, originalPaidMinor: 120000n }],
      splits: [
        { memberId: 'm1', included: true, owedMinor: 60000n, originalOwedMinor: 60000n, rawInputValue: 1n, remainderMinor: 0n },
        { memberId: 'm2', included: true, owedMinor: 60000n, originalOwedMinor: 60000n, rawInputValue: 1n, remainderMinor: 0n },
      ],
    };

    const diff = computeExpenseRevisionDiff(prev, next, { m1: 'Chetan', m2: 'Rahul' }, 'Chetan');
    expect(diff.summaryText).toContain('Chetan updated "Beach Dinner"');
    expect(diff.summaryText).toContain('₹1,000.00 → ₹1,200.00');
    expect(diff.changes.some((c) => c.field === 'amount_minor')).toBe(true);
  });

  it('flags hasUnresolvedConflict=true and preserves both snapshots when two users edit the same baseRevisionId offline', () => {
    const currentOnServer = {
      id: 'e1',
      currentRevisionId: 'rev-2-rahul',
      revisionNumber: 2,
      hlc: '019a73e4c210-0001-nodeRahul',
      hasUnresolvedConflict: false,
      conflictRevisionId: null,
      snapshot: { title: 'Dinner (Rahul Edit)', amountMinor: 150000n },
    };

    const incomingFromChetanOffline = {
      expenseId: 'e1',
      newRevisionId: 'rev-2-chetan',
      baseRevisionId: 'rev-1-initial', // Mismatch! Rahul already moved rev-1 -> rev-2
      hlc: '019a73e4c500-0001-nodeChetan', // Chetan edited slightly later
      actorName: 'Chetan',
      snapshot: { title: 'Dinner (Chetan Edit)', amountMinor: 200000n },
    };

    const resolution = resolveIncomingExpenseRevision(currentOnServer, incomingFromChetanOffline);
    expect(resolution.conflictDetected).toBe(true);
    expect(resolution.updatedExpense.hasUnresolvedConflict).toBe(true);
    expect(resolution.updatedExpense.currentRevisionId).toBe('rev-2-chetan');
    expect(resolution.updatedExpense.conflictRevisionId).toBe('rev-2-rahul');
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd /home/chetan/projects/wise-spliter && bun test tests/unit/sync-conflict.test.ts`
Expected: FAIL with module not found.

- [x] **Step 3: Implement `hlc.ts`, `revision-diff.ts`, and `atomic-conflict-resolver.ts`**

Implement the 48-bit-ms + 16-bit-counter HLC clock, structured field diff builder (`amount_minor`, `title`, `category`, `payers`, `splits`, `fx_rate_scaled`), and atomic revision conflict detector/resolver.

- [x] **Step 4: Run test to verify it passes**

Run: `cd /home/chetan/projects/wise-spliter && bun test tests/unit/sync-conflict.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/domain/sync/ tests/unit/sync-conflict.test.ts
git commit -m "feat(sync): implement HLC clock, expense revision diff generator, and atomic conflict resolver"
```

---

### Task 5: Local Offline Database (`Dexie.js` + `local_receipt_blobs`), Group Activity Log, Trash Recovery & Centralized Supabase `wise_spliter` SQL Migration (✅ Completed)

**Files:**
- Create: `wise-spliter/supabase/migrations/0001_wise_spliter_schema.sql`
- Create: `wise-spliter/scripts/apply-migration.mjs`
- Create: `wise-spliter/src/storage/local-db.ts`
- Create: `wise-spliter/src/state/LedgerContext.tsx`
- Test: `wise-spliter/tests/unit/local-repository.test.ts`

**Interfaces:**
- Consumes: `src/domain/money/*`, `src/domain/splits/*`, `src/domain/ledger/*`, `src/domain/sync/*`
- Produces:
  - `WiseSpliterLocalDatabase` (Dexie IndexedDB `wise_spliter_local_db` with `groups`, `expenses`, `expenseRevisions`, `settlements`, `groupActivityLog`, `syncOutbox`, `local_receipt_blobs` for offline compressed WebP receipt images, and `kvStore`)
  - Centralized Supabase migration (`SUPABASE_DIR = /home/chetan/projects/my-scripts/setup/dependencies`) creating isolated `wise_spliter` schema, `receipt_attachments` table, private Storage bucket `wise-spliter-receipts`, and RPC functions `wise_spliter.schema_health`, `wise_spliter.push_mutations`, and `wise_spliter.pull_changes`
  - `LedgerRepository` / `LedgerContext`:
    - `createGroup(...)`, `updateGroupCurrency(groupId, newCurrency, mode: 'relabel' | 'reconvert', fxRateScaled?)`, `softDeleteGroup(groupId)`, `restoreGroup(groupId)`
    - `addGroupMember(...)`, `claimMemberByEmailOrInvite(email, userId)`
    - `createExpense(...)` (supporting both group bills and `group_id = null` direct non-group splits with `ad_hoc_participants`), `updateExpense(...)`, `softDeleteExpense(...)`, `restoreExpense(...)`, `resolveExpenseConflict(expenseId, keepRevisionId)`
    - `recordSettlement(...)`, `recordCrossGroupSettlementBatch(...)`
    - `getGroupActivityLog(groupId): Promise<GroupActivityItem[]>`
    - `getExpenseRevisions(expenseId): Promise<ExpenseRevisionItem[]>`

- [x] **Step 1: Write the failing repository tests covering offline CRUD, group activity logging, unclaimed member auto-linking, currency change modes, and trash restore**

```ts
// wise-spliter/tests/unit/local-repository.test.ts
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { createLocalDb } from '../../src/storage/local-db';
import { LedgerRepository } from '../../src/storage/ledger-repository';

describe('Local Offline Dexie Repository & Group Activity Audit Trail', () => {
  let repo: LedgerRepository;

  beforeEach(async () => {
    const db = createLocalDb(`test-db-${ crypto.randomUUID() }`);
    repo = new LedgerRepository(db, {
      userId: 'u_chetan',
      email: 'chetan@gmail.com',
      fullName: 'Chetan',
      nodeId: 'node_chetan',
    });
    await repo.ensureCurrentUserProfile();
  });

  it('creates a group, adds an unclaimed friend by Gmail, logs expenses, records Group Activity History, and auto-links friend on sign-in', async () => {
    const group = await repo.createGroup({
      name: 'Goa Trip',
      category: 'trip',
      baseCurrency: 'INR',
      simplifyDebts: true,
    });

    const rahulMember = await repo.addGroupMember({
      groupId: group.id,
      displayName: 'Rahul',
      invitedEmail: 'rahul@gmail.com',
      upiId: 'rahul@okaxis',
    });
    expect(rahulMember.userId).toBeNull();

    const myMember = await repo.getMyMemberInGroup(group.id);
    const expense = await repo.createExpense({
      groupId: group.id,
      title: 'Scuba Diving',
      category: 'activities',
      expenseDate: '2026-11-11',
      originalCurrency: 'INR',
      originalAmountMinor: 500000n, // ₹5,000.00
      fxRateScaled: 100000000n,
      fxStatus: 'identity',
      splitMode: 'equal',
      payers: [{ memberId: myMember.id, paidMinor: 500000n, originalPaidMinor: 500000n }],
      participants: [
        { memberId: myMember.id, memberOrder: 0, included: true },
        { memberId: rahulMember.id, memberOrder: 1, included: true },
      ],
    });

    // Update the expense and verify both expense_revisions and group_activity_log
    await repo.updateExpense({
      expenseId: expense.id,
      title: 'Scuba Diving + Photos',
      category: 'activities',
      expenseDate: '2026-11-11',
      originalCurrency: 'INR',
      originalAmountMinor: 600000n, // ₹6,000.00
      fxRateScaled: 100000000n,
      fxStatus: 'identity',
      splitMode: 'equal',
      payers: [{ memberId: myMember.id, paidMinor: 600000n, originalPaidMinor: 600000n }],
      participants: [
        { memberId: myMember.id, memberOrder: 0, included: true },
        { memberId: rahulMember.id, memberOrder: 1, included: true },
      ],
    });

    const revisions = await repo.getExpenseRevisions(expense.id);
    expect(revisions).toHaveLength(2);

    const activity = await repo.getGroupActivityLog(group.id);
    expect(activity.some((a) => a.action === 'expense_updated' && a.summaryText.includes('₹5,000.00 → ₹6,000.00'))).toBe(true);

    // Simulate Rahul signing in with Google (rahul@gmail.com) -> auto-claims his member record
    const claimedCount = await repo.claimUnclaimedMembershipsByEmail('rahul@gmail.com', 'u_rahul');
    expect(claimedCount).toBe(1);
    const updatedRahul = await repo.getGroupMember(rahulMember.id);
    expect(updatedRahul?.userId).toBe('u_rahul');
  });

  it('supports soft-delete and 1-tap restore from Trash with full activity logging', async () => {
    const group = await repo.createGroup({ name: 'Flat 402', category: 'home', baseCurrency: 'INR', simplifyDebts: true });
    const me = await repo.getMyMemberInGroup(group.id);
    const exp = await repo.createExpense({
      groupId: group.id,
      title: 'Wi-Fi Bill',
      category: 'utilities',
      expenseDate: '2026-11-11',
      originalCurrency: 'INR',
      originalAmountMinor: 100000n,
      fxRateScaled: 100000000n,
      fxStatus: 'identity',
      splitMode: 'equal',
      payers: [{ memberId: me.id, paidMinor: 100000n, originalPaidMinor: 100000n }],
      participants: [{ memberId: me.id, memberOrder: 0, included: true }],
    });

    await repo.softDeleteExpense(exp.id);
    expect(await repo.listActiveGroupExpenses(group.id)).toHaveLength(0);
    expect(await repo.listTrashedGroupExpenses(group.id)).toHaveLength(1);

    await repo.restoreExpense(exp.id);
    expect(await repo.listActiveGroupExpenses(group.id)).toHaveLength(1);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd /home/chetan/projects/wise-spliter && bun test tests/unit/local-repository.test.ts`
Expected: FAIL with module not found.

- [x] **Step 3: Create `0001_wise_spliter_schema.sql`, `local-db.ts`, and `ledger-repository.ts`**

Write the complete Supabase SQL migration for `wise_spliter` schema (including RPCs `wise_spliter.schema_health`, `wise_spliter.push_mutations`, and `wise_spliter.pull_changes`) and implement `WiseSpliterLocalDatabase` + `LedgerContext` with ACID transactions that update records, store offline compressed WebP receipt images in `local_receipt_blobs`, append `expense_revisions`, append `group_activity_log`, and enqueue `sync_outbox` mutations atomically.

- [x] **Step 4: Run test to verify it passes**

Run: `cd /home/chetan/projects/wise-spliter && bun test tests/unit/local-repository.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add supabase/migrations/0001_wise_spliter_schema.sql src/storage/ tests/unit/local-repository.test.ts
git commit -m "feat(storage): add Dexie local database, group activity log, and Supabase wise_spliter migration"
```

---

### Task 6: Backend API Gatekeeper (`:4174`), Receipt Storage Pipeline (`wise-spliter-receipts`) & Cloud Sync Engine (✅ Completed)

**Files:**
- Create: `wise-spliter/src/server/index.ts`
- Create: `wise-spliter/src/server/supabaseAdmin.ts`
- Create: `wise-spliter/src/sync-engine/supabase-sync.ts`
- Test: `wise-spliter/tests/unit/sync-manager.test.ts`

**Interfaces:**
- Consumes: `src/storage/local-db.ts`, `src/domain/sync/atomic-conflict-resolver.ts`
- Produces:
  - Backend API Gatekeeper (`src/server/index.ts` on `:4174`) holding `SUPABASE_SECRET_KEY` (`service_role`) server-side, enforcing financial conservation invariants, binding `Accept-Profile: wise_spliter` & `Content-Profile: wise_spliter`, and exposing `GET /api/health`, `GET /api/ledger/bootstrap`, `POST /api/ledger/sync`, and `POST /api/receipts/upload`
  - Receipt upload pipeline (`POST /api/receipts/upload` on `:4174`) uploading compressed WebP blobs from `local_receipt_blobs` to private Supabase Storage bucket `wise-spliter-receipts` at `{group_id_or_direct}/{expense_id}/{receipt_id}.webp` and recording metadata in `wise_spliter.receipt_attachments` and `wise_spliter.expenses.receipts`
  - `WiseSpliterCloudSyncEngine` (`src/sync-engine/supabase-sync.ts`) invoking `wise_spliter.push_mutations`, `wise_spliter.pull_changes`, and `wise_spliter.schema_health`

- [x] **Step 1: Write the failing multi-device offline sync & conflict convergence tests**

```ts
// wise-spliter/tests/unit/sync-manager.test.ts
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { createLocalDb } from '../../src/storage/local-db';
import { LedgerRepository } from '../../src/storage/ledger-repository';
import { InMemoryCloudAdapter, SyncManager } from '../../src/sync-engine/sync-manager';

describe('Multi-Device Offline Sync Engine (wise_spliter schema)', () => {
  it('syncs offline expenses between two group members and flags concurrent edits on the same expense without losing history', async () => {
    const cloud = new InMemoryCloudAdapter();

    const dbChetan = createLocalDb(`chetan-${ crypto.randomUUID() }`);
    const repoChetan = new LedgerRepository(dbChetan, {
      userId: 'u_chetan',
      email: 'chetan@gmail.com',
      fullName: 'Chetan',
      nodeId: 'node_c',
    });
    await repoChetan.ensureCurrentUserProfile();
    const syncChetan = new SyncManager(dbChetan, repoChetan, cloud);

    const dbRahul = createLocalDb(`rahul-${ crypto.randomUUID() }`);
    const repoRahul = new LedgerRepository(dbRahul, {
      userId: 'u_rahul',
      email: 'rahul@gmail.com',
      fullName: 'Rahul',
      nodeId: 'node_r',
    });
    await repoRahul.ensureCurrentUserProfile();
    const syncRahul = new SyncManager(dbRahul, repoRahul, cloud);

    // 1. Chetan creates group & adds Rahul by email, then syncs to cloud
    const group = await repoChetan.createGroup({ name: 'Euro Trip', category: 'trip', baseCurrency: 'INR', simplifyDebts: true });
    const rahulMember = await repoChetan.addGroupMember({ groupId: group.id, displayName: 'Rahul', invitedEmail: 'rahul@gmail.com' });
    const chetanMember = await repoChetan.getMyMemberInGroup(group.id);
    const sharedExpense = await repoChetan.createExpense({
      groupId: group.id,
      title: 'Train Tickets',
      category: 'transport',
      expenseDate: '2026-11-11',
      originalCurrency: 'INR',
      originalAmountMinor: 200000n,
      fxRateScaled: 100000000n,
      fxStatus: 'identity',
      splitMode: 'equal',
      payers: [{ memberId: chetanMember.id, paidMinor: 200000n, originalPaidMinor: 200000n }],
      participants: [
        { memberId: chetanMember.id, memberOrder: 0, included: true },
        { memberId: rahulMember.id, memberOrder: 1, included: true },
      ],
    });
    await syncChetan.syncNow();

    // 2. Rahul pulls from cloud -> gets the group and claims his membership
    await syncRahul.syncNow();
    expect(await repoRahul.listActiveGroupExpenses(group.id)).toHaveLength(1);

    // 3. Both go offline and edit the SAME 'Train Tickets' expense concurrently!
    await repoChetan.updateExpense({
      expenseId: sharedExpense.id,
      title: 'Train Tickets (1st Class)',
      category: 'transport',
      expenseDate: '2026-11-11',
      originalCurrency: 'INR',
      originalAmountMinor: 240000n,
      fxRateScaled: 100000000n,
      fxStatus: 'identity',
      splitMode: 'equal',
      payers: [{ memberId: chetanMember.id, paidMinor: 240000n, originalPaidMinor: 240000n }],
      participants: [
        { memberId: chetanMember.id, memberOrder: 0, included: true },
        { memberId: rahulMember.id, memberOrder: 1, included: true },
      ],
    });

    await repoRahul.updateExpense({
      expenseId: sharedExpense.id,
      title: 'Train Tickets + Seat Reservation',
      category: 'transport',
      expenseDate: '2026-11-11',
      originalCurrency: 'INR',
      originalAmountMinor: 260000n,
      fxRateScaled: 100000000n,
      fxStatus: 'identity',
      splitMode: 'equal',
      payers: [{ memberId: chetanMember.id, paidMinor: 260000n, originalPaidMinor: 260000n }],
      participants: [
        { memberId: chetanMember.id, memberOrder: 0, included: true },
        { memberId: rahulMember.id, memberOrder: 1, included: true },
      ],
    });

    // 4. Both reconnect and sync
    await syncChetan.syncNow();
    await syncRahul.syncNow();
    await syncChetan.syncNow();

    // 5. Verify both devices converged to the exact same state AND flagged the conflict with both revisions preserved
    const expOnChetan = await repoChetan.getExpense(sharedExpense.id);
    const expOnRahul = await repoRahul.getExpense(sharedExpense.id);
    expect(expOnChetan?.amountMinor).toBe(expOnRahul?.amountMinor);
    expect(expOnChetan?.hasUnresolvedConflict).toBe(true);
    expect((await repoChetan.getExpenseRevisions(sharedExpense.id)).length).toBeGreaterThanOrEqual(3);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd /home/chetan/projects/wise-spliter && bun test tests/unit/sync-manager.test.ts`
Expected: FAIL with module not found.

- [x] **Step 3: Implement `src/server/index.ts`, `src/server/supabaseAdmin.ts`, and `src/sync-engine/supabase-sync.ts`**

Implement the Backend API Gatekeeper on `:4174`, `POST /api/receipts/upload` to private bucket `wise-spliter-receipts` (`{group_id_or_direct}/{expense_id}/{receipt_id}.webp`), and the sync engine targeting `wise_spliter` (`wise_spliter.schema_health`, `wise_spliter.push_mutations`, `wise_spliter.pull_changes`).

- [x] **Step 4: Run test to verify it passes**

Run: `cd /home/chetan/projects/wise-spliter && bun test tests/unit/sync-manager.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/server/ src/sync-engine/ tests/unit/sync-manager.test.ts
git commit -m "feat(sync-engine): implement offline outbox sync manager and Supabase wise_spliter adapter"
```

---

### Task 7: Portability Suite — Splitwise CSV/JSON Importer, Multi-Sheet `.xlsx` & `.pdf` Exporters, CSV, UPI Links, WhatsApp Summary & Encrypted Backups (✅ Completed)

**Files:**
- Create: `wise-spliter/src/portability/portability-engine.ts`
- Test: `wise-spliter/tests/unit/portability.test.ts`

**Interfaces:**
- Consumes: `src/domain/money/*`, `src/domain/ledger/*`, `src/storage/*`
- Produces:
  - `buildUpiPaymentUri(params: { payeeUpiId: string; payeeName: string; amountMinor: bigint; currency: string; note: string }): string`
  - `generateWhatsAppGroupSummary(params: { groupName: string; currency: string; totalSpendMinor: bigint; netBalances: Array<{ name: string; netMinor: bigint }>; transfers: Array<{ fromName: string; toName: string; toUpiId?: string; amountMinor: bigint }> }): string`
  - `parseSplitwiseCsv(csvText: string): SplitwiseImportResult`
  - `parseSplitwiseJson(jsonText: string): SplitwiseImportResult`
  - `exportGroupToCsv(groupData: ExportGroupBundle): string`
  - `exportGroupToExcelBuffer(groupData: ExportGroupBundle): Uint8Array` (Multi-Sheet `.xlsx`: `Summary`, `Expenses`, `Settlements`, `Member Balances`)
  - `exportGroupToPdfBytes(groupData: ExportGroupBundle): Uint8Array` (Printable `.pdf` statement)
  - `encryptBackupPayload(payloadJson: string, passphrase: string): Promise<string>`
  - `decryptBackupPayload(encryptedBundle: string, passphrase: string): Promise<string>`

- [x] **Step 1: Write the failing tests for Splitwise CSV/JSON import, UPI URI formatting, WhatsApp summary text, CSV/Excel/PDF generation, and AES-256-GCM encrypted backup roundtrip**

```ts
// wise-spliter/tests/unit/portability.test.ts
import { describe, expect, it } from 'vitest';
import { buildUpiPaymentUri } from '../../src/portability/upi-links';
import { generateWhatsAppGroupSummary } from '../../src/portability/whatsapp-summary';
import { parseSplitwiseCsv } from '../../src/portability/splitwise-importer';
import { exportGroupToCsv, exportGroupToExcelBuffer, exportGroupToPdfBytes } from '../../src/portability/exporters';
import { decryptBackupPayload, encryptBackupPayload } from '../../src/portability/encrypted-backup';

describe('Portability, UPI Deep-Links, WhatsApp Summary & AES-256-GCM Backup', () => {
  it('builds a valid NPCI upi://pay deep link with pre-filled amount and receiver', () => {
    const uri = buildUpiPaymentUri({
      payeeUpiId: 'rahul@okicici',
      payeeName: 'Rahul Sharma',
      amountMinor: 125050n,
      currency: 'INR',
      note: 'Goa Trip Settlement',
    });
    expect(uri).toBe(
      'upi://pay?pa=rahul%40okicici&pn=Rahul%20Sharma&am=1250.50&cu=INR&tn=Goa%20Trip%20Settlement'
    );
  });

  it('generates a clean WhatsApp group settlement summary with embedded UPI payment links', () => {
    const text = generateWhatsAppGroupSummary({
      groupName: 'Goa Trip',
      currency: 'INR',
      totalSpendMinor: 1500000n,
      netBalances: [
        { name: 'Chetan', netMinor: 50000n },
        { name: 'Rahul', netMinor: -50000n },
      ],
      transfers: [
        { fromName: 'Rahul', toName: 'Chetan', toUpiId: 'chetan@upi', amountMinor: 50000n },
      ],
    });
    expect(text).toContain('Goa Trip');
    expect(text).toContain('Rahul pays Chetan ₹500.00');
    expect(text).toContain('upi://pay?pa=chetan%40upi');
  });

  it('imports official Splitwise CSV format and reconstructs members, expenses, and shares', () => {
    const sampleCsv = [
      'Date,Description,Category,Cost,Currency,Chetan,Rahul,Aman',
      '2026-11-10,Dinner at Britto,Food and drink,3000.00,INR,2000.00,-1000.00,-1000.00',
      '2026-11-11,Scooter Rental,Transportation,1200.00,INR,-600.00,600.00,0.00',
    ].join('\n');

    const imported = parseSplitwiseCsv(sampleCsv);
    expect(imported.memberNames).toEqual(['Chetan', 'Rahul', 'Aman']);
    expect(imported.expenses).toHaveLength(2);
    expect(imported.expenses[0]!.amountMinor).toBe(300000n);
    expect(imported.expenses[0]!.payers).toEqual([{ memberName: 'Chetan', paidMinor: 300000n }]);
    expect(imported.expenses[0]!.splits.map((s) => s.owedMinor)).toEqual([100000n, 100000n, 100000n]);
  });

  it('exports group data to CSV, Excel (.xlsx), and PDF bytes, and roundtrips AES-256-GCM encrypted backups', async () => {
    const bundle = {
      groupName: 'Goa Trip',
      currency: 'INR',
      expenses: [
        { date: '2026-11-10', title: 'Dinner', category: 'food', amountMinor: 300000n, paidBy: 'Chetan' },
      ],
      settlements: [],
      balances: [
        { memberName: 'Chetan', netMinor: 150000n },
        { memberName: 'Rahul', netMinor: -150000n },
      ],
    };

    const csv = exportGroupToCsv(bundle);
    expect(csv).toContain('Dinner');
    expect(exportGroupToExcelBuffer(bundle).byteLength).toBeGreaterThan(100);
    expect(exportGroupToPdfBytes(bundle).byteLength).toBeGreaterThan(100);

    const rawJson = JSON.stringify({ version: 1, groupName: 'Goa Trip', totalMinor: '300000' });
    const encrypted = await encryptBackupPayload(rawJson, 'strong-secret-passphrase');
    expect(encrypted).not.toContain('Goa Trip');
    const decrypted = await decryptBackupPayload(encrypted, 'strong-secret-passphrase');
    expect(decrypted).toBe(rawJson);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd /home/chetan/projects/wise-spliter && bun test tests/unit/portability.test.ts`
Expected: FAIL with module not found.

- [x] **Step 3: Implement `portability-engine.ts` (`upi-links`, `whatsapp-summary`, `splitwise-importer`, Multi-Sheet `.xlsx` / `.pdf` / `.csv` `exporters`, and `encrypted-backup`)**

Implement all five portability capabilities with zero external server dependencies.

- [x] **Step 4: Run test to verify it passes**

Run: `cd /home/chetan/projects/wise-spliter && bun test tests/unit/portability.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/portability/ tests/unit/portability.test.ts
git commit -m "feat(portability): add Splitwise importer, CSV/Excel/PDF exporters, UPI links, and AES-256-GCM backups"
```

---

### Task 8: Minimalist Home Dashboard (`<= 3` Recent Groups), Modular `ExpenseEditorModal`, Progressive Group Workspace, `HelpGuideModal`, Offline Service Worker (`public/sw.js`) & Playwright E2E Verification (✅ Completed)

**Files:**
- Create: `wise-spliter/index.html`
- Create: `wise-spliter/public/manifest.webmanifest`
- Create: `wise-spliter/public/sw.js`
- Create: `wise-spliter/src/main.tsx`
- Create: `wise-spliter/src/App.tsx`
- Create: `wise-spliter/src/ui/primitives/DesignPrimitives.tsx` (`DoubleBezelCard`, `StatusBadge`, `ContextualPageGuideBanner`)
- Create: `wise-spliter/src/ui/modals/ExpenseEditorModal.tsx`
- Create: `wise-spliter/src/ui/modals/ExplainBalanceModal.tsx`
- Create: `wise-spliter/src/ui/modals/HelpGuideModal.tsx`
- Create: `wise-spliter/src/ui/pages/HomeDashboardPage.tsx`
- Create: `wise-spliter/src/ui/pages/GroupsLedgerPage.tsx`
- Create: `wise-spliter/src/ui/pages/ActivityAndTrashPage.tsx`
- Create: `wise-spliter/src/ui/pages/FriendsAndSettlePage.tsx`
- Create: `wise-spliter/src/ui/pages/AnalyticsAndSearchPage.tsx`
- Create: `wise-spliter/src/ui/pages/PortabilityAndSyncPage.tsx`
- Create: `wise-spliter/playwright.config.ts`
- Test: `wise-spliter/tests/e2e/wise-spliter.spec.ts`

**Interfaces:**
- Consumes: All `src/domain/*`, `src/storage/*`, `src/sync-engine/*`, `src/server/*`, `src/portability/*` modules
- Produces:
  - Complete responsive Desktop + iOS + Android + Web UI with:
    - **Minimalist Home Dashboard (`HomeDashboardPage.tsx`):** Displays at most `<= 3` recently accessed/updated groups via `last_accessed_at` (`GREATEST(last_accessed_at, updated_at) DESC`), personal net balance summary, recent direct non-group splits, and quick actions
    - **Modular `ExpenseEditorModal` (`ExpenseEditorModal.tsx`):** Supports both `group_id = null` direct non-group splits with `ad_hoc_participants` and group-preselected splits across all 5 split modes (`Equal`, `Exact`, `Percentage`, `Shares`, `+/- Adjustment`) + Multiple Payers + Foreign Currency FX Converter + Offline WebP receipt attachments (`local_receipt_blobs` $\to$ `POST /api/receipts/upload` $\to$ `wise-spliter-receipts`)
    - **Progressive Group Workspace (`GroupsLedgerPage.tsx`):** Concise group balance insights, Unclaimed/Claimed Member management, Editable Group Base Currency (`Relabel` vs `FX Re-convert`), Smart Debt Simplification Toggle, and **"Explain This Balance"** Modal (`ExplainBalanceModal.tsx`)
    - **Interactive Help & Guide (`HelpGuideModal.tsx` + `ContextualPageGuideBanner`):** Skippable contextual banners on each view and an interactive multi-step Help & Feature Guide modal
    - **Activity, Revision & Trash Vault (`ActivityAndTrashPage.tsx`):** Group-wide audit feed, per-expense immutable edit history, 1-tap conflict resolution (`[Keep Mine] / [Keep Theirs]`), and Trash recovery
    - **Friends & Settle Studio (`FriendsAndSettlePage.tsx`):** Cross-group net balances, 1-tap atomic multi-group settlement (`batch_settlement_id`), `upi://pay` deep-links + QR modal, and WhatsApp summary export
    - **Analytics & Portability (`AnalyticsAndSearchPage.tsx`, `PortabilityAndSyncPage.tsx`):** Multi-filter search, spending analytics, Splitwise CSV/JSON import, Multi-Sheet `.xlsx` & `.pdf` exports, RFC-4180 `.csv`, and `AES-256-GCM` `.wisesplit` encrypted backups
    - **Offline Service Worker (`public/sw.js`):** Full offline shell and asset caching for flight/travel operation

- [x] **Step 1: Write the Playwright E2E test suite verifying core Phase 1 user journeys**

```ts
// wise-spliter/tests/e2e/wise-spliter.spec.ts
import { expect, test } from '@playwright/test';

test.describe('Wise-Spliter Phase 1 End-to-End Verification', () => {
  test('creates a group, adds friends, logs multi-currency & rotating-remainder expenses, explains balances, views group activity history, and settles up', async ({ page }) => {
    await page.goto('/');

    // 1. Create a new group
    await page.getByTestId('create-group-btn').click();
    await page.getByTestId('group-name-input').fill('Goa Beach Trip');
    await page.getByTestId('group-currency-select').selectOption('INR');
    await page.getByTestId('save-group-btn').click();

    // 2. Add two friends (Rahul and Priya)
    await page.getByTestId('add-member-btn').click();
    await page.getByTestId('member-name-input').fill('Rahul');
    await page.getByTestId('member-email-input').fill('rahul@gmail.com');
    await page.getByTestId('member-upi-input').fill('rahul@okaxis');
    await page.getByTestId('save-member-btn').click();

    await page.getByTestId('add-member-btn').click();
    await page.getByTestId('member-name-input').fill('Priya');
    await page.getByTestId('member-email-input').fill('priya@gmail.com');
    await page.getByTestId('save-member-btn').click();

    // 3. Log a ₹100.00 Equal Split expense across 3 members -> rotating remainder assigns ₹33.34, ₹33.33, ₹33.33
    await page.getByTestId('add-expense-btn').click();
    await page.getByTestId('expense-title-input').fill('Cab from Airport');
    await page.getByTestId('expense-amount-input').fill('100');
    await page.getByTestId('save-expense-btn').click();

    await expect(page.getByText('Cab from Airport')).toBeVisible();
    await expect(page.getByText('₹100.00')).toBeVisible();

    // 4. Open "Explain This Balance" modal and verify mathematical lineage
    await page.getByTestId('explain-balance-btn').first().click();
    await expect(page.getByTestId('explain-balance-modal')).toContainText('Cab from Airport');
    await page.getByTestId('close-explain-modal-btn').click();

    // 5. Open Group Activity & Update History tab and verify transparent audit trail
    await page.getByTestId('tab-activity-history').click();
    await expect(page.getByTestId('activity-feed-list')).toContainText('Cab from Airport');
  });
});
```

- [x] **Step 2: Run E2E test to verify it fails before UI is built**

Run: `cd /home/chetan/projects/wise-spliter && bunx playwright test`
Expected: FAIL (application entry point not yet created).

- [x] **Step 3: Build the responsive React 19 UI components, Offline Service Worker (`public/sw.js`), PWA manifest, and Capacitor config**

Implement `index.html`, `public/sw.js`, `src/main.tsx`, `src/App.tsx`, and all UI pages/modals (`HomeDashboardPage`, `GroupsLedgerPage`, `ActivityAndTrashPage`, `FriendsAndSettlePage`, `AnalyticsAndSearchPage`, `PortabilityAndSyncPage`, `ExpenseEditorModal`, `ExplainBalanceModal`, `HelpGuideModal`, `ContextualPageGuideBanner`) wired to `LedgerContext`, `WiseSpliterCloudSyncEngine`, Backend API Gatekeeper (`:4174`), and `src/portability/`.

- [x] **Step 4: Run unit tests, property tests, production build, and Playwright E2E tests**

Run: `cd /home/chetan/projects/wise-spliter && bun test && bun run build && bunx playwright test`
Expected: PASS (100% unit, property, build, and E2E checks green).

- [x] **Step 5: Commit**

```bash
git add index.html public/ src/ playwright.config.ts tests/e2e/
git commit -m "feat(ui): build multi-platform Wise-Spliter Phase 1 UI, PWA shell, and E2E suite"
```
