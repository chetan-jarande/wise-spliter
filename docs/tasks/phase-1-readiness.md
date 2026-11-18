# Phase 1 Readiness Review

Review date: 2026-11-16. Scope: [feature-requiremrnts.md](../feature-requiremrnts.md) Phase 1, checked against the code at HEAD of `main`.

How this was checked:
- I read the code. Doc claims and test names were not taken as evidence.
- `make test` passes: 5 files, 196 tests.
- `make e2e` was not run, because other agents are editing e2e tests at the same time.
- I ran the app (`make dev-ui`) and checked behaviour with Playwright scripts in `/tmp/ws-review/`.
- I checked the domain functions with a bun script (`/tmp/ws-review/domain-check.ts`).

Every bug marked "verified" below was reproduced, not inferred from reading.

## 0. Verdict

**Phase 1 cannot be concluded yet.**

The core money math is correct:
- BigInt minor units.
- Rotating remainders.
- Split conservation.
- Optimal simplification. I brute-forced 2000 random cases and found 0 non-optimal results.

The server security model is strong.

Four problems block the "done" claim:
- Two silent data-loss paths (P0-1, P1-9).
- One real-money safety bug (P0-3).
- A fake FX layer (P0-4).

There are also 4 multi-user correctness gaps (P1-1 to P1-4), and several Phase 1 requirements are only partly built. In particular:
- Settlement dates.
- Invite links.
- Group delete.
- Monthly charts.
- Search by amount and date.
- Splitwise JSON import.
- Date-range export.

Estimated work to close P0 + P1: about 12 to 16 developer-days.

## 1. Requirement traceability

Status values: Done, Partial, Missing, Diverges (built, but behaves differently from what the requirement says).

