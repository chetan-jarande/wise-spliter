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
    <div className="space-y-6 min-w-0">
      {/* Editorial Spatial Header */}
      <header className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 pt-1 min-w-0">
        <div className="space-y-2 max-w-3xl min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone="emerald">
              <ShieldCheck size={14} weight="duotone" aria-hidden="true" />
              <span>Smart cross-group netting</span>
            </StatusBadge>
            <StatusBadge tone="blue">
              <Lightning size={14} weight="duotone" aria-hidden="true" />
              <span>Instant UPI QR &amp; WhatsApp share</span>
            </StatusBadge>
            <CurrencyPrecisionPill currencyCode={displayCurrency} />
          </div>

          <h1
            data-testid="friends-plain-english-summary"
            className="text-2xl sm:text-3xl lg:text-[34px] font-medium tracking-tight leading-[1.15] text-[#141715] dark:text-[#F3F5F3] break-words"
          >
            {crossGroupTotals.netOverallMinor > 0 ? (
              <>
                Friends owe you{' '}
                <span className="text-emerald-700 dark:text-emerald-300 font-semibold font-mono tabular-nums whitespace-nowrap">
                  +{formatMinorToMajor(crossGroupTotals.netOverallMinor, displayCurrency)}
                </span>{' '}
                overall
              </>
            ) : crossGroupTotals.netOverallMinor < 0 ? (
              <>
                You owe friends{' '}
                <span className="text-rose-700 dark:text-rose-300 font-semibold font-mono tabular-nums whitespace-nowrap">
                  {formatMinorToMajor(Math.abs(crossGroupTotals.netOverallMinor), displayCurrency)}
                </span>{' '}
                overall
              </>
            ) : (
              <span className="text-emerald-700 dark:text-emerald-300">
                You and your friends are all settled up
              </span>
            )}
          </h1>

          <p className="text-xs sm:text-sm text-[#4A524D] dark:text-[#B7BEB9] leading-relaxed">
            Shared group balances with the same friend combine automatically without ever mixing strangers across groups. Settle all shared tabs in one tap, scan a UPI QR code, or copy a verified WhatsApp summary.
          </p>

          {crossGroupTotals.rateLabel && (
            <p
              data-testid="friends-fx-label"
              className="text-[11px] text-[#5C6660] dark:text-[#9CA69F]"
            >
              {crossGroupTotals.rateLabel}
            </p>
          )}
          {crossGroupTotals.unconvertedTotals.length > 0 && (
            <p
              data-testid="friends-unconverted-balances"
              className="text-[11px] text-amber-800 dark:text-amber-200 break-words"
            >
              Not included in the {displayCurrency} totals (no exchange rate):{' '}
              {crossGroupTotals.unconvertedTotals
                .map(([code, minor]) => `${minor > 0 ? '+' : ''}${formatMinorToMajor(minor, code)} ${code}`)
                .join(', ')}
            </p>
          )}
        </div>
      </header>

      {/* 3 Sculpted Glass Metric Tiles */}
      <DoubleBezelCard innerClassName="p-4 sm:p-5 min-w-0">
        <div
          data-testid="friends-stat-tiles"
          className="grid grid-cols-1 md:grid-cols-3 gap-3 min-w-0"
        >
          <div className="lg-recessed-well rounded-[1.25rem] px-4 py-3.5 min-w-0 flex items-center justify-between gap-3 md:flex-col md:items-start md:justify-between border-emerald-600/20 dark:border-emerald-400/20">
            <div className="text-xs font-medium text-emerald-800 dark:text-emerald-300">
              Friends Owe You
            </div>
            <div className="md:mt-2 shrink-0 whitespace-nowrap text-base md:text-sm xl:text-xl font-semibold">
              <CurrencyAmount
                minorAmount={crossGroupTotals.owedToMeMinor}
                currencyCode={displayCurrency}
                colorize
                showPlusSign
              />
            </div>
          </div>

          <div className="lg-recessed-well rounded-[1.25rem] px-4 py-3.5 min-w-0 flex items-center justify-between gap-3 md:flex-col md:items-start md:justify-between border-rose-600/20 dark:border-rose-400/20">
            <div className="text-xs font-medium text-rose-800 dark:text-rose-300">
              You Owe Friends
            </div>
            <div className="md:mt-2 shrink-0 whitespace-nowrap text-base md:text-sm xl:text-xl font-semibold">
              <CurrencyAmount
                minorAmount={-crossGroupTotals.iOweMinor}
                currencyCode={displayCurrency}
                colorize
              />
            </div>
          </div>

          <div className="lg-recessed-well rounded-[1.25rem] px-4 py-3.5 min-w-0 flex items-center justify-between gap-3 md:flex-col md:items-start md:justify-between">
            <div className="text-xs font-medium text-[#4A524D] dark:text-[#B7BEB9]">
              Combined Net ({displayCurrency})
            </div>
            <div className="md:mt-2 shrink-0 whitespace-nowrap text-base md:text-sm xl:text-xl font-semibold">
              <CurrencyAmount
                minorAmount={crossGroupTotals.netOverallMinor}
                currencyCode={displayCurrency}
                colorize
                showPlusSign
              />
            </div>
          </div>
        </div>
      </DoubleBezelCard>

      {/* Main 12-Column Responsive Spatial Workspace */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start min-w-0">
        {/* LEFT 7 COLUMNS: Cross-Group Friend Net Balances & WhatsApp Studio */}
        <div className="lg:col-span-7 space-y-5 min-w-0">
          <DoubleBezelCard
            testId="friends-cross-group-list"
            innerClassName="p-4 sm:p-6 space-y-5 min-w-0"
          >
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-black/[0.07] dark:border-white/[0.08] pb-4 min-w-0">
              <div className="flex items-start gap-3 min-w-0">
                <span className="lg-icon-orb h-9 w-9 rounded-full flex items-center justify-center shrink-0 mt-0.5">
                  <UsersThree
                    size={18}
                    weight="duotone"
                    className="text-emerald-700 dark:text-emerald-300"
                    aria-hidden="true"
                  />
                </span>
                <div className="min-w-0">
                  <h2 className="text-base sm:text-lg font-semibold tracking-tight text-[#141715] dark:text-[#F3F5F3]">
                    Cross-group friend balances
                  </h2>
                  <p className="text-xs text-[#5C6660] dark:text-[#9CA69F] mt-0.5">
                    Per-friend aggregation across {activeGroups.length} active {activeGroups.length === 1 ? 'group' : 'groups'} normalized to {displayCurrency}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <span className="text-xs font-medium text-[#5C6660] dark:text-[#9CA69F]">
                  Batch method:
                </span>
                <select
                  aria-label="Cross-group batch payment method"
                  value={selectedPaymentMethod}
                  onChange={(e) =>
                    setSelectedPaymentMethod(
                      e.target.value as SettlementItem['paymentMethod']
                    )
                  }
                  className="lg-recessed-well min-h-[44px] rounded-full px-3.5 py-1.5 text-xs font-semibold text-[#141715] dark:text-[#F3F5F3] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 cursor-pointer"
                >
                  {PAYMENT_METHODS.map((pm) => (
                    <option key={pm.key} value={pm.key} className="bg-[#F6F8F6] dark:bg-[#222522]">
                      {pm.label} ({pm.key.toUpperCase()})
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="space-y-4 min-w-0">
              {friendsSummary.length === 0 ? (
                <div className="lg-recessed-well rounded-[1.25rem] p-6 text-center space-y-2">
                  <span className="lg-icon-orb h-10 w-10 rounded-full flex items-center justify-center mx-auto">
                    <UsersThree size={18} weight="duotone" className="text-[#4A524D] dark:text-[#B7BEB9]" aria-hidden="true" />
                  </span>
                  <div className="text-sm font-semibold text-[#141715] dark:text-[#F3F5F3]">
                    No shared friend balances yet
                  </div>
                  <p className="text-xs text-[#5C6660] dark:text-[#9CA69F] max-w-md mx-auto">
                    Add friends to a group or record a direct 1-on-1 split to track cross-group balances here.
                  </p>
                </div>
              ) : (
                friendsSummary.map((friend) => {
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
                      className="lg-recessed-well rounded-[1.375rem] p-4 sm:p-5 transition-colors min-w-0"
                    >
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 min-w-0">
                        {/* Friend Identity & Badges */}
                        <div className="flex items-start gap-3.5 min-w-0">
                          <div className="lg-icon-orb h-11 w-11 rounded-full flex items-center justify-center text-sm font-mono font-semibold text-emerald-800 dark:text-emerald-200 shrink-0">
                            {friend.avatarInitials}
                          </div>

                          <div className="space-y-1.5 min-w-0">
                            <div className="flex flex-wrap items-center gap-2 min-w-0">
                              <h3
                                dir="auto"
                                title={friend.displayName}
                                className="text-sm sm:text-base font-semibold text-[#141715] dark:text-[#F3F5F3] truncate max-w-full"
                              >
                                {friend.displayName}
                              </h3>
                              {friend.isClaimedAccount ? (
                                <StatusBadge tone="emerald">
                                  <CheckCircle size={12} weight="fill" aria-hidden="true" />
                                  <span>Joined</span>
                                </StatusBadge>
                              ) : (
                                <StatusBadge tone="amber">
                                  <Info size={12} weight="bold" aria-hidden="true" />
                                  <span>Invite Pending</span>
                                </StatusBadge>
                              )}
                            </div>

                            <div className="flex flex-wrap items-center gap-2 text-xs text-[#5C6660] dark:text-[#9CA69F] min-w-0">
                              {friend.email && <span className="break-all">{friend.email}</span>}
                              {friend.upiId && (
                                <span
                                  data-testid={`friend-upi-${friend.friendKey}`}
                                  className="lg-scene-tile inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 font-mono text-[11px] text-[#2B312D] dark:text-[#DCE2DD] break-all"
                                >
                                  <QrCode size={12} weight="duotone" aria-hidden="true" />
                                  <span>{friend.upiId}</span>
                                </span>
                              )}
                              {friend.upiIdVaries && (
                                <span
                                  data-testid={`friend-upi-varies-${friend.friendKey}`}
                                  className="inline-flex items-center gap-1 rounded-full bg-amber-500/14 ring-1 ring-amber-600/25 dark:ring-amber-300/25 px-2.5 py-0.5 text-[11px] text-amber-900 dark:text-amber-200"
                                >
                                  <QrCode size={12} weight="duotone" aria-hidden="true" />
                                  <span>UPI varies by bill. Check the &ldquo;Paying&rdquo; line before you pay.</span>
                                </span>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* Overall net balance + 1-Tap Settle Up */}
                        <div className="flex flex-wrap sm:flex-col items-center sm:items-end justify-between gap-2 border-t sm:border-t-0 pt-3 sm:pt-0 border-black/[0.07] dark:border-white/[0.08] shrink-0">
                          <div className="text-left sm:text-right">
                            <div className="text-[11px] font-medium text-[#5C6660] dark:text-[#9CA69F]">
                              {fx.netMinor > 0
                                ? `Owes you net (${displayCurrency})`
                                : fx.netMinor < 0
                                ? `You owe net (${displayCurrency})`
                                : fx.unconverted.length > 0
                                ? 'Open balances'
                                : 'Settled across all groups'}
                            </div>
                            <div className="text-lg sm:text-xl font-semibold whitespace-nowrap">
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
                                className="text-[11px] font-mono text-amber-800 dark:text-amber-200"
                              >
                                {minor > 0 ? '+' : ''}
                                {formatMinorToMajor(minor, code)} {code} (no rate)
                              </div>
                            ))}
                          </div>

                          <div className="flex flex-wrap items-center justify-end gap-2">
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
                              className={`min-h-[44px] inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-xs font-semibold transition-[transform,opacity,background-color,color,box-shadow] duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 ${
                                hasOpenBalances
                                  ? 'lg-luminous-pill cursor-pointer'
                                  : 'bg-black/[0.05] dark:bg-white/[0.05] text-[#68726C] dark:text-[#8A938D] cursor-not-allowed opacity-65'
                              }`}
                            >
                              <Lightning size={14} weight="fill" aria-hidden="true" />
                              <span>
                                {hasOpenBalances
                                  ? `1-Tap Settle All (${friend.groupBreakdowns.length} ${
                                      friend.groupBreakdowns.length === 1
                                        ? 'Group'
                                        : 'Groups'
                                    })`
                                  : 'All Groups Settled'}
                              </span>
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
                                className="lg-scene-tile inline-flex min-h-[44px] items-center gap-1.5 rounded-full px-3.5 py-2 text-xs font-semibold text-[#141715] dark:text-[#F3F5F3] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
                              >
                                <Money size={14} weight="duotone" className="text-emerald-700 dark:text-emerald-300" aria-hidden="true" />
                                <span>Record a payment</span>
                              </button>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Per-Group Breakdown List */}
                      <div className="mt-4 pt-3 border-t border-black/[0.07] dark:border-white/[0.08]">
                        <div className="flex flex-wrap items-center justify-between gap-1 mb-2.5">
                          <span className="text-xs font-medium text-[#5C6660] dark:text-[#9CA69F]">
                            Per-group breakdown
                          </span>
                          {hasMultipleGroups && (
                            <span className="text-[11px] font-medium text-emerald-800 dark:text-emerald-300">
                              Offsetting group balances net out without mixing strangers
                            </span>
                          )}
                        </div>

                        {friend.groupBreakdowns.length === 0 ? (
                          <div className="lg-scene-tile rounded-2xl px-3.5 py-2.5 text-xs text-[#5C6660] dark:text-[#9CA69F] flex items-center justify-between gap-2">
                            <span className="min-w-0 break-words">
                              Zero unsettled balance with {friend.displayName} in any shared group.
                            </span>
                            <StatusBadge tone="emerald" className="shrink-0">0.00 Net</StatusBadge>
                          </div>
                        ) : (
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                            {friend.groupBreakdowns.map((gb) => (
                              <div
                                key={gb.expenseId ?? gb.groupId ?? gb.groupName}
                                className="lg-scene-tile rounded-2xl p-3 flex items-center justify-between gap-2 min-w-0"
                              >
                                <div className="min-w-0">
                                  <div
                                    dir="auto"
                                    title={gb.groupName}
                                    className="text-xs font-semibold text-[#141715] dark:text-[#F3F5F3] truncate"
                                  >
                                    {gb.groupName}
                                  </div>
                                  <div className="text-[11px] text-[#5C6660] dark:text-[#9CA69F] mt-0.5 flex flex-wrap items-center gap-1.5">
                                    <span className="truncate">
                                      {gb.netMinor > 0
                                        ? `${friend.displayName.split(' ')[0]} owes you`
                                        : `You owe ${friend.displayName.split(' ')[0]}`}
                                    </span>
                                    <span className="font-mono text-[10px] px-2 py-0.5 rounded-full bg-black/[0.055] dark:bg-white/[0.08] text-[#2B312D] dark:text-[#DCE2DD]">
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
                                    className="text-xs sm:text-sm font-semibold whitespace-nowrap"
                                  />
                                  <button
                                    type="button"
                                    onClick={() =>
                                      handleLoadGroupBreakdownIntoStudio(
                                        friend.friendKey,
                                        gb
                                      )
                                    }
                                    className="min-h-[44px] rounded-full px-2.5 text-[11px] font-semibold text-emerald-800 dark:text-emerald-300 hover:underline cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
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
                })
              )}
            </div>
          </DoubleBezelCard>

          {/* 3. One-Tap WhatsApp / Chat Summary Card & Text Generator */}
          <DoubleBezelCard
            testId="whatsapp-summary-panel"
            innerClassName="p-4 sm:p-6 space-y-5 min-w-0"
          >
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-black/[0.07] dark:border-white/[0.08] pb-4 min-w-0">
              <div className="flex items-start gap-3 min-w-0">
                <span className="lg-icon-orb h-9 w-9 rounded-full flex items-center justify-center shrink-0 mt-0.5">
                  <WhatsappLogo
                    size={18}
                    weight="duotone"
                    className="text-emerald-700 dark:text-emerald-300"
                    aria-hidden="true"
                  />
                </span>
                <div className="min-w-0">
                  <h2 className="text-base sm:text-lg font-semibold tracking-tight text-[#141715] dark:text-[#F3F5F3]">
                    WhatsApp &amp; chat summary studio
                  </h2>
                  <p className="text-xs text-[#5C6660] dark:text-[#9CA69F] mt-0.5">
                    Spatial card preview and ready-to-paste markdown with embedded UPI payment links
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  data-testid="copy-whatsapp-summary-btn"
                  onClick={handleCopyWhatsAppSummary}
                  className="lg-luminous-pill min-h-[44px] inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-xs font-semibold cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
                >
                  {copiedWhatsApp ? (
                    <>
                      <Check size={15} weight="bold" aria-hidden="true" />
                      <span>Copied for WhatsApp</span>
                    </>
                  ) : (
                    <>
                      <Copy size={15} weight="duotone" aria-hidden="true" />
                      <span>Copy Summary</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Spatial Glass Summary Card Preview + Markdown */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 min-w-0">
              <div className="lg-recessed-well rounded-[1.375rem] p-4 sm:p-5 flex flex-col justify-between space-y-4 min-w-0">
                <div className="space-y-3 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <StatusBadge tone="emerald">
                      <Sparkle size={12} weight="fill" aria-hidden="true" />
                      <span>Verified Ledger</span>
                    </StatusBadge>
                    <CurrencyPrecisionPill currencyCode={activeGroup.baseCurrency} />
                  </div>

                  <div className="min-w-0">
                    <h3
                      dir="auto"
                      title={activeGroup.name}
                      className="text-base font-semibold text-[#141715] dark:text-[#F3F5F3] truncate"
                    >
                      {activeGroup.name}
                    </h3>
                    <div className="text-xs text-[#4A524D] dark:text-[#B7BEB9] mt-0.5">
                      Total group spend:{' '}
                      <span className="font-mono font-semibold text-emerald-700 dark:text-emerald-300 whitespace-nowrap">
                        {formatMinorToMajor(
                          totalGroupSpendMinor,
                          activeGroup.baseCurrency
                        )}
                      </span>
                    </div>
                  </div>

                  <div className="space-y-1.5 pt-2.5 border-t border-black/[0.07] dark:border-white/[0.08]">
                    <div className="text-[11px] font-medium text-[#5C6660] dark:text-[#9CA69F]">
                      Net member positions
                    </div>
                    {activeGroup.members.map((m) => {
                      const net = groupNetBalancesMap.get(m.id) ?? 0;
                      return (
                        <div
                          key={m.id}
                          className="flex items-center justify-between gap-2 text-xs min-w-0"
                        >
                          <span
                            dir="auto"
                            title={m.displayName}
                            className="text-[#141715] dark:text-[#F3F5F3] font-medium truncate"
                          >
                            {m.displayName}
                          </span>
                          <span
                            className={`font-mono tabular-nums font-semibold shrink-0 whitespace-nowrap ${
                              net > 0
                                ? 'text-emerald-700 dark:text-emerald-300'
                                : net < 0
                                ? 'text-rose-700 dark:text-rose-300'
                                : 'text-[#68726C] dark:text-[#8A938D]'
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

                <div className="pt-3 border-t border-black/[0.07] dark:border-white/[0.08] flex items-center justify-between gap-2 text-[11px] text-[#5C6660] dark:text-[#9CA69F]">
                  <span className="truncate">
                    {activeGroup.simplifyDebts
                      ? 'Simplified minimum transfers'
                      : 'Direct pairwise balances'}
                  </span>
                  <span className="font-mono font-semibold text-emerald-700 dark:text-emerald-300 shrink-0">
                    {groupSuggestedTransfers.length} transfer(s)
                  </span>
                </div>
              </div>

              {/* Formatted WhatsApp Markdown Text */}
              <div className="flex flex-col h-full min-w-0">
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <span className="text-xs font-medium text-[#4A524D] dark:text-[#B7BEB9]">
                    Formatted chat markdown
                  </span>
                  <a
                    href={`https://wa.me/?text=${encodeURIComponent(
                      whatsappSummaryText
                    )}`}
                    target="_blank"
                    rel="noreferrer"
                    className="min-h-[44px] inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 dark:text-emerald-300 hover:underline"
                  >
                    <WhatsappLogo size={14} weight="fill" aria-hidden="true" />
                    <span>Open in WhatsApp</span>
                  </a>
                </div>
                <pre
                  data-testid="whatsapp-summary-markdown"
                  className="lg-recessed-well flex-1 rounded-[1.25rem] p-3.5 text-xs font-mono text-[#141715] dark:text-[#F3F5F3] whitespace-pre-wrap break-words overflow-x-auto leading-relaxed"
                >
                  {whatsappSummaryText}
                </pre>
              </div>
            </div>
          </DoubleBezelCard>
        </div>

        {/* RIGHT 5 COLUMNS: Interactive Settle Up & UPI Deep-Link / QR Studio */}
        <div className="lg:col-span-5 space-y-5 min-w-0">
          <DoubleBezelCard
            testId="settle-up-studio"
            innerClassName="p-4 sm:p-6 space-y-5 min-w-0"
          >
            <div className="flex items-center justify-between gap-2 border-b border-black/[0.07] dark:border-white/[0.08] pb-4 min-w-0">
              <div className="flex items-start gap-3 min-w-0">
                <span className="lg-icon-orb h-9 w-9 rounded-full flex items-center justify-center shrink-0 mt-0.5">
                  <ArrowsLeftRight
                    size={18}
                    weight="duotone"
                    className="text-emerald-700 dark:text-emerald-300"
                    aria-hidden="true"
                  />
                </span>
                <div className="min-w-0">
                  <h2 className="text-base sm:text-lg font-semibold tracking-tight text-[#141715] dark:text-[#F3F5F3]">
                    Settle up &amp; UPI QR studio
                  </h2>
                  <p className="text-xs text-[#5C6660] dark:text-[#9CA69F] mt-0.5">
                    Record full or partial settlements and generate NPCI UPI QR codes
                  </p>
                </div>
              </div>
              <CurrencyPrecisionPill currencyCode={studioCurrency} />
            </div>

            {direct ? (
              <div
                data-testid="direct-payback-panel"
                className="lg-recessed-well rounded-[1.25rem] p-3.5 space-y-2.5 min-w-0"
              >
                <div className="flex items-start justify-between gap-2 min-w-0">
                  <div className="min-w-0">
                    <div className="text-xs sm:text-sm font-semibold text-[#141715] dark:text-[#F3F5F3] break-words">
                      {directPlan && directPlan.maxMinor > 0n
                        ? directPlan.friendPays
                          ? `${directFriend?.displayName ?? 'Your friend'} owes you ${formatMinorToMajor(directPlan.maxMinor, studioCurrency)}`
                          : `You owe ${directFriend?.displayName ?? 'your friend'} ${formatMinorToMajor(directPlan.maxMinor, studioCurrency)}`
                        : `You and ${directFriend?.displayName ?? 'your friend'} are settled up in ${studioCurrency}.`}
                    </div>
                    <p className="text-[11px] text-[#5C6660] dark:text-[#9CA69F] mt-0.5 break-words">
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
                    className="lg-scene-tile min-h-[44px] shrink-0 rounded-full px-3.5 text-xs font-semibold text-[#141715] dark:text-[#F3F5F3] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
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
                    className="lg-recessed-well min-h-[44px] w-full rounded-xl px-3 text-xs font-semibold text-[#141715] dark:text-[#F3F5F3] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50"
                  >
                    {directCurrencies.map((c) => (
                      <option key={c} value={c} className="bg-[#F6F8F6] dark:bg-[#222522]">
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
                    className="block text-xs font-medium text-[#2B312D] dark:text-[#DCE2DD]"
                  >
                    Active group for settlement &amp; WhatsApp summary
                  </label>
                  <select
                    id="studio-group-select"
                    data-testid="settle-group-select"
                    value={activeGroup.id}
                    onChange={(e) => setActiveGroupId(e.target.value)}
                    className="lg-recessed-well min-h-[44px] w-full rounded-xl px-3.5 py-2 text-xs sm:text-sm font-semibold text-[#141715] dark:text-[#F3F5F3] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 cursor-pointer"
                  >
                    {activeGroups.map((g) => (
                      <option key={g.id} value={g.id} className="bg-[#F6F8F6] dark:bg-[#222522]">
                        {g.name} ({g.baseCurrency})
                      </option>
                    ))}
                  </select>
                </div>

                {/* Suggested Transfers Quick Fill Pills */}
                {groupSuggestedTransfers.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium text-[#5C6660] dark:text-[#9CA69F]">
                        Suggested transfers (tap to pre-fill)
                      </span>
                      <span className="text-[11px] text-[#5C6660] dark:text-[#9CA69F]">
                        {activeGroup.simplifyDebts
                          ? 'Simplified mode'
                          : 'Pairwise mode'}
                      </span>
                    </div>
                    <div className="space-y-2">
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
                            className={`rounded-2xl p-2.5 flex flex-wrap items-center justify-between gap-2 transition-colors min-w-0 ${
                              isSelected
                                ? 'lg-scene-tile ring-1 ring-emerald-600/35 dark:ring-emerald-400/35'
                                : 'lg-recessed-well'
                            }`}
                          >
                            <div className="flex items-center gap-1.5 text-xs font-semibold text-[#141715] dark:text-[#F3F5F3] min-w-0 truncate">
                              <span className="truncate">{fromM?.displayName ?? 'Member'}</span>
                              <ArrowRight size={13} className="text-[#68726C] dark:text-[#8A938D] shrink-0" aria-hidden="true" />
                              <span className="truncate">{toM?.displayName ?? 'Member'}</span>
                              <span className="font-mono tabular-nums text-emerald-700 dark:text-emerald-300 ml-1 shrink-0 whitespace-nowrap">
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
                                className="lg-luminous-pill min-h-[36px] rounded-full px-3 py-1 text-[11px] font-semibold cursor-pointer"
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
                                className="lg-scene-tile min-h-[36px] rounded-full px-3 py-1 text-[11px] font-semibold text-[#141715] dark:text-[#F3F5F3] cursor-pointer"
                              >
                                50%
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
                <div className="flex items-center justify-between gap-2 rounded-2xl border border-amber-600/30 bg-amber-500/12 px-3.5 py-2 text-xs text-amber-900 dark:text-amber-200">
                  <span>Editing a recorded payment. Who paid whom stays the same.</span>
                  <button
                    type="button"
                    data-testid="cancel-edit-settlement-btn"
                    onClick={resetForm}
                    className="min-h-[44px] rounded-full px-3 font-semibold hover:bg-amber-500/15 cursor-pointer"
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
                      className="block text-xs font-medium text-[#2B312D] dark:text-[#DCE2DD] mb-1.5"
                    >
                      Payer (from member)
                    </label>
                    <select
                      id="settle-from-member"
                      data-testid="settle-from-member-select"
                      value={fromMember?.id ?? ''}
                      disabled={!!editingId}
                      onChange={(e) => setFromMemberId(e.target.value)}
                      className="lg-recessed-well min-h-[44px] w-full rounded-xl px-3 py-2 text-xs sm:text-sm font-medium text-[#141715] dark:text-[#F3F5F3] disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50"
                    >
                      {settleMembers.map((m) => (
                        <option key={m.id} value={m.id} className="bg-[#F6F8F6] dark:bg-[#222522]">
                          {m.displayName}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label
                      htmlFor="settle-to-member"
                      className="block text-xs font-medium text-[#2B312D] dark:text-[#DCE2DD] mb-1.5"
                    >
                      Recipient (to member)
                    </label>
                    <select
                      id="settle-to-member"
                      data-testid="settle-to-member-select"
                      value={toMember?.id ?? ''}
                      disabled={!!editingId}
                      onChange={(e) => setToMemberId(e.target.value)}
                      className="lg-recessed-well min-h-[44px] w-full rounded-xl px-3 py-2 text-xs sm:text-sm font-medium text-[#141715] dark:text-[#F3F5F3] disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50"
                    >
                      {settleMembers.map((m) => (
                        <option key={m.id} value={m.id} className="bg-[#F6F8F6] dark:bg-[#222522]">
                          {m.displayName}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              )}

              {/* Editable Full or Partial Amount */}
              <div>
                <div className="flex flex-wrap items-center justify-between gap-1 mb-1.5">
                  <label
                    htmlFor="settle-amount-input"
                    className="text-xs font-medium text-[#2B312D] dark:text-[#DCE2DD]"
                  >
                    Amount ({studioCurrency}), full or partial
                  </label>
                  {owedLimit > 0n && (
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        data-testid="settle-amount-full-btn"
                        onClick={() => setAmountMajorInput(toMajorInput(owedLimit, studioCurrency))}
                        className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-300 hover:underline cursor-pointer"
                      >
                        Full ({formatMinorToMajor(owedLimit, studioCurrency)})
                      </button>
                      <span className="text-[#68726C] dark:text-[#8A938D]">/</span>
                      <button
                        type="button"
                        onClick={() =>
                          setAmountMajorInput(
                            toMajorInput(owedLimit > 1n ? owedLimit / 2n : owedLimit, studioCurrency)
                          )
                        }
                        className="text-[11px] font-semibold text-[#4A524D] dark:text-[#B7BEB9] hover:underline cursor-pointer"
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
                  className="lg-recessed-well min-h-[44px] w-full rounded-xl px-3.5 py-2.5 font-mono tabular-nums text-sm font-semibold text-[#141715] dark:text-[#F3F5F3] placeholder:text-[#68726C] dark:placeholder:text-[#8A938D] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50"
                />
                {showAmountProblem && (
                  <p
                    id="settle-amount-error"
                    data-testid="settle-amount-error"
                    role="alert"
                    className="mt-1.5 text-[11px] font-medium text-amber-800 dark:text-amber-200"
                  >
                    {amountProblem}
                  </p>
                )}
              </div>

              {/* Payment Method Selector */}
              <div>
                <span className="block text-xs font-medium text-[#2B312D] dark:text-[#DCE2DD] mb-1.5">
                  Payment method
                </span>
                <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
                  {PAYMENT_METHODS.map((pm) => {
                    const active = selectedPaymentMethod === pm.key;
                    return (
                      <button
                        key={pm.key}
                        type="button"
                        data-testid={`payment-method-${pm.key}`}
                        onClick={() => setSelectedPaymentMethod(pm.key)}
                        className={`min-h-[48px] min-w-0 rounded-2xl py-2 px-2 text-center text-xs font-semibold cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 ${
                          active
                            ? 'lg-luminous-pill'
                            : 'lg-scene-tile text-[#141715] dark:text-[#F3F5F3]'
                        }`}
                      >
                        <div className="flex items-center justify-center mb-0.5">
                          {pm.key === 'upi' && <QrCode size={15} weight="duotone" aria-hidden="true" />}
                          {pm.key === 'cash' && <Money size={15} weight="duotone" aria-hidden="true" />}
                          {pm.key === 'bank' && <Bank size={15} weight="duotone" aria-hidden="true" />}
                          {pm.key === 'paypal' && (
                            <CreditCard size={15} weight="duotone" aria-hidden="true" />
                          )}
                          {pm.key === 'venmo' && <Wallet size={15} weight="duotone" aria-hidden="true" />}
                        </div>
                        <span className="uppercase text-[11px] block truncate">{pm.key}</span>
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
                    className="block text-xs font-medium text-[#2B312D] dark:text-[#DCE2DD] mb-1.5"
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
                    className="lg-recessed-well w-full min-h-[44px] rounded-xl px-3 py-2 text-xs font-mono text-[#141715] dark:text-[#F3F5F3] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50"
                  />
                  {dateProblem && (
                    <p
                      data-testid="settle-date-error"
                      role="alert"
                      className="mt-1 text-[11px] font-medium text-amber-800 dark:text-amber-200"
                    >
                      {dateProblem}
                    </p>
                  )}
                </div>

                <div>
                  <label
                    htmlFor="settle-ref-input"
                    className="block text-xs font-medium text-[#2B312D] dark:text-[#DCE2DD] mb-1.5"
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
                    placeholder="UPI or bank ref"
                    className="lg-recessed-well w-full min-h-[44px] rounded-xl px-3 py-2 text-xs font-mono text-[#141715] dark:text-[#F3F5F3] placeholder:text-[#68726C] dark:placeholder:text-[#8A938D] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50"
                  />
                </div>

                <div>
                  <label
                    htmlFor="settle-notes-input"
                    className="block text-xs font-medium text-[#2B312D] dark:text-[#DCE2DD] mb-1.5"
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
                    className="lg-recessed-well w-full min-h-[44px] rounded-xl px-3 py-2 text-xs text-[#141715] dark:text-[#F3F5F3] placeholder:text-[#68726C] dark:placeholder:text-[#8A938D] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50"
                  />
                </div>
              </div>

              <button
                type="submit"
                data-testid="record-settlement-submit-btn"
                className="lg-luminous-pill w-full min-h-[48px] rounded-full font-semibold py-2.5 px-5 text-xs sm:text-sm flex items-center justify-center gap-2 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
              >
                <CheckCircle size={18} weight="fill" className="shrink-0" aria-hidden="true" />
                <span className="truncate">
                  {editingId ? 'Save changes' : 'Record payment'} ({payerFirst}{' '}
                  {payerFirst === 'You' ? 'pay' : 'pays'} {payeeFirst}{' '}
                  {formatMinorToMajor(amountMinor > 0n ? amountMinor : 0n, studioCurrency)})
                </span>
              </button>
            </form>

            {/* Live UPI Deep-Link & QR Code Generator */}
            <div
              data-testid="upi-deep-link-box"
              className="lg-recessed-well rounded-[1.375rem] p-4 space-y-4 min-w-0"
            >
              <div className="flex items-center justify-between gap-2 min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="lg-icon-orb h-8 w-8 rounded-full flex items-center justify-center shrink-0">
                    <QrCode
                      size={16}
                      weight="duotone"
                      className="text-emerald-700 dark:text-emerald-300"
                      aria-hidden="true"
                    />
                  </span>
                  <span className="text-xs sm:text-sm font-semibold text-[#141715] dark:text-[#F3F5F3] truncate">
                    Pay {payee.name} by UPI
                  </span>
                </div>
                {upiUri && <StatusBadge tone="emerald">Ready</StatusBadge>}
              </div>

              <div className="flex flex-col sm:flex-row items-center gap-4 min-w-0">
                {upiUri && (
                  <div className="rounded-2xl bg-white p-3 ring-1 ring-black/10 shadow-sm shrink-0">
                    <QRCodeSVG value={upiUri} size={132} level="M" marginSize={0} />
                  </div>
                )}

                <div className="flex-1 min-w-0 space-y-2.5 w-full">
                  {upiHint && (
                    <p
                      id="upi-hint"
                      data-testid="upi-missing-hint"
                      className="rounded-xl bg-amber-500/12 border border-amber-600/25 px-3 py-2 text-[11px] text-amber-900 dark:text-amber-200"
                    >
                      {upiHint}
                    </p>
                  )}
                  <div>
                    <div className="text-[11px] font-medium text-[#5C6660] dark:text-[#9CA69F] mb-1">
                      Payment link
                    </div>
                    <div
                      data-testid="upi-uri-text"
                      className="lg-scene-tile rounded-xl font-mono text-[11px] text-emerald-800 dark:text-emerald-300 p-2.5 break-all select-all"
                    >
                      {upiUri ?? 'No link yet'}
                    </div>
                  </div>
                </div>
              </div>

              <div
                data-testid="upi-payee-id"
                className="lg-scene-tile rounded-xl px-3.5 py-2.5 text-xs sm:text-sm font-semibold text-[#141715] dark:text-[#F3F5F3] break-words"
              >
                {payeeUpiId ? (
                  <>
                    Paying <span className="font-mono break-all">{payeeUpiId}</span>{' '}
                    <span className="font-normal text-[#5C6660] dark:text-[#9CA69F]">({payee.name})</span>
                  </>
                ) : (
                  `No UPI id for ${payee.name} yet`
                )}
              </div>

              {/* 1-Tap UPI App Launchers + Copy URI */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-0.5">
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
                    className="lg-scene-tile inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-full py-2 px-2.5 text-xs font-semibold text-[#141715] dark:text-[#F3F5F3] cursor-pointer disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
                  >
                    <DeviceMobile size={14} weight="duotone" aria-hidden="true" />
                    <span>{label}</span>
                  </button>
                ))}
                <button
                  type="button"
                  data-testid="copy-upi-uri-btn"
                  disabled={!upiUri}
                  onClick={handleCopyUpiUri}
                  className="inline-flex min-h-[44px] items-center justify-center gap-1.5 rounded-full bg-emerald-500/14 hover:bg-emerald-500/22 border border-emerald-600/30 dark:border-emerald-400/30 py-2 px-2.5 text-xs font-semibold text-emerald-800 dark:text-emerald-200 transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60"
                >
                  {copiedUpi ? (
                    <>
                      <Check size={14} weight="bold" aria-hidden="true" />
                      <span>Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy size={14} weight="duotone" aria-hidden="true" />
                      <span>Copy link</span>
                    </>
                  )}
                </button>
              </div>

              {launchedUpiApp && upiUri && (
                <div className="rounded-xl bg-emerald-500/12 border border-emerald-600/25 px-3 py-2 text-[11px] text-emerald-900 dark:text-emerald-200 flex items-center justify-between gap-2">
                  <span className="min-w-0 break-words">
                    Opening <strong>{launchedUpiApp}</strong> to pay{' '}
                    <code className="font-mono break-all">{payeeUpiId}</code>
                  </span>
                  <a href={upiUri} className="font-semibold underline shrink-0">
                    Open link
                  </a>
                </div>
              )}
            </div>

            {/* Recent Recorded Settlements in Active Group */}
            {!direct && (
              <div className="pt-2 border-t border-black/[0.07] dark:border-white/[0.08] space-y-2.5 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-[#141715] dark:text-[#F3F5F3] flex items-center gap-1.5 min-w-0 truncate">
                    <Receipt size={15} weight="duotone" className="shrink-0 text-emerald-700 dark:text-emerald-300" aria-hidden="true" />
                    <span className="truncate">Recorded settlements ({activeGroup.name})</span>
                  </span>
                  <span className="text-[11px] font-mono text-[#5C6660] dark:text-[#9CA69F] shrink-0">
                    {groupSettlements.length} record(s)
                  </span>
                </div>

                {groupSettlements.length === 0 ? (
                  <div className="text-xs text-[#5C6660] dark:text-[#9CA69F] py-2">
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
                          className={`rounded-2xl px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs min-w-0 ${
                            editingId === stl.id
                              ? 'bg-amber-500/12 border border-amber-600/30'
                              : 'lg-recessed-well'
                          }`}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="font-semibold text-[#141715] dark:text-[#F3F5F3] truncate">
                              {fromName} paid {toName}
                            </div>
                            <div className="text-[11px] text-[#5C6660] dark:text-[#9CA69F] flex flex-wrap items-center gap-1.5 mt-0.5">
                              <span className="uppercase font-mono font-semibold text-emerald-700 dark:text-emerald-300">
                                {stl.paymentMethod}
                              </span>
                              <span>on</span>
                              <span className="font-mono">{stl.settledDate}</span>
                              {stl.paymentReference && (
                                <span className="font-mono text-[10px] bg-black/[0.06] dark:bg-white/[0.08] px-2 py-0.5 rounded-full">
                                  {stl.paymentReference}
                                </span>
                              )}
                              {stl.batchSettlementId && (
                                <span className="font-mono text-[10px] bg-sky-500/14 text-sky-800 dark:text-sky-200 px-2 py-0.5 rounded-full">
                                  Cross-group batch
                                </span>
                              )}
                            </div>
                            {stl.notes && (
                              <div className="text-[11px] text-[#5C6660] dark:text-[#9CA69F] truncate">
                                {stl.notes}
                              </div>
                            )}
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <CurrencyAmount
                              minorAmount={stl.amountMinor}
                              currencyCode={stl.currency}
                              className="font-semibold text-emerald-700 dark:text-emerald-300 whitespace-nowrap"
                            />
                            {canChange && (
                              <>
                                <button
                                  type="button"
                                  data-testid={`edit-group-settlement-${stl.id}`}
                                  onClick={() => startEditSettlement(stl)}
                                  className="min-h-[44px] rounded-full px-2.5 font-semibold text-[#141715] dark:text-[#F3F5F3] hover:bg-black/[0.05] dark:hover:bg-white/[0.07] cursor-pointer"
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
                                  className="min-h-[44px] rounded-full px-2.5 font-semibold text-rose-700 dark:text-rose-300 hover:bg-rose-500/12 cursor-pointer"
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
