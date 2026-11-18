import { CurrencyDecimals, CurrencyDefinition, FxStatus } from '../../types/ledger';
import mockData from '../../data/mock-ledger-data.json';

const PRIMARY_CURRENCIES: CurrencyDefinition[] = mockData.currenciesCatalog as CurrencyDefinition[];

const EXTRA_ISO_CURRENCIES: Array<[string, string, string, CurrencyDecimals]> = [
  ['AFN', 'Afghan Afghani', '؋', 2], ['ALL', 'Albanian Lek', 'L', 2], ['AMD', 'Armenian Dram', '֏', 2],
  ['ANG', 'Netherlands Antillean Guilder', 'ƒ', 2], ['AOA', 'Angolan Kwanza', 'Kz', 2], ['ARS', 'Argentine Peso', '$', 2],
  ['AWG', 'Aruban Florin', 'ƒ', 2], ['AZN', 'Azerbaijani Manat', '₼', 2], ['BAM', 'Bosnia-Herzegovina Convertible Mark', 'KM', 2],
  ['BBD', 'Barbadian Dollar', '$', 2], ['BDT', 'Bangladeshi Taka', '৳', 2], ['BGN', 'Bulgarian Lev', 'лв', 2],
  ['BIF', 'Burundian Franc', 'FBu', 0], ['BMD', 'Bermudan Dollar', '$', 2], ['BND', 'Brunei Dollar', '$', 2],
  ['BOB', 'Bolivian Boliviano', 'Bs.', 2], ['BRL', 'Brazilian Real', 'R$', 2], ['BSD', 'Bahamian Dollar', '$', 2],
  ['BTN', 'Bhutanese Ngultrum', 'Nu.', 2], ['BWP', 'Botswanan Pula', 'P', 2], ['BYN', 'Belarusian Ruble', 'Br', 2],
  ['BZD', 'Belize Dollar', 'BZ$', 2], ['CDF', 'Congolese Franc', 'FC', 2], ['CLP', 'Chilean Peso', '$', 0],
  ['CNY', 'Chinese Yuan', '¥', 2], ['COP', 'Colombian Peso', '$', 2], ['CRC', 'Costa Rican Colón', '₡', 2],
  ['CUP', 'Cuban Peso', '₱', 2], ['CVE', 'Cape Verdean Escudo', '$', 2], ['CZK', 'Czech Koruna', 'Kč', 2],
  ['DJF', 'Djiboutian Franc', 'Fdj', 0], ['DKK', 'Danish Krone', 'kr', 2], ['DOP', 'Dominican Peso', 'RD$', 2],
  ['DZD', 'Algerian Dinar', 'د.ج', 2], ['EGP', 'Egyptian Pound', 'E£', 2], ['ERN', 'Eritrean Nakfa', 'Nfk', 2],
  ['ETB', 'Ethiopian Birr', 'Br', 2], ['FJD', 'Fijian Dollar', '$', 2], ['FKP', 'Falkland Islands Pound', '£', 2],
  ['GEL', 'Georgian Lari', '₾', 2], ['GHS', 'Ghanaian Cedi', '₵', 2], ['GIP', 'Gibraltar Pound', '£', 2],
  ['GMD', 'Gambian Dalasi', 'D', 2], ['GNF', 'Guinean Franc', 'FG', 0], ['GTQ', 'Guatemalan Quetzal', 'Q', 2],
  ['GYD', 'Guyanaese Dollar', '$', 2], ['HKD', 'Hong Kong Dollar', 'HK$', 2], ['HNL', 'Honduran Lempira', 'L', 2],
  ['HTG', 'Haitian Gourde', 'G', 2], ['HUF', 'Hungarian Forint', 'Ft', 2], ['IDR', 'Indonesian Rupiah', 'Rp', 2],
  ['ILS', 'Israeli New Shekel', '₪', 2], ['IQD', 'Iraqi Dinar', 'ع.د', 3], ['IRR', 'Iranian Rial', '﷼', 2],
  ['ISK', 'Icelandic Króna', 'kr', 0], ['JMD', 'Jamaican Dollar', 'J$', 2], ['JOD', 'Jordanian Dinar', 'JD', 3],
  ['KES', 'Kenyan Shilling', 'KSh', 2], ['KGS', 'Kyrgystani Som', 'лв', 2], ['KHR', 'Cambodian Riel', '៛', 2],
  ['KMF', 'Comorian Franc', 'CF', 0], ['KPW', 'North Korean Won', '₩', 2], ['KYD', 'Cayman Islands Dollar', '$', 2],
  ['KZT', 'Kazakhstani Tenge', '₸', 2], ['LAK', 'Laotian Kip', '₭', 2], ['LBP', 'Lebanese Pound', 'ل.ل', 2],
  ['LKR', 'Sri Lankan Rupee', 'Rs', 2], ['LRD', 'Liberian Dollar', '$', 2], ['LSL', 'Lesotho Loti', 'L', 2],
  ['LYD', 'Libyan Dinar', 'LD', 3], ['MAD', 'Moroccan Dirham', 'د.م.', 2], ['MDL', 'Moldovan Leu', 'L', 2],
  ['MGA', 'Malagasy Ariary', 'Ar', 2], ['MKD', 'Macedonian Denar', 'ден', 2], ['MMK', 'Myanma Kyat', 'K', 2],
  ['MNT', 'Mongolian Tugrik', '₮', 2], ['MOP', 'Macanese Pataca', 'MOP$', 2], ['MRU', 'Mauritanian Ouguiya', 'UM', 2],
  ['MUR', 'Mauritian Rupee', '₨', 2], ['MVR', 'Maldivian Rufiyaa', 'Rf', 2], ['MWK', 'Malawian Kwacha', 'MK', 2],
  ['MXN', 'Mexican Peso', '$', 2], ['MYR', 'Malaysian Ringgit', 'RM', 2], ['MZN', 'Mozambican Metical', 'MT', 2],
  ['NAD', 'Namibian Dollar', '$', 2], ['NGN', 'Nigerian Naira', '₦', 2], ['NIO', 'Nicaraguan Córdoba', 'C$', 2],
  ['NOK', 'Norwegian Krone', 'kr', 2], ['NPR', 'Nepalese Rupee', '₨', 2], ['NZD', 'New Zealand Dollar', 'NZ$', 2],
  ['PAB', 'Panamanian Balboa', 'B/.', 2], ['PEN', 'Peruvian Sol', 'S/.', 2], ['PGK', 'Papua New Guinean Kina', 'K', 2],
  ['PHP', 'Philippine Peso', '₱', 2], ['PKR', 'Pakistani Rupee', '₨', 2], ['PLN', 'Polish Zloty', 'zł', 2],
  ['PYG', 'Paraguayan Guarani', '₲', 0], ['QAR', 'Qatari Rial', 'ر.ق', 2], ['RON', 'Romanian Leu', 'lei', 2],
  ['RSD', 'Serbian Dinar', 'Дин.', 2], ['RUB', 'Russian Ruble', '₽', 2], ['RWF', 'Rwandan Franc', 'FRw', 0],
  ['SAR', 'Saudi Riyal', 'ر.س', 2], ['SBD', 'Solomon Islands Dollar', '$', 2], ['SCR', 'Seychellois Rupee', '₨', 2],
  ['SDG', 'Sudanese Pound', 'ج.س.', 2], ['SEK', 'Swedish Krona', 'kr', 2], ['SHP', 'Saint Helena Pound', '£', 2],
  ['SLE', 'Sierra Leonean Leone', 'Le', 2], ['SOS', 'Somali Shilling', 'S', 2], ['SRD', 'Surinamese Dollar', '$', 2],
  ['SSP', 'South Sudanese Pound', '£', 2], ['STN', 'São Tomé & Príncipe Dobra', 'Db', 2], ['SYP', 'Syrian Pound', '£', 2],
  ['SZL', 'Swazi Lilangeni', 'E', 2], ['TJS', 'Tajikistani Somoni', 'SM', 2], ['TMT', 'Turkmenistani Manat', 'T', 2],
  ['TND', 'Tunisian Dinar', 'د.ت', 3], ['TOP', 'Tongan Paʻanga', 'T$', 2], ['TRY', 'Turkish Lira', '₺', 2],
  ['TTD', 'Trinidad and Tobago Dollar', 'TT$', 2], ['TWD', 'New Taiwan Dollar', 'NT$', 2], ['TZS', 'Tanzanian Shilling', 'TSh', 2],
  ['UAH', 'Ukrainian Hryvnia', '₴', 2], ['UGX', 'Ugandan Shilling', 'USh', 0], ['UYU', 'Uruguayan Peso', '$U', 2],
  ['UZS', 'Uzbekistani Som', 'лв', 2], ['VES', 'Venezuelan Bolívar', 'Bs.S', 2], ['VUV', 'Vanuatu Vatu', 'VT', 0],
  ['WST', 'Samoan Tala', 'WS$', 2], ['XAF', 'Central African CFA Franc', 'FCFA', 0], ['XCD', 'East Caribbean Dollar', '$', 2],
  ['XOF', 'West African CFA Franc', 'CFA', 0], ['XPF', 'CFP Franc', '₣', 0], ['YER', 'Yemeni Rial', '﷼', 2],
  ['ZAR', 'South African Rand', 'R', 2], ['ZMW', 'Zambian Kwacha', 'ZK', 2], ['ZWL', 'Zimbabwean Dollar', '$', 2],
  ['BOV', 'Bolivian Mvdol', 'BOV', 2], ['COU', 'Colombian Real Value Unit', 'COU', 2],
  ['CUC', 'Cuban Convertible Peso', 'CUC$', 2], ['SVC', 'Salvadoran Colón', '₡', 2], ['ZWG', 'Zimbabwe Gold', 'ZiG', 2],
  ['XCG', 'Caribbean Guilder', 'Cg', 2], ['VED', 'Venezuelan Bolívar Digital', 'Bs.D', 2]
];

