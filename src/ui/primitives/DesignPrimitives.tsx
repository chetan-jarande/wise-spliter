import React from 'react';
import { formatMinorToMajor, getCurrency } from '../../domain/money/currencies';

export function DoubleBezelCard({
  children,
  className = '',
  innerClassName = '',
  testId,
}: {
  children: React.ReactNode;
  className?: string;
  innerClassName?: string;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className={`rounded-[1.5rem] p-1.5 ring-1 ring-slate-900/[0.06] dark:ring-white/[0.08] bg-slate-900/[0.025] dark:bg-white/[0.025] transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] ${className}`}
    >
      <div
        className={`h-full rounded-[calc(1.5rem-0.375rem)] bg-white dark:bg-[#111827] border border-slate-200/70 dark:border-white/[0.06] shadow-[inset_0_1px_0_rgba(255,255,255,0.6)] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] p-5 ${innerClassName}`}
      >
        {children}
      </div>
    </div>
  );
}

export function CurrencyAmount({
  minorAmount,
  currencyCode,
  className = '',
  showPlusSign = false,
  colorize = false,
}: {
  minorAmount: number;
  currencyCode: string;
  className?: string;
  showPlusSign?: boolean;
  colorize?: boolean;
}) {
  const formatted = formatMinorToMajor(minorAmount, currencyCode, true);
  const prefix = showPlusSign && minorAmount > 0 ? '+' : '';
  const toneClass = !colorize
    ? ''
    : minorAmount > 0
    ? 'text-emerald-600 dark:text-emerald-400'
    : minorAmount < 0
    ? 'text-rose-600 dark:text-rose-400'
    : 'text-slate-500 dark:text-slate-400';

  return (
    <span className={`font-mono tabular-nums tracking-tight ${toneClass} ${className}`}>
      {prefix}
      {formatted}
    </span>
  );
}

export function StatusBadge({
  tone = 'slate',
  children,
  className = '',
}: {
  tone?: 'emerald' | 'rose' | 'amber' | 'blue' | 'slate';
  children: React.ReactNode;
  className?: string;
}) {
  const styles: Record<string, string> = {
    emerald:
      'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 ring-1 ring-emerald-500/25',
    rose: 'bg-rose-500/10 text-rose-700 dark:text-rose-300 ring-1 ring-rose-500/25',
    amber: 'bg-amber-500/12 text-amber-800 dark:text-amber-300 ring-1 ring-amber-500/30',
    blue: 'bg-sky-500/10 text-sky-700 dark:text-sky-300 ring-1 ring-sky-500/25',
    slate:
      'bg-slate-500/10 text-slate-700 dark:text-slate-300 ring-1 ring-slate-500/20',
  };

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${styles[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function CurrencyPrecisionPill({ currencyCode }: { currencyCode: string }) {
  const meta = getCurrency(currencyCode);
  const unitName =
    meta.decimals === 0
      ? '0-dec whole unit'
      : meta.decimals === 3
      ? '3-dec (1000 fils)'
      : '2-dec (100 paise/cents)';
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 dark:bg-slate-800/90 px-2.5 py-0.5 text-[11px] font-mono font-medium text-slate-700 dark:text-slate-300 ring-1 ring-slate-300/60 dark:ring-white/10">
      <span>{meta.code}</span>
      <span className="text-slate-400 dark:text-slate-500">/</span>
      <span>{unitName}</span>
    </span>
  );
}
