import * as XLSX from 'xlsx';
import { jsPDF } from 'jspdf';
import {
  ExpenseCategoryKey,
  ExpenseItem,
  ExpensePayer,
  ExpenseSplitShare,
  FxStatus,
  GroupMember,
  GroupRecord,
  MockLedgerDataset,
  ReceiptAttachment,
  SettlementItem,
} from '../types/ledger';
import {
  SUPPORTED_CURRENCIES,
  convertMinorAmountWithFx,
  formatMinorToMajor,
  parseMajorToMinor,
  tryParseMajorToMinorBigInt,
} from '../domain/money/currencies';
import {
  allocateProportionalMinorAmounts,
  reconcileMultiPayerFxContributions,
  validateExpenseInvariants,
} from '../domain/splits/split-calculator';
import { HLC_RE } from '../server/syncRows';
import { newId } from '../utils/ids';
import { buildPayeeUpiLink } from '../utils/upi-link';

/**
 * Neutralizes spreadsheet formula injection (OWASP CSV Injection) on untrusted text cells
 * starting with '=', '+', '-', '@', '\t', or '\r' while leaving normal strings intact.
 */
export function sanitizeSpreadsheetCell(value: string): string {
  if (!value) return '';
  if (/^[=+\-@\t\r]/.test(value)) {
    return `'${value}`;
  }
  return value;
}

