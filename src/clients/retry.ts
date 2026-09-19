/**
 * Retry decorator for any `LLMClient`.
 *
 * Keeping retries out of the provider clients gives every provider (the mock included)
 * identical, testable behaviour: only `TransientLLMError` is retried, with exponential
 * backoff + jitter; permanent errors fail fast.
 */
import type { LLMRequest, LLMResponse } from '../models/results.js';
import { createLogger } from '../utils/logger.js';
import { type LLMClient, TransientLLMError } from './base.js';

const log = createLogger('retry');

export interface RetryOptions {
  maxRetries?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class RetryingClient implements LLMClient {
  readonly provider: string;
  readonly model: string;
  readonly #maxRetries: number;
  readonly #initial: number;
  readonly #max: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #random: () => number;

  constructor(
    readonly inner: LLMClient,
    opts: RetryOptions = {},
  ) {
    this.provider = inner.provider;
    this.model = inner.model;
    this.#maxRetries = opts.maxRetries ?? 3;
    this.#initial = opts.initialBackoffMs ?? 500;
    this.#max = opts.maxBackoffMs ?? 20_000;
    this.#sleep = opts.sleep ?? defaultSleep;
    this.#random = opts.random ?? Math.random;
  }

  /** Exponential backoff capped at `maxBackoffMs`, plus up to `initialBackoffMs` of jitter. */
  backoffMs(retryNumber: number): number {
    const exponential = this.#initial * 2 ** (retryNumber - 1);
    return Math.min(this.#max, exponential + this.#random() * this.#initial);
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await this.inner.complete(request);
        return { ...response, attempts: attempt };
      } catch (err) {
        if (!(err instanceof TransientLLMError) || attempt > this.#maxRetries) throw err;
        const delay = this.backoffMs(attempt);
        log.warn(
          `transient LLM error (attempt ${attempt}/${this.#maxRetries + 1}) for ` +
            `${request.metadata.testId ?? '?'}: ${err.message}; retrying in ${Math.round(delay)} ms`,
        );
        await this.#sleep(delay);
      }
    }
  }
}