export const SUPPORTED_CURRENCIES: Record<string, CurrencyDefinition> = {};

for (const c of PRIMARY_CURRENCIES) {
  const normCode = c.code.trim().toUpperCase();
  SUPPORTED_CURRENCIES[normCode] = { ...c, code: normCode };
}
for (const [code, name, symbol, decimals] of EXTRA_ISO_CURRENCIES) {
  const normCode = code.trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(normCode) && !SUPPORTED_CURRENCIES[normCode]) {
    SUPPORTED_CURRENCIES[normCode] = {
      code: normCode,
      name,
      symbol,
      decimals,
      flagCode: normCode.slice(0, 2),
    };
  }
}

const KNOWN_CURRENCY_SYMBOLS: string[] = Array.from(
  new Set(Object.values(SUPPORTED_CURRENCIES).map((c) => c.symbol))
).sort((a, b) => b.length - a.length);

export function getCurrency(code: string): CurrencyDefinition {
  const upper = code.trim().toUpperCase();
  return (
    SUPPORTED_CURRENCIES[upper] ?? {
      code: upper,
      name: upper,
      symbol: upper,
      decimals: 2,
      flagCode: 'UN',
    }
  );
}

export function getMinorScaleFactor(currencyCode: string): bigint {
  const { decimals } = getCurrency(currencyCode);
  if (decimals === 0) return 1n;
  if (decimals === 3) return 1000n;
  return 100n;
}

