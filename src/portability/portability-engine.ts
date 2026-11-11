import * as XLSX from 'xlsx';
import { jsPDF } from 'jspdf';
import {
  ExpenseItem,
  GroupRecord,
  ReceiptAttachment,
  SettlementItem,
} from '../types/ledger';
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

export function exportGroupToExcelBuffer(
  group: GroupRecord,
  expenses: ExpenseItem[],
  settlements: SettlementItem[]
): Uint8Array {
  const activeExpenses = expenses.filter((e) => !e.deletedAt);
  const activeSettlements = settlements.filter((s) => !s.deletedAt);
  const totalSpendMinor = activeExpenses.reduce((acc, e) => acc + e.amountMinor, 0);

  const summaryRows = group.members.map((member) => {
    const totalPaidMinor = activeExpenses.reduce((acc, exp) => {
      const paid = exp.payers.find((p) => p.memberId === member.id)?.paidMinor ?? 0;
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
      GroupName: group.name,
      BaseCurrency: group.baseCurrency,
      TotalGroupSpend: formatMinorToMajor(totalSpendMinor, group.baseCurrency, false),
      MemberName: member.displayName,
      Email: member.invitedEmail ?? '',
      UpiId: member.upiId ?? '',
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
            ExpenseID: exp.id,
            Date: exp.expenseDate,
            Title: exp.title,
            Category: exp.category,
            OriginalCurrency: exp.originalCurrency,
            OriginalAmount: formatMinorToMajor(
              exp.originalAmountMinor,
              exp.originalCurrency,
              false
            ),
            BaseCurrency: exp.groupCurrency,
            ConvertedAmount: formatMinorToMajor(exp.amountMinor, exp.groupCurrency, false),
            SplitMode: exp.splitMode,
            PaidBy: payerNames,
            ReceiptsCount: exp.receipts?.length ?? 0,
          };
          for (const m of group.members) {
            const paid = exp.payers.find((p) => p.memberId === m.id)?.paidMinor ?? 0;
            const owed =
              exp.splits.find((s) => s.memberId === m.id && s.included)?.owedMinor ?? 0;
            row[`${m.displayName} (Net)`] = formatMinorToMajor(
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
            OriginalAmount: '0.00',
            BaseCurrency: group.baseCurrency,
            ConvertedAmount: '0.00',
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
            SettlementID: stl.id,
            Date: stl.settledDate,
            FromMember: fromName,
            ToMember: toName,
            Currency: stl.currency,
            Amount: formatMinorToMajor(stl.amountMinor, stl.currency, false),
            PaymentMethod: stl.paymentMethod.toUpperCase(),
            Reference: stl.paymentReference ?? '',
            Notes: stl.notes ?? '',
          };
        })
      : [
          {
            SettlementID: 'NONE',
            Date: '',
            FromMember: '',
            ToMember: '',
            Currency: group.baseCurrency,
            Amount: '0.00',
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
