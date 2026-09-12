/**
 * Result types shared by clients, evaluators, runner and reporters.
 *
 * They are plain, JSON-serialisable data (no classes): a TestResult produced in a
 * Playwright worker is attached to the test and re-read by the reporter in the main
 * process, so it must survive JSON.stringify / JSON.parse unchanged.
 */
import type { Category, Severity } from './test-case.js';

export type Role = 'system' | 'user' | 'assistant';

export interface Message {
  role: Role;
  content: string;
}

export interface LLMRequest {
  messages: Message[];
  temperature: number;
  maxTokens: number;
  seed: number | null;
  /** Not sent to the provider (test id, purpose...). */
  metadata: { testId?: string; purpose?: 'target' | 'judge' };
}

export interface LLMResponse {
  text: string;
  model: string;
  latencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  costUsd: number | null;
  /** Number of provider calls, including retries. */
  attempts: number;
  finishReason: string | null;
}

/** Uniform output of every evaluator. */
export interface EvaluationResult {
  evaluator: string;
  passed: boolean;
  score: number;
  reason: string;
  deterministic: boolean;
  details: Record<string, unknown>;
}

export const STATUSES = ['passed', 'failed', 'error', 'skipped'] as const;
/** `error` = infrastructure / provider failure, not a model defect. */
export type Status = (typeof STATUSES)[number];

export interface AttemptResult {
  response: LLMResponse | null;
  evaluations: EvaluationResult[];
  error: string | null;
}

export interface TestResult {
  caseId: string;
  category: Category;
  title: string;
  severity: Severity;
  tags: string[];
  prompt: string;
  deterministic: boolean;
  status: Status;
  attempts: AttemptResult[];
  durationMs: number;
  failureReason: string | null;
  defect: string | null;
}

export function attemptPassed(a: AttemptResult): boolean {
  return a.error === null && a.evaluations.every((e) => e.passed);
}

export function attemptScore(a: AttemptResult): number {
  if (a.evaluations.length === 0) return 0;
  return a.evaluations.reduce((sum, e) => sum + e.score, 0) / a.evaluations.length;
}

export function lastAttempt(r: TestResult): AttemptResult | undefined {
  return r.attempts.at(-1);
}

export function responseText(r: TestResult): string {
  return lastAttempt(r)?.response?.text ?? '';
}

/** Mean score over attempts that reached the model. */
export function resultScore(r: TestResult): number {
  const scored = r.attempts.filter((a) => a.error === null).map(attemptScore);
  return scored.length ? scored.reduce((s, x) => s + x, 0) / scored.length : 0;
}

export function passRatio(r: TestResult): number {
  if (r.attempts.length === 0) return 0;
  return r.attempts.filter(attemptPassed).length / r.attempts.length;
}

export interface RunMetadata {
  runId: string;
  startedAt: string;
  finishedAt: string | null;
  provider: string;
  model: string;
  judgeModel: string | null;
  harnessVersion: string;
  gitSha: string | null;
  environment: Record<string, string>;
}
