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
    adoptSignedInSession,
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
    dataset.currentUser.email.toLowerCase() === 'arjun.mehta@example.com';

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
          'We could not sign you in. Check your email and password. If you signed up with Google, use Continue with Google.'
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
      if (demoRes.ok && demoRes.profile) {
        if (await adoptSignedInSession(demoRes.profile, demoRes.token, demoRes.dataset)) {
          showToast(
            `Signed into Demo Sandbox: ${demoRes.profile.fullName} (${demoRes.profile.email})`
          );
        }
        onClose();
        return;
      }

      setAuthError(
        'The demo account is not available right now. You can keep using the app on this device without signing in; nothing here was changed.'
      );
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

      if (result.exchangedProfile) {
        const adopted = await adoptSignedInSession(
          result.exchangedProfile,
          result.exchangedToken ?? null,
          result.exchangedDataset ?? null
        );
        if (adopted) {
          showToast(
            `Signed in with Google as ${result.exchangedProfile.fullName} (${result.exchangedProfile.email})`
          );
        }
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
      className="fixed inset-0 z-50 flex items-center justify-center lg-modal-scrim p-4 overflow-y-auto"
    >
      <div className="w-full max-w-lg my-auto lg-modal-surface rounded-[30px] overflow-hidden text-[#141715] dark:text-[#F3F5F3]">
        {/* Modal Header */}
        <div className="flex items-center justify-between gap-3 px-6 py-4 border-b border-black/[0.07] dark:border-white/[0.10]">
          <div className="flex items-center gap-3">
            <div className="lg-icon-orb h-10 w-10 rounded-full text-emerald-700 dark:text-emerald-300 flex items-center justify-center shrink-0">
              <LockKey size={19} weight="bold" aria-hidden="true" />
            </div>
            <div>
              <h2
                id="dev-auth-modal-title"
                className="text-base font-bold tracking-tight text-[#141715] dark:text-[#F3F5F3]"
              >
                Sign In &amp; Switch Account
              </h2>
              <p className="text-xs text-[#5C6660] dark:text-[#9CA69F]">
                Supabase Auth &amp; Backend Session Isolation ({dataset.currentUser.supabaseSchema})
              </p>
            </div>
          </div>

          <button
            type="button"
            data-testid="close-dev-auth-modal-btn"
            onClick={onClose}
            aria-label="Close authentication modal"
            className="lg-icon-orb min-h-[44px] min-w-[44px] h-11 w-11 rounded-full text-[#4A524D] dark:text-[#B7BEB9] hover:text-[#141715] dark:hover:text-white flex items-center justify-center transition-colors shrink-0 cursor-pointer"
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
                <span className="h-10 w-10 rounded-full bg-emerald-500/18 dark:bg-emerald-400/20 text-emerald-800 dark:text-emerald-200 ring-1 ring-emerald-600/25 dark:ring-emerald-300/25 font-mono font-bold text-sm flex items-center justify-center shrink-0">
                  {dataset.currentUser.avatarInitials}
                </span>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-bold text-[#141715] dark:text-[#F3F5F3] truncate">
                      {dataset.currentUser.fullName}
                    </span>
                    <StatusBadge tone={isOnline ? 'emerald' : 'amber'}>
                      {isOnline
                        ? `Verified (${dataset.currentUser.supabaseSchema})`
                        : 'Offline Session'}
                    </StatusBadge>
                  </div>
                  <p className="text-xs font-mono text-[#4A524D] dark:text-[#B7BEB9] truncate">
                    {dataset.currentUser.email}
                  </p>
                  <p className="text-[11px] text-[#5C6660] dark:text-[#9CA69F] mt-0.5">
                    UPI: <span className="font-mono">{dataset.currentUser.upiId}</span> | Authorized Groups: <span className="font-mono font-semibold">{activeGroupsCount}</span>
                  </p>
                </div>
              </div>
              <CheckCircle
                size={20}
                weight="fill"
                className="text-emerald-600 dark:text-emerald-400 shrink-0"
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
              className="flex flex-col items-start justify-between gap-2 rounded-[20px] bg-emerald-500/[0.09] dark:bg-emerald-400/[0.10] hover:bg-emerald-500/[0.15] dark:hover:bg-emerald-400/[0.16] p-3.5 text-left ring-1 ring-emerald-600/25 dark:ring-emerald-300/25 transition-[transform,opacity,background-color,box-shadow] duration-200 active:scale-[0.985] cursor-pointer disabled:opacity-60"
            >
              <div className="flex items-center justify-between w-full gap-2">
                <span className="inline-flex items-center gap-1.5 text-xs font-bold text-emerald-800 dark:text-emerald-200">
                  <ShieldCheck size={16} weight="bold" aria-hidden="true" />
                  <span>1-Tap Demo Profile</span>
                </span>
                <StatusBadge tone={isCurrentlyDemoProfile ? 'emerald' : 'slate'}>
                  {isCurrentlyDemoProfile ? 'Active' : 'Sandbox'}
                </StatusBadge>
              </div>
              <p className="text-[11px] text-[#4A524D] dark:text-[#B7BEB9] leading-snug">
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
              className="lg-scene-tile flex flex-col items-start justify-between gap-2 rounded-[20px] disabled:opacity-60 p-3.5 text-left cursor-pointer"
            >
              <div className="flex items-center justify-between w-full gap-2">
                <span className="inline-flex items-center gap-1.5 text-xs font-bold text-[#141715] dark:text-[#F3F5F3]">
                  <GoogleLogo size={16} weight="bold" aria-hidden="true" />
                  <span>
                    {isGoogleLoading ? 'Connecting to Google...' : 'Continue with Google'}
                  </span>
                </span>
                <StatusBadge tone="blue">OAuth 2.0</StatusBadge>
              </div>
              <p className="text-[11px] text-[#4A524D] dark:text-[#B7BEB9] leading-snug">
                Verified Supabase Google sign-in with automatic invited-group claiming.
              </p>
            </button>
          </div>

          <div className="relative flex items-center py-0.5">
            <div className="flex-grow border-t border-black/[0.08] dark:border-white/[0.10]" />
            <span className="mx-3 shrink-0 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#68726C] dark:text-[#8A938D]">
              Sign in with Email / Team Account
            </span>
            <div className="flex-grow border-t border-black/[0.08] dark:border-white/[0.10]" />
          </div>

          {/* Email & Password Login Form */}
          <form onSubmit={handleLoginSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="dev-login-email-input"
                className="block text-xs font-semibold text-[#1F2421] dark:text-[#E5EAE6] mb-1.5"
              >
                Email Address
              </label>
              <div className="relative">
                <EnvelopeSimple
                  size={16}
                  weight="bold"
                  className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[#68726C] dark:text-[#8A938D]"
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
                  className="lg-recessed-well w-full min-h-[44px] rounded-[16px] pl-10 pr-3.5 py-2.5 text-sm text-[#141715] dark:text-[#F3F5F3] placeholder:text-[#68726C] dark:placeholder:text-[#8A938D] focus:outline-none focus:ring-2 focus:ring-emerald-500/60"
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="dev-login-password-input"
                className="block text-xs font-semibold text-[#1F2421] dark:text-[#E5EAE6] mb-1.5"
              >
                Password
              </label>
              <div className="relative">
                <Key
                  size={16}
                  weight="bold"
                  className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[#68726C] dark:text-[#8A938D]"
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
                  className="lg-recessed-well w-full min-h-[44px] rounded-[16px] pl-10 pr-3.5 py-2.5 text-sm text-[#141715] dark:text-[#F3F5F3] placeholder:text-[#68726C] dark:placeholder:text-[#8A938D] focus:outline-none focus:ring-2 focus:ring-emerald-500/60"
                />
              </div>
            </div>

            {authError && (
              <div
                data-testid="dev-login-error-banner"
                role="alert"
                className="flex items-center gap-2 rounded-[16px] bg-rose-500/12 px-3.5 py-2.5 text-xs font-medium text-rose-800 dark:text-rose-200 ring-1 ring-rose-600/25 dark:ring-rose-300/25"
              >
                <WarningCircle size={16} weight="bold" aria-hidden="true" className="shrink-0" />
                <span>{authError}</span>
              </div>
            )}

            <div className="flex items-center pt-1">
              <button
                type="submit"
                data-testid="dev-login-submit-btn"
                disabled={isSubmitting}
                className="lg-luminous-pill w-full min-h-[44px] inline-flex items-center justify-center gap-2 rounded-full disabled:opacity-60 px-4 py-2.5 text-xs font-semibold cursor-pointer"
              >
                <SignIn size={16} weight="bold" aria-hidden="true" />
                <span>{isSubmitting ? 'Verifying Credentials...' : 'Sign In with Email'}</span>
              </button>
            </div>
          </form>

          <div className="lg-recessed-well flex items-center gap-2.5 rounded-[16px] px-3.5 py-2.5 text-[11px] text-[#4A524D] dark:text-[#B7BEB9]">
            <ShieldCheck
              size={16}
              weight="bold"
              className="text-emerald-700 dark:text-emerald-300 shrink-0"
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
