import React, { useMemo, useState } from 'react';
import {
  ArrowRight,
  BookOpen,
  CaretDown,
  CaretUp,
  CheckCircle,
  Compass,
  Info,
  Question,
  Sparkle,
  X,
} from '@phosphor-icons/react';
import { HelpGuideSection } from '../../types/ledger';
import { useLedger } from '../../state/LedgerContext';
import { DoubleBezelCard, StatusBadge } from '../primitives/DesignPrimitives';

export type GuidePageKey =
  | 'home'
  | 'groups'
  | 'activity'
  | 'friends'
  | 'analytics'
  | 'portability';

const FALLBACK_HELP_GUIDES: HelpGuideSection[] = [
  {
    pageKey: 'home',
    pageTitle: 'Minimalist Home & Quick Split Hub',
    shortTip:
      'Your Home screen keeps cognitive load low: see your overall net position, quick-add any expense (with or without a group), or jump into your 3 most recently active groups.',
    whereToFindWhat: [
      'Top Bar: Net Position across all groups and direct friend splits.',
      'Quick Add Expense: Log a standalone 1-on-1/ad-hoc split (No Group) or assign to any group.',
      'Recent Groups (Max 3): Your 3 most recently accessed or updated groups. Click any group to open its progressive workspace.',
      'Direct Non-Group Splits: Bills split directly between participants without creating a group.',
    ],
    steps: [
      {
        stepNumber: 1,
        title: 'Quick-Add a Standalone or Group Bill',
        description:
          "Click '+ Quick Add Expense' on Home. Leave Group as 'No Group (Direct Split)' to split between specific people, or pick a group.",
        targetTab: 'home',
        actionLabel: 'Open Quick Add',
      },
      {
        stepNumber: 2,
        title: 'Open a Group for Progressive Insights & Actions',
        description:
          "Click any of your Top 3 Recent Groups (or 'View All Groups') to unlock group-specific insights, balance explanations, and group settings.",
        targetTab: 'groups',
        actionLabel: 'Explore Groups',
      },
      {
        stepNumber: 3,
        title: 'Settle Up via UPI QR or WhatsApp Card',
        description:
          "Open 'Friends & Settle' to clear balances across multiple groups in one atomic batch or generate a UPI QR code.",
        targetTab: 'friends',
        actionLabel: 'Go to Settle Hub',
      },
    ],
  },
  {
    pageKey: 'groups',
    pageTitle: 'Progressive Group Workspace & 5-Mode Ledger',
    shortTip:
      'Once a group is opened, minimal group-scoped insights appear automatically at the top alongside all group operations (Add Expense with group pre-selected, Explain Balance, Currency Switcher, and Simplify Toggle).',
    whereToFindWhat: [
      'Minimal Group Insights Strip: Total group spend, your personal share, and your net group balance.',
      'Conflict Banner (when applicable): 1-click resolution for concurrent offline edits.',
      "Left Column: Group members, Google OAuth link status, 'Explain Balance' math modal, and suggested repayments.",
      'Right Column: Filterable expense ledger with rotating remainder badges and foreign FX audit notes.',
    ],
    steps: [
      {
        stepNumber: 1,
        title: 'Add Expense (Group Pre-Selected)',
        description:
          "Click 'Add Expense' inside the group header - this group is pre-selected automatically with all 5 split modes.",
        targetTab: 'groups',
        actionLabel: 'Add Group Bill',
      },
      {
        stepNumber: 2,
        title: 'Inspect Mathematical Lineage',
        description:
          "Click 'Explain' next to any member to view the exact equation (Paid - Share + Sent - Received = Net).",
        targetTab: 'groups',
        actionLabel: 'Inspect Balances',
      },
    ],
  },
  {
    pageKey: 'activity',
    pageTitle: 'Transparent Activity Feed, Revisions & Trash Vault',
    shortTip:
      'Every create, edit, currency change, settlement, and conflict in a group is logged here with HLC timestamps and 1-click restore.',
    whereToFindWhat: [
      'Activity Timeline: Filter by any action type (Expense Edited, Conflict Flagged, Settlement Recorded, etc.).',
      'Revision Inspector: View field-by-field before -> after diffs and restore any historical revision.',
      'Trash Recovery Vault: Restore soft-deleted bills in one click.',
    ],
    steps: [
      {
        stepNumber: 1,
        title: 'Inspect Field-Level Edit Diffs',
        description:
          'Filter by Expense Updated or Conflict Flagged to inspect before and after snapshots with HLC timestamps.',
        targetTab: 'activity',
        actionLabel: 'View Activity Feed',
      },
      {
        stepNumber: 2,
        title: 'Restore Soft-Deleted Bills from Trash',
        description:
          'Open the Trash Recovery drawer to restore any deleted expense back into the active group ledger in 1 click.',
        targetTab: 'activity',
        actionLabel: 'Open Trash Vault',
      },
    ],
  },
  {
    pageKey: 'friends',
    pageTitle: 'Cross-Group Friends Net Ledger & UPI/WhatsApp Studio',
    shortTip:
      'See your combined net balance with each friend across all shared groups and direct non-group splits, without mixing strangers across groups.',
    whereToFindWhat: [
      "Friends Net List: Per-group breakdown + 'Settle All Across Groups' atomic batch button.",
      'UPI QR & Deep-Link Studio: Pre-filled upi://pay links and scannable QR code.',
      'WhatsApp Summary Generator: Copy-ready markdown and visual summary card.',
    ],
    steps: [
      {
        stepNumber: 1,
        title: 'Settle All Shared Groups + Direct Splits Atomically',
        description:
          "Pick a friend and click 'Settle All Across Groups' to record linked settlements across every shared group in one batch.",
        targetTab: 'friends',
        actionLabel: 'Open Friends Hub',
      },
      {
        stepNumber: 2,
        title: 'Share UPI QR or WhatsApp Statement',
        description:
          'Generate a scannable UPI QR code or copy a formatted WhatsApp breakdown with exact minor-unit amounts.',
        targetTab: 'friends',
        actionLabel: 'Launch UPI Studio',
      },
    ],
  },
  {
    pageKey: 'analytics',
    pageTitle: 'Deep Spending Analytics & Global Instant Search',
    shortTip:
      'Full visual breakdowns by category and split mode, plus instant search across all groups and currencies.',
    whereToFindWhat: [
      'Category & Split Mode Charts: Proportional SVG ring and bar distributions.',
      'Global Search: Filter by keyword, #tag, currency (INR/JPY/KWD/EUR/USD), or split mode.',
    ],
    steps: [
      {
        stepNumber: 1,
        title: 'Search Across All Groups & Direct Splits',
        description:
          'Filter bills by keyword, #tag, currency code, or split algorithm across your entire ledger.',
        targetTab: 'analytics',
        actionLabel: 'Open Global Search',
      },
    ],
  },
  {
    pageKey: 'portability',
    pageTitle: 'Local IndexedDB, Supabase Sync & Data Portability',
    shortTip:
      'Manage your local Dexie IndexedDB mirror, Supabase wise_spliter cloud sync, Splitwise CSV imports, and AES-256-GCM encrypted backups.',
    whereToFindWhat: [
      'Cloud Sync Center: Toggle Offline Flight Mode and flush queued outbox mutations to wise_spliter.',
      'Splitwise Importer & CSV/PDF Exporter: Migrate data in or export statements out.',
      'Encrypted Backup Vault: PBKDF2 + AES-256-GCM encrypted .wisesplit backup and restore.',
    ],
    steps: [
      {
        stepNumber: 1,
        title: 'Import Splitwise CSV or Export Encrypted Backup',
        description:
          'Preview and import Splitwise CSV/JSON files or download an AES-256-GCM encrypted .wisesplit archive.',
        targetTab: 'portability',
        actionLabel: 'Open Sync & Backups',
      },
    ],
  },
];

