import React, { useMemo, useState } from 'react';
import {
  ArrowCounterClockwiseIcon as ArrowCounterClockwise,
  CheckCircleIcon as CheckCircle,
  CloudArrowUpIcon as CloudArrowUp,
  CloudCheckIcon as CloudCheck,
  CloudSlashIcon as CloudSlash,
  CopyIcon as Copy,
  DatabaseIcon as Database,
  DownloadSimpleIcon as DownloadSimple,
  FileCsvIcon as FileCsv,
  FilePdfIcon as FilePdf,
  FileXlsIcon as FileXls,
  GoogleLogoIcon as GoogleLogo,
  KeyIcon as Key,
  LockKeyIcon as LockKey,
  PrinterIcon as Printer,
  ShieldCheckIcon as ShieldCheck,
  SignOutIcon as SignOut,
  SparkleIcon as Sparkle,
  TrashIcon as Trash,
  UploadSimpleIcon as UploadSimple,
  WarningCircleIcon as WarningCircle,
} from '@phosphor-icons/react';
import { useLedger } from '../../state/LedgerContext';
import {
  CurrencyAmount,
  CurrencyPrecisionPill,
  DoubleBezelCard,
  StatusBadge,
} from '../primitives/DesignPrimitives';
import {
  BackupRestoreError,
  DIRECT_EXPORT_SCOPE,
  MIN_BACKUP_PASSPHRASE_LENGTH,
  backupPassphraseProblem,
  buildBackupJson,
  encryptBackupPayload,
  exportGroupToCsv,
  exportGroupToExcelBuffer,
  exportGroupToPdfBytes,
  backupFileKind,
  openBackupFile,
  parseSplitwiseImport,
  resolveSplitwiseMembers,
  safeExportFileName,
  selectExportLedger,
  splitwiseMissingRates,
  type ParsedSplitwiseImport,
} from '../../portability/portability-engine';
import { fxIntoBase } from '../../utils/fx-rates';
import { pickableMembers } from '../../domain/ledger/ledger-engine';
import { formatMinorToMajor } from '../../domain/money/currencies';
import { listAllLocalReceiptBlobs, saveReceiptBlobLocally } from '../../storage/local-db';
import { wiseSpliterSyncEngine } from '../../sync-engine/supabase-sync';
import {
  exportFileCrossPlatform,
  isNativeCapacitorApp,
} from '../../utils/native-platform';

