import { describe, expect, it } from 'vitest';
import { PermanentLLMError, TransientLLMError } from '../../../src/clients/base.js';
import {
  OpenAICompatibleClient,
  isRetryableStatus,
} from '../../../src/clients/openai-compatible.js';
import { Pricing } from '../../../src/config/files.js';
import type { LLMRequest } from '../../../src/models/results.js';
import { Secret } from '../../../src/utils/redact.js';

const KEY = 'sk-test-0123456789abcdef';

const request: LLMRequest = {
  messages: [{ role: 'user', content: 'Hi' }],
  temperature: 0,
  maxTokens: 50,
  seed: 42,
  metadata: { testId: 'TC-001' },
};

const completion = {
  model: 'gpt-4o-mini-2024',
  choices: [{ message: { content: 'Hello!' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1000, completion_tokens: 500 },
};

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    const call = { url, init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { impl, calls };
}

const json = (status: number, body: unknown) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

function client(fetchImpl: typeof fetch, timeoutMs = 1000) {
  return new OpenAICompatibleClient({
    model: 'gpt-4o-mini',
    apiKey: new Secret(KEY),
    baseUrl: 'http://llm.local/v1/',
    timeoutMs,
    pricing: new Pricing({ 'gpt-4o-mini': { input_per_1k: 0.00015, output_per_1k: 0.0006 } }),
    fetchImpl,
  });
}

describe('OpenAICompatibleClient', () => {
  it('posts a chat completion and normalises the response (tokens, cost, model)', async () => {
    const { impl, calls } = fakeFetch(() => json(200, completion));
    const res = await client(impl).complete(request);

    expect(calls[0]?.url).toBe('http://llm.local/v1/chat/completions');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Hi' }],
      temperature: 0,
      max_tokens: 50,
      seed: 42,
    });
    expect(res).toMatchObject({
      text: 'Hello!',
      model: 'gpt-4o-mini-2024',
      promptTokens: 1000,
      completionTokens: 500,
      costUsd: 0.00045,
      attempts: 1,
      finishReason: 'stop',
    });
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('omits the seed when null and handles missing usage / content', async () => {
    const { impl, calls } = fakeFetch(() =>
      json(200, { choices: [{ message: { content: null } }] }),
    );
    const res = await client(impl).complete({ ...request, seed: null });
    expect(JSON.parse(calls[0]?.init.body as string)).not.toHaveProperty('seed');
    expect(res).toMatchObject({
      text: '',
      model: 'gpt-4o-mini',
      promptTokens: null,
      costUsd: null,
      finishReason: null,
    });
  });

  it.each([408, 409, 429, 500, 502, 503, 504, 529])('HTTP %i is transient', async (status) => {
    const { impl } = fakeFetch(() => json(status, 'busy'));
    const err = await client(impl)
      .complete(request)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientLLMError);
    expect(err).toMatchObject({ status, message: `HTTP ${status}: busy` });
  });

  it.each([400, 401, 403, 404, 422])('HTTP %i is permanent (never retried)', async (status) => {
    const { impl } = fakeFetch(() => json(status, { error: 'nope' }));
    await expect(client(impl).complete(request)).rejects.toBeInstanceOf(PermanentLLMError);
  });

  it('turns a hanging request into a transient timeout via AbortController', async () => {
    const { impl } = fakeFetch(
      ({ init }) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const err = await client(impl, 20)
      .complete(request)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientLLMError);
    expect((err as Error).message).toBe('timeout after 20 ms');
  });

  it('treats network failures as transient', async () => {
    const { impl } = fakeFetch(() => Promise.reject(new TypeError('fetch failed')));
    await expect(client(impl).complete(request)).rejects.toThrow(
      new TransientLLMError('network error: fetch failed'),
    );
  });

  it('treats a non-JSON body or an unexpected shape as permanent', async () => {
    const html = fakeFetch(() => json(200, '<html>gateway</html>'));
    await expect(client(html.impl).complete(request)).rejects.toThrow(/non-JSON body/);
    const shape = fakeFetch(() => json(200, { choices: [] }));
    await expect(client(shape.impl).complete(request)).rejects.toThrow(/unexpected response shape/);
  });

  it('never leaks the API key in error messages', async () => {
    const { impl } = fakeFetch(() => json(401, `invalid key ${KEY}`));
    const err = (await client(impl)
      .complete(request)
      .catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain(KEY);
    expect(err.message).toContain('***REDACTED***');
  });

  it('classifies statuses', () => {
    expect([408, 409, 429, 500, 599].every(isRetryableStatus)).toBe(true);
    expect([400, 401, 404, 422].some(isRetryableStatus)).toBe(false);
  });

  it('uses the real fetch and default options when none are injected', () => {
    const c = new OpenAICompatibleClient({ model: 'm', apiKey: new Secret(KEY) });
    expect(c).toMatchObject({ provider: 'openai', model: 'm' });
  });
});
