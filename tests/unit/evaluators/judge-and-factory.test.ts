import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PermanentLLMError } from '../../../src/clients/base.js';
import { EvaluatorFactory } from '../../../src/evaluators/factory.js';
import { JUDGE_SYSTEM_PROMPT, LLMJudgeEvaluator } from '../../../src/evaluators/judge.js';
import { FakeClient, ROOT, ctx, makeCase } from '../helpers.js';

const RUBRIC = 'The answer is correct and concise.';

describe('LLMJudgeEvaluator', () => {
  it('passes above the threshold and sends a deterministic, strict-JSON request', async () => {
    const client = new FakeClient(['{"score": 0.9, "reason": "Good."}'], 'judge-1');
    const c = makeCase({ context: 'Some context' });
    const r = await new LLMJudgeEvaluator(client, RUBRIC, 0.7).evaluate(ctx('Paris', c));
    expect(r).toMatchObject({
      evaluator: 'llm_judge',
      passed: true,
      score: 0.9,
      deterministic: false,
    });
    expect(r.reason).toBe('Judge: Good. (score 0.90, threshold 0.70)');
    expect(r.details).toEqual({ judgeModel: 'judge-1' });

    const req = client.requests[0];
    expect(req).toMatchObject({ temperature: 0, seed: 42, metadata: { purpose: 'judge' } });
    expect(req?.messages[0]?.content).toBe(JUDGE_SYSTEM_PROMPT);
    expect(req?.messages[1]?.content).toContain('CONTEXT:\nSome context');
  });

  it('fails below the threshold and tolerates a fenced verdict', async () => {
    const client = new FakeClient(['```json\n{"score": 0.3}\n```']);
    const r = await new LLMJudgeEvaluator(client, RUBRIC).evaluate(ctx('meh'));
    expect(r).toMatchObject({ passed: false, score: 0.3 });
    expect(r.reason).toContain('no reason given');
  });

  it.each([
    ['not JSON', 'I think it is fine'],
    ['no score', '{"reason": "fine"}'],
    ['non-numeric score', '{"score": "high"}'],
  ])('fails closed when the verdict is %s', async (_label, raw) => {
    const r = await new LLMJudgeEvaluator(new FakeClient([raw]), RUBRIC).evaluate(ctx('x'));
    expect(r).toMatchObject({
      passed: false,
      score: 0,
      reason: 'Judge output was not valid JSON with a score',
    });
  });

  it('fails closed when the judge call errors', async () => {
    const client = new FakeClient([new PermanentLLMError('HTTP 401')]);
    const r = await new LLMJudgeEvaluator(client, RUBRIC).evaluate(ctx('x'));
    expect(r).toMatchObject({ passed: false, reason: 'Judge call failed: HTTP 401' });
  });
});

describe('EvaluatorFactory', () => {
  const factory = new EvaluatorFactory({
    schemasDir: path.join(ROOT, 'test_data/schemas'),
    judgeClient: new FakeClient(['{"score": 1}']),
  });

  it('builds evaluators in a fixed order: deterministic, heuristic, judge', () => {
    const c = makeCase({
      context: 'ctx',
      expected: {
        judge: { rubric: RUBRIC },
        should_refuse: false,
        should_acknowledge_uncertainty: true,
        grounded: true,
        relevant_to: 'ref',
        length: { max_words: 5 },
        json_schema: 'person.schema.json',
        not_regex: 'b',
        regex: 'a',
        not_contains: ['x'],
        contains_any: ['y'],
        contains: ['z'],
        exact: 'e',
      },
    });
    expect(factory.build(c).map((e) => e.name)).toEqual([
      'exact_match',
      'contains',
      'contains_any',
      'not_contains',
      'regex',
      'not_regex',
      'json_schema',
      'length',
      'semantic_relevance',
      'groundedness',
      'acknowledges_uncertainty',
      'refusal',
      'llm_judge',
    ]);
  });

  it('accepts an inline JSON Schema', () => {
    const c = makeCase({ expected: { json_schema: { type: 'object' } } });
    expect(factory.build(c).map((e) => e.name)).toEqual(['json_schema']);
  });

  it('errors on a judge expectation without judge client, or a missing schema file', () => {
    const noJudge = new EvaluatorFactory({ schemasDir: '.' });
    expect(() => noJudge.build(makeCase({ expected: { judge: { rubric: RUBRIC } } }))).toThrow(
      /no judge client/,
    );
    expect(() => factory.build(makeCase({ expected: { json_schema: 'missing.json' } }))).toThrow(
      /ENOENT/,
    );
  });
});
