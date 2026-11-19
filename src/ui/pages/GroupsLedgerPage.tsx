import React, { useMemo, useState } from 'react';
import {
  ArrowCounterClockwiseIcon as ArrowCounterClockwise,
  ArrowRightIcon as ArrowRight,
  ArrowsClockwiseIcon as ArrowsClockwise,
  ArrowsLeftRightIcon as ArrowsLeftRight,
  CalculatorIcon as Calculator,
  ChatCircleTextIcon as ChatCircleText,
  CheckCircleIcon as CheckCircle,
  FunnelIcon as Funnel,
  GearSixIcon as GearSix,
  GitDiffIcon as GitDiff,
  HandCoinsIcon as HandCoins,
  LightningIcon as Lightning,
  MagnifyingGlassIcon as MagnifyingGlass,
  NotePencilIcon as NotePencil,
  PaperclipIcon as Paperclip,
  PlusIcon as Plus,
  ReceiptIcon as Receipt,
  ScalesIcon as Scales,
  ShareNetworkIcon as ShareNetwork,
  ShieldCheckIcon as ShieldCheck,
  SignInIcon as SignIn,
  SparkleIcon as Sparkle,
  TrashIcon as Trash,
  UserPlusIcon as UserPlus,
  UsersIcon as Users,
  WarningIcon as Warning,
  XIcon as X,
} from '@phosphor-icons/react';
import { useLedger } from '../../state/LedgerContext';
import { ExpenseCategoryKey, ExpenseItem, GroupRecord } from '../../types/ledger';
import {
  CurrencyAmount,
  CurrencyPrecisionPill,
  DoubleBezelCard,
  PersonalExpenseImpactBadge,
  StatusBadge,
} from '../primitives/DesignPrimitives';
import {
  SUPPORTED_CURRENCIES,
  formatMinorToMajor,
  formatScaledFxRate,
  parseFxRateToScaled,
  toLocaleDecimalInput,
  getCurrency,
} from '../../domain/money/currencies';
import { LIMITS } from '../../types/limits';
import {
  computeGroupNetBalances,
  computeRawPairwiseTransfers,
  simplifyGroupDebts,
} from '../../domain/ledger/ledger-engine';
import { ExpenseEditorModal } from '../modals/ExpenseEditorModal';
import { ExplainBalanceModal } from '../modals/ExplainBalanceModal';
import { actorLabel } from '../../utils/group-permissions';
import {
  BTN,
  BTN_DANGER,
  BTN_GHOST,
  BTN_PRIMARY,
  GroupDangerZone,
  InvitePanel,
  JoinGroupForm,
  MemberAdminActions,
  MemberUpiEditor,
} from '../components/GroupManagement';

const GLASS_INPUT =
  'lg-recessed-well min-h-[44px] w-full rounded-2xl px-3.5 py-2 text-xs sm:text-sm text-[#141715] dark:text-[#F3F5F3] placeholder:text-[#68726C] dark:placeholder:text-[#8A938D] focus:outline-none focus:ring-2 focus:ring-emerald-500/50';

const GLASS_LABEL =
  'block text-[11px] font-semibold uppercase tracking-[0.08em] text-[#5C6660] dark:text-[#9CA69F] mb-1.5';

