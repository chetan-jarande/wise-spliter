# Wise-Spliter — Feature Requirements Document

**Overview:**
Wise-Spliter is a 100% free, local-first, multi-platform daily expense-splitting and bill-sharing application (Desktop, iOS, Android, and Web) combining the offline speed and mathematical precision of **Settl** with the rich multi-user group collaboration, audit history, and settlement features of **Splitwise**. Every feature is completely free with no subscriptions, no ads, and no daily limits.

**Related Specifications:**

* [System Architecture &amp; Topology](./architecture.md)
* [Technical Architecture &amp; Feature Specification](./technical-spec.md)
* [Database Schema, Offline Sync &amp; Security Specification](./database-and-sync-spec.md)
* [Phase 1 Implementation Plan](./implementation-plan.md)
* [Engineering &amp; Coding Standards](./coding-standards.md)

---

## Phase 1: Core & Essential Features (MVP)

### 1. Authentication, Demo Sandbox, Offline-First Local DB & Multi-User Group Membership

* **Google Sign-In (Passwordless OAuth) & 1-Tap Demo Sandbox:** One-tap Sign in with Google (`POST /api/auth/google`) provides verified identity (`email`, `name`, `avatar`) and auto-claims invited groups, paired with a 1-tap Demo Sandbox Profile (`POST /api/auth/demo`) so first-time visitors can explore sample multi-currency groups with zero setup.
* **100% Offline-First Local Database with Automatic Cloud Sync:** The app always reads and writes to a complete on-device local database first (working seamlessly on flights and trips without internet) and automatically syncs with the cloud database (`wise_spliter` schema) when online.
* **Instant Unclaimed / Placeholder Group Members with Auto-Linking:** Add friends to any group immediately by Name (and optional Gmail/UPI ID) so you can split bills right away even if they haven't installed the app yet; if they sign in with Google or join via group invite link later, their account links to their existing member history automatically.
* **Unlimited Everything (100% Free):** No daily expense caps, no cooldown timers, no ads, and no paywalled features.

### 2. Expense Splitting, Modular Quick-Add & Math Precision

* **Modular Quick-Add Expense (Group-Scoped or Direct Non-Group Split):** Invoke "Add Expense" from either the **Home Screen** or inside a **Specific Group**. When opened inside a group, that group is pre-selected automatically; when opened from the Home Screen without selecting a group (`group_id = null`), the expense is split directly among the friends/participants added to that bill without tying it to any group.
* **Minimalist Home Screen with Top 3 Recent Groups & Progressive Disclosure:** The Home Screen surfaces only essential high-signal information—net balance summary, primary quick actions (`+ Add Expense`, `Settle Up`, `All Groups`, `Guided Help`), at most **3 recently accessed or updated groups**, and recent direct non-group splits. Opening a specific group progressively reveals minimal group-level insights, group-scoped expense operations, and automatic next-step guidance.
* **Interactive Help & Contextual Page Guide:** Built-in skippable/dismissible step-by-step guidance on each screen (`ContextualPageGuideBanner`) plus an interactive **Help & Feature Guide** modal (`HelpGuideModal`) so users always know where to find every capability without cluttering the interface.
* **Core Split Modes:** Split bills equally (with one-tap participant exclusion), by exact amounts, percentages, shares/ratios, or +/- adjustments.
* **Multiple Payers Support:** Record a single expense where two or more people contributed to paying the bill.
* **Saved Default Splits:** Save custom preset split ratios (e.g., 60/40 for couples or per-family shares) for one-tap reuse.
* **Paise/Cent Integer Math with Stateless Rotating Remainder:** Calculate in smallest currency subunits (`BigInt` minor units), rotate odd leftover cents/paise deterministically across group members at creation time, and freeze the exact calculated shares on the saved expense so deleting or editing another bill never shifts historical splits.
* **Strict Split Validation:** Prevent saving an expense until custom split amounts and payer contributions reconcile 100% with the total bill.

### 3. Balances, Debt Simplification & Transparency

* **Isolated Per-Group Debt Simplification Toggle:** Switch freely between minimum-payment graph simplification and raw, direct person-to-person balances strictly within each group (never mixing strangers across different groups).
* **Cross-Group Net Balance & One-Tap Multi-Group Settle Up:** See your total net balance with any individual friend combined across all shared groups, and settle across all shared groups in one atomic action that posts exact offsetting settlements into each group.
* **"Explain This Balance" Breakdown:** Tap any balance or suggested repayment to see the exact mathematical audit trail of bills, shares, and payments behind that number.

