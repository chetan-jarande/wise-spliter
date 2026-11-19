import React, { useMemo, useState } from 'react';
import {
  ArrowRightIcon as ArrowRight,
  ArrowsLeftRightIcon as ArrowsLeftRight,
  CheckCircleIcon as CheckCircle,
  ClockCounterClockwiseIcon as ClockCounterClockwise,
  CloudArrowUpIcon as CloudArrowUp,
  CloudSlashIcon as CloudSlash,
  FolderOpenIcon as FolderOpen,
  HandCoinsIcon as HandCoins,
  HouseIcon as House,
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
import { canDeleteDirectSettlement } from '../../utils/direct-settlements';
import { ExpenseItem, GroupRecord } from '../../types/ledger';
import {
  CurrencyAmount,
  CurrencyPrecisionPill,
  DoubleBezelCard,
  PersonalExpenseImpactBadge,
  SpatialActionTile,
  StatusBadge,
} from '../primitives/DesignPrimitives';
import { convertMinorAmountWithFx, formatMinorToMajor } from '../../domain/money/currencies';
import {
  computeCrossGroupFriendsSummary,
  computeGroupNetBalances,
} from '../../domain/ledger/ledger-engine';
import { ExpenseEditorModal } from '../modals/ExpenseEditorModal';
import { HelpGuideModal } from '../modals/HelpGuideModal';
import { JoinGroupForm } from '../components/GroupManagement';
import { parseInviteCode } from '../../utils/expense-search';

const PENDING_JOIN_KEY = 'ws_pending_join_code';

function readPendingJoinCode(): string | null {
  try {
    const fromUrl = parseInviteCode(new URLSearchParams(window.location.search).get('join') ?? '');
    if (fromUrl) sessionStorage.setItem(PENDING_JOIN_KEY, fromUrl);
    return fromUrl ?? parseInviteCode(sessionStorage.getItem(PENDING_JOIN_KEY) ?? '');
  } catch {
    return null;
  }
}

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
    isOnline,
    pendingOutboxCount,
    setActiveGroupId,
    setActivePage,
    softDeleteExpense,
    deleteSettlement,
    getFxQuote,
  } = useLedger();

  // Local modal states so HomeDashboardPage always opens ExpenseEditorModal & HelpGuideModal cleanly
  const [isExpenseModalOpen, setIsExpenseModalOpen] = useState(false);
  const [modalDefaultGroupId, setModalDefaultGroupId] = useState<string | null>(null);
  const [editingExpense, setEditingExpense] = useState<ExpenseItem | null>(null);
  const [isHelpModalOpen, setIsHelpModalOpen] = useState(false);
  const [pendingJoinCode, setPendingJoinCode] = useState<string | null>(readPendingJoinCode);

  const clearPendingJoin = () => {
    setPendingJoinCode(null);
    try {
      sessionStorage.removeItem(PENDING_JOIN_KEY);
      const url = new URL(window.location.href);
      url.searchParams.delete('join');
      window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
    } catch {
      // URL cleanup is best effort
    }
  };
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

  // 1. Cross-Group & Direct Split Net Position in the user's currency (rates only from getFxQuote)
  const displayCurrency = (dataset.currentUser.defaultCurrency || 'INR').toUpperCase();
  const friendsSummary = useMemo(
    () =>
      computeCrossGroupFriendsSummary(
        dataset.currentUser.email,
        dataset.groups,
        dataset.expenses,
        dataset.settlements,
        {}
      ),
    [dataset.currentUser.email, dataset.groups, dataset.expenses, dataset.settlements]
  );

  const crossGroupTotals = useMemo(() => {
    let youAreOwedInrMinor = 0;
    let youOweInrMinor = 0;
    let oldestRateDate: string | null = null;
    const unconverted = new Map<string, { owed: number; owe: number }>();
    for (const friend of friendsSummary) {
      let net = 0;
      const perCurrency = new Map<string, number>();
      for (const bd of friend.groupBreakdowns) {
        const code = bd.currency.toUpperCase();
        if (code === displayCurrency) {
          net += bd.netMinor;
          continue;
        }
        const quote = getFxQuote(code, displayCurrency);
        if (!quote) {
          perCurrency.set(code, (perCurrency.get(code) ?? 0) + bd.netMinor);
          continue;
        }
        net += convertMinorAmountWithFx({
          originalMinor: bd.netMinor,
          fromCurrency: code,
          toCurrency: displayCurrency,
          fxRateScaled: quote.rateScaled,
          fxStatus: quote.status,
          dateIso: quote.rateDate,
        }).convertedMinor;
        if (!oldestRateDate || quote.rateDate < oldestRateDate) oldestRateDate = quote.rateDate;
      }
      if (net > 0) youAreOwedInrMinor += net;
      else youOweInrMinor -= net;
      for (const [code, amt] of perCurrency) {
        const t = unconverted.get(code) ?? { owed: 0, owe: 0 };
        if (amt > 0) t.owed += amt;
        else t.owe -= amt;
        unconverted.set(code, t);
      }
    }
    return {
      youAreOwedInrMinor,
      youOweInrMinor,
      netBalanceInrMinor: youAreOwedInrMinor - youOweInrMinor,
      oldestRateDate,
      unconverted: [...unconverted.entries()].filter(([, t]) => t.owed !== 0 || t.owe !== 0),
    };
  }, [friendsSummary, displayCurrency, getFxQuote]);

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

  const firstName = dataset.currentUser.fullName.trim().split(/\s+/)[0] || 'there';
  const latestGroup = recentTop3Groups[0];

  return (
    <div data-testid="home-dashboard-page" className="space-y-6 min-w-0">
      {/* 1. Ombria Editorial Spatial Greeting Header */}
      <header className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 pt-1 min-w-0">
        <div className="space-y-2 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone={isOnline ? 'emerald' : 'amber'}>
              {isOnline ? (
                <>
                  <CloudArrowUp className="w-3.5 h-3.5" weight="bold" aria-hidden="true" />
                  <span>Cloud synced</span>
                </>
              ) : (
                <>
                  <CloudSlash className="w-3.5 h-3.5" weight="bold" aria-hidden="true" />
                  <span>Offline ({pendingOutboxCount} queued)</span>
                </>
              )}
            </StatusBadge>
            <CurrencyPrecisionPill currencyCode={dataset.currentUser.defaultCurrency || 'INR'} />
            <StatusBadge tone="slate">
              {allActiveGroups.length} {allActiveGroups.length === 1 ? 'group' : 'groups'}
            </StatusBadge>
          </div>

          <h1
            dir="auto"
            className="text-2xl sm:text-3xl lg:text-[34px] font-medium tracking-tight leading-[1.15] text-[#141715] dark:text-[#F3F5F3] truncate"
          >
            Welcome back, {firstName}
          </h1>

          <p
            data-testid="home-plain-english-hero-summary"
            className="text-sm sm:text-base font-medium text-[#4A524D] dark:text-[#B7BEB9] break-words"
          >
            {crossGroupTotals.netBalanceInrMinor > 0 ? (
              <>
                Overall, you are owed{' '}
                <span className="text-emerald-700 dark:text-emerald-300 font-semibold font-mono tabular-nums whitespace-nowrap">
                  +{formatMinorToMajor(crossGroupTotals.netBalanceInrMinor, displayCurrency)}
                </span>{' '}
                across {allActiveGroups.length} active {allActiveGroups.length === 1 ? 'group' : 'groups'} and{' '}
                {directExpenses.length} direct {directExpenses.length === 1 ? 'split' : 'splits'}.
              </>
            ) : crossGroupTotals.netBalanceInrMinor < 0 ? (
              <>
                Overall, you owe{' '}
                <span className="text-rose-700 dark:text-rose-300 font-semibold font-mono tabular-nums whitespace-nowrap">
                  {formatMinorToMajor(Math.abs(crossGroupTotals.netBalanceInrMinor), displayCurrency)}
                </span>{' '}
                across {allActiveGroups.length} active {allActiveGroups.length === 1 ? 'group' : 'groups'} and{' '}
                {directExpenses.length} direct {directExpenses.length === 1 ? 'split' : 'splits'}.
              </>
            ) : crossGroupTotals.unconverted.length > 0 ? (
              <span>Your open balances are held in other currencies.</span>
            ) : (
              <span className="text-emerald-700 dark:text-emerald-300 font-semibold">
                You are all settled up across every group and direct split.
              </span>
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {isQuickStartDismissed && (
            <button
              type="button"
              onClick={() => handleDismissQuickStart(false)}
              className="lg-scene-tile min-h-[44px] inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-xs font-semibold text-[#141715] dark:text-[#F3F5F3] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
            >
              <Sparkle className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-300" weight="fill" aria-hidden="true" />
              <span>3-Step Guide</span>
            </button>
          )}
          <button
            type="button"
            onClick={() =>
              latestGroup ? handleOpenGroupWorkspace(latestGroup.id) : setActivePage('groups')
            }
            className="lg-luminous-pill min-h-[44px] max-w-full inline-flex items-center gap-2 rounded-full px-4 py-2.5 text-xs sm:text-[13px] font-semibold cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
          >
            <FolderOpen className="w-4 h-4 shrink-0" weight="bold" aria-hidden="true" />
            <span className="truncate max-w-[200px]">
              {latestGroup ? `Resume ${latestGroup.name}` : 'Create a Group'}
            </span>
            <ArrowRight className="w-3.5 h-3.5 shrink-0 opacity-75" weight="bold" aria-hidden="true" />
          </button>
        </div>
      </header>

      {/* 2. Horizontal Tactile Scene Action Capsules Row (Ombria Glass Scene Pills) */}
      <section aria-label="Quick ledger actions" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <SpatialActionTile
          active
          testId="home-quick-add-expense-btn"
          onClick={() => handleTriggerAddExpense(null, null)}
          icon={<Plus className="w-4 h-4" weight="bold" />}
          title="Split a Bill"
          subtitle="Group or 1-on-1 expense"
        />
        <SpatialActionTile
          testId="home-quick-settle-btn"
          onClick={() => setActivePage('friends')}
          icon={<HandCoins className="w-4 h-4 text-emerald-700 dark:text-emerald-300" weight="duotone" />}
          title="Settle Up"
          subtitle="UPI QR & net balances"
        />
        <SpatialActionTile
          testId="home-view-all-groups-btn"
          onClick={() => setActivePage('groups')}
          icon={<UsersThree className="w-4 h-4 text-emerald-700 dark:text-emerald-300" weight="duotone" />}
          title={`All Groups (${allActiveGroups.length})`}
          subtitle="Trips, home & shared tabs"
        />
        <SpatialActionTile
          testId="home-open-help-btn"
          onClick={handleTriggerHelp}
          icon={<Question className="w-4 h-4 text-emerald-700 dark:text-emerald-300" weight="duotone" />}
          title="How It Works"
          subtitle="Interactive walkthrough"
        />
      </section>

      {pendingJoinCode && (
        <DoubleBezelCard testId="home-join-invite-card" innerClassName="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm sm:text-base font-semibold text-[#141715] dark:text-[#F3F5F3]">
              You have a group invite
            </h2>
            <button
              type="button"
              data-testid="home-join-invite-dismiss"
              onClick={clearPendingJoin}
              className="lg-scene-tile min-h-[44px] rounded-full px-3.5 text-xs font-semibold text-[#4A524D] dark:text-[#B7BEB9] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
            >
              Not now
            </button>
          </div>
          <p className="text-xs text-[#5C6660] dark:text-[#9CA69F]">
            Join to see the group&apos;s bills and balances. You need to be signed in.
          </p>
          <JoinGroupForm initialCode={pendingJoinCode} onJoined={clearPendingJoin} />
        </DoubleBezelCard>
      )}

      {/* 3. Spatial Bento Grid (12-Column Architecture) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch min-w-0">
        {/* Net Position / Owed / You Owe Sculpted Glass Metric Chamber */}
        <DoubleBezelCard
          className={isQuickStartDismissed ? 'lg:col-span-12' : 'lg:col-span-7 xl:col-span-8'}
          innerClassName="flex flex-col justify-between gap-4 min-w-0"
        >
          <div className="flex flex-wrap items-start justify-between gap-2 min-w-0">
            <div className="space-y-1 min-w-0">
              <h2 className="text-sm sm:text-base font-semibold tracking-tight text-[#141715] dark:text-[#F3F5F3]">
                Balance overview
              </h2>
              <p className="text-xs text-[#5C6660] dark:text-[#9CA69F]">
                Exact integer minor-unit standing normalized to {displayCurrency}
              </p>
            </div>
            <StatusBadge
              tone={
                crossGroupTotals.netBalanceInrMinor > 0
                  ? 'emerald'
                  : crossGroupTotals.netBalanceInrMinor < 0
                  ? 'rose'
                  : 'slate'
              }
            >
              {crossGroupTotals.netBalanceInrMinor > 0
                ? 'Net positive'
                : crossGroupTotals.netBalanceInrMinor < 0
                ? 'Balance due'
                : 'Settled 0.00'}
            </StatusBadge>
          </div>

          <div
            data-testid="home-stat-tiles"
            className="grid grid-cols-1 md:grid-cols-3 gap-3 min-w-0"
          >
            <div className="lg-recessed-well rounded-[1.25rem] px-4 py-3.5 min-w-0 flex items-center justify-between gap-3 md:flex-col md:items-start md:justify-between border-emerald-600/20 dark:border-emerald-400/20">
              <div className="text-xs font-medium text-emerald-800 dark:text-emerald-300">
                You are owed
              </div>
              <div
                data-testid="home-you-are-owed-amount"
                className="md:mt-2 shrink-0 whitespace-nowrap text-base md:text-sm xl:text-lg font-semibold font-mono tabular-nums text-emerald-700 dark:text-emerald-300"
              >
                <CurrencyAmount
                  minorAmount={crossGroupTotals.youAreOwedInrMinor}
                  currencyCode={displayCurrency}
                  showPlusSign
                />
              </div>
            </div>

            <div className="lg-recessed-well rounded-[1.25rem] px-4 py-3.5 min-w-0 flex items-center justify-between gap-3 md:flex-col md:items-start md:justify-between border-rose-600/20 dark:border-rose-400/20">
              <div className="text-xs font-medium text-rose-800 dark:text-rose-300">
                You owe
              </div>
              <div
                data-testid="home-you-owe-amount"
                className="md:mt-2 shrink-0 whitespace-nowrap text-base md:text-sm xl:text-lg font-semibold font-mono tabular-nums text-rose-700 dark:text-rose-300"
              >
                <CurrencyAmount
                  minorAmount={crossGroupTotals.youOweInrMinor}
                  currencyCode={displayCurrency}
                />
              </div>
            </div>

            <div className="lg-recessed-well rounded-[1.25rem] px-4 py-3.5 min-w-0 flex items-center justify-between gap-3 md:flex-col md:items-start md:justify-between">
              <div className="text-xs font-medium text-[#4A524D] dark:text-[#B7BEB9]">
                Net balance
              </div>
              <div
                data-testid="home-net-balance-amount"
                className="md:mt-2 shrink-0 whitespace-nowrap text-base md:text-sm xl:text-lg font-semibold font-mono tabular-nums text-[#141715] dark:text-[#F3F5F3]"
              >
                <CurrencyAmount
                  minorAmount={crossGroupTotals.netBalanceInrMinor}
                  currencyCode={displayCurrency}
                  colorize
                  showPlusSign
                />
              </div>
            </div>
          </div>

          {(crossGroupTotals.oldestRateDate || crossGroupTotals.unconverted.length > 0) && (
            <p
              data-testid="home-fx-note"
              className="text-[11px] text-[#5C6660] dark:text-[#9CA69F] break-words"
            >
              {crossGroupTotals.oldestRateDate &&
                `Approx., rates from ${crossGroupTotals.oldestRateDate}. `}
              {crossGroupTotals.unconverted.length > 0 && (
                <span data-testid="home-unconverted-totals">
                  Not included, no rate yet:{' '}
                  {crossGroupTotals.unconverted
                    .map(([code, t]) =>
                      [
                        t.owed ? `owed ${formatMinorToMajor(t.owed, code)}` : '',
                        t.owe ? `you owe ${formatMinorToMajor(t.owe, code)}` : '',
                      ]
                        .filter(Boolean)
                        .join(', ')
                    )
                    .join('; ')}
                </span>
              )}
            </p>
          )}
        </DoubleBezelCard>

        {/* Dismissible 3-Step Onboarding Chamber */}
        {!isQuickStartDismissed && (
          <DoubleBezelCard
            testId="first-time-quickstart-strip"
            className="lg:col-span-5 xl:col-span-4"
            innerClassName="flex flex-col justify-between gap-3 min-w-0"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="lg-icon-orb h-7 w-7 rounded-full flex items-center justify-center shrink-0">
                  <Sparkle className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-300" weight="fill" aria-hidden="true" />
                </span>
                <h2 className="text-xs sm:text-sm font-semibold text-[#141715] dark:text-[#F3F5F3] truncate">
                  Get started in 3 quick taps
                </h2>
              </div>
              <button
                type="button"
                data-testid="dismiss-quickstart-btn"
                onClick={() => handleDismissQuickStart(true)}
                aria-label="Dismiss 3-step quick start guide"
                className="lg-scene-tile min-h-[44px] min-w-[44px] justify-center inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium text-[#4A524D] dark:text-[#B7BEB9] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
              >
                <span>Hide</span>
                <X className="w-3.5 h-3.5" weight="bold" aria-hidden="true" />
              </button>
            </div>

            <div className="grid grid-cols-1 gap-2">
              <button
                type="button"
                onClick={() => setActivePage('groups')}
                className="lg-scene-tile min-h-[48px] flex items-center gap-3 rounded-2xl px-3 py-2.5 text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
              >
                <span className="lg-icon-orb h-7 w-7 shrink-0 rounded-full flex items-center justify-center text-xs font-mono font-semibold text-emerald-800 dark:text-emerald-300">
                  {allActiveGroups.length > 0 ? (
                    <CheckCircle className="w-4 h-4 text-emerald-700 dark:text-emerald-300" weight="fill" aria-hidden="true" />
                  ) : (
                    '1'
                  )}
                </span>
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-[#141715] dark:text-[#F3F5F3] truncate">
                    Pick or create a group
                  </div>
                  <p className="text-[11px] text-[#5C6660] dark:text-[#9CA69F] truncate">
                    Trips, roommates, or 1-on-1 by name
                  </p>
                </div>
              </button>

              <button
                type="button"
                onClick={() => handleTriggerAddExpense(null, null)}
                className="lg-scene-tile min-h-[48px] flex items-center gap-3 rounded-2xl px-3 py-2.5 text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
              >
                <span className="lg-icon-orb h-7 w-7 shrink-0 rounded-full flex items-center justify-center text-xs font-mono font-semibold text-emerald-800 dark:text-emerald-300">
                  {hasActiveExpenses ? (
                    <CheckCircle className="w-4 h-4 text-emerald-700 dark:text-emerald-300" weight="fill" aria-hidden="true" />
                  ) : (
                    '2'
                  )}
                </span>
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-[#141715] dark:text-[#F3F5F3] truncate">
                    Log a shared bill
                  </div>
                  <p className="text-[11px] text-[#5C6660] dark:text-[#9CA69F] truncate">
                    Equal, exact, % or multi-payer offline
                  </p>
                </div>
              </button>

              <button
                type="button"
                onClick={() => setActivePage('friends')}
                className="lg-scene-tile min-h-[48px] flex items-center gap-3 rounded-2xl px-3 py-2.5 text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
              >
                <span className="lg-icon-orb h-7 w-7 shrink-0 rounded-full flex items-center justify-center text-xs font-mono font-semibold text-emerald-800 dark:text-emerald-300">
                  {hasRecordedSettlements ? (
                    <CheckCircle className="w-4 h-4 text-emerald-700 dark:text-emerald-300" weight="fill" aria-hidden="true" />
                  ) : (
                    '3'
                  )}
                </span>
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-[#141715] dark:text-[#F3F5F3] truncate">
                    Settle via UPI or WhatsApp
                  </div>
                  <p className="text-[11px] text-[#5C6660] dark:text-[#9CA69F] truncate">
                    Scan QR or copy verified summary
                  </p>
                </div>
              </button>
            </div>
          </DoubleBezelCard>
        )}

        {/* Recently Active Groups (Strictly Top 3) */}
        <section className="lg:col-span-12 space-y-3.5 pt-1 min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="lg-icon-orb h-8 w-8 rounded-full flex items-center justify-center shrink-0">
                <ClockCounterClockwise className="w-4 h-4 text-[#141715] dark:text-[#F3F5F3]" weight="duotone" aria-hidden="true" />
              </span>
              <div className="flex flex-wrap items-center gap-2 min-w-0">
                <h2 className="text-base sm:text-lg font-semibold tracking-tight text-[#141715] dark:text-[#F3F5F3]">
                  Recently active groups
                </h2>
                <StatusBadge tone="slate">Top 3</StatusBadge>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setActivePage('groups')}
              className="lg-scene-tile min-h-[44px] inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-xs font-semibold text-[#141715] dark:text-[#F3F5F3] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
            >
              <span>Browse {allActiveGroups.length} groups</span>
              <ArrowRight className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-300" weight="bold" aria-hidden="true" />
            </button>
          </div>

          <div
            data-testid="home-recent-groups-grid"
            className="grid grid-cols-1 md:grid-cols-3 gap-4 min-w-0"
          >
            {recentTop3Groups.length === 0 ? (
              <DoubleBezelCard className="md:col-span-3" innerClassName="text-center py-8 space-y-3">
                <span className="lg-icon-orb h-11 w-11 rounded-2xl flex items-center justify-center mx-auto">
                  <UsersThree className="w-5 h-5 text-[#4A524D] dark:text-[#B7BEB9]" weight="duotone" aria-hidden="true" />
                </span>
                <div className="space-y-1">
                  <div className="text-sm font-semibold text-[#141715] dark:text-[#F3F5F3]">
                    No active groups yet
                  </div>
                  <p className="text-xs text-[#5C6660] dark:text-[#9CA69F] max-w-md mx-auto">
                    Start a shared ledger for a trip, household, or recurring event.
                  </p>
                </div>
              </DoubleBezelCard>
            ) : (
              recentTop3Groups.map((group) => {
                const myNetMinor = getMyNetInGroup(group);
                const activeBillsCount = dataset.expenses.filter(
                  (e) => e.groupId === group.id && !e.deletedAt
                ).length;
                const activeMembersCount = group.members.filter((m) => !m.removedAt).length;

                return (
                  <DoubleBezelCard
                    key={group.id}
                    testId={`home-recent-group-card-${group.id}`}
                    innerClassName="flex flex-col justify-between gap-4 min-w-0"
                  >
                    <div className="space-y-3 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="lg-icon-orb h-9 w-9 rounded-2xl flex items-center justify-center shrink-0">
                            <House className="w-4 h-4 text-emerald-700 dark:text-emerald-300" weight="duotone" aria-hidden="true" />
                          </span>
                          <StatusBadge tone="emerald" className="capitalize">
                            {group.category}
                          </StatusBadge>
                        </div>
                        <CurrencyPrecisionPill currencyCode={group.baseCurrency} />
                      </div>

                      <div className="min-w-0 space-y-0.5">
                        <h3
                          dir="auto"
                          title={group.name}
                          className="text-base font-semibold tracking-tight text-[#141715] dark:text-[#F3F5F3] truncate"
                        >
                          {group.name}
                        </h3>
                        <p className="text-xs text-[#5C6660] dark:text-[#9CA69F] line-clamp-1 break-words">
                          {group.description || 'Shared group ledger'}
                        </p>
                      </div>

                      <div className="lg-recessed-well rounded-2xl px-3.5 py-2.5 flex items-center justify-between gap-2 min-w-0">
                        <div className="text-xs text-[#5C6660] dark:text-[#9CA69F] flex items-center gap-1.5 min-w-0">
                          <Users className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-300 shrink-0" weight="bold" aria-hidden="true" />
                          <span className="truncate">
                            {activeMembersCount} people, {activeBillsCount} bills
                          </span>
                        </div>

                        <div className="text-right shrink-0">
                          <div className="text-xs font-semibold font-mono tabular-nums whitespace-nowrap">
                            <CurrencyAmount
                              minorAmount={myNetMinor}
                              currencyCode={group.baseCurrency}
                              colorize
                              showPlusSign
                            />
                          </div>
                          <div
                            className={`text-[10px] font-medium ${
                              myNetMinor > 0
                                ? 'text-emerald-700 dark:text-emerald-300'
                                : myNetMinor < 0
                                ? 'text-rose-700 dark:text-rose-300'
                                : 'text-[#68726C] dark:text-[#8A938D]'
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

                    <div className="grid grid-cols-2 gap-2 pt-1">
                      <button
                        type="button"
                        data-testid={`open-group-workspace-${group.id}`}
                        onClick={() => handleOpenGroupWorkspace(group.id)}
                        className="lg-luminous-pill min-h-[44px] inline-flex items-center justify-center gap-1.5 rounded-full px-3 py-2 text-xs font-semibold cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
                      >
                        <FolderOpen className="w-3.5 h-3.5 shrink-0" weight="bold" aria-hidden="true" />
                        <span className="truncate">Open Group</span>
                      </button>

                      <button
                        type="button"
                        data-testid={`home-add-group-expense-${group.id}`}
                        onClick={() => handleTriggerAddExpense(group.id, null)}
                        className="lg-scene-tile min-h-[44px] inline-flex items-center justify-center gap-1.5 rounded-full px-3 py-2 text-xs font-semibold text-[#141715] dark:text-[#F3F5F3] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
                      >
                        <Plus className="w-3.5 h-3.5 shrink-0 text-emerald-700 dark:text-emerald-300" weight="bold" aria-hidden="true" />
                        <span className="truncate">Add Bill</span>
                      </button>
                    </div>
                  </DoubleBezelCard>
                );
              })
            )}
          </div>
        </section>

        {/* Direct Non-Group Splits (groupId === null) */}
        <section className="lg:col-span-12 pt-1 min-w-0">
          <DoubleBezelCard innerClassName="space-y-4 min-w-0">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-start gap-3 min-w-0">
                <span className="lg-icon-orb h-9 w-9 rounded-full flex items-center justify-center shrink-0 mt-0.5">
                  <ArrowsLeftRight className="w-4 h-4 text-[#141715] dark:text-[#F3F5F3]" weight="duotone" aria-hidden="true" />
                </span>
                <div className="space-y-0.5 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-base sm:text-lg font-semibold tracking-tight text-[#141715] dark:text-[#F3F5F3]">
                      Direct 1-on-1 splits ({directExpenses.length})
                    </h2>
                    <StatusBadge tone="blue">No group needed</StatusBadge>
                  </div>
                  <p className="text-xs text-[#5C6660] dark:text-[#9CA69F]">
                    Quick bills shared directly with friends for coffee, cabs, or dinner without setting up a group.
                  </p>
                </div>
              </div>

              <button
                type="button"
                data-testid="home-new-direct-split-btn"
                onClick={() => handleTriggerAddExpense(null, null)}
                className="lg-scene-tile min-h-[44px] inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-xs font-semibold text-[#141715] dark:text-[#F3F5F3] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
              >
                <Plus className="w-4 h-4 text-emerald-700 dark:text-emerald-300" weight="bold" aria-hidden="true" />
                <span>New 1-on-1 Split</span>
              </button>
            </div>

            <div data-testid="home-direct-expenses-list" className="space-y-3 min-w-0">
              {directExpenses.length === 0 ? (
                <div className="lg-recessed-well rounded-[1.25rem] text-center py-8 px-4 space-y-2.5">
                  <span className="lg-icon-orb h-10 w-10 rounded-full flex items-center justify-center mx-auto">
                    <Receipt className="w-5 h-5 text-[#4A524D] dark:text-[#B7BEB9]" weight="duotone" aria-hidden="true" />
                  </span>
                  <div className="text-sm font-semibold text-[#141715] dark:text-[#F3F5F3]">
                    No direct 1-on-1 splits yet
                  </div>
                  <p className="text-xs text-[#5C6660] dark:text-[#9CA69F] max-w-md mx-auto">
                    Splitting a quick coffee, cab, or lunch with one friend? Tap &ldquo;New 1-on-1 Split&rdquo; above to record it right away.
                  </p>
                </div>
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
                    <div
                      key={exp.id}
                      data-testid={`direct-expense-card-${exp.id}`}
                      className="lg-recessed-well rounded-[1.25rem] p-4 space-y-3 min-w-0"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3 min-w-0">
                        <div className="space-y-1 min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <StatusBadge tone="blue">Direct split</StatusBadge>
                            <StatusBadge tone="emerald">
                              {catMeta?.label ?? exp.category}
                            </StatusBadge>
                            <StatusBadge tone="slate" className="capitalize">
                              {exp.splitMode} split
                            </StatusBadge>
                          </div>
                          <h3
                            dir="auto"
                            title={exp.title}
                            className="text-sm sm:text-base font-semibold text-[#141715] dark:text-[#F3F5F3] truncate"
                          >
                            {exp.title}
                          </h3>
                          <div className="text-xs text-[#5C6660] dark:text-[#9CA69F] break-words">
                            <span className="font-mono">{exp.expenseDate}</span> - Paid by {payerSummary}
                          </div>
                        </div>

                        <div className="text-right space-y-1 shrink-0">
                          <div className="text-base sm:text-lg font-semibold font-mono tabular-nums text-[#141715] dark:text-[#F3F5F3] whitespace-nowrap">
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
                            <div className="text-xs font-mono tabular-nums text-[#5C6660] dark:text-[#9CA69F]">
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
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
                        {exp.splits
                          .filter((s) => s.included)
                          .map((s) => {
                            const participant = participants.find((p) => p.id === s.memberId);
                            return (
                              <div
                                key={s.memberId}
                                className="lg-scene-tile flex items-center justify-between gap-2 rounded-xl px-3 py-2 min-w-0"
                              >
                                <div className="flex items-center gap-2 min-w-0">
                                  <span className="lg-icon-orb inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-mono font-semibold text-emerald-800 dark:text-emerald-300">
                                    {participant?.avatarInitials ?? 'FR'}
                                  </span>
                                  <span
                                    dir="auto"
                                    title={participantNameOf(s.memberId)}
                                    className="text-xs font-medium text-[#141715] dark:text-[#F3F5F3] truncate"
                                  >
                                    {participantNameOf(s.memberId)}
                                  </span>
                                </div>
                                <span className="text-xs font-semibold font-mono tabular-nums text-[#141715] dark:text-[#F3F5F3] shrink-0 whitespace-nowrap">
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
                        <p className="text-xs text-[#5C6660] dark:text-[#9CA69F] break-words">
                          {exp.notes}
                        </p>
                      )}

                      {dataset.settlements.some((st) => st.expenseId === exp.id && !st.deletedAt) && (
                        <ul className="space-y-1.5" aria-label="Payments on this bill">
                          {dataset.settlements
                            .filter((st) => st.expenseId === exp.id && !st.deletedAt)
                            .map((st) => (
                              <li
                                key={st.id}
                                data-testid={`direct-settlement-${st.id}`}
                                className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-emerald-500/10 border border-emerald-600/20 dark:border-emerald-400/20 px-3 py-2 text-xs text-[#2B312D] dark:text-[#DCE2DD]"
                              >
                                <span className="min-w-0 break-words">
                                  {participantNameOf(st.fromMemberId)} paid {participantNameOf(st.toMemberId)}{' '}
                                  <CurrencyAmount minorAmount={st.amountMinor} currencyCode={st.currency} /> on{' '}
                                  <span className="font-mono">{st.settledDate}</span>
                                </span>
                                {canDeleteDirectSettlement(st, exp, dataset.currentUser.email, dataset.currentUser.id) && (
                                  <button
                                    type="button"
                                    data-testid={`delete-settlement-${st.id}`}
                                    onClick={() => deleteSettlement(st.id)}
                                    className="min-h-[44px] rounded-full px-3 py-1 font-semibold text-rose-700 dark:text-rose-300 hover:bg-rose-500/12 transition-colors cursor-pointer"
                                  >
                                    Remove
                                  </button>
                                )}
                              </li>
                            ))}
                        </ul>
                      )}

                      <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-black/[0.07] dark:border-white/[0.08]">
                        <div className="flex items-center gap-1.5 text-[11px] text-[#5C6660] dark:text-[#9CA69F] min-w-0">
                          <CheckCircle className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-300 shrink-0" weight="fill" aria-hidden="true" />
                          <span className="truncate">
                            Participants:{' '}
                            {participants.map((p) => p.displayName).join(', ') || 'Direct Friends'}
                          </span>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            type="button"
                            onClick={() => handleTriggerAddExpense(null, exp)}
                            className="lg-scene-tile min-h-[44px] inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-semibold text-[#141715] dark:text-[#F3F5F3] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
                          >
                            <NotePencil className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>Edit</span>
                          </button>
                          <button
                            type="button"
                            data-testid={`delete-expense-${exp.id}`}
                            onClick={() => softDeleteExpense(exp.id)}
                            className="min-h-[44px] inline-flex items-center gap-1.5 rounded-full border border-rose-500/30 bg-rose-500/12 hover:bg-rose-500/20 px-3.5 py-1.5 text-xs font-semibold text-rose-800 dark:text-rose-200 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
                          >
                            <Trash className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>Trash</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </DoubleBezelCard>
        </section>
      </div>

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
