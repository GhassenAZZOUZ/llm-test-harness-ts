/**
 * Run report: metadata + metrics + quality gate + per-test rows, written as JSON
 * (machines), HTML (people) and Markdown (CI job summary). Shared by the Playwright
 * reporter and the CLI.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadQualityGate } from '../config/files.js';
import type { Settings } from '../config/settings.js';
import { type Metrics, computeMetrics } from '../metrics/collector.js';
import { type GateResult, evaluateGate } from '../metrics/gate.js';
import {
  type EvaluationResult,
  type RunMetadata,
  type TestResult,
  lastAttempt,
  passRatio,
  responseText,
  resultScore,
} from '../models/results.js';
import { renderHtml } from './html.js';
import { renderMarkdown } from './markdown.js';

export interface ResultRow extends TestResult {
  score: number;
  passRatio: number;
  response: string;
  evaluators: EvaluationResult[];
  latencyMs: number | null;
}

export interface RunReport {
  metadata: RunMetadata;
  metrics: Metrics;
  qualityGate: GateResult;
  results: ResultRow[];
}

export interface ReportPaths {
  json: string;
  html: string;
  markdown: string;
}

export const HARNESS_VERSION: string = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

/** Commit under test: GitHub Actions, GitLab CI, Jenkins, or the local checkout. */
export function gitSha(env: NodeJS.ProcessEnv = process.env): string | null {
  const fromCi = env.GITHUB_SHA ?? env.CI_COMMIT_SHA ?? env.GIT_COMMIT;
  if (fromCi) return fromCi;
  try {
    return (
      execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: 'pipe' }).trim() || null
    );
  } catch {
    return null;
  }
}

export function createRunMetadata(settings: Settings, now = new Date()): RunMetadata {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  return {
    runId: `${stamp}-${randomBytes(3).toString('hex')}`,
    startedAt: now.toISOString(),
    finishedAt: null,
    provider: settings.provider,
    model: settings.model,
    judgeModel: settings.judgeModel,
    harnessVersion: HARNESS_VERSION,
    gitSha: gitSha(),
    environment: { node: process.version, ci: process.env.CI ? 'true' : 'false' },
  };
}

export function toRow(r: TestResult): ResultRow {
  const last = lastAttempt(r);
  return {
    ...r,
    score: Math.round(resultScore(r) * 1e4) / 1e4,
    passRatio: Math.round(passRatio(r) * 1e4) / 1e4,
    response: responseText(r),
    evaluators: last?.evaluations ?? [],
    latencyMs: last?.response?.latencyMs ?? null,
  };
}

export function buildReport(
  results: readonly TestResult[],
  metadata: RunMetadata,
  settings: Pick<Settings, 'configDir'>,
): RunReport {
  // stable order whatever the worker scheduling was
  const sorted = [...results].sort((a, b) => a.caseId.localeCompare(b.caseId));
  const metrics = computeMetrics(sorted);
  const qualityGate = evaluateGate(
    metrics,
    loadQualityGate(path.join(settings.configDir, 'quality_gate.yaml')),
  );
  return {
    metadata: { ...metadata, finishedAt: new Date().toISOString() },
    metrics,
    qualityGate,
    results: sorted.map(toRow),
  };
}

export function writeReports(report: RunReport, dir: string, env = process.env): ReportPaths {
  mkdirSync(dir, { recursive: true });
  const paths: ReportPaths = {
    json: path.join(dir, 'results.json'),
    html: path.join(dir, 'report.html'),
    markdown: path.join(dir, 'summary.md'),
  };
  const markdown = renderMarkdown(report);
  writeFileSync(paths.json, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(paths.html, renderHtml(report), 'utf8');
  writeFileSync(paths.markdown, markdown, 'utf8');
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, markdown, 'utf8');
  return paths;
}
