/**
 * Trust-boundary validation for sync payloads: camelCase client entities (sync-contract.ts)
 * become bounded snake_case rows for wise_spliter.push_mutations, and pulled rows map back.
 * Authorization is NOT decided here; the push RPC owns it.
 */

import { SUPPORTED_CURRENCIES } from '../domain/money/currencies';
import { validateExpenseInvariants } from '../domain/splits/split-calculator';
import { LIMITS } from '../types/limits';
import type { SplitMode } from '../types/ledger';
import type { SyncEntityType } from '../types/sync-contract';

export class InvalidField extends Error {}

type Obj = Record<string, unknown>;

export const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const LONG_ID = /^[A-Za-z0-9_-]{1,120}$/;
export const HLC_RE = /^[0-9a-f]{12}-[0-9a-f]{4}-[A-Za-z0-9_-]{1,80}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;
const MAX_MONEY = BigInt(Number.MAX_SAFE_INTEGER);

const fail = (field: string, why: string): never => {
  throw new InvalidField(`${field}: ${why}`);
};

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function str(o: Obj, k: string, max: number, opt: { min?: number; nullable?: boolean; dflt?: string } = {}): string | null {
  const v = o[k];
  if (v === undefined || v === null) {
    if (opt.dflt !== undefined) return opt.dflt;
    if (opt.nullable) return null;
    return fail(k, 'required');
  }
  if (typeof v !== 'string') return fail(k, 'must be a string');
  if (v.length > max || v.length < (opt.min ?? 0)) return fail(k, `length must be ${opt.min ?? 0}..${max}`);
  return v;
}

const reqStr = (o: Obj, k: string, max: number, min = 1): string => str(o, k, max, { min }) as string;

function idOf(o: Obj, k: string, opt: { nullable?: boolean; long?: boolean } = {}): string | null {
  const v = str(o, k, 120, { nullable: opt.nullable });
  if (v === null) return null;
  return (opt.long ? LONG_ID : SAFE_ID).test(v) ? v : fail(k, 'invalid identifier');
}

function int(o: Obj, k: string, min: number, max: number, dflt?: number): number {
  const v = o[k] ?? dflt;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) return fail(k, `integer ${min}..${max} required`);
  return v;
}

export type Money = number;

/**
 * Minor units: a safe integer or a decimal string, 0..2^53-1, never rounded. The client keeps money
 * as JS numbers, so larger values are rejected instead of silently losing precision.
 */
export function money(v: unknown, field: string, min = 0n): Money {
  let n: bigint;
  if (typeof v === 'number' && Number.isSafeInteger(v)) n = BigInt(v);
  else if (typeof v === 'string' && /^\d{1,16}$/.test(v)) n = BigInt(v);
  else return fail(field, 'minor units must be a safe integer or decimal string');
  if (n < min || n > MAX_MONEY) return fail(field, 'out of range (0..2^53-1)');
  return Number(n);
}

function bool(o: Obj, k: string, dflt: boolean): boolean {
  const v = o[k] ?? dflt;
  return typeof v === 'boolean' ? v : fail(k, 'boolean required');
}

function ts(o: Obj, k: string, nullable = true): string | null {
  const v = str(o, k, 40, { nullable });
  if (v === null) return null;
  return Number.isNaN(Date.parse(v)) ? fail(k, 'invalid timestamp') : v;
}

function date(o: Obj, k: string): string {
  const v = reqStr(o, k, 10);
  const d = new Date(`${v}T00:00:00Z`);
  return DATE_RE.test(v) && !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v ? v : fail(k, 'YYYY-MM-DD required');
}

/** A payment date: 2000-01-01 up to tomorrow (UTC), so every timezone can record today. */
function pastDate(o: Obj, k: string): string {
  const v = date(o, k);
  const max = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  return v >= '2000-01-01' && v <= max ? v : fail(k, `must be between 2000-01-01 and ${max}`);
}

function currency(o: Obj, k: string): string {
  const v = reqStr(o, k, 3, 3);
  return /^[A-Z]{3}$/.test(v) && SUPPORTED_CURRENCIES[v] ? v : fail(k, 'unsupported currency');
}

function email(o: Obj, k: string): string | null {
  const v = str(o, k, LIMITS.email, { nullable: true });
  if (v === null || v.trim() === '') return null;
  const e = v.trim().toLowerCase();
  return EMAIL_RE.test(e) ? e : fail(k, 'invalid email');
}

