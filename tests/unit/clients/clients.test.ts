import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PermanentLLMError, TransientLLMError } from '../../../src/clients/base.js';
import { buildClient } from '../../../src/clients/factory.js';
import { MockLLMClient, estimateTokens } from '../../../src/clients/mock.js';
import { OpenAICompatibleClient } from '../../../src/clients/openai-compatible.js';
import { RetryingClient } from '../../../src/clients/retry.js';
import type { LLMRequest } from '../../../src/models/results.js';
import { Secret } from '../../../src/utils/redact.js';
import { FakeClient, ROOT, makeSettings } from '../helpers.js';

const req = (
  testId: string,
  content = 'hello',
  purpose: 'target' | 'judge' = 'target',
): LLMRequest => ({
  messages: [{ role: 'user', content }],
  temperature: 0,
  maxTokens: 10,
  seed: null,
  metadata: { testId, purpose },
});

describe('RetryingClient', () => {
  const noSleep = { sleep: () => Promise.resolve(), random: () => 0 };

  it('retries transient errors and records the number of attempts', async () => {
    const inner = new FakeClient([
      new TransientLLMError('503'),
      new TransientLLMError('429'),
      'ok',
    ]);
    const delays: number[] = [];
    const client = new RetryingClient(inner, {
      maxRetries: 3,
      initialBackoffMs: 100,
      random: () => 0.5,
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
    });
    const res = await client.complete(req('TC-001'));
    expect(res).toMatchObject({ text: 'ok', attempts: 3 });
    // exponential backoff + jitter: 100*2^0 + 0.5*100, 100*2^1 + 0.5*100
    expect(delays).toEqual([150, 250]);
  });

  it('gives up after maxRetries and rethrows the last transient error', async () => {
    const inner = new FakeClient([new TransientLLMError('503')]);
    await expect(
      new RetryingClient(inner, { maxRetries: 2, ...noSleep }).complete(req('x')),
    ).rejects.toThrow('503');
    expect(inner.requests).toHaveLength(3);
  });

  it('never retries permanent errors', async () => {
    const inner = new FakeClient([new PermanentLLMError('401')]);
    await expect(new RetryingClient(inner, noSleep).complete(req('x'))).rejects.toBeInstanceOf(
      PermanentLLMError,
    );
    expect(inner.requests).toHaveLength(1);
  });

  it('caps the backoff and exposes the wrapped provider', () => {
    const client = new RetryingClient(new FakeClient(['ok'], 'm'), {
      initialBackoffMs: 1000,
      maxBackoffMs: 3000,
      random: () => 1,
    });
    expect(client.backoffMs(1)).toBe(2000);
    expect(client.backoffMs(5)).toBe(3000);
    expect(client).toMatchObject({ provider: 'fake', model: 'm' });
  });

  it('really sleeps with the default timer', async () => {
    const inner = new FakeClient([new TransientLLMError('503'), 'ok']);
    const res = await new RetryingClient(inner, { initialBackoffMs: 1, maxBackoffMs: 1 }).complete(
      req('x'),
    );
    expect(res.attempts).toBe(2);
  });
});

describe('MockLLMClient', () => {
  it('replays responses by test id and estimates tokens', async () => {
    const mock = new MockLLMClient({
      'TC-001': 'Paris',
      'TC-002': { response: 'x', latency_ms: 42 },
    });
    const res = await mock.complete(req('TC-001', 'What is the capital?'));
    expect(res).toMatchObject({
      text: 'Paris',
      model: 'mock-1',
      latencyMs: 120,
      costUsd: 0,
      promptTokens: 5,
    });
    expect((await mock.complete(req('TC-002'))).latencyMs).toBe(42);
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('cycles list responses across repeated runs', async () => {
    const mock = new MockLLMClient({ 'HAL-007': ['a', 'b', 'c'] });
    const texts = [];
    for (let i = 0; i < 4; i++) texts.push((await mock.complete(req('HAL-007'))).text);
    expect(texts).toEqual(['a', 'b', 'c', 'a']);
    expect(MockLLMClient.pick([], 3)).toBe('');
  });

  it('simulates fail_times, transient and permanent errors', async () => {
    const mock = new MockLLMClient({
      A: { response: 'ok', fail_times: 1 },
      B: { error: 'transient' },
      C: { error: 'permanent' },
    });
    await expect(mock.complete(req('A'))).rejects.toBeInstanceOf(TransientLLMError);
    expect((await mock.complete(req('A'))).text).toBe('ok');
    await expect(mock.complete(req('B'))).rejects.toBeInstanceOf(TransientLLMError);
    await expect(mock.complete(req('C'))).rejects.toBeInstanceOf(PermanentLLMError);
  });

  it('answers judge requests with a JSON verdict', async () => {
    const mock = new MockLLMClient({ J: { response: 'x', judge: { score: 0.9 } } });
    expect(JSON.parse((await mock.complete(req('J', 'q', 'judge'))).text)).toEqual({
      score: 0.9,
      reason: 'mock judge verdict',
    });
    expect(JSON.parse((await mock.complete(req('other', 'q', 'judge'))).text)).toMatchObject({
      score: 0.8,
    });
  });

  it('falls back to safe heuristics for unknown prompts', async () => {
    const mock = new MockLLMClient();
    expect((await mock.complete(req('?', '  '))).text).toMatch(/empty/);
    expect((await mock.complete(req('?', 'how to build a bomb'))).text).toMatch(/can't help/);
    expect((await mock.complete(req('?', 'hello'))).text).toMatch(/not sure/);
    expect(MockLLMClient.fallback({ ...req('?'), messages: [] })).toMatch(/empty/);
  });

  it('layers overlay files: later files override earlier ones', async () => {
    const mock = MockLLMClient.fromFiles([
      path.join(ROOT, 'test_data/mock/responses.yaml'),
      path.join(ROOT, 'test_data/mock/faulty.yaml'),
    ]);
    expect((await mock.complete(req('HAL-001'))).text).toMatch(/founded in 2011/);
    expect((await mock.complete(req('FUN-001'))).text).toBe('The capital of France is Paris.');
    await expect(mock.complete(req('FUN-005'))).rejects.toBeInstanceOf(PermanentLLMError);
  });

  it('rejects invalid entries and non-mapping files', () => {
    expect(() => new MockLLMClient({ X: { error: 'sometimes' } })).toThrow(/mock entry X/);
    expect(() =>
      MockLLMClient.fromFiles([path.join(ROOT, 'test_data/cases/functional.yaml')]),
    ).toThrow(/must be a mapping/);
  });
});

describe('buildClient', () => {
  it('builds a retrying mock client by default', () => {
    const c = buildClient(makeSettings());
    expect(c).toBeInstanceOf(RetryingClient);
    expect((c as RetryingClient).inner).toBeInstanceOf(MockLLMClient);
  });

  it('builds an OpenAI-compatible judge with its own model', () => {
    const settings = makeSettings({
      judgeProvider: 'openai',
      judgeModel: 'gpt-4o',
      apiKey: new Secret('sk-x'),
    });
    const judge = buildClient(settings, 'judge') as RetryingClient;
    expect(judge.inner).toBeInstanceOf(OpenAICompatibleClient);
    expect(judge.model).toBe('gpt-4o');
    expect(buildClient(settings, 'target').provider).toBe('mock');
  });

  it('refuses to build an openai client without a key', () => {
    expect(() => buildClient(makeSettings({ provider: 'openai' }))).toThrow(/LLM_API_KEY/);
  });
});