function escapeCsvTextField(raw: string, alwaysQuote = false): string {
  const safe = sanitizeSpreadsheetCell(raw);
  if (alwaysQuote || /[",\r\n]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

/**
 * RFC-4180 compliant CSV row tokenizer supporting quoted fields with embedded commas,
 * escaped double quotes (""), CRLF/LF newlines, and UTF-8 BOM stripping.
 */
export function parseRfc4180CsvRows(csvText: string): string[][] {
  const text = csvText.startsWith('\uFEFF') ? csvText.slice(1) : csvText;
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let inQuotes = false;
  let fieldWasQuoted = false;

  const pushField = () => {
    currentRow.push(fieldWasQuoted ? currentField : currentField.trim());
    currentField = '';
    fieldWasQuoted = false;
  };

  const pushRow = () => {
    if (currentRow.some((cell) => cell.length > 0)) {
      rows.push(currentRow);
    }
    currentRow = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          currentField += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        currentField += ch;
      }
    } else if (ch === '"' && currentField.trim().length === 0) {
      inQuotes = true;
      fieldWasQuoted = true;
      currentField = '';
    } else if (ch === ',') {
      pushField();
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') i++;
      pushField();
      pushRow();
    } else if (ch === '\n') {
      pushField();
      pushRow();
    } else {
      currentField += ch;
    }
  }

  if (currentField.length > 0 || fieldWasQuoted || currentRow.length > 0) {
    pushField();
    pushRow();
  }

  return rows;
}

export function generateWhatsAppGroupSummary(params: {
  groupName: string;
  currency: string;
  totalSpendMinor: number;
  simplifyDebts: boolean;
  netBalances: Array<{ name: string; netMinor: number }>;
  transfers: Array<{
    fromName: string;
    toName: string;
    toUpiId?: string | null;
    amountMinor: number;
  }>;
}): string {
  const normCurrency = params.currency.trim().toUpperCase() || 'INR';
  const zeroStr = formatMinorToMajor(0, normCurrency, false);
  const lines: string[] = [
    `*Wise-Spliter Summary - ${params.groupName}*`,
    `Total Group Spend: ${formatMinorToMajor(params.totalSpendMinor, normCurrency)}`,
    `Mode: ${params.simplifyDebts ? 'Simplified Minimum Transfers' : 'Direct Pairwise Balances'}`,
    '',
    '*Net Positions:*',
  ];

  for (const b of params.netBalances) {
    if (b.netMinor > 0) {
      lines.push(`• ${b.name}: gets back ${formatMinorToMajor(b.netMinor, normCurrency)}`);
    } else if (b.netMinor < 0) {
      lines.push(`• ${b.name}: owes ${formatMinorToMajor(-b.netMinor, normCurrency)}`);
    } else {
      lines.push(`• ${b.name}: settled (${zeroStr})`);
    }
  }

  lines.push('', '*Suggested Settlements:*');
  if (params.transfers.length === 0) {
    lines.push('All balances settled!');
  } else {
    for (const t of params.transfers) {
      const amt = formatMinorToMajor(t.amountMinor, normCurrency);
      lines.push(`• *${t.fromName}* pays *${t.toName}* ${amt}`);
      const upiUri = buildPayeeUpiLink({
        payeeUpiId: t.toUpiId,
        payeeName: t.toName,
        amountMinor: Number.isSafeInteger(t.amountMinor) ? BigInt(t.amountMinor) : 0n,
        currency: normCurrency,
        note: `${params.groupName} settlement`,
      });
      if (upiUri) lines.push(`  UPI Pay: ${upiUri}`);
    }
  }

  return lines.join('\n');
}

export interface ParsedSplitwiseExpense {
  date: string;
  title: string;
  category: ExpenseCategoryKey;
  currency: string;
  amountMinor: number;
  payers: Array<{ memberName: string; paidMinor: number }>;
  splits: Array<{ memberName: string; owedMinor: number }>;
}

export interface ParsedSplitwisePayment {
  date: string;
  title: string;
  fromName: string;
  toName: string;
  currency: string;
  amountMinor: number;
}

export interface ParsedSplitwiseImport {
  memberNames: string[];
  expenses: ParsedSplitwiseExpense[];
  payments: ParsedSplitwisePayment[];
  /** Splitwise "Total balance" rows: currency -> member name -> net minor units. */
  totalBalances: Record<string, Record<string, number>>;
  /** Rows that were not imported, with the line (CSV) or item number (JSON) and why. */
  skipped: Array<{ line: number; title: string; reason: string }>;
  /** Where the imported rows do not add up to a Total balance row. */
  balanceMismatches: Array<{ currency: string; memberName: string; expectedMinor: number; importedMinor: number }>;
  /** Set when the whole file could not be read. */
  error: string | null;
}

interface SplitwiseRow {
  date: string;
  title: string;
  rawCategory: string;
  currency: string;
  amountMinor: number;
  isPayment: boolean;
  deltas: Array<{ memberName: string; deltaMinor: number }>;
}

/** Exact minor units, or null when the text is not a number or does not fit in 2^53-1. Empty is 0. */
function strictMinor(raw: string, currency: string): number | null {
  if (!raw.trim()) return 0;
  const res = tryParseMajorToMinorBigInt(raw, currency);
  if (!res.ok) return null;
  const big = res.value < 0n ? -res.value : res.value;
  return big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(res.value) : null;
}

function isIsoDate(d: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
}

function mapSplitwiseCategory(rawCat: string | undefined): ExpenseCategoryKey {
  const lower = (rawCat ?? '').toLowerCase();
  if (lower.includes('food') || lower.includes('dining') || lower.includes('drink') || lower.includes('restaurant')) {
    return 'food';
  }
  if (lower.includes('hotel') || lower.includes('lodging') || lower.includes('rent')) {
    return lower.includes('rent') ? 'utilities' : 'lodging';
  }
  if (lower.includes('taxi') || lower.includes('cab') || lower.includes('transport') || lower.includes('gas') || lower.includes('parking')) {
    return 'transport';
  }
  if (lower.includes('flight') || lower.includes('plane') || lower.includes('train')) {
    return 'flights';
  }
  if (lower.includes('grocer')) {
    return 'groceries';
  }
  if (lower.includes('utilit') || lower.includes('electric') || lower.includes('internet') || lower.includes('water')) {
    return 'utilities';
  }
  return 'general';
}

/** Adds the row exactly as Splitwise booked it, or returns why it cannot be. */
function addSplitwiseRow(out: ParsedSplitwiseImport, row: SplitwiseRow): string | null {
  const { date, title, currency, amountMinor, deltas } = row;
  if (!Object.hasOwn(SUPPORTED_CURRENCIES, currency)) return `the currency "${currency}" is not supported`;
  if (!isIsoDate(date)) return `the date "${date}" is not a valid YYYY-MM-DD date`;
  if (deltas.length === 0) return 'no people are listed on it';
  if (deltas.reduce((a, d) => a + d.deltaMinor, 0) !== 0) return 'the amounts per person do not add up to zero';

  if (row.isPayment) {
    const givers = deltas.filter((d) => d.deltaMinor > 0).map((d) => ({ ...d }));
    const takers = deltas.filter((d) => d.deltaMinor < 0).map((d) => ({ ...d, deltaMinor: -d.deltaMinor }));
    if (givers.length === 0) return 'the payment has no payer';
    let gi = 0;
    let ti = 0;
    while (gi < givers.length && ti < takers.length) {
      const g = givers[gi]!;
      const t = takers[ti]!;
      const amt = Math.min(g.deltaMinor, t.deltaMinor);
      out.payments.push({ date, title, fromName: g.memberName, toName: t.memberName, currency, amountMinor: amt });
      g.deltaMinor -= amt;
      t.deltaMinor -= amt;
      if (g.deltaMinor === 0) gi++;
      if (t.deltaMinor === 0) ti++;
    }
    return null;
  }

  const payers: Array<{ memberName: string; paidMinor: number }> = [];
  const splits: Array<{ memberName: string; owedMinor: number }> = [];
  const creditors = deltas.filter((d) => d.deltaMinor > 0);
  if (creditors.length === 1) {
    const solePayer = creditors[0]!;
    payers.push({ memberName: solePayer.memberName, paidMinor: amountMinor });
    for (const d of deltas) {
      splits.push({
        memberName: d.memberName,
        owedMinor: d.memberName === solePayer.memberName ? amountMinor - d.deltaMinor : -d.deltaMinor,
      });
    }
  } else if (creditors.length > 1) {
    const totalPositiveDelta = creditors.reduce((acc, c) => acc + c.deltaMinor, 0);
    const selfPool = amountMinor - totalPositiveDelta;
    if (selfPool < 0) return 'the amounts per person are larger than the bill';
    const selfAlloc = allocateProportionalMinorAmounts(
      BigInt(selfPool),
      creditors.map((c) => BigInt(c.deltaMinor)),
      0
    ).amounts;
    const creditorSelfMap = new Map<string, number>();
    creditors.forEach((c, idx) => {
      const selfShare = Number(selfAlloc[idx]!);
      creditorSelfMap.set(c.memberName, selfShare);
      payers.push({ memberName: c.memberName, paidMinor: c.deltaMinor + selfShare });
    });
    for (const d of deltas) {
      splits.push({ memberName: d.memberName, owedMinor: creditorSelfMap.get(d.memberName) ?? -d.deltaMinor });
    }
  } else {
    // Nobody is owed anything, so the first listed person paid only their own share.
    payers.push({ memberName: deltas[0]!.memberName, paidMinor: amountMinor });
    splits.push({ memberName: deltas[0]!.memberName, owedMinor: amountMinor });
  }

  if (
    splits.some((x) => x.owedMinor < 0) ||
    splits.reduce((a, x) => a + x.owedMinor, 0) !== amountMinor ||
    payers.reduce((a, x) => a + x.paidMinor, 0) !== amountMinor
  ) {
    return 'the amounts per person do not match the bill total';
  }
  out.expenses.push({ date, title, category: mapSplitwiseCategory(row.rawCategory), currency, amountMinor, payers, splits });
  return null;
}

const emptySplitwiseImport = (error: string | null = null): ParsedSplitwiseImport => ({
  memberNames: [],
  expenses: [],
  payments: [],
  totalBalances: {},
  skipped: [],
  balanceMismatches: [],
  error,
});

function compareWithTotals(out: ParsedSplitwiseImport): ParsedSplitwiseImport {
  const nets: Record<string, Map<string, number>> = {};
  const add = (cur: string, name: string, v: number) => {
    nets[cur] ??= new Map();
    nets[cur].set(name, (nets[cur].get(name) ?? 0) + v);
  };
  for (const e of out.expenses) {
    for (const p of e.payers) add(e.currency, p.memberName, p.paidMinor);
    for (const x of e.splits) add(e.currency, x.memberName, -x.owedMinor);
  }
  for (const p of out.payments) {
    add(p.currency, p.fromName, p.amountMinor);
    add(p.currency, p.toName, -p.amountMinor);
  }
  for (const [currency, row] of Object.entries(out.totalBalances)) {
    for (const memberName of out.memberNames) {
      const expectedMinor = row[memberName] ?? 0;
      const importedMinor = nets[currency]?.get(memberName) ?? 0;
      if (expectedMinor !== importedMinor) out.balanceMismatches.push({ currency, memberName, expectedMinor, importedMinor });
    }
  }
  return out;
}

export function parseSplitwiseCsv(csvText: string): ParsedSplitwiseImport {
  const out = emptySplitwiseImport();
  const rows = parseRfc4180CsvRows(csvText);
  if (rows.length < 2) return out;

  const headers = rows[0]!.map((h) => h.trim());
  const memberNames = headers.slice(5).filter((m) => m.length > 0);
  out.memberNames = memberNames;

  for (let i = 1; i < rows.length; i++) {
    const cols = rows[i]!;
    const line = i + 1;
    const title = cols[1]?.trim() ?? '';
    const skip = (reason: string) => out.skipped.push({ line, title: title || `Row ${line}`, reason });
    if (cols.length < 5 + memberNames.length) {
      skip(`it has ${cols.length} columns but the header has ${5 + memberNames.length}`);
      continue;
    }
    const date = cols[0]?.trim() ?? '';
    const rawCategory = cols[2]?.trim() ?? '';
    const costStr = cols[3]?.trim() ?? '';
    const currency = (cols[4]?.trim() ?? '').toUpperCase();
    const cells = memberNames.map((name, idx) => ({ name, raw: cols[5 + idx]?.trim() ?? '' }));
    const deltas = cells.map((c) => ({ memberName: c.name, deltaMinor: strictMinor(c.raw, currency) }));
    const badCell = cells.find((_, idx) => deltas[idx]!.deltaMinor === null);
    if (badCell) {
      skip(`the amount for ${badCell.name} ("${badCell.raw}") is not a number`);
      continue;
    }
    const exact = deltas.map((d) => ({ memberName: d.memberName, deltaMinor: d.deltaMinor! }));

    if (title.toLowerCase().includes('total balance')) {
      out.totalBalances[currency] = Object.fromEntries(exact.map((d) => [d.memberName, d.deltaMinor]));
      continue;
    }
    if (!title) {
      skip('it has no description');
      continue;
    }
    const amountMinor = strictMinor(costStr, currency);
    if (amountMinor === null || amountMinor <= 0) {
      skip(`the cost "${costStr}" is not a valid amount above zero`);
      continue;
    }
    const reason = addSplitwiseRow(out, {
      date,
      title,
      rawCategory,
      currency,
      amountMinor,
      isPayment: rawCategory.toLowerCase() === 'payment',
      deltas: exact,
    });
    if (reason) skip(reason);
  }
  return compareWithTotals(out);
}

const str = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '');
const asObj = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** Splitwise API shape: `{ expenses: [...] }`, a bare array, or `{ expense: {...} }` items. */
export function parseSplitwiseJson(jsonText: string): ParsedSplitwiseImport {
  let data: unknown;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return emptySplitwiseImport('This file is not valid JSON, so nothing can be imported from it.');
  }
  const list = Array.isArray(data) ? data : asObj(data)?.expenses;
  if (!Array.isArray(list)) {
    return emptySplitwiseImport('This JSON is not a Splitwise export: it has no list of expenses.');
  }
  const out = emptySplitwiseImport();
  const names = new Set<string>();
  const itemOf = (raw: unknown) => {
    const wrapper = asObj(raw);
    return asObj(wrapper?.expense) ?? wrapper;
  };
  const personOf = (u: unknown) => {
    const entry = asObj(u);
    const person = asObj(entry?.user);
    const name = [str(person?.first_name), str(person?.last_name)].filter(Boolean).join(' ');
    const id = str(person?.id) || str(entry?.user_id);
    return { entry, name, key: id ? `id:${id}` : `name:${name}`, id };
  };
  // Same-name people with different Splitwise ids stay apart: "Sam (Splitwise #1)", "Sam (Splitwise #2)".
  const keysByName = new Map<string, Set<string>>();
  for (const raw of list) {
    const users = itemOf(raw)?.users;
    for (const u of Array.isArray(users) ? users : []) {
      const p = personOf(u);
      if (p.name) keysByName.set(p.name, (keysByName.get(p.name) ?? new Set()).add(p.key));
    }
  }
  const labelOf = (p: { name: string; id: string }) =>
    (keysByName.get(p.name)?.size ?? 0) > 1 ? `${p.name} (${p.id ? `Splitwise #${p.id}` : 'no Splitwise id'})` : p.name;

  list.forEach((raw, idx) => {
    const line = idx + 1;
    const item = itemOf(raw);
    const title = str(item?.description);
    const skip = (reason: string) => out.skipped.push({ line, title: title || `Item ${line}`, reason });
    if (!item) {
      skip('it is not an expense');
      return;
    }
    if (item.deleted_at) return;
    const currency = str(item.currency_code).toUpperCase();
    if (!title) {
      skip('it has no description');
      return;
    }
    const amountMinor = strictMinor(str(item.cost), currency);
    if (amountMinor === null || amountMinor <= 0) {
      skip(`the cost "${str(item.cost)}" is not a valid amount above zero`);
      return;
    }
    if (!Array.isArray(item.users) || item.users.length === 0) {
      skip('no people are listed on it');
      return;
    }
    const byName = new Map<string, number>();
    for (const u of item.users) {
      const p = personOf(u);
      const { entry } = p;
      const name = p.name ? labelOf(p) : '';
      if (!entry || !name) {
        skip('a person on it has no name');
        return;
      }
      const paid = strictMinor(str(entry.paid_share), currency);
      const owed = strictMinor(str(entry.owed_share), currency);
      if (paid === null || owed === null) {
        skip(`the share for ${name} is not a number`);
        return;
      }
      byName.set(name, (byName.get(name) ?? 0) + paid - owed);
    }
    const reason = addSplitwiseRow(out, {
      date: str(item.date).slice(0, 10),
      title,
      rawCategory: str(asObj(item.category)?.name),
      currency,
      amountMinor,
      isPayment: item.payment === true,
      deltas: [...byName].map(([memberName, deltaMinor]) => ({ memberName, deltaMinor })),
    });
    if (reason) skip(reason);
    else for (const n of byName.keys()) names.add(n);
  });
  out.memberNames = [...names];
  return compareWithTotals(out);
}

