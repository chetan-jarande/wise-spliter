import React, { useMemo, useState } from 'react';
import {
  ArrowsLeftRightIcon as ArrowsLeftRight,
  ArrowUpRightIcon as ArrowUpRight,
  ChartBarIcon as ChartBar,
  ChartDonutIcon as ChartDonut,
  CheckCircleIcon as CheckCircle,
  CurrencyCircleDollarIcon as CurrencyCircleDollar,
  FunnelIcon as Funnel,
  GlobeHemisphereWestIcon as GlobeHemisphereWest,
  MagnifyingGlassIcon as MagnifyingGlass,
  ReceiptIcon as Receipt,
  SlidersHorizontalIcon as SlidersHorizontal,
  TagIcon as Tag,
  UsersIcon as Users,
  WarningCircleIcon as WarningCircle,
  XIcon as X,
} from '@phosphor-icons/react';
import { useLedger } from '../../state/LedgerContext';
import {
  CurrencyAmount,
  CurrencyPrecisionPill,
  DoubleBezelCard,
  PersonalExpenseImpactBadge,
  StatusBadge,
} from '../primitives/DesignPrimitives';
import { convertForeignToBaseMinor, formatMinorToMajor } from '../../domain/money/currencies';
import { ExpenseCategoryKey, SplitMode } from '../../types/ledger';
import { AmountFilter, matchesAmountFilter, matchesDateRange } from '../../utils/expense-search';
import { MonthlySpendChart } from '../components/MonthlySpendChart';

const CATEGORY_COLORS: Record<ExpenseCategoryKey, { stroke: string; badge: string; dot: string }> = {
  lodging: {
    stroke: '#2F8F6B',
    badge: 'bg-emerald-500/12 text-emerald-800 dark:text-emerald-200 ring-emerald-600/25',
    dot: 'bg-[#2F8F6B]',
  },
  activities: {
    stroke: '#3E88A8',
    badge: 'bg-sky-500/12 text-sky-800 dark:text-sky-200 ring-sky-600/25',
    dot: 'bg-[#3E88A8]',
  },
  food: {
    stroke: '#C88A36',
    badge: 'bg-amber-500/14 text-amber-900 dark:text-amber-200 ring-amber-600/28',
    dot: 'bg-[#C88A36]',
  },
  transport: {
    stroke: '#6875A8',
    badge: 'bg-indigo-500/12 text-indigo-800 dark:text-indigo-200 ring-indigo-600/25',
    dot: 'bg-[#6875A8]',
  },
  utilities: {
    stroke: '#3C948B',
    badge: 'bg-teal-500/12 text-teal-800 dark:text-teal-200 ring-teal-600/25',
    dot: 'bg-[#3C948B]',
  },
  groceries: {
    stroke: '#6E9856',
    badge: 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-200 ring-emerald-600/20',
    dot: 'bg-[#6E9856]',
  },
  flights: {
    stroke: '#B96A7E',
    badge: 'bg-rose-500/12 text-rose-800 dark:text-rose-200 ring-rose-600/25',
    dot: 'bg-[#B96A7E]',
  },
  shopping: {
    stroke: '#C46D5E',
    badge: 'bg-rose-500/12 text-rose-800 dark:text-rose-200 ring-rose-600/25',
    dot: 'bg-[#C46D5E]',
  },
  general: {
    stroke: '#7A847E',
    badge: 'bg-black/[0.055] text-[#2B312D] dark:bg-white/[0.08] dark:text-[#DCE2DD] ring-black/[0.08] dark:ring-white/[0.14]',
    dot: 'bg-[#7A847E]',
  },
};

const SPLIT_MODE_META: Array<{
  mode: SplitMode;
  label: string;
  formulaNote: string;
  colorHex: string;
}> = [
  {
    mode: 'equal',
    label: 'Equal Split',
    formulaNote: 'Deterministic N-way division with rotating +1 minor unit remainder',
    colorHex: '#2F8F6B',
  },
  {
    mode: 'shares',
    label: 'Weighted Shares',
    formulaNote: 'Proportional integer weight ratio (e.g. 2:1:1:2 shares)',
    colorHex: '#3E88A8',
  },
  {
    mode: 'percentage',
    label: 'Percentage (Basis Points)',
    formulaNote: 'Exact 10,000 bps allocation (e.g. 40% / 30% / 30%)',
    colorHex: '#6875A8',
  },
  {
    mode: 'adjustment',
    label: '+/- Adjustment',
    formulaNote: 'Itemized surcharge deducted first, remainder split equally',
    colorHex: '#C88A36',
  },
  {
    mode: 'exact',
    label: 'Exact Minor Amounts',
    formulaNote: 'Explicit minor unit assignment validated against bill total',
    colorHex: '#B96A7E',
  },
];

const QUICK_SEARCH_TAGS = [
  '#scuba',
  '#villa',
  '#shinkansen',
  '#kwd-fils',
  '#offline-cached-fx',
  '#conflict-demo',
  '#rotating-remainder',
];

