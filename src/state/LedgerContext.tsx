import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
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
  parseFxRateToScaled,
} from '../domain/money/currencies';
import {
  allocateProportionalMinorAmounts,
  reconcileMultiPayerFxContributions,
  redenominateExpenseCurrency,
  redenominateSettlementCurrency,
} from '../domain/splits/split-calculator';
import { FriendCrossGroupSummary } from '../domain/ledger/ledger-engine';
import { ParsedSplitwiseExpense } from '../portability/portability-engine';
import {
  clearSyncOutbox,
  enqueueSyncOutboxMutation,
  saveDatasetToIndexedDb,
  saveReceiptBlobLocally,
} from '../storage/local-db';
import {
  exchangeGoogleOAuthSession,
  getBrowserSupabaseClient,
  resolveApiUrl,
  setBackendSessionToken,
  wiseSpliterSyncEngine,
} from '../sync-engine/supabase-sync';

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
  splitMode: SplitMode;
  payers: ExpensePayer[];
  splits: ExpenseSplitShare[];
  receipts?: ReceiptAttachment[];
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
    customFxRate?: number
  ) => void;
  addMemberToGroup: (
    groupId: string,
    input: { displayName: string; invitedEmail?: string; upiId?: string }
  ) => GroupMember;
  claimMemberAccount: (groupId: string, memberId: string) => void;
  saveDefaultSplitPreset: (groupId: string, preset: DefaultSplitPreset) => void;
  upsertExpense: (input: UpsertExpenseInput) => ExpenseItem;
  softDeleteExpense: (expenseId: string) => void;
  restoreExpense: (expenseId: string) => void;
  resolveExpenseConflict: (expenseId: string, chosenRevisionId: string) => void;
  restoreExpenseRevision: (expenseId: string, revisionId: string) => void;
  refreshOfflineExpenseFx: (expenseId: string, liveRate: number) => void;
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
  }) => void;
  settleAllAcrossGroupsWithFriend: (
    friendSummary: FriendCrossGroupSummary,
    paymentMethod: SettlementItem['paymentMethod']
  ) => void;
  importSplitwiseExpenses: (
    groupId: string,
    parsed: { memberNames: string[]; expenses: ParsedSplitwiseExpense[] }
  ) => number;
  restoreFullDatasetFromBackup: (restored: MockLedgerDataset) => void;
  resetToInitialMockData: () => void;
}

const STORAGE_KEY = 'wise_spliter_ledger_state_v1';
const THEME_KEY = 'wise_spliter_theme_v1';

function cloneInitialDataset(): MockLedgerDataset {
  return JSON.parse(JSON.stringify(initialMockData)) as MockLedgerDataset;
}

