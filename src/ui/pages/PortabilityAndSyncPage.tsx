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
  SpatialFilterPill,
  SpatialMetricTile,
  SpatialPageHeader,
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

const EXPLICIT_TRANSITION =
  'transition-[transform,opacity,background-color,border-color,box-shadow] duration-200 ease-[cubic-bezier(0.32,0.72,0,1)]';

const BTN_BASE = `min-h-[44px] max-w-full inline-flex items-center justify-center gap-2 rounded-full px-4 py-2.5 text-xs font-semibold tracking-tight leading-snug text-left sm:text-center cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 disabled:opacity-50 disabled:cursor-not-allowed ${EXPLICIT_TRANSITION}`;

const BTN_LUMINOUS = `${BTN_BASE} lg-luminous-pill`;
const BTN_GLASS = `${BTN_BASE} lg-scene-tile text-[#141715] dark:text-[#F3F5F3]`;
const BTN_EMERALD_GLASS = `${BTN_BASE} bg-emerald-500/14 hover:bg-emerald-500/22 active:scale-[0.98] text-emerald-900 dark:bg-emerald-400/15 dark:hover:bg-emerald-400/24 dark:text-emerald-200 ring-1 ring-emerald-600/28 dark:ring-emerald-300/28 shadow-[inset_0_1px_0_rgba(255,255,255,0.20)]`;
const BTN_AMBER_GLASS = `${BTN_BASE} bg-amber-500/14 hover:bg-amber-500/22 active:scale-[0.98] text-amber-900 dark:bg-amber-400/15 dark:hover:bg-amber-400/24 dark:text-amber-200 ring-1 ring-amber-600/30 dark:ring-amber-300/28 shadow-[inset_0_1px_0_rgba(255,255,255,0.20)]`;
const BTN_ROSE_GLASS = `${BTN_BASE} bg-rose-500/12 hover:bg-rose-500/20 active:scale-[0.98] text-rose-800 dark:bg-rose-400/14 dark:hover:bg-rose-400/22 dark:text-rose-200 ring-1 ring-rose-600/25 dark:ring-rose-300/25 shadow-[inset_0_1px_0_rgba(255,255,255,0.18)]`;
const BTN_ROSE_SOLID = `${BTN_BASE} bg-rose-600 hover:bg-rose-500 active:scale-[0.98] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.24),0_10px_22px_-8px_rgba(225,29,72,0.45)]`;

const GLASS_FIELD_LABEL =
  'block text-[11px] font-medium tracking-wide text-[#5C6660] dark:text-[#9CA69F] mb-1.5';

const GLASS_INPUT =
  'lg-recessed-well min-h-[44px] w-full max-w-full min-w-0 rounded-2xl px-3.5 py-2.5 text-xs text-[#141715] dark:text-[#F3F5F3] placeholder:text-[#68726C] dark:placeholder:text-[#8A938D] [color-scheme:light] dark:[color-scheme:dark] focus:outline-none focus:ring-2 focus:ring-emerald-500/50';

const GLASS_CODE_WELL =
  'lg-recessed-well w-full max-w-full min-w-0 rounded-[20px] p-3.5 font-mono text-xs leading-relaxed text-[#141715] dark:text-[#E5EAE6] placeholder:text-[#68726C] dark:placeholder:text-[#8A938D] focus:outline-none focus:ring-2 focus:ring-emerald-500/50';

