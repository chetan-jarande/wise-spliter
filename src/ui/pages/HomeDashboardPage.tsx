import React, { useMemo, useState } from 'react';
import {
  ArrowRightIcon as ArrowRight,
  ArrowsLeftRightIcon as ArrowsLeftRight,
  CheckCircleIcon as CheckCircle,
  ClockCounterClockwiseIcon as ClockCounterClockwise,
  FolderOpenIcon as FolderOpen,
  HandCoinsIcon as HandCoins,
  NotePencilIcon as NotePencil,
  PlusIcon as Plus,
  QuestionIcon as Question,
  ReceiptIcon as Receipt,
  SparkleIcon as Sparkle,
  TrashIcon as Trash,
  UsersIcon as Users,
  UsersThreeIcon as UsersThree,
  XIcon as X,
} from '@phosphor-icons/react';
import { useLedger } from '../../state/LedgerContext';
import { ExpenseItem, GroupRecord } from '../../types/ledger';
import {
  CurrencyAmount,
  CurrencyPrecisionPill,
  DoubleBezelCard,
  PersonalExpenseImpactBadge,
  StatusBadge,
} from '../primitives/DesignPrimitives';
import { formatMinorToMajor } from '../../domain/money/currencies';
import {
  computeCrossGroupFriendsSummary,
  computeGroupNetBalances,
} from '../../domain/ledger/ledger-engine';
import { ExpenseEditorModal } from '../modals/ExpenseEditorModal';
import { HelpGuideModal } from '../modals/HelpGuideModal';

const QUICKSTART_STORAGE_KEY = 'wise_spliter_quickstart_dismissed_v1';

export interface HomeDashboardPageProps {
  onOpenAddExpense?: (defaultGroupId?: string | null, editingExpense?: ExpenseItem | null) => void;
  onOpenHelp?: () => void;
}

