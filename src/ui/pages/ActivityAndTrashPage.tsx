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
  XIcon as X,
} from '@phosphor-icons/react';
import { useLedger } from '../../state/LedgerContext';
import {
  ActionTypeCatalogItem,
  ExpenseItem,
  ExpenseRevision,
  GroupActivityActionType,
} from '../../types/ledger';
import { actorLabel } from '../../utils/group-permissions';
import {
  CurrencyAmount,
  DoubleBezelCard,
  SpatialFilterPill,
  SpatialPageHeader,
  StatusBadge,
} from '../primitives/DesignPrimitives';

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
    case 'settlement_restored':
    case 'member_claimed':
    case 'group_created':
      return 'emerald';
    case 'expense_updated':
    case 'group_currency_changed':
    case 'group_updated':
      return 'blue';
    case 'expense_conflict_flagged':
    case 'upi_changed':
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
  if (action === 'upi_changed') return 'UPI ID changed';
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
    restoreGroup,
    restoreSettlement,
    isGroupAdmin,
  } = useLedger();
  const trashedGroups = dataset.groups.filter((g) => g.deletedAt);

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
        const haystack = `${actorLabel(item)} ${item.summaryText} ${item.detailNote} ${item.diffBadges.join(' ')} ${item.hlc}`.toLowerCase();
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

  const trashedSettlements = useMemo(
    () => dataset.settlements.filter((s) => s.deletedAt),
    [dataset.settlements]
  );

  const participantNameOf = (id: string): string => {
    const fromGroup = memberNameMap.get(id);
    if (fromGroup) return fromGroup;
    for (const e of dataset.expenses) {
      const p = e.adHocParticipants?.find((x) => x.id === id);
      if (p) return p.displayName;
    }
    return 'Member';
  };

  const trashedExpenses = useMemo(
    () => dataset.expenses.filter((exp) => exp.deletedAt !== null),
    [dataset.expenses]
  );

  const activeGroupNonDeletedExpenses = useMemo(
    () => dataset.expenses.filter((exp) => exp.groupId === activeGroupId && exp.deletedAt === null),
    [dataset.expenses, activeGroupId]
  );

  const totalTrashedItems =
    trashedExpenses.length + trashedGroups.length + trashedSettlements.length;

  return (
    <div className="space-y-6 pb-2 min-w-0">
      {/* Editorial Spatial Header & Scope Switcher */}
      <SpatialPageHeader
        className="pt-1"
        badges={
          <>
            <StatusBadge tone="emerald">
              <ShieldCheck weight="fill" className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span>Full Edit Transparency</span>
            </StatusBadge>
            <StatusBadge tone="blue">
              <GitBranch weight="bold" className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span>1-Tap Version &amp; Trash Restore</span>
            </StatusBadge>
          </>
        }
        title="Activity Timeline, Edit History & Trash"
        subtitle="See every bill added, edited, settled, or deleted across your groups, and restore any earlier version or trashed bill in one tap."
        actions={
          <div
            data-testid="activity-scope-toggle"
            onClick={() => setScope((prev) => (prev === 'group' ? 'global' : 'group'))}
            role="group"
            aria-label="Activity timeline scope toggle"
            className="lg-recessed-well inline-flex flex-wrap items-center gap-1 rounded-full p-1 max-w-full cursor-pointer select-none"
          >
            <button
              type="button"
              aria-pressed={scope === 'group'}
              onClick={(e) => {
                e.stopPropagation();
                setScope('group');
              }}
              className={`min-h-[40px] sm:min-h-[38px] inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs font-semibold transition-[transform,opacity,background-color,border-color,box-shadow] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 ${
                scope === 'group'
                  ? 'lg-luminous-pill pointer-events-none'
                  : 'text-[#4A524D] dark:text-[#B7BEB9] hover:text-[#141715] dark:hover:text-[#F3F5F3]'
              }`}
            >
              <Users weight="bold" className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>This Group</span>
              <span
                className={`font-mono tabular-nums text-[10px] px-1.5 py-0.5 rounded-full ${
                  scope === 'group'
                    ? 'bg-black/12 dark:bg-black/15 text-inherit'
                    : 'bg-black/[0.06] dark:bg-white/[0.10] text-[#4A524D] dark:text-[#B7BEB9]'
                }`}
              >
                {currentGroupActivityCount}
              </span>
            </button>
            <button
              type="button"
              aria-pressed={scope === 'global'}
              onClick={(e) => {
                e.stopPropagation();
                setScope('global');
              }}
              className={`min-h-[40px] sm:min-h-[38px] inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs font-semibold transition-[transform,opacity,background-color,border-color,box-shadow] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 ${
                scope === 'global'
                  ? 'lg-luminous-pill pointer-events-none'
                  : 'text-[#4A524D] dark:text-[#B7BEB9] hover:text-[#141715] dark:hover:text-[#F3F5F3]'
              }`}
            >
              <GlobeHemisphereWest weight="bold" className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>All Groups</span>
              <span
                className={`font-mono tabular-nums text-[10px] px-1.5 py-0.5 rounded-full ${
                  scope === 'global'
                    ? 'bg-black/12 dark:bg-black/15 text-inherit'
                    : 'bg-black/[0.06] dark:bg-white/[0.10] text-[#4A524D] dark:text-[#B7BEB9]'
                }`}
              >
                {globalActivityCount}
              </span>
            </button>
          </div>
        }
      />

      {/* Search & Action Type Filter Chamber */}
      <DoubleBezelCard
        className="lg-stagger-1 min-w-0"
        innerClassName="space-y-3.5 min-w-0"
      >
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 min-w-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <span
              aria-hidden="true"
              className="lg-icon-orb h-8 w-8 rounded-full inline-flex items-center justify-center shrink-0 text-emerald-700 dark:text-emerald-300"
            >
              <Funnel weight="duotone" className="w-4 h-4" />
            </span>
            <span className="text-xs font-semibold uppercase tracking-[0.08em] text-[#4A524D] dark:text-[#B7BEB9] truncate">
              Filter Updates by Type
            </span>
          </div>

          <div className="relative w-full sm:w-80 min-w-0">
            <MagnifyingGlass
              weight="bold"
              aria-hidden="true"
              className="w-4 h-4 text-[#68726C] dark:text-[#8A938D] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
            />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search person, bill title, or change..."
              aria-label="Search activity log"
              className="lg-recessed-well min-h-[44px] sm:min-h-[40px] w-full rounded-full pl-9 pr-11 py-2 text-xs sm:text-sm text-[#141715] dark:text-[#F3F5F3] placeholder:text-[#68726C] dark:placeholder:text-[#8A938D] focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
            />
            {searchQuery && (
              <button
                type="button"
                aria-label="Clear activity search"
                onClick={() => setSearchQuery('')}
                className="min-h-[44px] min-w-[44px] sm:min-h-[32px] sm:min-w-[32px] inline-flex items-center justify-center absolute right-1 top-1/2 -translate-y-1/2 rounded-full text-[#5C6660] dark:text-[#9CA69F] hover:text-[#141715] dark:hover:text-[#F3F5F3] transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
              >
                <X weight="bold" className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 min-w-0">
          <SpatialFilterPill
            active={selectedAction === 'all'}
            onClick={() => setSelectedAction('all')}
            count={scope === 'group' ? currentGroupActivityCount : globalActivityCount}
          >
            All Actions
          </SpatialFilterPill>

          {dataset.actionTypesCatalog.map((cat) => {
            const count = dataset.groupActivityLog.filter(
              (a) =>
                (scope === 'global' || a.groupId === activeGroupId) &&
                a.action === cat.action
            ).length;

            return (
              <SpatialFilterPill
                key={cat.action}
                active={selectedAction === cat.action}
                onClick={() => setSelectedAction(cat.action)}
                count={count}
              >
                {cat.label}
              </SpatialFilterPill>
            );
          })}
        </div>

        {selectedCatalogMeta && (
          <div className="lg-recessed-well rounded-2xl p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2 min-w-0">
            <div className="flex flex-wrap items-center gap-2 min-w-0">
              <StatusBadge tone={selectedCatalogMeta.badgeTone}>
                {selectedCatalogMeta.label}
              </StatusBadge>
              <span className="text-xs font-mono tabular-nums text-[#5C6660] dark:text-[#9CA69F] break-all">
                action_code: {selectedCatalogMeta.action}
              </span>
            </div>
            <div className="text-xs text-[#4A524D] dark:text-[#B7BEB9] min-w-0 break-words [overflow-wrap:anywhere]">
              <span className="font-semibold text-[#141715] dark:text-[#F3F5F3]">
                Audit Note Template:{' '}
              </span>
              <span className="font-mono tabular-nums">
                {selectedCatalogMeta.sampleNoteTemplate}
              </span>
            </div>
          </div>
        )}
      </DoubleBezelCard>

      {/* Main Responsive 12-Column Spatial Bento Grid */}
      <div className="lg-stagger-2 grid grid-cols-1 lg:grid-cols-12 gap-5 items-start min-w-0">
        {/* Left 7 Columns: Transparent Group Activity Timeline */}
        <div className="lg:col-span-7 space-y-5 min-w-0">
          <DoubleBezelCard
            testId="activity-feed-list"
            className="min-w-0"
            innerClassName="space-y-4 min-w-0"
          >
            <div className="flex flex-wrap items-center justify-between gap-3 pb-3.5 border-b border-black/[0.07] dark:border-white/[0.08] min-w-0">
              <div className="flex items-start sm:items-center gap-3 min-w-0 flex-1">
                <span
                  aria-hidden="true"
                  className="lg-icon-orb w-9 h-9 rounded-full text-emerald-700 dark:text-emerald-300 flex items-center justify-center shrink-0"
                >
                  <ClockCounterClockwise weight="duotone" className="w-5 h-5" />
                </span>
                <div className="min-w-0">
                  <h2
                    dir="auto"
                    className="text-base sm:text-lg font-semibold tracking-tight text-[#141715] dark:text-[#F3F5F3] min-w-0 break-words [overflow-wrap:anywhere]"
                  >
                    {scope === 'group'
                      ? `Group Activity Feed - ${activeGroup.name}`
                      : 'All Groups Global Activity Timeline'}
                  </h2>
                  <p className="text-xs text-[#5C6660] dark:text-[#9CA69F] mt-0.5">
                    Showing{' '}
                    <span className="font-mono tabular-nums font-semibold text-[#141715] dark:text-[#F3F5F3]">
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
                  className="lg-scene-tile min-h-[44px] sm:min-h-[36px] inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-semibold text-[#141715] dark:text-[#F3F5F3] cursor-pointer shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
                >
                  <GlobeHemisphereWest
                    weight="bold"
                    aria-hidden="true"
                    className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-300 shrink-0"
                  />
                  <span>Switch to Global ({globalActivityCount})</span>
                </button>
              )}
            </div>

            {filteredActivities.length === 0 ? (
              <div className="lg-recessed-well rounded-[1.375rem] p-6 text-center space-y-2.5 min-w-0">
                <span
                  aria-hidden="true"
                  className="lg-icon-orb h-10 w-10 rounded-full flex items-center justify-center mx-auto text-[#4A524D] dark:text-[#B7BEB9]"
                >
                  <ClockCounterClockwise weight="duotone" className="w-5 h-5" />
                </span>
                <p className="text-sm font-semibold text-[#141715] dark:text-[#F3F5F3]">
                  No recorded events match the current filter in this scope.
                </p>
                {selectedCatalogMeta && (
                  <p className="text-xs text-[#5C6660] dark:text-[#9CA69F] font-mono tabular-nums break-words [overflow-wrap:anywhere]">
                    Schema Template ({selectedCatalogMeta.label}): {selectedCatalogMeta.sampleNoteTemplate}
                  </p>
                )}
                <div className="pt-2 flex flex-wrap items-center justify-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedAction('all');
                      setSearchQuery('');
                    }}
                    className="lg-luminous-pill min-h-[44px] sm:min-h-[38px] rounded-full px-4 py-2 text-xs font-semibold cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
                  >
                    Reset Action Filter
                  </button>
                  {scope === 'group' && (
                    <button
                      type="button"
                      onClick={() => setScope('global')}
                      className="lg-scene-tile min-h-[44px] sm:min-h-[38px] rounded-full px-4 py-2 text-xs font-semibold text-[#141715] dark:text-[#F3F5F3] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
                    >
                      Inspect Global Timeline
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div className="space-y-3 min-w-0">
                {filteredActivities.map((item) => {
                  const grpInfo = item.groupId ? groupMap.get(item.groupId) : undefined;
                  const badgeTone = getActionBadgeTone(item.action, dataset.actionTypesCatalog);
                  const actionLabel = getActionLabel(item.action, dataset.actionTypesCatalog);
                  const initials = getInitialsFromName(actorLabel(item));

                  return (
                    <div
                      key={item.id}
                      data-testid={`activity-item-${item.id}`}
                      className="lg-recessed-well rounded-[1.25rem] p-3.5 sm:p-4 space-y-2.5 min-w-0"
                    >
                      <div className="flex items-start justify-between gap-3 min-w-0">
                        <div className="flex items-start gap-3 min-w-0 flex-1">
                          <div
                            aria-hidden="true"
                            className="lg-icon-orb w-9 h-9 rounded-full text-emerald-800 dark:text-emerald-200 flex items-center justify-center text-xs font-semibold font-mono shrink-0"
                          >
                            {initials}
                          </div>
                          <div className="space-y-1 min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                              <StatusBadge tone={badgeTone}>{actionLabel}</StatusBadge>
                              {grpInfo && (
                                <StatusBadge tone="slate" className="max-w-full min-w-0">
                                  <span dir="auto" className="truncate">
                                    {grpInfo.name} ({grpInfo.baseCurrency})
                                  </span>
                                </StatusBadge>
                              )}
                              <span className="text-[11px] font-mono tabular-nums text-[#5C6660] dark:text-[#9CA69F]">
                                {formatIsoTimestamp(item.createdAt)}
                              </span>
                            </div>
                            <p
                              dir="auto"
                              className="text-sm font-semibold text-[#141715] dark:text-[#F3F5F3] min-w-0 break-words [overflow-wrap:anywhere]"
                            >
                              {item.summaryText}
                            </p>
                          </div>
                        </div>
                      </div>

                      <p
                        dir="auto"
                        className="text-xs text-[#4A524D] dark:text-[#B7BEB9] sm:pl-12 leading-relaxed min-w-0 break-words [overflow-wrap:anywhere]"
                      >
                        {item.detailNote}
                      </p>

                      <div className="flex flex-wrap items-center justify-between gap-2 sm:pl-12 pt-0.5 min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                          {item.diffBadges.map((badge, idx) => (
                            <span
                              key={`${item.id}_badge_${idx}`}
                              dir="auto"
                              className="lg-scene-tile inline-flex items-center rounded-lg px-2.5 py-0.5 text-[11px] font-mono tabular-nums font-medium text-[#2B312D] dark:text-[#DCE2DD] max-w-full min-w-0 break-words [overflow-wrap:anywhere]"
                            >
                              {badge}
                            </span>
                          ))}
                        </div>

                        <details className="ws-disclosure text-[11px] text-[#5C6660] dark:text-[#9CA69F] min-w-0">
                          <summary className="inline-flex items-center gap-1 hover:text-[#141715] dark:hover:text-[#F3F5F3] transition-colors">
                            <span>Audit Stamp</span>
                            <CaretDown className="w-3 h-3 shrink-0" weight="bold" aria-hidden="true" />
                          </summary>
                          <span className="mt-1 block font-mono tabular-nums text-[10px] break-all">
                            HLC: {item.hlc}
                          </span>
                        </details>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </DoubleBezelCard>
        </div>

        {/* Right 5 Columns: Per-Expense Revision Inspector & Trash Recovery Vault */}
        <div className="lg:col-span-5 space-y-5 min-w-0">
          {/* Immutable Per-Expense Revision History & Conflict Inspector */}
          <DoubleBezelCard
            testId="revision-history-panel"
            className="min-w-0"
            innerClassName="space-y-4 min-w-0"
          >
            <div className="flex flex-wrap items-start justify-between gap-3 pb-3.5 border-b border-black/[0.07] dark:border-white/[0.08] min-w-0">
              <div className="flex items-start sm:items-center gap-3 min-w-0 flex-1 basis-[12rem]">
                <span
                  aria-hidden="true"
                  className="lg-icon-orb w-9 h-9 rounded-full text-amber-700 dark:text-amber-300 flex items-center justify-center shrink-0"
                >
                  <GitBranch weight="bold" className="w-5 h-5" />
                </span>
                <div className="min-w-0">
                  <h2 className="text-base sm:text-lg font-semibold tracking-tight text-[#141715] dark:text-[#F3F5F3]">
                    Per-Expense Revision &amp; Conflict Inspector
                  </h2>
                  <p className="text-xs text-[#5C6660] dark:text-[#9CA69F] mt-0.5">
                    Causal revision tree with field-level diffs and 1-click version restore
                  </p>
                </div>
              </div>
              <StatusBadge tone="amber" className="shrink-0">
                <span className="font-mono tabular-nums">
                  {dataset.expenseRevisions.length} Revisions
                </span>
              </StatusBadge>
            </div>

            {revisionsByExpense.length === 0 ? (
              <div className="lg-recessed-well rounded-[1.375rem] p-5 text-center space-y-1.5 min-w-0">
                <p className="text-sm font-semibold text-[#141715] dark:text-[#F3F5F3]">
                  No bill revisions recorded yet
                </p>
                <p className="text-xs text-[#5C6660] dark:text-[#9CA69F]">
                  Edits to shared bills automatically create immutable snapshots here.
                </p>
              </div>
            ) : (
              <div className="space-y-4 min-w-0">
                {revisionsByExpense.map(
                  ({ expenseId, expense, groupName, groupCurrency, revisions }) => {
                    const hasConflict = expense?.hasUnresolvedConflict ?? false;
                    const activeRevId = expense?.currentRevisionId ?? null;

                    return (
                      <div
                        key={expenseId}
                        className="lg-recessed-well rounded-[1.375rem] p-3.5 sm:p-4 space-y-3.5 min-w-0"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-2.5 min-w-0">
                          <div className="space-y-1 min-w-0 flex-1 basis-[11rem]">
                            <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                              <span
                                dir="auto"
                                className="text-xs font-semibold text-[#5C6660] dark:text-[#9CA69F] min-w-0 break-words [overflow-wrap:anywhere]"
                              >
                                {groupName}
                              </span>
                              {hasConflict ? (
                                <StatusBadge tone="amber">
                                  <WarningOctagon
                                    weight="fill"
                                    className="w-3.5 h-3.5 shrink-0"
                                    aria-hidden="true"
                                  />
                                  <span>Concurrent Offline Edit Conflict</span>
                                </StatusBadge>
                              ) : (
                                <StatusBadge tone="emerald">
                                  <CheckCircle
                                    weight="fill"
                                    className="w-3.5 h-3.5 shrink-0"
                                    aria-hidden="true"
                                  />
                                  <span>Clean Causal Chain</span>
                                </StatusBadge>
                              )}
                            </div>
                            <h3
                              dir="auto"
                              className="text-sm font-semibold text-[#141715] dark:text-[#F3F5F3] min-w-0 break-words [overflow-wrap:anywhere]"
                            >
                              {expense?.title ??
                                revisions[revisions.length - 1]?.snapshot.title ??
                                expenseId}
                            </h3>
                          </div>

                          {expense && (
                            <div className="sm:text-right shrink-0">
                              <div className="text-[11px] text-[#5C6660] dark:text-[#9CA69F]">
                                Active Ledger Total
                              </div>
                              <CurrencyAmount
                                minorAmount={expense.amountMinor}
                                currencyCode={groupCurrency}
                                className="text-sm font-semibold text-[#141715] dark:text-[#F3F5F3]"
                              />
                            </div>
                          )}
                        </div>

                        {/* Revision Chain Items */}
                        <div className="space-y-3 min-w-0">
                          {revisions.map((rev) => {
                            const isCurrentActive = activeRevId === rev.id;
                            const isConflictBranch =
                              rev.isConflictBranch || rev.action === 'conflict_superseded';

                            return (
                              <div
                                key={rev.id}
                                data-testid={`revision-card-${rev.id}`}
                                className={`rounded-2xl p-3.5 space-y-2.5 min-w-0 ${
                                  isCurrentActive
                                    ? 'lg-scene-tile ring-1 ring-emerald-600/30 dark:ring-emerald-400/30 bg-emerald-500/[0.06] dark:bg-emerald-400/[0.07]'
                                    : isConflictBranch
                                    ? 'lg-scene-tile ring-1 ring-amber-600/35 dark:ring-amber-400/30 bg-amber-500/[0.06] dark:bg-amber-400/[0.07]'
                                    : 'lg-scene-tile'
                                }`}
                              >
                                <div className="flex flex-wrap items-center justify-between gap-2 min-w-0">
                                  <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                                    <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-mono tabular-nums font-semibold bg-[#181B19] text-[#F7F9F7] dark:bg-[#F3F4F1] dark:text-[#141614]">
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
                                    <span
                                      dir="auto"
                                      className="text-xs font-semibold text-[#2B312D] dark:text-[#DCE2DD] min-w-0 break-words [overflow-wrap:anywhere]"
                                    >
                                      by {actorLabel(rev)}
                                    </span>
                                  </div>

                                  <CurrencyAmount
                                    minorAmount={rev.snapshot.amountMinor}
                                    currencyCode={rev.snapshot.groupCurrency ?? groupCurrency}
                                    className="text-xs font-semibold text-[#141715] dark:text-[#F3F5F3] shrink-0"
                                  />
                                </div>

                                {/* Structured Field-by-Field Diffs */}
                                <div className="space-y-1.5 pt-0.5 min-w-0">
                                  {rev.changes.map((chg, cIdx) => (
                                    <div
                                      key={`${rev.id}_chg_${cIdx}`}
                                      className="lg-recessed-well rounded-xl px-3 py-2 text-xs space-y-1 min-w-0"
                                    >
                                      <div className="flex flex-wrap items-center justify-between gap-2 min-w-0">
                                        <span className="font-semibold text-[#2B312D] dark:text-[#DCE2DD] min-w-0 break-words [overflow-wrap:anywhere]">
                                          {chg.field.replace(/_/g, ' ')}
                                        </span>
                                        <div className="flex flex-wrap items-center gap-1.5 font-mono tabular-nums text-[11px] min-w-0 max-w-full">
                                          <span
                                            dir="auto"
                                            className="px-2 py-0.5 rounded-md bg-rose-500/12 text-rose-800 dark:text-rose-200 ring-1 ring-rose-600/20 dark:ring-rose-300/20 min-w-0 max-w-full break-words [overflow-wrap:anywhere]"
                                          >
                                            {chg.fromValue}
                                          </span>
                                          <ArrowsLeftRight
                                            weight="bold"
                                            aria-hidden="true"
                                            className="w-3 h-3 text-[#68726C] dark:text-[#8A938D] shrink-0"
                                          />
                                          <span
                                            dir="auto"
                                            className="px-2 py-0.5 rounded-md bg-emerald-500/12 text-emerald-800 dark:text-emerald-200 ring-1 ring-emerald-600/20 dark:ring-emerald-300/20 min-w-0 max-w-full break-words [overflow-wrap:anywhere]"
                                          >
                                            {chg.toValue}
                                          </span>
                                        </div>
                                      </div>
                                      <p
                                        dir="auto"
                                        className="text-[11px] text-[#5C6660] dark:text-[#9CA69F] min-w-0 break-words [overflow-wrap:anywhere]"
                                      >
                                        {chg.label}
                                      </p>
                                    </div>
                                  ))}
                                </div>

                                {/* Collapsible Technical Audit Details */}
                                <details className="ws-disclosure text-[11px] text-[#5C6660] dark:text-[#9CA69F] min-w-0">
                                  <summary className="inline-flex items-center gap-1 hover:text-[#141715] dark:hover:text-[#F3F5F3] transition-colors">
                                    <span>Technical / Audit Details</span>
                                    <CaretDown
                                      className="w-3 h-3 shrink-0"
                                      weight="bold"
                                      aria-hidden="true"
                                    />
                                  </summary>
                                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] font-mono tabular-nums text-[#5C6660] dark:text-[#9CA69F] break-all">
                                    <span>id: {rev.id}</span>
                                    <span>base: {rev.baseRevisionId ?? 'Initial'}</span>
                                    <span>HLC: {rev.hlc}</span>
                                  </div>
                                </details>

                                {/* Snapshot Summary & Restore Button */}
                                <div className="flex flex-wrap items-center justify-between gap-2 pt-1 min-w-0">
                                  <span className="text-[11px] text-[#5C6660] dark:text-[#9CA69F] font-mono tabular-nums">
                                    Split: {rev.snapshot.splitMode.toUpperCase()} |{' '}
                                    {formatIsoTimestamp(rev.createdAt)}
                                  </span>

                                  <button
                                    type="button"
                                    data-testid={`restore-revision-${rev.id}`}
                                    onClick={() => restoreExpenseRevision(rev.expenseId, rev.id)}
                                    className={`min-h-[44px] sm:min-h-[36px] inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-semibold cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 ${
                                      isCurrentActive
                                        ? 'lg-scene-tile text-[#141715] dark:text-[#F3F5F3]'
                                        : 'lg-luminous-pill'
                                    }`}
                                  >
                                    <ArrowCounterClockwise
                                      weight="bold"
                                      className="w-3.5 h-3.5 shrink-0"
                                      aria-hidden="true"
                                    />
                                    <span>Restore This Revision</span>
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  }
                )}
              </div>
            )}
          </DoubleBezelCard>

          {/* Trash & Soft-Delete Recovery Vault */}
          <DoubleBezelCard
            testId="trash-recovery-panel"
            className="min-w-0"
            innerClassName="space-y-4 min-w-0"
          >
            <div className="flex flex-wrap items-start justify-between gap-3 pb-3.5 border-b border-black/[0.07] dark:border-white/[0.08] min-w-0">
              <div className="flex items-start sm:items-center gap-3 min-w-0 flex-1 basis-[12rem]">
                <span
                  aria-hidden="true"
                  className="lg-icon-orb w-9 h-9 rounded-full text-rose-700 dark:text-rose-300 flex items-center justify-center shrink-0"
                >
                  <Trash weight="duotone" className="w-5 h-5" />
                </span>
                <div className="min-w-0">
                  <h2 className="text-base sm:text-lg font-semibold tracking-tight text-[#141715] dark:text-[#F3F5F3]">
                    Trash &amp; Soft-Delete Recovery Vault
                  </h2>
                  <p className="text-xs text-[#5C6660] dark:text-[#9CA69F] mt-0.5">
                    Zero data loss: soft-deleted bills retain full payer and split shares for instant recovery
                  </p>
                </div>
              </div>
              <StatusBadge
                tone={totalTrashedItems > 0 ? 'rose' : 'emerald'}
                className="shrink-0"
              >
                <span className="font-mono tabular-nums">
                  {trashedExpenses.length} in Trash
                </span>
              </StatusBadge>
            </div>

            {trashedGroups.length > 0 && (
              <ul className="space-y-2.5 min-w-0" aria-label="Deleted groups">
                {trashedGroups.map((g) => (
                  <li
                    key={g.id}
                    data-testid={`trash-group-${g.id}`}
                    className="lg-recessed-well flex flex-wrap items-center justify-between gap-2.5 rounded-2xl p-3.5 ring-1 ring-rose-500/25 text-xs min-w-0"
                  >
                    <div className="min-w-0 flex-1 basis-[10rem]">
                      <div
                        dir="auto"
                        className="font-semibold text-[#141715] dark:text-[#F3F5F3] min-w-0 break-words [overflow-wrap:anywhere]"
                      >
                        {g.name}
                      </div>
                      <div className="font-mono text-[11px] text-[#5C6660] dark:text-[#9CA69F] mt-0.5 break-words">
                        Group deleted {formatIsoTimestamp(g.deletedAt)}
                      </div>
                    </div>
                    {isGroupAdmin(g) ? (
                      <button
                        type="button"
                        data-testid={`restore-group-${g.id}`}
                        onClick={() => restoreGroup(g.id)}
                        className="lg-luminous-pill min-h-[44px] sm:min-h-[38px] inline-flex items-center gap-1.5 rounded-full px-3.5 py-2 text-xs font-semibold cursor-pointer shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
                      >
                        <ArrowCounterClockwise
                          weight="bold"
                          className="w-4 h-4 shrink-0"
                          aria-hidden="true"
                        />
                        <span>Restore group</span>
                      </button>
                    ) : (
                      <span className="text-[#5C6660] dark:text-[#9CA69F]">
                        Only a group admin can restore it.
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {trashedSettlements.length > 0 && (
              <ul className="space-y-2.5 min-w-0" aria-label="Deleted payments">
                {trashedSettlements.map((st) => {
                  const where = st.groupId
                    ? groupMap.get(st.groupId)?.name
                    : dataset.expenses.find((e) => e.id === st.expenseId)?.title;
                  return (
                    <li
                      key={st.id}
                      data-testid={`trash-settlement-${st.id}`}
                      className="lg-recessed-well flex flex-wrap items-center justify-between gap-2.5 rounded-2xl p-3.5 ring-1 ring-rose-500/25 text-xs min-w-0"
                    >
                      <div className="min-w-0 flex-1 basis-[10rem]">
                        <div
                          dir="auto"
                          className="font-semibold text-[#141715] dark:text-[#F3F5F3] min-w-0 break-words [overflow-wrap:anywhere]"
                        >
                          {participantNameOf(st.fromMemberId)} paid {participantNameOf(st.toMemberId)}{' '}
                          <CurrencyAmount minorAmount={st.amountMinor} currencyCode={st.currency} />
                        </div>
                        <div
                          dir="auto"
                          className="font-mono text-[11px] text-[#5C6660] dark:text-[#9CA69F] mt-0.5 min-w-0 break-words [overflow-wrap:anywhere]"
                        >
                          {where ? `${where}, ` : ''}paid {st.settledDate}, removed{' '}
                          {formatIsoTimestamp(st.deletedAt)}
                        </div>
                      </div>
                      <button
                        type="button"
                        data-testid={`restore-settlement-${st.id}`}
                        onClick={() => restoreSettlement(st.id)}
                        className="lg-luminous-pill min-h-[44px] sm:min-h-[38px] inline-flex items-center gap-1.5 rounded-full px-3.5 py-2 text-xs font-semibold cursor-pointer shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
                      >
                        <ArrowCounterClockwise
                          weight="bold"
                          className="w-4 h-4 shrink-0"
                          aria-hidden="true"
                        />
                        <span>Restore payment</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            {trashedExpenses.length === 0 ? (
              <div className="lg-recessed-well rounded-[1.375rem] p-5 text-center space-y-2 min-w-0">
                <span
                  aria-hidden="true"
                  className="lg-icon-orb h-10 w-10 rounded-full flex items-center justify-center mx-auto text-emerald-700 dark:text-emerald-300"
                >
                  <Sparkle weight="duotone" className="w-5 h-5" />
                </span>
                <p className="text-sm font-semibold text-[#141715] dark:text-[#F3F5F3]">
                  Trash Vault is Clean
                </p>
                <p className="text-xs text-[#5C6660] dark:text-[#9CA69F]">
                  All soft-deleted expenses have been restored to their active group ledgers.
                </p>
              </div>
            ) : (
              <div className="space-y-3 min-w-0">
                {trashedExpenses.map((exp) => {
                  const grpInfo = exp.groupId ? groupMap.get(exp.groupId) : undefined;
                  const includedSplits = exp.splits.filter((s) => s.included);

                  return (
                    <div
                      key={exp.id}
                      data-testid={`trash-item-${exp.id}`}
                      className="lg-recessed-well rounded-[1.375rem] p-4 ring-1 ring-rose-500/25 bg-rose-500/[0.04] dark:bg-rose-400/[0.05] space-y-3 min-w-0"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3 min-w-0">
                        <div className="space-y-1 min-w-0 flex-1 basis-[11rem]">
                          <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                            <StatusBadge tone="rose">Soft-Deleted</StatusBadge>
                            {grpInfo && (
                              <span
                                dir="auto"
                                className="text-xs font-medium text-[#4A524D] dark:text-[#B7BEB9] min-w-0 break-words [overflow-wrap:anywhere]"
                              >
                                {grpInfo.name}
                              </span>
                            )}
                            <span className="text-[11px] font-mono tabular-nums text-[#5C6660] dark:text-[#9CA69F]">
                              ({exp.splitMode.toUpperCase()} split)
                            </span>
                          </div>
                          <h3
                            dir="auto"
                            className="text-sm font-semibold text-[#141715] dark:text-[#F3F5F3] min-w-0 break-words [overflow-wrap:anywhere]"
                          >
                            {exp.title}
                          </h3>
                          {exp.notes && (
                            <p
                              dir="auto"
                              className="text-xs text-[#4A524D] dark:text-[#B7BEB9] min-w-0 break-words [overflow-wrap:anywhere]"
                            >
                              {exp.notes}
                            </p>
                          )}
                        </div>

                        <div className="sm:text-right shrink-0">
                          <div className="text-[11px] text-[#5C6660] dark:text-[#9CA69F]">
                            Amount
                          </div>
                          <CurrencyAmount
                            minorAmount={exp.amountMinor}
                            currencyCode={exp.groupCurrency}
                            className="text-base font-semibold text-rose-700 dark:text-rose-300"
                          />
                        </div>
                      </div>

                      {/* Preserved Split Breakdown */}
                      <div className="lg-scene-tile rounded-2xl p-3 space-y-2 min-w-0">
                        <div className="text-[11px] font-semibold text-[#5C6660] dark:text-[#9CA69F]">
                          Preserved Participant Shares ({includedSplits.length} members):
                        </div>
                        <div className="flex flex-wrap gap-1.5 min-w-0">
                          {includedSplits.map((split) => {
                            const memberName =
                              memberNameMap.get(split.memberId) ?? split.memberId;
                            return (
                              <span
                                key={`${exp.id}_split_${split.memberId}`}
                                className="lg-recessed-well inline-flex flex-wrap items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] text-[#2B312D] dark:text-[#DCE2DD] max-w-full min-w-0"
                              >
                                <span
                                  dir="auto"
                                  className="min-w-0 break-words [overflow-wrap:anywhere]"
                                >
                                  {memberName}:
                                </span>
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
                      <div className="flex flex-wrap items-center justify-between gap-2.5 pt-1 min-w-0">
                        <div className="text-[11px] font-mono tabular-nums text-[#5C6660] dark:text-[#9CA69F] space-y-0.5 min-w-0 break-all">
                          <div>Deleted at: {formatIsoTimestamp(exp.deletedAt)}</div>
                          <div>HLC: {exp.hlc}</div>
                        </div>

                        <button
                          type="button"
                          data-testid={`restore-trash-${exp.id}`}
                          onClick={() => restoreExpense(exp.id)}
                          className="lg-luminous-pill min-h-[44px] sm:min-h-[38px] inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-xs font-semibold cursor-pointer shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
                        >
                          <ArrowCounterClockwise
                            weight="bold"
                            className="w-4 h-4 shrink-0"
                            aria-hidden="true"
                          />
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
              <details className="ws-disclosure pt-3 border-t border-black/[0.07] dark:border-white/[0.08] min-w-0">
                <summary className="min-h-[44px] sm:min-h-[36px] flex items-center justify-between gap-2 text-xs font-semibold text-[#4A524D] dark:text-[#B7BEB9] hover:text-[#141715] dark:hover:text-[#F3F5F3] transition-colors min-w-0">
                  <span
                    dir="auto"
                    className="min-w-0 break-words [overflow-wrap:anywhere]"
                  >
                    Move an Active Bill from {activeGroup.name} to Trash
                  </span>
                  <CaretDown
                    className="w-3.5 h-3.5 shrink-0"
                    weight="bold"
                    aria-hidden="true"
                  />
                </summary>
                <div className="mt-2.5 flex flex-col sm:flex-row items-stretch sm:items-center gap-2 min-w-0">
                  <select
                    aria-label="Select active expense to move to trash"
                    value={
                      selectedExpenseIdForDeleteDemo ||
                      activeGroupNonDeletedExpenses[0]?.id ||
                      ''
                    }
                    onChange={(e) => setSelectedExpenseIdForDeleteDemo(e.target.value)}
                    className="lg-recessed-well min-h-[44px] sm:min-h-[40px] flex-1 min-w-0 max-w-full rounded-2xl px-3.5 py-2 text-xs font-medium text-[#141715] dark:text-[#F3F5F3] focus:outline-none focus:ring-2 focus:ring-emerald-500/50 [&>option]:bg-[#F6F8F6] [&>option]:text-[#141715] dark:[&>option]:bg-[#222522] dark:[&>option]:text-[#F3F5F3]"
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
                        selectedExpenseIdForDeleteDemo ||
                        activeGroupNonDeletedExpenses[0]?.id;
                      if (targetId) {
                        softDeleteExpense(targetId);
                        setSelectedExpenseIdForDeleteDemo('');
                      }
                    }}
                    className="min-h-[44px] sm:min-h-[40px] inline-flex items-center justify-center gap-1.5 rounded-full px-4 py-2 text-xs font-semibold border border-rose-500/30 bg-rose-500/12 hover:bg-rose-500/20 text-rose-800 dark:text-rose-200 transition-[transform,opacity,background-color,border-color,box-shadow] active:scale-[0.98] cursor-pointer shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/60"
                  >
                    <Trash weight="bold" className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                    <span>Move to Trash</span>
                  </button>
                </div>
              </details>
            )}
          </DoubleBezelCard>
        </div>
      </div>
    </div>
  );
}

export default ActivityAndTrashPage;
