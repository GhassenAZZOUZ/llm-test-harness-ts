import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { USAGE, main } from '../../src/cli.js';
import { tempDir } from './helpers.js';

/** Run the CLI inside a throw-away copy of test_data + config. */
async function cli(argv: string[], env: Record<string, string> = {}) {
  const dir = tempDir(true);
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(
    argv,
    { out: (l) => out.push(l), err: (l) => err.push(l) },
    {
      LLM_DATA_DIR: path.join(dir, 'test_data'),
      LLM_CONFIG_DIR: path.join(dir, 'config'),
      LLM_REPORTS_DIR: path.join(dir, 'reports'),
      LLM_MOCK_RESPONSES: path.join(dir, 'test_data/mock/responses.yaml'),
      LLM_LOG_LEVEL: 'silent',
      ...env,
    },
  );
  return { code, out: out.join('\n'), err: err.join('\n'), dir };
}

describe('CLI', () => {
  it('prints usage', async () => {
    expect(await cli(['--help'])).toMatchObject({ code: 0, out: USAGE });
    expect((await cli([])).code).toBe(2);
    expect(await cli(['nope'])).toMatchObject({
      code: 2,
      err: expect.stringContaining('unknown command') as string,
    });
    expect((await cli(['run', '--bogus'])).code).toBe(2);
  });

  it('validate: counts valid cases per category', async () => {
    const r = await cli(['validate']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^OK: 41 valid test cases .*"regression":4/);
  });

  it('validate: reports invalid data with file and id', async () => {
    const dir = tempDir(true);
    writeFileSync(
      path.join(dir, 'test_data/cases/broken.yaml'),
      '- id: TC-999\n  category: functional\n',
    );
    const out: string[] = [];
    const code = await main(
      ['validate'],
      { out: (l) => out.push(l), err: (l) => out.push(l) },
      {
        LLM_DATA_DIR: path.join(dir, 'test_data'),
      },
    );
    expect(code).toBe(1);
    expect(out.join()).toMatch(/^INVALID: broken.yaml \[TC-999\]/);
  });

  it('run: baseline passes the gate and writes reports', async () => {
    const r = await cli(['run', '-c', 'safety', '--tag', 'refusal']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('[PASS] SAFE-001 safety');
    expect(r.out).not.toContain('SAFE-005'); // filtered out by tag
    expect(r.out).toContain('Quality gate: PASSED');
    expect(readFileSync(path.join(r.dir, 'reports/results.json'), 'utf8')).toContain('SAFE-001');
  });

  it('run: the faulty overlay fails the gate (regression, hallucination, format, safety)', async () => {
    const probe = tempDir(true);
    const r = await cli(['run'], {
      LLM_MOCK_RESPONSES: ['responses.yaml', 'faulty.yaml']
        .map((f) => path.join(probe, 'test_data/mock', f))
        .join(','),
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain('[FAIL] HAL-001');
    expect(r.out).toContain('[FAIL] REG-002');
    expect(r.out).toContain('[FAIL] INS-003');
    expect(r.out).toContain('[FAIL] SAFE-002');
    expect(r.out).toContain('[ERR ] FUN-005');
    expect(r.out).toContain('  - regressionFailures: actual=1 threshold=0');
  });

  it('run: rejects an unknown category', async () => {
    expect(await cli(['run', '-c', 'perf'])).toMatchObject({
      code: 2,
      err: expect.stringContaining('unknown category') as string,
    });
  });

  it('gate: re-evaluates a results.json', async () => {
    const run = await cli(['run', '-c', 'functional']);
    const results = path.join(run.dir, 'reports/results.json');
    const ok = await cli(['gate', results]);
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/OK {3}passRate +actual=100.0% threshold=90.0%/);

    const data = JSON.parse(readFileSync(results, 'utf8')) as { metrics: Record<string, unknown> };
    data.metrics.regressionFailures = 2;
    writeFileSync(results, JSON.stringify(data));
    const ko = await cli(['gate', results]);
    expect(ko.code).toBe(1);
    expect(ko.out).toContain('FAIL regressionFailures');
  });

  it('gate: reports a missing file as an error', async () => {
    expect((await cli(['gate'])).err).toMatch(/^ERROR: ENOENT/);
  });

  it('promote: appends REG-005 to regression.yaml and re-validates', async () => {
    const r = await cli(['promote', 'HAL-001', '--defect', 'GH-42']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^Added REG-005 .* \(defect GH-42\)$/);
    const file = path.join(r.dir, 'test_data/cases/regression.yaml');
    const cases = parseYaml(readFileSync(file, 'utf8')) as Record<string, unknown>[];
    expect(cases.at(-1)).toMatchObject({
      id: 'REG-005',
      category: 'regression',
      defect: 'GH-42',
      title: '[regression] Fictional company',
      tags: ['fictional-entity', 'from-hal-001', 'regression'],
      expected: { should_acknowledge_uncertainty: true },
    });
    expect(readFileSync(file, 'utf8')).toContain('# Regression suite'); // comments preserved
  });

  it('promote: validates arguments and unknown ids', async () => {
    expect((await cli(['promote', 'HAL-001'])).code).toBe(2);
    expect(await cli(['promote', 'NOPE-001', '--defect', 'X'])).toMatchObject({
      code: 1,
      err: 'unknown case id NOPE-001',
    });
  });

  it('promote: rolls back when the result would be invalid', async () => {
    const dir = tempDir(true);
    const regression = path.join(dir, 'test_data/cases/regression.yaml');
    // a second file already owning the next id makes the promoted case a duplicate
    writeFileSync(
      path.join(dir, 'test_data/cases/zz.yaml'),
      '- id: REG-005\n  category: regression\n  defect: X\n  title: Taken id\n  prompt: p\n  expected: { contains: [x] }\n',
    );
    const before = readFileSync(regression, 'utf8');
    const err: string[] = [];
    const code = await main(
      ['promote', 'FUN-001', '--defect', 'GH-1'],
      { out: () => undefined, err: (l) => err.push(l) },
      {
        LLM_DATA_DIR: path.join(dir, 'test_data'),
      },
    );
    expect(code).toBe(1);
    expect(err.join()).toMatch(/duplicate id REG-005/);
    expect(readFileSync(regression, 'utf8')).toBe(before);
  });
});