| # | Requirement | Status | Evidence (implementation; test) | Notes |
|---|---|---|---|---|
| 1.1 | Google Sign-In (`POST /api/auth/google`) with auto-claim of invited groups | Done | `src/server/index.ts:196-212`, `claim_members` in `supabase/migrations/0004_tenant_isolation_and_sync.sql:1133`. Tests: `tests/unit/security-breach.test.ts:320-325,659,877,987`, `tests/unit/redteam-regression.test.ts:1106,1144` | The real OAuth round trip has no e2e test. The e2e suite only checks that the button exists (`dev-google-oauth-btn`). |
| 1.2 | 1-tap Demo Sandbox (`POST /api/auth/demo`) | Done | `src/server/index.ts:183-194`, `src/ui/modals/DevAuthModal.tsx:78-98`. Test: e2e `wise-spliter.spec.ts:806` | Production is offline-only: the client falls back to the bundled sample data. |
| 1.3 | 100% offline-first local DB with automatic cloud sync | Diverges | The real store is a `localStorage` JSON blob (`src/state/LedgerContext.tsx:261-274,323-341`). Dexie is rewritten on every change but never read back: `loadDatasetFromIndexedDb` (`src/storage/local-db.ts:151`) has no callers. Sync is in `src/sync-engine/sync-client.ts` (60 unit tests). | Three problems:<br>1. Data created before the first sign-in is wiped when you sign in (P0-1, verified).<br>2. The ~5 MB `localStorage` quota error is swallowed (`LedgerContext.tsx:338`), so persistence silently stops on large ledgers.<br>3. The e2e test uses an in-app "offline" toggle. It never takes the browser offline and never boots the service worker offline. |
| 1.4 | Placeholder members by name (+ Gmail/UPI) that auto-link on Google sign-in **or invite link** | Partial | Add by name/email/UPI: `LedgerContext.tsx:1081-1132`, `GroupsLedgerPage.tsx:266-280`. Auto-link by exact email: `claim_members`. Test: e2e Story 3. | Two problems:<br>1. Joining by invite link or code is Missing. The code is shown (`GroupsLedgerPage.tsx:449`) but there is no API route (`src/server/index.ts:176-340`) and no join UI.<br>2. The "Link Google Account" button fakes a claim (P1-6). |
| 1.5 | Unlimited, free, no caps | Done | No UI caps. The server has generous anti-abuse quotas (50k expenses per scope and owner, 500 groups per creator; `database-and-sync-spec.md` section 2.1). | Acceptable. Say "fair-use limits" in public copy. |
| 2.1 | Quick-Add from Home (direct split, `group_id = null`) or group-preselected | Done | `ExpenseEditorModal.tsx:120-190`, `LedgerContext.tsx:1189-1445`. Tests: e2e `:758`, Story 1. | |
| 2.2 | Minimal Home, top-3 recent groups, direct splits | Done | `LedgerContext.tsx:731-746`, `HomeDashboardPage.tsx`. Tests: `domain-and-portability.test.ts:348`, e2e Story 1. | Home totals are always shown in INR at static rates (`HomeDashboardPage.tsx:300-316`). |
| 2.3 | Help modal + contextual page guide | Done | `HelpGuideModal.tsx`, `DesignPrimitives.tsx`. Test: e2e Story 1 (`help-guide-modal`, `contextual-page-guide`). | |
| 2.4 | Split modes: equal (one-tap exclude), exact, %, shares, +/- adjustment | Done | `src/domain/splits/split-calculator.ts:70-210`. Tests: `math-engine-scenarios.test.ts:277-505,1251` (fast-check). | Shares are rounded to whole numbers (`ExpenseEditorModal.tsx:635`), so 1.5 becomes 2 without telling the user (P2). |
| 2.5 | Multiple payers | Done | `ExpenseEditorModal.tsx:674-706`. Tests: `math-engine-scenarios.test.ts:599`, e2e `multi-payer-toggle`. | |
| 2.6 | Saved default splits | Done | One preset per group: `LedgerContext.tsx:1177-1187`, `ExpenseEditorModal.tsx:597-625,801-814`. | Untested: no unit or e2e test saves or applies a preset. |
| 2.7 | BigInt minor units, rotating remainder frozen at creation | Partial | Math is Done: `split-calculator.ts:26-68`. Tests: property 2 at `math-engine-scenarios.test.ts:1339`. | The rotation seed comes from the group's `expenseSeq`. The client increments it but never pushes it, because group diffs are keyed on `hlc` (`sync-client.ts:117-121`, `LedgerContext.tsx:1431`). So two members' devices reuse the same seeds and remainder fairness breaks across users (P2). |
| 2.8 | Strict split validation blocks save | Done | `validateExpenseInvariants` `split-calculator.ts:212-306`, save button disabled `ExpenseEditorModal.tsx:1760`, server re-validates in `src/server/syncRows.ts`. Test: e2e `split-reconciliation-bar`. | |
| 3.1 | Per-group simplification toggle (never across groups) | Done | `ledger-engine.ts:260-341` (DP for n<=16, greedy above). Tests: `math-engine-scenarios.test.ts:678,1376`, e2e `toggle-simplify-debts-btn`. | My brute-force check: 2000 random cases, all zeroed, all at the optimal transfer count. |
| 3.2 | Cross-group friend net + one-tap atomic multi-group settle | Partial | `ledger-engine.ts:492-719`, `LedgerContext.tsx:1868-1912`, `src/utils/direct-settlements.ts`. Test: e2e Story 5, `:758`. | Three problems:<br>1. Not atomic: each settlement is a separate mutation in its own subtransaction (`0004:958-1020`).<br>2. Friends are matched by email, else by display name, so two different "Rahul" placeholders merge into one friend (verified, `ledger-engine.ts:551,633`).<br>3. Direct balances can only be settled in full (P1-8). |
| 3.3 | "Explain this balance" on any balance or suggested repayment | Partial | `ExplainBalanceModal.tsx`, `ledger-engine.ts:343-453`. Test: e2e Story 2. | The only entry point is the group roster (`GroupsLedgerPage.tsx:1039`). It is not reachable from suggested repayments, Home, Friends, or direct bills. |
| 4.1 | UPI / payment deep links (GPay, PhonePe, Paytm, Venmo) prefilled | Partial | `portability-engine.ts:97-117`, `FriendsAndSettlePage.tsx:250-275,1321-1350`. Test: e2e `upi-uri-text`. | Three problems:<br>1. If the payee has no UPI id, the link pays the payer's own VPA or a demo VPA (P0-3).<br>2. There is no Venmo deep link, only a label.<br>3. All three buttons fire the same generic `upi://pay`, and launching only happens on mobile user agents (`native-platform.ts:56-66`). |
| 4.2 | Partial and full payments with custom dates and notes | Partial | `recordSettlement` `LedgerContext.tsx:1711-1795`. | Four problems:<br>1. The UI has no date input: `settledDate` is never passed from `FriendsAndSettlePage.tsx:397`.<br>2. Group settlements cannot be edited or deleted. `deleteSettlement` is only wired for direct-bill payments (`HomeDashboardPage.tsx:759`).<br>3. Recording with an empty amount falls back to the suggested amount or ₹500 (`FriendsAndSettlePage.tsx:393-395`).<br>4. A fake `UTR...` reference is stored (`:406`). |
| 4.3 | WhatsApp text or image summary with UPI links | Partial | `generateWhatsAppGroupSummary` `portability-engine.ts:119`, `wa.me` link `FriendsAndSettlePage.tsx:902`. Test: e2e Story 5. | Text: Done. Image card: only an on-screen preview, with no PNG export or share. |
| 5.1 | 160+ currencies with 0/2/3 decimals | Partial | `src/domain/money/currencies.ts:6-79`. Test: `domain-and-portability.test.ts:57`. | There are 175 entries, but 8 are not 3-letter codes (`ZWGOLD, ABKHAZ, ARTSAKH, SOMALILAND, COOKISLANDS, NIUE, PITCAIRN, SAHRAWI`, from `:53-59`). The picker offers them and the server rejects them (`syncRows.ts:89`), so those bills never sync. Several other entries are not ISO 4217 either (SPL, PRB, KID, TVD, FOK). |
| 5.2 | Auto FX with live or cached-offline rates, manual override, audit note, flagged cached rates | Diverges | Audit note: `currencies.ts:407-454`. Manual override: `ExpenseEditorModal.tsx:1291`. Refresh: `LedgerContext.tsx:1570-1667`. | There is no rate fetch anywhere. Only 16 static rates exist (`src/data/mock-ledger-data.json` `fxRatesToInr`). Any other currency converts at 1:1 and is labelled "live rate" (P0-4, verified). "Live" vs "cached" depends on the in-app toggle (`LedgerContext.tsx:289`), not on connectivity. |
| 5.3 | Change group currency: relabel or re-convert | Partial | `LedgerContext.tsx:950-1079`, `split-calculator.ts:360-660`. Tests: `math-engine-scenarios.test.ts:507,1479`, e2e Stories 3 and 7. | Three problems:<br>1. Concurrent offline writes are not reconciled, which mixes currencies inside one group (P1-1).<br>2. Restoring an older revision ignores the currency (P1-2).<br>3. A fully settled group can show residual balances of up to 2 minor units after re-conversion (verified, P2). |
| 6.1 | Per-group and global activity feed with before/after diffs | Partial | Activity is written in every mutator in `LedgerContext.tsx`, shown in `ActivityAndTrashPage.tsx`. Test: e2e Story 4. | Diffs only cover amount, split mode and title (`LedgerContext.tsx:1305-1345`). `member_removed` and `settlement_updated` are never emitted. Feed text is written by the client (see section 4). |
| 6.2 | Per-expense revision history; restore any version; restore deleted expense or group | Partial | Revisions: `LedgerContext.tsx:1347-1383`. Restore: `:1566`. Trash: `:1447-1507`. Test: e2e Story 4. | Three problems:<br>1. The UI has no way to delete a group, so group restore (`:1837`) is unreachable for new data.<br>2. Revision restore is wrong across a currency change (P1-2).<br>3. The server does not store the v1 "created" snapshot until the first edit (by design). |
| 6.3 | Atomic offline conflict resolution: both revisions kept + Keep Yours / Keep Theirs banner, never silent | Diverges | `flagStaleExpenseConflicts` `sync-client.ts:187-205`, banner `ActivityAndTrashPage.tsx:533`. Test: e2e Story 2 uses a **pre-seeded** flag (`mock-ledger-data.json:653`). | The server compares HLCs only, never `base_revision_id` (`0004:734`). If the older edit arrives first, the newer one silently overwrites it and nobody sees a banner. When a conflict is detected, only the device that lost sees the banner (P1-3). |
| 6.4 | Categories and custom tags | Done | Editor `ExpenseEditorModal.tsx:816-830`, search haystack. | Tags have no e2e test. |
| 6.5 | Monthly spending charts, category breakdown, personal vs group trends | Partial | `AnalyticsAndSearchPage.tsx:178-294`. Test: e2e `analytics-category-breakdown`. | There is no monthly or time-series chart (no month aggregation in the code). Personal vs group appears as KPIs only. |
| 6.6 | Search by keyword, amount, date range, payer, category | Partial | `AnalyticsAndSearchPage.tsx:296-365`. Test: e2e `global-search-input`. | Amount and date-range filters are Missing. Payer works only through the keyword search. |
| 6.7 | Notes, comments, device-local receipts (0 bytes uploaded, pointer syncs) | Partial | Notes: Done. Comments: `LedgerContext.tsx:1669-1709` (group bills only, `GroupsLedgerPage.tsx:1378`). Receipts: `ExpenseEditorModal.tsx:729-797`, `local-db.ts:373`. Tests: `domain-and-portability.test.ts:410,500,531`. | Three problems:<br>1. Comments live inside the expense JSON and use last-writer-wins, so concurrent comments are lost (P1-4).<br>2. Receipt blobs are deleted on sign-out or user switch (P1-9).<br>3. Peers cannot see receipts (P2P is a separate plan). |
| 7.1 | Splitwise CSV/JSON importer, one click | Partial | `parseSplitwiseCsv` `portability-engine.ts:208-329`, `importSplitwiseExpenses` `LedgerContext.tsx:1914-2019`. Test: `math-engine-scenarios.test.ts:996`, e2e `confirm-splitwise-import-btn`. | Three problems:<br>1. JSON import is Missing.<br>2. Payment rows are dropped (`:232`), so imported balances differ from Splitwise.<br>3. Names that do not match a member are booked to `members[0]` without telling the user (`LedgerContext.tsx:1944,1952,1974`) (P1-7). |
| 7.2 | CSV, PDF, Excel export for any group or date range | Partial | `portability-engine.ts:331,520,675`. Tests: `domain-and-portability.test.ts:384`, e2e `download-xlsx-btn`/`download-pdf-btn`. | Exports are per group only: no date range, and direct splits cannot be exported. |
| 7.3 | Encrypted local and cloud backup and restore | Partial | AES-256-GCM `portability-engine.ts:436-518`, UI `PortabilityAndSyncPage.tsx:240-295`. Test: `domain-and-portability.test.ts:168`, e2e `decrypt-restore-btn`. | Four problems:<br>1. The default passphrase is the public string `wise-spliter-vault-2026` (`:84,243,267`).<br>2. Restore only accepts pasted text: there is no file picker.<br>3. "Decrypt and restore" on an empty box re-encrypts the current data and reports "Restored".<br>4. Receipt images are not included. |