### 4. Settlements & Payments

* **Deep-Link UPI / Payment Integration:** Tap "Settle Up" to open GPay, PhonePe, Paytm, or Venmo pre-filled with the exact amount and receiver's ID.
* **Partial & Full Payment Recording:** Log partial paybacks or full settlements with custom dates and notes.
* **One-Tap WhatsApp / Chat Summary:** Generate a clean, readable text or image summary card with UPI payment links to paste into group chats.

### 5. Multi-Currency & Travel (Splitwise + Settl Parity)

* **170+ Currencies (0, 2, & 3 Decimal Support):** Full native support for currencies like INR, USD, JPY (0 decimals), and KWD (3 decimals).
* **Unified Group Base Currency with Auto FX Conversion & Audit Note:** Convert foreign-currency travel expenses into the group's base currency using live or cached offline exchange rates (with manual override), permanently recording the original foreign amount and exact FX rate used (e.g., `Converted from €50.00 EUR at 1 EUR = 91.20 INR`) and flagging offline-cached rates so they can be refreshed if desired.
* **Editable Group Currency:** Change a group's base currency after creation with an explicit choice to either **Re-label currency symbol only** or **Re-convert existing expenses via FX rates**.

### 6. Organization, Transparency, Group Update History & Insights

* **Transparent Group Activity & Update History Feed:** Dedicated per-group and global activity timelines visible to all group members showing every action—expenses added, edited (with before $\to$ after diff values), deleted, or restored, settlements logged, members added/joined, and group settings changed.
* **Per-Expense Immutable Edit History & Trash Recovery:** Inspect the full chronological revision log on any individual expense and restore any previous version or soft-deleted expense/group in one tap.
* **Atomic Multi-User Offline Conflict Resolution:** Treat every expense edit as an indivisible financial unit (`base_revision_id`); if two members edit the same bill while offline, preserve both revisions in history and surface a clear **"Review Offline Conflict ([Keep Yours] / [Keep Theirs])"** banner without ever silently corrupting numbers.
* **Categories & Custom Tags:** Organize expenses by categories (Food, Rent, Travel, Groceries) and custom hashtags.
* **Visual Spending Analytics:** View monthly spending charts, category breakdowns, and personal vs. group spend trends.
* **Instant Global Search & Filters:** Search across all historical expenses by keyword, amount, date range, payer, or category.
* **Expense Comments, Notes & Receipt Attachments:** Add notes, discussion comments, and receipt/bill photo attachments on individual bills. Compressed WebP receipt images are saved immediately in the local Dexie.js IndexedDB table `local_receipt_blobs` for 100% offline viewing during flights/trips, and uploaded via the Backend API (`POST /api/receipts/upload` on `:4174`) to the private Supabase Storage bucket `wise-spliter-receipts` at `{group_id_or_direct}/{expense_id}/{receipt_id}.webp` with metadata persisted in `wise_spliter.receipt_attachments` and `wise_spliter.expenses.receipts`.

### 7. Data Ownership & Portability

* **Splitwise CSV/JSON Importer:** Migrate your existing Splitwise groups and history in one click.
* **CSV, PDF & Excel Export:** Export clean spreadsheets or printable PDF statements for any group or date range.
* **Local & Cloud Backup/Restore:** Export a single encrypted backup file of your entire ledger to restore anytime on any device.

---

## Phase 2: Daily Convenience & Automation

* **On-Device Receipt OCR & Itemization:** Scan restaurant or grocery bills to auto-extract items, taxes, and tips and assign dishes to specific friends.
* **Recurring Bills & Subscriptions:** Auto-generate repeating expenses (weekly, monthly, yearly) for rent, Wi-Fi, maid, and OTT subscriptions.
* **Quick 1-on-1 IOUs:** Log casual non-group debts with a friend (like grabbing a coffee) in two taps.
* **Smart SMS / UPI Notification Parser(defer):** Auto-detect bank/UPI payment alerts on your phone and prompt to split them in one tap.
* **Voice / Natural Language Quick Add:** Type or say *"Paid 600 for dinner with Rahul and Priya"* to auto-fill the expense form.
