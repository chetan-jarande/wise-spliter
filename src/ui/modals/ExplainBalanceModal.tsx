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
      className="fixed inset-0 z-50 flex items-center justify-center lg-modal-scrim p-3 sm:p-6 overflow-y-auto"
    >
      <div className="w-full max-w-3xl my-auto lg-modal-surface rounded-[30px] p-5 sm:p-7 max-h-[90vh] overflow-y-auto space-y-5 text-[#141715] dark:text-[#F3F5F3]">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-black/[0.07] dark:border-white/[0.10] pb-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge tone="emerald">
                <Calculator className="w-3.5 h-3.5" weight="duotone" />
                <span>Step-by-Step Balance Breakdown</span>
              </StatusBadge>
              <CurrencyPrecisionPill currencyCode={explanation.currency} />
            </div>
            <h2 className="mt-2 text-lg sm:text-xl font-bold tracking-tight text-[#141715] dark:text-[#F3F5F3]">
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
            className="lg-icon-orb min-h-[44px] min-w-[44px] h-11 w-11 flex items-center justify-center rounded-full text-[#4A524D] hover:text-[#141715] dark:text-[#B7BEB9] dark:hover:text-white transition-colors shrink-0 cursor-pointer"
            aria-label="Close explain balance modal"
          >
            <X className="w-4 h-4" weight="bold" />
          </button>
        </div>

        {/* Plain-English Verdict Summary */}
        <div
          data-testid="explain-plain-english-verdict"
          className={`rounded-[22px] border p-4 flex items-start gap-3 ${
            explanation.netBalanceMinor > 0
              ? 'border-emerald-600/30 dark:border-emerald-300/25 bg-emerald-500/[0.08] dark:bg-emerald-400/[0.09]'
              : explanation.netBalanceMinor < 0
              ? 'border-rose-600/30 dark:border-rose-300/25 bg-rose-500/[0.08] dark:bg-rose-400/[0.09]'
              : 'lg-recessed-well'
          }`}
        >
          <Sparkle
            className={`w-5 h-5 shrink-0 mt-0.5 ${
              explanation.netBalanceMinor > 0
                ? 'text-emerald-700 dark:text-emerald-300'
                : explanation.netBalanceMinor < 0
                ? 'text-rose-700 dark:text-rose-300'
                : 'text-[#5C6660] dark:text-[#9CA69F]'
            }`}
            weight="fill"
          />
          <div className="space-y-1 text-xs sm:text-sm text-[#2B312D] dark:text-[#DCE2DD] leading-relaxed">
            {explanation.netBalanceMinor > 0 ? (
              <p>
                <strong className="text-[#141715] dark:text-white">
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
                <strong className="text-[#141715] dark:text-white">
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
                <strong className="text-[#141715] dark:text-white">
                  {explanation.memberName} is completely settled up (0.00)!
                </strong>{' '}
                Everything they paid and owed in this group balances out to zero.
              </p>
            )}
          </div>
        </div>

        {/* Exact Arithmetic Equation Banner */}
        <div className="lg-recessed-well rounded-[24px] p-4 space-y-3">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-[#4A524D] dark:text-[#B7BEB9]">
            Exact Ledger Identity: Total Paid - Total Share + Settlements Sent - Settlements Received = Net Balance
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5 text-xs">
            <div className="lg-scene-tile rounded-[16px] p-2.5">
              <div className="text-[#5C6660] dark:text-[#9CA69F]">Paid for Bills</div>
              <div className="mt-0.5 text-sm font-bold font-mono tabular-nums">
                <CurrencyAmount
                  minorAmount={explanation.totalPaidMinor}
                  currencyCode={explanation.currency}
                />
              </div>
            </div>
            <div className="lg-scene-tile rounded-[16px] p-2.5">
              <div className="text-[#5C6660] dark:text-[#9CA69F]">- Own Share</div>
              <div className="mt-0.5 text-sm font-bold font-mono tabular-nums">
                <CurrencyAmount
                  minorAmount={explanation.totalShareMinor}
                  currencyCode={explanation.currency}
                />
              </div>
            </div>
            <div className="lg-scene-tile rounded-[16px] p-2.5">
              <div className="text-[#5C6660] dark:text-[#9CA69F]">+ Paid Back</div>
              <div className="mt-0.5 text-sm font-bold font-mono tabular-nums">
                <CurrencyAmount
                  minorAmount={explanation.settlementsSentMinor}
                  currencyCode={explanation.currency}
                />
              </div>
            </div>
            <div className="lg-scene-tile rounded-[16px] p-2.5">
              <div className="text-[#5C6660] dark:text-[#9CA69F]">- Received Back</div>
              <div className="mt-0.5 text-sm font-bold font-mono tabular-nums">
                <CurrencyAmount
                  minorAmount={explanation.settlementsReceivedMinor}
                  currencyCode={explanation.currency}
                />
              </div>
            </div>
            <div className="col-span-2 sm:col-span-1 lg-scene-tile rounded-[16px] p-2.5 ring-1 ring-emerald-600/35 dark:ring-emerald-300/30">
              <div className="text-[#5C6660] dark:text-[#9CA69F]">= Net Standing</div>
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
            className="ws-disclosure lg-scene-tile rounded-[14px] px-3.5 py-2"
          >
            <summary className="flex items-center justify-between text-[11px] font-semibold text-[#4A524D] dark:text-[#B7BEB9]">
              <span>Technical / Audit Equation</span>
              <CaretDown className="w-3.5 h-3.5" weight="bold" />
            </summary>
            <div className="mt-2 pt-2 border-t border-black/[0.07] dark:border-white/[0.09] font-mono tabular-nums text-xs text-[#2B312D] dark:text-[#DCE2DD]">
              {explanation.equationText}
            </div>
          </details>
        </div>

        {/* Itemized Contributing Bills & Settlements */}
        <div className="space-y-2.5">
          <div className="flex items-center justify-between">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#4A524D] dark:text-[#B7BEB9] flex items-center gap-1.5">
              <Receipt className="w-4 h-4 text-emerald-700 dark:text-emerald-300" weight="duotone" />
              <span>Itemized Contributing Entries ({explanation.contributingItems.length})</span>
            </h3>
          </div>

          {explanation.contributingItems.length === 0 ? (
            <div className="lg-recessed-well rounded-[18px] p-4 text-xs text-[#5C6660] dark:text-[#9CA69F]">
              No active bills or settlements involve {explanation.memberName} yet.
            </div>
          ) : (
            <div className="space-y-2">
              {explanation.contributingItems.map((item) => (
                <div
                  key={item.id}
                  className="lg-scene-tile flex flex-wrap items-center justify-between gap-3 rounded-[18px] px-4 py-3"
                >
                  <div className="space-y-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold text-[#141715] dark:text-[#F3F5F3]">
                        {item.title}
                      </span>
                      <StatusBadge tone={item.type === 'settlement' ? 'blue' : 'slate'}>
                        {item.splitBadge}
                      </StatusBadge>
                    </div>
                    <div className="text-xs font-mono text-[#5C6660] dark:text-[#9CA69F]">
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
                    <div className="text-[11px] text-[#68726C] dark:text-[#8A938D]">Net Impact</div>
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
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[#4A524D] dark:text-[#B7BEB9] flex items-center gap-1.5">
            <GitDiff className="w-4 h-4 text-emerald-700 dark:text-emerald-300" weight="duotone" />
            <span>How to Settle: Smart Minimum Payments vs Direct Person-to-Person</span>
          </h3>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* Smart Minimum Payments */}
            <div
              className={`rounded-[20px] p-4 space-y-2.5 ${
                activeGroup.simplifyDebts
                  ? 'border border-emerald-600/30 dark:border-emerald-300/30 bg-emerald-500/[0.07] dark:bg-emerald-400/[0.08]'
                  : 'lg-recessed-well'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-bold text-[#141715] dark:text-[#F3F5F3]">
                  Smart Minimum Payments
                </span>
                {activeGroup.simplifyDebts && (
                  <StatusBadge tone="emerald">Active in Group</StatusBadge>
                )}
              </div>
              <p className="text-[11px] text-[#5C6660] dark:text-[#9CA69F]">
                Combines circular debts (A owes B, B owes C) so everyone settles with the fewest total payments.
              </p>
              {routingComparison.simplified.length === 0 ? (
                <div className="text-xs font-mono text-emerald-700 dark:text-emerald-300">
                  All settled - 0 transfers required.
                </div>
              ) : (
                <div className="space-y-1.5">
                  {routingComparison.simplified.map((t, idx) => (
                    <div
                      key={idx}
                      className="lg-scene-tile flex items-center justify-between rounded-[12px] px-3 py-1.5 text-xs"
                    >
                      <span className="inline-flex items-center gap-1.5 font-medium text-[#141715] dark:text-[#F3F5F3]">
                        <span>{memberNameOf(t.fromMemberId)}</span>
                        <ArrowRight className="w-3 h-3 text-[#68726C] dark:text-[#8A938D]" />
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
              className={`rounded-[20px] p-4 space-y-2.5 ${
                !activeGroup.simplifyDebts
                  ? 'border border-emerald-600/30 dark:border-emerald-300/30 bg-emerald-500/[0.07] dark:bg-emerald-400/[0.08]'
                  : 'lg-recessed-well'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-bold text-[#141715] dark:text-[#F3F5F3] flex items-center gap-1">
                  <Scales className="w-3.5 h-3.5" />
                  <span>Direct Person-to-Person</span>
                </span>
                {!activeGroup.simplifyDebts && (
                  <StatusBadge tone="emerald">Active in Group</StatusBadge>
                )}
              </div>
              <p className="text-[11px] text-[#5C6660] dark:text-[#9CA69F]">
                Shows exact 1-on-1 debts between pairs of friends without combining across third parties.
              </p>
              {routingComparison.rawPairwise.length === 0 ? (
                <div className="text-xs font-mono text-emerald-700 dark:text-emerald-300">
                  No direct bilateral debts remaining.
                </div>
              ) : (
                <div className="space-y-1.5">
                  {routingComparison.rawPairwise.map((t, idx) => (
                    <div
                      key={idx}
                      className="lg-scene-tile flex items-center justify-between rounded-[12px] px-3 py-1.5 text-xs"
                    >
                      <span className="inline-flex items-center gap-1.5 font-medium text-[#141715] dark:text-[#F3F5F3]">
                        <span>{memberNameOf(t.fromMemberId)}</span>
                        <ArrowRight className="w-3 h-3 text-[#68726C] dark:text-[#8A938D]" />
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
        <div className="flex justify-end pt-2 border-t border-black/[0.07] dark:border-white/[0.10]">
          <button
            type="button"
            onClick={onClose}
            className="lg-luminous-pill min-h-[44px] inline-flex items-center gap-1.5 rounded-full px-5 py-2.5 text-xs font-semibold cursor-pointer"
          >
            <CheckCircle className="w-4 h-4" weight="bold" />
            <span>Got It</span>
          </button>
        </div>
      </div>
    </div>
  );
}