export function parseSplitwiseImport(text: string): ParsedSplitwiseImport {
  try {
    const trimmed = text.replace(/^\uFEFF/, '').trim();
    return trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed === 'null'
      ? parseSplitwiseJson(trimmed)
      : parseSplitwiseCsv(text);
  } catch {
    return emptySplitwiseImport('This file could not be read as a Splitwise export. Nothing was imported.');
  }
}

const nameKey = (name: string) => name.trim().toLowerCase();

/**
 * Matches Splitwise names to group members by name (case-insensitive), then by the user's explicit
 * mapping. Anything left is returned in `toCreate`; nothing ever falls back to another member.
 */
export function resolveSplitwiseMembers(
  names: string[],
  members: Array<{ id: string; displayName: string }>,
  mapping: Record<string, string>
): { idByName: Map<string, string>; toCreate: string[] } {
  const idByName = new Map<string, string>();
  const toCreate: string[] = [];
  for (const name of names) {
    const mapped = mapping[name];
    const id =
      (mapped && members.some((m) => m.id === mapped) ? mapped : undefined) ??
      members.find((m) => nameKey(m.displayName) === nameKey(name))?.id;
    if (id) idByName.set(name, id);
    else toCreate.push(name);
  }
  return { idByName, toCreate };
}

export interface SplitwiseImportExpense {
  title: string;
  category: ExpenseCategoryKey;
  expenseDate: string;
  originalCurrency: string;
  originalAmountMinor: number;
  fxRateScaled: number;
  fxStatus: FxStatus;
  fxRateDate: string;
  payers: ExpensePayer[];
  splits: ExpenseSplitShare[];
}

export interface SplitwiseImportSettlement {
  fromMemberId: string;
  toMemberId: string;
  amountMinor: number;
  settledDate: string;
  originalCurrency: string;
  originalAmountMinor: number;
  notes: string;
}

/** Rate for 1 unit of a foreign currency in the group currency, or null when none is known. */
export type SplitwiseImportFx = (
  currency: string
) => { fxRateScaled: number; fxStatus: FxStatus; fxRateDate: string } | null;

/** Foreign currencies in the import that `fxFor` has no rate for, sorted. */
export function splitwiseMissingRates(
  parsed: ParsedSplitwiseImport,
  baseCurrency: string,
  fxFor: SplitwiseImportFx
): string[] {
  const base = baseCurrency.trim().toUpperCase();
  const codes = new Set([...parsed.expenses, ...parsed.payments].map((r) => r.currency.toUpperCase()));
  return [...codes].filter((c) => c !== base && !fxFor(c)).sort();
}

/**
 * Turns parsed Splitwise rows into group-currency expenses and settlements. Throws on unresolved names.
 * All or nothing: when a foreign currency has no rate, nothing is planned and `missingRates` lists them.
 */
export function buildSplitwiseImportPlan(params: {
  parsed: ParsedSplitwiseImport;
  idByName: Map<string, string>;
  memberIds: string[];
  baseCurrency: string;
  fxFor: SplitwiseImportFx;
}): {
  expenses: SplitwiseImportExpense[];
  settlements: SplitwiseImportSettlement[];
  missingRates: string[];
} {
  const { parsed, idByName, memberIds } = params;
  const base = params.baseCurrency.trim().toUpperCase();
  const unresolved = parsed.memberNames.filter((n) => !idByName.has(n));
  if (unresolved.length > 0) {
    throw new Error(`Choose who these Splitwise names are first: ${unresolved.join(', ')}`);
  }
  const missingRates = splitwiseMissingRates(parsed, base, params.fxFor);
  if (missingRates.length > 0) return { expenses: [], settlements: [], missingRates };
  const idOf = (name: string) => idByName.get(name)!;
  const fxFor = (currency: string, date: string) =>
    currency === base
      ? { fxRateScaled: 100000000, fxStatus: 'identity' as FxStatus, fxRateDate: date }
      : params.fxFor(currency)!;
  const convert = (amount: number, currency: string, date: string) => {
    const fx = fxFor(currency, date);
    return convertMinorAmountWithFx({
      originalMinor: amount,
      fromCurrency: currency,
      toCurrency: base,
      fxRateScaled: fx.fxRateScaled,
      fxStatus: fx.fxStatus,
      dateIso: fx.fxRateDate,
    }).convertedMinor;
  };
  const sumById = (rows: Array<{ name: string; minor: number }>) => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(idOf(r.name), (m.get(idOf(r.name)) ?? 0) + r.minor);
    return m;
  };

  const expenses: SplitwiseImportExpense[] = [];
  for (const item of parsed.expenses) {
    const currency = item.currency.toUpperCase();
    const fx = fxFor(currency, item.date);
    const convertedMinor = convert(item.amountMinor, currency, item.date);
    const paidById = sumById(item.payers.map((p) => ({ name: p.memberName, minor: p.paidMinor })));
    const owedById = sumById(item.splits.map((s) => ({ name: s.memberName, minor: s.owedMinor })));
    const payers = reconcileMultiPayerFxContributions({
      payers: [...paidById].filter(([, v]) => v > 0).map(([memberId, v]) => ({ memberId, originalPaidMinor: v })),
      originalCurrency: currency,
      groupCurrency: base,
      fxRateScaled: fx.fxRateScaled,
      targetAmountMinor: convertedMinor,
    }).payers;
    const weights = memberIds.map((id) => BigInt(Math.max(0, owedById.get(id) ?? 0)));
    if (payers.length === 0 || weights.every((w) => w === 0n)) continue;
    const baseAlloc = allocateProportionalMinorAmounts(BigInt(convertedMinor), weights, 0).amounts;
    const origAlloc = allocateProportionalMinorAmounts(BigInt(item.amountMinor), weights, 0).amounts;
    expenses.push({
      title: item.title,
      category: item.category,
      expenseDate: item.date,
      originalCurrency: currency,
      originalAmountMinor: item.amountMinor,
      ...fx,
      payers,
      splits: memberIds.map((memberId, idx) => {
        const owed = Number(baseAlloc[idx]!);
        const origOwed = Number(origAlloc[idx]!);
        return {
          memberId,
          included: owed > 0 || origOwed > 0,
          owedMinor: owed,
          originalOwedMinor: origOwed,
          rawInputValue: owed,
          remainderMinor: 0,
        };
      }),
    });
  }

  const settlements: SplitwiseImportSettlement[] = [];
  for (const p of parsed.payments) {
    const fromMemberId = idOf(p.fromName);
    const toMemberId = idOf(p.toName);
    const currency = p.currency.toUpperCase();
    const amountMinor = convert(p.amountMinor, currency, p.date);
    if (fromMemberId === toMemberId || amountMinor <= 0) continue;
    settlements.push({
      fromMemberId,
      toMemberId,
      amountMinor,
      settledDate: p.date,
      originalCurrency: currency,
      originalAmountMinor: p.amountMinor,
      notes: `Imported from Splitwise: ${p.title} (${formatMinorToMajor(p.amountMinor, currency, false)} ${currency})`,
    });
  }
  return { expenses, settlements, missingRates };
}

