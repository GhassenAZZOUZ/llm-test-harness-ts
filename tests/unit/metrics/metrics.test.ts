import { describe, expect, it } from 'vitest';
import type { QualityGateConfig } from '../../../src/config/files.js';
import { computeMetrics, percentile, registerMetric } from '../../../src/metrics/collector.js';
import { evaluateGate, gateViolations } from '../../../src/metrics/gate.js';
import { attempt, makeResponse, makeResult } from '../helpers.js';

const results = [
  makeResult({
    caseId: 'FUN-001',
    attempts: [attempt(true, makeResponse('a', { latencyMs: 100, attempts: 2 }))],
  }),
  makeResult({
    caseId: 'HAL-001',
    category: 'hallucination',
    deterministic: false,
    status: 'failed',
    attempts: [attempt(false, makeResponse('b', { latencyMs: 300 }))],
  }),
  makeResult({ caseId: 'HAL-002', category: 'hallucination', deterministic: false }),
  makeResult({
    caseId: 'REG-001',
    category: 'regression',
    status: 'error',
    attempts: [{ response: null, evaluations: [], error: 'x' }],
  }),
  makeResult({ caseId: 'SAFE-001', category: 'safety', status: 'skipped', attempts: [] }),
];

describe('computeMetrics', () => {
  const m = computeMetrics(results);

  it('computes outcome rates over executed (non-skipped) cases', () => {
    expect(m).toMatchObject({
      total: 5,
      executed: 4,
      passed: 2,
      failed: 1,
      errors: 1,
      skipped: 1,
      passRate: 0.5,
      failureRate: 0.25,
      errorRate: 0.25,
    });
  });

  it('computes score, latency, usage, cost and retries', () => {
    expect(m.avgScore).toBe(0.6667);
    expect(m.latencyMs).toEqual({ avg: 166.7, p50: 100, p95: 280, max: 300 });
    expect(m.tokens).toEqual({ prompt: 30, completion: 15, total: 45 });
    expect(m.costUsd).toBe(0.003);
    expect(m.llmCalls).toBe(3);
    expect(m.retries).toBe(1);
  });

  it('computes quality metrics and the per-category breakdown', () => {
    expect(m).toMatchObject({
      hallucinationDetectionRate: 0.5,
      regressionFailures: 1,
      deterministicPassRate: 0.5,
      probabilisticPassRate: 0.5,
    });
    expect(m.byCategory).toEqual({
      functional: { total: 1, passed: 1, passRate: 1 },
      hallucination: { total: 2, passed: 1, passRate: 0.5 },
      regression: { total: 1, passed: 0, passRate: 0 },
    });
  });

  it('returns nulls when there is no data', () => {
    expect(computeMetrics([])).toMatchObject({
      passRate: null,
      avgScore: null,
      latencyMs: null,
      tokens: null,
      costUsd: null,
      hallucinationDetectionRate: null,
    });
  });

  it('includes metrics added through the registry', () => {
    registerMetric((rs) => ({ criticalCases: rs.filter((r) => r.severity === 'critical').length }));
    expect(computeMetrics(results).criticalCases).toBe(0);
  });

  it('interpolates percentiles', () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([7], 0.95)).toBe(7);
  });
});

describe('evaluateGate', () => {
  const gate: QualityGateConfig = {
    minPassRate: 0.9,
    maxRegressionFailures: 0,
    minHallucinationDetectionRate: 0.8,
    maxErrorRate: 0.05,
    maxP95LatencyMs: 1000,
    maxTotalCostUsd: 1,
  };

  it('passes a healthy run', () => {
    const r = evaluateGate(
      {
        passRate: 1,
        regressionFailures: 0,
        hallucinationDetectionRate: 1,
        errorRate: 0,
        latencyMs: { avg: 1, p50: 1, p95: 900, max: 1 },
        costUsd: 0.5,
      },
      gate,
    );
    expect(r.passed).toBe(true);
    expect(r.checks.map((c) => c.name)).toEqual([
      'passRate',
      'regressionFailures',
      'hallucinationDetectionRate',
      'errorRate',
      'p95LatencyMs',
      'costUsd',
    ]);
  });

  it('fails on each violated threshold', () => {
    const r = evaluateGate(computeMetrics(results), gate);
    expect(r.passed).toBe(false);
    expect(gateViolations(r).map((c) => c.name)).toEqual([
      'passRate',
      'regressionFailures',
      'hallucinationDetectionRate',
      'errorRate',
    ]);
  });

  it('does not treat missing data as a violation and skips optional checks', () => {
    const r = evaluateGate({}, { ...gate, maxP95LatencyMs: null, maxTotalCostUsd: null });
    expect(r.passed).toBe(true);
    expect(r.checks).toHaveLength(4);
    expect(r.checks.every((c) => c.actual === null)).toBe(true);
  });
});
