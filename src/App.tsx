import React, { useEffect, useState } from 'react';
import {
  ArrowsLeftRightIcon as ArrowsLeftRight,
  ChartPolarIcon as ChartPolar,
  ClockCounterClockwiseIcon as ClockCounterClockwise,
  CloudArrowUpIcon as CloudArrowUp,
  CloudSlashIcon as CloudSlash,
  DatabaseIcon as Database,
  HouseIcon as House,
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
  testId: string;
  icon: React.ComponentType<{ size?: number; weight?: 'regular' | 'bold' | 'duotone' | 'fill' }>;
}> = [
  {
    id: 'home',
    label: 'Home',
    shortLabel: 'Home',
    testId: 'nav-tab-home',
    icon: House,
  },
  {
    id: 'groups',
    label: 'Groups & Ledger',
    shortLabel: 'Groups',
    testId: 'nav-tab-groups',
    icon: Receipt,
  },
  {
    id: 'activity',
    label: 'Activity & History',
    shortLabel: 'History',
    testId: 'nav-tab-activity',
    icon: ClockCounterClockwise,
  },
  {
    id: 'friends',
    label: 'Friends & Settle',
    shortLabel: 'Settle',
    testId: 'nav-tab-friends',
    icon: ArrowsLeftRight,
  },
  {
    id: 'analytics',
    label: 'Insights & Search',
    shortLabel: 'Insights',
    testId: 'nav-tab-analytics',
    icon: ChartPolar,
  },
  {
    id: 'portability',
    label: 'Portability & Sync',
    shortLabel: 'Sync/Export',
    testId: 'nav-tab-portability',
    icon: Database,
  },
];