export type ExportScope = Pick<GroupRecord, 'name' | 'baseCurrency' | 'simplifyDebts'> & {
  members: Array<Pick<GroupMember, 'id' | 'displayName'> & Partial<Pick<GroupMember, 'invitedEmail' | 'upiId'>>>;
};

export const DIRECT_EXPORT_SCOPE = 'direct';

/** Picks one group's (or all direct bills') live rows, inclusive of an optional YYYY-MM-DD range. */
export function selectExportLedger(params: {
  groups: GroupRecord[];
  expenses: ExpenseItem[];
  settlements: SettlementItem[];
  scopeId: string;
  fromDate: string;
  toDate: string;
  directName: string;
  directCurrency: string;
}): { scope: ExportScope; expenses: ExpenseItem[]; settlements: SettlementItem[] } {
  const inRange = (d: string) => {
    const day = d.slice(0, 10);
    return (!params.fromDate || day >= params.fromDate) && (!params.toDate || day <= params.toDate);
  };
  const isDirect = params.scopeId === DIRECT_EXPORT_SCOPE;
  const groupId = isDirect ? null : params.scopeId;
  const expenses = params.expenses.filter((e) => !e.deletedAt && e.groupId === groupId && inRange(e.expenseDate));
  const settlements = params.settlements.filter((s) => !s.deletedAt && s.groupId === groupId && inRange(s.settledDate));
  if (!isDirect) {
    const group = params.groups.find((g) => g.id === groupId);
    return group
      ? { scope: group, expenses, settlements }
      : { scope: { name: params.directName, baseCurrency: params.directCurrency, simplifyDebts: false, members: [] }, expenses: [], settlements: [] };
  }
  const members = new Map<string, ExportScope['members'][number]>();
  for (const e of params.expenses) {
    if (e.groupId !== null) continue;
    for (const p of e.adHocParticipants ?? []) if (!members.has(p.id)) members.set(p.id, p);
  }
  return {
    scope: { name: params.directName, baseCurrency: params.directCurrency, simplifyDebts: false, members: [...members.values()] },
    expenses,
    settlements,
  };
}

export function safeExportFileName(name: string, ext: string, fromDate = '', toDate = ''): string {
  const slug = (s: string) =>
    s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 60).replace(/^-+|-+$/g, '');
  const range = fromDate || toDate ? `-${slug(`${fromDate} to ${toDate}`)}` : '';
  return `wise-spliter-${slug(name) || 'ledger'}${range}.${ext}`;
}

/** Display names by member id; repeated names become "Sam", "Sam [2]" so columns never collide. */
function memberLabels(group: ExportScope): Map<string, string> {
  const used = new Set<string>();
  return new Map(
    group.members.map((m) => {
      let label = m.displayName;
      for (let n = 2; used.has(label); n++) label = `${m.displayName} [${n}]`;
      used.add(label);
      return [m.id, label];
    })
  );
}

export function exportGroupToCsv(
  group: ExportScope,
  expenses: ExpenseItem[],
  settlements: SettlementItem[]
): string {
  const labels = memberLabels(group);
  const memberCols = group.members.map((m) => escapeCsvTextField(labels.get(m.id)!, false));
  const header = ['Type', 'Date', 'Title', 'Category', 'Currency', 'Total', 'SplitMode', ...memberCols].join(',');
  const rows: string[] = [header];

  for (const exp of expenses) {
    if (exp.deletedAt) continue;
    const totalStr = formatMinorToMajor(exp.amountMinor, exp.groupCurrency, false).replace(/,/g, '');
    const memberValues = group.members.map((m) => {
      const paid = exp.payers
        .filter((p) => p.memberId === m.id)
        .reduce((acc, p) => acc + p.paidMinor, 0);
      const owed = exp.splits.find((s) => s.memberId === m.id && s.included)?.owedMinor ?? 0;
      const net = paid - owed;
      return formatMinorToMajor(net, exp.groupCurrency, false).replace(/,/g, '');
    });
    rows.push(
      [
        'EXPENSE',
        escapeCsvTextField(exp.expenseDate, false),
        escapeCsvTextField(exp.title, true),
        escapeCsvTextField(exp.category, false),
        escapeCsvTextField(exp.groupCurrency, false),
        totalStr,
        escapeCsvTextField(exp.splitMode, false),
        ...memberValues,
      ].join(',')
    );
  }

  for (const stl of settlements) {
    if (stl.deletedAt) continue;
    const totalStr = formatMinorToMajor(stl.amountMinor, stl.currency, false).replace(/,/g, '');
    const zeroStr = formatMinorToMajor(0, stl.currency, false).replace(/,/g, '');
    const fromName = group.members.find((m) => m.id === stl.fromMemberId)?.displayName ?? 'Member';
    const toName = group.members.find((m) => m.id === stl.toMemberId)?.displayName ?? 'Member';
    const memberValues = group.members.map((m) => {
      if (m.id === stl.fromMemberId && m.id === stl.toMemberId) return zeroStr;
      if (m.id === stl.fromMemberId) return totalStr;
      if (m.id === stl.toMemberId) return `-${totalStr}`;
      return zeroStr;
    });
    rows.push(
      [
        'SETTLEMENT',
        escapeCsvTextField(stl.settledDate, false),
        escapeCsvTextField(`${fromName} paid ${toName} (${stl.paymentMethod.toUpperCase()})`, true),
        'settlement',
        escapeCsvTextField(stl.currency, false),
        totalStr,
        'direct',
        ...memberValues,
      ].join(',')
    );
  }

  return rows.join('\n');
}

const BASE64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes: Uint8Array): string {
  let result = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < len ? bytes[i + 1]! : 0;
    const b2 = i + 2 < len ? bytes[i + 2]! : 0;
    const triplet = (b0 << 16) | (b1 << 8) | b2;

    result += BASE64_ALPHABET[(triplet >> 18) & 0x3f];
    result += BASE64_ALPHABET[(triplet >> 12) & 0x3f];
    result += i + 1 < len ? BASE64_ALPHABET[(triplet >> 6) & 0x3f] : '=';
    result += i + 2 < len ? BASE64_ALPHABET[triplet & 0x3f] : '=';
  }
  return result;
}

function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[\r\n\s]/g, '');
  if (clean.length === 0) return new Uint8Array(0);
  const padLen = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  const byteLen = Math.floor((clean.length * 3) / 4) - padLen;
  const bytes = new Uint8Array(byteLen);
  let outIdx = 0;

  for (let i = 0; i < clean.length; i += 4) {
    const c0 = BASE64_ALPHABET.indexOf(clean[i]!);
    const c1 = BASE64_ALPHABET.indexOf(clean[i + 1]!);
    const c2 = clean[i + 2] === '=' ? 0 : BASE64_ALPHABET.indexOf(clean[i + 2]!);
    const c3 = clean[i + 3] === '=' ? 0 : BASE64_ALPHABET.indexOf(clean[i + 3]!);

    const triplet = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    if (outIdx < byteLen) bytes[outIdx++] = (triplet >> 16) & 0xff;
    if (outIdx < byteLen) bytes[outIdx++] = (triplet >> 8) & 0xff;
    if (outIdx < byteLen) bytes[outIdx++] = triplet & 0xff;
  }
  return bytes;
}

