import React, { useCallback, useEffect, useState } from 'react';
import {
  ArrowsLeftRightIcon as ArrowsLeftRight,
  ChartPolarIcon as ChartPolar,
  ClockCounterClockwiseIcon as ClockCounterClockwise,
  CloudArrowUpIcon as CloudArrowUp,
  CloudSlashIcon as CloudSlash,
  DatabaseIcon as Database,
  HouseIcon as House,
  MagnifyingGlassIcon as MagnifyingGlass,
  MoonIcon as Moon,
  PlusIcon as Plus,
  QuestionIcon as Question,
  ReceiptIcon as Receipt,
  ShieldCheckIcon as ShieldCheck,
  SunIcon as Sun,
  UsersThreeIcon as UsersThree,
  XIcon as X,
} from '@phosphor-icons/react';
import { ActivePageTab, useLedger } from './state/LedgerContext';
import { HomeDashboardPage } from './ui/pages/HomeDashboardPage';
import { GroupsLedgerPage } from './ui/pages/GroupsLedgerPage';
import { ActivityAndTrashPage } from './ui/pages/ActivityAndTrashPage';
import { FriendsAndSettlePage } from './ui/pages/FriendsAndSettlePage';
import { AnalyticsAndSearchPage } from './ui/pages/AnalyticsAndSearchPage';
import { PortabilityAndSyncPage } from './ui/pages/PortabilityAndSyncPage';
import { ContextualPageGuideBanner, HelpGuideModal } from './ui/modals/HelpGuideModal';
import { ExpenseEditorModal } from './ui/modals/ExpenseEditorModal';
import { DevAuthModal } from './ui/modals/DevAuthModal';
import { registerNativeBackButtonHandler } from './utils/native-platform';
import { backupPassphraseProblem } from './portability/portability-engine';
import { formatMinorToMajor } from './domain/money/currencies';

const NAV_ITEMS: Array<{
  id: ActivePageTab;
  label: string;
  shortLabel: string;
  section: 'workspace' | 'system';
  testId: string;
  icon: React.ComponentType<{ size?: number; weight?: 'regular' | 'bold' | 'duotone' | 'fill' }>;
}> = [
  {
    id: 'home',
    label: 'Home',
    shortLabel: 'Home',
    section: 'workspace',
    testId: 'nav-tab-home',
    icon: House,
  },
  {
    id: 'groups',
    label: 'Groups & Ledger',
    shortLabel: 'Groups',
    section: 'workspace',
    testId: 'nav-tab-groups',
    icon: Receipt,
  },
  {
    id: 'activity',
    label: 'Activity & History',
    shortLabel: 'History',
    section: 'workspace',
    testId: 'nav-tab-activity',
    icon: ClockCounterClockwise,
  },
  {
    id: 'friends',
    label: 'Friends & Settle',
    shortLabel: 'Settle',
    section: 'workspace',
    testId: 'nav-tab-friends',
    icon: ArrowsLeftRight,
  },
  {
    id: 'analytics',
    label: 'Insights & Search',
    shortLabel: 'Insights',
    section: 'system',
    testId: 'nav-tab-analytics',
    icon: ChartPolar,
  },
  {
    id: 'portability',
    label: 'Portability & Sync',
    shortLabel: 'Sync/Export',
    section: 'system',
    testId: 'nav-tab-portability',
    icon: Database,
  },
];

const MOBILE_NAV_ITEMS = NAV_ITEMS.slice(0, 5);
const WORKSPACE_NAV_ITEMS = NAV_ITEMS.filter((item) => item.section === 'workspace');
const SYSTEM_NAV_ITEMS = NAV_ITEMS.filter((item) => item.section === 'system');

