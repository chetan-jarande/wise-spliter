import React, { useEffect, useMemo, useState } from 'react';
import { LIMITS } from '../../types/limits';
import { QRCodeSVG } from 'qrcode.react';
import {
  ArrowRightIcon as ArrowRight,
  ArrowsLeftRightIcon as ArrowsLeftRight,
  BankIcon as Bank,
  CheckIcon as Check,
  CheckCircleIcon as CheckCircle,
  CopyIcon as Copy,
  CreditCardIcon as CreditCard,
  DeviceMobileIcon as DeviceMobile,
  InfoIcon as Info,
  LightningIcon as Lightning,
  MoneyIcon as Money,
  QrCodeIcon as QrCode,
  ReceiptIcon as Receipt,
  ShieldCheckIcon as ShieldCheck,
  SparkleIcon as Sparkle,
  UsersThreeIcon as UsersThree,
  WalletIcon as Wallet,
  WhatsappLogoIcon as WhatsappLogo,
} from '@phosphor-icons/react';
import { useLedger } from '../../state/LedgerContext';
import {
  computeCrossGroupFriendsSummary,
  computeGroupNetBalances,
  computeRawPairwiseTransfers,
  pickableMembers,
  simplifyGroupDebts,
} from '../../domain/ledger/ledger-engine';
import {
  convertForeignToBaseMinor,
  formatMinorToMajor,
  localeUsesDecimalComma,
  tryParseMajorToMinorBigInt,
} from '../../domain/money/currencies';
import type { FxQuote } from '../../utils/fx-rates';
import { generateWhatsAppGroupSummary } from '../../portability/portability-engine';
import { SettlementItem } from '../../types/ledger';
import {
  canChangeGroupSettlement,
  localIsoDate,
  planDirectPayback,
} from '../../utils/direct-settlements';
import { newId } from '../../utils/ids';
import { launchExternalUriCrossPlatform } from '../../utils/native-platform';
import { buildPayeeUpiLink, isValidUpiId } from '../../utils/upi-link';
import {
  CurrencyAmount,
  CurrencyPrecisionPill,
  DoubleBezelCard,
  StatusBadge,
} from '../primitives/DesignPrimitives';

const PAYMENT_METHODS: Array<{
  key: SettlementItem['paymentMethod'];
  label: string;
  sublabel: string;
}> = [
  { key: 'upi', label: 'UPI Instant', sublabel: 'GPay / PhonePe / Paytm' },
  { key: 'cash', label: 'Cash', sublabel: 'In-person settlement' },
  { key: 'bank', label: 'Bank / NEFT', sublabel: 'IMPS / Wire transfer' },
  { key: 'paypal', label: 'PayPal', sublabel: 'Cross-border wallet' },
  { key: 'venmo', label: 'Venmo', sublabel: 'Social peer transfer' },
];

const INPUT_LOCALE = typeof navigator !== 'undefined' ? navigator.language : undefined;

