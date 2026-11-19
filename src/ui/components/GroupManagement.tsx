import { LIMITS } from '../../types/limits';
import React, { useState } from 'react';
import {
  ArrowsClockwiseIcon as ArrowsClockwise,
  CopyIcon as Copy,
  CrownIcon as Crown,
  CurrencyInrIcon as CurrencyInr,
  EnvelopeSimpleIcon as EnvelopeSimple,
  ShareNetworkIcon as ShareNetwork,
  SignInIcon as SignIn,
  SignOutIcon as SignOut,
  TrashIcon as Trash,
  UserMinusIcon as UserMinus,
  WarningIcon as Warning,
} from '@phosphor-icons/react';
import { Share } from '@capacitor/share';
import { useLedger } from '../../state/LedgerContext';
import type { GroupMember, GroupRecord } from '../../types/ledger';
import { formatMinorToMajor } from '../../domain/money/currencies';
import { parseInviteCode } from '../../utils/expense-search';
import { canEditMemberUpi } from '../../utils/group-permissions';
import { isNativeCapacitorApp } from '../../utils/native-platform';

export const BTN =
  'min-h-[44px] min-w-[44px] inline-flex items-center justify-center gap-1.5 rounded-full px-4 py-2 text-xs font-semibold tracking-tight transition-[transform,opacity,background-color,border-color,color,box-shadow] duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 disabled:cursor-not-allowed disabled:opacity-55';
export const BTN_PRIMARY = `${BTN} lg-luminous-pill`;
export const BTN_GHOST = `${BTN} lg-scene-tile text-[#141715] dark:text-[#F3F5F3]`;
export const BTN_DANGER = `${BTN} border border-rose-500/30 bg-rose-500/12 dark:bg-rose-400/14 hover:bg-rose-500/20 dark:hover:bg-rose-400/22 text-rose-800 dark:text-rose-200 shadow-[inset_0_1px_0_rgba(255,255,255,0.18)]`;
const INPUT =
  'lg-recessed-well min-h-[44px] w-full rounded-2xl px-3.5 py-2 text-sm text-[#141715] dark:text-[#F3F5F3] placeholder:text-[#68726C] dark:placeholder:text-[#8A938D] focus:outline-none focus:ring-2 focus:ring-emerald-500/50';

export function inviteLinkFor(code: string): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const apiBase = env?.VITE_API_BASE_URL?.trim() ?? '';
  const base = isNativeCapacitorApp() && apiBase.startsWith('https://') ? apiBase : window.location.origin;
  return `${base.replace(/\/+$/, '')}/?join=${encodeURIComponent(code)}`;
}

export function JoinGroupForm({ initialCode = '', onJoined }: { initialCode?: string; onJoined?: () => void }) {
  const { joinGroupByCode } = useLedger();
  const [value, setValue] = useState(initialCode);
  const [busy, setBusy] = useState(false);
  const code = parseInviteCode(value);
  const showError = value.trim() !== '' && !code;

  const submit = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!code || busy) return;
    setBusy(true);
    const ok = await joinGroupByCode(code);
    setBusy(false);
    if (ok) {
      setValue('');
      onJoined?.();
    }
  };

  return (
    <form onSubmit={submit} data-testid="join-group-form" className="flex flex-col sm:flex-row gap-2.5 sm:items-start">
      <div className="flex-1 min-w-0">
        <label htmlFor="join-group-code" className="sr-only">
          Invite code or link
        </label>
        <input
          id="join-group-code"
          data-testid="join-group-input"
          type="text"
          inputMode="text"
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          maxLength={500}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Paste an invite link or code, like WS-1A2B3C4D5E"
          aria-invalid={showError}
          aria-describedby={showError ? 'join-group-error' : undefined}
          className={`${INPUT} font-mono`}
        />
        {showError && (
          <p id="join-group-error" data-testid="join-group-error" className="mt-1.5 text-[11px] font-medium text-rose-700 dark:text-rose-300">
            That does not look like an invite code. Codes look like WS- followed by 10 letters and numbers.
          </p>
        )}
      </div>
      <button type="submit" data-testid="join-group-submit" disabled={!code || busy} className={BTN_PRIMARY}>
        <SignIn className="w-4 h-4" weight="bold" />
        <span>{busy ? 'Joining...' : 'Join group'}</span>
      </button>
    </form>
  );
}