/** OWASP Password Storage Cheat Sheet: PBKDF2-HMAC-SHA256, 600,000 iterations. */
export const PBKDF2_ITERATIONS = 600_000;
/** Exact labels only. 100k is what the first app version wrote, also when the label is absent. */
const KDF_ITERATIONS = new Map<unknown, number>([
  [`PBKDF2-SHA256-${PBKDF2_ITERATIONS}`, PBKDF2_ITERATIONS],
  ['PBKDF2-SHA256-100000', 100_000],
  [undefined, 100_000],
]);
export const MIN_BACKUP_PASSPHRASE_LENGTH = 12;

export function backupPassphraseProblem(passphrase: string, confirmation: string): string | null {
  if (passphrase.trim().length < MIN_BACKUP_PASSPHRASE_LENGTH) {
    return `Use a passphrase of at least ${MIN_BACKUP_PASSPHRASE_LENGTH} characters. A short sentence works well.`;
  }
  if (passphrase !== confirmation) return 'The two passphrases do not match. Type the same one twice.';
  return null;
}

export class BackupRestoreError extends Error {
  constructor(
    readonly code: 'empty' | 'format' | 'passphrase' | 'schema',
    message: string
  ) {
    super(message);
    this.name = 'BackupRestoreError';
  }
}

async function deriveBackupKey(passphrase: string, salt: Uint8Array, iterations: number, usage: KeyUsage) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage]
  );
}

export async function encryptBackupPayload(payloadJson: string, passphrase: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveBackupKey(passphrase, salt, PBKDF2_ITERATIONS, 'encrypt');
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(payloadJson)
  );

  return JSON.stringify({
    format: 'wise-spliter-encrypted-v1',
    cipher: 'AES-256-GCM',
    kdf: `PBKDF2-SHA256-${PBKDF2_ITERATIONS}`,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  });
}

const NOT_A_BACKUP = 'Decryption failed: this is not a Wise-Spliter backup file. Nothing was changed.';

export async function decryptBackupPayload(encryptedBundle: string, passphrase: string): Promise<string> {
  let parsed: { kdf?: unknown; salt?: unknown; iv?: unknown; ciphertext?: unknown };
  try {
    parsed = JSON.parse(encryptedBundle) as typeof parsed;
  } catch {
    throw new BackupRestoreError('format', NOT_A_BACKUP);
  }
  const iterations = parsed && typeof parsed === 'object' ? KDF_ITERATIONS.get(parsed.kdf) : undefined;
  if (
    iterations === undefined ||
    typeof parsed.salt !== 'string' ||
    typeof parsed.iv !== 'string' ||
    typeof parsed.ciphertext !== 'string'
  ) {
    throw new BackupRestoreError('format', NOT_A_BACKUP);
  }
  const salt = base64ToBytes(parsed.salt);
  const iv = base64ToBytes(parsed.iv);
  const ciphertext = base64ToBytes(parsed.ciphertext);
  if (salt.length < 16 || iv.length !== 12 || ciphertext.length < 16) {
    throw new BackupRestoreError('format', NOT_A_BACKUP);
  }

  try {
    const key = await deriveBackupKey(passphrase, salt, iterations, 'decrypt');
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      ciphertext as BufferSource
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new BackupRestoreError(
      'passphrase',
      'Decryption failed: that passphrase does not open this backup, or the file is damaged. Nothing was changed.'
    );
  }
}

type Check = (v: unknown) => boolean;
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const S: Check = isStr;
const SN: Check = (v) => v === null || isStr(v);
const INT: Check = (v) => Number.isSafeInteger(v);
const NONNEG: Check = (v) => INT(v) && (v as number) >= 0;
const POS: Check = (v) => INT(v) && (v as number) > 0;
const NUM: Check = (v) => typeof v === 'number' && Number.isFinite(v);
const B: Check = (v) => typeof v === 'boolean';
const CUR: Check = (v) => isStr(v) && Object.hasOwn(SUPPORTED_CURRENCIES, v);
const opt = (c: Check): Check => (v) => v === undefined || c(v);
/** The same date, timestamp and clock rules the sync server enforces (syncRows.ts). */
const DAY: Check = (v) => isStr(v) && isIsoDate(v);
const PAYMENT_DAY: Check = (v) =>
  DAY(v) && (v as string) >= '2000-01-01' && (v as string) <= new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const TS: Check = (v) => isStr(v) && v.length <= 40 && !Number.isNaN(Date.parse(v));
const TSN: Check = (v) => v === null || TS(v);
const HLC: Check = (v) => isStr(v) && HLC_RE.test(v);
const oneOf = (...xs: string[]): Check => (v) => isStr(v) && xs.includes(v);
const arrOf = (c: Check): Check => (v) => Array.isArray(v) && v.every(c);
const shape = (spec: Record<string, Check>): Check => (v) =>
  isObj(v) && Object.entries(spec).every(([k, c]) => c(v[k]));

const SPLIT_MODE = oneOf('equal', 'exact', 'percentage', 'shares', 'adjustment');
const FX_STATUS = oneOf('identity', 'live', 'cached_offline', 'manual');
const CATEGORY = oneOf('food', 'lodging', 'transport', 'utilities', 'groceries', 'activities', 'flights', 'shopping', 'general');
const payerShape = shape({ memberId: S, paidMinor: NONNEG, originalPaidMinor: NONNEG });
const splitShape = shape({ memberId: S, included: B, owedMinor: NONNEG, originalOwedMinor: NONNEG, rawInputValue: NUM, remainderMinor: INT });
const memberShape = shape({
  id: S, groupId: S, userId: SN, invitedEmail: SN, displayName: S, avatarInitials: S, upiId: SN,
  role: oneOf('admin', 'member'), memberOrder: INT, joinedAt: TS, claimedAt: TSN, removedAt: opt(TSN),
});
const groupSpec: Record<string, Check> = {
  id: S, name: S, description: S, category: oneOf('trip', 'home', 'couple', 'friends', 'other'), baseCurrency: CUR,
  simplifyDebts: B, expenseSeq: INT, inviteCode: S, createdAt: TS, updatedAt: TS, lastAccessedAt: opt(TS), deletedAt: TSN, hlc: HLC,
  defaultSplitConfig: (v) => v === null || shape({ label: S, splitMode: SPLIT_MODE, memberValues: (m) => isObj(m) && Object.values(m).every(NUM) })(v),
  members: arrOf(memberShape),
};
const expenseSpec: Record<string, Check> = {
  id: S, groupId: SN, title: S, category: CATEGORY, tags: arrOf(S), notes: S, expenseDate: DAY,
  originalCurrency: CUR, originalAmountMinor: POS, groupCurrency: CUR, amountMinor: POS, fxRateScaled: POS,
  fxStatus: FX_STATUS, fxAuditNote: SN, splitMode: SPLIT_MODE, rotationSeed: INT,
  payers: arrOf(payerShape), splits: arrOf(splitShape), currentRevisionId: S, revisionNumber: INT,
  hasUnresolvedConflict: B, conflictRevisionId: SN, createdByMemberId: S, updatedByMemberId: S,
  createdAt: TS, updatedAt: TS, deletedAt: TSN, hlc: HLC,
  adHocParticipants: opt(arrOf(shape({ id: S, displayName: S, invitedEmail: SN, upiId: SN, avatarInitials: S, memberOrder: INT }))),
  comments: arrOf(shape({ id: S, expenseId: S, authorMemberId: S, authorName: S, body: S, createdAt: TS, hlc: opt(HLC), isMine: opt(B), isLegacy: opt(B), editedAt: opt(TSN) })),
  receipts: arrOf(shape({
    id: S, expenseId: S, fileName: S, mimeType: S, sizeKb: NUM, uploadedByName: S, createdAt: S, previewNote: S,
    sha256: opt(S), localDeviceOnly: opt(B), storageBucket: opt(S), storagePath: opt(S),
    dataUrl: opt((v) => isStr(v) && v.startsWith('data:image/')),
  })),
};
const settlementSpec: Record<string, Check> = {
  id: S, groupId: SN, expenseId: opt(SN), batchSettlementId: SN, fromMemberId: S, toMemberId: S, amountMinor: POS,
  currency: CUR, paymentMethod: oneOf('upi', 'cash', 'bank', 'paypal', 'venmo', 'other'), paymentReference: SN,
  notes: S, settledDate: PAYMENT_DAY, createdAt: TS, deletedAt: TSN, hlc: HLC,
};
const revisionSpec: Record<string, Check> = {
  id: S, expenseId: S, groupId: SN, revisionNumber: INT, baseRevisionId: SN, actorMemberId: SN, actorDisplayName: S,
  action: oneOf('created', 'updated', 'deleted', 'restored', 'currency_reconverted', 'conflict_superseded', 'conflict_resolved'),
  changes: arrOf(shape({ field: S, fromValue: S, toValue: S, label: S })),
  snapshot: shape({
    title: S, category: S, amountMinor: POS, originalCurrency: S, originalAmountMinor: POS, fxRateScaled: POS,
    fxStatus: S, splitMode: S, payers: arrOf(payerShape), splits: arrOf(splitShape), notes: S, groupCurrency: opt(S),
  }),
  isConflictBranch: B, createdAt: TS, hlc: HLC,
};
const activitySpec: Record<string, Check> = {
  id: S, groupId: SN, actorMemberId: SN, actorDisplayName: S,
  entityType: oneOf('group', 'member', 'expense', 'settlement', 'comment', 'currency'), entityId: S, action: S,
  summaryText: S, detailNote: S, diffBadges: arrOf(S), createdAt: TS, hlc: HLC,
};

