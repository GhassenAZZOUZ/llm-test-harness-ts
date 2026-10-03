/**
 * Playwright fixtures for LLM evaluations (dependency injection).
 *
 * - `settings`, `softFail`: worker-scoped option fixtures (a project can override them).
 * - `harness`: worker-scoped composition root (clients, evaluators, runner), created
 *   once per worker and shared by all its tests.
 * - `evaluateCase`: test-scoped; runs one YAML case, attaches prompt / response /
 *   evaluator table / JSON result, and turns the verdict into a Playwright outcome.
 */
import { test as base, expect } from '@playwright/test';
import { type Settings, loadSettings } from '../config/settings.js';
import type { TestResult } from '../models/results.js';
import type { TestCase } from '../models/test-case.js';
import { Harness } from '../runner/harness.js';
import { setLogLevel } from '../utils/logger.js';
import { RESULT_ATTACHMENT, decideOutcome, evaluatorTable } from './outcome.js';

export interface LLMWorkerFixtures {
  settings: Settings;
  softFail: boolean;
  harness: Harness;
}

export interface LLMTestFixtures {
  evaluateCase: (c: TestCase) => Promise<TestResult>;
}

export const test = base.extend<LLMTestFixtures, LLMWorkerFixtures>({
  settings: [
    // eslint-disable-next-line no-empty-pattern -- Playwright requires object destructuring
    async ({}, use) => {
      const settings = loadSettings();
      setLogLevel(settings.logLevel);
      await use(settings);
    },
    { scope: 'worker' },
  ],

  softFail: [
    async ({ settings }, use) => use(settings.softFail),
    { scope: 'worker', option: true },
  ],

  harness: [async ({ settings }, use) => use(Harness.create(settings)), { scope: 'worker' }],

  evaluateCase: async ({ harness, softFail }, use, testInfo) => {
    await use(async (c) => {
      const result = await harness.run(c);

      await testInfo.attach(RESULT_ATTACHMENT, {
        body: JSON.stringify(result),
        contentType: 'application/json',
      });
      await testInfo.attach('prompt', {
        body: result.prompt || '<empty>',
        contentType: 'text/plain',
      });
      await testInfo.attach('response', {
        body: result.attempts.at(-1)?.response?.text ?? '<no response>',
        contentType: 'text/plain',
      });
      await testInfo.attach('evaluators', {
        body: evaluatorTable(result),
        contentType: 'text/plain',
      });
      testInfo.annotations.push(
        { type: 'llm-status', description: result.status },
        { type: 'llm-deterministic', description: String(result.deterministic) },
        ...(c.defect ? [{ type: 'defect', description: c.defect }] : []),
      );

      const outcome = decideOutcome(result, c, softFail);
      switch (outcome.kind) {
        case 'skip':
          testInfo.skip(true, outcome.reason);
          break;
        case 'soft-fail':
          // expected failure: visible in reports, does not break the build; the gate decides
          testInfo.annotations.push({ type: 'llm-soft-fail', description: outcome.message });
          testInfo.fail(true, outcome.message);
          expect(result.status, outcome.message).toBe('passed');
          break;
        case 'fail':
          expect(result.status, outcome.message).toBe('passed');
          break;
        case 'pass':
          break;
      }
      return result;
    });
  },
});

export { expect };
