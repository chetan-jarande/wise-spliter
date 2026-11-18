import type { ExpenseItem } from '../types/ledger';
import { tryParseMajorToMinorBigInt } from '../domain/money/currencies';

export interface AmountFilter {
  mode: 'any' | 'exact' | 'between';
  min: string;
  max: string;
}

function toMinor(input: string, currency: string, locale?: string): bigint | null {
  if (!input.trim()) return null;
  const res = tryParseMajorToMinorBigInt(input, currency, locale);
  return res.ok ? res.value : null;
}

function amountMatches(amountMinor: number, currency: string, f: AmountFilter, locale?: string): boolean {
  const amount = BigInt(Math.round(amountMinor));
  if (f.mode === 'exact') {
    const target = toMinor(f.min, currency, locale);
    return target === null || amount === target;
  }
  let lo = toMinor(f.min, currency, locale);
  let hi = toMinor(f.max, currency, locale);
  if (lo !== null && hi !== null && lo > hi) [lo, hi] = [hi, lo];
  return (lo === null || amount >= lo) && (hi === null || amount <= hi);
}

/** Matches the bill amount in the group currency or the original currency it was paid in. */
export function matchesAmountFilter(exp: ExpenseItem, f: AmountFilter, locale?: string): boolean {
  if (f.mode === 'any') return true;
  return (
    amountMatches(exp.amountMinor, exp.groupCurrency, f, locale) ||
    amountMatches(exp.originalAmountMinor, exp.originalCurrency, f, locale)
  );
}

export function matchesDateRange(expenseDate: string, from: string, to: string): boolean {
  const day = expenseDate.slice(0, 10);
  const [lo, hi] = from && to && from > to ? [to, from] : [from, to];
  return (!lo || day >= lo) && (!hi || day <= hi);
}

export interface MonthTotal {
  month: string;
  totalMinor: number;
  count: number;
}

const MONTH_RE = /^(\d{4})-(\d{2})/;

/** The bill amount in `currency` (converted when needed), or null when it cannot be converted. */
export function inCurrency(
  e: ExpenseItem,
  currency?: string,
  convert?: (minor: bigint, from: string) => bigint | null
): bigint | null {
  const amount = BigInt(Math.round(e.amountMinor));
  if (!currency || e.groupCurrency === currency) return amount;
  return convert ? convert(amount, e.groupCurrency) : null;
}

/**
 * Contiguous months (gaps filled with 0) ending at the latest bill month, at most `limit` long.
 * With `currency`, bills in another currency go through `convert`; those it returns null for are skipped.
 */
export function monthlySpend(
  expenses: ExpenseItem[],
  limit: number,
  currency?: string,
  convert?: (minor: bigint, from: string) => bigint | null
): MonthTotal[] {
  const totals = new Map<string, { sum: bigint; count: number }>();
  for (const e of expenses) {
    const m = MONTH_RE.exec(e.expenseDate);
    if (e.deletedAt || !m) continue;
    const amount = inCurrency(e, currency, convert);
    if (amount === null) continue;
    const key = `${m[1]}-${m[2]}`;
    const t = totals.get(key) ?? { sum: 0n, count: 0 };
    t.sum += amount;
    t.count += 1;
    totals.set(key, t);
  }
  const keys = [...totals.keys()].sort();
  if (keys.length === 0) return [];
  const idx = (k: string) => Number(k.slice(0, 4)) * 12 + Number(k.slice(5, 7)) - 1;
  const last = idx(keys[keys.length - 1]!);
  const first = Math.max(idx(keys[0]!), last - limit + 1);
  const out: MonthTotal[] = [];
  for (let i = first; i <= last; i++) {
    const key = `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
    const t = totals.get(key);
    out.push({ month: key, totalMinor: t ? Number(t.sum) : 0, count: t?.count ?? 0 });
  }
  return out;
}

const CODE_RE = /^WS-[0-9A-F]{10}$/;

/** Accepts a raw invite code or an invite link carrying `?join=CODE`. */
export function parseInviteCode(input: string): string | null {
  const raw = input.trim();
  const fromLink = /[?&]join=([^&#]*)/.exec(raw);
  let code = fromLink ? fromLink[1]! : raw;
  try {
    code = decodeURIComponent(code);
  } catch {
    return null;
  }
  code = code.trim().toUpperCase();
  return CODE_RE.test(code) ? code : null;
}
