export type CurrencyDecimals = 0 | 2 | 3;

export interface CurrencyDefinition {
  code: string;
  name: string;
  symbol: string;
  decimals: CurrencyDecimals;
  flagCode: string;
}

export type SplitMode = 'equal' | 'exact' | 'percentage' | 'shares' | 'adjustment';

export type FxStatus = 'identity' | 'live' | 'cached_offline' | 'manual';

export type ExpenseCategoryKey =
  | 'food'
  | 'lodging'
  | 'transport'
  | 'utilities'
  | 'groceries'
  | 'activities'
  | 'flights'
  | 'shopping'
  | 'general';

export interface CategoryMeta {
  key: ExpenseCategoryKey;
  label: string;
  description: string;
}

export type GroupActivityActionType =
  | 'group_created'
  | 'group_updated'
  | 'group_currency_changed'
  | 'member_added'
  | 'member_claimed'
  | 'member_removed'
  | 'expense_created'
  | 'expense_updated'
  | 'expense_deleted'
  | 'expense_restored'
  | 'expense_conflict_flagged'
  | 'expense_conflict_resolved'
  | 'settlement_recorded'
  | 'settlement_deleted'
  | 'comment_added';

export interface ActionTypeCatalogItem {
  action: GroupActivityActionType;
  label: string;
  badgeTone: 'emerald' | 'blue' | 'amber' | 'rose' | 'slate';
  sampleNoteTemplate: string;
}

export interface UserProfile {
  id: string;
  email: string;
  fullName: string;
  avatarInitials: string;
  defaultCurrency: string;
  upiId: string;
  googleConnected: boolean;
  supabaseSchema: string;
  syncState: 'synced' | 'offline_local' | 'syncing';
  lastSyncedAt: string;
}

export interface GroupMember {
  id: string;
  groupId: string;
  userId: string | null;
  invitedEmail: string | null;
  displayName: string;
  avatarInitials: string;
  upiId: string | null;
  role: 'admin' | 'member';
  memberOrder: number;
  joinedAt: string;
  claimedAt: string | null;
}

export interface ExpensePayer {
  memberId: string;
  paidMinor: number; // Integer minor units (e.g. paise/cents/fils/yen)
  originalPaidMinor: number;
}

export interface ExpenseSplitShare {
  memberId: string;
  included: boolean;
  owedMinor: number; // Frozen integer minor units in group base currency
  originalOwedMinor: number;
  rawInputValue: number; // Share weight, basis points (10000 = 100%), adjustment minor, or exact minor
  remainderMinor: number; // 1 if rotating remainder assigned to this member, else 0
}

export interface ExpenseComment {
  id: string;
  expenseId: string;
  authorMemberId: string;
  authorName: string;
  body: string;
  createdAt: string;
}

export interface ReceiptAttachment {
  id: string;
  expenseId: string;
  fileName: string;
  mimeType: string;
  sizeKb: number;
  uploadedByName: string;
  createdAt: string;
  previewNote: string;
}

export interface RevisionChangeField {
  field: string;
  fromValue: string;
  toValue: string;
  label: string;
}

export interface ExpenseSnapshotData {
  title: string;
  category: ExpenseCategoryKey;
  amountMinor: number;
  originalCurrency: string;
  originalAmountMinor: number;
  fxRateScaled: number;
  fxStatus: FxStatus;
  splitMode: SplitMode;
  payers: ExpensePayer[];
  splits: ExpenseSplitShare[];
  notes: string;
}

export interface ExpenseRevision {
  id: string;
  expenseId: string;
  groupId: string;
  revisionNumber: number;
  baseRevisionId: string | null;
  actorMemberId: string;
  actorDisplayName: string;
  action:
    | 'created'
    | 'updated'
    | 'deleted'
    | 'restored'
    | 'currency_reconverted'
    | 'conflict_superseded'
    | 'conflict_resolved';
  changes: RevisionChangeField[];
  snapshot: ExpenseSnapshotData;
  isConflictBranch: boolean;
  createdAt: string;
  hlc: string;
}

export interface ExpenseItem {
  id: string;
  groupId: string;
  title: string;
  category: ExpenseCategoryKey;
  tags: string[];
  notes: string;
  expenseDate: string;
  originalCurrency: string;
  originalAmountMinor: number;
  groupCurrency: string;
  amountMinor: number;
  fxRateScaled: number; // Scaled by 10^8 (100000000 = 1.0)
  fxStatus: FxStatus;
  fxAuditNote: string | null;
  splitMode: SplitMode;
  rotationSeed: number;
  payers: ExpensePayer[];
  splits: ExpenseSplitShare[];
  currentRevisionId: string;
  revisionNumber: number;
  hasUnresolvedConflict: boolean;
  conflictRevisionId: string | null;
  createdByMemberId: string;
  updatedByMemberId: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  hlc: string;
  comments: ExpenseComment[];
  receipts: ReceiptAttachment[];
}

export interface SettlementItem {
  id: string;
  groupId: string;
  batchSettlementId: string | null;
  fromMemberId: string;
  toMemberId: string;
  amountMinor: number;
  currency: string;
  paymentMethod: 'upi' | 'cash' | 'bank' | 'paypal' | 'venmo' | 'other';
  paymentReference: string | null;
  notes: string;
  settledDate: string;
  createdAt: string;
  deletedAt: string | null;
  hlc: string;
}

export interface GroupActivityItem {
  id: string;
  groupId: string;
  actorMemberId: string;
  actorDisplayName: string;
  entityType: 'group' | 'member' | 'expense' | 'settlement' | 'comment' | 'currency';
  entityId: string;
  action: GroupActivityActionType;
  summaryText: string;
  detailNote: string;
  diffBadges: string[];
  createdAt: string;
  hlc: string;
}

export interface DefaultSplitPreset {
  label: string;
  splitMode: SplitMode;
  memberValues: Record<string, number>;
}

export interface GroupRecord {
  id: string;
  name: string;
  description: string;
  category: 'trip' | 'home' | 'couple' | 'friends' | 'other';
  baseCurrency: string;
  simplifyDebts: boolean;
  defaultSplitConfig: DefaultSplitPreset | null;
  expenseSeq: number;
  inviteCode: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  hlc: string;
  members: GroupMember[];
}

export interface SuggestedTransfer {
  fromMemberId: string;
  toMemberId: string;
  amountMinor: number;
  explanationNote: string;
}

export interface MemberBalanceExplanation {
  memberId: string;
  memberName: string;
  currency: string;
  totalPaidMinor: number;
  totalShareMinor: number;
  settlementsSentMinor: number;
  settlementsReceivedMinor: number;
  netBalanceMinor: number;
  equationText: string;
  contributingItems: Array<{
    id: string;
    type: 'expense' | 'settlement';
    title: string;
    date: string;
    paidMinor: number;
    owedMinor: number;
    netDeltaMinor: number;
    splitBadge: string;
  }>;
}

export interface MockLedgerDataset {
  schemaVersion: number;
  currentUser: UserProfile;
  fxRatesToInr: Record<string, number>;
  currenciesCatalog: CurrencyDefinition[];
  categoriesCatalog: CategoryMeta[];
  actionTypesCatalog: ActionTypeCatalogItem[];
  groups: GroupRecord[];
  expenses: ExpenseItem[];
  expenseRevisions: ExpenseRevision[];
  settlements: SettlementItem[];
  groupActivityLog: GroupActivityItem[];
  sampleSplitwiseCsv: string;
  sampleSplitwiseJson: string;
}