Group management that the requirements imply but that is missing from the UI:
- Delete group.
- Remove member, leave group.
- Edit member (for example, adding an email so they can claim later).
- Rename group.
- Edit or delete a group settlement.

## 2. Parity with Splitwise and Settl

**How the sources were gathered.** A research sub-agent ran web searches on 2026-11-16. WebFetch failed, so every claim comes from search-result snippets of the cited pages. Treat exact numbers as "per the snippet".

**Which Settl.** At least 5 apps are called Settl. "Settl A" is the Google Play listing `com.settl.app` (about 75% sure it is the offline, paise-rotating one). "Settl B" is settlapp.in, which has UPI flows (about 70% sure it is a separate product).

Sources:
- [SW-Pro] https://kb.splitwise.com/pro/what-is-splitwise-pro
- [SW-Split] https://kb.splitwise.com/balances-and-expenses/what-are-different-ways-i-can-split-an-expense
- [SW-Rec] https://kb.splitwise.com/balances-and-expenses/how-can-i-manage-recurring-expenses
- [SW-Simp] https://kb.splitwise.com/balances-and-expenses/what-is-simplify-debts
- [SW-FX] https://feedback.splitwise.com/knowledgebase/articles/301146-can-splitwise-do-currency-conversion-between-multi
- [SW-Undel] https://feedback.splitwise.com/knowledgebase/articles/298437-how-do-i-restore-un-delete-an-expense
- [SW-Pay] https://kb.splitwise.com/payment-integrations/how-do-i-send-money-via-paypal-or-venmo
- [SW-Itemize] https://www.splitwise.com/press/splitwise-launches-new-feature-that-takes-the-awkwardness-out-of-splitting-the-check
- [ST-A] https://play.google.com/store/apps/details?id=com.settl.app
- [ST-B] https://www.settlapp.in/features/upi-payments
- [ST-B-iOS] https://apps.apple.com/us/app/settl-split-bills-expenses/id6761974656

