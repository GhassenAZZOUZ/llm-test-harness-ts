/** YAML configuration files: model pricing and quality-gate thresholds. */
import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const priceSchema = z.object({
  input_per_1k: z.number().min(0),
  output_per_1k: z.number().min(0),
});

const pricingSchema = z.object({
  models: z.record(z.string(), priceSchema).default({}),
});

export class Pricing {
  constructor(readonly models: Record<string, z.infer<typeof priceSchema>> = {}) {}

  /** USD cost of one call, or null when the model or the token usage is unknown. */
  cost(model: string, promptTokens: number | null, completionTokens: number | null): number | null {
    const price = this.models[model];
    if (!price || promptTokens === null || completionTokens === null) return null;
    const usd =
      (promptTokens / 1000) * price.input_per_1k + (completionTokens / 1000) * price.output_per_1k;
    return Math.round(usd * 1e6) / 1e6;
  }

  static load(file: string): Pricing {
    return new Pricing(pricingSchema.parse(readYamlObject(file)).models);
  }
}

const gateSchema = z.strictObject({
  min_pass_rate: z.number().min(0).max(1).default(0.9),
  max_regression_failures: z.int().min(0).default(0),
  min_hallucination_detection_rate: z.number().min(0).max(1).default(0.8),
  max_error_rate: z.number().min(0).max(1).default(0.05),
  max_p95_latency_ms: z.number().positive().nullable().default(null),
  max_total_cost_usd: z.number().min(0).nullable().default(null),
});

/** Thresholds that decide whether a run is releasable. */
export interface QualityGateConfig {
  minPassRate: number;
  maxRegressionFailures: number;
  minHallucinationDetectionRate: number;
  maxErrorRate: number;
  maxP95LatencyMs: number | null;
  maxTotalCostUsd: number | null;
}

export function loadQualityGate(file: string): QualityGateConfig {
  const g = gateSchema.parse(readYamlObject(file));
  return {
    minPassRate: g.min_pass_rate,
    maxRegressionFailures: g.max_regression_failures,
    minHallucinationDetectionRate: g.min_hallucination_detection_rate,
    maxErrorRate: g.max_error_rate,
    maxP95LatencyMs: g.max_p95_latency_ms,
    maxTotalCostUsd: g.max_total_cost_usd,
  };
}

function readYamlObject(file: string): unknown {
  if (!existsSync(file)) return {};
  return (parseYaml(readFileSync(file, 'utf8')) as unknown) ?? {};
}
