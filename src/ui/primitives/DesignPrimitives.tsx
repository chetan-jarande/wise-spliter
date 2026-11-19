import React from 'react';
import { formatMinorToMajor, getCurrency } from '../../domain/money/currencies';
import { ExpenseItem } from '../../types/ledger';

/**
 * Concentric Spatial Liquid Glass Double-Bezel Card.
 * Outer shell creates a subtle machined refraction rim; inner core holds the
 * translucent specular chamber with concentric corner radii.
 */
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
      className={`lg-bezel-outer rounded-[1.625rem] p-1.5 transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] ${className}`}
    >
      <div
        className={`lg-bezel-inner h-full rounded-[calc(1.625rem-0.375rem)] p-4 sm:p-5 ${innerClassName}`}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Ombria / visionOS Tactile Scene Action Capsule.
 * Circular glass icon orb on the left + crisp label & subtle description.
 */
export function SpatialActionTile({
  icon,
  title,
  subtitle,
  onClick,
  testId,
  active = false,
  className = '',
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  onClick?: () => void;
  testId?: string;
  active?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className={`min-h-[56px] text-left rounded-[1.25rem] px-3.5 py-3 flex items-center gap-3 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 ${
        active ? 'lg-luminous-pill' : 'lg-scene-tile text-[#141715] dark:text-[#F3F5F3]'
      } ${className}`}
    >
      <span
        aria-hidden="true"
        className={`h-9 w-9 rounded-full flex items-center justify-center shrink-0 ${
          active
            ? 'bg-black/10 text-inherit dark:bg-black/12'
            : 'lg-icon-orb text-[#1F2421] dark:text-[#E5EAE6]'
        }`}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-xs sm:text-[13px] font-semibold tracking-tight truncate">
          {title}
        </span>
        {subtitle && (
          <span
            className={`block text-[11px] truncate ${
              active
                ? 'opacity-75'
                : 'text-[#5C6660] dark:text-[#9CA69F]'
            }`}
          >
            {subtitle}
          </span>
        )}
      </span>
    </button>
  );
}

/**
 * Reusable Ombria / visionOS Editorial Spatial Section Header.
 * Keeps top-of-stage headers consistent and modular across all pages.
 */
export function SpatialPageHeader({
  eyebrow,
  title,
  subtitle,
  actions,
  badges,
  headingLevel = 'h1',
  className = '',
}: {
  eyebrow?: string;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  badges?: React.ReactNode;
  headingLevel?: 'h1' | 'h2';
  className?: string;
}) {
  const HeadingTag = headingLevel;
  return (
    <div
      className={`flex flex-col lg:flex-row lg:items-end lg:justify-between gap-4 min-w-0 ${className}`}
    >
      <div className="space-y-1.5 min-w-0 max-w-3xl">
        {eyebrow && (
          <p className="text-xs font-medium tracking-wide text-[#5C6660] dark:text-[#9CA69F]">
            {eyebrow}
          </p>
        )}
        {badges && <div className="flex flex-wrap items-center gap-2">{badges}</div>}
        <HeadingTag className="text-2xl sm:text-3xl lg:text-[34px] font-medium tracking-tight leading-[1.15] text-[#141715] dark:text-[#F3F5F3] [overflow-wrap:anywhere]">
          {title}
        </HeadingTag>
        {subtitle && (
          <div className="text-xs sm:text-sm text-[#4A524D] dark:text-[#B7BEB9] leading-relaxed max-w-[65ch]">
            {subtitle}
          </div>
        )}
      </div>
      {actions && (
        <div className="flex flex-wrap items-center gap-2 shrink-0">{actions}</div>
      )}
    </div>
  );
}

/**
 * Reusable Sculpted Optical Glass Metric Chamber (Ombria 20 Friday / 9:00 AM style).
 */
