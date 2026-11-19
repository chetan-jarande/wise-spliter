import React, { useMemo, useState } from 'react';
import {
  ArrowRightIcon as ArrowRight,
  BookOpenIcon as BookOpen,
  CaretDownIcon as CaretDown,
  CaretUpIcon as CaretUp,
  CheckCircleIcon as CheckCircle,
  CompassIcon as Compass,
  InfoIcon as Info,
  QuestionIcon as Question,
  SparkleIcon as Sparkle,
  XIcon as X,
} from '@phosphor-icons/react';
import { HelpGuideSection } from '../../types/ledger';
import { ActivePageTab, useLedger } from '../../state/LedgerContext';
import { StatusBadge } from '../primitives/DesignPrimitives';

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
    pageTitle: 'Home & Quick Split',
    shortTip:
      'See whether friends owe you or you owe them at a glance, split a bill in seconds, or open your 3 most recent groups.',
    whereToFindWhat: [
      'Overall Standing: Plain-English summary of whether you are owed, owe, or are settled up.',
      'Split a Bill: Split a casual 1-on-1 meal (no group needed) or add a bill to any group.',
      'Recent Groups (Top 3): Jump straight into your 3 most recently active shared groups.',
      'Direct Splits: 1-on-1 or casual bills split with friends outside any group.',
    ],
    steps: [
      {
        stepNumber: 1,
        title: 'Split a Group or 1-on-1 Bill',
        description:
          "Tap 'Split a Bill' on Home. Leave scope as 'No Group' for a quick 1-on-1 split, or choose a group.",
        targetTab: 'home',
        actionLabel: 'Start a Split',
      },
      {
        stepNumber: 2,
        title: 'Open Any Group Ledger',
        description:
          'Tap any recent group card to see every bill, check your personal share, or add friends by name.',
        targetTab: 'groups',
        actionLabel: 'Explore Groups',
      },
      {
        stepNumber: 3,
        title: 'Settle via UPI QR or WhatsApp',
        description:
          'Open Friends & Settle to pay back across all shared groups at once or share a WhatsApp summary.',
        targetTab: 'friends',
        actionLabel: 'Go to Settle Up',
      },
    ],
  },
  {
    pageKey: 'groups',
    pageTitle: 'Group Ledger & Shared Bills',
    shortTip:
      'Every bill row shows the total plus what you personally lent or borrowed - tap Explain Balance anytime to see the exact math.',
    whereToFindWhat: [
      'Group Summary Bar: Total group spend, your personal share, and whether you get money back or owe.',
      "Left Column: Group members, 'Explain Balance' breakdown, and suggested minimum repayments.",
      'Right Column: Shared bills with clear emerald (you lent) and rose (you borrowed) badges.',
      'Group Controls: Toggle smart debt simplification, add friends, or switch currency.',
    ],
    steps: [
      {
        stepNumber: 1,
        title: 'Add a Bill to This Group',
        description:
          "Tap 'Add Expense' - this group is pre-selected automatically with Equal, Exact, %, Shares, and +/- modes.",
        targetTab: 'groups',
        actionLabel: 'Add Group Bill',
      },
      {
        stepNumber: 2,
        title: 'Verify Any Balance in 1 Tap',
        description:
          "Tap 'Explain Balance' on any member to see every bill and payment behind their number.",
        targetTab: 'groups',
        actionLabel: 'Inspect Balances',
      },
    ],
  },
  {
    pageKey: 'activity',
    pageTitle: 'Activity Timeline, Edit History & Trash',
    shortTip:
      'Full peace of mind: see every bill added, edited, or deleted, and restore any earlier version or trashed bill in one tap.',
    whereToFindWhat: [
      'Activity Timeline: Plain-English feed of bills added, edits made, and payments recorded.',
      'Edit History Inspector: Side-by-side before -> after changes on edited bills with 1-tap restore.',
      'Trash Recovery Vault: Accidentally deleted a bill? Restore it cleanly in one click.',
    ],
    steps: [
      {
        stepNumber: 1,
        title: 'Review What Changed on Edited Bills',
        description:
          'Check the Edit History panel to see who changed an amount or split and restore an older version if needed.',
        targetTab: 'activity',
        actionLabel: 'View Edit History',
      },
      {
        stepNumber: 2,
        title: 'Recover Deleted Bills from Trash',
        description:
          'Use the Trash Recovery panel to bring back any deleted bill with all shares intact.',
        targetTab: 'activity',
        actionLabel: 'Open Trash Vault',
      },
    ],
  },
  {
    pageKey: 'friends',
    pageTitle: 'Friends Balances & UPI / WhatsApp Settle Up',
    shortTip:
      'See your combined net balance with each friend across all shared groups, settle everything in 1 tap, or scan a UPI QR code.',
    whereToFindWhat: [
      "Friends List: Combined net standing with each friend + '1-Tap Settle All' across shared groups.",
      'UPI QR & Payment Studio: Ready-to-scan QR code and 1-tap GPay / PhonePe / Paytm links.',
      'WhatsApp Summary Card: Copy a clean group summary message to paste into your group chat.',
    ],
    steps: [
      {
        stepNumber: 1,
        title: 'Settle All Shared Groups in 1 Tap',
        description:
          "Tap '1-Tap Settle All' next to a friend to clear your balance across every group you share.",
        targetTab: 'friends',
        actionLabel: 'Open Friends Hub',
      },
      {
        stepNumber: 2,
        title: 'Scan UPI QR or Share on WhatsApp',
        description:
          'Generate an exact-amount UPI QR code or copy a ready-to-send WhatsApp summary.',
        targetTab: 'friends',
        actionLabel: 'Open UPI Studio',
      },
    ],
  },
  {
    pageKey: 'analytics',
    pageTitle: 'Spending Insights & Global Search',
    shortTip:
      'See where your group money went by category and instantly find any bill across all groups, tags, and currencies.',
    whereToFindWhat: [
      'Category Ring & Bars: Visual breakdown of Food, Stays, Flights, Groceries, and Activities.',
      'Instant Search: Find any expense by name, #tag, friend, or travel currency (INR, EUR, JPY, KWD).',
    ],
    steps: [
      {
        stepNumber: 1,
        title: 'Find Any Bill Instantly',
        description:
          'Type a keyword, #tag, or currency code to filter across every group and direct split.',
        targetTab: 'analytics',
        actionLabel: 'Search Bills',
      },
    ],
  },
  {
    pageKey: 'portability',
    pageTitle: 'Cloud Sync, Exports & Switch from Splitwise',
    shortTip:
      'Works 100% offline on flights, syncs automatically when online, imports Splitwise CSVs, and exports Excel, PDF, or encrypted backups.',
    whereToFindWhat: [
      'Offline & Cloud Sync: Test Airplane Mode and sync queued changes whenever you reconnect.',
      'Splitwise Importer: Bring over existing Splitwise CSV/JSON history in one click.',
      'Spreadsheet, PDF & Backup: Download .xlsx, .pdf, .csv statements or a password-locked .wisesplit backup.',
    ],
    steps: [
      {
        stepNumber: 1,
        title: 'Import Splitwise or Export Statements',
        description:
          'Migrate from Splitwise in seconds or download clean Excel / PDF trip statements.',
        targetTab: 'portability',
        actionLabel: 'Open Exports & Backup',
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
  const { setActivePage } = useLedger();
  const [showPills, setShowPills] = useState(false);
  const [isDismissed, setIsDismissed] = useState(false);
  const [internalModalOpen, setInternalModalOpen] = useState(false);

  const guideSection = useMemo(() => {
    const fallback =
      FALLBACK_HELP_GUIDES.find((h) => h.pageKey === pageKey) ?? FALLBACK_HELP_GUIDES[0]!;
    return fallback;
  }, [pageKey]);

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
          className="lg-recessed-well flex items-center justify-between gap-2 rounded-[20px] px-4 py-2 text-xs text-[#4A524D] dark:text-[#B7BEB9]"
        >
          <span className="inline-flex items-center gap-2 font-medium min-w-0">
            <span className="lg-icon-orb h-6 w-6 rounded-full inline-flex items-center justify-center shrink-0 text-emerald-700 dark:text-emerald-300">
              <Info className="w-3.5 h-3.5" weight="duotone" />
            </span>
            <span className="truncate">{guideSection.pageTitle}</span>
          </span>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => setIsDismissed(false)}
              className="inline-flex items-center justify-center rounded-full px-2.5 py-1 text-xs font-semibold text-[#4A524D] dark:text-[#B7BEB9] hover:text-[#141715] dark:hover:text-[#F3F5F3] transition-colors cursor-pointer"
            >
              Show Tip
            </button>
            <button
              type="button"
              data-testid="open-full-help-btn"
              onClick={handleOpenHelp}
              className="lg-scene-tile inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold text-[#141715] dark:text-[#F3F5F3] cursor-pointer"
            >
              <BookOpen className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-300" />
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
        className="lg-recessed-well rounded-[20px] px-4 py-2.5 transition-colors"
      >
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-2.5">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="lg-icon-orb inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-emerald-700 dark:text-emerald-300">
              <Compass className="w-3.5 h-3.5" weight="duotone" />
            </span>
            <p className="text-xs text-[#4A524D] dark:text-[#B7BEB9] leading-snug truncate sm:whitespace-normal">
              <span className="font-semibold text-[#141715] dark:text-[#F3F5F3] mr-1.5">
                {guideSection.pageTitle}:
              </span>
              {guideSection.shortTip}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => setShowPills((prev) => !prev)}
              className="lg-scene-tile inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-semibold text-[#1F2421] dark:text-[#E5EAE6] cursor-pointer"
            >
              <span>Quick tips</span>
              {showPills ? (
                <CaretUp className="w-3 h-3" weight="bold" />
              ) : (
                <CaretDown className="w-3 h-3" weight="bold" />
              )}
            </button>

            <button
              type="button"
              data-testid="open-full-help-btn"
              onClick={handleOpenHelp}
              className="inline-flex items-center gap-1 rounded-full bg-emerald-500/12 dark:bg-emerald-400/14 hover:bg-emerald-500/20 text-emerald-800 dark:text-emerald-200 ring-1 ring-emerald-600/25 dark:ring-emerald-300/25 px-3 py-1 text-xs font-semibold transition-colors cursor-pointer"
            >
              <Question className="w-3.5 h-3.5" weight="bold" />
              <span>Help Guide</span>
            </button>

            <button
              type="button"
              onClick={() => setIsDismissed(true)}
              className="lg-icon-orb inline-flex items-center justify-center rounded-full p-1.5 text-[#5C6660] dark:text-[#9CA69F] hover:text-[#141715] dark:hover:text-[#F3F5F3] transition-colors cursor-pointer"
              aria-label="Minimize page guide"
              title="Hide tip"
            >
              <X className="w-3.5 h-3.5" weight="bold" />
            </button>
          </div>
        </div>

        {showPills && (
          <div className="mt-2.5 pt-2.5 border-t border-black/[0.07] dark:border-white/[0.09] grid grid-cols-1 sm:grid-cols-2 gap-2">
            {guideSection.whereToFindWhat.map((item, idx) => (
              <div
                key={idx}
                className="lg-scene-tile flex items-start gap-2 rounded-[14px] px-3 py-2 text-xs text-[#2B312D] dark:text-[#DCE2DD]"
              >
                <CheckCircle
                  className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-300 shrink-0 mt-0.5"
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
  onNavigateTab: (tab: ActivePageTab) => void;
}) {
  const [selectedTabKey, setSelectedTabKey] = useState<GuidePageKey>('home');

  const mergedCatalog: HelpGuideSection[] = useMemo(() => {
    return SECTION_TAB_LABELS.map(({ key }) => {
      return FALLBACK_HELP_GUIDES.find((h) => h.pageKey === key)!;
    });
  }, []);

  const activeSection =
    mergedCatalog.find((s) => s.pageKey === selectedTabKey) ?? mergedCatalog[0]!;

  if (!isOpen) return null;

  const isValidTab = (val: string): val is ActivePageTab =>
    val === 'home' ||
    val === 'groups' ||
    val === 'activity' ||
    val === 'friends' ||
    val === 'analytics' ||
    val === 'portability';

  const handleJumpToFeature = (targetTab: string) => {
    onNavigateTab(isValidTab(targetTab) ? targetTab : 'home');
    onClose();
  };

  return (
    <div
      data-testid="help-guide-modal"
      className="fixed inset-0 z-50 flex items-center justify-center lg-modal-scrim p-3 sm:p-6 overflow-y-auto"
    >
      <div className="w-full max-w-4xl my-auto lg-modal-surface rounded-[30px] p-5 sm:p-7 max-h-[90vh] overflow-y-auto space-y-5 text-[#141715] dark:text-[#F3F5F3]">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-black/[0.07] dark:border-white/[0.10] pb-4">
          <div>
            <div className="flex items-center gap-2">
              <StatusBadge tone="emerald">
                <Sparkle className="w-3.5 h-3.5" weight="fill" />
                <span>Interactive App Guide &amp; Feature Map</span>
              </StatusBadge>
            </div>
            <h2 className="mt-2 text-lg sm:text-xl font-bold tracking-tight text-[#141715] dark:text-[#F3F5F3]">
              How to Split Bills, Manage Groups &amp; Find Every Feature
            </h2>
            <p className="mt-1 text-xs text-[#5C6660] dark:text-[#9CA69F]">
              Progressive disclosure keeps Home clutter-free while giving you 1-click access to
              group ledgers, direct non-group splits, and audit tools.
            </p>
          </div>
          <button
            type="button"
            data-testid="close-help-modal-btn"
            onClick={onClose}
            className="lg-icon-orb min-h-[44px] min-w-[44px] h-11 w-11 rounded-full flex items-center justify-center text-[#4A524D] hover:text-[#141715] dark:text-[#B7BEB9] dark:hover:text-white transition-colors shrink-0 cursor-pointer"
            aria-label="Close help modal"
          >
            <X className="w-4 h-4" weight="bold" />
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
                className={`inline-flex items-center justify-center rounded-full px-4 py-2 text-xs font-semibold transition-[transform,opacity,background-color,color,box-shadow] duration-200 cursor-pointer ${
                  isSelected
                    ? 'lg-luminous-pill'
                    : 'lg-scene-tile text-[#4A524D] dark:text-[#B7BEB9] hover:text-[#141715] dark:hover:text-white'
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Active Section Details */}
        <div className="lg-recessed-well rounded-[24px] p-4 sm:p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-bold text-[#141715] dark:text-[#F3F5F3]">
                {activeSection.pageTitle}
              </h3>
              <p className="mt-1 text-xs text-[#4A524D] dark:text-[#B7BEB9] leading-relaxed">
                {activeSection.shortTip}
              </p>
            </div>
            <button
              type="button"
              onClick={() => handleJumpToFeature(activeSection.pageKey)}
              className="lg-luminous-pill min-h-[40px] inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-xs font-semibold shrink-0 cursor-pointer"
            >
              <span>
                Go to {SECTION_TAB_LABELS.find((t) => t.key === activeSection.pageKey)?.label}
              </span>
              <ArrowRight className="w-3.5 h-3.5" weight="bold" />
            </button>
          </div>

          {/* Where to Find What Checklist */}
          <div className="space-y-2">
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#68726C] dark:text-[#8A938D]">
              Where to Find What
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {activeSection.whereToFindWhat.map((item, idx) => (
                <div
                  key={idx}
                  className="lg-scene-tile flex items-start gap-2.5 rounded-[16px] p-3.5 text-xs text-[#1F2421] dark:text-[#E5EAE6]"
                >
                  <CheckCircle
                    className="w-4 h-4 text-emerald-700 dark:text-emerald-300 shrink-0 mt-0.5"
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
              <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#68726C] dark:text-[#8A938D]">
                Step-by-Step Workflows
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {activeSection.steps.map((step) => (
                  <div
                    key={step.stepNumber}
                    className="lg-scene-tile flex flex-col justify-between rounded-[18px] p-4 space-y-3"
                  >
                    <div className="space-y-1.5">
                      <div className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/12 dark:bg-emerald-400/14 ring-1 ring-emerald-600/25 dark:ring-emerald-300/25 px-2.5 py-0.5 text-[11px] font-mono tabular-nums font-semibold text-emerald-800 dark:text-emerald-200">
                        Step 0{step.stepNumber}
                      </div>
                      <div className="text-xs font-bold text-[#141715] dark:text-[#F3F5F3]">
                        {step.title}
                      </div>
                      <p className="text-xs text-[#4A524D] dark:text-[#B7BEB9] leading-relaxed">
                        {step.description}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleJumpToFeature(step.targetTab)}
                      className="lg-recessed-well inline-flex items-center justify-between gap-1.5 rounded-full px-3.5 py-2 text-xs font-semibold text-[#141715] dark:text-[#F3F5F3] hover:bg-emerald-500/12 hover:text-emerald-800 dark:hover:text-emerald-200 transition-colors cursor-pointer"
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
        <div className="flex items-center justify-between gap-3 pt-2 border-t border-black/[0.07] dark:border-white/[0.10]">
          <span className="text-xs text-[#5C6660] dark:text-[#9CA69F]">
            Tip: Every screen has a collapsible guide banner at the top for quick reference.
          </span>
          <button
            type="button"
            onClick={onClose}
            className="lg-luminous-pill min-h-[42px] inline-flex items-center justify-center rounded-full px-5 py-2 text-xs font-semibold cursor-pointer"
          >
            Got It
          </button>
        </div>
      </div>
    </div>
  );
}