| Capability | Competitor reality | Ours | vs. them | Phase |
|---|---|---|---|---|
| Groups | Splitwise: free | Yes, but no delete, rename or remove-member UI | Worse | P1 |
| Non-group 1:1 expenses | Splitwise: free | Partial: direct splits work, but settling is full-only with no date | Worse | P1 (2.1, 4.2). "Quick 1-on-1 IOU" is Phase 2 |
| Split types | Splitwise: equal, exact, %, shares, adjustment, plus reimbursement and itemized [SW-Split]. Settl A: equal, shares, exact, % [ST-A] | Yes, all 5. Shares are whole numbers only | Equal to Splitwise (minus itemized); better than Settl A | P1 |
| Multiple payers | Splitwise: free | Yes | Equal | P1 |
| Itemized / receipt OCR | Splitwise: manual itemize free; OCR is Pro (free in US and UK since 14 Oct 2026) [SW-Pro][SW-Itemize] | No | Worse | Phase 2 |
| Recurring | Splitwise: free, weekly to yearly [SW-Rec] | No | Worse | Phase 2 |
| Comments | Splitwise: free (forum) | Partial: group bills only, lost on concurrent posts | Worse | P1 (6.7) |
| Activity feed | Splitwise: free [SW-Undel] | Yes, with per-expense revision history | Better (Splitwise edit history: commonly known, unverified) | P1 |
| Push / email notifications | Splitwise: email reminders. General notification settings: unverified | No | Worse | Not in requirements (Phase 2+) |
| Payment reminders | Splitwise: manual "send reminder"; whether auto-nudges are Pro is unverified. Settl B iOS: Pro nudges [ST-B-iOS] | No (only a WhatsApp summary) | Worse | Not in requirements (Phase 2+) |
| Settle up / record payment | Splitwise: free; Settl A: partial payments [ST-A] | Partial: no date, no edit or delete for group payments | Worse | P1 (4.2) |
| Integrated payments | Splitwise: Venmo and PayPal, US only [SW-Pay]; no native UPI found. Settl B: opens UPI app, receiver confirms payment [ST-B] | Partial: generic `upi://pay`, payee fallback bug, no Venmo link, no receiver confirmation | Better than Splitwise in India once P0-3 is fixed; worse than Settl B (no confirmation) | P1 (4.1) |
| Debt simplification | Splitwise: per-group toggle [SW-Simp]. Settl A: toggle, plus an explanation for each payment [ST-A] | Yes. Exact DP optimum for n<=16 | Equal or better (Splitwise optimality: commonly known, unverified) | P1 |
| Multi-currency | Splitwise: free per-expense currency [SW-FX]. Settl A: 170+, including 0-decimal [ST-A] | Yes, with 0/2/3 decimals | Equal | P1 |
| Currency conversion | Splitwise: Pro, at the day's rate [SW-FX] | Partial: free, but no live rates; unknown currencies convert 1:1 | Worse until P0-4 is fixed (free is a plus) | P1 (5.2) |
| Export | Splitwise: CSV free, JSON backup Pro. Settl A: export, backup, restore [ST-A] | CSV, XLSX, PDF per group; encrypted backup | Better format coverage; worse on range and direct splits | P1 (7.2) |
| Search | Splitwise: Pro [SW-Pro] | Partial: free, but no amount or date filters | Better (free); worse on filters | P1 (6.6) |
| Categories / charts | Splitwise: charts are Pro [SW-Pro] | Categories, tags, category chart; no monthly chart | Partial | P1 (6.4, 6.5) |
| Default split per group | Splitwise: Pro [SW-Split] | Yes, free | Better | P1 |
| Receipts | Splitwise: about 1 image per expense, free (forum) | Device-only, peers cannot see, wiped on sign-out | Worse | P1 (6.7), P2P later |
| Invites | Splitwise: email, SMS, phone; QR for Itemize | Email claim only; no invite link or QR join | Worse | P1 (1.4) |
| Offline | Splitwise: unverified. Settl A: fully offline, no account [ST-A] | Offline-first, but a real ledger needs sign-in; data from before sign-in is wiped | Better than Splitwise; worse than Settl A (no account-free personal mode) | P1 (1.3) |
| Quick amount presets | Settl: not found in either listing (unverified) | Yes (`ux-quick-amount-presets`) | Unique to us (unverified) | P1 |
| Paise rounding fairness | Settl A: leftover paisa rotates [ST-A] | Yes, frozen per bill; the seed does not sync across users | Equal, slightly worse multi-user | P1 |
| Trash / undelete | Splitwise: restore from the activity entry [SW-Undel] | Expenses: yes. Groups: no delete path | Equal for expenses | P1 |
| Limits / price | Splitwise free: about 3 to 5 expenses per day plus a countdown, and ads [SW-Pro]. Settl A: no limits | None | Better than Splitwise, equal to Settl | P1 |
| AI text / voice entry | Settl B: yes [ST-B] | No | Worse | Phase 2 |

