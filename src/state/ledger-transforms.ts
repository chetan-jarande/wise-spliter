import type { ExpenseItem, ExpenseRevision, MockLedgerDataset, UserProfile } from '../types/ledger';
import { redenominateExpenseCurrency } from '../domain/splits/split-calculator';

export interface LocalDataCounts {
  groups: number;
  bills: number;
  payments: number;
  /** Bills and payments added inside the bundled sample groups or bills: they cannot be copied to an account. */
  sampleBills: number;
  samplePayments: number;
}

/** Anything the user made while signed out, including bills in sample groups that cannot be copied. */
export const hasLocalData = (c: LocalDataCounts): boolean =>
  c.groups + c.bills + c.payments + c.sampleBills + c.samplePayments > 0;

/**
 * The user's own rows on a signed-out device: groups and direct bills that are not bundled sample
 * data, with everything that belongs to them. Rows inside sample groups stay behind.
 */
export function takeLocalData(d: MockLedgerDataset, sampleIds: ReadonlySet<string>) {
  const groups = d.groups.filter((g) => !sampleIds.has(g.id));
  const groupIds = new Set(groups.map((g) => g.id));
  const expenses = d.expenses.filter(
    (e) => !sampleIds.has(e.id) && (e.groupId === null || groupIds.has(e.groupId))
  );
  const expenseIds = new Set(expenses.map((e) => e.id));
  const settlements = d.settlements.filter(
    (s) =>
      !sampleIds.has(s.id) &&
      (s.groupId !== null ? groupIds.has(s.groupId) : expenseIds.has(s.expenseId ?? ''))
  );
  const owned = new Set([...groupIds, ...expenseIds, ...settlements.map((s) => s.id)]);
  const data: MockLedgerDataset = {
    ...d,
    groups,
    expenses,
    expenseRevisions: d.expenseRevisions.filter((r) => expenseIds.has(r.expenseId)),
    settlements,
    groupActivityLog: d.groupActivityLog.filter(
      (a) => !sampleIds.has(a.id) && ((a.groupId !== null && groupIds.has(a.groupId)) || owned.has(a.entityId))
    ),
  };
  const counts: LocalDataCounts = {
    groups: groups.filter((g) => !g.deletedAt).length,
    bills: expenses.filter((e) => !e.deletedAt).length,
    payments: settlements.filter((s) => !s.deletedAt).length,
    sampleBills: d.expenses.filter(
      (e) => !sampleIds.has(e.id) && !e.deletedAt && e.groupId !== null && sampleIds.has(e.groupId)
    ).length,
    samplePayments: d.settlements.filter(
      (s) => !sampleIds.has(s.id) && !s.deletedAt && sampleIds.has(s.groupId ?? s.expenseId ?? '')
    ).length,
  };
  return { data, counts };
}

/**
 * Moves the signed-out "me" to the signed-in profile: my member row in each group (matched by user
 * id), my participant row on direct bills (matched by email), and the id fields that fall back to my
 * user id when no member matched. Other people's rows and free text are left alone.
 */
export function adoptLocalIdentity(
  local: MockLedgerDataset,
  from: { id: string; email: string },
  to: UserProfile
): MockLedgerDataset {
  const oldEmail = from.email.trim().toLowerCase();
  const id = <T extends string | null>(v: T): T => (v === from.id ? (to.id as T) : v);
  const me = { displayName: to.fullName, avatarInitials: to.avatarInitials };
  const isMyEmail = (e: string | null | undefined) => Boolean(oldEmail) && e?.trim().toLowerCase() === oldEmail;
  return {
    ...local,
    groups: local.groups.map((g) => ({
      ...g,
      members: g.members.map((m) => (m.userId === from.id ? { ...m, ...me, userId: to.id, invitedEmail: to.email } : m)),
    })),
    expenses: local.expenses.map((e) => ({
      ...e,
      ...(e.adHocParticipants
        ? { adHocParticipants: e.adHocParticipants.map((p) => (isMyEmail(p.invitedEmail) ? { ...p, ...me, invitedEmail: to.email } : p)) }
        : {}),
      createdByMemberId: id(e.createdByMemberId),
      updatedByMemberId: id(e.updatedByMemberId),
      payers: e.payers.map((p) => ({ ...p, memberId: id(p.memberId) })),
      splits: e.splits.map((x) => ({ ...x, memberId: id(x.memberId) })),
      comments: e.comments.map((c) => ({ ...c, authorMemberId: id(c.authorMemberId) })),
    })),
    expenseRevisions: local.expenseRevisions.map((r) => ({ ...r, actorMemberId: id(r.actorMemberId) })),
    settlements: local.settlements.map((x) => ({ ...x, fromMemberId: id(x.fromMemberId), toMemberId: id(x.toMemberId) })),
    groupActivityLog: local.groupActivityLog.map((a) => ({ ...a, actorMemberId: id(a.actorMemberId) })),
  };
}

