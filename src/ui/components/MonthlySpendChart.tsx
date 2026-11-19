import { useMemo, useState } from 'react';
import { ChartBarIcon as ChartBar } from '@phosphor-icons/react';
import type { ExpenseItem } from '../../types/ledger';
import { formatMinorToMajor } from '../../domain/money/currencies';
import { inCurrency, monthlySpend } from '../../utils/expense-search';
import { CurrencyPrecisionPill, DoubleBezelCard, StatusBadge } from '../primitives/DesignPrimitives';

const MOBILE_MONTHS = 6;

function monthLabel(key: string, style: 'short' | 'long'): string {
  const d = new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, 1));
  return style === 'short'
    ? d.toLocaleString(undefined, { month: 'short', timeZone: 'UTC' })
    : d.toLocaleString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

export function MonthlySpendChart({
  expenses,
  currency,
  groupName,
  convert,
}: {
  expenses: ExpenseItem[];
  currency: string;
  groupName: string;
  convert?: (minor: bigint, from: string) => bigint | null;
}) {
  const rows = useMemo(() => monthlySpend(expenses, 12, currency, convert), [expenses, currency, convert]);
  const excluded = expenses.filter((e) => !e.deletedAt && inCurrency(e, currency, convert) === null);
  const [active, setActive] = useState<number | null>(null);
  const max = Math.max(1, ...rows.map((r) => r.totalMinor));
  const shown = rows[active ?? rows.length - 1];
  const readout = (r: (typeof rows)[number]) =>
    `${monthLabel(r.month, 'long')}: ${formatMinorToMajor(r.totalMinor, currency)} across ${r.count} ${r.count === 1 ? 'bill' : 'bills'}`;

  return (
    <DoubleBezelCard
      testId="analytics-monthly-chart"
      className="min-w-0"
      innerClassName="space-y-4 min-w-0"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 min-w-0">
        <div className="flex items-center gap-3 min-w-0">
          <span
            aria-hidden="true"
            className="lg-icon-orb h-9 w-9 rounded-full flex items-center justify-center shrink-0 text-[#2F8F6B] dark:text-[#6BC5A1]"
          >
            <ChartBar className="w-4 h-4" weight="duotone" />
          </span>
          <div className="min-w-0">
            <h2
              className="text-base sm:text-lg font-semibold tracking-tight text-[#141715] dark:text-[#F3F5F3] truncate"
              title={`Monthly spending in ${groupName}`}
            >
              Monthly spending in <span dir="auto">{groupName}</span>
            </h2>
            <p className="text-xs text-[#5C6660] dark:text-[#9CA69F] truncate">
              Trailing 12-month cadence normalized to {currency}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <CurrencyPrecisionPill currencyCode={currency} />
          {rows.length > 0 && (
            <StatusBadge tone="slate">
              {rows.length} {rows.length === 1 ? 'month' : 'months'}
            </StatusBadge>
          )}
        </div>
      </div>

      {excluded.length > 0 && (
        <p
          data-testid="monthly-chart-excluded"
          className="rounded-2xl bg-amber-500/12 dark:bg-amber-400/14 ring-1 ring-amber-600/25 dark:ring-amber-300/25 px-3.5 py-2 text-xs font-medium text-amber-900 dark:text-amber-200 break-words"
        >
          {excluded.length} {excluded.length === 1 ? 'bill' : 'bills'} in{' '}
          {[...new Set(excluded.map((e) => e.groupCurrency))].join(', ')} not shown: no exchange rate to {currency}.
        </p>
      )}

      {rows.length === 0 ? (
        <div className="lg-recessed-well rounded-2xl px-4 py-6 text-center">
          <p data-testid="monthly-chart-empty" className="text-xs font-medium text-[#5C6660] dark:text-[#9CA69F]">
            No bills yet. Months appear here once the group has spending.
          </p>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 min-w-0">
            <p
              data-testid="monthly-chart-readout"
              aria-live="polite"
              className="text-xs sm:text-sm font-semibold font-mono tabular-nums tracking-tight text-[#141715] dark:text-[#F3F5F3] break-words"
            >
              {shown && readout(shown)}
            </p>
          </div>

          <div className="lg-recessed-well rounded-[1.375rem] p-3.5 sm:p-4 space-y-1.5 min-w-0 overflow-hidden">
            <div className="flex items-center justify-between text-[10px] font-mono tabular-nums text-[#5C6660] dark:text-[#9CA69F] border-b border-dashed border-black/[0.09] dark:border-white/[0.11] pb-1">
              <span className="uppercase tracking-wider">Peak month</span>
              <span>{formatMinorToMajor(max, currency)}</span>
            </div>
            <div
              role="group"
              aria-label={`Monthly spending in ${groupName}, ${currency}`}
              className="flex items-end h-40 pt-2 border-b border-black/[0.10] dark:border-white/[0.14]"
              onMouseLeave={() => setActive(null)}
            >
              {rows.map((r, i) => {
                const pct = (r.totalMinor / max) * 100;
                const hiddenOnMobile = i < rows.length - MOBILE_MONTHS;
                const isSelected = active === i;
                const isDimmed = active !== null && active !== i;
                return (
                  <button
                    key={r.month}
                    type="button"
                    data-testid={`monthly-bar-${r.month}`}
                    aria-label={readout(r)}
                    onMouseEnter={() => setActive(i)}
                    onFocus={() => setActive(i)}
                    onBlur={() => setActive(null)}
                    className={`${hiddenOnMobile ? 'hidden sm:flex' : 'flex'} flex-1 min-w-[44px] sm:min-w-0 h-full items-end justify-center px-0.5 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 rounded-t-lg`}
                  >
                    <span
                      className={`block w-full max-w-[26px] rounded-t-[7px] transition-[opacity,background-color,box-shadow] duration-200 ${
                        isSelected
                          ? 'bg-gradient-to-t from-[#247354] via-[#2F8F6B] to-[#63C19D] dark:from-[#2C8664] dark:via-[#3FA47E] dark:to-[#7ED3B2] shadow-[inset_0_1px_0_rgba(255,255,255,0.52),0_6px_16px_-4px_rgba(47,143,107,0.45)]'
                          : 'bg-gradient-to-t from-[#2D7F60] via-[#3A9874] to-[#5BB391] dark:from-[#276F54] dark:via-[#368F6D] dark:to-[#5DB694] shadow-[inset_0_1px_0_rgba(255,255,255,0.34)]'
                      } ${isDimmed ? 'opacity-40' : 'opacity-95'}`}
                      style={{ height: r.totalMinor > 0 ? `max(3px, ${pct}%)` : '0' }}
                    />
                  </button>
                );
              })}
            </div>
            <div className="flex pt-0.5" aria-hidden="true">
              {rows.map((r, i) => (
                <span
                  key={r.month}
                  className={`${i < rows.length - MOBILE_MONTHS ? 'hidden sm:block' : 'block'} flex-1 min-w-[44px] sm:min-w-0 pt-1 text-center text-[10px] font-mono tracking-tight ${
                    active === i
                      ? 'font-semibold text-[#141715] dark:text-[#F3F5F3]'
                      : 'text-[#5C6660] dark:text-[#9CA69F]'
                  }`}
                >
                  {monthLabel(r.month, 'short')}
                </span>
              ))}
            </div>
          </div>

          <details className="ws-disclosure group">
            <summary className="min-h-[44px] inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs font-semibold text-[#141715] dark:text-[#F3F5F3] lg-scene-tile focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60">
              <span>Show as a table</span>
            </summary>
            <div className="mt-3 overflow-x-auto lg-recessed-well rounded-2xl p-2.5 sm:p-3.5">
              <table data-testid="monthly-chart-table" className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="border-b border-black/[0.08] dark:border-white/[0.09] text-[11px] font-mono uppercase tracking-wider text-[#5C6660] dark:text-[#9CA69F]">
                    <th className="py-2 px-2">Month</th>
                    <th className="py-2 px-2 text-right">Bills</th>
                    <th className="py-2 px-2 text-right">Spent</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-black/[0.06] dark:divide-white/[0.06] text-[#141715] dark:text-[#F3F5F3]">
                  {rows.map((r) => (
                    <tr key={r.month} className="hover:bg-black/[0.025] dark:hover:bg-white/[0.03] transition-colors">
                      <td className="py-2 px-2 font-medium">{monthLabel(r.month, 'long')}</td>
                      <td className="py-2 px-2 text-right font-mono tabular-nums text-[#4A524D] dark:text-[#B7BEB9]">
                        {r.count}
                      </td>
                      <td className="py-2 px-2 text-right font-mono tabular-nums font-semibold">
                        {formatMinorToMajor(r.totalMinor, currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </DoubleBezelCard>
  );
}