## 3. Correctness review

### 3.1 Money math (good)
- Parsing is BigInt with half-away-from-zero rounding (`currencies.ts:202-280`).
- Conversion is BigInt (`currencies.ts:372-405`).
- Allocation uses Hamilton largest remainder with a rotating tiebreak (`split-calculator.ts:26-68`).
- Property tests cover conservation for 0/2/3 decimals.

Issues:
- **Malformed grouping input is accepted.** `"12,50"` EUR parses to 125000 minor (€1,250.00). Verified. `currencies.ts:221-229` never checks 3-digit groups. P2.
- **Excess decimals are rounded without a warning.** `"10.005"` INR becomes 1001. P2: show this in the UI.
- **Money crosses domain boundaries as a JS `number`.** This is safe because the server caps values at 2^53-1.

### 3.2 Split modes
All 5 are correct and conserve the total.
- Adjustment = equal split of `(T - sum adj)` plus each person's adjustment. This matches Splitwise.
- Shares are whole numbers only (P2).
- In percentage mode, the leftover basis points go to the first included member (fine).

### 3.3 FX
- **P0-4.** There are no live or cached rates. Unknown currencies fall back to rate 1:
  - `ExpenseEditorModal.tsx:355-358,480-487`
  - `LedgerContext.tsx:970-974,1925-1927`
  - `ledger-engine.ts:483-486`

  Reproduction (verified): 1,000,000 VND becomes ₹1,000,000.00 with the note "Converted ... at 1 VND = 1.00 INR (live rate ...)".
- **P1-1.** The server never checks that `expenses.group_currency = groups.base_currency`, or that the settlement currency matches. See `0004_tenant_isolation_and_sync.sql:693-768,798-875` and `syncRows.ts:265,321`.

  Reproduction: member B is offline and adds a ₹1,000 bill. Admin A re-converts the group INR to USD. B syncs. B's bill (INR, 100000 minor) is now counted as $1,000.00 in the USD group's balances. An offline edit with a newer HLC on an already converted bill has the same effect.
- **P2.** Re-conversion rounds each bill and payment on its own. A fully settled group showed `{a:-2, b:+1, c:+1}` minor units after INR to USD at 0.0118 (verified, `split-calculator.ts:620-660`). Possible fix: post a rounding adjustment, or re-convert net balances.

### 3.4 Debt simplification
- Optimal. The DP reconstruction is correct.
- My brute-force check found 0 mismatches against the optimal transfer count in 2000 random cases (n <= 8).
- The greedy fallback (n > 16) still zeroes every balance.

### 3.5 Balance explanations
- The arithmetic is correct (`ledger-engine.ts:343-453`).
- It can only be opened from the roster (Partial, see 3.3 in the table).

### 3.6 Settlements
- **P0-3: UPI can pay the wrong person.**
  - The payee VPA falls back to the payer's own VPA (`FriendsAndSettlePage.tsx:192,208`).
  - It then falls back to the hard-coded demo VPA `arjun.mehta@upi.test` (`:250-254`).

  Reproduction: you owe a member who has no UPI id. Open Friends, tap GPay. The `upi://pay?pa=` field is your own VPA (or the demo VPA).
- **P1-5.**
  - No settlement date input.
  - A group payment cannot be undone (no delete or edit).
  - An empty amount records the suggestion or ₹500 (`FriendsAndSettlePage.tsx:393-395`).
  - A fake UTR is generated (`:406`).
- **P1-8.** Direct "settle with a friend" works only through Settle All, for the full amount, one settlement per bill. The Friends record form refuses direct balances ("Direct non-group split selected.", `FriendsAndSettlePage.tsx:355`). There is no partial direct payback, so the anchoring rework made 1:1 settling less natural.

  Also, editing a direct bill to remove a participant soft-deletes their anchored payments on the server (`0004:465-473`). That loses the record that money was paid.
- **Placeholders without accounts still work** in direct splits: fresh UUIDs, and the owner is bound by email. A settlement still needs the recorder to be one of the two parties.

### 3.7 Trash, restore, revisions, conflicts
- **P1-2.** The revision snapshot has no `groupCurrency` (`0004:536-542`, `LedgerContext.tsx:1007-1019,1367-1379`). `restoreExpenseRevision` reuses `resolveExpenseConflict` (`:1509-1568`), which copies snapshot amounts into the current currency.

  Reproduction (verified in the domain script): a ₹1,000 bill re-converted to USD becomes $11.80. Restore v1, and it shows 100000 minor in USD = $1,000.00.