const MOBILE_NAV_ITEMS = NAV_ITEMS.slice(0, 5);

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

  const isAnyModalOpen =
    expenseModalState.isOpen || isHelpModalOpen || isAuthModalOpen;

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

  return (
    <div className="min-h-[100dvh] bg-[#F8FAFC] dark:bg-[#090D16] text-slate-900 dark:text-slate-100 pb-[calc(9rem+env(safe-area-inset-bottom))] lg:pb-16 transition-colors duration-300">
      {/* Subtle fixed ambient background glow */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 overflow-hidden z-0"
      >
        <div className="absolute -top-40 left-1/4 h-96 w-96 rounded-full bg-emerald-500/[0.06] dark:bg-emerald-500/[0.08] blur-3xl" />
        <div className="absolute top-1/3 right-10 h-80 w-80 rounded-full bg-sky-500/[0.05] dark:bg-sky-500/[0.06] blur-3xl" />
      </div>

      {/* Floating Island Top Navigation Bar (<= 80px height, Android/iOS safe-area aware) */}
      <header className="sticky top-0 z-30 px-3 pt-[max(0.75rem,env(safe-area-inset-top))] sm:px-6">
        <div className="mx-auto max-w-[1400px] h-16 rounded-full px-3.5 sm:px-6 bg-white/85 dark:bg-[#111827]/85 backdrop-blur-xl ring-1 ring-slate-900/[0.08] dark:ring-white/[0.1] shadow-[0_8px_30px_rgb(0,0,0,0.06)] flex items-center justify-between gap-2 sm:gap-3">
          {/* Brand Identity */}
          <div className="flex items-center gap-2.5 sm:gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setActivePage('home')}
              aria-label="Go to Wise-Spliter Home"
              className="h-11 w-11 rounded-full bg-emerald-600 text-white flex items-center justify-center shadow-sm shrink-0 cursor-pointer hover:bg-emerald-500 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
            >
              <UsersThree size={20} weight="bold" aria-hidden="true" />
            </button>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-bold tracking-tight text-base sm:text-lg text-slate-900 dark:text-white truncate">
                  Wise-Spliter
                </span>
                <span className="hidden xl:inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-mono font-semibold text-emerald-700 dark:text-emerald-300 ring-1 ring-emerald-500/25">
                  <ShieldCheck size={13} weight="bold" aria-hidden="true" />
                  100% Free
                </span>
              </div>
              <button
                type="button"
                onClick={() => setActivePage('groups')}
                className="hidden sm:block text-[11px] text-slate-500 dark:text-slate-400 hover:text-emerald-600 dark:hover:text-emerald-400 truncate cursor-pointer text-left transition-colors"
              >
                Group: <span className="font-semibold text-slate-700 dark:text-slate-200">{activeGroup.name}</span> ({activeGroup.baseCurrency})
              </button>
            </div>
          </div>

          {/* Single-Line Desktop Navigation Pills */}
          <nav
            aria-label="Primary Navigation"
            className="hidden lg:flex items-center gap-1 rounded-full bg-slate-100/90 dark:bg-slate-900/90 p-1 ring-1 ring-slate-200/80 dark:ring-white/[0.07]"
          >
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const isActive = activePage === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  data-testid={item.testId}
                  onClick={() => setActivePage(item.id)}
                  className={`relative inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
                    isActive
                      ? 'bg-emerald-600 text-white shadow-sm'
                      : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                  }`}
                >
                  <Icon size={15} weight={isActive ? 'bold' : 'regular'} aria-hidden="true" />
                  <span>{item.label}</span>
                  {item.id === 'activity' && unresolvedConflictCount > 0 && (
                    <span className="ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-mono font-bold text-slate-950">
                      {unresolvedConflictCount}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>

          {/* Right Status Controls: Sync Confidence, Account, Backup (mobile), Help & Theme */}
          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            <button
              type="button"
              data-testid="header-offline-toggle"
              onClick={toggleOfflineMode}
              title={
                isOnline
                  ? 'All bills backed up to cloud - click to test Airplane / Offline Mode'
                  : 'Working 100% offline on this device - click to reconnect and sync'
              }
              className={`min-h-[44px] inline-flex items-center gap-1.5 rounded-full px-2.5 sm:px-3 py-1.5 text-xs font-semibold transition-colors duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
                isOnline
                  ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 ring-1 ring-emerald-500/30 hover:bg-emerald-500/15'
                  : 'bg-amber-500/15 text-amber-800 dark:text-amber-300 ring-1 ring-amber-500/40 hover:bg-amber-500/25'
              }`}
            >
              {isOnline ? (
                <>
                  <CloudArrowUp size={15} weight="bold" aria-hidden="true" />
                  <span className="hidden md:inline">Cloud Synced</span>
                  <span className="md:hidden">Online</span>
                </>
              ) : (
                <>
                  <CloudSlash size={15} weight="bold" aria-hidden="true" />
                  <span>Offline ({pendingOutboxCount})</span>
                </>
              )}
            </button>

            <button
              type="button"
              data-testid="header-user-pill"
              onClick={() => setAuthModalOpen(true)}
              aria-label={`Account: ${dataset.currentUser.fullName} - Sign in or switch account`}
              title="Sign in or switch active account"
              className="min-h-[44px] min-w-[44px] flex items-center gap-2 rounded-full bg-slate-100 dark:bg-slate-800/80 p-1 sm:pl-1.5 sm:pr-3 text-xs ring-1 ring-slate-200 dark:ring-white/10 hover:bg-slate-200/70 dark:hover:bg-slate-700 transition-colors duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
            >
              <span className="h-7 w-7 sm:h-6 sm:w-6 rounded-full bg-emerald-600/20 text-emerald-700 dark:text-emerald-300 font-mono font-bold text-[11px] flex items-center justify-center">
                {dataset.currentUser.avatarInitials}
              </span>
              <span className="hidden sm:inline font-medium text-slate-700 dark:text-slate-200 max-w-[110px] truncate">
                {dataset.currentUser.fullName}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setActivePage('portability')}
              aria-label="Open Backup, Sync and Export"
              title="Backup, Sync & Splitwise Import"
              className={`lg:hidden h-11 w-11 rounded-full flex items-center justify-center ring-1 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
                activePage === 'portability'
                  ? 'bg-emerald-600 text-white ring-emerald-600'
                  : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 ring-slate-200 dark:ring-white/10 hover:bg-slate-200/70 dark:hover:bg-slate-700'
              }`}
            >
              <Database size={16} weight="bold" aria-hidden="true" />
            </button>

            <button
              type="button"
              data-testid="header-help-btn"
              onClick={() => setHelpModalOpen(true)}
              aria-label="Open interactive Help and Step-by-Step Guide"
              className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center gap-1.5 rounded-full bg-slate-100 dark:bg-slate-800 px-2.5 sm:px-3 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 ring-1 ring-slate-200 dark:ring-white/10 hover:bg-slate-200/70 dark:hover:bg-slate-700 transition-colors duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
            >
              <Question size={16} weight="bold" aria-hidden="true" />
              <span className="hidden sm:inline">Help</span>
            </button>

            <button
              type="button"
              data-testid="theme-toggle-btn"
              onClick={toggleTheme}
              aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              className="h-11 w-11 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 flex items-center justify-center ring-1 ring-slate-200 dark:ring-white/10 hover:bg-slate-200/70 dark:hover:bg-slate-700 transition-colors duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
            >
              {theme === 'dark' ? (
                <Sun size={18} weight="bold" aria-hidden="true" />
              ) : (
                <Moon size={18} weight="bold" aria-hidden="true" />
              )}
            </button>
          </div>
        </div>
      </header>

      {/* Polite Toast Notification Banner */}
      <div aria-live="polite" className="fixed bottom-32 lg:bottom-6 right-4 z-40 max-w-md">
        {toastMessage && (
          <div
            data-testid="toast-banner"
            className="flex items-center gap-3 rounded-full bg-slate-900 dark:bg-emerald-950 text-white px-4 py-2.5 text-xs font-medium shadow-lg ring-1 ring-white/15"
          >
            <span>{toastMessage}</span>
            <button
              type="button"
              onClick={clearToast}
              aria-label="Dismiss notification"
              className="rounded-full p-1 hover:bg-white/10 cursor-pointer"
            >
              <X size={14} weight="bold" aria-hidden="true" />
            </button>
          </div>
        )}
      </div>

      {/* Main Content Workspace */}
      <main id="main-workspace" className="relative mx-auto max-w-[1400px] px-4 sm:px-6 pt-5 space-y-5">
        <NotSavedPanel />
        <ContextualPageGuideBanner
          pageKey={activePage}
          onOpenFullHelp={() => setHelpModalOpen(true)}
        />
        {activePage === 'home' && <HomeDashboardPage />}
        {activePage === 'groups' && <GroupsLedgerPage />}
        {activePage === 'activity' && <ActivityAndTrashPage />}
        {activePage === 'friends' && <FriendsAndSettlePage />}
        {activePage === 'analytics' && <AnalyticsAndSearchPage />}
        {activePage === 'portability' && <PortabilityAndSyncPage />}
      </main>

      {/* Mobile Thumb-Zone Sticky Quick-Split Action Button */}
      {!isAnyModalOpen && (activePage === 'home' || activePage === 'groups') && (
        <div className="lg:hidden fixed bottom-[calc(4.75rem+env(safe-area-inset-bottom))] right-4 z-30">
          <button
            type="button"
            data-testid="mobile-fab-split-btn"
            onClick={() =>
              openAddExpenseModal(activePage === 'groups' && activeGroup.id ? activeGroup.id : null, null)
            }
            className="min-h-[48px] inline-flex items-center gap-2 rounded-full bg-[#059669] hover:bg-emerald-600 text-white px-4 py-3 text-xs font-bold shadow-lg shadow-emerald-900/30 ring-1 ring-white/20 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
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
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4"
        >
          <div className="w-full max-w-md rounded-3xl bg-white dark:bg-[#0F172A] ring-1 ring-slate-200 dark:ring-white/10 shadow-2xl p-6 space-y-4">
            <h2 id="switch-user-warning-title" className="text-base font-bold text-slate-900 dark:text-white">
              You have {pendingUserSwitch.unsynced} unsynced{' '}
              {pendingUserSwitch.unsynced === 1 ? 'change' : 'changes'}
            </h2>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              Signing in as {pendingUserSwitch.email} clears this device. Sync your changes first so
              they are saved to {dataset.currentUser.fullName}&apos;s account, or discard them and continue.
            </p>
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                data-testid="switch-user-sync-first-btn"
                onClick={() => void resolvePendingUserSwitch('sync')}
                className="min-h-[44px] px-4 py-2.5 rounded-xl text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white cursor-pointer"
              >
                Sync first
              </button>
              <button
                type="button"
                data-testid="switch-user-discard-btn"
                onClick={() => void resolvePendingUserSwitch('discard')}
                className="min-h-[44px] px-4 py-2.5 rounded-xl text-xs font-semibold bg-rose-500/10 text-rose-700 dark:text-rose-300 ring-1 ring-rose-500/25 hover:bg-rose-500/20 cursor-pointer"
              >
                Discard and continue
              </button>
              <button
                type="button"
                data-testid="switch-user-cancel-btn"
                onClick={() => void resolvePendingUserSwitch('cancel')}
                className="min-h-[44px] px-4 py-2.5 rounded-xl text-xs font-semibold bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 cursor-pointer"
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
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4"
        >
          <div className="w-full max-w-md rounded-3xl bg-white dark:bg-[#0F172A] ring-1 ring-slate-200 dark:ring-white/10 shadow-2xl p-6 space-y-4">
            <h2 id="sign-out-warning-title" className="text-base font-bold text-slate-900 dark:text-white">
              You have {pendingSignOut.unsynced} unsynced {pendingSignOut.unsynced === 1 ? 'change' : 'changes'}
            </h2>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              Signing out clears this device, and these changes have not reached your account yet. Sync them
              first, or sign out anyway and lose them.
            </p>
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                data-testid="sign-out-sync-first-btn"
                onClick={() => void resolvePendingSignOut('sync')}
                className="min-h-[44px] px-4 py-2.5 rounded-xl text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white cursor-pointer"
              >
                Sync first
              </button>
              <button
                type="button"
                data-testid="sign-out-discard-btn"
                onClick={() => void resolvePendingSignOut('discard')}
                className="min-h-[44px] px-4 py-2.5 rounded-xl text-xs font-semibold bg-rose-500/10 text-rose-700 dark:text-rose-300 ring-1 ring-rose-500/25 hover:bg-rose-500/20 cursor-pointer"
              >
                Sign out anyway
              </button>
              <button
                type="button"
                data-testid="sign-out-cancel-btn"
                onClick={() => void resolvePendingSignOut('cancel')}
                className="min-h-[44px] px-4 py-2.5 rounded-xl text-xs font-semibold bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 cursor-pointer"
              >
                Stay signed in
              </button>
            </div>
          </div>
        </div>
      )}

      <LocalDataImportDialog />

      {/* Mobile Bottom Navigation Bar (<= 5 items, >= 44x44px hit targets) */}
      <nav
        aria-label="Mobile Navigation"
        className="lg:hidden fixed bottom-0 inset-x-0 z-30 bg-white/95 dark:bg-[#111827]/95 backdrop-blur-xl border-t border-slate-200 dark:border-white/10 px-2 pt-1.5 pb-safe-nav"
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
                className={`min-h-[48px] flex flex-col items-center justify-center rounded-xl py-1 text-[11px] font-semibold transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
                  isActive
                    ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                <Icon size={18} weight={isActive ? 'bold' : 'regular'} aria-hidden="true" />
                <span className="mt-0.5 truncate">{item.shortLabel}</span>
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
    ...dataset.groups.filter((g) => g.syncRejection && !g.deletedAt).map((g) => ({ entity: 'group' as const, id: g.id, label: `Group "${g.name}"`, reason: g.syncRejection!, bill: null })),
    ...dataset.expenses.filter((e) => e.syncRejection && !e.deletedAt).map((e) => ({ entity: 'expense' as const, id: e.id, label: `Bill "${e.title}"`, reason: e.syncRejection!, bill: e })),
    ...dataset.settlements.filter((x) => x.syncRejection && !x.deletedAt).map((x) => ({ entity: 'settlement' as const, id: x.id, label: `Payment of ${formatMinorToMajor(x.amountMinor, x.currency)}`, reason: x.syncRejection!, bill: null })),
  ];
  if (rows.length === 0) return null;
  const btn = 'min-h-[44px] px-3 py-2 rounded-xl text-xs font-semibold cursor-pointer';
  return (
    <section data-testid="not-saved-panel" aria-label="Not saved to your account" className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 space-y-3">
      <h2 className="text-sm font-bold text-amber-900 dark:text-amber-200">
        {rows.length === 1 ? 'One item is only on this device' : `${rows.length} items are only on this device`}
      </h2>
      <ul className="space-y-2">
        {rows.map((r) => (
          <li key={`${r.entity}:${r.id}`} data-testid={`not-saved-${r.entity}-${r.id}`} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-white/70 dark:bg-slate-900/60 px-3 py-2">
            <div className="min-w-0 text-xs">
              <div className="font-semibold text-slate-900 dark:text-slate-100 truncate">{r.label}</div>
              <div className="text-amber-800 dark:text-amber-300">Could not save to your account: {r.reason}</div>
            </div>
            <div className="flex flex-wrap gap-2">
              {r.bill && (
                <button type="button" data-testid={`not-saved-edit-${r.id}`} onClick={() => openAddExpenseModal(r.bill!.groupId, r.bill)} className={`${btn} bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200`}>
                  Edit
                </button>
              )}
              <button type="button" data-testid={`not-saved-retry-${r.id}`} onClick={() => retryRejected(r.entity, r.id)} className={`${btn} bg-emerald-600 hover:bg-emerald-500 text-white`}>
                Try again
              </button>
              <button type="button" data-testid={`not-saved-remove-${r.id}`} onClick={() => discardRejected(r.entity, r.id)} className={`${btn} text-rose-700 dark:text-rose-300 hover:bg-rose-500/10`}>
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
    inSamples.length > 0 ? ` ${inSamples.join(' and ')} you added inside the sample groups cannot be copied to an account.` : '';
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
  const buttonBase = 'min-h-[44px] px-4 py-2.5 rounded-xl text-xs font-semibold cursor-pointer disabled:opacity-60';
  return (
    <div
      data-testid="local-data-import-dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="local-data-import-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4"
    >
      <div className="w-full max-w-md rounded-3xl bg-white dark:bg-[#0F172A] ring-1 ring-slate-200 dark:ring-white/10 shadow-2xl p-6 space-y-4">
        {step === 'choose' ? (
          <>
            <h2 id="local-data-import-title" className="text-base font-bold text-slate-900 dark:text-white">
              You have data on this device
            </h2>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              {counts.length > 0 ? `Before you signed in you added ${counts.join(', ')}.` : 'Before you signed in you changed the sample groups.'}
              {leftBehind}{' '}
              {!pending.canImport
                ? `${pending.email} is the shared demo account, so data from this device is never copied into it.`
                : counts.length > 0
                  ? `You can keep your data in ${pending.email}, or start with an empty account. The sample groups are never copied.`
                  : `Start fresh to sign in as ${pending.email}, or stay signed out to keep them on this device.`}
            </p>
            <div className="flex flex-col gap-3">
              {pending.canImport && counts.length > 0 && (
                <button
                  type="button"
                  autoFocus
                  disabled={busy}
                  data-testid="local-data-import-btn"
                  onClick={() => void finish('import')}
                  className={`${buttonBase} bg-emerald-600 hover:bg-emerald-500 text-white`}
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
                className={`${buttonBase} bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300`}
              >
                Start fresh
              </button>
              <button
                type="button"
                disabled={busy}
                data-testid="local-data-later-btn"
                onClick={() => void finish('later')}
                className={`${buttonBase} text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800`}
              >
                Not now, stay signed out
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 id="local-data-import-title" className="text-base font-bold text-slate-900 dark:text-white">
              Start fresh and remove this data?
            </h2>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              Starting fresh removes {counts.length > 0 ? counts.join(', ') : 'your changes'} from this device. If you might want them later, download
              a backup first. It is protected with a passphrase you choose, and you can restore it from Portability
              and Sync.
            </p>
            <div className="grid gap-2">
              <input
                type="password"
                autoComplete="new-password"
                data-testid="local-data-passphrase-input"
                aria-label="Backup passphrase"
                placeholder="Backup passphrase"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                className="min-h-[44px] rounded-xl border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-900 px-3 text-sm text-slate-900 dark:text-slate-100"
              />
              <input
                type="password"
                autoComplete="new-password"
                data-testid="local-data-passphrase-confirm-input"
                aria-label="Type the passphrase again"
                placeholder="Type the passphrase again"
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
                className="min-h-[44px] rounded-xl border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-900 px-3 text-sm text-slate-900 dark:text-slate-100"
              />
              {backupNote && (
                <p role="status" data-testid="local-data-backup-note" className="text-xs text-slate-600 dark:text-slate-300">
                  {backupNote}
                </p>
              )}
            </div>
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                disabled={busy}
                data-testid="local-data-backup-btn"
                onClick={() => void downloadBackup()}
                className={`${buttonBase} bg-emerald-600 hover:bg-emerald-500 text-white`}
              >
                Download encrypted backup
              </button>
              <button
                type="button"
                disabled={busy}
                data-testid="local-data-wipe-btn"
                onClick={() => void finish('fresh')}
                className={`${buttonBase} bg-rose-500/10 text-rose-700 dark:text-rose-300 ring-1 ring-rose-500/25 hover:bg-rose-500/20`}
              >
                Remove and continue
              </button>
              <button
                type="button"
                disabled={busy}
                data-testid="local-data-back-btn"
                onClick={() => setStep('choose')}
                className={`${buttonBase} bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300`}
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
