/**
 * Provider abstraction.
 *
 * Every provider implements `LLMClient`. The runner and the LLM judge depend only on
 * this interface, so adding Anthropic, Azure, Bedrock or a local model means one new
 * class plus one line in `factory.ts`.
 */
import type { LLMRequest, LLMResponse } from '../models/results.js';

export class LLMClientError extends Error {
  override name = 'LLMClientError';

  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Retryable failure: timeout, connection reset, 408/409/429, 5xx. */
export class TransientLLMError extends LLMClientError {
  override name = 'TransientLLMError';
}

/** Non-retryable failure: bad request, auth error, malformed payload. */
export class PermanentLLMError extends LLMClientError {
  override name = 'PermanentLLMError';
}

export interface LLMClient {
  readonly provider: string;
  readonly model: string;
  /** Send a chat completion request and return a normalised response. */
  complete(request: LLMRequest): Promise<LLMResponse>;
}
