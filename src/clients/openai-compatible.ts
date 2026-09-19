/**
 * Client for any OpenAI-compatible `/chat/completions` endpoint: OpenAI, Azure OpenAI
 * (through a compatible gateway), Ollama, vLLM, LM Studio, LiteLLM, OpenRouter...
 *
 * Uses native `fetch` instead of a vendor SDK so the timeout (AbortController) and the
 * transient/permanent error classification are explicit and unit-testable with an
 * injected fetch. Retries are the job of `RetryingClient`.
 */
import { Pricing } from '../config/files.js';
import type { LLMRequest, LLMResponse } from '../models/results.js';
import { redact } from '../utils/redact.js';
import type { Secret } from '../utils/redact.js';
import { type LLMClient, PermanentLLMError, TransientLLMError } from './base.js';

/** 4xx codes worth retrying; every 5xx is retried too. */
export const RETRYABLE_4XX: ReadonlySet<number> = new Set([408, 409, 429]);

export function isRetryableStatus(status: number): boolean {
  return status >= 500 || RETRYABLE_4XX.has(status);
}

export interface OpenAICompatibleOptions {
  model: string;
  apiKey: Secret;
  baseUrl?: string;
  timeoutMs?: number;
  pricing?: Pricing;
  fetchImpl?: typeof fetch;
}

interface ChatCompletion {
  model?: string;
  choices?: { message?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class OpenAICompatibleClient implements LLMClient {
  readonly provider = 'openai';
  readonly model: string;
  readonly #apiKey: Secret;
  readonly #endpoint: string;
  readonly #timeoutMs: number;
  readonly #pricing: Pricing;
  readonly #fetch: typeof fetch;

  constructor(opts: OpenAICompatibleOptions) {
    this.model = opts.model;
    this.#apiKey = opts.apiKey;
    this.#endpoint = `${(opts.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '')}/chat/completions`;
    this.#timeoutMs = opts.timeoutMs ?? 30_000;
    this.#pricing = opts.pricing ?? new Pricing();
    this.#fetch = opts.fetchImpl ?? fetch;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const started = performance.now();
    const data = await this.#post(this.#payload(request));
    return this.#parse(data, performance.now() - started);
  }

  #payload(request: LLMRequest): Record<string, unknown> {
    return {
      model: this.model,
      messages: request.messages,
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      ...(request.seed !== null && { seed: request.seed }),
    };
  }

  async #post(payload: Record<string, unknown>): Promise<ChatCompletion> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let response: Response;
    let body: string;
    try {
      response = await this.#fetch(this.#endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.#apiKey.reveal()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      body = await response.text();
    } catch (err) {
      if (controller.signal.aborted) {
        throw new TransientLLMError(`timeout after ${this.#timeoutMs} ms`);
      }
      // DNS failure, connection reset, socket hang up...
      throw new TransientLLMError(`network error: ${this.#safe((err as Error).message)}`);
    } finally {
      clearTimeout(timer);
    }

    const snippet = this.#safe(body.slice(0, 200));
    if (isRetryableStatus(response.status)) {
      throw new TransientLLMError(`HTTP ${response.status}: ${snippet}`, response.status);
    }
    if (response.status >= 400) {
      // 400/401/403/404/422...: retrying would only burn quota
      throw new PermanentLLMError(`HTTP ${response.status}: ${snippet}`, response.status);
    }
    try {
      return JSON.parse(body) as ChatCompletion;
    } catch {
      throw new PermanentLLMError(`provider returned a non-JSON body: ${snippet}`);
    }
  }

  #parse(data: ChatCompletion, latencyMs: number): LLMResponse {
    const choice = Array.isArray(data.choices) ? data.choices[0] : undefined;
    if (!choice?.message || typeof choice.message !== 'object') {
      throw new PermanentLLMError(
        `unexpected response shape: ${this.#safe(JSON.stringify(data).slice(0, 200))}`,
      );
    }
    const promptTokens = data.usage?.prompt_tokens ?? null;
    const completionTokens = data.usage?.completion_tokens ?? null;
    return {
      text: choice.message.content ?? '',
      model: data.model ?? this.model,
      latencyMs: Math.round(latencyMs * 10) / 10,
      promptTokens,
      completionTokens,
      costUsd: this.#pricing.cost(this.model, promptTokens, completionTokens),
      attempts: 1,
      finishReason: choice.finish_reason ?? null,
    };
  }

  /** Error messages end up in reports: never let the key through. */
  #safe(text: string): string {
    return redact(text, [this.#apiKey.reveal()]);
  }
}
