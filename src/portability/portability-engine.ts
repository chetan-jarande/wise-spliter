import * as XLSX from 'xlsx';
import { jsPDF } from 'jspdf';
import {
  ExpenseItem,
  GroupRecord,
  ReceiptAttachment,
  SettlementItem,
} from '../types/ledger';
import { formatMinorToMajor, parseMajorToMinor } from '../domain/money/currencies';
import { allocateProportionalMinorAmounts } from '../domain/splits/split-calculator';

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

export function buildUpiPaymentUri(params: {
  payeeUpiId: string;
  payeeName: string;
  amountMinor: number;
  currency: string;
  note: string;
}): string {
  const normCurrency = params.currency.trim().toUpperCase() || 'INR';
  const safeAmountMinor = Number.isFinite(params.amountMinor)
    ? Math.max(0, Math.round(params.amountMinor))
    : 0;
  const majorStr = formatMinorToMajor(safeAmountMinor, normCurrency, false).replace(/,/g, '');
  const query = [
    `pa=${encodeURIComponent(params.payeeUpiId.trim())}`,
    `pn=${encodeURIComponent(params.payeeName.trim())}`,
    `am=${encodeURIComponent(majorStr)}`,
    `cu=${encodeURIComponent(normCurrency)}`,
    `tn=${encodeURIComponent(params.note.trim())}`,
  ].join('&');
  return `upi://pay?${query}`;
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
      if (t.toUpiId && normCurrency === 'INR') {
        const upiUri = buildUpiPaymentUri({
          payeeUpiId: t.toUpiId,
          payeeName: t.toName,
          amountMinor: t.amountMinor,
          currency: normCurrency,
          note: `${params.groupName} settlement`,
        });
        lines.push(`  UPI Pay: ${upiUri}`);
      }
    }
  }

  return lines.join('\n');
}

export interface ParsedSplitwiseExpense {
  date: string;
  title: string;
  category: string;
  currency: string;
  amountMinor: number;
  payers: Array<{ memberName: string; paidMinor: number }>;
  splits: Array<{ memberName: string; owedMinor: number }>;
}

