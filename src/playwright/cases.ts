/** Collect YAML cases for a spec file and expose them as Playwright tags. */
import path from 'node:path';
import { loadDotEnv, loadSettings } from '../config/settings.js';
import type { Category, TestCase } from '../models/test-case.js';
import { loadCases } from '../utils/loader.js';

/**
 * Cases of one category. Runs at collection time, so invalid YAML, duplicate ids or a
 * bad configuration fail the run before any LLM call is made.
 */
export function casesFor(category: Category): TestCase[] {
  loadDotEnv();
  const settings = loadSettings();
  return loadCases(path.join(settings.dataDir, 'cases'), { categories: [category] });
}

/** YAML tags + severity as Playwright tags, so `--grep @smoke` / `--grep @critical` work. */
export function tagsFor(c: TestCase): string[] {
  return [...new Set([...c.tags, c.severity])].map((t) => `@${t}`);
}

/** Playwright tag of a category, e.g. `@edge_case`. */
export function categoryTag(category: Category): string {
  return `@${category}`;
}
