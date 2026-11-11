import React, { useMemo, useState } from 'react';
import {
  ArrowCounterClockwise,
  ArrowRight,
  ArrowsClockwise,
  ArrowsLeftRight,
  Calculator,
  ChatCircleText,
  CheckCircle,
  Coins,
  Funnel,
  GitDiff,
  GoogleLogo,
  HandCoins,
  Lightning,
  MagnifyingGlass,
  NotePencil,
  Paperclip,
  Plus,
  Receipt,
  Scales,
  ShieldCheck,
  Sparkle,
  Trash,
  UserPlus,
  Users,
  Warning,
  X,
} from '@phosphor-icons/react';
import { useLedger } from '../../state/LedgerContext';
import { ExpenseCategoryKey, ExpenseItem, GroupRecord } from '../../types/ledger';
import {
  CurrencyAmount,
  CurrencyPrecisionPill,
  DoubleBezelCard,
  StatusBadge,
} from '../primitives/DesignPrimitives';
import {
  SUPPORTED_CURRENCIES,
  formatMinorToMajor,
  getCurrency,
} from '../../domain/money/currencies';
import {
  computeGroupNetBalances,
  computeRawPairwiseTransfers,
  simplifyGroupDebts,
} from '../../domain/ledger/ledger-engine';
import { ExpenseEditorModal } from '../modals/ExpenseEditorModal';
import { ExplainBalanceModal } from '../modals/ExplainBalanceModal';

