/**
 * Zod schema for YAML test cases.
 *
 * The YAML contract is snake_case (shared with the Python version of the harness);
 * the schema validates it and maps it to a camelCase domain model. A test case is
 * declarative: the mapping from expectations to evaluators lives in
 * `evaluators/factory.ts`, so test authors never write code.
 */
import { z } from 'zod';
import { toJsRegExp } from '../utils/regex.js';

export const CATEGORIES = [
  'functional',
  'edge_case',
  'hallucination',
  'instruction_following',
  'safety',
  'regression',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const SEVERITIES = ['critical', 'major', 'minor'] as const;
export type Severity = (typeof SEVERITIES)[number];

const regexString = z.string().superRefine((pattern, ctx) => {
  try {
    toJsRegExp(pattern);
  } catch (err) {
    ctx.addIssue({ code: 'custom', message: `invalid regex: ${(err as Error).message}` });
  }
});

const lengthSchema = z
  .strictObject({
    min_chars: z.int().min(0).optional(),
    max_chars: z.int().min(1).optional(),
    min_words: z.int().min(0).optional(),
    max_words: z.int().min(1).optional(),
  })
  .refine((l) => !(l.min_chars != null && l.max_chars != null && l.min_chars > l.max_chars), {
    message: 'min_chars must be <= max_chars',
  })
  .refine((l) => !(l.min_words != null && l.max_words != null && l.min_words > l.max_words), {
    message: 'min_words must be <= max_words',
  });

const judgeSchema = z.strictObject({
  rubric: z.string().min(10),
  threshold: z.number().min(0).max(1).default(0.7),
});

const expectationsSchema = z.strictObject({
  // deterministic
  exact: z.string().optional(),
  contains: z.array(z.string()).default([]),
  contains_any: z.array(z.string()).default([]),
  not_contains: z.array(z.string()).default([]),
  regex: regexString.optional(),
  not_regex: regexString.optional(),
  json_schema: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  length: lengthSchema.optional(),
  case_sensitive: z.boolean().default(false),
  // heuristic / probabilistic
  relevant_to: z.string().optional(),
  relevance_threshold: z.number().min(0).max(1).default(0.3),
  grounded: z.boolean().default(false),
  groundedness_threshold: z.number().min(0).max(1).default(0.6),
  should_acknowledge_uncertainty: z.boolean().default(false),
  should_refuse: z.boolean().optional(),
  judge: judgeSchema.optional(),
});

const generationSchema = z.strictObject({
  temperature: z.number().min(0).max(2).default(0),
  max_tokens: z.int().min(1).max(32_000).default(512),
  seed: z.int().nullable().default(42),
});

export const rawTestCaseSchema = z
  .strictObject({
    id: z.string().regex(/^[A-Z]{2,5}-\d{3,}$/, 'id must look like TC-001 / REG-012'),
    category: z.enum(CATEGORIES),
    title: z.string().min(3),
    description: z.string().default(''),
    system_prompt: z.string().optional(),
    prompt: z.string().optional(),
    template: z.string().optional(),
    variables: z.record(z.string(), z.unknown()).default({}),
    context: z.string().optional(),
    expected: expectationsSchema,
    generation: generationSchema.default({ temperature: 0, max_tokens: 512, seed: 42 }),
    tags: z.array(z.string()).default([]),
    severity: z.enum(SEVERITIES).default('major'),
    runs: z.int().min(1).max(10).default(1),
    min_pass_ratio: z.number().gt(0).max(1).default(1),
    skip: z.string().optional(),
    defect: z.string().optional(),
  })
  .superRefine((c, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (c.prompt === undefined && c.template === undefined)
      issue('either `prompt` or `template` is required');
    if (c.prompt !== undefined && c.template !== undefined)
      issue('`prompt` and `template` are mutually exclusive');
    if (!hasAssertion(c.expected)) issue('`expected` must define at least one assertion');
    if (c.expected.grounded && !c.context) issue('`grounded: true` requires a `context`');
    if (c.category === 'regression' && !c.defect)
      issue('regression cases must reference a `defect`');
  });

export type RawTestCase = z.infer<typeof rawTestCaseSchema>;
type RawExpectations = RawTestCase['expected'];

function hasAssertion(e: RawExpectations): boolean {
  return (
    e.exact !== undefined ||
    e.contains.length > 0 ||
    e.contains_any.length > 0 ||
    e.not_contains.length > 0 ||
    e.regex !== undefined ||
    e.not_regex !== undefined ||
    e.json_schema !== undefined ||
    e.length !== undefined ||
    e.relevant_to !== undefined ||
    e.grounded ||
    e.should_acknowledge_uncertainty ||
    e.should_refuse !== undefined ||
    e.judge !== undefined
  );
}

// ------------------------------------------------------------------ domain model
export interface LengthLimits {
  minChars?: number;
  maxChars?: number;
  minWords?: number;
  maxWords?: number;
}

export interface Expectations {
  exact?: string;
  contains: string[];
  containsAny: string[];
  notContains: string[];
  regex?: string;
  notRegex?: string;
  jsonSchema?: string | Record<string, unknown>;
  length?: LengthLimits;
  caseSensitive: boolean;
  relevantTo?: string;
  relevanceThreshold: number;
  grounded: boolean;
  groundednessThreshold: number;
  shouldAcknowledgeUncertainty: boolean;
  shouldRefuse?: boolean;
  judge?: { rubric: string; threshold: number };
}

export interface TestCase {
  id: string;
  category: Category;
  title: string;
  description: string;
  systemPrompt?: string;
  prompt?: string;
  template?: string;
  variables: Record<string, unknown>;
  context?: string;
  expected: Expectations;
  generation: { temperature: number; maxTokens: number; seed: number | null };
  tags: string[];
  severity: Severity;
  runs: number;
  minPassRatio: number;
  skip?: string;
  defect?: string;
}

/** Drop `undefined` values so the domain object serialises cleanly. */
function compact<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

export function toTestCase(raw: RawTestCase): TestCase {
  const e = raw.expected;
  return compact<TestCase>({
    id: raw.id,
    category: raw.category,
    title: raw.title,
    description: raw.description,
    systemPrompt: raw.system_prompt,
    prompt: raw.prompt,
    template: raw.template,
    variables: raw.variables,
    context: raw.context,
    expected: compact<Expectations>({
      exact: e.exact,
      contains: e.contains,
      containsAny: e.contains_any,
      notContains: e.not_contains,
      regex: e.regex,
      notRegex: e.not_regex,
      jsonSchema: e.json_schema,
      length: e.length
        ? compact<LengthLimits>({
            minChars: e.length.min_chars,
            maxChars: e.length.max_chars,
            minWords: e.length.min_words,
            maxWords: e.length.max_words,
          })
        : undefined,
      caseSensitive: e.case_sensitive,
      relevantTo: e.relevant_to,
      relevanceThreshold: e.relevance_threshold,
      grounded: e.grounded,
      groundednessThreshold: e.groundedness_threshold,
      shouldAcknowledgeUncertainty: e.should_acknowledge_uncertainty,
      shouldRefuse: e.should_refuse,
      judge: e.judge,
    }),
    generation: {
      temperature: raw.generation.temperature,
      maxTokens: raw.generation.max_tokens,
      seed: raw.generation.seed,
    },
    tags: raw.tags,
    severity: raw.severity,
    runs: raw.runs,
    minPassRatio: raw.min_pass_ratio,
    skip: raw.skip,
    defect: raw.defect,
  });
}

/** Parse one YAML object into a validated test case (throws ZodError). */
export function parseTestCase(input: unknown): TestCase {
  return toTestCase(rawTestCaseSchema.parse(input));
}

/** True when the verdict does not depend on heuristics or a judge. */
export function isDeterministic(c: TestCase): boolean {
  const e = c.expected;
  return !(
    e.relevantTo ||
    e.grounded ||
    e.shouldAcknowledgeUncertainty ||
    e.shouldRefuse !== undefined ||
    e.judge
  );
}
