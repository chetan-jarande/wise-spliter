import React, { useMemo, useState } from 'react';
import {
  ArrowsLeftRight,
  ArrowUpRight,
  ChartBar,
  ChartDonut,
  CheckCircle,
  CurrencyCircleDollar,
  Funnel,
  GlobeHemisphereWest,
  MagnifyingGlass,
  Receipt,
  SlidersHorizontal,
  Tag,
  Users,
  WarningCircle,
  X,
} from '@phosphor-icons/react';
import { useLedger } from '../../state/LedgerContext';
import {
  CurrencyAmount,
  CurrencyPrecisionPill,
  DoubleBezelCard,
  StatusBadge,
} from '../primitives/DesignPrimitives';
import { formatMinorToMajor } from '../../domain/money/currencies';
import { ExpenseCategoryKey, SplitMode } from '../../types/ledger';

const CATEGORY_COLORS: Record<ExpenseCategoryKey, { stroke: string; badge: string; dot: string }> = {
  lodging: {
    stroke: '#10b981',
    badge: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 ring-emerald-500/25',
    dot: 'bg-emerald-500',
  },
  activities: {
    stroke: '#0ea5e9',
    badge: 'bg-sky-500/10 text-sky-700 dark:text-sky-300 ring-sky-500/25',
    dot: 'bg-sky-500',
  },
  food: {
    stroke: '#f59e0b',
    badge: 'bg-amber-500/10 text-amber-700 dark:text-amber-300 ring-amber-500/25',
    dot: 'bg-amber-500',
  },
  transport: {
    stroke: '#6366f1',
    badge: 'bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 ring-indigo-500/25',
    dot: 'bg-indigo-500',
  },
  utilities: {
    stroke: '#14b8a6',
    badge: 'bg-teal-500/10 text-teal-700 dark:text-teal-300 ring-teal-500/25',
    dot: 'bg-teal-500',
  },
  groceries: {
    stroke: '#84cc16',
    badge: 'bg-lime-500/10 text-lime-700 dark:text-lime-300 ring-lime-500/25',
    dot: 'bg-lime-500',
  },
  flights: {
    stroke: '#ec4899',
    badge: 'bg-pink-500/10 text-pink-700 dark:text-pink-300 ring-pink-500/25',
    dot: 'bg-pink-500',
  },
  shopping: {
    stroke: '#f43f5e',
    badge: 'bg-rose-500/10 text-rose-700 dark:text-rose-300 ring-rose-500/25',
    dot: 'bg-rose-500',
  },
  general: {
    stroke: '#64748b',
    badge: 'bg-slate-500/10 text-slate-700 dark:text-slate-300 ring-slate-500/25',
    dot: 'bg-slate-500',
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
    colorHex: '#10b981',
  },
  {
    mode: 'shares',
    label: 'Weighted Shares',
    formulaNote: 'Proportional integer weight ratio (e.g. 2:1:1:2 shares)',
    colorHex: '#0ea5e9',
  },
  {
    mode: 'percentage',
    label: 'Percentage (Basis Points)',
    formulaNote: 'Exact 10,000 bps allocation (e.g. 40% / 30% / 30%)',
    colorHex: '#6366f1',
  },
  {
    mode: 'adjustment',
    label: '+/- Adjustment',
    formulaNote: 'Itemized surcharge deducted first, remainder split equally',
    colorHex: '#f59e0b',
  },
  {
    mode: 'exact',
    label: 'Exact Minor Amounts',
    formulaNote: 'Explicit minor unit assignment validated against bill total',
    colorHex: '#ec4899',
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
  } = useLedger();

  const [selectedCategoryFilter, setSelectedCategoryFilter] = useState<string>('all');
  const [selectedSplitModeFilter, setSelectedSplitModeFilter] = useState<string>('all');
  const [selectedCurrencyFilter, setSelectedCurrencyFilter] = useState<string>('all');
  const [selectedStatusFilter, setSelectedStatusFilter] = useState<'all' | 'conflict' | 'fx'>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
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
  ]);

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
    <div className="space-y-8">
      {/* Top Header & Active Group Selector */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <div className="inline-flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-emerald-600 dark:text-emerald-400 mb-1">
            <ChartDonut className="w-4 h-4" weight="duotone" />
            <span>Spending Telemetry & Cross-Ledger Search</span>
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-white">
            Visual Analytics & Global Instant Search
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
            Integer minor-unit spending distributions for{' '}
            <span className="font-semibold text-slate-900 dark:text-slate-200">
              {activeGroup.name}
            </span>{' '}
            plus multi-facet search across all {activeGroups.length} active groups.
          </p>
        </div>

        {/* Group Scope Switcher */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-slate-500 dark:text-slate-400 mr-1">
            Analytics Scope:
          </span>
          {activeGroups.map((grp) => {
            const isSelected = grp.id === activeGroup.id;
            return (
              <button
                key={grp.id}
                type="button"
                onClick={() => setActiveGroupId(grp.id)}
                className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition-all cursor-pointer flex items-center gap-1.5 ${
                  isSelected
                    ? 'bg-emerald-600 text-white shadow-sm'
                    : 'bg-slate-100 dark:bg-slate-800/80 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700/80'
                }`}
              >
                <span>{grp.name}</span>
                <span
                  className={`font-mono text-[10px] px-1.5 py-0.5 rounded ${
                    isSelected
                      ? 'bg-emerald-700 text-emerald-100'
                      : 'bg-slate-200/80 dark:bg-slate-700 text-slate-600 dark:text-slate-300'
                  }`}
                >
                  {grp.baseCurrency}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 1. KPI Summary Bento */}
      <div
        data-testid="analytics-kpi-grid"
        className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4"
      >
        <DoubleBezelCard innerClassName="flex flex-col justify-between space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Total Active Group Spend
            </span>
            <span className="p-2 rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
              <CurrencyCircleDollar className="w-5 h-5" weight="duotone" />
            </span>
          </div>
          <div>
            <div className="text-2xl font-bold text-slate-900 dark:text-white">
              <CurrencyAmount
                minorAmount={kpiStats.totalGroupSpendMinor}
                currencyCode={activeGroup.baseCurrency}
              />
            </div>
            <div className="mt-2 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
              <span>{groupExpenses.length} active bills</span>
              <CurrencyPrecisionPill currencyCode={activeGroup.baseCurrency} />
            </div>
          </div>
        </DoubleBezelCard>

        <DoubleBezelCard innerClassName="flex flex-col justify-between space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Your Personal Share
            </span>
            <span className="p-2 rounded-xl bg-sky-500/10 text-sky-600 dark:text-sky-400">
              <Users className="w-5 h-5" weight="duotone" />
            </span>
          </div>
          <div>
            <div className="text-2xl font-bold text-slate-900 dark:text-white">
              <CurrencyAmount
                minorAmount={kpiStats.personalShareMinor}
                currencyCode={activeGroup.baseCurrency}
              />
            </div>
            <div className="mt-2 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
              <span className="truncate max-w-[140px]">
                {dataset.currentUser.email}
              </span>
              <StatusBadge tone="blue">
                {kpiStats.personalSharePct}% of group
              </StatusBadge>
            </div>
          </div>
        </DoubleBezelCard>

        <DoubleBezelCard innerClassName="flex flex-col justify-between space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Total Settled Volume
            </span>
            <span className="p-2 rounded-xl bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
              <CheckCircle className="w-5 h-5" weight="duotone" />
            </span>
          </div>
          <div>
            <div className="text-2xl font-bold text-slate-900 dark:text-white">
              <CurrencyAmount
                minorAmount={kpiStats.totalSettledMinor}
                currencyCode={activeGroup.baseCurrency}
              />
            </div>
            <div className="mt-2 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
              <span>{kpiStats.settlementCount} recorded transfers</span>
              <StatusBadge tone="emerald">Audited HLC</StatusBadge>
            </div>
          </div>
        </DoubleBezelCard>

        <DoubleBezelCard innerClassName="flex flex-col justify-between space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Multi-Currency Bills Count
            </span>
            <span className="p-2 rounded-xl bg-amber-500/10 text-amber-600 dark:text-amber-400">
              <GlobeHemisphereWest className="w-5 h-5" weight="duotone" />
            </span>
          </div>
          <div>
            <div className="text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-white">
              {kpiStats.multiCurrencyAllCount}{' '}
              <span className="text-sm font-normal text-slate-500 dark:text-slate-400">
                cross-ledger bills
              </span>
            </div>
            <div className="mt-2 flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
              <span>{kpiStats.groupForeignBillsCount} in active group</span>
              <StatusBadge tone="amber">INR / EUR / JPY / KWD</StatusBadge>
            </div>
          </div>
        </DoubleBezelCard>
      </div>

      {/* 2. Visual Category Breakdown & Group Spend SVG Chart */}
      <DoubleBezelCard
        testId="analytics-category-breakdown"
        innerClassName="space-y-6"
      >
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-slate-200/70 dark:border-white/[0.06] pb-4">
          <div>
            <div className="flex items-center gap-2">
              <ChartBar
                className="w-5 h-5 text-emerald-600 dark:text-emerald-400"
                weight="duotone"
              />
              <h2 className="text-lg font-bold text-slate-900 dark:text-white">
                Category & Split Mode Spending Architecture
              </h2>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Proportional SVG ring chart, SVG horizontal distribution bars, and tabular minor-unit ledger breakdown for {activeGroup.name}.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <StatusBadge tone="emerald">
              Base: {activeGroup.baseCurrency}
            </StatusBadge>
            <StatusBadge tone="slate">
              Paid by You:{' '}
              {formatMinorToMajor(
                kpiStats.personalPaidMinor,
                activeGroup.baseCurrency
              )}
            </StatusBadge>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left 5 Cols: Interactive SVG Proportional Ring + SVG Horizontal Category Bars */}
          <div className="lg:col-span-5 flex flex-col items-center justify-center rounded-2xl bg-slate-50/80 dark:bg-slate-900/60 border border-slate-200/60 dark:border-white/[0.06] p-5 space-y-5">
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
                  strokeWidth="18"
                  className="text-slate-200/70 dark:text-slate-800"
                />
                {donutSegments.map((seg) => {
                  const isHighlighted =
                    highlightedCategory === null ||
                    highlightedCategory === seg.key;
                  return (
                    <circle
                      key={seg.key}
                      cx="90"
                      cy="90"
                      r={seg.radius}
                      fill="transparent"
                      stroke={seg.color.stroke}
                      strokeWidth={highlightedCategory === seg.key ? 22 : 18}
                      strokeDasharray={seg.dashArray}
                      strokeDashoffset={seg.dashOffset}
                      strokeLinecap="butt"
                      className="transition-all duration-300 cursor-pointer"
                      style={{ opacity: isHighlighted ? 1 : 0.3 }}
                      onMouseEnter={() => setHighlightedCategory(seg.key)}
                      onMouseLeave={() => setHighlightedCategory(null)}
                    />
                  );
                })}
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center text-center pointer-events-none px-4">
                <span className="text-[10px] font-mono uppercase tracking-wider text-slate-400 dark:text-slate-500">
                  {highlightedCategory
                    ? categoryBreakdown.find((c) => c.key === highlightedCategory)
                        ?.label
                    : 'Total Spend'}
                </span>
                <span className="text-sm font-bold font-mono tabular-nums text-slate-900 dark:text-white mt-0.5">
                  {highlightedCategory
                    ? formatMinorToMajor(
                        categoryBreakdown.find(
                          (c) => c.key === highlightedCategory
                        )?.amountMinor ?? 0,
                        activeGroup.baseCurrency
                      )
                    : formatMinorToMajor(
                        kpiStats.totalGroupSpendMinor,
                        activeGroup.baseCurrency
                      )}
                </span>
                <span className="text-[11px] font-mono text-emerald-600 dark:text-emerald-400">
                  {highlightedCategory
                    ? `${(
                        categoryBreakdown.find(
                          (c) => c.key === highlightedCategory
                        )?.percentage ?? 0
                      ).toFixed(1)}%`
                    : `${groupExpenses.length} bills`}
                </span>
              </div>
            </div>

            {/* SVG Horizontal Bar Chart for Active Categories */}
            <div className="w-full space-y-2">
              <div className="flex items-center justify-between text-[11px] font-mono uppercase tracking-wider text-slate-500 dark:text-slate-400">
                <span>SVG Proportional Category Bars</span>
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
                    return (
                      <g
                        key={cat.key}
                        transform={`translate(0, ${y})`}
                        className="cursor-pointer"
                        onMouseEnter={() => setHighlightedCategory(cat.key)}
                        onMouseLeave={() => setHighlightedCategory(null)}
                      >
                        <text
                          x="0"
                          y="14"
                          className="fill-slate-700 dark:fill-slate-300 text-[10px] font-medium"
                        >
                          {cat.label.slice(0, 15)}
                        </text>
                        <rect
                          x="96"
                          y="4"
                          width="170"
                          height="12"
                          rx="4"
                          className="fill-slate-200/60 dark:fill-slate-800/90"
                        />
                        <rect
                          x="96"
                          y="4"
                          width={Math.min(170, barWidth)}
                          height="12"
                          rx="4"
                          fill={cat.color.stroke}
                        />
                        <text
                          x="316"
                          y="14"
                          textAnchor="end"
                          className="fill-slate-700 dark:fill-slate-300 text-[10px] font-mono"
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
          <div className="lg:col-span-7 space-y-6">
            {/* Category Table */}
            <div className="overflow-x-auto rounded-2xl border border-slate-200/70 dark:border-white/[0.06]">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200/70 dark:border-white/[0.06] bg-slate-50/80 dark:bg-slate-900/50 text-[11px] font-mono uppercase tracking-wider text-slate-500 dark:text-slate-400">
                    <th className="py-2.5 px-3">Category</th>
                    <th className="py-2.5 px-3 text-right">Bills</th>
                    <th className="py-2.5 px-3 text-right">Amount</th>
                    <th className="py-2.5 px-3 text-right">Share</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200/50 dark:divide-white/[0.05] text-xs">
                  {categoryBreakdown.map((cat) => (
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
                        selectedCategoryFilter === cat.key
                          ? 'bg-emerald-500/10'
                          : 'hover:bg-slate-50 dark:hover:bg-slate-800/40'
                      }`}
                    >
                      <td className="py-2.5 px-3">
                        <div className="flex items-center gap-2">
                          <span
                            className={`w-2.5 h-2.5 rounded-full shrink-0 ${cat.color.dot}`}
                          />
                          <div>
                            <div className="font-semibold text-slate-900 dark:text-slate-100">
                              {cat.label}
                            </div>
                            <div className="text-[11px] text-slate-500 dark:text-slate-400 hidden sm:block">
                              {cat.description}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-600 dark:text-slate-300">
                        {cat.count}
                      </td>
                      <td className="py-2.5 px-3 text-right font-semibold text-slate-900 dark:text-white">
                        <CurrencyAmount
                          minorAmount={cat.amountMinor}
                          currencyCode={activeGroup.baseCurrency}
                        />
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-600 dark:text-slate-300">
                        {cat.percentage.toFixed(1)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Split Mode Tabular Breakdown */}
            <div className="rounded-2xl border border-slate-200/70 dark:border-white/[0.06] p-4 bg-slate-50/50 dark:bg-slate-900/30 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
                  <SlidersHorizontal className="w-4 h-4 text-emerald-500" />
                  <span>Split Mode Engine Distribution (5 Modes)</span>
                </span>
                <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                  Click any mode to filter global search
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-5 gap-2.5">
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
                      className={`text-left p-2.5 rounded-xl border transition-all cursor-pointer ${
                        isFiltered
                          ? 'border-emerald-500 bg-emerald-500/10 ring-1 ring-emerald-500/30'
                          : 'border-slate-200/70 dark:border-white/[0.06] bg-white dark:bg-slate-900/70 hover:border-slate-300 dark:hover:border-white/15'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-mono uppercase font-semibold text-slate-700 dark:text-slate-300">
                          {sm.mode}
                        </span>
                        <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
                          {sm.count}
                        </span>
                      </div>
                      <div className="mt-1.5 text-xs font-bold font-mono tabular-nums text-slate-900 dark:text-white truncate">
                        {formatMinorToMajor(
                          sm.amountMinor,
                          activeGroup.baseCurrency
                        )}
                      </div>
                      <div className="mt-0.5 text-[10px] font-mono tabular-nums text-slate-500 dark:text-slate-400">
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

      {/* 3. Instant Global Search & Multi-Facet Filter Engine */}
      <DoubleBezelCard
        testId="global-search-panel"
        innerClassName="space-y-5"
      >
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 border-b border-slate-200/70 dark:border-white/[0.06] pb-4">
          <div>
            <div className="flex items-center gap-2">
              <MagnifyingGlass
                className="w-5 h-5 text-emerald-600 dark:text-emerald-400"
                weight="bold"
              />
              <h2 className="text-lg font-bold text-slate-900 dark:text-white">
                Instant Global Search & Multi-Facet Filter Engine
              </h2>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              Query across all groups and expenses by title, notes, tag (#scuba, #villa, #shinkansen), category, split mode, currency, or conflict state.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <StatusBadge tone="emerald">
              {globalFilteredExpenses.length} matching expenses
            </StatusBadge>
            {(searchQuery ||
              selectedCategoryFilter !== 'all' ||
              selectedSplitModeFilter !== 'all' ||
              selectedCurrencyFilter !== 'all' ||
              selectedStatusFilter !== 'all') && (
              <button
                type="button"
                onClick={() => {
                  setSearchQuery('');
                  setSelectedCategoryFilter('all');
                  setSelectedSplitModeFilter('all');
                  setSelectedCurrencyFilter('all');
                  setSelectedStatusFilter('all');
                }}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold bg-rose-500/10 text-rose-600 dark:text-rose-400 hover:bg-rose-500/20 cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
                <span>Clear Filters</span>
              </button>
            )}
          </div>
        </div>

        {/* Search Input & Quick Tag Chips */}
        <div className="space-y-3">
          <div className="relative">
            <MagnifyingGlass className="w-5 h-5 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              data-testid="global-search-input"
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search bills, notes, #scuba, #villa, #shinkansen, EUR, JPY, KWD, conflict..."
              className="w-full pl-11 pr-10 py-3 rounded-xl bg-slate-50 dark:bg-slate-900/90 border border-slate-300/80 dark:border-white/10 text-sm text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
            {searchQuery && (
              <button
                type="button"
                aria-label="Clear search query"
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 p-1 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>

          {/* Quick Tag Chips */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="inline-flex items-center gap-1 text-[11px] font-mono text-slate-500 dark:text-slate-400 mr-1">
              <Tag className="w-3.5 h-3.5" />
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
                  className={`px-2.5 py-1 rounded-lg text-xs font-mono transition-colors cursor-pointer ${
                    active
                      ? 'bg-emerald-600 text-white'
                      : 'bg-slate-100 dark:bg-slate-800/80 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
                  }`}
                >
                  {tag}
                </button>
              );
            })}
          </div>

          {/* Multi-Facet Selectors Row */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 pt-1">
            <div>
              <label className="block text-[11px] font-mono uppercase text-slate-500 dark:text-slate-400 mb-1">
                Category Facet
              </label>
              <select
                aria-label="Filter by category"
                value={selectedCategoryFilter}
                onChange={(e) => setSelectedCategoryFilter(e.target.value)}
                className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-white/10 text-xs font-medium text-slate-800 dark:text-slate-200"
              >
                <option value="all">All Categories</option>
                {dataset.categoriesCatalog.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label} ({c.key})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-[11px] font-mono uppercase text-slate-500 dark:text-slate-400 mb-1">
                Split Mode Facet
              </label>
              <select
                aria-label="Filter by split mode"
                value={selectedSplitModeFilter}
                onChange={(e) => setSelectedSplitModeFilter(e.target.value)}
                className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-white/10 text-xs font-medium text-slate-800 dark:text-slate-200"
              >
                <option value="all">All Split Modes</option>
                <option value="equal">Equal Split (equal)</option>
                <option value="shares">Weighted Shares (shares)</option>
                <option value="percentage">Percentage (percentage)</option>
                <option value="adjustment">+/- Adjustment (adjustment)</option>
                <option value="exact">Exact Amounts (exact)</option>
              </select>
            </div>

            <div>
              <label className="block text-[11px] font-mono uppercase text-slate-500 dark:text-slate-400 mb-1">
                Currency Facet
              </label>
              <select
                aria-label="Filter by currency"
                value={selectedCurrencyFilter}
                onChange={(e) => setSelectedCurrencyFilter(e.target.value)}
                className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-white/10 text-xs font-medium text-slate-800 dark:text-slate-200"
              >
                <option value="all">All Currencies (INR, EUR, JPY, USD, KWD)</option>
                <option value="INR">INR - Indian Rupee (2-dec)</option>
                <option value="EUR">EUR - Euro (2-dec)</option>
                <option value="JPY">JPY - Japanese Yen (0-dec)</option>
                <option value="USD">USD - US Dollar (2-dec)</option>
                <option value="KWD">KWD - Kuwaiti Dinar (3-dec)</option>
              </select>
            </div>

            <div>
              <label className="block text-[11px] font-mono uppercase text-slate-500 dark:text-slate-400 mb-1">
                Audit / Conflict Status
              </label>
              <select
                aria-label="Filter by conflict or FX status"
                value={selectedStatusFilter}
                onChange={(e) =>
                  setSelectedStatusFilter(
                    e.target.value as 'all' | 'conflict' | 'fx'
                  )
                }
                className="w-full px-3 py-2 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-white/10 text-xs font-medium text-slate-800 dark:text-slate-200"
              >
                <option value="all">All Ledger States</option>
                <option value="conflict">Unresolved Offline Conflicts Only</option>
                <option value="fx">Foreign Currency Converted Bills Only</option>
              </select>
            </div>
          </div>
        </div>

        {/* Search Results List */}
        <div className="space-y-3">
          {globalFilteredExpenses.length === 0 ? (
            <div className="text-center py-10 rounded-2xl border border-dashed border-slate-300 dark:border-white/10">
              <Funnel className="w-8 h-8 text-slate-400 mx-auto mb-2" />
              <div className="text-sm font-semibold text-slate-700 dark:text-slate-300">
                No expenses match your current search facets
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                Try clearing the search query or resetting category/currency filters.
              </p>
            </div>
          ) : (
            globalFilteredExpenses.map((exp) => {
              const grp = dataset.groups.find((g) => g.id === exp.groupId);
              const isForeignFx = exp.originalCurrency !== exp.groupCurrency;
              return (
                <div
                  key={exp.id}
                  className="p-4 rounded-2xl border border-slate-200/80 dark:border-white/[0.07] bg-slate-50/60 dark:bg-slate-900/50 hover:border-emerald-500/40 transition-all flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4"
                >
                  <div className="space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge tone="emerald">
                        <Receipt className="w-3.5 h-3.5" />
                        <span>{grp?.name ?? 'Direct Non-Group Split'}</span>
                      </StatusBadge>
                      <StatusBadge tone="slate">{exp.category}</StatusBadge>
                      <StatusBadge tone="blue">
                        Split: {exp.splitMode}
                      </StatusBadge>
                      <CurrencyPrecisionPill currencyCode={exp.groupCurrency} />
                      {exp.hasUnresolvedConflict && (
                        <StatusBadge tone="amber">
                          <WarningCircle className="w-3.5 h-3.5" weight="fill" />
                          <span>Offline Edit Conflict</span>
                        </StatusBadge>
                      )}
                    </div>

                    <div className="text-base font-bold text-slate-900 dark:text-white">
                      {exp.title}
                    </div>

                    <p className="text-xs text-slate-600 dark:text-slate-400">
                      {exp.notes}
                    </p>

                    {isForeignFx && (
                      <div className="inline-flex items-center gap-1.5 text-xs font-mono text-sky-700 dark:text-sky-300 bg-sky-500/10 px-2.5 py-1 rounded-lg">
                        <ArrowsLeftRight className="w-3.5 h-3.5" />
                        <span>
                          {exp.fxAuditNote ??
                            `Original: ${formatMinorToMajor(exp.originalAmountMinor, exp.originalCurrency)} ${exp.originalCurrency} -> ${formatMinorToMajor(exp.amountMinor, exp.groupCurrency)} ${exp.groupCurrency}`}
                        </span>
                      </div>
                    )}

                    <div className="flex flex-wrap items-center gap-1.5 pt-1">
                      <span className="text-[11px] font-mono text-slate-400">
                        {exp.expenseDate}
                      </span>
                      {exp.tags.map((t) => (
                        <button
                          key={t}
                          type="button"
                          onClick={() => setSearchQuery(t)}
                          className="text-[11px] font-mono px-2 py-0.5 rounded-md bg-slate-200/70 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:text-emerald-600 dark:hover:text-emerald-400 cursor-pointer"
                        >
                          {t}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="flex sm:flex-row lg:flex-col items-start sm:items-center lg:items-end justify-between gap-3 shrink-0 border-t lg:border-t-0 pt-3 lg:pt-0 border-slate-200/60 dark:border-white/[0.06]">
                    <div className="text-left lg:text-right">
                      <div className="text-lg font-bold text-slate-900 dark:text-white">
                        <CurrencyAmount
                          minorAmount={exp.amountMinor}
                          currencyCode={exp.groupCurrency}
                        />
                      </div>
                      {isForeignFx && (
                        <div className="text-xs font-mono text-slate-500 dark:text-slate-400">
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
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white shadow-sm transition-colors cursor-pointer"
                    >
                      <span>{exp.groupId ? 'Inspect in Group' : 'Inspect on Home'}</span>
                      <ArrowUpRight className="w-4 h-4" weight="bold" />
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
