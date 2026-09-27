import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PermanentLLMError, TransientLLMError } from '../../../src/clients/base.js';
import { EvaluatorFactory } from '../../../src/evaluators/factory.js';
import { Harness } from '../../../src/runner/harness.js';
import { TestRunner } from '../../../src/runner/runner.js';
import { PromptRenderer } from '../../../src/utils/loader.js';
import { FakeClient, ROOT, attempt, evaluation, makeCase, makeSettings } from '../helpers.js';

function runner(client: FakeClient): TestRunner {
  return new TestRunner(
    client,
    new EvaluatorFactory({ schemasDir: path.join(ROOT, 'test_data/schemas'), judgeClient: client }),
    new PromptRenderer(path.join(ROOT, 'test_data/prompts')),
  );
}

describe('TestRunner', () => {
  it('builds the request from the case (system prompt, generation params, metadata)', () => {
    const c = makeCase({
      system_prompt: 'Be brief',
      generation: { temperature: 0.7, max_tokens: 20 },
    });
    expect(runner(new FakeClient([])).buildRequest(c, 'Hi')).toEqual({
      messages: [
        { role: 'system', content: 'Be brief' },
        { role: 'user', content: 'Hi' },
      ],
      temperature: 0.7,
      maxTokens: 20,
      seed: 42,
      metadata: { testId: 'TC-001', purpose: 'target' },
    });
  });

  it('passes when every evaluator passes', async () => {
    const r = await runner(new FakeClient(['Paris is the capital.'])).run(makeCase());
    expect(r).toMatchObject({ status: 'passed', failureReason: null, deterministic: true });
    expect(r.attempts[0]?.evaluations[0]).toMatchObject({ evaluator: 'contains', passed: true });
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('fails with the reasons of the failing evaluators', async () => {
    const c = makeCase({ expected: { contains: ['Paris'], length: { max_words: 2 } } });
    const r = await runner(new FakeClient(['London is big and rainy'])).run(c);
    expect(r.status).toBe('failed');
    expect(r.failureReason).toBe('contains: Missing keywords: ["Paris"] | length: 5 words > max 2');
  });

  it('reports provider problems as ERROR, not FAILED', async () => {
    const r = await runner(new FakeClient([new PermanentLLMError('HTTP 401')])).run(makeCase());
    expect(r).toMatchObject({ status: 'error', failureReason: 'provider error: HTTP 401' });
  });

  it('uses the pass ratio over repeated runs', async () => {
    const c = makeCase({ runs: 3, min_pass_ratio: 0.66 });
    const ok = await runner(new FakeClient(['Paris', 'Rome', 'Paris'])).run(c);
    expect(ok.status).toBe('passed');
    expect(ok.attempts).toHaveLength(3);

    const ko = await runner(new FakeClient(['Rome', 'Rome', 'Paris'])).run(c);
    expect(ko.status).toBe('failed');
    expect(ko.failureReason).toMatch(/^passed 33% of 3 runs \(< 66%\)\. contains: Missing/);
  });

  it('a partial provider outage counts against the pass ratio', async () => {
    const c = makeCase({ runs: 2, min_pass_ratio: 1 });
    const r = await runner(new FakeClient(['Paris', new TransientLLMError('503')])).run(c);
    expect(r.status).toBe('failed');
    expect(r.failureReason).toContain('provider error: 503');
  });

  it('skips without calling the model', async () => {
    const client = new FakeClient(['x']);
    const r = await runner(client).run(makeCase({ skip: 'flaky upstream' }));
    expect(r).toMatchObject({ status: 'skipped', failureReason: 'skipped: flaky upstream' });
    expect(client.requests).toHaveLength(0);
  });

  it('reports setup errors (missing template variable) as ERROR without crashing', async () => {
    const c = makeCase({ prompt: undefined, template: 'rag_qa.njk', context: 'x' });
    const r = await runner(new FakeClient(['x'])).run(c);
    expect(r.status).toBe('error');
    expect(r.failureReason).toMatch(/^setup error: .*undefined/s);
  });

  it('propagates unexpected (programming) errors', async () => {
    await expect(runner(new FakeClient([new TypeError('bug')])).run(makeCase())).rejects.toThrow(
      'bug',
    );
  });

  it('verdict helper covers every branch', () => {
    const c = makeCase();
    expect(TestRunner.verdict(c, [attempt(true)])).toEqual(['passed', null]);
    expect(TestRunner.verdict(c, [{ response: null, evaluations: [], error: 'down' }])).toEqual([
      'error',
      'provider error: down',
    ]);
    const failed = { ...attempt(false), evaluations: [evaluation(false, { reason: 'bad' })] };
    expect(TestRunner.verdict(c, [failed])).toEqual(['failed', 'contains: bad']);
  });
});

describe('Harness (composition root)', () => {
  it('wires the mock provider from settings and runs a real case', async () => {
    const harness = Harness.create(makeSettings());
    const [fun001] = harness.loadCases({ tags: ['factual'] });
    expect(harness.casesDir).toMatch(/cases$/);
    expect(fun001?.id).toBe('FUN-001');
    expect((await harness.run(fun001!)).status).toBe('passed');
  });

  it('accepts injected clients and embedder', async () => {
    const client = new FakeClient(['Paris']);
    const harness = Harness.create(makeSettings(), {
      client,
      judgeClient: client,
      embedder: { similarity: () => 1 },
    });
    const r = await harness.run(makeCase({ expected: { relevant_to: 'anything' } }));
    expect(r.status).toBe('passed');
  });
});
