/**
 * Execute test cases: render prompt -> call LLM -> evaluate -> aggregate a verdict.
 *
 * The runner knows nothing about Playwright, YAML or reports; it depends only on the
 * abstractions injected in its constructor (client, evaluator factory, renderer). That
 * keeps it unit-testable and shared by the Playwright fixture and the CLI.
 */
import { LLMClientError } from '../clients/base.js';
import type { LLMClient } from '../clients/base.js';
import type { Evaluator } from '../evaluators/base.js';
import type { EvaluatorFactory } from '../evaluators/factory.js';
import {
  type AttemptResult,
  type LLMRequest,
  type Message,
  type Status,
  type TestResult,
  attemptPassed,
} from '../models/results.js';
import { type TestCase, isDeterministic } from '../models/test-case.js';
import { createLogger } from '../utils/logger.js';
import type { PromptRenderer } from '../utils/loader.js';

const log = createLogger('runner');

export class TestRunner {
  constructor(
    readonly client: LLMClient,
    readonly factory: EvaluatorFactory,
    readonly renderer: PromptRenderer,
  ) {}

  buildRequest(c: TestCase, prompt: string): LLMRequest {
    const messages: Message[] = [];
    if (c.systemPrompt) messages.push({ role: 'system', content: c.systemPrompt });
    messages.push({ role: 'user', content: prompt });
    return {
      messages,
      temperature: c.generation.temperature,
      maxTokens: c.generation.maxTokens,
      seed: c.generation.seed,
      metadata: { testId: c.id, purpose: 'target' },
    };
  }

  async run(c: TestCase): Promise<TestResult> {
    const base = {
      caseId: c.id,
      category: c.category,
      title: c.title,
      severity: c.severity,
      tags: c.tags,
      deterministic: isDeterministic(c),
      defect: c.defect ?? null,
      attempts: [] as AttemptResult[],
      durationMs: 0,
    };
    if (c.skip) {
      return {
        ...base,
        prompt: c.prompt ?? '',
        status: 'skipped',
        failureReason: `skipped: ${c.skip}`,
      };
    }

    const started = performance.now();
    let prompt: string;
    let evaluators: Evaluator[];
    try {
      prompt = this.renderer.render(c);
      evaluators = this.factory.build(c);
    } catch (err) {
      // missing template variable, unknown schema file, invalid JSON Schema...
      return {
        ...base,
        prompt: c.prompt ?? '',
        status: 'error',
        failureReason: `setup error: ${(err as Error).message}`,
      };
    }

    const request = this.buildRequest(c, prompt);
    const attempts: AttemptResult[] = [];
    for (let runNo = 1; runNo <= c.runs; runNo++) {
      let attempt: AttemptResult;
      try {
        const response = await this.client.complete(request);
        const ctx = { case: c, prompt, response };
        const evaluations = [];
        for (const ev of evaluators) evaluations.push(await ev.evaluate(ctx));
        attempt = { response, evaluations, error: null };
        log.debug(
          `${c.id} run ${runNo}/${c.runs}: ${attemptPassed(attempt) ? 'PASS' : 'FAIL'} ` +
            `(${Math.round(response.latencyMs)} ms)`,
        );
      } catch (err) {
        if (!(err instanceof LLMClientError)) throw err;
        log.error(`${c.id} run ${runNo}: provider error: ${err.message}`);
        attempt = { response: null, evaluations: [], error: err.message };
      }
      attempts.push(attempt);
    }

    const [status, failureReason] = TestRunner.verdict(c, attempts);
    return {
      ...base,
      prompt,
      status,
      attempts,
      durationMs: Math.round((performance.now() - started) * 10) / 10,
      failureReason,
    };
  }

  /** Provider errors => `error`; otherwise pass when the pass ratio reaches `minPassRatio`. */
  static verdict(c: TestCase, attempts: AttemptResult[]): [Status, string | null] {
    if (attempts.every((a) => a.error !== null)) {
      return ['error', `provider error: ${attempts.at(-1)?.error ?? 'no attempt'}`];
    }
    const ratio = attempts.filter(attemptPassed).length / attempts.length;
    if (ratio >= c.minPassRatio) return ['passed', null];

    const failing = attempts.findLast((a) => !attemptPassed(a));
    let reason = failing?.error
      ? `provider error: ${failing.error}`
      : (failing?.evaluations ?? [])
          .filter((e) => !e.passed)
          .map((e) => `${e.evaluator}: ${e.reason}`)
          .join(' | ');
    if (c.runs > 1) {
      const pct = (x: number) => `${Math.round(x * 100)}%`;
      reason = `passed ${pct(ratio)} of ${c.runs} runs (< ${pct(c.minPassRatio)}). ${reason}`;
    }
    return ['failed', reason];
  }
}
