import { describe, expect, it } from 'vitest';
import { casesFor, categoryTag, tagsFor } from '../../../src/playwright/cases.js';
import { decideOutcome, evaluatorTable } from '../../../src/playwright/outcome.js';
import { evaluation, makeCase, makeResult } from '../helpers.js';

describe('decideOutcome (strict vs soft-fail policy)', () => {
  const c = makeCase();
  const regression = makeCase({ id: 'REG-001', category: 'regression', defect: 'GH-1' });
  const failed = makeResult({ status: 'failed', failureReason: 'contains: Missing' });

  it('passes and skips', () => {
    expect(decideOutcome(makeResult(), c, false)).toEqual({ kind: 'pass' });
    expect(
      decideOutcome(makeResult({ status: 'skipped', failureReason: 'skipped: x' }), c, true),
    ).toEqual({
      kind: 'skip',
      reason: 'skipped: x',
    });
  });

  it('strict mode fails on failures and errors', () => {
    expect(decideOutcome(failed, c, false)).toEqual({
      kind: 'fail',
      message: '[FAILED] TC-001: contains: Missing',
    });
    expect(decideOutcome(makeResult({ status: 'error' }), c, false).kind).toBe('fail');
  });

  it('soft-fail mode turns failures into expected failures', () => {
    expect(decideOutcome(failed, c, true)).toMatchObject({ kind: 'soft-fail' });
  });

  it('regression cases always fail hard, even in soft-fail mode', () => {
    expect(decideOutcome(failed, regression, true)).toMatchObject({ kind: 'fail' });
  });
});

describe('evaluatorTable', () => {
  it('lists every evaluator with verdict, score and type', () => {
    const r = makeResult({
      attempts: [
        {
          response: null,
          error: null,
          evaluations: [
            evaluation(true),
            evaluation(false, { evaluator: 'refusal', deterministic: false, reason: 'complied' }),
          ],
        },
      ],
    });
    const table = evaluatorTable(r);
    expect(table).toContain('PASS  contains');
    expect(table).toMatch(/FAIL {2}refusal +0\.00 {2}prob\. {2}complied/);
  });

  it('falls back to the failure reason when nothing was evaluated', () => {
    expect(evaluatorTable(makeResult({ attempts: [], failureReason: 'setup error: x' }))).toBe(
      'setup error: x',
    );
    expect(evaluatorTable(makeResult({ attempts: [] }))).toBe('no evaluation');
  });
});

describe('Playwright case collection', () => {
  it('loads the cases of one category from YAML', () => {
    const cases = casesFor('regression');
    expect(cases.map((x) => x.id)).toEqual(['REG-001', 'REG-002', 'REG-003', 'REG-004']);
  });

  it('exposes YAML tags, severity and category as Playwright tags', () => {
    expect(tagsFor(makeCase({ tags: ['smoke', 'factual'], severity: 'critical' }))).toEqual([
      '@smoke',
      '@factual',
      '@critical',
    ]);
    expect(categoryTag('edge_case')).toBe('@edge_case');
  });
});
