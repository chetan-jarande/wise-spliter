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
  ['Bov', 'Bolivian Mvdol', 'BOV', 2], ['CLF', 'Chilean Unit of Account', 'UF', 0], ['COU', 'Colombian Real Value Unit', 'COU', 2],
  ['CUC', 'Cuban Convertible Peso', 'CUC$', 2], ['SVC', 'Salvadoran Colón', '₡', 2], ['ZWGold', 'Zimbabwe Gold', 'ZiG', 2],
  ['IMP', 'Isle of Man Pound', '£', 2], ['JEP', 'Jersey Pound', '£', 2], ['GGP', 'Guernsey Pound', '£', 2],
  ['TVD', 'Tuvaluan Dollar', '$', 2], ['KID', 'Kiribati Dollar', '$', 2], ['FOK', 'Faroese Króna', 'kr', 2],
  ['SPL', 'Seborga Luigino', 'SPL', 2], ['PRB', 'Transnistrian Ruble', 'р.', 2], ['Abkhaz', 'Abkhazian Apsar', 'Аҧ', 2],
  ['Artsakh', 'Artsakh Dram', 'դր.', 2], ['Somaliland', 'Somaliland Shilling', 'Sl.Sh.', 2], ['CookIslands', 'Cook Islands Dollar', '$', 2],
  ['Niue', 'Niue Dollar', '$', 2], ['Pitcairn', 'Pitcairn Islands Dollar', '$', 2], ['Sahrawi', 'Sahrawi Peseta', '₧', 2]
];

export const SUPPORTED_CURRENCIES: Record<string, CurrencyDefinition> = {};

for (const c of PRIMARY_CURRENCIES) {
  SUPPORTED_CURRENCIES[c.code] = c;
}
for (const [code, name, symbol, decimals] of EXTRA_ISO_CURRENCIES) {
  if (!SUPPORTED_CURRENCIES[code]) {
    SUPPORTED_CURRENCIES[code] = {
      code,
      name,
      symbol,
      decimals,
      flagCode: code.slice(0, 2).toUpperCase(),
    };
  }
}

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

export function parseMajorToMinor(majorInput: string | number, currencyCode: string): number {
  const { decimals } = getCurrency(currencyCode);
  const raw = String(majorInput).replace(/,/g, '').trim();
  if (!raw || raw === '-' || raw === '.') return 0;

  const isNegative = raw.startsWith('-');
  const unsigned = isNegative ? raw.slice(1) : raw;
  const parts = unsigned.split('.');
  const wholePart = parts[0] ? parts[0].replace(/\D/g, '') || '0' : '0';
  const fracRaw = parts[1] ? parts[1].replace(/\D/g, '') : '';

  const paddedFrac =
    decimals === 0
      ? ''
      : fracRaw.padEnd(decimals, '0').slice(0, decimals);

  const combined = BigInt(wholePart + paddedFrac);
  const signed = isNegative ? -combined : combined;
  return Number(signed);
}

export function formatMinorToMajor(
  minorAmount: number | bigint,
  currencyCode: string,
  includeSymbol = true
): string {
  const { decimals, symbol } = getCurrency(currencyCode);
  const val = BigInt(Math.trunc(Number(minorAmount)));
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

export function parseFxRateToScaled(rateDecimal: string | number): number {
  const num = Number(rateDecimal);
  if (!Number.isFinite(num) || num <= 0) return 100000000;
  return Math.round(num * 100000000);
}

export function formatScaledFxRate(fxRateScaled: number): string {
  const rate = fxRateScaled / 100000000;
  return rate.toFixed(rate >= 10 ? 2 : 4).replace(/\.?0+$/, (m) => (m === '.00' ? '.00' : m));
}

export function convertMinorAmountWithFx(params: {
  originalMinor: number;
  fromCurrency: string;
  toCurrency: string;
  fxRateScaled: number;
  fxStatus: FxStatus;
  dateIso: string;
}): { convertedMinor: number; fxAuditNote: string | null } {
  const from = params.fromCurrency.toUpperCase();
  const to = params.toCurrency.toUpperCase();
  if (from === to) {
    return {
      convertedMinor: params.originalMinor,
      fxAuditNote: null,
    };
  }

  const fromScale = getMinorScaleFactor(from);
  const toScale = getMinorScaleFactor(to);
  const origBig = BigInt(Math.round(params.originalMinor));
  const rateBig = BigInt(Math.round(params.fxRateScaled));

  const numerator = origBig * rateBig * toScale;
  const denominator = fromScale * 100000000n;
  const convertedBig = (numerator + denominator / 2n) / denominator;

  const formattedOrig = formatMinorToMajor(params.originalMinor, from, true);
  const rateReadable = (params.fxRateScaled / 100000000).toFixed(2);
  const statusLabel =
    params.fxStatus === 'cached_offline'
      ? 'cached offline rate'
      : params.fxStatus === 'manual'
      ? 'manual rate'
      : 'live rate';

  return {
    convertedMinor: Number(convertedBig),
    fxAuditNote: `Converted from ${formattedOrig} ${from} at 1 ${from} = ${rateReadable} ${to} (${statusLabel}, ${params.dateIso})`,
  };
}
