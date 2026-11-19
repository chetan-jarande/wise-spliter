/**
 * Dev-only Demo Ledger Builder (`src/server/demoSeedBuilder.ts`).
 *
 * Takes `src/data/mock-ledger-data.json` and either returns the canonical demo dataset
 * (`usr_arjun_01`) or deterministically remaps every group, member, expense, split,
 * revision, settlement, direct split, and activity entry so a custom dev user
 * (`{ fullName, email, upiId }`) owns and participates in their own isolated copy
 * of all 4 demo groups and 12 multi-currency bills.
 */

import { createHash } from 'node:crypto';
import type { MockLedgerDataset } from '../types/ledger';
import { SAFE_ID } from './syncRows';

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;
const BASE_USER_ID = 'usr_arjun_01';
const BASE_USER_EMAIL = 'arjun.mehta@example.com';
const BASE_USER_NAME = 'Arjun Mehta';
const BASE_ADHOC_ID = 'adhoc_arjun';

export interface DemoUserSeedInput {
  fullName: string;
  email: string;
  upiId?: string;
}

export interface BuiltDemoSeed {
  profileId: string;
  email: string;
  fullName: string;
  avatarInitials: string;
  upiId: string;
  isCustomUser: boolean;
  dataset: MockLedgerDataset;
}

export function computeInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const raw =
    parts.length >= 2
      ? `${parts[0]![0] ?? ''}${parts[parts.length - 1]![0] ?? ''}`
      : name.trim().slice(0, 2);
  return (raw.toUpperCase().replace(/[^A-Z0-9]/g, '') || 'DV').slice(0, 4);
}

export function assertDevOnlyEnvironment(
  caller: string,
  env: NodeJS.ProcessEnv = process.env,
  supabaseUrl?: string
): void {
  const nodeEnv = (env.NODE_ENV || 'development').trim().toLowerCase();
  if (nodeEnv === 'production') {
    throw new Error(
      `[${caller}] REFUSED: demo seeding is strictly restricted to development (NODE_ENV=production is forbidden).`
    );
  }

  const rawUrl = (supabaseUrl ?? env.SUPABASE_URL ?? '').trim();
  if (!rawUrl) {
    throw new Error(
      `[${caller}] Missing SUPABASE_URL. Set SUPABASE_URL=http://127.0.0.1:54321 in .env.development.`
    );
  }

  let hostname = '';
  try {
    hostname = new URL(rawUrl).hostname;
  } catch {
    throw new Error(`[${caller}] Invalid SUPABASE_URL: ${rawUrl}`);
  }

  if (!['127.0.0.1', 'localhost', '::1'].includes(hostname)) {
    throw new Error(
      `[${caller}] REFUSED: demo seeding only runs against local loopback Supabase (127.0.0.1 / localhost), got "${hostname}".`
    );
  }
}

function suffixId(baseId: string, tag: string, maxLen = 80): string {
  const suffix = `_${tag}`;
  const trimmedBase = baseId.slice(0, Math.max(1, maxLen - suffix.length));
  const candidate = `${trimmedBase}${suffix}`;
  if (!SAFE_ID.test(candidate) && maxLen <= 80) {
    throw new Error(`Generated invalid identifier: ${candidate}`);
  }
  return candidate;
}

function replaceTextIdentity(text: string, fullName: string, email: string): string {
  const firstName = fullName.trim().split(/\s+/)[0] || fullName;
  return text
    .replaceAll(BASE_USER_NAME, fullName)
    .replaceAll(BASE_USER_EMAIL, email)
    .replace(/\bArjun\b/g, firstName);
}