/**
 * Pure BigInt integer division with deterministic commercial half-away-from-zero rounding.
 * Works accurately for any signed numerator and positive denominator (even or odd).
 */
export function divRoundHalfAwayFromZero(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) {
    throw new RangeError('Division by zero in divRoundHalfAwayFromZero');
  }
  const sign = (numerator < 0n) !== (denominator < 0n) ? -1n : 1n;
  const absNum = numerator < 0n ? -numerator : numerator;
  const absDen = denominator < 0n ? -denominator : denominator;

  const quotient = absNum / absDen;
  const remainder = absNum % absDen;
  const rounded = remainder * 2n >= absDen ? quotient + 1n : quotient;
  return rounded === 0n ? 0n : sign * rounded;
}

function stripCurrencyAffixes(input: string, targetCurrency: CurrencyDefinition): {
  cleaned: string;
  isNegative: boolean;
  validSign: boolean;
  mismatch?: boolean;
} {
  let mismatch = false;
  const dollarFamily = targetCurrency.symbol.includes('$');
  let s = input.trim();
  let signChar: '+' | '-' | null = null;

  const consumeSign = (): boolean => {
    if (s.startsWith('-') || s.startsWith('+')) {
      if (signChar !== null) return false;
      signChar = s[0] as '+' | '-';
      s = s.slice(1).trim();
    }
    return true;
  };

  if (!consumeSign()) {
    return { cleaned: s, isNegative: false, validSign: false };
  }

  // Strip leading target currency code/symbol or known symbol
  const upperS = s.toUpperCase();
  if (upperS.startsWith(targetCurrency.code) && (s.length === targetCurrency.code.length || /[\s\d.,+-]/.test(s[targetCurrency.code.length] ?? ''))) {
    s = s.slice(targetCurrency.code.length).trim();
  } else if (s.startsWith(targetCurrency.symbol)) {
    s = s.slice(targetCurrency.symbol.length).trim();
  } else if (dollarFamily && s.startsWith('$')) {
    s = s.slice(1).trim();
  } else {
    const codeMatch = /^([A-Z]{3})\s+/.exec(s);
    if (codeMatch && codeMatch[1] && SUPPORTED_CURRENCIES[codeMatch[1]]) {
      mismatch = true;
    } else if (KNOWN_CURRENCY_SYMBOLS.some((sym) => sym && s.startsWith(sym) && !/^[A-Za-z]+$/.test(sym))) {
      mismatch = true;
    }
  }

  if (!consumeSign()) {
    return { cleaned: s, isNegative: false, validSign: false };
  }

  // Strip trailing currency code or non-alphabetic symbol (e.g. "25.50 INR" or "50.00€")
  const trailingUpper = s.toUpperCase();
  if (
    trailingUpper.endsWith(targetCurrency.code) &&
    s.length > targetCurrency.code.length &&
    /[\s\d.]/.test(s[s.length - targetCurrency.code.length - 1] ?? '')
  ) {
    s = s.slice(0, s.length - targetCurrency.code.length).trim();
  } else if (
    s.endsWith(targetCurrency.symbol) &&
    !/^[A-Za-z]+$/.test(targetCurrency.symbol)
  ) {
    s = s.slice(0, s.length - targetCurrency.symbol.length).trim();
  } else if (dollarFamily && s.endsWith('$')) {
    s = s.slice(0, -1).trim();
  } else {
    const trailCodeMatch = /\s+([A-Z]{3})$/.exec(s);
    if (trailCodeMatch && trailCodeMatch[1] && SUPPORTED_CURRENCIES[trailCodeMatch[1]]) {
      mismatch = true;
    } else if (KNOWN_CURRENCY_SYMBOLS.some((sym) => sym && !/^[A-Za-z]+$/.test(sym) && s.endsWith(sym))) {
      mismatch = true;
    }
  }

  return {
    cleaned: s,
    isNegative: signChar === '-',
    validSign: true,
    mismatch,
  };
}

