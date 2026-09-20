/** Builders and fakes shared by the unit tests. */
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LLMClient } from '../../src/clients/base.js';
import type { Settings } from '../../src/config/settings.js';
import type { EvalContext } from '../../src/evaluators/base.js';
import type {
  AttemptResult,
  EvaluationResult,
  LLMRequest,
  LLMResponse,
  TestResult,
} from '../../src/models/results.js';
import { type TestCase, parseTestCase } from '../../src/models/test-case.js';

export const ROOT = path.resolve(import.meta.dirname, '../..');

/** A valid case in YAML (snake_case) form, with overrides. */
export function rawCase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'TC-001',
    category: 'functional',
    title: 'A test case',
    prompt: 'What is the capital of France?',
    expected: { contains: ['Paris'] },
    ...overrides,
  };
}

export function makeCase(overrides: Record<string, unknown> = {}): TestCase {
  return parseTestCase(rawCase(overrides));
}

export function makeResponse(text: string, overrides: Partial<LLMResponse> = {}): LLMResponse {
  return {
    text,
    model: 'fake-1',
    latencyMs: 100,
    promptTokens: 10,
    completionTokens: 5,
    costUsd: 0.001,
    attempts: 1,
    finishReason: 'stop',
    ...overrides,
  };
}

export function ctx(text: string, c: TestCase = makeCase(), prompt = 'question'): EvalContext {
  return { case: c, prompt, response: makeResponse(text) };
}

export function evaluation(passed: boolean, overrides: Partial<EvaluationResult> = {}) {
  return {
    evaluator: 'contains',
    passed,
    score: passed ? 1 : 0,
    reason: passed ? 'ok' : 'nope',
    deterministic: true,
    details: {},
    ...overrides,
  } satisfies EvaluationResult;
}

export function attempt(passed: boolean, response = makeResponse('x')): AttemptResult {
  return { response, evaluations: [evaluation(passed)], error: null };
}

export function makeResult(overrides: Partial<TestResult> = {}): TestResult {
  return {
    caseId: 'TC-001',
    category: 'functional',
    title: 'A test case',
    severity: 'major',
    tags: [],
    prompt: 'question',
    deterministic: true,
    status: 'passed',
    attempts: [attempt(true)],
    durationMs: 12,
    failureReason: null,
    defect: null,
    ...overrides,
  };
}

/** Scripted client: returns (or throws) the next item on every call and records requests. */
export class FakeClient implements LLMClient {
  readonly provider = 'fake';
  readonly requests: LLMRequest[] = [];

  constructor(
    private readonly script: (string | Error)[],
    readonly model = 'fake-1',
  ) {}

  complete(request: LLMRequest): Promise<LLMResponse> {
    this.requests.push(request);
    const next = this.script[Math.min(this.requests.length - 1, this.script.length - 1)];
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(makeResponse(next ?? ''));
  }
}

export function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    provider: 'mock',
    model: 'mock-1',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: null,
    timeoutMs: 30_000,
    maxRetries: 3,
    judgeProvider: 'mock',
    judgeModel: 'mock-1',
    dataDir: path.join(ROOT, 'test_data'),
    reportsDir: path.join(ROOT, 'reports'),
    configDir: path.join(ROOT, 'config'),
    mockResponses: [path.join(ROOT, 'test_data/mock/responses.yaml')],
    softFail: false,
    gate: false,
    logLevel: 'silent',
    ...overrides,
  };
}

/** Fresh temp directory; with `copyProject`, a copy of test_data + config to mutate safely. */
export function tempDir(copyProject = false): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'llm-harness-'));
  if (copyProject) {
    cpSync(path.join(ROOT, 'test_data'), path.join(dir, 'test_data'), { recursive: true });
    cpSync(path.join(ROOT, 'config'), path.join(dir, 'config'), { recursive: true });
  }
  return dir;
}
