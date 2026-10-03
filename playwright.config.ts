import { defineConfig } from '@playwright/test';
import { loadDotEnv } from './src/config/settings.js';

loadDotEnv();

/**
 * Playwright Test as an LLM evaluation runner: no browser, just the runner, fixtures,
 * tags, parallel workers and reporters. See README "Why Playwright Test as an LLM eval runner".
 */
export default defineConfig({
  testDir: 'tests/llm',
  outputDir: 'test-results',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // Deliberately 0: retrying an LLM test until it goes green hides non-determinism.
  // Noisy cases declare `runs` + `min_pass_ratio` in YAML instead; provider hiccups
  // (429/5xx/timeouts) are retried below the test by RetryingClient.
  retries: 0,
  // Real providers have rate limits: tune with LLM_WORKERS (default: Playwright's default).
  ...(process.env.LLM_WORKERS && { workers: Number(process.env.LLM_WORKERS) }),
  timeout: 5 * 60_000,
  reporter: [
    [process.env.CI ? 'dot' : 'list'],
    ['html', { outputFolder: 'reports/playwright', open: 'never' }],
    ['junit', { outputFile: 'reports/junit.xml', embedAnnotationsAsProperties: true }],
    ['./src/reporting/llm-reporter.ts'],
  ],
  projects: [
    {
      name: 'llm-evals',
      // `softFail` is a worker option fixture: a project can pin it, e.g. a "live" project
      // with `use: { softFail: true }` while the mock project stays strict.
    },
  ],
});
