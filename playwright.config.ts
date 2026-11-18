import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: 'list',
  timeout: 60_000,
  globalSetup: './tests/e2e/global-setup.ts',
  webServer: {
    command: 'node scripts/dev-stack.mjs',
    url: `http://localhost:${process.env.API_PORT || 4174}/api/health`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
  use: {
    baseURL: `http://localhost:${process.env.APP_PORT || 4173}`,
    trace: 'on-first-retry',
    launchOptions: {
      executablePath:
        process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? '/usr/bin/google-chrome',
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
