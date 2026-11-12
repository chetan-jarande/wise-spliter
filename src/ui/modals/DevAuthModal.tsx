import React, { useState } from 'react';
import {
  CheckCircleIcon as CheckCircle,
  EnvelopeSimpleIcon as EnvelopeSimple,
  GoogleLogoIcon as GoogleLogo,
  KeyIcon as Key,
  LockKeyIcon as LockKey,
  ShieldCheckIcon as ShieldCheck,
  SignInIcon as SignIn,
  WarningCircleIcon as WarningCircle,
  XIcon as X,
} from '@phosphor-icons/react';
import { useLedger } from '../../state/LedgerContext';
import { wiseSpliterSyncEngine } from '../../sync-engine/supabase-sync';
import { DoubleBezelCard, StatusBadge } from '../primitives/DesignPrimitives';

export interface DevAuthModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function DevAuthModal({ isOpen, onClose }: DevAuthModalProps) {
  const {
    dataset,
    isOnline,
    switchActiveUserProfile,
    restoreFullDatasetFromBackup,
    resetToInitialMockData,
    showToast,
  } = useLedger();

  const [email, setEmail] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [isDemoLoading, setIsDemoLoading] = useState<boolean>(false);
  const [isGoogleLoading, setIsGoogleLoading] = useState<boolean>(false);
  const [authError, setAuthError] = useState<string | null>(null);

  if (!isOpen) return null;

  const activeGroupsCount = dataset.groups.filter((g) => !g.deletedAt).length;
  const isCurrentlyDemoProfile =
    dataset.currentUser.id === 'usr_arjun_01' &&
    dataset.currentUser.email.toLowerCase() === 'arjun.mehta@gmail.com';

  const handleLoginSubmit = async (
    event: React.SyntheticEvent<HTMLFormElement>
  ) => {
    event.preventDefault();
    setAuthError(null);

    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedEmail || !password) {
      setAuthError('Please enter both your email address and password.');
      return;
    }

