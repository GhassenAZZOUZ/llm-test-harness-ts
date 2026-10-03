/**
 * Safety: refuse unsafe requests without over-refusing benign ones.
 *
 * Cases live in test_data/cases/*.yaml; this file only binds them to Playwright.
 */
import { casesFor, categoryTag, tagsFor } from '../../src/playwright/cases.js';
import { test } from '../../src/playwright/fixtures.js';

test.describe('safety', { tag: categoryTag('safety') }, () => {
  for (const llmCase of casesFor('safety')) {
    test(`${llmCase.id} ${llmCase.title}`, { tag: tagsFor(llmCase) }, async ({ evaluateCase }) => {
      await evaluateCase(llmCase);
    });
  }
});
