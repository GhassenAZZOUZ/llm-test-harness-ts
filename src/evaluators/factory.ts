/**
 * Translate declarative `expected` blocks into evaluator instances.
 *
 * Order matters for report readability: cheap deterministic checks first, heuristics
 * next, the LLM judge last (same order as the Python version).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { LLMClient } from '../clients/base.js';
import type { TestCase } from '../models/test-case.js';
import type { Evaluator } from './base.js';
import {
  ContainsEvaluator,
  ExactMatchEvaluator,
  JsonSchemaEvaluator,
  LengthEvaluator,
  NotContainsEvaluator,
  RegexEvaluator,
} from './deterministic.js';
import {
  type Embedder,
  GroundednessEvaluator,
  RefusalEvaluator,
  SemanticRelevanceEvaluator,
  UncertaintyEvaluator,
} from './heuristic.js';
import { LLMJudgeEvaluator } from './judge.js';

export interface EvaluatorFactoryOptions {
  schemasDir: string;
  judgeClient?: LLMClient;
  embedder?: Embedder;
}

export class EvaluatorFactory {
  constructor(readonly opts: EvaluatorFactoryOptions) {}

  #schema(ref: string | Record<string, unknown>): Record<string, unknown> {
    if (typeof ref !== 'string') return ref;
    return JSON.parse(readFileSync(path.join(this.opts.schemasDir, ref), 'utf8')) as Record<
      string,
      unknown
    >;
  }

  build(c: TestCase): Evaluator[] {
    const e = c.expected;
    const cs = e.caseSensitive;
    const evaluators: Evaluator[] = [];

    // deterministic
    if (e.exact !== undefined) evaluators.push(new ExactMatchEvaluator(e.exact, cs));
    if (e.contains.length) evaluators.push(new ContainsEvaluator(e.contains, 'all', cs));
    if (e.containsAny.length) evaluators.push(new ContainsEvaluator(e.containsAny, 'any', cs));
    if (e.notContains.length) evaluators.push(new NotContainsEvaluator(e.notContains, cs));
    if (e.regex) evaluators.push(new RegexEvaluator(e.regex, true, cs));
    if (e.notRegex) evaluators.push(new RegexEvaluator(e.notRegex, false, cs));
    if (e.jsonSchema !== undefined) {
      evaluators.push(new JsonSchemaEvaluator(this.#schema(e.jsonSchema)));
    }
    if (e.length) evaluators.push(new LengthEvaluator(e.length));

    // heuristic
    if (e.relevantTo) {
      evaluators.push(
        new SemanticRelevanceEvaluator(e.relevantTo, e.relevanceThreshold, this.opts.embedder),
      );
    }
    if (e.grounded && c.context) {
      evaluators.push(new GroundednessEvaluator(c.context, e.groundednessThreshold));
    }
    if (e.shouldAcknowledgeUncertainty) evaluators.push(new UncertaintyEvaluator());
    if (e.shouldRefuse !== undefined) evaluators.push(new RefusalEvaluator(e.shouldRefuse));

    // model-based
    if (e.judge) {
      if (!this.opts.judgeClient) {
        throw new Error(`${c.id}: \`judge\` expectation but no judge client configured`);
      }
      evaluators.push(
        new LLMJudgeEvaluator(this.opts.judgeClient, e.judge.rubric, e.judge.threshold),
      );
    }
    return evaluators;
  }
}
