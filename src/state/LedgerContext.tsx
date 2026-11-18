import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import initialMockData from '../data/mock-ledger-data.json';
import {
  AdHocParticipant,
  DefaultSplitPreset,
  ExpenseCategoryKey,
  ExpenseItem,
  ExpensePayer,
  ExpenseRevision,
  ExpenseSplitShare,
  FxStatus,
  GroupActivityItem,
  GroupMember,
  GroupRecord,
  MockLedgerDataset,
  ReceiptAttachment,
  SettlementItem,
  SplitMode,
  UserProfile,
} from '../types/ledger';
import {
  convertMinorAmountWithFx,
  formatMinorToMajor,
  formatScaledFxRate,
  parseFxRateToScaled,
} from '../domain/money/currencies';
import {
  allocateProportionalMinorAmounts,
  reconcileMultiPayerFxContributions,
  redenominateExpenseCurrency,
  redenominateSettlementCurrency,
  validateExpenseInvariants,
} from '../domain/splits/split-calculator';
import { LIMITS, expenseTextProblems } from '../types/limits';
import { FriendCrossGroupSummary, pickableMembers } from '../domain/ledger/ledger-engine';
import {
  ParsedSplitwiseImport,
  buildSplitwiseImportPlan,
  resolveSplitwiseMembers,
  splitwiseMissingRates,
  buildBackupJson,
  encryptBackupPayload,
  safeExportFileName,
  mergeLedgerEntities,
  type LedgerEntities,
  type RestoreReport,
} from '../portability/portability-engine';
import {
  commitLocalChanges,
  countSyncOutbox,
  deleteReceiptBlobsOwnedBy,
  enqueueSyncOutboxMutations,
  getDeviceId,
  isQuotaError,
  listAllLocalReceiptBlobs,
  loadLegacyDexieSnapshot,
  loadLocalDataset,
  migrateLegacyOutboxComments,
  reassignReceiptBlobs,
  saveReceiptBlobLocally,
  setReceiptOwner,
  setSyncCursor,
  wipeUserScopedData,
} from '../storage/local-db';
import {
  LocalDataCounts,
  adoptLocalIdentity,
  hasLocalData,
  recordedConversionRate,
  revisionInCurrentCurrency,
  takeLocalData,
  withExtraRows,
} from './ledger-transforms';
import {
  SessionIdentity,
  clearBackendSessionToken,
  exchangeGoogleOAuthSession,
  getBrowserSupabaseClient,
  loadPersistedSession,
  markSessionTokenRejected,
  requestAccountDeletion,
  resolveApiUrl,
  isDesignatedDemoUser,
  resolveSessionToken,
  setBackendSessionToken,
} from '../sync-engine/supabase-sync';
import {
  BackfillScope,
  diffDatasetToMutations,
  evictExpenseData,
  evictGroupData,
  makeHlc,
  mergePullChanges,
  newId,
  pullAll,
  pushNow,
  pushOutbox,
  setHlcDeviceId,
  takeServerVersions,
  CurrencyMismatch,
  convertQueuedToBase,
  dropRows,
  forceRows,
  markRejected,
  scopesOf,
  unpinRows,
} from '../sync-engine/sync-client';
import type { GroupJoinResponse, SyncPullChange, SyncPushMutation } from '../types/sync-contract';
import { exportFileCrossPlatform } from '../utils/native-platform';
import {
  activeMemberNamed,
  canEditMemberUpi,
  describeRejectedUpi,
  isGroupAdminFor,
} from '../utils/group-permissions';
import { isValidUpiId } from '../utils/upi-link';
import {
  canChangeGroupSettlement,
  canDeleteDirectSettlement,
  canRecordDirectSettlement,
  describeRejectedSettlements,
  whyCannotRestoreSettlement,
  localIsoDate,
  myParticipantId,
  planDirectSettlements,
} from '../utils/direct-settlements';
import { FxQuote, FxRateTable, fxIntoBase, loadFxRates, quoteFxRate } from '../utils/fx-rates';

export type ActivePageTab = 'home' | 'groups' | 'activity' | 'friends' | 'analytics' | 'portability';

export interface UpsertExpenseInput {
  id?: string;
  groupId: string | null;
  adHocParticipants?: AdHocParticipant[];
  title: string;
  category: ExpenseCategoryKey;
  tags: string[];
  notes: string;
  expenseDate: string;
  originalCurrency: string;
  originalAmountMinor: number;
  fxRateScaled: number;
  fxStatus: FxStatus;
  fxRateDate?: string;
  splitMode: SplitMode;
  payers: ExpensePayer[];
  splits: ExpenseSplitShare[];
  receipts?: ReceiptAttachment[];
  /** hlc of the bill as the editor opened it; a remote change pulled meanwhile then comes back as a conflict. */
  baseHlc?: string;
}

export interface ExpenseModalState {
  isOpen: boolean;
  defaultGroupId: string | null;
  editingExpense: ExpenseItem | null;
}

export interface LedgerContextValue {
  dataset: MockLedgerDataset;
  activeGroupId: string;
  activeGroup: GroupRecord;
  hasGroups: boolean;
  recentGroups: GroupRecord[];
  activePage: ActivePageTab;
  theme: 'dark' | 'light';
  isOnline: boolean;
  pendingOutboxCount: number;
  toastMessage: string | null;
  expenseModalState: ExpenseModalState;
  openAddExpenseModal: (defaultGroupId?: string | null, editingExpense?: ExpenseItem | null) => void;
  closeAddExpenseModal: () => void;
  isHelpModalOpen: boolean;
  setHelpModalOpen: (open: boolean) => void;
  isAuthModalOpen: boolean;
  setAuthModalOpen: (open: boolean) => void;
  isSignedIn: boolean;
  /** Resolves false when the sign-in waits on the unsynced-changes or local-data dialog. */
  adoptSignedInSession: (
    profile: UserProfile,
    token: string | null,
    serverDataset: MockLedgerDataset | null
  ) => Promise<boolean>;
  pendingUserSwitch: { email: string; fullName: string; unsynced: number } | null;
  resolvePendingUserSwitch: (choice: 'sync' | 'discard' | 'cancel') => Promise<void>;
  /** Signing in on a device that holds data made while signed out. */
  pendingLocalImport: ({ email: string; canImport: boolean } & LocalDataCounts) | null;
  /** 'later' keeps everything and stays signed out. */
  resolvePendingLocalImport: (choice: 'import' | 'fresh' | 'later') => Promise<void>;
  /** A row the server refused as new: send it again as it is, or remove it from this device. */
  retryRejected: (entity: 'group' | 'expense' | 'settlement', id: string) => void;
  discardRejected: (entity: 'group' | 'expense' | 'settlement', id: string) => void;
  /** Signing out (or resetting) while changes still wait to sync. */
  pendingSignOut: { unsynced: number } | null;
  resolvePendingSignOut: (choice: 'sync' | 'discard' | 'cancel') => Promise<void>;
  /** Saves this device's ledger, with its receipt photos, as an encrypted .wisesplit file. */
  downloadLocalBackup: (passphrase: string) => Promise<void>;
  /** Resolves false when the user chose to stay signed in at the unsynced-changes warning. */
  signOut: () => Promise<boolean>;
  deleteAccount: () => Promise<boolean>;
  switchActiveUserProfile: (credentials: {
    email: string;
    password?: string;
  }) => Promise<boolean>;
  clearToast: () => void;
  showToast: (msg: string) => void;
  setActiveGroupId: (id: string) => void;
  openGroupWorkspace: (groupId: string) => void;
  setActivePage: (page: ActivePageTab) => void;
  toggleTheme: () => void;
  toggleOfflineMode: () => void;
  triggerCloudSync: () => void;
  createGroup: (input: {
    name: string;
    description: string;
    category: GroupRecord['category'];
    baseCurrency: string;
    simplifyDebts: boolean;
  }) => GroupRecord;
  toggleGroupSimplifyDebts: (groupId: string) => void;
  changeGroupBaseCurrency: (
    groupId: string,
    newCurrency: string,
    mode: 'relabel' | 'reconvert',
    customFxRate?: number | string
  ) => void;
  addMemberToGroup: (
    groupId: string,
    input: { displayName: string; invitedEmail?: string; upiId?: string }
  ) => GroupMember;
  saveDefaultSplitPreset: (groupId: string, preset: DefaultSplitPreset) => void;
  /** Null when the bill's group is no longer on this device (nothing is saved). */
  upsertExpense: (input: UpsertExpenseInput) => ExpenseItem | null;
  softDeleteExpense: (expenseId: string) => void;
  deleteSettlement: (settlementId: string) => void;
  restoreSettlement: (settlementId: string) => void;
  /** Group payments only; direct payments are removed and recorded again. */
  editSettlement: (
    settlementId: string,
    patch: {
      amountMinor: number;
      settledDate: string;
      paymentMethod: SettlementItem['paymentMethod'];
      paymentReference?: string;
      notes: string;
    }
  ) => void;
  /** Group admins only; synced as op 'restore'. */
  restoreGroup: (groupId: string) => void;
  isGroupAdmin: (group: GroupRecord) => boolean;
  joinGroupByCode: (code: string) => Promise<boolean>;
  rotateInviteCode: (groupId: string) => void;
  leaveGroup: (groupId: string) => void;
  removeMember: (groupId: string, memberId: string) => void;
  setMemberRole: (groupId: string, memberId: string, role: GroupMember['role']) => void;
  deleteGroup: (groupId: string) => void;
  addMemberEmail: (groupId: string, memberId: string, email: string) => boolean;
  setMemberUpi: (groupId: string, memberId: string, upiId: string) => boolean;
  restoreExpense: (expenseId: string) => void;
  resolveExpenseConflict: (expenseId: string, chosenRevisionId: string) => void;
  restoreExpenseRevision: (expenseId: string, revisionId: string) => void;
  /** Re-applies today's fetched rate; the second argument is ignored. */
  refreshOfflineExpenseFx: (expenseId: string, liveRate?: number) => void;
  /** Rate for 1 `from` in `to` from the device cache, or null when no rate is known. */
  getFxQuote: (from: string, to: string) => FxQuote | null;
  addExpenseComment: (expenseId: string, body: string) => void;
  recordSettlement: (input: {
    groupId: string | null;
    fromMemberId: string;
    toMemberId: string;
    amountMinor: number;
    paymentMethod: SettlementItem['paymentMethod'];
    paymentReference?: string;
    notes?: string;
    settledDate?: string;
    batchSettlementId?: string | null;
    currency?: string;
    expenseId?: string | null;
  }) => void;
  settleAllAcrossGroupsWithFriend: (
    friendSummary: FriendCrossGroupSummary,
    paymentMethod: SettlementItem['paymentMethod']
  ) => void;
  /** Unknown Splitwise names are mapped via `nameMapping` (name -> member id) or added as new members. */
  importSplitwiseExpenses: (
    groupId: string,
    parsed: ParsedSplitwiseImport,
    nameMapping: Record<string, string>,
    manualRates?: Record<string, string>
  ) => { expenses: number; payments: number; missingRates: string[] };
  /**
   * Merges only the five entity arrays, newer hlc wins per id; currentUser, rates and catalogs are
   * never taken from a file. `skipped` counts groups, bills and payments this account cannot take.
   */
  restoreFullDatasetFromBackup: (restored: LedgerEntities) => RestoreReport & { skipped: number };
  resetToInitialMockData: () => void;
}

const LEGACY_STORAGE_KEY = 'wise_spliter_ledger_state_v1';
const THEME_KEY = 'wise_spliter_theme_v1';
const SYNC_DEBOUNCE_MS = 1500;
const SYNC_MAX_BACKOFF_MS = 5 * 60 * 1000;

function cloneInitialDataset(): MockLedgerDataset {
  return structuredClone(initialMockData as MockLedgerDataset);
}

const SAMPLE_ME = { id: initialMockData.currentUser.id, email: initialMockData.currentUser.email };

const SAMPLE_ENTITY_IDS = new Set<string>(
  [
    ...initialMockData.groups.flatMap((g) => [g.id, ...g.members.map((m) => m.id)]),
    ...initialMockData.expenses.flatMap((e) => [
      e.id,
      ...(e.adHocParticipants ?? []).map((p) => p.id),
      ...(e.receipts ?? []).map((r) => r.id),
    ]),
    ...initialMockData.expenseRevisions.map((r) => r.id),
    ...initialMockData.settlements.map((s) => s.id),
    ...initialMockData.groupActivityLog.map((a) => a.id),
  ]
);

/** Stand-in when the user has no groups; the empty id routes the expense editor to a direct split. */
function noGroupPlaceholder(currency: string): GroupRecord {
  return {
    id: '',
    name: 'No group yet',
    description: '',
    category: 'other',
    baseCurrency: currency || 'INR',
    simplifyDebts: true,
    defaultSplitConfig: null,
    expenseSeq: 0,
    inviteCode: '',
    createdAt: '',
    updatedAt: '',
    deletedAt: null,
    hlc: '',
    members: [],
  };
}

/**
 * Dexie is the source of truth and always wins. Only a device with no Dexie ledger yet takes a
 * legacy snapshot (old full JSON in Dexie, or the localStorage blob, which also seeds tests); it is
 * rewritten into Dexie once and removed.
 */
async function loadBootDataset(): Promise<{ dataset: MockLedgerDataset; fromDevice: boolean; legacy: boolean } | null> {
  const defaults = cloneInitialDataset();
  try {
    const stored = await loadLocalDataset(defaults);
    if (stored) {
      dropLegacySnapshot();
      return { dataset: stored, fromDevice: true, legacy: false };
    }
  } catch {
    return null;
  }
  let legacy: MockLedgerDataset | null = await loadLegacyDexieSnapshot();
  if (!legacy) {
    try {
      const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
      legacy = raw ? (JSON.parse(raw) as MockLedgerDataset) : null;
    } catch {
      legacy = null;
    }
  }
  if (legacy && Array.isArray(legacy.groups) && legacy.currentUser) {
    return { dataset: { ...defaults, ...legacy }, fromDevice: false, legacy: true };
  }
  return { dataset: defaults, fromDevice: false, legacy: false };
}

