/** Markdown summary: appended to the GitHub Actions job summary, archived in GitLab/Jenkins. */
import { fmt, isRateMetric } from './format.js';
import type { RunReport } from './report.js';

const cell = (text: string) => text.replaceAll('|', '/').replace(/\s+/g, ' ');

export function renderMarkdown(report: RunReport): string {
  const { metrics: m, metadata: meta, qualityGate: gate } = report;
  const lines = [
    '## LLM Test Harness report',
    '',
    `Provider **${meta.provider}** · model \`${meta.model}\` · run \`${meta.runId}\``,
    '',
    '| Metric | Value |',
    '|---|---|',
    `| Executed | ${m.executed} (${m.passed} passed, ${m.failed} failed, ${m.errors} errors, ${m.skipped} skipped) |`,
    `| Pass rate | ${fmt(m.passRate, true)} |`,
    `| Avg score | ${fmt(m.avgScore)} |`,
    `| Hallucination detection rate | ${fmt(m.hallucinationDetectionRate, true)} |`,
    `| Regression failures | ${m.regressionFailures} |`,
    `| Latency p95 (ms) | ${fmt(m.latencyMs?.p95)} |`,
    `| Tokens | ${fmt(m.tokens?.total)} |`,
    `| Cost (USD) | ${fmt(m.costUsd)} |`,
    '',
    `### Quality gate: ${gate.passed ? '✅ PASSED' : '❌ FAILED'}`,
    '',
    '| Check | Actual | Threshold | Result |',
    '|---|---|---|---|',
    ...gate.checks.map(
      (c) =>
        `| ${c.name} | ${fmt(c.actual, isRateMetric(c.name))} | ` +
        `${fmt(c.threshold, isRateMetric(c.name))} | ${c.passed ? '✅' : '❌'} |`,
    ),
    '',
  ];
  const failures = report.results.filter((r) => r.status === 'failed' || r.status === 'error');
  if (failures.length) {
    lines.push('### Failures', '', '| ID | Category | Status | Reason |', '|---|---|---|---|');
    for (const r of failures) {
      lines.push(
        `| ${r.caseId} | ${r.category} | ${r.status} | ${cell(r.failureReason ?? '').slice(0, 160)} |`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}