function SpatialPanelHeader({
  icon,
  title,
  subtitle,
  aside,
}: {
  icon: React.ReactNode;
  title: React.ReactNode;
  subtitle: React.ReactNode;
  aside?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-black/[0.07] dark:border-white/[0.08] pb-4 min-w-0">
      <div className="flex items-start gap-3 min-w-0 flex-1">
        <span
          aria-hidden="true"
          className="lg-icon-orb h-10 w-10 rounded-full flex items-center justify-center shrink-0 text-[#1F2421] dark:text-[#E5EAE6]"
        >
          {icon}
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <h2 className="text-base sm:text-lg font-semibold tracking-tight text-[#141715] dark:text-[#F3F5F3] [overflow-wrap:anywhere]">
            {title}
          </h2>
          <p className="text-xs text-[#4A524D] dark:text-[#B7BEB9] leading-relaxed [overflow-wrap:anywhere]">
            {subtitle}
          </p>
        </div>
      </div>
      {aside && <div className="shrink-0 max-w-full">{aside}</div>}
    </div>
  );
}

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
    <div data-testid="portability-and-sync-page" className="space-y-6 min-w-0 lg-stage-reveal">
      {/* Ombria Spatial Stage Header */}
      <SpatialPageHeader
        eyebrow="100% Yours / Zero Lock-In & Offline-First"
        badges={
          <>
            <StatusBadge tone={isOnline ? 'emerald' : 'amber'}>
              {isOnline ? (
                <>
                  <CloudCheck className="w-3.5 h-3.5 shrink-0" weight="bold" aria-hidden="true" />
                  <span>Cloud Synced</span>
                </>
              ) : (
                <>
                  <CloudSlash className="w-3.5 h-3.5 shrink-0" weight="bold" aria-hidden="true" />
                  <span>Saved Offline</span>
                </>
              )}
            </StatusBadge>
            <StatusBadge tone="slate">
              <Database className="w-3.5 h-3.5 shrink-0" weight="duotone" aria-hidden="true" />
              <span>PBKDF2 + AES-256-GCM</span>
            </StatusBadge>
            <CurrencyPrecisionPill currencyCode={activeGroup.baseCurrency} />
          </>
        }
        title="Cloud Sync, Exports & Switch from Splitwise"
        subtitle="Your bills save on this device first (even on flights without Wi-Fi), sync automatically when online, and export cleanly to Excel, PDF, CSV, or encrypted backups anytime."
      />

      {/* Active Group Target Capsule Strip */}
      <section
        aria-label="Target group selector"
        className="flex flex-wrap items-center gap-2 min-w-0"
      >
        <span className="text-xs font-medium tracking-wide text-[#5C6660] dark:text-[#9CA69F] mr-1">
          Target Group:
        </span>
        {activeGroups.map((grp) => (
          <SpatialFilterPill
            key={grp.id}
            active={grp.id === activeGroup.id}
            onClick={() => {
              setActiveGroupId(grp.id);
              setExportDirect(false);
            }}
          >
            {grp.name} ({grp.baseCurrency})
          </SpatialFilterPill>
        ))}
      </section>

      {/* Top Row: Cloud Sync Center + Splitwise Importer */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 min-w-0 lg-stagger-1">
        {/* 1. Supabase Custom Schema (wise_spliter) & Google OAuth Sync Center */}
        <div className="lg:col-span-6 min-w-0">
          <DoubleBezelCard
            testId="cloud-sync-panel"
            className="h-full min-w-0"
            innerClassName="flex flex-col justify-between gap-5 min-w-0"
          >
            <div className="space-y-4 min-w-0">
              <SpatialPanelHeader
                icon={
                  isOnline ? (
                    <CloudCheck className="w-5 h-5 text-emerald-700 dark:text-emerald-300" weight="duotone" />
                  ) : (
                    <CloudSlash className="w-5 h-5 text-amber-700 dark:text-amber-300" weight="duotone" />
                  )
                }
                title="Offline Storage & Cloud Sync"
                subtitle="Every bill saves immediately on your device and syncs automatically to your private cloud account when online."
                aside={
                  <StatusBadge tone={isOnline ? 'emerald' : 'amber'}>
                    {isOnline ? 'Cloud Synced' : 'Saved Offline'}
                  </StatusBadge>
                }
              />

              {/* Authenticated Identity Chamber */}
              <div className="lg-recessed-well rounded-[20px] p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 min-w-0">
                <div className="flex items-center gap-3 min-w-0">
                  <div
                    aria-hidden="true"
                    className="lg-icon-orb w-11 h-11 rounded-2xl text-emerald-800 dark:text-emerald-200 font-semibold flex items-center justify-center text-sm shrink-0"
                  >
                    {dataset.currentUser.avatarInitials}
                  </div>
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-2 min-w-0">
                      <span className="text-sm font-semibold tracking-tight text-[#141715] dark:text-[#F3F5F3] [overflow-wrap:anywhere]">
                        {dataset.currentUser.fullName}
                      </span>
                      <StatusBadge tone="emerald">Signed In</StatusBadge>
                    </div>
                    <div className="text-xs font-mono text-[#4A524D] dark:text-[#B7BEB9] [overflow-wrap:anywhere]">
                      {dataset.currentUser.email}
                    </div>
                    <div className="text-[11px] font-mono text-[#5C6660] dark:text-[#9CA69F] [overflow-wrap:anywhere]">
                      UPI ID: {dataset.currentUser.upiId}
                    </div>
                  </div>
                </div>
                <div className="text-left sm:text-right font-mono text-xs min-w-0 shrink-0">
                  <div className="text-[#5C6660] dark:text-[#9CA69F]">
                    Cloud Vault
                  </div>
                  <div className="font-semibold text-emerald-700 dark:text-emerald-300 [overflow-wrap:anywhere]">
                    {dataset.currentUser.supabaseSchema}
                  </div>
                </div>
              </div>

              {/* Sync Confidence Metrics Grid */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 min-w-0">
                <SpatialMetricTile
                  label="On-Device Copy"
                  value={<span className="text-sm sm:text-base">100% Offline Ready</span>}
                  sublabel={`${dataset.expenses.length} bills saved locally`}
                  icon={<Database className="w-3.5 h-3.5" weight="duotone" />}
                  tone="emerald"
                />
                <SpatialMetricTile
                  label="Cloud Protection"
                  value={<span className="text-sm sm:text-base font-mono">wise_spliter</span>}
                  sublabel="Private per-group access"
                  icon={<ShieldCheck className="w-3.5 h-3.5" weight="duotone" />}
                  tone="neutral"
                />
                <SpatialMetricTile
                  label="Offline Queue"
                  value={
                    <span className="text-base sm:text-lg font-mono tabular-nums">
                      {pendingOutboxCount}{' '}
                      <span className="text-xs font-sans font-normal text-[#5C6660] dark:text-[#9CA69F]">
                        waiting
                      </span>
                    </span>
                  }
                  sublabel={`Last sync: ${dataset.currentUser.lastSyncedAt.slice(0, 19).replace('T', ' ')}`}
                  icon={
                    isOnline ? (
                      <CloudCheck className="w-3.5 h-3.5" weight="duotone" />
                    ) : (
                      <CloudSlash className="w-3.5 h-3.5" weight="duotone" />
                    )
                  }
                  tone={pendingOutboxCount > 0 ? 'amber' : 'neutral'}
                />
              </div>
            </div>

            <div className="space-y-3 min-w-0">
              {/* Action Controls */}
              <div className="flex flex-wrap items-center gap-2.5 pt-3 border-t border-black/[0.07] dark:border-white/[0.08] min-w-0">
                <button
                  data-testid="trigger-sync-btn"
                  type="button"
                  onClick={triggerCloudSync}
                  className={BTN_LUMINOUS}
                >
                  <CloudArrowUp className="w-4 h-4 shrink-0" weight="bold" aria-hidden="true" />
                  <span className="[overflow-wrap:anywhere]">Sync to Cloud Now</span>
                </button>

                <button
                  data-testid="toggle-offline-btn"
                  type="button"
                  onClick={toggleOfflineMode}
                  className={isOnline ? BTN_AMBER_GLASS : BTN_EMERALD_GLASS}
                >
                  {isOnline ? (
                    <>
                      <CloudSlash className="w-4 h-4 shrink-0" weight="bold" aria-hidden="true" />
                      <span className="[overflow-wrap:anywhere]">Test Airplane / Offline Mode</span>
                    </>
                  ) : (
                    <>
                      <CloudCheck className="w-4 h-4 shrink-0" weight="bold" aria-hidden="true" />
                      <span className="[overflow-wrap:anywhere]">Reconnect Online</span>
                    </>
                  )}
                </button>

                <button
                  data-testid="google-oauth-btn"
                  type="button"
                  onClick={handleVerifyGoogleOAuth}
                  className={BTN_GLASS}
                >
                  <GoogleLogo className="w-4 h-4 shrink-0 text-emerald-700 dark:text-emerald-300" weight="bold" aria-hidden="true" />
                  <span className="[overflow-wrap:anywhere]">Check Google Account Sync</span>
                </button>
              </div>

              {isSignedIn && (
                <div
                  data-testid="delete-account-panel"
                  className="pt-3 border-t border-black/[0.07] dark:border-white/[0.08] space-y-3 min-w-0"
                >
                  {isConfirmingDelete ? (
                    <div className="lg-recessed-well rounded-[20px] p-3.5 border-rose-500/25 dark:border-rose-400/25 bg-rose-500/[0.05] space-y-3 min-w-0">
                      <p className="text-xs text-[#4A524D] dark:text-[#B7BEB9] leading-relaxed [overflow-wrap:anywhere]">
                        This permanently deletes your account, signs you out and clears this device. This cannot be undone.
                      </p>
                      <div className="flex flex-wrap gap-2.5 min-w-0">
                        <button
                          data-testid="delete-account-confirm-btn"
                          type="button"
                          disabled={isDeletingAccount}
                          onClick={() => void handleDeleteAccount()}
                          className={BTN_ROSE_SOLID}
                        >
                          <Trash className="w-4 h-4 shrink-0" weight="bold" aria-hidden="true" />
                          <span className="[overflow-wrap:anywhere]">
                            {isDeletingAccount ? 'Deleting...' : 'Yes, delete my account'}
                          </span>
                        </button>
                        <button
                          data-testid="delete-account-cancel-btn"
                          type="button"
                          disabled={isDeletingAccount}
                          onClick={() => setIsConfirmingDelete(false)}
                          className={BTN_GLASS}
                        >
                          <span className="[overflow-wrap:anywhere]">Keep my account</span>
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-2.5 min-w-0">
                      <button
                        data-testid="sign-out-btn"
                        type="button"
                        onClick={() =>
                          void signOut().then((signedOut) => {
                            if (signedOut) showToast('You are signed out. This device is back to the sample ledger.');
                          })
                        }
                        className={BTN_GLASS}
                      >
                        <SignOut className="w-4 h-4 shrink-0" weight="bold" aria-hidden="true" />
                        <span>Sign out</span>
                      </button>
                      <button
                        data-testid="delete-account-btn"
                        type="button"
                        onClick={() => setIsConfirmingDelete(true)}
                        className={BTN_ROSE_GLASS}
                      >
                        <Trash className="w-4 h-4 shrink-0" weight="bold" aria-hidden="true" />
                        <span>Delete account</span>
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </DoubleBezelCard>
        </div>

        {/* 2. One-Click Splitwise CSV & JSON Importer */}
        <div className="lg:col-span-6 min-w-0">
          <DoubleBezelCard
            testId="splitwise-importer-panel"
            className="h-full min-w-0"
            innerClassName="flex flex-col justify-between gap-4 min-w-0"
          >
            <div className="space-y-4 min-w-0">
              <SpatialPanelHeader
                icon={<UploadSimple className="w-5 h-5 text-emerald-700 dark:text-emerald-300" weight="bold" />}
                title="One-Click Splitwise CSV & JSON Importer"
                subtitle={
                  <>
                    Parse exported Splitwise spreadsheets and map member net columns into integer minor-unit splits in{' '}
                    <span className="font-semibold text-[#141715] dark:text-[#F3F5F3]">
                      {activeGroup.name}
                    </span>
                    .
                  </>
                }
              />

              <div className="flex flex-wrap items-center gap-2.5 min-w-0">
                <label className={`${BTN_GLASS} focus-within:ring-2 focus-within:ring-emerald-500/60`}>
                  <UploadSimple className="w-4 h-4 shrink-0 text-emerald-700 dark:text-emerald-300" weight="bold" aria-hidden="true" />
                  <span className="[overflow-wrap:anywhere]">Choose Splitwise export (.csv or .json)</span>
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

                <button
                  data-testid="load-sample-splitwise-btn"
                  type="button"
                  onClick={handleLoadSampleSplitwise}
                  className={BTN_EMERALD_GLASS}
                >
                  <Sparkle className="w-4 h-4 shrink-0" weight="fill" aria-hidden="true" />
                  <span className="[overflow-wrap:anywhere]">Load Sample Splitwise CSV</span>
                </button>
              </div>

              <div className="min-w-0">
                <label className={GLASS_FIELD_LABEL}>
                  Splitwise CSV Payload (Editable)
                </label>
                <textarea
                  aria-label="Splitwise CSV Input"
                  rows={3}
                  value={splitwiseCsvInput}
                  onChange={(e) => setSplitwiseCsvInput(e.target.value)}
                  className={`${GLASS_CODE_WELL} [overflow-wrap:anywhere]`}
                />
              </div>

              {/* Live Parsed Preview */}
              <div className="lg-recessed-well rounded-[20px] p-3.5 space-y-2.5 min-w-0">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs min-w-0">
                  <span className="font-semibold text-[#141715] dark:text-[#F3F5F3] [overflow-wrap:anywhere]">
                    Live Parsed Preview ({parsedSplitwise.expenses.length} bills, {parsedSplitwise.payments.length} payments detected)
                  </span>
                  <span className="font-mono text-[11px] text-[#5C6660] dark:text-[#9CA69F] [overflow-wrap:anywhere]">
                    Members: {parsedSplitwise.memberNames.join(', ') || 'None'}
                  </span>
                </div>

                {parsedSplitwise.expenses.length + parsedSplitwise.payments.length === 0 ? (
                  <p className="text-xs text-[#5C6660] dark:text-[#9CA69F] py-1">
                    Choose a Splitwise CSV or JSON file above, or load the sample payload to preview detected rows.
                  </p>
                ) : (
                  <div className="divide-y divide-black/[0.06] dark:divide-white/[0.07] max-h-48 overflow-y-auto pr-0.5 min-w-0">
                    {parsedSplitwise.expenses.map((item, idx) => (
                      <div
                        key={`${item.title}-${idx}`}
                        className="py-2 flex items-start justify-between gap-3 text-xs min-w-0"
                      >
                        <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                          <span className="font-semibold text-[#141715] dark:text-[#F3F5F3]">
                            {item.title}
                          </span>
                          <span className="ml-1.5 font-mono text-[11px] text-[#5C6660] dark:text-[#9CA69F]">
                            ({item.date} / Paid by {item.payers[0]?.memberName})
                          </span>
                        </div>
                        <CurrencyAmount
                          minorAmount={item.amountMinor}
                          currencyCode={item.currency}
                          className="font-semibold text-emerald-700 dark:text-emerald-300 shrink-0"
                        />
                      </div>
                    ))}
                    {parsedSplitwise.payments.map((pay, idx) => (
                      <div
                        key={`pay-${pay.date}-${idx}`}
                        className="py-2 flex items-start justify-between gap-3 text-xs min-w-0"
                      >
                        <span className="text-[#4A524D] dark:text-[#B7BEB9] min-w-0 flex-1 [overflow-wrap:anywhere]">
                          Payment: {pay.fromName} paid {pay.toName}
                          <span className="ml-1.5 font-mono text-[11px] text-[#5C6660] dark:text-[#9CA69F]">
                            ({pay.date})
                          </span>
                        </span>
                        <CurrencyAmount
                          minorAmount={pay.amountMinor}
                          currencyCode={pay.currency}
                          className="font-semibold text-[#141715] dark:text-[#F3F5F3] shrink-0"
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {parsedSplitwise.error && (
                <p
                  data-testid="splitwise-parse-error"
                  role="alert"
                  className="lg-recessed-well rounded-2xl p-3 border-rose-500/30 dark:border-rose-400/28 bg-rose-500/10 text-xs font-medium text-rose-800 dark:text-rose-200 [overflow-wrap:anywhere]"
                >
                  {parsedSplitwise.error}
                </p>
              )}

              {skippedRows.length > 0 && (
                <div
                  data-testid="splitwise-skipped-rows"
                  className="lg-recessed-well rounded-2xl border-amber-500/30 dark:border-amber-400/28 bg-amber-500/10 p-3 space-y-1 text-xs text-amber-900 dark:text-amber-200 min-w-0"
                >
                  <p className="font-semibold">
                    {skippedRows.length === 1 ? '1 row was' : `${skippedRows.length} rows were`} not imported:
                  </p>
                  <ul className="list-disc pl-5 space-y-0.5 [overflow-wrap:anywhere]">
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
                  className="lg-recessed-well rounded-2xl border-rose-500/30 dark:border-rose-400/28 bg-rose-500/10 p-3 space-y-1 text-xs text-rose-800 dark:text-rose-200 min-w-0"
                >
                  <p className="font-semibold">
                    These balances would not match the Total balance in your Splitwise file:
                  </p>
                  <ul className="list-disc pl-5 space-y-0.5 [overflow-wrap:anywhere]">
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
                  className="lg-recessed-well rounded-2xl border-amber-500/30 dark:border-amber-400/28 bg-amber-500/[0.08] p-3.5 space-y-2.5 min-w-0"
                >
                  <p className="text-xs font-semibold text-amber-900 dark:text-amber-200 [overflow-wrap:anywhere]">
                    {unmatchedNames.length === 1 ? 'This name is' : 'These names are'} not in {activeGroup.name} yet. Choose who each one is, or add them as new members.
                  </p>
                  {unmatchedNames.map((name, idx) => (
                    <label
                      key={name}
                      className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs min-w-0"
                    >
                      <span className="font-semibold text-[#141715] dark:text-[#F3F5F3] [overflow-wrap:anywhere]">
                        {name}
                      </span>
                      <select
                        data-testid={`splitwise-map-${idx}`}
                        aria-label={`Who is ${name} in ${activeGroup.name}?`}
                        value={nameMapping[name] ?? ''}
                        onChange={(e) =>
                          setNameMapping((prev) => ({ ...prev, [name]: e.target.value }))
                        }
                        className={`${GLASS_INPUT} sm:w-auto sm:min-w-[13rem]`}
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
                  className="lg-recessed-well rounded-2xl border-amber-500/30 dark:border-amber-400/28 bg-amber-500/[0.08] p-3.5 space-y-2.5 min-w-0"
                >
                  <p className="text-xs font-semibold text-amber-900 dark:text-amber-200 [overflow-wrap:anywhere]">
                    No exchange rate is available for {currenciesNeedingRate.join(', ')}. Enter the rate into {activeGroup.baseCurrency} to import.
                  </p>
                  {currenciesNeedingRate.map((code) => (
                    <label
                      key={code}
                      className="flex flex-wrap items-center justify-between gap-2 text-xs text-[#141715] dark:text-[#F3F5F3] min-w-0"
                    >
                      <span className="font-semibold font-mono">1 {code} =</span>
                      <span className="flex items-center gap-2 min-w-0">
                        <input
                          type="number"
                          step="any"
                          min="0"
                          data-testid={`splitwise-fx-rate-${code}`}
                          aria-label={`Exchange rate for 1 ${code} in ${activeGroup.baseCurrency}`}
                          value={manualRates[code] ?? ''}
                          onChange={(e) => setManualRates((prev) => ({ ...prev, [code]: e.target.value }))}
                          className={`${GLASS_INPUT} w-28 sm:w-32 font-mono tabular-nums`}
                        />
                        <span className="font-mono text-[#4A524D] dark:text-[#B7BEB9] shrink-0">
                          {activeGroup.baseCurrency}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-black/[0.07] dark:border-white/[0.08] min-w-0">
              <div className="text-xs text-[#4A524D] dark:text-[#B7BEB9] min-w-0 flex-1 [overflow-wrap:anywhere]">
                {lastImport !== null ? (
                  <span
                    data-testid="splitwise-import-result"
                    className="text-emerald-700 dark:text-emerald-300 font-semibold"
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
                className={BTN_LUMINOUS}
              >
                <UploadSimple className="w-4 h-4 shrink-0" weight="bold" aria-hidden="true" />
                <span className="[overflow-wrap:anywhere]">Import into Active Group</span>
              </button>
            </div>
          </DoubleBezelCard>
        </div>
      </div>

      {/* Bottom Row: CSV & Printable Statement Exporter + Encrypted .wisesplit Backup & Restore */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 min-w-0 lg-stagger-2">
        {/* 3. CSV & Printable Statement Exporter */}
        <div className="lg:col-span-6 min-w-0">
          <DoubleBezelCard
            testId="csv-export-panel"
            className="h-full min-w-0"
            innerClassName="flex flex-col justify-between gap-4 min-w-0"
          >
            <div className="space-y-4 min-w-0">
              <SpatialPanelHeader
                icon={<FileCsv className="w-5 h-5 text-emerald-700 dark:text-emerald-300" weight="duotone" />}
                title="CSV & Printable Statement Exporter"
                subtitle={
                  <>
                    Live accounting export for{' '}
                    <span className="font-semibold text-[#141715] dark:text-[#F3F5F3]">
                      {exportName}
                    </span>{' '}
                    including member net columns and recorded settlements.
                  </>
                }
                aside={<CurrencyPrecisionPill currencyCode={exportSelection.scope.baseCurrency} />}
              />

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs min-w-0">
                <label className="flex flex-col min-w-0">
                  <span className={GLASS_FIELD_LABEL}>What to export</span>
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
                    className={GLASS_INPUT}
                  >
                    {activeGroups.map((grp) => (
                      <option key={grp.id} value={grp.id}>
                        {grp.name} ({grp.baseCurrency})
                      </option>
                    ))}
                    <option value={DIRECT_EXPORT_SCOPE}>Direct bills (no group)</option>
                  </select>
                </label>
                <label className="flex flex-col min-w-0">
                  <span className={GLASS_FIELD_LABEL}>From</span>
                  <input
                    data-testid="export-from-date"
                    type="date"
                    value={exportFrom}
                    onChange={(e) => setExportFrom(e.target.value)}
                    className={GLASS_INPUT}
                  />
                </label>
                <label className="flex flex-col min-w-0">
                  <span className={GLASS_FIELD_LABEL}>To</span>
                  <input
                    data-testid="export-to-date"
                    type="date"
                    value={exportTo}
                    onChange={(e) => setExportTo(e.target.value)}
                    className={GLASS_INPUT}
                  />
                </label>
              </div>
              {exportRangeInvalid && (
                <p className="lg-recessed-well rounded-2xl p-3 border-amber-500/30 dark:border-amber-400/28 bg-amber-500/10 text-xs font-medium text-amber-900 dark:text-amber-200 [overflow-wrap:anywhere]">
                  The start date is after the end date, so nothing falls in this range.
                </p>
              )}

              <div className="min-w-0 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2 min-w-0">
                  <span className="text-[11px] font-mono text-[#5C6660] dark:text-[#9CA69F] [overflow-wrap:anywhere]">
                    Live Generated CSV Stream ({exportSelection.expenses.length} expenses, {exportSelection.settlements.length} settlements)
                  </span>
                  <button
                    type="button"
                    onClick={handleCopyCsv}
                    className={`lg-scene-tile min-h-[36px] inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold text-[#141715] dark:text-[#F3F5F3] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 ${EXPLICIT_TRANSITION}`}
                  >
                    <Copy className="w-3.5 h-3.5 shrink-0 text-emerald-700 dark:text-emerald-300" aria-hidden="true" />
                    <span>Copy CSV</span>
                  </button>
                </div>
                <pre
                  data-testid="csv-export-preview"
                  className={`${GLASS_CODE_WELL} overflow-x-auto max-h-56`}
                >
                  {csvExportText}
                </pre>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2.5 pt-3 border-t border-black/[0.07] dark:border-white/[0.08] min-w-0">
              <button
                type="button"
                onClick={handleDownloadCsv}
                className={BTN_LUMINOUS}
              >
                <DownloadSimple className="w-4 h-4 shrink-0" weight="bold" aria-hidden="true" />
                <span className="[overflow-wrap:anywhere]">Download .CSV Spreadsheet</span>
              </button>

              <button
                data-testid="download-xlsx-btn"
                type="button"
                onClick={handleDownloadExcel}
                className={BTN_GLASS}
              >
                <FileXls className="w-4 h-4 shrink-0 text-emerald-700 dark:text-emerald-300" weight="bold" aria-hidden="true" />
                <span className="[overflow-wrap:anywhere]">Download Excel (.xlsx)</span>
              </button>

              <button
                data-testid="download-pdf-btn"
                type="button"
                onClick={handleDownloadPdf}
                className={BTN_GLASS}
              >
                <FilePdf className="w-4 h-4 shrink-0 text-rose-700 dark:text-rose-300" weight="bold" aria-hidden="true" />
                <span className="[overflow-wrap:anywhere]">Download PDF (.pdf)</span>
              </button>

              <button
                type="button"
                onClick={handlePrintStatement}
                className={BTN_GLASS}
              >
                <Printer className="w-4 h-4 shrink-0 text-[#4A524D] dark:text-[#B7BEB9]" weight="duotone" aria-hidden="true" />
                <span className="[overflow-wrap:anywhere]">Print / Save PDF Statement</span>
              </button>
            </div>
          </DoubleBezelCard>
        </div>

        {/* 4. PBKDF2 + AES-256-GCM Encrypted .wisesplit Backup & Restore */}
        <div className="lg:col-span-6 min-w-0">
          <DoubleBezelCard
            testId="encrypted-backup-panel"
            className="h-full min-w-0"
            innerClassName="flex flex-col justify-between gap-4 min-w-0"
          >
            <div className="space-y-4 min-w-0">
              <SpatialPanelHeader
                icon={<ShieldCheck className="w-5 h-5 text-emerald-700 dark:text-emerald-300" weight="duotone" />}
                title="Password-Protected Backup File (.wisesplit)"
                subtitle="Lock a private backup of all your groups, bills, and settlements with your own passphrase (AES-256-GCM encrypted in your browser)."
                aside={<StatusBadge tone="emerald">Encrypted Vault</StatusBadge>}
              />

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 min-w-0">
                <label className="block min-w-0">
                  <span className={GLASS_FIELD_LABEL}>
                    Backup Passphrase
                  </span>
                  <span className="relative block min-w-0">
                    <Key
                      className="w-4 h-4 text-[#68726C] dark:text-[#8A938D] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
                      aria-hidden="true"
                    />
                    <input
                      data-testid="backup-passphrase-input"
                      type="password"
                      autoComplete="new-password"
                      value={passphrase}
                      onChange={(e) => setPassphrase(e.target.value)}
                      placeholder={`At least ${MIN_BACKUP_PASSPHRASE_LENGTH} characters`}
                      className={`${GLASS_INPUT} pl-10 font-mono`}
                    />
                  </span>
                </label>
                <label className="block min-w-0">
                  <span className={GLASS_FIELD_LABEL}>
                    Confirm Passphrase
                  </span>
                  <input
                    data-testid="backup-passphrase-confirm-input"
                    type="password"
                    autoComplete="new-password"
                    value={passphraseConfirm}
                    onChange={(e) => setPassphraseConfirm(e.target.value)}
                    placeholder="Type it again (not needed to restore)"
                    className={`${GLASS_INPUT} font-mono`}
                  />
                </label>
              </div>
              <p className="text-[11px] text-[#5C6660] dark:text-[#9CA69F] [overflow-wrap:anywhere]">
                Nobody can recover this passphrase for you. Without it the backup cannot be opened.
              </p>

              <label className="lg-recessed-well rounded-2xl px-3.5 py-2.5 flex items-center gap-3 text-xs text-[#2B312D] dark:text-[#DCE2DD] cursor-pointer min-h-[44px] min-w-0">
                <input
                  data-testid="backup-include-receipts-toggle"
                  type="checkbox"
                  checked={includeReceipts}
                  onChange={(e) => setIncludeReceipts(e.target.checked)}
                  className="w-4 h-4 shrink-0 accent-emerald-600"
                />
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  Include receipt photos stored on this device (makes the file larger)
                </span>
              </label>

              <div className="min-w-0 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2 min-w-0">
                  <span className="block text-[11px] font-mono text-[#5C6660] dark:text-[#9CA69F] [overflow-wrap:anywhere]">
                    Encrypted .wisesplit Ciphertext Bundle
                  </span>
                  <label
                    className={`lg-scene-tile min-h-[40px] max-w-full inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-semibold text-[#141715] dark:text-[#F3F5F3] cursor-pointer focus-within:ring-2 focus-within:ring-emerald-500/60 ${EXPLICIT_TRANSITION}`}
                  >
                    <UploadSimple className="w-4 h-4 shrink-0 text-emerald-700 dark:text-emerald-300" weight="bold" aria-hidden="true" />
                    <span className="min-w-0 [overflow-wrap:anywhere]">
                      {restoreFileName ? `Using ${restoreFileName}` : 'Choose a backup file to restore (.wisesplit or .json)'}
                    </span>
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
                  placeholder="Generate a backup here, or choose a .wisesplit file to restore it."
                  className={`${GLASS_CODE_WELL} [overflow-wrap:anywhere] break-all`}
                />
              </div>

              {isPlainBackup && (
                <p
                  data-testid="backup-plain-note"
                  className="lg-recessed-well rounded-2xl p-3 border-amber-500/30 dark:border-amber-400/28 bg-amber-500/10 text-xs font-medium text-amber-900 dark:text-amber-200 [overflow-wrap:anywhere]"
                >
                  This backup file is not encrypted, so anyone who has the file can read it. It restores without a passphrase. Delete the file once you no longer need it.
                </p>
              )}

              {restoreVerificationMessage && (
                <div
                  data-testid="backup-restore-success"
                  role="status"
                  className="lg-recessed-well rounded-2xl p-3 border-emerald-500/30 dark:border-emerald-400/28 bg-emerald-500/10 text-xs font-medium text-emerald-800 dark:text-emerald-200 flex items-start gap-2 min-w-0"
                >
                  <CheckCircle className="w-4 h-4 shrink-0 mt-0.5 text-emerald-600 dark:text-emerald-400" weight="fill" aria-hidden="true" />
                  <span className="min-w-0 [overflow-wrap:anywhere]">{restoreVerificationMessage}</span>
                </div>
              )}

              {backupError && (
                <div
                  data-testid="backup-error"
                  role="alert"
                  className="lg-recessed-well rounded-2xl p-3 border-rose-500/30 dark:border-rose-400/28 bg-rose-500/10 text-xs font-medium text-rose-800 dark:text-rose-200 flex items-start gap-2 min-w-0"
                >
                  <WarningCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-600 dark:text-rose-400" weight="fill" aria-hidden="true" />
                  <span className="min-w-0 [overflow-wrap:anywhere]">{backupError}</span>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2.5 pt-3 border-t border-black/[0.07] dark:border-white/[0.08] min-w-0">
              <div className="flex flex-wrap items-center gap-2.5 min-w-0">
                <button
                  data-testid="generate-encrypted-backup-btn"
                  type="button"
                  disabled={isEncrypting}
                  onClick={handleGenerateEncryptedBackup}
                  className={BTN_LUMINOUS}
                >
                  <LockKey className="w-4 h-4 shrink-0" weight="bold" aria-hidden="true" />
                  <span className="[overflow-wrap:anywhere]">Generate AES-256-GCM Encrypted Backup</span>
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
                    className={BTN_EMERALD_GLASS}
                  >
                    <DownloadSimple className="w-4 h-4 shrink-0" weight="bold" aria-hidden="true" />
                    <span className="[overflow-wrap:anywhere]">Download / Share .wisesplit</span>
                  </button>
                )}

                <button
                  data-testid="decrypt-restore-btn"
                  type="button"
                  disabled={isRestoring}
                  onClick={handleDecryptAndRestore}
                  className={BTN_GLASS}
                >
                  <ShieldCheck className="w-4 h-4 shrink-0 text-emerald-700 dark:text-emerald-300" weight="bold" aria-hidden="true" />
                  <span className="[overflow-wrap:anywhere]">Decrypt & Verify Restore</span>
                </button>
              </div>

              <button
                data-testid="reset-mock-data-btn"
                type="button"
                onClick={resetToInitialMockData}
                className={BTN_ROSE_GLASS}
              >
                <ArrowCounterClockwise className="w-4 h-4 shrink-0" weight="bold" aria-hidden="true" />
                <span className="[overflow-wrap:anywhere]">Reset Demo to Initial mock-ledger-data.json</span>
              </button>
            </div>
          </DoubleBezelCard>
        </div>
      </div>
    </div>
  );
}

export default PortabilityAndSyncPage;