export function SpatialMetricTile({
  label,
  value,
  sublabel,
  icon,
  tone = 'neutral',
  testId,
  className = '',
}: {
  label: string;
  value: React.ReactNode;
  sublabel?: React.ReactNode;
  icon?: React.ReactNode;
  tone?: 'neutral' | 'emerald' | 'rose' | 'amber';
  testId?: string;
  className?: string;
}) {
  const toneRing: Record<string, string> = {
    neutral: '',
    emerald: 'border-emerald-500/25 dark:border-emerald-400/22 bg-emerald-500/[0.06] dark:bg-emerald-400/[0.06]',
    rose: 'border-rose-500/25 dark:border-rose-400/22 bg-rose-500/[0.06] dark:bg-rose-400/[0.06]',
    amber: 'border-amber-500/28 dark:border-amber-400/25 bg-amber-500/[0.07] dark:bg-amber-400/[0.07]',
  };

  return (
    <div
      data-testid={testId}
      className={`lg-recessed-well rounded-[20px] px-4 py-3.5 flex flex-col justify-between gap-1.5 min-w-0 ${toneRing[tone]} ${className}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium tracking-wide text-[#5C6660] dark:text-[#9CA69F] truncate">
          {label}
        </span>
        {icon && (
          <span
            aria-hidden="true"
            className="h-7 w-7 rounded-full lg-icon-orb flex items-center justify-center shrink-0 text-[#2B312D] dark:text-[#DCE2DD]"
          >
            {icon}
          </span>
        )}
      </div>
      <div className="text-lg sm:text-xl font-semibold tracking-tight text-[#141715] dark:text-[#F3F5F3] truncate">
        {value}
      </div>
      {sublabel && (
        <div className="text-[11px] text-[#5C6660] dark:text-[#9CA69F] truncate">
          {sublabel}
        </div>
      )}
    </div>
  );
}

/**
 * Reusable Ombria Filter / Room Switcher Pill (Everything / Person / Parcel style).
 */
export function SpatialFilterPill({
  active,
  onClick,
  children,
  count,
  testId,
  ariaLabel,
  className = '',
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  count?: number;
  testId?: string;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={ariaLabel}
      aria-pressed={active}
      onClick={onClick}
      className={`min-h-[40px] sm:min-h-[36px] inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 ${
        active
          ? 'lg-luminous-pill font-semibold'
          : 'lg-scene-tile text-[#2B312D] dark:text-[#DCE2DD]'
      } ${className}`}
    >
      <span className="truncate max-w-[180px]">{children}</span>
      {typeof count === 'number' && (
        <span
          className={`inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-mono ${
            active
              ? 'bg-black/12 text-inherit'
              : 'bg-black/[0.06] dark:bg-white/[0.10] text-[#4A524D] dark:text-[#B7BEB9]'
          }`}
        >
          {count}
        </span>
      )}
    </button>
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
    ? 'text-emerald-700 dark:text-emerald-300'
    : minorAmount < 0
    ? 'text-rose-700 dark:text-rose-300'
    : 'text-[#5C6660] dark:text-[#9CA69F]';

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
      'bg-emerald-500/12 text-emerald-800 dark:bg-emerald-400/14 dark:text-emerald-200 ring-1 ring-emerald-600/25 dark:ring-emerald-300/25 shadow-[inset_0_1px_0_rgba(255,255,255,0.18)]',
    rose:
      'bg-rose-500/12 text-rose-800 dark:bg-rose-400/14 dark:text-rose-200 ring-1 ring-rose-600/25 dark:ring-rose-300/25 shadow-[inset_0_1px_0_rgba(255,255,255,0.18)]',
    amber:
      'bg-amber-500/14 text-amber-900 dark:bg-amber-400/15 dark:text-amber-200 ring-1 ring-amber-600/30 dark:ring-amber-300/28 shadow-[inset_0_1px_0_rgba(255,255,255,0.18)]',
    blue:
      'bg-sky-500/12 text-sky-800 dark:bg-sky-400/14 dark:text-sky-200 ring-1 ring-sky-600/25 dark:ring-sky-300/25 shadow-[inset_0_1px_0_rgba(255,255,255,0.18)]',
    slate:
      'bg-black/[0.055] text-[#2B312D] dark:bg-white/[0.08] dark:text-[#DCE2DD] ring-1 ring-black/[0.08] dark:ring-white/[0.14] shadow-[inset_0_1px_0_rgba(255,255,255,0.16)]',
  };

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium backdrop-blur-md ${styles[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function CurrencyPrecisionPill({
  currencyCode,
  showTechnical = false,
}: {
  currencyCode: string;
  showTechnical?: boolean;
}) {
  const meta = getCurrency(currencyCode);
  const unitName =
    meta.decimals === 0
      ? '0-dec whole unit'
      : meta.decimals === 3
      ? '3-dec (1000 fils)'
      : '2-dec (100 paise/cents)';

  return (
    <span
      title={`${meta.name} (${meta.code}) - Exact ${unitName}`}
      className="inline-flex items-center gap-1 rounded-full bg-black/[0.055] dark:bg-white/[0.08] px-2.5 py-0.5 text-[11px] font-mono font-medium text-[#2B312D] dark:text-[#DCE2DD] ring-1 ring-black/[0.08] dark:ring-white/[0.14] shadow-[inset_0_1px_0_rgba(255,255,255,0.16)]"
    >
      <span className="font-semibold text-emerald-700 dark:text-emerald-300">{meta.symbol}</span>
      <span>{meta.code}</span>
      {showTechnical && (
        <>
          <span className="opacity-50">/</span>
          <span>{unitName}</span>
        </>
      )}
    </span>
  );
}

export function PersonalExpenseImpactBadge({
  expense,
  myMemberId,
  className = '',
}: {
  expense: ExpenseItem;
  myMemberId: string | null | undefined;
  className?: string;
}) {
  if (!myMemberId) {
    return (
      <span
        data-testid="expense-personal-impact-pill"
        className={`inline-flex items-center gap-1 rounded-full bg-black/[0.05] dark:bg-white/[0.07] px-2.5 py-0.5 text-[11px] font-medium text-[#525B55] dark:text-[#AAB3AD] ring-1 ring-black/[0.08] dark:ring-white/[0.12] ${className}`}
      >
        not involved
      </span>
    );
  }

  const myPaidMinor = expense.payers
    .filter((p) => p.memberId === myMemberId)
    .reduce((sum, p) => sum + p.paidMinor, 0);
  const mySplit = expense.splits.find((s) => s.memberId === myMemberId && s.included);
  const myOwedMinor = mySplit ? mySplit.owedMinor : 0;
  const isInvolved = myPaidMinor > 0 || Boolean(mySplit);

  if (!isInvolved) {
    return (
      <span
        data-testid="expense-personal-impact-pill"
        className={`inline-flex items-center gap-1 rounded-full bg-black/[0.05] dark:bg-white/[0.07] px-2.5 py-0.5 text-[11px] font-medium text-[#525B55] dark:text-[#AAB3AD] ring-1 ring-black/[0.08] dark:ring-white/[0.12] ${className}`}
      >
        not involved
      </span>
    );
  }

  const netDeltaMinor = myPaidMinor - myOwedMinor;

  if (netDeltaMinor > 0) {
    return (
      <span
        data-testid="expense-personal-impact-pill"
        className={`inline-flex items-center gap-1 rounded-full bg-emerald-500/12 dark:bg-emerald-400/14 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-800 dark:text-emerald-200 ring-1 ring-emerald-600/25 dark:ring-emerald-300/25 ${className}`}
      >
        <span>you lent</span>
        <span className="font-mono tabular-nums font-bold">
          {formatMinorToMajor(netDeltaMinor, expense.groupCurrency)}
        </span>
      </span>
    );
  }

  if (netDeltaMinor < 0) {
    return (
      <span
        data-testid="expense-personal-impact-pill"
        className={`inline-flex items-center gap-1 rounded-full bg-rose-500/12 dark:bg-rose-400/14 px-2.5 py-0.5 text-[11px] font-semibold text-rose-800 dark:text-rose-200 ring-1 ring-rose-600/25 dark:ring-rose-300/25 ${className}`}
      >
        <span>you borrowed</span>
        <span className="font-mono tabular-nums font-bold">
          {formatMinorToMajor(Math.abs(netDeltaMinor), expense.groupCurrency)}
        </span>
      </span>
    );
  }

  return (
    <span
      data-testid="expense-personal-impact-pill"
      className={`inline-flex items-center gap-1 rounded-full bg-black/[0.05] dark:bg-white/[0.07] px-2.5 py-0.5 text-[11px] font-medium text-[#525B55] dark:text-[#AAB3AD] ring-1 ring-black/[0.08] dark:ring-white/[0.12] ${className}`}
    >
      settled on bill
    </span>
  );
}
