/**
 * Command-line interface (runs without Playwright).
 *
 *   llm-harness validate                        schema-check all YAML test cases
 *   llm-harness run [-c safety] [-t smoke]      run cases, write reports, evaluate the gate
 *   llm-harness gate [reports/results.json]     re-evaluate the quality gate (CI)
 *   llm-harness promote TC-042 --defect GH-17   turn a case into a regression case
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { stringify as stringifyYaml } from 'yaml';
import { loadQualityGate } from './config/files.js';
import { type Settings, loadDotEnv, loadSettings } from './config/settings.js';
import type { Metrics } from './metrics/collector.js';
import { evaluateGate, gateViolations } from './metrics/gate.js';
import type { Status } from './models/results.js';
import { CATEGORIES, type Category } from './models/test-case.js';
import { fmt, isRateMetric } from './reporting/format.js';
import { buildReport, createRunMetadata, writeReports } from './reporting/report.js';
import { Harness, type HarnessOverrides } from './runner/harness.js';
import { setLogLevel } from './utils/logger.js';
import { TestDataError, listCaseFiles, loadCases, readYaml } from './utils/loader.js';

export const USAGE = `Usage: llm-harness <command> [options]

Commands:
  validate                          validate YAML test cases
  run [-c <category>]... [-t <tag>]...
                                    run cases without Playwright, write reports, evaluate the gate
  gate [results.json]               evaluate the quality gate on a results file
  promote <CASE-ID> --defect <REF>  copy a case into regression.yaml as REG-00N

Categories: ${CATEGORIES.join(', ')}`;

export interface CliIO {
  out: (line: string) => void;
  err: (line: string) => void;
}

const defaultIO: CliIO = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

const MARK: Record<Status, string> = {
  passed: 'PASS',
  failed: 'FAIL',
  error: 'ERR ',
  skipped: 'SKIP',
};

function cmdValidate(settings: Settings, io: CliIO): number {
  const cases = loadCases(path.join(settings.dataDir, 'cases'));
  const byCategory: Record<string, number> = {};
  for (const c of cases) byCategory[c.category] = (byCategory[c.category] ?? 0) + 1;
  io.out(`OK: ${cases.length} valid test cases ${JSON.stringify(byCategory)}`);
  return 0;
}

async function cmdRun(
  settings: Settings,
  categories: Category[],
  tags: string[],
  io: CliIO,
  overrides: HarnessOverrides,
): Promise<number> {
  const harness = Harness.create(settings, overrides);
  const cases = harness.loadCases({ categories, tags });
  const metadata = createRunMetadata(settings);
  const results = [];
  for (const c of [...cases].sort((a, b) => a.id.localeCompare(b.id))) {
    const result = await harness.run(c);
    results.push(result);
    let line = `[${MARK[result.status]}] ${c.id.padEnd(8)} ${c.category.padEnd(22)} ${c.title}`;
    if (result.failureReason && result.status !== 'skipped') {
      line += `\n        -> ${result.failureReason}`;
    }
    io.out(line);
  }
  const report = buildReport(results, metadata, settings);
  const paths = writeReports(report, settings.reportsDir);
  io.out('');
  io.out(`Reports: ${paths.html} | ${paths.json} | ${paths.markdown}`);
  printGate(report.qualityGate, io, false);
  return report.qualityGate.passed ? 0 : 1;
}

function printGate(gate: ReturnType<typeof evaluateGate>, io: CliIO, all: boolean): void {
  const shown = all ? gate.checks : gateViolations(gate);
  if (all) {
    for (const c of shown) {
      const pct = isRateMetric(c.name);
      io.out(
        `${c.passed ? 'OK  ' : 'FAIL'} ${c.name.padEnd(28)} actual=${fmt(c.actual, pct)} threshold=${fmt(c.threshold, pct)}`,
      );
    }
  }
  io.out(`Quality gate: ${gate.passed ? 'PASSED' : 'FAILED'}`);
  if (!all) {
    for (const c of shown) {
      const pct = isRateMetric(c.name);
      io.out(`  - ${c.name}: actual=${fmt(c.actual, pct)} threshold=${fmt(c.threshold, pct)}`);
    }
  }
}

function cmdGate(settings: Settings, resultsFile: string, io: CliIO): number {
  const data = JSON.parse(readFileSync(resultsFile, 'utf8')) as { metrics: Metrics };
  const gate = evaluateGate(
    data.metrics,
    loadQualityGate(path.join(settings.configDir, 'quality_gate.yaml')),
  );
  printGate(gate, io, true);
  return gate.passed ? 0 : 1;
}

/** Copy an existing case into regression.yaml so the defect stays covered forever. */
function cmdPromote(settings: Settings, caseId: string, defect: string, io: CliIO): number {
  const casesDir = path.join(settings.dataDir, 'cases');
  loadCases(casesDir); // refuse to promote from an invalid suite
  const source = listCaseFiles(casesDir)
    .flatMap((file) => {
      const raw = readYaml(file);
      return Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
    })
    .find((item) => item.id === caseId);
  if (!source) {
    io.err(`unknown case id ${caseId}`);
    return 1;
  }

  const target = path.join(casesDir, 'regression.yaml');
  let original = '';
  try {
    original = readFileSync(target, 'utf8');
  } catch {
    // first regression case
  }
  const existing = (readYamlSafe(target) ?? []) as { id?: unknown }[];
  const numbers = existing
    .map((c) => /^REG-(\d+)$/.exec(typeof c.id === 'string' ? c.id : '')?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number);
  const newId = `REG-${String(Math.max(0, ...numbers) + 1).padStart(3, '0')}`;
  const tags = Array.isArray(source.tags) ? (source.tags as string[]) : [];
  const promoted = {
    ...source,
    id: newId,
    category: 'regression',
    title: `[regression] ${String(source.title)}`,
    defect,
    tags: [...new Set([...tags, 'regression', `from-${caseId.toLowerCase()}`])].sort(),
  };

  const separator = original && !original.endsWith('\n') ? '\n\n' : '\n';
  writeFileSync(target, original + separator + stringifyYaml([promoted], { lineWidth: 0 }), 'utf8');
  try {
    loadCases(casesDir); // re-validate everything
  } catch (err) {
    writeFileSync(target, original, 'utf8'); // roll back: never leave the suite invalid
    throw err;
  }
  io.out(`Added ${newId} to ${target} (defect ${defect})`);
  return 0;
}

