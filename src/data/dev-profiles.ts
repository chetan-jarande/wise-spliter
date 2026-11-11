/**
 * SERVER / CLI SEED ONLY: Development user profiles for seeding centralized local Supabase
 * (`scripts/setup-dev-user.mjs`).
 *
 * SECURITY NOTICE: Never import this file from any frontend component, React context, or browser bundle.
 */

export const DEV_DEFAULT_PASSWORD = 'WiseSpliter@2026';

export interface DevDemoProfile {
  id: string;
  email: string;
  password: string;
  fullName: string;
  avatarInitials: string;
  defaultCurrency: string;
  upiId: string;
  roleLabel: string;
}

export const DEV_DEMO_PROFILES: readonly DevDemoProfile[] = [
  {
    id: 'usr_arjun_01',
    email: 'arjun.mehta@gmail.com',
    password: DEV_DEFAULT_PASSWORD,
    fullName: 'Arjun Mehta',
    avatarInitials: 'AM',
    defaultCurrency: 'INR',
    upiId: 'arjun.mehta@okicici',
    roleLabel: 'Primary Dev User (All 4 Groups + Direct Splits)',
  },
  {
    id: 'usr_rohan_02',
    email: 'rohan.verma@gmail.com',
    password: DEV_DEFAULT_PASSWORD,
    fullName: 'Rohan Verma',
    avatarInitials: 'RV',
    defaultCurrency: 'INR',
    upiId: 'rohan.verma@okaxis',
    roleLabel: 'Group Collaborator (Goa, Apt 14B, Kuwait - Isolated from Tokyo)',
  },
  {
    id: 'usr_priya_03',
    email: 'priya.nair@gmail.com',
    password: DEV_DEFAULT_PASSWORD,
    fullName: 'Priya Nair',
    avatarInitials: 'PN',
    defaultCurrency: 'INR',
    upiId: 'priya.nair@oksbi',
    roleLabel: 'Group Collaborator (Goa, Tokyo, Kuwait - Isolated from Apt 14B)',
  },
] as const;