export function AnalyticsAndSearchPage() {
  const {
    dataset,
    activeGroup,
    setActiveGroupId,
    setActivePage,
    showToast,
    getFxQuote,
  } = useLedger();
  const chartCurrency = dataset.currentUser.defaultCurrency || activeGroup.baseCurrency;
  const convertForChart = (minor: bigint, from: string) => {
    const q = getFxQuote(from, chartCurrency);
    return q ? convertForeignToBaseMinor(minor, from, chartCurrency, q.rateScaled) : null;
  };

  const [selectedCategoryFilter, setSelectedCategoryFilter] = useState<string>('all');
  const [selectedSplitModeFilter, setSelectedSplitModeFilter] = useState<string>('all');
  const [selectedCurrencyFilter, setSelectedCurrencyFilter] = useState<string>('all');
  const [selectedStatusFilter, setSelectedStatusFilter] = useState<'all' | 'conflict' | 'fx'>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [amountFilter, setAmountFilter] = useState<AmountFilter>({ mode: 'any', min: '', max: '' });
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [highlightedCategory, setHighlightedCategory] = useState<ExpenseCategoryKey | null>(null);

  const activeGroups = useMemo(
    () => dataset.groups.filter((g) => !g.deletedAt),
    [dataset.groups]
  );

  const groupExpenses = useMemo(
    () =>
      dataset.expenses.filter(
        (e) => e.groupId === activeGroup.id && !e.deletedAt
      ),
    [dataset.expenses, activeGroup.id]
  );

  const groupSettlements = useMemo(
    () =>
      dataset.settlements.filter(
        (s) => s.groupId === activeGroup.id && !s.deletedAt
      ),
    [dataset.settlements, activeGroup.id]
  );

  const myMemberInActiveGroup = useMemo(() => {
    return (
      activeGroup.members.find(
        (m) =>
          m.invitedEmail?.toLowerCase() === dataset.currentUser.email.toLowerCase() ||
          m.userId === dataset.currentUser.id
      ) ?? activeGroup.members[0]
    );
  }, [activeGroup.members, dataset.currentUser]);

  // KPI computations for activeGroup + cross-group multi-currency count
  const kpiStats = useMemo(() => {
    const totalGroupSpendMinor = groupExpenses.reduce(
      (sum, exp) => sum + exp.amountMinor,
      0
    );

    let personalShareMinor = 0;
    let personalPaidMinor = 0;

    if (myMemberInActiveGroup) {
      for (const exp of groupExpenses) {
        const mySplit = exp.splits.find(
          (s) => s.memberId === myMemberInActiveGroup.id && s.included
        );
        if (mySplit) {
          personalShareMinor += mySplit.owedMinor;
        }
        const myPayer = exp.payers.find(
          (p) => p.memberId === myMemberInActiveGroup.id
        );
        if (myPayer) {
          personalPaidMinor += myPayer.paidMinor;
        }
      }
    }

    const totalSettledMinor = groupSettlements.reduce(
      (sum, stl) => sum + stl.amountMinor,
      0
    );

    const allActiveExpenses = dataset.expenses.filter((e) => !e.deletedAt);
    const multiCurrencyAllCount = allActiveExpenses.filter(
      (e) =>
        e.originalCurrency !== e.groupCurrency ||
        e.groupCurrency === 'JPY' ||
        e.groupCurrency === 'KWD'
    ).length;

    const groupForeignBillsCount = groupExpenses.filter(
      (e) => e.originalCurrency !== e.groupCurrency
    ).length;

    const personalSharePct =
      totalGroupSpendMinor > 0
        ? ((personalShareMinor / totalGroupSpendMinor) * 100).toFixed(1)
        : '0.0';

    return {
      totalGroupSpendMinor,
      personalShareMinor,
      personalPaidMinor,
      personalSharePct,
      totalSettledMinor,
      settlementCount: groupSettlements.length,
      multiCurrencyAllCount,
      groupForeignBillsCount,
    };
  }, [groupExpenses, groupSettlements, myMemberInActiveGroup, dataset.expenses]);

  // Category Breakdown for activeGroup
  const categoryBreakdown = useMemo(() => {
    const total = kpiStats.totalGroupSpendMinor;
    const rows = dataset.categoriesCatalog.map((cat) => {
      const matching = groupExpenses.filter((e) => e.category === cat.key);
      const amountMinor = matching.reduce((acc, e) => acc + e.amountMinor, 0);
      const ratio = total > 0 ? amountMinor / total : 0;
      const percentage = ratio * 100;
      return {
        ...cat,
        count: matching.length,
        amountMinor,
        ratio,
        percentage,
        color: CATEGORY_COLORS[cat.key] ?? CATEGORY_COLORS.general,
      };
    });

    return rows.sort((a, b) => b.amountMinor - a.amountMinor);
  }, [dataset.categoriesCatalog, groupExpenses, kpiStats.totalGroupSpendMinor]);

  // Split Mode Breakdown for activeGroup
  const splitModeBreakdown = useMemo(() => {
    const total = kpiStats.totalGroupSpendMinor;
    return SPLIT_MODE_META.map((meta) => {
      const matching = groupExpenses.filter((e) => e.splitMode === meta.mode);
      const amountMinor = matching.reduce((acc, e) => acc + e.amountMinor, 0);
      const ratio = total > 0 ? amountMinor / total : 0;
      const percentage = ratio * 100;
      return {
        ...meta,
        count: matching.length,
        amountMinor,
        ratio,
        percentage,
      };
    });
  }, [groupExpenses, kpiStats.totalGroupSpendMinor]);

  // SVG Donut ring segments calculation
  const donutSegments = useMemo(() => {
    const radius = 64;
    const circumference = 2 * Math.PI * radius;
    let cumulativeFraction = 0;

    return categoryBreakdown
      .filter((c) => c.amountMinor > 0)
      .map((item) => {
        const segmentLength = item.ratio * circumference;
        const dashArray = `${Math.max(0, segmentLength - 2)} ${circumference}`;
        const dashOffset = -cumulativeFraction * circumference;
        cumulativeFraction += item.ratio;
        return {
          ...item,
          radius,
          circumference,
          dashArray,
          dashOffset,
        };
      });
  }, [categoryBreakdown]);

  // Global Instant Search across ALL groups and expenses
  const globalFilteredExpenses = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const groupMap = new Map(dataset.groups.map((g) => [g.id, g]));

    return dataset.expenses
      .filter((exp) => !exp.deletedAt)
      .filter((exp) => {
        if (selectedCategoryFilter !== 'all' && exp.category !== selectedCategoryFilter) {
          return false;
        }
        if (selectedSplitModeFilter !== 'all' && exp.splitMode !== selectedSplitModeFilter) {
          return false;
        }
        if (
          selectedCurrencyFilter !== 'all' &&
          exp.originalCurrency.toUpperCase() !== selectedCurrencyFilter &&
          exp.groupCurrency.toUpperCase() !== selectedCurrencyFilter
        ) {
          return false;
        }
        if (selectedStatusFilter === 'conflict' && !exp.hasUnresolvedConflict) {
          return false;
        }
        if (
          selectedStatusFilter === 'fx' &&
          exp.originalCurrency === exp.groupCurrency
        ) {
          return false;
        }
        if (!matchesAmountFilter(exp, amountFilter, typeof navigator !== 'undefined' ? navigator.language : undefined) || !matchesDateRange(exp.expenseDate, dateFrom, dateTo)) {
          return false;
        }

        if (!q) return true;

        const grp = exp.groupId ? groupMap.get(exp.groupId) : undefined;
        const payerNames = exp.payers
          .map(
            (p) =>
              grp?.members.find((m) => m.id === p.memberId)?.displayName ??
              exp.adHocParticipants?.find((a) => a.id === p.memberId)?.displayName ??
              ''
          )
          .join(' ')
          .toLowerCase();

        const haystack = [
          exp.title,
          exp.notes,
          exp.category,
          exp.splitMode,
          exp.originalCurrency,
          exp.groupCurrency,
          exp.fxStatus,
          exp.fxAuditNote ?? '',
          exp.tags.join(' '),
          grp?.name ?? '',
          payerNames,
          exp.hasUnresolvedConflict ? 'conflict unresolved concurrent' : '',
        ]
          .join(' ')
          .toLowerCase();

        return haystack.includes(q);
      })
      .sort((a, b) => b.expenseDate.localeCompare(a.expenseDate));
  }, [
    dataset.expenses,
    dataset.groups,
    searchQuery,
    selectedCategoryFilter,
    selectedSplitModeFilter,
    selectedCurrencyFilter,
    selectedStatusFilter,
    amountFilter,
    dateFrom,
    dateTo,
  ]);

  const hasFilters =
    searchQuery !== '' ||
    selectedCategoryFilter !== 'all' ||
    selectedSplitModeFilter !== 'all' ||
    selectedCurrencyFilter !== 'all' ||
    selectedStatusFilter !== 'all' ||
    amountFilter.mode !== 'any' ||
    dateFrom !== '' ||
    dateTo !== '';

  const handleJumpToGroup = (groupId: string | null, groupName: string) => {
    if (!groupId) {
      setActivePage('home');
      showToast('Switched to Home Direct Splits.');
      return;
    }
    setActiveGroupId(groupId);
    setActivePage('groups');
    showToast(`Switched to "${groupName}" ledger.`);
  };

  return (
    <div className="space-y-6 pb-4 min-w-0">
      {/* Editorial Spatial Header & Active Group Scope Selector */}
      <header className="flex flex-col xl:flex-row xl:items-end xl:justify-between gap-4 pt-1 min-w-0">
        <div className="space-y-2 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone="emerald">
              <ChartDonut className="w-3.5 h-3.5" weight="duotone" aria-hidden="true" />
              <span>Spending Insights &amp; Instant Bill Finder</span>
            </StatusBadge>
            <CurrencyPrecisionPill currencyCode={activeGroup.baseCurrency} />
            <StatusBadge tone="slate">
              {activeGroups.length} {activeGroups.length === 1 ? 'group' : 'groups'}
            </StatusBadge>
          </div>

          <h1 className="text-2xl sm:text-3xl lg:text-[34px] font-medium tracking-tight leading-[1.15] text-[#141715] dark:text-[#F3F5F3]">
            Spending Insights &amp; Global Search
          </h1>

          <p className="text-sm sm:text-base font-medium text-[#4A524D] dark:text-[#B7BEB9] break-words">
            See where money went in{' '}
            <span dir="auto" className="font-semibold text-[#141715] dark:text-[#F3F5F3]">
              {activeGroup.name}
            </span>{' '}
            and search across all {activeGroups.length} active groups and travel currencies.
          </p>
        </div>

        {/* Group Scope Switcher Capsule Tray */}
        <div className="lg-recessed-well rounded-[1.375rem] p-1.5 flex flex-wrap items-center gap-1.5 min-w-0">
          <span className="px-2.5 py-1 text-[11px] font-mono uppercase tracking-wider text-[#5C6660] dark:text-[#9CA69F]">
            Scope
          </span>
          {activeGroups.map((grp) => {
            const isSelected = grp.id === activeGroup.id;
            return (
              <button
                key={grp.id}
                type="button"
                onClick={() => setActiveGroupId(grp.id)}
                className={`min-h-[44px] sm:min-h-[38px] px-3.5 py-1.5 rounded-full text-xs font-semibold cursor-pointer flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 ${
                  isSelected
                    ? 'lg-luminous-pill'
                    : 'lg-scene-tile text-[#141715] dark:text-[#F3F5F3]'
                }`}
              >
                <span dir="auto" className="truncate max-w-[10rem]" title={grp.name}>
                  {grp.name}
                </span>
                <span
                  className={`shrink-0 font-mono text-[10px] px-2 py-0.5 rounded-full ${
                    isSelected
                      ? 'bg-white/15 dark:bg-black/15 text-inherit'
                      : 'lg-icon-orb text-[#4A524D] dark:text-[#B7BEB9]'
                  }`}
                >
                  {grp.baseCurrency}
                </span>
              </button>
            );
          })}
        </div>
      </header>

      {/* 1. Sculpted Glass KPI Summary Bento */}
      <div
        data-testid="analytics-kpi-grid"
        className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3.5 min-w-0"
      >
        <DoubleBezelCard
          className="min-w-0 overflow-hidden"
          innerClassName="flex flex-col justify-between gap-3.5 min-w-0"
        >
          <div className="flex items-center justify-between gap-2 min-w-0">
            <span className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#5C6660] dark:text-[#9CA69F] truncate">
              Total Active Group Spend
            </span>
            <span
              aria-hidden="true"
              className="lg-icon-orb h-9 w-9 rounded-full flex items-center justify-center shrink-0 text-[#2F8F6B] dark:text-[#6BC5A1]"
            >
              <CurrencyCircleDollar className="w-4 h-4" weight="duotone" />
            </span>
          </div>
          <div className="space-y-2.5 min-w-0">
            <div className="lg-recessed-well rounded-[1.125rem] px-3.5 py-2.5 min-w-0 overflow-hidden">
              <div className="text-lg sm:text-xl xl:text-[17px] 2xl:text-xl font-semibold whitespace-nowrap text-[#141715] dark:text-[#F3F5F3]">
                <CurrencyAmount
                  minorAmount={kpiStats.totalGroupSpendMinor}
                  currencyCode={activeGroup.baseCurrency}
                />
              </div>
            </div>
            <div className="flex items-center justify-between gap-2 min-w-0 text-xs text-[#5C6660] dark:text-[#9CA69F]">
              <span className="truncate">{groupExpenses.length} active bills</span>
              <span className="shrink-0">
                <CurrencyPrecisionPill currencyCode={activeGroup.baseCurrency} />
              </span>
            </div>
          </div>
        </DoubleBezelCard>

        <DoubleBezelCard
          className="min-w-0 overflow-hidden"
          innerClassName="flex flex-col justify-between gap-3.5 min-w-0"
        >
          <div className="flex items-center justify-between gap-2 min-w-0">
            <span className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#5C6660] dark:text-[#9CA69F] truncate">
              Your Personal Share
            </span>
            <span
              aria-hidden="true"
              className="lg-icon-orb h-9 w-9 rounded-full flex items-center justify-center shrink-0 text-[#3E88A8] dark:text-[#7EC4E0]"
            >
              <Users className="w-4 h-4" weight="duotone" />
            </span>
          </div>
          <div className="space-y-2.5 min-w-0">
            <div className="lg-recessed-well rounded-[1.125rem] px-3.5 py-2.5 min-w-0 overflow-hidden">
              <div className="text-lg sm:text-xl xl:text-[17px] 2xl:text-xl font-semibold whitespace-nowrap text-[#141715] dark:text-[#F3F5F3]">
                <CurrencyAmount
                  minorAmount={kpiStats.personalShareMinor}
                  currencyCode={activeGroup.baseCurrency}
                />
              </div>
            </div>
            <div className="flex items-center justify-between gap-2 min-w-0 text-xs text-[#5C6660] dark:text-[#9CA69F]">
              <span className="truncate min-w-0">{dataset.currentUser.email}</span>
              <StatusBadge tone="blue" className="shrink-0">
                {kpiStats.personalSharePct}% of group
              </StatusBadge>
            </div>
          </div>
        </DoubleBezelCard>

        <DoubleBezelCard
          className="min-w-0 overflow-hidden"
          innerClassName="flex flex-col justify-between gap-3.5 min-w-0"
        >
          <div className="flex items-center justify-between gap-2 min-w-0">
            <span className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#5C6660] dark:text-[#9CA69F] truncate">
              Total Settled Volume
            </span>
            <span
              aria-hidden="true"
              className="lg-icon-orb h-9 w-9 rounded-full flex items-center justify-center shrink-0 text-[#6875A8] dark:text-[#A8B4E4]"
            >
              <CheckCircle className="w-4 h-4" weight="duotone" />
            </span>
          </div>
          <div className="space-y-2.5 min-w-0">
            <div className="lg-recessed-well rounded-[1.125rem] px-3.5 py-2.5 min-w-0 overflow-hidden">
              <div className="text-lg sm:text-xl xl:text-[17px] 2xl:text-xl font-semibold whitespace-nowrap text-[#141715] dark:text-[#F3F5F3]">
                <CurrencyAmount
                  minorAmount={kpiStats.totalSettledMinor}
                  currencyCode={activeGroup.baseCurrency}
                />
              </div>
            </div>
            <div className="flex items-center justify-between gap-2 min-w-0 text-xs text-[#5C6660] dark:text-[#9CA69F]">
              <span className="truncate">{kpiStats.settlementCount} recorded transfers</span>
              <StatusBadge tone="emerald" className="shrink-0">
                Verified
              </StatusBadge>
            </div>
          </div>
        </DoubleBezelCard>

        <DoubleBezelCard
          className="min-w-0 overflow-hidden"
          innerClassName="flex flex-col justify-between gap-3.5 min-w-0"
        >
          <div className="flex items-center justify-between gap-2 min-w-0">
            <span className="text-[11px] font-semibold uppercase tracking-[0.07em] text-[#5C6660] dark:text-[#9CA69F] truncate">
              Multi-Currency Bills Count
            </span>
            <span
              aria-hidden="true"
              className="lg-icon-orb h-9 w-9 rounded-full flex items-center justify-center shrink-0 text-[#C88A36] dark:text-[#E5B36A]"
            >
              <GlobeHemisphereWest className="w-4 h-4" weight="duotone" />
            </span>
          </div>
          <div className="space-y-2.5 min-w-0">
            <div className="lg-recessed-well rounded-[1.125rem] px-3.5 py-2.5 min-w-0 overflow-hidden">
              <div className="flex items-baseline gap-1.5 min-w-0">
                <span className="text-lg sm:text-xl xl:text-[17px] 2xl:text-xl font-semibold font-mono tabular-nums whitespace-nowrap text-[#141715] dark:text-[#F3F5F3]">
                  {kpiStats.multiCurrencyAllCount}
                </span>
                <span className="text-xs font-medium text-[#5C6660] dark:text-[#9CA69F] truncate">
                  cross-ledger bills
                </span>
              </div>
            </div>
            <div className="flex items-center justify-between gap-2 min-w-0 text-xs text-[#5C6660] dark:text-[#9CA69F]">
              <span className="truncate">{kpiStats.groupForeignBillsCount} in active group</span>
              <StatusBadge tone="amber" className="shrink-0">
                INR / EUR / JPY / KWD
              </StatusBadge>
            </div>
          </div>
        </DoubleBezelCard>
      </div>

      <MonthlySpendChart
        expenses={groupExpenses}
        currency={chartCurrency}
        groupName={activeGroup.name}
        convert={convertForChart}
      />

      {/* 2. Visual Category Breakdown & Group Spend SVG Chart */}
      <DoubleBezelCard
        testId="analytics-category-breakdown"
        className="min-w-0"
        innerClassName="space-y-6 min-w-0"
      >
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-black/[0.07] dark:border-white/[0.08] pb-4 min-w-0">
          <div className="flex items-start sm:items-center gap-3 min-w-0">
            <span
              aria-hidden="true"
              className="lg-icon-orb h-9 w-9 rounded-full flex items-center justify-center shrink-0 text-[#2F8F6B] dark:text-[#6BC5A1]"
            >
              <ChartBar className="w-4 h-4" weight="duotone" />
            </span>
            <div className="min-w-0">
              <h2 className="text-base sm:text-lg font-semibold tracking-tight text-[#141715] dark:text-[#F3F5F3]">
                Category &amp; Split Mode Spending Architecture
              </h2>
              <p className="text-xs text-[#5C6660] dark:text-[#9CA69F] mt-0.5 break-words">
                Proportional SVG ring chart, horizontal distribution bars, and tabular minor-unit ledger breakdown for{' '}
                <span dir="auto" className="font-medium text-[#141715] dark:text-[#F3F5F3]">
                  {activeGroup.name}
                </span>
                .
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <StatusBadge tone="emerald">Base: {activeGroup.baseCurrency}</StatusBadge>
            <StatusBadge tone="slate">
              Paid by You:{' '}
              <span className="font-mono tabular-nums font-semibold">
                {formatMinorToMajor(kpiStats.personalPaidMinor, activeGroup.baseCurrency)}
              </span>
            </StatusBadge>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start min-w-0">
          {/* Left 5 Cols: Interactive SVG Proportional Ring + SVG Horizontal Category Bars */}
          <div className="lg:col-span-5 lg-recessed-well rounded-[1.375rem] p-5 flex flex-col items-center justify-center space-y-5 min-w-0">
            <div className="relative flex items-center justify-center">
              <svg
                viewBox="0 0 180 180"
                className="w-44 h-44 -rotate-90 transform"
                role="img"
                aria-label="Category Spend Proportional Donut Chart"
              >
                <circle
                  cx="90"
                  cy="90"
                  r="64"
                  fill="transparent"
                  stroke="currentColor"
                  strokeWidth="17"
                  className="text-black/[0.065] dark:text-white/[0.08]"
                />
                {donutSegments.map((seg) => {
                  const isHighlighted =
                    highlightedCategory === null || highlightedCategory === seg.key;
                  return (
                    <circle
                      key={seg.key}
                      cx="90"
                      cy="90"
                      r={seg.radius}
                      fill="transparent"
                      stroke={seg.color.stroke}
                      strokeWidth={highlightedCategory === seg.key ? 21 : 17}
                      strokeDasharray={seg.dashArray}
                      strokeDashoffset={seg.dashOffset}
                      strokeLinecap="butt"
                      className="transition-opacity duration-300 cursor-pointer"
                      style={{ opacity: isHighlighted ? 1 : 0.28 }}
                      onMouseEnter={() => setHighlightedCategory(seg.key)}
                      onMouseLeave={() => setHighlightedCategory(null)}
                    />
                  );
                })}
              </svg>
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="lg-scene-tile rounded-full w-24 h-24 flex flex-col items-center justify-center text-center px-2">
                  <span className="text-[9px] font-mono uppercase tracking-wider text-[#5C6660] dark:text-[#9CA69F] truncate max-w-full">
                    {highlightedCategory
                      ? categoryBreakdown.find((c) => c.key === highlightedCategory)?.label
                      : 'Total Spend'}
                  </span>
                  <span className="text-xs font-semibold font-mono tabular-nums text-[#141715] dark:text-[#F3F5F3] mt-0.5 truncate max-w-full">
                    {highlightedCategory
                      ? formatMinorToMajor(
                          categoryBreakdown.find((c) => c.key === highlightedCategory)
                            ?.amountMinor ?? 0,
                          activeGroup.baseCurrency
                        )
                      : formatMinorToMajor(
                          kpiStats.totalGroupSpendMinor,
                          activeGroup.baseCurrency
                        )}
                  </span>
                  <span className="text-[10px] font-mono font-medium text-[#2F8F6B] dark:text-[#6BC5A1]">
                    {highlightedCategory
                      ? `${(
                          categoryBreakdown.find((c) => c.key === highlightedCategory)
                            ?.percentage ?? 0
                        ).toFixed(1)}%`
                      : `${groupExpenses.length} bills`}
                  </span>
                </div>
              </div>
            </div>

            {/* SVG Horizontal Bar Chart for Active Categories */}
            <div className="w-full space-y-2 min-w-0">
              <div className="flex items-center justify-between text-[11px] font-mono uppercase tracking-wider text-[#5C6660] dark:text-[#9CA69F]">
                <span>Category Allocation</span>
                <span>Share %</span>
              </div>
              <svg
                viewBox={`0 0 320 ${Math.max(1, categoryBreakdown.filter((c) => c.amountMinor > 0).length) * 32}`}
                className="w-full overflow-visible"
                role="img"
                aria-label="Category Horizontal SVG Bar Chart"
              >
                {categoryBreakdown
                  .filter((c) => c.amountMinor > 0)
                  .map((cat, idx) => {
                    const y = idx * 32;
                    const barWidth = Math.max(6, Math.round(cat.ratio * 210));
                    const isDimmed =
                      highlightedCategory !== null && highlightedCategory !== cat.key;
                    return (
                      <g
                        key={cat.key}
                        transform={`translate(0, ${y})`}
                        className="cursor-pointer transition-opacity duration-200"
                        style={{ opacity: isDimmed ? 0.45 : 1 }}
                        onMouseEnter={() => setHighlightedCategory(cat.key)}
                        onMouseLeave={() => setHighlightedCategory(null)}
                      >
                        <text
                          x="0"
                          y="14"
                          className="fill-[#2B312D] dark:fill-[#DCE2DD] text-[10px] font-medium"
                        >
                          {cat.label.slice(0, 15)}
                        </text>
                        <rect
                          x="96"
                          y="4"
                          width="170"
                          height="12"
                          rx="6"
                          className="fill-black/[0.065] dark:fill-white/[0.08]"
                        />
                        <rect
                          x="96"
                          y="4"
                          width={Math.min(170, barWidth)}
                          height="12"
                          rx="6"
                          fill={cat.color.stroke}
                        />
                        <text
                          x="316"
                          y="14"
                          textAnchor="end"
                          className="fill-[#2B312D] dark:fill-[#DCE2DD] text-[10px] font-mono"
                        >
                          {cat.percentage.toFixed(1)}%
                        </text>
                      </g>
                    );
                  })}
              </svg>
            </div>
          </div>

          {/* Right 7 Cols: Structured Tabular Category Breakdown & Split Mode Breakdown */}
          <div className="lg:col-span-7 space-y-5 min-w-0">
            {/* Category Table */}
            <div className="lg-recessed-well rounded-[1.375rem] overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-black/[0.07] dark:border-white/[0.08] text-[11px] font-mono uppercase tracking-wider text-[#5C6660] dark:text-[#9CA69F]">
                    <th className="py-3 px-3.5">Category</th>
                    <th className="py-3 px-3 text-right">Bills</th>
                    <th className="py-3 px-3 text-right">Amount</th>
                    <th className="py-3 px-3.5 text-right">Share</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-black/[0.055] dark:divide-white/[0.06] text-xs">
                  {categoryBreakdown.map((cat) => {
                    const isActiveCat = selectedCategoryFilter === cat.key;
                    return (
                      <tr
                        key={cat.key}
                        onMouseEnter={() => setHighlightedCategory(cat.key)}
                        onMouseLeave={() => setHighlightedCategory(null)}
                        onClick={() =>
                          setSelectedCategoryFilter((prev) =>
                            prev === cat.key ? 'all' : cat.key
                          )
                        }
                        className={`transition-colors cursor-pointer ${
                          isActiveCat
                            ? 'bg-emerald-500/12 dark:bg-emerald-400/14'
                            : 'hover:bg-black/[0.025] dark:hover:bg-white/[0.035]'
                        }`}
                      >
                        <td className="py-2.5 px-3.5">
                          <div className="flex items-center gap-2.5 min-w-0">
                            <span
                              className={`w-2.5 h-2.5 rounded-full shrink-0 ring-2 ring-white/40 dark:ring-black/30 ${cat.color.dot}`}
                            />
                            <div className="min-w-0">
                              <div className="font-semibold text-[#141715] dark:text-[#F3F5F3]">
                                {cat.label}
                              </div>
                              <div className="text-[11px] text-[#5C6660] dark:text-[#9CA69F] hidden sm:block">
                                {cat.description}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums text-[#4A524D] dark:text-[#B7BEB9]">
                          {cat.count}
                        </td>
                        <td className="py-2.5 px-3 text-right font-semibold whitespace-nowrap text-[#141715] dark:text-[#F3F5F3]">
                          <CurrencyAmount
                            minorAmount={cat.amountMinor}
                            currencyCode={activeGroup.baseCurrency}
                          />
                        </td>
                        <td className="py-2.5 px-3.5 text-right font-mono tabular-nums text-[#4A524D] dark:text-[#B7BEB9]">
                          {cat.percentage.toFixed(1)}%
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Split Mode Tabular Breakdown */}
            <div className="lg-recessed-well rounded-[1.375rem] p-4 space-y-3 min-w-0">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-[#2B312D] dark:text-[#DCE2DD] flex items-center gap-2">
                  <SlidersHorizontal
                    className="w-4 h-4 text-[#2F8F6B] dark:text-[#6BC5A1]"
                    weight="bold"
                    aria-hidden="true"
                  />
                  <span>Split Mode Engine Distribution (5 Modes)</span>
                </span>
                <span className="text-[11px] font-mono text-[#5C6660] dark:text-[#9CA69F]">
                  Tap any mode to filter global search
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 xl:grid-cols-5 gap-2.5 min-w-0">
                {splitModeBreakdown.map((sm) => {
                  const isFiltered = selectedSplitModeFilter === sm.mode;
                  return (
                    <button
                      key={sm.mode}
                      type="button"
                      onClick={() =>
                        setSelectedSplitModeFilter((prev) =>
                          prev === sm.mode ? 'all' : sm.mode
                        )
                      }
                      className={`min-h-[44px] text-left p-3 rounded-2xl cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 min-w-0 ${
                        isFiltered
                          ? 'lg-luminous-pill'
                          : 'lg-scene-tile text-[#141715] dark:text-[#F3F5F3]'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-1.5 min-w-0">
                        <span className="inline-flex items-center gap-1.5 min-w-0">
                          <span
                            aria-hidden="true"
                            className="w-2 h-2 rounded-full shrink-0"
                            style={{ backgroundColor: sm.colorHex }}
                          />
                          <span className="text-[11px] font-mono uppercase font-semibold truncate">
                            {sm.mode}
                          </span>
                        </span>
                        <span
                          className={`text-[10px] font-mono px-1.5 py-0.5 rounded-full shrink-0 ${
                            isFiltered
                              ? 'bg-white/15 dark:bg-black/15 text-inherit'
                              : 'lg-icon-orb text-[#4A524D] dark:text-[#B7BEB9]'
                          }`}
                        >
                          {sm.count}
                        </span>
                      </div>
                      <div className="mt-2 text-xs font-semibold font-mono tabular-nums truncate">
                        {formatMinorToMajor(sm.amountMinor, activeGroup.baseCurrency)}
                      </div>
                      <div
                        className={`mt-0.5 text-[10px] font-mono tabular-nums ${
                          isFiltered ? 'opacity-80' : 'text-[#5C6660] dark:text-[#9CA69F]'
                        }`}
                      >
                        {sm.percentage.toFixed(1)}% of spend
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </DoubleBezelCard>

      {/* 3. Instant Global Search & Smart Filters */}
      <DoubleBezelCard
        testId="global-search-panel"
        className="min-w-0"
        innerClassName="space-y-5 min-w-0"
      >
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 border-b border-black/[0.07] dark:border-white/[0.08] pb-4 min-w-0">
          <div className="flex items-start sm:items-center gap-3 min-w-0">
            <span
              aria-hidden="true"
              className="lg-icon-orb h-9 w-9 rounded-full flex items-center justify-center shrink-0 text-[#2F8F6B] dark:text-[#6BC5A1]"
            >
              <MagnifyingGlass className="w-4 h-4" weight="bold" />
            </span>
            <div className="min-w-0">
              <h2 className="text-base sm:text-lg font-semibold tracking-tight text-[#141715] dark:text-[#F3F5F3]">
                Find Any Bill Across All Groups
              </h2>
              <p className="text-xs text-[#5C6660] dark:text-[#9CA69F] mt-0.5 break-words">
                Search across all groups and direct splits by bill name, notes, #tag (#scuba, #villa, #shinkansen), category, split type, or currency.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <StatusBadge tone="emerald">
              {globalFilteredExpenses.length} matching expenses
            </StatusBadge>
            {hasFilters && (
              <button
                type="button"
                onClick={() => {
                  setSearchQuery('');
                  setSelectedCategoryFilter('all');
                  setSelectedSplitModeFilter('all');
                  setSelectedCurrencyFilter('all');
                  setSelectedStatusFilter('all');
                  setAmountFilter({ mode: 'any', min: '', max: '' });
                  setDateFrom('');
                  setDateTo('');
                }}
                className="lg-scene-tile min-h-[44px] sm:min-h-[36px] inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-semibold text-rose-700 dark:text-rose-300 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/50"
              >
                <X className="w-3.5 h-3.5" weight="bold" aria-hidden="true" />
                <span>Clear Filters</span>
              </button>
            )}
          </div>
        </div>

        {/* Recessed Optical Search Input & Quick Tag Chips */}
        <div className="space-y-3.5 min-w-0">
          <div className="relative min-w-0">
            <MagnifyingGlass
              className="w-4 h-4 text-[#5C6660] dark:text-[#9CA69F] absolute left-4 top-1/2 -translate-y-1/2 pointer-events-none"
              weight="bold"
              aria-hidden="true"
            />
            <input
              id="global-search-input"
              data-testid="global-search-input"
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search bills, notes, #scuba, #villa, #shinkansen, EUR, JPY, KWD, conflict..."
              className="lg-recessed-well w-full min-h-[48px] pl-11 pr-14 py-3 rounded-full text-sm text-[#141715] dark:text-[#F3F5F3] placeholder:text-[#68726C] dark:placeholder:text-[#8A938D] focus:outline-none focus:ring-2 focus:ring-emerald-500/60 transition-shadow"
            />
            {searchQuery ? (
              <button
                type="button"
                aria-label="Clear search query"
                onClick={() => setSearchQuery('')}
                className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center absolute right-1 top-1/2 -translate-y-1/2 rounded-full text-[#5C6660] dark:text-[#9CA69F] hover:text-[#141715] dark:hover:text-[#F3F5F3] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
              >
                <X className="w-4 h-4" weight="bold" />
              </button>
            ) : (
              <kbd
                aria-hidden="true"
                className="hidden sm:inline-flex lg-icon-orb rounded-full px-2.5 py-0.5 text-[10px] font-mono font-semibold text-[#5C6660] dark:text-[#9CA69F] absolute right-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
              >
                ⌘K
              </kbd>
            )}
          </div>

          {/* Quick Tag Chips */}
          <div className="flex flex-wrap items-center gap-1.5 min-w-0">
            <span className="inline-flex items-center gap-1 text-[11px] font-mono text-[#5C6660] dark:text-[#9CA69F] mr-1">
              <Tag className="w-3.5 h-3.5" aria-hidden="true" />
              <span>Quick Tags:</span>
            </span>
            {QUICK_SEARCH_TAGS.map((tag) => {
              const active = searchQuery.toLowerCase() === tag.toLowerCase();
              return (
                <button
                  key={tag}
                  type="button"
                  onClick={() =>
                    setSearchQuery((prev) =>
                      prev.toLowerCase() === tag.toLowerCase() ? '' : tag
                    )
                  }
                  className={`min-h-[44px] sm:min-h-[32px] px-3 py-1 rounded-full text-xs font-mono cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 ${
                    active
                      ? 'lg-luminous-pill font-semibold'
                      : 'lg-scene-tile text-[#2B312D] dark:text-[#DCE2DD]'
                  }`}
                >
                  {tag}
                </button>
              );
            })}
          </div>

          {/* Multi-Filter Frosted Selectors Row */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 pt-1 min-w-0">
            <div className="min-w-0">
              <label className="block text-[11px] font-semibold uppercase tracking-wider text-[#5C6660] dark:text-[#9CA69F] mb-1.5">
                Category
              </label>
              <select
                aria-label="Filter by category"
                value={selectedCategoryFilter}
                onChange={(e) => setSelectedCategoryFilter(e.target.value)}
                className="lg-recessed-well w-full min-h-[44px] px-3.5 py-2 rounded-2xl text-xs font-medium text-[#141715] dark:text-[#F3F5F3] focus:outline-none focus:ring-2 focus:ring-emerald-500/60 [&>option]:bg-[#F6F8F6] [&>option]:text-[#141715] dark:[&>option]:bg-[#222522] dark:[&>option]:text-[#F3F5F3]"
              >
                <option value="all">All Categories</option>
                {dataset.categoriesCatalog.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="min-w-0">
              <label className="block text-[11px] font-semibold uppercase tracking-wider text-[#5C6660] dark:text-[#9CA69F] mb-1.5">
                Split Type
              </label>
              <select
                aria-label="Filter by split mode"
                value={selectedSplitModeFilter}
                onChange={(e) => setSelectedSplitModeFilter(e.target.value)}
                className="lg-recessed-well w-full min-h-[44px] px-3.5 py-2 rounded-2xl text-xs font-medium text-[#141715] dark:text-[#F3F5F3] focus:outline-none focus:ring-2 focus:ring-emerald-500/60 [&>option]:bg-[#F6F8F6] [&>option]:text-[#141715] dark:[&>option]:bg-[#222522] dark:[&>option]:text-[#F3F5F3]"
              >
                <option value="all">All Split Types</option>
                <option value="equal">Equal Split</option>
                <option value="shares">Weighted Shares</option>
                <option value="percentage">Percentage (%)</option>
                <option value="adjustment">+/- Adjustment</option>
                <option value="exact">Exact Amounts</option>
              </select>
            </div>

            <div className="min-w-0">
              <label className="block text-[11px] font-semibold uppercase tracking-wider text-[#5C6660] dark:text-[#9CA69F] mb-1.5">
                Currency
              </label>
              <select
                aria-label="Filter by currency"
                value={selectedCurrencyFilter}
                onChange={(e) => setSelectedCurrencyFilter(e.target.value)}
                className="lg-recessed-well w-full min-h-[44px] px-3.5 py-2 rounded-2xl text-xs font-medium text-[#141715] dark:text-[#F3F5F3] focus:outline-none focus:ring-2 focus:ring-emerald-500/60 [&>option]:bg-[#F6F8F6] [&>option]:text-[#141715] dark:[&>option]:bg-[#222522] dark:[&>option]:text-[#F3F5F3]"
              >
                <option value="all">All Currencies (INR, EUR, JPY, USD, KWD)</option>
                <option value="INR">INR - Indian Rupee (₹)</option>
                <option value="EUR">EUR - Euro (€)</option>
                <option value="JPY">JPY - Japanese Yen (¥)</option>
                <option value="USD">USD - US Dollar ($)</option>
                <option value="KWD">KWD - Kuwaiti Dinar (KD)</option>
              </select>
            </div>

            <div className="min-w-0">
              <label className="block text-[11px] font-semibold uppercase tracking-wider text-[#5C6660] dark:text-[#9CA69F] mb-1.5">
                Special Filter
              </label>
              <select
                aria-label="Filter by conflict or FX status"
                value={selectedStatusFilter}
                onChange={(e) =>
                  setSelectedStatusFilter(
                    e.target.value as 'all' | 'conflict' | 'fx'
                  )
                }
                className="lg-recessed-well w-full min-h-[44px] px-3.5 py-2 rounded-2xl text-xs font-medium text-[#141715] dark:text-[#F3F5F3] focus:outline-none focus:ring-2 focus:ring-emerald-500/60 [&>option]:bg-[#F6F8F6] [&>option]:text-[#141715] dark:[&>option]:bg-[#222522] dark:[&>option]:text-[#F3F5F3]"
              >
                <option value="all">All Bills</option>
                <option value="conflict">Needs Offline Review</option>
                <option value="fx">Foreign Currency Bills Only</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 min-w-0">
            <div className="min-w-0">
              <label
                htmlFor="search-amount-mode"
                className="block text-[11px] font-semibold uppercase tracking-wider text-[#5C6660] dark:text-[#9CA69F] mb-1.5"
              >
                Amount
              </label>
              <select
                id="search-amount-mode"
                data-testid="search-amount-mode"
                value={amountFilter.mode}
                onChange={(e) =>
                  setAmountFilter((f) => ({
                    ...f,
                    mode: e.target.value as AmountFilter['mode'],
                  }))
                }
                className="lg-recessed-well w-full min-h-[45px] px-3.5 py-2 rounded-2xl text-xs font-medium text-[#141715] dark:text-[#F3F5F3] focus:outline-none focus:ring-2 focus:ring-emerald-500/60 [&>option]:bg-[#F6F8F6] [&>option]:text-[#141715] dark:[&>option]:bg-[#222522] dark:[&>option]:text-[#F3F5F3]"
              >
                <option value="any">Any amount</option>
                <option value="exact">Exactly</option>
                <option value="between">Between</option>
              </select>
            </div>
            {amountFilter.mode !== 'any' && (
              <div className="flex items-end gap-2 min-w-0">
                <div className="flex-1 min-w-0">
                  <label
                    htmlFor="search-amount-min"
                    className="block text-[11px] font-semibold uppercase tracking-wider text-[#5C6660] dark:text-[#9CA69F] mb-1.5"
                  >
                    {amountFilter.mode === 'exact' ? 'Amount' : 'From'}
                  </label>
                  <input
                    id="search-amount-min"
                    data-testid="search-amount-min"
                    type="text"
                    inputMode="decimal"
                    value={amountFilter.min}
                    onChange={(e) =>
                      setAmountFilter((f) => ({ ...f, min: e.target.value }))
                    }
                    placeholder="250.00"
                    className="lg-recessed-well w-full min-h-[45px] px-3.5 py-2 rounded-2xl text-xs font-medium font-mono tabular-nums text-[#141715] dark:text-[#F3F5F3] placeholder:text-[#68726C] dark:placeholder:text-[#8A938D] focus:outline-none focus:ring-2 focus:ring-emerald-500/60"
                  />
                </div>
                {amountFilter.mode === 'between' && (
                  <div className="flex-1 min-w-0">
                    <label
                      htmlFor="search-amount-max"
                      className="block text-[11px] font-semibold uppercase tracking-wider text-[#5C6660] dark:text-[#9CA69F] mb-1.5"
                    >
                      To
                    </label>
                    <input
                      id="search-amount-max"
                      data-testid="search-amount-max"
                      type="text"
                      inputMode="decimal"
                      value={amountFilter.max}
                      onChange={(e) =>
                        setAmountFilter((f) => ({ ...f, max: e.target.value }))
                      }
                      placeholder="1000"
                      className="lg-recessed-well w-full min-h-[45px] px-3.5 py-2 rounded-2xl text-xs font-medium font-mono tabular-nums text-[#141715] dark:text-[#F3F5F3] placeholder:text-[#68726C] dark:placeholder:text-[#8A938D] focus:outline-none focus:ring-2 focus:ring-emerald-500/60"
                    />
                  </div>
                )}
              </div>
            )}
            <div className="min-w-0">
              <label
                htmlFor="search-date-from"
                className="block text-[11px] font-semibold uppercase tracking-wider text-[#5C6660] dark:text-[#9CA69F] mb-1.5"
              >
                From date
              </label>
              <input
                id="search-date-from"
                data-testid="search-date-from"
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="lg-recessed-well w-full min-h-[45px] px-3.5 py-2 rounded-2xl text-xs font-medium font-mono text-[#141715] dark:text-[#F3F5F3] focus:outline-none focus:ring-2 focus:ring-emerald-500/60"
              />
            </div>
            <div className="min-w-0">
              <label
                htmlFor="search-date-to"
                className="block text-[11px] font-semibold uppercase tracking-wider text-[#5C6660] dark:text-[#9CA69F] mb-1.5"
              >
                To date
              </label>
              <input
                id="search-date-to"
                data-testid="search-date-to"
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="lg-recessed-well w-full min-h-[45px] px-3.5 py-2 rounded-2xl text-xs font-medium font-mono text-[#141715] dark:text-[#F3F5F3] focus:outline-none focus:ring-2 focus:ring-emerald-500/60"
              />
            </div>
          </div>
          <p className="text-[11px] text-[#5C6660] dark:text-[#9CA69F]">
            Amounts match the bill total in its group currency or in the currency it was paid in.
          </p>
        </div>

        {/* Spatial Search Results List */}
        <div className="space-y-3 min-w-0">
          {globalFilteredExpenses.length === 0 ? (
            <div className="lg-recessed-well text-center py-12 px-4 rounded-[1.375rem]">
              <span
                aria-hidden="true"
                className="lg-icon-orb h-11 w-11 rounded-full mx-auto mb-3 flex items-center justify-center text-[#5C6660] dark:text-[#9CA69F]"
              >
                <Funnel className="w-5 h-5" weight="duotone" />
              </span>
              <div className="text-sm font-semibold text-[#141715] dark:text-[#F3F5F3]">
                No bills match your search filters
              </div>
              <p className="text-xs text-[#5C6660] dark:text-[#9CA69F] mt-1">
                Try clearing the search query or resetting the dropdown filters above.
              </p>
            </div>
          ) : (
            globalFilteredExpenses.map((exp) => {
              const grp = dataset.groups.find((g) => g.id === exp.groupId);
              const isForeignFx = exp.originalCurrency !== exp.groupCurrency;
              const myMemberIdForExp = grp
                ? grp.members.find(
                    (m) =>
                      m.userId === dataset.currentUser.id ||
                      m.invitedEmail?.toLowerCase() ===
                        dataset.currentUser.email.toLowerCase()
                  )?.id ?? grp.members[0]?.id
                : exp.adHocParticipants?.find(
                    (p) =>
                      p.invitedEmail?.toLowerCase() ===
                        dataset.currentUser.email.toLowerCase() ||
                      p.displayName.toLowerCase() ===
                        dataset.currentUser.fullName.toLowerCase()
                  )?.id ?? exp.adHocParticipants?.[0]?.id;

              return (
                <div
                  key={exp.id}
                  className="lg-scene-tile p-4 sm:p-5 rounded-[1.375rem] flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 min-w-0"
                >
                  <div className="space-y-2 min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                      <StatusBadge tone="emerald" className="max-w-full min-w-0">
                        <Receipt className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                        <span dir="auto" className="truncate" title={grp?.name}>
                          {grp?.name ?? 'Direct 1-on-1 Split'}
                        </span>
                      </StatusBadge>
                      <StatusBadge tone="slate">{exp.category}</StatusBadge>
                      <StatusBadge tone="blue">Split: {exp.splitMode}</StatusBadge>
                      <CurrencyPrecisionPill currencyCode={exp.groupCurrency} />
                      {exp.hasUnresolvedConflict && (
                        <StatusBadge tone="amber">
                          <WarningCircle
                            className="w-3.5 h-3.5"
                            weight="fill"
                            aria-hidden="true"
                          />
                          <span>Needs Offline Review</span>
                        </StatusBadge>
                      )}
                    </div>

                    <div
                      dir="auto"
                      title={exp.title}
                      data-testid={`search-result-title-${exp.id}`}
                      className="text-base font-semibold tracking-tight text-[#141715] dark:text-[#F3F5F3] break-words [overflow-wrap:anywhere]"
                    >
                      {exp.title}
                    </div>

                    {exp.notes && (
                      <p
                        dir="auto"
                        className="text-xs leading-relaxed text-[#4A524D] dark:text-[#B7BEB9] break-words [overflow-wrap:anywhere]"
                      >
                        {exp.notes}
                      </p>
                    )}

                    {isForeignFx && (
                      <div className="lg-recessed-well inline-flex max-w-full items-center gap-1.5 text-[11px] font-mono text-sky-800 dark:text-sky-200 px-3 py-1.5 rounded-xl break-words [overflow-wrap:anywhere]">
                        <ArrowsLeftRight className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                        <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                          {exp.fxAuditNote ??
                            `Original: ${formatMinorToMajor(exp.originalAmountMinor, exp.originalCurrency)} ${exp.originalCurrency} -> ${formatMinorToMajor(exp.amountMinor, exp.groupCurrency)} ${exp.groupCurrency}`}
                        </span>
                      </div>
                    )}

                    <div className="flex flex-wrap items-center gap-1.5 pt-0.5 min-w-0">
                      <span className="text-[11px] font-mono tabular-nums text-[#5C6660] dark:text-[#9CA69F] mr-1">
                        {exp.expenseDate}
                      </span>
                      {exp.tags.map((t) => (
                        <button
                          key={t}
                          type="button"
                          onClick={() => setSearchQuery(t)}
                          className="lg-recessed-well min-h-[44px] sm:min-h-[28px] text-[11px] font-mono px-2.5 py-0.5 rounded-full text-[#2B312D] dark:text-[#DCE2DD] hover:text-[#2F8F6B] dark:hover:text-[#6BC5A1] transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
                        >
                          {t}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="flex flex-col sm:flex-row lg:flex-col items-start sm:items-center lg:items-end justify-between gap-3 shrink-0 border-t lg:border-t-0 pt-3.5 lg:pt-0 border-black/[0.07] dark:border-white/[0.08] min-w-0">
                    <div className="text-left lg:text-right space-y-1 min-w-0">
                      <div className="text-lg sm:text-xl font-semibold whitespace-nowrap text-[#141715] dark:text-[#F3F5F3]">
                        <CurrencyAmount
                          minorAmount={exp.amountMinor}
                          currencyCode={exp.groupCurrency}
                        />
                      </div>
                      <div>
                        <PersonalExpenseImpactBadge
                          expense={exp}
                          myMemberId={myMemberIdForExp}
                        />
                      </div>
                      {isForeignFx && (
                        <div className="text-xs font-mono text-[#5C6660] dark:text-[#9CA69F]">
                          Card Bill:{' '}
                          <CurrencyAmount
                            minorAmount={exp.originalAmountMinor}
                            currencyCode={exp.originalCurrency}
                          />{' '}
                          ({exp.originalCurrency})
                        </div>
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={() =>
                        handleJumpToGroup(
                          exp.groupId,
                          grp?.name ?? 'Direct Non-Group Split'
                        )
                      }
                      className="lg-luminous-pill min-h-[44px] inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-full text-xs font-semibold cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
                    >
                      <span>{exp.groupId ? 'Open in Group' : 'Open on Home'}</span>
                      <ArrowUpRight className="w-4 h-4 shrink-0" weight="bold" aria-hidden="true" />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </DoubleBezelCard>
    </div>
  );
}

export default AnalyticsAndSearchPage;
