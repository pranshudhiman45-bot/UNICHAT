import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', workers: 1, timeout: 60000,
  outputDir: '../.local/workspace-approval-results', reporter: 'list',
  use: { baseURL: process.env.PLAYWRIGHT_BASE_URL, channel: 'chrome', viewport: { width: 1440, height: 1000 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
});
