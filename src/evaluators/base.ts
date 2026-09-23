/**
 * Evaluator contract.
 *
 * Every evaluator receives the same `EvalContext` and returns an `EvaluationResult`
 * `{ evaluator, passed, score, reason, deterministic, details }`. The `deterministic`
 * flag is surfaced in reports so readers know which verdicts are exact and which are
 * heuristic or model-based.
 */
import type { EvaluationResult, LLMResponse } from '../models/results.js';
import type { TestCase } from '../models/test-case.js';

export interface EvalContext {
  case: TestCase;
  prompt: string;
  response: LLMResponse;
}

export interface Evaluator {
  readonly name: string;
  readonly deterministic: boolean;
  evaluate(ctx: EvalContext): EvaluationResult | Promise<EvaluationResult>;
}

export abstract class BaseEvaluator implements Evaluator {
  abstract readonly name: string;
  readonly deterministic: boolean = true;

  abstract evaluate(ctx: EvalContext): EvaluationResult | Promise<EvaluationResult>;

  protected result(
    passed: boolean,
    score: number,
    reason: string,
    details: Record<string, unknown> = {},
  ): EvaluationResult {
    return {
      evaluator: this.name,
      passed,
      score: Math.round(Math.min(Math.max(score, 0), 1) * 1e4) / 1e4,
      reason,
      deterministic: this.deterministic,
      details,
    };
  }
}

/** Python-style repr for readable failure reasons: 'text' or ["a", "b"]. */
export function repr(value: unknown): string {
  return typeof value === 'string' ? `'${value}'` : JSON.stringify(value);
}
