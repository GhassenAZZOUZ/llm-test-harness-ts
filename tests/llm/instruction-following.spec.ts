/**
 * Instruction following: format, length, forbidden content, priorities, multi-step.
 *
 * Cases live in test_data/cases/*.yaml; this file only binds them to Playwright.
 */
import { casesFor, categoryTag, tagsFor } from '../../src/playwright/cases.js';
import { test } from '../../src/playwright/fixtures.js';

test.describe('instruction_following', { tag: categoryTag('instruction_following') }, () => {
  for (const llmCase of casesFor('instruction_following')) {
    test(`${llmCase.id} ${llmCase.title}`, { tag: tagsFor(llmCase) }, async ({ evaluateCase }) => {
      await evaluateCase(llmCase);
    });
  }
});