function oneOf<T extends string>(o: Obj, k: string, allowed: readonly T[], dflt?: T): T {
  const v = o[k] ?? dflt;
  return allowed.includes(v as T) ? (v as T) : fail(k, `one of ${allowed.join(', ')}`);
}

function arr(o: Obj, k: string, max: number): unknown[] {
  const v = o[k] ?? [];
  if (!Array.isArray(v) || v.length > max) return fail(k, `array of at most ${max}`);
  return v;
}

function objs(o: Obj, k: string, max: number): Obj[] {
  return arr(o, k, max).map((x, i) => (isObj(x) ? x : fail(`${k}[${i}]`, 'object required')));
}

function strArr(o: Obj, k: string, maxItems: number, maxLen: number): string[] {
  return arr(o, k, maxItems).map((x, i) => (typeof x === 'string' && x.length <= maxLen ? x : fail(`${k}[${i}]`, 'string too long')));
}

const SPLIT_MODES = ['equal', 'exact', 'percentage', 'shares', 'adjustment'] as const;
const FX_STATUSES = ['identity', 'live', 'cached_offline', 'manual'] as const;

/** Weight, basis points, exact or +/- adjustment minor units: a signed safe integer. */
function rawInput(v: unknown): number {
  if (v === undefined || v === null) return 0;
  const n = typeof v === 'string' && /^-?\d{1,16}$/.test(v) ? Number(v) : v;
  return typeof n === 'number' && Number.isSafeInteger(n) ? n : fail('rawInputValue', 'signed safe integer required');
}

interface Payer { memberId: string; paidMinor: Money; originalPaidMinor: Money }
interface Split { memberId: string; included: boolean; owedMinor: Money; originalOwedMinor: Money; rawInputValue: number; remainderMinor: number }

function payers(o: Obj, k: string): Payer[] {
  return objs(o, k, 100).map((p) => ({
    memberId: idOf(p, 'memberId') as string,
    paidMinor: money(p.paidMinor, `${k}.paidMinor`),
    originalPaidMinor: money(p.originalPaidMinor ?? p.paidMinor, `${k}.originalPaidMinor`),
  }));
}

function splits(o: Obj, k: string): Split[] {
  return objs(o, k, 100).map((s) => ({
    memberId: idOf(s, 'memberId') as string,
    included: bool(s, 'included', true),
    owedMinor: money(s.owedMinor, `${k}.owedMinor`),
    originalOwedMinor: money(s.originalOwedMinor ?? s.owedMinor, `${k}.originalOwedMinor`),
    rawInputValue: rawInput(s.rawInputValue),
    remainderMinor: int(s, 'remainderMinor', 0, 1000, 0),
  }));
}

/** Conservation in BigInt: sum(payers) == amount == sum(included splits), excluded owe 0. */
export function assertConservation(amount: Money, mode: SplitMode, p: Payer[], s: Split[]): void {
  const total = BigInt(amount);
  const paid = p.reduce((a, x) => a + BigInt(x.paidMinor), 0n);
  const owed = s.filter((x) => x.included).reduce((a, x) => a + BigInt(x.owedMinor), 0n);
  if (paid !== total || owed !== total) fail('amountMinor', `payers ${paid} and splits ${owed} must both equal ${total}`);
  const domain = validateExpenseInvariants({ amountMinor: amount, splitMode: mode, payers: p, splits: s });
  if (!domain.valid) fail('splits', domain.errors.join('; '));
}

function convertedFrom(v: unknown): Obj {
  const c = isObj(v) ? v : fail('snapshot.convertedFrom', 'object required');
  return { currency: currency(c, 'currency'), fxRateScaled: money(c.fxRateScaled, 'convertedFrom.fxRateScaled', 1n) };
}

function snapshot(o: Obj): Obj {
  const s = isObj(o.snapshot) ? o.snapshot : fail('snapshot', 'object required');
  return {
    title: reqStr(s, 'title', LIMITS.expenseTitle),
    category: reqStr(s, 'category', LIMITS.expenseCategory),
    amountMinor: money(s.amountMinor, 'snapshot.amountMinor'),
    originalCurrency: currency(s, 'originalCurrency'),
    originalAmountMinor: money(s.originalAmountMinor, 'snapshot.originalAmountMinor'),
    ...(s.groupCurrency !== undefined && s.groupCurrency !== null ? { groupCurrency: currency(s, 'groupCurrency') } : {}),
    ...(s.convertedFrom !== undefined && s.convertedFrom !== null ? { convertedFrom: convertedFrom(s.convertedFrom) } : {}),
    fxRateScaled: money(s.fxRateScaled, 'snapshot.fxRateScaled', 1n),
    fxStatus: oneOf(s, 'fxStatus', FX_STATUSES),
    splitMode: oneOf(s, 'splitMode', SPLIT_MODES),
    payers: payers(s, 'payers'),
    splits: splits(s, 'splits'),
    notes: str(s, 'notes', LIMITS.expenseNotes, { dflt: '' }),
  };
}

