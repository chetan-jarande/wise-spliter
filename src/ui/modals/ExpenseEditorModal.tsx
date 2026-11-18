import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowsLeftRightIcon as ArrowsLeftRight,
  CalendarBlankIcon as CalendarBlank,
  CheckCircleIcon as CheckCircle,
  CoinsIcon as Coins,
  FloppyDiskIcon as FloppyDisk,
  FolderOpenIcon as FolderOpen,
  ImageIcon as Image,
  PaperclipIcon as Paperclip,
  PlusIcon as Plus,
  SparkleIcon as Sparkle,
  TagIcon as Tag,
  TrashIcon as Trash,
  UploadSimpleIcon as UploadSimple,
  UserPlusIcon as UserPlus,
  UsersIcon as Users,
  WarningCircleIcon as WarningCircle,
  XIcon as X,
} from '@phosphor-icons/react';
import {
  AdHocParticipant,
  ExpenseCategoryKey,
  ExpenseItem,
  ExpensePayer,
  FxStatus,
  GroupMember,
  ReceiptAttachment,
  SplitMode,
} from '../../types/ledger';
import { useLedger } from '../../state/LedgerContext';
import { getLocalReceiptBlobsForExpense } from '../../storage/local-db';
import { newId, newUuid } from '../../utils/ids';
import { normalizePersonName } from '../../utils/group-permissions';
import { localIsoDate } from '../../utils/direct-settlements';
import {
  createSampleWebpReceiptAttachment,
  sha256Hex,
} from '../../portability/portability-engine';
import {
  CurrencyAmount,
  CurrencyPrecisionPill,
  DoubleBezelCard,
  StatusBadge,
} from '../primitives/DesignPrimitives';
import {
  SUPPORTED_CURRENCIES,
  convertMinorAmountWithFx,
  formatMinorToMajor,
  formatScaledFxRate,
  getCurrency,
  getMinorScaleFactor,
  localeUsesDecimalComma,
  parseFxRateToScaled,
  parseLocaleDecimal,
  parseMajorToMinor,
  toLocaleDecimalInput,
} from '../../domain/money/currencies';
import {
  SplitParticipantInput,
  calculateSplits,
  validateExpenseInvariants,
} from '../../domain/splits/split-calculator';
import { lockParticipantUpiIds, pickableMembers } from '../../domain/ledger/ledger-engine';
import { LIMITS, expenseTextProblems } from '../../types/limits';

export interface ExpenseEditorModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialExpense?: ExpenseItem | null;
  defaultGroupId?: string | null; // When opened from a group, pass group.id; when opened from Home Quick-Add, pass null
}

const SPLIT_MODES: Array<{ mode: SplitMode; label: string; hint: string; verb: string }> = [
  { mode: 'equal', label: 'Equal', hint: 'Evenly per person', verb: 'equally' },
  { mode: 'exact', label: 'Exact', hint: 'Specific amounts', verb: 'by exact amounts' },
  { mode: 'percentage', label: 'Percentage', hint: 'Totaling 100%', verb: 'by percentage' },
  { mode: 'shares', label: 'Shares', hint: 'Ratio like 2x, 1x', verb: 'by share ratios' },
  { mode: 'adjustment', label: '+/- Adjust', hint: 'Equal + item extras', verb: 'with +/- adjustments' },
];

function computeInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]![0] ?? ''}${parts[parts.length - 1]![0] ?? ''}`.toUpperCase();
  }
  return name.trim().slice(0, 2).toUpperCase() || 'FR';
}

const INPUT_LOCALE = typeof navigator !== 'undefined' ? navigator.language : undefined;

/** Major-unit string for the amount field, written with the device's decimal separator. */
function toAmountInput(minor: number, currency: string): string {
  const plain = formatMinorToMajor(minor, currency, false).replace(/,/g, '');
  return localeUsesDecimalComma(INPUT_LOCALE) ? plain.replace('.', ',') : plain;
}

/** Rate date recorded in an audit note such as "(live rate, 2026-11-16)". */
function auditNoteRateDate(expense: ExpenseItem): string {
  return /, (\d{4}-\d{2}-\d{2})\)$/.exec(expense.fxAuditNote ?? '')?.[1] ?? expense.expenseDate;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const participantKey = (p: { invitedEmail: string | null; displayName: string }) =>
  (p.invitedEmail?.trim() || p.displayName.trim()).toLowerCase();

/** The owner's direct-split contacts keyed like the ledger engine's friendKey, so a friend keeps one UUID across bills. */
function knownDirectParticipants(expenses: ExpenseItem[]): Map<string, AdHocParticipant> {
  const known = new Map<string, AdHocParticipant>();
  for (const e of expenses) {
    if (e.groupId !== null) continue;
    for (const p of e.adHocParticipants ?? []) {
      if (UUID_RE.test(p.id) && !known.has(participantKey(p))) known.set(participantKey(p), p);
    }
  }
  return known;
}

function makeSelfParticipant(
  user: { fullName: string; email: string; upiId: string },
  known: Map<string, AdHocParticipant>
): AdHocParticipant {
  return {
    id: known.get(user.email.trim().toLowerCase())?.id ?? newUuid(),
    displayName: user.fullName,
    invitedEmail: user.email,
    upiId: user.upiId || null,
    avatarInitials: computeInitials(user.fullName),
    memberOrder: 0,
  };
}

export function ExpenseEditorModal({
  isOpen,
  onClose,
  initialExpense: initialExpenseProp = null,
  defaultGroupId,
}: ExpenseEditorModalProps) {
  const { dataset, activeGroup, getFxQuote, upsertExpense, saveDefaultSplitPreset } = useLedger();
  const [initialExpense, setLoadedExpense] = useState<ExpenseItem | null>(initialExpenseProp);

  const activeGroups = useMemo(
    () => dataset.groups.filter((g) => !g.deletedAt),
    [dataset.groups]
  );

  const resolveInitialScopeGroupId = (): string => {
    if (initialExpenseProp) {
      return initialExpenseProp.groupId ?? '';
    }
    if (defaultGroupId !== undefined) {
      return defaultGroupId ?? '';
    }
    return activeGroup.id;
  };

  const [selectedGroupId, setSelectedGroupId] = useState<string>(resolveInitialScopeGroupId);
  const knownAdHoc = useMemo(() => knownDirectParticipants(dataset.expenses), [dataset.expenses]);
  const [adHocParticipants, setAdHocParticipants] = useState<AdHocParticipant[]>(() => [
    makeSelfParticipant(dataset.currentUser, knownDirectParticipants(dataset.expenses)),
  ]);
  const isSelfParticipant = (p: { invitedEmail?: string | null }) =>
    Boolean(p.invitedEmail) &&
    p.invitedEmail!.toLowerCase() === dataset.currentUser.email.toLowerCase();
  const [customFriendName, setCustomFriendName] = useState('');

  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<ExpenseCategoryKey>('food');
  const [expenseDate, setExpenseDate] = useState(() => localIsoDate());
  const [amountInput, setAmountInput] = useState('');
  const [originalCurrency, setOriginalCurrency] = useState(activeGroup.baseCurrency);
  const [fxRateInput, setFxRateInput] = useState('');
  const [fxMode, setFxMode] = useState<'auto' | 'manual' | 'stored'>('auto');
  const [notes, setNotes] = useState('');
  const [tagsInput, setTagsInput] = useState('');

  const [splitMode, setSplitMode] = useState<SplitMode>('equal');
  const [isMultiPayer, setIsMultiPayer] = useState(false);
  const [singlePayerId, setSinglePayerId] = useState(activeGroup.members[0]?.id ?? '');
  const [multiPayerInputs, setMultiPayerInputs] = useState<Record<string, string>>({});

  const [includedMembers, setIncludedMembers] = useState<Record<string, boolean>>({});
  const [memberInputStrings, setMemberInputStrings] = useState<Record<string, string>>({});
  const [attachedReceipts, setAttachedReceipts] = useState<ReceiptAttachment[]>([]);

  const isDirectSplit = selectedGroupId === '';
  const groupRoster = (g: { id: string; members: GroupMember[] }): GroupMember[] =>
    pickableMembers(
      g.members,
      initialExpense?.groupId === g.id
        ? [...initialExpense.payers.map((p) => p.memberId), ...initialExpense.splits.map((sp) => sp.memberId)]
        : []
    );

  const selectedGroup = useMemo(() => {
    if (isDirectSplit) return null;
    return activeGroups.find((g) => g.id === selectedGroupId) ?? activeGroup;
  }, [isDirectSplit, activeGroups, selectedGroupId, activeGroup]);

  const effectiveBaseCurrency = selectedGroup ? selectedGroup.baseCurrency : originalCurrency;

  const currentParticipants = useMemo(() => {
    if (selectedGroup) {
      return groupRoster(selectedGroup).map((m) => ({
        id: m.id,
        displayName: m.displayName,
        avatarInitials: m.avatarInitials,
        memberOrder: m.memberOrder,
        userId: m.userId,
        isFormer: Boolean(m.removedAt),
      }));
    }
    return adHocParticipants.map((p, idx) => ({
      id: p.id,
      displayName: p.displayName,
      avatarInitials: p.avatarInitials,
      memberOrder: idx,
      userId: isSelfParticipant(p) ? dataset.currentUser.id : null,
      isFormer: false,
    }));
  }, [selectedGroup, adHocParticipants, dataset.currentUser.id, dataset.currentUser.email, initialExpense]);

  const allCurrencyOptions = useMemo(() => {
    const primaryCodes = new Set(dataset.currenciesCatalog.map((c) => c.code));
    const extras = Object.values(SUPPORTED_CURRENCIES)
      .filter((c) => !primaryCodes.has(c.code))
      .sort((a, b) => a.code.localeCompare(b.code));
    return [...dataset.currenciesCatalog, ...extras];
  }, [dataset.currenciesCatalog]);

  const initForm = (src: ExpenseItem | null) => {
    setLoadedExpense(src);
    setSaveError(null);

    const initGroupId = src
      ? src.groupId ?? ''
      : defaultGroupId !== undefined
      ? defaultGroupId ?? ''
      : activeGroup.id;

    setSelectedGroupId(initGroupId);
    setCustomFriendName('');

    const targetGroup =
      initGroupId !== ''
        ? dataset.groups.find((g) => g.id === initGroupId && !g.deletedAt) ?? activeGroup
        : null;

    const initAdHoc: AdHocParticipant[] =
      src?.adHocParticipants && src.adHocParticipants.length >= 2
        ? src.adHocParticipants.map((p, i) => ({ ...p, memberOrder: i }))
        : [makeSelfParticipant(dataset.currentUser, knownAdHoc)];

    setAdHocParticipants(initAdHoc);

    const activeRoster = targetGroup ? groupRoster(targetGroup) : initAdHoc;
    const baseCurr = targetGroup
      ? targetGroup.baseCurrency
      : src?.originalCurrency ?? dataset.currentUser.defaultCurrency ?? 'INR';

    if (src) {
      setTitle(src.title);
      setCategory(src.category);
      setExpenseDate(src.expenseDate);
      setOriginalCurrency(src.originalCurrency);
      setAmountInput(toAmountInput(src.originalAmountMinor, src.originalCurrency));
      setFxRateInput(formatScaledFxRate(src.fxRateScaled));
      setFxMode(src.fxStatus === 'identity' ? 'auto' : 'stored');
      setNotes(src.notes);
      setTagsInput(src.tags.join(', '));
      setSplitMode(src.splitMode);

      const multi = src.payers.length > 1;
      setIsMultiPayer(multi);
      setSinglePayerId(src.payers[0]?.memberId ?? activeRoster[0]?.id ?? '');

      const payerMap: Record<string, string> = {};
      for (const m of activeRoster) {
        const foundPayer = src.payers.find((p) => p.memberId === m.id);
        payerMap[m.id] = foundPayer
          ? formatMinorToMajor(foundPayer.paidMinor, baseCurr, false).replace(/,/g, '')
          : '0';
      }
      setMultiPayerInputs(payerMap);

      const incMap: Record<string, boolean> = {};
      const strMap: Record<string, string> = {};
      for (const m of activeRoster) {
        const sp = src.splits.find((s) => s.memberId === m.id);
        incMap[m.id] = sp ? sp.included : true;
        if (!sp) {
          strMap[m.id] = '1';
        } else if (src.splitMode === 'percentage') {
          strMap[m.id] = (sp.rawInputValue / 100).toFixed(2).replace(/\.00$/, '');
        } else if (
          src.splitMode === 'exact' ||
          src.splitMode === 'adjustment'
        ) {
          strMap[m.id] = formatMinorToMajor(sp.rawInputValue, baseCurr, false).replace(/,/g, '');
        } else {
          strMap[m.id] = String(sp.rawInputValue || 1);
        }
      }
      setIncludedMembers(incMap);
      setMemberInputStrings(strMap);
      const baseReceipts = src.receipts ?? [];
      setAttachedReceipts(baseReceipts);
      if (baseReceipts.some((r) => !r.dataUrl)) {
        void getLocalReceiptBlobsForExpense(src.id).then((blobs) => {
          if (blobs.length === 0) return;
          const byId = new Map(blobs.map((b) => [b.id, b.dataUrl]));
          setAttachedReceipts((prev) =>
            prev.map((r) => {
              const cachedUrl = byId.get(r.id);
              return !r.dataUrl && cachedUrl ? { ...r, dataUrl: cachedUrl } : r;
            })
          );
        });
      }
    } else {
      setTitle('');
      setCategory('food');
      setExpenseDate(localIsoDate());
      setOriginalCurrency(baseCurr);
      setAmountInput('');
      setFxRateInput('');
      setFxMode('auto');
      setNotes('');
      setTagsInput('');
      setSplitMode('equal');
      setIsMultiPayer(false);
      setAttachedReceipts([]);
      const defaultPayer = targetGroup
        ? activeRoster.find((m) => 'userId' in m && m.userId === dataset.currentUser.id)?.id ??
          activeRoster[0]?.id ??
          ''
        : initAdHoc[0]?.id ?? '';
      setSinglePayerId(defaultPayer);

      const payerMap: Record<string, string> = {};
      const incMap: Record<string, boolean> = {};
      const strMap: Record<string, string> = {};
      for (const m of activeRoster) {
        payerMap[m.id] = '0';
        incMap[m.id] = true;
        strMap[m.id] = '1';
      }
      setMultiPayerInputs(payerMap);
      setIncludedMembers(incMap);
      setMemberInputStrings(strMap);
    }
  };

  const openKey = isOpen ? `${initialExpenseProp?.id ?? 'new'}|${defaultGroupId ?? ''}` : null;
  useEffect(() => {
    if (openKey !== null) initForm(initialExpenseProp);
  }, [openKey]);

  const liveExpense = initialExpense ? dataset.expenses.find((e) => e.id === initialExpense.id) ?? null : null;
  const remoteChanged = !!liveExpense && !!initialExpense && liveExpense.hlc !== initialExpense.hlc;

  const syncParticipantStateForRoster = (
    roster: Array<{ id: string; memberOrder: number; userId?: string | null }>,
    nextBaseCurrency: string,
    nextOrigCurrency: string
  ) => {
    const defaultPayer =
      roster.find((m) => m.userId === dataset.currentUser.id)?.id ?? roster[0]?.id ?? '';
    setSinglePayerId(defaultPayer);
    setIsMultiPayer(false);
    setSplitMode('equal');

    const payerMap: Record<string, string> = {};
    const incMap: Record<string, boolean> = {};
    const strMap: Record<string, string> = {};
    for (const m of roster) {
      payerMap[m.id] = '0';
      incMap[m.id] = true;
      strMap[m.id] = '1';
    }
    setMultiPayerInputs(payerMap);
    setIncludedMembers(incMap);
    setMemberInputStrings(strMap);

    setFxRateInput('');
    setFxMode('auto');
  };

  const handleGroupScopeChange = (nextGroupId: string) => {
    setSelectedGroupId(nextGroupId);
    if (nextGroupId === '') {
      const roster = adHocParticipants.some(isSelfParticipant)
        ? adHocParticipants
        : [makeSelfParticipant(dataset.currentUser, knownAdHoc), ...adHocParticipants];
      setAdHocParticipants(roster);
      const nextCurr = originalCurrency || dataset.currentUser.defaultCurrency || 'INR';
      setOriginalCurrency(nextCurr);
      syncParticipantStateForRoster(
        roster.map((p, idx) => ({
          id: p.id,
          memberOrder: idx,
          userId: isSelfParticipant(p) ? dataset.currentUser.id : null,
        })),
        nextCurr,
        nextCurr
      );
    } else {
      const grp = dataset.groups.find((g) => g.id === nextGroupId && !g.deletedAt) ?? activeGroup;
      setOriginalCurrency(grp.baseCurrency);
      syncParticipantStateForRoster(groupRoster(grp), grp.baseCurrency, grp.baseCurrency);
    }
  };

  const handleAddAdHocParticipant = (contact: Omit<AdHocParticipant, 'memberOrder'>) => {
    const trimmedName = contact.displayName.trim();
    if (!trimmedName) return;
    const exists = adHocParticipants.some(
      (p) => p.id === contact.id || normalizePersonName(p.displayName) === normalizePersonName(trimmedName)
    );
    if (exists) return;

    const nextParticipant: AdHocParticipant = {
      ...contact,
      displayName: trimmedName,
      avatarInitials: contact.avatarInitials || computeInitials(trimmedName),
      memberOrder: adHocParticipants.length,
    };

    const nextList = [...adHocParticipants, nextParticipant];
    setAdHocParticipants(nextList);
    setIncludedMembers((prev) => ({ ...prev, [nextParticipant.id]: true }));
    setMultiPayerInputs((prev) => ({ ...prev, [nextParticipant.id]: '0' }));

    if (splitMode === 'percentage') {
      const activeIds = nextList
        .filter((p) => (p.id === nextParticipant.id ? true : includedMembers[p.id] !== false))
        .map((p) => p.id);
      const k = activeIds.length;
      if (k > 0) {
        const baseBps = Math.floor(10000 / k);
        const remBps = 10000 - baseBps * k;
        const nextStr = { ...memberInputStrings };
        activeIds.forEach((id, idx) => {
          const bps = baseBps + (idx === 0 ? remBps : 0);
          nextStr[id] = (bps / 100).toFixed(2).replace(/\.00$/, '');
        });
        setMemberInputStrings(nextStr);
      }
    } else if (splitMode === 'adjustment') {
      setMemberInputStrings((prev) => ({ ...prev, [nextParticipant.id]: '0' }));
    } else {
      setMemberInputStrings((prev) => ({ ...prev, [nextParticipant.id]: '1' }));
    }
  };

  const handleAddCustomFriend = () => {
    const name = customFriendName.trim();
    if (!name) return;
    const lower = normalizePersonName(name);
    const known =
      knownAdHoc.get(lower) ??
      [...knownAdHoc.values()].find((p) => normalizePersonName(p.displayName) === lower);
    handleAddAdHocParticipant(
      known && !isSelfParticipant(known)
        ? known
        : { id: newUuid(), displayName: name, invitedEmail: null, upiId: null, avatarInitials: computeInitials(name) }
    );
    setCustomFriendName('');
  };

  const handleRemoveAdHocParticipant = (participantId: string) => {
    const target = adHocParticipants.find((p) => p.id === participantId);
    if (!target || isSelfParticipant(target)) return;
    const filtered = adHocParticipants
      .filter((p) => p.id !== participantId)
      .map((p, idx) => ({ ...p, memberOrder: idx }));
    setAdHocParticipants(filtered);
    if (singlePayerId === participantId) {
      setSinglePayerId(filtered[0]?.id ?? '');
    }
    if (splitMode === 'percentage') {
      const activeIds = filtered
        .filter((p) => includedMembers[p.id] !== false)
        .map((p) => p.id);
      const k = activeIds.length;
      if (k > 0) {
        const baseBps = Math.floor(10000 / k);
        const remBps = 10000 - baseBps * k;
        const nextStr = { ...memberInputStrings };
        activeIds.forEach((id, idx) => {
          const bps = baseBps + (idx === 0 ? remBps : 0);
          nextStr[id] = (bps / 100).toFixed(2).replace(/\.00$/, '');
        });
        setMemberInputStrings(nextStr);
      }
    }
  };

  const handleCurrencyChange = (nextCurrency: string) => {
    setOriginalCurrency(nextCurrency);
    setFxRateInput('');
    setFxMode('auto');
  };

  const originalAmountMinor = useMemo(
    () => Math.max(0, parseMajorToMinor(amountInput, originalCurrency, INPUT_LOCALE)),
    [amountInput, originalCurrency]
  );

  const needsFx = originalCurrency !== effectiveBaseCurrency;
  const manualRateScaled = parseFxRateToScaled(fxRateInput);
  const storedFxUsable =
    fxMode === 'stored' &&
    !!initialExpense &&
    initialExpense.fxRateScaled > 0 &&
    initialExpense.originalCurrency === originalCurrency &&
    initialExpense.groupCurrency === effectiveBaseCurrency;
  const autoQuote = needsFx && fxMode === 'auto' ? getFxQuote(originalCurrency, effectiveBaseCurrency) : null;
  const activeFx: { rateScaled: number; status: FxStatus; rateDate: string } | null = !needsFx
    ? { rateScaled: 100000000, status: 'identity', rateDate: expenseDate }
    : fxMode === 'manual'
      ? manualRateScaled > 0
        ? { rateScaled: manualRateScaled, status: 'manual', rateDate: expenseDate }
        : null
      : storedFxUsable
        ? { rateScaled: initialExpense.fxRateScaled, status: initialExpense.fxStatus, rateDate: auditNoteRateDate(initialExpense) }
        : autoQuote
          ? { rateScaled: autoQuote.rateScaled, status: autoQuote.status, rateDate: autoQuote.rateDate }
          : null;
  const fxMissing = needsFx && !activeFx;

  const fxConversion = useMemo(
    () =>
      activeFx
        ? convertMinorAmountWithFx({
            originalMinor: originalAmountMinor,
            fromCurrency: originalCurrency,
            toCurrency: effectiveBaseCurrency,
            fxRateScaled: activeFx.rateScaled,
            fxStatus: activeFx.status,
            dateIso: activeFx.rateDate,
          })
        : { convertedMinor: 0, fxAuditNote: null },
    [originalAmountMinor, originalCurrency, effectiveBaseCurrency, activeFx?.rateScaled, activeFx?.status, activeFx?.rateDate]
  );

  const totalConvertedMinor = fxConversion.convertedMinor;
  const rotationSeed = initialExpense
    ? initialExpense.rotationSeed
    : selectedGroup
    ? selectedGroup.expenseSeq
    : 0;

  const handleSwitchSplitMode = (nextMode: SplitMode) => {
    setSplitMode(nextMode);
    const activeMembers = currentParticipants.filter((m) => includedMembers[m.id] !== false);
    const k = activeMembers.length;
    if (k === 0) return;

    const nextStrings = { ...memberInputStrings };
    if (nextMode === 'equal' || nextMode === 'shares') {
      for (const m of currentParticipants) {
        nextStrings[m.id] = includedMembers[m.id] !== false ? '1' : '0';
      }
    } else if (nextMode === 'percentage') {
      const baseBps = Math.floor(10000 / k);
      const remBps = 10000 - baseBps * k;
      activeMembers.forEach((m, idx) => {
        const bps = baseBps + (idx === 0 ? remBps : 0);
        nextStrings[m.id] = (bps / 100).toFixed(2).replace(/\.00$/, '');
      });
    } else if (nextMode === 'adjustment') {
      for (const m of currentParticipants) {
        nextStrings[m.id] = '0';
      }
    } else if (nextMode === 'exact') {
      const eqSplits = calculateSplits({
        totalMinor: totalConvertedMinor,
        originalTotalMinor: originalAmountMinor,
        splitMode: 'equal',
        rotationSeed,
        participants: currentParticipants.map((m) => ({
          memberId: m.id,
          memberOrder: m.memberOrder,
          included: includedMembers[m.id] !== false,
          rawInputValue: 1,
        })),
      });
      for (const sp of eqSplits) {
        nextStrings[sp.memberId] = formatMinorToMajor(
          sp.owedMinor,
          effectiveBaseCurrency,
          false
        ).replace(/,/g, '');
      }
    }
    setMemberInputStrings(nextStrings);
  };

  const handleToggleMultiPayer = () => {
    const next = !isMultiPayer;
    setIsMultiPayer(next);
    if (next) {
      const payerMap: Record<string, string> = {};
      const firstId = singlePayerId || currentParticipants[0]?.id;
      for (const m of currentParticipants) {
        payerMap[m.id] =
          m.id === firstId
            ? formatMinorToMajor(totalConvertedMinor, effectiveBaseCurrency, false).replace(
                /,/g,
                ''
              )
            : '0';
      }
      setMultiPayerInputs(payerMap);
    }
  };

  const handleApplyDefaultSplit = () => {
    if (!selectedGroup) return;
    const preset = selectedGroup.defaultSplitConfig;
    if (!preset) return;
    setSplitMode(preset.splitMode);
    const incMap: Record<string, boolean> = {};
    const strMap: Record<string, string> = {};
    for (const m of groupRoster(selectedGroup)) {
      const rawVal = preset.memberValues[m.id];
      const isInc = rawVal !== undefined && (preset.splitMode === 'adjustment' || rawVal > 0);
      incMap[m.id] = isInc;
      if (preset.splitMode === 'percentage') {
        strMap[m.id] = ((rawVal ?? 0) / 100).toFixed(2).replace(/\.00$/, '');
      } else if (preset.splitMode === 'exact' || preset.splitMode === 'adjustment') {
        strMap[m.id] = formatMinorToMajor(
          rawVal ?? 0,
          selectedGroup.baseCurrency,
          false
        ).replace(/,/g, '');
      } else {
        strMap[m.id] = String(rawVal ?? 1);
      }
    }
    setIncludedMembers(incMap);
    setMemberInputStrings(strMap);
  };

  const participantInputs: SplitParticipantInput[] = useMemo(() => {
    return currentParticipants.map((m) => {
      const included = includedMembers[m.id] !== false;
      const strVal = memberInputStrings[m.id] ?? '0';
      let rawInputValue = 0;
      if (!included) {
        rawInputValue = 0;
      } else if (splitMode === 'equal') {
        rawInputValue = 1;
      } else if (splitMode === 'shares') {
        rawInputValue = Number(parseLocaleDecimal(strVal, 0) ?? 0n);
      } else if (splitMode === 'percentage') {
        rawInputValue = Number(parseLocaleDecimal(strVal, 2) ?? 0n);
      } else {
        rawInputValue = parseMajorToMinor(strVal, effectiveBaseCurrency);
      }
      return {
        memberId: m.id,
        memberOrder: m.memberOrder,
        included,
        rawInputValue,
      };
    });
  }, [
    currentParticipants,
    effectiveBaseCurrency,
    includedMembers,
    memberInputStrings,
    splitMode,
  ]);

  const computedSplits = useMemo(
    () =>
      calculateSplits({
        totalMinor: totalConvertedMinor,
        originalTotalMinor: originalAmountMinor,
        splitMode,
        rotationSeed,
        participants: participantInputs,
      }),
    [totalConvertedMinor, originalAmountMinor, splitMode, rotationSeed, participantInputs]
  );

  const computedPayers: ExpensePayer[] = useMemo(() => {
    if (!isMultiPayer) {
      const targetId = singlePayerId || currentParticipants[0]?.id || '';
      return [
        {
          memberId: targetId,
          paidMinor: totalConvertedMinor,
          originalPaidMinor: originalAmountMinor,
        },
      ];
    }
    const list: ExpensePayer[] = [];
    for (const m of currentParticipants) {
      const paidMinor = Math.max(
        0,
        parseMajorToMinor(multiPayerInputs[m.id] ?? '0', effectiveBaseCurrency)
      );
      if (paidMinor > 0) {
        const origPaid =
          totalConvertedMinor > 0
            ? Math.round((paidMinor * originalAmountMinor) / totalConvertedMinor)
            : paidMinor;
        list.push({
          memberId: m.id,
          paidMinor,
          originalPaidMinor: origPaid,
        });
      }
    }
    return list;
  }, [
    isMultiPayer,
    singlePayerId,
    currentParticipants,
    effectiveBaseCurrency,
    totalConvertedMinor,
    originalAmountMinor,
    multiPayerInputs,
  ]);

  const parsedTags = tagsInput
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => (t.startsWith('#') ? t : `#${t}`));
  const textProblems = expenseTextProblems({ title: title.trim(), notes: notes.trim(), tags: parsedTags });
  const [saveError, setSaveError] = useState<string | null>(null);
  const needsMoreParticipants = isDirectSplit && adHocParticipants.length < 2;
  const validation = useMemo(() => {
    const result = validateExpenseInvariants({
      amountMinor: totalConvertedMinor,
      splitMode,
      payers: computedPayers,
      splits: computedSplits,
    });
    return needsMoreParticipants || fxMissing || textProblems.length > 0 ? { ...result, valid: false } : result;
  }, [totalConvertedMinor, splitMode, computedPayers, computedSplits, needsMoreParticipants, fxMissing, textProblems.length]);

  const handleAttachSampleReceipt = () => {
    const draftExpId = initialExpense?.id ?? newId('exp');
    const sampleReceipt = createSampleWebpReceiptAttachment(
      draftExpId,
      title.trim() || 'Shared Bill Receipt',
      dataset.currentUser.fullName
    );
    setAttachedReceipts((prev) => [...prev, sampleReceipt]);
  };

  const handleReceiptFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const draftExpId = initialExpense?.id ?? newId('exp');
    const baseName = file.name.replace(/\.[^.]+$/, '') || 'receipt';
    const webpFileName = file.type === 'application/pdf' ? file.name : `${baseName}.webp`;
    const sizeKb = Math.max(1, Math.round(file.size / 1024));

    const reader = new FileReader();
    reader.onload = () => {
      const rawDataUrl = typeof reader.result === 'string' ? reader.result : '';
      const appendAttachment = (finalDataUrl: string, finalMime: string) => {
        const commaIdx = finalDataUrl.indexOf(',');
        const b64Len = commaIdx >= 0 ? finalDataUrl.length - commaIdx - 1 : finalDataUrl.length;
        const postCompressBytes = Math.max(1, Math.floor((b64Len * 3) / 4));
        const computedSizeKb = Math.max(1, Math.round(postCompressBytes / 1024));
        const attachment: ReceiptAttachment = {
          id: newId('rcp'),
          expenseId: draftExpId,
          fileName: webpFileName,
          mimeType: finalMime,
          sizeKb: finalDataUrl ? computedSizeKb : sizeKb,
          uploadedByName: dataset.currentUser.fullName,
          createdAt: new Date().toISOString(),
          previewNote: 'Saved privately on this device (0 KB uploaded to cloud)',
          sha256: sha256Hex(finalDataUrl),
          localDeviceOnly: true,
          storageBucket: 'local-device-only',
          storagePath: `local-device/${draftExpId}.webp`,
          dataUrl: finalDataUrl,
        };
        setAttachedReceipts((prev) => [...prev, attachment]);
      };

      if (file.type.startsWith('image/') && typeof document !== 'undefined') {
        const img = new window.Image();
        img.onload = () => {
          try {
            const canvas = document.createElement('canvas');
            const maxDim = 960;
            const scale = Math.min(1, maxDim / Math.max(img.width || 320, img.height || 180));
            canvas.width = Math.max(1, Math.round((img.width || 320) * scale));
            canvas.height = Math.max(1, Math.round((img.height || 180) * scale));
            const ctx = canvas.getContext('2d');
            if (ctx) {
              ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
              const compressedUrl = canvas.toDataURL('image/webp', 0.82);
              appendAttachment(compressedUrl || rawDataUrl, 'image/webp');
              return;
            }
          } catch {
            // Fallback to raw DataURL
          }
          appendAttachment(rawDataUrl, 'image/webp');
        };
        img.onerror = () => {
          appendAttachment(rawDataUrl, 'image/webp');
        };
        img.src = rawDataUrl;
      } else {
        appendAttachment(rawDataUrl, file.type || 'image/webp');
      }
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const handleRemoveReceipt = (receiptId: string) => {
    setAttachedReceipts((prev) => prev.filter((r) => r.id !== receiptId));
  };

  const handleSaveDefaultSplit = () => {
    if (!selectedGroup) return;
    const memberValues: Record<string, number> = {};
    for (const p of participantInputs) {
      if (p.included) {
        memberValues[p.memberId] = p.rawInputValue;
      }
    }
    saveDefaultSplitPreset(selectedGroup.id, {
      label: `Custom ${splitMode.toUpperCase()} Split`,
      splitMode,
      memberValues,
    });
  };

  const handleSaveExpense = () => {
    if (!validation.valid || !activeFx) return;

    const lockedAdHocParticipants = () => {
      const myId = adHocParticipants.find(isSelfParticipant)?.id ?? null;
      const isOwner = !initialExpense || initialExpense.createdByMemberId === myId;
      return lockParticipantUpiIds(adHocParticipants, initialExpense?.adHocParticipants, myId, isOwner);
    };

    const defaultTags = isDirectSplit
      ? ['#direct-split', '#no-group', `#${category}`]
      : [`#${category}`];

    const payload = {
      id: initialExpense?.id,
      groupId: isDirectSplit ? null : selectedGroup!.id,
      adHocParticipants: isDirectSplit ? lockedAdHocParticipants() : undefined,
      title:
        title.trim() ||
        (isDirectSplit ? 'Direct Non-Group Expense' : 'Shared Group Expense'),
      category,
      tags: parsedTags.length > 0 ? parsedTags : defaultTags,
      notes,
      expenseDate,
      originalCurrency,
      originalAmountMinor,
      fxRateScaled: activeFx.rateScaled,
      fxStatus: activeFx.status,
      fxRateDate: activeFx.rateDate,
      splitMode,
      payers: computedPayers,
      splits: computedSplits,
      receipts: attachedReceipts,
      baseHlc: initialExpense?.hlc,
    };

    try {
      if (!upsertExpense(payload as unknown as Parameters<typeof upsertExpense>[0])) {
        setSaveError('This bill could not be saved. Check the details above and try again.');
        return;
      }
    } catch {
      setSaveError('This bill could not be saved. Check the amount and exchange rate, then try again.');
      return;
    }
    onClose();
  };

  if (!isOpen) return null;

  const baseMeta = getCurrency(effectiveBaseCurrency);
  const origMeta = getCurrency(originalCurrency);
  const minorUnitLabel =
    baseMeta.decimals === 0 ? 'units' : baseMeta.decimals === 3 ? 'fils' : 'paise/cents';
  const remainderWinners = computedSplits
    .filter((s) => s.included && s.remainderMinor === 1)
    .map(
      (s) =>
        currentParticipants.find((m) => m.id === s.memberId)?.displayName ?? s.memberId
    );

  // Settl-style quick-amount preset increments adapted to currency decimals
  const quickAmountPresets =
    origMeta.decimals === 0
      ? [500, 1000, 5000, 10000]
      : origMeta.decimals === 3
      ? [5, 10, 25, 50]
      : [100, 250, 500, 1000];

  const applyAmountString = (nextVal: string) => {
    setAmountInput(nextVal);
    if (splitMode === 'exact') {
      const nextOrigMinor = Math.max(0, parseMajorToMinor(nextVal, originalCurrency, INPUT_LOCALE));
      const nextConv = activeFx
        ? convertMinorAmountWithFx({
            originalMinor: nextOrigMinor,
            fromCurrency: originalCurrency,
            toCurrency: effectiveBaseCurrency,
            fxRateScaled: activeFx.rateScaled,
            fxStatus: activeFx.status,
            dateIso: activeFx.rateDate,
          }).convertedMinor
        : 0;
      const eqSplits = calculateSplits({
        totalMinor: nextConv,
        originalTotalMinor: nextOrigMinor,
        splitMode: 'equal',
        rotationSeed,
        participants: currentParticipants.map((m) => ({
          memberId: m.id,
          memberOrder: m.memberOrder,
          included: includedMembers[m.id] !== false,
          rawInputValue: 1,
        })),
      });
      const nextStr: Record<string, string> = {};
      for (const sp of eqSplits) {
        nextStr[sp.memberId] = formatMinorToMajor(
          sp.owedMinor,
          effectiveBaseCurrency,
          false
        ).replace(/,/g, '');
      }
      setMemberInputStrings(nextStr);
    }
  };

  const handleQuickAddPreset = (incrementMajor: number) => {
    const nextMinor = originalAmountMinor + incrementMajor * Number(getMinorScaleFactor(originalCurrency));
    const text = toAmountInput(nextMinor, originalCurrency);
    applyAmountString(/[.,]/.test(text) ? text.replace(/0+$/, '').replace(/[.,]$/, '') : text);
  };

  // Splitwise-style live human-readable split summary sentence
  const includedCount = computedSplits.filter((s) => s.included).length;
  const myParticipant =
    currentParticipants.find((m) => m.userId === dataset.currentUser.id) ??
    currentParticipants[0];
  const myPaidOnDraft = myParticipant
    ? computedPayers
        .filter((p) => p.memberId === myParticipant.id)
        .reduce((sum, p) => sum + p.paidMinor, 0)
    : 0;
  const myOwedOnDraft = myParticipant
    ? computedSplits.find((s) => s.memberId === myParticipant.id && s.included)?.owedMinor ?? 0
    : 0;
  const myNetDraftMinor = myPaidOnDraft - myOwedOnDraft;

  const payerLabelText = (() => {
    if (!isMultiPayer) {
      const p = currentParticipants.find((m) => m.id === singlePayerId);
      if (!p) return 'You';
      return p.userId === dataset.currentUser.id ? `You (${p.displayName.split(' ')[0]})` : p.displayName;
    }
    if (computedPayers.length === 0) return 'Multiple payers';
    if (computedPayers.length === 1) {
      const p = currentParticipants.find((m) => m.id === computedPayers[0]!.memberId);
      return p?.displayName ?? '1 payer';
    }
    return `${computedPayers.length} people (${computedPayers
      .map((cp) => currentParticipants.find((m) => m.id === cp.memberId)?.displayName.split(' ')[0] ?? '')
      .filter(Boolean)
      .join(' + ')})`;
  })();

  const activeModeVerb =
    SPLIT_MODES.find((m) => m.mode === splitMode)?.verb ?? 'equally';
  const approxPerPersonMinor =
    includedCount > 0 ? Math.floor(totalConvertedMinor / includedCount) : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-3 sm:p-6 overflow-y-auto">
      <div className="w-full max-w-3xl my-auto">
        <DoubleBezelCard
          className="shadow-2xl"
          innerClassName="max-h-[90vh] overflow-y-auto space-y-5 bg-white dark:bg-[#111827] text-slate-900 dark:text-slate-100"
        >
          {/* Modal Header */}
          <div className="flex items-start justify-between gap-4 border-b border-slate-200/80 dark:border-white/10 pb-4">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge tone={isDirectSplit ? 'blue' : 'emerald'}>
                  <Coins className="w-3.5 h-3.5" weight="duotone" />
                  <span>
                    {initialExpense
                      ? `Edit Bill (Version #${initialExpense.revisionNumber})`
                      : isDirectSplit
                      ? 'Direct 1-on-1 / Ad-Hoc Split'
                      : 'New Group Bill'}
                  </span>
                </StatusBadge>
                <CurrencyPrecisionPill currencyCode={effectiveBaseCurrency} />
              </div>
              <h2 className="mt-1.5 text-lg sm:text-xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
                {initialExpense
                  ? `Update "${initialExpense.title}"`
                  : isDirectSplit
                  ? `Split Directly Between ${adHocParticipants.length} People`
                  : `Add Bill to ${selectedGroup?.name ?? activeGroup.name}`}
              </h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl p-2 text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/10 transition-colors cursor-pointer"
              aria-label="Close modal"
            >
              <X className="w-5 h-5" weight="bold" />
            </button>
          </div>

          {remoteChanged && liveExpense && (
            <div
              data-testid="expense-remote-update-notice"
              role="status"
              className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-sky-500/30 bg-sky-500/[0.06] px-3.5 py-2.5 text-xs text-slate-700 dark:text-slate-200"
            >
              <span>This bill was updated on another device. Your changes are kept until you reload it.</span>
              <button
                type="button"
                data-testid="expense-reload-remote-btn"
                onClick={() => initForm(liveExpense)}
                className="min-h-[44px] rounded-xl px-3 py-2 font-semibold text-sky-700 dark:text-sky-300 hover:bg-sky-500/10 cursor-pointer"
              >
                Reload latest version
              </button>
            </div>
          )}

          {/* Group / Scope Selector */}
          <div className="rounded-2xl border border-slate-200 dark:border-white/10 bg-slate-50/80 dark:bg-slate-900/60 p-3.5">
            <label className="block text-xs font-bold uppercase tracking-wider text-slate-600 dark:text-slate-300 mb-1.5">
              <span className="inline-flex items-center gap-1.5">
                <FolderOpen className="w-4 h-4 text-[#059669]" weight="duotone" />
                <span>Expense Scope (Group or Direct Non-Group Split)</span>
              </span>
            </label>
            <select
              data-testid="expense-group-scope-select"
              value={selectedGroupId}
              onChange={(e) => handleGroupScopeChange(e.target.value)}
              className="w-full rounded-xl border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-900 px-3.5 py-2.5 text-sm font-semibold text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-[#059669]"
            >
              <option value="">
                No Group (Direct Split Between Added Participants)
              </option>
              {activeGroups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name} ({g.baseCurrency})
                </option>
              ))}
            </select>
          </div>

          {/* Inline Direct Participants Builder (Only when No Group is selected) */}
          {isDirectSplit && (
            <div
              data-testid="adhoc-participants-panel"
              className="rounded-2xl border border-sky-500/30 bg-sky-500/[0.05] dark:bg-sky-500/[0.06] p-4 space-y-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <UserPlus className="w-4 h-4 text-sky-600 dark:text-sky-400" weight="duotone" />
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-800 dark:text-slate-200">
                    Direct Split Participants ({adHocParticipants.length})
                  </span>
                </div>
                <span className="text-[11px] text-slate-500 dark:text-slate-400">
                  No group required - settles in Friends &amp; Settle Hub
                </span>
              </div>

              {/* Active Ad-Hoc Participants Pills */}
              <div className="flex flex-wrap items-center gap-2">
                {adHocParticipants.map((p) => {
                  const canRemove = !isSelfParticipant(p);
                  return (
                    <span
                      key={p.id}
                      className="inline-flex items-center gap-2 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-white/10 px-3 py-1.5 text-xs font-semibold text-slate-800 dark:text-slate-200 shadow-sm"
                    >
                      <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-sky-500/15 text-sky-700 dark:text-sky-300 text-[10px] font-bold">
                        {p.avatarInitials}
                      </span>
                      <span>{p.displayName}</span>
                      {isSelfParticipant(p) && (
                        <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-mono">
                          (You)
                        </span>
                      )}
                      {canRemove && (
                        <button
                          type="button"
                          onClick={() => handleRemoveAdHocParticipant(p.id)}
                          className="text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 transition-colors"
                          title={`Remove ${p.displayName}`}
                        >
                          <Trash className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </span>
                  );
                })}
              </div>

              {/* Custom Friend Input */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 pt-1 border-t border-slate-200/70 dark:border-white/10">
                <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                  Add the friends you are splitting this bill with.
                </span>

                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    data-testid="adhoc-friend-name-input"
                    maxLength={LIMITS.personName}
                    value={customFriendName}
                    onChange={(e) => setCustomFriendName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleAddCustomFriend();
                      }
                    }}
                    placeholder="Add person by name..."
                    className="w-full sm:w-44 rounded-lg border border-slate-300 dark:border-white/15 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-[#059669]"
                  />
                  <button
                    type="button"
                    data-testid="add-adhoc-friend-btn"
                    onClick={handleAddCustomFriend}
                    className="inline-flex items-center gap-1 rounded-lg bg-[#059669] hover:bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition-colors shrink-0"
                  >
                    <Plus className="w-3.5 h-3.5" weight="bold" />
                    <span>Add</span>
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Core Bill Details */}
          <div className="grid grid-cols-1 sm:grid-cols-12 gap-3.5">
            <div className="sm:col-span-7">
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
                Expense Title
              </label>
              <input
                type="text"
                data-testid="expense-title-input"
                maxLength={LIMITS.expenseTitle}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g., Thalassa Cliff Dinner or Blue Tokai Coffee"
                className="w-full rounded-xl border border-slate-300 dark:border-white/15 bg-slate-50 dark:bg-slate-900/90 px-3.5 py-2.5 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-[#059669]"
              />
            </div>

            <div className="sm:col-span-5">
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
                <span className="inline-flex items-center gap-1">
                  <Tag className="w-3.5 h-3.5" />
                  <span>Category</span>
                </span>
              </label>
              <select
                data-testid="expense-category-select"
                value={category}
                onChange={(e) => setCategory(e.target.value as ExpenseCategoryKey)}
                className="w-full rounded-xl border border-slate-300 dark:border-white/15 bg-slate-50 dark:bg-slate-900/90 px-3.5 py-2.5 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-[#059669]"
              >
                {dataset.categoriesCatalog.map((cat) => (
                  <option key={cat.key} value={cat.key}>
                    {cat.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="sm:col-span-4">
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
                Bill Amount ({originalCurrency})
              </label>
              <input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                data-testid="expense-amount-input"
                value={amountInput}
                onChange={(e) => applyAmountString(e.target.value)}
                aria-invalid={amountInput.trim() !== '' && originalAmountMinor <= 0}
                placeholder={toAmountInput(0, originalCurrency)}
                className="w-full rounded-xl border border-slate-300 dark:border-white/15 bg-slate-50 dark:bg-slate-900/90 px-3.5 py-2.5 font-mono tabular-nums text-sm font-semibold text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-[#059669]"
              />
            </div>

            <div className="sm:col-span-4">
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
                Bill Currency
              </label>
              <select
                data-testid="expense-currency-select"
                value={originalCurrency}
                onChange={(e) => handleCurrencyChange(e.target.value)}
                className="w-full rounded-xl border border-slate-300 dark:border-white/15 bg-slate-50 dark:bg-slate-900/90 px-3.5 py-2.5 font-mono text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-[#059669]"
              >
                {allCurrencyOptions.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.code} - {c.name} ({c.symbol})
                  </option>
                ))}
              </select>
            </div>

            <div className="sm:col-span-4">
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
                <span className="inline-flex items-center gap-1">
                  <CalendarBlank className="w-3.5 h-3.5" />
                  <span>Expense Date</span>
                </span>
              </label>
              <input
                type="date"
                data-testid="expense-date-input"
                value={expenseDate}
                onChange={(e) => setExpenseDate(e.target.value)}
                className="w-full rounded-xl border border-slate-300 dark:border-white/15 bg-slate-50 dark:bg-slate-900/90 px-3.5 py-2.5 font-mono text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-[#059669]"
              />
            </div>

            {/* Settl-Style Quick Amount Preset Chips */}
            <div
              data-testid="ux-quick-amount-presets"
              className="sm:col-span-12 flex flex-wrap items-center gap-1.5"
            >
              <span className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 mr-1">
                Quick add amount:
              </span>
              {quickAmountPresets.map((amt) => (
                <button
                  key={amt}
                  type="button"
                  data-testid={`quick-amount-chip-${amt}`}
                  onClick={() => handleQuickAddPreset(amt)}
                  className="rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-slate-800/80 hover:border-emerald-500/40 hover:bg-emerald-500/10 px-2.5 py-1 font-mono tabular-nums text-xs font-semibold text-slate-700 dark:text-slate-200 transition-colors cursor-pointer"
                >
                  +{origMeta.symbol}
                  {amt.toLocaleString('en-IN')}
                </button>
              ))}
              {amountInput && (
                <button
                  type="button"
                  onClick={() => applyAmountString('')}
                  className="rounded-lg border border-slate-200 dark:border-white/10 bg-white dark:bg-slate-900 hover:text-rose-600 dark:hover:text-rose-400 px-2.5 py-1 text-xs font-semibold text-slate-500 dark:text-slate-400 transition-colors cursor-pointer"
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          {/* Splitwise-Style Live Plain-English Summary Sentence */}
          <div
            data-testid="ux-live-split-sentence"
            className="rounded-2xl border border-emerald-500/25 bg-emerald-500/[0.06] dark:bg-emerald-500/[0.08] px-4 py-3 flex flex-wrap items-center justify-between gap-2 text-xs sm:text-sm"
          >
            <div className="text-slate-700 dark:text-slate-200">
              Paid by <strong className="text-slate-900 dark:text-white">{payerLabelText}</strong>{' '}
              and split <strong className="text-slate-900 dark:text-white">{activeModeVerb}</strong>{' '}
              among{' '}
              <strong className="text-slate-900 dark:text-white">
                {includedCount} {includedCount === 1 ? 'person' : 'people'}
              </strong>
              {totalConvertedMinor > 0 && splitMode === 'equal' && includedCount > 0 && (
                <span className="ml-1 font-mono tabular-nums text-xs text-slate-600 dark:text-slate-300">
                  ({formatMinorToMajor(approxPerPersonMinor, effectiveBaseCurrency)}/person)
                </span>
              )}
            </div>

            {totalConvertedMinor > 0 && (
              <div className="font-mono tabular-nums text-xs font-bold">
                {myNetDraftMinor > 0 ? (
                  <span className="text-emerald-700 dark:text-emerald-300">
                    you lend {formatMinorToMajor(myNetDraftMinor, effectiveBaseCurrency)}
                  </span>
                ) : myNetDraftMinor < 0 ? (
                  <span className="text-rose-700 dark:text-rose-300">
                    you borrow {formatMinorToMajor(Math.abs(myNetDraftMinor), effectiveBaseCurrency)}
                  </span>
                ) : (
                  <span className="text-slate-500 dark:text-slate-400">settled on bill</span>
                )}
              </div>
            )}
          </div>

          {/* Foreign Currency FX Rate & Live Preview Bar */}
          {originalCurrency !== effectiveBaseCurrency && (
            <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/[0.06] p-3.5 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-xs font-semibold text-emerald-800 dark:text-emerald-300">
                  <ArrowsLeftRight className="w-4 h-4" weight="bold" />
                  <span>
                    Foreign Currency Conversion ({originalCurrency} to {effectiveBaseCurrency})
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    1 {originalCurrency} =
                  </span>
                  <input
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    data-testid="expense-fx-rate-input"
                    value={toLocaleDecimalInput(fxMode === 'manual' ? fxRateInput : activeFx ? formatScaledFxRate(activeFx.rateScaled) : '', INPUT_LOCALE)}
                    placeholder="Enter rate"
                    aria-invalid={fxMissing}
                    onChange={(e) => {
                      setFxRateInput(toLocaleDecimalInput(e.target.value, INPUT_LOCALE));
                      setFxMode('manual');
                    }}
                    className="w-28 rounded-lg border border-emerald-500/40 bg-white dark:bg-slate-900 px-2.5 py-1 font-mono tabular-nums text-xs font-semibold text-slate-900 dark:text-slate-100"
                  />
                  <span className="text-xs font-mono font-semibold text-slate-700 dark:text-slate-300">
                    {effectiveBaseCurrency}
                  </span>
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600 dark:text-slate-300">
                {fxMissing ? (
                  <span data-testid="fx-rate-missing" className="font-semibold text-amber-700 dark:text-amber-300">
                    No exchange rate is available for {originalCurrency} to {effectiveBaseCurrency}. Enter the rate to save this bill.
                  </span>
                ) : (
                  <span data-testid="fx-audit-note">{fxConversion.fxAuditNote}</span>
                )}
                <span className="font-mono tabular-nums font-bold text-emerald-700 dark:text-emerald-300">
                  Converted Total:{' '}
                  <CurrencyAmount
                    minorAmount={totalConvertedMinor}
                    currencyCode={effectiveBaseCurrency}
                  />
                </span>
              </div>
            </div>
          )}

          {/* Payer Configuration (Single vs Multiple Payers) */}
          <div className="rounded-2xl border border-slate-200 dark:border-white/10 bg-slate-50/70 dark:bg-slate-900/50 p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Users className="w-4 h-4 text-[#059669]" weight="duotone" />
                <span className="text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300">
                  Paid By
                </span>
              </div>
              <button
                type="button"
                data-testid="multi-payer-toggle"
                onClick={handleToggleMultiPayer}
                className={`min-h-[44px] inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                  isMultiPayer
                    ? 'bg-[#059669] text-white'
                    : 'bg-slate-200/80 dark:bg-white/10 text-slate-700 dark:text-slate-300 hover:bg-slate-300/70'
                }`}
              >
                <span>{isMultiPayer ? 'Multiple Payers Active' : 'Multiple Payers'}</span>
              </button>
            </div>

            {!isMultiPayer ? (
              <div className="flex flex-wrap items-center gap-2">
                {currentParticipants.map((m) => {
                  const selected = singlePayerId === m.id;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      data-testid={`payer-chip-${m.id}`}
                      disabled={m.isFormer}
                      title={m.isFormer ? 'Former member: kept on this bill, cannot be picked as a new payer' : undefined}
                      onClick={() => setSinglePayerId(m.id)}
                      className={`inline-flex items-center gap-2 rounded-xl px-3.5 py-2 text-xs font-semibold transition-all ${
                        selected
                          ? 'bg-[#059669] text-white shadow-sm'
                          : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-white/10'
                      }`}
                    >
                      <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-black/15 text-[10px] font-bold">
                        {m.avatarInitials}
                      </span>
                      <span>{m.displayName}{m.isFormer ? ' (former member)' : ''}</span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {currentParticipants.map((m) => (
                  <div
                    key={m.id}
                    className="flex items-center justify-between gap-2 rounded-xl bg-white dark:bg-slate-800/90 border border-slate-200 dark:border-white/10 px-3 py-2"
                  >
                    <span className="text-xs font-medium text-slate-800 dark:text-slate-200 truncate">
                      {m.displayName}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-mono text-slate-400">{baseMeta.symbol}</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        autoComplete="off"
                        data-testid={`payer-input-${m.id}`}
                        disabled={m.isFormer}
                        value={toLocaleDecimalInput(multiPayerInputs[m.id] ?? '0', INPUT_LOCALE)}
                        onChange={(e) =>
                          setMultiPayerInputs((prev) => ({ ...prev, [m.id]: toLocaleDecimalInput(e.target.value, INPUT_LOCALE) }))
                        }
                        className="w-24 rounded-lg border border-slate-300 dark:border-white/15 bg-slate-50 dark:bg-slate-900 px-2 py-1 text-right font-mono tabular-nums text-xs text-slate-900 dark:text-slate-100"
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 5 Split Modes + Group Default Preset Controls */}
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-700 dark:text-slate-300">
                How Should We Split It?
              </span>
              {selectedGroup && (
                <div className="flex flex-wrap items-center gap-2">
                  {selectedGroup.defaultSplitConfig && (
                    <button
                      type="button"
                      data-testid="apply-default-split-btn"
                      onClick={handleApplyDefaultSplit}
                      className="inline-flex items-center gap-1 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 ring-1 ring-emerald-500/30 px-2.5 py-1 text-xs font-semibold transition-colors cursor-pointer"
                    >
                      <Sparkle className="w-3.5 h-3.5" weight="fill" />
                      <span>Use Saved Split ({selectedGroup.defaultSplitConfig.label})</span>
                    </button>
                  )}
                  <button
                    type="button"
                    data-testid="save-default-split-btn"
                    onClick={handleSaveDefaultSplit}
                    className="inline-flex items-center gap-1 rounded-lg bg-slate-100 dark:bg-white/10 hover:bg-slate-200 dark:hover:bg-white/15 text-slate-700 dark:text-slate-300 px-2.5 py-1 text-xs font-semibold transition-colors cursor-pointer"
                  >
                    <FloppyDisk className="w-3.5 h-3.5" />
                    <span>Save Split as Default</span>
                  </button>
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              {SPLIT_MODES.map((item) => {
                const active = splitMode === item.mode;
                return (
                  <button
                    key={item.mode}
                    type="button"
                    data-testid={`split-mode-${item.mode}`}
                    onClick={() => handleSwitchSplitMode(item.mode)}
                    className={`rounded-xl px-3 py-2 text-left transition-all border cursor-pointer ${
                      active
                        ? 'bg-[#059669] text-white border-[#059669] shadow-sm'
                        : 'bg-slate-50 dark:bg-slate-900/70 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-white/10 hover:border-emerald-500/40'
                    }`}
                  >
                    <div className="text-xs font-bold">{item.label}</div>
                    <div
                      className={`text-[10px] truncate ${
                        active ? 'text-emerald-100' : 'text-slate-400 dark:text-slate-500'
                      }`}
                    >
                      {item.hint}
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Participant Split Rows */}
            <div className="space-y-2">
              {currentParticipants.map((m) => {
                const isInc = includedMembers[m.id] !== false;
                const splitShare = computedSplits.find((s) => s.memberId === m.id);
                const owedMinor = splitShare?.owedMinor ?? 0;
                const hasRotatedRemainder = splitShare?.remainderMinor === 1;
                const sharePct =
                  isInc && totalConvertedMinor > 0
                    ? `${((owedMinor / totalConvertedMinor) * 100).toFixed(1)}% of bill`
                    : isInc
                    ? 'Included'
                    : 'Not in split';

                return (
                  <div
                    key={m.id}
                    className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border px-3.5 py-2.5 transition-colors ${
                      isInc
                        ? 'border-slate-200 dark:border-white/10 bg-white dark:bg-slate-900/80'
                        : 'border-slate-200/50 dark:border-white/5 bg-slate-100/50 dark:bg-slate-900/30 opacity-60'
                    }`}
                  >
                    <label className="flex items-center gap-2.5 cursor-pointer min-h-[44px]">
                      <input
                        type="checkbox"
                        data-testid={`split-include-${m.id}`}
                        disabled={m.isFormer}
                        checked={isInc}
                        onChange={(e) =>
                          setIncludedMembers((prev) => ({ ...prev, [m.id]: e.target.checked }))
                        }
                        className="h-4 w-4 rounded border-slate-300 text-[#059669] focus:ring-[#059669]"
                      />
                      <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 text-xs font-bold">
                        {m.avatarInitials}
                      </span>
                      <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                        {m.displayName}
                      </span>
                      {m.isFormer && (
                        <StatusBadge tone="amber">
                          <span data-testid={`former-member-chip-${m.id}`}>Former member</span>
                        </StatusBadge>
                      )}
                      {hasRotatedRemainder && (
                        <StatusBadge tone="amber">
                          <span>+1 {minorUnitLabel} rotated</span>
                        </StatusBadge>
                      )}
                    </label>

                    <div className="flex items-center gap-3">
                      {isInc && splitMode !== 'equal' && (
                        <div className="flex items-center gap-1.5">
                          {splitMode === 'shares' && (
                            <span className="text-xs text-slate-400">Shares:</span>
                          )}
                          {splitMode === 'percentage' && (
                            <span className="text-xs text-slate-400">%:</span>
                          )}
                          {(splitMode === 'exact' || splitMode === 'adjustment') && (
                            <span className="text-xs font-mono text-slate-400">
                              {splitMode === 'adjustment' ? '+/-' : baseMeta.symbol}
                            </span>
                          )}
                          <input
                            type="text"
                            inputMode={splitMode === 'adjustment' ? 'text' : 'decimal'}
                            autoComplete="off"
                            data-testid={`split-input-${m.id}`}
                            disabled={m.isFormer}
                            value={toLocaleDecimalInput(memberInputStrings[m.id] ?? '', INPUT_LOCALE)}
                            onChange={(e) =>
                              setMemberInputStrings((prev) => ({
                                ...prev,
                                [m.id]: toLocaleDecimalInput(e.target.value, INPUT_LOCALE),
                              }))
                            }
                            className="w-24 rounded-lg border border-slate-300 dark:border-white/15 bg-slate-50 dark:bg-slate-800 px-2.5 py-1 text-right font-mono tabular-nums text-xs font-semibold text-slate-900 dark:text-slate-100"
                          />
                        </div>
                      )}

                      <div className="text-right min-w-[110px]">
                        <div className="text-sm font-bold font-mono tabular-nums">
                          <CurrencyAmount
                            minorAmount={owedMinor}
                            currencyCode={effectiveBaseCurrency}
                          />
                        </div>
                        <div className="text-[10px] font-medium text-slate-400">
                          {sharePct}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Optional Notes & Tags */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
                Notes (Optional)
              </label>
              <input
                type="text"
                data-testid="expense-notes-input"
                maxLength={LIMITS.expenseNotes}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="e.g., Includes tip, drinks, or room upgrade..."
                className="w-full rounded-xl border border-slate-300 dark:border-white/15 bg-slate-50 dark:bg-slate-900/90 px-3.5 py-2 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-[#059669]"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
                Tags (Optional)
              </label>
              <input
                type="text"
                data-testid="expense-tags-input"
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
                aria-invalid={textProblems.length > 0}
                placeholder="#dinner, #goa, #villa"
                className="w-full rounded-xl border border-slate-300 dark:border-white/15 bg-slate-50 dark:bg-slate-900/90 px-3.5 py-2 font-mono text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-[#059669]"
              />
              {textProblems.length > 0 && (
                <p data-testid="expense-text-problems" className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">
                  {textProblems.join(' ')}
                </p>
              )}
            </div>
          </div>

          {/* Receipt Attachment Section (Offline-Ready + Cloud Synced) */}
          <div
            data-testid="expense-receipt-section"
            className="rounded-2xl border border-slate-200 dark:border-white/10 bg-slate-50/70 dark:bg-slate-900/50 p-4 space-y-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="flex items-center gap-2">
                  <Paperclip className="w-4 h-4 text-[#059669]" weight="bold" />
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-800 dark:text-slate-200">
                    Receipt or Bill Photo (Optional)
                  </span>
                </div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                  Saved privately on this device (0 KB uploaded to cloud).
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <label className="inline-flex items-center gap-1.5 rounded-xl bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-white/10 px-3 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 cursor-pointer transition-colors">
                  <UploadSimple className="w-3.5 h-3.5 text-[#059669]" weight="bold" />
                  <span>Upload Photo / PDF</span>
                  <input
                    type="file"
                    accept="image/*,application/pdf"
                    data-testid="receipt-file-input"
                    onChange={handleReceiptFileChange}
                    className="hidden"
                  />
                </label>

                <button
                  type="button"
                  data-testid="attach-sample-receipt-btn"
                  onClick={handleAttachSampleReceipt}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-800 dark:text-emerald-300 ring-1 ring-emerald-500/30 px-3 py-1.5 text-xs font-semibold cursor-pointer transition-colors"
                >
                  <Image className="w-3.5 h-3.5" weight="duotone" />
                  <span>Attach Sample Receipt</span>
                </button>
              </div>
            </div>

            {attachedReceipts.length > 0 && (
              <div className="space-y-2 pt-1">
                {attachedReceipts.map((rcp) => (
                  <div
                    key={rcp.id}
                    data-testid="attached-receipt-badge"
                    className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white dark:bg-slate-900 border border-emerald-500/30 px-3 py-2 text-xs"
                  >
                    <div className="flex items-center gap-3">
                      {rcp.dataUrl && rcp.dataUrl.startsWith('data:image/') && (
                        <img
                          src={rcp.dataUrl}
                          alt={rcp.fileName}
                          className="h-9 w-14 rounded-lg object-cover border border-slate-200 dark:border-white/10"
                        />
                      )}
                      <div>
                        <div className="font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
                          <span>{rcp.fileName}</span>
                          <span className="font-mono text-[10px] text-emerald-600 dark:text-emerald-400">
                            ({rcp.sizeKb} KB)
                          </span>
                        </div>
                        <div className="text-[11px] text-slate-500 dark:text-slate-400">
                          {rcp.dataUrl
                            ? 'Stored on this device only (0 KB uploaded to cloud)'
                            : `Stored on ${rcp.uploadedByName}'s device (0 KB uploaded to cloud)`}
                        </div>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => handleRemoveReceipt(rcp.id)}
                      className="text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 p-1 transition-colors cursor-pointer"
                      title="Remove receipt"
                    >
                      <Trash className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Calm Settl-Style Live Reconciliation Status Bar */}
          <div
            data-testid="split-reconciliation-bar"
            className={`rounded-2xl border p-3.5 transition-colors ${
              totalConvertedMinor === 0
                ? 'border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-slate-900/60 text-slate-700 dark:text-slate-300'
                : validation.valid
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-900 dark:text-emerald-200'
                : 'border-rose-500/30 bg-rose-500/10 text-rose-900 dark:text-rose-200'
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs font-bold">
                {totalConvertedMinor === 0 ? (
                  <Coins className="w-4 h-4 text-slate-500 dark:text-slate-400" weight="duotone" />
                ) : validation.valid ? (
                  <CheckCircle className="w-4 h-4 text-emerald-600 dark:text-emerald-400" weight="fill" />
                ) : (
                  <WarningCircle className="w-4 h-4 text-rose-600 dark:text-rose-400" weight="fill" />
                )}
                <span>
                  {totalConvertedMinor === 0
                    ? 'Enter a bill amount above to calculate shares'
                    : validation.valid
                    ? `100% Reconciled • ${formatMinorToMajor(0, effectiveBaseCurrency)} left - Ready to save`
                    : needsMoreParticipants
                    ? 'Add at least one friend to split this bill with'
                    : validation.unallocatedSplitMinor > 0
                    ? `${formatMinorToMajor(validation.unallocatedSplitMinor, effectiveBaseCurrency)} left to assign`
                    : validation.unallocatedSplitMinor < 0
                    ? `${formatMinorToMajor(Math.abs(validation.unallocatedSplitMinor), effectiveBaseCurrency)} over-assigned`
                    : 'Adjust payer or split amounts to match bill total'}
                </span>
              </div>

              {totalConvertedMinor > 0 && (
                <div className="font-mono tabular-nums text-xs">
                  {validation.unallocatedSplitMinor === 0 ? (
                    <span>
                      Total:{' '}
                      <CurrencyAmount
                        minorAmount={totalConvertedMinor}
                        currencyCode={effectiveBaseCurrency}
                      />
                    </span>
                  ) : (
                    <span>
                      Remaining:{' '}
                      <CurrencyAmount
                        minorAmount={validation.unallocatedSplitMinor}
                        currencyCode={effectiveBaseCurrency}
                      />
                    </span>
                  )}
                  {isMultiPayer && validation.unallocatedPayerMinor !== 0 && (
                    <>
                      {' • '}
                      <span>
                        Payer diff:{' '}
                        <CurrencyAmount
                          minorAmount={validation.unallocatedPayerMinor}
                          currencyCode={effectiveBaseCurrency}
                        />
                      </span>
                    </>
                  )}
                </div>
              )}
            </div>

            {totalConvertedMinor > 0 && remainderWinners.length > 0 && (
              <div className="mt-1.5 text-[11px] text-amber-700 dark:text-amber-300">
                Odd cent/paisa fairness: +1 {minorUnitLabel} assigned to{' '}
                <strong>{remainderWinners.join(', ')}</strong> (rotates fairly each bill)
              </div>
            )}

            {totalConvertedMinor > 0 && !validation.valid && validation.errors.length > 0 && (
              <ul className="mt-2 space-y-1 text-xs text-rose-700 dark:text-rose-300 list-disc list-inside">
                {validation.errors.map((err, i) => (
                  <li key={i}>{err}</li>
                ))}
              </ul>
            )}
          </div>

          {saveError && (
            <p data-testid="expense-save-error" role="alert" className="text-xs font-semibold text-rose-700 dark:text-rose-300">
              {saveError}
            </p>
          )}

          {/* Modal Footer Actions */}
          <div className="flex items-center justify-end gap-3 pt-2 border-t border-slate-200/80 dark:border-white/10">
            <button
              type="button"
              onClick={onClose}
              className="min-h-[44px] rounded-xl px-4 py-2.5 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/10 transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="save-expense-btn"
              disabled={!validation.valid}
              onClick={handleSaveExpense}
              className={`min-h-[44px] inline-flex items-center gap-2 rounded-xl px-5 py-2.5 text-xs font-bold text-white transition-all ${
                validation.valid
                  ? 'bg-[#059669] hover:bg-emerald-600 shadow-md shadow-emerald-600/20 cursor-pointer'
                  : 'bg-slate-400 dark:bg-slate-700 cursor-not-allowed opacity-60'
              }`}
            >
              <CheckCircle className="w-4 h-4" weight="bold" />
              <span>{initialExpense ? 'Save Changes' : 'Save Bill'}</span>
            </button>
          </div>
        </DoubleBezelCard>
      </div>
    </div>
  );
}