export type LedgerEntities = Pick<
  MockLedgerDataset,
  'groups' | 'expenses' | 'settlements' | 'expenseRevisions' | 'groupActivityLog'
>;

const uniqueIds = (rows: Array<{ id: string }>) => new Set(rows.map((r) => r.id)).size === rows.length;

/** Every item typed, every amount conserved, every reference resolvable; otherwise null. */
const describeRow = (x: unknown, idx: number): string => {
  const o = isObj(x) ? x : {};
  const label = [o.title, o.name, o.summaryText, o.id].find(isStr);
  return label ? `${idx + 1} ("${label.slice(0, 40)}")` : `${idx + 1}`;
};

/** First malformed row of an array, described for people, or null when all rows fit the spec. */
function arrayProblem(v: unknown, spec: Record<string, Check>, label: string): string | null {
  if (!Array.isArray(v)) return `the ${label} list is missing`;
  for (let i = 0; i < v.length; i++) {
    const row: unknown = v[i];
    if (!isObj(row)) return `${label} ${i + 1} is not a record`;
    const key = Object.keys(spec).find((k) => !spec[k]!(row[k]));
    if (key) return `${label} ${describeRow(row, i)} has an invalid "${key}"`;
  }
  return null;
}

/** Every item typed, every amount conserved, every reference resolvable; otherwise why not. */
function ledgerEntitiesProblem(d: unknown, knownGroups: GroupRecord[]): string | LedgerEntities {
  if (!isObj(d)) return 'it is not a ledger';
  const shapeProblem =
    arrayProblem(d.groups, groupSpec, 'group') ??
    arrayProblem(d.expenses, expenseSpec, 'bill') ??
    arrayProblem(d.settlements, settlementSpec, 'payment') ??
    arrayProblem(d.expenseRevisions, revisionSpec, 'bill history entry') ??
    arrayProblem(d.groupActivityLog, activitySpec, 'activity entry');
  if (shapeProblem) return shapeProblem;
  const e = d as unknown as LedgerEntities;
  const lists: Array<[string, Array<{ id: string }>]> = [
    ['groups', e.groups], ['bills', e.expenses], ['payments', e.settlements],
    ['bill history entries', e.expenseRevisions], ['activity entries', e.groupActivityLog],
  ];
  const dup = lists.find(([, rows]) => !uniqueIds(rows));
  if (dup) return `two ${dup[0]} share the same id`;
  const groups = new Map(knownGroups.map((g) => [g.id, g]));
  for (const [i, g] of e.groups.entries()) {
    if (!g.members.every((m) => m.groupId === g.id) || !uniqueIds(g.members)) {
      return `group ${describeRow(g, i)} has members that belong elsewhere or repeat`;
    }
    groups.set(g.id, g);
  }
  const expensesById = new Map(e.expenses.map((x) => [x.id, x]));
  const partiesOf = (groupId: string | null, expenseId?: string | null): Set<string> | null => {
    if (groupId !== null) {
      const g = groups.get(groupId);
      return g ? new Set(g.members.map((m) => m.id)) : null;
    }
    const bill = expenseId ? expensesById.get(expenseId) : undefined;
    return bill ? new Set((bill.adHocParticipants ?? []).map((p) => p.id)) : null;
  };
  for (const [i, x] of e.expenses.entries()) {
    const at = `bill ${describeRow(x, i)}`;
    const g = x.groupId === null ? null : groups.get(x.groupId);
    if (x.groupId !== null && !g) return `${at} belongs to a group that is not in the file or on this device`;
    if (g && x.groupCurrency !== g.baseCurrency) return `${at} is not in its group's currency`;
    if (x.groupId === null && (x.adHocParticipants ?? []).length === 0) return `${at} has no people on it`;
    if (!validateExpenseInvariants(x).valid) return `${at} does not add up: payers and shares must equal the total`;
    const parties = partiesOf(x.groupId, x.id);
    if (!parties || ![...x.payers, ...x.splits].every((p) => parties.has(p.memberId))) {
      return `${at} names someone who is not part of it`;
    }
  }
  for (const [i, r] of e.expenseRevisions.entries()) {
    if (!validateExpenseInvariants(r.snapshot).valid) {
      return `bill history entry ${describeRow(r, i)} does not add up: payers and shares must equal the total`;
    }
  }
  for (const [i, x] of e.settlements.entries()) {
    const at = `payment ${describeRow(x, i)}`;
    if (x.fromMemberId === x.toMemberId) return `${at} is from a person to themselves`;
    const g = x.groupId === null ? null : groups.get(x.groupId);
    if (x.groupId !== null && !g) return `${at} belongs to a group that is not in the file or on this device`;
    if (g && x.currency !== g.baseCurrency) return `${at} is not in its group's currency`;
    if (x.groupId !== null || x.expenseId) {
      const parties = partiesOf(x.groupId, x.expenseId);
      if (!parties || !parties.has(x.fromMemberId) || !parties.has(x.toMemberId)) {
        return `${at} names someone who is not part of it`;
      }
    }
  }
  return {
    groups: e.groups,
    expenses: e.expenses,
    settlements: e.settlements,
    expenseRevisions: e.expenseRevisions,
    groupActivityLog: e.groupActivityLog,
  };
}

function parseLedgerJson(json: string, lead: string, knownGroups: GroupRecord[]): LedgerEntities {
  let data: unknown = null;
  try {
    data = JSON.parse(json);
  } catch {
    // reported below
  }
  const result = ledgerEntitiesProblem(data, knownGroups);
  if (typeof result === 'string') throw new BackupRestoreError('schema', `${lead} (${result}). Nothing was changed.`);
  return result;
}

/** Decrypts and validates a backup. Never resolves on empty, foreign or wrong-passphrase input. */
export async function openBackupBundle(
  bundleText: string,
  passphrase: string,
  knownGroups: GroupRecord[] = []
): Promise<LedgerEntities> {
  if (!bundleText.trim()) {
    throw new BackupRestoreError('empty', 'Choose a .wisesplit file or paste a backup first. Nothing was changed.');
  }
  const json = await decryptBackupPayload(bundleText.trim(), passphrase);
  return parseLedgerJson(
    json,
    'This backup opened, but it is not a complete, valid Wise-Spliter ledger',
    knownGroups
  );
}

/** `plain` is an unencrypted ledger JSON, such as the device backup offered when starting fresh. */
export function backupFileKind(text: string): 'encrypted' | 'plain' | 'unknown' {
  try {
    const d: unknown = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (isObj(d) && isStr(d.ciphertext)) return 'encrypted';
    if (isObj(d) && ('groups' in d || 'expenses' in d || 'currentUser' in d)) return 'plain';
  } catch {
    // not JSON
  }
  return 'unknown';
}

/**
 * Opens an encrypted .wisesplit bundle or a plain ledger JSON. Only the five entity arrays are
 * returned; catalogs, rates and the user identity in a file are never trusted.
 */
