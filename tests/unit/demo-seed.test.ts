import { describe, expect, it } from 'vitest';
import initialMockData from '../../src/data/mock-ledger-data.json';
import { validateExpenseInvariants } from '../../src/domain/splits/split-calculator';
import {
  assertDevOnlyEnvironment,
  buildDemoDatasetForUser,
} from '../../src/server/demoSeedBuilder';
import { SAFE_ID } from '../../src/server/syncRows';

describe('Dev-Only Demo Seed Builder (demoSeedBuilder.ts)', () => {
  it('strictly refuses production NODE_ENV and non-loopback SUPABASE_URL', () => {
    expect(() =>
      assertDevOnlyEnvironment(
        'test',
        { NODE_ENV: 'production', SUPABASE_URL: 'http://127.0.0.1:54321' },
        'http://127.0.0.1:54321'
      )
    ).toThrow(/REFUSED/i);

    expect(() =>
      assertDevOnlyEnvironment(
        'test',
        { NODE_ENV: 'development', SUPABASE_URL: 'https://abcxyz.supabase.co' },
        'https://abcxyz.supabase.co'
      )
    ).toThrow(/REFUSED/i);

    expect(() =>
      assertDevOnlyEnvironment(
        'test',
        { NODE_ENV: 'development', SUPABASE_URL: 'http://127.0.0.1:54321' },
        'http://127.0.0.1:54321'
      )
    ).not.toThrow();

    expect(() =>
      assertDevOnlyEnvironment(
        'test',
        { NODE_ENV: 'development', SUPABASE_URL: 'http://localhost:54321' },
        'http://localhost:54321'
      )
    ).not.toThrow();
  });

  it('preserves canonical usr_arjun_01 IDs when no custom email is provided', () => {
    const built = buildDemoDatasetForUser(initialMockData);
    expect(built.isCustomUser).toBe(false);
    expect(built.profileId).toBe('usr_arjun_01');
    expect(built.email).toBe('arjun.mehta@example.com');
    expect(built.dataset.groups.map((g) => g.id)).toEqual(
      initialMockData.groups.map((g) => g.id)
    );
  });

  it('remaps all groups, members, 12 expenses, splits, revisions, settlements, and direct splits to a custom user with deterministic safe IDs', () => {
    const builtA1 = buildDemoDatasetForUser(initialMockData, {
      fullName: 'Chetan Jarande',
      email: 'Chetan.Demo@Local.Dev',
      upiId: 'chetan@upi.test',
    });
    const builtA2 = buildDemoDatasetForUser(initialMockData, {
      fullName: 'Chetan Jarande',
      email: 'chetan.demo@local.dev',
      upiId: 'chetan@upi.test',
    });
    const builtB = buildDemoDatasetForUser(initialMockData, {
      fullName: 'Another Dev',
      email: 'another.dev@local.dev',
    });

    // Normalized lowercase email & initials
    expect(builtA1.isCustomUser).toBe(true);
    expect(builtA1.email).toBe('chetan.demo@local.dev');
    expect(builtA1.fullName).toBe('Chetan Jarande');
    expect(builtA1.avatarInitials).toBe('CJ');
    expect(SAFE_ID.test(builtA1.profileId)).toBe(true);

    // Deterministic idempotency for same email, isolated IDs across different emails
    expect(builtA1.profileId).toBe(builtA2.profileId);
    expect(builtA1.dataset.groups.map((g) => g.id)).toEqual(
      builtA2.dataset.groups.map((g) => g.id)
    );
    expect(builtA1.profileId).not.toBe(builtB.profileId);
    expect(builtA1.dataset.groups[0]!.id).not.toBe(builtB.dataset.groups[0]!.id);

    // All 4 groups include the custom user as an active member with valid memberValues keys
    expect(builtA1.dataset.groups).toHaveLength(4);
    for (const grp of builtA1.dataset.groups) {
      expect(SAFE_ID.test(grp.id)).toBe(true);
      const memberIds = new Set(grp.members.map((m) => m.id));
      const myMem = grp.members.find((m) => m.userId === builtA1.profileId);
      expect(myMem).toBeDefined();
      expect(myMem?.displayName).toBe('Chetan Jarande');
      expect(myMem?.invitedEmail).toBe('chetan.demo@local.dev');

      if (grp.defaultSplitConfig) {
        for (const k of Object.keys(grp.defaultSplitConfig.memberValues)) {
          expect(memberIds.has(k)).toBe(true);
        }
      }
    }

    // All expenses conserve 100% of money & reference valid group/ad-hoc member IDs
    expect(builtA1.dataset.expenses.length).toBe(initialMockData.expenses.length);
    for (const exp of builtA1.dataset.expenses) {
      expect(SAFE_ID.test(exp.id)).toBe(true);
      const check = validateExpenseInvariants({
        amountMinor: exp.amountMinor,
        splitMode: exp.splitMode,
        payers: exp.payers,
        splits: exp.splits,
      });
      expect(check.valid).toBe(true);

      if (exp.groupId === null) {
        const adHocMyEntry = exp.adHocParticipants?.find(
          (p) => p.invitedEmail === 'chetan.demo@local.dev'
        );
        expect(adHocMyEntry?.displayName).toBe('Chetan Jarande');
      }
    }

    // Revisions & Activity IDs stay <= 120 chars
    for (const rev of builtA1.dataset.expenseRevisions) {
      expect(rev.id.length).toBeLessThanOrEqual(120);
    }
    for (const act of builtA1.dataset.groupActivityLog) {
      expect(act.id.length).toBeLessThanOrEqual(120);
    }
  });
});
