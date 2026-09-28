/**
 * Run-level metrics.
 *
 * Each metric is a small function `(results) => partial metrics`. Register a new one
 * with `registerMetric()` and it automatically lands in the JSON/HTML/Markdown reports.
 */
import { type LLMResponse, type TestResult, resultScore } from '../models/results.js';
import { CATEGORIES } from '../models/test-case.js';

export interface LatencyStats {
  avg: number;
  p50: number;
  p95: number;
  max: number;
}

export interface CategoryStats {
  total: number;
  passed: number;
  passRate: number | null;
}

export interface Metrics {
  total: number;
  executed: number;
  passed: number;
  failed: number;
  errors: number;
  skipped: number;
  passRate: number | null;
  failureRate: number | null;
  errorRate: number | null;
  avgScore: number | null;
  latencyMs: LatencyStats | null;
  tokens: { prompt: number; completion: number; total: number } | null;
  costUsd: number | null;
  llmCalls: number;
  retries: number;
  /** Share of hallucination probes where the model correctly declined to invent facts. */
  hallucinationDetectionRate: number | null;
  regressionFailures: number;
  deterministicPassRate: number | null;
  probabilisticPassRate: number | null;
  byCategory: Record<string, CategoryStats>;
  /** Extension point: metrics added through registerMetric(). */
  [custom: string]: unknown;
}

export type MetricFn = (results: readonly TestResult[]) => Record<string, unknown>;
const registry: MetricFn[] = [];

export function registerMetric(fn: MetricFn): MetricFn {
  registry.push(fn);
  return fn;
}

const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;
const rate = (num: number, den: number) => (den ? round(num / den, 4) : null);
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

export function percentile(values: readonly number[], pct: number): number {
  const ordered = [...values].sort((a, b) => a - b);
  const k = (ordered.length - 1) * pct;
  const lo = Math.floor(k);
  const hi = Math.min(lo + 1, ordered.length - 1);
  const [a = 0, b = 0] = [ordered[lo], ordered[hi]];
  return round(a + (b - a) * (k - lo), 1);
}

const executed = (rs: readonly TestResult[]) => rs.filter((r) => r.status !== 'skipped');
const responses = (rs: readonly TestResult[]): LLMResponse[] =>
  rs.flatMap((r) => r.attempts.flatMap((a) => (a.response ? [a.response] : [])));
const passedCount = (rs: readonly TestResult[]) => rs.filter((r) => r.status === 'passed').length;

registerMetric(function outcomeMetrics(results) {
  const n = executed(results).length;
  const count = (s: TestResult['status']) => results.filter((r) => r.status === s).length;
  return {
    total: results.length,
    executed: n,
    passed: count('passed'),
    failed: count('failed'),
    errors: count('error'),
    skipped: count('skipped'),
    passRate: rate(count('passed'), n),
    failureRate: rate(count('failed'), n),
    errorRate: rate(count('error'), n),
  };
});

registerMetric(function scoreMetrics(results) {
  const scored = executed(results)
    .filter((r) => r.status !== 'error')
    .map(resultScore);
  return { avgScore: scored.length ? round(mean(scored), 4) : null };
});

registerMetric(function latencyMetrics(results) {
  const latencies = responses(results).map((r) => r.latencyMs);
  if (latencies.length === 0) return { latencyMs: null };
  return {
    latencyMs: {
      avg: round(mean(latencies), 1),
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      max: round(Math.max(...latencies), 1),
    },
  };
});

registerMetric(function usageMetrics(results) {
  const rs = responses(results);
  const prompt = rs.flatMap((r) => (r.promptTokens === null ? [] : [r.promptTokens]));
  const completion = rs.flatMap((r) => (r.completionTokens === null ? [] : [r.completionTokens]));
  const costs = rs.flatMap((r) => (r.costUsd === null ? [] : [r.costUsd]));
  return {
    tokens:
      prompt.length || completion.length
        ? { prompt: sum(prompt), completion: sum(completion), total: sum(prompt) + sum(completion) }
        : null,
    costUsd: costs.length ? round(sum(costs), 6) : null,
    llmCalls: rs.length,
    retries: sum(rs.map((r) => Math.max(r.attempts - 1, 0))),
  };
});

registerMetric(function qualityMetrics(results) {
  const ex = executed(results);
  const halluc = ex.filter((r) => r.category === 'hallucination');
  const regression = ex.filter((r) => r.category === 'regression');
  const det = ex.filter((r) => r.deterministic);
  const prob = ex.filter((r) => !r.deterministic);
  return {
    hallucinationDetectionRate: rate(passedCount(halluc), halluc.length),
    regressionFailures: regression.filter((r) => r.status !== 'passed').length,
    deterministicPassRate: rate(passedCount(det), det.length),
    probabilisticPassRate: rate(passedCount(prob), prob.length),
  };
});

registerMetric(function categoryBreakdown(results) {
  const byCategory: Record<string, CategoryStats> = {};
  for (const cat of CATEGORIES) {
    const rows = executed(results).filter((r) => r.category === cat);
    if (rows.length) {
      const passed = passedCount(rows);
      byCategory[cat] = { total: rows.length, passed, passRate: rate(passed, rows.length) };
    }
  }
  return { byCategory };
});

export function computeMetrics(results: readonly TestResult[]): Metrics {
  return Object.assign({}, ...registry.map((fn) => fn(results))) as Metrics;
}