const safeFileName = (name: string): string =>
  name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.{2,}/g, '_').slice(0, 80) || 'receipt.webp';

function receiptMeta(r: Obj): Obj {
  return {
    id: idOf(r, 'id'),
    expenseId: idOf(r, 'expenseId', { nullable: true }),
    fileName: safeFileName(str(r, 'fileName', 200, { dflt: 'receipt.webp' }) as string),
    mimeType: oneOf(r, 'mimeType', ['image/webp', 'image/png', 'image/jpeg', 'application/pdf'] as const, 'image/webp'),
    sizeKb: int(r, 'sizeKb', 0, 102400, 0),
    uploadedByName: str(r, 'uploadedByName', 100, { dflt: '' }),
    createdAt: ts(r, 'createdAt'),
    previewNote: str(r, 'previewNote', 500, { dflt: '' }),
    ...(r.sha256 !== undefined && r.sha256 !== null ? { sha256: sha(r, 'sha256') } : {}),
    localDeviceOnly: true,
    storageBucket: 'local-device-only',
  };
}

function sha(o: Obj, k: string): string | null {
  const v = str(o, k, 64, { nullable: true });
  if (v === null) return null;
  return /^[0-9a-f]{64}$/.test(v) ? v : fail(k, 'sha256 hex required');
}

