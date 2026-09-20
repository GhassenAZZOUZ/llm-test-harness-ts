import { describe, expect, it } from 'vitest';
import { isDeterministic, parseTestCase } from '../../../src/models/test-case.js';
import { makeCase, rawCase } from '../helpers.js';

const errorOf = (input: unknown) => {
  try {
    parseTestCase(input);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('expected a validation error');
};

describe('test case schema', () => {
  it('parses a minimal case and applies defaults (snake_case -> camelCase)', () => {
    const c = makeCase();
    expect(c).toMatchObject({
      id: 'TC-001',
      severity: 'major',
      runs: 1,
      minPassRatio: 1,
      tags: [],
      generation: { temperature: 0, maxTokens: 512, seed: 42 },
      expected: { contains: ['Paris'], caseSensitive: false, relevanceThreshold: 0.3 },
    });
    expect(c).not.toHaveProperty('template');
  });

  it('maps every snake_case key', () => {
    const c = makeCase({
      system_prompt: 'sys',
      min_pass_ratio: 0.5,
      runs: 3,
      generation: { max_tokens: 20, seed: null },
      expected: {
        contains_any: ['a'],
        not_contains: ['b'],
        not_regex: 'x',
        length: { min_chars: 1, max_chars: 9, min_words: 1, max_words: 3 },
        relevant_to: 'ref',
        should_acknowledge_uncertainty: true,
        should_refuse: false,
        judge: { rubric: 'a rubric that is long enough' },
      },
    });
    expect(c.systemPrompt).toBe('sys');
    expect(c.minPassRatio).toBe(0.5);
    expect(c.generation).toEqual({ temperature: 0, maxTokens: 20, seed: null });
    expect(c.expected).toMatchObject({
      containsAny: ['a'],
      notContains: ['b'],
      notRegex: 'x',
      length: { minChars: 1, maxChars: 9, minWords: 1, maxWords: 3 },
      relevantTo: 'ref',
      shouldAcknowledgeUncertainty: true,
      shouldRefuse: false,
      judge: { threshold: 0.7 },
    });
  });

  it.each([
    ['bad id pattern', { id: 'tc-1' }, 'id must look like'],
    ['unknown category', { category: 'perf' }, 'category'],
    ['unknown top-level key (typo)', { promt: 'x' }, 'promt'],
    ['unknown expectation key', { expected: { contain: ['x'] } }, 'contain'],
    ['short title', { title: 'ab' }, 'title'],
    ['runs out of range', { runs: 11 }, 'runs'],
    ['min_pass_ratio of 0', { min_pass_ratio: 0 }, 'min_pass_ratio'],
    ['invalid regex', { expected: { regex: '(' } }, 'invalid regex'],
    [
      'min > max length',
      { expected: { length: { min_words: 5, max_words: 2 } } },
      'min_words must be <= max_words',
    ],
    [
      'min > max chars',
      { expected: { length: { min_chars: 5, max_chars: 2 } } },
      'min_chars must be <= max_chars',
    ],
    ['short judge rubric', { expected: { judge: { rubric: 'short' } } }, 'rubric'],
  ])('rejects %s', (_label, overrides, fragment) => {
    expect(errorOf(rawCase(overrides))).toContain(fragment);
  });

  it('requires prompt XOR template', () => {
    const none = rawCase();
    delete none.prompt;
    expect(errorOf(none)).toContain('either `prompt` or `template` is required');
    expect(errorOf(rawCase({ template: 'x.njk' }))).toContain('mutually exclusive');
  });

  it('accepts an empty prompt (edge case) but not an empty expectation block', () => {
    expect(makeCase({ prompt: '' }).prompt).toBe('');
    expect(errorOf(rawCase({ expected: {} }))).toContain('at least one assertion');
    expect(errorOf(rawCase({ expected: { case_sensitive: true } }))).toContain(
      'at least one assertion',
    );
  });

  it('grounded requires context; regression requires defect', () => {
    expect(errorOf(rawCase({ expected: { grounded: true } }))).toContain('requires a `context`');
    expect(errorOf(rawCase({ id: 'REG-001', category: 'regression' }))).toContain('`defect`');
    expect(makeCase({ category: 'regression', defect: 'GH-1' }).defect).toBe('GH-1');
  });

  it('flags cases that rely on heuristics or a judge as probabilistic', () => {
    expect(isDeterministic(makeCase())).toBe(true);
    expect(isDeterministic(makeCase({ expected: { should_refuse: false } }))).toBe(false);
    expect(isDeterministic(makeCase({ expected: { relevant_to: 'x' } }))).toBe(false);
    expect(isDeterministic(makeCase({ context: 'c', expected: { grounded: true } }))).toBe(false);
  });
});
