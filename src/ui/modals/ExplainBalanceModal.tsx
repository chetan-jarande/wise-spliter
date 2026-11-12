import React, { useMemo } from 'react';
import {
  ArrowRightIcon as ArrowRight,
  CalculatorIcon as Calculator,
  CaretDownIcon as CaretDown,
  CheckCircleIcon as CheckCircle,
  GitDiffIcon as GitDiff,
  ReceiptIcon as Receipt,
  ScalesIcon as Scales,
  SparkleIcon as Sparkle,
  XIcon as X,
} from '@phosphor-icons/react';
import { useLedger } from '../../state/LedgerContext';
import { formatMinorToMajor } from '../../domain/money/currencies';
import {
  computeGroupNetBalances,
  computeRawPairwiseTransfers,
  explainMemberBalance,
  simplifyGroupDebts,
} from '../../domain/ledger/ledger-engine';
import {
  CurrencyAmount,
  CurrencyPrecisionPill,
  DoubleBezelCard,
  StatusBadge,
} from '../primitives/DesignPrimitives';

export function ExplainBalanceModal({
  memberId,
  onClose,
}: {
  memberId: string | null;
  onClose: () => void;
}) {
  const { dataset, activeGroup } = useLedger();

  const groupExpenses = useMemo(
    () => dataset.expenses.filter((e) => e.groupId === activeGroup.id && !e.deletedAt),
    [dataset.expenses, activeGroup.id]
  );

  const groupSettlements = useMemo(
    () => dataset.settlements.filter((s) => s.groupId === activeGroup.id && !s.deletedAt),
    [dataset.settlements, activeGroup.id]
  );

  const explanation = useMemo(() => {
    if (!memberId) return null;
    return explainMemberBalance(memberId, activeGroup, groupExpenses, groupSettlements);
  }, [memberId, activeGroup, groupExpenses, groupSettlements]);

  const routingComparison = useMemo(() => {
    if (!memberId) return { simplified: [], rawPairwise: [] };
    const netMap = computeGroupNetBalances(groupExpenses, groupSettlements, activeGroup.members);
    const allSimplified = simplifyGroupDebts(
      netMap,
      activeGroup.members,
      activeGroup.baseCurrency
    );
    const allRaw = computeRawPairwiseTransfers(
      groupExpenses,
      groupSettlements,
      activeGroup.members,
      activeGroup.baseCurrency
    );
    return {
      simplified: allSimplified.filter(
        (t) => t.fromMemberId === memberId || t.toMemberId === memberId
      ),
      rawPairwise: allRaw.filter(
        (t) => t.fromMemberId === memberId || t.toMemberId === memberId
      ),
    };
  }, [memberId, groupExpenses, groupSettlements, activeGroup]);

  if (!memberId || !explanation) return null;

  const memberNameOf = (id: string) =>
    activeGroup.members.find((m) => m.id === id)?.displayName ?? id;

  return (
    <div
      data-testid="explain-balance-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-3 sm:p-6 overflow-y-auto"
    >
      <div className="w-full max-w-3xl my-auto">
        <DoubleBezelCard
          className="shadow-2xl"
          innerClassName="max-h-[90vh] overflow-y-auto space-y-5 bg-white dark:bg-[#111827] text-slate-900 dark:text-slate-100"
        >
          {/* Header */}
          <div className="flex items-start justify-between gap-4 border-b border-slate-200/80 dark:border-white/10 pb-4">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge tone="emerald">
                  <Calculator className="w-3.5 h-3.5" weight="duotone" />
                  <span>Step-by-Step Balance Breakdown</span>
                </StatusBadge>
                <CurrencyPrecisionPill currencyCode={explanation.currency} />
              </div>
              <h2 className="mt-1.5 text-lg sm:text-xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
                Why is {explanation.memberName}&apos;s net balance{' '}
                <CurrencyAmount
                  minorAmount={explanation.netBalanceMinor}
                  currencyCode={explanation.currency}
                  colorize
                  showPlusSign
                />
                ?
              </h2>
            </div>
            <button
              type="button"
              data-testid="close-explain-modal-btn"
              onClick={onClose}
              className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-xl p-2 text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/10 transition-colors cursor-pointer"
              aria-label="Close explain balance modal"
            >
              <X className="w-5 h-5" weight="bold" />
            </button>
          </div>

          {/* Plain-English Verdict Summary */}
          <div
            data-testid="explain-plain-english-verdict"
            className={`rounded-2xl border p-4 flex items-start gap-3 ${
              explanation.netBalanceMinor > 0
                ? 'border-emerald-500/35 bg-emerald-500/[0.08]'
                : explanation.netBalanceMinor < 0
                ? 'border-rose-500/35 bg-rose-500/[0.08]'
                : 'border-slate-200 dark:border-white/10 bg-slate-50 dark:bg-slate-900/70'
            }`}
          >
            <Sparkle
              className={`w-5 h-5 shrink-0 mt-0.5 ${
                explanation.netBalanceMinor > 0
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : explanation.netBalanceMinor < 0
                  ? 'text-rose-600 dark:text-rose-400'
                  : 'text-slate-500'
              }`}
              weight="fill"
            />
            <div className="space-y-1 text-xs sm:text-sm text-slate-700 dark:text-slate-200 leading-relaxed">
              {explanation.netBalanceMinor > 0 ? (
                <p>
                  <strong className="text-slate-900 dark:text-white">
                    {explanation.memberName} gets back{' '}
                    {formatMinorToMajor(explanation.netBalanceMinor, explanation.currency)}
                  </strong>{' '}
                  because they paid{' '}
                  <strong className="font-mono">
                    {formatMinorToMajor(explanation.totalPaidMinor, explanation.currency)}
                  </strong>{' '}
                  toward group bills while their personal share was{' '}
                  <strong className="font-mono">
                    {formatMinorToMajor(explanation.totalShareMinor, explanation.currency)}
                  </strong>
                  {explanation.settlementsSentMinor > 0 || explanation.settlementsReceivedMinor > 0
                    ? ' (adjusted for settlements recorded below).'
                    : '.'}
                </p>
              ) : explanation.netBalanceMinor < 0 ? (
                <p>
                  <strong className="text-slate-900 dark:text-white">
                    {explanation.memberName} owes{' '}
                    {formatMinorToMajor(
                      Math.abs(explanation.netBalanceMinor),
                      explanation.currency
                    )}
                  </strong>{' '}
                  because their personal share of group bills was{' '}
                  <strong className="font-mono">
                    {formatMinorToMajor(explanation.totalShareMinor, explanation.currency)}
                  </strong>{' '}
                  while they paid{' '}
                  <strong className="font-mono">
                    {formatMinorToMajor(explanation.totalPaidMinor, explanation.currency)}
                  </strong>
                  {explanation.settlementsSentMinor > 0 || explanation.settlementsReceivedMinor > 0
                    ? ' (adjusted for settlements recorded below).'
                    : '.'}
                </p>
              ) : (
                <p>
                  <strong className="text-slate-900 dark:text-white">
                    {explanation.memberName} is completely settled up (0.00)!
                  </strong>{' '}
                  Everything they paid and owed in this group balances out to zero.
                </p>
              )}
            </div>
          </div>

          {/* Exact Arithmetic Equation Banner */}
          <div className="rounded-2xl border border-slate-200 dark:border-white/10 bg-slate-50/80 dark:bg-slate-900/60 p-4 space-y-3">
            <div className="text-[11px] font-bold uppercase tracking-wider text-slate-600 dark:text-slate-300">
              Exact Ledger Identity: Total Paid - Total Share + Settlements Sent - Settlements Received = Net Balance
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5 text-xs">
              <div className="rounded-xl bg-white dark:bg-slate-900/90 p-2.5 border border-slate-200/70 dark:border-white/10">
                <div className="text-slate-500 dark:text-slate-400">Paid for Bills</div>
                <div className="mt-0.5 text-sm font-bold font-mono tabular-nums">
                  <CurrencyAmount
                    minorAmount={explanation.totalPaidMinor}
                    currencyCode={explanation.currency}
                  />
                </div>
              </div>
              <div className="rounded-xl bg-white dark:bg-slate-900/90 p-2.5 border border-slate-200/70 dark:border-white/10">
                <div className="text-slate-500 dark:text-slate-400">- Own Share</div>
                <div className="mt-0.5 text-sm font-bold font-mono tabular-nums">
                  <CurrencyAmount
                    minorAmount={explanation.totalShareMinor}
                    currencyCode={explanation.currency}
                  />
                </div>
              </div>
              <div className="rounded-xl bg-white dark:bg-slate-900/90 p-2.5 border border-slate-200/70 dark:border-white/10">
                <div className="text-slate-500 dark:text-slate-400">+ Paid Back</div>
                <div className="mt-0.5 text-sm font-bold font-mono tabular-nums">
                  <CurrencyAmount
                    minorAmount={explanation.settlementsSentMinor}
                    currencyCode={explanation.currency}
                  />
                </div>
              </div>
              <div className="rounded-xl bg-white dark:bg-slate-900/90 p-2.5 border border-slate-200/70 dark:border-white/10">
                <div className="text-slate-500 dark:text-slate-400">- Received Back</div>
                <div className="mt-0.5 text-sm font-bold font-mono tabular-nums">
                  <CurrencyAmount
                    minorAmount={explanation.settlementsReceivedMinor}
                    currencyCode={explanation.currency}
                  />
                </div>
              </div>
              <div className="col-span-2 sm:col-span-1 rounded-xl bg-white dark:bg-slate-900/90 p-2.5 border border-emerald-500/40">
                <div className="text-slate-500 dark:text-slate-400">= Net Standing</div>
                <div className="mt-0.5 text-sm font-bold font-mono tabular-nums">
                  <CurrencyAmount
                    minorAmount={explanation.netBalanceMinor}
                    currencyCode={explanation.currency}
                    colorize
                    showPlusSign
                  />
                </div>
              </div>
            </div>

            <details
              data-testid="explain-technical-details"
              className="ws-disclosure rounded-xl bg-white/80 dark:bg-slate-900/70 border border-slate-200/60 dark:border-white/5 px-3 py-2"
            >
              <summary className="flex items-center justify-between text-[11px] font-semibold text-slate-600 dark:text-slate-400">
                <span>Technical / Audit Equation</span>
                <CaretDown className="w-3.5 h-3.5" weight="bold" />
              </summary>
              <div className="mt-2 pt-2 border-t border-slate-200/60 dark:border-white/10 font-mono tabular-nums text-xs text-slate-700 dark:text-slate-300">
                {explanation.equationText}
              </div>
            </details>
          </div>

          {/* Itemized Contributing Bills & Settlements */}
          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-600 dark:text-slate-300 flex items-center gap-1.5">
                <Receipt className="w-4 h-4 text-[#059669]" weight="duotone" />
                <span>Itemized Contributing Entries ({explanation.contributingItems.length})</span>
              </h3>
            </div>

            {explanation.contributingItems.length === 0 ? (
              <div className="rounded-xl border border-slate-200 dark:border-white/10 p-4 text-xs text-slate-500">
                No active bills or settlements involve {explanation.memberName} yet.
              </div>
            ) : (
              <div className="space-y-2">
                {explanation.contributingItems.map((item) => (
                  <div
                    key={item.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200/80 dark:border-white/10 bg-slate-50/70 dark:bg-slate-900/60 px-3.5 py-2.5"
                  >
                    <div className="space-y-0.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                          {item.title}
                        </span>
                        <StatusBadge tone={item.type === 'settlement' ? 'blue' : 'slate'}>
                          {item.splitBadge}
                        </StatusBadge>
                      </div>
                      <div className="text-xs font-mono text-slate-500 dark:text-slate-400">
                        {item.date} | Paid:{' '}
                        <CurrencyAmount
                          minorAmount={item.paidMinor}
                          currencyCode={explanation.currency}
                        />{' '}
                        | Share:{' '}
                        <CurrencyAmount
                          minorAmount={item.owedMinor}
                          currencyCode={explanation.currency}
                        />
                      </div>
                    </div>

                    <div className="text-right">
                      <div className="text-xs text-slate-400">Net Impact</div>
                      <div className="text-sm font-bold font-mono tabular-nums">
                        <CurrencyAmount
                          minorAmount={item.netDeltaMinor}
                          currencyCode={explanation.currency}
                          colorize
                          showPlusSign
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Simplified Mode vs Direct Person-to-Person Mode Comparison */}
          <div className="space-y-2.5">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-600 dark:text-slate-300 flex items-center gap-1.5">
              <GitDiff className="w-4 h-4 text-[#059669]" weight="duotone" />
              <span>How to Settle: Smart Minimum Payments vs Direct Person-to-Person</span>
            </h3>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Smart Minimum Payments */}
              <div
                className={`rounded-2xl border p-3.5 space-y-2 ${
                  activeGroup.simplifyDebts
                    ? 'border-emerald-500/40 bg-emerald-500/[0.06]'
                    : 'border-slate-200 dark:border-white/10 bg-slate-50/60 dark:bg-slate-900/50'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-bold text-slate-900 dark:text-slate-100">
                    Smart Minimum Payments
                  </span>
                  {activeGroup.simplifyDebts && (
                    <StatusBadge tone="emerald">Active in Group</StatusBadge>
                  )}
                </div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  Combines circular debts (A owes B, B owes C) so everyone settles with the fewest total payments.
                </p>
                {routingComparison.simplified.length === 0 ? (
                  <div className="text-xs font-mono text-emerald-600 dark:text-emerald-400">
                    All settled - 0 transfers required.
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {routingComparison.simplified.map((t, idx) => (
                      <div
                        key={idx}
                        className="flex items-center justify-between rounded-lg bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs border border-slate-200/70 dark:border-white/10"
                      >
                        <span className="inline-flex items-center gap-1 font-medium">
                          <span>{memberNameOf(t.fromMemberId)}</span>
                          <ArrowRight className="w-3 h-3 text-slate-400" />
                          <span>{memberNameOf(t.toMemberId)}</span>
                        </span>
                        <CurrencyAmount
                          minorAmount={t.amountMinor}
                          currencyCode={explanation.currency}
                          className="font-bold"
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Direct Person-to-Person Mode */}
              <div
                className={`rounded-2xl border p-3.5 space-y-2 ${
                  !activeGroup.simplifyDebts
                    ? 'border-emerald-500/40 bg-emerald-500/[0.06]'
                    : 'border-slate-200 dark:border-white/10 bg-slate-50/60 dark:bg-slate-900/50'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-bold text-slate-900 dark:text-slate-100 flex items-center gap-1">
                    <Scales className="w-3.5 h-3.5" />
                    <span>Direct Person-to-Person</span>
                  </span>
                  {!activeGroup.simplifyDebts && (
                    <StatusBadge tone="emerald">Active in Group</StatusBadge>
                  )}
                </div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  Shows exact 1-on-1 debts between pairs of friends without combining across third parties.
                </p>
                {routingComparison.rawPairwise.length === 0 ? (
                  <div className="text-xs font-mono text-emerald-600 dark:text-emerald-400">
                    No direct bilateral debts remaining.
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {routingComparison.rawPairwise.map((t, idx) => (
                      <div
                        key={idx}
                        className="flex items-center justify-between rounded-lg bg-white dark:bg-slate-900 px-2.5 py-1.5 text-xs border border-slate-200/70 dark:border-white/10"
                      >
                        <span className="inline-flex items-center gap-1 font-medium">
                          <span>{memberNameOf(t.fromMemberId)}</span>
                          <ArrowRight className="w-3 h-3 text-slate-400" />
                          <span>{memberNameOf(t.toMemberId)}</span>
                        </span>
                        <CurrencyAmount
                          minorAmount={t.amountMinor}
                          currencyCode={explanation.currency}
                          className="font-bold"
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="flex justify-end pt-2 border-t border-slate-200/80 dark:border-white/10">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center gap-1.5 rounded-xl bg-[#059669] hover:bg-emerald-600 px-4 py-2 text-xs font-bold text-white transition-colors"
            >
              <CheckCircle className="w-4 h-4" weight="bold" />
              <span>Got It</span>
            </button>
          </div>
        </DoubleBezelCard>
      </div>
    </div>
  );
}