- **P1-3.** Conflict detection depends on arrival order. The server only compares HLCs (`0004:734`) and ignores `base_revision_id`.
  - If the older-HLC edit pushes first and the newer one second, the second overwrites the first silently. Nobody is flagged.
  - If the older-HLC edit arrives second, it comes back stale. Only that device sets `hasUnresolvedConflict`, locally (`sync-client.ts:187-205`), and the other member never sees a banner.

  The only e2e test uses a pre-seeded flag.
- **P1-4.** Comments are stored inside the expense row (`LedgerContext.tsx:1669-1709`).
  - Two members commenting offline means one comment is lost.
  - It also triggers a false "someone edited the same bill" conflict toast.
  - Comment authorship comes from the client (`syncRows.ts:274-281`). The author id is also wrong: `exp.createdByMemberId` (`LedgerContext.tsx:1680`).
- **Group delete has no UI.** The restore path exists but is unreachable for new groups.

### 3.8 Invites and claims
- Email-based claims are correct and well tested.
- **P1-6.** `claimMemberAccount` (`LedgerContext.tsx:1134-1175`, button `GroupsLedgerPage.tsx:1046-1056`) does two harmful things:
  - It writes a fake local `userId = usr_claimed_<id>`. The server ignores this, so the device diverges from the server.
  - It pushes a `member_claimed` activity to every member saying someone "signed in with Google". That event never happened.
- Invite-link join is Missing (no route).

### 3.9 Account deletion
- Server flow is covered by tests (`security-breach.test.ts:429,706`, `redteam-regression.test.ts:1333`).
- Client: signs out and wipes local data (`LedgerContext.tsx:610-625`). Fine.

### 3.10 Exports and imports
- **P1-7. Splitwise import is wrong in three ways:**
  - Payment rows are dropped (`portability-engine.ts:232`), so balances after import differ from Splitwise.
  - Unmatched names go to `members[0]`, both as payer and as split fallback (`LedgerContext.tsx:1944,1952,1974`).
  - There is no JSON importer.
- **P1-10. Backup:**
  - The public default passphrase is pre-filled.
  - There is no file restore.
  - Restoring from an empty box reports success.

### 3.11 Regressions from the security and sync rework

| Question | Answer |
|---|---|
| Is "settle with a friend" still natural? | No, for direct bills (P1-8). |
| Can participants without accounts still be used? | Yes. |
| Does offline-first still fully work? | For a signed-in user, yes (outbox, then push/pull, with backoff). Two exceptions:<br>- **P0-1.** Anything created before the first sign-in is wiped. `completeSignIn` treats the anonymous state as "another user" (`LedgerContext.tsx:560-570,581`). Verified: a bill added while signed out was gone after demo sign-in. The user is not warned.<br>- **P1-9.** `wipeUserScopedData` (`local-db.ts:352-371`) clears `localReceiptBlobs` on sign-out. Receipts exist nowhere else, so they are lost for good. |
| Does a second device get all data on sign-in? | Yes. Pull from cursor 0 plus group and expense backfills, unit-tested (`security-breach.test.ts` "DIRECT JOIN", sync-client suite). There is no e2e test with two browser contexts. |
| Does rotation fairness hold? | It degrades across users: the seed is not synced (2.7). |

### 3.12 Scale

**P1-11. Local persistence does not scale.**
- The store is one `localStorage` JSON blob. Chrome's limit is about 5 MB (commonly known). The quota error is swallowed. At about 3.5 KB per bill (row + revision + activity), the limit hits at roughly 1,400 bills.
- Every change rewrites all Dexie tables (`local-db.ts:102-149`), which costs O(N) per edit.
- Effect when the limit is hit: the stored snapshot silently goes stale. For a signed-in user, the pull cursor has already advanced past the rows that were not saved, so they disappear from that device after a reload.

## 4. Security and quality: residual risks only

1. **Client-written feed and comments.**
   - Activity `summary_text` / `detail_note` come from the client (`0004:895-900`).
   - Comment `authorName` and `body` come from the client, and the whole comment array is replaced on every expense upsert.

   Any group member can forge feed lines ("X paid you ₹5,000") or rewrite other people's comments. Fix: derive these on the server, or render the feed from structured metadata.
2. **Fabricated claim activity** (P1-6) is the same kind of spoofing, built into the UI.
3. **Backups protected by a public passphrase** (P1-10).
4. **Plaintext local store.** The whole ledger, including emails and VPAs, sits in `localStorage` (readable by any XSS). This is normal for local-first apps; keep the CSP strict.
5. **Write throughput ceiling.** One global commit-order lock (`pg_advisory_xact_lock(7735001)`, `0004:133,980`) limits throughput to a few hundred write transactions per second. This is documented, with an upgrade path.
6. **Rejected mutations leave devices out of step.** When the server rejects a mutation, it is dropped from the outbox and stays only on this device (`sync-client.ts:527-529`). The only signal is a generic toast, so devices can drift apart with no record of why.
7. **Test gap.** No e2e test exercises two real users or devices, a real network loss (`context.setOffline`), or a cold boot through the service worker.

## 5. Must-fix list

