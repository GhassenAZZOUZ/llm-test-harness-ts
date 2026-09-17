/**
 * Runtime configuration from environment variables (prefix `LLM_`), validated with Zod.
 * A local `.env` file is loaded when present. The API key is wrapped in `Secret`, so it
 * never ends up in logs, reports or error messages.
 */
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { LOG_LEVELS } from '../utils/logger.js';
import { Secret } from '../utils/redact.js';

export const PROVIDERS = ['mock', 'openai'] as const;
export type ProviderName = (typeof PROVIDERS)[number];

const bool = z
  .string()
  .trim()
  .toLowerCase()
  .transform((v) => ['1', 'true', 'yes', 'on'].includes(v));

const envSchema = z
  .object({
    LLM_PROVIDER: z.enum(PROVIDERS).default('mock'),
    LLM_MODEL: z.string().min(1).default('mock-1'),
    LLM_BASE_URL: z.url().default('https://api.openai.com/v1'),
    LLM_API_KEY: z.string().min(1).optional(),
    LLM_TIMEOUT_S: z.coerce.number().positive().default(30),
    LLM_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(3),
    LLM_JUDGE_PROVIDER: z.enum(PROVIDERS).optional(),
    LLM_JUDGE_MODEL: z.string().min(1).optional(),
    LLM_DATA_DIR: z.string().default('test_data'),
    LLM_REPORTS_DIR: z.string().default('reports'),
    LLM_CONFIG_DIR: z.string().default('config'),
    LLM_MOCK_RESPONSES: z.string().default('test_data/mock/responses.yaml'),
    LLM_SOFT_FAIL: bool.default(false),
    LLM_GATE: bool.default(false),
    LLM_LOG_LEVEL: z.string().toLowerCase().pipe(z.enum(LOG_LEVELS)).default('info'),
  })
  .refine(
    (env) =>
      !(env.LLM_PROVIDER === 'openai' || env.LLM_JUDGE_PROVIDER === 'openai') ||
      env.LLM_API_KEY !== undefined,
    { message: 'LLM_API_KEY is required when LLM_PROVIDER/LLM_JUDGE_PROVIDER=openai' },
  );

export interface Settings {
  provider: ProviderName;
  model: string;
  baseUrl: string;
  apiKey: Secret | null;
  timeoutMs: number;
  maxRetries: number;
  judgeProvider: ProviderName;
  judgeModel: string;
  dataDir: string;
  reportsDir: string;
  configDir: string;
  mockResponses: string[];
  /** Record probabilistic failures as expected failures and let the quality gate decide. */
  softFail: boolean;
  /** Fail the Playwright run (exit code) when the quality gate fails. */
  gate: boolean;
  logLevel: (typeof LOG_LEVELS)[number];
}

export class SettingsError extends Error {
  override name = 'SettingsError';
}

/** Build settings from an env map (defaults to process.env). Empty strings count as unset. */
export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  const cleaned = Object.fromEntries(
    Object.entries(env).filter(([k, v]) => k.startsWith('LLM_') && v !== undefined && v !== ''),
  );
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    // report variable names and messages only: never echo values (the key could be one)
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || 'config'}: ${i.message}`)
      .join('; ');
    throw new SettingsError(`invalid configuration: ${detail}`);
  }
  const e = parsed.data;
  return {
    provider: e.LLM_PROVIDER,
    model: e.LLM_MODEL,
    baseUrl: e.LLM_BASE_URL,
    apiKey: e.LLM_API_KEY ? new Secret(e.LLM_API_KEY) : null,
    timeoutMs: e.LLM_TIMEOUT_S * 1000,
    maxRetries: e.LLM_MAX_RETRIES,
    judgeProvider: e.LLM_JUDGE_PROVIDER ?? e.LLM_PROVIDER,
    judgeModel: e.LLM_JUDGE_MODEL ?? e.LLM_MODEL,
    dataDir: e.LLM_DATA_DIR,
    reportsDir: e.LLM_REPORTS_DIR,
    configDir: e.LLM_CONFIG_DIR,
    mockResponses: e.LLM_MOCK_RESPONSES.split(',')
      .map((p) => p.trim())
      .filter(Boolean),
    softFail: e.LLM_SOFT_FAIL,
    gate: e.LLM_GATE,
    logLevel: e.LLM_LOG_LEVEL,
  };
}

/** Load `.env` into process.env once (existing variables win). */
export function loadDotEnv(file = '.env'): void {
  if (existsSync(file)) process.loadEnvFile(file);
}