function mapSplitwiseCategory(rawCat: string | undefined): string {
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

export function parseSplitwiseCsv(csvText: string): {
  memberNames: string[];
  expenses: ParsedSplitwiseExpense[];
} {
  const rows = parseRfc4180CsvRows(csvText);
  if (rows.length < 2) {
    return { memberNames: [], expenses: [] };
  }

  const headers = rows[0]!.map((h) => h.trim());
  const memberNames = headers.slice(5).filter((m) => m.length > 0);
  const expenses: ParsedSplitwiseExpense[] = [];

  for (let i = 1; i < rows.length; i++) {
    const cols = rows[i]!;
    if (cols.length < 5 + memberNames.length) continue;
    const date = cols[0]?.trim() ?? '';
    const title = cols[1]?.trim() ?? '';
    const rawCat = cols[2]?.trim() ?? '';
    const costStr = cols[3]?.trim() ?? '';
    const currency = (cols[4]?.trim() ?? '').toUpperCase();

    if (!date || !title || !costStr || !currency) continue;
    if (title.toLowerCase().includes('total balance')) continue;
    if (rawCat.toLowerCase() === 'payment') continue;

    const amountMinor = parseMajorToMinor(costStr, currency);
    if (amountMinor <= 0) continue;

    const netDeltas = memberNames.map((name, idx) => ({
      memberName: name,
      deltaMinor: parseMajorToMinor(cols[5 + idx] ?? '0', currency),
    }));

    const payers: Array<{ memberName: string; paidMinor: number }> = [];
    const splits: Array<{ memberName: string; owedMinor: number }> = [];

    const creditors = netDeltas.filter((d) => d.deltaMinor > 0);
    if (creditors.length === 1) {
      const solePayer = creditors[0]!;
      payers.push({ memberName: solePayer.memberName, paidMinor: amountMinor });
      for (const d of netDeltas) {
        if (d.memberName === solePayer.memberName) {
          splits.push({
            memberName: d.memberName,
            owedMinor: Math.max(0, amountMinor - d.deltaMinor),
          });
        } else {
          splits.push({
            memberName: d.memberName,
            owedMinor: Math.max(0, -d.deltaMinor),
          });
        }
      }
    } else if (creditors.length > 1) {
      // Multi-creditor Splitwise row: reconstruct paid & owed while preserving exact net deltas
      const totalPositiveDelta = creditors.reduce((acc, c) => acc + c.deltaMinor, 0);
      const selfPoolBig = BigInt(Math.max(0, amountMinor - totalPositiveDelta));
      const credWeights = creditors.map((c) => BigInt(c.deltaMinor));
      const selfAlloc = allocateProportionalMinorAmounts(selfPoolBig, credWeights, 0).amounts;
      const creditorSelfMap = new Map<string, number>();
      creditors.forEach((c, idx) => {
        const selfShare = Number(selfAlloc[idx]!);
        creditorSelfMap.set(c.memberName, selfShare);
        payers.push({
          memberName: c.memberName,
          paidMinor: c.deltaMinor + selfShare,
        });
      });

      for (const d of netDeltas) {
        if (creditorSelfMap.has(d.memberName)) {
          splits.push({
            memberName: d.memberName,
            owedMinor: creditorSelfMap.get(d.memberName)!,
          });
        } else {
          splits.push({
            memberName: d.memberName,
            owedMinor: Math.max(0, -d.deltaMinor),
          });
        }
      }
    } else {
      const count = memberNames.length;
      if (count > 0) {
        const alloc = allocateProportionalMinorAmounts(
          BigInt(amountMinor),
          memberNames.map(() => 1n),
          0
        ).amounts;
        payers.push({ memberName: memberNames[0]!, paidMinor: amountMinor });
        memberNames.forEach((m, idx) => {
          splits.push({
            memberName: m,
            owedMinor: Number(alloc[idx]!),
          });
        });
      }
    }

    // Reconcile any 1-subunit CSV rounding residual on splits
    const splitSum = splits.reduce((acc, s) => acc + s.owedMinor, 0);
    if (splitSum !== amountMinor && splits.length > 0) {
      const residual = amountMinor - splitSum;
      const targetSplit = splits.find((s) => s.owedMinor + residual >= 0) ?? splits[0]!;
      targetSplit.owedMinor = Math.max(0, targetSplit.owedMinor + residual);
    }

    expenses.push({
      date,
      title,
      category: mapSplitwiseCategory(rawCat),
      currency,
      amountMinor,
      payers,
      splits,
    });
  }

  return { memberNames, expenses };
}

export function exportGroupToCsv(
  group: GroupRecord,
  expenses: ExpenseItem[],
  settlements: SettlementItem[]
): string {
  const memberCols = group.members.map((m) => escapeCsvTextField(m.displayName, false));
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

function bytesToBase64(bytes: Uint8Array): string {
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

export async function encryptBackupPayload(payloadJson: string, passphrase: string): Promise<string> {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(passphrase),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  const key = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(payloadJson)
  );

  return JSON.stringify({
    format: 'wise-spliter-encrypted-v1',
    cipher: 'AES-256-GCM',
    kdf: 'PBKDF2-SHA256-100000',
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  });
}

export async function decryptBackupPayload(encryptedBundle: string, passphrase: string): Promise<string> {
  const parsed = JSON.parse(encryptedBundle) as {
    salt: string;
    iv: string;
    ciphertext: string;
  };
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const salt = base64ToBytes(parsed.salt);
  const iv = base64ToBytes(parsed.iv);
  const ciphertext = base64ToBytes(parsed.ciphertext);

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(passphrase),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  const key = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt.buffer as ArrayBuffer,
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );

  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
    key,
    ciphertext.buffer as ArrayBuffer
  );

  return dec.decode(plaintext);
}

