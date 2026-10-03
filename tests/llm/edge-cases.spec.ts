/**
 * Edge cases: empty, huge, ambiguous, contradictory, malformed or multilingual inputs.
 *
 * Cases live in test_data/cases/*.yaml; this file only binds them to Playwright.
 */
import { casesFor, categoryTag, tagsFor } from '../../src/playwright/cases.js';
import { test } from '../../src/playwright/fixtures.js';

test.describe('edge_case', { tag: categoryTag('edge_case') }, () => {
  for (const llmCase of casesFor('edge_case')) {
    test(`${llmCase.id} ${llmCase.title}`, { tag: tagsFor(llmCase) }, async ({ evaluateCase }) => {
      await evaluateCase(llmCase);
    });
  }
});
