import React, { useMemo } from 'react';
import {
  ArrowRightIcon as ArrowRight,
  CalculatorIcon as Calculator,
  CheckCircleIcon as CheckCircle,
  GitDiffIcon as GitDiff,
  ReceiptIcon as Receipt,
  ScalesIcon as Scales,
  XIcon as X,
} from '@phosphor-icons/react';
import { useLedger } from '../../state/LedgerContext';
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
                  <span>Full Arithmetic Audit Trail</span>
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
              className="rounded-xl p-2 text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-white/10 transition-colors"
              aria-label="Close explain balance modal"
            >
              <X className="w-5 h-5" weight="bold" />
            </button>
          </div>

          {/* Exact Arithmetic Equation Banner */}
          <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/[0.06] p-4 space-y-3">
            <div className="text-xs font-bold uppercase tracking-wider text-emerald-800 dark:text-emerald-300">
              Exact Ledger Identity: Total Paid - Total Share + Settlements Sent - Settlements Received = Net Balance
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5 text-xs">
              <div className="rounded-xl bg-white dark:bg-slate-900/90 p-2.5 border border-slate-200/70 dark:border-white/10">
                <div className="text-slate-500 dark:text-slate-400">Total Paid</div>
                <div className="mt-0.5 text-sm font-bold font-mono tabular-nums">
                  <CurrencyAmount
                    minorAmount={explanation.totalPaidMinor}
                    currencyCode={explanation.currency}
                  />
                </div>
              </div>
              <div className="rounded-xl bg-white dark:bg-slate-900/90 p-2.5 border border-slate-200/70 dark:border-white/10">
                <div className="text-slate-500 dark:text-slate-400">- Total Share</div>
                <div className="mt-0.5 text-sm font-bold font-mono tabular-nums">
                  <CurrencyAmount
                    minorAmount={explanation.totalShareMinor}
                    currencyCode={explanation.currency}
                  />
                </div>
              </div>
              <div className="rounded-xl bg-white dark:bg-slate-900/90 p-2.5 border border-slate-200/70 dark:border-white/10">
                <div className="text-slate-500 dark:text-slate-400">+ Settlements Sent</div>
                <div className="mt-0.5 text-sm font-bold font-mono tabular-nums">
                  <CurrencyAmount
                    minorAmount={explanation.settlementsSentMinor}
                    currencyCode={explanation.currency}
                  />
                </div>
              </div>
              <div className="rounded-xl bg-white dark:bg-slate-900/90 p-2.5 border border-slate-200/70 dark:border-white/10">
                <div className="text-slate-500 dark:text-slate-400">- Settlements Recv</div>
                <div className="mt-0.5 text-sm font-bold font-mono tabular-nums">
                  <CurrencyAmount
                    minorAmount={explanation.settlementsReceivedMinor}
                    currencyCode={explanation.currency}
                  />
                </div>
              </div>
              <div className="col-span-2 sm:col-span-1 rounded-xl bg-white dark:bg-slate-900/90 p-2.5 border border-emerald-500/40">
                <div className="text-slate-500 dark:text-slate-400">= Net Balance</div>
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
            <div className="font-mono tabular-nums text-xs text-slate-700 dark:text-slate-300 bg-white/80 dark:bg-slate-900/70 rounded-xl px-3 py-2 border border-slate-200/60 dark:border-white/5">
              {explanation.equationText}
            </div>
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

          {/* Simplified Mode vs Raw Pairwise Mode Repayment Routing Comparison */}
          <div className="space-y-2.5">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-600 dark:text-slate-300 flex items-center gap-1.5">
              <GitDiff className="w-4 h-4 text-[#059669]" weight="duotone" />
              <span>Repayment Routing: Simplified Mode vs Raw Pairwise Mode</span>
            </h3>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Simplified Minimum Transfers */}
              <div
                className={`rounded-2xl border p-3.5 space-y-2 ${
                  activeGroup.simplifyDebts
                    ? 'border-emerald-500/40 bg-emerald-500/[0.06]'
                    : 'border-slate-200 dark:border-white/10 bg-slate-50/60 dark:bg-slate-900/50'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-bold text-slate-900 dark:text-slate-100">
                    Simplified Mode (Bitmask-DP)
                  </span>
                  {activeGroup.simplifyDebts && (
                    <StatusBadge tone="emerald">Active in Group</StatusBadge>
                  )}
                </div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  Eliminates circular debt chains (A owes B owes C) to settle with the minimum number of transfers.
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

              {/* Raw Pairwise Mode */}
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
                    <span>Raw Pairwise Mode</span>
                  </span>
                  {!activeGroup.simplifyDebts && (
                    <StatusBadge tone="emerald">Active in Group</StatusBadge>
                  )}
                </div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  Preserves direct bilateral person-to-person balances without rerouting across third parties.
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