export async function openBackupFile(
  text: string,
  passphrase: string,
  knownGroups: GroupRecord[] = []
): Promise<{ entities: LedgerEntities; encrypted: boolean }> {
  if (backupFileKind(text) !== 'plain') {
    return { entities: await openBackupBundle(text, passphrase, knownGroups), encrypted: true };
  }
  return {
    entities: parseLedgerJson(
      text.replace(/^\uFEFF/, ''),
      'This file is not a complete, valid Wise-Spliter ledger, so it was not restored',
      knownGroups
    ),
    encrypted: false,
  };
}

export interface RestoreReport {
  /** Groups, bills and payments taken from the backup: new here, or newer than this device's copy. */
  restored: number;
  /** Rows where this device already has a newer copy, which is kept. */
  keptNewer: number;
  /** Rows identical to this device's copy. */
  unchanged: number;
  takenExpenseIds: string[];
}

/**
 * Per id, the copy with the newer hlc wins, so an older backup never overwrites newer edits or
 * deletions. Everything else, including currentUser and catalogs, stays as it is.
 */
export function mergeLedgerEntities(
  current: MockLedgerDataset,
  restored: LedgerEntities
): { dataset: MockLedgerDataset; report: RestoreReport } {
  const report: RestoreReport = { restored: 0, keptNewer: 0, unchanged: 0, takenExpenseIds: [] };
  const merge = <T extends { id: string; hlc: string }>(mine: T[], theirs: T[], counted: boolean, combine?: (m: T, t: T) => T): T[] => {
    const out = new Map(mine.map((x) => [x.id, x]));
    const taken: T[] = [];
    for (const t of theirs) {
      const m = out.get(t.id);
      const outcome = !m || t.hlc > m.hlc ? 'restored' : t.hlc === m.hlc ? 'unchanged' : 'keptNewer';
      if (counted) report[outcome] += 1;
      if (outcome !== 'restored') continue;
      const row = m && combine ? combine(m, t) : t;
      out.set(t.id, row);
      taken.push(row);
    }
    const takenIds = new Set(taken.map((x) => x.id));
    return [...taken, ...mine.filter((x) => !takenIds.has(x.id))];
  };
  const expenses = merge(current.expenses, restored.expenses, true);
  const mineExpenses = new Map(current.expenses.map((x) => [x.id, x]));
  report.takenExpenseIds = expenses.filter((x) => mineExpenses.get(x.id) !== x).map((x) => x.id);
  return {
    dataset: {
      ...current,
      groups: merge(current.groups, restored.groups, true, (m, t) => ({
        ...t,
        members: [...m.members, ...t.members.filter((x) => !m.members.some((y) => y.id === x.id))],
      })),
      expenses,
      settlements: merge(current.settlements, restored.settlements, true),
      expenseRevisions: merge(current.expenseRevisions, restored.expenseRevisions, false),
      groupActivityLog: merge(current.groupActivityLog, restored.groupActivityLog, false),
    },
    report,
  };
}

/** Receipt image bytes are dropped unless `receiptDataUrls` is given (explicit opt-in). */
export function buildBackupJson(
  dataset: MockLedgerDataset,
  receiptDataUrls: Map<string, string> | null
): string {
  return JSON.stringify({
    ...dataset,
    expenses: dataset.expenses.map((e) => ({
      ...e,
      receipts: (e.receipts ?? []).map(({ dataUrl, ...meta }) => {
        const bytes = receiptDataUrls ? (dataUrl ?? receiptDataUrls.get(meta.id)) : undefined;
        return bytes ? { ...meta, dataUrl: bytes } : meta;
      }),
    })),
  });
}

function ledgerCurrencies(group: ExportScope, expenses: ExpenseItem[], settlements: SettlementItem[]): string[] {
  const set = new Set([...expenses.map((e) => e.groupCurrency), ...settlements.map((s) => s.currency)]);
  return set.size > 0 ? [...set] : [group.baseCurrency];
}

export function exportGroupToExcelBuffer(
  group: ExportScope,
  expenses: ExpenseItem[],
  settlements: SettlementItem[]
): Uint8Array {
  const activeExpenses = expenses.filter((e) => !e.deletedAt);
  const activeSettlements = settlements.filter(
    (s) => !s.deletedAt && s.fromMemberId !== s.toMemberId && s.amountMinor > 0
  );
  const zeroBaseMajor = formatMinorToMajor(0, group.baseCurrency, false);

  const summaryRows = ledgerCurrencies(group, activeExpenses, activeSettlements).flatMap((cur) => {
    const curExpenses = activeExpenses.filter((e) => e.groupCurrency === cur);
    const curSettlements = activeSettlements.filter((s) => s.currency === cur);
    const totalSpendMinor = curExpenses.reduce((acc, e) => acc + e.amountMinor, 0);
    return group.members.map((member) => {
      const totalPaidMinor = curExpenses.reduce(
        (acc, exp) => acc + exp.payers.filter((p) => p.memberId === member.id).reduce((sum, p) => sum + p.paidMinor, 0),
        0
      );
      const totalOwedMinor = curExpenses.reduce(
        (acc, exp) => acc + (exp.splits.find((s) => s.memberId === member.id && s.included)?.owedMinor ?? 0),
        0
      );
      const settlementsSentMinor = curSettlements
        .filter((s) => s.fromMemberId === member.id)
        .reduce((acc, s) => acc + s.amountMinor, 0);
      const settlementsReceivedMinor = curSettlements
        .filter((s) => s.toMemberId === member.id)
        .reduce((acc, s) => acc + s.amountMinor, 0);
      const netMinor = totalPaidMinor - totalOwedMinor + settlementsSentMinor - settlementsReceivedMinor;

      return {
        GroupName: sanitizeSpreadsheetCell(group.name),
        BaseCurrency: cur,
        TotalGroupSpend: formatMinorToMajor(totalSpendMinor, cur, false),
        MemberName: sanitizeSpreadsheetCell(member.displayName),
        Email: sanitizeSpreadsheetCell(member.invitedEmail ?? ''),
        UpiId: sanitizeSpreadsheetCell(member.upiId ?? ''),
        TotalPaid: formatMinorToMajor(totalPaidMinor, cur, false),
        TotalShareOwed: formatMinorToMajor(totalOwedMinor, cur, false),
        SettlementsSent: formatMinorToMajor(settlementsSentMinor, cur, false),
        SettlementsReceived: formatMinorToMajor(settlementsReceivedMinor, cur, false),
        NetBalance: formatMinorToMajor(netMinor, cur, false),
      };
    });
  });

  const labels = memberLabels(group);
  const expenseRows =
    activeExpenses.length > 0
      ? activeExpenses.map((exp) => {
          const payerNames = exp.payers
            .map(
              (p) =>
                group.members.find((m) => m.id === p.memberId)?.displayName ?? p.memberId
            )
            .join(', ');
          const row: Record<string, string | number> = {
            ExpenseID: sanitizeSpreadsheetCell(exp.id),
            Date: sanitizeSpreadsheetCell(exp.expenseDate),
            Title: sanitizeSpreadsheetCell(exp.title),
            Category: sanitizeSpreadsheetCell(exp.category),
            OriginalCurrency: exp.originalCurrency,
            OriginalAmount: formatMinorToMajor(
              exp.originalAmountMinor,
              exp.originalCurrency,
              false
            ),
            BaseCurrency: exp.groupCurrency,
            ConvertedAmount: formatMinorToMajor(exp.amountMinor, exp.groupCurrency, false),
            SplitMode: exp.splitMode,
            PaidBy: sanitizeSpreadsheetCell(payerNames),
            ReceiptsCount: exp.receipts?.length ?? 0,
          };
          for (const m of group.members) {
            const paid = exp.payers
              .filter((p) => p.memberId === m.id)
              .reduce((sum, p) => sum + p.paidMinor, 0);
            const owed =
              exp.splits.find((s) => s.memberId === m.id && s.included)?.owedMinor ?? 0;
            row[`${sanitizeSpreadsheetCell(labels.get(m.id)!)} (Net)`] = formatMinorToMajor(
              paid - owed,
              exp.groupCurrency,
              false
            );
          }
          return row;
        })
      : [
          {
            ExpenseID: 'NONE',
            Date: '',
            Title: 'No active expenses',
            Category: '',
            OriginalCurrency: group.baseCurrency,
            OriginalAmount: zeroBaseMajor,
            BaseCurrency: group.baseCurrency,
            ConvertedAmount: zeroBaseMajor,
            SplitMode: 'equal',
            PaidBy: '',
            ReceiptsCount: 0,
          },
        ];

  const settlementRows =
    activeSettlements.length > 0
      ? activeSettlements.map((stl) => {
          const fromName =
            group.members.find((m) => m.id === stl.fromMemberId)?.displayName ??
            stl.fromMemberId;
          const toName =
            group.members.find((m) => m.id === stl.toMemberId)?.displayName ??
            stl.toMemberId;
          return {
            SettlementID: sanitizeSpreadsheetCell(stl.id),
            Date: sanitizeSpreadsheetCell(stl.settledDate),
            FromMember: sanitizeSpreadsheetCell(fromName),
            ToMember: sanitizeSpreadsheetCell(toName),
            Currency: stl.currency,
            Amount: formatMinorToMajor(stl.amountMinor, stl.currency, false),
            PaymentMethod: stl.paymentMethod.toUpperCase(),
            Reference: sanitizeSpreadsheetCell(stl.paymentReference ?? ''),
            Notes: sanitizeSpreadsheetCell(stl.notes ?? ''),
          };
        })
      : [
          {
            SettlementID: 'NONE',
            Date: '',
            FromMember: '',
            ToMember: '',
            Currency: group.baseCurrency,
            Amount: zeroBaseMajor,
            PaymentMethod: '',
            Reference: '',
            Notes: 'No recorded settlements',
          },
        ];

  const wb = XLSX.utils.book_new();
  const summarySheet = XLSX.utils.json_to_sheet(summaryRows);
  const expensesSheet = XLSX.utils.json_to_sheet(expenseRows);
  const settlementsSheet = XLSX.utils.json_to_sheet(settlementRows);

  XLSX.utils.book_append_sheet(wb, summarySheet, 'Summary');
  XLSX.utils.book_append_sheet(wb, expensesSheet, 'Expenses');
  XLSX.utils.book_append_sheet(wb, settlementsSheet, 'Settlements');

  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  return new Uint8Array(out);
}

