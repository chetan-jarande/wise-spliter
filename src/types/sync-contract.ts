import type {
  ExpenseItem,
  ExpenseRevision,
  GroupActivityItem,
  GroupMember,
  GroupRecord,
  ReceiptAttachment,
  SettlementItem,
} from './ledger';

export type SyncEntityType =
  | 'group'
  | 'group_member'
  | 'expense'
  | 'expense_revision'
  | 'settlement'
  | 'group_activity'
  | 'receipt_pointer'
  | 'expense_comment';

/**
 * One comment row (append-only: a new comment is a new row, never a rewrite of the bill).
 * Push sends { expenseId, body }; the server sets createdAt (server time), authorMemberId, authorName,
 * isMine, isLegacy, editedAt and groupId from the verified actor and the bill. Readable by whoever
 * can open the bill; new comments and edits need a live (not deleted) bill. Only the author edits
 * (upsert, newer hlc) or deletes (op 'delete', which blanks the body). body is 1..1000 chars. Pulled with the bill's group or direct-bill scope,
 * including the groupId / expenseId backfills.
 */
export interface SyncExpenseComment {
  id: string;
  expenseId: string;
  groupId: string | null;
  /** The author's group member id, or their participant id on a direct bill. */
  authorMemberId: string | null;
  authorName: string;
  /**
   * Migrated from the old expense JSON: authorName / authorMemberId were written by a client and are
   * unverified (show them as such). Legacy rows are read-only.
   */
  isLegacy: boolean;
  /** True when the pulling account wrote it (edit and delete are offered only then). */
  isMine: boolean;
  body: string;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  hlc: string;
}

/**
 * Shape of `data` per entity, camelCase as in ledger.ts, both directions. The server maps it
 * to snake_case. Money fields accept safe integers or decimal strings of minor units up to
 * 2^53-1. The server overrides ownership fields (createdBy, actor ids/names, userId) and
 * returns `hlc` on every pulled row.
 */
export interface SyncEntityDataMap {
  /**
   * Upserts of an existing group are PATCHes: only the keys present are applied (absent keys keep
   * the stored value), under the newer-hlc guard. Send only the fields the user changed. Creating a
   * group needs name and baseCurrency. Admin-only: changing baseCurrency, rotateInviteCode, op
   * 'delete' and 'restore'. inviteCode is server-generated and ignored; rotateInviteCode: true asks
   * the server for a fresh one (the old code stops working; the new one arrives on pull).
   */
  group: Partial<Omit<GroupRecord, 'members'>> & { rotateInviteCode?: boolean };
  /**
   * upiId decides where money goes: on a claimed member (userId set) only that user may change it
   * ('forbidden' for everyone else, admins included; resend the stored value unchanged). Any active
   * member may set or change an unclaimed placeholder's upiId; the server then writes a
   * 'group_activity' row with action 'upi_changed' (entityType 'member', entityId = the member,
   * summaryText "<actor> changed the UPI ID of <name>", detailNote "ka***@okaxis to at***@okicici";
   * 'none' when empty). Direct bills: only the bill owner or that participant once bound may change
   * a participant's upiId in adHocParticipants; logged the same way with entityType 'expense',
   * entityId = the bill. Server-written activity may have actorMemberId null.
   */
  group_member: GroupMember & { removedAt?: string | null };
  /**
   * groupCurrency must equal the group's current baseCurrency (else 'invalid', code
   * 'currency_mismatch'). A foreign bill keeps originalCurrency / originalAmountMinor /
   * fxRateScaled and stores amountMinor already converted into groupCurrency.
   * comments is legacy and read-only: ignored on push, always [] on pull (use 'expense_comment').
   */
  expense: ExpenseItem;
  /**
   * Pulled actorMemberId is null when the actor of a direct bill is not one of its bound participants
   * (the bill's owner); profile ids are never sent. snapshot may carry groupCurrency and
   * convertedFrom { currency, fxRateScaled }.
   */
  expense_revision: ExpenseRevision;
  /**
   * Group settlements: currency must equal the group's baseCurrency ('currency_mismatch' otherwise);
   * like group expenses, any active member of the group may edit, delete or restore one (the
   * recorder stays the server-set owner). settledDate is YYYY-MM-DD between 2000-01-01 and tomorrow
   * (UTC). canEdit is pull-only, per caller, ignored on push: true for every group settlement you can
   * see; on a direct settlement true only for its recorder (the only one who may edit it).
   */
  settlement: SettlementItem & { canEdit?: boolean };
  group_activity: GroupActivityItem;
  receipt_pointer: Omit<ReceiptAttachment, 'dataUrl'>;
  expense_comment: SyncExpenseComment;
}

export const SYNC_PUSH_MAX_MUTATIONS = 200;
export const SYNC_PULL_MAX_LIMIT = 500;

