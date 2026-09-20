import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Pricing, loadQualityGate } from '../../../src/config/files.js';
import { SettingsError, loadDotEnv, loadSettings } from '../../../src/config/settings.js';
import { ROOT, tempDir } from '../helpers.js';

describe('loadSettings', () => {
  it('defaults to the mock provider, so everything runs without a key', () => {
    const s = loadSettings({});
    expect(s).toMatchObject({
      provider: 'mock',
      model: 'mock-1',
      apiKey: null,
      timeoutMs: 30_000,
      maxRetries: 3,
      judgeProvider: 'mock',
      judgeModel: 'mock-1',
      mockResponses: ['test_data/mock/responses.yaml'],
      softFail: false,
      gate: false,
      logLevel: 'info',
    });
  });

  it('reads LLM_* variables, overlays and booleans; empty values count as unset', () => {
    const s = loadSettings({
      LLM_PROVIDER: 'openai',
      LLM_MODEL: 'gpt-4o-mini',
      LLM_API_KEY: 'sk-live-abcdefghijk',
      LLM_TIMEOUT_S: '2.5',
      LLM_JUDGE_MODEL: 'gpt-4o',
      LLM_MOCK_RESPONSES: 'a.yaml, b.yaml,',
      LLM_SOFT_FAIL: 'TRUE',
      LLM_GATE: '1',
      LLM_LOG_LEVEL: 'WARN',
      LLM_BASE_URL: '',
      OTHER: 'ignored',
    });
    expect(s).toMatchObject({
      provider: 'openai',
      timeoutMs: 2500,
      judgeProvider: 'openai',
      judgeModel: 'gpt-4o',
      baseUrl: 'https://api.openai.com/v1',
      mockResponses: ['a.yaml', 'b.yaml'],
      softFail: true,
      gate: true,
      logLevel: 'warn',
    });
    expect(s.apiKey?.reveal()).toBe('sk-live-abcdefghijk');
    expect(JSON.stringify(s)).not.toContain('sk-live');
  });

  it('requires a key for the openai provider (target or judge)', () => {
    expect(() => loadSettings({ LLM_PROVIDER: 'openai' })).toThrow(SettingsError);
    expect(() => loadSettings({ LLM_JUDGE_PROVIDER: 'openai' })).toThrow(/LLM_API_KEY is required/);
  });

  it('reports invalid values by name without echoing them', () => {
    const run = () =>
      loadSettings({ LLM_PROVIDER: 'sk-looks-like-a-secret-123', LLM_MAX_RETRIES: '99' });
    expect(run).toThrow(/LLM_PROVIDER/);
    expect(run).toThrow(/LLM_MAX_RETRIES/);
    expect(run).not.toThrow(/looks-like/);
  });

  it('loads a .env file without overriding existing variables', () => {
    const file = path.join(tempDir(), '.env');
    writeFileSync(file, 'LLM_TEST_DOTENV=from-file\nLLM_TEST_EXISTING=from-file\n');
    process.env.LLM_TEST_EXISTING = 'from-env';
    loadDotEnv(file);
    loadDotEnv(path.join(tempDir(), 'missing.env')); // no-op
    expect(process.env.LLM_TEST_DOTENV).toBe('from-file');
    expect(process.env.LLM_TEST_EXISTING).toBe('from-env');
    delete process.env.LLM_TEST_DOTENV;
    delete process.env.LLM_TEST_EXISTING;
  });
});

describe('Pricing', () => {
  it('computes cost from config/pricing.yaml', () => {
    const pricing = Pricing.load(path.join(ROOT, 'config/pricing.yaml'));
    expect(pricing.cost('gpt-4o-mini', 1000, 1000)).toBe(0.00075);
    expect(pricing.cost('unknown-model', 1, 1)).toBeNull();
    expect(pricing.cost('gpt-4o-mini', null, 1)).toBeNull();
  });

  it('is empty when the file is missing', () => {
    expect(Pricing.load('nope.yaml').models).toEqual({});
  });
});

describe('loadQualityGate', () => {
  it('reads thresholds from config/quality_gate.yaml', () => {
    expect(loadQualityGate(path.join(ROOT, 'config/quality_gate.yaml'))).toEqual({
      minPassRate: 0.9,
      maxRegressionFailures: 0,
      minHallucinationDetectionRate: 0.8,
      maxErrorRate: 0.05,
      maxP95LatencyMs: 15000,
      maxTotalCostUsd: 1,
    });
  });

  it('falls back to defaults and rejects unknown keys', () => {
    expect(loadQualityGate('missing.yaml')).toMatchObject({
      minPassRate: 0.9,
      maxP95LatencyMs: null,
    });
    const file = path.join(tempDir(), 'gate.yaml');
    writeFileSync(file, 'min_pass_rat: 0.5\n');
    expect(() => loadQualityGate(file)).toThrow();
  });
});