Effort: S = up to half a day, M = 1 to 2 days, L = 3 or more days.

### P0 (blocks Phase 1)

| ID | Item | Where | Effort |
|---|---|---|---|
| P0-1 | Data from before sign-in is silently wiped on first sign-in. Offer to import it into the account (diff against `SAMPLE_ENTITY_IDS`, remap the sample "me" member to the profile), or at least block and warn, with an export option. | `LedgerContext.tsx:555-589` | M (S for warn-only) |
| P0-2 | New expenses default to the hard-coded date `2026-11-11` (verified). | `ExpenseEditorModal.tsx:147,297` | S |
| P0-3 | UPI payee falls back to the payer's own or a demo VPA. Disable the pay buttons when the payee has no VPA; remove `arjun.mehta@upi.test`. | `FriendsAndSettlePage.tsx:192,208,250-254` | S |
| P0-4 | Unknown-rate currencies convert 1:1 and are labelled "live". Require a manual rate (status `manual`) when no rate is known; derive "live/cached" from real fetch state. | `ExpenseEditorModal.tsx:355-358,480-487`; `LedgerContext.tsx:970-974,1925-1927`; `ledger-engine.ts:483-486` | S guard, M with live rates (P1-12) |

### P1 (required for "Phase 1 done")

| ID | Item | Where | Effort |
|---|---|---|---|
| P1-1 | Server: reject or flag expense and settlement writes whose currency does not match the group; client re-denominates or flags on pull. | `0004:693-768,798-875`; `syncRows.ts:265,321` | M |
| P1-2 | Add `groupCurrency` to revision snapshots; convert or block when restoring across currencies. | `0004:536-542`; `LedgerContext.tsx:1509-1568` | S |
| P1-3 | Server-side conflict detection on `base_revision_id`, setting `has_unresolved_conflict` / `conflict_revision_id` on the row so every member sees the banner. | `0004:734-767`; `sync-client.ts:187-205` | M |
| P1-4 | Comments as their own synced entity (the table already exists in the spec), with the author set by the server. | `LedgerContext.tsx:1669-1709`; `syncRows.ts:274-281` | M |
| P1-5 | Settlement form: date input; edit and delete for group settlements; no amount fallback; no fake UTR. | `FriendsAndSettlePage.tsx:376-415`; `LedgerContext.tsx:1797-1832` | M |
| P1-6 | Remove the fake "Link Google Account" claim; show "Invite pending" instead. | `GroupsLedgerPage.tsx:1046-1056`; `LedgerContext.tsx:1134-1175` | S |
| P1-7 | Splitwise import: import payments as settlements; create or map unmatched members (block if unresolved); add JSON. | `portability-engine.ts:208-329`; `LedgerContext.tsx:1914-2019` | M |
| P1-8 | Partial direct settlement with a friend: allocate an amount across direct bills, with date and notes. | `FriendsAndSettlePage.tsx:351-375`; `direct-settlements.ts:20-51` | M |
| P1-9 | Keep receipt blobs across sign-out (key them per user), or warn before wiping. | `local-db.ts:352-371` | S |
| P1-10 | Backup: no default passphrase (enforce a minimum strength); restore from a file; never report success on an empty input. | `PortabilityAndSyncPage.tsx:84,240-295` | S |
| P1-11 | Load the dataset from Dexie and write only the rows that changed. Stop relying on `localStorage` for data. | `LedgerContext.tsx:261-274,323-341`; `local-db.ts:102-183` | M |
| P1-12 | Fetch live FX rates, cache them (`fx_rates_cache` exists in the spec), and flag cached rates. | new `/api/fx` route, client cache | M |
| P1-13 | Invite link or code join (RPC + route + UI), plus delete group, remove or leave member, edit member email. | `src/server/index.ts`; `GroupsLedgerPage.tsx` | L |
| P1-14 | Search by amount and date range; monthly spend chart; export by date range (and direct splits). | `AnalyticsAndSearchPage.tsx:296-365`; `portability-engine.ts:331,520,675` | M |

### P2 (fix soon, does not block)
- Re-conversion leaves residual balances of up to 2 minor units (3.3).
- Comma-decimal parsing (3.1).
- Fractional shares.
- 8 non-ISO "currencies" offered that the server rejects.
- Rotation seed not synced.
- Friends merged by display name.
- Home totals INR-only.
- Explain Balance only from the roster.
- Cross-group settle is not atomic on the server.
- Venmo deep link and iOS UPI app schemes.
- WhatsApp image export.
- Activity diffs for payers, splits, date and category.
- Removing a direct participant deletes their payments.
- Server-derived feed text (section 4.1).

### Explicit deferrals to Phase 2
- Receipt OCR and itemization.
- Recurring bills.
- Quick 1-on-1 IOUs (two-tap flow).
- SMS/UPI notification parser.
- Voice / natural-language quick add.
- P2P receipt mesh (`p2p-receipt-mesh-plan.md`).
- Push and email notifications, and payment reminders. These are not in the Phase 1 requirements, but they are a parity gap.
- Receiver-confirmed UPI settlement (Settl B parity).
- Per-group sequences to remove the global write lock.

## 6. Edge cases that need e2e coverage (none exist today)

Ordered by priority. Each one names the expected behaviour, so it fails today wherever a bug above applies.