/** camelCase entity data -> snake_case row. Throws InvalidField. */
export function toDbRow(entity: SyncEntityType, id: string, d: Obj): Obj {
  if (d.id !== undefined && d.id !== id) fail('id', 'does not match mutation id');
  switch (entity) {
    case 'group': {
      // PATCH semantics: only keys present in data are validated and sent; absent means unchanged.
      const row: Obj = {
        name: () => reqStr(d, 'name', LIMITS.groupName),
        description: () => str(d, 'description', LIMITS.groupDescription, { dflt: '' }),
        category: () => oneOf(d, 'category', ['trip', 'home', 'couple', 'friends', 'other'] as const, 'trip'),
        baseCurrency: () => currency(d, 'baseCurrency'),
        simplifyDebts: () => bool(d, 'simplifyDebts', true),
        defaultSplitConfig: () => d.defaultSplitConfig ?? null,
        expenseSeq: () => int(d, 'expenseSeq', 0, 10_000_000, 0),
        createdAt: () => ts(d, 'createdAt'),
        lastAccessedAt: () => ts(d, 'lastAccessedAt'),
        rotateInviteCode: () => bool(d, 'rotateInviteCode', false),
      };
      const col: Record<string, string> = {
        name: 'name', description: 'description', category: 'category', baseCurrency: 'base_currency',
        simplifyDebts: 'simplify_debts', defaultSplitConfig: 'default_split_config', expenseSeq: 'expense_seq',
        createdAt: 'created_at', lastAccessedAt: 'last_accessed_at', rotateInviteCode: 'rotate_invite_code',
      };
      return Object.fromEntries(Object.keys(row).filter((k) => k in d).map((k) => [col[k], (row[k] as () => unknown)()]));
    }
    case 'group_member':
      return {
        group_id: idOf(d, 'groupId'),
        user_id: idOf(d, 'userId', { nullable: true }),
        invited_email: email(d, 'invitedEmail'),
        display_name: reqStr(d, 'displayName', LIMITS.personName),
        avatar_initials: str(d, 'avatarInitials', 4, { dflt: 'GM' }),
        upi_id: str(d, 'upiId', LIMITS.upiId, { nullable: true }),
        role: oneOf(d, 'role', ['admin', 'member'] as const, 'member'),
        member_order: int(d, 'memberOrder', 0, 1000, 0),
        removed_at: ts(d, 'removedAt'),
      };
    case 'expense': {
      const groupId = idOf(d, 'groupId', { nullable: true });
      const amount = money(d.amountMinor, 'amountMinor', 1n);
      const mode = oneOf(d, 'splitMode', SPLIT_MODES);
      const p = payers(d, 'payers');
      const s = splits(d, 'splits');
      assertConservation(amount, mode, p, s);
      return {
        group_id: groupId,
        ad_hoc_participants:
          groupId === null
            ? objs(d, 'adHocParticipants', 100).map((a) => ({
                id: idOf(a, 'id'),
                displayName: reqStr(a, 'displayName', LIMITS.personName),
                invitedEmail: email(a, 'invitedEmail'),
                upiId: str(a, 'upiId', LIMITS.upiId, { nullable: true }),
                avatarInitials: str(a, 'avatarInitials', 4, { dflt: 'US' }),
                memberOrder: int(a, 'memberOrder', 0, 1000, 0),
              }))
            : [],
        title: reqStr(d, 'title', LIMITS.expenseTitle),
        category: reqStr(d, 'category', LIMITS.expenseCategory),
        tags: strArr(d, 'tags', LIMITS.expenseTags, LIMITS.expenseTagLength),
        notes: str(d, 'notes', LIMITS.expenseNotes, { dflt: '' }),
        expense_date: date(d, 'expenseDate'),
        original_currency: currency(d, 'originalCurrency'),
        original_amount_minor: money(d.originalAmountMinor, 'originalAmountMinor', 1n),
        group_currency: currency(d, 'groupCurrency'),
        amount_minor: amount,
        fx_rate_scaled: money(d.fxRateScaled ?? 100000000, 'fxRateScaled', 1n),
        fx_status: oneOf(d, 'fxStatus', FX_STATUSES, 'identity'),
        fx_audit_note: str(d, 'fxAuditNote', LIMITS.fxAuditNote, { nullable: true }),
        split_mode: mode,
        rotation_seed: int(d, 'rotationSeed', 0, 10_000_000, 0),
        payers: p,
        splits: s,
        receipts: objs(d, 'receipts', 20).map(receiptMeta),
        current_revision_id: idOf(d, 'currentRevisionId', { long: true }),
        revision_number: int(d, 'revisionNumber', 1, 100000, 1),
        has_unresolved_conflict: bool(d, 'hasUnresolvedConflict', false),
        conflict_revision_id: idOf(d, 'conflictRevisionId', { nullable: true, long: true }),
        created_by_member_id: idOf(d, 'createdByMemberId'),
        updated_by_member_id: idOf(d, 'updatedByMemberId'),
        created_at: ts(d, 'createdAt'),
        deleted_at: ts(d, 'deletedAt'),
      };
    }
    case 'expense_revision':
      return {
        expense_id: idOf(d, 'expenseId'),
        revision_number: int(d, 'revisionNumber', 1, 100000),
        base_revision_id: idOf(d, 'baseRevisionId', { nullable: true, long: true }),
        actor_member_id: idOf(d, 'actorMemberId'),
        action: oneOf(d, 'action', ['created', 'updated', 'deleted', 'restored', 'currency_reconverted', 'conflict_superseded', 'conflict_resolved'] as const),
        changes_json: objs(d, 'changes', 50).map((c) => ({
          field: reqStr(c, 'field', 60),
          fromValue: str(c, 'fromValue', 200, { dflt: '' }),
          toValue: str(c, 'toValue', 200, { dflt: '' }),
          label: str(c, 'label', 300, { dflt: '' }),
        })),
        snapshot: snapshot(d),
        is_conflict_branch: bool(d, 'isConflictBranch', false),
        created_at: ts(d, 'createdAt'),
      };
    case 'settlement': {
      const from = idOf(d, 'fromMemberId');
      const to = idOf(d, 'toMemberId');
      if (from === to) fail('toMemberId', 'must differ from fromMemberId');
      return {
        group_id: idOf(d, 'groupId', { nullable: true }),
        expense_id: idOf(d, 'expenseId', { nullable: true }),
        batch_settlement_id: idOf(d, 'batchSettlementId', { nullable: true }),
        from_member_id: from,
        to_member_id: to,
        amount_minor: money(d.amountMinor, 'amountMinor', 1n),
        currency: currency(d, 'currency'),
        payment_method: oneOf(d, 'paymentMethod', ['upi', 'cash', 'bank', 'paypal', 'venmo', 'other'] as const, 'upi'),
        payment_reference: str(d, 'paymentReference', LIMITS.paymentReference, { nullable: true }),
        notes: str(d, 'notes', LIMITS.settlementNotes, { dflt: '' }),
        settled_date: pastDate(d, 'settledDate'),
        created_at: ts(d, 'createdAt'),
        deleted_at: ts(d, 'deletedAt'),
      };
    }
    case 'group_activity':
      return {
        group_id: idOf(d, 'groupId', { nullable: true }),
        actor_member_id: idOf(d, 'actorMemberId'),
        entity_type: oneOf(d, 'entityType', ['group', 'member', 'expense', 'settlement', 'comment', 'currency'] as const),
        entity_id: idOf(d, 'entityId', { long: true }),
        action: reqStr(d, 'action', 60),
        summary_text: reqStr(d, 'summaryText', 500),
        detail_note: str(d, 'detailNote', 2000, { dflt: '' }),
        diff_badges: strArr(d, 'diffBadges', 10, 100),
        created_at: ts(d, 'createdAt'),
      };
    case 'expense_comment': {
      const body = reqStr(d, 'body', LIMITS.commentBody);
      return { expense_id: idOf(d, 'expenseId'), body: body.trim() ? body : fail('body', 'must not be blank'), created_at: ts(d, 'createdAt') };
    }
    case 'receipt_pointer': {
      const meta = receiptMeta({ ...d, id });
      const expenseId = idOf(d, 'expenseId') as string;
      return {
        expense_id: expenseId,
        storage_path: `local-device/${expenseId}/${id}-${String(meta.fileName)}`,
        file_name: meta.fileName,
        mime_type: meta.mimeType,
        size_kb: meta.sizeKb,
        preview_note: meta.previewNote,
        sha256_hex: sha(d, 'sha256'),
        created_at: meta.createdAt,
      };
    }
  }
}