function parseUnsignedDecimalToScaledBigInt(
  cleaned: string,
  decimals: number
): { ok: boolean; magnitude: bigint; error?: string } {
  if (!cleaned) {
    return { ok: false, magnitude: 0n, error: 'Empty numeric string' };
  }
  if (/[eE]/.test(cleaned)) {
    return { ok: false, magnitude: 0n, error: 'Scientific notation is not permitted' };
  }

  const dotParts = cleaned.split('.');
  if (dotParts.length > 2) {
    return { ok: false, magnitude: 0n, error: 'Multiple decimal points' };
  }

  const rawWhole = dotParts[0] ?? '';
  const rawFrac = dotParts[1] ?? '';

  // Reject commas in fractional part or non-digit/comma chars in whole part
  if (/[^0-9,]/.test(rawWhole) || /[^0-9]/.test(rawFrac)) {
    return { ok: false, magnitude: 0n, error: 'Invalid characters in numeric input' };
  }
  if (rawWhole.includes(',') && !/^(\d{1,3}(,\d{3})+|\d{1,2}(,\d{2})*,\d{3})$/.test(rawWhole)) {
    return { ok: false, magnitude: 0n, error: 'Malformed grouping separator' };
  }

  const wholeDigits = rawWhole.replace(/,/g, '');
  if (wholeDigits.length === 0 && rawFrac.length === 0) {
    return { ok: false, magnitude: 0n, error: 'No digits present' };
  }

  const normalizedWhole = wholeDigits || '0';
  const keptFrac = decimals === 0 ? '' : rawFrac.padEnd(decimals, '0').slice(0, decimals);
  const baseMag = BigInt(normalizedWhole + keptFrac);
  const nextFracDigit = rawFrac[decimals] ?? '0';
  const roundedMag = nextFracDigit >= '5' ? baseMag + 1n : baseMag;

  return { ok: true, magnitude: roundedMag };
}