export function exportGroupToExcelBuffer(
  group: GroupRecord,
  expenses: ExpenseItem[],
  settlements: SettlementItem[]
): Uint8Array {
  const activeExpenses = expenses.filter((e) => !e.deletedAt);
  const activeSettlements = settlements.filter(
    (s) => !s.deletedAt && s.fromMemberId !== s.toMemberId && s.amountMinor > 0
  );
  const totalSpendMinor = activeExpenses.reduce((acc, e) => acc + e.amountMinor, 0);
  const zeroBaseMajor = formatMinorToMajor(0, group.baseCurrency, false);

  const summaryRows = group.members.map((member) => {
    const totalPaidMinor = activeExpenses.reduce((acc, exp) => {
      const paid = exp.payers
        .filter((p) => p.memberId === member.id)
        .reduce((sum, p) => sum + p.paidMinor, 0);
      return acc + paid;
    }, 0);
    const totalOwedMinor = activeExpenses.reduce((acc, exp) => {
      const owed = exp.splits.find((s) => s.memberId === member.id && s.included)?.owedMinor ?? 0;
      return acc + owed;
    }, 0);
    const settlementsSentMinor = activeSettlements
      .filter((s) => s.fromMemberId === member.id)
      .reduce((acc, s) => acc + s.amountMinor, 0);
    const settlementsReceivedMinor = activeSettlements
      .filter((s) => s.toMemberId === member.id)
      .reduce((acc, s) => acc + s.amountMinor, 0);
    const netMinor =
      totalPaidMinor - totalOwedMinor + settlementsSentMinor - settlementsReceivedMinor;

    return {
      GroupName: sanitizeSpreadsheetCell(group.name),
      BaseCurrency: group.baseCurrency,
      TotalGroupSpend: formatMinorToMajor(totalSpendMinor, group.baseCurrency, false),
      MemberName: sanitizeSpreadsheetCell(member.displayName),
      Email: sanitizeSpreadsheetCell(member.invitedEmail ?? ''),
      UpiId: sanitizeSpreadsheetCell(member.upiId ?? ''),
      TotalPaid: formatMinorToMajor(totalPaidMinor, group.baseCurrency, false),
      TotalShareOwed: formatMinorToMajor(totalOwedMinor, group.baseCurrency, false),
      SettlementsSent: formatMinorToMajor(settlementsSentMinor, group.baseCurrency, false),
      SettlementsReceived: formatMinorToMajor(
        settlementsReceivedMinor,
        group.baseCurrency,
        false
      ),
      NetBalance: formatMinorToMajor(netMinor, group.baseCurrency, false),
    };
  });

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
            row[`${sanitizeSpreadsheetCell(m.displayName)} (Net)`] = formatMinorToMajor(
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
  group: GroupRecord,
  expenses: ExpenseItem[],
  settlements: SettlementItem[]
): Uint8Array {
  const activeExpenses = expenses.filter((e) => !e.deletedAt);
  const activeSettlements = settlements.filter((s) => !s.deletedAt);
  const totalSpendMinor = activeExpenses.reduce((acc, e) => acc + e.amountMinor, 0);

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
    `Base Currency: ${group.baseCurrency} | Total Spend: ${group.baseCurrency} ${formatMinorToMajor(totalSpendMinor, group.baseCurrency, false)} | Members: ${group.members.length}`,
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
  <text x="24" y="150" fill="#34d399" font-family="monospace" font-size="10">Bucket: wise-spliter-receipts</text>
</svg>`;

  const base64Svg = bytesToBase64(new TextEncoder().encode(svgMarkup));
  const dataUrl = `data:image/svg+xml;base64,${base64Svg}`;

  return {
    id: `rcp_${expenseId}_${Date.now()}`,
    expenseId,
    fileName: `${slug}.webp`,
    mimeType: 'image/webp',
    sizeKb: 18,
    uploadedByName: uploaderName || 'Arjun Mehta',
    createdAt: new Date().toISOString(),
    previewNote:
      'Compressed WebP receipt stored in Local IndexedDB (local_receipt_blobs) & Supabase Storage (wise-spliter-receipts)',
    storageBucket: 'wise-spliter-receipts',
    storagePath: `receipts/${expenseId}.webp`,
    dataUrl,
  };
}