const n = (v: unknown): number => Number(v);

/** snake_case row from pull_changes -> camelCase client entity data. */
export function fromDbRow(entity: SyncEntityType, r: Obj | null): Obj | null {
  if (r === null) return null;
  switch (entity) {
    case 'group':
      return {
        id: r.id, name: r.name, description: r.description, category: r.category, baseCurrency: r.base_currency,
        simplifyDebts: r.simplify_debts, defaultSplitConfig: r.default_split_config ?? null,
        expenseSeq: n(r.expense_seq), inviteCode: r.invite_code, createdAt: r.created_at, updatedAt: r.updated_at,
        lastAccessedAt: r.last_accessed_at, deletedAt: r.deleted_at ?? null, hlc: r.hlc,
      };
    case 'group_member':
      if (r.group_id === undefined) return null;
      return {
        id: r.id, groupId: r.group_id, userId: r.user_id ?? null, invitedEmail: r.invited_email ?? null,
        displayName: r.display_name, avatarInitials: r.avatar_initials, upiId: r.upi_id ?? null, role: r.role,
        memberOrder: n(r.member_order), joinedAt: r.joined_at, claimedAt: r.claimed_at ?? null,
        removedAt: r.removed_at ?? null, hlc: r.hlc,
      };
    case 'expense':
      return {
        id: r.id, groupId: r.group_id ?? null,
        ...(r.group_id === null ? { adHocParticipants: r.ad_hoc_participants ?? [] } : {}),
        title: r.title, category: r.category, tags: r.tags ?? [], notes: r.notes ?? '', expenseDate: r.expense_date,
        originalCurrency: r.original_currency, originalAmountMinor: n(r.original_amount_minor),
        groupCurrency: r.group_currency, amountMinor: n(r.amount_minor), fxRateScaled: n(r.fx_rate_scaled),
        fxStatus: r.fx_status, fxAuditNote: r.fx_audit_note ?? null, splitMode: r.split_mode,
        rotationSeed: n(r.rotation_seed), payers: r.payers ?? [], splits: r.splits ?? [],
        currentRevisionId: r.current_revision_id, revisionNumber: n(r.revision_number),
        hasUnresolvedConflict: Boolean(r.has_unresolved_conflict), conflictRevisionId: r.conflict_revision_id ?? null,
        createdByMemberId: r.created_by_member_id, updatedByMemberId: r.updated_by_member_id,
        createdAt: r.created_at, updatedAt: r.updated_at, deletedAt: r.deleted_at ?? null, hlc: r.hlc,
        comments: [], receipts: r.receipts ?? [],
      };
    case 'expense_revision':
      return {
        id: r.id, expenseId: r.expense_id, groupId: r.group_id ?? null, revisionNumber: n(r.revision_number),
        baseRevisionId: r.base_revision_id ?? null, actorMemberId: r.actor_member_id,
        actorDisplayName: r.actor_display_name, action: r.action, changes: r.changes_json ?? [],
        snapshot: r.snapshot, isConflictBranch: Boolean(r.is_conflict_branch), createdAt: r.created_at, hlc: r.hlc,
      };
    case 'settlement':
      return {
        id: r.id, groupId: r.group_id ?? null, expenseId: r.expense_id ?? null, batchSettlementId: r.batch_settlement_id ?? null,
        fromMemberId: r.from_member_id, toMemberId: r.to_member_id, amountMinor: n(r.amount_minor),
        currency: r.currency, paymentMethod: r.payment_method, paymentReference: r.payment_reference ?? null,
        notes: r.notes ?? '', settledDate: r.settled_date, createdAt: r.created_at, deletedAt: r.deleted_at ?? null,
        canEdit: r.can_edit === true, hlc: r.hlc,
      };
    case 'group_activity':
      return {
        id: r.id, groupId: r.group_id ?? null, actorMemberId: r.actor_member_id,
        actorDisplayName: r.actor_display_name, entityType: r.entity_type, entityId: r.entity_id, action: r.action,
        summaryText: r.summary_text, detailNote: r.detail_note ?? '', diffBadges: r.diff_badges ?? [],
        createdAt: r.created_at, hlc: r.hlc,
      };
    case 'receipt_pointer':
      return {
        id: r.id, expenseId: r.expense_id, fileName: r.file_name, mimeType: r.mime_type, sizeKb: n(r.size_kb),
        uploadedByName: r.uploaded_by_name, createdAt: r.created_at, previewNote: r.preview_note ?? '',
        ...(r.sha256_hex ? { sha256: r.sha256_hex } : {}), localDeviceOnly: true,
        storageBucket: 'local-device-only', storagePath: r.storage_path, deletedAt: r.deleted_at ?? null, hlc: r.hlc,
      };
    case 'expense_comment':
      return {
        id: r.id, expenseId: r.expense_id, groupId: r.group_id ?? null, authorMemberId: r.author_member_id ?? null,
        authorName: r.author_name, isMine: r.is_mine === true, body: r.body, createdAt: r.created_at,
        editedAt: r.edited_at ?? null, deletedAt: r.deleted_at ?? null, isLegacy: r.legacy === true, hlc: r.hlc,
      };
  }
}