function dropLegacySnapshot(): void {
  try {
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // Ignore
  }
}

function withoutEntities(d: MockLedgerDataset): MockLedgerDataset {
  return { ...d, groups: [], expenses: [], expenseRevisions: [], settlements: [], groupActivityLog: [] };
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return `${parts[0]![0] ?? ''}${parts[parts.length - 1]![0] ?? ''}`.toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

const LedgerContext = createContext<LedgerContextValue | null>(null);

export function LedgerProvider({ children }: { children: React.ReactNode }) {
  const [dataset, setDataset] = useState<MockLedgerDataset>(cloneInitialDataset);
  const [isLoaded, setIsLoaded] = useState(false);

  const [activeGroupId, setActiveGroupIdState] = useState<string>(
    () => dataset.groups[0]?.id ?? ''
  );
  const [activePage, setActivePage] = useState<ActivePageTab>('home');
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try {
      const savedTheme = localStorage.getItem(THEME_KEY);
      if (savedTheme === 'light' || savedTheme === 'dark') return savedTheme;
    } catch {
      // default dark
    }
    return 'dark';
  });
  const [isOnline, setIsOnline] = useState<boolean>(true);
  const [fxRates, setFxRates] = useState<FxRateTable | null>(null);
  useEffect(() => {
    let alive = true;
    void loadFxRates({ online: isOnline }).then((t) => alive && setFxRates(t));
    return () => {
      alive = false;
    };
  }, [isOnline]);
  const getFxQuote = (from: string, to: string) => quoteFxRate(fxRates, from, to);
  const [pendingOutboxCount, setPendingOutboxCount] = useState<number>(0);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const [expenseModalState, setExpenseModalState] = useState<ExpenseModalState>({
    isOpen: false,
    defaultGroupId: null,
    editingExpense: null,
  });
  const [isHelpModalOpen, setHelpModalOpen] = useState<boolean>(false);
  const [isAuthModalOpen, setAuthModalOpen] = useState<boolean>(false);

  const [sessionUser, setSessionUser] = useState<SessionIdentity | null>(null);
  const [pendingSwitch, setPendingSwitch] = useState<{
    profile: UserProfile;
    token: string | null;
    serverDataset: MockLedgerDataset | null;
    unsynced: number;
  } | null>(null);
  const [pendingImport, setPendingImport] = useState<{
    profile: UserProfile;
    token: string | null;
    serverDataset: MockLedgerDataset | null;
    counts: LocalDataCounts;
    canImport: boolean;
  } | null>(null);
  const [pendingSignOut, setPendingSignOut] = useState<{ unsynced: number } | null>(null);
  const signOutDecisionRef = useRef<((go: boolean) => void) | null>(null);
  const datasetRef = useRef(dataset);
  const prevDatasetRef = useRef(dataset);
  const persistWaitersRef = useRef<Array<{ ready: () => boolean; settle: (ok: boolean) => void }>>([]);
  const loadedRef = useRef(false);
  const persistedRef = useRef<MockLedgerDataset | null>(null);
  const persistQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const carriedMutationsRef = useRef<SyncPushMutation[]>([]);
  const storageWarnedRef = useRef(false);
  const storageUnreadableRef = useRef(false);
  /** Per bill id, the hlc an open editor started from; read once by the next diff. */
  const editBaseHlcsRef = useRef(new Map<string, string>());
  const sessionRef = useRef<SessionIdentity | null>(null);
  const sessionReadyRef = useRef<Promise<void>>(Promise.resolve());
  const isOnlineRef = useRef(isOnline);
  isOnlineRef.current = isOnline;
  const needsSignInRef = useRef(false);
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncingRef = useRef(false);
  const resyncRef = useRef(false);
  const backoffRef = useRef(0);
  const runSyncRef = useRef<() => Promise<void>>(async () => {});
  const syncInFlightRef = useRef<Promise<void>>(Promise.resolve());

  /** Runs storage work one task at a time, in order. */
  const queuePersist = <T,>(task: () => Promise<T>): Promise<T> => {
    const run = persistQueueRef.current.then(task);
    persistQueueRef.current = run.catch(() => {});
    return run;
  };

  /** Resolves the number of outbox rows written, or -1 if the device refused the write. */
  const commitToDevice = (next: MockLedgerDataset, mutations: SyncPushMutation[]) =>
    queuePersist(async () => {
      const all = [...carriedMutationsRef.current, ...mutations];
      try {
        if (storageUnreadableRef.current) throw new Error('device storage could not be read');
        await commitLocalChanges(persistedRef.current, next, all);
        persistedRef.current = next;
        carriedMutationsRef.current = [];
        storageWarnedRef.current = false;
        return all.length;
      } catch (err) {
        carriedMutationsRef.current = all;
        if (!storageWarnedRef.current) {
          storageWarnedRef.current = true;
          setToastMessage(
            isQuotaError(err)
              ? 'This device is out of storage space, so your latest changes are not saved here yet. Free up some space and they will be saved automatically.'
              : 'Your latest changes could not be saved on this device yet. Keep the app open and they will be saved on the next change.'
          );
        }
        return -1;
      }
    });

  useEffect(() => {
    datasetRef.current = dataset;
    if (!loadedRef.current) return;
    const prev = prevDatasetRef.current;
    prevDatasetRef.current = dataset;
    const session = sessionRef.current;
    const mutations =
      session && prev !== dataset ? diffDatasetToMutations(prev, dataset, session.id, editBaseHlcsRef.current) : [];
    editBaseHlcsRef.current = new Map();
    const ready = persistWaitersRef.current.filter((w) => w.ready());
    persistWaitersRef.current = persistWaitersRef.current.filter((w) => !ready.includes(w));
    void commitToDevice(dataset, mutations).then((written) => {
      ready.forEach((w) => w.settle(written >= 0));
      if (written > 0) {
        refreshPendingCount();
        scheduleSync(SYNC_DEBOUNCE_MS);
      }
    });
  }, [dataset]);

  const replaceDataset = (next: MockLedgerDataset) => {
    prevDatasetRef.current = next;
    setDataset(next);
  };

  const refreshPendingCount = () => {
    void countSyncOutbox().then(setPendingOutboxCount);
  };

  const scheduleSync = (delayMs: number) => {
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    syncTimerRef.current = setTimeout(() => {
      syncTimerRef.current = null;
      void runSyncRef.current();
    }, delayMs);
  };

  const handleAuthExpired = () => {
    void markSessionTokenRejected();
    if (needsSignInRef.current) return;
    needsSignInRef.current = true;
    setToastMessage(
      'Your sign-in has expired. Sign in again to keep syncing. Your changes are safe on this device.'
    );
    setAuthModalOpen(true);
  };

  const applyRemoteChanges = (changes: SyncPullChange[], selfUserId: string) =>
    new Promise<SyncPullChange[]>((resolve, reject) => {
      let orphans: SyncPullChange[] = [];
      let merged = false;
      persistWaitersRef.current.push({
        ready: () => merged,
        settle: (ok) => (ok ? resolve(orphans) : reject(new Error('not saved on this device'))),
      });
      setDataset((prev) => {
        merged = true;
        prevDatasetRef.current = mergePullChanges(prevDatasetRef.current, changes, [], selfUserId);
        const leftover: SyncPullChange[] = [];
        const next = mergePullChanges(prev, changes, leftover, selfUserId);
        orphans = leftover;
        return next;
      });
    });

  const evictLost = (scope: BackfillScope, id: string) =>
    new Promise<void>((resolve, reject) => {
      let evicted = false;
      persistWaitersRef.current.push({
        ready: () => evicted,
        settle: (ok) => (ok ? resolve() : reject(new Error('not saved on this device'))),
      });
      setDataset((prev) => {
        evicted = true;
        const evict = scope === 'group' ? evictGroupData : evictExpenseData;
        prevDatasetRef.current = evict(prevDatasetRef.current, id);
        return evict(prev, id);
      });
    });

  /**
   * The group's base currency changed while these were queued: convert them (after the pull brought
   * the group) and queue them again, keeping their baseHlc. Without a rate they stay queued.
   */
  const requeueInBaseCurrency = async (mismatches: CurrencyMismatch[], userId: string) => {
    const converted: SyncPushMutation[] = [];
    const waiting: string[] = [];
    let moved = false;
    let usedDeviceRate = false;
    for (const { mutation, baseCurrency } of mismatches) {
      const from = String(mutation.entity === 'expense' ? mutation.data?.groupCurrency : mutation.data?.currency);
      const groupId = typeof mutation.data?.groupId === 'string' ? mutation.data.groupId : '';
      // The admin's recorded rate keeps every bill in the group on one rate; this device's quote is the fallback.
      const adminRate = recordedConversionRate(datasetRef.current.expenseRevisions, groupId, from, baseCurrency);
      const rate = adminRate ?? getFxQuote(from, baseCurrency);
      usedDeviceRate ||= !adminRate && rate !== null && from.toUpperCase() !== baseCurrency.toUpperCase();
      const next = convertQueuedToBase(mutation, baseCurrency, rate, makeHlc(userId));
      if (!next) {
        waiting.push(`${typeof mutation.data?.title === 'string' ? `"${mutation.data.title}"` : 'A payment'} (${from} to ${baseCurrency})`);
        continue;
      }
      converted.push(next);
      moved ||= from.toUpperCase() !== baseCurrency.toUpperCase();
    }
    if (converted.length > 0) {
      const rows = converted.map((m) => ({ entity: m.entity, id: m.id, serverSeq: '0', deleted: false, data: m.data }));
      setDataset((prev) => {
        prevDatasetRef.current = forceRows(prevDatasetRef.current, rows);
        return forceRows(prev, rows);
      });
      await enqueueSyncOutboxMutations(converted);
      if (moved) resyncRef.current = true;
    }
    if (waiting.length > 0) {
      setToastMessage(
        `The group currency changed while you were offline. ${waiting.join(', ')} needs an exchange rate before it can sync; it is safe on this device.`
      );
    } else if (moved) {
      setToastMessage(
        usedDeviceRate
          ? 'The group currency changed while you were offline. Your changes were converted at today\'s rate on this device, because the admin\'s rate was not recorded, and are syncing now.'
          : 'The group currency changed while you were offline, so your changes were converted at the rate the admin used and are syncing now.'
      );
    }
  };

  runSyncRef.current = async () => {
    const session = sessionRef.current;
    if (!session || needsSignInRef.current || !isOnlineRef.current) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    if (syncingRef.current) {
      resyncRef.current = true;
      return;
    }
    syncingRef.current = true;
    let finishRun = () => {};
    syncInFlightRef.current = new Promise<void>((resolve) => {
      finishRun = resolve;
    });
    const isCurrent = () => sessionRef.current === session;
    let retry = false;
    try {
      const auth = await resolveSessionToken(session);
      if (!isCurrent()) return;
      if (!auth.token) {
        if (auth.reason === 'unauthorized') handleAuthExpired();
        else retry = true;
        return;
      }
      const push = await pushOutbox(auth.token, isCurrent);
      if (push.rejected.length > 0) {
        setToastMessage(
          describeRejectedUpi(push.rejected, datasetRef.current.groups, session.id) ??
            describeRejectedSettlements(push.rejected, datasetRef.current) ??
            'A few changes could not be saved to your account, so this device went back to the saved version.'
        );
      }
      // Refused rows go back to the server's copy: unpinned so it wins, and their scope re-read below.
      const refused = push.rejected.map((r) => ({ entity: r.entity, id: r.id }));
      const refetch = scopesOf(datasetRef.current, refused);
      if (refused.length > 0 && isCurrent()) {
        setDataset((prev) => {
          prevDatasetRef.current = unpinRows(prevDatasetRef.current, refused);
          return unpinRows(prev, refused);
        });
      }
      if (push.serverConflicts.length > 0 && isCurrent()) {
        setDataset((prev) => {
          prevDatasetRef.current = takeServerVersions(prevDatasetRef.current, push.serverConflicts);
          return takeServerVersions(prev, push.serverConflicts);
        });
      }
      if (push.status === 'auth') return handleAuthExpired();
      if (push.status === 'retry' || !isCurrent()) {
        retry = isCurrent();
        return;
      }
      const seen = new Set<string>();
      const pull = await pullAll(
        session.id,
        auth.token,
        (changes) => {
          changes.forEach((c) => seen.add(`${c.entity}:${c.id}`));
          return applyRemoteChanges(changes, session.id);
        },
        evictLost,
        isCurrent,
        refetch
      );
      if (pull.status === 'auth') return handleAuthExpired();
      if (pull.status === 'retry') {
        retry = true;
        return;
      }
      // Rows the server never had are kept and flagged, never deleted; edits already went back above.
      const neverAccepted = push.rejected.filter((r) => !seen.has(`${r.entity}:${r.id}`));
      if (neverAccepted.length > 0 && isCurrent()) {
        const restamped = new Map<string, string>();
        const mint = (key: string) => () => {
          if (!restamped.has(key)) restamped.set(key, makeHlc(session.id));
          return restamped.get(key)!;
        };
        // Same hlc in the baseline and the dataset, so marking pushes nothing.
        const mark = (d: MockLedgerDataset) =>
          neverAccepted.reduce((acc, r) => markRejected(acc, [r], mint(`${r.entity}:${r.id}`)), d);
        setDataset((prev) => {
          prevDatasetRef.current = mark(prevDatasetRef.current);
          return mark(prev);
        });
      }
      backoffRef.current = 0;
      if (isCurrent()) {
        setDataset((d) => ({
          ...d,
          currentUser: { ...d.currentUser, syncState: 'synced', lastSyncedAt: new Date().toISOString() },
        }));
        if (push.serverConflicts.length > 0) {
          setToastMessage('Someone edited the same bill at the same time. Both versions are on the bill so you can pick one.');
        } else if (push.conflicts.length > 0) {
          setToastMessage('Someone else changed this at the same time, so their version was kept.');
        }
        if (push.currencyMismatches.length > 0) await requeueInBaseCurrency(push.currencyMismatches, session.id);
      }
    } catch {
      // A switched session schedules its own run; a failed device write retries
      retry = isCurrent();
    } finally {
      syncingRef.current = false;
      finishRun();
      refreshPendingCount();
      if (retry) {
        backoffRef.current = Math.min(backoffRef.current + 1, 10);
        scheduleSync(Math.min(1000 * 2 ** backoffRef.current, SYNC_MAX_BACKOFF_MS));
      } else if (resyncRef.current) {
        resyncRef.current = false;
        scheduleSync(0);
      }
    }
  };

  useEffect(() => {
    let alive = true;
    void getDeviceId().then(setHlcDeviceId);
    sessionReadyRef.current = Promise.all([loadPersistedSession(), loadBootDataset()]).then(async ([stored, boot]) => {
      if (!alive) return;
      let session = stored;
      const legacyUser = boot?.legacy ? boot.dataset.currentUser : null;
      if (!session && legacyUser && legacyUser.id !== SAMPLE_ME.id && legacyUser.email) {
        // Older versions kept no session: their ledger belongs to this account, so treat the device as
        // signed in (it asks to sign in again) instead of offering that data as new signed-out data.
        session = { id: legacyUser.id, email: legacyUser.email.trim().toLowerCase(), fullName: legacyUser.fullName };
        await setBackendSessionToken(null, session);
        if (!alive) return;
      }
      const owner = session?.id ?? null;
      setReceiptOwner(owner);
      void reassignReceiptBlobs(undefined, owner);
      sessionRef.current = session;
      setSessionUser(session);
      storageUnreadableRef.current = boot === null;
      storageWarnedRef.current = boot === null;
      const loaded = boot?.dataset ?? cloneInitialDataset();
      prevDatasetRef.current = loaded;
      persistedRef.current = boot?.fromDevice ? loaded : null;
      loadedRef.current = true;
      setDataset(loaded);
      setActiveGroupIdState((loaded.groups.find((g) => !g.deletedAt) ?? loaded.groups[0])?.id ?? '');
      setIsLoaded(true);
      if (boot === null) {
        setToastMessage('This device\'s storage could not be opened, so changes are not saved here. Close other tabs of the app and reload.');
      } else if (!boot.fromDevice) {
        void commitToDevice(loaded, []).then((written) => written >= 0 && dropLegacySnapshot());
      }
      if (session) {
        void queuePersist(() => migrateLegacyOutboxComments(session.fullName, () => makeHlc(session.id)))
          .catch(() => 0)
          .then(() => {
            refreshPendingCount();
            scheduleSync(0);
          });
      }
    });
    const wake = () => {
      if (document.visibilityState !== 'hidden') scheduleSync(0);
    };
    window.addEventListener('online', wake);
    document.addEventListener('visibilitychange', wake);
    return () => {
      alive = false;
      window.removeEventListener('online', wake);
      document.removeEventListener('visibilitychange', wake);
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    };
  }, []);

  const adoptSignedInSession: LedgerContextValue['adoptSignedInSession'] = async (
    profile,
    token,
    serverDataset
  ) => {
    await sessionReadyRef.current;
    const previous = sessionRef.current;
    if (previous && previous.id !== profile.id) {
      const unsynced = await countSyncOutbox();
      if (unsynced > 0) {
        setToastMessage(null);
        setPendingSwitch({ profile, token, serverDataset, unsynced });
        return false;
      }
    }
    if (!previous) {
      const { counts } = takeLocalData(datasetRef.current, SAMPLE_ENTITY_IDS);
      if (hasLocalData(counts)) {
        // The demo account is shared, so personal data is never copied into it.
        setToastMessage(null);
        setPendingImport({ profile, token, serverDataset, counts, canImport: !isDesignatedDemoUser(profile) });
        return false;
      }
    }
    await completeSignIn(profile, token, serverDataset);
    return true;
  };

  const resolvePendingLocalImport: LedgerContextValue['resolvePendingLocalImport'] = async (choice) => {
    const pending = pendingImport;
    if (!pending || (choice === 'import' && !pending.canImport)) return;
    setPendingImport(null);
    if (choice === 'later') {
      void clearBackendSessionToken();
      showToast('You are still signed out. Everything stays on this device.');
      return;
    }
    if (choice === 'fresh') await deleteReceiptBlobsOwnedBy(null);
    await completeSignIn(pending.profile, pending.token, pending.serverDataset, choice === 'import');
    showToast(
      choice === 'import'
        ? `Signed in as ${pending.profile.fullName}. Your bills from this device are being saved to your account.`
        : `Signed in as ${pending.profile.fullName} (${pending.profile.email})`
    );
  };

  const downloadLocalBackup = async (passphrase: string) => {
    const receipts = new Map((await listAllLocalReceiptBlobs()).map((b) => [b.id, b.dataUrl]));
    await exportFileCrossPlatform({
      fileName: safeExportFileName(`backup ${new Date().toISOString().slice(0, 10)}`, 'wisesplit'),
      mimeType: 'application/json;charset=utf-8;',
      data: await encryptBackupPayload(buildBackupJson(datasetRef.current, receipts), passphrase),
      shareTitle: 'Wise-Spliter Encrypted Backup (.wisesplit)',
    });
  };

  const resolvePendingUserSwitch: LedgerContextValue['resolvePendingUserSwitch'] = async (choice) => {
    const pending = pendingSwitch;
    if (!pending) return;
    if (choice === 'cancel') {
      setPendingSwitch(null);
      showToast(`You are still signed in as ${datasetRef.current.currentUser.fullName}.`);
      return;
    }
    if (choice === 'sync') {
      const { left, reason } = await flushOutbox();
      if (left > 0) {
        setPendingSwitch({ ...pending, unsynced: left });
        showToast(`${waitingText(left)} ${reason}, or discard them.`);
        return;
      }
    }
    setPendingSwitch(null);
    await completeSignIn(pending.profile, pending.token, pending.serverDataset);
    showToast(`Signed in as ${pending.profile.fullName} (${pending.profile.email})`);
  };

  /** Forgets that the row was ever sent, so the next diff sends it (a group with all its contents) as new. */
  const retryRejected: LedgerContextValue['retryRejected'] = (entity, id) => {
    const clear = <T extends { id: string; syncRejection?: string | null }>(rows: T[]) =>
      rows.map((r) => (r.id === id ? { ...r, syncRejection: null } : r));
    setDataset((prev) => {
      prevDatasetRef.current = dropRows(prevDatasetRef.current, [{ entity, id }]);
      return {
        ...prev,
        groups: entity === 'group' ? clear(prev.groups) : prev.groups,
        expenses: entity === 'expense' ? clear(prev.expenses) : prev.expenses,
        settlements: entity === 'settlement' ? clear(prev.settlements) : prev.settlements,
      };
    });
    showToast('Trying again. If it is refused again, it stays here marked as not saved.');
  };

  const discardRejected: LedgerContextValue['discardRejected'] = (entity, id) => {
    setDataset((prev) => {
      prevDatasetRef.current = dropRows(prevDatasetRef.current, [{ entity, id }]);
      return dropRows(prev, [{ entity, id }]);
    });
    showToast('Removed from this device. Nothing was saved to your account for it.');
  };

  const waitingText = (n: number) => `${n} ${n === 1 ? 'change is' : 'changes are'} still waiting to sync.`;

  /** Pushes what it can right now; reports what is still queued and why, in plain words. */
  const flushOutbox = async (): Promise<{ left: number; reason: string }> => {
    const offline = !isOnlineRef.current || (typeof navigator !== 'undefined' && navigator.onLine === false);
    if (!needsSignInRef.current && !offline) {
      await runSyncRef.current();
      await syncInFlightRef.current;
    }
    const reason = needsSignInRef.current
      ? 'Sign in again to sync them'
      : offline
        ? 'Go online to sync them'
        : 'The server could not take them yet, so try again in a moment';
    return { left: await countSyncOutbox(), reason };
  };

  /** Signs out after a last sync; with changes still queued it asks first and resolves false on "stay". */
  const requestSignOut = async (): Promise<boolean> => {
    if (sessionRef.current) {
      const { left } = await flushOutbox();
      if (left > 0) {
        const go = await new Promise<boolean>((resolve) => {
          signOutDecisionRef.current?.(false);
          signOutDecisionRef.current = resolve;
          setPendingSignOut({ unsynced: left });
        });
        if (!go) return false;
      }
    }
    await signOut();
    return true;
  };

  const resolvePendingSignOut: LedgerContextValue['resolvePendingSignOut'] = async (choice) => {
    if (!pendingSignOut) return;
    if (choice === 'sync') {
      const { left, reason } = await flushOutbox();
      if (left > 0) {
        setPendingSignOut({ unsynced: left });
        showToast(`${waitingText(left)} ${reason}, or sign out anyway.`);
        return;
      }
    }
    setPendingSignOut(null);
    const decide = signOutDecisionRef.current;
    signOutDecisionRef.current = null;
    decide?.(choice !== 'cancel');
  };

  const wipeDevice = () =>
    queuePersist(async () => {
      await wipeUserScopedData();
      persistedRef.current = null;
      carriedMutationsRef.current = [];
      dropLegacySnapshot();
    });

  const completeSignIn = async (
    profile: UserProfile,
    token: string | null,
    serverDataset: MockLedgerDataset | null,
    importLocal = false
  ) => {
    const sameUser = sessionRef.current?.id === profile.id;
    const before = datasetRef.current;
    const carried = importLocal
      ? adoptLocalIdentity(takeLocalData(before, SAMPLE_ENTITY_IDS).data, before.currentUser, profile)
      : null;
    if (!sameUser) {
      sessionRef.current = null;
      await syncInFlightRef.current;
      await wipeDevice();
    }
    const identity: SessionIdentity = {
      id: profile.id,
      email: profile.email.trim().toLowerCase(),
      fullName: profile.fullName,
    };
    await setBackendSessionToken(token, identity);
    sessionRef.current = identity;
    needsSignInRef.current = false;
    backoffRef.current = 0;
    setSessionUser(identity);
    setReceiptOwner(profile.id);
    if (carried) await reassignReceiptBlobs(null, profile.id);
    const base = { ...(sameUser ? datasetRef.current : (serverDataset ?? withoutEntities(datasetRef.current))), currentUser: profile };
    prevDatasetRef.current = base;
    const next = carried ? withExtraRows(base, carried) : base;
    setDataset(next);
    if (!sameUser) {
      const first = next.groups.find((g) => !g.deletedAt) ?? next.groups[0];
      if (first) setActiveGroupIdState(first.id);
    }
    refreshPendingCount();
    scheduleSync(0);
  };

  /** Wipes this device first, then tells the server (time-limited), so an interrupted sign-out never leaves data behind. */
  const signOut = async (purgeReceipts = false) => {
    const leaving = sessionRef.current;
    sessionRef.current = null;
    needsSignInRef.current = false;
    setSessionUser(null);
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    await syncInFlightRef.current;
    await wipeDevice();
    if (purgeReceipts && leaving) await deleteReceiptBlobsOwnedBy(leaving.id);
    setReceiptOwner(null);
    setPendingOutboxCount(0);
    const fresh = cloneInitialDataset();
    replaceDataset(fresh);
    setActiveGroupIdState(fresh.groups[0]!.id);
    await clearBackendSessionToken();
  };

  const deleteAccount = async (): Promise<boolean> => {
    const session = sessionRef.current;
    if (!session) return false;
    const result = await requestAccountDeletion(session);
    if (result === 'deleted') {
      await signOut(true);
      setToastMessage('Your account has been deleted and this device has been cleared.');
      return true;
    }
    if (result === 'unauthorized') {
      handleAuthExpired();
      return false;
    }
    setToastMessage('We could not reach the server, so your account was not deleted. Please try again when you are online.');
    return false;
  };

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Ignore
    }
  }, [theme]);

  useEffect(() => {
    let active = true;
    let client: ReturnType<typeof getBrowserSupabaseClient>;
    try {
      client = getBrowserSupabaseClient();
    } catch (err) {
      console.warn(err);
      return;
    }

    const completeGoogleCallbackIfPresent = async (accessToken: string) => {
      const exchanged = await exchangeGoogleOAuthSession(accessToken);
      if (!active || !exchanged.ok || !exchanged.profile) return;

      const adopted = await adoptSignedInSession(
        exchanged.profile,
        exchanged.token,
        exchanged.dataset && Array.isArray(exchanged.dataset.groups) ? exchanged.dataset : null
      );
      setAuthModalOpen(false);
      if (adopted) {
        setToastMessage(
          `Signed in with Google as ${exchanged.profile.fullName} (${exchanged.profile.email})`
        );
      }

      if (typeof window !== 'undefined' && window.location.hash.includes('access_token=')) {
        window.history.replaceState(
          null,
          '',
          `${window.location.pathname}${window.location.search}`
        );
      }
    };

    const { data: sub } = client.auth.onAuthStateChange((event, session) => {
      if (
        (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') &&
        session?.access_token
      ) {
        const hasOAuthCallbackUrl =
          typeof window !== 'undefined' &&
          (window.location.hash.includes('access_token=') ||
            window.location.search.includes('code='));
        if (event === 'SIGNED_IN' || hasOAuthCallbackUrl) {
          void completeGoogleCallbackIfPresent(session.access_token);
        }
      }
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const showToast = (msg: string) => {
    setToastMessage(msg);
  };

  const clearToast = () => setToastMessage(null);

  const openAddExpenseModal: LedgerContextValue['openAddExpenseModal'] = (
    defaultGroupId = null,
    editingExpense = null
  ) => {
    setExpenseModalState({
      isOpen: true,
      defaultGroupId: defaultGroupId !== undefined ? defaultGroupId : (editingExpense?.groupId ?? null),
      editingExpense,
    });
  };

  const closeAddExpenseModal = () => {
    setExpenseModalState((prev) => ({
      ...prev,
      isOpen: false,
      editingExpense: null,
    }));
  };

  const activeGroup = useMemo(() => {
    return (
      dataset.groups.find((g) => g.id === activeGroupId && !g.deletedAt) ??
      dataset.groups.find((g) => !g.deletedAt) ??
      dataset.groups[0] ??
      noGroupPlaceholder(dataset.currentUser.defaultCurrency)
    );
  }, [dataset.groups, activeGroupId, dataset.currentUser.defaultCurrency]);

  const recentGroups = useMemo(() => {
    return [...dataset.groups]
      .filter((g) => !g.deletedAt)
      .sort((a, b) => {
        const timeA = Math.max(
          Date.parse(a.lastAccessedAt ?? a.updatedAt) || 0,
          Date.parse(a.updatedAt) || 0
        );
        const timeB = Math.max(
          Date.parse(b.lastAccessedAt ?? b.updatedAt) || 0,
          Date.parse(b.updatedAt) || 0
        );
        return timeB - timeA;
      })
      .slice(0, 3);
  }, [dataset.groups]);

  const setActiveGroupId = (id: string) => {
    const nowIso = new Date().toISOString();
    setActiveGroupIdState(id);
    setDataset((prev) => ({
      ...prev,
      groups: prev.groups.map((g) =>
        g.id === id ? { ...g, lastAccessedAt: nowIso } : g
      ),
    }));
  };

  const openGroupWorkspace = (groupId: string) => {
    setActiveGroupId(groupId);
    setActivePage('groups');
  };

  const toggleTheme = () => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  };

  const toggleOfflineMode = () => {
    const next = !isOnline;
    isOnlineRef.current = next;
    setIsOnline(next);
    setDataset((d) => ({
      ...d,
      currentUser: {
        ...d.currentUser,
        syncState: next ? 'synced' : 'offline_local',
      },
    }));
    if (next) {
      scheduleSync(0);
      showToast(
        sessionRef.current
          ? 'Back online. Syncing your saved changes now.'
          : 'Back online. Everything is saved on this device.'
      );
    } else {
      showToast('Offline mode is on. Every change keeps saving on this device.');
    }
  };

  const triggerCloudSync = () => {
    if (!sessionRef.current) {
      showToast('Everything is saved on this device. Sign in to sync it to the cloud.');
      return;
    }
    if (needsSignInRef.current) {
      setAuthModalOpen(true);
      return;
    }
    isOnlineRef.current = true;
    setIsOnline(true);
    scheduleSync(0);
    showToast('Syncing your changes now.');
  };

  const switchActiveUserProfile: LedgerContextValue['switchActiveUserProfile'] = async (
    credentials
  ) => {
    const email = credentials.email?.trim().toLowerCase() || '';
    const password = credentials.password ?? '';
    if (!email || !password) {
      showToast('Please enter both your email address and password.');
      return false;
    }

    try {
      const res = await fetch(resolveApiUrl('/api/auth/login'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      const payload = (await res.json()) as {
        ok?: boolean;
        error?: string;
        token?: string;
        profile?: UserProfile;
        dataset?: MockLedgerDataset;
      };

      if (!res.ok || !payload.ok || !payload.profile) {
        showToast(payload.error || 'Invalid email or password');
        return false;
      }

      const verifiedProfile = payload.profile;
      const serverDataset =
        payload.dataset && Array.isArray(payload.dataset.groups) ? payload.dataset : null;
      if (!(await adoptSignedInSession(verifiedProfile, payload.token ?? null, serverDataset))) {
        return true;
      }
      showToast(
        serverDataset
          ? `Signed in as ${verifiedProfile.fullName} (${verifiedProfile.email}) - ${serverDataset.groups.length} group(s) loaded.`
          : `Signed in as ${verifiedProfile.fullName} (${verifiedProfile.email})`
      );

      return true;
    } catch {
      showToast('Unable to reach authentication server (/api/auth/login).');
      return false;
    }
  };

  const createGroup: LedgerContextValue['createGroup'] = (input) => {
    const newGroupId = newId('grp');
    const myMemId = newId('mem');
    const nowIso = new Date().toISOString();
    const hlc = makeHlc(dataset.currentUser.id);

    const newGroup: GroupRecord = {
      id: newGroupId,
      name: input.name.trim(),
      description: input.description.trim(),
      category: input.category,
      baseCurrency: input.baseCurrency.toUpperCase(),
      simplifyDebts: input.simplifyDebts,
      defaultSplitConfig: null,
      expenseSeq: 0,
      inviteCode: '',
      createdAt: nowIso,
      updatedAt: nowIso,
      lastAccessedAt: nowIso,
      deletedAt: null,
      hlc,
      members: [
        {
          id: myMemId,
          groupId: newGroupId,
          userId: dataset.currentUser.id,
          invitedEmail: dataset.currentUser.email,
          displayName: dataset.currentUser.fullName,
          avatarInitials: dataset.currentUser.avatarInitials,
          upiId: dataset.currentUser.upiId,
          role: 'admin',
          memberOrder: 0,
          joinedAt: nowIso,
          claimedAt: nowIso,
        },
      ],
    };

    const activity: GroupActivityItem = {
      id: newId('act'),
      groupId: newGroupId,
      actorMemberId: myMemId,
      actorDisplayName: dataset.currentUser.fullName,
      entityType: 'group',
      entityId: newGroupId,
      action: 'group_created',
      summaryText: `${dataset.currentUser.fullName} created group "${newGroup.name}" (${newGroup.baseCurrency})`,
      detailNote: `Base currency locked to ${newGroup.baseCurrency}; debt simplification ${newGroup.simplifyDebts ? 'enabled' : 'disabled'}.`,
      diffBadges: [`Base: ${newGroup.baseCurrency}`, newGroup.category.toUpperCase()],
      createdAt: nowIso,
      hlc,
    };

    setDataset((prev) => ({
      ...prev,
      groups: [newGroup, ...prev.groups],
      groupActivityLog: [activity, ...prev.groupActivityLog],
    }));
    setActiveGroupIdState(newGroupId);
    showToast(`Created group "${newGroup.name}"`);
    return newGroup;
  };

  const toggleGroupSimplifyDebts = (groupId: string) => {
    const nowIso = new Date().toISOString();
    const hlc = makeHlc(dataset.currentUser.id);
    setDataset((prev) => {
      const grp = prev.groups.find((g) => g.id === groupId);
      if (!grp) return prev;
      const nextVal = !grp.simplifyDebts;
      const act: GroupActivityItem = {
        id: newId('act'),
        groupId,
        actorMemberId: grp.members[0]?.id ?? 'mem',
        actorDisplayName: dataset.currentUser.fullName,
        entityType: 'group',
        entityId: groupId,
        action: 'group_updated',
        summaryText: `${dataset.currentUser.fullName} switched Debt Simplification ${nextVal ? 'ON (Minimum Transfers)' : 'OFF (Raw Pairwise Debts)'}`,
        detailNote: 'Underlying expenses and settlements are unchanged; only repayment routing was toggled.',
        diffBadges: [nextVal ? 'Simplified ON' : 'Raw Pairwise Mode'],
        createdAt: nowIso,
        hlc,
      };
      return {
        ...prev,
        groups: prev.groups.map((g) =>
          g.id === groupId ? { ...g, simplifyDebts: nextVal, updatedAt: nowIso, hlc } : g
        ),
        groupActivityLog: [act, ...prev.groupActivityLog],
      };
    });
  };

  const changeGroupBaseCurrency: LedgerContextValue['changeGroupBaseCurrency'] = (
    groupId,
    newCurrency,
    mode,
    customFxRate
  ) => {
    const targetCode = newCurrency.toUpperCase();
    const target = dataset.groups.find((g) => g.id === groupId);
    if (!target || !isGroupAdminFor(target, dataset.currentUser.id)) {
      showToast('Only a group admin can change the currency.');
      return;
    }
    const nowIso = new Date().toISOString();
    const hlc = makeHlc(dataset.currentUser.id);
    const manualScaled = customFxRate !== undefined ? parseFxRateToScaled(customFxRate) : 0;
    const quote = manualScaled > 0 ? null : getFxQuote(target.baseCurrency, targetCode);
    const reconvertFx =
      manualScaled > 0
        ? { fxRateScaled: manualScaled, fxStatus: 'manual' as FxStatus, fxRateDate: localIsoDate() }
        : quote
          ? { fxRateScaled: quote.rateScaled, fxStatus: quote.status as FxStatus, fxRateDate: quote.rateDate }
          : null;
    if (mode === 'reconvert' && !reconvertFx) {
      showToast(`No exchange rate for ${target.baseCurrency} to ${targetCode}. Enter a rate to convert.`);
      return;
    }

    setDataset((prev) => {
      const grp = prev.groups.find((g) => g.id === groupId);
      if (!grp || grp.baseCurrency === targetCode) return prev;
      const oldCode = grp.baseCurrency;

      const { fxRateScaled, fxStatus, fxRateDate } = reconvertFx ?? { fxRateScaled: 0, fxStatus: undefined, fxRateDate: undefined };
      const rateNote = reconvertFx
        ? `1 ${oldCode} = ${formatScaledFxRate(fxRateScaled)} ${targetCode} (${fxStatus === 'manual' ? 'manual' : fxStatus === 'live' ? 'live' : 'cached offline'} rate, ${fxRateDate})`
        : '';

      const newRevisions: ExpenseRevision[] = [];
      const updatedExpenses = prev.expenses.map((exp) => {
        if (exp.groupId !== groupId) return exp;
        const converted = redenominateExpenseCurrency({
          expense: exp,
          newCurrency: targetCode,
          mode,
          fxRateScaled,
          fxStatus,
          fxRateDate,
          updatedAt: nowIso,
          hlc,
        });
        if (mode === 'reconvert' && !exp.deletedAt) {
          const revId = newId('rev');
          const nextRevNum = exp.revisionNumber + 1;
          newRevisions.push({
            id: revId,
            expenseId: exp.id,
            groupId,
            revisionNumber: nextRevNum,
            baseRevisionId: exp.currentRevisionId,
            actorMemberId: grp.members[0]?.id ?? exp.updatedByMemberId,
            actorDisplayName: dataset.currentUser.fullName,
            action: 'currency_reconverted',
            changes: [
              {
                field: 'groupCurrency',
                fromValue: formatMinorToMajor(exp.amountMinor, oldCode),
                toValue: formatMinorToMajor(converted.amountMinor, targetCode),
                label: `Converted ${formatMinorToMajor(exp.amountMinor, oldCode)} -> ${formatMinorToMajor(converted.amountMinor, targetCode)}`,
              },
            ],
            snapshot: {
              title: converted.title,
              category: converted.category,
              amountMinor: converted.amountMinor,
              originalCurrency: converted.originalCurrency,
              originalAmountMinor: converted.originalAmountMinor,
              fxRateScaled: converted.fxRateScaled,
              fxStatus: converted.fxStatus,
              splitMode: converted.splitMode,
              payers: converted.payers,
              splits: converted.splits,
              notes: converted.notes,
              groupCurrency: targetCode,
              convertedFrom: { currency: oldCode, fxRateScaled },
            },
            isConflictBranch: false,
            createdAt: nowIso,
            hlc,
          });
          return {
            ...converted,
            currentRevisionId: revId,
            revisionNumber: nextRevNum,
          };
        }
        return converted;
      });

      const updatedSettlements = prev.settlements.map((stl) =>
        stl.groupId === groupId
          ? redenominateSettlementCurrency({
              settlement: stl,
              newCurrency: targetCode,
              mode,
              fxRateScaled,
              hlc,
            })
          : stl
      );

      const act: GroupActivityItem = {
        id: newId('act'),
        groupId,
        actorMemberId: grp.members[0]?.id ?? 'mem',
        actorDisplayName: dataset.currentUser.fullName,
        entityType: 'currency',
        entityId: groupId,
        action: 'group_currency_changed',
        summaryText: `${dataset.currentUser.fullName} changed group base currency: ${oldCode} -> ${targetCode}`,
        detailNote:
          mode === 'relabel'
            ? `Re-labeled currency symbol (${oldCode} -> ${targetCode}) while preserving major numeric values.`
            : `Re-converted all active bills and settlements at ${rateNote}.`,
        diffBadges: [`${oldCode} -> ${targetCode}`, mode === 'relabel' ? 'Symbol Relabel' : `FX Rate ${formatScaledFxRate(fxRateScaled)}`],
        createdAt: nowIso,
        hlc,
      };

      return {
        ...prev,
        groups: prev.groups.map((g) =>
          g.id === groupId ? { ...g, baseCurrency: targetCode, updatedAt: nowIso, hlc } : g
        ),
        expenses: updatedExpenses,
        expenseRevisions:
          newRevisions.length > 0
            ? [...newRevisions, ...prev.expenseRevisions]
            : prev.expenseRevisions,
        settlements: updatedSettlements,
        groupActivityLog: [act, ...prev.groupActivityLog],
      };
    });

    showToast(
      mode === 'reconvert' && reconvertFx
        ? `Converted group to ${targetCode} at 1 ${target.baseCurrency} = ${formatScaledFxRate(reconvertFx.fxRateScaled)} ${targetCode} (${reconvertFx.fxRateDate})`
        : `Updated group currency to ${targetCode}`
    );
  };

  const addMemberToGroup: LedgerContextValue['addMemberToGroup'] = (groupId, input) => {
    const nowIso = new Date().toISOString();
    const hlc = makeHlc(dataset.currentUser.id);
    const newMemId = newId('mem');
    const grp = dataset.groups.find((g) => g.id === groupId);
    const nextOrder = grp ? grp.members.length : 1;
    const existing = grp && activeMemberNamed(grp, input.displayName);
    if (existing) {
      showToast(`There is already a ${existing.displayName} in this group. Add a last name or nickname.`);
      return existing;
    }

    const newMember: GroupMember = {
      id: newMemId,
      groupId,
      userId: null,
      invitedEmail: input.invitedEmail?.trim().toLowerCase() || null,
      displayName: input.displayName.normalize('NFC').trim().replace(/\s+/g, ' '),
      avatarInitials: getInitials(input.displayName),
      upiId: input.upiId?.trim() || null,
      role: 'member',
      memberOrder: nextOrder,
      joinedAt: nowIso,
      claimedAt: null,
    };

    const act: GroupActivityItem = {
      id: newId('act'),
      groupId,
      actorMemberId: grp?.members[0]?.id ?? newMemId,
      actorDisplayName: dataset.currentUser.fullName,
      entityType: 'member',
      entityId: newMemId,
      action: 'member_added',
      summaryText: `${dataset.currentUser.fullName} added ${newMember.displayName} to the group`,
      detailNote: newMember.invitedEmail
        ? `Unclaimed placeholder member (${newMember.invitedEmail}) ready for instant bill splitting; will auto-link on Google Sign-In.`
        : 'Added by name for immediate bill splitting.',
      diffBadges: [
        newMember.invitedEmail ? `Invite: ${newMember.invitedEmail}` : 'Unclaimed Member',
        ...(newMember.upiId ? [`UPI: ${newMember.upiId}`] : []),
      ],
      createdAt: nowIso,
      hlc,
    };

    setDataset((prev) => ({
      ...prev,
      groups: prev.groups.map((g) =>
        g.id === groupId ? { ...g, members: [...g.members, newMember] } : g
      ),
      groupActivityLog: [act, ...prev.groupActivityLog],
    }));

    showToast(`Added ${newMember.displayName} to group`);
    return newMember;
  };

  const saveDefaultSplitPreset: LedgerContextValue['saveDefaultSplitPreset'] = (groupId, preset) => {
    const nowIso = new Date().toISOString();
    const hlc = makeHlc(dataset.currentUser.id);
    setDataset((prev) => ({
      ...prev,
      groups: prev.groups.map((g) =>
        g.id === groupId ? { ...g, defaultSplitConfig: preset, updatedAt: nowIso, hlc } : g
      ),
    }));
    showToast(`Saved default split preset: ${preset.label}`);
  };

  const upsertExpense: LedgerContextValue['upsertExpense'] = (input) => {
    const nowIso = new Date().toISOString();
    const hlc = makeHlc(dataset.currentUser.id);
    const isDirectSplit = input.groupId === null;
    const grp = isDirectSplit ? null : dataset.groups.find((g) => g.id === input.groupId && !g.deletedAt);
    if (!isDirectSplit && !grp) {
      showToast('That group is no longer on this device, so the bill was not saved.');
      return null;
    }

    const existing = input.id ? dataset.expenses.find((e) => e.id === input.id) : undefined;
    if (existing && input.baseHlc && input.baseHlc !== existing.hlc) editBaseHlcsRef.current.set(existing.id, input.baseHlc);
    const expId = existing?.id ?? newId('exp');

    const adHocParticipants = isDirectSplit
      ? (input.adHocParticipants ?? existing?.adHocParticipants ?? [])
      : undefined;

    const myMemberId = isDirectSplit
      ? (adHocParticipants?.find(
          (p) => p.invitedEmail?.toLowerCase() === dataset.currentUser.email.toLowerCase()
        )?.id ?? dataset.currentUser.id)
      : (grp!.members.find((m) => m.userId === dataset.currentUser.id)?.id ?? dataset.currentUser.id);

    const rotationSeed = existing
      ? existing.rotationSeed
      : isDirectSplit
        ? dataset.expenses.filter((e) => e.groupId === null).length
        : grp!.expenseSeq;

    const revNum = existing ? existing.revisionNumber + 1 : 1;
    const revId = newId('rev');

    const origCode = input.originalCurrency.toUpperCase();
    const hasCustomFx =
      input.fxStatus !== 'identity' &&
      input.fxRateScaled > 0 &&
      input.fxRateScaled !== 100000000;

    const targetCurrency = isDirectSplit
      ? hasCustomFx
        ? dataset.currentUser.defaultCurrency.toUpperCase()
        : origCode
      : grp!.baseCurrency;

    let fxConv: ReturnType<typeof convertMinorAmountWithFx>;
    try {
      fxConv = convertMinorAmountWithFx({
        originalMinor: input.originalAmountMinor,
        fromCurrency: origCode,
        toCurrency: targetCurrency,
        fxRateScaled: input.fxRateScaled,
        fxStatus: input.fxStatus,
        dateIso: input.fxRateDate ?? input.expenseDate,
      });
    } catch {
      showToast(`This bill needs an exchange rate from ${origCode} to ${targetCurrency} before it can be saved.`);
      return null;
    }
    const problems = [
      ...expenseTextProblems({ title: input.title.trim(), notes: input.notes.trim(), tags: input.tags }),
      ...validateExpenseInvariants({ amountMinor: fxConv.convertedMinor, splitMode: input.splitMode, payers: input.payers, splits: input.splits }).errors,
    ];
    if (problems.length > 0) {
      showToast(`The bill was not saved: ${problems[0]}`);
      return null;
    }

    const resolvedReceipts: ReceiptAttachment[] = (
      input.receipts ??
      existing?.receipts ??
      []
    ).map((r) => ({
      ...r,
      expenseId: expId,
      localDeviceOnly: true,
      storageBucket: 'local-device-only',
      storagePath: r.storagePath ?? `local-device/${expId}.webp`,
    }));

    const newExpense: ExpenseItem = {
      id: expId,
      groupId: isDirectSplit ? null : grp!.id,
      ...(isDirectSplit ? { adHocParticipants } : {}),
      title: input.title.trim(),
      category: input.category,
      tags: input.tags,
      notes: input.notes.trim(),
      expenseDate: input.expenseDate,
      originalCurrency: origCode,
      originalAmountMinor: input.originalAmountMinor,
      groupCurrency: targetCurrency,
      amountMinor: fxConv.convertedMinor,
      fxRateScaled: input.fxRateScaled,
      fxStatus: input.fxStatus,
      fxAuditNote: fxConv.fxAuditNote,
      splitMode: input.splitMode,
      rotationSeed,
      payers: input.payers,
      splits: input.splits,
      currentRevisionId: revId,
      revisionNumber: revNum,
      hasUnresolvedConflict: existing?.hasUnresolvedConflict ?? false,
      conflictRevisionId: existing?.conflictRevisionId ?? null,
      createdByMemberId: existing?.createdByMemberId ?? myMemberId,
      updatedByMemberId: myMemberId,
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
      deletedAt: null,
      hlc,
      comments: existing?.comments ?? [],
      receipts: resolvedReceipts,
    };

    if (input.receipts && input.receipts.length > 0) {
      for (const r of resolvedReceipts) {
        if (!r.dataUrl) continue;
        void saveReceiptBlobLocally({
          id: r.id,
          expenseId: expId,
          groupId: newExpense.groupId,
          fileName: r.fileName,
          mimeType: r.mimeType,
          sizeKb: r.sizeKb,
          dataUrl: r.dataUrl,
          storageBucket: 'local-device-only',
          storagePath: r.storagePath ?? `local-device/${expId}.webp`,
          uploadedToCloud: false,
          createdAt: r.createdAt || nowIso,
        });
      }
    }

    const changes = existing
      ? [
          ...(existing.amountMinor !== newExpense.amountMinor
            ? [
                {
                  field: 'amount_minor',
                  fromValue: formatMinorToMajor(existing.amountMinor, targetCurrency),
                  toValue: formatMinorToMajor(newExpense.amountMinor, targetCurrency),
                  label: `Total changed from ${formatMinorToMajor(existing.amountMinor, targetCurrency)} to ${formatMinorToMajor(newExpense.amountMinor, targetCurrency)}`,
                },
              ]
            : []),
          ...(existing.splitMode !== newExpense.splitMode
            ? [
                {
                  field: 'split_mode',
                  fromValue: existing.splitMode,
                  toValue: newExpense.splitMode,
                  label: `Split mode changed from ${existing.splitMode} to ${newExpense.splitMode}`,
                },
              ]
            : []),
          ...(existing.title !== newExpense.title
            ? [
                {
                  field: 'title',
                  fromValue: existing.title,
                  toValue: newExpense.title,
                  label: `Renamed from "${existing.title}" to "${newExpense.title}"`,
                },
              ]
            : []),
        ]
      : [
          {
            field: 'created',
            fromValue: '0',
            toValue: formatMinorToMajor(newExpense.amountMinor, targetCurrency),
            label: `Logged ${formatMinorToMajor(newExpense.amountMinor, targetCurrency)} (${newExpense.splitMode.toUpperCase()} split)`,
          },
        ];

    const revision: ExpenseRevision = {
      id: revId,
      expenseId: expId,
      groupId: isDirectSplit ? null : grp!.id,
      revisionNumber: revNum,
      baseRevisionId: existing?.currentRevisionId ?? null,
      actorMemberId: myMemberId,
      actorDisplayName: dataset.currentUser.fullName,
      action: existing ? 'updated' : 'created',
      changes:
        changes.length > 0
          ? changes
          : [
              {
                field: 'splits',
                fromValue: 'previous',
                toValue: 'updated',
                label: 'Updated participant split shares',
              },
            ],
      snapshot: {
        title: newExpense.title,
        category: newExpense.category,
        amountMinor: newExpense.amountMinor,
        originalCurrency: newExpense.originalCurrency,
        originalAmountMinor: newExpense.originalAmountMinor,
        fxRateScaled: newExpense.fxRateScaled,
        fxStatus: newExpense.fxStatus,
        splitMode: newExpense.splitMode,
        payers: newExpense.payers,
        splits: newExpense.splits,
        notes: newExpense.notes,
        groupCurrency: newExpense.groupCurrency,
      },
      isConflictBranch: false,
      createdAt: nowIso,
      hlc,
    };

    const participantNames = (adHocParticipants ?? [])
      .map((p) => p.displayName)
      .filter(Boolean)
      .join(', ');

    const summaryText = isDirectSplit
      ? existing
        ? `${dataset.currentUser.fullName} updated Direct Non-Group Split "${newExpense.title}" (${formatMinorToMajor(newExpense.amountMinor, targetCurrency)})${participantNames ? ` among ${participantNames}` : ''}`
        : `${dataset.currentUser.fullName} added Direct Non-Group Split "${newExpense.title}" (${formatMinorToMajor(newExpense.amountMinor, targetCurrency)})${participantNames ? ` among ${participantNames}` : ''}`
      : existing
        ? `${dataset.currentUser.fullName} updated "${newExpense.title}" (${formatMinorToMajor(newExpense.amountMinor, targetCurrency)})`
        : `${dataset.currentUser.fullName} added "${newExpense.title}" (${formatMinorToMajor(newExpense.amountMinor, targetCurrency)})`;

    const activity: GroupActivityItem = {
      id: newId('act'),
      groupId: isDirectSplit ? null : grp!.id,
      actorMemberId: myMemberId,
      actorDisplayName: dataset.currentUser.fullName,
      entityType: 'expense',
      entityId: expId,
      action: existing ? 'expense_updated' : 'expense_created',
      summaryText,
      detailNote:
        revision.changes.map((c) => c.label).join('; ') +
        (isDirectSplit && participantNames ? ` | Direct Non-Group Split (${participantNames})` : '') +
        (newExpense.fxAuditNote ? ` | ${newExpense.fxAuditNote}` : ''),
      diffBadges: [
        ...(isDirectSplit ? ['Direct Non-Group Split'] : []),
        `${newExpense.splitMode.toUpperCase()} Split`,
        formatMinorToMajor(newExpense.amountMinor, targetCurrency),
        ...(newExpense.originalCurrency !== targetCurrency
          ? [`FX: ${formatMinorToMajor(newExpense.originalAmountMinor, newExpense.originalCurrency)}`]
          : []),
      ],
      createdAt: nowIso,
      hlc,
    };

    setDataset((prev) => ({
      ...prev,
      groups: isDirectSplit
        ? prev.groups
        : prev.groups.map((g) =>
            g.id === grp!.id
              ? {
                  ...g,
                  expenseSeq: existing ? g.expenseSeq : g.expenseSeq + 1,
                  lastAccessedAt: nowIso,
                }
              : g
          ),
      expenses: existing
        ? prev.expenses.map((e) => (e.id === expId ? newExpense : e))
        : [newExpense, ...prev.expenses],
      expenseRevisions: [revision, ...prev.expenseRevisions],
      groupActivityLog: [activity, ...prev.groupActivityLog],
    }));

    showToast(existing ? `Updated "${newExpense.title}"` : `Added "${newExpense.title}"`);
    return newExpense;
  };

  const softDeleteExpense = (expenseId: string) => {
    const nowIso = new Date().toISOString();
    const hlc = makeHlc(dataset.currentUser.id);
    setDataset((prev) => {
      const exp = prev.expenses.find((e) => e.id === expenseId);
      if (!exp) return prev;
      const act: GroupActivityItem = {
        id: newId('act'),
        groupId: exp.groupId,
        actorMemberId: exp.updatedByMemberId,
        actorDisplayName: dataset.currentUser.fullName,
        entityType: 'expense',
        entityId: expenseId,
        action: 'expense_deleted',
        summaryText: `${dataset.currentUser.fullName} moved "${exp.title}" (${formatMinorToMajor(exp.amountMinor, exp.groupCurrency)}) to Trash`,
        detailNote: 'Soft-deleted; can be restored from the Trash & Recovery drawer with 1 click.',
        diffBadges: ['Moved to Trash', formatMinorToMajor(exp.amountMinor, exp.groupCurrency)],
        createdAt: nowIso,
        hlc,
      };
      return {
        ...prev,
        expenses: prev.expenses.map((e) =>
          e.id === expenseId ? { ...e, deletedAt: nowIso, updatedAt: nowIso, hlc } : e
        ),
        groupActivityLog: [act, ...prev.groupActivityLog],
      };
    });
    showToast('Moved expense to Trash (restorable anytime).');
  };

  const restoreExpense = (expenseId: string) => {
    const nowIso = new Date().toISOString();
    const hlc = makeHlc(dataset.currentUser.id);
    setDataset((prev) => {
      const exp = prev.expenses.find((e) => e.id === expenseId);
      if (!exp) return prev;
      const act: GroupActivityItem = {
        id: newId('act'),
        groupId: exp.groupId,
        actorMemberId: exp.updatedByMemberId,
        actorDisplayName: dataset.currentUser.fullName,
        entityType: 'expense',
        entityId: expenseId,
        action: 'expense_restored',
        summaryText: `${dataset.currentUser.fullName} restored "${exp.title}" (${formatMinorToMajor(exp.amountMinor, exp.groupCurrency)}) from Trash`,
        detailNote: 'Expense restored to active ledger and balances recomputed.',
        diffBadges: ['Restored from Trash', formatMinorToMajor(exp.amountMinor, exp.groupCurrency)],
        createdAt: nowIso,
        hlc,
      };
      return {
        ...prev,
        expenses: prev.expenses.map((e) =>
          e.id === expenseId ? { ...e, deletedAt: null, updatedAt: nowIso, hlc } : e
        ),
        groupActivityLog: [act, ...prev.groupActivityLog],
      };
    });
    showToast('Restored expense from Trash.');
  };

  /**
   * Makes `revisionId` the bill's current version, converted into the bill's current currency.
   * Resolving a conflict in favour of the current version only clears the flag. Either way the
   * push carries baseHlc = the bill's hlc, so a race with another edit comes back as a conflict.
   */
  const applyExpenseRevision = (expenseId: string, revisionId: string, kind: 'resolve' | 'restore') => {
    const exp = dataset.expenses.find((e) => e.id === expenseId);
    if (!exp) return;
    const keepCurrent = revisionId === exp.currentRevisionId;
    const chosenRev = dataset.expenseRevisions.find((r) => r.id === revisionId);
    let body: ExpenseItem = exp;
    if (!keepCurrent) {
      const out = revisionInCurrentCurrency(exp, dataset.expenseRevisions, revisionId, (iso) =>
        dataset.groupActivityLog.some(
          (a) => exp.groupId !== null && a.groupId === exp.groupId && a.action === 'group_currency_changed' && a.createdAt > iso
        )
      );
      if (!out.ok) {
        showToast(out.reason);
        return;
      }
      body = out.expense;
    }
    const nowIso = new Date().toISOString();
    const hlc = makeHlc(dataset.currentUser.id);
    const who = chosenRev?.actorDisplayName ?? 'the current';
    setDataset((prev) => {
      const cur = prev.expenses.find((e) => e.id === expenseId);
      if (!cur) return prev;
      const resolvedExp: ExpenseItem = {
        ...cur,
        title: body.title,
        category: body.category,
        amountMinor: body.amountMinor,
        groupCurrency: body.groupCurrency,
        originalCurrency: body.originalCurrency,
        originalAmountMinor: body.originalAmountMinor,
        fxRateScaled: body.fxRateScaled,
        fxStatus: body.fxStatus,
        splitMode: body.splitMode,
        payers: body.payers,
        splits: body.splits,
        notes: body.notes,
        currentRevisionId: keepCurrent ? cur.currentRevisionId : revisionId,
        revisionNumber: cur.revisionNumber + 1,
        // The server clears the marker when it sees false plus the id being resolved.
        hasUnresolvedConflict: false,
        conflictRevisionId: cur.conflictRevisionId,
        updatedAt: nowIso,
        hlc,
      };
      const amount = formatMinorToMajor(resolvedExp.amountMinor, resolvedExp.groupCurrency);
      const act: GroupActivityItem = {
        id: newId('act'),
        groupId: exp.groupId,
        actorMemberId: exp.updatedByMemberId,
        actorDisplayName: dataset.currentUser.fullName,
        entityType: 'expense',
        entityId: expenseId,
        action: kind === 'resolve' ? 'expense_conflict_resolved' : 'expense_updated',
        summaryText:
          kind === 'resolve'
            ? `${dataset.currentUser.fullName} resolved offline edit conflict on "${resolvedExp.title}"`
            : `${dataset.currentUser.fullName} restored "${resolvedExp.title}" to version ${chosenRev?.revisionNumber ?? ''}`.trim(),
        detailNote: `Confirmed ${who}'s version (${amount}, ${resolvedExp.splitMode} split). Both revisions remain preserved in immutable history.`,
        diffBadges: [`Kept: ${who}`, amount],
        createdAt: nowIso,
        hlc,
      };
      return {
        ...prev,
        expenses: prev.expenses.map((e) => (e.id === expenseId ? resolvedExp : e)),
        groupActivityLog: [act, ...prev.groupActivityLog],
      };
    });
    showToast(kind === 'resolve' ? 'Resolved offline edit conflict and updated group ledger.' : 'Restored that version of the bill.');
  };

  const resolveExpenseConflict = (expenseId: string, chosenRevisionId: string) =>
    applyExpenseRevision(expenseId, chosenRevisionId, 'resolve');

  const restoreExpenseRevision = (expenseId: string, revisionId: string) =>
    applyExpenseRevision(expenseId, revisionId, 'restore');

  const refreshOfflineExpenseFx = (expenseId: string, _ignored?: number) => {
    const nowIso = new Date().toISOString();
    const hlc = makeHlc(dataset.currentUser.id);
    const target = dataset.expenses.find((e) => e.id === expenseId);
    const quote = target ? getFxQuote(target.originalCurrency, target.groupCurrency) : null;
    if (!target || !quote || quote.status !== 'live') {
      showToast('No live exchange rate yet. Connect to the internet and try again.');
      return;
    }
    const scaled = quote.rateScaled;
    setDataset((prev) => {
      const exp = prev.expenses.find((e) => e.id === expenseId);
      if (!exp) return prev;
      const conv = convertMinorAmountWithFx({
        originalMinor: exp.originalAmountMinor,
        fromCurrency: exp.originalCurrency,
        toCurrency: exp.groupCurrency,
        fxRateScaled: scaled,
        fxStatus: 'live',
        dateIso: quote.rateDate,
      });
      const reconciledPayers = reconcileMultiPayerFxContributions({
        payers: exp.payers.map((p) => ({
          memberId: p.memberId,
          originalPaidMinor: p.originalPaidMinor > 0 ? p.originalPaidMinor : p.paidMinor,
        })),
        originalCurrency: exp.originalCurrency,
        groupCurrency: exp.groupCurrency,
        fxRateScaled: scaled,
        targetAmountMinor: conv.convertedMinor,
        rotationSeed: exp.rotationSeed,
      }).payers;

      const includedIndices: number[] = [];
      const splitWeights: bigint[] = [];
      exp.splits.forEach((s, idx) => {
        if (s.included) {
          includedIndices.push(idx);
          splitWeights.push(BigInt(Math.max(0, Math.round(s.owedMinor))));
        }
      });
      const effectiveWeights =
        splitWeights.reduce((a, b) => a + b, 0n) > 0n
          ? splitWeights
          : splitWeights.map(() => 1n);
      const splitAlloc = allocateProportionalMinorAmounts(
        BigInt(conv.convertedMinor),
        effectiveWeights,
        exp.rotationSeed
      ).amounts;
      const includedOwedMap = new Map<number, number>();
      includedIndices.forEach((splitIdx, i) => {
        includedOwedMap.set(splitIdx, Number(splitAlloc[i]!));
      });
      const newSplits: ExpenseSplitShare[] = exp.splits.map((s, idx) => {
        const nextOwed = includedOwedMap.get(idx);
        if (nextOwed === undefined) {
          return { ...s, included: false, owedMinor: 0 };
        }
        return {
          ...s,
          included: true,
          owedMinor: nextOwed,
          ...(exp.splitMode === 'exact' ? { rawInputValue: nextOwed } : {}),
        };
      });

      const act: GroupActivityItem = {
        id: newId('act'),
        groupId: exp.groupId,
        actorMemberId: exp.updatedByMemberId,
        actorDisplayName: dataset.currentUser.fullName,
        entityType: 'expense',
        entityId: exp.id,
        action: 'expense_updated',
        summaryText: `${dataset.currentUser.fullName} refreshed offline FX rate on "${exp.title}"`,
        detailNote: conv.fxAuditNote ?? 'Updated to live FX rate',
        diffBadges: ['Live FX Locked', formatMinorToMajor(conv.convertedMinor, exp.groupCurrency)],
        createdAt: nowIso,
        hlc,
      };

      return {
        ...prev,
        expenses: prev.expenses.map((e) =>
          e.id === expenseId
            ? {
                ...e,
                amountMinor: conv.convertedMinor,
                fxRateScaled: scaled,
                fxStatus: 'live',
                fxAuditNote: conv.fxAuditNote,
                payers: reconciledPayers,
                splits: newSplits,
                updatedAt: nowIso,
                hlc,
              }
            : e
        ),
        groupActivityLog: [act, ...prev.groupActivityLog],
      };
    });
    showToast('Locked live exchange rate on expense.');
  };

  const addExpenseComment = (expenseId: string, body: string) => {
    const trimmed = body.trim();
    if (!trimmed) return;
    if (trimmed.length > 1000) {
      showToast('Comments can be up to 1,000 characters.');
      return;
    }
    const nowIso = new Date().toISOString();
    const hlc = makeHlc(dataset.currentUser.id);
    setDataset((prev) => {
      const exp = prev.expenses.find((e) => e.id === expenseId);
      if (!exp) return prev;
      const me =
        (exp.groupId === null
          ? myParticipantId(exp, dataset.currentUser.email)
          : prev.groups.find((g) => g.id === exp.groupId)?.members.find((m) => m.userId === dataset.currentUser.id)?.id) ??
        dataset.currentUser.id;
      const newComment = {
        id: newId('cmt'),
        expenseId,
        authorMemberId: me,
        authorName: dataset.currentUser.fullName,
        body: trimmed,
        createdAt: nowIso,
        isMine: true,
      };
      const act: GroupActivityItem = {
        id: newId('act'),
        groupId: exp.groupId,
        actorMemberId: me,
        actorDisplayName: dataset.currentUser.fullName,
        entityType: 'comment',
        entityId: expenseId,
        action: 'comment_added',
        summaryText: `${dataset.currentUser.fullName} commented on "${exp.title}"`,
        detailNote: `"${trimmed}"`,
        diffBadges: ['Comment'],
        createdAt: nowIso,
        hlc,
      };
      return {
        ...prev,
        expenses: prev.expenses.map((e) =>
          e.id === expenseId ? { ...e, comments: [...e.comments, newComment] } : e
        ),
        groupActivityLog: [act, ...prev.groupActivityLog],
      };
    });
  };

  const recordSettlement: LedgerContextValue['recordSettlement'] = (input) => {
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
      showToast('Enter an amount above zero to record a payment.');
      return;
    }
    const nowIso = new Date().toISOString();
    const hlc = makeHlc(dataset.currentUser.id);
    const grp = input.groupId ? dataset.groups.find((g) => g.id === input.groupId) : null;
    if (input.groupId && !grp) return;
    const directBill = grp
      ? null
      : dataset.expenses.find((e) => e.id === input.expenseId && e.groupId === null && !e.deletedAt);
    if (!grp && !directBill) {
      showToast('Pick the shared bill you are settling so both people can see it.');
      return;
    }
    if (
      directBill &&
      !canRecordDirectSettlement(directBill, dataset.currentUser.email, input.fromMemberId, input.toMemberId)
    ) {
      showToast('Only the person paying or the person being paid can record this settlement.');
      return;
    }

    const findParticipantName = (memberId: string): string => {
      if (grp) {
        return grp.members.find((m) => m.id === memberId)?.displayName ?? 'Member';
      }
      for (const exp of dataset.expenses) {
        if (exp.adHocParticipants) {
          const found = exp.adHocParticipants.find((p) => p.id === memberId);
          if (found) return found.displayName;
        }
      }
      return 'Member';
    };

    const fromName = findParticipantName(input.fromMemberId);
    const toName = findParticipantName(input.toMemberId);
    const stlCurrency = grp?.baseCurrency ?? input.currency ?? dataset.currentUser.defaultCurrency;
    const stlId = newId('stl');

    const newStl: SettlementItem = {
      id: stlId,
      groupId: grp ? grp.id : null,
      ...(directBill ? { expenseId: directBill.id } : {}),
      batchSettlementId: input.batchSettlementId ?? null,
      fromMemberId: input.fromMemberId,
      toMemberId: input.toMemberId,
      amountMinor: Math.round(input.amountMinor),
      currency: stlCurrency,
      paymentMethod: input.paymentMethod,
      paymentReference: input.paymentReference?.trim() || null,
      notes: input.notes?.trim() || '',
      settledDate: input.settledDate || localIsoDate(),
      createdAt: nowIso,
      deletedAt: null,
      hlc,
    };

    const act: GroupActivityItem = {
      id: newId('act'),
      groupId: grp ? grp.id : null,
      actorMemberId: input.fromMemberId,
      actorDisplayName: dataset.currentUser.fullName,
      entityType: 'settlement',
      entityId: stlId,
      action: 'settlement_recorded',
      summaryText: `${fromName} paid ${toName} ${formatMinorToMajor(newStl.amountMinor, stlCurrency)} via ${newStl.paymentMethod.toUpperCase()}`,
      detailNote: input.batchSettlementId
        ? `Recorded as part of Cross-Group Atomic Settlement Batch (${input.batchSettlementId})`
        : newStl.notes || 'Direct settlement recorded',
      diffBadges: [
        newStl.paymentMethod.toUpperCase(),
        formatMinorToMajor(newStl.amountMinor, stlCurrency),
        ...(input.batchSettlementId ? ['Cross-Group Batch'] : []),
      ],
      createdAt: nowIso,
      hlc,
    };

    setDataset((prev) => ({
      ...prev,
      settlements: [newStl, ...prev.settlements],
      groupActivityLog: [act, ...prev.groupActivityLog],
    }));

    showToast(`Recorded settlement: ${fromName} paid ${toName} ${formatMinorToMajor(newStl.amountMinor, stlCurrency)}`);
  };

  const deleteSettlement: LedgerContextValue['deleteSettlement'] = (settlementId) => {
    const stl = dataset.settlements.find((x) => x.id === settlementId && !x.deletedAt);
    if (!stl) return;
    const bill = stl.groupId === null ? dataset.expenses.find((e) => e.id === stl.expenseId) : undefined;
    if (
      stl.groupId === null &&
      (!bill || !canDeleteDirectSettlement(stl, bill, dataset.currentUser.email, dataset.currentUser.id))
    ) {
      showToast('Only the two people in this payment or the bill owner can remove it.');
      return;
    }
    const stlGroup = stl.groupId ? dataset.groups.find((g) => g.id === stl.groupId) : undefined;
    if (
      stl.groupId !== null &&
      (!stlGroup || !canChangeGroupSettlement(stl, stlGroup, dataset.currentUser.id, dataset.currentUser.email))
    ) {
      showToast('Only members of this group can remove its payments.');
      return;
    }
    const nowIso = new Date().toISOString();
    const hlc = makeHlc(dataset.currentUser.id);
    const act: GroupActivityItem = {
      id: newId('act'),
      groupId: stl.groupId,
      actorMemberId:
        (bill && myParticipantId(bill, dataset.currentUser.email)) ??
        stlGroup?.members.find((m) => m.userId === dataset.currentUser.id)?.id ??
        dataset.currentUser.id,
      actorDisplayName: dataset.currentUser.fullName,
      entityType: 'settlement',
      entityId: stl.id,
      action: 'settlement_deleted',
      summaryText: `${dataset.currentUser.fullName} removed a payment of ${formatMinorToMajor(stl.amountMinor, stl.currency)}`,
      detailNote: bill ? `Settlement on "${bill.title}" removed.` : 'Settlement removed.',
      diffBadges: ['Payment removed', formatMinorToMajor(stl.amountMinor, stl.currency)],
      createdAt: nowIso,
      hlc,
    };
    setDataset((prev) => ({
      ...prev,
      settlements: prev.settlements.map((x) =>
        x.id === settlementId ? { ...x, deletedAt: nowIso, hlc } : x
      ),
      groupActivityLog: [act, ...prev.groupActivityLog],
    }));
    showToast('Removed the payment.');
  };

  const restoreSettlement: LedgerContextValue['restoreSettlement'] = (settlementId) => {
    const stl = dataset.settlements.find((x) => x.id === settlementId && x.deletedAt);
    if (!stl) return;
    const bill = stl.groupId === null ? dataset.expenses.find((e) => e.id === stl.expenseId) : undefined;
    const grp = stl.groupId ? dataset.groups.find((g) => g.id === stl.groupId) : undefined;
    const me = dataset.currentUser;
    const problem = whyCannotRestoreSettlement(stl, dataset, me.id, me.email);
    if (problem) {
      showToast(problem);
      return;
    }
    const nowIso = new Date().toISOString();
    const hlc = makeHlc(me.id);
    const act: GroupActivityItem = {
      id: newId('act'),
      groupId: stl.groupId,
      actorMemberId:
        (bill && myParticipantId(bill, me.email)) ?? grp?.members.find((m) => m.userId === me.id)?.id ?? me.id,
      actorDisplayName: me.fullName,
      entityType: 'settlement',
      entityId: stl.id,
      action: 'settlement_restored',
      summaryText: `${me.fullName} brought back a payment of ${formatMinorToMajor(stl.amountMinor, stl.currency)}`,
      detailNote: bill ? `Payment on "${bill.title}" restored.` : 'Payment restored.',
      diffBadges: ['Payment restored', formatMinorToMajor(stl.amountMinor, stl.currency)],
      createdAt: nowIso,
      hlc,
    };
    setDataset((prev) => ({
      ...prev,
      settlements: prev.settlements.map((x) => (x.id === settlementId ? { ...x, deletedAt: null, hlc } : x)),
      groupActivityLog: [act, ...prev.groupActivityLog],
    }));
    showToast('Restored the payment.');
  };

  const editSettlement: LedgerContextValue['editSettlement'] = (settlementId, patch) => {
    const stl = dataset.settlements.find((x) => x.id === settlementId && !x.deletedAt);
    const grp = stl?.groupId ? dataset.groups.find((g) => g.id === stl.groupId) : undefined;
    if (!stl || !grp) return;
    if (!canChangeGroupSettlement(stl, grp, dataset.currentUser.id, dataset.currentUser.email)) {
      showToast('Only members of this group can change its payments.');
      return;
    }
    if (!Number.isSafeInteger(patch.amountMinor) || patch.amountMinor <= 0) {
      showToast('Enter an amount above zero to save the payment.');
      return;
    }
    const next: SettlementItem = {
      ...stl,
      amountMinor: patch.amountMinor,
      settledDate: patch.settledDate || stl.settledDate,
      paymentMethod: patch.paymentMethod,
      paymentReference: patch.paymentReference?.trim() || null,
      notes: patch.notes.trim(),
    };
    const fmt = (n: number) => formatMinorToMajor(n, stl.currency);
    const badges = [
      ...(stl.amountMinor !== next.amountMinor ? [`${fmt(stl.amountMinor)} to ${fmt(next.amountMinor)}`] : []),
      ...(stl.settledDate !== next.settledDate ? [`${stl.settledDate} to ${next.settledDate}`] : []),
      ...(stl.paymentMethod !== next.paymentMethod ? [`${stl.paymentMethod.toUpperCase()} to ${next.paymentMethod.toUpperCase()}`] : []),
      ...(stl.notes !== next.notes || stl.paymentReference !== next.paymentReference ? ['Note updated'] : []),
    ];
    if (badges.length === 0) {
      showToast('Nothing changed.');
      return;
    }
    const nowIso = new Date().toISOString();
    const hlc = makeHlc(dataset.currentUser.id);
    const nameOf = (id: string) => grp.members.find((m) => m.id === id)?.displayName ?? 'Member';
    const act: GroupActivityItem = {
      id: newId('act'),
      groupId: grp.id,
      actorMemberId: grp.members.find((m) => m.userId === dataset.currentUser.id)?.id ?? dataset.currentUser.id,
      actorDisplayName: dataset.currentUser.fullName,
      entityType: 'settlement',
      entityId: stl.id,
      action: 'settlement_updated',
      summaryText: `${dataset.currentUser.fullName} edited the payment from ${nameOf(stl.fromMemberId)} to ${nameOf(stl.toMemberId)}`,
      detailNote: next.notes || 'Payment edited.',
      diffBadges: badges,
      createdAt: nowIso,
      hlc,
    };
    setDataset((prev) => ({
      ...prev,
      settlements: prev.settlements.map((x) => (x.id === settlementId ? { ...next, hlc } : x)),
      groupActivityLog: [act, ...prev.groupActivityLog],
    }));
    showToast('Saved the payment.');
  };

  const isGroupAdmin: LedgerContextValue['isGroupAdmin'] = (group) =>
    isGroupAdminFor(group, dataset.currentUser.id);

  const restoreGroup: LedgerContextValue['restoreGroup'] = (groupId) => {
    const grp = dataset.groups.find((g) => g.id === groupId && g.deletedAt);
    if (!grp) return;
    if (!isGroupAdmin(grp)) {
      showToast('Only a group admin can restore this group.');
      return;
    }
    const nowIso = new Date().toISOString();
    const hlc = makeHlc(dataset.currentUser.id);
    const act: GroupActivityItem = {
      id: newId('act'),
      groupId,
      actorMemberId: grp.members.find((m) => m.userId === dataset.currentUser.id)?.id ?? dataset.currentUser.id,
      actorDisplayName: dataset.currentUser.fullName,
      entityType: 'group',
      entityId: groupId,
      action: 'group_updated',
      summaryText: `${dataset.currentUser.fullName} restored group "${grp.name}" from Trash`,
      detailNote: 'Group restored with all of its bills and settlements.',
      diffBadges: ['Restored from Trash'],
      createdAt: nowIso,
      hlc,
    };
    setDataset((prev) => ({
      ...prev,
      groups: prev.groups.map((g) => (g.id === groupId ? { ...g, deletedAt: null, updatedAt: nowIso, hlc } : g)),
      groupActivityLog: [act, ...prev.groupActivityLog],
    }));
    showToast(`Restored group "${grp.name}".`);
  };

  const myActiveMember = (grp: GroupRecord) =>
    grp.members.find((m) => m.userId === dataset.currentUser.id && !m.removedAt);

  /** Same rule as the server: only signed-in (claimed) admins count. */
  const isLastAdmin = (grp: GroupRecord, memberId: string) =>
    !grp.members.some((m) => m.id !== memberId && !m.removedAt && m.role === 'admin' && m.userId);

  const memberActivity = (
    grp: GroupRecord,
    entityId: string,
    action: GroupActivityItem['action'],
    summaryText: string,
    diffBadges: string[]
  ): GroupActivityItem => ({
    id: newId('act'),
    groupId: grp.id,
    actorMemberId: myActiveMember(grp)?.id ?? dataset.currentUser.id,
    actorDisplayName: dataset.currentUser.fullName,
    entityType: entityId === grp.id ? 'group' : 'member',
    entityId,
    action,
    summaryText,
    detailNote: '',
    diffBadges,
    createdAt: new Date().toISOString(),
    hlc: makeHlc(dataset.currentUser.id),
  });

  const updateMember = (groupId: string, memberId: string, patch: Partial<GroupMember>, act: GroupActivityItem) =>
    setDataset((prev) => ({
      ...prev,
      groups: prev.groups.map((g) =>
        g.id === groupId
          ? { ...g, members: g.members.map((m) => (m.id === memberId ? { ...m, ...patch } : m)) }
          : g
      ),
      groupActivityLog: [act, ...prev.groupActivityLog],
    }));

  const adminGroup = (groupId: string): GroupRecord | null => {
    const grp = dataset.groups.find((g) => g.id === groupId && !g.deletedAt);
    if (!grp) return null;
    if (!isGroupAdmin(grp)) {
      showToast('Only a group admin can do this.');
      return null;
    }
    return grp;
  };

  const joinGroupByCode: LedgerContextValue['joinGroupByCode'] = async (code) => {
    const session = sessionRef.current;
    if (!session) {
      showToast('Sign in to join a group, then enter the code again.');
      setAuthModalOpen(true);
      return false;
    }
    if (!isOnlineRef.current || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
      showToast('You are offline. Join the group once you are back online.');
      return false;
    }
    const auth = await resolveSessionToken(session);
    if (!auth.token) {
      if (auth.reason === 'unauthorized') handleAuthExpired();
      else showToast('Could not reach the server. Try again in a moment.');
      return false;
    }
    let res: Response;
    try {
      res = await fetch(resolveApiUrl('/api/groups/join'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${auth.token}`,
        },
        body: JSON.stringify({ code }),
      });
    } catch {
      showToast('Could not reach the server. Try again in a moment.');
      return false;
    }
    if (res.status === 401) {
      handleAuthExpired();
      return false;
    }
    if (res.status === 403) {
      const err = (await res.json().catch(() => null)) as { error?: unknown } | null;
      showToast(
        typeof err?.error === 'string' && err.error.trim()
          ? err.error
          : 'An admin removed you from this group. Ask them to add you back.'
      );
      return false;
    }
    if (!res.ok) {
      showToast(
        res.status === 404
          ? 'No group uses that code. Check it with the person who shared it.'
          : res.status === 429
            ? 'Too many tries. Wait a few minutes, then try again.'
            : res.status === 409
              ? 'This group is full, so no one else can join right now.'
            : 'That code did not work. Check it and try again.'
      );
      return false;
    }
    const body = (await res.json().catch(() => null)) as GroupJoinResponse | null;
    if (body?.groupId) {
      setActiveGroupIdState(body.groupId);
      setActivePage('groups');
    }
    showToast(
      body?.status === 'already_member'
        ? 'You are already in this group.'
        : 'You joined the group. Its bills are loading now.'
    );
    scheduleSync(0);
    return true;
  };

  const rotateInviteCode: LedgerContextValue['rotateInviteCode'] = (groupId) => {
    if (!adminGroup(groupId)) return;
    if (!sessionRef.current) {
      showToast('Sign in to get a new invite code.');
      return;
    }
    const hlc = makeHlc(dataset.currentUser.id);
    void enqueueSyncOutboxMutations([
      { entity: 'group', id: groupId, op: 'upsert', hlc, data: { id: groupId, hlc, rotateInviteCode: true } },
    ]).then(() => {
      refreshPendingCount();
      scheduleSync(0);
    });
    showToast('New invite code requested. The old code and link stop working once it syncs.');
  };

  const leaveGroup: LedgerContextValue['leaveGroup'] = (groupId) => {
    const grp = dataset.groups.find((g) => g.id === groupId);
    const me = grp && myActiveMember(grp);
    if (!grp || !me) return;
    const othersRemain = grp.members.some((m) => m.id !== me.id && !m.removedAt && m.userId);
    if (me.role === 'admin' && othersRemain && isLastAdmin(grp, me.id)) {
      showToast('Make someone else an admin first.');
      return;
    }
    const leaveHere = () => {
      evictLost('group', groupId).catch(() => showToast('Could not update this device. Reload to finish leaving.'));
      showToast(`You left "${grp.name}".`);
    };
    const session = sessionRef.current;
    if (!session) return leaveHere();
    const offline = () => showToast('You are offline. Leave the group once you are back online.');
    if (!isOnlineRef.current || (typeof navigator !== 'undefined' && navigator.onLine === false)) return offline();
    const hlc = makeHlc(dataset.currentUser.id);
    // The group stays on this device until the server has accepted the leave.
    void (async () => {
      const auth = await resolveSessionToken(session);
      if (!auth.token) return auth.reason === 'unauthorized' ? handleAuthExpired() : offline();
      const out = await pushNow(auth.token, [{ entity: 'group_member', id: me.id, op: 'delete', hlc, data: null }]);
      if (out === 'auth') return handleAuthExpired();
      if (out === 'offline') return offline();
      const result = out.find((r) => r.id === me.id);
      if (result?.status === 'applied') return leaveHere();
      showToast(
        /admin/i.test(result?.reason ?? '')
          ? 'Make someone else an admin first.'
          : 'The server did not let you leave this group right now. Nothing changed.'
      );
    })();
  };

  const removeMember: LedgerContextValue['removeMember'] = (groupId, memberId) => {
    const grp = adminGroup(groupId);
    const target = grp?.members.find((m) => m.id === memberId && !m.removedAt);
    if (!grp || !target) return;
    if (target.userId === dataset.currentUser.id) {
      showToast('Use Leave group to remove yourself.');
      return;
    }
    updateMember(
      groupId,
      memberId,
      { removedAt: new Date().toISOString() },
      memberActivity(grp, memberId, 'member_removed', `${dataset.currentUser.fullName} removed ${target.displayName} from the group`, [
        'Former member',
      ])
    );
    showToast(`Removed ${target.displayName}. Their past bills stay in the history.`);
  };

  const setMemberRole: LedgerContextValue['setMemberRole'] = (groupId, memberId, role) => {
    const grp = adminGroup(groupId);
    const target = grp?.members.find((m) => m.id === memberId && !m.removedAt);
    if (!grp || !target || target.role === role) return;
    if (role === 'member' && isLastAdmin(grp, memberId)) {
      showToast('A group needs an admin. Make someone else an admin first.');
      return;
    }
    updateMember(
      groupId,
      memberId,
      { role },
      memberActivity(
        grp,
        memberId,
        'group_updated',
        role === 'admin'
          ? `${dataset.currentUser.fullName} made ${target.displayName} an admin`
          : `${dataset.currentUser.fullName} removed admin rights from ${target.displayName}`,
        [role === 'admin' ? 'Admin' : 'Member']
      )
    );
    showToast(`${target.displayName} is now ${role === 'admin' ? 'an admin' : 'a member'}.`);
  };

  const deleteGroup: LedgerContextValue['deleteGroup'] = (groupId) => {
    const grp = adminGroup(groupId);
    if (!grp) return;
    const nowIso = new Date().toISOString();
    const act = memberActivity(grp, groupId, 'group_updated', `${dataset.currentUser.fullName} moved group "${grp.name}" to Trash`, [
      'Moved to Trash',
    ]);
    setDataset((prev) => ({
      ...prev,
      groups: prev.groups.map((g) =>
        g.id === groupId ? { ...g, deletedAt: nowIso, updatedAt: nowIso, hlc: act.hlc } : g
      ),
      groupActivityLog: [act, ...prev.groupActivityLog],
    }));
    showToast(`Moved "${grp.name}" to Trash. An admin can restore it from Trash.`);
  };

  const setMemberUpi: LedgerContextValue['setMemberUpi'] = (groupId, memberId, rawUpi) => {
    const grp = dataset.groups.find((g) => g.id === groupId && !g.deletedAt);
    const target = grp?.members.find((m) => m.id === memberId && !m.removedAt);
    if (!grp || !target || !myActiveMember(grp)) return false;
    if (!canEditMemberUpi(target, dataset.currentUser.id)) {
      showToast(`Only ${target.displayName} can change their UPI ID.`);
      return false;
    }
    const upiId = rawUpi.trim() || null;
    if (upiId && !isValidUpiId(upiId)) {
      showToast('Enter a UPI ID like name@bank.');
      return false;
    }
    if (upiId === (target.upiId ?? null)) return true;
    setDataset((prev) => ({
      ...prev,
      groups: prev.groups.map((g) =>
        g.id === groupId ? { ...g, members: g.members.map((m) => (m.id === memberId ? { ...m, upiId } : m)) } : g
      ),
    }));
    showToast(upiId ? `Saved the UPI ID for ${target.displayName}.` : `Removed the UPI ID for ${target.displayName}.`);
    return true;
  };

  const addMemberEmail: LedgerContextValue['addMemberEmail'] = (groupId, memberId, rawEmail) => {
    const grp = adminGroup(groupId);
    const target = grp?.members.find((m) => m.id === memberId && !m.removedAt);
    if (!grp || !target) return false;
    const email = rawEmail.trim().toLowerCase();
    if (target.userId) {
      showToast(`${target.displayName} has already joined, so their email is set by their account.`);
      return false;
    }
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showToast('Enter a valid email address.');
      return false;
    }
    if (grp.members.some((m) => m.id !== memberId && !m.removedAt && m.invitedEmail?.toLowerCase() === email)) {
      showToast('Someone in this group already uses that email.');
      return false;
    }
    updateMember(
      groupId,
      memberId,
      { invitedEmail: email },
      memberActivity(grp, memberId, 'group_updated', `${dataset.currentUser.fullName} added an email for ${target.displayName}`, [
        'Invite pending',
      ])
    );
    showToast(`Saved. ${target.displayName} can sign in with ${email} to claim their spot.`);
    return true;
  };

  const settleAllAcrossGroupsWithFriend: LedgerContextValue['settleAllAcrossGroupsWithFriend'] = (
    friendSummary,
    paymentMethod
  ) => {
    const batchId = newId('batch');
    const today = localIsoDate();

    for (const item of friendSummary.groupBreakdowns) {
      if (item.netMinor === 0 || item.groupId === null) continue;
      const fromMemberId = item.netMinor > 0 ? item.friendMemberId : item.myMemberId;
      const toMemberId = item.netMinor > 0 ? item.myMemberId : item.friendMemberId;
      recordSettlement({
        groupId: item.groupId,
        fromMemberId,
        toMemberId,
        amountMinor: Math.abs(item.netMinor),
        paymentMethod,
        settledDate: today,
        batchSettlementId: batchId,
        currency: item.currency,
        notes: `Cross-group net settlement with ${friendSummary.displayName}`,
      });
    }
    for (const plan of planDirectSettlements({
      userEmail: dataset.currentUser.email,
      friendKey: friendSummary.friendKey,
      expenses: dataset.expenses,
      settlements: dataset.settlements,
      fxRatesToInr: dataset.fxRatesToInr,
    })) {
      recordSettlement({
        groupId: null,
        expenseId: plan.expenseId,
        fromMemberId: plan.fromMemberId,
        toMemberId: plan.toMemberId,
        amountMinor: plan.amountMinor,
        paymentMethod,
        settledDate: today,
        batchSettlementId: batchId,
        currency: plan.currency,
        notes: `Direct bill settlement with ${friendSummary.displayName}`,
      });
    }
    showToast(`Recorded payments to settle up with ${friendSummary.displayName}.`);
  };

  const importSplitwiseExpenses: LedgerContextValue['importSplitwiseExpenses'] = (
    groupId,
    parsed,
    nameMapping,
    manualRates = {}
  ) => {
    const grp = dataset.groups.find((g) => g.id === groupId);
    if (!grp || parsed.expenses.length + parsed.payments.length === 0) return { expenses: 0, payments: 0, missingRates: [] };
    const fxFor = fxIntoBase(grp.baseCurrency, getFxQuote, manualRates);
    const missingRates = splitwiseMissingRates(parsed, grp.baseCurrency, fxFor);
    if (missingRates.length > 0) {
      showToast(`Enter an exchange rate for ${missingRates.join(', ')} before importing.`);
      return { expenses: 0, payments: 0, missingRates };
    }

    const { idByName, toCreate } = resolveSplitwiseMembers(parsed.memberNames, pickableMembers(grp.members), nameMapping);
    const created = toCreate.map((name) => addMemberToGroup(groupId, { displayName: name }));
    created.forEach((m, i) => idByName.set(toCreate[i]!, m.id));
    const plan = buildSplitwiseImportPlan({
      parsed,
      idByName,
      memberIds: [...pickableMembers(grp.members), ...created].map((m) => m.id),
      baseCurrency: grp.baseCurrency,
      fxFor,
    });

    for (const item of plan.expenses) {
      upsertExpense({
        groupId,
        ...item,
        title: item.title.slice(0, LIMITS.expenseTitle),
        tags: ['#splitwise-import'],
        notes: 'Imported from Splitwise',
        splitMode: 'exact',
      });
    }
    for (const stl of plan.settlements) {
      recordSettlement({
        groupId,
        fromMemberId: stl.fromMemberId,
        toMemberId: stl.toMemberId,
        amountMinor: stl.amountMinor,
        paymentMethod: 'other',
        settledDate: stl.settledDate,
        notes: stl.notes,
      });
    }
    showToast(
      `Imported ${plan.expenses.length} bills and ${plan.settlements.length} payments from Splitwise into "${grp.name}".`
    );
    return { expenses: plan.expenses.length, payments: plan.settlements.length, missingRates: [] };
  };

  const restoreFullDatasetFromBackup = (backup: LedgerEntities) => {
    const session = sessionRef.current;
    const current = datasetRef.current;
    // Signed in: a backup made while signed out names the sample "me"; it becomes this account, and
    // sample rows (which can never sync) stay out.
    const restored = session
      ? adoptLocalIdentity(takeLocalData({ ...current, ...backup }, SAMPLE_ENTITY_IDS).data, SAMPLE_ME, current.currentUser)
      : backup;
    const { dataset: next, report } = mergeLedgerEntities(current, restored);
    setDataset(next);
    // Signed in, the diff runs against the ledger as it was before the restore, so only new or newer
    // rows enqueue, each bill carrying baseHlc = this device's copy for the server's conflict check.
    if (!session) prevDatasetRef.current = next;
    if (session) void setSyncCursor(session.id, '0');
    if (restored.groups[0]) {
      setActiveGroupIdState(restored.groups[0].id);
    }
    const size = (d: LedgerEntities) => d.groups.length + d.expenses.length + d.settlements.length;
    const skipped = Math.max(0, size(backup) - size(restored));
    showToast(`Restored ${report.restored} items from the backup.`);
    return { ...report, skipped };
  };

  const resetToInitialMockData = () => {
    if (sessionRef.current) {
      void requestSignOut().then((done) => done && showToast('Signed out and reset this device to the sample ledger.'));
      return;
    }
    const fresh = cloneInitialDataset();
    replaceDataset(fresh);
    setActiveGroupIdState(fresh.groups[0]!.id);
    setPendingOutboxCount(0);
    setIsOnline(true);
    showToast('Reset ledger to initial mock-ledger-data.json state.');
  };

  return (
    <LedgerContext.Provider
      value={{
        dataset,
        activeGroupId,
        activeGroup,
        hasGroups: dataset.groups.some((g) => !g.deletedAt),
        recentGroups,
        activePage,
        theme,
        isOnline,
        pendingOutboxCount,
        toastMessage,
        expenseModalState,
        openAddExpenseModal,
        closeAddExpenseModal,
        isHelpModalOpen,
        setHelpModalOpen,
        isAuthModalOpen,
        setAuthModalOpen,
        isSignedIn: sessionUser !== null,
        adoptSignedInSession,
        pendingUserSwitch: pendingSwitch
          ? {
              email: pendingSwitch.profile.email,
              fullName: pendingSwitch.profile.fullName,
              unsynced: pendingSwitch.unsynced,
            }
          : null,
        resolvePendingUserSwitch,
        pendingLocalImport: pendingImport
          ? { email: pendingImport.profile.email, canImport: pendingImport.canImport, ...pendingImport.counts }
          : null,
        pendingSignOut,
        resolvePendingSignOut,
        retryRejected,
        discardRejected,
        resolvePendingLocalImport,
        downloadLocalBackup,
        signOut: requestSignOut,
        deleteAccount,
        switchActiveUserProfile,
        clearToast,
        showToast,
        setActiveGroupId,
        openGroupWorkspace,
        setActivePage,
        toggleTheme,
        toggleOfflineMode,
        triggerCloudSync,
        createGroup,
        toggleGroupSimplifyDebts,
        changeGroupBaseCurrency,
        addMemberToGroup,
        saveDefaultSplitPreset,
        upsertExpense,
        softDeleteExpense,
        deleteSettlement,
        restoreSettlement,
        editSettlement,
        restoreGroup,
        isGroupAdmin,
        joinGroupByCode,
        rotateInviteCode,
        leaveGroup,
        removeMember,
        setMemberRole,
        deleteGroup,
        addMemberEmail,
        setMemberUpi,
        restoreExpense,
        resolveExpenseConflict,
        restoreExpenseRevision,
        refreshOfflineExpenseFx,
        getFxQuote,
        addExpenseComment,
        recordSettlement,
        settleAllAcrossGroupsWithFriend,
        importSplitwiseExpenses,
        restoreFullDatasetFromBackup,
        resetToInitialMockData,
      }}
    >
      {isLoaded ? children : null}
    </LedgerContext.Provider>
  );
}

export function useLedger(): LedgerContextValue {
  const ctx = useContext(LedgerContext);
  if (!ctx) {
    throw new Error('useLedger must be used inside a LedgerProvider');
  }
  return ctx;
}
