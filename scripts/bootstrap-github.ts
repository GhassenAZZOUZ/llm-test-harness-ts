/**
 * Create the GitHub repo, labels, milestones and issues from .github/backlog.yaml,
 * push the code, then close implemented issues with a link to their commit.
 * Idempotent: re-running skips what already exists.
 *
 *   gh auth login                                        # once
 *   npx tsx scripts/bootstrap-github.ts --dry-run        # preview
 *   npx tsx scripts/bootstrap-github.ts                  # <login>/llm-test-harness, public
 *   npx tsx scripts/bootstrap-github.ts --repo me/other --private
 *
 * Implemented items are closed with a comment linking the oldest commit whose message
 * contains the trailer `Implements: <KEY>`.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { parse as parseYaml } from 'yaml';

const ROOT = path.resolve(import.meta.dirname, '..');
const DESCRIPTION =
  'LLM testing & evaluation framework on Playwright Test + TypeScript: YAML test cases, ' +
  'deterministic + heuristic + LLM-as-judge evaluators, custom reporter, metrics, mock mode, CI quality gate.';
const TOPICS = [
  'llm',
  'testing',
  'qa-automation',
  'playwright',
  'typescript',
  'llm-evaluation',
  'hallucination',
  'quality-gate',
  'github-actions',
  'gitlab-ci',
  'jenkins',
];

interface Backlog {
  labels: { name: string; color: string; description: string }[];
  milestones: { title: string; description: string }[];
  issues: {
    key: string;
    title: string;
    milestone: string;
    labels: string[];
    implemented: boolean;
    body: string;
  }[];
}

const { values: args } = parseArgs({
  options: {
    repo: { type: 'string' },
    private: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    'no-push': { type: 'boolean', default: false },
  },
});
const dryRun = args['dry-run'];

function run(cmd: string, cmdArgs: string[], { write = true, check = true } = {}): string {
  if (write && dryRun) {
    console.log(`DRY-RUN: ${cmd} ${cmdArgs.join(' ')}`);
    return '';
  }
  const res = spawnSync(cmd, cmdArgs, { cwd: ROOT, encoding: 'utf8' });
  if (check && res.status !== 0) {
    console.error(`command failed: ${cmd} ${cmdArgs.join(' ')}\n${res.stderr}`);
    process.exit(1);
  }
  return res.stdout;
}

const gh = (ghArgs: string[], opts?: { write?: boolean; check?: boolean }) =>
  run('gh', ghArgs, opts);
const git = (gitArgs: string[]) =>
  execFileSync('git', gitArgs, { cwd: ROOT, encoding: 'utf8' }).trim();

if (spawnSync('gh', ['auth', 'status']).status !== 0) {
  console.error('gh is not authenticated: run `gh auth login` first');
  process.exit(1);
}
const login = gh(['api', 'user', '-q', '.login'], { write: false }).trim();
const repo = args.repo ?? `${login}/llm-test-harness`;
const backlog = parseYaml(readFileSync(path.join(ROOT, '.github/backlog.yaml'), 'utf8')) as Backlog;

// 1. repository ---------------------------------------------------------------
const exists = spawnSync('gh', ['repo', 'view', repo]).status === 0;
if (exists) {
  console.log(`repo ${repo} exists`);
} else {
  gh([
    'repo',
    'create',
    repo,
    args.private ? '--private' : '--public',
    '--description',
    DESCRIPTION,
    '--disable-wiki',
  ]);
  console.log(`${dryRun ? 'would create' : 'created'} repo ${repo}`);
}
gh(['repo', 'edit', repo, ...TOPICS.map((t) => `--add-topic=${t}`)]);

// 2. labels -------------------------------------------------------------------
for (const l of backlog.labels) {
  gh([
    'label',
    'create',
    l.name,
    '--repo',
    repo,
    '--color',
    l.color,
    '--description',
    l.description,
    '--force',
  ]);
}
console.log(`labels: ${backlog.labels.length} ensured`);

// 3. milestones ---------------------------------------------------------------
const existingMilestones = new Set<string>(
  dryRun && !exists
    ? []
    : (
        JSON.parse(
          gh(['api', `repos/${repo}/milestones?state=all`, '--paginate'], { write: false }) || '[]',
        ) as { title: string }[]
      ).map((m) => m.title),
);
for (const ms of backlog.milestones) {
  if (existingMilestones.has(ms.title)) continue;
  gh([
    'api',
    '-X',
    'POST',
    `repos/${repo}/milestones`,
    '-f',
    `title=${ms.title}`,
    '-f',
    `description=${ms.description}`,
    '--silent',
  ]);
  console.log(`milestone created: ${ms.title}`);
}

// 4. push code (so issues can link commits) -------------------------------------
if (!args['no-push']) {
  const remote = `https://github.com/${repo}.git`;
  if (dryRun) {
    console.log(`DRY-RUN: git push -u origin main (${remote})`);
  } else {
    if (!git(['remote']).split(/\s+/).includes('origin')) git(['remote', 'add', 'origin', remote]);
    run('git', ['push', '-u', 'origin', 'main']);
  }
}

// 5. issues -------------------------------------------------------------------
const existingIssues = new Map<string, { number: number | string; state: string }>();
if (!(dryRun && !exists)) {
  const out = gh(
    [
      'issue',
      'list',
      '--repo',
      repo,
      '--state',
      'all',
      '--limit',
      '500',
      '--json',
      'number,title,state',
    ],
    { write: false },
  );
  for (const i of JSON.parse(out || '[]') as { number: number; title: string; state: string }[]) {
    existingIssues.set(i.title, i);
  }
}

for (const item of backlog.issues) {
  const title = `[${item.key}] ${item.title}`;
  let issue = existingIssues.get(title);
  if (!issue) {
    const url = gh([
      'issue',
      'create',
      '--repo',
      repo,
      '--title',
      title,
      '--body',
      item.body,
      '--milestone',
      item.milestone,
      ...item.labels.flatMap((l) => ['--label', l]),
    ]);
    const number = url.trim().split('/').at(-1) || '?';
    console.log(`issue #${number} created: ${title}`);
    issue = { number, state: 'OPEN' };
  }
  if (item.implemented && issue.state === 'OPEN' && !args['no-push']) {
    // oldest commit mentioning the key = the one that implemented it
    const shas = git(['log', '--format=%H', '-E', `--grep=Implements:.*\\b${item.key}\\b`])
      .split('\n')
      .filter(Boolean);
    const sha = shas.at(-1) ?? git(['rev-parse', 'HEAD']);
    gh([
      'issue',
      'close',
      String(issue.number),
      '--repo',
      repo,
      '--reason',
      'completed',
      '--comment',
      `Implemented in https://github.com/${repo}/commit/${sha}`,
    ]);
    console.log(`issue ${title} closed (${sha.slice(0, 7)})`);
  }
}

console.log(`\nDone: https://github.com/${repo}`);
console.log(
  'Next: Settings > Environments > create `llm-live`, add the LLM_API_KEY secret there (optional, live runs).',
);
