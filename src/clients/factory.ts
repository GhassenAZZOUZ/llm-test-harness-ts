/** Build clients from settings: the single place to register new providers. */
import path from 'node:path';
import { Pricing } from '../config/files.js';
import type { Settings } from '../config/settings.js';
import type { LLMClient } from './base.js';
import { MockLLMClient } from './mock.js';
import { OpenAICompatibleClient } from './openai-compatible.js';
import { RetryingClient } from './retry.js';

export type ClientRole = 'target' | 'judge';

/** Create the provider client for `role`, wrapped with retries. */
export function buildClient(settings: Settings, role: ClientRole = 'target'): LLMClient {
  const provider = role === 'target' ? settings.provider : settings.judgeProvider;
  const model = role === 'target' ? settings.model : settings.judgeModel;

  switch (provider) {
    case 'mock':
      // no real network: no need to wait between retries
      return new RetryingClient(MockLLMClient.fromFiles(settings.mockResponses, model), {
        maxRetries: settings.maxRetries,
        initialBackoffMs: 0,
        maxBackoffMs: 0,
      });
    case 'openai': {
      if (!settings.apiKey) throw new Error('LLM_API_KEY is required for the openai provider');
      const inner = new OpenAICompatibleClient({
        model,
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
        timeoutMs: settings.timeoutMs,
        pricing: Pricing.load(path.join(settings.configDir, 'pricing.yaml')),
      });
      return new RetryingClient(inner, { maxRetries: settings.maxRetries });
    }
  }
}