/** True when the locale writes decimals with a comma (de-DE: 12,50). Invalid tags count as false. */
export function localeUsesDecimalComma(locale?: string): boolean {
  if (!locale) return false;
  try {
    return new Intl.NumberFormat(locale).formatToParts(1.5).find((p) => p.type === 'decimal')?.value === ',';
  } catch {
    return false;
  }
}

/**
 * Swaps "." and "," for decimal-comma locales, so "1,234.50" <-> "1.234,50". It is its own inverse:
 * use it to show canonical text in an input and to turn typed text back into canonical form.
 */
export function toLocaleDecimalInput(text: string, locale?: string): string {
  return localeUsesDecimalComma(locale) ? text.replace(/[.,]/g, (c) => (c === '.' ? ',' : '.')) : text;
}

/** Non-negative decimal (percent, share, rate) scaled by 10^decimals, locale-aware; null when unusable. */
export function parseLocaleDecimal(input: string, decimals: number, locale?: string): bigint | null {
  const raw = input.trim().replace(/^\+/, '');
  const parsed = parseUnsignedDecimalToScaledBigInt(canonicalizeLocaleDigits(raw, locale), decimals);
  return parsed.ok ? parsed.magnitude : null;
}

/** Rewrites locale digits to "1,234.56" form so the strict parser validates grouping. */
function canonicalizeLocaleDigits(cleaned: string, locale?: string): string {
  const swapped = localeUsesDecimalComma(locale)
    ? cleaned.replace(/[.,]/g, (c) => (c === '.' ? ',' : '.'))
    : cleaned;
  return swapped.replace(/(\d)[\s'\u2019]+(?=\d)/g, '$1,');
}

export function tryParseMajorToMinorBigInt(
  majorInput: string | number,
  currencyCode: string,
  locale?: string
): { ok: boolean; value: bigint; error?: string } {
  const currency = getCurrency(currencyCode);
  const { decimals } = currency;

  let rawStr: string;
  if (typeof majorInput === 'number') {
    if (!Number.isFinite(majorInput) || Math.abs(majorInput) >= 1e21) {
      return { ok: false, value: 0n, error: 'Non-finite or unsafe floating-point number' };
    }
    rawStr =
      Math.abs(majorInput) > 0 && Math.abs(majorInput) < 1e-4
        ? majorInput.toFixed(decimals + 6)
        : String(majorInput);
  } else {
    rawStr = String(majorInput);
  }

  const trimmed = rawStr.trim();
  if (!trimmed || trimmed === '-' || trimmed === '+' || trimmed === '.' || trimmed === '-.' || trimmed === '+.') {
    return { ok: false, value: 0n, error: 'Incomplete or empty numeric input' };
  }

  const { cleaned, isNegative, validSign, mismatch } = stripCurrencyAffixes(trimmed, currency);
  if (!validSign) {
    return { ok: false, value: 0n, error: 'Duplicate or malformed sign prefix' };
  }
  if (mismatch) {
    return { ok: false, value: 0n, error: `Currency symbol does not match ${currency.code}` };
  }

  const parsed = parseUnsignedDecimalToScaledBigInt(canonicalizeLocaleDigits(cleaned, locale), decimals);
  if (!parsed.ok) {
    return { ok: false, value: 0n, error: parsed.error };
  }

  const signed = parsed.magnitude === 0n ? 0n : isNegative ? -parsed.magnitude : parsed.magnitude;
  return { ok: true, value: signed };
}

export function parseMajorToMinorStrict(
  majorInput: string | number,
  currencyCode: string
): bigint {
  const res = tryParseMajorToMinorBigInt(majorInput, currencyCode);
  if (!res.ok) {
    throw new RangeError(
      `Invalid monetary input "${String(majorInput)}" for ${currencyCode}: ${res.error ?? 'parse error'}`
    );
  }
  return res.value;
}

const MAX_SAFE_MINOR = BigInt(Number.MAX_SAFE_INTEGER);

/** UI helper: 0 for anything unparseable or beyond 2^53-1 minor units. */
export function parseMajorToMinor(
  majorInput: string | number,
  currencyCode: string,
  locale?: string
): number {
  const res = tryParseMajorToMinorBigInt(majorInput, currencyCode, locale);
  if (!res.ok || res.value === 0n || res.value > MAX_SAFE_MINOR || res.value < -MAX_SAFE_MINOR) return 0;
  return Number(res.value);
}

export function formatMinorToMajor(
  minorAmount: number | bigint,
  currencyCode: string,
  includeSymbol = true
): string {
  const { decimals, symbol } = getCurrency(currencyCode);
  let val: bigint;
  if (typeof minorAmount === 'bigint') {
    val = minorAmount;
  } else if (!Number.isFinite(minorAmount)) {
    val = 0n;
  } else {
    val = BigInt(Math.trunc(minorAmount));
  }

  const isNegative = val < 0n;
  const abs = isNegative ? -val : val;

  const scale = decimals === 0 ? 1n : decimals === 3 ? 1000n : 100n;
  const whole = abs / scale;
  const frac = abs % scale;

  const wholeFormatted = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fracFormatted =
    decimals === 0 ? '' : '.' + frac.toString().padStart(decimals, '0');

  const signPrefix = isNegative ? '-' : '';
  const symbolPrefix = includeSymbol ? `${symbol}` : '';
  return `${signPrefix}${symbolPrefix}${wholeFormatted}${fracFormatted}`;
}

/** Rate scaled by 10^8, or 0 when the input is not a usable positive rate. Never defaults to 1:1. */
export function parseFxRateToScaled(rateDecimal: string | number, locale?: string): number {
  let raw: string;
  if (typeof rateDecimal === 'number') {
    if (!Number.isFinite(rateDecimal) || rateDecimal <= 0) return 0;
    raw = rateDecimal < 1e-4 ? rateDecimal.toFixed(12) : String(rateDecimal);
  } else {
    raw = String(rateDecimal);
  }
  const scaled = parseLocaleDecimal(raw, 8, typeof rateDecimal === 'number' ? undefined : locale);
  return scaled !== null && scaled > 0n && scaled <= MAX_SAFE_MINOR ? Number(scaled) : 0;
}

/**
 * Cross rate from two quotes against one base (units of each currency per 1 base unit):
 * 1 from = toPerBase / fromPerBase to, rounded half-away-from-zero to 10^-8.
 * Null when either quote is unusable or the result is 0 or beyond 2^53-1 once scaled.
 */
export function fxCrossRateScaled(fromPerBase: string, toPerBase: string): number | null {
  const f = parseUnsignedDecimalToScaledBigInt(fromPerBase.trim(), 12);
  const t = parseUnsignedDecimalToScaledBigInt(toPerBase.trim(), 12);
  if (!f.ok || !t.ok || f.magnitude <= 0n || t.magnitude <= 0n) return null;
  const scaled = divRoundHalfAwayFromZero(t.magnitude * 100000000n, f.magnitude);
  return scaled > 0n && scaled <= MAX_SAFE_MINOR ? Number(scaled) : null;
}

/** Full-precision display of a 10^8-scaled rate (at least 2 decimals); '' when unusable. */
export function formatScaledFxRate(fxRateScaled: number): string {
  if (!Number.isSafeInteger(fxRateScaled) || fxRateScaled <= 0) return '';
  return formatAuditFxRateBigInt(BigInt(fxRateScaled), 8);
}

function formatAuditFxRateBigInt(rateScaled: bigint, maxDecimals = 8): string {
  const whole = rateScaled / 100000000n;
  const frac8 = (rateScaled % 100000000n).toString().padStart(8, '0');
  const trimmedFrac = frac8.slice(0, maxDecimals).replace(/0+$/, '');
  const finalFrac = trimmedFrac.length < 2 ? frac8.slice(0, 2) : trimmedFrac;
  return `${whole.toString()}.${finalFrac}`;
}

function requirePositiveRate(fxRateScaled: bigint | number, from: string, to: string): bigint {
  const rate =
    typeof fxRateScaled === 'bigint'
      ? fxRateScaled
      : Number.isFinite(fxRateScaled)
      ? BigInt(Math.round(fxRateScaled))
      : 0n;
  if (rate <= 0n) {
    throw new RangeError(`No exchange rate for ${from} to ${to}`);
  }
  return rate;
}

/**
 * Pure BigInt foreign-to-base minor unit converter.
 * converted = roundHalfAwayFromZero(originalMinor * rateScaled * toScale / (fromScale * 10^8)).
 * Throws RangeError when from != to and the rate is not positive.
 * Prevents IEEE-754 MAX_SAFE_INTEGER overflow even when originalMinor * rateScaled * toScale >= 10^22.
 */
export function convertForeignToBaseMinor(
  originalMinor: bigint | number,
  fromCurrency: string,
  toCurrency: string,
  fxRateScaled: bigint | number
): bigint {
  const from = fromCurrency.trim().toUpperCase();
  const to = toCurrency.trim().toUpperCase();
  const origBig =
    typeof originalMinor === 'bigint'
      ? originalMinor
      : Number.isFinite(originalMinor)
      ? BigInt(Math.round(originalMinor))
      : 0n;

  if (from === to) {
    return origBig;
  }

  const rateBig = requirePositiveRate(fxRateScaled, from, to);

  const fromScale = getMinorScaleFactor(from);
  const toScale = getMinorScaleFactor(to);

  const numerator = origBig * rateBig * toScale;
  const denominator = fromScale * 100000000n;
  return divRoundHalfAwayFromZero(numerator, denominator);
}

export function convertMinorAmountWithFx(params: {
  originalMinor: number | bigint;
  fromCurrency: string;
  toCurrency: string;
  fxRateScaled: number | bigint;
  fxStatus: FxStatus;
  dateIso: string;
}): { convertedMinor: number; fxAuditNote: string | null } {
  const from = params.fromCurrency.trim().toUpperCase();
  const to = params.toCurrency.trim().toUpperCase();
  const origBig =
    typeof params.originalMinor === 'bigint'
      ? params.originalMinor
      : Number.isFinite(params.originalMinor)
      ? BigInt(Math.round(params.originalMinor))
      : 0n;

  if (from === to) {
    return {
      convertedMinor: origBig === 0n ? 0 : Number(origBig),
      fxAuditNote: null,
    };
  }
  if (params.fxStatus === 'identity') {
    throw new RangeError(`No exchange rate status for ${from} to ${to}`);
  }

  const rateBig = requirePositiveRate(params.fxRateScaled, from, to);

  const convertedBig = convertForeignToBaseMinor(origBig, from, to, rateBig);

  const formattedOrig = formatMinorToMajor(origBig, from, true);
  const rateReadable = formatAuditFxRateBigInt(rateBig);
  const statusLabel =
    params.fxStatus === 'cached_offline' ? 'cached offline rate' : params.fxStatus === 'manual' ? 'manual rate' : 'live rate';

  return {
    convertedMinor: convertedBig === 0n ? 0 : Number(convertedBig),
    fxAuditNote: `Converted from ${formattedOrig} ${from} at 1 ${from} = ${rateReadable} ${to} (${statusLabel}, ${params.dateIso})`,
  };
}
