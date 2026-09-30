/**
 * Self-contained HTML report: KPI cards, quality gate, per-category breakdown and a
 * filterable table of cases (status, category, free text) with prompt, response and
 * per-evaluator reasons. No external assets; follows the OS light/dark preference.
 *
 * Model output is untrusted input: every dynamic value goes through `escapeHtml`.
 */
import { escapeHtml as e, fmt, isRateMetric } from './format.js';
import type { ResultRow, RunReport } from './report.js';

const STYLE = `
:root{--bg:#f7f7f8;--card:#fff;--fg:#1d1d1f;--muted:#6b6b76;--line:#e4e4e8;--pass:#1a7f37;--fail:#cf222e;--err:#9a6700;--skip:#6b6b76;--accent:#3355cc}
@media (prefers-color-scheme:dark){:root{--bg:#141417;--card:#1d1d22;--fg:#ececf1;--muted:#9c9ca8;--line:#2d2d35;--pass:#3fb950;--fail:#f85149;--err:#d29922;--skip:#8b8b96;--accent:#7a9cff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:1200px;margin:0 auto;padding:24px 16px}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 10px}
.meta{color:var(--muted);font-size:13px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-top:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}.card .k{color:var(--muted);font-size:12px}.card .v{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:12px;color:var(--muted);font-weight:600}
.badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;font-weight:600;color:#fff}
.passed{background:var(--pass)}.failed{background:var(--fail)}.error{background:var(--err)}.skipped{background:var(--skip)}
.ok{color:var(--pass);font-weight:600}.ko{color:var(--fail);font-weight:600}
pre{white-space:pre-wrap;word-break:break-word;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px;margin:4px 0 10px;font-size:12.5px;max-height:320px;overflow:auto}
details summary{cursor:pointer;color:var(--accent)}.tag{font-size:11px;color:var(--muted);border:1px solid var(--line);border-radius:4px;padding:0 4px;margin-right:3px}
.filters{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:10px}
.filters button,.filters select,.filters input{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:4px 10px;font:inherit}
.filters button{cursor:pointer}.filters button.on{border-color:var(--accent);color:var(--accent)}
.table-wrap{overflow-x:auto}.muted{color:var(--muted)}.small{font-size:11px}`;

const SCRIPT = `
const state={status:'all',category:'all',q:''};
function apply(){document.querySelectorAll('#cases tr[data-status]').forEach(tr=>{
  const ok=(state.status==='all'||tr.dataset.status===state.status)&&(state.category==='all'||tr.dataset.category===state.category)&&(!state.q||tr.dataset.search.includes(state.q));
  tr.hidden=!ok;});}
document.querySelectorAll('.filters button').forEach(b=>b.addEventListener('click',()=>{
  document.querySelectorAll('.filters button').forEach(x=>x.classList.remove('on'));b.classList.add('on');state.status=b.dataset.f;apply();}));
document.getElementById('cat').addEventListener('change',ev=>{state.category=ev.target.value;apply();});
document.getElementById('q').addEventListener('input',ev=>{state.q=ev.target.value.toLowerCase();apply();});`;

function card(label: string, value: string): string {
  return `<div class="card"><div class="k">${e(label)}</div><div class="v">${value}</div></div>`;
}

function caseRow(r: ResultRow): string {
  const evaluators = r.evaluators.length
    ? `<b>Evaluators</b><table><tr><th>Evaluator</th><th>Type</th><th>Score</th><th>Result</th><th>Reason</th></tr>${r.evaluators
        .map(
          (ev) =>
            `<tr><td>${e(ev.evaluator)}</td><td>${ev.deterministic ? 'det.' : 'prob.'}</td><td>${ev.score.toFixed(2)}</td>` +
            `<td><span class="badge ${ev.passed ? 'passed' : 'failed'}">${ev.passed ? 'pass' : 'fail'}</span></td><td>${e(ev.reason)}</td></tr>`,
        )
        .join('')}</table>`
    : '';
  const search = `${r.caseId} ${r.title} ${r.tags.join(' ')}`.toLowerCase();
  return `<tr data-status="${e(r.status)}" data-category="${e(r.category)}" data-search="${e(search)}">
  <td><code>${e(r.caseId)}</code></td>
  <td>${e(r.category)}<br><span class="muted small">${r.deterministic ? 'deterministic' : 'probabilistic'}</span></td>
  <td>${e(r.title)}<br>${r.tags.map((t) => `<span class="tag">${e(t)}</span>`).join('')}</td>
  <td><span class="badge ${e(r.status)}">${e(r.status)}</span></td>
  <td>${r.score.toFixed(2)}</td>
  <td>${e(r.durationMs)}</td>
  <td><details><summary>open</summary>
    ${r.failureReason ? `<b>Failure reason</b><pre>${e(r.failureReason)}</pre>` : ''}
    <b>Prompt</b><pre>${e(r.prompt || '<empty>')}</pre>
    <b>Model response</b><pre>${e(r.response || '<no response>')}</pre>
    ${evaluators}
    ${r.defect ? `<p class="muted">Defect: ${e(r.defect)}</p>` : ''}
  </details></td>
</tr>`;
}