export const SYNC_ENTITIES: readonly SyncEntityType[] = [
  'group', 'group_member', 'expense', 'expense_revision', 'settlement', 'group_activity', 'receipt_pointer', 'expense_comment',
];

export interface ValidatedMutation {
  entity: SyncEntityType;
  id: string;
  op: 'upsert' | 'delete' | 'restore';
  hlc: string;
  baseHlc?: string;
  data: Obj | null;
}

/** Shape-checks one mutation; returns the DB-ready mutation or a reason. */
export function validateMutation(raw: unknown): { ok: true; m: ValidatedMutation } | { ok: false; id: string; entity: string; reason: string } {
  const o = isObj(raw) ? raw : {};
  const id = typeof o.id === 'string' ? o.id : '';
  const entity = typeof o.entity === 'string' ? o.entity : '';
  try {
    if (!SYNC_ENTITIES.includes(entity as SyncEntityType)) fail('entity', 'unknown entity');
    if (!LONG_ID.test(id)) fail('id', 'invalid identifier');
    if (typeof o.hlc !== 'string' || !HLC_RE.test(o.hlc)) fail('hlc', 'invalid hybrid logical clock');
    const op = o.op === 'delete' || o.op === 'upsert' ? o.op : o.op === 'restore' && entity === 'group' ? 'restore' : fail('op', 'upsert, delete, or restore (groups)');
    const e = entity as SyncEntityType;
    const data = op === 'delete' ? null : toDbRow(e, id, isObj(o.data) ? o.data : fail('data', 'object required'));
    const base = e === 'expense' && op === 'upsert' && o.baseHlc != null ? o.baseHlc : undefined;
    if (base !== undefined && (typeof base !== 'string' || !HLC_RE.test(base))) fail('baseHlc', 'invalid hybrid logical clock');
    return { ok: true, m: { entity: e, id, op, hlc: o.hlc as string, ...(base !== undefined ? { baseHlc: base as string } : {}), data } };
  } catch (err) {
    return { ok: false, id, entity, reason: err instanceof InvalidField ? err.message : 'invalid mutation' };
  }
}
