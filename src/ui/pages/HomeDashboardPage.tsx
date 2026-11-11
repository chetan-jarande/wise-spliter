import React, { useMemo, useState } from 'react';
import {
  ArrowRightIcon as ArrowRight,
  ArrowsLeftRightIcon as ArrowsLeftRight,
  BookOpenIcon as BookOpen,
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
} from '@phosphor-icons/react';
import { useLedger } from '../../state/LedgerContext';
import { ExpenseItem, GroupRecord } from '../../types/ledger';
import {
  CurrencyAmount,
  CurrencyPrecisionPill,
  DoubleBezelCard,
  StatusBadge,
} from '../primitives/DesignPrimitives';
import { formatMinorToMajor } from '../../domain/money/currencies';
import {
  computeCrossGroupFriendsSummary,
  computeGroupNetBalances,
} from '../../domain/ledger/ledger-engine';
import { ExpenseEditorModal } from '../modals/ExpenseEditorModal';
import { HelpGuideModal } from '../modals/HelpGuideModal';

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

  return (
    <div data-testid="home-dashboard-page" className="space-y-8">
      {/* 1. Minimalist Hero & Quick Actions Strip */}
      <DoubleBezelCard innerClassName="space-y-5">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-5">
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge tone="emerald">
                <Sparkle className="w-3.5 h-3.5" weight="fill" />
                <span>Minimalist Quick-Split Hub</span>
              </StatusBadge>
              <CurrencyPrecisionPill currencyCode={dataset.currentUser.defaultCurrency || 'INR'} />
            </div>
            <h1 className="text-xl sm:text-2xl font-extrabold tracking-tight text-slate-900 dark:text-slate-100">
              Welcome back, {dataset.currentUser.fullName}
            </h1>
            <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400">
              Instant overview of your net balances across {allActiveGroups.length} active groups and{' '}
              {directExpenses.length} direct non-group splits.
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

        {/* Primary Quick Actions Row */}
        <div className="flex flex-wrap items-center justify-between gap-2.5 pt-3 border-t border-slate-200/70 dark:border-white/10">
          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              data-testid="home-quick-add-expense-btn"
              onClick={() => handleTriggerAddExpense(null, null)}
              className="inline-flex items-center gap-2 rounded-xl bg-[#059669] hover:bg-emerald-600 text-white px-4 py-2.5 text-xs font-bold shadow-md shadow-emerald-600/20 transition-all cursor-pointer"
            >
              <Plus className="w-4 h-4" weight="bold" />
              <span>+ Quick Add Expense</span>
            </button>

            <button
              type="button"
              data-testid="home-quick-settle-btn"
              onClick={() => setActivePage('friends')}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 dark:border-white/15 bg-slate-50 dark:bg-slate-800/90 hover:bg-slate-100 dark:hover:bg-slate-800 px-3.5 py-2.5 text-xs font-semibold text-slate-700 dark:text-slate-200 transition-colors cursor-pointer"
            >
              <HandCoins className="w-4 h-4 text-[#059669]" weight="bold" />
              <span>Settle Up</span>
            </button>

            <button
              type="button"
              data-testid="home-view-all-groups-btn"
              onClick={() => setActivePage('groups')}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 dark:border-white/15 bg-slate-50 dark:bg-slate-800/90 hover:bg-slate-100 dark:hover:bg-slate-800 px-3.5 py-2.5 text-xs font-semibold text-slate-700 dark:text-slate-200 transition-colors cursor-pointer"
            >
              <UsersThree className="w-4 h-4 text-[#059669]" weight="bold" />
              <span>All Groups ({allActiveGroups.length})</span>
            </button>
          </div>

          <button
            type="button"
            data-testid="home-open-help-btn"
            onClick={handleTriggerHelp}
            className="inline-flex items-center gap-1.5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 hover:bg-emerald-500/20 px-3.5 py-2 text-xs font-semibold text-emerald-700 dark:text-emerald-300 transition-colors cursor-pointer"
          >
            <Question className="w-4 h-4" weight="bold" />
            <span>How It Works / Help</span>
          </button>
        </div>
      </DoubleBezelCard>

      {/* 2. Recently Accessed or Updated Groups (Strictly At Most 3 Groups) */}
      <section className="space-y-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <ClockCounterClockwise className="w-5 h-5 text-[#059669]" weight="duotone" />
            <h2 className="text-sm sm:text-base font-bold tracking-tight text-slate-900 dark:text-slate-100">
              Recently Active Groups (Top 3)
            </h2>
            <StatusBadge tone="slate">Max 3 Shown</StatusBadge>
          </div>

          <button
            type="button"
            onClick={() => setActivePage('groups')}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 dark:border-white/15 bg-white dark:bg-slate-900 hover:border-emerald-500/40 px-3 py-1.5 text-xs font-bold text-slate-700 dark:text-slate-200 transition-colors cursor-pointer"
          >
            <span>View All ({allActiveGroups.length})</span>
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

                  <div className="flex items-center justify-between rounded-xl border border-slate-200/70 dark:border-white/10 bg-slate-50/80 dark:bg-slate-900/60 px-3 py-2">
                    <div className="text-xs text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
                      <Users className="w-3.5 h-3.5 text-[#059669]" weight="bold" />
                      <span>
                        {group.members.length} members | {activeBillsCount} bills
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
                      <div className="text-[10px] text-slate-400">
                        {myNetMinor > 0
                          ? 'you are owed'
                          : myNetMinor < 0
                          ? 'you owe'
                          : 'settled'}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 pt-2 border-t border-slate-200/70 dark:border-white/10">
                  <button
                    type="button"
                    data-testid={`open-group-workspace-${group.id}`}
                    onClick={() => handleOpenGroupWorkspace(group.id)}
                    className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-slate-900 dark:bg-white text-white dark:text-slate-900 hover:opacity-90 px-3 py-2 text-xs font-bold transition-opacity cursor-pointer"
                  >
                    <FolderOpen className="w-3.5 h-3.5" weight="bold" />
                    <span>Open Group Workspace</span>
                  </button>

                  <button
                    type="button"
                    data-testid={`home-add-group-expense-${group.id}`}
                    onClick={() => handleTriggerAddExpense(group.id, null)}
                    className="inline-flex items-center justify-center gap-1 rounded-xl bg-[#059669] hover:bg-emerald-600 text-white px-3 py-2 text-xs font-bold transition-colors cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" weight="bold" />
                    <span>+ Add Bill to Group</span>
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
                Direct Non-Group Splits ({directExpenses.length})
              </h2>
              <StatusBadge tone="blue">No Group Required</StatusBadge>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Standalone 1-on-1 or ad-hoc expenses split directly between people without creating a group.
            </p>
          </div>

          <button
            type="button"
            data-testid="home-new-direct-split-btn"
            onClick={() => handleTriggerAddExpense(null, null)}
            className="inline-flex items-center gap-1.5 rounded-xl bg-[#059669] hover:bg-emerald-600 text-white px-3.5 py-2 text-xs font-bold shadow-sm transition-colors cursor-pointer"
          >
            <Plus className="w-4 h-4" weight="bold" />
            <span>+ New Direct Split (No Group)</span>
          </button>
        </div>

        <div data-testid="home-direct-expenses-list" className="space-y-3">
          {directExpenses.length === 0 ? (
            <DoubleBezelCard innerClassName="text-center py-8 space-y-2">
              <Receipt className="w-7 h-7 text-slate-400 mx-auto" weight="duotone" />
              <div className="text-sm font-bold text-slate-700 dark:text-slate-300">
                No standalone direct splits yet
              </div>
              <p className="text-xs text-slate-500">
                Click &quot;+ New Direct Split (No Group)&quot; to split a coffee, cab, or meal directly with friends.
              </p>
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

              return (
                <DoubleBezelCard
                  key={exp.id}
                  testId={`direct-expense-card-${exp.id}`}
                  innerClassName="space-y-3"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <StatusBadge tone="blue">Direct Non-Group Split</StatusBadge>
                        <StatusBadge tone="emerald">
                          {catMeta?.label ?? exp.category.toUpperCase()}
                        </StatusBadge>
                        <StatusBadge tone="slate">{exp.splitMode.toUpperCase()} SPLIT</StatusBadge>
                      </div>
                      <h3 className="text-sm sm:text-base font-bold text-slate-900 dark:text-slate-100">
                        {exp.title}
                      </h3>
                      <div className="text-xs font-mono text-slate-500 dark:text-slate-400">
                        {exp.expenseDate} | Paid by {payerSummary}
                      </div>
                    </div>

                    <div className="text-right">
                      <div className="text-base sm:text-lg font-extrabold font-mono tabular-nums text-slate-900 dark:text-slate-100">
                        <CurrencyAmount
                          minorAmount={exp.amountMinor}
                          currencyCode={exp.groupCurrency}
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