export function renderHtml(report: RunReport): string {
  const { metrics: m, metadata: meta, qualityGate: gate } = report;
  const categories = Object.keys(m.byCategory);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LLM Test Report · ${e(meta.runId)}</title>
<style>${STYLE}</style>
</head>
<body><main>
<h1>LLM Test Harness report</h1>
<div class="meta">Run <code>${e(meta.runId)}</code> · provider <b>${e(meta.provider)}</b> · model <code>${e(meta.model)}</code>${
    meta.judgeModel ? ` · judge <code>${e(meta.judgeModel)}</code>` : ''
  } · ${e(meta.startedAt)}${meta.gitSha ? ` · commit <code>${e(meta.gitSha.slice(0, 8))}</code>` : ''}</div>

<div class="grid">
${card('Pass rate', fmt(m.passRate, true))}
${card('Passed / executed', `${m.passed} / ${m.executed}`)}
${card('Failed · errors', `${m.failed} · ${m.errors}`)}
${card('Avg score', m.avgScore === null ? 'n/a' : m.avgScore.toFixed(2))}
${card('Hallucination detection', fmt(m.hallucinationDetectionRate, true))}
${card('Regression failures', String(m.regressionFailures))}
${card('Latency p95', `${fmt(m.latencyMs?.p95)}<span class="muted small"> ms</span>`)}
${card('Tokens · cost', `<span style="font-size:16px">${fmt(m.tokens?.total)} · ${m.costUsd === null ? 'n/a' : `$${m.costUsd.toFixed(4)}`}</span>`)}
</div>

<h2>Quality gate: <span class="${gate.passed ? 'ok' : 'ko'}">${gate.passed ? 'PASSED' : 'FAILED'}</span></h2>
<div class="table-wrap"><table><tr><th>Check</th><th>Actual</th><th>Threshold</th><th>Result</th></tr>
${gate.checks
  .map(
    (c) =>
      `<tr><td>${e(c.name)}</td><td>${fmt(c.actual, isRateMetric(c.name))}</td><td>${fmt(c.threshold, isRateMetric(c.name))}</td>` +
      `<td class="${c.passed ? 'ok' : 'ko'}">${c.passed ? '✔' : '✘'}</td></tr>`,
  )
  .join('\n')}
</table></div>

<h2>By category</h2>
<div class="table-wrap"><table><tr><th>Category</th><th>Total</th><th>Passed</th><th>Pass rate</th></tr>
${Object.entries(m.byCategory)
  .map(
    ([cat, row]) =>
      `<tr><td>${e(cat)}</td><td>${row.total}</td><td>${row.passed}</td><td>${fmt(row.passRate, true)}</td></tr>`,
  )
  .join('\n')}
</table></div>

<h2>Test cases</h2>
<div class="filters">
  <button class="on" data-f="all">All</button><button data-f="failed">Failed</button><button data-f="error">Errors</button><button data-f="passed">Passed</button><button data-f="skipped">Skipped</button>
  <select id="cat" aria-label="Category"><option value="all">All categories</option>${categories
    .map((c) => `<option value="${e(c)}">${e(c)}</option>`)
    .join('')}</select>
  <input id="q" type="search" placeholder="Search id, title, tag" aria-label="Search">
</div>
<div class="table-wrap"><table id="cases">
<tr><th>ID</th><th>Category</th><th>Title</th><th>Status</th><th>Score</th><th>Time (ms)</th><th>Details</th></tr>
${report.results.map(caseRow).join('\n')}
</table></div>
</main>
<script>${SCRIPT}</script>
</body></html>
`;
}