| Priority | Scenario | Expected result |
|---|---|---|
| P0 | Signed out, add a group bill and a direct bill, then sign in (demo or password). | The bills are kept, or an explicit choice is shown. They are never silently gone. |
| P0 | `page.clock.setFixedTime('2026-12-03')`, open a new expense. | The date input shows `2026-12-03`. |
| P0 | Owe a member who has no UPI id. Open Friends. | The GPay/PhonePe/Paytm buttons are disabled. `upi-uri-text` never contains your own VPA or any `*.test` VPA. |
| P0 | INR group, add a bill in VND (no known rate). | Save is blocked until a manual rate is entered. The stored status is `manual`, and the note does not say "live". |
| P1 | Two contexts: demo user and `rohan.verma@example.com` (`DEV_USER_PASSWORD`) in one group. Both go `context.setOffline(true)` and edit the same bill. Reconnect in **both orders**. | Both devices show the conflict banner. Keep Mine / Keep Theirs converge on both devices. Both revisions are in the history. |
| P1 | Admin re-converts the group INR to USD while the other member is offline and adds an INR bill plus a payment. Both sync. | Every bill and payment in the group is in USD, and the group net sums to 0. |
| P1 | Bill v1 (₹1,000), re-convert to USD, restore v1 from the revision panel. | The amount is about $11.80 (or the restore is refused), never $1,000.00. |
| P1 | Two members comment on the same bill while offline, then sync. | Both comments are present on both devices. No conflict banner or toast. |
| P1 | Device A creates groups, direct bills, payments, edits and trash items. A fresh context B signs in as the same user. | B shows the same Home totals, friend balances, revision history, Trash and direct bills. |
| P1 | Real offline: `setOffline(true)`, reload (service worker shell), add a bill, `setOffline(false)`. | The push request carries the bill. A second device pulls it. |
| P1 | A placeholder with an email is added; that user signs in. | The group appears with its full history and the member shows as claimed. A different user with a similar email (for example a `+tag`) gets no access. |
| P1 | Direct bill with a no-account friend: record a partial payback with a date, then the remainder. | The friend balance is exactly 0. Deleting a payment restores the balance. |
| P1 | Group payment with a custom date and note, then delete it. | Balances revert. The activity feed shows recorded and removed. Exports include the date. |
| P1 | Import a Splitwise CSV that has `Payment` rows and a name missing from the group. | Balances after import equal the Splitwise totals, or the import is blocked with the unmatched names listed. |
| P1 | Attach a real image receipt, sign out, sign back in. | The receipt is still viewable, or the user was warned before sign-out. |
| P1 | Backup round trip through a downloaded `.wisesplit` file: wipe, restore from the file. | An empty passphrase is rejected. A wrong passphrase gives an error. An empty restore box never reports success. |
| P1 | "Link Google Account" on an unclaimed member. | No `member_claimed` activity is pushed (no push request contains it). |
| P2 | JPY (0-decimal) and KWD (3-decimal) groups, 3 equal bills each with an odd remainder. | Each member gets the +1 exactly once, and XLSX/PDF/CSV show the correct decimals. |
| P2 | Settle All with a friend where one group's settlement is rejected (the friend was removed on the server). | The user sees which group failed. |
| P2 | Two placeholders both called "Rahul" in different groups. | They are separate friend cards. |
| P2 | 2,000 bills seeded, then reload. | All bills persist, and Home renders within the agreed time budget. |
| P2 | 17 or more members with non-zero balances, simplify on. | Every balance reaches 0, with at most n-1 transfers. |
| P2 | Account deletion of one member. | Other members' balances are byte-identical. The deleted member shows as "Deleted user". Shared direct bills survive. |
| P2 | Offline longer than the token lifetime, then reconnect. | A re-auth prompt appears, the outbox is kept and is pushed after sign-in. |
| P2 | Pick `SOMALILAND` (or any non-3-letter code) in the currency picker. | It is not offered, or it syncs. |
| P2 | Type `12,50` into the EUR amount field. | It is rejected, or parsed as 12.50, never as 1,250.00. |

## Status update (2026-11-18)

All P0 and P1 items above are implemented and verified. Evidence:

* Gates: `make typecheck`, `make migrate-verify`, `make test` (353 unit tests), `make build`, and the full `make e2e` run (128 tests across 7 specs) pass. The single failure in the last full run came from a test that predated the shared field limits (`src/types/limits.ts`); it was updated and the affected specs pass.
* Independent reviews: server and sync (0004 three rounds, 0005 one round), client features (two rounds), each re-verified after fixes. The final recheck found no MEDIUM or higher issue.
* Product rules added during this work: any active group member can edit, delete and restore group expenses and payments (Section 1 of the requirements); invite codes are server-minted `WS-` codes; a claimed member's UPI ID can only be changed by that member.

Still open, by design or owner:

* Phase 2 parity items: recurring bills, receipt OCR, reminders and notifications, receiver-confirmed UPI payments.
* P2P receipt sharing is planned only (`docs/p2p-receipt-mesh-plan.md`).
* Platform: API deployment (`docs/tasks/Cloudflare-Worker.md`), release signing for Android, iOS project, desktop shell (PWA today), Google sign-in inside the Android WebView.
* Optional storage savings listed in `docs/database-capacity.md` section 7.
* Small UI follow-up: a per-card "could not save" badge (the app-level panel already lists such rows).