export function GroupsLedgerPage() {
  const {
    dataset,
    activeGroup,
    setActiveGroupId,
    setActivePage,
    createGroup,
    toggleGroupSimplifyDebts,
    changeGroupBaseCurrency,
    isGroupAdmin,
    addMemberToGroup,
    softDeleteExpense,
    restoreExpense,
    resolveExpenseConflict,
    refreshOfflineExpenseFx,
    getFxQuote,
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
  const [rateEdited, setRateEdited] = useState(false);

  // Add Member Panel State
  const [showAddMember, setShowAddMember] = useState(false);
  const [memberNameInput, setMemberNameInput] = useState('');
  const [memberEmailInput, setMemberEmailInput] = useState('');
  const [memberUpiInput, setMemberUpiInput] = useState('');
  const [showInvite, setShowInvite] = useState(false);
  const [showJoin, setShowJoin] = useState(false);

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

  const currentMembers = useMemo(
    () => activeGroup.members.filter((m) => !m.removedAt),
    [activeGroup.members]
  );
  const formerMembers = useMemo(
    () => activeGroup.members.filter((m) => m.removedAt),
    [activeGroup.members]
  );

  const currentUserMember = useMemo(() => {
    return (
      currentMembers.find(
        (m) =>
          m.userId === dataset.currentUser.id ||
          m.invitedEmail?.toLowerCase() === dataset.currentUser.email.toLowerCase()
      ) ?? currentMembers[0]
    );
  }, [currentMembers, dataset.currentUser.id, dataset.currentUser.email]);

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
    activeGroup.members.find((m) => m.id === id)?.displayName ?? 'Former member';
  const upiChangedBy = useMemo(() => {
    const latest = new Map<string, { at: string; actor: string }>();
    for (const a of dataset.groupActivityLog) {
      if (a.action !== 'upi_changed' || a.groupId !== activeGroup.id) continue;
      const prev = latest.get(a.entityId);
      if (!prev || a.createdAt > prev.at) latest.set(a.entityId, { at: a.createdAt, actor: actorLabel(a) });
    }
    return new Map([...latest].map(([id, v]) => [id, v.actor]));
  }, [dataset.groupActivityLog, activeGroup.id]);

  const isFormerMember = (id: string) => !currentMembers.some((m) => m.id === id);

  const canChangeCurrency = isGroupAdmin(activeGroup);

  const fxQuote = showCurrencyChanger ? getFxQuote(activeGroup.baseCurrency, targetCurrency) : null;
  const inputLocale = typeof navigator !== 'undefined' ? navigator.language : undefined;
  const typedRateScaled = parseFxRateToScaled(customFxRateInput, inputLocale);
  const rateInvalid = currencyChangeMode === 'reconvert' && rateEdited && typedRateScaled <= 0;

  const selectTargetCurrency = (code: string) => {
    setTargetCurrency(code);
    const quote = getFxQuote(activeGroup.baseCurrency, code);
    setCustomFxRateInput(quote ? toLocaleDecimalInput(formatScaledFxRate(quote.rateScaled), inputLocale) : '');
    setRateEdited(false);
  };

  const handleOpenCurrencyChanger = () => {
    selectTargetCurrency(activeGroup.baseCurrency === 'INR' ? 'USD' : 'INR');
    setShowCurrencyChanger((prev) => !prev);
  };

  const handleConfirmCurrencyChange = () => {
    if (rateInvalid) return;
    changeGroupBaseCurrency(
      activeGroup.id,
      targetCurrency,
      currencyChangeMode,
      rateEdited ? formatScaledFxRate(typedRateScaled) : undefined
    );
    setShowCurrencyChanger(false);
  };

  const handleCreateGroupSubmit = (e: React.SyntheticEvent<HTMLFormElement>) => {
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

  const handleAddMemberSubmit = (e: React.SyntheticEvent<HTMLFormElement>) => {
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

  const baseMeta = getCurrency(activeGroup.baseCurrency);
  const minorUnitName =
    baseMeta.decimals === 0 ? 'unit' : baseMeta.decimals === 3 ? 'fils' : 'paisa/cent';

  return (
    <div className="space-y-6 min-w-0">
      {/* Top Group Switcher Pill Strip (Ombria Horizontal Room Selector) */}
      <div
        data-testid="group-switcher-bar"
        className="flex flex-wrap items-center justify-between gap-2.5 min-w-0"
      >
        <div className="flex flex-wrap items-center gap-2 min-w-0 max-w-full">
          {activeGroups.map((grp) => {
            const isSelected = grp.id === activeGroup.id;
            return (
              <button
                key={grp.id}
                type="button"
                data-testid={`group-select-${grp.id}`}
                onClick={() => setActiveGroupId(grp.id)}
                title={grp.name}
                className={`min-h-[44px] min-w-[44px] max-w-full inline-flex items-center gap-2 rounded-full px-4 py-2 text-xs font-semibold tracking-tight cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 ${
                  isSelected
                    ? 'lg-luminous-pill'
                    : 'lg-scene-tile text-[#141715] dark:text-[#F3F5F3]'
                }`}
              >
                <span dir="auto" className="truncate max-w-[11rem] sm:max-w-[15rem]">
                  {grp.name}
                </span>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 font-mono tabular-nums text-[10px] font-semibold ${
                    isSelected
                      ? 'bg-black/12 dark:bg-black/15 text-inherit'
                      : 'lg-recessed-well text-[#4A524D] dark:text-[#B7BEB9]'
                  }`}
                >
                  {grp.baseCurrency}
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="join-group-btn"
            aria-expanded={showJoin}
            onClick={() => setShowJoin((prev) => !prev)}
            className={BTN_GHOST}
          >
            <SignIn className="w-4 h-4 text-emerald-700 dark:text-emerald-300" weight="bold" aria-hidden="true" />
            <span>Join Group</span>
          </button>
          <button
            type="button"
            data-testid="create-group-btn"
            onClick={() => setShowCreateGroup((prev) => !prev)}
            className={BTN_GHOST}
          >
            <Plus className="w-4 h-4 text-emerald-700 dark:text-emerald-300" weight="bold" aria-hidden="true" />
            <span>New Group</span>
          </button>
        </div>
      </div>

      {showJoin && (
        <DoubleBezelCard testId="join-group-panel" className="min-w-0" innerClassName="space-y-3 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold tracking-tight text-[#141715] dark:text-[#F3F5F3]">
              Join a group
            </h3>
            <button
              type="button"
              onClick={() => setShowJoin(false)}
              aria-label="Close join group panel"
              className="lg-icon-orb min-h-[44px] min-w-[44px] rounded-full inline-flex items-center justify-center text-[#4A524D] dark:text-[#B7BEB9] hover:text-[#141715] dark:hover:text-[#F3F5F3] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
            >
              <X className="w-4 h-4" weight="bold" aria-hidden="true" />
            </button>
          </div>
          <p className="text-xs text-[#5C6660] dark:text-[#9CA69F]">
            Ask someone in the group for the invite link or code, then paste it here.
          </p>
          <JoinGroupForm onJoined={() => setShowJoin(false)} />
        </DoubleBezelCard>
      )}

      {/* Create New Group Inline Drawer */}
      {showCreateGroup && (
        <DoubleBezelCard className="min-w-0" innerClassName="space-y-4 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold tracking-tight text-[#141715] dark:text-[#F3F5F3]">
              Create New Shared Group Ledger
            </h3>
            <button
              type="button"
              onClick={() => setShowCreateGroup(false)}
              aria-label="Close new group drawer"
              className="lg-icon-orb min-h-[44px] min-w-[44px] rounded-full inline-flex items-center justify-center text-[#4A524D] dark:text-[#B7BEB9] hover:text-[#141715] dark:hover:text-[#F3F5F3] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
            >
              <X className="w-4 h-4" weight="bold" aria-hidden="true" />
            </button>
          </div>
          <form
            onSubmit={handleCreateGroupSubmit}
            className="grid grid-cols-1 sm:grid-cols-12 gap-3"
          >
            <div className="sm:col-span-4 min-w-0">
              <label className={GLASS_LABEL}>
                Group Name
              </label>
              <input
                type="text"
                data-testid="group-name-input"
                maxLength={LIMITS.groupName}
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                placeholder="e.g., Manali Ski Trip 2026"
                className={GLASS_INPUT}
              />
            </div>
            <div className="sm:col-span-3 min-w-0">
              <label className={GLASS_LABEL}>
                Base Currency
              </label>
              <select
                data-testid="group-currency-select"
                value={newGroupCurrency}
                onChange={(e) => setNewGroupCurrency(e.target.value)}
                className={`${GLASS_INPUT} font-mono`}
              >
                {allCurrencyOptions.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.code} - {c.name} ({c.symbol})
                  </option>
                ))}
              </select>
            </div>
            <div className="sm:col-span-3 min-w-0">
              <label className={GLASS_LABEL}>
                Description
              </label>
              <input
                type="text"
                value={newGroupDesc}
                maxLength={LIMITS.groupDescription}
                onChange={(e) => setNewGroupDesc(e.target.value)}
                placeholder="Villas, flights, and shared meals"
                className={GLASS_INPUT}
              />
            </div>
            <div className="sm:col-span-2 flex items-end">
              <button
                type="submit"
                data-testid="save-group-btn"
                className={`${BTN_PRIMARY} w-full`}
              >
                Create Group
              </button>
            </div>
          </form>
        </DoubleBezelCard>
      )}

      {activeGroups.length === 0 ? (
        <DoubleBezelCard
          testId="no-groups-empty-state"
          className="min-w-0"
          innerClassName="text-center py-10 space-y-3.5 min-w-0"
        >
          <span className="lg-icon-orb h-12 w-12 rounded-full flex items-center justify-center mx-auto">
            <Users className="w-6 h-6 text-emerald-700 dark:text-emerald-300" weight="duotone" aria-hidden="true" />
          </span>
          <div className="text-sm sm:text-base font-semibold tracking-tight text-[#141715] dark:text-[#F3F5F3]">
            You have no groups yet
          </div>
          <p className="text-xs text-[#5C6660] dark:text-[#9CA69F] max-w-md mx-auto">
            Create a group for a trip, a flat or any shared plan, then add friends by name and log your first bill.
          </p>
          <button
            type="button"
            data-testid="no-groups-create-group-btn"
            onClick={() => setShowCreateGroup(true)}
            className={BTN_PRIMARY}
          >
            <Plus className="w-4 h-4" weight="bold" aria-hidden="true" />
            <span>Create a group</span>
          </button>
        </DoubleBezelCard>
      ) : (
      <>
      {/* Group Workspace Spatial Header Card */}
      <DoubleBezelCard className="min-w-0" innerClassName="space-y-4 min-w-0">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 min-w-0">
          <div className="space-y-1.5 min-w-0">
            <div className="flex flex-wrap items-center gap-2 min-w-0">
              <StatusBadge tone="emerald">{activeGroup.category.toUpperCase()}</StatusBadge>
              <CurrencyPrecisionPill currencyCode={activeGroup.baseCurrency} />
              {activeGroup.inviteCode && (
                <StatusBadge tone="slate" className="max-w-full">
                  <span className="truncate font-mono">Invite: {activeGroup.inviteCode}</span>
                </StatusBadge>
              )}
              {activeGroup.defaultSplitConfig && (
                <StatusBadge tone="blue">
                  <Sparkle className="w-3 h-3" weight="fill" aria-hidden="true" />
                  <span>Preset: {activeGroup.defaultSplitConfig.label}</span>
                </StatusBadge>
              )}
            </div>
            <h1
              dir="auto"
              title={activeGroup.name}
              data-testid="group-title"
              className="truncate text-xl sm:text-2xl lg:text-[28px] font-semibold tracking-tight leading-tight text-[#141715] dark:text-[#F3F5F3]"
            >
              {activeGroup.name}
            </h1>
            <p
              dir="auto"
              className="text-xs sm:text-sm text-[#4A524D] dark:text-[#B7BEB9] line-clamp-2 break-words [overflow-wrap:anywhere]"
            >
              {activeGroup.description}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 min-w-0">
            {/* Add Expense Primary CTA */}
            <button
              type="button"
              data-testid="add-expense-btn"
              onClick={() => {
                setEditingExpense(null);
                setIsExpenseModalOpen(true);
              }}
              className={`${BTN_PRIMARY} px-4 py-2.5 sm:text-[13px]`}
            >
              <Plus className="w-4 h-4 shrink-0" weight="bold" aria-hidden="true" />
              <span>Add Expense</span>
            </button>

            {/* Add Member Trigger */}
            <button
              type="button"
              data-testid="add-member-btn"
              onClick={() => setShowAddMember((prev) => !prev)}
              className={BTN_GHOST}
            >
              <UserPlus className="w-4 h-4 shrink-0 text-emerald-700 dark:text-emerald-300" weight="bold" aria-hidden="true" />
              <span>Add Member</span>
            </button>

            <button
              type="button"
              data-testid="invite-btn"
              aria-expanded={showInvite}
              onClick={() => setShowInvite((prev) => !prev)}
              className={BTN_GHOST}
            >
              <ShareNetwork className="w-4 h-4 shrink-0 text-emerald-700 dark:text-emerald-300" weight="bold" aria-hidden="true" />
              <span>Invite</span>
            </button>

            {/* Smart Debt Simplification Toggle */}
            <button
              type="button"
              data-testid="toggle-simplify-debts-btn"
              onClick={() => toggleGroupSimplifyDebts(activeGroup.id)}
              title="Minimize total payments across group members or keep 1-on-1 pairwise balances"
              className={`${BTN} lg-scene-tile ${
                activeGroup.simplifyDebts
                  ? 'text-emerald-800 dark:text-emerald-200 ring-1 ring-emerald-600/25 dark:ring-emerald-300/25'
                  : 'text-amber-900 dark:text-amber-200 ring-1 ring-amber-600/30 dark:ring-amber-300/28'
              }`}
            >
              <Lightning
                className={`w-4 h-4 shrink-0 ${
                  activeGroup.simplifyDebts
                    ? 'text-emerald-700 dark:text-emerald-300'
                    : 'text-amber-700 dark:text-amber-300'
                }`}
                weight="fill"
                aria-hidden="true"
              />
              <span>
                {activeGroup.simplifyDebts
                  ? 'Simplify Debts: ON'
                  : 'Simplify Debts: OFF'}
              </span>
            </button>

            {/* Change Base Currency Trigger */}
            <button
              type="button"
              data-testid="change-group-currency-btn"
              onClick={handleOpenCurrencyChanger}
              disabled={!canChangeCurrency}
              aria-describedby={canChangeCurrency ? undefined : 'currency-admin-only-hint'}
              className={BTN_GHOST}
            >
              <ArrowsLeftRight className="w-4 h-4 shrink-0 text-emerald-700 dark:text-emerald-300" weight="bold" aria-hidden="true" />
              <span>Currency ({activeGroup.baseCurrency})</span>
            </button>
            {!canChangeCurrency && (
              <span
                id="currency-admin-only-hint"
                data-testid="currency-admin-only-hint"
                className="text-[11px] text-[#5C6660] dark:text-[#9CA69F]"
              >
                Only a group admin can change the currency
              </span>
            )}
          </div>
        </div>

        {/* Inline Base Currency Switcher (Mode A: Re-label vs Mode B: Re-convert) */}
        {showCurrencyChanger && canChangeCurrency && (
          <div className="lg-recessed-well rounded-[20px] p-4 space-y-3.5 ring-1 ring-emerald-600/25 dark:ring-emerald-300/22 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-emerald-800 dark:text-emerald-300">
                Change Group Base Currency ({activeGroup.baseCurrency} to {targetCurrency})
              </div>
              <button
                type="button"
                onClick={() => setShowCurrencyChanger(false)}
                aria-label="Close currency changer drawer"
                className="lg-icon-orb min-h-[44px] min-w-[44px] rounded-full inline-flex items-center justify-center text-[#4A524D] dark:text-[#B7BEB9] hover:text-[#141715] dark:hover:text-[#F3F5F3] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
              >
                <X className="w-4 h-4" weight="bold" aria-hidden="true" />
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
              <div className="md:col-span-3 min-w-0">
                <label className={GLASS_LABEL}>
                  New Base Currency
                </label>
                <select
                  data-testid="change-currency-target-select"
                  value={targetCurrency}
                  onChange={(e) => selectTargetCurrency(e.target.value)}
                  className={`${GLASS_INPUT} font-mono`}
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

              <div className="md:col-span-6 grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <button
                  type="button"
                  onClick={() => setCurrencyChangeMode('relabel')}
                  className={`min-h-[44px] min-w-[44px] rounded-2xl p-3 text-left text-xs cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 ${
                    currencyChangeMode === 'relabel'
                      ? 'lg-luminous-pill font-semibold'
                      : 'lg-scene-tile text-[#141715] dark:text-[#F3F5F3]'
                  }`}
                >
                  <div>Mode A: Re-label symbol only</div>
                  <div
                    className={`mt-0.5 text-[10px] ${
                      currencyChangeMode === 'relabel'
                        ? 'opacity-75'
                        : 'text-[#5C6660] dark:text-[#9CA69F]'
                    }`}
                  >
                    Preserves major numeric values (scales minor units if decimals differ)
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => setCurrencyChangeMode('reconvert')}
                  className={`min-h-[44px] min-w-[44px] rounded-2xl p-3 text-left text-xs cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 ${
                    currencyChangeMode === 'reconvert'
                      ? 'lg-luminous-pill font-semibold'
                      : 'lg-scene-tile text-[#141715] dark:text-[#F3F5F3]'
                  }`}
                >
                  <div>Mode B: Convert existing bills via FX rate</div>
                  <div
                    className={`mt-0.5 text-[10px] ${
                      currencyChangeMode === 'reconvert'
                        ? 'opacity-75'
                        : 'text-[#5C6660] dark:text-[#9CA69F]'
                    }`}
                  >
                    Multiplies all active expenses &amp; settlements by FX rate
                  </div>
                </button>
              </div>

              <div className="md:col-span-3 flex flex-wrap items-center gap-2">
                {currencyChangeMode === 'reconvert' && (
                  <input
                    type="text"
                    inputMode="decimal"
                    data-testid="currency-change-rate-input"
                    aria-label={`1 ${activeGroup.baseCurrency} in ${targetCurrency}`}
                    aria-describedby="currency-rate-status"
                    aria-required={!fxQuote}
                    aria-invalid={rateInvalid}
                    value={customFxRateInput}
                    placeholder="Type a rate"
                    onChange={(e) => {
                      setCustomFxRateInput(e.target.value);
                      setRateEdited(true);
                    }}
                    className="lg-recessed-well min-h-[44px] w-28 rounded-2xl px-3 py-2 font-mono tabular-nums text-xs text-[#141715] dark:text-[#F3F5F3] placeholder:text-[#68726C] dark:placeholder:text-[#8A938D] focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
                  />
                )}
                <button
                  type="button"
                  data-testid="confirm-currency-change-btn"
                  onClick={handleConfirmCurrencyChange}
                  disabled={rateInvalid}
                  className={`${BTN_PRIMARY} flex-1`}
                >
                  Confirm Change
                </button>
                {currencyChangeMode === 'reconvert' && (
                  <span
                    id="currency-rate-status"
                    data-testid="currency-rate-status"
                    className="basis-full text-[11px] text-[#5C6660] dark:text-[#9CA69F]"
                  >
                    {rateInvalid
                      ? 'That rate is not a valid number above zero.'
                      : rateEdited
                      ? 'Your rate. It is saved on every converted bill.'
                      : fxQuote
                        ? `${fxQuote.status === 'live' ? 'Live rate' : 'Saved offline rate'} from ${fxQuote.rateDate}`
                        : `No rate known for ${activeGroup.baseCurrency} to ${targetCurrency}. Type one to convert.`}
                  </span>
                )}
              </div>
            </div>
          </div>
        )}

        {showInvite && <InvitePanel group={activeGroup} isAdmin={isGroupAdmin(activeGroup)} />}

        {/* Inline Add Member Form */}
        {showAddMember && (
          <form
            onSubmit={handleAddMemberSubmit}
            className="lg-recessed-well rounded-[20px] p-4 grid grid-cols-1 sm:grid-cols-12 gap-3 items-end min-w-0"
          >
            <div className="sm:col-span-4 min-w-0">
              <label className={GLASS_LABEL}>
                Member Display Name
              </label>
              <input
                type="text"
                data-testid="member-name-input"
                maxLength={LIMITS.personName}
                value={memberNameInput}
                onChange={(e) => setMemberNameInput(e.target.value)}
                placeholder="e.g., Ananya Rao"
                className={GLASS_INPUT}
              />
            </div>
            <div className="sm:col-span-3 min-w-0">
              <label className={GLASS_LABEL}>
                Google Email (Optional Invite)
              </label>
              <input
                type="email"
                data-testid="member-email-input"
                maxLength={LIMITS.email}
                value={memberEmailInput}
                onChange={(e) => setMemberEmailInput(e.target.value)}
                placeholder="friend@example.com"
                className={GLASS_INPUT}
              />
            </div>
            <div className="sm:col-span-3 min-w-0">
              <label className={GLASS_LABEL}>
                UPI ID (Optional)
              </label>
              <input
                type="text"
                data-testid="member-upi-input"
                maxLength={LIMITS.upiId}
                value={memberUpiInput}
                onChange={(e) => setMemberUpiInput(e.target.value)}
                placeholder="ananya@upi.test"
                className={`${GLASS_INPUT} font-mono`}
              />
            </div>
            <div className="sm:col-span-2">
              <button
                type="submit"
                data-testid="save-member-btn"
                className={`${BTN_PRIMARY} w-full`}
              >
                Save Member
              </button>
            </div>
          </form>
        )}

        {/* Progressive Disclosure: Minimal Group Insights Bar (4 Sculpted Recessed Glass Tiles) */}
        <div
          data-testid="group-minimal-insights-bar"
          className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 pt-2 border-t border-black/[0.07] dark:border-white/[0.08] min-w-0"
        >
          <div className="lg-recessed-well rounded-[20px] px-4 py-3 min-w-0 flex flex-col justify-between">
            <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[#5C6660] dark:text-[#9CA69F] truncate">
              Group Total Spend
            </div>
            <div className="mt-1.5 text-sm sm:text-base font-semibold font-mono tabular-nums text-[#141715] dark:text-[#F3F5F3] whitespace-nowrap">
              <CurrencyAmount
                minorAmount={totalGroupSpendMinor}
                currencyCode={activeGroup.baseCurrency}
              />
            </div>
          </div>

          <div className="lg-recessed-well rounded-[20px] px-4 py-3 min-w-0 flex flex-col justify-between">
            <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[#5C6660] dark:text-[#9CA69F] truncate">
              Your Share
            </div>
            <div className="mt-1.5 text-sm sm:text-base font-semibold font-mono tabular-nums text-[#141715] dark:text-[#F3F5F3] whitespace-nowrap">
              <CurrencyAmount
                minorAmount={myGroupShareMinor}
                currencyCode={activeGroup.baseCurrency}
              />
            </div>
          </div>

          <div className="lg-recessed-well rounded-[20px] px-4 py-3 min-w-0 flex flex-col justify-between">
            <div className="flex items-center justify-between gap-2 min-w-0">
              <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[#5C6660] dark:text-[#9CA69F] truncate">
                Your Net Position
              </span>
              <span
                className={`shrink-0 text-[11px] font-semibold ${
                  myGroupNetPositionMinor > 0
                    ? 'text-emerald-700 dark:text-emerald-300'
                    : myGroupNetPositionMinor < 0
                    ? 'text-rose-700 dark:text-rose-300'
                    : 'text-[#68726C] dark:text-[#8A938D]'
                }`}
              >
                {myGroupNetPositionMinor > 0
                  ? 'you are owed'
                  : myGroupNetPositionMinor < 0
                  ? 'you owe'
                  : 'settled up'}
              </span>
            </div>
            <div className="mt-1.5 text-sm sm:text-base font-semibold font-mono tabular-nums whitespace-nowrap">
              <CurrencyAmount
                minorAmount={myGroupNetPositionMinor}
                currencyCode={activeGroup.baseCurrency}
                colorize
                showPlusSign
              />
            </div>
          </div>

          <div className="lg-recessed-well rounded-[20px] px-4 py-3 min-w-0 flex flex-col justify-between">
            <div className="flex items-center justify-between gap-2 min-w-0">
              <span className="min-w-0 truncate text-[11px] font-semibold uppercase tracking-[0.06em] text-[#5C6660] dark:text-[#9CA69F]">
                Top Category ({groupExpenses.length})
              </span>
              <button
                type="button"
                onClick={() => setActivePage('analytics')}
                className="min-h-[44px] min-w-[44px] sm:min-h-[28px] inline-flex items-center justify-end gap-1 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300 hover:underline cursor-pointer shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 rounded-lg"
              >
                <span>See Charts</span>
                <ArrowRight className="w-3 h-3 shrink-0" weight="bold" aria-hidden="true" />
              </button>
            </div>
            <div className="mt-1 space-y-0.5 min-w-0">
              <div className="text-xs font-medium text-[#4A524D] dark:text-[#B7BEB9] truncate">
                {topSpendCategory.label}
              </div>
              <div className="text-xs sm:text-sm font-semibold font-mono tabular-nums text-[#141715] dark:text-[#F3F5F3] whitespace-nowrap">
                <CurrencyAmount
                  minorAmount={topSpendCategory.amountMinor}
                  currencyCode={activeGroup.baseCurrency}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Automatic User Guidance Strip */}
        <div
          data-testid="group-auto-guide-strip"
          className={`lg-recessed-well flex flex-wrap items-center justify-between gap-3 rounded-[20px] px-4 py-3 text-xs font-medium min-w-0 ${
            conflictedExpenses.length > 0
              ? 'ring-1 ring-amber-600/35 dark:ring-amber-300/30 text-amber-900 dark:text-amber-200'
              : suggestedTransfers.length > 0
              ? 'ring-1 ring-sky-600/25 dark:ring-sky-300/25 text-[#141715] dark:text-[#F3F5F3]'
              : 'ring-1 ring-emerald-600/25 dark:ring-emerald-300/25 text-emerald-900 dark:text-emerald-200'
          }`}
        >
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <span className="lg-icon-orb h-8 w-8 rounded-full flex items-center justify-center shrink-0">
              {conflictedExpenses.length > 0 ? (
                <Warning className="w-4 h-4 text-amber-700 dark:text-amber-300" weight="fill" aria-hidden="true" />
              ) : suggestedTransfers.length > 0 ? (
                <Scales className="w-4 h-4 text-sky-700 dark:text-sky-300" weight="duotone" aria-hidden="true" />
              ) : (
                <CheckCircle
                  className="w-4 h-4 text-emerald-700 dark:text-emerald-300"
                  weight="fill"
                  aria-hidden="true"
                />
              )}
            </span>
            <span className="min-w-0 break-words">
              {conflictedExpenses.length > 0
                ? 'Needs your review: Two offline edits were made on a bill below - pick which version to keep.'
                : suggestedTransfers.length > 0
                ? "Balances active: Tap 'Explain Balance' on any person to see the math, or settle up in one tap."
                : "All settled up at 0.00! Tap 'Add Expense' whenever your next shared bill comes up."}
            </span>
          </div>
          {suggestedTransfers.length > 0 ? (
            <button
              type="button"
              onClick={() => setActivePage('friends')}
              className={BTN_GHOST}
            >
              <span>Open UPI / WhatsApp Settle</span>
              <ArrowRight className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-300" weight="bold" aria-hidden="true" />
            </button>
          ) : (
            <span className="font-mono text-[11px] text-[#5C6660] dark:text-[#9CA69F] truncate max-w-full">
              {activeGroup.name} ({activeGroup.baseCurrency})
            </span>
          )}
        </div>
      </DoubleBezelCard>

      {/* Concurrent Offline Conflict Resolution Banner */}
      {conflictedExpenses.map((exp) => {
        const activeRev = dataset.expenseRevisions.find((r) => r.id === exp.currentRevisionId);
        const conflictRev = dataset.expenseRevisions.find((r) => r.id === exp.conflictRevisionId);

        return (
          <DoubleBezelCard
            key={exp.id}
            testId="conflict-resolution-banner"
            className="ring-1 ring-amber-500/40 min-w-0"
            innerClassName="space-y-4 min-w-0"
          >
            <div className="flex flex-wrap items-start justify-between gap-3 min-w-0">
              <div className="space-y-1.5 min-w-0">
                <div className="flex flex-wrap items-center gap-2 min-w-0">
                  <StatusBadge tone="amber" className="max-w-full">
                    <Warning className="w-3.5 h-3.5 shrink-0" weight="fill" aria-hidden="true" />
                    <span className="truncate">Review Offline Edit on &quot;{exp.title}&quot;</span>
                  </StatusBadge>
                </div>
                <p className="text-xs text-[#4A524D] dark:text-[#B7BEB9]">
                  Two group members edited this bill while offline. Nothing was lost - both versions are saved in edit history. Choose which version should count toward group balances:
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 min-w-0">
              {/* Active Revision Card */}
              <div className="lg-recessed-well rounded-[20px] ring-1 ring-emerald-600/28 dark:ring-emerald-300/25 p-4 space-y-3 flex flex-col justify-between min-w-0">
                <div className="space-y-1.5 min-w-0">
                  <div className="flex items-center justify-between gap-2 min-w-0">
                    <StatusBadge tone="emerald" className="max-w-full">
                      <span className="truncate">
                        Current Version ({activeRev ? actorLabel(activeRev) : 'Latest'})
                      </span>
                    </StatusBadge>
                    <span className="shrink-0 font-mono text-[11px] text-[#5C6660] dark:text-[#9CA69F]">
                      v{activeRev?.revisionNumber ?? exp.revisionNumber}
                    </span>
                  </div>
                  <div
                    dir="auto"
                    className="text-sm font-semibold text-[#141715] dark:text-[#F3F5F3] break-words [overflow-wrap:anywhere]"
                  >
                    {activeRev?.snapshot.title ?? exp.title}
                  </div>
                  <div className="text-base font-semibold font-mono tabular-nums text-emerald-700 dark:text-emerald-300">
                    <CurrencyAmount
                      minorAmount={activeRev?.snapshot.amountMinor ?? exp.amountMinor}
                      currencyCode={activeRev?.snapshot.groupCurrency ?? exp.groupCurrency}
                    />{' '}
                    <span className="text-xs font-sans font-normal text-[#5C6660] dark:text-[#9CA69F]">
                      ({(activeRev?.snapshot.splitMode ?? exp.splitMode).toUpperCase()} split)
                    </span>
                  </div>
                  <p
                    dir="auto"
                    className="text-xs text-[#4A524D] dark:text-[#B7BEB9] break-words [overflow-wrap:anywhere]"
                  >
                    {activeRev?.snapshot.notes ?? exp.notes}
                  </p>
                </div>

                <button
                  type="button"
                  data-testid="keep-active-revision-btn"
                  onClick={() => resolveExpenseConflict(exp.id, exp.currentRevisionId)}
                  className={`${BTN_PRIMARY} mt-2 w-full`}
                >
                  <CheckCircle className="w-4 h-4 shrink-0" weight="bold" aria-hidden="true" />
                  <span className="truncate">
                    Keep {activeRev ? actorLabel(activeRev) : 'Active'}&apos;s Version (
                    {formatMinorToMajor(
                      activeRev?.snapshot.amountMinor ?? exp.amountMinor,
                      activeRev?.snapshot.groupCurrency ?? exp.groupCurrency
                    )}
                    )
                  </span>
                </button>
              </div>

              {/* Conflicting Branch Revision Card */}
              {conflictRev && (
                <div className="lg-recessed-well rounded-[20px] ring-1 ring-amber-600/30 dark:ring-amber-300/28 p-4 space-y-3 flex flex-col justify-between min-w-0">
                  <div className="space-y-1.5 min-w-0">
                    <div className="flex items-center justify-between gap-2 min-w-0">
                      <StatusBadge tone="amber" className="max-w-full">
                        <span className="truncate">
                          Other Offline Edit ({actorLabel(conflictRev)})
                        </span>
                      </StatusBadge>
                      <span className="shrink-0 font-mono text-[11px] text-[#5C6660] dark:text-[#9CA69F]">
                        v{conflictRev.revisionNumber}
                      </span>
                    </div>
                    <div
                      dir="auto"
                      className="text-sm font-semibold text-[#141715] dark:text-[#F3F5F3] break-words [overflow-wrap:anywhere]"
                    >
                      {conflictRev.snapshot.title}
                    </div>
                    <div className="text-base font-semibold font-mono tabular-nums text-amber-800 dark:text-amber-300">
                      <CurrencyAmount
                        minorAmount={conflictRev.snapshot.amountMinor}
                        currencyCode={conflictRev.snapshot.groupCurrency ?? exp.groupCurrency}
                      />{' '}
                      <span className="text-xs font-sans font-normal text-[#5C6660] dark:text-[#9CA69F]">
                        ({conflictRev.snapshot.splitMode.toUpperCase()} split)
                      </span>
                    </div>
                    <p
                      dir="auto"
                      className="text-xs text-[#4A524D] dark:text-[#B7BEB9] break-words [overflow-wrap:anywhere]"
                    >
                      {conflictRev.snapshot.notes}
                    </p>
                  </div>

                  <button
                    type="button"
                    data-testid="keep-conflict-revision-btn"
                    onClick={() => resolveExpenseConflict(exp.id, conflictRev.id)}
                    className={`${BTN} mt-2 w-full border border-amber-600/35 dark:border-amber-300/30 bg-amber-500/15 dark:bg-amber-400/16 hover:bg-amber-500/22 dark:hover:bg-amber-400/24 text-amber-900 dark:text-amber-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]`}
                  >
                    <GitDiff className="w-4 h-4 shrink-0" weight="bold" aria-hidden="true" />
                    <span className="truncate">
                      Use {actorLabel(conflictRev)}&apos;s Version (
                      {formatMinorToMajor(
                        conflictRev.snapshot.amountMinor,
                        conflictRev.snapshot.groupCurrency ?? exp.groupCurrency
                      )}
                      )
                    </span>
                  </button>
                </div>
              )}
            </div>
          </DoubleBezelCard>
        );
      })}

      {/* Main 12-Column Responsive Bento Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start min-w-0">
        {/* Left/Top Column: Group Members & Suggested Repayments */}
        <div className="lg:col-span-5 space-y-5 min-w-0">
          {/* Members & Net Balances Card */}
          <DoubleBezelCard className="min-w-0" innerClassName="space-y-4 min-w-0">
            <div className="flex flex-wrap items-center justify-between gap-2 min-w-0">
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="lg-icon-orb h-8 w-8 rounded-full flex items-center justify-center shrink-0">
                  <Users className="w-4 h-4 text-emerald-700 dark:text-emerald-300" weight="duotone" aria-hidden="true" />
                </span>
                <h2 className="text-sm font-semibold tracking-tight text-[#141715] dark:text-[#F3F5F3]">
                  Group Members ({currentMembers.length})
                </h2>
              </div>
              <span className="text-xs font-mono tabular-nums text-[#5C6660] dark:text-[#9CA69F]">
                Total Spend:{' '}
                <CurrencyAmount
                  minorAmount={totalGroupSpendMinor}
                  currencyCode={activeGroup.baseCurrency}
                  className="font-semibold text-[#141715] dark:text-[#F3F5F3]"
                />
              </span>
            </div>

            <div className="space-y-2.5 min-w-0">
              {currentMembers.map((member) => {
                const netMinor = netBalances.get(member.id) ?? 0;
                const isClaimed = member.userId !== null;

                return (
                  <div
                    key={member.id}
                    className="lg-recessed-well rounded-2xl p-3.5 space-y-2.5 min-w-0"
                  >
                    <div className="flex items-start justify-between gap-2 min-w-0">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span className="lg-icon-orb inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-emerald-800 dark:text-emerald-300 font-mono font-semibold text-xs">
                          {member.avatarInitials}
                        </span>
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                            <span
                              dir="auto"
                              title={member.displayName}
                              className="truncate max-w-[11rem] sm:max-w-[14rem] text-sm font-bold text-[#141715] dark:text-[#F3F5F3]"
                            >
                              {member.displayName}
                            </span>
                            {member.role === 'admin' && <StatusBadge tone="blue">Admin</StatusBadge>}
                            {isClaimed ? (
                              <StatusBadge tone="emerald">
                                <ShieldCheck className="w-3 h-3" weight="fill" aria-hidden="true" />
                                <span>Joined</span>
                              </StatusBadge>
                            ) : (
                              <StatusBadge tone="amber">Invite Pending</StatusBadge>
                            )}
                          </div>
                          <div
                            className="text-[11px] font-mono text-[#5C6660] dark:text-[#9CA69F] truncate"
                            title={member.invitedEmail ?? undefined}
                          >
                            {member.invitedEmail ?? 'Added by name'}
                            {member.upiId ? ` • UPI: ${member.upiId}` : ''}
                          </div>
                          {!member.userId && upiChangedBy.get(member.id) && (
                            <div
                              data-testid={`member-upi-changed-${member.id}`}
                              className="text-[11px] font-semibold text-amber-800 dark:text-amber-300 truncate"
                            >
                              UPI changed by <span dir="auto">{upiChangedBy.get(member.id)}</span>
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="text-right shrink-0">
                        <div className="text-sm font-extrabold font-mono tabular-nums whitespace-nowrap">
                          <CurrencyAmount
                            minorAmount={netMinor}
                            currencyCode={activeGroup.baseCurrency}
                            colorize
                            showPlusSign
                          />
                        </div>
                        <div
                          className={`text-[10px] font-medium ${
                            netMinor > 0
                              ? 'text-emerald-700 dark:text-emerald-300'
                              : netMinor < 0
                              ? 'text-rose-700 dark:text-rose-300'
                              : 'text-[#68726C] dark:text-[#8A938D]'
                          }`}
                        >
                          {netMinor > 0
                            ? 'gets back'
                            : netMinor < 0
                            ? 'owes'
                            : 'settled up'}
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-black/[0.07] dark:border-white/[0.08]">
                      <button
                        type="button"
                        data-testid="explain-balance-btn"
                        onClick={() => setExplainMemberId(member.id)}
                        className="lg-scene-tile min-h-[44px] min-w-[44px] inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-semibold text-[#141715] dark:text-[#F3F5F3] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
                      >
                        <Calculator className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-300" aria-hidden="true" />
                        <span>Explain Balance</span>
                      </button>

                      {currentUserMember && <MemberUpiEditor group={activeGroup} member={member} />}
                      {isGroupAdmin(activeGroup) && (
                        <MemberAdminActions group={activeGroup} member={member} netMinor={netMinor} />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {formerMembers.length > 0 && (
              <details
                data-testid="former-members"
                className="ws-disclosure lg-recessed-well rounded-2xl min-w-0"
              >
                <summary className="min-h-[44px] flex items-center px-3.5 text-xs font-semibold text-[#4A524D] dark:text-[#B7BEB9]">
                  Former members ({formerMembers.length})
                </summary>
                <div className="space-y-2 px-3.5 pb-3.5">
                  {formerMembers.map((member) => {
                    const netMinor = netBalances.get(member.id) ?? 0;
                    return (
                      <div key={member.id} className="flex items-center justify-between gap-2 min-w-0">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span
                            dir="auto"
                            title={member.displayName}
                            className="truncate text-xs font-semibold text-[#2B312D] dark:text-[#DCE2DD]"
                          >
                            {member.displayName}
                          </span>
                          <StatusBadge tone="slate" className="shrink-0">
                            Former member
                          </StatusBadge>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-xs font-mono tabular-nums whitespace-nowrap">
                            <CurrencyAmount
                              minorAmount={netMinor}
                              currencyCode={activeGroup.baseCurrency}
                              colorize
                              showPlusSign
                            />
                          </span>
                          <button
                            type="button"
                            onClick={() => setExplainMemberId(member.id)}
                            aria-label={`Explain balance for ${member.displayName}`}
                            className="lg-icon-orb min-h-[44px] min-w-[44px] rounded-full inline-flex items-center justify-center text-[#4A524D] dark:text-[#B7BEB9] hover:text-emerald-700 dark:hover:text-emerald-300 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
                          >
                            <Calculator className="w-4 h-4" aria-hidden="true" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </details>
            )}

            <details
              data-testid="group-settings"
              className="ws-disclosure lg-recessed-well rounded-2xl min-w-0"
            >
              <summary className="min-h-[44px] flex items-center gap-2 px-3.5 text-xs font-semibold text-[#4A524D] dark:text-[#B7BEB9]">
                <GearSix className="w-4 h-4 text-emerald-700 dark:text-emerald-300" aria-hidden="true" />
                <span>Group settings</span>
              </summary>
              <div className="px-3.5 pb-3.5">
                <GroupDangerZone
                  group={activeGroup}
                  isAdmin={isGroupAdmin(activeGroup)}
                  myNetMinor={myGroupNetPositionMinor}
                />
              </div>
            </details>
          </DoubleBezelCard>

          {/* Suggested Repayments Card */}
          <DoubleBezelCard className="min-w-0" innerClassName="space-y-4 min-w-0">
            <div className="flex flex-wrap items-center justify-between gap-2 min-w-0">
              <div className="flex items-center gap-2.5 min-w-0">
                <span className="lg-icon-orb h-8 w-8 rounded-full flex items-center justify-center shrink-0">
                  <HandCoins className="w-4 h-4 text-emerald-700 dark:text-emerald-300" weight="duotone" aria-hidden="true" />
                </span>
                <h2 className="text-sm font-semibold tracking-tight text-[#141715] dark:text-[#F3F5F3]">
                  Who Pays Whom ({suggestedTransfers.length})
                </h2>
              </div>
              <StatusBadge tone={activeGroup.simplifyDebts ? 'emerald' : 'amber'}>
                {activeGroup.simplifyDebts ? 'Smart Min-Payments' : 'Direct Pairwise'}
              </StatusBadge>
            </div>

            {suggestedTransfers.length === 0 ? (
              <div className="lg-recessed-well rounded-[20px] ring-1 ring-emerald-600/25 dark:ring-emerald-300/25 p-5 text-center space-y-2">
                <span className="lg-icon-orb h-10 w-10 rounded-full flex items-center justify-center mx-auto">
                  <CheckCircle
                    className="w-5 h-5 text-emerald-700 dark:text-emerald-300"
                    weight="fill"
                    aria-hidden="true"
                  />
                </span>
                <div className="text-xs sm:text-sm font-semibold text-emerald-900 dark:text-emerald-200 break-words [overflow-wrap:anywhere]">
                  Everyone in {activeGroup.name} is settled up!
                </div>
                <p className="text-[11px] text-[#5C6660] dark:text-[#9CA69F]">
                  No open debts right now. Ready whenever your next shared bill comes in.
                </p>
              </div>
            ) : (
              <div className="space-y-2.5 min-w-0">
                {suggestedTransfers.map((transfer, idx) => (
                  <div
                    key={`${transfer.fromMemberId}-${transfer.toMemberId}-${idx}`}
                    className="lg-recessed-well rounded-2xl p-3.5 space-y-2.5 min-w-0"
                  >
                    <div className="flex items-center justify-between gap-2 min-w-0">
                      <div className="flex items-center gap-1.5 text-xs font-semibold text-[#141715] dark:text-[#F3F5F3] min-w-0 flex-wrap">
                        <span dir="auto" className="break-words [overflow-wrap:anywhere]">
                          {memberNameOf(transfer.fromMemberId)}
                        </span>
                        <ArrowRight className="w-3.5 h-3.5 shrink-0 text-emerald-700 dark:text-emerald-300" weight="bold" aria-hidden="true" />
                        <span dir="auto" className="break-words [overflow-wrap:anywhere]">
                          {memberNameOf(transfer.toMemberId)}
                        </span>
                      </div>
                      <div className="shrink-0 whitespace-nowrap text-sm font-semibold font-mono tabular-nums text-emerald-700 dark:text-emerald-300">
                        <CurrencyAmount
                          minorAmount={transfer.amountMinor}
                          currencyCode={activeGroup.baseCurrency}
                        />
                      </div>
                    </div>

                    <p className="text-[11px] text-[#5C6660] dark:text-[#9CA69F] break-words">
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
                      className={`${BTN_PRIMARY} w-full`}
                    >
                      <CheckCircle className="w-4 h-4 shrink-0" weight="bold" aria-hidden="true" />
                      <span className="truncate">
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
        <div className="lg:col-span-7 space-y-4 min-w-0">
          {/* Ombria Category Filter Pills & Recessed Search Input */}
          <DoubleBezelCard className="min-w-0" innerClassName="space-y-3.5 min-w-0">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 min-w-0">
              <div className="relative flex-1 min-w-0">
                <MagnifyingGlass
                  className="w-4 h-4 text-[#68726C] dark:text-[#8A938D] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
                  weight="bold"
                  aria-hidden="true"
                />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search expenses by title, notes, or #tags..."
                  aria-label="Search group expenses"
                  className="lg-recessed-well min-h-[44px] w-full rounded-full pl-9 pr-4 py-2 text-xs sm:text-sm text-[#141715] dark:text-[#F3F5F3] placeholder:text-[#68726C] dark:placeholder:text-[#8A938D] focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
                />
              </div>
              <div className="flex items-center gap-1.5 text-xs text-[#5C6660] dark:text-[#9CA69F] font-mono tabular-nums shrink-0">
                <Funnel className="w-4 h-4 text-emerald-700 dark:text-emerald-300" aria-hidden="true" />
                <span>{filteredExpenses.length} active bills</span>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setSelectedCategory('all')}
                className={`min-h-[44px] min-w-[44px] rounded-full px-3.5 py-1.5 text-xs font-semibold tracking-tight cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 ${
                  selectedCategory === 'all'
                    ? 'lg-luminous-pill'
                    : 'lg-recessed-well text-[#4A524D] dark:text-[#B7BEB9] hover:text-[#141715] dark:hover:text-[#F3F5F3]'
                }`}
              >
                All Categories
              </button>
              {dataset.categoriesCatalog.map((cat) => (
                <button
                  key={cat.key}
                  type="button"
                  onClick={() => setSelectedCategory(cat.key)}
                  className={`min-h-[44px] min-w-[44px] rounded-full px-3.5 py-1.5 text-xs font-semibold tracking-tight cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 ${
                    selectedCategory === cat.key
                      ? 'lg-luminous-pill'
                      : 'lg-recessed-well text-[#4A524D] dark:text-[#B7BEB9] hover:text-[#141715] dark:hover:text-[#F3F5F3]'
                  }`}
                >
                  {cat.label}
                </button>
              ))}
            </div>
          </DoubleBezelCard>

          {/* Expense Feed Cards */}
          {filteredExpenses.length === 0 ? (
            <DoubleBezelCard
              testId="empty-group-onboarding-card"
              className="min-w-0"
              innerClassName="text-center py-10 space-y-3.5 min-w-0"
            >
              <span className="lg-icon-orb h-12 w-12 rounded-full flex items-center justify-center mx-auto">
                <Receipt className="w-6 h-6 text-emerald-700 dark:text-emerald-300" weight="duotone" aria-hidden="true" />
              </span>
              <div className="text-sm sm:text-base font-semibold tracking-tight text-[#141715] dark:text-[#F3F5F3] break-words [overflow-wrap:anywhere]">
                {groupExpenses.length === 0
                  ? `${activeGroup.name} is ready for its first bill!`
                  : 'No bills match your search filter'}
              </div>
              <p className="text-xs text-[#5C6660] dark:text-[#9CA69F] max-w-md mx-auto">
                {groupExpenses.length === 0
                  ? 'Add friends by name (even if they have not signed in yet) and log your first shared expense in seconds.'
                  : 'Try clearing your search text or selecting All Categories above.'}
              </p>
              {groupExpenses.length === 0 && (
                <div className="flex flex-wrap items-center justify-center gap-2.5 pt-1">
                  <button
                    type="button"
                    onClick={() => setShowAddMember(true)}
                    className={BTN_GHOST}
                  >
                    <UserPlus className="w-4 h-4 text-emerald-700 dark:text-emerald-300" weight="bold" aria-hidden="true" />
                    <span>+ Add Friends</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingExpense(null);
                      setIsExpenseModalOpen(true);
                    }}
                    className={BTN_PRIMARY}
                  >
                    <Plus className="w-4 h-4" weight="bold" aria-hidden="true" />
                    <span>+ Add First Bill</span>
                  </button>
                </div>
              )}
            </DoubleBezelCard>
          ) : (
            <div className="space-y-4 min-w-0">
              {filteredExpenses.map((exp) => {
                const catMeta = dataset.categoriesCatalog.find((c) => c.key === exp.category);
                const rotatedWinner = exp.splits.find((s) => s.included && s.remainderMinor === 1);
                const isExpanded = Boolean(expandedExpenseIds[exp.id]);
                const payerSummary = exp.payers
                  .map(
                    (p) =>
                      `${memberNameOf(p.memberId)}${isFormerMember(p.memberId) ? ' (former member)' : ''} (${formatMinorToMajor(
                        p.paidMinor,
                        exp.groupCurrency
                      )})`
                  )
                  .join(' + ');

                return (
                  <DoubleBezelCard
                    key={exp.id}
                    className="rounded-[1.5rem] min-w-0"
                    innerClassName="space-y-3.5 min-w-0"
                  >
                    {/* Top Row: Badges, Semantic Wrapping Heading & Splitwise Personal Impact */}
                    <div className="flex flex-wrap items-start justify-between gap-3 min-w-0">
                      <div className="space-y-1.5 min-w-0 flex-1 basis-[12rem]">
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
                            <StatusBadge tone="rose">Needs Review</StatusBadge>
                          )}
                        </div>

                        <h3
                          dir="auto"
                          title={exp.title}
                          data-testid={`expense-title-${exp.id}`}
                          className="text-base font-semibold tracking-tight text-[#141715] dark:text-[#F3F5F3] break-words [overflow-wrap:anywhere] min-w-0"
                        >
                          {exp.title}
                        </h3>
                        <div
                          dir="auto"
                          className="text-xs text-[#5C6660] dark:text-[#9CA69F] break-words [overflow-wrap:anywhere]"
                        >
                          <span className="font-mono">{exp.expenseDate}</span> • Paid by {payerSummary}
                        </div>
                      </div>

                      <div className="sm:text-right space-y-1 shrink-0 max-w-full">
                        <div className="text-base sm:text-lg font-semibold font-mono tabular-nums text-[#141715] dark:text-[#F3F5F3] whitespace-nowrap">
                          <CurrencyAmount
                            minorAmount={exp.amountMinor}
                            currencyCode={exp.groupCurrency}
                          />
                        </div>
                        <div>
                          <PersonalExpenseImpactBadge
                            expense={exp}
                            myMemberId={currentUserMember?.id}
                          />
                        </div>
                        {exp.originalCurrency !== exp.groupCurrency && (
                          <div className="text-xs font-mono tabular-nums text-[#5C6660] dark:text-[#9CA69F] whitespace-nowrap">
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
                      <div className="lg-recessed-well flex flex-wrap items-center justify-between gap-2 rounded-2xl ring-1 ring-sky-600/22 dark:ring-sky-300/22 px-3.5 py-2.5 text-xs min-w-0">
                        <span className="font-mono text-sky-800 dark:text-sky-200 break-words [overflow-wrap:anywhere] min-w-0">
                          {exp.fxAuditNote}
                        </span>
                        {exp.fxStatus === 'cached_offline' && (
                          <button
                            type="button"
                            data-testid={`refresh-fx-${exp.id}`}
                            onClick={() => refreshOfflineExpenseFx(exp.id)}
                            className={BTN_PRIMARY}
                          >
                            <ArrowsClockwise className="w-3.5 h-3.5" weight="bold" aria-hidden="true" />
                            <span>Refresh Live FX</span>
                          </button>
                        )}
                      </div>
                    )}

                    {/* Per-Member Split Breakdown Chips */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 min-w-0">
                      {exp.splits
                        .filter((s) => s.included)
                        .map((s) => (
                          <div
                            key={s.memberId}
                            className="lg-recessed-well rounded-2xl px-3 py-2 min-w-0"
                          >
                            <div className="flex items-center justify-between gap-1 min-w-0">
                              <span
                                dir="auto"
                                title={memberNameOf(s.memberId)}
                                className="text-[11px] font-medium text-[#4A524D] dark:text-[#B7BEB9] truncate"
                              >
                                {memberNameOf(s.memberId)}
                              </span>
                              {s.remainderMinor === 1 && (
                                <span className="text-[10px] font-mono font-semibold text-amber-700 dark:text-amber-300 shrink-0">
                                  +1
                                </span>
                              )}
                            </div>
                            <div className="mt-0.5 text-xs font-semibold font-mono tabular-nums text-[#141715] dark:text-[#F3F5F3] truncate">
                              <CurrencyAmount
                                minorAmount={s.owedMinor}
                                currencyCode={exp.groupCurrency}
                              />
                            </div>
                            {isFormerMember(s.memberId) && (
                              <span
                                data-testid="former-member-badge"
                                className="mt-1 inline-block rounded-full bg-black/[0.055] dark:bg-white/[0.08] px-2 py-0.5 text-[10px] font-medium text-[#4A524D] dark:text-[#B7BEB9]"
                              >
                                Former member
                              </span>
                            )}
                          </div>
                        ))}
                    </div>

                    {exp.notes && (
                      <p
                        dir="auto"
                        className="text-xs text-[#5C6660] dark:text-[#9CA69F] break-words [overflow-wrap:anywhere]"
                      >
                        {exp.notes}
                      </p>
                    )}

                    {/* Card Footer Actions */}
                    <div className="flex flex-wrap items-center justify-between gap-2 pt-2.5 border-t border-black/[0.07] dark:border-white/[0.08]">
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedExpenseIds((prev) => ({
                            ...prev,
                            [exp.id]: !prev[exp.id],
                          }))
                        }
                        className="lg-scene-tile min-h-[44px] min-w-[44px] inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-semibold text-[#141715] dark:text-[#F3F5F3] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
                      >
                        <ChatCircleText className="w-4 h-4 text-emerald-700 dark:text-emerald-300" aria-hidden="true" />
                        <span>Comments ({exp.comments.length})</span>
                        <span className="opacity-40" aria-hidden="true">|</span>
                        <Paperclip className="w-4 h-4 text-emerald-700 dark:text-emerald-300" aria-hidden="true" />
                        <span>Receipts ({exp.receipts.length})</span>
                      </button>

                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setEditingExpense(exp);
                            setIsExpenseModalOpen(true);
                          }}
                          className={BTN_GHOST}
                        >
                          <NotePencil className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>Edit</span>
                        </button>
                        <button
                          type="button"
                          data-testid={`delete-expense-${exp.id}`}
                          onClick={() => softDeleteExpense(exp.id)}
                          className={BTN_DANGER}
                        >
                          <Trash className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>Move to Trash</span>
                        </button>
                      </div>
                    </div>

                    {/* Expandable Comments & Receipts Drawer */}
                    {isExpanded && (
                      <div className="lg-recessed-well rounded-[20px] p-3.5 space-y-3 min-w-0">
                        {exp.receipts.length > 0 && (
                          <div className="space-y-1.5 min-w-0">
                            <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[#5C6660] dark:text-[#9CA69F]">
                              Attached Receipts
                            </div>
                            {exp.receipts.map((rcp) => (
                              <div
                                key={rcp.id}
                                className="lg-scene-tile flex items-center justify-between gap-2 rounded-2xl px-3 py-2 text-xs min-w-0"
                              >
                                <span
                                  className="font-mono font-semibold text-[#141715] dark:text-[#F3F5F3] truncate"
                                  title={rcp.fileName}
                                >
                                  {rcp.fileName}
                                </span>
                                <span className="text-[#5C6660] dark:text-[#9CA69F] shrink-0">
                                  {rcp.previewNote}
                                </span>
                              </div>
                            ))}
                          </div>
                        )}

                        <div className="space-y-2 min-w-0">
                          <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[#5C6660] dark:text-[#9CA69F]">
                            Discussion &amp; Audit Comments
                          </div>
                          {exp.comments.map((cmt) => (
                            <div
                              key={cmt.id}
                              dir="auto"
                              className="lg-scene-tile rounded-2xl px-3 py-2 text-xs break-words [overflow-wrap:anywhere]"
                            >
                              {cmt.isLegacy && (
                                <span
                                  data-testid={`comment-imported-${cmt.id}`}
                                  title="Imported comment. The author name was not verified."
                                  className="mr-1.5 inline-block rounded-full bg-black/[0.06] dark:bg-white/[0.08] px-2 py-0.5 text-[10px] font-semibold text-[#5C6660] dark:text-[#9CA69F]"
                                >
                                  imported
                                </span>
                              )}
                              <span className="font-semibold text-[#141715] dark:text-[#F3F5F3]">
                                {cmt.authorName}:{' '}
                              </span>
                              <span className="text-[#4A524D] dark:text-[#B7BEB9]">{cmt.body}</span>
                            </div>
                          ))}
                          <div className="flex items-center gap-2 pt-1 min-w-0">
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
                              aria-label="Comment on this bill"
                              className="lg-recessed-well min-h-[44px] min-w-0 flex-1 rounded-full px-3.5 py-2 text-xs text-[#141715] dark:text-[#F3F5F3] placeholder:text-[#68726C] dark:placeholder:text-[#8A938D] focus:outline-none focus:ring-2 focus:ring-emerald-500/50"
                            />
                            <button
                              type="button"
                              onClick={() => {
                                const draft = commentDrafts[exp.id] ?? '';
                                if (!draft.trim()) return;
                                addExpenseComment(exp.id, draft);
                                setCommentDrafts((prev) => ({ ...prev, [exp.id]: '' }));
                              }}
                              className={BTN_PRIMARY}
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
            <DoubleBezelCard className="min-w-0" innerClassName="space-y-3 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold uppercase tracking-[0.08em] text-rose-700 dark:text-rose-300 flex items-center gap-2">
                  <span className="lg-icon-orb h-7 w-7 rounded-full inline-flex items-center justify-center shrink-0">
                    <Trash className="w-3.5 h-3.5 text-rose-700 dark:text-rose-300" aria-hidden="true" />
                  </span>
                  <span>Trash &amp; 1-Click Recovery ({trashedExpenses.length})</span>
                </span>
              </div>
              <div className="space-y-2 min-w-0">
                {trashedExpenses.map((trashed) => (
                  <div
                    key={trashed.id}
                    className="lg-recessed-well flex flex-wrap items-center justify-between gap-2 rounded-2xl px-3.5 py-2.5 text-xs min-w-0"
                  >
                    <div className="min-w-0 flex-1 truncate" title={trashed.title}>
                      <span dir="auto" className="font-semibold text-[#4A524D] dark:text-[#B7BEB9] line-through">
                        {trashed.title}
                      </span>{' '}
                      <span className="font-mono tabular-nums text-[#68726C] dark:text-[#8A938D]">
                        ({formatMinorToMajor(trashed.amountMinor, trashed.groupCurrency)})
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => restoreExpense(trashed.id)}
                      className={BTN_GHOST}
                    >
                      <ArrowCounterClockwise className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-300" weight="bold" aria-hidden="true" />
                      <span>Restore</span>
                    </button>
                  </div>
                ))}
              </div>
            </DoubleBezelCard>
          )}
        </div>
      </div>
      </>
      )}

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
