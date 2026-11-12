import React, { useMemo, useState } from 'react';
import {
  ArrowCounterClockwiseIcon as ArrowCounterClockwise,
  ArrowsLeftRightIcon as ArrowsLeftRight,
  CaretDownIcon as CaretDown,
  CheckCircleIcon as CheckCircle,
  ClockCounterClockwiseIcon as ClockCounterClockwise,
  FunnelIcon as Funnel,
  GitBranchIcon as GitBranch,
  GlobeHemisphereWestIcon as GlobeHemisphereWest,
  MagnifyingGlassIcon as MagnifyingGlass,
  ShieldCheckIcon as ShieldCheck,
  SparkleIcon as Sparkle,
  TrashIcon as Trash,
  UsersIcon as Users,
  WarningOctagonIcon as WarningOctagon,
} from '@phosphor-icons/react';
import { useLedger } from '../../state/LedgerContext';
import {
  ActionTypeCatalogItem,
  ExpenseItem,
  ExpenseRevision,
  GroupActivityActionType,
} from '../../types/ledger';
import { CurrencyAmount, DoubleBezelCard, StatusBadge } from '../primitives/DesignPrimitives';

function getInitialsFromName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return `${parts[0]?.[0] ?? ''}${parts[parts.length - 1]?.[0] ?? ''}`.toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

function formatIsoTimestamp(iso: string | null): string {
  if (!iso) return 'N/A';
  return iso.replace('T', ' ').replace('Z', ' UTC');
}

function getActionBadgeTone(
  action: GroupActivityActionType,
  catalog: ActionTypeCatalogItem[]
): 'emerald' | 'blue' | 'amber' | 'rose' | 'slate' {
  const found = catalog.find((item) => item.action === action);
  if (found) return found.badgeTone;
  switch (action) {
    case 'expense_created':
    case 'expense_restored':
    case 'expense_conflict_resolved':
    case 'settlement_recorded':
    case 'member_claimed':
    case 'group_created':
      return 'emerald';
    case 'expense_updated':
    case 'group_currency_changed':
    case 'group_updated':
      return 'blue';
    case 'expense_conflict_flagged':
      return 'amber';
    case 'expense_deleted':
    case 'settlement_deleted':
    case 'member_removed':
      return 'rose';
    default:
      return 'slate';
  }
}

function getActionLabel(
  action: GroupActivityActionType,
  catalog: ActionTypeCatalogItem[]
): string {
  const found = catalog.find((item) => item.action === action);
  if (found) return found.label;
  return action.replace(/_/g, ' ');
}

