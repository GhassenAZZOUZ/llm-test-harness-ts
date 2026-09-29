/** Quality gate: turn run metrics into a release decision for CI. */
import type { QualityGateConfig } from '../config/files.js';
import type { Metrics } from './collector.js';

export interface GateCheck {
  name: string;
  actual: number | null;
  threshold: number;
  passed: boolean;
}

export interface GateResult {
  passed: boolean;
  checks: GateCheck[];
}

export function evaluateGate(metrics: Partial<Metrics>, gate: QualityGateConfig): GateResult {
  const checks: GateCheck[] = [];
  // a metric with no data (e.g. no hallucination case selected) is not a violation
  const atLeast = (name: string, actual: number | null | undefined, threshold: number) =>
    checks.push({
      name,
      actual: actual ?? null,
      threshold,
      passed: actual == null || actual >= threshold,
    });
  const atMost = (name: string, actual: number | null | undefined, threshold: number) =>
    checks.push({
      name,
      actual: actual ?? null,
      threshold,
      passed: actual == null || actual <= threshold,
    });

  atLeast('passRate', metrics.passRate, gate.minPassRate);
  atMost('regressionFailures', metrics.regressionFailures, gate.maxRegressionFailures);
  atLeast(
    'hallucinationDetectionRate',
    metrics.hallucinationDetectionRate,
    gate.minHallucinationDetectionRate,
  );
  atMost('errorRate', metrics.errorRate, gate.maxErrorRate);
  if (gate.maxP95LatencyMs !== null) {
    atMost('p95LatencyMs', metrics.latencyMs?.p95, gate.maxP95LatencyMs);
  }
  if (gate.maxTotalCostUsd !== null) atMost('costUsd', metrics.costUsd, gate.maxTotalCostUsd);

  return { passed: checks.every((c) => c.passed), checks };
}

export function gateViolations(gate: GateResult): GateCheck[] {
  return gate.checks.filter((c) => !c.passed);
}