const SECTION_TAB_LABELS: Array<{ key: GuidePageKey; label: string }> = [
  { key: 'home', label: 'Home & Quick Split' },
  { key: 'groups', label: 'Groups & 5-Mode Splits' },
  { key: 'activity', label: 'Activity & Conflict History' },
  { key: 'friends', label: 'Friends & UPI Settle' },
  { key: 'analytics', label: 'Insights & Search' },
  { key: 'portability', label: 'Offline Sync & Backups' },
];

export function ContextualPageGuideBanner({
  pageKey,
  onOpenFullHelp,
}: {
  pageKey: GuidePageKey;
  onOpenFullHelp?: () => void;
}) {
  const { dataset, setActivePage } = useLedger();
  const [showPills, setShowPills] = useState(false);
  const [isDismissed, setIsDismissed] = useState(false);
  const [internalModalOpen, setInternalModalOpen] = useState(false);

  const guideSection = useMemo(() => {
    const fromCatalog = dataset.helpGuidesCatalog?.find((h) => h.pageKey === pageKey);
    const fallback = FALLBACK_HELP_GUIDES.find((h) => h.pageKey === pageKey) ?? FALLBACK_HELP_GUIDES[0]!;
    if (!fromCatalog) return fallback;
    return {
      ...fallback,
      ...fromCatalog,
      whereToFindWhat:
        fromCatalog.whereToFindWhat && fromCatalog.whereToFindWhat.length > 0
          ? fromCatalog.whereToFindWhat
          : fallback.whereToFindWhat,
      steps:
        fromCatalog.steps && fromCatalog.steps.length > 0 ? fromCatalog.steps : fallback.steps,
    };
  }, [dataset.helpGuidesCatalog, pageKey]);

  const handleOpenHelp = () => {
    if (onOpenFullHelp) {
      onOpenFullHelp();
    } else {
      setInternalModalOpen(true);
    }
  };

  if (isDismissed) {
    return (
      <>
        <div
          data-testid="contextual-page-guide"
          className="flex items-center justify-between gap-2 rounded-xl border border-slate-200/70 dark:border-white/10 bg-white/70 dark:bg-slate-900/50 px-3.5 py-2 text-xs text-slate-600 dark:text-slate-400"
        >
          <span className="inline-flex items-center gap-1.5 font-medium">
            <Info className="w-3.5 h-3.5 text-[#059669]" weight="duotone" />
            <span>{guideSection.pageTitle}</span>
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setIsDismissed(false)}
              className="text-xs font-semibold text-slate-600 dark:text-slate-300 hover:text-[#059669] transition-colors"
            >
              Show Tip
            </button>
            <button
              type="button"
              data-testid="open-full-help-btn"
              onClick={handleOpenHelp}
              className="inline-flex items-center gap-1 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 px-2.5 py-1 text-xs font-semibold transition-colors"
            >
              <BookOpen className="w-3.5 h-3.5" />
              <span>Full App Guide</span>
            </button>
          </div>
        </div>
        {!onOpenFullHelp && (
          <HelpGuideModal
            isOpen={internalModalOpen}
            onClose={() => setInternalModalOpen(false)}
            onNavigateTab={(tab) => setActivePage(tab)}
          />
        )}
      </>
    );
  }

  return (
    <>
      <div
        data-testid="contextual-page-guide"
        className="rounded-2xl border border-emerald-500/25 bg-emerald-500/[0.04] dark:bg-emerald-500/[0.06] px-4 py-3 transition-all"
      >
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="flex items-start gap-2.5 min-w-0">
            <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-emerald-500/15 text-[#059669] dark:text-emerald-400">
              <Compass className="w-4 h-4" weight="duotone" />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-bold text-slate-900 dark:text-slate-100">
                  {guideSection.pageTitle}
                </span>
                <span className="text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                  Page Guide
                </span>
              </div>
              <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                {guideSection.shortTip}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setShowPills((prev) => !prev)}
              className="inline-flex items-center gap-1 rounded-xl border border-slate-200 dark:border-white/10 bg-white dark:bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-300 hover:border-emerald-500/40 transition-colors"
            >
              <span>Where to find what on this screen</span>
              {showPills ? (
                <CaretUp className="w-3.5 h-3.5" weight="bold" />
              ) : (
                <CaretDown className="w-3.5 h-3.5" weight="bold" />
              )}
            </button>

            <button
              type="button"
              data-testid="open-full-help-btn"
              onClick={handleOpenHelp}
              className="inline-flex items-center gap-1.5 rounded-xl bg-[#059669] hover:bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors"
            >
              <Question className="w-3.5 h-3.5" weight="bold" />
              <span>Full App Guide</span>
            </button>

            <button
              type="button"
              onClick={() => setIsDismissed(true)}
              className="rounded-lg p-1.5 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors"
              aria-label="Minimize page guide"
              title="Minimize guide"
            >
              <X className="w-3.5 h-3.5" weight="bold" />
            </button>
          </div>
        </div>

        {showPills && (
          <div className="mt-3 pt-2.5 border-t border-emerald-500/20 grid grid-cols-1 sm:grid-cols-2 gap-2">
            {guideSection.whereToFindWhat.map((item, idx) => (
              <div
                key={idx}
                className="flex items-start gap-2 rounded-xl bg-white/90 dark:bg-slate-900/80 border border-slate-200/70 dark:border-white/10 px-3 py-2 text-xs text-slate-700 dark:text-slate-300"
              >
                <CheckCircle
                  className="w-3.5 h-3.5 text-[#059669] shrink-0 mt-0.5"
                  weight="fill"
                />
                <span>{item}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {!onOpenFullHelp && (
        <HelpGuideModal
          isOpen={internalModalOpen}
          onClose={() => setInternalModalOpen(false)}
          onNavigateTab={(tab) => setActivePage(tab)}
        />
      )}
    </>
  );
}

export function HelpGuideModal({
  isOpen,
  onClose,
  onNavigateTab,
}: {
  isOpen: boolean;
  onClose: () => void;
  onNavigateTab: (tab: any) => void;
}) {
  const { dataset } = useLedger();
  const [selectedTabKey, setSelectedTabKey] = useState<GuidePageKey>('home');

  const mergedCatalog: HelpGuideSection[] = useMemo(() => {
    return SECTION_TAB_LABELS.map(({ key }) => {
      const fromData = dataset.helpGuidesCatalog?.find((h) => h.pageKey === key);
      const fallback = FALLBACK_HELP_GUIDES.find((h) => h.pageKey === key)!;
      if (!fromData) return fallback;
      return {
        ...fallback,
        ...fromData,
        whereToFindWhat:
          fromData.whereToFindWhat && fromData.whereToFindWhat.length > 0
            ? fromData.whereToFindWhat
            : fallback.whereToFindWhat,
        steps: fromData.steps && fromData.steps.length > 0 ? fromData.steps : fallback.steps,
      };
    });
  }, [dataset.helpGuidesCatalog]);

  const activeSection =
    mergedCatalog.find((s) => s.pageKey === selectedTabKey) ?? mergedCatalog[0]!;

  if (!isOpen) return null;

  const handleJumpToFeature = (targetTab: string) => {
    onNavigateTab(targetTab);
    onClose();
  };

  return (
    <div
      data-testid="help-guide-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-3 sm:p-6 overflow-y-auto"
    >
      <div className="w-full max-w-4xl my-auto">
        <DoubleBezelCard
          className="shadow-2xl"
          innerClassName="max-h-[90vh] overflow-y-auto space-y-5 bg-white dark:bg-[#111827] text-slate-900 dark:text-slate-100"
        >
          {/* Header */}
          <div className="flex items-start justify-between gap-4 border-b border-slate-200/80 dark:border-white/10 pb-4">
            <div>
              <div className="flex items-center gap-2">
                <StatusBadge tone="emerald">
                  <Sparkle className="w-3.5 h-3.5" weight="fill" />
                  <span>Interactive App Guide &amp; Feature Map</span>
                </StatusBadge>
              </div>
              <h2 className="mt-1.5 text-lg sm:text-xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
                How to Split Bills, Manage Groups &amp; Find Every Feature
              </h2>
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                Progressive disclosure keeps Home clutter-free while giving you 1-click access to
                group ledgers, direct non-group splits, and audit tools.
              </p>
            </div>
            <button
              type="button"
              data-testid="close-help-modal-btn"
              onClick={onClose}
              className="rounded-xl p-2 text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/10 transition-colors"
              aria-label="Close help modal"
            >
              <X className="w-5 h-5" weight="bold" />
            </button>
          </div>

          {/* Section Navigation Tabs */}
          <div className="flex flex-wrap gap-2">
            {SECTION_TAB_LABELS.map((tab) => {
              const isSelected = selectedTabKey === tab.key;
              return (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setSelectedTabKey(tab.key)}
                  className={`rounded-xl px-3.5 py-2 text-xs font-bold transition-all border ${
                    isSelected
                      ? 'bg-[#059669] text-white border-[#059669] shadow-sm'
                      : 'bg-slate-50 dark:bg-slate-900/70 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-white/10 hover:border-emerald-500/40'
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>

          {/* Active Section Details */}
          <div className="rounded-2xl border border-slate-200 dark:border-white/10 bg-slate-50/70 dark:bg-slate-900/60 p-4 sm:p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">
                  {activeSection.pageTitle}
                </h3>
                <p className="mt-1 text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                  {activeSection.shortTip}
                </p>
              </div>
              <button
                type="button"
                onClick={() => handleJumpToFeature(activeSection.pageKey)}
                className="inline-flex items-center gap-1.5 rounded-xl bg-[#059669] hover:bg-emerald-600 px-3.5 py-2 text-xs font-bold text-white shadow-sm transition-colors shrink-0"
              >
                <span>Go to {SECTION_TAB_LABELS.find((t) => t.key === activeSection.pageKey)?.label}</span>
                <ArrowRight className="w-3.5 h-3.5" weight="bold" />
              </button>
            </div>

            {/* Where to Find What Checklist */}
            <div className="space-y-2">
              <div className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                Where to Find What
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {activeSection.whereToFindWhat.map((item, idx) => (
                  <div
                    key={idx}
                    className="flex items-start gap-2.5 rounded-xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-white/10 p-3 text-xs text-slate-700 dark:text-slate-200"
                  >
                    <CheckCircle
                      className="w-4 h-4 text-[#059669] shrink-0 mt-0.5"
                      weight="fill"
                    />
                    <span>{item}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Step-by-Step Workflows */}
            {activeSection.steps.length > 0 && (
              <div className="space-y-2.5 pt-2">
                <div className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  Step-by-Step Workflows
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  {activeSection.steps.map((step) => (
                    <div
                      key={step.stepNumber}
                      className="flex flex-col justify-between rounded-xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-white/10 p-3.5 space-y-3"
                    >
                      <div className="space-y-1.5">
                        <div className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-mono tabular-nums font-bold text-emerald-700 dark:text-emerald-300">
                          Step 0{step.stepNumber}
                        </div>
                        <div className="text-xs font-bold text-slate-900 dark:text-slate-100">
                          {step.title}
                        </div>
                        <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                          {step.description}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleJumpToFeature(step.targetTab)}
                        className="inline-flex items-center justify-between gap-1.5 rounded-lg bg-slate-100 dark:bg-white/10 hover:bg-emerald-500/15 hover:text-emerald-700 dark:hover:text-emerald-300 px-3 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 transition-colors"
                      >
                        <span>{step.actionLabel}</span>
                        <ArrowRight className="w-3.5 h-3.5" weight="bold" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between gap-3 pt-2 border-t border-slate-200/80 dark:border-white/10">
            <span className="text-xs text-slate-500 dark:text-slate-400">
              Tip: Every screen has a collapsible guide banner at the top for quick reference.
            </span>
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl bg-slate-900 dark:bg-white text-white dark:text-slate-900 px-4 py-2 text-xs font-bold hover:opacity-90 transition-opacity"
            >
              Got It
            </button>
          </div>
        </DoubleBezelCard>
      </div>
    </div>
  );
}
