import React, { useEffect, useMemo, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  ArrowRight,
  ArrowsLeftRight,
  Bank,
  Check,
  CheckCircle,
  Copy,
  CreditCard,
  DeviceMobile,
  Info,
  Lightning,
  LinkSimple,
  Money,
  QrCode,
  Receipt,
  ShieldCheck,
  Sparkle,
  UsersThree,
  Wallet,
  WhatsappLogo,
} from '@phosphor-icons/react';
import { useLedger } from '../../state/LedgerContext';
import {
  computeCrossGroupFriendsSummary,
  computeGroupNetBalances,
  computeRawPairwiseTransfers,
  simplifyGroupDebts,
} from '../../domain/ledger/ledger-engine';
import {
  formatMinorToMajor,
  getCurrency,
  parseMajorToMinor,
} from '../../domain/money/currencies';
import {
  buildUpiPaymentUri,
  generateWhatsAppGroupSummary,
} from '../../portability/portability-engine';
import { SettlementItem } from '../../types/ledger';
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

export function FriendsAndSettlePage() {
  const {
    dataset,
    activeGroup,
    setActiveGroupId,
    recordSettlement,
    settleAllAcrossGroupsWithFriend,
    claimMemberAccount,
    showToast,
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
        dataset.fxRatesToInr
      ),
    [
      dataset.currentUser.email,
      dataset.groups,
      dataset.expenses,
      dataset.settlements,
      dataset.fxRatesToInr,
    ]
  );

  const crossGroupTotals = useMemo(() => {
    let owedToMeInrMinor = 0;
    let iOweInrMinor = 0;
    for (const f of friendsSummary) {
      if (f.netInInrMinor > 0) {
        owedToMeInrMinor += f.netInInrMinor;
      } else if (f.netInInrMinor < 0) {
        iOweInrMinor += Math.abs(f.netInInrMinor);
      }
    }
    return {
      owedToMeInrMinor,
      iOweInrMinor,
      netOverallInrMinor: owedToMeInrMinor - iOweInrMinor,
    };
  }, [friendsSummary]);

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
  const [customPayeeUpiId, setCustomPayeeUpiId] = useState<string>('');
  const [copiedUpi, setCopiedUpi] = useState<boolean>(false);
  const [copiedWhatsApp, setCopiedWhatsApp] = useState<boolean>(false);
  const [launchedUpiApp, setLaunchedUpiApp] = useState<string | null>(null);

  // Sync default payer/payee/amount whenever activeGroup changes or members change
  useEffect(() => {
    const firstTransfer = groupSuggestedTransfers[0];
    if (firstTransfer) {
      setFromMemberId(firstTransfer.fromMemberId);
      setToMemberId(firstTransfer.toMemberId);
      setAmountMajorInput(
        formatMinorToMajor(
          firstTransfer.amountMinor,
          activeGroup.baseCurrency,
          false
        ).replace(/,/g, '')
      );
      const payee = activeGroup.members.find(
        (m) => m.id === firstTransfer.toMemberId
      );
      setCustomPayeeUpiId(payee?.upiId ?? dataset.currentUser.upiId);
      setSettlementNotes(`${activeGroup.name} settlement`);
    } else {
      const m0 = activeGroup.members[0];
      const m1 = activeGroup.members[1] ?? activeGroup.members[0];
      setFromMemberId(m1?.id ?? '');
      setToMemberId(m0?.id ?? '');
      const scale = getCurrency(activeGroup.baseCurrency).decimals;
      const fallbackMinor = scale === 0 ? 1000 : scale === 3 ? 5000 : 50000;
      setAmountMajorInput(
        formatMinorToMajor(
          fallbackMinor,
          activeGroup.baseCurrency,
          false
        ).replace(/,/g, '')
      );
      setCustomPayeeUpiId(m0?.upiId ?? dataset.currentUser.upiId);
      setSettlementNotes(`${activeGroup.name} settlement`);
    }
  }, [activeGroup.id]);

  // Keep payee UPI ID synced when toMemberId changes
  useEffect(() => {
    const payee = activeGroup.members.find((m) => m.id === toMemberId);
    if (payee?.upiId) {
      setCustomPayeeUpiId(payee.upiId);
    }
  }, [toMemberId, activeGroup.members]);

  const fromMember = useMemo(
    () =>
      activeGroup.members.find((m) => m.id === fromMemberId) ??
      activeGroup.members[0],
    [activeGroup.members, fromMemberId]
  );

  const toMember = useMemo(
    () =>
      activeGroup.members.find((m) => m.id === toMemberId) ??
      activeGroup.members[1] ??
      activeGroup.members[0],
    [activeGroup.members, toMemberId]
  );

  const parsedAmountMinor = useMemo(() => {
    const val = parseMajorToMinor(amountMajorInput, activeGroup.baseCurrency);
    return val > 0 ? val : 0;
  }, [amountMajorInput, activeGroup.baseCurrency]);

  // Matching suggested transfer between fromMemberId and toMemberId (if any)
  const matchingSuggestedTransfer = useMemo(
    () =>
      groupSuggestedTransfers.find(
        (t) => t.fromMemberId === fromMemberId && t.toMemberId === toMemberId
      ) ?? groupSuggestedTransfers[0],
    [groupSuggestedTransfers, fromMemberId, toMemberId]
  );

  const effectivePayeeUpi =
    customPayeeUpiId.trim() ||
    toMember?.upiId ||
    dataset.currentUser.upiId ||
    'arjun.mehta@okicici';

  const effectiveUpiAmountMinor =
    parsedAmountMinor > 0
      ? parsedAmountMinor
      : matchingSuggestedTransfer?.amountMinor ?? 50000;

  const upiUri = useMemo(
    () =>
      buildUpiPaymentUri({
        payeeUpiId: effectivePayeeUpi,
        payeeName: toMember?.displayName ?? dataset.currentUser.fullName,
        amountMinor: effectiveUpiAmountMinor,
        currency: activeGroup.baseCurrency,
        note: settlementNotes.trim() || `${activeGroup.name} settlement`,
      }),
    [
      effectivePayeeUpi,
      toMember?.displayName,
      dataset.currentUser.fullName,
      effectiveUpiAmountMinor,
      activeGroup.baseCurrency,
      settlementNotes,
      activeGroup.name,
    ]
  );

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
        toUpiId: to?.upiId ?? null,
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
    setFromMemberId(fromId);
    setToMemberId(toId);
    setAmountMajorInput(
      formatMinorToMajor(partialMinor, activeGroup.baseCurrency, false).replace(
        /,/g,
        ''
      )
    );
    const payee = activeGroup.members.find((m) => m.id === toId);
    if (payee?.upiId) {
      setCustomPayeeUpiId(payee.upiId);
    }
    setSettlementNotes(
      fraction < 1
        ? `Partial (${Math.round(fraction * 100)}%) settlement - ${activeGroup.name}`
        : `Full settlement - ${activeGroup.name}`
    );
  };

  const handleLoadGroupBreakdownIntoStudio = (item: {
    groupId: string | null;
    myMemberId: string;
    friendMemberId: string;
    netMinor: number;
  }) => {
    if (!item.groupId) {
      showToast('Direct non-group split selected.');
      return;
    }
    const targetGrp = dataset.groups.find((g) => g.id === item.groupId);
    if (!targetGrp) return;
    setActiveGroupId(item.groupId);
    const fromId = item.netMinor > 0 ? item.friendMemberId : item.myMemberId;
    const toId = item.netMinor > 0 ? item.myMemberId : item.friendMemberId;
    const absMinor = Math.abs(item.netMinor);
    setTimeout(() => {
      setFromMemberId(fromId);
      setToMemberId(toId);
      setAmountMajorInput(
        formatMinorToMajor(absMinor, targetGrp.baseCurrency, false).replace(
          /,/g,
          ''
        )
      );
      const payee = targetGrp.members.find((m) => m.id === toId);
      if (payee?.upiId) {
        setCustomPayeeUpiId(payee.upiId);
      }
      setSettlementNotes(`${targetGrp.name} direct settlement`);
    }, 0);
  };

  const handleRecordSettlementSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!fromMember || !toMember) return;

    const finalFromId = fromMember.id;
    const finalToId =
      toMember.id === finalFromId
        ? activeGroup.members.find((m) => m.id !== finalFromId)?.id ??
          toMember.id
        : toMember.id;

    const finalAmountMinor =
      parsedAmountMinor > 0
        ? parsedAmountMinor
        : matchingSuggestedTransfer?.amountMinor ?? 50000;

    recordSettlement({
      groupId: activeGroup.id,
      fromMemberId: finalFromId,
      toMemberId: finalToId,
      amountMinor: finalAmountMinor,
      paymentMethod: selectedPaymentMethod,
      paymentReference:
        paymentReference.trim() ||
        (selectedPaymentMethod === 'upi'
          ? `UTR${Date.now().toString().slice(-8)}`
          : undefined),
      notes:
        settlementNotes.trim() ||
        `Settled via ${selectedPaymentMethod.toUpperCase()}`,
    });

    setPaymentReference('');
  };

  const handleCopyUpiUri = async () => {
    try {
      await navigator.clipboard.writeText(upiUri);
    } catch {
      // Clipboard API fallback ignored in headless environment
    }
    setCopiedUpi(true);
    showToast('Copied NPCI upi://pay deep-link URI to clipboard.');
    setTimeout(() => setCopiedUpi(false), 2200);
  };

  const handleLaunchUpiApp = (appName: string) => {
    setLaunchedUpiApp(appName);
    showToast(`Prepared ${appName} intent with NPCI deep-link: ${upiUri}`);
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
                Pairwise Group Isolation Active
              </StatusBadge>
              <StatusBadge tone="blue">
                <Lightning size={14} weight="duotone" />
                NPCI UPI Deep-Link + QR Ready
              </StatusBadge>
            </div>
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
              Friends Cross-Group Net Balances & Instant Settle Studio
            </h1>
            <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
              Offsetting balances with the same friend across shared groups net out transparently in INR without ever mixing strangers from different groups. Settle across all shared groups in 1 atomic batch or scan an NPCI UPI QR code.
            </p>
          </div>

          <div className="grid grid-cols-3 gap-3 sm:gap-4 shrink-0">
            <div className="rounded-xl bg-emerald-500/[0.07] dark:bg-emerald-500/[0.08] border border-emerald-500/20 px-3.5 py-2.5">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-emerald-700 dark:text-emerald-300">
                Friends Owe You
              </div>
              <div className="mt-1 text-base sm:text-lg font-bold">
                <CurrencyAmount
                  minorAmount={crossGroupTotals.owedToMeInrMinor}
                  currencyCode="INR"
                  colorize
                  showPlusSign
                />
              </div>
            </div>

            <div className="rounded-xl bg-rose-500/[0.07] dark:bg-rose-500/[0.08] border border-rose-500/20 px-3.5 py-2.5">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-rose-700 dark:text-rose-300">
                You Owe Friends
              </div>
              <div className="mt-1 text-base sm:text-lg font-bold">
                <CurrencyAmount
                  minorAmount={-crossGroupTotals.iOweInrMinor}
                  currencyCode="INR"
                  colorize
                />
              </div>
            </div>

            <div className="rounded-xl bg-slate-900/[0.04] dark:bg-white/[0.04] border border-slate-200/80 dark:border-white/10 px-3.5 py-2.5">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-400">
                Net Position (INR)
              </div>
              <div className="mt-1 text-base sm:text-lg font-bold">
                <CurrencyAmount
                  minorAmount={crossGroupTotals.netOverallInrMinor}
                  currencyCode="INR"
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
                  Per-friend aggregation across {activeGroups.length} active groups normalized to INR
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
                const hasMultipleGroups = friend.groupBreakdowns.length > 1;

                // Find if there is an unclaimed member entry in any group so user can also test claiming
                const unclaimedGroupMember = dataset.groups
                  .flatMap((g) => g.members)
                  .find(
                    (m) =>
                      (m.invitedEmail ?? m.displayName).toLowerCase() ===
                        friend.friendKey && m.userId === null
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
                                Google OAuth Verified
                              </StatusBadge>
                            ) : (
                              <StatusBadge tone="amber">
                                <Info size={12} weight="bold" />
                                Unclaimed Invite
                              </StatusBadge>
                            )}
                          </div>

                          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                            {friend.email && <span>{friend.email}</span>}
                            {friend.upiId && (
                              <span className="inline-flex items-center gap-1 rounded-md bg-slate-200/70 dark:bg-slate-800 px-2 py-0.5 font-mono text-[11px] text-slate-700 dark:text-slate-300">
                                <QrCode size={12} weight="duotone" />
                                {friend.upiId}
                              </span>
                            )}
                            {unclaimedGroupMember && (
                              <button
                                type="button"
                                onClick={() =>
                                  claimMemberAccount(
                                    unclaimedGroupMember.groupId,
                                    unclaimedGroupMember.id
                                  )
                                }
                                className="inline-flex items-center gap-1 rounded-md bg-amber-500/15 hover:bg-amber-500/25 text-amber-800 dark:text-amber-300 px-2 py-0.5 text-[11px] font-semibold transition-colors cursor-pointer"
                              >
                                <LinkSimple size={12} weight="bold" />
                                Simulate Google Sign-In Claim
                              </button>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Overall Net Balance in INR + 1-Tap Atomic Settle Up */}
                      <div className="flex flex-row sm:flex-col items-center sm:items-end justify-between gap-2 border-t sm:border-t-0 pt-3 sm:pt-0 border-slate-200/60 dark:border-white/[0.06]">
                        <div className="text-left sm:text-right">
                          <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">
                            {friend.netInInrMinor > 0
                              ? 'Owes you net (INR)'
                              : friend.netInInrMinor < 0
                              ? 'You owe net (INR)'
                              : 'Settled across all groups'}
                          </div>
                          <div className="text-lg sm:text-xl font-bold">
                            <CurrencyAmount
                              minorAmount={friend.netInInrMinor}
                              currencyCode="INR"
                              colorize
                              showPlusSign
                            />
                          </div>
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
                              key={gb.groupId}
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
                                    handleLoadGroupBreakdownIntoStudio(gb)
                                  }
                                  className="text-[11px] font-semibold text-sky-600 dark:text-sky-400 hover:underline cursor-pointer"
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
                    className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600 dark:text-emerald-400 hover:underline"
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
              <CurrencyPrecisionPill currencyCode={activeGroup.baseCurrency} />
            </div>

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

            {/* Settlement Form */}
            <form onSubmit={handleRecordSettlementSubmit} className="space-y-4">
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
                    onChange={(e) => setFromMemberId(e.target.value)}
                    className="w-full rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-300/80 dark:border-white/10 px-3 py-2 text-xs sm:text-sm font-medium text-slate-900 dark:text-white"
                  >
                    {activeGroup.members.map((m) => (
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
                    onChange={(e) => setToMemberId(e.target.value)}
                    className="w-full rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-300/80 dark:border-white/10 px-3 py-2 text-xs sm:text-sm font-medium text-slate-900 dark:text-white"
                  >
                    {activeGroup.members.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.displayName}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Editable Full or Partial Amount */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label
                    htmlFor="settle-amount-input"
                    className="text-xs font-semibold text-slate-700 dark:text-slate-300"
                  >
                    Settlement Amount ({activeGroup.baseCurrency}) - Full or Partial
                  </label>
                  {matchingSuggestedTransfer && (
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() =>
                          setAmountMajorInput(
                            formatMinorToMajor(
                              matchingSuggestedTransfer.amountMinor,
                              activeGroup.baseCurrency,
                              false
                            ).replace(/,/g, '')
                          )
                        }
                        className="text-[11px] font-semibold text-emerald-600 dark:text-emerald-400 hover:underline cursor-pointer"
                      >
                        Full (
                        {formatMinorToMajor(
                          matchingSuggestedTransfer.amountMinor,
                          activeGroup.baseCurrency
                        )}
                        )
                      </button>
                      <span className="text-slate-300 dark:text-slate-600">|</span>
                      <button
                        type="button"
                        onClick={() =>
                          setAmountMajorInput(
                            formatMinorToMajor(
                              Math.max(
                                1,
                                Math.round(
                                  matchingSuggestedTransfer.amountMinor / 2
                                )
                              ),
                              activeGroup.baseCurrency,
                              false
                            ).replace(/,/g, '')
                          )
                        }
                        className="text-[11px] font-semibold text-sky-600 dark:text-sky-400 hover:underline cursor-pointer"
                      >
                        50% Partial
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
                  className="w-full rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-300/80 dark:border-white/10 px-3.5 py-2.5 font-mono text-sm font-bold text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                />
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

              {/* Reference & Notes */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label
                    htmlFor="settle-ref-input"
                    className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1"
                  >
                    UPI UTR / Bank Reference
                  </label>
                  <input
                    id="settle-ref-input"
                    data-testid="settle-reference-input"
                    type="text"
                    value={paymentReference}
                    onChange={(e) => setPaymentReference(e.target.value)}
                    placeholder="e.g. UTR6329104482"
                    className="w-full rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-300/80 dark:border-white/10 px-3 py-2 text-xs font-mono text-slate-900 dark:text-white"
                  />
                </div>

                <div>
                  <label
                    htmlFor="settle-notes-input"
                    className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1"
                  >
                    Settlement Note
                  </label>
                  <input
                    id="settle-notes-input"
                    data-testid="settle-notes-input"
                    type="text"
                    value={settlementNotes}
                    onChange={(e) => setSettlementNotes(e.target.value)}
                    placeholder="Villa & scuba balance"
                    className="w-full rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-300/80 dark:border-white/10 px-3 py-2 text-xs text-slate-900 dark:text-white"
                  />
                </div>
              </div>

              <button
                type="submit"
                data-testid="record-settlement-submit-btn"
                className="w-full rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold py-2.5 px-4 text-xs sm:text-sm shadow-sm shadow-emerald-600/25 flex items-center justify-center gap-2 transition-all cursor-pointer"
              >
                <CheckCircle size={18} weight="fill" />
                Record Settlement ({fromMember?.displayName.split(' ')[0]} pays{' '}
                {toMember?.displayName.split(' ')[0]}{' '}
                {formatMinorToMajor(
                  effectiveUpiAmountMinor,
                  activeGroup.baseCurrency
                )}
                )
              </button>
            </form>

            {/* Live NPCI upi://pay Deep-Link & QR Code Generator */}
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
                    NPCI UPI Deep-Link & Scannable QR
                  </span>
                </div>
                <StatusBadge tone="emerald">upi://pay</StatusBadge>
              </div>

              <div className="flex flex-col sm:flex-row items-center gap-4">
                <div className="rounded-2xl bg-white p-3 border border-slate-200 shadow-sm shrink-0">
                  <QRCodeSVG
                    value={upiUri}
                    size={132}
                    level="M"
                    includeMargin={false}
                  />
                </div>

                <div className="flex-1 min-w-0 space-y-2.5 w-full">
                  <div>
                    <label
                      htmlFor="payee-upi-id-input"
                      className="block text-[11px] font-semibold text-slate-500 dark:text-slate-400 mb-1"
                    >
                      Payee VPA / UPI ID
                    </label>
                    <input
                      id="payee-upi-id-input"
                      type="text"
                      value={customPayeeUpiId}
                      onChange={(e) => setCustomPayeeUpiId(e.target.value)}
                      placeholder="name@okicici"
                      className="w-full rounded-lg bg-white dark:bg-slate-950 border border-slate-200 dark:border-white/10 px-2.5 py-1.5 font-mono text-xs text-slate-800 dark:text-slate-200"
                    />
                  </div>

                  <div>
                    <div className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 mb-1">
                      Generated NPCI URI
                    </div>
                    <div
                      data-testid="upi-uri-text"
                      className="rounded-lg bg-slate-900 text-emerald-300 font-mono text-[11px] p-2 break-all select-all border border-slate-800"
                    >
                      {upiUri}
                    </div>
                  </div>
                </div>
              </div>

              {/* 1-Tap UPI App Launchers + Copy URI */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => handleLaunchUpiApp('Google Pay')}
                  className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200/80 dark:border-white/10 py-2 px-2.5 text-xs font-semibold text-slate-800 dark:text-slate-200 transition-colors cursor-pointer"
                >
                  <DeviceMobile size={14} weight="duotone" />
                  GPay
                </button>
                <button
                  type="button"
                  onClick={() => handleLaunchUpiApp('PhonePe')}
                  className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200/80 dark:border-white/10 py-2 px-2.5 text-xs font-semibold text-slate-800 dark:text-slate-200 transition-colors cursor-pointer"
                >
                  <DeviceMobile size={14} weight="duotone" />
                  PhonePe
                </button>
                <button
                  type="button"
                  onClick={() => handleLaunchUpiApp('Paytm')}
                  className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200/80 dark:border-white/10 py-2 px-2.5 text-xs font-semibold text-slate-800 dark:text-slate-200 transition-colors cursor-pointer"
                >
                  <DeviceMobile size={14} weight="duotone" />
                  Paytm
                </button>
                <button
                  type="button"
                  data-testid="copy-upi-uri-btn"
                  onClick={handleCopyUpiUri}
                  className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-emerald-600/15 hover:bg-emerald-600/25 border border-emerald-500/30 py-2 px-2.5 text-xs font-semibold text-emerald-800 dark:text-emerald-300 transition-colors cursor-pointer"
                >
                  {copiedUpi ? (
                    <>
                      <Check size={14} weight="bold" />
                      Copied
                    </>
                  ) : (
                    <>
                      <Copy size={14} weight="duotone" />
                      Copy URI
                    </>
                  )}
                </button>
              </div>

              {launchedUpiApp && (
                <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/25 px-3 py-2 text-[11px] text-emerald-800 dark:text-emerald-300 flex items-center justify-between">
                  <span>
                    Ready to launch <strong>{launchedUpiApp}</strong> with{' '}
                    <code className="font-mono">{effectivePayeeUpi}</code>
                  </span>
                  <a
                    href={upiUri}
                    className="font-bold underline ml-2"
                  >
                    Open Deep-Link
                  </a>
                </div>
              )}
            </div>

            {/* Recent Recorded Settlements in Active Group */}
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
                <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                  {groupSettlements.map((stl) => {
                    const fromName =
                      activeGroup.members.find((m) => m.id === stl.fromMemberId)
                        ?.displayName ?? stl.fromMemberId;
                    const toName =
                      activeGroup.members.find((m) => m.id === stl.toMemberId)
                        ?.displayName ?? stl.toMemberId;
                    return (
                      <div
                        key={stl.id}
                        className="rounded-xl bg-slate-50 dark:bg-slate-900/60 border border-slate-200/70 dark:border-white/[0.06] px-3 py-2 flex items-center justify-between gap-2 text-xs"
                      >
                        <div className="min-w-0">
                          <div className="font-semibold text-slate-800 dark:text-slate-200 truncate">
                            {fromName} paid {toName}
                          </div>
                          <div className="text-[11px] text-slate-500 dark:text-slate-400 flex flex-wrap items-center gap-1.5 mt-0.5">
                            <span className="uppercase font-mono font-semibold text-emerald-600 dark:text-emerald-400">
                              {stl.paymentMethod}
                            </span>
                            <span>-</span>
                            <span>{stl.settledDate}</span>
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
                        </div>
                        <CurrencyAmount
                          minorAmount={stl.amountMinor}
                          currencyCode={stl.currency}
                          className="font-bold text-emerald-600 dark:text-emerald-400 shrink-0"
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </DoubleBezelCard>
        </div>
      </div>
    </div>
  );
}

export default FriendsAndSettlePage;
