import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowsLeftRight,
  CalendarBlank,
  CheckCircle,
  Coins,
  FloppyDisk,
  Sparkle,
  Tag,
  Users,
  WarningCircle,
  X,
} from '@phosphor-icons/react';
import {
  ExpenseCategoryKey,
  ExpenseItem,
  ExpensePayer,
  FxStatus,
  SplitMode,
} from '../../types/ledger';
import { useLedger } from '../../state/LedgerContext';
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

const SPLIT_MODES: Array<{ mode: SplitMode; label: string; hint: string }> = [
  { mode: 'equal', label: 'Equal', hint: 'Deterministic rotating remainder' },
  { mode: 'exact', label: 'Exact', hint: 'Exact minor units per person' },
  { mode: 'percentage', label: 'Percentage', hint: 'Basis points totaling 100.00%' },
  { mode: 'shares', label: 'Shares', hint: 'Proportional ratio weights (2x, 1x)' },
  { mode: 'adjustment', label: '+/- Adjust', hint: 'Equal base plus custom item delta' },
];

export function ExpenseEditorModal({
  isOpen,
  onClose,
  initialExpense = null,
}: {
  isOpen: boolean;
  onClose: () => void;
  initialExpense?: ExpenseItem | null;
}) {
  const { dataset, activeGroup, isOnline, upsertExpense, saveDefaultSplitPreset } = useLedger();

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

  const allCurrencyOptions = useMemo(() => {
    const primaryCodes = new Set(dataset.currenciesCatalog.map((c) => c.code));
    const extras = Object.values(SUPPORTED_CURRENCIES)
      .filter((c) => !primaryCodes.has(c.code))
      .sort((a, b) => a.code.localeCompare(b.code));
    return [...dataset.currenciesCatalog, ...extras];
  }, [dataset.currenciesCatalog]);

  useEffect(() => {
    if (!isOpen) return;

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
      setSinglePayerId(initialExpense.payers[0]?.memberId ?? activeGroup.members[0]?.id ?? '');

      const payerMap: Record<string, string> = {};
      for (const m of activeGroup.members) {
        const foundPayer = initialExpense.payers.find((p) => p.memberId === m.id);
        payerMap[m.id] = foundPayer
          ? formatMinorToMajor(foundPayer.paidMinor, activeGroup.baseCurrency, false).replace(
              /,/g,
              ''
            )
          : '0';
      }
      setMultiPayerInputs(payerMap);

      const incMap: Record<string, boolean> = {};
      const strMap: Record<string, string> = {};
      for (const m of activeGroup.members) {
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
          strMap[m.id] = formatMinorToMajor(
            sp.rawInputValue,
            activeGroup.baseCurrency,
            false
          ).replace(/,/g, '');
        } else {
          strMap[m.id] = String(sp.rawInputValue || 1);
        }
      }
      setIncludedMembers(incMap);
      setMemberInputStrings(strMap);
    } else {
      setTitle('');
      setCategory('food');
      setExpenseDate('2026-11-11');
      setOriginalCurrency(activeGroup.baseCurrency);
      setAmountInput('');
      setFxRateInput('1.00');
      setFxStatus('identity');
      setNotes('');
      setTagsInput('');
      setSplitMode('equal');
      setIsMultiPayer(false);
      const defaultPayer =
        activeGroup.members.find((m) => m.userId === dataset.currentUser.id)?.id ??
        activeGroup.members[0]?.id ??
        '';
      setSinglePayerId(defaultPayer);

      const payerMap: Record<string, string> = {};
      const incMap: Record<string, boolean> = {};
      const strMap: Record<string, string> = {};
      for (const m of activeGroup.members) {
        payerMap[m.id] = '0';
        incMap[m.id] = true;
        strMap[m.id] = '1';
      }
      setMultiPayerInputs(payerMap);
      setIncludedMembers(incMap);
      setMemberInputStrings(strMap);
    }
  }, [isOpen, initialExpense, activeGroup, dataset.currentUser.id]);

  const handleCurrencyChange = (nextCurrency: string) => {
    setOriginalCurrency(nextCurrency);
    if (nextCurrency === activeGroup.baseCurrency) {
      setFxRateInput('1.00');
      setFxStatus('identity');
    } else {
      const fromInr = dataset.fxRatesToInr[nextCurrency] ?? 1;
      const toInr = dataset.fxRatesToInr[activeGroup.baseCurrency] ?? 1;
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
    if (originalCurrency === activeGroup.baseCurrency) return 100000000;
    return parseFxRateToScaled(fxRateInput);
  }, [originalCurrency, activeGroup.baseCurrency, fxRateInput]);

  const fxConversion = useMemo(
    () =>
      convertMinorAmountWithFx({
        originalMinor: originalAmountMinor,
        fromCurrency: originalCurrency,
        toCurrency: activeGroup.baseCurrency,
        fxRateScaled,
        fxStatus:
          originalCurrency === activeGroup.baseCurrency
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
      activeGroup.baseCurrency,
      fxRateScaled,
      fxStatus,
      isOnline,
      expenseDate,
    ]
  );

  const totalConvertedMinor = fxConversion.convertedMinor;
  const rotationSeed = initialExpense ? initialExpense.rotationSeed : activeGroup.expenseSeq;

  const handleSwitchSplitMode = (nextMode: SplitMode) => {
    setSplitMode(nextMode);
    const activeMembers = activeGroup.members.filter((m) => includedMembers[m.id] !== false);
    const k = activeMembers.length;
    if (k === 0) return;

    const nextStrings = { ...memberInputStrings };
    if (nextMode === 'equal' || nextMode === 'shares') {
      for (const m of activeGroup.members) {
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
      for (const m of activeGroup.members) {
        nextStrings[m.id] = '0';
      }
    } else if (nextMode === 'exact') {
      const eqSplits = calculateSplits({
        totalMinor: totalConvertedMinor,
        originalTotalMinor: originalAmountMinor,
        splitMode: 'equal',
        rotationSeed,
        participants: activeGroup.members.map((m) => ({
          memberId: m.id,
          memberOrder: m.memberOrder,
          included: includedMembers[m.id] !== false,
          rawInputValue: 1,
        })),
      });
      for (const sp of eqSplits) {
        nextStrings[sp.memberId] = formatMinorToMajor(
          sp.owedMinor,
          activeGroup.baseCurrency,
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
      const firstId = singlePayerId || activeGroup.members[0]?.id;
      for (const m of activeGroup.members) {
        payerMap[m.id] =
          m.id === firstId
            ? formatMinorToMajor(totalConvertedMinor, activeGroup.baseCurrency, false).replace(
                /,/g,
                ''
              )
            : '0';
      }
      setMultiPayerInputs(payerMap);
    }
  };

  const handleApplyDefaultSplit = () => {
    const preset = activeGroup.defaultSplitConfig;
    if (!preset) return;
    setSplitMode(preset.splitMode);
    const incMap: Record<string, boolean> = {};
    const strMap: Record<string, string> = {};
    for (const m of activeGroup.members) {
      const rawVal = preset.memberValues[m.id];
      const isInc = rawVal !== undefined && (preset.splitMode === 'adjustment' || rawVal > 0);
      incMap[m.id] = isInc;
      if (preset.splitMode === 'percentage') {
        strMap[m.id] = ((rawVal ?? 0) / 100).toFixed(2).replace(/\.00$/, '');
      } else if (preset.splitMode === 'exact' || preset.splitMode === 'adjustment') {
        strMap[m.id] = formatMinorToMajor(rawVal ?? 0, activeGroup.baseCurrency, false).replace(
          /,/g,
          ''
        );
      } else {
        strMap[m.id] = String(rawVal ?? 1);
      }
    }
    setIncludedMembers(incMap);
    setMemberInputStrings(strMap);
  };

  const participantInputs: SplitParticipantInput[] = useMemo(() => {
    return activeGroup.members.map((m) => {
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
        rawInputValue = parseMajorToMinor(strVal, activeGroup.baseCurrency);
      }
      return {
        memberId: m.id,
        memberOrder: m.memberOrder,
        included,
        rawInputValue,
      };
    });
  }, [activeGroup.members, activeGroup.baseCurrency, includedMembers, memberInputStrings, splitMode]);

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
      const targetId = singlePayerId || activeGroup.members[0]?.id || '';
      return [
        {
          memberId: targetId,
          paidMinor: totalConvertedMinor,
          originalPaidMinor: originalAmountMinor,
        },
      ];
    }
    const list: ExpensePayer[] = [];
    for (const m of activeGroup.members) {
      const paidMinor = Math.max(
        0,
        parseMajorToMinor(multiPayerInputs[m.id] ?? '0', activeGroup.baseCurrency)
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
    activeGroup.members,
    activeGroup.baseCurrency,
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

  const handleSaveDefaultSplit = () => {
    const memberValues: Record<string, number> = {};
    for (const p of participantInputs) {
      if (p.included) {
        memberValues[p.memberId] = p.rawInputValue;
      }
    }
    saveDefaultSplitPreset(activeGroup.id, {
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

    upsertExpense({
      id: initialExpense?.id,
      groupId: activeGroup.id,
      title: title.trim() || 'Shared Group Expense',
      category,
      tags: parsedTags.length > 0 ? parsedTags : [`#${category}`],
      notes,
      expenseDate,
      originalCurrency,
      originalAmountMinor,
      fxRateScaled,
      fxStatus:
        originalCurrency === activeGroup.baseCurrency
          ? 'identity'
          : fxStatus === 'identity'
          ? isOnline
            ? 'live'
            : 'cached_offline'
          : fxStatus,
      splitMode,
      payers: computedPayers,
      splits: computedSplits,
    });
    onClose();
  };

  if (!isOpen) return null;

  const baseMeta = getCurrency(activeGroup.baseCurrency);
  const minorUnitLabel =
    baseMeta.decimals === 0 ? 'units' : baseMeta.decimals === 3 ? 'fils' : 'paise/cents';
  const remainderWinners = computedSplits
    .filter((s) => s.included && s.remainderMinor === 1)
    .map((s) => activeGroup.members.find((m) => m.id === s.memberId)?.displayName ?? s.memberId);

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
              <div className="flex items-center gap-2">
                <StatusBadge tone="emerald">
                  <Coins className="w-3.5 h-3.5" weight="duotone" />
                  <span>{initialExpense ? `Edit Expense (Rev #${initialExpense.revisionNumber})` : 'New Group Expense'}</span>
                </StatusBadge>
                <CurrencyPrecisionPill currencyCode={activeGroup.baseCurrency} />
              </div>
              <h2 className="mt-1.5 text-lg sm:text-xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
                {initialExpense ? `Update "${initialExpense.title}"` : `Log Bill in ${activeGroup.name}`}
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
                placeholder="e.g., Thalassa Cliff Dinner or Shinkansen Tickets"
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
                      toCurrency: activeGroup.baseCurrency,
                      fxRateScaled,
                      fxStatus: 'live',
                      dateIso: expenseDate,
                    }).convertedMinor;
                    const eqSplits = calculateSplits({
                      totalMinor: nextConv,
                      originalTotalMinor: nextOrigMinor,
                      splitMode: 'equal',
                      rotationSeed,
                      participants: activeGroup.members.map((m) => ({
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
                        activeGroup.baseCurrency,
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
          {originalCurrency !== activeGroup.baseCurrency && (
            <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/[0.06] p-3.5 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-xs font-semibold text-emerald-800 dark:text-emerald-300">
                  <ArrowsLeftRight className="w-4 h-4" weight="bold" />
                  <span>
                    Foreign Currency Conversion ({originalCurrency} to {activeGroup.baseCurrency})
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
                    {activeGroup.baseCurrency}
                  </span>
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600 dark:text-slate-300">
                <span>{fxConversion.fxAuditNote}</span>
                <span className="font-mono tabular-nums font-bold text-emerald-700 dark:text-emerald-300">
                  Converted Total:{' '}
                  <CurrencyAmount
                    minorAmount={totalConvertedMinor}
                    currencyCode={activeGroup.baseCurrency}
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
                {activeGroup.members.map((m) => {
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
                {activeGroup.members.map((m) => (
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
              <div className="flex flex-wrap items-center gap-2">
                {activeGroup.defaultSplitConfig && (
                  <button
                    type="button"
                    data-testid="apply-default-split-btn"
                    onClick={handleApplyDefaultSplit}
                    className="inline-flex items-center gap-1 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 ring-1 ring-emerald-500/30 px-2.5 py-1 text-xs font-semibold transition-colors"
                  >
                    <Sparkle className="w-3.5 h-3.5" weight="fill" />
                    <span>Apply Default ({activeGroup.defaultSplitConfig.label})</span>
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
              {activeGroup.members.map((m) => {
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
                            currencyCode={activeGroup.baseCurrency}
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
                    currencyCode={activeGroup.baseCurrency}
                  />
                </span>
                {' | '}
                <span>
                  Unallocated Payer:{' '}
                  <CurrencyAmount
                    minorAmount={validation.unallocatedPayerMinor}
                    currencyCode={activeGroup.baseCurrency}
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