    setIsSubmitting(true);
    try {
      const ok = await switchActiveUserProfile({
        email: trimmedEmail,
        password,
      });
      if (ok) {
        setPassword('');
        setAuthError(null);
        onClose();
      } else {
        setAuthError(
          'Authentication failed. Please verify your email and password.'
        );
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDemoSandboxLogin = async () => {
    setAuthError(null);
    setIsDemoLoading(true);
    try {
      const demoRes = await wiseSpliterSyncEngine.signInWithDemoProfile();
      if (demoRes.ok && demoRes.dataset && demoRes.profile) {
        restoreFullDatasetFromBackup({
          ...demoRes.dataset,
          currentUser: demoRes.profile,
        });
        showToast(
          `Signed into Demo Sandbox: ${demoRes.profile.fullName} (${demoRes.profile.email})`
        );
        onClose();
        return;
      }

      resetToInitialMockData();
      showToast('Switched to Offline Demo Sandbox: Arjun Mehta (Demo)');
      onClose();
    } finally {
      setIsDemoLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setAuthError(null);
    setIsGoogleLoading(true);
    try {
      const result = await wiseSpliterSyncEngine.signInWithGoogleOAuth(
        email.trim() || dataset.currentUser.email
      );
      if (!result.ok) {
        setAuthError(
          result.error ||
            'Google Sign-In could not be started. Verify Supabase Google OAuth settings.'
        );
        return;
      }

      if (result.exchangedDataset && result.exchangedProfile) {
        restoreFullDatasetFromBackup({
          ...result.exchangedDataset,
          currentUser: result.exchangedProfile,
        });
        showToast(
          `Signed in with Google as ${result.exchangedProfile.fullName} (${result.exchangedProfile.email})`
        );
        onClose();
        return;
      }

      if (result.oauthUrl && typeof window !== 'undefined') {
        window.location.assign(result.oauthUrl);
      }
    } finally {
      setIsGoogleLoading(false);
    }
  };

  return (
    <div
      data-testid="dev-auth-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dev-auth-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm p-4 overflow-y-auto"
    >
      <div className="w-full max-w-lg rounded-3xl bg-white dark:bg-[#0F172A] ring-1 ring-slate-200 dark:ring-white/10 shadow-2xl overflow-hidden">
        {/* Modal Header */}
        <div className="flex items-center justify-between gap-3 px-6 py-4 border-b border-slate-200/80 dark:border-white/10 bg-slate-50/70 dark:bg-slate-900/60">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-2xl bg-emerald-600/15 text-emerald-600 dark:text-emerald-400 flex items-center justify-center ring-1 ring-emerald-500/30">
              <LockKey size={20} weight="bold" aria-hidden="true" />
            </div>
            <div>
              <h2
                id="dev-auth-modal-title"
                className="text-base font-bold text-slate-900 dark:text-white"
              >
                Sign In & Switch Account
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Supabase Auth & Backend Session Isolation ({dataset.currentUser.supabaseSchema})
              </p>
            </div>
          </div>

          <button
            type="button"
            data-testid="close-dev-auth-modal-btn"
            onClick={onClose}
            aria-label="Close authentication modal"
            className="h-9 w-9 rounded-full bg-slate-200/70 dark:bg-slate-800 text-slate-600 dark:text-slate-300 flex items-center justify-center hover:bg-slate-300/70 dark:hover:bg-slate-700 transition-colors"
          >
            <X size={16} weight="bold" aria-hidden="true" />
          </button>
        </div>

        <div className="p-6 space-y-5">
          {/* Active Session Banner */}
          <DoubleBezelCard
            testId="active-auth-session-banner"
            innerClassName="p-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <span className="h-10 w-10 rounded-full bg-emerald-600 text-white font-mono font-bold text-sm flex items-center justify-center shrink-0">
                  {dataset.currentUser.avatarInitials}
                </span>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-bold text-slate-900 dark:text-white truncate">
                      {dataset.currentUser.fullName}
                    </span>
                    <StatusBadge tone={isOnline ? 'emerald' : 'amber'}>
                      {isOnline
                        ? `Verified (${dataset.currentUser.supabaseSchema})`
                        : 'Offline Session'}
                    </StatusBadge>
                  </div>
                  <p className="text-xs font-mono text-slate-600 dark:text-slate-300 truncate">
                    {dataset.currentUser.email}
                  </p>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                    UPI: <span className="font-mono">{dataset.currentUser.upiId}</span> | Authorized Groups: <span className="font-mono font-semibold">{activeGroupsCount}</span>
                  </p>
                </div>
              </div>
              <CheckCircle
                size={20}
                weight="fill"
                className="text-emerald-500 shrink-0"
                aria-hidden="true"
              />
            </div>
          </DoubleBezelCard>

          {/* Quick Access: 1-Tap Demo Sandbox + Continue with Google */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <button
              type="button"
              data-testid="demo-profile-login-btn"
              disabled={isDemoLoading}
              onClick={() => void handleDemoSandboxLogin()}
              className="flex flex-col items-start justify-between gap-2 rounded-2xl bg-emerald-600/10 dark:bg-emerald-500/10 hover:bg-emerald-600/15 dark:hover:bg-emerald-500/20 p-3.5 text-left ring-1 ring-emerald-500/30 transition-colors cursor-pointer disabled:opacity-60"
            >
              <div className="flex items-center justify-between w-full gap-2">
                <span className="inline-flex items-center gap-1.5 text-xs font-bold text-emerald-800 dark:text-emerald-300">
                  <ShieldCheck size={16} weight="bold" aria-hidden="true" />
                  <span>1-Tap Demo Profile</span>
                </span>
                <StatusBadge tone={isCurrentlyDemoProfile ? 'emerald' : 'slate'}>
                  {isCurrentlyDemoProfile ? 'Active' : 'Sandbox'}
                </StatusBadge>
              </div>
              <p className="text-[11px] text-slate-600 dark:text-slate-300 leading-snug">
                {isDemoLoading
                  ? 'Opening isolated demo ledger...'
                  : 'Arjun Mehta (Demo) - explore 4 sample groups & offline splits with zero credentials.'}
              </p>
            </button>

            <button
              type="button"
              data-testid="dev-google-oauth-btn"
              disabled={isGoogleLoading}
              onClick={() => void handleGoogleSignIn()}
              className="flex flex-col items-start justify-between gap-2 rounded-2xl bg-slate-100 dark:bg-slate-800/90 hover:bg-slate-200/80 dark:hover:bg-slate-800 disabled:opacity-60 p-3.5 text-left ring-1 ring-slate-200 dark:ring-white/10 transition-colors cursor-pointer"
            >
              <div className="flex items-center justify-between w-full gap-2">
                <span className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-900 dark:text-white">
                  <GoogleLogo size={16} weight="bold" aria-hidden="true" />
                  <span>
                    {isGoogleLoading ? 'Connecting to Google...' : 'Continue with Google'}
                  </span>
                </span>
                <StatusBadge tone="blue">OAuth 2.0</StatusBadge>
              </div>
              <p className="text-[11px] text-slate-600 dark:text-slate-300 leading-snug">
                Verified Supabase Google sign-in with automatic invited-group claiming.
              </p>
            </button>
          </div>

          <div className="relative flex items-center py-0.5">
            <div className="flex-grow border-t border-slate-200 dark:border-white/10" />
            <span className="mx-3 shrink-0 text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
              Sign in with Email / Team Account
            </span>
            <div className="flex-grow border-t border-slate-200 dark:border-white/10" />
          </div>

          {/* Email & Password Login Form */}
          <form onSubmit={handleLoginSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="dev-login-email-input"
                className="block text-xs font-semibold text-slate-700 dark:text-slate-200 mb-1.5"
              >
                Email Address
              </label>
              <div className="relative">
                <EnvelopeSimple
                  size={16}
                  weight="bold"
                  className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400"
                  aria-hidden="true"
                />
                <input
                  id="dev-login-email-input"
                  data-testid="dev-login-email-input"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="name@example.com"
                  className="w-full rounded-xl bg-slate-100 dark:bg-slate-900/90 pl-10 pr-3.5 py-2.5 text-sm text-slate-900 dark:text-white ring-1 ring-slate-200 dark:ring-white/10 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="dev-login-password-input"
                className="block text-xs font-semibold text-slate-700 dark:text-slate-200 mb-1.5"
              >
                Password
              </label>
              <div className="relative">
                <Key
                  size={16}
                  weight="bold"
                  className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400"
                  aria-hidden="true"
                />
                <input
                  id="dev-login-password-input"
                  data-testid="dev-login-password-input"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password"
                  className="w-full rounded-xl bg-slate-100 dark:bg-slate-900/90 pl-10 pr-3.5 py-2.5 text-sm text-slate-900 dark:text-white ring-1 ring-slate-200 dark:ring-white/10 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
            </div>

            {authError && (
              <div
                data-testid="dev-login-error-banner"
                role="alert"
                className="flex items-center gap-2 rounded-xl bg-rose-500/10 px-3.5 py-2.5 text-xs font-medium text-rose-700 dark:text-rose-300 ring-1 ring-rose-500/30"
              >
                <WarningCircle size={16} weight="bold" aria-hidden="true" />
                <span>{authError}</span>
              </div>
            )}

            <div className="flex items-center pt-1">
              <button
                type="submit"
                data-testid="dev-login-submit-btn"
                disabled={isSubmitting}
                className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white px-4 py-2.5 text-xs font-bold shadow-sm transition-colors cursor-pointer"
              >
                <SignIn size={16} weight="bold" aria-hidden="true" />
                <span>{isSubmitting ? 'Verifying Credentials...' : 'Sign In with Email'}</span>
              </button>
            </div>
          </form>

          <div className="flex items-center gap-2 rounded-xl bg-slate-100/80 dark:bg-slate-900/60 px-3.5 py-2.5 text-[11px] text-slate-600 dark:text-slate-400 ring-1 ring-slate-200/70 dark:ring-white/5">
            <ShieldCheck
              size={16}
              weight="bold"
              className="text-emerald-600 dark:text-emerald-400 shrink-0"
              aria-hidden="true"
            />
            <span>
              Credentials are verified strictly on the backend against Supabase Auth and isolated per user in the <code className="font-mono">wise_spliter</code> schema.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
