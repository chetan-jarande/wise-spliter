/** Field caps enforced by the server validator (src/server/syncRows.ts) and mirrored by client forms. */
export const LIMITS = {
  expenseTitle: 200,
  expenseCategory: 40,
  expenseNotes: 2000,
  expenseTags: 20,
  expenseTagLength: 40,
  fxAuditNote: 500,
  personName: 100,
  upiId: 100,
  email: 254,
  groupName: 100,
  groupDescription: 500,
  settlementNotes: 500,
  paymentReference: 200,
  commentBody: 1000,
} as const;

/** Problems with a bill's free-text fields, in plain words; empty when the server will accept them. */
export function expenseTextProblems(input: { title: string; notes: string; tags: string[] }): string[] {
  const out: string[] = [];
  if (input.title.length > LIMITS.expenseTitle) out.push(`Keep the title to ${LIMITS.expenseTitle} characters.`);
  if (input.notes.length > LIMITS.expenseNotes) out.push(`Keep notes to ${LIMITS.expenseNotes} characters.`);
  if (input.tags.length > LIMITS.expenseTags) out.push(`Use at most ${LIMITS.expenseTags} tags.`);
  if (input.tags.some((t) => t.length > LIMITS.expenseTagLength)) out.push(`Keep each tag to ${LIMITS.expenseTagLength} characters.`);
  return out;
}
