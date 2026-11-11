import { ExpenseItem, GroupRecord, SettlementItem } from '../types/ledger';
import { formatMinorToMajor, parseMajorToMinor } from '../domain/money/currencies';

export function buildUpiPaymentUri(params: {
  payeeUpiId: string;
  payeeName: string;
  amountMinor: number;
  currency: string;
  note: string;
}): string {
  const majorStr = formatMinorToMajor(params.amountMinor, params.currency, false).replace(/,/g, '');
  const query = [
    `pa=${encodeURIComponent(params.payeeUpiId.trim())}`,
    `pn=${encodeURIComponent(params.payeeName.trim())}`,
    `am=${encodeURIComponent(majorStr)}`,
    `cu=${encodeURIComponent(params.currency.toUpperCase())}`,
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
  const lines: string[] = [
    `*Wise-Spliter Summary - ${params.groupName}*`,
    `Total Group Spend: ${formatMinorToMajor(params.totalSpendMinor, params.currency)}`,
    `Mode: ${params.simplifyDebts ? 'Simplified Minimum Transfers' : 'Direct Pairwise Balances'}`,
    '',
    '*Net Positions:*',
  ];

  for (const b of params.netBalances) {
    if (b.netMinor > 0) {
      lines.push(`• ${b.name}: gets back ${formatMinorToMajor(b.netMinor, params.currency)}`);
    } else if (b.netMinor < 0) {
      lines.push(`• ${b.name}: owes ${formatMinorToMajor(-b.netMinor, params.currency)}`);
    } else {
      lines.push(`• ${b.name}: settled (0.00)`);
    }
  }

  lines.push('', '*Suggested Settlements:*');
  if (params.transfers.length === 0) {
    lines.push('All balances settled!');
  } else {
    for (const t of params.transfers) {
      const amt = formatMinorToMajor(t.amountMinor, params.currency);
      lines.push(`• *${t.fromName}* pays *${t.toName}* ${amt}`);
      if (t.toUpiId && params.currency === 'INR') {
        const upiUri = buildUpiPaymentUri({
          payeeUpiId: t.toUpiId,
          payeeName: t.toName,
          amountMinor: t.amountMinor,
          currency: params.currency,
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

export function parseSplitwiseCsv(csvText: string): {
  memberNames: string[];
  expenses: ParsedSplitwiseExpense[];
} {
  const lines = csvText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 2) {
    return { memberNames: [], expenses: [] };
  }

  const headers = lines[0]!.split(',').map((h) => h.trim());
  const memberNames = headers.slice(5);
  const expenses: ParsedSplitwiseExpense[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i]!.split(',').map((c) => c.trim());
    if (cols.length < 5 + memberNames.length) continue;
    const [date, title, rawCat, costStr, currency] = cols;
    if (!date || !title || !costStr || !currency) continue;
    if (title.toLowerCase().includes('total balance')) continue;

    const amountMinor = parseMajorToMinor(costStr, currency);
    if (amountMinor <= 0) continue;

    const netDeltas = memberNames.map((name, idx) => ({
      memberName: name,
      deltaMinor: parseMajorToMinor(cols[5 + idx] ?? '0', currency),
    }));

    // In Splitwise CSV: positive delta = net lent, negative delta = net owed
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
    } else {
      const perPerson = Math.floor(amountMinor / memberNames.length);
      payers.push({ memberName: memberNames[0] ?? 'Member', paidMinor: amountMinor });
      memberNames.forEach((m, idx) => {
        splits.push({
          memberName: m,
          owedMinor: idx === 0 ? amountMinor - perPerson * (memberNames.length - 1) : perPerson,
        });
      });
    }

    expenses.push({
      date,
      title,
      category: rawCat?.toLowerCase().includes('food') ? 'food' : 'general',
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
  const memberCols = group.members.map((m) => m.displayName);
  const header = ['Type', 'Date', 'Title', 'Category', 'Currency', 'Total', 'SplitMode', ...memberCols].join(',');
  const rows: string[] = [header];

  for (const exp of expenses) {
    if (exp.deletedAt) continue;
    const totalStr = formatMinorToMajor(exp.amountMinor, exp.groupCurrency, false).replace(/,/g, '');
    const memberValues = group.members.map((m) => {
      const paid = exp.payers.find((p) => p.memberId === m.id)?.paidMinor ?? 0;
      const owed = exp.splits.find((s) => s.memberId === m.id && s.included)?.owedMinor ?? 0;
      const net = paid - owed;
      return formatMinorToMajor(net, exp.groupCurrency, false).replace(/,/g, '');
    });
    rows.push(
      [
        'EXPENSE',
        exp.expenseDate,
        `"${exp.title.replace(/"/g, '""')}"`,
        exp.category,
        exp.groupCurrency,
        totalStr,
        exp.splitMode,
        ...memberValues,
      ].join(',')
    );
  }

  for (const stl of settlements) {
    if (stl.deletedAt) continue;
    const totalStr = formatMinorToMajor(stl.amountMinor, stl.currency, false).replace(/,/g, '');
    const fromName = group.members.find((m) => m.id === stl.fromMemberId)?.displayName ?? 'Member';
    const toName = group.members.find((m) => m.id === stl.toMemberId)?.displayName ?? 'Member';
    const memberValues = group.members.map((m) => {
      if (m.id === stl.fromMemberId) return totalStr;
      if (m.id === stl.toMemberId) return `-${totalStr}`;
      return '0.00';
    });
    rows.push(
      [
        'SETTLEMENT',
        stl.settledDate,
        `"${fromName} paid ${toName} (${stl.paymentMethod.toUpperCase()})"`,
        'settlement',
        stl.currency,
        totalStr,
        'direct',
        ...memberValues,
      ].join(',')
    );
  }

  return rows.join('\n');
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
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
