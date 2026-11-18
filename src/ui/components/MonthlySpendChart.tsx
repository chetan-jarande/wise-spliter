import { useMemo, useState } from 'react';
import { ChartBarIcon as ChartBar } from '@phosphor-icons/react';
import type { ExpenseItem } from '../../types/ledger';
import { formatMinorToMajor } from '../../domain/money/currencies';
import { inCurrency, monthlySpend } from '../../utils/expense-search';
import { DoubleBezelCard } from '../primitives/DesignPrimitives';

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
    <DoubleBezelCard testId="analytics-monthly-chart" innerClassName="space-y-4">
      <div className="flex items-center gap-2 min-w-0">
        <ChartBar className="w-5 h-5 shrink-0 text-emerald-600 dark:text-emerald-400" weight="duotone" />
        <h2 className="text-lg font-bold text-slate-900 dark:text-white truncate" title={`Monthly spending in ${groupName}`}>
          Monthly spending in <span dir="auto">{groupName}</span>
        </h2>
      </div>

      {excluded.length > 0 && (
        <p data-testid="monthly-chart-excluded" className="text-[11px] text-amber-700 dark:text-amber-300">
          {excluded.length} {excluded.length === 1 ? 'bill' : 'bills'} in{' '}
          {[...new Set(excluded.map((e) => e.groupCurrency))].join(', ')} not shown: no exchange rate to {currency}.
        </p>
      )}

      {rows.length === 0 ? (
        <p data-testid="monthly-chart-empty" className="text-xs text-slate-500 dark:text-slate-400">
          No bills yet. Months appear here once the group has spending.
        </p>
      ) : (
        <>
          <p data-testid="monthly-chart-readout" aria-live="polite" className="text-sm font-semibold text-slate-700 dark:text-slate-200">
            {shown && readout(shown)}
          </p>
          <div className="relative">
            <div className="flex items-center justify-between text-[10px] font-mono tabular-nums text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-white/10 pb-0.5">
              <span>{formatMinorToMajor(max, currency)}</span>
            </div>
            <div
              role="group"
              aria-label={`Monthly spending in ${groupName}, ${currency}`}
              className="flex items-end h-40 border-b border-slate-300 dark:border-white/20"
              onMouseLeave={() => setActive(null)}
            >
              {rows.map((r, i) => {
                const pct = (r.totalMinor / max) * 100;
                const hiddenOnMobile = i < rows.length - MOBILE_MONTHS;
                return (
                  <button
                    key={r.month}
                    type="button"
                    data-testid={`monthly-bar-${r.month}`}
                    aria-label={readout(r)}
                    onMouseEnter={() => setActive(i)}
                    onFocus={() => setActive(i)}
                    onBlur={() => setActive(null)}
                    className={`${hiddenOnMobile ? 'hidden sm:flex' : 'flex'} flex-1 min-w-[44px] sm:min-w-0 h-full items-end justify-center px-px cursor-default focus:outline-none focus-visible:ring-2 focus-visible:ring-[#059669] rounded-t-md`}
                  >
                    <span
                      className={`block w-full max-w-[24px] rounded-t-[4px] bg-[#059669] dark:bg-[#0ea472] transition-opacity ${
                        active !== null && active !== i ? 'opacity-50' : ''
                      }`}
                      style={{ height: r.totalMinor > 0 ? `max(2px, ${pct}%)` : '0' }}
                    />
                  </button>
                );
              })}
            </div>
            <div className="flex" aria-hidden="true">
              {rows.map((r, i) => (
                <span
                  key={r.month}
                  className={`${i < rows.length - MOBILE_MONTHS ? 'hidden sm:block' : 'block'} flex-1 min-w-[44px] sm:min-w-0 pt-1 text-center text-[10px] text-slate-500 dark:text-slate-400`}
                >
                  {monthLabel(r.month, 'short')}
                </span>
              ))}
            </div>
          </div>

          <details className="ws-disclosure">
            <summary className="min-h-[44px] flex items-center text-xs font-semibold text-[#059669]">Show as a table</summary>
            <table data-testid="monthly-chart-table" className="w-full text-left text-xs">
              <thead>
                <tr className="text-[11px] uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  <th className="py-1.5">Month</th>
                  <th className="py-1.5 text-right">Bills</th>
                  <th className="py-1.5 text-right">Spent</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200/60 dark:divide-white/[0.06] text-slate-700 dark:text-slate-200">
                {rows.map((r) => (
                  <tr key={r.month}>
                    <td className="py-1.5">{monthLabel(r.month, 'long')}</td>
                    <td className="py-1.5 text-right font-mono tabular-nums">{r.count}</td>
                    <td className="py-1.5 text-right font-mono tabular-nums">{formatMinorToMajor(r.totalMinor, currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      )}
    </DoubleBezelCard>
  );
}