export function FriendsAndSettlePage() {
  const {
    dataset,
    activeGroup,
    setActiveGroupId,
    recordSettlement,
    editSettlement,
    deleteSettlement,
    settleAllAcrossGroupsWithFriend,
    showToast,
    getFxQuote,
  } = useLedger();

  const activeGroups = useMemo(
    () => dataset.groups.filter((g) => !g.deletedAt),
    [dataset.groups]
  );

  // 1. Cross-Group Friends Net Balances Summary
  const friendsSummary = useMemo(
    () =>
      computeCrossGroupFriendsSummary(
        dataset.currentUser.email,
        dataset.groups,
        dataset.expenses,
        dataset.settlements,
        {}
      ),
    [
      dataset.currentUser.email,
      dataset.groups,
      dataset.expenses,
      dataset.settlements,
    ]
  );

  const displayCurrency = (dataset.currentUser.defaultCurrency || 'INR').toUpperCase();

  const crossGroupTotals = useMemo(() => {
    const byFriend = new Map<string, { netMinor: number; unconverted: Array<[string, number]> }>();
    const unconvertedTotals: Record<string, number> = {};
    const used: FxQuote[] = [];
    let owedToMeMinor = 0;
    let iOweMinor = 0;
    for (const f of friendsSummary) {
      let inr = 0n;
      const unconverted: Array<[string, number]> = [];
      for (const [code, minor] of Object.entries(f.netByCurrencyMinor ?? {})) {
        if (minor === 0) continue;
        const quote = code === displayCurrency ? null : getFxQuote(code, displayCurrency);
        if (code === displayCurrency) inr += BigInt(minor);
        else if (quote) {
          inr += convertForeignToBaseMinor(minor, code, displayCurrency, quote.rateScaled);
          used.push(quote);
        } else {
          unconverted.push([code, minor]);
          unconvertedTotals[code] = (unconvertedTotals[code] ?? 0) + minor;
        }
      }
      const netMinor = Number(inr);
      byFriend.set(f.friendKey, { netMinor, unconverted });
      if (netMinor > 0) owedToMeMinor += netMinor;
      else iOweMinor -= netMinor;
    }
    const oldest = used.reduce((d, q) => (q.rateDate < d ? q.rateDate : d), used[0]?.rateDate ?? '');
    const rateLabel =
      used.length === 0
        ? null
        : used.some((q) => q.status === 'cached_offline')
        ? `Foreign balances converted at cached offline rates from ${oldest}`
        : `Foreign balances converted at live rates, ${oldest}`;
    return {
      byFriend,
      rateLabel,
      unconvertedTotals: Object.entries(unconvertedTotals).filter(([, v]) => v !== 0),
      owedToMeMinor,
      iOweMinor,
      netOverallMinor: owedToMeMinor - iOweMinor,
    };
  }, [friendsSummary, getFxQuote, displayCurrency]);

  // Active Group Expenses, Settlements, Net Balances, and Suggested Transfers
  const groupExpenses = useMemo(
    () =>
      dataset.expenses.filter(
        (e) => e.groupId === activeGroup.id && !e.deletedAt
      ),
    [dataset.expenses, activeGroup.id]
  );

  const groupSettlements = useMemo(
    () =>
      dataset.settlements.filter(
        (s) => s.groupId === activeGroup.id && !s.deletedAt
      ),
    [dataset.settlements, activeGroup.id]
  );

  const groupNetBalancesMap = useMemo(
    () =>
      computeGroupNetBalances(
        groupExpenses,
        groupSettlements,
        activeGroup.members
      ),
    [groupExpenses, groupSettlements, activeGroup.members]
  );

  const groupSuggestedTransfers = useMemo(() => {
    if (activeGroup.simplifyDebts) {
      return simplifyGroupDebts(
        groupNetBalancesMap,
        activeGroup.members,
        activeGroup.baseCurrency
      );
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
    groupNetBalancesMap,
    groupExpenses,
    groupSettlements,
  ]);

  // 2. Interactive Settle Up & UPI Deep-Link / QR Studio state
  const [selectedPaymentMethod, setSelectedPaymentMethod] =
    useState<SettlementItem['paymentMethod']>('upi');
  const [fromMemberId, setFromMemberId] = useState<string>('');
  const [toMemberId, setToMemberId] = useState<string>('');
  const [amountMajorInput, setAmountMajorInput] = useState<string>('');
  const [paymentReference, setPaymentReference] = useState<string>('');
  const [settlementNotes, setSettlementNotes] = useState<string>('');
  const [settledDate, setSettledDate] = useState<string>(() => localIsoDate());
  const [attempted, setAttempted] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [direct, setDirect] = useState<{
    friendKey: string;
    currency: string;
    expenseId: string | null;
  } | null>(null);
  const [copiedUpi, setCopiedUpi] = useState<boolean>(false);
  const [copiedWhatsApp, setCopiedWhatsApp] = useState<boolean>(false);
  const [launchedUpiApp, setLaunchedUpiApp] = useState<string | null>(null);

  const toMajorInput = (minor: number | bigint, currency: string) => {
    const plain = formatMinorToMajor(minor, currency, false).replace(/,/g, '');
    return localeUsesDecimalComma(INPUT_LOCALE) ? plain.replace('.', ',') : plain;
  };

  const resetForm = () => {
    setAmountMajorInput('');
    setPaymentReference('');
    setSettledDate(localIsoDate());
    setAttempted(false);
    setEditingId(null);
  };

  // Sync default payer/payee/amount whenever activeGroup changes
  const settleMembers = pickableMembers(activeGroup.members, editingId ? [fromMemberId, toMemberId] : []);

  useEffect(() => {
    setEditingId(null);
    setAttempted(false);
    const active = pickableMembers(activeGroup.members);
    const isActive = (id: string) => active.some((m) => m.id === id);
    const firstTransfer = groupSuggestedTransfers.find((t) => isActive(t.fromMemberId) && isActive(t.toMemberId));
    if (firstTransfer) {
      setFromMemberId(firstTransfer.fromMemberId);
      setToMemberId(firstTransfer.toMemberId);
      setAmountMajorInput(toMajorInput(firstTransfer.amountMinor, activeGroup.baseCurrency));
    } else {
      setFromMemberId(active[1]?.id ?? active[0]?.id ?? '');
      setToMemberId(active[0]?.id ?? '');
      setAmountMajorInput('');
    }
    setSettlementNotes(`${activeGroup.name} settlement`);
  }, [activeGroup.id]);

  const fromMember = settleMembers.find((m) => m.id === fromMemberId) ?? (fromMemberId ? undefined : settleMembers[0]);
  const toMember =
    settleMembers.find((m) => m.id === toMemberId) ?? (toMemberId ? undefined : settleMembers[1] ?? settleMembers[0]);

  const studioCurrency = direct ? direct.currency : activeGroup.baseCurrency;

  const amountMinor = useMemo(() => {
    const parsed = tryParseMajorToMinorBigInt(amountMajorInput, studioCurrency, INPUT_LOCALE);
    return parsed.ok ? parsed.value : 0n;
  }, [amountMajorInput, studioCurrency]);

  // Matching suggested transfer between fromMemberId and toMemberId (if any)
  const matchingSuggestedTransfer = useMemo(
    () =>
      groupSuggestedTransfers.find(
        (t) => t.fromMemberId === fromMemberId && t.toMemberId === toMemberId
      ) ?? groupSuggestedTransfers[0],
    [groupSuggestedTransfers, fromMemberId, toMemberId]
  );

  // Most the payer can pay the payee without flipping who owes whom (an edit adds back its own amount)
  const groupOwedLimit = useMemo(() => {
    const from = fromMember?.id ?? '';
    const to = toMember?.id ?? '';
    let owed: number;
    if (activeGroup.simplifyDebts) {
      owed = Math.min(-(groupNetBalancesMap.get(from) ?? 0), groupNetBalancesMap.get(to) ?? 0);
    } else {
      owed = 0;
      for (const t of groupSuggestedTransfers) {
        if (t.fromMemberId === from && t.toMemberId === to) owed += t.amountMinor;
        if (t.fromMemberId === to && t.toMemberId === from) owed -= t.amountMinor;
      }
    }
    const editing = groupSettlements.find((s) => s.id === editingId);
    const limit = BigInt(owed) + BigInt(editing?.amountMinor ?? 0);
    return limit > 0n ? limit : 0n;
  }, [
    activeGroup.simplifyDebts,
    groupNetBalancesMap,
    groupSuggestedTransfers,
    groupSettlements,
    fromMember?.id,
    toMember?.id,
    editingId,
  ]);

  const directFriend = direct
    ? friendsSummary.find((f) => f.friendKey === direct.friendKey)
    : undefined;
  const directCurrencies = [
    ...new Set(
      (directFriend?.groupBreakdowns ?? [])
        .filter((b) => b.groupId === null)
        .map((b) => b.currency)
    ),
  ];
  const directBillTitle = direct?.expenseId
    ? dataset.expenses.find((e) => e.id === direct.expenseId)?.title
    : undefined;

  const directPlan = useMemo(
    () =>
      direct
        ? planDirectPayback({
            userEmail: dataset.currentUser.email,
            friendKey: direct.friendKey,
            currency: direct.currency,
            amountMinor,
            expenseId: direct.expenseId,
            expenses: dataset.expenses,
            settlements: dataset.settlements,
            fxRatesToInr: dataset.fxRatesToInr,
          })
        : null,
    [direct, amountMinor, dataset.currentUser.email, dataset.expenses, dataset.settlements, dataset.fxRatesToInr]
  );

  const friendFirst = directFriend?.displayName.split(' ')[0] ?? 'Your friend';
  const payerFirst = direct
    ? directPlan?.friendPays ? friendFirst : 'You'
    : fromMember?.displayName.split(' ')[0] ?? 'Member';
  const payeeFirst = direct
    ? directPlan?.friendPays ? 'you' : friendFirst
    : toMember?.displayName.split(' ')[0] ?? 'Member';
  const owedLimit = direct ? directPlan?.maxMinor ?? 0n : groupOwedLimit;

  const amountProblem: string | null =
    amountMinor <= 0n
      ? 'Enter an amount above zero.'
      : !direct && fromMember?.id === toMember?.id
      ? 'Pick two different people.'
      : owedLimit === 0n
      ? direct
        ? `Nothing is open with ${friendFirst} in ${studioCurrency} right now.`
        : `${payerFirst} does not owe ${payeeFirst} anything here right now.`
      : amountMinor > owedLimit
      ? `That is more than ${payerFirst === 'You' ? 'you owe' : `${payerFirst} owes`} ${payeeFirst} (${formatMinorToMajor(owedLimit, studioCurrency)}). Lower the amount to record it.`
      : null;
  const showAmountProblem = amountProblem !== null && (attempted || amountMajorInput.trim() !== '');
  const todayIso = localIsoDate();
  const dateProblem =
    settledDate && (settledDate < '2000-01-01' || settledDate > todayIso)
      ? 'Pick a date from 2000 up to today.'
      : null;

  const isMe = (m: { userId: string | null; invitedEmail: string | null } | undefined) =>
    !!m &&
    (m.userId === dataset.currentUser.id ||
      m.invitedEmail?.trim().toLowerCase() === dataset.currentUser.email.trim().toLowerCase());

  const payee = direct
    ? directPlan?.friendPays
      ? { name: dataset.currentUser.fullName, upiId: dataset.currentUser.upiId }
      : { name: directFriend?.displayName ?? 'Friend', upiId: directPlan?.payeeUpiId ?? null }
    : {
        name: toMember?.displayName ?? 'Member',
        upiId: toMember?.upiId || (isMe(toMember) ? dataset.currentUser.upiId : null),
      };
  const payeeUpiId = payee.upiId?.trim() || null;
  const payeeFirstName = payee.name.split(' ')[0] ?? payee.name;

  const upiUri = buildPayeeUpiLink({
    payeeUpiId,
    payeeName: payee.name,
    amountMinor: amountProblem ? 0n : amountMinor,
    currency: studioCurrency,
    note:
      settlementNotes.trim() ||
      (direct ? `Settle up with ${directFriend?.displayName ?? 'friend'}` : `${activeGroup.name} settlement`),
  });

  const upiHint = !payeeUpiId
    ? `Ask ${payeeFirstName} to add their UPI id.`
    : !isValidUpiId(payeeUpiId)
    ? `${payeeFirstName}'s UPI id looks incomplete. Ask them to check it.`
    : studioCurrency.toUpperCase() !== 'INR'
    ? 'UPI works in INR only. Pay another way, then record it here.'
    : amountProblem
    ? 'Enter a valid amount to create a payment link.'
    : null;

  // 3. WhatsApp Summary Generator for activeGroup
  const totalGroupSpendMinor = useMemo(
    () => groupExpenses.reduce((sum, exp) => sum + exp.amountMinor, 0),
    [groupExpenses]
  );

  const whatsappSummaryText = useMemo(() => {
    const memberMap = new Map(activeGroup.members.map((m) => [m.id, m]));
    const netBalances = activeGroup.members.map((m) => ({
      name: m.displayName,
      netMinor: groupNetBalancesMap.get(m.id) ?? 0,
    }));
    const transfers = groupSuggestedTransfers.map((t) => {
      const from = memberMap.get(t.fromMemberId);
      const to = memberMap.get(t.toMemberId);
      return {
        fromName: from?.displayName ?? t.fromMemberId,
        toName: to?.displayName ?? t.toMemberId,
        toUpiId: isValidUpiId(to?.upiId) ? to?.upiId ?? null : null,
        amountMinor: t.amountMinor,
      };
    });

    return generateWhatsAppGroupSummary({
      groupName: activeGroup.name,
      currency: activeGroup.baseCurrency,
      totalSpendMinor: totalGroupSpendMinor,
      simplifyDebts: activeGroup.simplifyDebts,
      netBalances,
      transfers,
    });
  }, [
    activeGroup.name,
    activeGroup.baseCurrency,
    activeGroup.simplifyDebts,
    activeGroup.members,
    totalGroupSpendMinor,
    groupNetBalancesMap,
    groupSuggestedTransfers,
  ]);

  const handleSelectSuggestedTransfer = (
    fromId: string,
    toId: string,
    minorAmt: number,
    fraction = 1
  ) => {
    const partialMinor = Math.max(1, Math.round(minorAmt * fraction));
    setDirect(null);
    setEditingId(null);
    setFromMemberId(fromId);
    setToMemberId(toId);
    setAmountMajorInput(toMajorInput(partialMinor, activeGroup.baseCurrency));
    setSettlementNotes(
      fraction < 1
        ? `Partial (${Math.round(fraction * 100)}%) settlement, ${activeGroup.name}`
        : `Full settlement, ${activeGroup.name}`
    );
  };

  const openDirectPayback = (friendKey: string, currency: string, expenseId: string | null) => {
    const plan = planDirectPayback({
      userEmail: dataset.currentUser.email,
      friendKey,
      currency,
      amountMinor: 0n,
      expenseId,
      expenses: dataset.expenses,
      settlements: dataset.settlements,
      fxRatesToInr: dataset.fxRatesToInr,
    });
    resetForm();
    setDirect({ friendKey, currency, expenseId });
    setAmountMajorInput(plan.maxMinor > 0n ? toMajorInput(plan.maxMinor, currency) : '');
    setSettlementNotes('');
  };

  const handleLoadGroupBreakdownIntoStudio = (
    friendKey: string,
    item: {
      groupId: string | null;
      myMemberId: string;
      friendMemberId: string;
      netMinor: number;
      currency: string;
      expenseId?: string;
    }
  ) => {
    if (!item.groupId) {
      openDirectPayback(friendKey, item.currency, item.expenseId ?? null);
      return;
    }
    const targetGrp = dataset.groups.find((g) => g.id === item.groupId);
    if (!targetGrp) return;
    setDirect(null);
    setEditingId(null);
    setActiveGroupId(item.groupId);
    const fromId = item.netMinor > 0 ? item.friendMemberId : item.myMemberId;
    const toId = item.netMinor > 0 ? item.myMemberId : item.friendMemberId;
    const absMinor = Math.abs(item.netMinor);
    setTimeout(() => {
      setFromMemberId(fromId);
      setToMemberId(toId);
      setAmountMajorInput(toMajorInput(absMinor, targetGrp.baseCurrency));
      setSettlementNotes(`${targetGrp.name} settlement`);
    }, 0);
  };

  const startEditSettlement = (stl: SettlementItem) => {
    setDirect(null);
    setEditingId(stl.id);
    setAttempted(false);
    setFromMemberId(stl.fromMemberId);
    setToMemberId(stl.toMemberId);
    setAmountMajorInput(toMajorInput(stl.amountMinor, stl.currency));
    setSettledDate(stl.settledDate);
    setSelectedPaymentMethod(stl.paymentMethod);
    setPaymentReference(stl.paymentReference ?? '');
    setSettlementNotes(stl.notes);
  };

  const handleRecordSettlementSubmit = (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setAttempted(true);
    if (amountProblem || dateProblem) return;
    const reference = paymentReference.trim() || undefined;

    if (direct) {
      const plans = directPlan?.plans ?? [];
      if (plans.length === 0) return;
      const batchId = plans.length > 1 ? newId('batch') : null;
      for (const plan of plans) {
        recordSettlement({
          groupId: null,
          expenseId: plan.expenseId,
          fromMemberId: plan.fromMemberId,
          toMemberId: plan.toMemberId,
          amountMinor: plan.amountMinor,
          currency: plan.currency,
          paymentMethod: selectedPaymentMethod,
          paymentReference: reference,
          notes: settlementNotes,
          settledDate,
          batchSettlementId: batchId,
        });
      }
      showToast(
        `Recorded ${formatMinorToMajor(amountMinor, studioCurrency)} ${
          directPlan?.friendPays ? `from ${friendFirst}` : `to ${friendFirst}`
        } across ${plans.length} ${plans.length === 1 ? 'bill' : 'bills'}.`
      );
      resetForm();
      return;
    }

    if (!fromMember || !toMember) {
      showToast('Former members cannot get new payments. Pick current members.');
      return;
    }
    if (editingId) {
      editSettlement(editingId, {
        amountMinor: Number(amountMinor),
        settledDate,
        paymentMethod: selectedPaymentMethod,
        paymentReference: reference,
        notes: settlementNotes,
      });
      resetForm();
      return;
    }
    recordSettlement({
      groupId: activeGroup.id,
      fromMemberId: fromMember.id,
      toMemberId: toMember.id,
      amountMinor: Number(amountMinor),
      paymentMethod: selectedPaymentMethod,
      paymentReference: reference,
      notes: settlementNotes,
      settledDate,
    });
    resetForm();
  };

  const handleCopyUpiUri = async () => {
    if (!upiUri) return;
    try {
      await navigator.clipboard.writeText(upiUri);
    } catch {
      // Clipboard API fallback ignored in headless environment
    }
    setCopiedUpi(true);
    showToast('Copied the UPI payment link.');
    setTimeout(() => setCopiedUpi(false), 2200);
  };

  const handleLaunchUpiApp = (appName: string) => {
    if (!upiUri) return;
    setLaunchedUpiApp(appName);
    launchExternalUriCrossPlatform(upiUri);
    showToast(`Opening ${appName} to pay ${payee.name}.`);
  };

  const handleCopyWhatsAppSummary = async () => {
    try {
      await navigator.clipboard.writeText(whatsappSummaryText);
    } catch {
      // Clipboard API fallback ignored in headless environment
    }
    setCopiedWhatsApp(true);
    showToast(`Copied "${activeGroup.name}" summary for WhatsApp.`);
    setTimeout(() => setCopiedWhatsApp(false), 2500);
  };

  return (
    <div className="space-y-6">
      {/* Top Cross-Group Net Position Banner */}
      <DoubleBezelCard
        innerClassName="p-5 sm:p-6 bg-gradient-to-br from-white via-slate-50/70 to-emerald-500/[0.04] dark:from-[#111827] dark:via-[#111827] dark:to-emerald-950/20"
      >
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-5">
          <div className="space-y-2 max-w-2xl">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge tone="emerald">
                <ShieldCheck size={14} weight="duotone" />
                Smart Cross-Group Netting
              </StatusBadge>
              <StatusBadge tone="blue">
                <Lightning size={14} weight="duotone" />
                Instant UPI QR &amp; WhatsApp Share
              </StatusBadge>
            </div>
            <h1
              data-testid="friends-plain-english-summary"
              className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900 dark:text-white"
            >
              {crossGroupTotals.netOverallMinor > 0 ? (
                <>
                  Friends owe you{' '}
                  <span className="text-emerald-600 dark:text-emerald-400 font-mono tabular-nums whitespace-nowrap">
                    +{formatMinorToMajor(crossGroupTotals.netOverallMinor, displayCurrency)}
                  </span>{' '}
                  overall
                </>
              ) : crossGroupTotals.netOverallMinor < 0 ? (
                <>
                  You owe friends{' '}
                  <span className="text-rose-600 dark:text-rose-400 font-mono tabular-nums whitespace-nowrap">
                    {formatMinorToMajor(Math.abs(crossGroupTotals.netOverallMinor), displayCurrency)}
                  </span>{' '}
                  overall
                </>
              ) : (
                <span className="text-emerald-600 dark:text-emerald-400">
                  You and your friends are all settled up!
                </span>
              )}
            </h1>
            <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
              Shared group balances with the same friend combine automatically (without ever mixing strangers from different groups). Settle all shared groups in 1 tap, scan a UPI QR code, or send a clean WhatsApp summary.
            </p>
            {crossGroupTotals.rateLabel && (
              <p data-testid="friends-fx-label" className="text-[11px] text-slate-500 dark:text-slate-400">
                {crossGroupTotals.rateLabel}
              </p>
            )}
            {crossGroupTotals.unconvertedTotals.length > 0 && (
              <p data-testid="friends-unconverted-balances" className="text-[11px] text-amber-700 dark:text-amber-300">
                Not included in the {displayCurrency} totals (no exchange rate):{' '}
                {crossGroupTotals.unconvertedTotals
                  .map(([code, minor]) => `${minor > 0 ? '+' : ''}${formatMinorToMajor(minor, code)} ${code}`)
                  .join(', ')}
              </p>
            )}
          </div>

          <div data-testid="friends-stat-tiles" className="grid grid-cols-1 sm:grid-cols-3 gap-2 sm:gap-4 shrink-0">
            <div className="rounded-xl bg-emerald-500/[0.07] dark:bg-emerald-500/[0.08] border border-emerald-500/20 px-3.5 py-2.5 min-w-0 flex items-center justify-between gap-3 sm:block">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-300">
                Friends Owe You
              </div>
              <div className="sm:mt-1 shrink-0 whitespace-nowrap text-base sm:text-sm lg:text-lg font-bold">
                <CurrencyAmount
                  minorAmount={crossGroupTotals.owedToMeMinor}
                  currencyCode={displayCurrency}
                  colorize
                  showPlusSign
                />
              </div>
            </div>

            <div className="rounded-xl bg-rose-500/[0.07] dark:bg-rose-500/[0.08] border border-rose-500/20 px-3.5 py-2.5 min-w-0 flex items-center justify-between gap-3 sm:block">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-rose-700 dark:text-rose-300">
                You Owe Friends
              </div>
              <div className="sm:mt-1 shrink-0 whitespace-nowrap text-base sm:text-sm lg:text-lg font-bold">
                <CurrencyAmount
                  minorAmount={-crossGroupTotals.iOweMinor}
                  currencyCode={displayCurrency}
                  colorize
                />
              </div>
            </div>

            <div className="rounded-xl bg-slate-900/[0.04] dark:bg-white/[0.04] border border-slate-200/80 dark:border-white/10 px-3.5 py-2.5 min-w-0 flex items-center justify-between gap-3 sm:block">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-400">
                Net Position ({displayCurrency})
              </div>
              <div className="sm:mt-1 shrink-0 whitespace-nowrap text-base sm:text-sm lg:text-lg font-bold">
                <CurrencyAmount
                  minorAmount={crossGroupTotals.netOverallMinor}
                  currencyCode={displayCurrency}
                  colorize
                  showPlusSign
                />
              </div>
            </div>
          </div>
        </div>
      </DoubleBezelCard>

      {/* Main 12-Column Responsive Workspace */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* LEFT 7 COLUMNS: Cross-Group Friend Net Balances */}
        <div className="lg:col-span-7 space-y-6">
          <DoubleBezelCard
            testId="friends-cross-group-list"
            innerClassName="p-5 sm:p-6 space-y-5"
          >
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-200/70 dark:border-white/[0.07] pb-4">
              <div>
                <div className="flex items-center gap-2">
                  <UsersThree
                    size={20}
                    weight="duotone"
                    className="text-emerald-600 dark:text-emerald-400"
                  />
                  <h2 className="text-base sm:text-lg font-bold text-slate-900 dark:text-white">
                    Cross-Group Friend Net Balances
                  </h2>
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  Per-friend aggregation across {activeGroups.length} active groups normalized to {displayCurrency}
                </p>
              </div>

              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                  Batch Method:
                </span>
                <select
                  aria-label="Cross-group batch payment method"
                  value={selectedPaymentMethod}
                  onChange={(e) =>
                    setSelectedPaymentMethod(
                      e.target.value as SettlementItem['paymentMethod']
                    )
                  }
                  className="rounded-lg bg-slate-100 dark:bg-slate-800/90 border border-slate-300/70 dark:border-white/10 px-2.5 py-1.5 text-xs font-semibold text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                >
                  {PAYMENT_METHODS.map((pm) => (
                    <option key={pm.key} value={pm.key}>
                      {pm.label} ({pm.key.toUpperCase()})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="space-y-4">
              {friendsSummary.map((friend) => {
                const hasOpenBalances = friend.groupBreakdowns.length > 0;
                const fx = crossGroupTotals.byFriend.get(friend.friendKey) ?? { netMinor: 0, unconverted: [] };
                const hasMultipleGroups = friend.groupBreakdowns.length > 1;

                const directRow = friend.groupBreakdowns.find(
                  (b) => b.groupId === null
                );

                return (
                  <div
                    key={friend.friendKey}
                    data-testid={`friend-card-${friend.friendKey}`}
                    className="rounded-2xl border border-slate-200/80 dark:border-white/[0.08] bg-slate-50/60 dark:bg-slate-900/50 p-4 sm:p-5 transition-all hover:border-slate-300 dark:hover:border-white/15"
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                      {/* Friend Identity & Badges */}
                      <div className="flex items-start gap-3.5">
                        <div className="h-11 w-11 rounded-xl bg-gradient-to-br from-emerald-500/20 to-sky-500/20 dark:from-emerald-500/25 dark:to-sky-500/25 border border-emerald-500/30 flex items-center justify-center text-sm font-bold text-emerald-800 dark:text-emerald-200 shrink-0">
                          {friend.avatarInitials}
                        </div>

                        <div className="space-y-1.5">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="text-sm sm:text-base font-bold text-slate-900 dark:text-white">
                              {friend.displayName}
                            </h3>
                            {friend.isClaimedAccount ? (
                              <StatusBadge tone="emerald">
                                <CheckCircle size={12} weight="fill" />
                                Joined
                              </StatusBadge>
                            ) : (
                              <StatusBadge tone="amber">
                                <Info size={12} weight="bold" />
                                Invite Pending
                              </StatusBadge>
                            )}
                          </div>

                          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                            {friend.email && <span>{friend.email}</span>}
                            {friend.upiId && (
                              <span
                                data-testid={`friend-upi-${friend.friendKey}`}
                                className="inline-flex items-center gap-1 rounded-md bg-slate-200/70 dark:bg-slate-800 px-2 py-0.5 font-mono text-[11px] text-slate-700 dark:text-slate-300"
                              >
                                <QrCode size={12} weight="duotone" />
                                {friend.upiId}
                              </span>
                            )}
                            {friend.upiIdVaries && (
                              <span
                                data-testid={`friend-upi-varies-${friend.friendKey}`}
                                className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-800 dark:text-amber-300"
                              >
                                <QrCode size={12} weight="duotone" />
                                UPI varies by bill. Check the "Paying" line before you pay.
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Overall net balance + 1-Tap Settle Up */}
                      <div className="flex flex-row sm:flex-col items-center sm:items-end justify-between gap-2 border-t sm:border-t-0 pt-3 sm:pt-0 border-slate-200/60 dark:border-white/[0.06]">
                        <div className="text-left sm:text-right">
                          <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                            {fx.netMinor > 0
                              ? `Owes you net (${displayCurrency})`
                              : fx.netMinor < 0
                              ? `You owe net (${displayCurrency})`
                              : fx.unconverted.length > 0
                              ? 'Open balances'
                              : 'Settled across all groups'}
                          </div>
                          <div className="text-lg sm:text-xl font-bold">
                            <CurrencyAmount
                              minorAmount={fx.netMinor}
                              currencyCode={displayCurrency}
                              colorize
                              showPlusSign
                            />
                          </div>
                          {fx.unconverted.map(([code, minor]) => (
                            <div
                              key={code}
                              data-testid={`friend-unconverted-${friend.friendKey}-${code}`}
                              className="text-[11px] font-mono text-amber-700 dark:text-amber-300"
                            >
                              {minor > 0 ? '+' : ''}
                              {formatMinorToMajor(minor, code)} {code} (no rate)
                            </div>
                          ))}
                        </div>

                        <button
                          type="button"
                          data-testid={`settle-all-groups-${friend.friendKey}`}
                          disabled={!hasOpenBalances}
                          onClick={() =>
                            settleAllAcrossGroupsWithFriend(
                              friend,
                              selectedPaymentMethod
                            )
                          }
                          className={`inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-semibold transition-all ${
                            hasOpenBalances
                              ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-sm shadow-emerald-600/20 cursor-pointer'
                              : 'bg-slate-200/70 dark:bg-slate-800/60 text-slate-400 dark:text-slate-500 cursor-not-allowed'
                          }`}
                        >
                          <Lightning size={14} weight="fill" />
                          {hasOpenBalances
                            ? `1-Tap Settle All (${friend.groupBreakdowns.length} ${
                                friend.groupBreakdowns.length === 1
                                  ? 'Group'
                                  : 'Groups'
                              })`
                            : 'All Groups Settled'}
                        </button>
                        {directRow && (
                          <button
                            type="button"
                            data-testid={`direct-payback-${friend.friendKey}`}
                            onClick={() =>
                              openDirectPayback(
                                friend.friendKey,
                                directRow.currency,
                                null
                              )
                            }
                            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-xl border border-sky-500/30 bg-sky-500/10 hover:bg-sky-500/20 px-3.5 py-2 text-xs font-semibold text-sky-800 dark:text-sky-300 transition-colors cursor-pointer"
                          >
                            <Money size={14} weight="duotone" />
                            Record a payment
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Per-Group Breakdown List */}
                    <div className="mt-4 pt-3 border-t border-slate-200/70 dark:border-white/[0.06]">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                          Per-Group Breakdown
                        </span>
                        {hasMultipleGroups && (
                          <span className="text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                            Offsetting group balances net out without mixing strangers
                          </span>
                        )}
                      </div>

                      {friend.groupBreakdowns.length === 0 ? (
                        <div className="rounded-xl bg-white/70 dark:bg-slate-950/40 border border-slate-200/60 dark:border-white/[0.05] px-3.5 py-2.5 text-xs text-slate-500 dark:text-slate-400 flex items-center justify-between">
                          <span>
                            Zero unsettled balance with {friend.displayName} in any shared group.
                          </span>
                          <StatusBadge tone="emerald">0.00 Net</StatusBadge>
                        </div>
                      ) : (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                          {friend.groupBreakdowns.map((gb) => (
                            <div
                              key={gb.expenseId ?? gb.groupId ?? gb.groupName}
                              className="rounded-xl bg-white dark:bg-[#111827] border border-slate-200/80 dark:border-white/[0.07] p-3 flex items-center justify-between gap-2"
                            >
                              <div className="min-w-0">
                                <div className="text-xs font-bold text-slate-800 dark:text-slate-100 truncate">
                                  {gb.groupName}
                                </div>
                                <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 flex items-center gap-1.5">
                                  <span>
                                    {gb.netMinor > 0
                                      ? `${friend.displayName.split(' ')[0]} owes you`
                                      : `You owe ${friend.displayName.split(' ')[0]}`}
                                  </span>
                                  <span className="font-mono text-[10px] px-1.5 py-0.2 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
                                    {gb.currency}
                                  </span>
                                </div>
                              </div>

                              <div className="text-right shrink-0 flex flex-col items-end gap-1">
                                <CurrencyAmount
                                  minorAmount={gb.netMinor}
                                  currencyCode={gb.currency}
                                  colorize
                                  showPlusSign
                                  className="text-xs sm:text-sm font-bold"
                                />
                                <button
                                  type="button"
                                  onClick={() =>
                                    handleLoadGroupBreakdownIntoStudio(
                                      friend.friendKey,
                                      gb
                                    )
                                  }
                                  className="min-h-[44px] px-2 text-[11px] font-semibold text-sky-600 dark:text-sky-400 hover:underline cursor-pointer"
                                >
                                  Load in Studio
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </DoubleBezelCard>

          {/* 3. One-Tap WhatsApp / Chat Summary Card & Text Generator */}
          <DoubleBezelCard
            testId="whatsapp-summary-panel"
            innerClassName="p-5 sm:p-6 space-y-5"
          >
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-200/70 dark:border-white/[0.07] pb-4">
              <div>
                <div className="flex items-center gap-2">
                  <WhatsappLogo
                    size={20}
                    weight="duotone"
                    className="text-emerald-600 dark:text-emerald-400"
                  />
                  <h2 className="text-base sm:text-lg font-bold text-slate-900 dark:text-white">
                    One-Tap WhatsApp / Chat Summary Studio
                  </h2>
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  High-contrast visual card preview and ready-to-paste WhatsApp markdown with embedded UPI pay links
                </p>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  data-testid="copy-whatsapp-summary-btn"
                  onClick={handleCopyWhatsAppSummary}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 text-xs font-semibold shadow-sm shadow-emerald-600/20 transition-all cursor-pointer"
                >
                  {copiedWhatsApp ? (
                    <>
                      <Check size={15} weight="bold" />
                      Copied for WhatsApp!
                    </>
                  ) : (
                    <>
                      <Copy size={15} weight="duotone" />
                      Copy Summary for WhatsApp
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Visual High-Contrast Summary Card Preview */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="rounded-2xl bg-gradient-to-br from-slate-900 via-slate-900 to-emerald-950 text-white p-4 sm:p-5 border border-emerald-500/30 shadow-lg flex flex-col justify-between space-y-4">
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/20 border border-emerald-400/30 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-300">
                      <Sparkle size={12} weight="fill" />
                      Wise-Spliter Verified Ledger
                    </span>
                    <span className="font-mono text-xs text-slate-300">
                      {activeGroup.baseCurrency}
                    </span>
                  </div>

                  <div>
                    <h3 className="text-base font-bold text-white">
                      {activeGroup.name}
                    </h3>
                    <div className="text-xs text-slate-300 mt-0.5">
                      Total Group Spend:{' '}
                      <span className="font-mono font-semibold text-emerald-300">
                        {formatMinorToMajor(
                          totalGroupSpendMinor,
                          activeGroup.baseCurrency
                        )}
                      </span>
                    </div>
                  </div>

                  <div className="space-y-1.5 pt-2 border-t border-white/10">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                      Net Member Positions
                    </div>
                    {activeGroup.members.map((m) => {
                      const net = groupNetBalancesMap.get(m.id) ?? 0;
                      return (
                        <div
                          key={m.id}
                          className="flex items-center justify-between text-xs"
                        >
                          <span className="text-slate-200 font-medium">
                            {m.displayName}
                          </span>
                          <span
                            className={`font-mono font-semibold ${
                              net > 0
                                ? 'text-emerald-400'
                                : net < 0
                                ? 'text-rose-400'
                                : 'text-slate-400'
                            }`}
                          >
                            {net > 0 ? '+' : ''}
                            {formatMinorToMajor(net, activeGroup.baseCurrency)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="pt-3 border-t border-white/10 flex items-center justify-between text-[11px] text-slate-300">
                  <span>
                    {activeGroup.simplifyDebts
                      ? 'Simplified Minimum Transfers'
                      : 'Direct Pairwise Balances'}
                  </span>
                  <span className="font-mono text-emerald-300">
                    {groupSuggestedTransfers.length} transfer(s)
                  </span>
                </div>
              </div>

              {/* Formatted WhatsApp Markdown Text */}
              <div className="flex flex-col h-full">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                    Formatted WhatsApp / Telegram Markdown
                  </span>
                  <a
                    href={`https://wa.me/?text=${encodeURIComponent(
                      whatsappSummaryText
                    )}`}
                    target="_blank"
                    rel="noreferrer"
                    className="min-h-[44px] inline-flex items-center gap-1 text-xs font-semibold text-emerald-600 dark:text-emerald-400 hover:underline"
                  >
                    <WhatsappLogo size={14} weight="fill" />
                    Open in WhatsApp
                  </a>
                </div>
                <pre
                  data-testid="whatsapp-summary-markdown"
                  className="flex-1 rounded-2xl bg-slate-100 dark:bg-slate-950/90 border border-slate-200/80 dark:border-white/10 p-3.5 text-xs font-mono text-slate-800 dark:text-slate-200 whitespace-pre-wrap break-words overflow-x-auto leading-relaxed"
                >
                  {whatsappSummaryText}
                </pre>
              </div>
            </div>
          </DoubleBezelCard>
        </div>

        {/* RIGHT 5 COLUMNS: Interactive Settle Up & UPI Deep-Link / QR Studio */}
        <div className="lg:col-span-5 space-y-6">
          <DoubleBezelCard
            testId="settle-up-studio"
            innerClassName="p-5 sm:p-6 space-y-5"
          >
            <div className="flex items-center justify-between gap-2 border-b border-slate-200/70 dark:border-white/[0.07] pb-4">
              <div>
                <div className="flex items-center gap-2">
                  <ArrowsLeftRight
                    size={20}
                    weight="duotone"
                    className="text-sky-600 dark:text-sky-400"
                  />
                  <h2 className="text-base sm:text-lg font-bold text-slate-900 dark:text-white">
                    Settle Up & UPI QR Studio
                  </h2>
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  Record full or partial settlements and generate NPCI UPI QR codes
                </p>
              </div>
              <CurrencyPrecisionPill currencyCode={studioCurrency} />
            </div>

            {direct ? (
              <div
                data-testid="direct-payback-panel"
                className="rounded-2xl border border-sky-500/30 bg-sky-500/[0.06] p-3.5 space-y-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-xs sm:text-sm font-bold text-slate-900 dark:text-white">
                      {directPlan && directPlan.maxMinor > 0n
                        ? directPlan.friendPays
                          ? `${directFriend?.displayName ?? 'Your friend'} owes you ${formatMinorToMajor(directPlan.maxMinor, studioCurrency)}`
                          : `You owe ${directFriend?.displayName ?? 'your friend'} ${formatMinorToMajor(directPlan.maxMinor, studioCurrency)}`
                        : `You and ${directFriend?.displayName ?? 'your friend'} are settled up in ${studioCurrency}.`}
                    </div>
                    <p className="text-[11px] text-slate-600 dark:text-slate-300 mt-0.5">
                      {directBillTitle
                        ? `Only the bill "${directBillTitle}".`
                        : 'Direct bills outside groups. A payment clears the oldest bill first.'}
                    </p>
                  </div>
                  <button
                    type="button"
                    data-testid="direct-payback-exit-btn"
                    onClick={() => {
                      setDirect(null);
                      resetForm();
                    }}
                    className="min-h-[44px] shrink-0 rounded-xl px-3 text-xs font-semibold text-sky-700 dark:text-sky-300 hover:bg-sky-500/10 cursor-pointer"
                  >
                    Back to groups
                  </button>
                </div>
                {directCurrencies.length > 1 && !direct.expenseId && (
                  <select
                    aria-label="Currency of the bills to settle"
                    data-testid="direct-payback-currency-select"
                    value={direct.currency}
                    onChange={(e) => openDirectPayback(direct.friendKey, e.target.value, null)}
                    className="min-h-[44px] w-full rounded-xl bg-white dark:bg-slate-900 border border-slate-300/80 dark:border-white/10 px-3 text-xs font-semibold text-slate-900 dark:text-white"
                  >
                    {directCurrencies.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            ) : (
              <>
            {/* Group Selector inside Studio */}
            <div className="space-y-1.5">
              <label
                htmlFor="studio-group-select"
                className="block text-xs font-semibold text-slate-700 dark:text-slate-300"
              >
                Active Group for Settlement & WhatsApp Summary
              </label>
              <select
                id="studio-group-select"
                data-testid="settle-group-select"
                value={activeGroup.id}
                onChange={(e) => setActiveGroupId(e.target.value)}
                className="w-full rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-300/80 dark:border-white/10 px-3 py-2 text-xs sm:text-sm font-semibold text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-sky-500/40"
              >
                {activeGroups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name} ({g.baseCurrency})
                  </option>
                ))}
              </select>
            </div>

            {/* Suggested Transfers Quick Fill Pills */}
            {groupSuggestedTransfers.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                    Suggested Transfers (Click to Pre-fill)
                  </span>
                  <span className="text-[11px] text-slate-500 dark:text-slate-400">
                    {activeGroup.simplifyDebts
                      ? 'Simplified Mode'
                      : 'Pairwise Mode'}
                  </span>
                </div>
                <div className="space-y-1.5">
                  {groupSuggestedTransfers.map((t, idx) => {
                    const fromM = activeGroup.members.find(
                      (m) => m.id === t.fromMemberId
                    );
                    const toM = activeGroup.members.find(
                      (m) => m.id === t.toMemberId
                    );
                    const isSelected =
                      fromMemberId === t.fromMemberId &&
                      toMemberId === t.toMemberId;
                    return (
                      <div
                        key={`${t.fromMemberId}-${t.toMemberId}-${idx}`}
                        className={`rounded-xl border p-2.5 flex items-center justify-between gap-2 transition-colors ${
                          isSelected
                            ? 'bg-sky-500/10 border-sky-500/40 dark:bg-sky-500/15'
                            : 'bg-slate-50/80 dark:bg-slate-900/50 border-slate-200/70 dark:border-white/[0.07]'
                        }`}
                      >
                        <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-800 dark:text-slate-200 truncate">
                          <span>{fromM?.displayName ?? 'Member'}</span>
                          <ArrowRight size={13} className="text-slate-400 shrink-0" />
                          <span>{toM?.displayName ?? 'Member'}</span>
                          <span className="font-mono text-emerald-600 dark:text-emerald-400 ml-1">
                            {formatMinorToMajor(
                              t.amountMinor,
                              activeGroup.baseCurrency
                            )}
                          </span>
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            onClick={() =>
                              handleSelectSuggestedTransfer(
                                t.fromMemberId,
                                t.toMemberId,
                                t.amountMinor,
                                1
                              )
                            }
                            className="rounded-lg bg-slate-900 dark:bg-white text-white dark:text-slate-900 px-2 py-1 text-[11px] font-semibold cursor-pointer"
                          >
                            Full
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              handleSelectSuggestedTransfer(
                                t.fromMemberId,
                                t.toMemberId,
                                t.amountMinor,
                                0.5
                              )
                            }
                            className="rounded-lg bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-200 px-2 py-1 text-[11px] font-semibold cursor-pointer"
                          >
                            50% Partial
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

              </>
            )}

            {/* Settlement Form */}
            <form onSubmit={handleRecordSettlementSubmit} className="space-y-4">
              {editingId && (
                <div className="flex items-center justify-between gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-900 dark:text-amber-200">
                  <span>Editing a recorded payment. Who paid whom stays the same.</span>
                  <button
                    type="button"
                    data-testid="cancel-edit-settlement-btn"
                    onClick={resetForm}
                    className="min-h-[44px] rounded-lg px-3 font-semibold hover:bg-amber-500/15 cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              )}
              {!direct && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label
                    htmlFor="settle-from-member"
                    className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1"
                  >
                    Payer (From Member)
                  </label>
                  <select
                    id="settle-from-member"
                    data-testid="settle-from-member-select"
                    value={fromMember?.id ?? ''}
                    disabled={!!editingId}
                    onChange={(e) => setFromMemberId(e.target.value)}
                    className="w-full rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-300/80 dark:border-white/10 px-3 py-2 text-xs sm:text-sm font-medium text-slate-900 dark:text-white disabled:opacity-60"
                  >
                    {settleMembers.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.displayName}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="settle-to-member"
                    className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1"
                  >
                    Recipient (To Member)
                  </label>
                  <select
                    id="settle-to-member"
                    data-testid="settle-to-member-select"
                    value={toMember?.id ?? ''}
                    disabled={!!editingId}
                    onChange={(e) => setToMemberId(e.target.value)}
                    className="w-full rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-300/80 dark:border-white/10 px-3 py-2 text-xs sm:text-sm font-medium text-slate-900 dark:text-white disabled:opacity-60"
                  >
                    {settleMembers.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.displayName}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              )}

              {/* Editable Full or Partial Amount */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label
                    htmlFor="settle-amount-input"
                    className="text-xs font-semibold text-slate-700 dark:text-slate-300"
                  >
                    Amount ({studioCurrency}), full or partial
                  </label>
                  {owedLimit > 0n && (
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        data-testid="settle-amount-full-btn"
                        onClick={() => setAmountMajorInput(toMajorInput(owedLimit, studioCurrency))}
                        className="text-[11px] font-semibold text-emerald-600 dark:text-emerald-400 hover:underline cursor-pointer"
                      >
                        Full ({formatMinorToMajor(owedLimit, studioCurrency)})
                      </button>
                      <span className="text-slate-300 dark:text-slate-600">|</span>
                      <button
                        type="button"
                        onClick={() =>
                          setAmountMajorInput(
                            toMajorInput(owedLimit > 1n ? owedLimit / 2n : owedLimit, studioCurrency)
                          )
                        }
                        className="text-[11px] font-semibold text-sky-600 dark:text-sky-400 hover:underline cursor-pointer"
                      >
                        Half
                      </button>
                    </div>
                  )}
                </div>
                <input
                  id="settle-amount-input"
                  data-testid="settle-amount-input"
                  type="text"
                  inputMode="decimal"
                  value={amountMajorInput}
                  onChange={(e) => setAmountMajorInput(e.target.value)}
                  placeholder="0.00"
                  aria-invalid={showAmountProblem}
                  aria-describedby={showAmountProblem ? 'settle-amount-error' : undefined}
                  className="w-full rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-300/80 dark:border-white/10 px-3.5 py-2.5 font-mono text-sm font-bold text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                />
                {showAmountProblem && (
                  <p
                    id="settle-amount-error"
                    data-testid="settle-amount-error"
                    role="alert"
                    className="mt-1 text-[11px] font-medium text-amber-700 dark:text-amber-300"
                  >
                    {amountProblem}
                  </p>
                )}
              </div>

              {/* Payment Method Selector */}
              <div>
                <span className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1.5">
                  Payment Method
                </span>
                <div className="grid grid-cols-5 gap-1.5">
                  {PAYMENT_METHODS.map((pm) => {
                    const active = selectedPaymentMethod === pm.key;
                    return (
                      <button
                        key={pm.key}
                        type="button"
                        data-testid={`payment-method-${pm.key}`}
                        onClick={() => setSelectedPaymentMethod(pm.key)}
                        className={`rounded-xl py-2 px-2 text-center border text-xs font-semibold transition-all cursor-pointer ${
                          active
                            ? 'bg-emerald-600 text-white border-emerald-600 shadow-sm'
                            : 'bg-slate-50 dark:bg-slate-900 text-slate-700 dark:text-slate-300 border-slate-200/80 dark:border-white/10 hover:border-slate-300'
                        }`}
                      >
                        <div className="flex items-center justify-center mb-0.5">
                          {pm.key === 'upi' && <QrCode size={15} weight="duotone" />}
                          {pm.key === 'cash' && <Money size={15} weight="duotone" />}
                          {pm.key === 'bank' && <Bank size={15} weight="duotone" />}
                          {pm.key === 'paypal' && (
                            <CreditCard size={15} weight="duotone" />
                          )}
                          {pm.key === 'venmo' && <Wallet size={15} weight="duotone" />}
                        </div>
                        <span className="uppercase text-[11px]">{pm.key}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Date, Reference & Notes */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label
                    htmlFor="settle-date-input"
                    className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1"
                  >
                    Date paid
                  </label>
                  <input
                    id="settle-date-input"
                    data-testid="settle-date-input"
                    type="date"
                    value={settledDate}
                    min="2000-01-01"
                    max={todayIso}
                    aria-invalid={!!dateProblem}
                    onChange={(e) => setSettledDate(e.target.value)}
                    className="w-full min-h-[44px] rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-300/80 dark:border-white/10 px-3 py-2 text-xs font-mono text-slate-900 dark:text-white"
                  />
                  {dateProblem && (
                    <p
                      data-testid="settle-date-error"
                      role="alert"
                      className="mt-1 text-[11px] font-medium text-amber-700 dark:text-amber-300"
                    >
                      {dateProblem}
                    </p>
                  )}
                </div>

                <div>
                  <label
                    htmlFor="settle-ref-input"
                    className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1"
                  >
                    Reference (optional)
                  </label>
                  <input
                    id="settle-ref-input"
                    data-testid="settle-reference-input"
                    maxLength={LIMITS.paymentReference}
                    type="text"
                    value={paymentReference}
                    onChange={(e) => setPaymentReference(e.target.value)}
                    placeholder="UPI or bank reference"
                    className="w-full min-h-[44px] rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-300/80 dark:border-white/10 px-3 py-2 text-xs font-mono text-slate-900 dark:text-white"
                  />
                </div>

                <div>
                  <label
                    htmlFor="settle-notes-input"
                    className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1"
                  >
                    Note (optional)
                  </label>
                  <input
                    id="settle-notes-input"
                    data-testid="settle-notes-input"
                    maxLength={LIMITS.settlementNotes}
                    type="text"
                    value={settlementNotes}
                    onChange={(e) => setSettlementNotes(e.target.value)}
                    placeholder="What it was for"
                    className="w-full min-h-[44px] rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-300/80 dark:border-white/10 px-3 py-2 text-xs text-slate-900 dark:text-white"
                  />
                </div>
              </div>

              <button
                type="submit"
                data-testid="record-settlement-submit-btn"
                className="w-full min-h-[44px] rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold py-2.5 px-4 text-xs sm:text-sm shadow-sm shadow-emerald-600/25 flex items-center justify-center gap-2 transition-all cursor-pointer"
              >
                <CheckCircle size={18} weight="fill" />
                {editingId ? 'Save changes' : 'Record payment'} ({payerFirst}{' '}
                {payerFirst === 'You' ? 'pay' : 'pays'} {payeeFirst}{' '}
                {formatMinorToMajor(amountMinor > 0n ? amountMinor : 0n, studioCurrency)})
              </button>
            </form>

            {/* Live UPI Deep-Link & QR Code Generator */}
            <div
              data-testid="upi-deep-link-box"
              className="rounded-2xl bg-slate-50/90 dark:bg-slate-900/70 border border-slate-200/80 dark:border-white/10 p-4 space-y-4"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <QrCode
                    size={18}
                    weight="duotone"
                    className="text-emerald-600 dark:text-emerald-400"
                  />
                  <span className="text-xs sm:text-sm font-bold text-slate-900 dark:text-white">
                    Pay {payee.name} by UPI
                  </span>
                </div>
                {upiUri && <StatusBadge tone="emerald">Ready</StatusBadge>}
              </div>

              <div className="flex flex-col sm:flex-row items-center gap-4">
                {upiUri && (
                  <div className="rounded-2xl bg-white p-3 border border-slate-200 shadow-sm shrink-0">
                    <QRCodeSVG value={upiUri} size={132} level="M" marginSize={0} />
                  </div>
                )}

                <div className="flex-1 min-w-0 space-y-2.5 w-full">
                  {upiHint && (
                    <p
                      id="upi-hint"
                      data-testid="upi-missing-hint"
                      className="rounded-lg bg-amber-500/10 border border-amber-500/25 px-2.5 py-1.5 text-[11px] text-amber-800 dark:text-amber-300"
                    >
                      {upiHint}
                    </p>
                  )}
                  <div>
                    <div className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 mb-1">
                      Payment link
                    </div>
                    <div
                      data-testid="upi-uri-text"
                      className="rounded-lg bg-slate-900 text-emerald-300 font-mono text-[11px] p-2 break-all select-all border border-slate-800"
                    >
                      {upiUri ?? 'No link yet'}
                    </div>
                  </div>
                </div>
              </div>

              <div
                data-testid="upi-payee-id"
                className="rounded-xl bg-white dark:bg-slate-950/60 border border-slate-200/80 dark:border-white/10 px-3 py-2 text-xs sm:text-sm font-semibold text-slate-900 dark:text-white"
              >
                {payeeUpiId ? (
                  <>
                    Paying <span className="font-mono break-all">{payeeUpiId}</span>{' '}
                    <span className="font-normal text-slate-500 dark:text-slate-400">({payee.name})</span>
                  </>
                ) : (
                  `No UPI id for ${payee.name} yet`
                )}
              </div>

              {/* 1-Tap UPI App Launchers + Copy URI */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1">
                {(
                  [
                    ['gpay', 'Google Pay', 'GPay'],
                    ['phonepe', 'PhonePe', 'PhonePe'],
                    ['paytm', 'Paytm', 'Paytm'],
                  ] as const
                ).map(([key, appName, label]) => (
                  <button
                    key={key}
                    type="button"
                    data-testid={`upi-launch-${key}`}
                    disabled={!upiUri}
                    aria-describedby={upiHint ? 'upi-hint' : undefined}
                    onClick={() => handleLaunchUpiApp(appName)}
                    className="inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200/80 dark:border-white/10 py-2 px-2.5 text-xs font-semibold text-slate-800 dark:text-slate-200 transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <DeviceMobile size={14} weight="duotone" />
                    {label}
                  </button>
                ))}
                <button
                  type="button"
                  data-testid="copy-upi-uri-btn"
                  disabled={!upiUri}
                  onClick={handleCopyUpiUri}
                  className="inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl bg-emerald-600/15 hover:bg-emerald-600/25 border border-emerald-500/30 py-2 px-2.5 text-xs font-semibold text-emerald-800 dark:text-emerald-300 transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {copiedUpi ? (
                    <>
                      <Check size={14} weight="bold" />
                      Copied
                    </>
                  ) : (
                    <>
                      <Copy size={14} weight="duotone" />
                      Copy link
                    </>
                  )}
                </button>
              </div>

              {launchedUpiApp && upiUri && (
                <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/25 px-3 py-2 text-[11px] text-emerald-800 dark:text-emerald-300 flex items-center justify-between">
                  <span>
                    Opening <strong>{launchedUpiApp}</strong> to pay{' '}
                    <code className="font-mono">{payeeUpiId}</code>
                  </span>
                  <a href={upiUri} className="font-bold underline ml-2">
                    Open link
                  </a>
                </div>
              )}
            </div>

            {/* Recent Recorded Settlements in Active Group */}
            {!direct && (
            <div className="pt-2 border-t border-slate-200/70 dark:border-white/[0.07] space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                  <Receipt size={15} weight="duotone" />
                  Recorded Settlements ({activeGroup.name})
                </span>
                <span className="text-[11px] font-mono text-slate-500">
                  {groupSettlements.length} record(s)
                </span>
              </div>

              {groupSettlements.length === 0 ? (
                <div className="text-xs text-slate-500 dark:text-slate-400 py-2">
                  No settlements recorded for this group yet.
                </div>
              ) : (
                <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                  {groupSettlements.map((stl) => {
                    const fromName =
                      activeGroup.members.find((m) => m.id === stl.fromMemberId)
                        ?.displayName ?? stl.fromMemberId;
                    const toName =
                      activeGroup.members.find((m) => m.id === stl.toMemberId)
                        ?.displayName ?? stl.toMemberId;
                    const canChange = canChangeGroupSettlement(
                      stl,
                      activeGroup,
                      dataset.currentUser.id,
                      dataset.currentUser.email
                    );
                    return (
                      <div
                        key={stl.id}
                        data-testid={`group-settlement-${stl.id}`}
                        className={`rounded-xl border px-3 py-2 flex items-center justify-between gap-2 text-xs ${
                          editingId === stl.id
                            ? 'bg-amber-500/10 border-amber-500/30'
                            : 'bg-slate-50 dark:bg-slate-900/60 border-slate-200/70 dark:border-white/[0.06]'
                        }`}
                      >
                        <div className="min-w-0">
                          <div className="font-semibold text-slate-800 dark:text-slate-200 truncate">
                            {fromName} paid {toName}
                          </div>
                          <div className="text-[11px] text-slate-500 dark:text-slate-400 flex flex-wrap items-center gap-1.5 mt-0.5">
                            <span className="uppercase font-mono font-semibold text-emerald-600 dark:text-emerald-400">
                              {stl.paymentMethod}
                            </span>
                            <span>on</span>
                            <span className="font-mono">{stl.settledDate}</span>
                            {stl.paymentReference && (
                              <span className="font-mono text-[10px] bg-slate-200/70 dark:bg-slate-800 px-1.5 rounded">
                                {stl.paymentReference}
                              </span>
                            )}
                            {stl.batchSettlementId && (
                              <span className="font-mono text-[10px] bg-sky-500/15 text-sky-700 dark:text-sky-300 px-1.5 rounded">
                                Cross-Group Batch
                              </span>
                            )}
                          </div>
                          {stl.notes && (
                            <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                              {stl.notes}
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <CurrencyAmount
                            minorAmount={stl.amountMinor}
                            currencyCode={stl.currency}
                            className="font-bold text-emerald-600 dark:text-emerald-400"
                          />
                          {canChange && (
                            <>
                              <button
                                type="button"
                                data-testid={`edit-group-settlement-${stl.id}`}
                                onClick={() => startEditSettlement(stl)}
                                className="min-h-[44px] rounded-lg px-2 font-semibold text-sky-700 dark:text-sky-300 hover:bg-sky-500/10 cursor-pointer"
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                data-testid={`remove-group-settlement-${stl.id}`}
                                onClick={() => {
                                  if (editingId === stl.id) resetForm();
                                  deleteSettlement(stl.id);
                                }}
                                className="min-h-[44px] rounded-lg px-2 font-semibold text-rose-700 dark:text-rose-300 hover:bg-rose-500/10 cursor-pointer"
                              >
                                Remove
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            )}
          </DoubleBezelCard>
        </div>
      </div>
    </div>
  );
}

export default FriendsAndSettlePage;