export interface SyncPushMutation {
  entity: SyncEntityType;
  id: string;
  /**
   * 'delete' soft-deletes. 'restore' (groups only, admins only, newer hlc) clears a group's
   * deletion; a plain 'upsert' never changes a group's deleted state, and a deleted group answers
   * 'stale' to upserts. Expenses and settlements are restored by an 'upsert' with deletedAt null.
   */
  op: 'upsert' | 'delete' | 'restore';
  hlc: string;
  /**
   * Expense upserts of an existing bill: the hlc of the server version this edit started from
   * (the bill's hlc as last pulled or acked). If the stored hlc differs, someone else changed the
   * bill meanwhile, whatever the arrival order, and the server answers 'conflict' instead of
   * overwriting. Omit (or null) only for a new bill. Legacy pushes without it stay last-writer-wins.
   */
  baseHlc?: string | null;
  data: Record<string, unknown> | null;
}

export interface SyncPushRequest {
  mutations: SyncPushMutation[];
}

export type SyncPushStatus = 'applied' | 'stale' | 'forbidden' | 'invalid' | 'conflict';

/**
 * 'conflict' (expenses only): nothing of yours was written to the bill. The server kept your version
 * as revision `conflictRevisionId` (isConflictBranch true, snapshot = your data, hlc = your hlc) and
 * set hasUnresolvedConflict / conflictRevisionId on the bill under a NEW server-minted hlc
 * (server.hlc, after both edits), so every device pulls the marker and any edit still based on an
 * older hlc is a conflict as well. Drop the mutation from the outbox and take `server` as the bill.
 * The marker is server-owned: pushes never set it, and a normal edit keeps it. Resolving, on any device:
 *   Keep mine:   push your version with a fresh hlc, baseHlc = server.hlc,
 *                hasUnresolvedConflict false, conflictRevisionId = the id being resolved.
 *   Keep theirs: push server.data the same way (fresh hlc, baseHlc = server.hlc, same two fields).
 * The server then clears both (conflictRevisionId becomes null). An identical retry of a conflicting
 * push returns the same 'conflict' without changing anything. A resolution that races another edit
 * comes back as 'conflict' again (never silent).
 *
 * 'invalid' with code 'currency_mismatch' (group expenses and settlements): the group's base currency
 * changed (to `baseCurrency`) after this was written. Keep the mutation, pull (the group row arrives
 * no later than the re-converted bills, since the admin pushes the group first), convert your version
 * into baseCurrency (amountMinor, payers, splits; originalCurrency / originalAmountMinor stay, fxRateScaled
 * becomes the original-to-base rate), then re-push with a fresh hlc. For an edit keep the same baseHlc:
 * if the admin re-converted the bill meanwhile, the server reports it as a 'conflict' for the user to pick.
 * The admin's own device must push the group's baseCurrency change in the same batch as (or an earlier
 * batch than) the re-converted or relabelled bills and settlements, or those are refused the same way.
 */
export interface SyncPushResult {
  id: string;
  entity: SyncEntityType;
  status: SyncPushStatus;
  serverSeq?: string;
  /** On 'stale' and 'conflict': the stored row's hlc, so the client can advance its clock past it. */
  serverHlc?: string;
  reason?: string;
  code?: 'currency_mismatch';
  /** On 'currency_mismatch': the group's current base currency. */
  baseCurrency?: string;
  /** On 'conflict': the stored bill (camelCase, with the conflict flag set) and its hlc. */
  server?: { hlc: string; data: Record<string, unknown> };
  /** On 'conflict': id of the revision that holds your version. */
  conflictRevisionId?: string;
}

export interface SyncPushResponse {
  results: SyncPushResult[];
}

/**
 * POST /api/groups/join { code } (signed in). Binds the caller's unclaimed placeholder that carries
 * their email, revives their own earlier member row, or adds a new member row. Then backfill with
 * GET /api/ledger/pull?groupId=<groupId>&cursor=0. Codes are exactly /^WS-[0-9A-F]{10}$/ (the client
 * may upper-case and trim). Errors: 400 malformed code, 403 "An admin removed you from this group; ask
 * them to add you back" (only users who left on their own rejoin by code; an admin re-adds others with
 * a group_member upsert removedAt null), 404 unknown code (counts as a failed attempt), 409 group full
 * (100 active members), 429 rate limited or too many failed attempts (Retry-After).
 * Leaving is a 'group_member' op 'delete' on your own member row (the last admin of a group with
 * other members must promote someone first); admins remove others the same way.
 */
export interface GroupJoinRequest {
  code: string;
}

export interface GroupJoinResponse {
  ok: true;
  groupId: string;
  memberId: string;
  status: 'joined' | 'claimed' | 'rejoined' | 'already_member';
}

export interface SyncPullChange {
  entity: SyncEntityType;
  id: string;
  serverSeq: string;
  deleted: boolean;
  data: Record<string, unknown> | null;
}

export interface SyncPullResponse {
  changes: SyncPullChange[];
  nextCursor: string;
  hasMore: boolean;
  /**
   * Groups the caller joined, re-joined or claimed after `cursor`: their older rows sit below the
   * cursor, so page each with `GET /api/ledger/pull?groupId=<id>&cursor=0` until `hasMore` is false,
   * merge, then continue the main cursor. Empty when cursor is 0.
   */
  backfillGroupIds: string[];
  /**
   * Direct (non-group) bills the caller was added to or bound to (by a later verified sign-in) after
   * `cursor`: page each with `GET /api/ledger/pull?expenseId=<id>&cursor=0` for its older
   * settlements, receipts, revisions and activity, then continue the main cursor. Empty when cursor is 0.
   */
  backfillExpenseIds: string[];
}