/** Prepends `extra`'s rows to `base`, as if they had just been created; an id in both keeps `extra`'s row. */
export function withExtraRows(base: MockLedgerDataset, extra: MockLedgerDataset): MockLedgerDataset {
  const join = <T extends { id: string }>(add: T[], rows: T[]) => {
    const ids = new Set(add.map((r) => r.id));
    return [...add, ...rows.filter((r) => !ids.has(r.id))];
  };
  return {
    ...base,
    groups: join(extra.groups, base.groups),
    expenses: join(extra.expenses, base.expenses),
    expenseRevisions: join(extra.expenseRevisions, base.expenseRevisions),
    settlements: join(extra.settlements, base.settlements),
    groupActivityLog: join(extra.groupActivityLog, base.groupActivityLog),
  };
}

/**
 * The rate the admin used when converting `groupId` from `from` to `to`, as recorded on the
 * re-conversion revisions (latest wins), or null when none is recorded.
 */
export function recordedConversionRate(
  revisions: ExpenseRevision[],
  groupId: string,
  from: string,
  to: string
): { rateScaled: number; status: 'manual'; rateDate: string } | null {
  let best: ExpenseRevision | null = null;
  for (const r of revisions) {
    const c = r.snapshot.convertedFrom;
    if (r.action !== 'currency_reconverted' || r.groupId !== groupId || !c || c.fxRateScaled <= 0) continue;
    if (c.currency.toUpperCase() !== from.toUpperCase() || r.snapshot.groupCurrency?.toUpperCase() !== to.toUpperCase()) continue;
    if (!best || r.createdAt > best.createdAt) best = r;
  }
  return best ? { rateScaled: best.snapshot.convertedFrom!.fxRateScaled, status: 'manual', rateDate: best.createdAt.slice(0, 10) } : null;
}

export type RevisionRestore = { ok: true; expense: ExpenseItem } | { ok: false; reason: string };

/**
 * The bill as it was in `revisionId`, expressed in the bill's current currency. A snapshot saved in
 * another currency is replayed through each later re-conversion at the rate that conversion used;
 * if any step is unknown the restore is refused rather than guessed.
 * `currencyChangedSince(iso)` says whether the group's currency changed after a time (for old
 * snapshots that do not record their currency).
 */
export function revisionInCurrentCurrency(
  expense: ExpenseItem,
  revisions: ExpenseRevision[],
  revisionId: string,
  currencyChangedSince: (iso: string) => boolean
): RevisionRestore {
  const rev = revisions.find((r) => r.id === revisionId && r.expenseId === expense.id);
  if (!rev) return { ok: false, reason: 'That version of the bill is not on this device yet.' };
  const snap = rev.snapshot;
  const target = expense.groupCurrency;
  const later = revisions
    .filter((r) => r.expenseId === expense.id && r.revisionNumber > rev.revisionNumber && r.action === 'currency_reconverted')
    .sort((a, b) => a.revisionNumber - b.revisionNumber);
  const from =
    snap.groupCurrency ??
    (snap.fxStatus === 'identity' ? snap.originalCurrency : undefined) ??
    later[0]?.snapshot.convertedFrom?.currency ??
    (currencyChangedSince(rev.createdAt) ? undefined : target);
  const refuse = (code: string): RevisionRestore => ({
    ok: false,
    reason: `This version was saved in ${code}, and the rate used to convert it to ${target} is not known, so it was not restored. Edit the bill instead.`,
  });
  if (!from) return refuse('an earlier currency');

  let restored: ExpenseItem = {
    ...expense,
    title: snap.title,
    category: snap.category,
    amountMinor: snap.amountMinor,
    originalCurrency: snap.originalCurrency,
    originalAmountMinor: snap.originalAmountMinor,
    fxRateScaled: snap.fxRateScaled,
    fxStatus: snap.fxStatus,
    splitMode: snap.splitMode,
    payers: snap.payers,
    splits: snap.splits,
    notes: snap.notes,
    groupCurrency: from,
  };
  for (const step of later) {
    if (restored.groupCurrency === target) break;
    const conv = step.snapshot.convertedFrom;
    const to = step.snapshot.groupCurrency;
    if (!conv || !to || conv.currency !== restored.groupCurrency) return refuse(from);
    restored = redenominateExpenseCurrency({ expense: restored, newCurrency: to, mode: 'reconvert', fxRateScaled: conv.fxRateScaled });
  }
  return restored.groupCurrency === target ? { ok: true, expense: restored } : refuse(from);
}
