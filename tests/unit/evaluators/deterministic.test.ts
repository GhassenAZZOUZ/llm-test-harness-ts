import { describe, expect, it } from 'vitest';
import {
  ContainsEvaluator,
  ExactMatchEvaluator,
  JsonSchemaEvaluator,
  LengthEvaluator,
  NotContainsEvaluator,
  RegexEvaluator,
} from '../../../src/evaluators/deterministic.js';
import { ctx } from '../helpers.js';

describe('ExactMatchEvaluator', () => {
  it('tolerates whitespace, case and a trailing period', () => {
    const r = new ExactMatchEvaluator('144').evaluate(ctx('  144. '));
    expect(r).toMatchObject({
      evaluator: 'exact_match',
      passed: true,
      score: 1,
      deterministic: true,
    });
    expect(new ExactMatchEvaluator('ok').evaluate(ctx('OK')).passed).toBe(true);
  });

  it('fails with the expected and actual values, and honours case sensitivity', () => {
    const r = new ExactMatchEvaluator('[WORLD HELLO]', true).evaluate(ctx('[world hello]'));
    expect(r.passed).toBe(false);
    expect(r.reason).toBe("Expected '[WORLD HELLO]', got '[world hello]'");
  });
});

describe('ContainsEvaluator', () => {
  it('mode all: passes when every keyword is present', () => {
    const r = new ContainsEvaluator(['Paris', 'France']).evaluate(ctx('paris is in FRANCE'));
    expect(r).toMatchObject({ evaluator: 'contains', passed: true, score: 1 });
  });

  it('mode all: partial score and missing keywords on failure', () => {
    const r = new ContainsEvaluator(['Paris', 'Berlin']).evaluate(ctx('Paris only'));
    expect(r).toMatchObject({ passed: false, score: 0.5, reason: 'Missing keywords: ["Berlin"]' });
  });

  it('mode any', () => {
    const ev = new ContainsEvaluator(['4', 'four'], 'any');
    expect(ev.name).toBe('contains_any');
    expect(ev.evaluate(ctx('the answer is four'))).toMatchObject({
      passed: true,
      reason: "Found 'four'",
    });
    expect(ev.evaluate(ctx('five'))).toMatchObject({ passed: false, score: 0 });
  });

  it('is case sensitive on demand and rejects an empty keyword list', () => {
    expect(new ContainsEvaluator(['Paris'], 'all', true).evaluate(ctx('paris')).passed).toBe(false);
    expect(() => new ContainsEvaluator([])).toThrow(/at least one keyword/);
  });
});

describe('NotContainsEvaluator', () => {
  it('passes without forbidden content', () => {
    expect(new NotContainsEvaluator(['PWNED']).evaluate(ctx('fine')).passed).toBe(true);
  });

  it('fails and scores the share of hits', () => {
    const r = new NotContainsEvaluator(['best', 'coffee']).evaluate(ctx('The BEST beans'));
    expect(r).toMatchObject({ passed: false, score: 0.5, details: { hits: ['best'] } });
  });
});

describe('RegexEvaluator', () => {
  it('regex must match', () => {
    const ev = new RegexEvaluator('^\\s*negative\\.?\\s*$');
    expect(ev.evaluate(ctx('Negative.'))).toMatchObject({ evaluator: 'regex', passed: true });
    expect(ev.evaluate(ctx('It is negative overall')).passed).toBe(false);
  });

  it('not_regex must not match (Python syntax translated)', () => {
    const ev = new RegexEvaluator('\\A\\s*\\{', false);
    expect(ev.name).toBe('not_regex');
    expect(ev.evaluate(ctx('Sure: {"a":1}')).passed).toBe(true);
    const r = ev.evaluate(ctx('{"a":1}'));
    expect(r).toMatchObject({ passed: false, reason: 'Response matches /\\A\\s*\\{/' });
    expect(r.details).toEqual({ match: '{' });
  });
});

describe('JsonSchemaEvaluator', () => {
  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    required: ['priority'],
    additionalProperties: false,
    properties: { priority: { enum: ['low', 'high'] } },
  };

  it('passes on valid JSON, even inside a ```json fence', () => {
    const ev = new JsonSchemaEvaluator(schema);
    expect(ev.evaluate(ctx('{"priority": "low"}')).passed).toBe(true);
    expect(ev.evaluate(ctx('```json\n{"priority": "high"}\n```')).passed).toBe(true);
  });

  it('gives partial credit on schema violations', () => {
    const r = new JsonSchemaEvaluator(schema).evaluate(ctx('{"priority": "urgent", "x": 1}'));
    expect(r.passed).toBe(false);
    expect(r.score).toBe(0.5);
    expect(r.reason).toMatch(/Schema violations/);
    expect((r.details.errors as string[]).length).toBeGreaterThan(0);
  });

  it('scores 0 on non-JSON output and throws on an invalid schema', () => {
    expect(new JsonSchemaEvaluator(schema).evaluate(ctx('not json'))).toMatchObject({
      passed: false,
      score: 0,
      reason: 'Response is not valid JSON',
    });
    expect(() => new JsonSchemaEvaluator({ type: 'not-a-type' })).toThrow();
  });
});

describe('LengthEvaluator', () => {
  it('passes within limits', () => {
    const r = new LengthEvaluator({ maxWords: 3, minChars: 2 }).evaluate(ctx('one two'));
    expect(r).toMatchObject({ passed: true, reason: 'Length OK (7 chars, 2 words)' });
  });

  it('reports every violated bound', () => {
    const ev = new LengthEvaluator({ minChars: 50, maxChars: 3, minWords: 5, maxWords: 1 });
    expect(ev.evaluate(ctx('two words')).reason).toBe(
      '9 chars < min 50; 9 chars > max 3; 2 words < min 5; 2 words > max 1',
    );
  });
});
