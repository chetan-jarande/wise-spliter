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

  return (
    <div className="min-h-[100dvh] bg-[#F8FAFC] dark:bg-[#090D16] text-slate-900 dark:text-slate-100 pb-28 lg:pb-16 transition-colors duration-300">
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
        <div className="mx-auto max-w-[1400px] h-16 rounded-full px-3.5 sm:px-6 bg-white/85 dark:bg-[#111827]/85 backdrop-blur-xl ring-1 ring-slate-900/[0.08] dark:ring-white/[0.1] shadow-[0_8px_30px_rgb(0,0,0,0.06)] flex items-center justify-between gap-2 sm:gap-3">
          {/* Brand Identity */}
          <div className="flex items-center gap-2.5 sm:gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setActivePage('home')}
              aria-label="Go to Wise-Spliter Home"
              className="h-9 w-9 rounded-full bg-emerald-600 text-white flex items-center justify-center shadow-sm shrink-0 cursor-pointer hover:bg-emerald-500 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
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
              className={`min-h-[36px] inline-flex items-center gap-1.5 rounded-full px-2.5 sm:px-3 py-1.5 text-xs font-semibold transition-colors duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
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
              className="min-h-[36px] flex items-center gap-2 rounded-full bg-slate-100 dark:bg-slate-800/80 p-1 sm:pl-1.5 sm:pr-3 text-xs ring-1 ring-slate-200 dark:ring-white/10 hover:bg-slate-200/70 dark:hover:bg-slate-700 transition-colors duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
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
              className={`lg:hidden h-9 w-9 rounded-full flex items-center justify-center ring-1 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
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
              className="min-h-[36px] min-w-[36px] inline-flex items-center justify-center gap-1.5 rounded-full bg-slate-100 dark:bg-slate-800 px-2.5 sm:px-3 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 ring-1 ring-slate-200 dark:ring-white/10 hover:bg-slate-200/70 dark:hover:bg-slate-700 transition-colors duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
            >
              <Question size={16} weight="bold" aria-hidden="true" />
              <span className="hidden sm:inline">Help</span>
            </button>

            <button
              type="button"
              data-testid="theme-toggle-btn"
              onClick={toggleTheme}
              aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              className="h-9 w-9 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 flex items-center justify-center ring-1 ring-slate-200 dark:ring-white/10 hover:bg-slate-200/70 dark:hover:bg-slate-700 transition-colors duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
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
        <div className="lg:hidden fixed bottom-[4.75rem] right-4 z-30">
          <button
            type="button"
            data-testid="mobile-fab-split-btn"
            onClick={() =>
              openAddExpenseModal(activePage === 'groups' ? activeGroup.id : null, null)
            }
            className="min-h-[48px] inline-flex items-center gap-2 rounded-full bg-[#059669] hover:bg-emerald-600 text-white px-4 py-3 text-xs font-bold shadow-lg shadow-emerald-900/30 ring-1 ring-white/20 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
          >
            <Plus size={18} weight="bold" aria-hidden="true" />
            <span>{activePage === 'groups' ? '+ Add Group Bill' : '+ Split a Bill'}</span>
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
