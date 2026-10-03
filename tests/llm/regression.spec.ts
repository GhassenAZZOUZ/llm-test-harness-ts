/**
 * Regression suite: previously failing prompts. Always strict, even with LLM_SOFT_FAIL=true.
 *
 * Cases live in test_data/cases/*.yaml; this file only binds them to Playwright.
 */
import { casesFor, categoryTag, tagsFor } from '../../src/playwright/cases.js';
import { test } from '../../src/playwright/fixtures.js';

test.describe('regression', { tag: categoryTag('regression') }, () => {
  for (const llmCase of casesFor('regression')) {
    test(`${llmCase.id} ${llmCase.title}`, { tag: tagsFor(llmCase) }, async ({ evaluateCase }) => {
      await evaluateCase(llmCase);
    });
  }
});
