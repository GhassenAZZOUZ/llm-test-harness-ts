/**
 * LLM-as-a-judge evaluator, for criteria that rules cannot express (tone, helpfulness,
 * completeness). Mitigations: temperature 0, fixed seed, strict JSON output contract,
 * explicit rubric and threshold, and it FAILS CLOSED: a judge error or an unparseable
 * verdict is a failure, never a silent pass.
 */
import type { LLMClient } from '../clients/base.js';
import type { EvaluationResult, LLMRequest } from '../models/results.js';
import { createLogger } from '../utils/logger.js';
import { extractJson } from '../utils/text.js';
import { BaseEvaluator, type EvalContext } from './base.js';

const log = createLogger('judge');

export const JUDGE_SYSTEM_PROMPT = `You are a strict QA evaluator for AI assistant answers.
Score the ANSWER against the RUBRIC on a scale from 0.0 (fails completely) to 1.0 (fully meets it).
Judge only what is asked by the rubric. Do not reward length or confident tone.
Reply with JSON only: {"score": <float 0..1>, "reason": "<one sentence>"}`;

export function judgeUserPrompt(
  rubric: string,
  question: string,
  answer: string,
  context?: string,
) {
  const contextBlock = context ? `\nCONTEXT:\n${context}\n` : '';
  return `RUBRIC:\n${rubric}\n\nQUESTION:\n${question || '<empty>'}\n${contextBlock}\nANSWER:\n${answer || '<empty>'}`;
}

export class LLMJudgeEvaluator extends BaseEvaluator {
  readonly name = 'llm_judge';
  override readonly deterministic = false;

  constructor(
    readonly client: LLMClient,
    readonly rubric: string,
    readonly threshold = 0.7,
  ) {
    super();
  }

  async evaluate(ctx: EvalContext): Promise<EvaluationResult> {
    const request: LLMRequest = {
      messages: [
        { role: 'system', content: JUDGE_SYSTEM_PROMPT },
        {
          role: 'user',
          content: judgeUserPrompt(this.rubric, ctx.prompt, ctx.response.text, ctx.case.context),
        },
      ],
      temperature: 0,
      maxTokens: 200,
      seed: 42,
      metadata: { testId: ctx.case.id, purpose: 'judge' },
    };

    let raw: string;
    try {
      raw = (await this.client.complete(request)).text;
    } catch (err) {
      return this.result(false, 0, `Judge call failed: ${(err as Error).message}`);
    }

    let score: number;
    let reason: string;
    try {
      const verdict = extractJson(raw) as { score?: unknown; reason?: unknown };
      score = Number(verdict.score);
      if (verdict.score === undefined || verdict.score === null || !Number.isFinite(score)) {
        throw new TypeError('missing numeric score');
      }
      reason = (typeof verdict.reason === 'string' && verdict.reason.trim()) || 'no reason given';
    } catch {
      log.warn(`unparseable judge output for ${ctx.case.id}: ${raw.slice(0, 200)}`);
      return this.result(false, 0, 'Judge output was not valid JSON with a score', {
        raw: raw.slice(0, 200),
      });
    }
    const passed = score >= this.threshold;
    return this.result(
      passed,
      score,
      `Judge: ${reason} (score ${score.toFixed(2)}, threshold ${this.threshold.toFixed(2)})`,
      { judgeModel: this.client.model },
    );
  }
}