function makeHlc(userId: string): string {
  const hexMs = Date.now().toString(16).padStart(12, '0');
  const rand = Math.floor(Math.random() * 65535)
    .toString(16)
    .padStart(4, '0');
  return `${hexMs}-${rand}-${userId}`;
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
  const [dataset, setDataset] = useState<MockLedgerDataset>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as MockLedgerDataset;
        if (parsed && Array.isArray(parsed.groups) && parsed.groups.length > 0) {
          return parsed;
        }
      }
    } catch {
      // Fallback to mock JSON
    }
    return cloneInitialDataset();
  });

  const [activeGroupId, setActiveGroupIdState] = useState<string>(
    () => dataset.groups[0]?.id ?? 'grp_goa_2026'
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
  const [pendingOutboxCount, setPendingOutboxCount] = useState<number>(0);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const [expenseModalState, setExpenseModalState] = useState<ExpenseModalState>({
    isOpen: false,
    defaultGroupId: null,
    editingExpense: null,
  });
  const [isHelpModalOpen, setHelpModalOpen] = useState<boolean>(false);
  const [isAuthModalOpen, setAuthModalOpen] = useState<boolean>(false);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(dataset));
    } catch {
      // Ignore storage quota issues
    }
    void saveDatasetToIndexedDb(dataset);
    if (isOnline) {
      void wiseSpliterSyncEngine.pushDatasetToBackendApi(dataset);
    }
  }, [dataset, isOnline]);

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
    const client = getBrowserSupabaseClient();

    const completeGoogleCallbackIfPresent = async (accessToken: string) => {
      const exchanged = await exchangeGoogleOAuthSession(accessToken);
      if (!active || !exchanged.ok || !exchanged.profile) return;

      if (exchanged.dataset && Array.isArray(exchanged.dataset.groups)) {
        const nextDataset: MockLedgerDataset = {
          ...exchanged.dataset,
          currentUser: exchanged.profile,
        };
        setDataset(nextDataset);
        if (nextDataset.groups[0]?.id) {
          setActiveGroupIdState(nextDataset.groups[0].id);
        }
      } else {
        setDataset((prev) => ({
          ...prev,
          currentUser: exchanged.profile!,
        }));
      }
      setAuthModalOpen(false);
      setToastMessage(
        `Signed in with Google as ${exchanged.profile.fullName} (${exchanged.profile.email})`
      );

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

  const recordOutboxIfOffline = (entityType = 'ledger', action = 'mutation', payload: unknown = {}) => {
    if (!isOnline) {
      setPendingOutboxCount((c) => c + 1);
      const nowIso = new Date().toISOString();
      void enqueueSyncOutboxMutation({
        id: `outbox_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
        entityType,
        action,
        payloadJson: JSON.stringify(payload),
        createdAt: nowIso,
        hlc: makeHlc(dataset.currentUser.id),
      });
    }
  };

  const activeGroup = useMemo(() => {
    return (
      dataset.groups.find((g) => g.id === activeGroupId && !g.deletedAt) ??
      dataset.groups.find((g) => !g.deletedAt) ??
      dataset.groups[0]!
    );
  }, [dataset.groups, activeGroupId]);

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
    setIsOnline((prev) => {
      const next = !prev;
      setDataset((d) => ({
        ...d,
        currentUser: {
          ...d.currentUser,
          syncState: next ? 'synced' : 'offline_local',
          lastSyncedAt: next ? new Date().toISOString() : d.currentUser.lastSyncedAt,
        },
      }));
      if (next && pendingOutboxCount > 0) {
        const countToFlush = pendingOutboxCount;
        setPendingOutboxCount(0);
        void wiseSpliterSyncEngine.flushOutbox(countToFlush);
        showToast('Reconnected: Flushed offline outbox mutations to Supabase wise_spliter schema.');
      } else if (!next) {
        showToast('Switched to Offline Mode: All changes saved to local IndexedDB outbox.');
      }
      return next;
    });
  };

  const triggerCloudSync = () => {
    setIsOnline(true);
    const countToFlush = pendingOutboxCount;
    setPendingOutboxCount(0);
    const nowIso = new Date().toISOString();
    void wiseSpliterSyncEngine.flushOutbox(countToFlush);
    void wiseSpliterSyncEngine.pushDatasetToBackendApi(dataset);
    setDataset((d) => ({
      ...d,
      currentUser: {
        ...d.currentUser,
        syncState: 'synced',
        lastSyncedAt: nowIso,
      },
    }));
    showToast('Synced local database with Supabase wise_spliter schema.');
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
      if (payload.token) {
        setBackendSessionToken(payload.token, verifiedProfile);
      } else {
        await wiseSpliterSyncEngine.ensureBackendSessionToken({
          id: verifiedProfile.id,
          email: verifiedProfile.email,
          fullName: verifiedProfile.fullName,
        });
      }

      if (payload.dataset && Array.isArray(payload.dataset.groups)) {
        const nextDataset: MockLedgerDataset = {
          ...payload.dataset,
          currentUser: verifiedProfile,
        };
        setDataset(nextDataset);
        const firstGroupId = nextDataset.groups[0]?.id ?? 'grp_goa_2026';
        setActiveGroupIdState(firstGroupId);
        showToast(
          `Signed in as ${verifiedProfile.fullName} (${verifiedProfile.email}) - ${nextDataset.groups.length} group(s) loaded.`
        );
      } else {
        setDataset((prev) => ({
          ...prev,
          currentUser: verifiedProfile,
        }));
        showToast(`Signed in as ${verifiedProfile.fullName} (${verifiedProfile.email})`);
      }

      return true;
    } catch {
      showToast('Unable to reach authentication server (/api/auth/login).');
      return false;
    }
  };

  const createGroup: LedgerContextValue['createGroup'] = (input) => {
    const newId = `grp_${Date.now()}`;
    const myMemId = `mem_${Date.now()}_me`;
    const nowIso = new Date().toISOString();
    const hlc = makeHlc(dataset.currentUser.id);

    const newGroup: GroupRecord = {
      id: newId,
      name: input.name.trim(),
      description: input.description.trim(),
      category: input.category,
      baseCurrency: input.baseCurrency.toUpperCase(),
      simplifyDebts: input.simplifyDebts,
      defaultSplitConfig: null,
      expenseSeq: 0,
      inviteCode: `${input.name.slice(0, 4).toUpperCase().replace(/\W/g, 'GRP')}-${Math.floor(1000 + Math.random() * 9000)}`,
      createdAt: nowIso,
      updatedAt: nowIso,
      lastAccessedAt: nowIso,
      deletedAt: null,
      hlc,
      members: [
        {
          id: myMemId,
          groupId: newId,
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
      id: `act_${Date.now()}`,
      groupId: newId,
      actorMemberId: myMemId,
      actorDisplayName: dataset.currentUser.fullName,
      entityType: 'group',
      entityId: newId,
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
    setActiveGroupIdState(newId);
    recordOutboxIfOffline('group', 'group_created', { groupId: newId });
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
        id: `act_${Date.now()}`,
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
    recordOutboxIfOffline();
  };

  const changeGroupBaseCurrency: LedgerContextValue['changeGroupBaseCurrency'] = (
    groupId,
    newCurrency,
    mode,
    customFxRate
  ) => {
    const targetCode = newCurrency.toUpperCase();
    const nowIso = new Date().toISOString();
    const hlc = makeHlc(dataset.currentUser.id);

    setDataset((prev) => {
      const grp = prev.groups.find((g) => g.id === groupId);
      if (!grp || grp.baseCurrency === targetCode) return prev;
      const oldCode = grp.baseCurrency;

      const oldRateToInr = prev.fxRatesToInr[oldCode] ?? 1;
      const newRateToInr = prev.fxRatesToInr[targetCode] ?? 1;
      const computedCrossRate =
        customFxRate && customFxRate > 0 ? customFxRate : oldRateToInr / newRateToInr;
      const fxRateScaled = parseFxRateToScaled(String(computedCrossRate));

      const newRevisions: ExpenseRevision[] = [];
      const updatedExpenses = prev.expenses.map((exp) => {
        if (exp.groupId !== groupId) return exp;
        const converted = redenominateExpenseCurrency({
          expense: exp,
          newCurrency: targetCode,
          mode,
          fxRateScaled,
          updatedAt: nowIso,
          hlc,
        });
        if (mode === 'reconvert' && !exp.deletedAt) {
          const revId = `rev_${exp.id}_fx_${Date.now()}`;
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
        id: `act_${Date.now()}`,
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
            : `Re-converted all active bills and settlements at 1 ${oldCode} = ${computedCrossRate.toFixed(4)} ${targetCode}.`,
        diffBadges: [`${oldCode} -> ${targetCode}`, mode === 'relabel' ? 'Symbol Relabel' : `FX Rate ${computedCrossRate.toFixed(3)}`],
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

    recordOutboxIfOffline();
    showToast(`Updated group currency to ${targetCode}`);
  };

  const addMemberToGroup: LedgerContextValue['addMemberToGroup'] = (groupId, input) => {
    const nowIso = new Date().toISOString();
    const hlc = makeHlc(dataset.currentUser.id);
    const newMemId = `mem_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const grp = dataset.groups.find((g) => g.id === groupId);
    const nextOrder = grp ? grp.members.length : 1;

    const newMember: GroupMember = {
      id: newMemId,
      groupId,
      userId: null,
      invitedEmail: input.invitedEmail?.trim().toLowerCase() || null,
      displayName: input.displayName.trim(),
      avatarInitials: getInitials(input.displayName),
      upiId: input.upiId?.trim() || null,
      role: 'member',
      memberOrder: nextOrder,
      joinedAt: nowIso,
      claimedAt: null,
    };

    const act: GroupActivityItem = {
      id: `act_${Date.now()}`,
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
        g.id === groupId ? { ...g, members: [...g.members, newMember], updatedAt: nowIso, hlc } : g
      ),
      groupActivityLog: [act, ...prev.groupActivityLog],
    }));

    recordOutboxIfOffline();
    showToast(`Added ${newMember.displayName} to group`);
    return newMember;
  };

  const claimMemberAccount: LedgerContextValue['claimMemberAccount'] = (groupId, memberId) => {
    const nowIso = new Date().toISOString();
    const hlc = makeHlc(dataset.currentUser.id);
    setDataset((prev) => {
      const grp = prev.groups.find((g) => g.id === groupId);
      const mem = grp?.members.find((m) => m.id === memberId);
      if (!grp || !mem) return prev;

      const act: GroupActivityItem = {
        id: `act_${Date.now()}`,
        groupId,
        actorMemberId: memberId,
        actorDisplayName: mem.displayName,
        entityType: 'member',
        entityId: memberId,
        action: 'member_claimed',
        summaryText: `${mem.displayName} signed in with Google (${mem.invitedEmail ?? 'verified account'}) and linked their group ledger`,
        detailNote: 'All historical expenses, rotating remainders, and net balances are now synced to their Google account.',
        diffBadges: ['Google OAuth Verified', 'Auto-Linked'],
        createdAt: nowIso,
        hlc,
      };

      return {
        ...prev,
        groups: prev.groups.map((g) =>
          g.id === groupId
            ? {
                ...g,
                members: g.members.map((m) =>
                  m.id === memberId
                    ? { ...m, userId: `usr_claimed_${memberId}`, claimedAt: nowIso }
                    : m
                ),
              }
            : g
        ),
        groupActivityLog: [act, ...prev.groupActivityLog],
      };
    });
    recordOutboxIfOffline();
    showToast('Linked member profile to verified Google account.');
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
    const grp = isDirectSplit
      ? null
      : (dataset.groups.find((g) => g.id === input.groupId) ?? activeGroup);

    const existing = input.id ? dataset.expenses.find((e) => e.id === input.id) : undefined;
    const expId = existing?.id ?? `exp_${Date.now()}`;

    const adHocParticipants = isDirectSplit
      ? (input.adHocParticipants ?? existing?.adHocParticipants ?? [])
      : undefined;

    const myMemberId = isDirectSplit
      ? (adHocParticipants?.find(
          (p) => p.invitedEmail?.toLowerCase() === dataset.currentUser.email.toLowerCase()
        )?.id ??
          adHocParticipants?.[0]?.id ??
          input.payers[0]?.memberId ??
          dataset.currentUser.id)
      : ((grp!.members.find((m) => m.userId === dataset.currentUser.id) ?? grp!.members[0])!.id);

    const rotationSeed = existing
      ? existing.rotationSeed
      : isDirectSplit
        ? dataset.expenses.filter((e) => e.groupId === null).length
        : grp!.expenseSeq;

    const revNum = existing ? existing.revisionNumber + 1 : 1;
    const revId = `rev_${expId}_v${revNum}_${Date.now()}`;

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

    const fxConv = convertMinorAmountWithFx({
      originalMinor: input.originalAmountMinor,
      fromCurrency: origCode,
      toCurrency: targetCurrency,
      fxRateScaled: input.fxRateScaled,
      fxStatus: input.fxStatus,
      dateIso: input.expenseDate,
    });

    const resolvedReceipts: ReceiptAttachment[] = (
      input.receipts ??
      existing?.receipts ??
      []
    ).map((r) => ({
      ...r,
      expenseId: expId,
      storageBucket: r.storageBucket ?? 'wise-spliter-receipts',
      storagePath: r.storagePath ?? `receipts/${expId}.webp`,
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
      hasUnresolvedConflict: false,
      conflictRevisionId: null,
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
        void saveReceiptBlobLocally({
          id: r.id,
          expenseId: expId,
          groupId: newExpense.groupId,
          fileName: r.fileName,
          mimeType: r.mimeType,
          sizeKb: r.sizeKb,
          dataUrl: r.dataUrl ?? '',
          storageBucket: r.storageBucket ?? 'wise-spliter-receipts',
          storagePath: r.storagePath ?? `receipts/${expId}.webp`,
          uploadedToCloud: isOnline,
          createdAt: r.createdAt || nowIso,
        });
        if (isOnline && r.dataUrl) {
          void wiseSpliterSyncEngine.uploadReceiptAttachment({
            id: r.id,
            expenseId: expId,
            groupId: newExpense.groupId,
            fileName: r.fileName,
            mimeType: r.mimeType,
            sizeKb: r.sizeKb,
            uploadedByName: r.uploadedByName,
            previewNote: r.previewNote,
            dataUrl: r.dataUrl,
            hlc,
          });
        }
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
      id: `act_${Date.now()}`,
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
                  updatedAt: nowIso,
                  lastAccessedAt: nowIso,
                  hlc,
                }
              : g
          ),
      expenses: existing
        ? prev.expenses.map((e) => (e.id === expId ? newExpense : e))
        : [newExpense, ...prev.expenses],
      expenseRevisions: [revision, ...prev.expenseRevisions],
      groupActivityLog: [activity, ...prev.groupActivityLog],
    }));

    recordOutboxIfOffline('expense', existing ? 'expense_updated' : 'expense_created', {
      expenseId: expId,
      groupId: newExpense.groupId,
    });
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
        id: `act_${Date.now()}`,
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
    recordOutboxIfOffline();
    showToast('Moved expense to Trash (restorable anytime).');
  };

  const restoreExpense = (expenseId: string) => {
    const nowIso = new Date().toISOString();
    const hlc = makeHlc(dataset.currentUser.id);
    setDataset((prev) => {
      const exp = prev.expenses.find((e) => e.id === expenseId);
      if (!exp) return prev;
      const act: GroupActivityItem = {
        id: `act_${Date.now()}`,
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
    recordOutboxIfOffline();
    showToast('Restored expense from Trash.');
  };

  const resolveExpenseConflict = (expenseId: string, chosenRevisionId: string) => {
    const nowIso = new Date().toISOString();
    const hlc = makeHlc(dataset.currentUser.id);
    setDataset((prev) => {
      const exp = prev.expenses.find((e) => e.id === expenseId);
      const chosenRev = prev.expenseRevisions.find((r) => r.id === chosenRevisionId);
      if (!exp || !chosenRev) return prev;

      const snap = chosenRev.snapshot;
      const resolvedExp: ExpenseItem = {
        ...exp,
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
        currentRevisionId: chosenRev.id,
        revisionNumber: exp.revisionNumber + 1,
        hasUnresolvedConflict: false,
        conflictRevisionId: null,
        updatedAt: nowIso,
        hlc,
      };

      const act: GroupActivityItem = {
        id: `act_${Date.now()}`,
        groupId: exp.groupId,
        actorMemberId: exp.updatedByMemberId,
        actorDisplayName: dataset.currentUser.fullName,
        entityType: 'expense',
        entityId: expenseId,
        action: 'expense_conflict_resolved',
        summaryText: `${dataset.currentUser.fullName} resolved offline edit conflict on "${resolvedExp.title}"`,
        detailNote: `Confirmed ${chosenRev.actorDisplayName}'s version (${formatMinorToMajor(resolvedExp.amountMinor, resolvedExp.groupCurrency)}, ${resolvedExp.splitMode} split). Both revisions remain preserved in immutable history.`,
        diffBadges: [
          `Kept: ${chosenRev.actorDisplayName}`,
          formatMinorToMajor(resolvedExp.amountMinor, resolvedExp.groupCurrency),
        ],
        createdAt: nowIso,
        hlc,
      };

      return {
        ...prev,
        expenses: prev.expenses.map((e) => (e.id === expenseId ? resolvedExp : e)),
        groupActivityLog: [act, ...prev.groupActivityLog],
      };
    });
    recordOutboxIfOffline();
    showToast('Resolved offline edit conflict and updated group ledger.');
  };

  const restoreExpenseRevision = (expenseId: string, revisionId: string) => {
    resolveExpenseConflict(expenseId, revisionId);
  };

  const refreshOfflineExpenseFx = (expenseId: string, liveRate: number) => {
    const nowIso = new Date().toISOString();
    const hlc = makeHlc(dataset.currentUser.id);
    const scaled = parseFxRateToScaled(String(liveRate));
    setDataset((prev) => {
      const exp = prev.expenses.find((e) => e.id === expenseId);
      if (!exp) return prev;
      const conv = convertMinorAmountWithFx({
        originalMinor: exp.originalAmountMinor,
        fromCurrency: exp.originalCurrency,
        toCurrency: exp.groupCurrency,
        fxRateScaled: scaled,
        fxStatus: 'live',
        dateIso: nowIso.slice(0, 10),
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
        id: `act_${Date.now()}`,
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
    const nowIso = new Date().toISOString();
    const hlc = makeHlc(dataset.currentUser.id);
    setDataset((prev) => {
      const exp = prev.expenses.find((e) => e.id === expenseId);
      if (!exp) return prev;
      const newComment = {
        id: `cmt_${Date.now()}`,
        expenseId,
        authorMemberId: exp.createdByMemberId,
        authorName: dataset.currentUser.fullName,
        body: trimmed,
        createdAt: nowIso,
      };
      const act: GroupActivityItem = {
        id: `act_${Date.now()}`,
        groupId: exp.groupId,
        actorMemberId: exp.createdByMemberId,
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
    recordOutboxIfOffline();
  };

  const recordSettlement: LedgerContextValue['recordSettlement'] = (input) => {
    const nowIso = new Date().toISOString();
    const hlc = makeHlc(dataset.currentUser.id);
    const grp = input.groupId ? dataset.groups.find((g) => g.id === input.groupId) : null;
    if (input.groupId && !grp) return;

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
    const stlId = `stl_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

    const newStl: SettlementItem = {
      id: stlId,
      groupId: grp ? grp.id : null,
      batchSettlementId: input.batchSettlementId ?? null,
      fromMemberId: input.fromMemberId,
      toMemberId: input.toMemberId,
      amountMinor: Math.round(input.amountMinor),
      currency: stlCurrency,
      paymentMethod: input.paymentMethod,
      paymentReference: input.paymentReference?.trim() || null,
      notes: input.notes?.trim() || '',
      settledDate: input.settledDate ?? nowIso.slice(0, 10),
      createdAt: nowIso,
      deletedAt: null,
      hlc,
    };

    const act: GroupActivityItem = {
      id: `act_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
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

    recordOutboxIfOffline('settlement', 'settlement_recorded', {
      settlementId: stlId,
      groupId: newStl.groupId,
    });
    showToast(`Recorded settlement: ${fromName} paid ${toName} ${formatMinorToMajor(newStl.amountMinor, stlCurrency)}`);
  };

  const settleAllAcrossGroupsWithFriend: LedgerContextValue['settleAllAcrossGroupsWithFriend'] = (
    friendSummary,
    paymentMethod
  ) => {
    const batchId = `batch_${Date.now()}`;
    const today = new Date().toISOString().slice(0, 10);

    for (const item of friendSummary.groupBreakdowns) {
      if (item.netMinor === 0) continue;
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
    showToast(`Settled all shared group balances with ${friendSummary.displayName} in 1 atomic batch.`);
  };

  const importSplitwiseExpenses: LedgerContextValue['importSplitwiseExpenses'] = (
    groupId,
    parsed
  ) => {
    const grp = dataset.groups.find((g) => g.id === groupId);
    if (!grp || parsed.expenses.length === 0) return 0;

    let count = 0;
    for (const item of parsed.expenses) {
      const itemCurrency = (item.currency || grp.baseCurrency).trim().toUpperCase();
      const sameCurrency = itemCurrency === grp.baseCurrency.toUpperCase();
      const fromToInr = dataset.fxRatesToInr[itemCurrency] ?? 1;
      const toInr = dataset.fxRatesToInr[grp.baseCurrency.toUpperCase()] ?? 1;
      const crossRate = sameCurrency ? 1 : fromToInr / toInr;
      const fxRateScaled = sameCurrency ? 100000000 : parseFxRateToScaled(String(crossRate));
      const conv = convertMinorAmountWithFx({
        originalMinor: item.amountMinor,
        fromCurrency: itemCurrency,
        toCurrency: grp.baseCurrency,
        fxRateScaled,
        fxStatus: sameCurrency ? 'identity' : 'live',
        dateIso: item.date,
      });

      const resolvedPayersRaw =
        item.payers.length > 0
          ? item.payers.map((p) => {
              const matchedMem =
                grp.members.find(
                  (m) => m.displayName.toLowerCase() === p.memberName.toLowerCase()
                ) ?? grp.members[0]!;
              return {
                memberId: matchedMem.id,
                originalPaidMinor: p.paidMinor,
              };
            })
          : [
              {
                memberId: grp.members[0]!.id,
                originalPaidMinor: item.amountMinor,
              },
            ];

      const reconciledPayers = reconcileMultiPayerFxContributions({
        payers: resolvedPayersRaw,
        originalCurrency: itemCurrency,
        groupCurrency: grp.baseCurrency,
        fxRateScaled,
        targetAmountMinor: conv.convertedMinor,
      }).payers;

      const rawMemberOrigWeights = grp.members.map((m) => {
        const matched = item.splits.find(
          (s) => s.memberName.toLowerCase() === m.displayName.toLowerCase()
        );
        return BigInt(Math.max(0, matched ? matched.owedMinor : 0));
      });
      const effectiveOrigWeights =
        rawMemberOrigWeights.reduce((a, b) => a + b, 0n) > 0n
          ? rawMemberOrigWeights
          : grp.members.map((_, idx) => (idx === 0 ? 1n : 0n));

      const baseSplitAlloc = allocateProportionalMinorAmounts(
        BigInt(conv.convertedMinor),
        effectiveOrigWeights,
        0
      ).amounts;
      const origSplitAlloc = allocateProportionalMinorAmounts(
        BigInt(item.amountMinor),
        effectiveOrigWeights,
        0
      ).amounts;

      const splits: ExpenseSplitShare[] = grp.members.map((m, idx) => {
        const owed = Number(baseSplitAlloc[idx]!);
        const origOwed = Number(origSplitAlloc[idx]!);
        return {
          memberId: m.id,
          included: owed > 0 || origOwed > 0,
          owedMinor: owed,
          originalOwedMinor: origOwed,
          rawInputValue: owed,
          remainderMinor: 0,
        };
      });

      upsertExpense({
        groupId,
        title: item.title,
        category: (item.category as ExpenseCategoryKey) || 'general',
        tags: ['#splitwise-import'],
        notes: 'Imported from Splitwise CSV',
        expenseDate: item.date,
        originalCurrency: itemCurrency,
        originalAmountMinor: item.amountMinor,
        fxRateScaled,
        fxStatus: sameCurrency ? 'identity' : 'live',
        splitMode: 'exact',
        payers: reconciledPayers,
        splits,
      });
      count++;
    }
    showToast(`Imported ${count} expenses from Splitwise into "${grp.name}".`);
    return count;
  };

  const restoreFullDatasetFromBackup = (restored: MockLedgerDataset) => {
    setDataset(restored);
    if (restored.groups[0]) {
      setActiveGroupIdState(restored.groups[0].id);
    }
    showToast('Restored full ledger state from backup.');
  };

  const resetToInitialMockData = () => {
    const fresh = cloneInitialDataset();
    setDataset(fresh);
    setActiveGroupIdState(fresh.groups[0]!.id);
    setPendingOutboxCount(0);
    setIsOnline(true);
    void clearSyncOutbox();
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Ignore
    }
    void saveDatasetToIndexedDb(fresh);
    showToast('Reset ledger to initial mock-ledger-data.json state.');
  };

  return (
    <LedgerContext.Provider
      value={{
        dataset,
        activeGroupId,
        activeGroup,
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
        claimMemberAccount,
        saveDefaultSplitPreset,
        upsertExpense,
        softDeleteExpense,
        restoreExpense,
        resolveExpenseConflict,
        restoreExpenseRevision,
        refreshOfflineExpenseFx,
        addExpenseComment,
        recordSettlement,
        settleAllAcrossGroupsWithFriend,
        importSplitwiseExpenses,
        restoreFullDatasetFromBackup,
        resetToInitialMockData,
      }}
    >
      {children}
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
