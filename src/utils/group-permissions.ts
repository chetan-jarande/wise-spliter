import type { GroupMember, GroupRecord } from '../types/ledger';
import type { SyncPushResult } from '../types/sync-contract';

/** Server rule: only a group admin may delete, restore, or change the base currency of a group. */
export function isGroupAdminFor(group: GroupRecord, userId: string): boolean {
  return !!userId && group.members.some((m) => !m.removedAt && m.userId === userId && m.role === 'admin');
}

/** Like Splitwise: any active member may edit, delete or restore the group's expenses and payments. */
export function isActiveGroupMember(group: GroupRecord, userId: string, userEmail = ''): boolean {
  const email = userEmail.trim().toLowerCase();
  return group.members.some(
    (m) => !m.removedAt && (m.userId === userId || (!!email && m.invitedEmail?.trim().toLowerCase() === email))
  );
}

/** Name identity for duplicate checks: NFC, trimmed, inner spaces collapsed, case-folded. */
export function normalizePersonName(name: string): string {
  return name.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** The active member already using this name, if any. Former members never block a name. */
export function activeMemberNamed(group: GroupRecord, name: string) {
  const key = normalizePersonName(name);
  return group.members.find((m) => !m.removedAt && normalizePersonName(m.displayName) === key);
}

/** UPI IDs decide where money goes: only the member themself, or anyone for an unclaimed placeholder. */
export function canEditMemberUpi(member: GroupMember, userId: string): boolean {
  return !member.removedAt && (member.userId === null || (!!userId && member.userId === userId));
}

/** Calm copy for group_member pushes the server refused because they touched someone else's UPI ID. */
export function describeRejectedUpi(
  rejected: SyncPushResult[],
  groups: GroupRecord[],
  userId: string
): string | null {
  for (const r of rejected) {
    if (r.entity !== 'group_member' || r.status !== 'forbidden') continue;
    const m = groups.flatMap((g) => g.members).find((x) => x.id === r.id);
    if (m?.userId && m.userId !== userId) return `Only ${m.displayName} can change their UPI ID.`;
  }
  return null;
}

/** Who did it, for activity and revision rows whose actor may be unknown (null id, blank name). */
export function actorLabel(row: { actorDisplayName?: string | null; groupId: string | null }): string {
  return row.actorDisplayName?.trim() || (row.groupId ? 'Someone in this group' : 'Someone on this bill');
}