export function exportGroupToPdfBytes(
  group: ExportScope,
  expenses: ExpenseItem[],
  settlements: SettlementItem[]
): Uint8Array {
  const activeExpenses = expenses.filter((e) => !e.deletedAt);
  const activeSettlements = settlements.filter((s) => !s.deletedAt);
  const totalSpend = ledgerCurrencies(group, activeExpenses, activeSettlements)
    .map((cur) => {
      const minor = activeExpenses.filter((e) => e.groupCurrency === cur).reduce((acc, e) => acc + e.amountMinor, 0);
      return `${cur} ${formatMinorToMajor(minor, cur, false)}`;
    })
    .join(', ');

  const doc = new jsPDF();
  let y = 18;

  const ensureSpace = (needed: number) => {
    if (y + needed > 278) {
      doc.addPage();
      y = 18;
    }
  };

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text(`Wise-Spliter Statement: ${group.name}`, 14, y);
  y += 8;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.text(
    `Base Currency: ${group.baseCurrency} | Total Spend: ${totalSpend} | Members: ${group.members.length}`,
    14,
    y
  );
  y += 6;
  doc.text(
    `Mode: ${group.simplifyDebts ? 'Simplified Minimum Transfers' : 'Direct Pairwise Balances'} | Active Bills: ${activeExpenses.length} | Settlements: ${activeSettlements.length}`,
    14,
    y
  );
  y += 10;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text('Itemized Expenses', 14, y);
  y += 6;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  if (activeExpenses.length === 0) {
    doc.text('No active expenses recorded in this group.', 14, y);
    y += 6;
  } else {
    for (const exp of activeExpenses) {
      ensureSpace(10);
      const payerNames = exp.payers
        .map(
          (p) => group.members.find((m) => m.id === p.memberId)?.displayName ?? p.memberId
        )
        .join(', ');
      const line = `${exp.expenseDate} | ${exp.title} (${exp.category}) | ${exp.groupCurrency} ${formatMinorToMajor(exp.amountMinor, exp.groupCurrency, false)} | ${exp.splitMode.toUpperCase()} | Paid by ${payerNames}`;
      doc.text(line.slice(0, 110), 14, y);
      y += 5.5;
    }
  }

  y += 5;
  ensureSpace(16);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text('Recorded Settlements', 14, y);
  y += 6;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  if (activeSettlements.length === 0) {
    doc.text('No settlements recorded yet.', 14, y);
    y += 6;
  } else {
    for (const stl of activeSettlements) {
      ensureSpace(8);
      const fromName =
        group.members.find((m) => m.id === stl.fromMemberId)?.displayName ?? stl.fromMemberId;
      const toName =
        group.members.find((m) => m.id === stl.toMemberId)?.displayName ?? stl.toMemberId;
      const line = `${stl.settledDate} | ${fromName} paid ${toName} ${stl.currency} ${formatMinorToMajor(stl.amountMinor, stl.currency, false)} via ${stl.paymentMethod.toUpperCase()}`;
      doc.text(line.slice(0, 110), 14, y);
      y += 5.5;
    }
  }

  const arrayBuffer = doc.output('arraybuffer');
  return new Uint8Array(arrayBuffer);
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/**
 * Pure FIPS 180-4 SHA-256 hex digest for content-addressed device-local & P2P swarm receipt verification.
 */
export function sha256Hex(input: string | Uint8Array): string {
  const msg = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const bitLen = msg.length * 8;
  const paddedLen = (((msg.length + 9 + 63) >> 6) << 6);
  const padded = new Uint8Array(paddedLen);
  padded.set(msg);
  padded[msg.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(paddedLen - 4, bitLen >>> 0, false);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15]!;
      const w2 = w[i - 2]!;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }

    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g; g = f; f = e;
      e = (d + temp1) >>> 0;
      d = c; c = b; b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((v) => v.toString(16).padStart(8, '0'))
    .join('');
}

export function createSampleWebpReceiptAttachment(
  expenseId: string,
  expenseTitle: string,
  uploaderName: string
): ReceiptAttachment {
  const safeTitle = (expenseTitle || 'Expense Receipt')
    .replace(/[<>&"']/g, '')
    .slice(0, 36);
  const safeUploader = (uploaderName || 'Arjun Mehta')
    .replace(/[<>&"']/g, '')
    .slice(0, 28);
  const slug =
    safeTitle
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'sample-receipt';

  const svgMarkup = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">
  <rect width="320" height="180" rx="14" fill="#0f172a"/>
  <rect x="10" y="10" width="300" height="160" rx="10" fill="#1e293b" stroke="#10b981" stroke-width="1.5"/>
  <text x="24" y="38" fill="#10b981" font-family="monospace" font-size="11" font-weight="bold">WISE-SPLITER WEBP RECEIPT</text>
  <text x="24" y="64" fill="#f8fafc" font-family="sans-serif" font-size="14" font-weight="bold">${safeTitle}</text>
  <text x="24" y="88" fill="#94a3b8" font-family="monospace" font-size="11">Expense ID: ${expenseId}</text>
  <text x="24" y="108" fill="#94a3b8" font-family="monospace" font-size="11">Uploaded by: ${safeUploader}</text>
  <text x="24" y="132" fill="#38bdf8" font-family="monospace" font-size="10">IndexedDB: local_receipt_blobs</text>
  <text x="24" y="150" fill="#34d399" font-family="monospace" font-size="10">Storage: Device-Local Only (Zero Cloud Bytes)</text>
</svg>`;

  const base64Svg = bytesToBase64(new TextEncoder().encode(svgMarkup));
  const dataUrl = `data:image/svg+xml;base64,${base64Svg}`;

  return {
    id: newId('rcp'),
    expenseId,
    fileName: `${slug}.webp`,
    mimeType: 'image/webp',
    sizeKb: 18,
    uploadedByName: uploaderName || 'Arjun Mehta',
    createdAt: new Date().toISOString(),
    previewNote:
      'Compressed WebP receipt stored strictly on-device in Local IndexedDB (local_receipt_blobs)',
    sha256: sha256Hex(dataUrl),
    localDeviceOnly: true,
    storageBucket: 'local-device-only',
    storagePath: `local-device/${expenseId}.webp`,
    dataUrl,
  };
}
