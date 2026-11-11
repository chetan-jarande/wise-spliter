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
  ReceiptAttachment,
  SplitMode,
} from '../../types/ledger';
import { useLedger } from '../../state/LedgerContext';
import { createSampleWebpReceiptAttachment } from '../../portability/portability-engine';
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
  parseFxRateToScaled,
  parseMajorToMinor,
} from '../../domain/money/currencies';
import {
  SplitParticipantInput,
  calculateSplits,
  validateExpenseInvariants,
} from '../../domain/splits/split-calculator';

export interface ExpenseEditorModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialExpense?: ExpenseItem | null;
  defaultGroupId?: string | null; // When opened from a group, pass group.id; when opened from Home Quick-Add, pass null
}

const SPLIT_MODES: Array<{ mode: SplitMode; label: string; hint: string }> = [
  { mode: 'equal', label: 'Equal', hint: 'Deterministic rotating remainder' },
  { mode: 'exact', label: 'Exact', hint: 'Exact minor units per person' },
  { mode: 'percentage', label: 'Percentage', hint: 'Basis points totaling 100.00%' },
  { mode: 'shares', label: 'Shares', hint: 'Proportional ratio weights (2x, 1x)' },
  { mode: 'adjustment', label: '+/- Adjust', hint: 'Equal base plus custom item delta' },
];

const DEFAULT_ADHOC_PARTICIPANTS: AdHocParticipant[] = [
  {
    id: 'adhoc_arjun',
    displayName: 'Arjun Mehta',
    invitedEmail: 'arjun.mehta@gmail.com',
    upiId: 'arjun.mehta@okicici',
    avatarInitials: 'AM',
    memberOrder: 0,
  },
  {
    id: 'adhoc_rohan',
    displayName: 'Rohan Verma',
    invitedEmail: 'rohan.verma@gmail.com',
    upiId: 'rohan.verma@okaxis',
    avatarInitials: 'RV',
    memberOrder: 1,
  },
];

const KNOWN_ADHOC_CONTACTS: Array<Omit<AdHocParticipant, 'memberOrder'>> = [
  {
    id: 'adhoc_priya',
    displayName: 'Priya Nair',
    invitedEmail: 'priya.nair@gmail.com',
    upiId: 'priya.nair@oksbi',
    avatarInitials: 'PN',
  },
  {
    id: 'adhoc_kabir',
    displayName: 'Kabir Kapoor',
    invitedEmail: 'kabir.kapoor@gmail.com',
    upiId: 'kabir.kapoor@okhdfcbank',
    avatarInitials: 'KK',
  },
  {
    id: 'adhoc_neha',
    displayName: 'Neha Sharma',
    invitedEmail: 'neha.sharma@gmail.com',
    upiId: 'neha.sharma@okicici',
    avatarInitials: 'NS',
  },
  {
    id: 'adhoc_rohan',
    displayName: 'Rohan Verma',
    invitedEmail: 'rohan.verma@gmail.com',
    upiId: 'rohan.verma@okaxis',
    avatarInitials: 'RV',
  },
];

function computeInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]![0] ?? ''}${parts[parts.length - 1]![0] ?? ''}`.toUpperCase();
  }
  return name.trim().slice(0, 2).toUpperCase() || 'FR';
}

export function ExpenseEditorModal({
  isOpen,
  onClose,
  initialExpense = null,
  defaultGroupId,
}: ExpenseEditorModalProps) {
  const { dataset, activeGroup, isOnline, upsertExpense, saveDefaultSplitPreset } = useLedger();

  const activeGroups = useMemo(
    () => dataset.groups.filter((g) => !g.deletedAt),
    [dataset.groups]
  );

  const resolveInitialScopeGroupId = (): string => {
    if (initialExpense) {
      return initialExpense.groupId ?? '';
    }
    if (defaultGroupId !== undefined) {
      return defaultGroupId ?? '';
    }
    return activeGroup.id;
  };

  const [selectedGroupId, setSelectedGroupId] = useState<string>(resolveInitialScopeGroupId);
  const [adHocParticipants, setAdHocParticipants] = useState<AdHocParticipant[]>(
    DEFAULT_ADHOC_PARTICIPANTS
  );
  const [customFriendName, setCustomFriendName] = useState('');

  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<ExpenseCategoryKey>('food');
  const [expenseDate, setExpenseDate] = useState('2026-11-11');
  const [amountInput, setAmountInput] = useState('');
  const [originalCurrency, setOriginalCurrency] = useState(activeGroup.baseCurrency);
  const [fxRateInput, setFxRateInput] = useState('1.00');
  const [fxStatus, setFxStatus] = useState<FxStatus>('identity');
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

  const selectedGroup = useMemo(() => {
    if (isDirectSplit) return null;
    return activeGroups.find((g) => g.id === selectedGroupId) ?? activeGroup;
  }, [isDirectSplit, activeGroups, selectedGroupId, activeGroup]);

  const effectiveBaseCurrency = selectedGroup ? selectedGroup.baseCurrency : originalCurrency;

  const currentParticipants = useMemo(() => {
    if (selectedGroup) {
      return selectedGroup.members.map((m) => ({
        id: m.id,
        displayName: m.displayName,
        avatarInitials: m.avatarInitials,
        memberOrder: m.memberOrder,
        userId: m.userId,
      }));
    }
    return adHocParticipants.map((p, idx) => ({
      id: p.id,
      displayName: p.displayName,
      avatarInitials: p.avatarInitials,
      memberOrder: idx,
      userId: p.id === 'adhoc_arjun' ? dataset.currentUser.id : null,
    }));
  }, [selectedGroup, adHocParticipants, dataset.currentUser.id]);

  const allCurrencyOptions = useMemo(() => {
    const primaryCodes = new Set(dataset.currenciesCatalog.map((c) => c.code));
    const extras = Object.values(SUPPORTED_CURRENCIES)
      .filter((c) => !primaryCodes.has(c.code))
      .sort((a, b) => a.code.localeCompare(b.code));
    return [...dataset.currenciesCatalog, ...extras];
  }, [dataset.currenciesCatalog]);

  useEffect(() => {
    if (!isOpen) return;

    const initGroupId = initialExpense
      ? initialExpense.groupId ?? ''
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
      initialExpense?.adHocParticipants && initialExpense.adHocParticipants.length >= 2
        ? initialExpense.adHocParticipants.map((p, i) => ({ ...p, memberOrder: i }))
        : DEFAULT_ADHOC_PARTICIPANTS.map((p, i) => ({ ...p, memberOrder: i }));

    setAdHocParticipants(initAdHoc);

    const activeRoster = targetGroup ? targetGroup.members : initAdHoc;
    const baseCurr = targetGroup
      ? targetGroup.baseCurrency
      : initialExpense?.originalCurrency ?? dataset.currentUser.defaultCurrency ?? 'INR';

    if (initialExpense) {
      setTitle(initialExpense.title);
      setCategory(initialExpense.category);
      setExpenseDate(initialExpense.expenseDate);
      setOriginalCurrency(initialExpense.originalCurrency);
      setAmountInput(
        formatMinorToMajor(
          initialExpense.originalAmountMinor,
          initialExpense.originalCurrency,
          false
        ).replace(/,/g, '')
      );
      setFxRateInput(formatScaledFxRate(initialExpense.fxRateScaled));
      setFxStatus(initialExpense.fxStatus);
      setNotes(initialExpense.notes);
      setTagsInput(initialExpense.tags.join(', '));
      setSplitMode(initialExpense.splitMode);

      const multi = initialExpense.payers.length > 1;
      setIsMultiPayer(multi);
      setSinglePayerId(initialExpense.payers[0]?.memberId ?? activeRoster[0]?.id ?? '');

      const payerMap: Record<string, string> = {};
      for (const m of activeRoster) {
        const foundPayer = initialExpense.payers.find((p) => p.memberId === m.id);
        payerMap[m.id] = foundPayer
          ? formatMinorToMajor(foundPayer.paidMinor, baseCurr, false).replace(/,/g, '')
          : '0';
      }
      setMultiPayerInputs(payerMap);

      const incMap: Record<string, boolean> = {};
      const strMap: Record<string, string> = {};
      for (const m of activeRoster) {
        const sp = initialExpense.splits.find((s) => s.memberId === m.id);
        incMap[m.id] = sp ? sp.included : true;
        if (!sp) {
          strMap[m.id] = '1';
        } else if (initialExpense.splitMode === 'percentage') {
          strMap[m.id] = (sp.rawInputValue / 100).toFixed(2).replace(/\.00$/, '');
        } else if (
          initialExpense.splitMode === 'exact' ||
          initialExpense.splitMode === 'adjustment'
        ) {
          strMap[m.id] = formatMinorToMajor(sp.rawInputValue, baseCurr, false).replace(/,/g, '');
        } else {
          strMap[m.id] = String(sp.rawInputValue || 1);
        }
      }
      setIncludedMembers(incMap);
      setMemberInputStrings(strMap);
      setAttachedReceipts(initialExpense.receipts ?? []);
    } else {
      setTitle('');
      setCategory('food');
      setExpenseDate('2026-11-11');
      setOriginalCurrency(baseCurr);
      setAmountInput('');
      setFxRateInput('1.00');
      setFxStatus('identity');
      setNotes('');
      setTagsInput('');
      setSplitMode('equal');
      setIsMultiPayer(false);
      setAttachedReceipts([]);
      const defaultPayer = targetGroup
        ? targetGroup.members.find((m) => m.userId === dataset.currentUser.id)?.id ??
          targetGroup.members[0]?.id ??
          ''
        : initAdHoc[0]?.id ?? 'adhoc_arjun';
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
  }, [isOpen, initialExpense, defaultGroupId, activeGroup, dataset.groups, dataset.currentUser]);

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

    if (nextOrigCurrency === nextBaseCurrency) {
      setFxRateInput('1.00');
      setFxStatus('identity');
    } else {
      const fromInr = dataset.fxRatesToInr[nextOrigCurrency] ?? 1;
      const toInr = dataset.fxRatesToInr[nextBaseCurrency] ?? 1;
      const crossRate = fromInr / toInr;
      setFxRateInput(crossRate.toFixed(crossRate >= 10 ? 2 : 4));
      setFxStatus(isOnline ? 'live' : 'cached_offline');
    }
  };

  const handleGroupScopeChange = (nextGroupId: string) => {
    setSelectedGroupId(nextGroupId);
    if (nextGroupId === '') {
      const roster =
        adHocParticipants.length >= 2 ? adHocParticipants : DEFAULT_ADHOC_PARTICIPANTS;
      setAdHocParticipants(roster);
      const nextCurr = originalCurrency || dataset.currentUser.defaultCurrency || 'INR';
      setOriginalCurrency(nextCurr);
      syncParticipantStateForRoster(
        roster.map((p, idx) => ({
          id: p.id,
          memberOrder: idx,
          userId: p.id === 'adhoc_arjun' ? dataset.currentUser.id : null,
        })),
        nextCurr,
        nextCurr
      );
    } else {
      const grp = dataset.groups.find((g) => g.id === nextGroupId && !g.deletedAt) ?? activeGroup;
      setOriginalCurrency(grp.baseCurrency);
      syncParticipantStateForRoster(grp.members, grp.baseCurrency, grp.baseCurrency);
    }
  };

  const handleAddAdHocParticipant = (contact: Omit<AdHocParticipant, 'memberOrder'>) => {
    const trimmedName = contact.displayName.trim();
    if (!trimmedName) return;
    const exists = adHocParticipants.some(
      (p) => p.id === contact.id || p.displayName.toLowerCase() === trimmedName.toLowerCase()
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
    const matchedKnown = KNOWN_ADHOC_CONTACTS.find(
      (c) => c.displayName.toLowerCase() === name.toLowerCase()
    );
    if (matchedKnown) {
      handleAddAdHocParticipant(matchedKnown);
    } else {
      const slug = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '');
      handleAddAdHocParticipant({
        id: `adhoc_${slug || 'friend'}_${Date.now()}`,
        displayName: name,
        invitedEmail: null,
        upiId: null,
        avatarInitials: computeInitials(name),
      });
    }
    setCustomFriendName('');
  };

  const handleRemoveAdHocParticipant = (participantId: string) => {
    if (adHocParticipants.length <= 2) return;
    const filtered = adHocParticipants
      .filter((p) => p.id !== participantId)
      .map((p, idx) => ({ ...p, memberOrder: idx }));
    setAdHocParticipants(filtered);
    if (singlePayerId === participantId) {
      setSinglePayerId(filtered[0]?.id ?? 'adhoc_arjun');
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
    const targetBase = selectedGroup ? selectedGroup.baseCurrency : nextCurrency;
    if (nextCurrency === targetBase) {
      setFxRateInput('1.00');
      setFxStatus('identity');
    } else {
      const fromInr = dataset.fxRatesToInr[nextCurrency] ?? 1;
      const toInr = dataset.fxRatesToInr[targetBase] ?? 1;
      const crossRate = fromInr / toInr;
      setFxRateInput(crossRate.toFixed(crossRate >= 10 ? 2 : 4));
      setFxStatus(isOnline ? 'live' : 'cached_offline');
    }
  };

  const originalAmountMinor = useMemo(
    () => Math.max(0, parseMajorToMinor(amountInput, originalCurrency)),
    [amountInput, originalCurrency]
  );

  const fxRateScaled = useMemo(() => {
    if (originalCurrency === effectiveBaseCurrency) return 100000000;
    return parseFxRateToScaled(fxRateInput);
  }, [originalCurrency, effectiveBaseCurrency, fxRateInput]);

  const fxConversion = useMemo(
    () =>
      convertMinorAmountWithFx({
        originalMinor: originalAmountMinor,
        fromCurrency: originalCurrency,
        toCurrency: effectiveBaseCurrency,
        fxRateScaled,
        fxStatus:
          originalCurrency === effectiveBaseCurrency
            ? 'identity'
            : fxStatus === 'identity'
            ? isOnline
              ? 'live'
              : 'cached_offline'
            : fxStatus,
        dateIso: expenseDate,
      }),
    [
      originalAmountMinor,
      originalCurrency,
      effectiveBaseCurrency,
      fxRateScaled,
      fxStatus,
      isOnline,
      expenseDate,
    ]
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
    for (const m of selectedGroup.members) {
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
        rawInputValue = Math.max(0, Math.round(Number(strVal) || 0));
      } else if (splitMode === 'percentage') {
        rawInputValue = Math.max(0, Math.round((Number(strVal) || 0) * 100));
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

  const validation = useMemo(
    () =>
      validateExpenseInvariants({
        amountMinor: totalConvertedMinor,
        splitMode,
        payers: computedPayers,
        splits: computedSplits,
      }),
    [totalConvertedMinor, splitMode, computedPayers, computedSplits]
  );

  const handleAttachSampleReceipt = () => {
    const draftExpId = initialExpense?.id ?? `exp_${Date.now()}`;
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

    const draftExpId = initialExpense?.id ?? `exp_${Date.now()}`;
    const baseName = file.name.replace(/\.[^.]+$/, '') || 'receipt';
    const webpFileName = file.type === 'application/pdf' ? file.name : `${baseName}.webp`;
    const sizeKb = Math.max(1, Math.round(file.size / 1024));

    const reader = new FileReader();
    reader.onload = () => {
      const rawDataUrl = typeof reader.result === 'string' ? reader.result : '';
      const appendAttachment = (finalDataUrl: string, finalMime: string) => {
        const attachment: ReceiptAttachment = {
          id: `rcp_${draftExpId}_${Date.now()}`,
          expenseId: draftExpId,
          fileName: webpFileName,
          mimeType: finalMime,
          sizeKb,
          uploadedByName: dataset.currentUser.fullName,
          createdAt: new Date().toISOString(),
          previewNote:
            'Compressed WebP receipt stored in Local IndexedDB (local_receipt_blobs) & Supabase Storage (wise-spliter-receipts)',
          storageBucket: 'wise-spliter-receipts',
          storagePath: `receipts/${draftExpId}.webp`,
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
    if (!validation.valid) return;
    const parsedTags = tagsInput
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => (t.startsWith('#') ? t : `#${t}`));

    const defaultTags = isDirectSplit
      ? ['#direct-split', '#no-group', `#${category}`]
      : [`#${category}`];

    const payload = {
      id: initialExpense?.id,
      groupId: isDirectSplit ? null : selectedGroup!.id,
      adHocParticipants: isDirectSplit ? adHocParticipants : undefined,
      title:
        title.trim() ||
        (isDirectSplit ? 'Direct Non-Group Expense' : 'Shared Group Expense'),
      category,
      tags: parsedTags.length > 0 ? parsedTags : defaultTags,
      notes,
      expenseDate,
      originalCurrency,
      originalAmountMinor,
      fxRateScaled,
      fxStatus:
        originalCurrency === effectiveBaseCurrency
          ? 'identity'
          : fxStatus === 'identity'
          ? isOnline
            ? 'live'
            : 'cached_offline'
          : fxStatus,
      splitMode,
      payers: computedPayers,
      splits: computedSplits,
      receipts: attachedReceipts,
    };

    upsertExpense(payload as unknown as Parameters<typeof upsertExpense>[0]);
    onClose();
  };

  if (!isOpen) return null;

  const baseMeta = getCurrency(effectiveBaseCurrency);
  const minorUnitLabel =
    baseMeta.decimals === 0 ? 'units' : baseMeta.decimals === 3 ? 'fils' : 'paise/cents';
  const remainderWinners = computedSplits
    .filter((s) => s.included && s.remainderMinor === 1)
    .map(
      (s) =>
        currentParticipants.find((m) => m.id === s.memberId)?.displayName ?? s.memberId
    );

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
                      ? `Edit Expense (Rev #${initialExpense.revisionNumber})`
                      : isDirectSplit
                      ? 'Direct Non-Group Split'
                      : 'New Group Expense'}
                  </span>
                </StatusBadge>
                <CurrencyPrecisionPill currencyCode={effectiveBaseCurrency} />
              </div>
              <h2 className="mt-1.5 text-lg sm:text-xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
                {initialExpense
                  ? `Update "${initialExpense.title}"`
                  : isDirectSplit
                  ? `Split Directly Between ${adHocParticipants.length} Participants`
                  : `Log Bill in ${selectedGroup?.name ?? activeGroup.name}`}
              </h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl p-2 text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/10 transition-colors"
              aria-label="Close modal"
            >
              <X className="w-5 h-5" weight="bold" />
            </button>
          </div>

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
                  const canRemove = adHocParticipants.length > 2;
                  return (
                    <span
                      key={p.id}
                      className="inline-flex items-center gap-2 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-white/10 px-3 py-1.5 text-xs font-semibold text-slate-800 dark:text-slate-200 shadow-sm"
                    >
                      <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-sky-500/15 text-sky-700 dark:text-sky-300 text-[10px] font-bold">
                        {p.avatarInitials}
                      </span>
                      <span>{p.displayName}</span>
                      {p.id === 'adhoc_arjun' && (
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

              {/* Quick-Add Known Contacts + Custom Friend Input */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 pt-1 border-t border-slate-200/70 dark:border-white/10">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400 mr-1">
                    Quick add:
                  </span>
                  {KNOWN_ADHOC_CONTACTS.map((c) => {
                    const alreadyAdded = adHocParticipants.some(
                      (p) =>
                        p.id === c.id ||
                        p.displayName.toLowerCase() === c.displayName.toLowerCase()
                    );
                    if (alreadyAdded) return null;
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => handleAddAdHocParticipant(c)}
                        className="inline-flex items-center gap-1 rounded-lg bg-white dark:bg-slate-800 hover:bg-emerald-500/10 border border-slate-200 dark:border-white/10 px-2.5 py-1 text-xs font-medium text-slate-700 dark:text-slate-300 transition-colors"
                      >
                        <Plus className="w-3 h-3 text-[#059669]" weight="bold" />
                        <span>{c.displayName}</span>
                      </button>
                    );
                  })}
                </div>

                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    data-testid="adhoc-friend-name-input"
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
                type="number"
                step="any"
                min="0"
                data-testid="expense-amount-input"
                value={amountInput}
                onChange={(e) => {
                  const val = e.target.value;
                  setAmountInput(val);
                  if (splitMode === 'exact') {
                    const nextOrigMinor = Math.max(0, parseMajorToMinor(val, originalCurrency));
                    const nextConv = convertMinorAmountWithFx({
                      originalMinor: nextOrigMinor,
                      fromCurrency: originalCurrency,
                      toCurrency: effectiveBaseCurrency,
                      fxRateScaled,
                      fxStatus: 'live',
                      dateIso: expenseDate,
                    }).convertedMinor;
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
                }}
                placeholder="0.00"
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
                value={expenseDate}
                onChange={(e) => setExpenseDate(e.target.value)}
                className="w-full rounded-xl border border-slate-300 dark:border-white/15 bg-slate-50 dark:bg-slate-900/90 px-3.5 py-2.5 font-mono text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-[#059669]"
              />
            </div>
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
                    type="number"
                    step="any"
                    min="0.0001"
                    data-testid="expense-fx-rate-input"
                    value={fxRateInput}
                    onChange={(e) => {
                      setFxRateInput(e.target.value);
                      setFxStatus('manual');
                    }}
                    className="w-28 rounded-lg border border-emerald-500/40 bg-white dark:bg-slate-900 px-2.5 py-1 font-mono tabular-nums text-xs font-semibold text-slate-900 dark:text-slate-100"
                  />
                  <span className="text-xs font-mono font-semibold text-slate-700 dark:text-slate-300">
                    {effectiveBaseCurrency}
                  </span>
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600 dark:text-slate-300">
                <span>{fxConversion.fxAuditNote}</span>
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
                className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
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
                      <span>{m.displayName}</span>
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
                        type="number"
                        step="any"
                        min="0"
                        data-testid={`payer-input-${m.id}`}
                        value={multiPayerInputs[m.id] ?? '0'}
                        onChange={(e) =>
                          setMultiPayerInputs((prev) => ({ ...prev, [m.id]: e.target.value }))
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
                Split Mode (5 Integer-Exact Algorithms)
              </span>
              {selectedGroup && (
                <div className="flex flex-wrap items-center gap-2">
                  {selectedGroup.defaultSplitConfig && (
                    <button
                      type="button"
                      data-testid="apply-default-split-btn"
                      onClick={handleApplyDefaultSplit}
                      className="inline-flex items-center gap-1 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 ring-1 ring-emerald-500/30 px-2.5 py-1 text-xs font-semibold transition-colors"
                    >
                      <Sparkle className="w-3.5 h-3.5" weight="fill" />
                      <span>Apply Default ({selectedGroup.defaultSplitConfig.label})</span>
                    </button>
                  )}
                  <button
                    type="button"
                    data-testid="save-default-split-btn"
                    onClick={handleSaveDefaultSplit}
                    className="inline-flex items-center gap-1 rounded-lg bg-slate-100 dark:bg-white/10 hover:bg-slate-200 dark:hover:bg-white/15 text-slate-700 dark:text-slate-300 px-2.5 py-1 text-xs font-semibold transition-colors"
                  >
                    <FloppyDisk className="w-3.5 h-3.5" />
                    <span>Save as Group Default</span>
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
                    className={`rounded-xl px-3 py-2 text-left transition-all border ${
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

                return (
                  <div
                    key={m.id}
                    className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border px-3.5 py-2.5 transition-colors ${
                      isInc
                        ? 'border-slate-200 dark:border-white/10 bg-white dark:bg-slate-900/80'
                        : 'border-slate-200/50 dark:border-white/5 bg-slate-100/50 dark:bg-slate-900/30 opacity-60'
                    }`}
                  >
                    <label className="flex items-center gap-2.5 cursor-pointer">
                      <input
                        type="checkbox"
                        data-testid={`split-include-${m.id}`}
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
                            type="number"
                            step="any"
                            data-testid={`split-input-${m.id}`}
                            value={memberInputStrings[m.id] ?? ''}
                            onChange={(e) =>
                              setMemberInputStrings((prev) => ({
                                ...prev,
                                [m.id]: e.target.value,
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
                        <div className="text-[10px] font-mono tabular-nums text-slate-400">
                          {owedMinor} {minorUnitLabel}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Notes Input */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
              Audit Notes (Optional)
            </label>
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Add context on shares, adjustments, or receipt details..."
              className="w-full rounded-xl border border-slate-300 dark:border-white/15 bg-slate-50 dark:bg-slate-900/90 px-3.5 py-2 text-xs text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-[#059669]"
            />
          </div>

          {/* Receipt Attachment Section (WebP Local IndexedDB + Supabase Storage Bucket) */}
          <div
            data-testid="expense-receipt-section"
            className="rounded-2xl border border-slate-200 dark:border-white/10 bg-slate-50/70 dark:bg-slate-900/50 p-4 space-y-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="flex items-center gap-2">
                  <Paperclip className="w-4 h-4 text-[#059669]" weight="bold" />
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-800 dark:text-slate-200">
                    Receipt &amp; Bill Image Attachments (WebP)
                  </span>
                </div>
                <p className="text-[11px] font-mono text-slate-500 dark:text-slate-400 mt-0.5">
                  Local IndexedDB: <span className="text-sky-600 dark:text-sky-400">local_receipt_blobs</span> + Supabase Storage Bucket: <span className="text-emerald-600 dark:text-emerald-400">wise-spliter-receipts</span>
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <label className="inline-flex items-center gap-1.5 rounded-xl bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-white/10 px-3 py-1.5 text-xs font-semibold text-slate-700 dark:text-slate-200 cursor-pointer transition-colors">
                  <UploadSimple className="w-3.5 h-3.5 text-[#059669]" weight="bold" />
                  <span>Upload Image / PDF</span>
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
                  <span>Attach Sample Receipt (WebP)</span>
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
                            ({rcp.sizeKb} KB / {rcp.mimeType})
                          </span>
                        </div>
                        <div className="font-mono text-[10px] text-slate-500 dark:text-slate-400">
                          Bucket: {rcp.storageBucket ?? 'wise-spliter-receipts'} | Path:{' '}
                          {rcp.storagePath ?? `receipts/${rcp.expenseId}.webp`}
                        </div>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => handleRemoveReceipt(rcp.id)}
                      className="text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 p-1 transition-colors"
                      title="Remove receipt"
                    >
                      <Trash className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Live Reconciliation Status Bar */}
          <div
            data-testid="split-reconciliation-bar"
            className={`rounded-2xl border p-3.5 transition-colors ${
              validation.valid
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-900 dark:text-emerald-200'
                : 'border-rose-500/30 bg-rose-500/10 text-rose-900 dark:text-rose-200'
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs font-bold">
                {validation.valid ? (
                  <CheckCircle className="w-4 h-4 text-emerald-600 dark:text-emerald-400" weight="fill" />
                ) : (
                  <WarningCircle className="w-4 h-4 text-rose-600 dark:text-rose-400" weight="fill" />
                )}
                <span>
                  {validation.valid
                    ? `100% Reconciled (${totalConvertedMinor} ${minorUnitLabel} exact)`
                    : 'Split Invariant Check Failed'}
                </span>
              </div>
              <div className="font-mono tabular-nums text-xs">
                <span>
                  Unallocated Split:{' '}
                  <CurrencyAmount
                    minorAmount={validation.unallocatedSplitMinor}
                    currencyCode={effectiveBaseCurrency}
                  />
                </span>
                {' | '}
                <span>
                  Unallocated Payer:{' '}
                  <CurrencyAmount
                    minorAmount={validation.unallocatedPayerMinor}
                    currencyCode={effectiveBaseCurrency}
                  />
                </span>
              </div>
            </div>

            {remainderWinners.length > 0 && (
              <div className="mt-1.5 text-[11px] font-mono text-amber-700 dark:text-amber-300">
                Deterministic Rotation (Seed #{rotationSeed}): +1 {minorUnitLabel} remainder assigned to{' '}
                {remainderWinners.join(', ')}
              </div>
            )}

            {!validation.valid && validation.errors.length > 0 && (
              <ul className="mt-2 space-y-1 text-xs text-rose-700 dark:text-rose-300 list-disc list-inside">
                {validation.errors.map((err, i) => (
                  <li key={i}>{err}</li>
                ))}
              </ul>
            )}
          </div>

          {/* Modal Footer Actions */}
          <div className="flex items-center justify-end gap-3 pt-2 border-t border-slate-200/80 dark:border-white/10">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl px-4 py-2.5 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-white/10 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="save-expense-btn"
              disabled={!validation.valid}
              onClick={handleSaveExpense}
              className={`inline-flex items-center gap-2 rounded-xl px-5 py-2.5 text-xs font-bold text-white transition-all ${
                validation.valid
                  ? 'bg-[#059669] hover:bg-emerald-600 shadow-md shadow-emerald-600/20 cursor-pointer'
                  : 'bg-slate-400 dark:bg-slate-700 cursor-not-allowed opacity-60'
              }`}
            >
              <CheckCircle className="w-4 h-4" weight="bold" />
              <span>{initialExpense ? 'Save Expense Changes' : 'Save Expense to Ledger'}</span>
            </button>
          </div>
        </DoubleBezelCard>
      </div>
    </div>
  );
}
