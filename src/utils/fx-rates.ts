import { SUPPORTED_CURRENCIES, fxCrossRateScaled, parseFxRateToScaled } from '../domain/money/currencies';
import { getKvValue, setKvValue } from '../storage/local-db';
import { localIsoDate } from './direct-settlements';

/** Frankfurter v2: free, no key, CORS *, blended central-bank rates. See docs/technical-spec.md (FX). */
export const FX_RATES_URL = 'https://api.frankfurter.dev/v2/rates?base=EUR';
const CACHE_KEY = 'fx_rates_cache';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface FxRateTable {
  fetchedOn: string;
  perEur: Record<string, { rate: string; date: string }>;
}

export interface FxQuote {
  rateScaled: number;
  status: 'live' | 'cached_offline';
  rateDate: string;
}

export function parseFxRatesResponse(json: unknown, fetchedOn: string): FxRateTable | null {
  if (!Array.isArray(json)) return null;
  const perEur: FxRateTable['perEur'] = {};
  let latest = '';
  for (const row of json as Array<Record<string, unknown>>) {
    const { base, quote, rate, date } = row ?? {};
    if (base !== 'EUR' || typeof quote !== 'string' || !/^[A-Z]{3}$/.test(quote) || !SUPPORTED_CURRENCIES[quote]) continue;
    if (typeof rate !== 'number' || !(rate > 0) || typeof date !== 'string' || !DATE_RE.test(date)) continue;
    const text = String(rate);
    if (/e/i.test(text)) continue;
    perEur[quote] = { rate: text, date };
    if (date > latest) latest = date;
  }
  if (!latest) return null;
  perEur.EUR = { rate: '1', date: latest };
  return { fetchedOn, perEur };
}

function isTable(v: unknown): v is FxRateTable {
  const t = v as FxRateTable | null;
  return !!t && typeof t.fetchedOn === 'string' && !!t.perEur && typeof t.perEur === 'object';
}

/** Cached table if it is from today or we are offline; otherwise fetch, cache and return. Falls back to the stale cache. */
export async function loadFxRates(opts: {
  online: boolean;
  today?: string;
  fetchImpl?: typeof fetch;
}): Promise<FxRateTable | null> {
  const today = opts.today ?? localIsoDate();
  const raw = await getKvValue<unknown>(CACHE_KEY);
  const cached = isTable(raw) ? raw : null;
  if (!opts.online || cached?.fetchedOn === today) return cached;
  try {
    const res = await (opts.fetchImpl ?? fetch)(FX_RATES_URL, { signal: AbortSignal.timeout(10_000) });
    const table = res.ok ? parseFxRatesResponse(await res.json(), today) : null;
    if (table) {
      await setKvValue(CACHE_KEY, table);
      return table;
    }
  } catch {
    // Offline or blocked: keep the cached table
  }
  return cached;
}

/** 'live' only when the table was fetched today; rateDate is the older of the two provider dates. */
export function quoteFxRate(
  table: FxRateTable | null,
  from: string,
  to: string,
  today = localIsoDate()
): FxQuote | null {
  const f = table?.perEur[from.toUpperCase()];
  const t = table?.perEur[to.toUpperCase()];
  if (!table || !f || !t) return null;
  const rateScaled = fxCrossRateScaled(f.rate, t.rate);
  if (rateScaled === null) return null;
  return {
    rateScaled,
    status: table.fetchedOn === today ? 'live' : 'cached_offline',
    rateDate: f.date < t.date ? f.date : t.date,
  };
}

/** Per-currency rate into `base`: a typed manual rate wins, else the cached quote, else null. */
export function fxIntoBase(
  base: string,
  quote: (from: string, to: string) => FxQuote | null,
  manualRates: Record<string, string> = {},
  today = localIsoDate()
) {
  return (currency: string) => {
    const manual = parseFxRateToScaled(manualRates[currency] ?? '');
    if (manual > 0) return { fxRateScaled: manual, fxStatus: 'manual' as const, fxRateDate: today };
    const q = quote(currency, base);
    return q && { fxRateScaled: q.rateScaled, fxStatus: q.status, fxRateDate: q.rateDate };
  };
}
