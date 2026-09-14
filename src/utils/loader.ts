/** Load and validate YAML test cases + render Nunjucks prompt templates. */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import nunjucks from 'nunjucks';
import { parse as parseYaml } from 'yaml';
import { ZodError } from 'zod';
import { type Category, type TestCase, parseTestCase } from '../models/test-case.js';

/** Invalid or inconsistent test data. Raised at collection time, not mid-run. */
export class TestDataError extends Error {
  override name = 'TestDataError';
}

export interface CaseFilter {
  categories?: readonly Category[];
  tags?: readonly string[];
}

export function listCaseFiles(casesDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(casesDir, { recursive: true, encoding: 'utf8' });
  } catch {
    throw new TestDataError(`test case directory not found: ${casesDir}`);
  }
  return entries
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => path.join(casesDir, f))
    .sort();
}

export function readYaml(file: string): unknown {
  try {
    return parseYaml(readFileSync(file, 'utf8')) as unknown;
  } catch (err) {
    throw new TestDataError(`${file}: invalid YAML: ${(err as Error).message}`);
  }
}

function formatZodError(err: ZodError): string {
  return err.issues
    .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ');
}

/** Load every *.yaml under `casesDir`; fail fast on schema errors or duplicate ids. */
export function loadCases(casesDir: string, filter: CaseFilter = {}): TestCase[] {
  const files = listCaseFiles(casesDir);
  if (files.length === 0) throw new TestDataError(`no test case files found in ${casesDir}`);

  const cases: TestCase[] = [];
  const seen = new Map<string, string>();
  for (const file of files) {
    const raw = readYaml(file) ?? [];
    if (!Array.isArray(raw)) {
      throw new TestDataError(`${file}: top-level YAML must be a list of test cases`);
    }
    raw.forEach((item: unknown, index) => {
      const ident =
        item && typeof item === 'object' && 'id' in item ? String(item.id) : `#${index}`;
      let testCase: TestCase;
      try {
        testCase = parseTestCase(item);
      } catch (err) {
        const detail = err instanceof ZodError ? formatZodError(err) : String(err);
        throw new TestDataError(`${path.basename(file)} [${ident}]: ${detail}`);
      }
      const previous = seen.get(testCase.id);
      if (previous) {
        throw new TestDataError(
          `duplicate id ${testCase.id} in ${path.basename(file)} and ${path.basename(previous)}`,
        );
      }
      seen.set(testCase.id, file);
      cases.push(testCase);
    });
  }

  const categories = filter.categories?.length ? new Set(filter.categories) : null;
  const tags = filter.tags?.length ? new Set(filter.tags) : null;
  return cases.filter(
    (c) =>
      (categories === null || categories.has(c.category)) &&
      (tags === null || c.tags.some((t) => tags.has(t))),
  );
}

/** Render prompts; `throwOnUndefined` turns a missing variable into an error (StrictUndefined). */
export class PromptRenderer {
  readonly #env: nunjucks.Environment;

  constructor(templatesDir: string) {
    this.#env = new nunjucks.Environment(new nunjucks.FileSystemLoader(templatesDir), {
      autoescape: false, // prompts are plain text, not HTML
      throwOnUndefined: true,
    });
    // Jinja2's "%05d"|format(i) has no Nunjucks equivalent
    this.#env.addFilter('zfill', (value: unknown, width: number) =>
      String(value).padStart(width, '0'),
    );
  }

  render(c: TestCase): string {
    if (c.template === undefined) return c.prompt ?? '';
    return this.#env.render(c.template, { ...c.variables, context: c.context }).trim();
  }
}
