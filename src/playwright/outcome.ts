/**
 * Map a harness verdict to a Playwright outcome. Pure function, so the strict /
 * soft-fail policy is unit-tested without starting Playwright.
 *
 * - strict (default: mock, CI): any failure or error fails the test.
 * - soft-fail (live providers): failures become *expected failures* (`test.fail()`),
 *   visible in every report, and the run-level quality gate decides.
 *   Regression cases are ALWAYS strict: a fixed defect must never come back.
 */
import { type TestResult, lastAttempt, resultScore } from '../models/results.js';
import type { TestCase } from '../models/test-case.js';

/** Name of the attachment that carries the TestResult from the worker to the reporter. */
export const RESULT_ATTACHMENT = 'llm-result.json';

export type Outcome =
  | { kind: 'pass' }
  | { kind: 'skip'; reason: string }
  | { kind: 'fail'; message: string }
  | { kind: 'soft-fail'; message: string };

export function decideOutcome(result: TestResult, c: TestCase, softFail: boolean): Outcome {
  if (result.status === 'skipped')
    return { kind: 'skip', reason: result.failureReason ?? 'skipped' };
  if (result.status === 'passed') return { kind: 'pass' };
  const message = `[${result.status.toUpperCase()}] ${c.id}: ${result.failureReason ?? ''}`;
  if (softFail && c.category !== 'regression') return { kind: 'soft-fail', message };
  return { kind: 'fail', message };
}

/** Plain-text evaluator table attached to every test (readable in the HTML report). */
export function evaluatorTable(result: TestResult): string {
  const evaluations = lastAttempt(result)?.evaluations ?? [];
  if (evaluations.length === 0) return result.failureReason ?? 'no evaluation';
  const header = `score=${resultScore(result).toFixed(3)} status=${result.status}\n\n`;
  return (
    header +
    evaluations
      .map(
        (e) =>
          `${e.passed ? 'PASS' : 'FAIL'}  ${e.evaluator.padEnd(24)} ${e.score.toFixed(2)}  ` +
          `${e.deterministic ? 'det. ' : 'prob.'}  ${e.reason}`,
      )
      .join('\n')
  );
}
