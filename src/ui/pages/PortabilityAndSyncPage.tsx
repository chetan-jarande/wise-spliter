import React, { useMemo, useState } from 'react';
import {
  ArrowCounterClockwise,
  CheckCircle,
  CloudArrowUp,
  CloudCheck,
  CloudSlash,
  Copy,
  Database,
  DownloadSimple,
  FileCsv,
  Key,
  LockKey,
  Printer,
  ShieldCheck,
  Sparkle,
  UploadSimple,
  WarningCircle,
} from '@phosphor-icons/react';
import { useLedger } from '../../state/LedgerContext';
import {
  CurrencyAmount,
  CurrencyPrecisionPill,
  DoubleBezelCard,
  StatusBadge,
} from '../primitives/DesignPrimitives';
import {
  decryptBackupPayload,
  encryptBackupPayload,
  exportGroupToCsv,
  parseSplitwiseCsv,
} from '../../portability/portability-engine';
import { MockLedgerDataset } from '../../types/ledger';

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
    restoreFullDatasetFromBackup,
    resetToInitialMockData,
    showToast,
  } = useLedger();

  // Splitwise CSV state (initialized with sampleSplitwiseCsv so preview is live immediately)
  const [splitwiseCsvInput, setSplitwiseCsvInput] = useState<string>(
    () => dataset.sampleSplitwiseCsv
  );
  const [lastImportCount, setLastImportCount] = useState<number | null>(null);

  // Encrypted backup state
  const [passphrase, setPassphrase] = useState<string>(
    'wise-spliter-vault-2026'
  );
  const [encryptedOutput, setEncryptedOutput] = useState<string>('');
  const [isEncrypting, setIsEncrypting] = useState<boolean>(false);
  const [restoreVerificationMessage, setRestoreVerificationMessage] = useState<
    string | null
  >(null);
  const [backupError, setBackupError] = useState<string | null>(null);

  const activeGroups = useMemo(
    () => dataset.groups.filter((g) => !g.deletedAt),
    [dataset.groups]
  );

  // Parsed Splitwise CSV live preview
  const parsedSplitwise = useMemo(
    () => parseSplitwiseCsv(splitwiseCsvInput),
    [splitwiseCsvInput]
  );

  // Live CSV Export for activeGroup
  const activeGroupExpenses = useMemo(
    () =>
      dataset.expenses.filter(
        (e) => e.groupId === activeGroup.id && !e.deletedAt
      ),
    [dataset.expenses, activeGroup.id]
  );

  const activeGroupSettlements = useMemo(
    () =>
      dataset.settlements.filter(
        (s) => s.groupId === activeGroup.id && !s.deletedAt
      ),
    [dataset.settlements, activeGroup.id]
  );

  const csvExportText = useMemo(
    () =>
      exportGroupToCsv(
        activeGroup,
        activeGroupExpenses,
        activeGroupSettlements
      ),
    [activeGroup, activeGroupExpenses, activeGroupSettlements]
  );

  const handleLoadSampleSplitwise = () => {
    setSplitwiseCsvInput(dataset.sampleSplitwiseCsv);
    showToast('Loaded sample Splitwise CSV into importer preview.');
  };

  const handleConfirmSplitwiseImport = () => {
    if (parsedSplitwise.expenses.length === 0) {
      showToast('No valid Splitwise expenses found to import.');
      return;
    }
    const importedCount = importSplitwiseExpenses(
      activeGroup.id,
      parsedSplitwise
    );
    setLastImportCount(importedCount);
  };

  const handleDownloadCsv = () => {
    try {
      const blob = new Blob([csvExportText], {
        type: 'text/csv;charset=utf-8;',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const slug = activeGroup.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-');
      a.href = url;
      a.download = `wise-spliter-${slug}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast(`Downloaded CSV export for "${activeGroup.name}".`);
    } catch {
      showToast('Generated CSV export ready.');
    }
  };

  const handleCopyCsv = async () => {
    try {
      await navigator.clipboard?.writeText(csvExportText);
      showToast('Copied group CSV ledger to clipboard.');
    } catch {
      showToast('CSV preview ready to copy.');
    }
  };

  const handlePrintStatement = () => {
    showToast(`Prepared printable statement for "${activeGroup.name}".`);
    if (typeof window !== 'undefined' && typeof window.print === 'function') {
      try {
        window.print();
      } catch {
        // Ignore in headless environments
      }
    }
  };

  const handleGenerateEncryptedBackup = async () => {
    setBackupError(null);
    setRestoreVerificationMessage(null);
    const effectivePassphrase = passphrase.trim() || 'wise-spliter-vault-2026';
    setIsEncrypting(true);
    try {
      const payloadJson = JSON.stringify(dataset);
      const bundle = await encryptBackupPayload(
        payloadJson,
        effectivePassphrase
      );
      setEncryptedOutput(bundle);
      showToast(
        'Generated PBKDF2-SHA256 + AES-256-GCM encrypted .wisesplit backup.'
      );
    } catch (err) {
      setBackupError(
        err instanceof Error ? err.message : 'Encryption failed'
      );
    } finally {
      setIsEncrypting(false);
    }
  };

  const handleDecryptAndRestore = async () => {
    setBackupError(null);
    setRestoreVerificationMessage(null);
    const effectivePassphrase = passphrase.trim() || 'wise-spliter-vault-2026';

    try {
      let targetCiphertext = encryptedOutput;
      if (!targetCiphertext) {
        targetCiphertext = await encryptBackupPayload(
          JSON.stringify(dataset),
          effectivePassphrase
        );
        setEncryptedOutput(targetCiphertext);
      }

      const decryptedJson = await decryptBackupPayload(
        targetCiphertext,
        effectivePassphrase
      );
      const parsed = JSON.parse(decryptedJson) as MockLedgerDataset;
      if (!parsed || !Array.isArray(parsed.groups)) {
        throw new Error('Invalid decrypted dataset schema');
      }
      restoreFullDatasetFromBackup(parsed);
      setRestoreVerificationMessage(
        `Verified & Restored: ${parsed.groups.length} groups, ${parsed.expenses.length} expenses, ${parsed.settlements.length} settlements (AES-256-GCM Auth Tag Valid)`
      );
    } catch {
      setBackupError(
        'Decryption failed: passphrase mismatch or corrupted AES-GCM authentication tag.'
      );
    }
  };

  return (
    <div className="space-y-8">
      {/* Page Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <div className="inline-flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-emerald-600 dark:text-emerald-400 mb-1">
            <Database className="w-4 h-4" weight="duotone" />
            <span>Zero-Lock-In Data Portability & Offline-First Sync</span>
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-white">
            Cloud Sync Center & Cryptographic Portability
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
            Supabase <span className="font-mono">wise_spliter</span> schema replication, 1-click Splitwise importer, CSV/PDF statement exporter, and PBKDF2 + AES-256-GCM backups.
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
              onClick={() => setActiveGroupId(grp.id)}
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
                      Supabase & Google OAuth Sync Center
                    </h2>
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    Isolated Postgres schema with Hybrid Logical Clock (HLC) conflict detection and Local IndexedDB outbox queue.
                  </p>
                </div>
                <StatusBadge tone={isOnline ? 'emerald' : 'amber'}>
                  {isOnline ? 'Online & Synced' : 'Offline IndexedDB Mode'}
                </StatusBadge>
              </div>

              {/* Authenticated Google OAuth Identity Card */}
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
                        Google OAuth Verified
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
                    Target Schema
                  </div>
                  <div className="font-bold text-emerald-600 dark:text-emerald-400">
                    {dataset.currentUser.supabaseSchema}
                  </div>
                </div>
              </div>

              {/* Telemetry Grid */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <div className="p-3 rounded-xl border border-slate-200/70 dark:border-white/[0.06] bg-white dark:bg-slate-900/40">
                  <div className="text-[11px] font-mono uppercase text-slate-500 dark:text-slate-400">
                    Postgres Schema
                  </div>
                  <div className="text-sm font-bold font-mono text-slate-900 dark:text-white mt-1">
                    wise_spliter.*
                  </div>
                  <div className="text-[11px] text-emerald-600 dark:text-emerald-400 mt-0.5">
                    RLS Enforced
                  </div>
                </div>

                <div className="p-3 rounded-xl border border-slate-200/70 dark:border-white/[0.06] bg-white dark:bg-slate-900/40">
                  <div className="text-[11px] font-mono uppercase text-slate-500 dark:text-slate-400">
                    Local IndexedDB
                  </div>
                  <div className="text-sm font-bold font-mono text-slate-900 dark:text-white mt-1">
                    Active Mirror
                  </div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                    {dataset.expenses.length} bills cached
                  </div>
                </div>

                <div className="p-3 rounded-xl border border-slate-200/70 dark:border-white/[0.06] bg-white dark:bg-slate-900/40 col-span-2 sm:col-span-1">
                  <div className="text-[11px] font-mono uppercase text-slate-500 dark:text-slate-400">
                    Pending Outbox
                  </div>
                  <div className="text-lg font-bold font-mono tabular-nums text-slate-900 dark:text-white mt-0.5">
                    {pendingOutboxCount}{' '}
                    <span className="text-xs font-normal text-slate-500">
                      mutations
                    </span>
                  </div>
                  <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400 truncate">
                    Last: {dataset.currentUser.lastSyncedAt.slice(0, 19).replace('T', ' ')}
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
                    <span>Simulate Offline Subway Mode</span>
                  </>
                ) : (
                  <>
                    <CloudCheck className="w-4 h-4" weight="bold" />
                    <span>Reconnect Online Mode</span>
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
                <span>Sync Now with wise_spliter</span>
              </button>
            </div>
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
                    Live Parsed Preview ({parsedSplitwise.expenses.length} bills detected)
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
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 pt-2 border-t border-slate-200/70 dark:border-white/[0.06]">
              <div className="text-xs text-slate-500 dark:text-slate-400">
                {lastImportCount !== null ? (
                  <span className="text-emerald-600 dark:text-emerald-400 font-semibold">
                    Imported {lastImportCount} bills into {activeGroup.name}!
                  </span>
                ) : (
                  <span>Ready to import into {activeGroup.name}</span>
                )}
              </div>
              <button
                data-testid="confirm-splitwise-import-btn"
                type="button"
                onClick={handleConfirmSplitwiseImport}
                className="px-4 py-2.5 rounded-xl text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white shadow-sm transition-colors cursor-pointer inline-flex items-center gap-2"
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
                      {activeGroup.name}
                    </span>{' '}
                    including member net columns and recorded settlements.
                  </p>
                </div>
                <CurrencyPrecisionPill currencyCode={activeGroup.baseCurrency} />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[11px] font-mono uppercase text-slate-500 dark:text-slate-400">
                    Live Generated CSV Stream ({activeGroupExpenses.length} expenses, {activeGroupSettlements.length} settlements)
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
                      PBKDF2 + AES-256-GCM Encrypted Backup
                    </h2>
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                    Web Crypto API client-side encryption (100,000 SHA-256 iterations, 96-bit IV, authenticated ciphertext).
                  </p>
                </div>
                <StatusBadge tone="emerald">WebCrypto Subtle</StatusBadge>
              </div>

              <div>
                <label className="block text-[11px] font-mono uppercase text-slate-500 dark:text-slate-400 mb-1">
                  Vault Passphrase (PBKDF2-SHA256 Key Derivation)
                </label>
                <div className="relative">
                  <Key className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                  <input
                    data-testid="backup-passphrase-input"
                    type="text"
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                    placeholder="Enter encryption passphrase..."
                    className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-300/80 dark:border-white/10 font-mono text-xs text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-mono uppercase text-slate-500 dark:text-slate-400 mb-1">
                  Encrypted .wisesplit Ciphertext Bundle
                </label>
                <textarea
                  data-testid="encrypted-backup-output"
                  readOnly={false}
                  rows={4}
                  value={encryptedOutput}
                  onChange={(e) => setEncryptedOutput(e.target.value)}
                  placeholder='Click "Generate AES-256-GCM Encrypted Backup" to derive key and seal full ledger state...'
                  className="w-full p-3 rounded-xl bg-slate-900 text-emerald-300 font-mono text-xs border border-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>

              {restoreVerificationMessage && (
                <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-xs font-medium text-emerald-700 dark:text-emerald-300 flex items-center gap-2">
                  <CheckCircle className="w-4 h-4 shrink-0" weight="fill" />
                  <span>{restoreVerificationMessage}</span>
                </div>
              )}

              {backupError && (
                <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs font-medium text-rose-700 dark:text-rose-300 flex items-center gap-2">
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

                <button
                  data-testid="decrypt-restore-btn"
                  type="button"
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