export function buildDemoDatasetForUser(
  template: MockLedgerDataset | Record<string, unknown>,
  user?: Partial<DemoUserSeedInput>
): BuiltDemoSeed {
  const cloned = JSON.parse(JSON.stringify(template)) as MockLedgerDataset;

  const rawEmail = (user?.email ?? BASE_USER_EMAIL).trim().toLowerCase();
  if (!EMAIL_RE.test(rawEmail) || rawEmail.length < 3 || rawEmail.length > 254) {
    throw new Error(`Invalid email "${rawEmail}": must be a valid email address (3..254 chars).`);
  }

  const defaultNameFromEmail = rawEmail
    .split('@')[0]!
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(' ');

  const fullName = (
    user?.fullName?.trim() ||
    (rawEmail === BASE_USER_EMAIL ? BASE_USER_NAME : defaultNameFromEmail) ||
    'Demo User'
  ).slice(0, 100);

  const emailLocal = rawEmail.split('@')[0]!.replace(/[^a-z0-9._-]/g, '') || 'demo.user';
  const upiId = (
    user?.upiId?.trim() ||
    (rawEmail === BASE_USER_EMAIL ? 'arjun.mehta@upi.test' : `${emailLocal}@upi.test`)
  ).slice(0, 100);

  const avatarInitials = computeInitials(fullName);
  const isCustomUser = rawEmail !== BASE_USER_EMAIL;

  if (!isCustomUser) {
    cloned.currentUser = {
      ...cloned.currentUser,
      id: BASE_USER_ID,
      email: BASE_USER_EMAIL,
      fullName,
      avatarInitials,
      upiId,
      googleConnected: false,
    };
    for (const grp of cloned.groups) {
      for (const mem of grp.members) {
        if (mem.userId === BASE_USER_ID) {
          mem.displayName = fullName;
          mem.avatarInitials = avatarInitials;
          mem.upiId = upiId;
          mem.invitedEmail = BASE_USER_EMAIL;
        }
      }
    }
    return {
      profileId: BASE_USER_ID,
      email: BASE_USER_EMAIL,
      fullName,
      avatarInitials,
      upiId,
      isCustomUser: false,
      dataset: cloned,
    };
  }

  const tag = createHash('sha256').update(rawEmail).digest('hex').slice(0, 8);
  const profileId = `usr_demo_${tag}`;
  const nowIso = new Date().toISOString();

  const idMap = new Map<string, string>();
  idMap.set(BASE_USER_ID, profileId);
  idMap.set(BASE_ADHOC_ID, suffixId(BASE_ADHOC_ID, tag));

  for (const g of cloned.groups) {
    idMap.set(g.id, suffixId(g.id, tag));
    for (const m of g.members) {
      idMap.set(m.id, suffixId(m.id, tag));
    }
  }
  for (const e of cloned.expenses) {
    idMap.set(e.id, suffixId(e.id, tag));
    idMap.set(e.currentRevisionId, suffixId(e.currentRevisionId, tag, 110));
    if (e.conflictRevisionId) {
      idMap.set(e.conflictRevisionId, suffixId(e.conflictRevisionId, tag, 110));
    }
    for (const p of e.adHocParticipants ?? []) {
      idMap.set(p.id, suffixId(p.id, tag));
    }
    for (const c of e.comments ?? []) {
      idMap.set(c.id, suffixId(c.id, tag));
    }
    for (const r of e.receipts ?? []) {
      idMap.set(r.id, suffixId(r.id, tag));
    }
  }
  for (const rev of cloned.expenseRevisions) {
    idMap.set(rev.id, suffixId(rev.id, tag, 110));
    if (rev.baseRevisionId) {
      idMap.set(rev.baseRevisionId, suffixId(rev.baseRevisionId, tag, 110));
    }
  }
  for (const s of cloned.settlements) {
    idMap.set(s.id, suffixId(s.id, tag));
    if (s.batchSettlementId) {
      idMap.set(s.batchSettlementId, suffixId(s.batchSettlementId, tag));
    }
  }
  for (const act of cloned.groupActivityLog) {
    idMap.set(act.id, suffixId(act.id, tag, 110));
  }

  const mapId = (id: string): string => idMap.get(id) ?? suffixId(id, tag);
  const remapHlc = (hlc: string): string => hlc.replaceAll(BASE_USER_ID, profileId);

  cloned.currentUser = {
    ...cloned.currentUser,
    id: profileId,
    email: rawEmail,
    fullName,
    avatarInitials,
    upiId,
    googleConnected: false,
    lastSyncedAt: nowIso,
  };

  cloned.groups = cloned.groups.map((g) => {
    const newGroupId = mapId(g.id);
    const remappedDefaultSplit = g.defaultSplitConfig
      ? {
          ...g.defaultSplitConfig,
          memberValues: Object.fromEntries(
            Object.entries(g.defaultSplitConfig.memberValues).map(([mId, val]) => [
              mapId(mId),
              val,
            ])
          ),
        }
      : null;

    return {
      ...g,
      id: newGroupId,
      inviteCode: `${g.inviteCode.slice(0, 26)}-${tag.toUpperCase()}`,
      defaultSplitConfig: remappedDefaultSplit,
      hlc: remapHlc(g.hlc),
      members: g.members.map((m) => {
        const isPrimary = m.userId === BASE_USER_ID;
        return {
          ...m,
          id: mapId(m.id),
          groupId: newGroupId,
          userId: isPrimary ? profileId : m.userId,
          invitedEmail: isPrimary ? rawEmail : m.invitedEmail,
          displayName: isPrimary ? fullName : m.displayName,
          avatarInitials: isPrimary ? avatarInitials : m.avatarInitials,
          upiId: isPrimary ? upiId : m.upiId,
        };
      }),
    };
  });

  cloned.expenses = cloned.expenses.map((e) => ({
    ...e,
    id: mapId(e.id),
    groupId: e.groupId ? mapId(e.groupId) : null,
    notes: replaceTextIdentity(e.notes, fullName, rawEmail),
    adHocParticipants: (e.adHocParticipants ?? []).map((p) => {
      const isPrimary =
        p.id === BASE_ADHOC_ID || p.invitedEmail?.toLowerCase() === BASE_USER_EMAIL;
      return {
        ...p,
        id: mapId(p.id),
        displayName: isPrimary ? fullName : p.displayName,
        invitedEmail: isPrimary ? rawEmail : p.invitedEmail,
        upiId: isPrimary ? upiId : p.upiId,
        avatarInitials: isPrimary ? avatarInitials : p.avatarInitials,
      };
    }),
    payers: e.payers.map((p) => ({
      ...p,
      memberId: mapId(p.memberId),
    })),
    splits: e.splits.map((s) => ({
      ...s,
      memberId: mapId(s.memberId),
    })),
    currentRevisionId: mapId(e.currentRevisionId),
    conflictRevisionId: e.conflictRevisionId ? mapId(e.conflictRevisionId) : null,
    createdByMemberId: mapId(e.createdByMemberId),
    updatedByMemberId: mapId(e.updatedByMemberId),
    hlc: remapHlc(e.hlc),
    comments: (e.comments ?? []).map((c) => ({
      ...c,
      id: mapId(c.id),
      expenseId: mapId(e.id),
      authorMemberId: mapId(c.authorMemberId),
      authorName: c.authorName === BASE_USER_NAME ? fullName : c.authorName,
      body: replaceTextIdentity(c.body, fullName, rawEmail),
    })),
    receipts: (e.receipts ?? []).map((r) => ({
      ...r,
      id: mapId(r.id),
      expenseId: mapId(e.id),
      uploadedByName: r.uploadedByName === BASE_USER_NAME ? fullName : r.uploadedByName,
    })),
  }));

  cloned.expenseRevisions = cloned.expenseRevisions.map((r) => ({
    ...r,
    id: mapId(r.id),
    expenseId: mapId(r.expenseId),
    groupId: r.groupId ? mapId(r.groupId) : null,
    baseRevisionId: r.baseRevisionId ? mapId(r.baseRevisionId) : null,
    actorMemberId: r.actorMemberId ? mapId(r.actorMemberId) : null,
    actorDisplayName: r.actorDisplayName === BASE_USER_NAME ? fullName : r.actorDisplayName,
    changes: r.changes.map((ch) => ({
      ...ch,
      label: replaceTextIdentity(ch.label, fullName, rawEmail),
    })),
    snapshot: {
      ...r.snapshot,
      notes: replaceTextIdentity(r.snapshot.notes, fullName, rawEmail),
      payers: r.snapshot.payers.map((p) => ({ ...p, memberId: mapId(p.memberId) })),
      splits: r.snapshot.splits.map((s) => ({ ...s, memberId: mapId(s.memberId) })),
    },
    hlc: remapHlc(r.hlc),
  }));

  cloned.settlements = cloned.settlements.map((s) => ({
    ...s,
    id: mapId(s.id),
    groupId: s.groupId ? mapId(s.groupId) : null,
    batchSettlementId: s.batchSettlementId ? mapId(s.batchSettlementId) : null,
    fromMemberId: mapId(s.fromMemberId),
    toMemberId: mapId(s.toMemberId),
    notes: replaceTextIdentity(s.notes, fullName, rawEmail),
    hlc: remapHlc(s.hlc),
  }));

  cloned.groupActivityLog = cloned.groupActivityLog.map((act) => ({
    ...act,
    id: mapId(act.id),
    groupId: act.groupId ? mapId(act.groupId) : null,
    actorMemberId: act.actorMemberId ? mapId(act.actorMemberId) : null,
    actorDisplayName: act.actorDisplayName === BASE_USER_NAME ? fullName : act.actorDisplayName,
    entityId: idMap.get(act.entityId) ?? act.entityId,
    summaryText: replaceTextIdentity(act.summaryText, fullName, rawEmail),
    detailNote: replaceTextIdentity(act.detailNote, fullName, rawEmail),
    diffBadges: act.diffBadges.map((b) => replaceTextIdentity(b, fullName, rawEmail)),
    hlc: remapHlc(act.hlc),
  }));

  return {
    profileId,
    email: rawEmail,
    fullName,
    avatarInitials,
    upiId,
    isCustomUser: true,
    dataset: cloned,
  };
}