function readYamlSafe(file: string): unknown {
  try {
    return readYaml(file);
  } catch {
    return null;
  }
}

export async function main(
  argv: string[],
  io: CliIO = defaultIO,
  env: NodeJS.ProcessEnv = process.env,
  overrides: HarnessOverrides = {},
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        category: { type: 'string', short: 'c', multiple: true, default: [] },
        tag: { type: 'string', short: 't', multiple: true, default: [] },
        defect: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    io.err(`${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;
  if (values.help || !command) {
    io.out(USAGE);
    return values.help ? 0 : 2;
  }

  try {
    const settings = loadSettings(env);
    setLogLevel(settings.logLevel);
    switch (command) {
      case 'validate':
        return cmdValidate(settings, io);
      case 'run': {
        const unknown = values.category.filter(
          (c) => !(CATEGORIES as readonly string[]).includes(c),
        );
        if (unknown.length) {
          io.err(
            `unknown category: ${unknown.join(', ')} (expected one of ${CATEGORIES.join(', ')})`,
          );
          return 2;
        }
        return await cmdRun(settings, values.category as Category[], values.tag, io, overrides);
      }
      case 'gate':
        return cmdGate(settings, rest[0] ?? path.join(settings.reportsDir, 'results.json'), io);
      case 'promote':
        if (!rest[0] || !values.defect) {
          io.err('usage: llm-harness promote <CASE-ID> --defect <REF>');
          return 2;
        }
        return cmdPromote(settings, rest[0], values.defect, io);
      default:
        io.err(`unknown command: ${command}\n\n${USAGE}`);
        return 2;
    }
  } catch (err) {
    const prefix = err instanceof TestDataError ? 'INVALID' : 'ERROR';
    io.err(`${prefix}: ${(err as Error).message}`);
    return 1;
  }
}

/* c8 ignore start -- entry point */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadDotEnv();
  process.exitCode = await main(process.argv.slice(2));
}
/* c8 ignore stop */