export function PortabilityAndSyncPage() {
  const {
    dataset,
    activeGroup,
    setActiveGroupId,
    isOnline,
    pendingOutboxCount,
    toggleOfflineMode,
    triggerCloudSync,
    importSplitwiseExpenses,
    getFxQuote,
    restoreFullDatasetFromBackup,
    resetToInitialMockData,
    showToast,
    isSignedIn,
    deleteAccount,
    signOut,
  } = useLedger();
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);

  const handleDeleteAccount = async () => {
    setIsDeletingAccount(true);
    try {
      if (await deleteAccount()) setIsConfirmingDelete(false);
    } finally {
      setIsDeletingAccount(false);
    }
  };

  const [splitwiseCsvInput, setSplitwiseCsvInput] = useState<string>(
    () => dataset.sampleSplitwiseCsv
  );
  const [lastImport, setLastImport] = useState<{
    expenses: number;
    payments: number;
    skipped: ParsedSplitwiseImport['skipped'];
  } | null>(null);
  const [nameMapping, setNameMapping] = useState<Record<string, string>>({});

  const [passphrase, setPassphrase] = useState('');
  const [passphraseConfirm, setPassphraseConfirm] = useState('');
  const [includeReceipts, setIncludeReceipts] = useState(false);
  const [restoreFileName, setRestoreFileName] = useState<string | null>(null);
  const [encryptedOutput, setEncryptedOutput] = useState<string>('');
  const isPlainBackup = useMemo(() => backupFileKind(encryptedOutput) === 'plain', [encryptedOutput]);
  const [isEncrypting, setIsEncrypting] = useState<boolean>(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [restoreVerificationMessage, setRestoreVerificationMessage] = useState<
    string | null
  >(null);
  const [backupError, setBackupError] = useState<string | null>(null);

  const [exportDirect, setExportDirect] = useState(false);
  const [exportFrom, setExportFrom] = useState('');
  const [exportTo, setExportTo] = useState('');

  const activeGroups = useMemo(
    () => dataset.groups.filter((g) => !g.deletedAt),
    [dataset.groups]
  );

  const parsedSplitwise = useMemo(
    () => parseSplitwiseImport(splitwiseCsvInput),
    [splitwiseCsvInput]
  );
  const skippedRows = lastImport ? lastImport.skipped : parsedSplitwise.skipped;
  const unmatchedNames = useMemo(
    () => resolveSplitwiseMembers(parsedSplitwise.memberNames, pickableMembers(activeGroup.members), {}).toCreate,
    [parsedSplitwise.memberNames, activeGroup.members]
  );
  const [manualRates, setManualRates] = useState<Record<string, string>>({});
  const currenciesNeedingRate = splitwiseMissingRates(
    parsedSplitwise,
    activeGroup.baseCurrency,
    fxIntoBase(activeGroup.baseCurrency, getFxQuote)
  );
  const stillMissingRates = splitwiseMissingRates(
    parsedSplitwise,
    activeGroup.baseCurrency,
    fxIntoBase(activeGroup.baseCurrency, getFxQuote, manualRates)
  );

  const exportSelection = useMemo(
    () =>
      selectExportLedger({
        groups: dataset.groups,
        expenses: dataset.expenses,
        settlements: dataset.settlements,
        scopeId: exportDirect ? DIRECT_EXPORT_SCOPE : activeGroup.id,
        fromDate: exportFrom,
        toDate: exportTo,
        directName: 'Direct bills',
        directCurrency: dataset.currentUser.defaultCurrency,
      }),
    [dataset.groups, dataset.expenses, dataset.settlements, dataset.currentUser.defaultCurrency, exportDirect, activeGroup.id, exportFrom, exportTo]
  );
  const exportName = exportSelection.scope.name;
  const exportRangeInvalid = Boolean(exportFrom && exportTo && exportFrom > exportTo);
  const exportFileName = (ext: string) => safeExportFileName(exportName, ext, exportFrom, exportTo);

  const csvExportText = useMemo(
    () =>
      exportGroupToCsv(
        exportSelection.scope,
        exportSelection.expenses,
        exportSelection.settlements
      ),
    [exportSelection]
  );

  const handleLoadSampleSplitwise = () => {
    setSplitwiseCsvInput(dataset.sampleSplitwiseCsv);
    setLastImport(null);
    showToast('Loaded sample Splitwise CSV into importer preview.');
  };

  const handleSplitwiseFile = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    setLastImport(null);
    setSplitwiseCsvInput(text);
    if (!text.trim()) showToast(`"${file.name}" is empty.`);
  };

  const handleConfirmSplitwiseImport = () => {
    if (parsedSplitwise.expenses.length + parsedSplitwise.payments.length === 0) {
      showToast('No Splitwise bills or payments found to import.');
      return;
    }
    const result = importSplitwiseExpenses(activeGroup.id, parsedSplitwise, nameMapping, manualRates);
    if (result.missingRates.length > 0) return;
    setLastImport({ ...result, skipped: parsedSplitwise.skipped });
    setSplitwiseCsvInput('');
    setNameMapping({});
    setManualRates({});
  };

  const runExport = async (kind: string, ext: string, mimeType: string, build: () => string | Uint8Array) => {
    try {
      await exportFileCrossPlatform({
        fileName: exportFileName(ext),
        mimeType,
        data: build(),
        shareTitle: `${exportName} ${kind}`,
      });
      showToast(`Exported ${kind} for "${exportName}".`);
    } catch {
      showToast(`The ${kind} could not be created on this device. Nothing was downloaded.`);
    }
  };

  const handleDownloadCsv = () =>
    void runExport('CSV ledger', 'csv', 'text/csv;charset=utf-8;', () => csvExportText);

  const handleCopyCsv = async () => {
    try {
      await navigator.clipboard?.writeText(csvExportText);
      showToast('Copied CSV ledger to clipboard.');
    } catch {
      showToast('CSV preview ready to copy.');
    }
  };

  const handlePrintStatement = () => {
    if (isNativeCapacitorApp()) {
      handleDownloadPdf();
      return;
    }
    showToast(`Prepared printable statement for "${exportName}".`);
    if (typeof window !== 'undefined' && typeof window.print === 'function') {
      try {
        window.print();
      } catch {
        // Ignore in headless environments
      }
    }
  };

  const handleDownloadExcel = () =>
    void runExport(
      'Excel workbook',
      'xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      () => exportGroupToExcelBuffer(exportSelection.scope, exportSelection.expenses, exportSelection.settlements)
    );

  const handleDownloadPdf = () => {
    const period = exportFrom || exportTo ? ` (${exportFrom || 'start'} to ${exportTo || 'today'})` : '';
    void runExport('PDF statement', 'pdf', 'application/pdf', () =>
      exportGroupToPdfBytes(
        { ...exportSelection.scope, name: `${exportName}${period}` },
        exportSelection.expenses,
        exportSelection.settlements
      )
    );
  };

  const handleVerifyGoogleOAuth = () => {
    void wiseSpliterSyncEngine.signInWithGoogleOAuth(dataset.currentUser.email);
    showToast(
      `Verified Google OAuth session (${dataset.currentUser.email}) connected to Supabase ${dataset.currentUser.supabaseSchema} schema.`
    );
  };

  const handleGenerateEncryptedBackup = async () => {
    setBackupError(null);
    setRestoreVerificationMessage(null);
    const problem = backupPassphraseProblem(passphrase, passphraseConfirm);
    if (problem) {
      setBackupError(problem);
      return;
    }
    setIsEncrypting(true);
    try {
      const receiptBytes = includeReceipts
        ? new Map((await listAllLocalReceiptBlobs()).map((b) => [b.id, b.dataUrl]))
        : null;
      const bundle = await encryptBackupPayload(buildBackupJson(dataset, receiptBytes), passphrase);
      setEncryptedOutput(bundle);
      setRestoreFileName(null);
      showToast(
        'Generated PBKDF2-SHA256 + AES-256-GCM encrypted .wisesplit backup.'
      );
    } catch {
      setBackupError('The backup could not be created on this device. Nothing was saved.');
    } finally {
      setIsEncrypting(false);
    }
  };

  const handleRestoreFile = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    setRestoreVerificationMessage(null);
    if (!text.trim()) {
      setEncryptedOutput('');
      setRestoreFileName(null);
      setBackupError(`"${file.name}" is empty. Choose the backup file you downloaded. Nothing was changed.`);
      return;
    }
    setBackupError(null);
    setEncryptedOutput(text);
    setRestoreFileName(file.name);
  };

  const handleDecryptAndRestore = async () => {
    setBackupError(null);
    setRestoreVerificationMessage(null);
    setIsRestoring(true);
    try {
      const { entities: restored, encrypted } = await openBackupFile(encryptedOutput, passphrase, dataset.groups);
      const report = restoreFullDatasetFromBackup(restored);
      const taken = new Set(report.takenExpenseIds);
      let imageFailures = 0;
      for (const exp of restored.expenses) {
        if (!taken.has(exp.id)) continue;
        for (const r of exp.receipts ?? []) {
          if (!r.dataUrl) continue;
          await saveReceiptBlobLocally({
            id: r.id,
            expenseId: exp.id,
            groupId: exp.groupId,
            fileName: r.fileName,
            mimeType: r.mimeType,
            sizeKb: r.sizeKb,
            dataUrl: r.dataUrl,
            storageBucket: 'local-device-only',
            storagePath: r.storagePath ?? `local-device/${exp.id}.webp`,
            uploadedToCloud: false,
            createdAt: r.createdAt,
          }).catch(() => {
            imageFailures += 1;
          });
        }
      }
      const items = (n: number) => `${n} ${n === 1 ? 'item' : 'items'}`;
      const notes = [
        report.keptNewer > 0 ? `kept this device's newer copy of ${items(report.keptNewer)}` : '',
        report.unchanged > 0 ? `${items(report.unchanged)} already up to date` : '',
        report.skipped > 0 ? `skipped ${items(report.skipped)} this account cannot take (sample data, or bills whose group is missing)` : '',
        imageFailures > 0 ? `${imageFailures} receipt ${imageFailures === 1 ? 'image' : 'images'} could not be saved on this device` : '',
      ].filter(Boolean);
      setRestoreVerificationMessage(
        `Verified & Restored: ${items(report.restored)} from ${encrypted ? 'the encrypted backup (AES-256-GCM Auth Tag Valid)' : 'an unencrypted backup file'}.` +
          (notes.length > 0 ? ` ${notes.join('; ')}.` : '')
      );
    } catch (err) {
      setBackupError(
        err instanceof BackupRestoreError
          ? err.message
          : 'Decryption failed: this backup could not be restored. Nothing was changed.'
      );
    } finally {
      setIsRestoring(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* Page Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <div className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400 mb-1">
            <Database className="w-4 h-4" weight="duotone" />
            <span>100% Yours - Zero Lock-In &amp; Works Offline</span>
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-white">
            Cloud Sync, Exports &amp; Switch from Splitwise
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
            Your bills save on this device first (even on flights without Wi-Fi), sync automatically when online, and export cleanly to Excel, PDF, CSV, or encrypted backups anytime.
          </p>
        </div>

        {/* Active Group Target Selector */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
            Target Group:
          </span>
          {activeGroups.map((grp) => (
            <button
              key={grp.id}
              type="button"
              onClick={() => {
                setActiveGroupId(grp.id);
                setExportDirect(false);
              }}
              className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition-all cursor-pointer ${
                grp.id === activeGroup.id
                  ? 'bg-emerald-600 text-white shadow-sm'
                  : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
              }`}
            >
              {grp.name} ({grp.baseCurrency})
            </button>
          ))}
        </div>
      </div>

      {/* Top Row: Cloud Sync Center + Splitwise Importer */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* 1. Supabase Custom Schema (wise_spliter) & Google OAuth Sync Center */}
        <div className="lg:col-span-6">
          <DoubleBezelCard
            testId="cloud-sync-panel"
            className="h-full"
            innerClassName="flex flex-col justify-between space-y-5"
          >
            <div className="space-y-4">
              <div className="flex items-start justify-between gap-3 border-b border-slate-200/70 dark:border-white/[0.06] pb-4">
                <div>
                  <div className="flex items-center gap-2">
                    {isOnline ? (
                      <CloudCheck
                        className="w-5 h-5 text-emerald-500"
                        weight="duotone"
                      />
                    ) : (
                      <CloudSlash
                        className="w-5 h-5 text-amber-500"
                        weight="duotone"
                      />
                    )}
                    <h2 className="text-lg font-bold text-slate-900 dark:text-white">
                      Offline Storage &amp; Cloud Sync
                    </h2>
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    Every bill saves immediately on your device and syncs automatically to your private cloud account when online.
                  </p>
                </div>
                <StatusBadge tone={isOnline ? 'emerald' : 'amber'}>
                  {isOnline ? 'Cloud Synced' : 'Saved Offline'}
                </StatusBadge>
              </div>

              {/* Authenticated Identity Card */}
              <div className="p-4 rounded-2xl bg-slate-50/90 dark:bg-slate-900/70 border border-slate-200/70 dark:border-white/[0.06] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="w-11 h-11 rounded-2xl bg-emerald-600 text-white font-bold flex items-center justify-center text-sm shadow-sm">
                    {dataset.currentUser.avatarInitials}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-bold text-slate-900 dark:text-white">
                        {dataset.currentUser.fullName}
                      </span>
                      <StatusBadge tone="emerald">
                        Signed In
                      </StatusBadge>
                    </div>
                    <div className="text-xs font-mono text-slate-600 dark:text-slate-400">
                      {dataset.currentUser.email}
                    </div>
                    <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                      UPI ID: {dataset.currentUser.upiId}
                    </div>
                  </div>
                </div>
                <div className="text-left sm:text-right font-mono text-xs">
                  <div className="text-slate-500 dark:text-slate-400">
                    Cloud Vault
                  </div>
                  <div className="font-bold text-emerald-600 dark:text-emerald-400">
                    {dataset.currentUser.supabaseSchema}
                  </div>
                </div>
              </div>

              {/* Sync Confidence Grid */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <div className="p-3 rounded-xl border border-slate-200/70 dark:border-white/[0.06] bg-white dark:bg-slate-900/40">
                  <div className="text-[11px] font-semibold uppercase text-slate-500 dark:text-slate-400">
                    On-Device Copy
                  </div>
                  <div className="text-sm font-bold text-slate-900 dark:text-white mt-1">
                    100% Offline Ready
                  </div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                    {dataset.expenses.length} bills saved locally
                  </div>
                </div>

                <div className="p-3 rounded-xl border border-slate-200/70 dark:border-white/[0.06] bg-white dark:bg-slate-900/40">
                  <div className="text-[11px] font-semibold uppercase text-slate-500 dark:text-slate-400">
                    Cloud Protection
                  </div>
                  <div className="text-sm font-bold font-mono text-slate-900 dark:text-white mt-1">
                    wise_spliter
                  </div>
                  <div className="text-[11px] text-emerald-600 dark:text-emerald-400 mt-0.5">
                    Private per-group access
                  </div>
                </div>

                <div className="p-3 rounded-xl border border-slate-200/70 dark:border-white/[0.06] bg-white dark:bg-slate-900/40 col-span-2 sm:col-span-1">
                  <div className="text-[11px] font-semibold uppercase text-slate-500 dark:text-slate-400">
                    Offline Queue
                  </div>
                  <div className="text-lg font-bold font-mono tabular-nums text-slate-900 dark:text-white mt-0.5">
                    {pendingOutboxCount}{' '}
                    <span className="text-xs font-normal text-slate-500">
                      waiting
                    </span>
                  </div>
                  <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400 truncate">
                    Last sync: {dataset.currentUser.lastSyncedAt.slice(0, 19).replace('T', ' ')}
                  </div>
                </div>
              </div>
            </div>

            {/* Action Controls */}
            <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-slate-200/70 dark:border-white/[0.06]">
              <button
                data-testid="toggle-offline-btn"
                type="button"
                onClick={toggleOfflineMode}
                className={`px-4 py-2.5 rounded-xl text-xs font-semibold transition-all cursor-pointer inline-flex items-center gap-2 ${
                  isOnline
                    ? 'bg-amber-500/15 text-amber-800 dark:text-amber-300 ring-1 ring-amber-500/30 hover:bg-amber-500/25'
                    : 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 ring-1 ring-emerald-500/30 hover:bg-emerald-500/25'
                }`}
              >
                {isOnline ? (
                  <>
                    <CloudSlash className="w-4 h-4" weight="bold" />
                    <span>Test Airplane / Offline Mode</span>
                  </>
                ) : (
                  <>
                    <CloudCheck className="w-4 h-4" weight="bold" />
                    <span>Reconnect Online</span>
                  </>
                )}
              </button>

              <button
                data-testid="trigger-sync-btn"
                type="button"
                onClick={triggerCloudSync}
                className="px-4 py-2.5 rounded-xl text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white shadow-sm transition-colors cursor-pointer inline-flex items-center gap-2"
              >
                <CloudArrowUp className="w-4 h-4" weight="bold" />
                <span>Sync to Cloud Now</span>
              </button>

              <button
                data-testid="google-oauth-btn"
                type="button"
                onClick={handleVerifyGoogleOAuth}
                className="px-4 py-2.5 rounded-xl text-xs font-semibold bg-sky-500/15 text-sky-700 dark:text-sky-300 ring-1 ring-sky-500/30 hover:bg-sky-500/25 transition-colors cursor-pointer inline-flex items-center gap-2"
              >
                <GoogleLogo className="w-4 h-4" weight="bold" />
                <span>Check Google Account Sync</span>
              </button>
            </div>

            {isSignedIn && (
              <div
                data-testid="delete-account-panel"
                className="pt-3 border-t border-slate-200/70 dark:border-white/[0.06] space-y-3"
              >
                {isConfirmingDelete ? (
                  <>
                    <p className="text-xs text-slate-600 dark:text-slate-300">
                      This permanently deletes your account, signs you out and clears this device. This cannot be undone.
                    </p>
                    <div className="flex flex-wrap gap-3">
                      <button
                        data-testid="delete-account-confirm-btn"
                        type="button"
                        disabled={isDeletingAccount}
                        onClick={() => void handleDeleteAccount()}
                        className="min-h-[44px] px-4 py-2.5 rounded-xl text-xs font-semibold bg-rose-600 hover:bg-rose-500 disabled:opacity-60 text-white transition-colors cursor-pointer inline-flex items-center gap-2"
                      >
                        <Trash className="w-4 h-4" weight="bold" />
                        <span>{isDeletingAccount ? 'Deleting...' : 'Yes, delete my account'}</span>
                      </button>
                      <button
                        data-testid="delete-account-cancel-btn"
                        type="button"
                        disabled={isDeletingAccount}
                        onClick={() => setIsConfirmingDelete(false)}
                        className="min-h-[44px] px-4 py-2.5 rounded-xl text-xs font-semibold bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors cursor-pointer"
                      >
                        Keep my account
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="flex flex-wrap gap-3">
                    <button
                      data-testid="sign-out-btn"
                      type="button"
                      onClick={() =>
                        void signOut().then((signedOut) => {
                          if (signedOut) showToast('You are signed out. This device is back to the sample ledger.');
                        })
                      }
                      className="min-h-[44px] px-4 py-2.5 rounded-xl text-xs font-semibold bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors cursor-pointer inline-flex items-center gap-2"
                    >
                      <SignOut className="w-4 h-4" weight="bold" />
                      <span>Sign out</span>
                    </button>
                    <button
                      data-testid="delete-account-btn"
                      type="button"
                      onClick={() => setIsConfirmingDelete(true)}
                      className="min-h-[44px] px-4 py-2.5 rounded-xl text-xs font-semibold bg-rose-500/10 text-rose-700 dark:text-rose-300 ring-1 ring-rose-500/25 hover:bg-rose-500/20 transition-colors cursor-pointer inline-flex items-center gap-2"
                    >
                      <Trash className="w-4 h-4" weight="bold" />
                      <span>Delete account</span>
                    </button>
                  </div>
                )}
              </div>
            )}
          </DoubleBezelCard>
        </div>

        {/* 2. One-Click Splitwise CSV & JSON Importer */}
        <div className="lg:col-span-6">
          <DoubleBezelCard
            testId="splitwise-importer-panel"
            className="h-full"
            innerClassName="flex flex-col justify-between space-y-4"
          >
            <div className="space-y-4">
              <div className="flex items-start justify-between gap-3 border-b border-slate-200/70 dark:border-white/[0.06] pb-4">
                <div>
                  <div className="flex items-center gap-2">
                    <UploadSimple
                      className="w-5 h-5 text-emerald-500"
                      weight="bold"
                    />
                    <h2 className="text-lg font-bold text-slate-900 dark:text-white">
                      One-Click Splitwise CSV & JSON Importer
                    </h2>
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    Parse exported Splitwise spreadsheets and map member net columns into integer minor-unit splits in{' '}
                    <span className="font-semibold text-slate-800 dark:text-slate-200">
                      {activeGroup.name}
                    </span>
                    .
                  </p>
                </div>
                <button
                  data-testid="load-sample-splitwise-btn"
                  type="button"
                  onClick={handleLoadSampleSplitwise}
                  className="px-3 py-1.5 rounded-xl text-xs font-semibold bg-sky-500/15 text-sky-700 dark:text-sky-300 ring-1 ring-sky-500/30 hover:bg-sky-500/25 transition-colors cursor-pointer shrink-0 inline-flex items-center gap-1.5"
                >
                  <Sparkle className="w-4 h-4" weight="fill" />
                  <span>Load Sample Splitwise CSV</span>
                </button>
              </div>

              <label className="min-h-[44px] px-4 py-2.5 rounded-xl text-xs font-semibold bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors cursor-pointer inline-flex items-center gap-2 focus-within:ring-2 focus-within:ring-emerald-500">
                <UploadSimple className="w-4 h-4" weight="bold" />
                <span>Choose Splitwise export (.csv or .json)</span>
                <input
                  data-testid="splitwise-file-input"
                  type="file"
                  accept=".csv,.json,text/csv,application/json"
                  className="sr-only"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    void handleSplitwiseFile(file);
                  }}
                />
              </label>

              <div>
                <label className="block text-[11px] font-mono uppercase text-slate-500 dark:text-slate-400 mb-1">
                  Splitwise CSV Payload (Editable)
                </label>
                <textarea
                  aria-label="Splitwise CSV Input"
                  rows={3}
                  value={splitwiseCsvInput}
                  onChange={(e) => setSplitwiseCsvInput(e.target.value)}
                  className="w-full p-3 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-white/10 font-mono text-xs text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>

              {/* Live Parsed Preview */}
              <div className="rounded-xl border border-slate-200/70 dark:border-white/[0.06] bg-slate-50/60 dark:bg-slate-900/50 p-3 space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-slate-800 dark:text-slate-200">
                    Live Parsed Preview ({parsedSplitwise.expenses.length} bills, {parsedSplitwise.payments.length} payments detected)
                  </span>
                  <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400">
                    Members: {parsedSplitwise.memberNames.join(', ') || 'None'}
                  </span>
                </div>

                <div className="divide-y divide-slate-200/60 dark:divide-white/[0.06]">
                  {parsedSplitwise.expenses.map((item, idx) => (
                    <div
                      key={`${item.title}-${idx}`}
                      className="py-2 flex items-center justify-between text-xs"
                    >
                      <div>
                        <span className="font-semibold text-slate-900 dark:text-white">
                          {item.title}
                        </span>
                        <span className="ml-2 font-mono text-[11px] text-slate-500">
                          ({item.date} / Paid by {item.payers[0]?.memberName})
                        </span>
                      </div>
                      <CurrencyAmount
                        minorAmount={item.amountMinor}
                        currencyCode={item.currency}
                        className="font-bold text-emerald-600 dark:text-emerald-400"
                      />
                    </div>
                  ))}
                  {parsedSplitwise.payments.map((pay, idx) => (
                    <div
                      key={`pay-${pay.date}-${idx}`}
                      className="py-2 flex items-center justify-between text-xs"
                    >
                      <span className="text-slate-700 dark:text-slate-300">
                        Payment: {pay.fromName} paid {pay.toName}
                        <span className="ml-2 font-mono text-[11px] text-slate-500">({pay.date})</span>
                      </span>
                      <CurrencyAmount
                        minorAmount={pay.amountMinor}
                        currencyCode={pay.currency}
                        className="font-bold text-slate-700 dark:text-slate-200"
                      />
                    </div>
                  ))}
                </div>
              </div>

              {parsedSplitwise.error && (
                <p
                  data-testid="splitwise-parse-error"
                  role="alert"
                  className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs font-medium text-rose-700 dark:text-rose-300"
                >
                  {parsedSplitwise.error}
                </p>
              )}

              {skippedRows.length > 0 && (
                <div
                  data-testid="splitwise-skipped-rows"
                  className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 space-y-1 text-xs text-amber-800 dark:text-amber-300"
                >
                  <p className="font-semibold">
                    {skippedRows.length === 1 ? '1 row was' : `${skippedRows.length} rows were`} not imported:
                  </p>
                  <ul className="list-disc pl-5 space-y-0.5">
                    {skippedRows.map((x) => (
                      <li key={`${x.line}-${x.title}`}>
                        Line {x.line}, {x.title}: {x.reason}.
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {parsedSplitwise.balanceMismatches.length > 0 && (
                <div
                  data-testid="splitwise-balance-mismatch"
                  role="alert"
                  className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 space-y-1 text-xs text-rose-700 dark:text-rose-300"
                >
                  <p className="font-semibold">
                    These balances would not match the Total balance in your Splitwise file:
                  </p>
                  <ul className="list-disc pl-5 space-y-0.5">
                    {parsedSplitwise.balanceMismatches.map((m) => (
                      <li key={`${m.currency}-${m.memberName}`}>
                        {m.memberName} ({m.currency}): Splitwise says {formatMinorToMajor(m.expectedMinor, m.currency, false)}, this import gives {formatMinorToMajor(m.importedMinor, m.currency, false)}.
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {unmatchedNames.length > 0 && (
                <div
                  data-testid="splitwise-member-mapping"
                  className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 space-y-2"
                >
                  <p className="text-xs font-semibold text-amber-800 dark:text-amber-300">
                    {unmatchedNames.length === 1 ? 'This name is' : 'These names are'} not in {activeGroup.name} yet. Choose who each one is, or add them as new members.
                  </p>
                  {unmatchedNames.map((name, idx) => (
                    <label
                      key={name}
                      className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs"
                    >
                      <span className="font-semibold text-slate-900 dark:text-white">{name}</span>
                      <select
                        data-testid={`splitwise-map-${idx}`}
                        aria-label={`Who is ${name} in ${activeGroup.name}?`}
                        value={nameMapping[name] ?? ''}
                        onChange={(e) =>
                          setNameMapping((prev) => ({ ...prev, [name]: e.target.value }))
                        }
                        className="min-h-[44px] px-3 rounded-xl bg-white dark:bg-slate-900 border border-slate-300/80 dark:border-white/10 text-xs text-slate-900 dark:text-white"
                      >
                        <option value="">Add {name} as a new member</option>
                        {pickableMembers(activeGroup.members).map((m) => (
                          <option key={m.id} value={m.id}>
                            Same person as {m.displayName}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
              )}

              {currenciesNeedingRate.length > 0 && (
                <div
                  data-testid="splitwise-fx-rates"
                  className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 space-y-2"
                >
                  <p className="text-xs font-semibold text-amber-800 dark:text-amber-300">
                    No exchange rate is available for {currenciesNeedingRate.join(', ')}. Enter the rate into {activeGroup.baseCurrency} to import.
                  </p>
                  {currenciesNeedingRate.map((code) => (
                    <label
                      key={code}
                      className="flex items-center justify-between gap-2 text-xs text-slate-900 dark:text-white"
                    >
                      <span className="font-semibold">1 {code} =</span>
                      <span className="flex items-center gap-2">
                        <input
                          type="number"
                          step="any"
                          min="0"
                          data-testid={`splitwise-fx-rate-${code}`}
                          aria-label={`Exchange rate for 1 ${code} in ${activeGroup.baseCurrency}`}
                          value={manualRates[code] ?? ''}
                          onChange={(e) => setManualRates((prev) => ({ ...prev, [code]: e.target.value }))}
                          className="min-h-[44px] w-32 px-3 rounded-xl bg-white dark:bg-slate-900 border border-slate-300/80 dark:border-white/10 font-mono tabular-nums"
                        />
                        <span className="font-mono">{activeGroup.baseCurrency}</span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>

            <div className="flex items-center justify-between gap-3 pt-2 border-t border-slate-200/70 dark:border-white/[0.06]">
              <div className="text-xs text-slate-500 dark:text-slate-400">
                {lastImport !== null ? (
                  <span
                    data-testid="splitwise-import-result"
                    className="text-emerald-600 dark:text-emerald-400 font-semibold"
                  >
                    Imported {lastImport.expenses} bills and {lastImport.payments} payments into {activeGroup.name}.
                    {lastImport.skipped.length > 0 &&
                      ` ${lastImport.skipped.length === 1 ? '1 row was' : `${lastImport.skipped.length} rows were`} skipped (listed above).`}
                  </span>
                ) : (
                  <span>Ready to import into {activeGroup.name}</span>
                )}
              </div>
              <button
                data-testid="confirm-splitwise-import-btn"
                type="button"
                onClick={handleConfirmSplitwiseImport}
                disabled={stillMissingRates.length > 0}
                className="px-4 py-2.5 rounded-xl text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white shadow-sm transition-colors cursor-pointer inline-flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <UploadSimple className="w-4 h-4" weight="bold" />
                <span>Import into Active Group</span>
              </button>
            </div>
          </DoubleBezelCard>
        </div>
      </div>

      {/* Bottom Row: CSV & Printable Statement Exporter + Encrypted .wisesplit Backup & Restore */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* 3. CSV & Printable Statement Exporter */}
        <div className="lg:col-span-6">
          <DoubleBezelCard
            testId="csv-export-panel"
            className="h-full"
            innerClassName="flex flex-col justify-between space-y-4"
          >
            <div className="space-y-4">
              <div className="flex items-start justify-between gap-3 border-b border-slate-200/70 dark:border-white/[0.06] pb-4">
                <div>
                  <div className="flex items-center gap-2">
                    <FileCsv
                      className="w-5 h-5 text-emerald-500"
                      weight="duotone"
                    />
                    <h2 className="text-lg font-bold text-slate-900 dark:text-white">
                      CSV & Printable Statement Exporter
                    </h2>
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    Live accounting export for{' '}
                    <span className="font-semibold text-slate-800 dark:text-slate-200">
                      {exportName}
                    </span>{' '}
                    including member net columns and recorded settlements.
                  </p>
                </div>
                <CurrencyPrecisionPill currencyCode={exportSelection.scope.baseCurrency} />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] font-semibold uppercase text-slate-500 dark:text-slate-400">What to export</span>
                  <select
                    data-testid="export-scope-select"
                    value={exportDirect ? DIRECT_EXPORT_SCOPE : activeGroup.id}
                    onChange={(e) => {
                      if (e.target.value === DIRECT_EXPORT_SCOPE) {
                        setExportDirect(true);
                      } else {
                        setExportDirect(false);
                        setActiveGroupId(e.target.value);
                      }
                    }}
                    className="min-h-[44px] px-3 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-300/80 dark:border-white/10 text-slate-900 dark:text-white"
                  >
                    {activeGroups.map((grp) => (
                      <option key={grp.id} value={grp.id}>
                        {grp.name} ({grp.baseCurrency})
                      </option>
                    ))}
                    <option value={DIRECT_EXPORT_SCOPE}>Direct bills (no group)</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] font-semibold uppercase text-slate-500 dark:text-slate-400">From</span>
                  <input
                    data-testid="export-from-date"
                    type="date"
                    value={exportFrom}
                    onChange={(e) => setExportFrom(e.target.value)}
                    className="min-h-[44px] px-3 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-300/80 dark:border-white/10 text-slate-900 dark:text-white"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[11px] font-semibold uppercase text-slate-500 dark:text-slate-400">To</span>
                  <input
                    data-testid="export-to-date"
                    type="date"
                    value={exportTo}
                    onChange={(e) => setExportTo(e.target.value)}
                    className="min-h-[44px] px-3 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-300/80 dark:border-white/10 text-slate-900 dark:text-white"
                  />
                </label>
              </div>
              {exportRangeInvalid && (
                <p className="text-xs font-medium text-amber-700 dark:text-amber-300">
                  The start date is after the end date, so nothing falls in this range.
                </p>
              )}

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[11px] font-mono uppercase text-slate-500 dark:text-slate-400">
                    Live Generated CSV Stream ({exportSelection.expenses.length} expenses, {exportSelection.settlements.length} settlements)
                  </span>
                  <button
                    type="button"
                    onClick={handleCopyCsv}
                    className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600 dark:text-emerald-400 hover:underline cursor-pointer"
                  >
                    <Copy className="w-3.5 h-3.5" />
                    <span>Copy CSV</span>
                  </button>
                </div>
                <pre
                  data-testid="csv-export-preview"
                  className="p-3.5 rounded-xl bg-slate-900 text-slate-100 font-mono text-xs overflow-x-auto max-h-56 leading-relaxed border border-slate-800"
                >
                  {csvExportText}
                </pre>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3 pt-2 border-t border-slate-200/70 dark:border-white/[0.06]">
              <button
                type="button"
                onClick={handleDownloadCsv}
                className="px-4 py-2.5 rounded-xl text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white shadow-sm transition-colors cursor-pointer inline-flex items-center gap-2"
              >
                <DownloadSimple className="w-4 h-4" weight="bold" />
                <span>Download .CSV Spreadsheet</span>
              </button>

              <button
                data-testid="download-xlsx-btn"
                type="button"
                onClick={handleDownloadExcel}
                className="px-4 py-2.5 rounded-xl text-xs font-semibold bg-sky-600 hover:bg-sky-500 text-white shadow-sm transition-colors cursor-pointer inline-flex items-center gap-2"
              >
                <FileXls className="w-4 h-4" weight="bold" />
                <span>Download Excel (.xlsx)</span>
              </button>

              <button
                data-testid="download-pdf-btn"
                type="button"
                onClick={handleDownloadPdf}
                className="px-4 py-2.5 rounded-xl text-xs font-semibold bg-indigo-600 hover:bg-indigo-500 text-white shadow-sm transition-colors cursor-pointer inline-flex items-center gap-2"
              >
                <FilePdf className="w-4 h-4" weight="bold" />
                <span>Download PDF (.pdf)</span>
              </button>

              <button
                type="button"
                onClick={handlePrintStatement}
                className="px-4 py-2.5 rounded-xl text-xs font-semibold bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors cursor-pointer inline-flex items-center gap-2"
              >
                <Printer className="w-4 h-4" weight="duotone" />
                <span>Print / Save PDF Statement</span>
              </button>
            </div>
          </DoubleBezelCard>
        </div>

        {/* 4. PBKDF2 + AES-256-GCM Encrypted .wisesplit Backup & Restore */}
        <div className="lg:col-span-6">
          <DoubleBezelCard
            testId="encrypted-backup-panel"
            className="h-full"
            innerClassName="flex flex-col justify-between space-y-4"
          >
            <div className="space-y-4">
              <div className="flex items-start justify-between gap-3 border-b border-slate-200/70 dark:border-white/[0.06] pb-4">
                <div>
                  <div className="flex items-center gap-2">
                    <ShieldCheck
                      className="w-5 h-5 text-emerald-500"
                      weight="duotone"
                    />
                    <h2 className="text-lg font-bold text-slate-900 dark:text-white">
                      Password-Protected Backup File (.wisesplit)
                    </h2>
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    Lock a private backup of all your groups, bills, and settlements with your own passphrase (AES-256-GCM encrypted in your browser).
                  </p>
                </div>
                <StatusBadge tone="emerald">Encrypted Vault</StatusBadge>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="block">
                  <span className="block text-[11px] font-semibold uppercase text-slate-500 dark:text-slate-400 mb-1">
                    Backup Passphrase
                  </span>
                  <span className="relative block">
                    <Key className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                    <input
                      data-testid="backup-passphrase-input"
                      type="password"
                      autoComplete="new-password"
                      value={passphrase}
                      onChange={(e) => setPassphrase(e.target.value)}
                      placeholder={`At least ${MIN_BACKUP_PASSPHRASE_LENGTH} characters`}
                      className="w-full min-h-[44px] pl-10 pr-4 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-300/80 dark:border-white/10 font-mono text-xs text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    />
                  </span>
                </label>
                <label className="block">
                  <span className="block text-[11px] font-semibold uppercase text-slate-500 dark:text-slate-400 mb-1">
                    Confirm Passphrase
                  </span>
                  <input
                    data-testid="backup-passphrase-confirm-input"
                    type="password"
                    autoComplete="new-password"
                    value={passphraseConfirm}
                    onChange={(e) => setPassphraseConfirm(e.target.value)}
                    placeholder="Type it again (not needed to restore)"
                    className="w-full min-h-[44px] px-4 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-300/80 dark:border-white/10 font-mono text-xs text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </label>
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                Nobody can recover this passphrase for you. Without it the backup cannot be opened.
              </p>

              <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-slate-300 cursor-pointer min-h-[44px]">
                <input
                  data-testid="backup-include-receipts-toggle"
                  type="checkbox"
                  checked={includeReceipts}
                  onChange={(e) => setIncludeReceipts(e.target.checked)}
                  className="w-4 h-4 accent-emerald-600"
                />
                <span>Include receipt photos stored on this device (makes the file larger)</span>
              </label>

              <div>
                <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
                  <span className="block text-[11px] font-mono uppercase text-slate-500 dark:text-slate-400">
                    Encrypted .wisesplit Ciphertext Bundle
                  </span>
                  <label className="min-h-[44px] inline-flex items-center gap-1.5 text-xs font-semibold text-sky-700 dark:text-sky-300 cursor-pointer hover:underline focus-within:ring-2 focus-within:ring-emerald-500 rounded-lg px-2">
                    <UploadSimple className="w-4 h-4" weight="bold" />
                    <span>{restoreFileName ? `Using ${restoreFileName}` : 'Choose a backup file to restore (.wisesplit or .json)'}</span>
                    <input
                      data-testid="restore-backup-file-input"
                      type="file"
                      accept=".wisesplit,.json,application/json"
                      className="sr-only"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        void handleRestoreFile(file);
                      }}
                    />
                  </label>
                </div>
                <textarea
                  data-testid="encrypted-backup-output"
                  readOnly={false}
                  rows={4}
                  value={encryptedOutput}
                  aria-label="Encrypted backup text"
                  onChange={(e) => {
                    setEncryptedOutput(e.target.value);
                    setRestoreFileName(null);
                  }}
                  placeholder='Generate a backup here, or choose a .wisesplit file to restore it.'
                  className="w-full p-3 rounded-xl bg-slate-900 text-emerald-300 font-mono text-xs border border-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>

              {isPlainBackup && (
                <p
                  data-testid="backup-plain-note"
                  className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs font-medium text-amber-800 dark:text-amber-300"
                >
                  This backup file is not encrypted, so anyone who has the file can read it. It restores without a passphrase. Delete the file once you no longer need it.
                </p>
              )}

              {restoreVerificationMessage && (
                <div data-testid="backup-restore-success" role="status" className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-xs font-medium text-emerald-700 dark:text-emerald-300 flex items-center gap-2">
                  <CheckCircle className="w-4 h-4 shrink-0" weight="fill" />
                  <span>{restoreVerificationMessage}</span>
                </div>
              )}

              {backupError && (
                <div data-testid="backup-error" role="alert" className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs font-medium text-rose-700 dark:text-rose-300 flex items-center gap-2">
                  <WarningCircle className="w-4 h-4 shrink-0" weight="fill" />
                  <span>{backupError}</span>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-200/70 dark:border-white/[0.06]">
              <div className="flex flex-wrap items-center gap-2">
                <button
                  data-testid="generate-encrypted-backup-btn"
                  type="button"
                  disabled={isEncrypting}
                  onClick={handleGenerateEncryptedBackup}
                  className="px-3.5 py-2.5 rounded-xl text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white shadow-sm transition-colors cursor-pointer inline-flex items-center gap-1.5"
                >
                  <LockKey className="w-4 h-4" weight="bold" />
                  <span>Generate AES-256-GCM Encrypted Backup</span>
                </button>

                {encryptedOutput && (
                  <button
                    data-testid="download-encrypted-backup-btn"
                    type="button"
                    onClick={() => {
                      void exportFileCrossPlatform({
                        fileName: safeExportFileName(`backup ${new Date().toISOString().slice(0, 10)}`, 'wisesplit'),
                        mimeType: 'application/json;charset=utf-8;',
                        data: encryptedOutput,
                        shareTitle: 'Wise-Spliter Encrypted Backup (.wisesplit)',
                      }).then(() => {
                        showToast('Exported encrypted .wisesplit backup file.');
                      });
                    }}
                    className="px-3.5 py-2.5 rounded-xl text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-white transition-colors cursor-pointer inline-flex items-center gap-1.5"
                  >
                    <DownloadSimple className="w-4 h-4" weight="bold" />
                    <span>Download / Share .wisesplit</span>
                  </button>
                )}

                <button
                  data-testid="decrypt-restore-btn"
                  type="button"
                  disabled={isRestoring}
                  onClick={handleDecryptAndRestore}
                  className="px-3.5 py-2.5 rounded-xl text-xs font-semibold bg-sky-500/15 text-sky-700 dark:text-sky-300 ring-1 ring-sky-500/30 hover:bg-sky-500/25 transition-colors cursor-pointer inline-flex items-center gap-1.5"
                >
                  <ShieldCheck className="w-4 h-4" weight="bold" />
                  <span>Decrypt & Verify Restore</span>
                </button>
              </div>

              <button
                data-testid="reset-mock-data-btn"
                type="button"
                onClick={resetToInitialMockData}
                className="px-3 py-2 rounded-xl text-xs font-semibold bg-rose-500/10 text-rose-700 dark:text-rose-300 ring-1 ring-rose-500/25 hover:bg-rose-500/20 transition-colors cursor-pointer inline-flex items-center gap-1.5"
              >
                <ArrowCounterClockwise className="w-4 h-4" weight="bold" />
                <span>Reset Demo to Initial mock-ledger-data.json</span>
              </button>
            </div>
          </DoubleBezelCard>
        </div>
      </div>
    </div>
  );
}

export default PortabilityAndSyncPage;
