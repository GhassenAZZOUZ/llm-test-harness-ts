/**
 * Custom Playwright reporter for LLM evaluations.
 *
 * Runs in the main process. Each test attaches its harness `TestResult` as JSON
 * (`llm-result.json`); the reporter collects them, computes the metrics, evaluates the
 * quality gate and writes reports/results.json, report.html and summary.md (appended
 * to $GITHUB_STEP_SUMMARY when set). With LLM_GATE=true a failed gate fails the run.
 *
 * It complements, not replaces, Playwright's own HTML and JUnit reporters.
 */
import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { type Settings, loadSettings } from '../config/settings.js';
import { gateViolations } from '../metrics/gate.js';
import type { RunMetadata, TestResult as LLMTestResult } from '../models/results.js';
import { RESULT_ATTACHMENT } from '../playwright/outcome.js';
import { fmt, isRateMetric } from './format.js';
import { buildReport, createRunMetadata, writeReports } from './report.js';

export interface LLMReporterOptions {
  /** Defaults to LLM_REPORTS_DIR (reports/). */
  outputDir?: string;
  /** Injected in unit tests; defaults to settings from the environment. */
  settings?: Settings;
  log?: (line: string) => void;
}

export default class LLMReporter implements Reporter {
  readonly #results = new Map<string, LLMTestResult>();
  readonly #settings: Settings;
  readonly #outputDir: string;
  readonly #log: (line: string) => void;
  #metadata: RunMetadata;

  constructor(options: LLMReporterOptions = {}) {
    this.#settings = options.settings ?? loadSettings();
    this.#outputDir = options.outputDir ?? this.#settings.reportsDir;
    this.#log = options.log ?? ((line) => process.stdout.write(`${line}\n`));
    this.#metadata = createRunMetadata(this.#settings);
  }

  printsToStdio(): boolean {
    return true;
  }

  onBegin(): void {
    this.#metadata = createRunMetadata(this.#settings);
  }

  onTestEnd(_test: TestCase, result: TestResult): void {
    const attachment = result.attachments.find((a) => a.name === RESULT_ATTACHMENT);
    if (!attachment?.body) return;
    const llmResult = JSON.parse(attachment.body.toString('utf8')) as LLMTestResult;
    // keyed by case id: if Playwright retries were enabled, the last attempt wins
    this.#results.set(llmResult.caseId, llmResult);
  }

  /** Playwright only honours a status override returned as a Promise. */
  onEnd(_result: FullResult): Promise<{ status?: FullResult['status'] } | undefined> {
    return Promise.resolve(this.#finish());
  }

  #finish(): { status?: FullResult['status'] } | undefined {
    if (this.#results.size === 0) return undefined;
    const report = buildReport([...this.#results.values()], this.#metadata, this.#settings);
    const paths = writeReports(report, this.#outputDir);
    const gate = report.qualityGate;
    const m = report.metrics;

    this.#log('');
    this.#log('──────── LLM evaluation summary ────────');
    this.#log(
      `executed ${m.executed} · passed ${m.passed} · failed ${m.failed} · errors ${m.errors} · ` +
        `skipped ${m.skipped} · pass rate ${fmt(m.passRate, true)} · ` +
        `hallucination detection ${fmt(m.hallucinationDetectionRate, true)} · ` +
        `p95 ${fmt(m.latencyMs?.p95)} ms`,
    );
    this.#log(`Reports: ${paths.html} | ${paths.json} | ${paths.markdown}`);
    this.#log(`Quality gate: ${gate.passed ? 'PASSED' : 'FAILED'}`);
    for (const c of gateViolations(gate)) {
      this.#log(
        `  - ${c.name}: actual=${fmt(c.actual, isRateMetric(c.name))} threshold=${fmt(c.threshold, isRateMetric(c.name))}`,
      );
    }
    if (this.#settings.gate && !gate.passed) {
      this.#log('LLM_GATE=true: failing the run because the quality gate failed');
      return { status: 'failed' };
    }
    return undefined;
  }
}