export function HomeDashboardPage({
  onOpenAddExpense,
  onOpenHelp,
}: HomeDashboardPageProps = {}) {
  const {
    dataset,
    setActiveGroupId,
    setActivePage,
    softDeleteExpense,
  } = useLedger();

  // Local modal states so HomeDashboardPage always opens ExpenseEditorModal & HelpGuideModal cleanly
  const [isExpenseModalOpen, setIsExpenseModalOpen] = useState(false);
  const [modalDefaultGroupId, setModalDefaultGroupId] = useState<string | null>(null);
  const [editingExpense, setEditingExpense] = useState<ExpenseItem | null>(null);
  const [isHelpModalOpen, setIsHelpModalOpen] = useState(false);
  const [isQuickStartDismissed, setIsQuickStartDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(QUICKSTART_STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  });

  const handleDismissQuickStart = (dismiss: boolean) => {
    setIsQuickStartDismissed(dismiss);
    try {
      if (dismiss) {
        localStorage.setItem(QUICKSTART_STORAGE_KEY, '1');
      } else {
        localStorage.removeItem(QUICKSTART_STORAGE_KEY);
      }
    } catch {
      // Ignore storage restrictions
    }
  };

  const handleTriggerAddExpense = (
    defaultGroupId: string | null,
    expenseToEdit: ExpenseItem | null = null
  ) => {
    if (onOpenAddExpense) {
      onOpenAddExpense(defaultGroupId, expenseToEdit);
      return;
    }
    setModalDefaultGroupId(defaultGroupId);
    setEditingExpense(expenseToEdit);
    setIsExpenseModalOpen(true);
  };

  const handleTriggerHelp = () => {
    if (onOpenHelp) {
      onOpenHelp();
      return;
    }
    setIsHelpModalOpen(true);
  };

  // 1. Cross-Group & Direct Split Net Position in INR
  const friendsSummary = useMemo(
    () =>
      computeCrossGroupFriendsSummary(
        dataset.currentUser.email,
        dataset.groups,
        dataset.expenses,
        dataset.settlements,
        dataset.fxRatesToInr
      ),
    [
      dataset.currentUser.email,
      dataset.groups,
      dataset.expenses,
      dataset.settlements,
      dataset.fxRatesToInr,
    ]
  );

  const crossGroupTotals = useMemo(() => {
    let youAreOwedInrMinor = 0;
    let youOweInrMinor = 0;
    for (const friend of friendsSummary) {
      if (friend.netInInrMinor > 0) {
        youAreOwedInrMinor += friend.netInInrMinor;
      } else if (friend.netInInrMinor < 0) {
        youOweInrMinor += Math.abs(friend.netInInrMinor);
      }
    }
    return {
      youAreOwedInrMinor,
      youOweInrMinor,
      netBalanceInrMinor: youAreOwedInrMinor - youOweInrMinor,
    };
  }, [friendsSummary]);

  // 2. Active Groups & Strictly Top 3 Recently Accessed/Updated Groups
  const allActiveGroups = useMemo(
    () => dataset.groups.filter((g) => !g.deletedAt),
    [dataset.groups]
  );

  const recentTop3Groups = useMemo(() => {
    return [...allActiveGroups]
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
  }, [allActiveGroups]);

  // Helper to compute current user's net balance inside a specific group
  const getMyNetInGroup = (group: GroupRecord): number => {
    const myMember =
      group.members.find(
        (m) =>
          m.userId === dataset.currentUser.id ||
          m.invitedEmail?.toLowerCase() === dataset.currentUser.email.toLowerCase()
      ) ?? group.members[0];
    if (!myMember) return 0;

    const grpExpenses = dataset.expenses.filter(
      (e) => e.groupId === group.id && !e.deletedAt
    );
    const grpSettlements = dataset.settlements.filter(
      (s) => s.groupId === group.id && !s.deletedAt
    );
    const balances = computeGroupNetBalances(grpExpenses, grpSettlements, group.members);
    return balances.get(myMember.id) ?? 0;
  };

  // 3. Direct Non-Group Splits (groupId === null)
  const directExpenses = useMemo(
    () => dataset.expenses.filter((exp) => exp.groupId === null && !exp.deletedAt),
    [dataset.expenses]
  );

  const handleOpenGroupWorkspace = (groupId: string) => {
    setActiveGroupId(groupId);
    setActivePage('groups');
  };

  const resolveMyDirectParticipantId = (exp: ExpenseItem): string | null => {
    const participants = exp.adHocParticipants ?? [];
    const byEmail = participants.find(
      (p) =>
        p.invitedEmail &&
        p.invitedEmail.toLowerCase() === dataset.currentUser.email.toLowerCase()
    );
    if (byEmail) return byEmail.id;
    const byName = participants.find(
      (p) => p.displayName.toLowerCase() === dataset.currentUser.fullName.toLowerCase()
    );
    if (byName) return byName.id;
    return participants[0]?.id ?? null;
  };

  const hasActiveExpenses = useMemo(
    () => dataset.expenses.some((e) => !e.deletedAt),
    [dataset.expenses]
  );

  const hasRecordedSettlements = useMemo(
    () => dataset.settlements.some((s) => !s.deletedAt),
    [dataset.settlements]
  );

  return (
    <div data-testid="home-dashboard-page" className="space-y-7">
      {/* 1. Splitwise-Clarity Hero & Hick's Law Primary Quick Actions */}
      <DoubleBezelCard innerClassName="space-y-5">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-5">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge
                tone={
                  crossGroupTotals.netBalanceInrMinor > 0
                    ? 'emerald'
                    : crossGroupTotals.netBalanceInrMinor < 0
                    ? 'rose'
                    : 'slate'
                }
              >
                <Sparkle className="w-3.5 h-3.5" weight="fill" />
                <span>Hi, {dataset.currentUser.fullName.split(' ')[0]}</span>
              </StatusBadge>
              <CurrencyPrecisionPill currencyCode={dataset.currentUser.defaultCurrency || 'INR'} />
            </div>

            {/* Plain-English Splitwise Hero Verdict */}
            <h1
              data-testid="home-plain-english-hero-summary"
              className="text-xl sm:text-2xl font-extrabold tracking-tight text-slate-900 dark:text-slate-100"
            >
              {crossGroupTotals.netBalanceInrMinor > 0 ? (
                <>
                  Overall, you are owed{' '}
                  <span className="text-emerald-600 dark:text-emerald-400 font-mono tabular-nums">
                    +{formatMinorToMajor(crossGroupTotals.netBalanceInrMinor, 'INR')}
                  </span>
                </>
              ) : crossGroupTotals.netBalanceInrMinor < 0 ? (
                <>
                  Overall, you owe{' '}
                  <span className="text-rose-600 dark:text-rose-400 font-mono tabular-nums">
                    {formatMinorToMajor(Math.abs(crossGroupTotals.netBalanceInrMinor), 'INR')}
                  </span>
                </>
              ) : (
                <span className="text-emerald-600 dark:text-emerald-400">
                  You are all settled up!
                </span>
              )}
            </h1>

            <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400">
              {crossGroupTotals.netBalanceInrMinor === 0
                ? 'Every group and friend balance is settled at 0.00. Tap + Split a Bill anytime.'
                : `Combined across ${allActiveGroups.length} active groups and ${directExpenses.length} direct 1-on-1 splits.`}
            </p>
          </div>

          {/* 3 Clean Numbers in INR: You Are Owed, You Owe, Net Balance */}
          <div className="grid grid-cols-3 gap-2.5 sm:gap-3.5">
            <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/[0.05] px-3.5 py-2.5">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-300">
                You Are Owed
              </div>
              <div
                data-testid="home-you-are-owed-amount"
                className="mt-1 text-sm sm:text-base font-extrabold font-mono tabular-nums text-emerald-600 dark:text-emerald-400"
              >
                <CurrencyAmount
                  minorAmount={crossGroupTotals.youAreOwedInrMinor}
                  currencyCode="INR"
                  showPlusSign
                />
              </div>
            </div>

            <div className="rounded-2xl border border-rose-500/25 bg-rose-500/[0.05] px-3.5 py-2.5">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-rose-700 dark:text-rose-300">
                You Owe
              </div>
              <div
                data-testid="home-you-owe-amount"
                className="mt-1 text-sm sm:text-base font-extrabold font-mono tabular-nums text-rose-600 dark:text-rose-400"
              >
                <CurrencyAmount
                  minorAmount={crossGroupTotals.youOweInrMinor}
                  currencyCode="INR"
                />
              </div>
            </div>

            <div className="rounded-2xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-slate-900/70 px-3.5 py-2.5">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                Net Balance
              </div>
              <div
                data-testid="home-net-balance-amount"
                className="mt-1 text-sm sm:text-base font-extrabold font-mono tabular-nums"
              >
                <CurrencyAmount
                  minorAmount={crossGroupTotals.netBalanceInrMinor}
                  currencyCode="INR"
                  colorize
                  showPlusSign
                />
              </div>
            </div>
          </div>
        </div>

        {/* Primary Quick Actions Row (Hick's Law: Single Dominant Primary CTA) */}
        <div className="flex flex-wrap items-center justify-between gap-2.5 pt-3.5 border-t border-slate-200/70 dark:border-white/10">
          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              data-testid="home-quick-add-expense-btn"
              onClick={() => handleTriggerAddExpense(null, null)}
              className="min-h-[44px] inline-flex items-center gap-2 rounded-xl bg-[#059669] hover:bg-emerald-600 text-white px-5 py-2.5 text-xs sm:text-sm font-bold shadow-md shadow-emerald-600/20 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
            >
              <Plus className="w-4 h-4" weight="bold" />
              <span>+ Split a Bill</span>
            </button>

            <button
              type="button"
              data-testid="home-quick-settle-btn"
              onClick={() => setActivePage('friends')}
              className="min-h-[44px] inline-flex items-center gap-1.5 rounded-xl border border-slate-200 dark:border-white/15 bg-slate-50 dark:bg-slate-800/90 hover:bg-slate-100 dark:hover:bg-slate-800 px-4 py-2.5 text-xs font-semibold text-slate-700 dark:text-slate-200 transition-colors cursor-pointer"
            >
              <HandCoins className="w-4 h-4 text-[#059669]" weight="bold" />
              <span>Settle Up</span>
            </button>

            <button
              type="button"
              data-testid="home-view-all-groups-btn"
              onClick={() => setActivePage('groups')}
              className="min-h-[44px] inline-flex items-center gap-1.5 rounded-xl border border-slate-200 dark:border-white/15 bg-slate-50 dark:bg-slate-800/90 hover:bg-slate-100 dark:hover:bg-slate-800 px-3.5 py-2.5 text-xs font-semibold text-slate-700 dark:text-slate-200 transition-colors cursor-pointer"
            >
              <UsersThree className="w-4 h-4 text-[#059669]" weight="bold" />
              <span>All Groups ({allActiveGroups.length})</span>
            </button>
          </div>

          <div className="flex items-center gap-2">
            {isQuickStartDismissed && (
              <button
                type="button"
                onClick={() => handleDismissQuickStart(false)}
                className="inline-flex items-center gap-1 rounded-xl border border-slate-200 dark:border-white/10 px-3 py-2 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:text-[#059669] transition-colors cursor-pointer"
              >
                <span>Show 3-Step Start</span>
              </button>
            )}
            <button
              type="button"
              data-testid="home-open-help-btn"
              onClick={handleTriggerHelp}
              className="min-h-[40px] inline-flex items-center gap-1.5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 hover:bg-emerald-500/20 px-3.5 py-2 text-xs font-semibold text-emerald-700 dark:text-emerald-300 transition-colors cursor-pointer"
            >
              <Question className="w-4 h-4" weight="bold" />
              <span>How It Works</span>
            </button>
          </div>
        </div>
      </DoubleBezelCard>

      {/* 1b. Settl-Style Compact 3-Step First-Time Quick-Start Checklist (Dismissible) */}
      {!isQuickStartDismissed && (
        <div
          data-testid="first-time-quickstart-strip"
          className="rounded-2xl border border-emerald-500/25 bg-emerald-500/[0.04] dark:bg-emerald-500/[0.06] p-4 space-y-3"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Sparkle className="w-4 h-4 text-[#059669]" weight="fill" />
              <span className="text-xs font-bold uppercase tracking-wider text-slate-800 dark:text-slate-100">
                New Here? Split &amp; Settle in 3 Simple Steps
              </span>
            </div>
            <button
              type="button"
              data-testid="dismiss-quickstart-btn"
              onClick={() => handleDismissQuickStart(true)}
              aria-label="Dismiss 3-step quick start guide"
              className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 transition-colors cursor-pointer"
            >
              <span>Hide</span>
              <X className="w-3.5 h-3.5" weight="bold" />
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <button
              type="button"
              onClick={() => setActivePage('groups')}
              className="flex items-start gap-3 rounded-xl bg-white dark:bg-[#111827] border border-slate-200/80 dark:border-white/10 hover:border-emerald-500/40 p-3 text-left transition-colors cursor-pointer"
            >
              <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 text-xs font-mono font-bold">
                {allActiveGroups.length > 0 ? (
                  <CheckCircle className="w-4 h-4 text-[#059669]" weight="fill" />
                ) : (
                  '1'
                )}
              </span>
              <div className="min-w-0">
                <div className="text-xs font-bold text-slate-900 dark:text-white">
                  1. Pick or Create a Group
                </div>
                <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                  Trips, roommates, or split 1-on-1 with any friend by name.
                </p>
              </div>
            </button>

            <button
              type="button"
              onClick={() => handleTriggerAddExpense(null, null)}
              className="flex items-start gap-3 rounded-xl bg-white dark:bg-[#111827] border border-slate-200/80 dark:border-white/10 hover:border-emerald-500/40 p-3 text-left transition-colors cursor-pointer"
            >
              <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 text-xs font-mono font-bold">
                {hasActiveExpenses ? (
                  <CheckCircle className="w-4 h-4 text-[#059669]" weight="fill" />
                ) : (
                  '2'
                )}
              </span>
              <div className="min-w-0">
                <div className="text-xs font-bold text-slate-900 dark:text-white">
                  2. Add a Bill in Seconds
                </div>
                <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                  Split equally, by exact share, %, or multiple payers - works offline too.
                </p>
              </div>
            </button>

            <button
              type="button"
              onClick={() => setActivePage('friends')}
              className="flex items-start gap-3 rounded-xl bg-white dark:bg-[#111827] border border-slate-200/80 dark:border-white/10 hover:border-emerald-500/40 p-3 text-left transition-colors cursor-pointer"
            >
              <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 text-xs font-mono font-bold">
                {hasRecordedSettlements ? (
                  <CheckCircle className="w-4 h-4 text-[#059669]" weight="fill" />
                ) : (
                  '3'
                )}
              </span>
              <div className="min-w-0">
                <div className="text-xs font-bold text-slate-900 dark:text-white">
                  3. Settle via UPI or WhatsApp
                </div>
                <p className="mt-0.5 text-[11px] text-slate-500 dark:text-slate-400">
                  Scan a pre-filled UPI QR code or share a clean WhatsApp summary.
                </p>
              </div>
            </button>
          </div>
        </div>
      )}

      {/* 2. Recently Accessed or Updated Groups (Strictly At Most 3 Groups) */}
      <section className="space-y-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <ClockCounterClockwise className="w-5 h-5 text-[#059669]" weight="duotone" />
            <h2 className="text-sm sm:text-base font-bold tracking-tight text-slate-900 dark:text-slate-100">
              Recent Groups
            </h2>
            <StatusBadge tone="slate">Top 3</StatusBadge>
          </div>

          <button
            type="button"
            onClick={() => setActivePage('groups')}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 dark:border-white/15 bg-white dark:bg-slate-900 hover:border-emerald-500/40 px-3 py-1.5 text-xs font-bold text-slate-700 dark:text-slate-200 transition-colors cursor-pointer"
          >
            <span>See All {allActiveGroups.length} Groups</span>
            <ArrowRight className="w-3.5 h-3.5 text-[#059669]" weight="bold" />
          </button>
        </div>

        <div
          data-testid="home-recent-groups-grid"
          className="grid grid-cols-1 md:grid-cols-3 gap-4"
        >
          {recentTop3Groups.map((group) => {
            const myNetMinor = getMyNetInGroup(group);
            const activeBillsCount = dataset.expenses.filter(
              (e) => e.groupId === group.id && !e.deletedAt
            ).length;

            return (
              <DoubleBezelCard
                key={group.id}
                testId={`home-recent-group-card-${group.id}`}
                innerClassName="flex flex-col justify-between space-y-4"
              >
                <div className="space-y-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <StatusBadge tone="emerald">{group.category.toUpperCase()}</StatusBadge>
                    <CurrencyPrecisionPill currencyCode={group.baseCurrency} />
                  </div>

                  <div>
                    <h3 className="text-base font-bold text-slate-900 dark:text-slate-100 truncate">
                      {group.name}
                    </h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400 line-clamp-1">
                      {group.description}
                    </p>
                  </div>

                  <div className="flex items-center justify-between rounded-xl border border-slate-200/70 dark:border-white/10 bg-slate-50/80 dark:bg-slate-900/60 px-3 py-2.5">
                    <div className="text-xs text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
                      <Users className="w-3.5 h-3.5 text-[#059669]" weight="bold" />
                      <span>
                        {group.members.length} people • {activeBillsCount} bills
                      </span>
                    </div>

                    <div className="text-right">
                      <div className="text-xs font-extrabold font-mono tabular-nums">
                        <CurrencyAmount
                          minorAmount={myNetMinor}
                          currencyCode={group.baseCurrency}
                          colorize
                          showPlusSign
                        />
                      </div>
                      <div
                        className={`text-[10px] font-semibold ${
                          myNetMinor > 0
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : myNetMinor < 0
                            ? 'text-rose-600 dark:text-rose-400'
                            : 'text-slate-400'
                        }`}
                      >
                        {myNetMinor > 0
                          ? 'you are owed'
                          : myNetMinor < 0
                          ? 'you owe'
                          : 'all settled up'}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 pt-2 border-t border-slate-200/70 dark:border-white/10">
                  <button
                    type="button"
                    data-testid={`open-group-workspace-${group.id}`}
                    onClick={() => handleOpenGroupWorkspace(group.id)}
                    className="min-h-[40px] inline-flex items-center justify-center gap-1.5 rounded-xl bg-slate-900 dark:bg-white text-white dark:text-slate-900 hover:opacity-90 px-3 py-2 text-xs font-bold transition-opacity cursor-pointer"
                  >
                    <FolderOpen className="w-3.5 h-3.5" weight="bold" />
                    <span>Open Group</span>
                  </button>

                  <button
                    type="button"
                    data-testid={`home-add-group-expense-${group.id}`}
                    onClick={() => handleTriggerAddExpense(group.id, null)}
                    className="min-h-[40px] inline-flex items-center justify-center gap-1 rounded-xl bg-[#059669] hover:bg-emerald-600 text-white px-3 py-2 text-xs font-bold transition-colors cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" weight="bold" />
                    <span>+ Add Bill</span>
                  </button>
                </div>
              </DoubleBezelCard>
            );
          })}
        </div>
      </section>

      {/* 3. Direct Non-Group Splits (groupId === null) */}
      <section className="space-y-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-0.5">
            <div className="flex items-center gap-2">
              <ArrowsLeftRight className="w-5 h-5 text-[#059669]" weight="duotone" />
              <h2 className="text-sm sm:text-base font-bold tracking-tight text-slate-900 dark:text-slate-100">
                Direct 1-on-1 &amp; Non-Group Splits ({directExpenses.length})
              </h2>
              <StatusBadge tone="blue">No Group Needed</StatusBadge>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Quick bills split directly with friends (coffee, cab, dinner) without setting up a group.
            </p>
          </div>

          <button
            type="button"
            data-testid="home-new-direct-split-btn"
            onClick={() => handleTriggerAddExpense(null, null)}
            className="min-h-[40px] inline-flex items-center gap-1.5 rounded-xl border border-emerald-500/35 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 px-3.5 py-2 text-xs font-bold transition-colors cursor-pointer"
          >
            <Plus className="w-4 h-4" weight="bold" />
            <span>+ Split 1-on-1 (No Group)</span>
          </button>
        </div>

        <div data-testid="home-direct-expenses-list" className="space-y-3">
          {directExpenses.length === 0 ? (
            <DoubleBezelCard innerClassName="text-center py-8 space-y-2.5">
              <Receipt className="w-7 h-7 text-slate-400 mx-auto" weight="duotone" />
              <div className="text-sm font-bold text-slate-700 dark:text-slate-300">
                No direct 1-on-1 splits yet
              </div>
              <p className="text-xs text-slate-500 max-w-md mx-auto">
                Splitting a quick coffee, cab, or lunch with one friend? Tap below to split right away without creating a group.
              </p>
              <div className="pt-1">
                <button
                  type="button"
                  onClick={() => handleTriggerAddExpense(null, null)}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-[#059669] hover:bg-emerald-600 text-white px-4 py-2 text-xs font-bold transition-colors cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" weight="bold" />
                  <span>Split a Direct Bill</span>
                </button>
              </div>
            </DoubleBezelCard>
          ) : (
            directExpenses.map((exp) => {
              const participants = exp.adHocParticipants ?? [];
              const participantNameOf = (memberId: string) =>
                participants.find((p) => p.id === memberId)?.displayName ?? memberId;

              const payerSummary = exp.payers
                .map(
                  (p) =>
                    `${participantNameOf(p.memberId)} (${formatMinorToMajor(
                      p.paidMinor,
                      exp.groupCurrency
                    )})`
                )
                .join(' + ');

              const catMeta = dataset.categoriesCatalog.find((c) => c.key === exp.category);
              const myDirectMemberId = resolveMyDirectParticipantId(exp);

              return (
                <DoubleBezelCard
                  key={exp.id}
                  testId={`direct-expense-card-${exp.id}`}
                  innerClassName="space-y-3"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <StatusBadge tone="blue">Direct Split</StatusBadge>
                        <StatusBadge tone="emerald">
                          {catMeta?.label ?? exp.category.toUpperCase()}
                        </StatusBadge>
                        <StatusBadge tone="slate">{exp.splitMode.toUpperCase()} SPLIT</StatusBadge>
                      </div>
                      <h3 className="text-sm sm:text-base font-bold text-slate-900 dark:text-slate-100">
                        {exp.title}
                      </h3>
                      <div className="text-xs text-slate-500 dark:text-slate-400">
                        <span className="font-mono">{exp.expenseDate}</span> • Paid by {payerSummary}
                      </div>
                    </div>

                    <div className="text-right space-y-1">
                      <div className="text-base sm:text-lg font-extrabold font-mono tabular-nums text-slate-900 dark:text-slate-100">
                        <CurrencyAmount
                          minorAmount={exp.amountMinor}
                          currencyCode={exp.groupCurrency}
                        />
                      </div>
                      <div>
                        <PersonalExpenseImpactBadge
                          expense={exp}
                          myMemberId={myDirectMemberId}
                        />
                      </div>
                      {exp.originalCurrency !== exp.groupCurrency && (
                        <div className="text-xs font-mono tabular-nums text-slate-500">
                          Orig:{' '}
                          <CurrencyAmount
                            minorAmount={exp.originalAmountMinor}
                            currencyCode={exp.originalCurrency}
                          />
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Ad-hoc Participants & Split Shares */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {exp.splits
                      .filter((s) => s.included)
                      .map((s) => {
                        const participant = participants.find((p) => p.id === s.memberId);
                        return (
                          <div
                            key={s.memberId}
                            className="flex items-center justify-between gap-2 rounded-xl border border-slate-200/70 dark:border-white/10 bg-slate-50/70 dark:bg-slate-900/50 px-3 py-1.5"
                          >
                            <div className="flex items-center gap-1.5 min-w-0">
                              <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 text-[10px] font-bold">
                                {participant?.avatarInitials ?? 'FR'}
                              </span>
                              <span className="text-xs font-semibold text-slate-700 dark:text-slate-300 truncate">
                                {participantNameOf(s.memberId)}
                              </span>
                            </div>
                            <span className="text-xs font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100">
                              <CurrencyAmount
                                minorAmount={s.owedMinor}
                                currencyCode={exp.groupCurrency}
                              />
                            </span>
                          </div>
                        );
                      })}
                  </div>

                  {exp.notes && (
                    <p className="text-xs text-slate-500 dark:text-slate-400">{exp.notes}</p>
                  )}

                  <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-200/60 dark:border-white/10">
                    <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500">
                      <CheckCircle className="w-3.5 h-3.5 text-[#059669]" weight="fill" />
                      <span>
                        Participants:{' '}
                        {participants.map((p) => p.displayName).join(', ') || 'Direct Friends'}
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleTriggerAddExpense(null, exp)}
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-white/15 bg-slate-50 dark:bg-slate-800 hover:bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700 dark:text-slate-200 transition-colors cursor-pointer"
                      >
                        <NotePencil className="w-3.5 h-3.5" />
                        <span>Edit</span>
                      </button>
                      <button
                        type="button"
                        data-testid={`delete-expense-${exp.id}`}
                        onClick={() => softDeleteExpense(exp.id)}
                        className="inline-flex items-center gap-1 rounded-lg border border-rose-500/30 bg-rose-500/10 hover:bg-rose-500/20 px-2.5 py-1 text-xs font-semibold text-rose-700 dark:text-rose-300 transition-colors cursor-pointer"
                      >
                        <Trash className="w-3.5 h-3.5" />
                        <span>Trash</span>
                      </button>
                    </div>
                  </div>
                </DoubleBezelCard>
              );
            })
          )}
        </div>
      </section>

      {/* Modular Expense Editor Modal (supports defaultGroupId=null for direct splits or group.id for group bills) */}
      <ExpenseEditorModal
        isOpen={isExpenseModalOpen}
        onClose={() => {
          setIsExpenseModalOpen(false);
          setEditingExpense(null);
        }}
        initialExpense={editingExpense}
        defaultGroupId={modalDefaultGroupId}
      />

      {/* Interactive Help Guide Modal */}
      <HelpGuideModal
        isOpen={isHelpModalOpen}
        onClose={() => setIsHelpModalOpen(false)}
        onNavigateTab={(tab) => setActivePage(tab)}
      />
    </div>
  );
}
