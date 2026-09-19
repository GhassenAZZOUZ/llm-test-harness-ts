/**
 * Deterministic mock provider (record/replay style).
 *
 * Responses are looked up by test-case id in one or more YAML files, so the whole suite
 * runs offline, for free, with the same verdict on every run. Later files override
 * earlier ones, which layers a "regressed model" scenario on top of the baseline
 * (see `test_data/mock/faulty.yaml`). Unknown prompts fall back to safe heuristics.
 */
import { z } from 'zod';
import type { LLMRequest, LLMResponse } from '../models/results.js';
import { readYaml } from '../utils/loader.js';
import { type LLMClient, PermanentLLMError, TransientLLMError } from './base.js';

const entrySchema = z.strictObject({
  response: z.union([z.string(), z.array(z.string())]).default(''),
  error: z.enum(['transient', 'permanent']).optional(),
  /** Raise a transient error N times before answering (exercises retries). */
  fail_times: z.int().min(0).default(0),
  latency_ms: z.number().min(0).default(120),
  judge: z
    .strictObject({
      score: z.number().min(0).max(1),
      reason: z.string().default('mock judge verdict'),
    })
    .optional(),
});
export type MockEntry = z.infer<typeof entrySchema>;

const UNSAFE =
  /\b(bomb|explosive|weapon|malware|ransomware|poison|steal|hack into|credit card numbers)\b/i;

/** ~4 characters per token is the usual rule of thumb for English. */
export function estimateTokens(text: string): number {
  return text ? Math.max(1, Math.ceil([...text].length / 4)) : 0;
}

export class MockLLMClient implements LLMClient {
  readonly provider = 'mock';
  readonly #entries: Map<string, MockEntry>;
  readonly #calls = new Map<string, number>();

  constructor(
    entries: Record<string, unknown> = {},
    readonly model = 'mock-1',
  ) {
    this.#entries = new Map(
      Object.entries(entries).map(([id, value]) => [id, MockLLMClient.parseEntry(id, value)]),
    );
  }

  static parseEntry(id: string, value: unknown): MockEntry {
    const data = typeof value === 'string' || Array.isArray(value) ? { response: value } : value;
    const parsed = entrySchema.safeParse(data);
    if (!parsed.success) {
      throw new Error(`mock entry ${id}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    }
    return parsed.data;
  }

  /** Layered overlays: later files override earlier ones, entry by entry. */
  static fromFiles(files: readonly string[], model = 'mock-1'): MockLLMClient {
    const merged: Record<string, unknown> = {};
    for (const file of files) {
      const raw = readYaml(file) ?? {};
      if (typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error(`${file}: mock responses must be a mapping of test id -> response`);
      }
      Object.assign(merged, raw);
    }
    return new MockLLMClient(merged, model);
  }

  complete(request: LLMRequest): Promise<LLMResponse> {
    // async contract, synchronous work: wrap so errors surface as rejections
    return Promise.resolve().then(() => this.#complete(request));
  }

  #complete(request: LLMRequest): LLMResponse {
    const testId = request.metadata.testId ?? '';
    const callNo = this.#calls.get(testId) ?? 0;
    this.#calls.set(testId, callNo + 1);
    const entry = this.#entries.get(testId);

    let text: string;
    if (request.metadata.purpose === 'judge') {
      text = JSON.stringify(entry?.judge ?? { score: 0.8, reason: 'mock judge verdict' });
    } else if (!entry) {
      text = MockLLMClient.fallback(request);
    } else {
      if (entry.error === 'permanent') {
        throw new PermanentLLMError(`mock permanent error for ${testId}`);
      }
      if (entry.error === 'transient' || callNo < entry.fail_times) {
        throw new TransientLLMError(`mock transient error for ${testId}`, 503);
      }
      text = MockLLMClient.pick(entry.response, callNo - entry.fail_times);
    }

    const promptText = request.messages.map((m) => m.content).join(' ');
    return {
      text,
      model: this.model,
      latencyMs: entry?.latency_ms ?? 100,
      promptTokens: estimateTokens(promptText),
      completionTokens: estimateTokens(text),
      costUsd: 0,
      attempts: 1,
      finishReason: 'stop',
    };
  }

  /** List responses cycle across repeated runs (simulates sampling variance). */
  static pick(response: string | string[], index: number): string {
    if (!Array.isArray(response)) return response;
    return response.length ? (response[index % response.length] ?? '') : '';
  }

  static fallback(request: LLMRequest): string {
    const user = request.messages.findLast((m) => m.role === 'user')?.content ?? '';
    if (!user.trim()) return 'Your message appears to be empty. What would you like to ask?';
    if (UNSAFE.test(user)) {
      return "I can't help with that request. I can share general safety information instead.";
    }
    return "I'm not sure I have enough information to answer that accurately.";
  }
}
