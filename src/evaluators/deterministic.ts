/**
 * Deterministic evaluators: same input -> same verdict, no model involved.
 * Prefer these whenever a requirement can be expressed as a rule.
 */
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import type { EvaluationResult } from '../models/results.js';
import type { LengthLimits } from '../models/test-case.js';
import { toJsRegExp } from '../utils/regex.js';
import { countWords, extractJson, truncate } from '../utils/text.js';
import { BaseEvaluator, type EvalContext, repr } from './base.js';

function norm(text: string, caseSensitive: boolean): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return caseSensitive ? collapsed : collapsed.toLowerCase();
}

export class ExactMatchEvaluator extends BaseEvaluator {
  readonly name = 'exact_match';

  constructor(
    readonly expected: string,
    readonly caseSensitive = false,
  ) {
    super();
  }

  evaluate(ctx: EvalContext): EvaluationResult {
    const strip = (s: string) => norm(s, this.caseSensitive).replace(/\.+$/, '');
    if (strip(ctx.response.text) === strip(this.expected)) {
      return this.result(true, 1, 'Response exactly matches the expected value');
    }
    return this.result(
      false,
      0,
      `Expected ${repr(this.expected)}, got ${repr(truncate(ctx.response.text, 80))}`,
    );
  }
}

export class ContainsEvaluator extends BaseEvaluator {
  readonly name: 'contains' | 'contains_any';

  constructor(
    readonly keywords: string[],
    readonly mode: 'all' | 'any' = 'all',
    readonly caseSensitive = false,
  ) {
    super();
    if (keywords.length === 0) throw new Error('ContainsEvaluator needs at least one keyword');
    this.name = mode === 'all' ? 'contains' : 'contains_any';
  }

  evaluate(ctx: EvalContext): EvaluationResult {
    const text = norm(ctx.response.text, this.caseSensitive);
    const found = this.keywords.filter((k) => text.includes(norm(k, this.caseSensitive)));
    const missing = this.keywords.filter((k) => !found.includes(k));
    if (this.mode === 'all') {
      const passed = missing.length === 0;
      return this.result(
        passed,
        found.length / this.keywords.length,
        passed ? 'All expected keywords present' : `Missing keywords: ${repr(missing)}`,
        { found, missing },
      );
    }
    const passed = found.length > 0;
    return this.result(
      passed,
      passed ? 1 : 0,
      passed ? `Found ${repr(found[0])}` : `None of ${repr(this.keywords)} found`,
      { found, missing },
    );
  }
}

export class NotContainsEvaluator extends BaseEvaluator {
  readonly name = 'not_contains';

  constructor(
    readonly forbidden: string[],
    readonly caseSensitive = false,
  ) {
    super();
  }

  evaluate(ctx: EvalContext): EvaluationResult {
    const text = norm(ctx.response.text, this.caseSensitive);
    const hits = this.forbidden.filter((f) => text.includes(norm(f, this.caseSensitive)));
    if (hits.length > 0) {
      const score = 1 - hits.length / this.forbidden.length;
      return this.result(false, score, `Forbidden content present: ${repr(hits)}`, { hits });
    }
    return this.result(true, 1, 'No forbidden content found');
  }
}

export class RegexEvaluator extends BaseEvaluator {
  readonly name: 'regex' | 'not_regex';
  readonly #regex: RegExp;

  constructor(
    readonly pattern: string,
    readonly mustMatch = true,
    caseSensitive = false,
  ) {
    super();
    this.#regex = toJsRegExp(pattern, { caseSensitive });
    this.name = mustMatch ? 'regex' : 'not_regex';
  }

  evaluate(ctx: EvalContext): EvaluationResult {
    const match = this.#regex.exec(ctx.response.text);
    const passed = (match !== null) === this.mustMatch;
    const verb = match ? 'matches' : 'does not match';
    return this.result(passed, passed ? 1 : 0, `Response ${verb} /${this.pattern}/`, {
      match: match?.[0] ?? null,
    });
  }
}

export class JsonSchemaEvaluator extends BaseEvaluator {
  readonly name = 'json_schema';
  readonly #validate: ValidateFunction;

  constructor(schema: Record<string, unknown>) {
    super();
    // compile() throws on an invalid schema: a setup error, reported before any LLM call
    this.#validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
  }

  evaluate(ctx: EvalContext): EvaluationResult {
    let payload: unknown;
    try {
      payload = extractJson(ctx.response.text);
    } catch {
      return this.result(false, 0, 'Response is not valid JSON');
    }
    if (this.#validate(payload)) {
      return this.result(true, 1, 'Response is valid JSON matching the schema');
    }
    const errors = (this.#validate.errors ?? [])
      .slice(0, 5)
      .map((e) => `${e.instancePath || '<root>'}: ${e.message ?? 'invalid'}`);
    // partial credit: JSON parsed but violates the schema
    return this.result(false, 0.5, `Schema violations: ${repr(errors)}`, { errors });
  }
}

export class LengthEvaluator extends BaseEvaluator {
  readonly name = 'length';

  constructor(readonly limits: LengthLimits) {
    super();
  }

  evaluate(ctx: EvalContext): EvaluationResult {
    const chars = [...ctx.response.text.trim()].length;
    const words = countWords(ctx.response.text);
    const { minChars, maxChars, minWords, maxWords } = this.limits;
    const problems: string[] = [];
    if (minChars !== undefined && chars < minChars)
      problems.push(`${chars} chars < min ${minChars}`);
    if (maxChars !== undefined && chars > maxChars)
      problems.push(`${chars} chars > max ${maxChars}`);
    if (minWords !== undefined && words < minWords)
      problems.push(`${words} words < min ${minWords}`);
    if (maxWords !== undefined && words > maxWords)
      problems.push(`${words} words > max ${maxWords}`);
    if (problems.length > 0) return this.result(false, 0, problems.join('; '), { chars, words });
    return this.result(true, 1, `Length OK (${chars} chars, ${words} words)`, { chars, words });
  }
}
