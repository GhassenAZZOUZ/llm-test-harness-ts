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

