import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { escapeHtml, fmt } from '../../../src/reporting/format.js';
import { renderHtml } from '../../../src/reporting/html.js';
import LLMReporter from '../../../src/reporting/llm-reporter.js';
import { renderMarkdown } from '../../../src/reporting/markdown.js';
import {
  HARNESS_VERSION,
  buildReport,
  createRunMetadata,
  gitSha,
  toRow,
  writeReports,
} from '../../../src/reporting/report.js';
import { RESULT_ATTACHMENT } from '../../../src/playwright/outcome.js';
import { attempt, makeResponse, makeResult, makeSettings, tempDir } from '../helpers.js';

const XSS = '<script>alert("x")</script>';

const results = [
  makeResult({
    caseId: 'REG-002',
    category: 'regression',
    status: 'failed',
    failureReason: 'regex: a | b',
    defect: 'GH-102',
  }),
  makeResult({
    caseId: 'FUN-001',
    tags: ['smoke'],
    prompt: XSS,
    attempts: [attempt(true, makeResponse(`answer ${XSS}`))],
  }),
];

function report() {
  const settings = makeSettings();
  return buildReport(results, createRunMetadata(settings), settings);
}

describe('report model', () => {
  it('sorts results, computes metrics and the gate, and flattens rows', () => {
    const r = report();
    expect(r.results.map((x) => x.caseId)).toEqual(['FUN-001', 'REG-002']);
    expect(r.metrics.regressionFailures).toBe(1);
    expect(r.qualityGate.passed).toBe(false);
    expect(r.metadata.finishedAt).not.toBeNull();
    expect(r.results[0]).toMatchObject({
      score: 1,
      passRatio: 1,
      response: `answer ${XSS}`,
      latencyMs: 100,
    });
    expect(toRow(makeResult({ attempts: [] }))).toMatchObject({
      response: '',
      evaluators: [],
      latencyMs: null,
    });
  });

  it('records run metadata (id, version, commit)', () => {
    const meta = createRunMetadata(makeSettings(), new Date('2026-09-30T20:18:15.123Z'));
    expect(meta.runId).toMatch(/^20260930T201815Z-[0-9a-f]{6}$/);
    expect(meta).toMatchObject({
      provider: 'mock',
      model: 'mock-1',
      harnessVersion: HARNESS_VERSION,
    });
    expect(gitSha({ GITHUB_SHA: 'abc' })).toBe('abc');
    expect(gitSha({ CI_COMMIT_SHA: 'gitlab' })).toBe('gitlab');
    expect(gitSha({ GIT_COMMIT: 'jenkins' })).toBe('jenkins');
  });

  it('returns null when git is unavailable', async () => {
    vi.resetModules();
    vi.doMock('node:child_process', () => ({
      execFileSync: () => {
        throw new Error('git: not found');
      },
    }));
    const mod = await import('../../../src/reporting/report.js');
    expect(mod.gitSha({})).toBeNull();
    vi.doUnmock('node:child_process');
  });
});

describe('writers', () => {
  it('writes JSON, HTML and Markdown and appends to $GITHUB_STEP_SUMMARY', () => {
    const dir = tempDir();
    const summary = path.join(dir, 'step-summary.md');
    writeFileSync(summary, '# previous step\n');
    const paths = writeReports(report(), path.join(dir, 'out'), { GITHUB_STEP_SUMMARY: summary });
    const json = JSON.parse(readFileSync(paths.json, 'utf8')) as { results: unknown[] };
    expect(json.results).toHaveLength(2);
    expect(readFileSync(paths.html, 'utf8')).toContain('<!doctype html>');
    expect(readFileSync(summary, 'utf8')).toMatch(/^# previous step\n## LLM Test Harness report/);
  });

  it('escapes model output and prompts in the HTML report', () => {
    const html = renderHtml(report());
    expect(html).not.toContain(XSS);
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(html).toContain('data-status="failed"');
    expect(html).toContain('Defect: GH-102');
    expect(html).toContain('Quality gate: <span class="ko">FAILED</span>');
  });

  it('renders the Markdown summary with gate table and failures', () => {
    const md = renderMarkdown(report());
    expect(md).toContain('### Quality gate: ❌ FAILED');
    expect(md).toContain('| regressionFailures | 1 | 0 | ❌ |');
    expect(md).toContain('| REG-002 | regression | failed | regex: a / b |');
  });

  it('formats values', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
    expect([fmt(null), fmt(0.8537, true), fmt(15000), fmt(0.12345678)]).toEqual([
      'n/a',
      '85.4%',
      '15,000',
      '0.1235',
    ]);
  });
});

describe('LLMReporter (custom Playwright reporter)', () => {
  const lines: string[] = [];
  afterEach(() => {
    lines.length = 0;
  });

  const attachmentFor = (r: ReturnType<typeof makeResult>) => ({
    attachments: [
      { name: 'prompt', contentType: 'text/plain', body: Buffer.from('x') },
      {
        name: RESULT_ATTACHMENT,
        contentType: 'application/json',
        body: Buffer.from(JSON.stringify(r)),
      },
    ],
  });

  function reporter(gate: boolean) {
    const dir = tempDir();
    const rep = new LLMReporter({
      settings: makeSettings({ gate }),
      outputDir: dir,
      log: (l) => lines.push(l),
    });
    rep.onBegin();
    return { rep, dir };
  }

  // Playwright objects are large; the reporter only reads `attachments`
  type TestEnd = Parameters<LLMReporter['onTestEnd']>;
  const end = (rep: LLMReporter, r: ReturnType<typeof makeResult>) =>
    rep.onTestEnd({} as TestEnd[0], attachmentFor(r) as unknown as TestEnd[1]);
  const full = { status: 'passed' } as Parameters<LLMReporter['onEnd']>[0];

  it('collects attached results, writes reports and prints the gate', async () => {
    const { rep, dir } = reporter(false);
    end(rep, makeResult());
    rep.onTestEnd({} as TestEnd[0], { attachments: [] } as unknown as TestEnd[1]); // not an LLM test
    expect(await rep.onEnd(full)).toBeUndefined();
    expect(rep.printsToStdio()).toBe(true);
    expect(lines.join('\n')).toMatch(/executed 1 · passed 1 .*\n.*\nQuality gate: PASSED/);
    const json = JSON.parse(readFileSync(path.join(dir, 'results.json'), 'utf8')) as {
      results: unknown[];
    };
    expect(json.results).toHaveLength(1);
  });

  it('keeps the last attempt per case and fails the run when LLM_GATE=true and the gate fails', async () => {
    const { rep } = reporter(true);
    end(rep, makeResult({ caseId: 'REG-001', category: 'regression' }));
    end(rep, makeResult({ caseId: 'REG-001', category: 'regression', status: 'failed' }));
    expect(await rep.onEnd(full)).toEqual({ status: 'failed' });
    expect(lines.join('\n')).toContain('regressionFailures: actual=1 threshold=0');
    expect(lines.at(-1)).toMatch(/LLM_GATE=true/);
  });

  it('only reports the gate when LLM_GATE is not set', async () => {
    const { rep } = reporter(false);
    end(rep, makeResult({ status: 'failed' }));
    expect(await rep.onEnd(full)).toBeUndefined();
    expect(lines).toContain('Quality gate: FAILED');
  });

  it('does nothing when no LLM test ran', async () => {
    const { rep } = reporter(true);
    expect(await rep.onEnd(full)).toBeUndefined();
    expect(lines).toEqual([]);
  });

  it('defaults to settings from the environment', () => {
    expect(() => new LLMReporter()).not.toThrow();
  });
});
