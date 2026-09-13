import { defineConfig } from 'vitest/config';

// Unit tests of the framework itself. They never call an LLM and are kept apart from
// the Playwright evaluation suite (tests/llm).
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['tests/unit/setup.ts'],
    reporters: process.env.CI ? ['default', 'junit'] : ['default'],
    outputFile: { junit: 'reports/unit-junit.xml' },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // exercised by the Playwright run, not by unit tests
      exclude: ['src/playwright/fixtures.ts'],
      reporter: ['text-summary', 'text', 'cobertura', 'html'],
      reportsDirectory: 'coverage',
      thresholds: { lines: 85, statements: 85, functions: 85, branches: 80 },
    },
  },
});