export function InvitePanel({ group, isAdmin }: { group: GroupRecord; isAdmin: boolean }) {
  const { showToast, isSignedIn, rotateInviteCode } = useLedger();
  const [confirmRotate, setConfirmRotate] = useState(false);
  const link = group.inviteCode ? inviteLinkFor(group.inviteCode) : '';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      showToast('Invite link copied.');
    } catch {
      showToast('Could not copy. Select the link and copy it by hand.');
    }
  };

  const share = async () => {
    const text = `Join "${group.name}" on Wise-Spliter to split bills with me.`;
    try {
      if ((await Share.canShare()).value) {
        await Share.share({ title: group.name, text, url: link, dialogTitle: 'Share invite' });
        return;
      }
    } catch {
      return;
    }
    await copy();
  };

  return (
    <div data-testid="invite-panel" className="lg-recessed-well rounded-[20px] p-4 space-y-3.5">
      <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[#4A524D] dark:text-[#B7BEB9]">
        Invite people
      </div>
      {!isSignedIn && (
        <p data-testid="invite-sign-in-note" className="text-xs font-medium text-amber-800 dark:text-amber-200">
          Sign in to share this group. The code and link work once the group is synced.
        </p>
      )}
      {link ? (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs text-[#4A524D] dark:text-[#B7BEB9]">
            <span>Code</span>
            <span
              data-testid="invite-code-text"
              className="lg-scene-tile rounded-full px-2.5 py-0.5 font-mono font-semibold text-[#141715] dark:text-[#F3F5F3] select-all"
            >
              {group.inviteCode}
            </span>
          </div>
          <div
            data-testid="invite-link-text"
            title={link}
            className="font-mono text-[11px] text-[#5C6660] dark:text-[#9CA69F] truncate select-all"
          >
            {link}
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" data-testid="invite-share-btn" onClick={share} className={BTN_PRIMARY}>
              <ShareNetwork className="w-4 h-4" weight="bold" />
              <span>Share invite</span>
            </button>
            <button type="button" data-testid="invite-copy-link-btn" onClick={copy} className={BTN_GHOST}>
              <Copy className="w-4 h-4" weight="bold" />
              <span>Copy link</span>
            </button>
            {isAdmin && !confirmRotate && (
              <button type="button" data-testid="invite-rotate-btn" onClick={() => setConfirmRotate(true)} className={BTN_GHOST}>
                <ArrowsClockwise className="w-4 h-4" weight="bold" />
                <span>New code</span>
              </button>
            )}
          </div>
        </>
      ) : (
        <p className="text-xs text-[#5C6660] dark:text-[#9CA69F]">The invite code appears after the group syncs.</p>
      )}
      {confirmRotate && (
        <div
          data-testid="invite-rotate-confirm"
          className="rounded-2xl border border-amber-600/30 dark:border-amber-300/28 bg-amber-500/12 dark:bg-amber-400/14 p-3.5 space-y-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.18)]"
        >
          <p className="text-xs text-amber-900 dark:text-amber-200">
            The current code and link stop working. People already in the group stay in it.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="invite-rotate-confirm-btn"
              onClick={() => {
                rotateInviteCode(group.id);
                setConfirmRotate(false);
              }}
              className={BTN_PRIMARY}
            >
              Get a new code
            </button>
            <button type="button" onClick={() => setConfirmRotate(false)} className={BTN_GHOST}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function balanceSentence(name: string, netMinor: number, currency: string, you: boolean): string {
  const amt = formatMinorToMajor(Math.abs(netMinor), currency);
  if (you) return netMinor > 0 ? `You are still owed ${amt} in this group.` : `You still owe ${amt} in this group.`;
  return netMinor > 0 ? `${name} is still owed ${amt}.` : `${name} still owes ${amt}.`;
}

export function GroupDangerZone({
  group,
  isAdmin,
  myNetMinor,
}: {
  group: GroupRecord;
  isAdmin: boolean;
  myNetMinor: number;
}) {
  const { leaveGroup, deleteGroup } = useLedger();
  const [confirm, setConfirm] = useState<'leave' | 'delete' | null>(null);

  return (
    <div data-testid="group-danger-zone" className="space-y-3 pt-1">
      <div className="flex flex-wrap gap-2">
        <button type="button" data-testid="leave-group-btn" onClick={() => setConfirm('leave')} className={BTN_GHOST}>
          <SignOut className="w-4 h-4" weight="bold" />
          <span>Leave group</span>
        </button>
        {isAdmin && (
          <button type="button" data-testid="delete-group-btn" onClick={() => setConfirm('delete')} className={BTN_DANGER}>
            <Trash className="w-4 h-4" weight="bold" />
            <span>Delete group</span>
          </button>
        )}
      </div>

      {confirm === 'leave' && (
        <div
          role="alertdialog"
          aria-label="Leave group"
          className="rounded-2xl border border-amber-600/30 dark:border-amber-300/28 bg-amber-500/12 dark:bg-amber-400/14 p-3.5 space-y-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.18)]"
        >
          {myNetMinor !== 0 && (
            <p data-testid="leave-group-balance-warning" className="flex items-start gap-1.5 text-xs font-semibold text-amber-900 dark:text-amber-200">
              <Warning className="w-4 h-4 shrink-0" weight="fill" />
              <span>
                {balanceSentence('', myNetMinor, group.baseCurrency, true)} Settle up first, or the others keep this
                balance without you.
              </span>
            </p>
          )}
          <p className="text-xs text-[#2B312D] dark:text-[#DCE2DD]">
            The group and its bills disappear from this device. Someone can invite you back later.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="leave-group-confirm-btn"
              onClick={() => {
                leaveGroup(group.id);
                setConfirm(null);
              }}
              className={BTN_DANGER}
            >
              Leave group
            </button>
            <button type="button" onClick={() => setConfirm(null)} className={BTN_GHOST}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {confirm === 'delete' && (
        <div
          role="alertdialog"
          aria-label="Delete group"
          className="rounded-2xl border border-rose-500/30 bg-rose-500/12 dark:bg-rose-400/14 p-3.5 space-y-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.18)]"
        >
          <p className="text-xs text-[#2B312D] dark:text-[#DCE2DD]">
            <span dir="auto" className="font-semibold break-words [overflow-wrap:anywhere]">{group.name}</span> moves to Trash for everyone in it. An
            admin can restore it from Trash with all of its bills.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="delete-group-confirm-btn"
              onClick={() => {
                deleteGroup(group.id);
                setConfirm(null);
              }}
              className={BTN_DANGER}
            >
              Move to Trash
            </button>
            <button type="button" onClick={() => setConfirm(null)} className={BTN_GHOST}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const SMALL =
  'lg-scene-tile min-h-[44px] min-w-[44px] inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-semibold text-[#141715] dark:text-[#F3F5F3] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60';

export function MemberAdminActions({
  group,
  member,
  netMinor,
}: {
  group: GroupRecord;
  member: GroupMember;
  netMinor: number;
}) {
  const { removeMember, setMemberRole, addMemberEmail, dataset } = useLedger();
  const [mode, setMode] = useState<'idle' | 'remove' | 'email'>('idle');
  const [email, setEmail] = useState(member.invitedEmail ?? '');
  const isMe = member.userId === dataset.currentUser.id;

  return (
    <>
      {!member.userId && (
        <button type="button" data-testid={`member-add-email-${member.id}`} onClick={() => setMode('email')} className={SMALL}>
          <EnvelopeSimple className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-300" />
          <span>{member.invitedEmail ? 'Change email' : 'Add email'}</span>
        </button>
      )}
      {member.userId && (
        <button
          type="button"
          data-testid={`member-role-${member.id}`}
          onClick={() => setMemberRole(group.id, member.id, member.role === 'admin' ? 'member' : 'admin')}
          className={SMALL}
        >
          <Crown className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-300" />
          <span>{member.role === 'admin' ? 'Remove admin' : 'Make admin'}</span>
        </button>
      )}
      {!isMe && (
        <button type="button" data-testid={`remove-member-${member.id}`} onClick={() => setMode('remove')} className={SMALL}>
          <UserMinus className="w-3.5 h-3.5 text-rose-700 dark:text-rose-300" />
          <span>Remove</span>
        </button>
      )}

      {mode === 'email' && (
        <form
          noValidate
          className="basis-full flex flex-col sm:flex-row gap-2 pt-1.5"
          onSubmit={(e: React.SyntheticEvent<HTMLFormElement>) => {
            e.preventDefault();
            if (addMemberEmail(group.id, member.id, email)) setMode('idle');
          }}
        >
          <label htmlFor={`member-email-${member.id}`} className="sr-only">
            Email for {member.displayName}
          </label>
          <input
            id={`member-email-${member.id}`}
            data-testid={`member-email-edit-input-${member.id}`}
            type="email"
            autoComplete="off"
            maxLength={LIMITS.email}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="friend@example.com"
            className={`${INPUT} sm:flex-1`}
          />
          <div className="flex flex-wrap gap-2">
            <button type="submit" data-testid={`member-email-save-${member.id}`} className={BTN_PRIMARY}>
              Save email
            </button>
            <button type="button" onClick={() => setMode('idle')} className={BTN_GHOST}>
              Cancel
            </button>
          </div>
          <p className="basis-full text-[11px] text-[#5C6660] dark:text-[#9CA69F]">
            When they sign in with this email, this spot and its balance become theirs.
          </p>
        </form>
      )}

      {mode === 'remove' && (
        <div
          role="alertdialog"
          aria-label={`Remove ${member.displayName}`}
          className="basis-full rounded-2xl border border-rose-500/30 bg-rose-500/12 dark:bg-rose-400/14 p-3.5 space-y-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.18)]"
        >
          {netMinor !== 0 && (
            <p data-testid={`remove-member-balance-warning-${member.id}`} className="flex items-start gap-1.5 text-xs font-semibold text-amber-900 dark:text-amber-200">
              <Warning className="w-4 h-4 shrink-0" weight="fill" />
              <span dir="auto" className="break-words [overflow-wrap:anywhere]">
                {balanceSentence(member.displayName, netMinor, group.baseCurrency, false)} The balance stays in the
                group and still shows in Who Pays Whom.
              </span>
            </p>
          )}
          <p className="text-xs text-[#2B312D] dark:text-[#DCE2DD]">
            Their past bills stay in the history, marked as a former member.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              data-testid={`remove-member-confirm-${member.id}`}
              onClick={() => {
                removeMember(group.id, member.id);
                setMode('idle');
              }}
              className={BTN_DANGER}
            >
              Remove from group
            </button>
            <button type="button" onClick={() => setMode('idle')} className={BTN_GHOST}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  );
}

export function MemberUpiEditor({ group, member }: { group: GroupRecord; member: GroupMember }) {
  const { setMemberUpi, dataset } = useLedger();
  const [mode, setMode] = useState<'idle' | 'edit' | 'locked'>('idle');
  const [upi, setUpi] = useState(member.upiId ?? '');
  const editable = canEditMemberUpi(member, dataset.currentUser.id);

  return (
    <>
      <button
        type="button"
        data-testid={`member-upi-edit-${member.id}`}
        onClick={() => {
          setUpi(member.upiId ?? '');
          setMode(editable ? 'edit' : 'locked');
        }}
        className={SMALL}
      >
        <CurrencyInr className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-300" />
        <span>{member.upiId ? 'Edit UPI' : 'Add UPI'}</span>
      </button>
      {mode === 'locked' && (
        <p data-testid={`member-upi-locked-${member.id}`} role="status" className="basis-full text-[11px] text-[#4A524D] dark:text-[#B7BEB9]">
          <span dir="auto">Only {member.displayName} can change their UPI ID.</span>
        </p>
      )}
      {mode === 'edit' && (
        <form
          noValidate
          className="basis-full flex flex-col sm:flex-row gap-2 pt-1.5"
          onSubmit={(e: React.SyntheticEvent<HTMLFormElement>) => {
            e.preventDefault();
            if (setMemberUpi(group.id, member.id, upi)) setMode('idle');
          }}
        >
          <label htmlFor={`member-upi-${member.id}`} className="sr-only">
            UPI ID for {member.displayName}
          </label>
          <input
            id={`member-upi-${member.id}`}
            data-testid={`member-upi-input-${member.id}`}
            type="text"
            autoComplete="off"
            spellCheck={false}
            maxLength={LIMITS.upiId}
            value={upi}
            onChange={(e) => setUpi(e.target.value)}
            placeholder="name@bank"
            className={`${INPUT} font-mono sm:flex-1`}
          />
          <div className="flex flex-wrap gap-2">
            <button type="submit" data-testid={`member-upi-save-${member.id}`} className={BTN_PRIMARY}>
              Save UPI
            </button>
            <button type="button" onClick={() => setMode('idle')} className={BTN_GHOST}>
              Cancel
            </button>
          </div>
          {!member.userId && (
            <p className="basis-full text-[11px] text-[#5C6660] dark:text-[#9CA69F]">
              Everyone in the group sees who changed it.
            </p>
          )}
        </form>
      )}
    </>
  );
}
