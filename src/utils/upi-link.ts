import { formatMinorToMajor } from '../domain/money/currencies';

const UPI_ID = /^[a-z0-9][a-z0-9._-]{1,255}@[a-z][a-z0-9.]{1,63}$/i;

/** handle@psp, as in NPCI VPAs. */
export function isValidUpiId(id: string | null | undefined): boolean {
  return UPI_ID.test(id?.trim() ?? '');
}

/**
 * A `upi://pay` link to the payee's own UPI id, or null when the id is missing or malformed,
 * the amount is not positive, or the currency is not INR (UPI settles in INR only).
 */
export function buildPayeeUpiLink(params: {
  payeeUpiId: string | null | undefined;
  payeeName: string;
  amountMinor: bigint;
  currency: string;
  note: string;
}): string | null {
  const pa = params.payeeUpiId?.trim() ?? '';
  const cu = params.currency.trim().toUpperCase();
  if (!isValidUpiId(pa) || params.amountMinor <= 0n || cu !== 'INR') return null;
  const query = new URLSearchParams({
    pa,
    pn: params.payeeName.trim(),
    am: formatMinorToMajor(params.amountMinor, cu, false).replace(/,/g, ''),
    cu,
    tn: params.note.trim(),
  });
  return `upi://pay?${query.toString().replace(/\+/g, '%20')}`;
}