export function GroupsLedgerPage() {
  const {
    dataset,
    activeGroup,
    setActiveGroupId,
    setActivePage,
    createGroup,
    toggleGroupSimplifyDebts,
    changeGroupBaseCurrency,
    addMemberToGroup,
    claimMemberAccount,
    softDeleteExpense,
    restoreExpense,
    resolveExpenseConflict,
    refreshOfflineExpenseFx,
    addExpenseComment,
    recordSettlement,
  } = useLedger();

  // New Group Modal / Drawer State
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupDesc, setNewGroupDesc] = useState('');
  const [newGroupCategory, setNewGroupCategory] = useState<GroupRecord['category']>('trip');
  const [newGroupCurrency, setNewGroupCurrency] = useState('INR');

  // Change Group Base Currency Panel State
  const [showCurrencyChanger, setShowCurrencyChanger] = useState(false);
  const [targetCurrency, setTargetCurrency] = useState('USD');
  const [currencyChangeMode, setCurrencyChangeMode] = useState<'relabel' | 'reconvert'>('reconvert');
  const [customFxRateInput, setCustomFxRateInput] = useState('');

  // Add Member Panel State
  const [showAddMember, setShowAddMember] = useState(false);
  const [memberNameInput, setMemberNameInput] = useState('');
  const [memberEmailInput, setMemberEmailInput] = useState('');
  const [memberUpiInput, setMemberUpiInput] = useState('');

  // Expense Editor Modal State
  const [isExpenseModalOpen, setIsExpenseModalOpen] = useState(false);
  const [editingExpense, setEditingExpense] = useState<ExpenseItem | null>(null);

  // Explain Balance Modal State
  const [explainMemberId, setExplainMemberId] = useState<string | null>(null);

  // Feed Filter & Search State
  const [selectedCategory, setSelectedCategory] = useState<ExpenseCategoryKey | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedExpenseIds, setExpandedExpenseIds] = useState<Record<string, boolean>>({});
  const [commentDrafts, setCommentDrafts] = useState<Record<string, string>>({});

  const activeGroups = useMemo(
    () => dataset.groups.filter((g) => !g.deletedAt),
    [dataset.groups]
  );

  const allCurrencyOptions = useMemo(() => {
    const primaryCodes = new Set(dataset.currenciesCatalog.map((c) => c.code));
    const extras = Object.values(SUPPORTED_CURRENCIES)
      .filter((c) => !primaryCodes.has(c.code))
      .sort((a, b) => a.code.localeCompare(b.code));
    return [...dataset.currenciesCatalog, ...extras];
  }, [dataset.currenciesCatalog]);

  const groupExpenses = useMemo(
    () => dataset.expenses.filter((e) => e.groupId === activeGroup.id && !e.deletedAt),
    [dataset.expenses, activeGroup.id]
  );

  const trashedExpenses = useMemo(
    () => dataset.expenses.filter((e) => e.groupId === activeGroup.id && Boolean(e.deletedAt)),
    [dataset.expenses, activeGroup.id]
  );

  const groupSettlements = useMemo(
    () => dataset.settlements.filter((s) => s.groupId === activeGroup.id && !s.deletedAt),
    [dataset.settlements, activeGroup.id]
  );

  const conflictedExpenses = useMemo(
    () => groupExpenses.filter((e) => e.hasUnresolvedConflict && e.conflictRevisionId),
    [groupExpenses]
  );

  const netBalances = useMemo(
    () => computeGroupNetBalances(groupExpenses, groupSettlements, activeGroup.members),
    [groupExpenses, groupSettlements, activeGroup.members]
  );

  const suggestedTransfers = useMemo(() => {
    if (activeGroup.simplifyDebts) {
      return simplifyGroupDebts(netBalances, activeGroup.members, activeGroup.baseCurrency);
    }
    return computeRawPairwiseTransfers(
      groupExpenses,
      groupSettlements,
      activeGroup.members,
      activeGroup.baseCurrency
    );
  }, [
    activeGroup.simplifyDebts,
    activeGroup.members,
    activeGroup.baseCurrency,
    netBalances,
    groupExpenses,
    groupSettlements,
  ]);

  const filteredExpenses = useMemo(() => {
    return groupExpenses.filter((exp) => {
      if (selectedCategory !== 'all' && exp.category !== selectedCategory) {
        return false;
      }
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const inTitle = exp.title.toLowerCase().includes(q);
        const inNotes = exp.notes.toLowerCase().includes(q);
        const inTags = exp.tags.some((t) => t.toLowerCase().includes(q));
        return inTitle || inNotes || inTags;
      }
      return true;
    });
  }, [groupExpenses, selectedCategory, searchQuery]);

  const totalGroupSpendMinor = useMemo(
    () => groupExpenses.reduce((acc, e) => acc + e.amountMinor, 0),
    [groupExpenses]
  );

  const currentUserMember = useMemo(() => {
    return (
      activeGroup.members.find(
        (m) =>
          m.userId === dataset.currentUser.id ||
          m.invitedEmail?.toLowerCase() === dataset.currentUser.email.toLowerCase()
      ) ?? activeGroup.members[0]
    );
  }, [activeGroup.members, dataset.currentUser.id, dataset.currentUser.email]);

  const myGroupShareMinor = useMemo(() => {
    if (!currentUserMember) return 0;
    return groupExpenses.reduce((acc, exp) => {
      const splitShare = exp.splits.find(
        (s) => s.memberId === currentUserMember.id && s.included
      );
      return acc + (splitShare ? splitShare.owedMinor : 0);
    }, 0);
  }, [groupExpenses, currentUserMember]);

  const myGroupNetPositionMinor = useMemo(() => {
    if (!currentUserMember) return 0;
    return netBalances.get(currentUserMember.id) ?? 0;
  }, [netBalances, currentUserMember]);

  const topSpendCategory = useMemo(() => {
    if (groupExpenses.length === 0) {
      return { label: 'No Bills Yet', amountMinor: 0 };
    }
    const totalsByCat = new Map<ExpenseCategoryKey, number>();
    for (const exp of groupExpenses) {
      totalsByCat.set(exp.category, (totalsByCat.get(exp.category) ?? 0) + exp.amountMinor);
    }
    let topKey: ExpenseCategoryKey = groupExpenses[0]!.category;
    let topAmount = 0;
    for (const [cat, amt] of totalsByCat.entries()) {
      if (amt > topAmount) {
        topKey = cat;
        topAmount = amt;
      }
    }
    const meta = dataset.categoriesCatalog.find((c) => c.key === topKey);
    return {
      label: meta?.label ?? topKey.toUpperCase(),
      amountMinor: topAmount,
    };
  }, [groupExpenses, dataset.categoriesCatalog]);

  const memberNameOf = (id: string) =>
    activeGroup.members.find((m) => m.id === id)?.displayName ?? id;

  const handleOpenCurrencyChanger = () => {
    const nextDefault = activeGroup.baseCurrency === 'INR' ? 'USD' : 'INR';
    setTargetCurrency(nextDefault);
    const oldRate = dataset.fxRatesToInr[activeGroup.baseCurrency] ?? 1;
    const newRate = dataset.fxRatesToInr[nextDefault] ?? 1;
    setCustomFxRateInput((oldRate / newRate).toFixed(4));
    setShowCurrencyChanger((prev) => !prev);
  };

  const handleConfirmCurrencyChange = () => {
    const parsedRate = Number(customFxRateInput);
    changeGroupBaseCurrency(
      activeGroup.id,
      targetCurrency,
      currencyChangeMode,
      Number.isFinite(parsedRate) && parsedRate > 0 ? parsedRate : undefined
    );
    setShowCurrencyChanger(false);
  };

  const handleCreateGroupSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newGroupName.trim()) return;
    createGroup({
      name: newGroupName.trim(),
      description: newGroupDesc.trim() || 'Shared multi-currency group ledger',
      category: newGroupCategory,
      baseCurrency: newGroupCurrency,
      simplifyDebts: true,
    });
    setNewGroupName('');
    setNewGroupDesc('');
    setShowCreateGroup(false);
  };

  const handleAddMemberSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!memberNameInput.trim()) return;
    addMemberToGroup(activeGroup.id, {
      displayName: memberNameInput.trim(),
      invitedEmail: memberEmailInput.trim() || undefined,
      upiId: memberUpiInput.trim() || undefined,
    });
    setMemberNameInput('');
    setMemberEmailInput('');
    setMemberUpiInput('');
    setShowAddMember(false);
  };

  const handleRefreshExpenseFx = (exp: ExpenseItem) => {
    const fromRateToInr = dataset.fxRatesToInr[exp.originalCurrency] ?? 1;
    const toRateToInr = dataset.fxRatesToInr[exp.groupCurrency] ?? 1;
    const liveCrossRate = Number((fromRateToInr / toRateToInr).toFixed(4));
    refreshOfflineExpenseFx(exp.id, liveCrossRate > 0 ? liveCrossRate : 154.2);
  };

  const baseMeta = getCurrency(activeGroup.baseCurrency);
  const minorUnitName =
    baseMeta.decimals === 0 ? 'unit' : baseMeta.decimals === 3 ? 'fils' : 'paisa/cent';

  return (
    <div className="space-y-6">
      {/* Top Group Switcher Bar */}
      <div
        data-testid="group-switcher-bar"
        className="flex flex-wrap items-center justify-between gap-3"
      >
        <div className="flex flex-wrap items-center gap-2">
          {activeGroups.map((grp) => {
            const isSelected = grp.id === activeGroup.id;
            return (
              <button
                key={grp.id}
                type="button"
                data-testid={`group-select-${grp.id}`}
                onClick={() => setActiveGroupId(grp.id)}
                className={`inline-flex items-center gap-2.5 rounded-2xl px-4 py-2.5 text-xs font-bold transition-all border ${
                  isSelected
                    ? 'bg-[#059669] text-white border-[#059669] shadow-md shadow-emerald-600/20'
                    : 'bg-white dark:bg-[#111827] text-slate-700 dark:text-slate-200 border-slate-200/80 dark:border-white/10 hover:border-emerald-500/40'
                }`}
              >
                <span>{grp.name}</span>
                <span
                  className={`rounded-full px-2 py-0.5 font-mono text-[10px] ${
                    isSelected
                      ? 'bg-black/20 text-white'
                      : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300'
                  }`}
                >
                  {grp.baseCurrency}
                </span>
              </button>
            );
          })}
        </div>

        <button
          type="button"
          data-testid="create-group-btn"
          onClick={() => setShowCreateGroup((prev) => !prev)}
          className="inline-flex items-center gap-1.5 rounded-2xl bg-slate-900 dark:bg-white text-white dark:text-slate-900 px-4 py-2.5 text-xs font-bold hover:opacity-90 transition-opacity cursor-pointer"
        >
          <Plus className="w-4 h-4" weight="bold" />
          <span>New Group</span>
        </button>
      </div>

      {/* Create New Group Inline Drawer */}
      {showCreateGroup && (
        <DoubleBezelCard innerClassName="space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">
              Create New Shared Group Ledger
            </h3>
            <button
              type="button"
              onClick={() => setShowCreateGroup(false)}
              aria-label="Close new group drawer"
              className="text-slate-400 hover:text-slate-700 dark:hover:text-white"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <form
            onSubmit={handleCreateGroupSubmit}
            className="grid grid-cols-1 sm:grid-cols-12 gap-3"
          >
            <div className="sm:col-span-4">
              <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
                Group Name
              </label>
              <input
                type="text"
                data-testid="group-name-input"
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                placeholder="e.g., Manali Ski Trip 2026"
                className="w-full rounded-xl border border-slate-300 dark:border-white/15 bg-slate-50 dark:bg-slate-900 px-3 py-2 text-xs text-slate-900 dark:text-slate-100"
              />
            </div>
            <div className="sm:col-span-3">
              <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
                Base Currency
              </label>
              <select
                data-testid="group-currency-select"
                value={newGroupCurrency}
                onChange={(e) => setNewGroupCurrency(e.target.value)}
                className="w-full rounded-xl border border-slate-300 dark:border-white/15 bg-slate-50 dark:bg-slate-900 px-3 py-2 font-mono text-xs text-slate-900 dark:text-slate-100"
              >
                {allCurrencyOptions.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.code} - {c.name} ({c.symbol})
                  </option>
                ))}
              </select>
            </div>
            <div className="sm:col-span-3">
              <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
                Description
              </label>
              <input
                type="text"
                value={newGroupDesc}
                onChange={(e) => setNewGroupDesc(e.target.value)}
                placeholder="Villas, flights, and shared meals"
                className="w-full rounded-xl border border-slate-300 dark:border-white/15 bg-slate-50 dark:bg-slate-900 px-3 py-2 text-xs text-slate-900 dark:text-slate-100"
              />
            </div>
            <div className="sm:col-span-2 flex items-end">
              <button
                type="submit"
                data-testid="save-group-btn"
                className="w-full rounded-xl bg-[#059669] hover:bg-emerald-600 text-white px-3 py-2 text-xs font-bold transition-colors cursor-pointer"
              >
                Create Group
              </button>
            </div>
          </form>
        </DoubleBezelCard>
      )}

      {/* Group Header Card */}
      <DoubleBezelCard innerClassName="space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge tone="emerald">{activeGroup.category.toUpperCase()}</StatusBadge>
              <CurrencyPrecisionPill currencyCode={activeGroup.baseCurrency} />
              <StatusBadge tone="slate">Invite: {activeGroup.inviteCode}</StatusBadge>
              {activeGroup.defaultSplitConfig && (
                <StatusBadge tone="blue">
                  <Sparkle className="w-3 h-3" weight="fill" />
                  <span>Preset: {activeGroup.defaultSplitConfig.label}</span>
                </StatusBadge>
              )}
            </div>
            <h1 className="text-xl sm:text-2xl font-extrabold tracking-tight text-slate-900 dark:text-slate-100">
              {activeGroup.name}
            </h1>
            <p className="text-xs sm:text-sm text-slate-500 dark:text-slate-400">
              {activeGroup.description}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            {/* Smart Debt Simplification Toggle */}
            <button
              type="button"
              data-testid="toggle-simplify-debts-btn"
              onClick={() => toggleGroupSimplifyDebts(activeGroup.id)}
              className={`inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-bold transition-all border cursor-pointer ${
                activeGroup.simplifyDebts
                  ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30'
                  : 'bg-amber-500/10 text-amber-800 dark:text-amber-300 border-amber-500/30'
              }`}
            >
              <Lightning className="w-4 h-4" weight="fill" />
              <span>
                {activeGroup.simplifyDebts
                  ? 'Simplify Debts: ON (Min Transfers)'
                  : 'Simplify Debts: OFF (Raw Pairwise)'}
              </span>
            </button>

            {/* Change Base Currency Trigger */}
            <button
              type="button"
              data-testid="change-group-currency-btn"
              onClick={handleOpenCurrencyChanger}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 dark:border-white/15 bg-slate-50 dark:bg-slate-800/90 hover:bg-slate-100 dark:hover:bg-slate-800 px-3.5 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 transition-colors cursor-pointer"
            >
              <ArrowsLeftRight className="w-4 h-4 text-[#059669]" weight="bold" />
              <span>Change Base Currency</span>
            </button>

            {/* Add Member Trigger */}
            <button
              type="button"
              data-testid="add-member-btn"
              onClick={() => setShowAddMember((prev) => !prev)}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 dark:border-white/15 bg-slate-50 dark:bg-slate-800/90 hover:bg-slate-100 dark:hover:bg-slate-800 px-3.5 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 transition-colors cursor-pointer"
            >
              <UserPlus className="w-4 h-4 text-[#059669]" weight="bold" />
              <span>Add Member</span>
            </button>

            {/* Add Expense Primary CTA */}
            <button
              type="button"
              data-testid="add-expense-btn"
              onClick={() => {
                setEditingExpense(null);
                setIsExpenseModalOpen(true);
              }}
              className="inline-flex items-center gap-1.5 rounded-xl bg-[#059669] hover:bg-emerald-600 text-white px-4 py-2 text-xs font-bold shadow-md shadow-emerald-600/20 transition-all cursor-pointer"
            >
              <Plus className="w-4 h-4" weight="bold" />
              <span>Add Expense</span>
            </button>
          </div>
        </div>

        {/* Inline Base Currency Switcher (Mode A: Re-label vs Mode B: Re-convert) */}
        {showCurrencyChanger && (
          <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/[0.05] p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-xs font-bold uppercase tracking-wider text-emerald-800 dark:text-emerald-300">
                Change Group Base Currency ({activeGroup.baseCurrency} to {targetCurrency})
              </div>
              <button
                type="button"
                onClick={() => setShowCurrencyChanger(false)}
                aria-label="Close currency changer drawer"
                className="text-slate-400 hover:text-slate-700 dark:hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
              <div className="md:col-span-3">
                <label className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-1">
                  New Base Currency
                </label>
                <select
                  value={targetCurrency}
                  onChange={(e) => {
                    const code = e.target.value;
                    setTargetCurrency(code);
                    const oldRate = dataset.fxRatesToInr[activeGroup.baseCurrency] ?? 1;
                    const newRate = dataset.fxRatesToInr[code] ?? 1;
                    setCustomFxRateInput((oldRate / newRate).toFixed(4));
                  }}
                  className="w-full rounded-xl border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-900 px-3 py-2 font-mono text-xs text-slate-900 dark:text-slate-100"
                >
                  {allCurrencyOptions
                    .filter((c) => c.code !== activeGroup.baseCurrency)
                    .map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.code} - {c.name} ({c.symbol})
                      </option>
                    ))}
                </select>
              </div>

              <div className="md:col-span-6 grid grid-cols-1 sm:grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setCurrencyChangeMode('relabel')}
                  className={`rounded-xl p-2.5 text-left border text-xs transition-all ${
                    currencyChangeMode === 'relabel'
                      ? 'border-[#059669] bg-[#059669]/15 text-slate-900 dark:text-white font-bold'
                      : 'border-slate-200 dark:border-white/10 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300'
                  }`}
                >
                  <div>Mode A: Re-label symbol only</div>
                  <div className="text-[10px] text-slate-500 dark:text-slate-400">
                    Preserves major numeric values (scales minor units if decimals differ)
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => setCurrencyChangeMode('reconvert')}
                  className={`rounded-xl p-2.5 text-left border text-xs transition-all ${
                    currencyChangeMode === 'reconvert'
                      ? 'border-[#059669] bg-[#059669]/15 text-slate-900 dark:text-white font-bold'
                      : 'border-slate-200 dark:border-white/10 bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300'
                  }`}
                >
                  <div>Mode B: Convert existing bills via FX rate</div>
                  <div className="text-[10px] text-slate-500 dark:text-slate-400">
                    Multiplies all active expenses & settlements by FX rate
                  </div>
                </button>
              </div>

              <div className="md:col-span-3 flex items-center gap-2">
                {currencyChangeMode === 'reconvert' && (
                  <input
                    type="number"
                    step="any"
                    value={customFxRateInput}
                    onChange={(e) => setCustomFxRateInput(e.target.value)}
                    className="w-24 rounded-xl border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-900 px-2.5 py-2 font-mono tabular-nums text-xs text-slate-900 dark:text-slate-100"
                    title="Cross FX rate"
                  />
                )}
                <button
                  type="button"
                  data-testid="confirm-currency-change-btn"
                  onClick={handleConfirmCurrencyChange}
                  className="flex-1 rounded-xl bg-[#059669] hover:bg-emerald-600 text-white px-3 py-2 text-xs font-bold transition-colors cursor-pointer"
                >
                  Confirm Change
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Inline Add Member Form */}
        {showAddMember && (
          <form
            onSubmit={handleAddMemberSubmit}
            className="rounded-2xl border border-slate-200 dark:border-white/10 bg-slate-50/80 dark:bg-slate-900/60 p-4 grid grid-cols-1 sm:grid-cols-12 gap-3 items-end"
          >
            <div className="sm:col-span-4">
              <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
                Member Display Name
              </label>
              <input
                type="text"
                data-testid="member-name-input"
                value={memberNameInput}
                onChange={(e) => setMemberNameInput(e.target.value)}
                placeholder="e.g., Ananya Rao"
                className="w-full rounded-xl border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-900 px-3 py-2 text-xs text-slate-900 dark:text-slate-100"
              />
            </div>
            <div className="sm:col-span-3">
              <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
                Google Email (Optional Invite)
              </label>
              <input
                type="email"
                data-testid="member-email-input"
                value={memberEmailInput}
                onChange={(e) => setMemberEmailInput(e.target.value)}
                placeholder="ananya@gmail.com"
                className="w-full rounded-xl border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-900 px-3 py-2 text-xs text-slate-900 dark:text-slate-100"
              />
            </div>
            <div className="sm:col-span-3">
              <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
                UPI ID (Optional)
              </label>
              <input
                type="text"
                data-testid="member-upi-input"
                value={memberUpiInput}
                onChange={(e) => setMemberUpiInput(e.target.value)}
                placeholder="ananya@okicici"
                className="w-full rounded-xl border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-900 px-3 py-2 font-mono text-xs text-slate-900 dark:text-slate-100"
              />
            </div>
            <div className="sm:col-span-2">
              <button
                type="submit"
                data-testid="save-member-btn"
                className="w-full rounded-xl bg-[#059669] hover:bg-emerald-600 text-white px-3 py-2 text-xs font-bold transition-colors cursor-pointer"
              >
                Save Member
              </button>
            </div>
          </form>
        )}

        {/* Progressive Disclosure: Minimal Group Insights Bar (4-Metric Strip) */}
        <div
          data-testid="group-minimal-insights-bar"
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 pt-2 border-t border-slate-200/70 dark:border-white/10"
        >
          <div className="rounded-2xl border border-slate-200/80 dark:border-white/10 bg-slate-50/70 dark:bg-slate-900/60 px-3.5 py-2.5">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Group Total Spend
            </div>
            <div className="mt-1 text-sm sm:text-base font-extrabold font-mono tabular-nums text-slate-900 dark:text-slate-100">
              <CurrencyAmount
                minorAmount={totalGroupSpendMinor}
                currencyCode={activeGroup.baseCurrency}
              />
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200/80 dark:border-white/10 bg-slate-50/70 dark:bg-slate-900/60 px-3.5 py-2.5">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Your Group Share
            </div>
            <div className="mt-1 text-sm sm:text-base font-extrabold font-mono tabular-nums text-slate-900 dark:text-slate-100">
              <CurrencyAmount
                minorAmount={myGroupShareMinor}
                currencyCode={activeGroup.baseCurrency}
              />
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200/80 dark:border-white/10 bg-slate-50/70 dark:bg-slate-900/60 px-3.5 py-2.5">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              Your Net Position
            </div>
            <div className="mt-1 text-sm sm:text-base font-extrabold font-mono tabular-nums">
              <CurrencyAmount
                minorAmount={myGroupNetPositionMinor}
                currencyCode={activeGroup.baseCurrency}
                colorize
                showPlusSign
              />
            </div>
          </div>

          <div className="rounded-2xl border border-slate-200/80 dark:border-white/10 bg-slate-50/70 dark:bg-slate-900/60 px-3.5 py-2.5 flex flex-col justify-between">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 truncate">
                Top Category ({groupExpenses.length} bills)
              </span>
              <button
                type="button"
                onClick={() => setActivePage('analytics')}
                className="inline-flex items-center gap-1 text-[11px] font-bold text-[#059669] hover:underline cursor-pointer shrink-0"
              >
                <span>View Full Group Charts</span>
                <ArrowRight className="w-3 h-3" weight="bold" />
              </button>
            </div>
            <div className="mt-1 flex items-baseline justify-between gap-2">
              <span className="text-xs font-bold text-slate-900 dark:text-slate-100 truncate">
                {topSpendCategory.label}
              </span>
              <span className="text-xs font-mono tabular-nums font-bold text-slate-600 dark:text-slate-300">
                <CurrencyAmount
                  minorAmount={topSpendCategory.amountMinor}
                  currencyCode={activeGroup.baseCurrency}
                />
              </span>
            </div>
          </div>
        </div>

        {/* Automatic User Guidance Strip */}
        <div
          data-testid="group-auto-guide-strip"
          className={`flex flex-wrap items-center justify-between gap-2 rounded-2xl border px-4 py-2.5 text-xs font-semibold ${
            conflictedExpenses.length > 0
              ? 'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300'
              : suggestedTransfers.length > 0
              ? 'border-sky-500/30 bg-sky-500/[0.07] text-sky-800 dark:text-sky-300'
              : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300'
          }`}
        >
          <div className="flex items-center gap-2">
            {conflictedExpenses.length > 0 ? (
              <Warning className="w-4 h-4 shrink-0 text-amber-600 dark:text-amber-400" weight="fill" />
            ) : suggestedTransfers.length > 0 ? (
              <Scales className="w-4 h-4 shrink-0 text-sky-600 dark:text-sky-400" weight="duotone" />
            ) : (
              <CheckCircle
                className="w-4 h-4 shrink-0 text-emerald-600 dark:text-emerald-400"
                weight="fill"
              />
            )}
            <span>
              {conflictedExpenses.length > 0
                ? 'Step 1: Resolve the concurrent offline edit conflict below to lock group balances.'
                : suggestedTransfers.length > 0
                ? "Group ready: Add new expenses, click 'Explain' on any member to verify math, or record a settlement."
                : "All members are settled to 0.00! Click '+ Add Expense' to log the next shared bill."}
            </span>
          </div>
          <span className="font-mono text-[11px] opacity-80">
            {activeGroup.name} ({activeGroup.baseCurrency})
          </span>
        </div>
      </DoubleBezelCard>

      {/* Concurrent Offline Conflict Resolution Banner */}
      {conflictedExpenses.map((exp) => {
        const activeRev = dataset.expenseRevisions.find((r) => r.id === exp.currentRevisionId);
        const conflictRev = dataset.expenseRevisions.find((r) => r.id === exp.conflictRevisionId);

        return (
          <div
            key={exp.id}
            data-testid="conflict-resolution-banner"
            className="rounded-[1.5rem] p-1.5 ring-1 ring-amber-500/40 bg-amber-500/10"
          >
            <div className="rounded-[calc(1.5rem-0.375rem)] bg-white dark:bg-[#111827] border border-amber-500/30 p-5 space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <StatusBadge tone="amber">
                      <Warning className="w-3.5 h-3.5" weight="fill" />
                      <span>Concurrent Offline Edit Conflict Detected</span>
                    </StatusBadge>
                    <span className="font-mono text-xs text-slate-500 dark:text-slate-400">
                      Base Revision Mismatch on &quot;{exp.title}&quot;
                    </span>
                  </div>
                  <p className="text-xs text-slate-600 dark:text-slate-300">
                    Two group members edited this expense concurrently while offline. Both snapshots are preserved in immutable revision history - choose which version should govern the active ledger.
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Active Revision Card */}
                <div className="rounded-2xl border border-emerald-500/40 bg-emerald-500/[0.05] p-4 space-y-2.5 flex flex-col justify-between">
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <StatusBadge tone="emerald">
                        Active Version ({activeRev?.actorDisplayName ?? 'Latest HLC'})
                      </StatusBadge>
                      <span className="font-mono text-[11px] text-slate-500">
                        Rev #{activeRev?.revisionNumber ?? exp.revisionNumber}
                      </span>
                    </div>
                    <div className="text-sm font-bold text-slate-900 dark:text-slate-100">
                      {activeRev?.snapshot.title ?? exp.title}
                    </div>
                    <div className="text-base font-extrabold font-mono tabular-nums text-emerald-700 dark:text-emerald-300">
                      <CurrencyAmount
                        minorAmount={activeRev?.snapshot.amountMinor ?? exp.amountMinor}
                        currencyCode={exp.groupCurrency}
                      />{' '}
                      <span className="text-xs font-normal text-slate-500">
                        ({(activeRev?.snapshot.splitMode ?? exp.splitMode).toUpperCase()} Split)
                      </span>
                    </div>
                    <p className="text-xs text-slate-600 dark:text-slate-400">
                      {activeRev?.snapshot.notes ?? exp.notes}
                    </p>
                  </div>

                  <button
                    type="button"
                    data-testid="keep-active-revision-btn"
                    onClick={() => resolveExpenseConflict(exp.id, exp.currentRevisionId)}
                    className="mt-3 w-full inline-flex items-center justify-center gap-1.5 rounded-xl bg-[#059669] hover:bg-emerald-600 text-white px-3.5 py-2 text-xs font-bold transition-colors cursor-pointer"
                  >
                    <CheckCircle className="w-4 h-4" weight="bold" />
                    <span>
                      Keep {activeRev?.actorDisplayName ?? 'Active'}&apos;s Version (
                      {formatMinorToMajor(
                        activeRev?.snapshot.amountMinor ?? exp.amountMinor,
                        exp.groupCurrency
                      )}
                      )
                    </span>
                  </button>
                </div>

                {/* Conflicting Branch Revision Card */}
                {conflictRev && (
                  <div className="rounded-2xl border border-amber-500/40 bg-amber-500/[0.05] p-4 space-y-2.5 flex flex-col justify-between">
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <StatusBadge tone="amber">
                          Conflicting Branch ({conflictRev.actorDisplayName})
                        </StatusBadge>
                        <span className="font-mono text-[11px] text-slate-500">
                          Rev #{conflictRev.revisionNumber}
                        </span>
                      </div>
                      <div className="text-sm font-bold text-slate-900 dark:text-slate-100">
                        {conflictRev.snapshot.title}
                      </div>
                      <div className="text-base font-extrabold font-mono tabular-nums text-amber-800 dark:text-amber-300">
                        <CurrencyAmount
                          minorAmount={conflictRev.snapshot.amountMinor}
                          currencyCode={exp.groupCurrency}
                        />{' '}
                        <span className="text-xs font-normal text-slate-500">
                          ({conflictRev.snapshot.splitMode.toUpperCase()} Split)
                        </span>
                      </div>
                      <p className="text-xs text-slate-600 dark:text-slate-400">
                        {conflictRev.snapshot.notes}
                      </p>
                    </div>

                    <button
                      type="button"
                      data-testid="keep-conflict-revision-btn"
                      onClick={() => resolveExpenseConflict(exp.id, conflictRev.id)}
                      className="mt-3 w-full inline-flex items-center justify-center gap-1.5 rounded-xl bg-amber-600 hover:bg-amber-700 text-white px-3.5 py-2 text-xs font-bold transition-colors cursor-pointer"
                    >
                      <GitDiff className="w-4 h-4" weight="bold" />
                      <span>
                        Switch to {conflictRev.actorDisplayName}&apos;s Version (
                        {formatMinorToMajor(conflictRev.snapshot.amountMinor, exp.groupCurrency)})
                      </span>
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}

      {/* Main 12-Column Responsive Bento Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left/Top Column: Group Members & Suggested Repayments */}
        <div className="lg:col-span-5 space-y-6">
          {/* Members & Net Balances Card */}
          <DoubleBezelCard innerClassName="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Users className="w-5 h-5 text-[#059669]" weight="duotone" />
                <h2 className="text-sm font-bold uppercase tracking-wider text-slate-800 dark:text-slate-200">
                  Group Members ({activeGroup.members.length})
                </h2>
              </div>
              <span className="text-xs font-mono text-slate-500 dark:text-slate-400">
                Total Spend:{' '}
                <CurrencyAmount
                  minorAmount={totalGroupSpendMinor}
                  currencyCode={activeGroup.baseCurrency}
                  className="font-bold text-slate-900 dark:text-slate-100"
                />
              </span>
            </div>

            <div className="space-y-2.5">
              {activeGroup.members.map((member) => {
                const netMinor = netBalances.get(member.id) ?? 0;
                const isClaimed = member.userId !== null;

                return (
                  <div
                    key={member.id}
                    className="rounded-2xl border border-slate-200/80 dark:border-white/10 bg-slate-50/70 dark:bg-slate-900/60 p-3.5 space-y-2.5"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2.5">
                        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 font-bold text-xs">
                          {member.avatarInitials}
                        </span>
                        <div>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-sm font-bold text-slate-900 dark:text-slate-100">
                              {member.displayName}
                            </span>
                            {isClaimed ? (
                              <StatusBadge tone="emerald">
                                <ShieldCheck className="w-3 h-3" weight="fill" />
                                <span>Google OAuth Verified</span>
                              </StatusBadge>
                            ) : (
                              <StatusBadge tone="amber">Unclaimed Placeholder</StatusBadge>
                            )}
                          </div>
                          <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                            {member.invitedEmail ?? 'No email linked'}
                            {member.upiId ? ` | UPI: ${member.upiId}` : ''}
                          </div>
                        </div>
                      </div>

                      <div className="text-right">
                        <div className="text-sm font-extrabold font-mono tabular-nums">
                          <CurrencyAmount
                            minorAmount={netMinor}
                            currencyCode={activeGroup.baseCurrency}
                            colorize
                            showPlusSign
                          />
                        </div>
                        <div className="text-[10px] text-slate-400">
                          {netMinor > 0
                            ? 'gets back'
                            : netMinor < 0
                            ? 'owes group'
                            : 'settled up'}
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-slate-200/60 dark:border-white/5">
                      <button
                        type="button"
                        data-testid="explain-balance-btn"
                        onClick={() => setExplainMemberId(member.id)}
                        className="inline-flex items-center gap-1 rounded-lg bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200/80 dark:border-white/10 px-2.5 py-1 text-[11px] font-semibold text-slate-700 dark:text-slate-200 transition-colors cursor-pointer"
                      >
                        <Calculator className="w-3.5 h-3.5 text-[#059669]" />
                        <span>Explain Balance</span>
                      </button>

                      {!isClaimed && (
                        <button
                          type="button"
                          data-testid={`claim-member-${member.id}`}
                          onClick={() => claimMemberAccount(activeGroup.id, member.id)}
                          className="inline-flex items-center gap-1 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 text-amber-800 dark:text-amber-300 ring-1 ring-amber-500/30 px-2.5 py-1 text-[11px] font-semibold transition-colors cursor-pointer"
                        >
                          <GoogleLogo className="w-3.5 h-3.5" weight="bold" />
                          <span>Simulate Google Sign-In Link</span>
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </DoubleBezelCard>

          {/* Suggested Repayments Card */}
          <DoubleBezelCard innerClassName="space-y-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <HandCoins className="w-5 h-5 text-[#059669]" weight="duotone" />
                <h2 className="text-sm font-bold uppercase tracking-wider text-slate-800 dark:text-slate-200">
                  Suggested Repayments ({suggestedTransfers.length})
                </h2>
              </div>
              <StatusBadge tone={activeGroup.simplifyDebts ? 'emerald' : 'amber'}>
                {activeGroup.simplifyDebts ? 'Bitmask-DP Simplified' : 'Raw Pairwise'}
              </StatusBadge>
            </div>

            {suggestedTransfers.length === 0 ? (
              <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-center space-y-1">
                <CheckCircle
                  className="w-6 h-6 text-emerald-600 dark:text-emerald-400 mx-auto"
                  weight="fill"
                />
                <div className="text-xs font-bold text-emerald-800 dark:text-emerald-200">
                  All Group Members Are 100% Settled Up!
                </div>
              </div>
            ) : (
              <div className="space-y-2.5">
                {suggestedTransfers.map((transfer, idx) => (
                  <div
                    key={`${transfer.fromMemberId}-${transfer.toMemberId}-${idx}`}
                    className="rounded-2xl border border-slate-200/80 dark:border-white/10 bg-slate-50/70 dark:bg-slate-900/60 p-3.5 space-y-2.5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 text-xs font-bold text-slate-900 dark:text-slate-100">
                        <span>{memberNameOf(transfer.fromMemberId)}</span>
                        <ArrowRight className="w-3.5 h-3.5 text-[#059669]" weight="bold" />
                        <span>{memberNameOf(transfer.toMemberId)}</span>
                      </div>
                      <div className="text-sm font-extrabold font-mono tabular-nums text-emerald-700 dark:text-emerald-300">
                        <CurrencyAmount
                          minorAmount={transfer.amountMinor}
                          currencyCode={activeGroup.baseCurrency}
                        />
                      </div>
                    </div>

                    <p className="text-[11px] text-slate-500 dark:text-slate-400">
                      {transfer.explanationNote}
                    </p>

                    <button
                      type="button"
                      data-testid="quick-settle-btn"
                      onClick={() =>
                        recordSettlement({
                          groupId: activeGroup.id,
                          fromMemberId: transfer.fromMemberId,
                          toMemberId: transfer.toMemberId,
                          amountMinor: transfer.amountMinor,
                          paymentMethod: 'upi',
                          notes: `Quick settlement (${
                            activeGroup.simplifyDebts ? 'Simplified path' : 'Pairwise balance'
                          })`,
                        })
                      }
                      className="w-full inline-flex items-center justify-center gap-1.5 rounded-xl bg-[#059669] hover:bg-emerald-600 text-white px-3 py-2 text-xs font-bold transition-colors cursor-pointer"
                    >
                      <CheckCircle className="w-4 h-4" weight="bold" />
                      <span>
                        Record Settlement (
                        {formatMinorToMajor(transfer.amountMinor, activeGroup.baseCurrency)})
                      </span>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </DoubleBezelCard>
        </div>

        {/* Right/Main Column: Expense Ledger Feed */}
        <div className="lg:col-span-7 space-y-4">
          {/* Category Filter Pills & Search Input */}
          <DoubleBezelCard innerClassName="space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="relative flex-1">
                <MagnifyingGlass className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search expenses by title, notes, or #tags..."
                  className="w-full rounded-xl border border-slate-200 dark:border-white/15 bg-slate-50 dark:bg-slate-900 pl-9 pr-3.5 py-2 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-[#059669]"
                />
              </div>
              <div className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 font-mono">
                <Funnel className="w-4 h-4 text-[#059669]" />
                <span>{filteredExpenses.length} active bills</span>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setSelectedCategory('all')}
                className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors cursor-pointer ${
                  selectedCategory === 'all'
                    ? 'bg-[#059669] text-white'
                    : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
                }`}
              >
                All Categories
              </button>
              {dataset.categoriesCatalog.map((cat) => (
                <button
                  key={cat.key}
                  type="button"
                  onClick={() => setSelectedCategory(cat.key)}
                  className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors cursor-pointer ${
                    selectedCategory === cat.key
                      ? 'bg-[#059669] text-white'
                      : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
                  }`}
                >
                  {cat.label}
                </button>
              ))}
            </div>
          </DoubleBezelCard>

          {/* Expense Feed Cards */}
          {filteredExpenses.length === 0 ? (
            <DoubleBezelCard innerClassName="text-center py-10 space-y-2">
              <Receipt className="w-8 h-8 text-slate-400 mx-auto" weight="duotone" />
              <div className="text-sm font-bold text-slate-700 dark:text-slate-300">
                No matching expenses in this view
              </div>
              <p className="text-xs text-slate-500">
                Click &quot;Add Expense&quot; above to log a new shared bill.
              </p>
            </DoubleBezelCard>
          ) : (
            <div className="space-y-4">
              {filteredExpenses.map((exp) => {
                const catMeta = dataset.categoriesCatalog.find((c) => c.key === exp.category);
                const rotatedWinner = exp.splits.find((s) => s.included && s.remainderMinor === 1);
                const isExpanded = Boolean(expandedExpenseIds[exp.id]);
                const payerSummary = exp.payers
                  .map(
                    (p) =>
                      `${memberNameOf(p.memberId)} (${formatMinorToMajor(
                        p.paidMinor,
                        exp.groupCurrency
                      )})`
                  )
                  .join(' + ');

                return (
                  <DoubleBezelCard key={exp.id} innerClassName="space-y-3.5">
                    {/* Top Row: Badges & Amount */}
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <StatusBadge tone="emerald">
                            {catMeta?.label ?? exp.category.toUpperCase()}
                          </StatusBadge>
                          <StatusBadge tone="blue">{exp.splitMode.toUpperCase()} SPLIT</StatusBadge>
                          {exp.payers.length > 1 && (
                            <StatusBadge tone="slate">
                              {exp.payers.length} Payers
                            </StatusBadge>
                          )}
                          {rotatedWinner && (
                            <StatusBadge tone="amber">
                              +1 {minorUnitName} rotated ({memberNameOf(rotatedWinner.memberId)})
                            </StatusBadge>
                          )}
                          {exp.hasUnresolvedConflict && (
                            <StatusBadge tone="rose">Conflict Flagged</StatusBadge>
                          )}
                        </div>

                        <h3 className="text-base font-bold text-slate-900 dark:text-slate-100">
                          {exp.title}
                        </h3>
                        <div className="text-xs font-mono text-slate-500 dark:text-slate-400">
                          {exp.expenseDate} | Paid by {payerSummary}
                        </div>
                      </div>

                      <div className="text-right">
                        <div className="text-lg font-extrabold font-mono tabular-nums text-slate-900 dark:text-slate-100">
                          <CurrencyAmount
                            minorAmount={exp.amountMinor}
                            currencyCode={exp.groupCurrency}
                          />
                        </div>
                        {exp.originalCurrency !== exp.groupCurrency && (
                          <div className="text-xs font-mono tabular-nums text-slate-500">
                            Orig:{' '}
                            <CurrencyAmount
                              minorAmount={exp.originalAmountMinor}
                              currencyCode={exp.originalCurrency}
                            />
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Foreign Currency Audit Note + Offline Cached FX Refresh CTA */}
                    {exp.fxAuditNote && (
                      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-sky-500/25 bg-sky-500/[0.06] px-3 py-2 text-xs">
                        <span className="font-mono text-sky-800 dark:text-sky-300">
                          {exp.fxAuditNote}
                        </span>
                        {exp.fxStatus === 'cached_offline' && (
                          <button
                            type="button"
                            data-testid={`refresh-fx-${exp.id}`}
                            onClick={() => handleRefreshExpenseFx(exp)}
                            className="inline-flex items-center gap-1 rounded-lg bg-[#059669] hover:bg-emerald-600 text-white px-2.5 py-1 text-[11px] font-bold transition-colors cursor-pointer"
                          >
                            <ArrowsClockwise className="w-3.5 h-3.5" weight="bold" />
                            <span>Refresh Live FX</span>
                          </button>
                        )}
                      </div>
                    )}

                    {/* Per-Member Split Breakdown Chips */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      {exp.splits
                        .filter((s) => s.included)
                        .map((s) => (
                          <div
                            key={s.memberId}
                            className="rounded-xl border border-slate-200/70 dark:border-white/10 bg-slate-50/70 dark:bg-slate-900/50 px-2.5 py-1.5"
                          >
                            <div className="flex items-center justify-between gap-1">
                              <span className="text-[11px] font-semibold text-slate-700 dark:text-slate-300 truncate">
                                {memberNameOf(s.memberId)}
                              </span>
                              {s.remainderMinor === 1 && (
                                <span className="text-[10px] font-mono font-bold text-amber-600 dark:text-amber-400">
                                  +1
                                </span>
                              )}
                            </div>
                            <div className="text-xs font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100">
                              <CurrencyAmount
                                minorAmount={s.owedMinor}
                                currencyCode={exp.groupCurrency}
                              />
                            </div>
                          </div>
                        ))}
                    </div>

                    {exp.notes && (
                      <p className="text-xs text-slate-500 dark:text-slate-400">{exp.notes}</p>
                    )}

                    {/* Card Footer Actions */}
                    <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-200/70 dark:border-white/10">
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedExpenseIds((prev) => ({
                            ...prev,
                            [exp.id]: !prev[exp.id],
                          }))
                        }
                        className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:text-[#059669]"
                      >
                        <ChatCircleText className="w-4 h-4" />
                        <span>Comments ({exp.comments.length})</span>
                        <span>|</span>
                        <Paperclip className="w-4 h-4" />
                        <span>Receipts ({exp.receipts.length})</span>
                      </button>

                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setEditingExpense(exp);
                            setIsExpenseModalOpen(true);
                          }}
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 dark:border-white/15 bg-slate-50 dark:bg-slate-800 hover:bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700 dark:text-slate-200 transition-colors cursor-pointer"
                        >
                          <NotePencil className="w-3.5 h-3.5" />
                          <span>Edit</span>
                        </button>
                        <button
                          type="button"
                          data-testid={`delete-expense-${exp.id}`}
                          onClick={() => softDeleteExpense(exp.id)}
                          className="inline-flex items-center gap-1 rounded-lg border border-rose-500/30 bg-rose-500/10 hover:bg-rose-500/20 px-2.5 py-1 text-xs font-semibold text-rose-700 dark:text-rose-300 transition-colors cursor-pointer"
                        >
                          <Trash className="w-3.5 h-3.5" />
                          <span>Move to Trash</span>
                        </button>
                      </div>
                    </div>

                    {/* Expandable Comments & Receipts Drawer */}
                    {isExpanded && (
                      <div className="rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-slate-900/70 p-3 space-y-3">
                        {exp.receipts.length > 0 && (
                          <div className="space-y-1">
                            <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
                              Attached Receipts
                            </div>
                            {exp.receipts.map((rcp) => (
                              <div
                                key={rcp.id}
                                className="flex items-center justify-between rounded-lg bg-white dark:bg-slate-800 px-2.5 py-1.5 text-xs"
                              >
                                <span className="font-mono font-semibold">{rcp.fileName}</span>
                                <span className="text-slate-500">{rcp.previewNote}</span>
                              </div>
                            ))}
                          </div>
                        )}

                        <div className="space-y-1.5">
                          <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
                            Discussion & Audit Comments
                          </div>
                          {exp.comments.map((cmt) => (
                            <div
                              key={cmt.id}
                              className="rounded-lg bg-white dark:bg-slate-800 px-2.5 py-1.5 text-xs"
                            >
                              <span className="font-bold text-slate-900 dark:text-slate-100">
                                {cmt.authorName}:{' '}
                              </span>
                              <span className="text-slate-600 dark:text-slate-300">{cmt.body}</span>
                            </div>
                          ))}
                          <div className="flex items-center gap-2 pt-1">
                            <input
                              type="text"
                              value={commentDrafts[exp.id] ?? ''}
                              onChange={(e) =>
                                setCommentDrafts((prev) => ({
                                  ...prev,
                                  [exp.id]: e.target.value,
                                }))
                              }
                              placeholder="Add a note or comment on this bill..."
                              className="flex-1 rounded-lg border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-800 px-2.5 py-1 text-xs text-slate-900 dark:text-slate-100"
                            />
                            <button
                              type="button"
                              onClick={() => {
                                const draft = commentDrafts[exp.id] ?? '';
                                if (!draft.trim()) return;
                                addExpenseComment(exp.id, draft);
                                setCommentDrafts((prev) => ({ ...prev, [exp.id]: '' }));
                              }}
                              className="rounded-lg bg-[#059669] text-white px-3 py-1 text-xs font-bold"
                            >
                              Post
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </DoubleBezelCard>
                );
              })}
            </div>
          )}

          {/* Soft-Deleted Trash & Recovery Section */}
          {trashedExpenses.length > 0 && (
            <DoubleBezelCard innerClassName="space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-wider text-rose-600 dark:text-rose-400 flex items-center gap-1.5">
                  <Trash className="w-4 h-4" />
                  <span>Trash & 1-Click Recovery ({trashedExpenses.length})</span>
                </span>
              </div>
              <div className="space-y-2">
                {trashedExpenses.map((trashed) => (
                  <div
                    key={trashed.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 dark:border-white/10 bg-slate-50/70 dark:bg-slate-900/50 px-3 py-2 text-xs"
                  >
                    <div>
                      <span className="font-semibold text-slate-700 dark:text-slate-300 line-through">
                        {trashed.title}
                      </span>{' '}
                      <span className="font-mono text-slate-500">
                        ({formatMinorToMajor(trashed.amountMinor, trashed.groupCurrency)})
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => restoreExpense(trashed.id)}
                      className="inline-flex items-center gap-1 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-700 dark:text-emerald-300 px-2.5 py-1 text-xs font-bold transition-colors cursor-pointer"
                    >
                      <ArrowCounterClockwise className="w-3.5 h-3.5" weight="bold" />
                      <span>Restore</span>
                    </button>
                  </div>
                ))}
              </div>
            </DoubleBezelCard>
          )}
        </div>
      </div>

      {/* Modals */}
      <ExpenseEditorModal
        isOpen={isExpenseModalOpen}
        onClose={() => {
          setIsExpenseModalOpen(false);
          setEditingExpense(null);
        }}
        initialExpense={editingExpense}
        defaultGroupId={activeGroup.id}
      />

      <ExplainBalanceModal
        memberId={explainMemberId}
        onClose={() => setExplainMemberId(null)}
      />
    </div>
  );
}