export function App() {
  const {
    pendingUserSwitch,
    resolvePendingUserSwitch,
    pendingSignOut,
    resolvePendingSignOut,
    pendingLocalImport,
    resolvePendingLocalImport,
    dataset,
    activeGroup,
    activePage,
    setActivePage,
    theme,
    toggleTheme,
    isOnline,
    toggleOfflineMode,
    pendingOutboxCount,
    toastMessage,
    clearToast,
    expenseModalState,
    openAddExpenseModal,
    closeAddExpenseModal,
    isHelpModalOpen,
    setHelpModalOpen,
    isAuthModalOpen,
    setAuthModalOpen,
  } = useLedger();

  const unresolvedConflictCount = dataset.expenses.filter(
    (e) => !e.deletedAt && e.hasUnresolvedConflict
  ).length;

  const activeGroupsCount = dataset.groups.filter((g) => !g.deletedAt).length;
  const activeGroupMembers = activeGroup.members.filter((m) => !m.removedAt);
  const previewMembers = activeGroupMembers.slice(0, 3);

  const isAnyModalOpen =
    expenseModalState.isOpen || isHelpModalOpen || isAuthModalOpen;

  const handleQuickSearch = useCallback(() => {
    setActivePage('analytics');
    window.setTimeout(() => {
      const searchEl = document.querySelector<HTMLInputElement>(
        '#global-search-input, [data-testid="global-search-input"]'
      );
      if (searchEl) {
        searchEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        searchEl.focus();
      }
    }, 45);
  }, [setActivePage]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        if (isAnyModalOpen || pendingUserSwitch || pendingSignOut || pendingLocalImport) {
          return;
        }
        event.preventDefault();
        handleQuickSearch();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    handleQuickSearch,
    isAnyModalOpen,
    pendingLocalImport,
    pendingSignOut,
    pendingUserSwitch,
  ]);

  useEffect(() => {
    return registerNativeBackButtonHandler(() => {
      // Back on a pending decision is the calm "keep things as they are" choice.
      if (pendingLocalImport) {
        void resolvePendingLocalImport('later');
        return true;
      }
      if (pendingSignOut) {
        void resolvePendingSignOut('cancel');
        return true;
      }
      if (pendingUserSwitch) {
        void resolvePendingUserSwitch('cancel');
        return true;
      }
      if (expenseModalState.isOpen) {
        closeAddExpenseModal();
        return true;
      }
      if (isHelpModalOpen) {
        setHelpModalOpen(false);
        return true;
      }
      if (isAuthModalOpen) {
        setAuthModalOpen(false);
        return true;
      }
      if (activePage !== 'home') {
        setActivePage('home');
        return true;
      }
      return false;
    });
  }, [
    pendingLocalImport,
    pendingSignOut,
    pendingUserSwitch,
    resolvePendingLocalImport,
    resolvePendingSignOut,
    resolvePendingUserSwitch,
    expenseModalState.isOpen,
    isHelpModalOpen,
    isAuthModalOpen,
    activePage,
    closeAddExpenseModal,
    setHelpModalOpen,
    setAuthModalOpen,
    setActivePage,
  ]);

  const renderDesktopNavButton = (item: (typeof NAV_ITEMS)[number]) => {
    const Icon = item.icon;
    const isActive = activePage === item.id;
    return (
      <button
        key={item.id}
        type="button"
        data-testid={item.testId}
        onClick={() => setActivePage(item.id)}
        className={`w-full rounded-[16px] px-3.5 py-2.5 text-[13px] font-medium flex items-center justify-between gap-2 transition-[transform,opacity,background-color,color,box-shadow] duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 ${
          isActive
            ? 'lg-luminous-pill font-semibold'
            : 'text-[#4A524D] dark:text-[#B7BEB9] hover:bg-black/[0.045] dark:hover:bg-white/[0.06] hover:text-[#141715] dark:hover:text-white'
        }`}
      >
        <span className="flex items-center gap-2.5 min-w-0">
          <Icon size={17} weight={isActive ? 'bold' : 'regular'} aria-hidden="true" />
          <span className="truncate">{item.label}</span>
        </span>
        {item.id === 'groups' && activeGroupsCount > 0 && (
          <span
            className={`inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[10px] font-mono tabular-nums font-semibold shrink-0 ${
              isActive
                ? 'bg-black/12 dark:bg-black/15 text-inherit'
                : 'bg-black/[0.06] dark:bg-white/[0.08] text-[#4A524D] dark:text-[#B7BEB9]'
            }`}
          >
            {activeGroupsCount}
          </span>
        )}
        {item.id === 'activity' && unresolvedConflictCount > 0 && (
          <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500 px-1.5 text-[10px] font-mono tabular-nums font-bold text-[#141715] shrink-0">
            {unresolvedConflictCount}
          </span>
        )}
      </button>
    );
  };

  return (
    <div className="lg-ambient-backdrop min-h-[100dvh] text-[#141715] dark:text-[#F3F5F3] pb-[calc(10rem+env(safe-area-inset-bottom))] lg:pb-0 transition-colors duration-300">
      {/* Subtle fixed optical sheen & micro-grain layer */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-0 overflow-hidden"
      >
        <div className="absolute -top-36 left-1/5 h-[26rem] w-[26rem] rounded-full bg-emerald-500/[0.045] dark:bg-emerald-400/[0.055] blur-3xl" />
        <div className="absolute bottom-12 right-1/6 h-[22rem] w-[22rem] rounded-full bg-amber-200/[0.12] dark:bg-stone-400/[0.04] blur-3xl" />
        <div
          className="absolute inset-0 opacity-[0.025] dark:opacity-[0.035]"
          style={{
            backgroundImage:
              "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 160 160' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
          }}
        />
      </div>

      {/* 3-Zone Spatial Glass Container */}
      <div className="relative z-10 max-w-[1560px] mx-auto px-1.5 sm:px-1.5 md:px-4 lg:grid lg:grid-cols-[248px_minmax(0,1fr)] lg:gap-4 lg:p-4">
        {/* Zone 1: Left Floating Glass Sidebar Rail (Desktop >= 1024px) */}
        <aside
          aria-label="Workspace Sidebar"
          className="hidden lg:flex lg:flex-col lg:justify-between lg-glass-shell rounded-[28px] p-3.5 sticky top-4 h-[calc(100dvh-2rem)]"
        >
          <div className="space-y-5 min-h-0 overflow-y-auto pr-0.5">
            {/* Top Brand Lockup */}
            <div className="flex items-start gap-3 px-1 pt-0.5">
              <button
                type="button"
                onClick={() => setActivePage('home')}
                aria-label="Go to Wise-Spliter Home"
                className="h-11 w-11 rounded-full lg-luminous-pill flex items-center justify-center shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
              >
                <UsersThree size={19} weight="bold" aria-hidden="true" />
              </button>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="font-bold tracking-tight text-[15px] text-[#141715] dark:text-[#F3F5F3] truncate">
                    Wise-Spliter
                  </span>
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/12 dark:bg-emerald-400/14 px-2 py-0.5 text-[10px] font-mono font-semibold text-emerald-800 dark:text-emerald-200 ring-1 ring-emerald-600/25 dark:ring-emerald-300/25">
                    <ShieldCheck size={11} weight="bold" aria-hidden="true" />
                    100% Free
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setActivePage('groups')}
                  title={`${activeGroup.name} · ${activeGroup.baseCurrency}`}
                  className="mt-0.5 block w-full text-left text-[11.5px] text-[#5C6660] dark:text-[#9CA69F] hover:text-[#141715] dark:hover:text-[#F3F5F3] truncate transition-colors cursor-pointer"
                >
                  {activeGroup.name} · <span className="font-mono">{activeGroup.baseCurrency}</span>
                </button>
              </div>
            </div>

            {/* Categorized Navigation */}
            <nav aria-label="Primary Navigation" className="space-y-4">
              <div className="space-y-1">
                <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#68726C] dark:text-[#8A938D]">
                  WORKSPACE
                </div>
                {WORKSPACE_NAV_ITEMS.map(renderDesktopNavButton)}
              </div>

              <div className="space-y-1">
                <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#68726C] dark:text-[#8A938D]">
                  SYSTEM
                </div>
                {SYSTEM_NAV_ITEMS.map(renderDesktopNavButton)}
              </div>
            </nav>
          </div>

          {/* Bottom Presence Capsule (Ombria "3 at home" dock style) */}
          <button
            type="button"
            onClick={() => setAuthModalOpen(true)}
            aria-label={`Active group presence: ${activeGroupMembers.length} in ${activeGroup.name}. Signed in as ${dataset.currentUser.fullName}`}
            className="lg-scene-tile rounded-[20px] p-3 w-full text-left flex items-center gap-3 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
          >
            <div className="flex items-center -space-x-2 shrink-0" aria-hidden="true">
              {previewMembers.length > 0 ? (
                previewMembers.map((member) => (
                  <span
                    key={member.id}
                    className="h-7 w-7 rounded-full lg-icon-orb bg-[#EAEEEB] dark:bg-[#2B302C] ring-2 ring-white/80 dark:ring-[#1E221F] text-[10px] font-mono font-bold text-[#141715] dark:text-[#F3F5F3] flex items-center justify-center"
                  >
                    {member.avatarInitials}
                  </span>
                ))
              ) : (
                <span className="h-7 w-7 rounded-full lg-icon-orb text-[10px] font-mono font-bold text-[#141715] dark:text-[#F3F5F3] flex items-center justify-center">
                  {dataset.currentUser.avatarInitials}
                </span>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold text-[#141715] dark:text-[#F3F5F3] truncate">
                {activeGroupMembers.length} in {activeGroup.name}
              </div>
              <div className="flex items-center gap-1.5 text-[11px] text-[#5C6660] dark:text-[#9CA69F] truncate">
                <span
                  aria-hidden="true"
                  className={`h-1.5 w-1.5 rounded-full shrink-0 ${
                    isOnline ? 'bg-emerald-500' : 'bg-amber-500'
                  }`}
                />
                <span className="truncate">{dataset.currentUser.fullName}</span>
              </div>
            </div>
          </button>
        </aside>

        {/* Zone 2: Right Column (Floating Command Bar + Enclosed Spatial Stage) */}
        <div className="min-w-0 flex flex-col gap-3.5">
          {/* Top Floating Glass Command & Utility Bar */}
          <header className="sticky top-0 z-30 pt-[max(0.5rem,env(safe-area-inset-top))] lg:static lg:pt-0">
            <div className="lg-glass-shell rounded-[24px] px-1.5 sm:px-4 py-1.5 sm:py-2 flex items-center justify-between gap-1 sm:gap-3">
              {/* Mobile Compact Brand Identity (< 1024px) */}
              <div className="lg:hidden flex items-center gap-1.5 sm:gap-2.5 min-w-0 flex-1">
                <button
                  type="button"
                  onClick={() => setActivePage('home')}
                  aria-label="Go to Wise-Spliter Home"
                  className="h-11 w-11 rounded-full lg-luminous-pill flex items-center justify-center shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
                >
                  <UsersThree size={18} weight="bold" aria-hidden="true" />
                </button>
                <div className="min-w-0">
                  <span className="block font-bold tracking-tight text-[11.5px] min-[400px]:text-sm sm:text-base text-[#141715] dark:text-[#F3F5F3] truncate">
                    Wise-Spliter
                  </span>
                  <button
                    type="button"
                    onClick={() => setActivePage('groups')}
                    className="hidden sm:block text-[11px] text-[#5C6660] dark:text-[#9CA69F] hover:text-[#141715] dark:hover:text-[#F3F5F3] truncate cursor-pointer text-left transition-colors"
                  >
                    {activeGroup.name} · <span className="font-mono">{activeGroup.baseCurrency}</span>
                  </button>
                </div>
              </div>

              {/* Desktop Recessed Quick Search Pill (>= 1024px) */}
              <div className="hidden lg:flex items-center gap-3 min-w-0">
                <button
                  type="button"
                  onClick={handleQuickSearch}
                  aria-label="Search bills, groups, and tags"
                  className="lg-recessed-well rounded-full px-3.5 py-2 min-h-[42px] w-80 xl:w-96 flex items-center justify-between gap-2 text-xs text-[#5C6660] dark:text-[#9CA69F] hover:text-[#141715] dark:hover:text-[#F3F5F3] transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <MagnifyingGlass size={15} weight="bold" aria-hidden="true" className="shrink-0" />
                    <span className="truncate">Search bills, groups, #tags...</span>
                  </span>
                  <kbd className="lg-icon-orb rounded-full px-2 py-0.5 text-[10px] font-mono font-semibold text-[#4A524D] dark:text-[#B7BEB9] shrink-0">
                    ⌘K
                  </kbd>
                </button>
              </div>

              {/* Right Utility Controls (Visible on both mobile 375px & desktop >= 1024px) */}
              <div className="flex items-center gap-0.5 sm:gap-2 shrink-0">
                <button
                  type="button"
                  data-testid="header-offline-toggle"
                  onClick={toggleOfflineMode}
                  title={
                    isOnline
                      ? 'All bills backed up to cloud - click to test Airplane / Offline Mode'
                      : 'Working 100% offline on this device - click to reconnect and sync'
                  }
                  className={`relative min-h-[44px] min-w-[44px] h-11 w-11 sm:w-auto sm:px-3.5 rounded-full inline-flex items-center justify-center gap-1.5 text-xs font-semibold transition-colors duration-200 shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 ${
                    isOnline
                      ? 'bg-emerald-500/12 dark:bg-emerald-400/14 text-emerald-800 dark:text-emerald-200 ring-1 ring-emerald-600/25 dark:ring-emerald-300/25 hover:bg-emerald-500/18'
                      : 'bg-amber-500/15 dark:bg-amber-400/16 text-amber-900 dark:text-amber-200 ring-1 ring-amber-600/30 dark:ring-amber-300/30 hover:bg-amber-500/22'
                  }`}
                >
                  {isOnline ? (
                    <>
                      <CloudArrowUp size={16} weight="bold" aria-hidden="true" />
                      <span className="sr-only sm:not-sr-only">Cloud Synced</span>
                    </>
                  ) : (
                    <>
                      <CloudSlash size={16} weight="bold" aria-hidden="true" />
                      <span className="sr-only sm:not-sr-only">Offline ({pendingOutboxCount})</span>
                      {pendingOutboxCount > 0 && (
                        <span
                          aria-hidden="true"
                          className="sm:hidden absolute -top-0.5 -right-0.5 h-4 min-w-4 px-1 rounded-full bg-amber-500 text-[#141715] text-[9px] font-mono font-bold flex items-center justify-center"
                        >
                          {pendingOutboxCount}
                        </span>
                      )}
                    </>
                  )}
                </button>

                {/* Desktop Quick + Orb Button */}
                <button
                  type="button"
                  onClick={() =>
                    openAddExpenseModal(
                      activePage === 'groups' && activeGroup.id ? activeGroup.id : null,
                      null
                    )
                  }
                  aria-label="Quick split a new bill"
                  title="Split a new bill"
                  className="hidden xl:inline-flex min-h-[44px] min-w-[44px] h-11 w-11 rounded-full lg-luminous-pill items-center justify-center shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
                >
                  <Plus size={17} weight="bold" aria-hidden="true" />
                </button>

                <button
                  type="button"
                  data-testid="header-help-btn"
                  onClick={() => setHelpModalOpen(true)}
                  aria-label="Open interactive Help and Step-by-Step Guide"
                  className="min-h-[44px] min-w-[44px] h-11 w-11 sm:w-auto sm:px-3.5 rounded-full lg-icon-orb inline-flex items-center justify-center gap-1.5 text-xs font-semibold text-[#1F2421] dark:text-[#E5EAE6] hover:bg-black/[0.08] dark:hover:bg-white/[0.12] transition-colors duration-200 shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
                >
                  <Question size={16} weight="bold" aria-hidden="true" />
                  <span className="hidden sm:inline">Help</span>
                </button>

                <button
                  type="button"
                  data-testid="theme-toggle-btn"
                  onClick={toggleTheme}
                  aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
                  className="min-h-[44px] min-w-[44px] h-11 w-11 rounded-full lg-icon-orb text-[#1F2421] dark:text-[#E5EAE6] inline-flex items-center justify-center hover:bg-black/[0.08] dark:hover:bg-white/[0.12] transition-colors duration-200 shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
                >
                  {theme === 'dark' ? (
                    <Sun size={17} weight="bold" aria-hidden="true" />
                  ) : (
                    <Moon size={17} weight="bold" aria-hidden="true" />
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => setActivePage('portability')}
                  aria-label="Open Backup, Sync and Export"
                  title="Backup, Sync & Splitwise Import"
                  className={`lg:hidden min-h-[44px] min-w-[44px] h-11 w-11 rounded-full inline-flex items-center justify-center transition-colors shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 ${
                    activePage === 'portability'
                      ? 'lg-luminous-pill'
                      : 'lg-icon-orb text-[#1F2421] dark:text-[#E5EAE6] hover:bg-black/[0.08] dark:hover:bg-white/[0.12]'
                  }`}
                >
                  <Database size={16} weight="bold" aria-hidden="true" />
                </button>

                <button
                  type="button"
                  data-testid="header-user-pill"
                  onClick={() => setAuthModalOpen(true)}
                  aria-label={`Account: ${dataset.currentUser.fullName} - Sign in or switch account`}
                  title="Sign in or switch active account"
                  className="min-h-[44px] min-w-[44px] h-11 w-11 sm:w-auto sm:pl-1.5 sm:pr-3.5 rounded-full lg-icon-orb inline-flex items-center justify-center gap-2 text-xs hover:bg-black/[0.08] dark:hover:bg-white/[0.12] transition-colors duration-200 shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
                >
                  <span className="h-7 w-7 rounded-full bg-emerald-500/18 dark:bg-emerald-400/20 text-emerald-800 dark:text-emerald-200 ring-1 ring-emerald-600/25 dark:ring-emerald-300/25 font-mono font-bold text-[11px] flex items-center justify-center shrink-0">
                    {dataset.currentUser.avatarInitials}
                  </span>
                  <span className="sr-only sm:not-sr-only sm:inline font-semibold text-[#141715] dark:text-[#F3F5F3] max-w-[112px] truncate">
                    {dataset.currentUser.fullName}
                  </span>
                </button>
              </div>
            </div>
          </header>

          {/* Zone 3: Main Enclosed Spatial Glass Stage */}
          <main
            id="main-workspace"
            className="lg-glass-shell rounded-[26px] sm:rounded-[32px] p-3.5 sm:p-6 lg:p-7 space-y-5 min-w-0"
          >
            <NotSavedPanel />
            <ContextualPageGuideBanner
              pageKey={activePage}
              onOpenFullHelp={() => setHelpModalOpen(true)}
            />
            <div key={activePage} className="lg-stage-reveal min-w-0">
              {activePage === 'home' && <HomeDashboardPage />}
              {activePage === 'groups' && <GroupsLedgerPage />}
              {activePage === 'activity' && <ActivityAndTrashPage />}
              {activePage === 'friends' && <FriendsAndSettlePage />}
              {activePage === 'analytics' && <AnalyticsAndSearchPage />}
              {activePage === 'portability' && <PortabilityAndSyncPage />}
            </div>
          </main>
        </div>
      </div>

      {/* Polite Toast Notification Banner */}
      <div aria-live="polite" className="fixed bottom-36 lg:bottom-6 right-4 z-40 max-w-md">
        {toastMessage && (
          <div
            data-testid="toast-banner"
            className="lg-luminous-pill flex items-center gap-3 rounded-full px-4 py-2.5 text-xs font-semibold"
          >
            <span>{toastMessage}</span>
            <button
              type="button"
              onClick={clearToast}
              aria-label="Dismiss notification"
              className="inline-flex items-center justify-center rounded-full p-1 hover:bg-black/10 dark:hover:bg-black/15 cursor-pointer"
            >
              <X size={14} weight="bold" aria-hidden="true" />
            </button>
          </div>
        )}
      </div>

      {/* Mobile Thumb-Zone Sticky Quick-Split Action Button */}
      {!isAnyModalOpen && (activePage === 'home' || activePage === 'groups') && (
        <div className="lg:hidden fixed bottom-[calc(5.25rem+env(safe-area-inset-bottom))] right-3.5 z-30">
          <button
            type="button"
            data-testid="mobile-fab-split-btn"
            onClick={() =>
              openAddExpenseModal(
                activePage === 'groups' && activeGroup.id ? activeGroup.id : null,
                null
              )
            }
            className="min-h-[48px] min-w-[48px] inline-flex items-center gap-2 rounded-full bg-[#059669] hover:bg-emerald-600 text-white px-4 py-3 text-xs font-bold shadow-[inset_0_1px_0_rgba(255,255,255,0.32),0_14px_30px_-8px_rgba(5,150,105,0.52)] ring-1 ring-white/25 transition-[transform,opacity,background-color,box-shadow] active:scale-[0.98] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
          >
            <Plus size={18} weight="bold" aria-hidden="true" />
            <span>{activePage === 'groups' ? 'Add Group Bill' : 'Split a Bill'}</span>
          </button>
        </div>
      )}

      {/* Global Modular Expense Editor Modal (invokable from Home or Group) */}
      <ExpenseEditorModal
        isOpen={expenseModalState.isOpen}
        onClose={closeAddExpenseModal}
        defaultGroupId={expenseModalState.defaultGroupId}
        initialExpense={expenseModalState.editingExpense}
      />

      {/* Interactive Step-by-Step Help & Feature Guide Modal */}
      <HelpGuideModal
        isOpen={isHelpModalOpen}
        onClose={() => setHelpModalOpen(false)}
        onNavigateTab={(tab) => {
          setActivePage(tab);
          setHelpModalOpen(false);
        }}
      />

      {/* Sign In & Switch Account Modal */}
      <DevAuthModal
        isOpen={isAuthModalOpen}
        onClose={() => setAuthModalOpen(false)}
      />

      {pendingUserSwitch && (
        <div
          data-testid="switch-user-warning"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="switch-user-warning-title"
          className="fixed inset-0 z-50 flex items-center justify-center lg-modal-scrim p-4"
        >
          <div className="w-full max-w-md lg-modal-surface rounded-[28px] p-6 space-y-4 text-[#141715] dark:text-[#F3F5F3]">
            <h2
              id="switch-user-warning-title"
              className="text-base font-bold tracking-tight text-[#141715] dark:text-[#F3F5F3]"
            >
              You have {pendingUserSwitch.unsynced} unsynced{' '}
              {pendingUserSwitch.unsynced === 1 ? 'change' : 'changes'}
            </h2>
            <p className="text-sm text-[#4A524D] dark:text-[#B7BEB9] leading-relaxed">
              Signing in as {pendingUserSwitch.email} clears this device. Sync your changes first so
              they are saved to {dataset.currentUser.fullName}&apos;s account, or discard them and continue.
            </p>
            <div className="flex flex-wrap gap-2.5 pt-1">
              <button
                type="button"
                data-testid="switch-user-sync-first-btn"
                onClick={() => void resolvePendingUserSwitch('sync')}
                className="min-h-[44px] px-4 py-2.5 rounded-full text-xs font-semibold lg-luminous-pill cursor-pointer"
              >
                Sync first
              </button>
              <button
                type="button"
                data-testid="switch-user-discard-btn"
                onClick={() => void resolvePendingUserSwitch('discard')}
                className="min-h-[44px] px-4 py-2.5 rounded-full text-xs font-semibold bg-rose-500/12 text-rose-800 dark:text-rose-200 ring-1 ring-rose-600/25 dark:ring-rose-300/25 hover:bg-rose-500/20 transition-colors cursor-pointer"
              >
                Discard and continue
              </button>
              <button
                type="button"
                data-testid="switch-user-cancel-btn"
                onClick={() => void resolvePendingUserSwitch('cancel')}
                className="min-h-[44px] px-4 py-2.5 rounded-full text-xs font-semibold lg-scene-tile text-[#1F2421] dark:text-[#E5EAE6] cursor-pointer"
              >
                Stay signed in
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingSignOut && (
        <div
          data-testid="sign-out-warning"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="sign-out-warning-title"
          className="fixed inset-0 z-50 flex items-center justify-center lg-modal-scrim p-4"
        >
          <div className="w-full max-w-md lg-modal-surface rounded-[28px] p-6 space-y-4 text-[#141715] dark:text-[#F3F5F3]">
            <h2
              id="sign-out-warning-title"
              className="text-base font-bold tracking-tight text-[#141715] dark:text-[#F3F5F3]"
            >
              You have {pendingSignOut.unsynced} unsynced{' '}
              {pendingSignOut.unsynced === 1 ? 'change' : 'changes'}
            </h2>
            <p className="text-sm text-[#4A524D] dark:text-[#B7BEB9] leading-relaxed">
              Signing out clears this device, and these changes have not reached your account yet. Sync them
              first, or sign out anyway and lose them.
            </p>
            <div className="flex flex-wrap gap-2.5 pt-1">
              <button
                type="button"
                data-testid="sign-out-sync-first-btn"
                onClick={() => void resolvePendingSignOut('sync')}
                className="min-h-[44px] px-4 py-2.5 rounded-full text-xs font-semibold lg-luminous-pill cursor-pointer"
              >
                Sync first
              </button>
              <button
                type="button"
                data-testid="sign-out-discard-btn"
                onClick={() => void resolvePendingSignOut('discard')}
                className="min-h-[44px] px-4 py-2.5 rounded-full text-xs font-semibold bg-rose-500/12 text-rose-800 dark:text-rose-200 ring-1 ring-rose-600/25 dark:ring-rose-300/25 hover:bg-rose-500/20 transition-colors cursor-pointer"
              >
                Sign out anyway
              </button>
              <button
                type="button"
                data-testid="sign-out-cancel-btn"
                onClick={() => void resolvePendingSignOut('cancel')}
                className="min-h-[44px] px-4 py-2.5 rounded-full text-xs font-semibold lg-scene-tile text-[#1F2421] dark:text-[#E5EAE6] cursor-pointer"
              >
                Stay signed in
              </button>
            </div>
          </div>
        </div>
      )}

      <LocalDataImportDialog />

      {/* Mobile Floating Liquid Glass Bottom Dock (<= 5 items, >= 44x44px hit targets) */}
      <nav
        aria-label="Mobile Navigation"
        className="lg:hidden fixed bottom-2 inset-x-2.5 z-30 lg-glass-shell rounded-[24px] px-1.5 pt-1.5 pb-safe-nav"
      >
        <div className="mx-auto max-w-md grid grid-cols-5 gap-1">
          {MOBILE_NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = activePage === item.id;
            return (
              <button
                key={item.id}
                type="button"
                data-testid={`mobile-${item.testId}`}
                onClick={() => setActivePage(item.id)}
                className={`min-h-[48px] min-w-[44px] flex flex-col items-center justify-center rounded-[16px] py-1 px-1 text-[10.5px] font-semibold transition-[transform,opacity,background-color,color,box-shadow] duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 ${
                  isActive
                    ? 'lg-luminous-pill'
                    : 'text-[#4A524D] dark:text-[#B7BEB9] hover:text-[#141715] dark:hover:text-white'
                }`}
              >
                <Icon size={18} weight={isActive ? 'bold' : 'regular'} aria-hidden="true" />
                <span className="mt-0.5 truncate max-w-full">{item.shortLabel}</span>
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** New groups, bills and payments the server refused: kept on this device until the user fixes, retries or removes them. */
function NotSavedPanel() {
  const { dataset, retryRejected, discardRejected, openAddExpenseModal } = useLedger();
  const rows = [
    ...dataset.groups
      .filter((g) => g.syncRejection && !g.deletedAt)
      .map((g) => ({
        entity: 'group' as const,
        id: g.id,
        label: `Group "${g.name}"`,
        reason: g.syncRejection!,
        bill: null,
      })),
    ...dataset.expenses
      .filter((e) => e.syncRejection && !e.deletedAt)
      .map((e) => ({
        entity: 'expense' as const,
        id: e.id,
        label: `Bill "${e.title}"`,
        reason: e.syncRejection!,
        bill: e,
      })),
    ...dataset.settlements
      .filter((x) => x.syncRejection && !x.deletedAt)
      .map((x) => ({
        entity: 'settlement' as const,
        id: x.id,
        label: `Payment of ${formatMinorToMajor(x.amountMinor, x.currency)}`,
        reason: x.syncRejection!,
        bill: null,
      })),
  ];
  if (rows.length === 0) return null;
  const btn = 'min-h-[44px] px-3.5 py-2 rounded-full text-xs font-semibold cursor-pointer transition-colors';
  return (
    <section
      data-testid="not-saved-panel"
      aria-label="Not saved to your account"
      className="rounded-[22px] border border-amber-600/30 dark:border-amber-300/25 bg-amber-500/[0.09] dark:bg-amber-400/[0.08] p-4 space-y-3"
    >
      <h2 className="text-sm font-bold text-amber-900 dark:text-amber-200">
        {rows.length === 1
          ? 'One item is only on this device'
          : `${rows.length} items are only on this device`}
      </h2>
      <ul className="space-y-2">
        {rows.map((r) => (
          <li
            key={`${r.entity}:${r.id}`}
            data-testid={`not-saved-${r.entity}-${r.id}`}
            className="lg-recessed-well flex flex-wrap items-center justify-between gap-2.5 rounded-[16px] px-3.5 py-2.5"
          >
            <div className="min-w-0 text-xs">
              <div className="font-semibold text-[#141715] dark:text-[#F3F5F3] truncate">
                {r.label}
              </div>
              <div className="text-amber-800 dark:text-amber-300">
                Could not save to your account: {r.reason}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {r.bill && (
                <button
                  type="button"
                  data-testid={`not-saved-edit-${r.id}`}
                  onClick={() => openAddExpenseModal(r.bill!.groupId, r.bill)}
                  className={`${btn} lg-scene-tile text-[#1F2421] dark:text-[#E5EAE6]`}
                >
                  Edit
                </button>
              )}
              <button
                type="button"
                data-testid={`not-saved-retry-${r.id}`}
                onClick={() => retryRejected(r.entity, r.id)}
                className={`${btn} lg-luminous-pill`}
              >
                Try again
              </button>
              <button
                type="button"
                data-testid={`not-saved-remove-${r.id}`}
                onClick={() => discardRejected(r.entity, r.id)}
                className={`${btn} text-rose-800 dark:text-rose-200 hover:bg-rose-500/12`}
              >
                Remove from this device
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Shown when someone signs in on a device that holds data they made while signed out. */
function LocalDataImportDialog() {
  const { pendingLocalImport: pending, resolvePendingLocalImport, downloadLocalBackup } = useLedger();
  const [step, setStep] = useState<'choose' | 'fresh'>('choose');
  const [busy, setBusy] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [backupNote, setBackupNote] = useState<string | null>(null);
  if (!pending) return null;
  const downloadBackup = async () => {
    const problem = backupPassphraseProblem(passphrase, confirmation);
    if (problem) {
      setBackupNote(problem);
      return;
    }
    setBusy(true);
    try {
      await downloadLocalBackup(passphrase);
      setBackupNote('Backup saved. Keep the passphrase safe: you need it to restore this file.');
    } catch {
      setBackupNote('The backup could not be created on this device. Nothing was removed.');
    } finally {
      setBusy(false);
    }
  };
  const counts = [
    pending.groups > 0 ? plural(pending.groups, 'group', 'groups') : null,
    pending.bills > 0 ? plural(pending.bills, 'bill', 'bills') : null,
    pending.payments > 0 ? plural(pending.payments, 'payment', 'payments') : null,
  ].filter(Boolean);
  const inSamples = [
    pending.sampleBills > 0 ? plural(pending.sampleBills, 'bill', 'bills') : null,
    pending.samplePayments > 0 ? plural(pending.samplePayments, 'payment', 'payments') : null,
  ].filter(Boolean);
  const leftBehind =
    inSamples.length > 0
      ? ` ${inSamples.join(' and ')} you added inside the sample groups cannot be copied to an account.`
      : '';
  const finish = async (choice: 'import' | 'fresh' | 'later') => {
    setBusy(true);
    try {
      await resolvePendingLocalImport(choice);
    } finally {
      setBusy(false);
      setStep('choose');
      setPassphrase('');
      setConfirmation('');
      setBackupNote(null);
    }
  };
  const buttonBase =
    'min-h-[44px] px-4 py-2.5 rounded-full text-xs font-semibold cursor-pointer disabled:opacity-60 transition-colors';
  return (
    <div
      data-testid="local-data-import-dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="local-data-import-title"
      className="fixed inset-0 z-50 flex items-center justify-center lg-modal-scrim p-4"
    >
      <div className="w-full max-w-md lg-modal-surface rounded-[28px] p-6 space-y-4 text-[#141715] dark:text-[#F3F5F3]">
        {step === 'choose' ? (
          <>
            <h2
              id="local-data-import-title"
              className="text-base font-bold tracking-tight text-[#141715] dark:text-[#F3F5F3]"
            >
              You have data on this device
            </h2>
            <p className="text-sm text-[#4A524D] dark:text-[#B7BEB9] leading-relaxed">
              {counts.length > 0
                ? `Before you signed in you added ${counts.join(', ')}.`
                : 'Before you signed in you changed the sample groups.'}
              {leftBehind}{' '}
              {!pending.canImport
                ? `${pending.email} is the shared demo account, so data from this device is never copied into it.`
                : counts.length > 0
                  ? `You can keep your data in ${pending.email}, or start with an empty account. The sample groups are never copied.`
                  : `Start fresh to sign in as ${pending.email}, or stay signed out to keep them on this device.`}
            </p>
            <div className="flex flex-col gap-2.5 pt-1">
              {pending.canImport && counts.length > 0 && (
                <button
                  type="button"
                  autoFocus
                  disabled={busy}
                  data-testid="local-data-import-btn"
                  onClick={() => void finish('import')}
                  className={`${buttonBase} lg-luminous-pill`}
                >
                  Bring my local data into this account
                </button>
              )}
              <button
                type="button"
                autoFocus={!(pending.canImport && counts.length > 0)}
                disabled={busy}
                data-testid="local-data-fresh-btn"
                onClick={() => setStep('fresh')}
                className={`${buttonBase} lg-scene-tile text-[#1F2421] dark:text-[#E5EAE6]`}
              >
                Start fresh
              </button>
              <button
                type="button"
                disabled={busy}
                data-testid="local-data-later-btn"
                onClick={() => void finish('later')}
                className={`${buttonBase} text-[#4A524D] dark:text-[#B7BEB9] hover:bg-black/[0.045] dark:hover:bg-white/[0.06]`}
              >
                Not now, stay signed out
              </button>
            </div>
          </>
        ) : (
          <>
            <h2
              id="local-data-import-title"
              className="text-base font-bold tracking-tight text-[#141715] dark:text-[#F3F5F3]"
            >
              Start fresh and remove this data?
            </h2>
            <p className="text-sm text-[#4A524D] dark:text-[#B7BEB9] leading-relaxed">
              Starting fresh removes {counts.length > 0 ? counts.join(', ') : 'your changes'} from this device. If you might want them later, download
              a backup first. It is protected with a passphrase you choose, and you can restore it from Portability
              and Sync.
            </p>
            <div className="grid gap-2.5">
              <input
                type="password"
                autoComplete="new-password"
                data-testid="local-data-passphrase-input"
                aria-label="Backup passphrase"
                placeholder="Backup passphrase"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                className="lg-recessed-well min-h-[44px] rounded-[14px] px-3.5 text-sm text-[#141715] dark:text-[#F3F5F3] placeholder:text-[#68726C] dark:placeholder:text-[#8A938D] focus:outline-none focus:ring-2 focus:ring-emerald-500/60"
              />
              <input
                type="password"
                autoComplete="new-password"
                data-testid="local-data-passphrase-confirm-input"
                aria-label="Type the passphrase again"
                placeholder="Type the passphrase again"
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
                className="lg-recessed-well min-h-[44px] rounded-[14px] px-3.5 text-sm text-[#141715] dark:text-[#F3F5F3] placeholder:text-[#68726C] dark:placeholder:text-[#8A938D] focus:outline-none focus:ring-2 focus:ring-emerald-500/60"
              />
              {backupNote && (
                <p
                  role="status"
                  data-testid="local-data-backup-note"
                  className="text-xs text-[#4A524D] dark:text-[#B7BEB9]"
                >
                  {backupNote}
                </p>
              )}
            </div>
            <div className="flex flex-wrap gap-2.5 pt-1">
              <button
                type="button"
                disabled={busy}
                data-testid="local-data-backup-btn"
                onClick={() => void downloadBackup()}
                className={`${buttonBase} lg-luminous-pill`}
              >
                Download encrypted backup
              </button>
              <button
                type="button"
                disabled={busy}
                data-testid="local-data-wipe-btn"
                onClick={() => void finish('fresh')}
                className={`${buttonBase} bg-rose-500/12 text-rose-800 dark:text-rose-200 ring-1 ring-rose-600/25 dark:ring-rose-300/25 hover:bg-rose-500/20`}
              >
                Remove and continue
              </button>
              <button
                type="button"
                disabled={busy}
                data-testid="local-data-back-btn"
                onClick={() => setStep('choose')}
                className={`${buttonBase} lg-scene-tile text-[#1F2421] dark:text-[#E5EAE6]`}
              >
                Back
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
