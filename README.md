# LLM Test Harness

[![llm-tests](https://github.com/GhassenAZZOUZ/llm-test-harness/actions/workflows/llm-tests.yml/badge.svg)](https://github.com/GhassenAZZOUZ/llm-test-harness/actions/workflows/llm-tests.yml)
![node](https://img.shields.io/badge/node-20%2B-339933) ![typescript](https://img.shields.io/badge/TypeScript-strict-3178c6) ![playwright](https://img.shields.io/badge/Playwright%20Test-runner-2EAD33) ![license](https://img.shields.io/badge/license-MIT-informational)

A test and evaluation framework for LLM-based applications, built the way a QA engineer
tests any other system under test: **declarative test data, layered assertions, metrics,
reports and a CI quality gate**. It runs on **Playwright Test** (no browser) and TypeScript.

```text
41 YAML test cases · 6 categories · 13 evaluators · mock mode (no API key) · TypeScript strict · 175 unit tests · 99% coverage
```

> This is the TypeScript / Playwright port of a Python (pytest) harness. The YAML test data is
> shared: same cases, same expectations, same verdicts.

---

## Contents

1. [What it does](#what-it-does)
2. [Why LLM testing is different from API testing](#why-llm-testing-is-different-from-api-testing)
3. [Why Playwright Test as an LLM eval runner](#why-playwright-test-as-an-llm-eval-runner)
4. [Architecture](#architecture)
5. [Test categories](#test-categories)
6. [Evaluation strategy](#evaluation-strategy)
7. [Metrics & quality gate](#metrics--quality-gate)
8. [Quick start](#quick-start)
9. [Writing test cases](#writing-test-cases)
10. [Configuring a real LLM provider](#configuring-a-real-llm-provider)
11. [Reports](#reports)
12. [CI/CD: GitHub Actions, GitLab CI, Jenkins](#cicd-github-actions-gitlab-ci-jenkins)
13. [Project layout](#project-layout)
14. [Known limitations](#known-limitations)
15. [Roadmap](#roadmap)
16. [Design decisions](#design-decisions)

---

## What it does

- Test cases are **defined in YAML** and validated with **Zod**. Typos and inconsistent cases fail at collection time, before any LLM call.
- Prompts are sent through a **provider abstraction**: an OpenAI-compatible client on native `fetch` (OpenAI, Ollama, vLLM, LiteLLM, OpenRouter…) or a **deterministic mock** for offline runs.
- Responses are scored by configurable evaluators: **exact / contains / regex / JSON Schema / length** (deterministic), **semantic relevance / groundedness / uncertainty / refusal** (heuristic), and **LLM-as-a-judge** (model-based).
- The harness detects **hallucinations, irrelevant answers, instruction-following failures and unsafe outputs**.
- Each run produces **metrics** (pass rate, latency p95, tokens, cost, hallucination detection rate, regression failures…), **JSON / HTML / Markdown reports**, Playwright's own HTML and JUnit reports, and a **quality-gate** verdict that CI enforces.

## Why LLM testing is different from API testing

| Classic API testing              | LLM testing                                                                                           |
| -------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Same input → same output         | Output varies with sampling, model version and provider-side changes                                  |
| Assert on exact values or schema | "Correct" is often a _property_: relevant, grounded, safe, concise                                    |
| A test is pass/fail              | A test has a **score**, and quality is measured as a **rate** over a suite                            |
| Failures are bugs in code        | Failures include **hallucination**, instruction drift, over- or under-refusal, prompt injection       |
| Contract rarely changes silently | Model upgrades change behaviour **without a code change**, so continuous regression testing is needed |
| Cost is negligible               | Every call costs tokens and money, so budget and latency become test criteria                         |

What follows from that:

1. **Separate the deterministic from the probabilistic.** Enforce anything that can be a rule as a rule. Where heuristics or a judge are needed, apply a threshold and label the result as probabilistic in reports.
2. **Measure at the suite level.** A single sampled answer is noisy. The quality gate decides on rates (pass rate, hallucination detection rate), and noisy cases can be repeated (`runs: 3, min_pass_ratio: 0.66`).
3. **Keep a regression suite.** Every defect found becomes a permanent test case (`npx llm-harness promote`), and a single regression failure blocks the pipeline.
4. **Treat infrastructure errors separately.** A timeout is an `error`, not a model `failed`, and it gets its own threshold.

## Why Playwright Test as an LLM eval runner

Playwright Test is a general-purpose test runner that happens to ship browser automation. None of
the LLM tests open a browser; they use the runner itself:

| Need of an LLM eval suite                                 | Playwright Test feature used                                                           |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Expensive shared setup (clients, evaluators) built once   | **Worker-scoped fixture** `harness` (dependency injection)                             |
| Per-test glue (run case, attach evidence, decide outcome) | **Test-scoped fixture** `evaluateCase`                                                 |
| Strict in CI, tolerant on live models                     | **Option fixture** `softFail`, overridable per **project**                             |
| Select by category / tag / severity                       | **Tags** (`@hallucination`, `@smoke`, `@critical`) + `--grep` / `--grep-invert`        |
| Evidence for every verdict                                | `testInfo.attach` (prompt, response, evaluator table, JSON result) and annotations     |
| Known, accepted failures that stay visible                | **Expected failures** (`testInfo.fail()`)                                              |
| Suite-level metrics and a release decision                | **Custom reporter** (`src/reporting/llm-reporter.ts`) that can override the run status |
| Human and CI reports                                      | Built-in **HTML** and **JUnit** reporters, kept alongside the custom one               |
| Throughput with slow models                               | **Parallel workers** (`LLM_WORKERS`)                                                   |

The same team that writes UI and API tests in Playwright can read, run and extend these tests with
the same mental model, the same CLI and the same CI integration. The runner-independent core
(`TestRunner`) is also exposed through a small CLI, so nothing is locked into Playwright.

**Why `retries: 0`.** Playwright retries are the right tool for flaky _infrastructure_ in UI
tests. For LLM evals they are the wrong tool: retrying a probabilistic test until it goes green
hides exactly the non-determinism you are trying to measure, and turns a 1-in-3 hallucination
into a "flaky pass". Instead:

- provider hiccups (429, 5xx, timeouts) are retried **below** the test by `RetryingClient`, and counted in the `retries` metric;
- intrinsically noisy cases declare `runs` + `min_pass_ratio` in YAML, so the sampling variance is measured and reported, not retried away (see `HAL-007`).

## Architecture

```mermaid
flowchart LR
    subgraph Data["Test data (declarative)"]
        Y["test_data/cases/*.yaml"]
        T["test_data/prompts/*.njk"]
        S["test_data/schemas/*.json"]
        M["test_data/mock/*.yaml"]
    end

    subgraph Exec["Execution"]
        L["Loader + Zod schema"]
        P["Playwright specs + fixtures / CLI"]
        R["TestRunner"]
    end

    subgraph Providers["Provider layer"]
        RC["RetryingClient<br/>backoff + jitter"]
        OC["OpenAICompatibleClient<br/>fetch + AbortController"]
        MC["MockLLMClient<br/>record / replay"]
    end

    subgraph Eval["Evaluation"]
        F["EvaluatorFactory"]
        D["Deterministic<br/>exact, contains, regex, JSON Schema, length"]
        H["Heuristic<br/>relevance, groundedness, uncertainty, refusal"]
        J["LLM-as-a-judge"]
    end

    subgraph Out["Metrics & reporting"]
        RP["LLM reporter<br/>(Playwright main process)"]
        MX["Metrics registry"]
        G["Quality gate<br/>config/quality_gate.yaml"]
        O["results.json, report.html, summary.md<br/>+ Playwright HTML + JUnit"]
    end

    Y --> L --> P --> R
    T --> R
    R --> RC --> OC & MC
    M --> MC
    R --> F --> D & H & J
    S --> D
    J --> RC
    P -- "JSON attachment" --> RP --> MX --> G --> O
    G -- "exit code" --> CI["GitHub Actions / GitLab CI / Jenkins"]
```

Sequence of a single test case:

```mermaid
sequenceDiagram
    participant PW as Playwright worker (hallucination.spec.ts)
    participant FX as evaluateCase fixture
    participant R as TestRunner
    participant C as RetryingClient → Provider
    participant E as Evaluators
    participant RP as LLM reporter (main process)
    PW->>FX: evaluateCase(HAL-003)
    FX->>R: run(case)
    R->>R: render rag_qa.njk (throwOnUndefined)
    loop runs (1..n)
        R->>C: complete(messages, temperature, seed)
        C-->>R: LLMResponse (text, latency, tokens, cost, attempts)
        R->>E: evaluate(ctx) for each evaluator
        E-->>R: { passed, score, reason, deterministic }
    end
    R-->>FX: TestResult (passed / failed / error / skipped)
    FX->>FX: attach prompt, response, evaluators, llm-result.json
    FX->>PW: strict → fail · soft → expected failure (regression always strict)
    PW-->>RP: onTestEnd(attachments)
    Note over RP: onEnd → metrics → quality gate → reports → exit code (LLM_GATE)
```

**Separation of concerns:**

| Layer                       | Knows about                                  | Does not know about                                       |
| --------------------------- | -------------------------------------------- | --------------------------------------------------------- |
| `models/`                   | Zod schema, plain result types               | Everything else                                           |
| `clients/`                  | HTTP, retries, pricing                       | Test cases, evaluators                                    |
| `evaluators/`               | A response + its case                        | Providers (except the judge's injected client), reporting |
| `runner/`                   | Abstractions injected in its constructor     | Playwright, YAML, reports                                 |
| `metrics/`, `reporting/`    | `TestResult` lists                           | How results were produced                                 |
| `runner/harness.ts`         | Wires everything together (composition root) | —                                                         |
| `playwright/`, `tests/llm/` | Playwright wiring only; cases come from YAML | —                                                         |

Results cross the worker → main-process boundary as **plain JSON** (a test attachment), which is
why the result model is interfaces + pure functions rather than classes.

## Test categories

| Category                  | Cases | Examples                                                                                                                                                            | Expected behaviour                                                   |
| ------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **functional**            | 6     | factual QA, arithmetic, summarization, sentiment classification, JSON extraction, judged explanation                                                                | Correct, well-formatted answers                                      |
| **edge_case**             | 10    | empty prompt, ~50K-char needle-in-haystack, ambiguous, contradictory, truncated JSON, special chars, French, Arabic + emoji, repeated instructions, missing context | Graceful, sensible handling                                          |
| **hallucination**         | 7     | fictional company/book, false premise (Einstein 1987), fake DOI, RAG answer absent vs present (control), future event ×3 runs                                       | **Acknowledge uncertainty** instead of inventing                     |
| **instruction_following** | 7     | system vs user conflict (prompt leak), exact markdown format, ≤20 words, forbidden words, multi-step chain, raw JSON only, answer language                          | Instructions respected, with priority given to the system prompt     |
| **safety**                | 7     | explosives, ransomware, doxxing, phishing, indirect prompt injection, **over-refusal** controls                                                                     | Refuse or redirect unsafe requests without over-refusing benign ones |
| **regression**            | 4     | invented refund policy, JSON wrapped in prose, summary > 50 words, over-refusal on `docker kill`                                                                    | Previously fixed defects stay fixed                                  |

One spec file per category under [`tests/llm/`](tests/llm/), each generated from YAML:

```ts
test.describe('hallucination', { tag: categoryTag('hallucination') }, () => {
  for (const llmCase of casesFor('hallucination')) {
    test(`${llmCase.id} ${llmCase.title}`, { tag: tagsFor(llmCase) }, async ({ evaluateCase }) => {
      await evaluateCase(llmCase);
    });
  }
});
```

> Safety cases store only the **request**. No harmful content is generated or asserted on;
> the evaluator checks for a refusal or redirect, and also checks for over-refusal.

## Evaluation strategy

Every evaluator returns the same structure:

```json
{
  "evaluator": "groundedness",
  "passed": true,
  "score": 0.92,
  "reason": "11/12 sentences supported by context",
  "deterministic": false,
  "details": {}
}
```

| Evaluator                        | YAML key                                   | Type          | Detects                                                 |
| -------------------------------- | ------------------------------------------ | ------------- | ------------------------------------------------------- |
| Exact match                      | `exact`                                    | deterministic | wrong value / extra text                                |
| Contains / any / not             | `contains`, `contains_any`, `not_contains` | deterministic | missing facts, forbidden content, prompt-injection echo |
| Regex / not regex                | `regex`, `not_regex`                       | deterministic | format violations, fabricated patterns (e.g. DOIs)      |
| JSON Schema (Ajv, draft 2020-12) | `json_schema`                              | deterministic | invalid structured output                               |
| Length                           | `length`                                   | deterministic | verbosity, instruction violations                       |
| Semantic relevance               | `relevant_to`                              | heuristic     | off-topic answers                                       |
| Groundedness                     | `grounded`                                 | heuristic     | claims or **numbers** not supported by the context      |
| Uncertainty                      | `should_acknowledge_uncertainty`           | heuristic     | hallucinated facts about unknown or fictional entities  |
| Refusal                          | `should_refuse: true/false`                | heuristic     | unsafe compliance **and** over-refusal                  |
| LLM-as-a-judge                   | `judge: {rubric, threshold}`               | model-based   | qualities rules can't express (clarity, helpfulness)    |

The factory builds them in a fixed order: deterministic first, heuristics next, the judge last.

### Why deterministic assertions come first

An LLM judge is another LLM, so it can be biased (towards longer or more confident answers, or towards its own style), it is non-deterministic, it costs money, and it can be prompt-injected by the answer it is grading. Rules of thumb used here:

1. If a requirement can be expressed as a rule (format, keyword, schema, length, forbidden term), **use a rule**. It is free, instant and reproducible, and when it fails it says exactly why.
2. Use heuristics (relevance, groundedness) as **cheap, explainable signals** with explicit thresholds.
3. Use the judge **last**, for subjective criteria only, and always **combined with deterministic guards** (see `FUN-006`). The judge runs at temperature 0 with a strict JSON contract, and **fails closed** if its output can't be parsed or the call fails.
4. The judge model can differ from the system under test (`LLM_JUDGE_MODEL`), which avoids a model grading its own output.

## Metrics & quality gate

Computed in [`src/metrics/collector.ts`](src/metrics/collector.ts). Each metric is a small function registered with `registerMetric()`, so adding one takes a few lines and it appears in every report automatically.

| Metric                                            | Meaning                                                 |
| ------------------------------------------------- | ------------------------------------------------------- |
| `passRate`, `failureRate`, `errorRate`            | over executed (non-skipped) cases                       |
| `avgScore`                                        | mean evaluator score                                    |
| `latencyMs.{avg,p50,p95,max}`                     | per LLM call                                            |
| `tokens.{prompt,completion,total}`, `costUsd`     | when the provider reports usage (`config/pricing.yaml`) |
| `retries`, `llmCalls`                             | transient-failure visibility                            |
| `hallucinationDetectionRate`                      | share of hallucination probes handled correctly         |
| `regressionFailures`                              | regression cases not passing                            |
| `deterministicPassRate` / `probabilisticPassRate` | the two kinds of verdict, reported separately           |
| `byCategory`                                      | pass rate per category                                  |

[`config/quality_gate.yaml`](config/quality_gate.yaml):

```yaml
min_pass_rate: 0.90
max_regression_failures: 0
min_hallucination_detection_rate: 0.80
max_error_rate: 0.05
max_p95_latency_ms: 15000
max_total_cost_usd: 1.00
```

**Soft-fail vs gate.** Two separate decisions:

- _Per test_ (`LLM_SOFT_FAIL`): strict by default (mock, PRs). With a live model, set it to `true` and probabilistic failures become Playwright **expected failures**: visible in every report, annotated `llm-soft-fail`, but not breaking the run on their own. **Regression cases always fail hard.**
- _Per run_ (`LLM_GATE`): the reporter evaluates the gate after all tests and, when `LLM_GATE=true`, fails the run if any threshold is violated. CI can also run `npx llm-harness gate reports/results.json` as an explicit step.

