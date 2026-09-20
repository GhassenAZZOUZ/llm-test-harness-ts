import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PromptRenderer, TestDataError, loadCases } from '../../../src/utils/loader.js';
import { ROOT, makeCase, tempDir } from '../helpers.js';

function casesDir(files: Record<string, string>): string {
  const dir = path.join(tempDir(), 'cases');
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

const CASE = (id: string, extra = '') => `
- id: ${id}
  category: functional
  title: Case ${id}
  prompt: hello
  expected: { contains: [hi] }
${extra}`;

describe('loadCases', () => {
  it('loads the real suite (41 cases, 6 categories)', () => {
    const cases = loadCases(path.join(ROOT, 'test_data/cases'));
    expect(cases).toHaveLength(41);
    expect(new Set(cases.map((c) => c.category)).size).toBe(6);
  });

  it('loads nested .yaml / .yml files and filters by category and tag', () => {
    const dir = casesDir({
      'a.yaml': CASE('TC-001', '  tags: [smoke]'),
      'nested/b.yml': CASE('TC-002').replace('functional', 'safety'),
    });
    expect(loadCases(dir).map((c) => c.id)).toEqual(['TC-001', 'TC-002']);
    expect(loadCases(dir, { categories: ['safety'] }).map((c) => c.id)).toEqual(['TC-002']);
    expect(loadCases(dir, { tags: ['smoke'] }).map((c) => c.id)).toEqual(['TC-001']);
    expect(loadCases(dir, { categories: [], tags: [] })).toHaveLength(2);
  });

  it('fails fast on duplicate ids, naming both files', () => {
    const dir = casesDir({ 'a.yaml': CASE('TC-001'), 'b.yaml': CASE('TC-001') });
    expect(() => loadCases(dir)).toThrow(/duplicate id TC-001 in b.yaml and a.yaml/);
  });

  it('reports file + case id on schema errors', () => {
    const dir = casesDir({ 'bad.yaml': CASE('TC-007').replace('prompt: hello', 'promt: hello') });
    expect(() => loadCases(dir)).toThrow(TestDataError);
    expect(() => loadCases(dir)).toThrow(/bad.yaml \[TC-007\]: .*promt/);
  });

  it('uses the index when the item has no id', () => {
    const dir = casesDir({ 'bad.yaml': '- just a string' });
    expect(() => loadCases(dir)).toThrow(/bad.yaml \[#0\]/);
  });

  it('rejects non-list files, invalid YAML, empty and missing directories', () => {
    expect(() => loadCases(casesDir({ 'x.yaml': 'id: TC-001' }))).toThrow(/must be a list/);
    expect(() => loadCases(casesDir({ 'x.yaml': '- [unclosed' }))).toThrow(/invalid YAML/);
    expect(() => loadCases(casesDir({ 'readme.txt': 'x' }))).toThrow(/no test case files/);
    expect(() => loadCases(path.join(tempDir(), 'nope'))).toThrow(/not found/);
  });

  it('treats an empty file as an empty list', () => {
    expect(loadCases(casesDir({ 'a.yaml': CASE('TC-001'), 'empty.yaml': '' }))).toHaveLength(1);
  });
});

describe('PromptRenderer (Nunjucks)', () => {
  const renderer = new PromptRenderer(path.join(ROOT, 'test_data/prompts'));

  it('returns the raw prompt when there is no template', () => {
    expect(renderer.render(makeCase({ prompt: 'raw' }))).toBe('raw');
  });

  it('renders a template with variables and context', () => {
    const c = makeCase({
      prompt: undefined,
      template: 'rag_qa.njk',
      variables: { question: 'Q?' },
      context: 'CTX',
    });
    const out = renderer.render(c);
    expect(out).toContain('CONTEXT:\nCTX');
    expect(out).toContain('QUESTION: Q?');
  });

  it('supports the zfill filter used by the needle-in-a-haystack template', () => {
    const c = makeCase({
      prompt: undefined,
      template: 'long_input.njk',
      variables: { repeat: 12, needle_at: 7, needle: 'BLUE-1' },
    });
    const out = renderer.render(c);
    expect(out).toContain('[00011] INFO');
    expect(out).toContain(
      '[00007] WARN service=auth message="temporary access code issued: BLUE-1"',
    );
  });

  it('turns a missing variable into an error (StrictUndefined)', () => {
    const c = makeCase({ prompt: undefined, template: 'rag_qa.njk', context: 'CTX' });
    expect(() => renderer.render(c)).toThrow(/undefined/);
  });
});
