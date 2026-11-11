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
  const { dataset, isOnline, switchActiveUserProfile, showToast } = useLedger();

  const [email, setEmail] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [authError, setAuthError] = useState<string | null>(null);

  if (!isOpen) return null;

  const activeGroupsCount = dataset.groups.filter((g) => !g.deletedAt).length;

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

  const handleGoogleSignIn = async () => {
    setAuthError(null);
    const result = await wiseSpliterSyncEngine.signInWithGoogleOAuth(
      email.trim() || dataset.currentUser.email
    );
    if (result.ok) {
      showToast(
        `Google OAuth session verified for ${result.sessionEmail} (${result.schema})`
      );
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

            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 pt-1">
              <button
                type="submit"
                data-testid="dev-login-submit-btn"
                disabled={isSubmitting}
                className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-60 text-white px-4 py-2.5 text-xs font-bold shadow-sm transition-colors cursor-pointer"
              >
                <SignIn size={16} weight="bold" aria-hidden="true" />
                <span>{isSubmitting ? 'Verifying Credentials...' : 'Sign In with Email'}</span>
              </button>

              <button
                type="button"
                data-testid="dev-google-oauth-btn"
                onClick={() => void handleGoogleSignIn()}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200/80 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-100 px-4 py-2.5 text-xs font-semibold ring-1 ring-slate-200 dark:ring-white/10 transition-colors cursor-pointer"
              >
                <GoogleLogo size={16} weight="bold" aria-hidden="true" />
                <span>Continue with Google</span>
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
