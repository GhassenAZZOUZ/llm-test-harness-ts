/**
 * Functional: does the model do the job on normal, well-formed requests?
 *
 * Cases live in test_data/cases/*.yaml; this file only binds them to Playwright.
 */
import { casesFor, categoryTag, tagsFor } from '../../src/playwright/cases.js';
import { test } from '../../src/playwright/fixtures.js';

test.describe('functional', { tag: categoryTag('functional') }, () => {
  for (const llmCase of casesFor('functional')) {
    test(`${llmCase.id} ${llmCase.title}`, { tag: tagsFor(llmCase) }, async ({ evaluateCase }) => {
      await evaluateCase(llmCase);
    });
  }
});