export function ActivityAndTrashPage() {
  const {
    dataset,
    activeGroupId,
    activeGroup,
    restoreExpense,
    softDeleteExpense,
    restoreExpenseRevision,
  } = useLedger();

  const [scope, setScope] = useState<'group' | 'global'>('group');
  const [selectedAction, setSelectedAction] = useState<'all' | GroupActivityActionType>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedExpenseIdForDeleteDemo, setSelectedExpenseIdForDeleteDemo] = useState<string>('');

  const groupMap = useMemo(() => {
    const map = new Map<string, { name: string; baseCurrency: string }>();
    for (const grp of dataset.groups) {
      map.set(grp.id, { name: grp.name, baseCurrency: grp.baseCurrency });
    }
    return map;
  }, [dataset.groups]);

  const memberNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const grp of dataset.groups) {
      for (const mem of grp.members) {
        map.set(mem.id, mem.displayName);
      }
    }
    return map;
  }, [dataset.groups]);

  const currentGroupActivityCount = useMemo(
    () => dataset.groupActivityLog.filter((item) => item.groupId === activeGroupId).length,
    [dataset.groupActivityLog, activeGroupId]
  );

  const globalActivityCount = dataset.groupActivityLog.length;

  const filteredActivities = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    return dataset.groupActivityLog.filter((item) => {
      if (scope === 'group' && item.groupId !== activeGroupId) {
        return false;
      }
      if (selectedAction !== 'all' && item.action !== selectedAction) {
        return false;
      }
      if (normalizedQuery) {
        const haystack = `${item.actorDisplayName} ${item.summaryText} ${item.detailNote} ${item.diffBadges.join(' ')} ${item.hlc}`.toLowerCase();
        if (!haystack.includes(normalizedQuery)) {
          return false;
        }
      }
      return true;
    });
  }, [dataset.groupActivityLog, scope, activeGroupId, selectedAction, searchQuery]);

  const selectedCatalogMeta = useMemo(() => {
    if (selectedAction === 'all') return null;
    return dataset.actionTypesCatalog.find((c) => c.action === selectedAction) ?? null;
  }, [dataset.actionTypesCatalog, selectedAction]);

  const revisionsByExpense = useMemo(() => {
    const grouped = new Map<
      string,
      {
        expense: ExpenseItem | undefined;
        groupName: string;
        groupCurrency: string;
        revisions: ExpenseRevision[];
      }
    >();

    for (const rev of dataset.expenseRevisions) {
      const existing = grouped.get(rev.expenseId);
      if (existing) {
        existing.revisions.push(rev);
      } else {
        const exp = dataset.expenses.find((e) => e.id === rev.expenseId);
        const grp = rev.groupId ? groupMap.get(rev.groupId) : undefined;
        grouped.set(rev.expenseId, {
          expense: exp,
          groupName: grp?.name ?? (rev.groupId ?? 'Direct Non-Group Split'),
          groupCurrency: exp?.groupCurrency ?? grp?.baseCurrency ?? 'INR',
          revisions: [rev],
        });
      }
    }

    for (const entry of grouped.values()) {
      entry.revisions.sort((a, b) => {
        if (a.revisionNumber !== b.revisionNumber) {
          return a.revisionNumber - b.revisionNumber;
        }
        return a.hlc.localeCompare(b.hlc);
      });
    }

    return Array.from(grouped.entries()).map(([expenseId, data]) => ({
      expenseId,
      ...data,
    }));
  }, [dataset.expenseRevisions, dataset.expenses, groupMap]);

  const trashedExpenses = useMemo(
    () => dataset.expenses.filter((exp) => exp.deletedAt !== null),
    [dataset.expenses]
  );

  const activeGroupNonDeletedExpenses = useMemo(
    () => dataset.expenses.filter((exp) => exp.groupId === activeGroupId && exp.deletedAt === null),
    [dataset.expenses, activeGroupId]
  );

  return (
    <div className="space-y-6">
      {/* Header & Scope / Action Filter Controls */}
      <DoubleBezelCard>
        <div className="flex flex-col gap-5">
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
            <div className="space-y-1.5">
              <div className="inline-flex flex-wrap items-center gap-2">
                <StatusBadge tone="emerald">
                  <ShieldCheck weight="fill" className="w-3.5 h-3.5" />
                  <span>Full Edit Transparency</span>
                </StatusBadge>
                <StatusBadge tone="blue">
                  <GitBranch weight="bold" className="w-3.5 h-3.5" />
                  <span>1-Tap Version &amp; Trash Restore</span>
                </StatusBadge>
              </div>
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-white">
                Activity Timeline, Edit History &amp; Trash
              </h1>
              <p className="text-sm text-slate-600 dark:text-slate-400 max-w-3xl">
                See every bill added, edited, settled, or deleted across your groups - and restore any earlier version or trashed bill in one tap.
              </p>
            </div>

            {/* Scope Toggle */}
            <div
              data-testid="activity-scope-toggle"
              onClick={() => setScope((prev) => (prev === 'group' ? 'global' : 'group'))}
              role="group"
              aria-label="Activity timeline scope toggle"
              className="inline-flex items-center rounded-2xl p-1 bg-slate-100 dark:bg-slate-800/90 ring-1 ring-slate-300/70 dark:ring-white/10 self-start lg:self-auto cursor-pointer select-none"
            >
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setScope('group');
                }}
                className={`inline-flex items-center gap-2 rounded-xl px-3.5 py-2 text-xs font-semibold transition-all cursor-pointer ${
                  scope === 'group'
                    ? 'bg-emerald-500 text-slate-950 shadow-sm pointer-events-none'
                    : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                <Users weight="bold" className="w-4 h-4" />
                <span>This Group</span>
                <span className="font-mono tabular-nums text-[11px] px-1.5 py-0.5 rounded-full bg-black/10 dark:bg-white/10">
                  {currentGroupActivityCount}
                </span>
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setScope('global');
                }}
                className={`inline-flex items-center gap-2 rounded-xl px-3.5 py-2 text-xs font-semibold transition-all cursor-pointer ${
                  scope === 'global'
                    ? 'bg-emerald-500 text-slate-950 shadow-sm pointer-events-none'
                    : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                <GlobeHemisphereWest weight="bold" className="w-4 h-4" />
                <span>All Groups</span>
                <span className="font-mono tabular-nums text-[11px] px-1.5 py-0.5 rounded-full bg-black/10 dark:bg-white/10">
                  {globalActivityCount}
                </span>
              </button>
            </div>
          </div>

          {/* Search & Action Type Filter Pills */}
          <div className="pt-3 border-t border-slate-200/70 dark:border-white/[0.06] space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                <Funnel weight="bold" className="w-4 h-4 text-emerald-500" />
                <span>Filter Updates by Type</span>
              </div>
              <div className="relative w-full sm:w-72">
                <MagnifyingGlass
                  weight="bold"
                  className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none"
                />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search person, bill title, or change..."
                  aria-label="Search activity log"
                  className="w-full rounded-xl pl-9 pr-3 py-1.5 text-xs bg-slate-100/90 dark:bg-slate-800/80 text-slate-900 dark:text-slate-100 placeholder:text-slate-400 border border-slate-300/70 dark:border-white/10 focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
                />
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setSelectedAction('all')}
                className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold transition-all ${
                  selectedAction === 'all'
                    ? 'bg-slate-900 text-white dark:bg-emerald-500 dark:text-slate-950 shadow-xs'
                    : 'bg-slate-100 dark:bg-slate-800/80 text-slate-700 dark:text-slate-300 hover:bg-slate-200/80 dark:hover:bg-slate-700/80 ring-1 ring-slate-300/60 dark:ring-white/10'
                }`}
              >
                <span>All Actions</span>
                <span className="font-mono tabular-nums text-[11px] opacity-80">
                  ({scope === 'group' ? currentGroupActivityCount : globalActivityCount})
                </span>
              </button>

              {dataset.actionTypesCatalog.map((cat) => {
                const isSelected = selectedAction === cat.action;
                const count = dataset.groupActivityLog.filter(
                  (a) =>
                    (scope === 'global' || a.groupId === activeGroupId) &&
                    a.action === cat.action
                ).length;

                return (
                  <button
                    key={cat.action}
                    type="button"
                    onClick={() => setSelectedAction(cat.action)}
                    className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold transition-all ${
                      isSelected
                        ? 'bg-slate-900 text-white dark:bg-emerald-500 dark:text-slate-950 shadow-xs'
                        : 'bg-slate-100 dark:bg-slate-800/80 text-slate-700 dark:text-slate-300 hover:bg-slate-200/80 dark:hover:bg-slate-700/80 ring-1 ring-slate-300/60 dark:ring-white/10'
                    }`}
                  >
                    <span>{cat.label}</span>
                    <span className="font-mono tabular-nums text-[11px] opacity-75">
                      ({count})
                    </span>
                  </button>
                );
              })}
            </div>

            {selectedCatalogMeta && (
              <div className="rounded-xl p-3 bg-slate-50 dark:bg-slate-900/90 border border-slate-200/80 dark:border-white/10 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <StatusBadge tone={selectedCatalogMeta.badgeTone}>
                    {selectedCatalogMeta.label}
                  </StatusBadge>
                  <span className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
                    action_code: {selectedCatalogMeta.action}
                  </span>
                </div>
                <div className="text-xs text-slate-600 dark:text-slate-300">
                  <span className="font-semibold text-slate-800 dark:text-slate-200">
                    Audit Note Template:{' '}
                  </span>
                  <span className="font-mono tabular-nums">
                    {selectedCatalogMeta.sampleNoteTemplate}
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
      </DoubleBezelCard>

      {/* Main Responsive 12-Column Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left 7 Columns: Transparent Group Activity Timeline */}
        <div className="lg:col-span-7 space-y-6">
          <DoubleBezelCard testId="activity-feed-list">
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-slate-200/70 dark:border-white/[0.06]">
                <div className="flex items-center gap-2.5">
                  <div className="w-9 h-9 rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 flex items-center justify-center ring-1 ring-emerald-500/25">
                    <ClockCounterClockwise weight="bold" className="w-5 h-5" />
                  </div>
                  <div>
                    <h2 className="text-base font-bold text-slate-900 dark:text-white">
                      {scope === 'group'
                        ? `Group Activity Feed - ${activeGroup.name}`
                        : 'All Groups Global Activity Timeline'}
                    </h2>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      Showing{' '}
                      <span className="font-mono tabular-nums font-semibold text-slate-700 dark:text-slate-200">
                        {filteredActivities.length}
                      </span>{' '}
                      updates in chronological order
                    </p>
                  </div>
                </div>

                {scope === 'group' && (
                  <button
                    type="button"
                    onClick={() => setScope('global')}
                    className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 hover:underline inline-flex items-center gap-1"
                  >
                    <GlobeHemisphereWest weight="bold" className="w-3.5 h-3.5" />
                    <span>Switch to Global ({globalActivityCount})</span>
                  </button>
                )}
              </div>

              {filteredActivities.length === 0 ? (
                <div className="rounded-2xl p-6 text-center bg-slate-50/70 dark:bg-slate-900/50 border border-dashed border-slate-300 dark:border-white/10 space-y-2">
                  <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">
                    No recorded events match the current filter in this scope.
                  </p>
                  {selectedCatalogMeta && (
                    <p className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                      Schema Template ({selectedCatalogMeta.label}): {selectedCatalogMeta.sampleNoteTemplate}
                    </p>
                  )}
                  <div className="pt-2 flex items-center justify-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedAction('all');
                        setSearchQuery('');
                      }}
                      className="rounded-xl px-3 py-1.5 text-xs font-semibold bg-emerald-500 text-slate-950 hover:bg-emerald-400 transition"
                    >
                      Reset Action Filter
                    </button>
                    {scope === 'group' && (
                      <button
                        type="button"
                        onClick={() => setScope('global')}
                        className="rounded-xl px-3 py-1.5 text-xs font-semibold bg-slate-200 dark:bg-slate-800 text-slate-800 dark:text-slate-200 hover:bg-slate-300 dark:hover:bg-slate-700 transition"
                      >
                        Inspect Global Timeline
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  {filteredActivities.map((item) => {
                    const grpInfo = item.groupId ? groupMap.get(item.groupId) : undefined;
                    const badgeTone = getActionBadgeTone(item.action, dataset.actionTypesCatalog);
                    const actionLabel = getActionLabel(item.action, dataset.actionTypesCatalog);
                    const initials = getInitialsFromName(item.actorDisplayName);

                    return (
                      <div
                        key={item.id}
                        data-testid={`activity-item-${item.id}`}
                        className="rounded-2xl p-4 bg-slate-50/90 dark:bg-slate-900/70 border border-slate-200/80 dark:border-white/[0.07] hover:border-slate-300 dark:hover:border-white/15 transition-all space-y-2.5"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex items-start gap-3">
                            <div
                              aria-hidden="true"
                              className="w-9 h-9 rounded-xl bg-slate-900 text-white dark:bg-emerald-500/15 dark:text-emerald-300 ring-1 ring-slate-900/10 dark:ring-emerald-500/30 flex items-center justify-center text-xs font-bold font-mono shrink-0"
                            >
                              {initials}
                            </div>
                            <div className="space-y-1">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <StatusBadge tone={badgeTone}>{actionLabel}</StatusBadge>
                                {grpInfo && (
                                  <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium bg-slate-200/70 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
                                    {grpInfo.name} ({grpInfo.baseCurrency})
                                  </span>
                                )}
                                <span className="text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400">
                                  {formatIsoTimestamp(item.createdAt)}
                                </span>
                              </div>
                              <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                                {item.summaryText}
                              </p>
                            </div>
                          </div>
                        </div>

                        <p className="text-xs text-slate-600 dark:text-slate-300 pl-12 leading-relaxed">
                          {item.detailNote}
                        </p>

                        <div className="flex flex-wrap items-center justify-between gap-2 pl-12 pt-0.5">
                          <div className="flex flex-wrap items-center gap-1.5">
                            {item.diffBadges.map((badge, idx) => (
                              <span
                                key={`${item.id}_badge_${idx}`}
                                className="inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-mono tabular-nums font-medium bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 ring-1 ring-slate-300/70 dark:ring-white/10"
                              >
                                {badge}
                              </span>
                            ))}
                          </div>

                          <details className="ws-disclosure text-[11px] text-slate-400">
                            <summary className="inline-flex items-center gap-1 hover:text-slate-600 dark:hover:text-slate-200">
                              <span>Audit Stamp</span>
                              <CaretDown className="w-3 h-3" weight="bold" />
                            </summary>
                            <span className="mt-1 block font-mono tabular-nums text-[10px]">
                              HLC: {item.hlc}
                            </span>
                          </details>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </DoubleBezelCard>
        </div>

        {/* Right 5 Columns: Per-Expense Revision Inspector & Trash Recovery Vault */}
        <div className="lg:col-span-5 space-y-6">
          {/* Immutable Per-Expense Revision History & Conflict Inspector */}
          <DoubleBezelCard testId="revision-history-panel">
            <div className="space-y-4">
              <div className="flex items-start justify-between gap-3 pb-3 border-b border-slate-200/70 dark:border-white/[0.06]">
                <div className="flex items-center gap-2.5">
                  <div className="w-9 h-9 rounded-xl bg-amber-500/12 text-amber-600 dark:text-amber-400 flex items-center justify-center ring-1 ring-amber-500/30">
                    <GitBranch weight="bold" className="w-5 h-5" />
                  </div>
                  <div>
                    <h2 className="text-base font-bold text-slate-900 dark:text-white">
                      Per-Expense Revision & Conflict Inspector
                    </h2>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      Causal revision tree with field-level diffs and 1-click version restore
                    </p>
                  </div>
                </div>
                <StatusBadge tone="amber">
                  <span className="font-mono tabular-nums">{dataset.expenseRevisions.length} Revisions</span>
                </StatusBadge>
              </div>

              <div className="space-y-5">
                {revisionsByExpense.map(({ expenseId, expense, groupName, groupCurrency, revisions }) => {
                  const hasConflict = expense?.hasUnresolvedConflict ?? false;
                  const activeRevId = expense?.currentRevisionId ?? null;

                  return (
                    <div
                      key={expenseId}
                      className="rounded-2xl p-4 bg-slate-50/90 dark:bg-slate-900/75 border border-slate-200/80 dark:border-white/[0.08] space-y-3.5"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                              {groupName}
                            </span>
                            {hasConflict ? (
                              <StatusBadge tone="amber">
                                <WarningOctagon weight="fill" className="w-3.5 h-3.5" />
                                <span>Concurrent Offline Edit Conflict</span>
                              </StatusBadge>
                            ) : (
                              <StatusBadge tone="emerald">
                                <CheckCircle weight="fill" className="w-3.5 h-3.5" />
                                <span>Clean Causal Chain</span>
                              </StatusBadge>
                            )}
                          </div>
                          <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                            {expense?.title ?? revisions[revisions.length - 1]?.snapshot.title ?? expenseId}
                          </h3>
                        </div>

                        {expense && (
                          <div className="text-right">
                            <div className="text-[11px] text-slate-500 dark:text-slate-400">
                              Active Ledger Total
                            </div>
                            <CurrencyAmount
                              minorAmount={expense.amountMinor}
                              currencyCode={groupCurrency}
                              className="text-sm font-bold text-slate-900 dark:text-white"
                            />
                          </div>
                        )}
                      </div>

                      {/* Revision Chain Items */}
                      <div className="space-y-3">
                        {revisions.map((rev) => {
                          const isCurrentActive = activeRevId === rev.id;
                          const isConflictBranch =
                            rev.isConflictBranch || rev.action === 'conflict_superseded';

                          return (
                            <div
                              key={rev.id}
                              data-testid={`revision-card-${rev.id}`}
                              className={`rounded-xl p-3.5 border transition-all space-y-2.5 ${
                                isCurrentActive
                                  ? 'bg-emerald-500/[0.06] dark:bg-emerald-500/[0.08] border-emerald-500/40'
                                  : isConflictBranch
                                  ? 'bg-amber-500/[0.06] dark:bg-amber-500/[0.08] border-amber-500/40'
                                  : 'bg-white dark:bg-slate-800/70 border-slate-200/80 dark:border-white/10'
                              }`}
                            >
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <span className="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-mono tabular-nums font-bold bg-slate-900 text-white dark:bg-white dark:text-slate-900">
                                    Rev #{rev.revisionNumber}
                                  </span>
                                  {isCurrentActive && (
                                    <StatusBadge tone="emerald">Active Head</StatusBadge>
                                  )}
                                  {isConflictBranch && (
                                    <StatusBadge tone="amber">Conflict Branch</StatusBadge>
                                  )}
                                  {!isCurrentActive && !isConflictBranch && (
                                    <StatusBadge tone="slate">{rev.action}</StatusBadge>
                                  )}
                                  <span className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                                    by {rev.actorDisplayName}
                                  </span>
                                </div>

                                <CurrencyAmount
                                  minorAmount={rev.snapshot.amountMinor}
                                  currencyCode={groupCurrency}
                                  className="text-xs font-bold text-slate-900 dark:text-white"
                                />
                              </div>

                              {/* Structured Field-by-Field Diffs */}
                              <div className="space-y-1.5 pt-1">
                                {rev.changes.map((chg, cIdx) => (
                                  <div
                                    key={`${rev.id}_chg_${cIdx}`}
                                    className="rounded-lg px-2.5 py-1.5 bg-slate-100/90 dark:bg-slate-900/90 border border-slate-200/70 dark:border-white/[0.06] text-xs space-y-0.5"
                                  >
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                      <span className="font-semibold text-slate-700 dark:text-slate-300">
                                        {chg.field.replace(/_/g, ' ')}
                                      </span>
                                      <div className="inline-flex items-center gap-1.5 font-mono tabular-nums text-[11px]">
                                        <span className="px-1.5 py-0.5 rounded bg-rose-500/10 text-rose-700 dark:text-rose-300">
                                          {chg.fromValue}
                                        </span>
                                        <ArrowsLeftRight weight="bold" className="w-3 h-3 text-slate-400" />
                                        <span className="px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
                                          {chg.toValue}
                                        </span>
                                      </div>
                                    </div>
                                    <p className="text-[11px] text-slate-600 dark:text-slate-400">
                                      {chg.label}
                                    </p>
                                  </div>
                                ))}
                              </div>

                              {/* Collapsible Technical Audit Details */}
                              <details className="ws-disclosure text-[11px] text-slate-400">
                                <summary className="inline-flex items-center gap-1 hover:text-slate-600 dark:hover:text-slate-200">
                                  <span>Technical / Audit Details</span>
                                  <CaretDown className="w-3 h-3" weight="bold" />
                                </summary>
                                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] font-mono tabular-nums text-slate-500 dark:text-slate-400">
                                  <span>id: {rev.id}</span>
                                  <span>base: {rev.baseRevisionId ?? 'Initial'}</span>
                                  <span>HLC: {rev.hlc}</span>
                                </div>
                              </details>

                              {/* Snapshot Summary & Restore Button */}
                              <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                                <span className="text-[11px] text-slate-500 dark:text-slate-400 font-mono tabular-nums">
                                  Split: {rev.snapshot.splitMode.toUpperCase()} |{' '}
                                  {formatIsoTimestamp(rev.createdAt)}
                                </span>

                                <button
                                  type="button"
                                  data-testid={`restore-revision-${rev.id}`}
                                  onClick={() => restoreExpenseRevision(rev.expenseId, rev.id)}
                                  className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition-all cursor-pointer ${
                                    isCurrentActive
                                      ? 'bg-slate-200/80 dark:bg-slate-700/80 text-slate-800 dark:text-slate-200 hover:bg-emerald-500 hover:text-slate-950'
                                      : 'bg-emerald-500 text-slate-950 hover:bg-emerald-400 shadow-xs'
                                  }`}
                                >
                                  <ArrowCounterClockwise weight="bold" className="w-3.5 h-3.5" />
                                  <span>Restore This Revision</span>
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </DoubleBezelCard>

          {/* Trash & Soft-Delete Recovery Vault */}
          <DoubleBezelCard testId="trash-recovery-panel">
            <div className="space-y-4">
              <div className="flex items-start justify-between gap-3 pb-3 border-b border-slate-200/70 dark:border-white/[0.06]">
                <div className="flex items-center gap-2.5">
                  <div className="w-9 h-9 rounded-xl bg-rose-500/10 text-rose-600 dark:text-rose-400 flex items-center justify-center ring-1 ring-rose-500/25">
                    <Trash weight="bold" className="w-5 h-5" />
                  </div>
                  <div>
                    <h2 className="text-base font-bold text-slate-900 dark:text-white">
                      Trash & Soft-Delete Recovery Vault
                    </h2>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      Zero data loss: soft-deleted bills retain full payer and split shares for instant recovery
                    </p>
                  </div>
                </div>
                <StatusBadge tone={trashedExpenses.length > 0 ? 'rose' : 'emerald'}>
                  <span className="font-mono tabular-nums">{trashedExpenses.length} in Trash</span>
                </StatusBadge>
              </div>

              {trashedExpenses.length === 0 ? (
                <div className="rounded-2xl p-5 text-center bg-slate-50/80 dark:bg-slate-900/50 border border-dashed border-slate-300 dark:border-white/10 space-y-2">
                  <Sparkle weight="duotone" className="w-6 h-6 text-emerald-500 mx-auto" />
                  <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">
                    Trash Vault is Clean
                  </p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    All soft-deleted expenses have been restored to their active group ledgers.
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {trashedExpenses.map((exp) => {
                    const grpInfo = exp.groupId ? groupMap.get(exp.groupId) : undefined;
                    const includedSplits = exp.splits.filter((s) => s.included);

                    return (
                      <div
                        key={exp.id}
                        data-testid={`trash-item-${exp.id}`}
                        className="rounded-2xl p-4 bg-rose-500/[0.04] dark:bg-rose-500/[0.06] border border-rose-500/25 space-y-3"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="space-y-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <StatusBadge tone="rose">Soft-Deleted</StatusBadge>
                              {grpInfo && (
                                <span className="text-xs font-medium text-slate-600 dark:text-slate-300">
                                  {grpInfo.name}
                                </span>
                              )}
                              <span className="text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400">
                                ({exp.splitMode.toUpperCase()} split)
                              </span>
                            </div>
                            <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                              {exp.title}
                            </h3>
                            {exp.notes && (
                              <p className="text-xs text-slate-600 dark:text-slate-300">
                                {exp.notes}
                              </p>
                            )}
                          </div>

                          <div className="text-right shrink-0">
                            <div className="text-[11px] text-slate-500 dark:text-slate-400">
                              Amount
                            </div>
                            <CurrencyAmount
                              minorAmount={exp.amountMinor}
                              currencyCode={exp.groupCurrency}
                              className="text-base font-bold text-rose-600 dark:text-rose-400"
                            />
                          </div>
                        </div>

                        {/* Preserved Split Breakdown */}
                        <div className="rounded-xl p-2.5 bg-white/80 dark:bg-slate-900/80 border border-slate-200/70 dark:border-white/[0.06] space-y-1.5">
                          <div className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                            Preserved Participant Shares ({includedSplits.length} members):
                          </div>
                          <div className="flex flex-wrap gap-1.5">
                            {includedSplits.map((split) => {
                              const memberName =
                                memberNameMap.get(split.memberId) ?? split.memberId;
                              return (
                                <span
                                  key={`${exp.id}_split_${split.memberId}`}
                                  className="inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-[11px] bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 ring-1 ring-slate-300/60 dark:ring-white/10"
                                >
                                  <span>{memberName}:</span>
                                  <CurrencyAmount
                                    minorAmount={split.owedMinor}
                                    currencyCode={exp.groupCurrency}
                                    className="font-semibold"
                                  />
                                </span>
                              );
                            })}
                          </div>
                        </div>

                        {/* Deleted Timestamp, HLC & 1-Click Restore */}
                        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                          <div className="text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400 space-y-0.5">
                            <div>Deleted at: {formatIsoTimestamp(exp.deletedAt)}</div>
                            <div>HLC: {exp.hlc}</div>
                          </div>

                          <button
                            type="button"
                            data-testid={`restore-trash-${exp.id}`}
                            onClick={() => restoreExpense(exp.id)}
                            className="inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-semibold bg-emerald-500 text-slate-950 hover:bg-emerald-400 transition shadow-xs cursor-pointer"
                          >
                            <ArrowCounterClockwise weight="bold" className="w-4 h-4" />
                            <span>Restore to Ledger</span>
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Quick Soft-Delete Utility (Collapsed by Default) */}
              {activeGroupNonDeletedExpenses.length > 0 && (
                <details className="ws-disclosure pt-3 border-t border-slate-200/70 dark:border-white/[0.06]">
                  <summary className="flex items-center justify-between text-xs font-semibold text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white">
                    <span>Move an Active Bill from {activeGroup.name} to Trash</span>
                    <CaretDown className="w-3.5 h-3.5" weight="bold" />
                  </summary>
                  <div className="mt-2.5 flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                    <select
                      aria-label="Select active expense to move to trash"
                      value={selectedExpenseIdForDeleteDemo || activeGroupNonDeletedExpenses[0]?.id || ''}
                      onChange={(e) => setSelectedExpenseIdForDeleteDemo(e.target.value)}
                      className="flex-1 rounded-xl px-3 py-1.5 text-xs bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-200 border border-slate-300/70 dark:border-white/10"
                    >
                      {activeGroupNonDeletedExpenses.map((exp) => (
                        <option key={exp.id} value={exp.id}>
                          {exp.title}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => {
                        const targetId =
                          selectedExpenseIdForDeleteDemo || activeGroupNonDeletedExpenses[0]?.id;
                        if (targetId) {
                          softDeleteExpense(targetId);
                          setSelectedExpenseIdForDeleteDemo('');
                        }
                      }}
                      className="inline-flex items-center justify-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold bg-rose-500/15 text-rose-700 dark:text-rose-300 hover:bg-rose-500/25 ring-1 ring-rose-500/30 transition cursor-pointer"
                    >
                      <Trash weight="bold" className="w-3.5 h-3.5" />
                      <span>Move to Trash</span>
                    </button>
                  </div>
                </details>
              )}
            </div>
          </DoubleBezelCard>
        </div>
      </div>
    </div>
  );
}

export default ActivityAndTrashPage;
