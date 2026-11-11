import React from 'react';
import {
  ArrowsLeftRightIcon as ArrowsLeftRight,
  ChartPolarIcon as ChartPolar,
  ClockCounterClockwiseIcon as ClockCounterClockwise,
  CloudArrowUpIcon as CloudArrowUp,
  CloudSlashIcon as CloudSlash,
  DatabaseIcon as Database,
  HouseIcon as House,
  MoonIcon as Moon,
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
    closeAddExpenseModal,
    isHelpModalOpen,
    setHelpModalOpen,
  } = useLedger();

  const unresolvedConflictCount = dataset.expenses.filter(
    (e) => !e.deletedAt && e.hasUnresolvedConflict
  ).length;

  return (
    <div className="min-h-[100dvh] bg-[#F8FAFC] dark:bg-[#090D16] text-slate-900 dark:text-slate-100 pb-24 lg:pb-16 transition-colors duration-300">
      {/* Subtle fixed ambient background glow */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 overflow-hidden z-0"
      >
        <div className="absolute -top-40 left-1/4 h-96 w-96 rounded-full bg-emerald-500/[0.06] dark:bg-emerald-500/[0.08] blur-3xl" />
        <div className="absolute top-1/3 right-10 h-80 w-80 rounded-full bg-sky-500/[0.05] dark:bg-sky-500/[0.06] blur-3xl" />
      </div>

      {/* Floating Island Top Navigation Bar (<= 80px height) */}
      <header className="sticky top-0 z-30 px-3 pt-3 sm:px-6">
        <div className="mx-auto max-w-[1400px] h-16 rounded-full px-4 sm:px-6 bg-white/85 dark:bg-[#111827]/85 backdrop-blur-xl ring-1 ring-slate-900/[0.08] dark:ring-white/[0.1] shadow-[0_8px_30px_rgb(0,0,0,0.06)] flex items-center justify-between gap-3">
          {/* Brand Identity */}
          <div className="flex items-center gap-3 min-w-0">
            <div className="h-9 w-9 rounded-full bg-emerald-600 text-white flex items-center justify-center shadow-sm shrink-0">
              <UsersThree size={20} weight="bold" aria-hidden="true" />
            </div>
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
              <p className="hidden sm:block text-[11px] text-slate-500 dark:text-slate-400 truncate">
                Active Group: <span className="font-semibold text-slate-700 dark:text-slate-200">{activeGroup.name}</span> ({activeGroup.baseCurrency})
              </p>
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
                  className={`relative inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs font-semibold transition-transform duration-200 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
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

          {/* Right Status Controls: Offline Toggle, Google Account & Theme Toggle */}
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              data-testid="header-offline-toggle"
              onClick={toggleOfflineMode}
              title={
                isOnline
                  ? 'Connected to Supabase wise_spliter schema - click to simulate Offline Flight Mode'
                  : 'Offline Mode active (saving to local IndexedDB) - click to reconnect'
              }
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition-transform duration-200 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
                isOnline
                  ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 ring-1 ring-emerald-500/30'
                  : 'bg-amber-500/15 text-amber-800 dark:text-amber-300 ring-1 ring-amber-500/40'
              }`}
            >
              {isOnline ? (
                <>
                  <CloudArrowUp size={15} weight="bold" aria-hidden="true" />
                  <span className="hidden md:inline">Synced (wise_spliter)</span>
                  <span className="md:hidden">Online</span>
                </>
              ) : (
                <>
                  <CloudSlash size={15} weight="bold" aria-hidden="true" />
                  <span>Offline ({pendingOutboxCount} queued)</span>
                </>
              )}
            </button>

            <div
              data-testid="header-user-pill"
              className="hidden sm:flex items-center gap-2 rounded-full bg-slate-100 dark:bg-slate-800/80 pl-1.5 pr-3 py-1 text-xs ring-1 ring-slate-200 dark:ring-white/10"
            >
              <span className="h-6 w-6 rounded-full bg-emerald-600/20 text-emerald-700 dark:text-emerald-300 font-mono font-bold text-[11px] flex items-center justify-center">
                {dataset.currentUser.avatarInitials}
              </span>
              <span className="font-medium text-slate-700 dark:text-slate-200 max-w-[110px] truncate">
                {dataset.currentUser.fullName}
              </span>
            </div>

            <button
              type="button"
              data-testid="header-help-btn"
              onClick={() => setHelpModalOpen(true)}
              aria-label="Open interactive Help and Step-by-Step Guide"
              className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 dark:bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 ring-1 ring-slate-200 dark:ring-white/10 hover:bg-slate-200/70 dark:hover:bg-slate-700 transition-transform duration-200 active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
            >
              <Question size={16} weight="bold" aria-hidden="true" />
              <span className="hidden sm:inline">Help</span>
            </button>

            <button
              type="button"
              data-testid="theme-toggle-btn"
              onClick={toggleTheme}
              aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              className="h-9 w-9 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 flex items-center justify-center ring-1 ring-slate-200 dark:ring-white/10 hover:bg-slate-200/70 dark:hover:bg-slate-700 transition-transform duration-200 active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
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
      <div aria-live="polite" className="fixed bottom-20 lg:bottom-6 right-4 z-40 max-w-md">
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
              className="rounded-full p-1 hover:bg-white/10"
            >
              <X size={14} weight="bold" aria-hidden="true" />
            </button>
          </div>
        )}
      </div>

      {/* Main Content Workspace */}
      <main id="main-workspace" className="relative mx-auto max-w-[1400px] px-4 sm:px-6 pt-6 space-y-5">
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

      {/* Mobile Bottom Navigation Bar (<= 5 items, >= 44x44px hit targets) */}
      <nav
        aria-label="Mobile Navigation"
        className="lg:hidden fixed bottom-0 inset-x-0 z-30 bg-white/95 dark:bg-[#111827]/95 backdrop-blur-xl border-t border-slate-200 dark:border-white/10 px-2 py-1.5"
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
                className={`min-h-[44px] flex flex-col items-center justify-center rounded-xl py-1 text-[11px] font-semibold transition-colors ${
                  isActive
                    ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
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
