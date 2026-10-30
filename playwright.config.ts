import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './tests', workers: 1, timeout: 60000, outputDir: '.local/playwright-results', reporter: 'list', use: { baseURL: 'http://localhost:5173', channel: 'chrome', viewport: { width: 1440, height: 1000 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' } });
