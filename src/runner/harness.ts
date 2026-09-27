/**
 * Composition root: settings -> clients -> evaluator factory -> runner.
 *
 * Shared by the Playwright worker fixture and the CLI, so both entry points behave
 * identically. Reporting is deliberately NOT here: in Playwright the harness lives in
 * a worker while reports are written by the reporter in the main process.
 */
import path from 'node:path';
import type { LLMClient } from '../clients/base.js';
import { buildClient } from '../clients/factory.js';
import type { Settings } from '../config/settings.js';
import { EvaluatorFactory } from '../evaluators/factory.js';
import type { Embedder } from '../evaluators/heuristic.js';
import type { TestResult } from '../models/results.js';
import { type CaseFilter, PromptRenderer, loadCases } from '../utils/loader.js';
import type { TestCase } from '../models/test-case.js';
import { TestRunner } from './runner.js';

export interface HarnessOverrides {
  client?: LLMClient;
  judgeClient?: LLMClient;
  embedder?: Embedder;
}

export class Harness {
  readonly runner: TestRunner;

  private constructor(
    readonly settings: Settings,
    readonly client: LLMClient,
    readonly judgeClient: LLMClient,
    embedder?: Embedder,
  ) {
    const factory = new EvaluatorFactory({
      schemasDir: path.join(settings.dataDir, 'schemas'),
      judgeClient,
      ...(embedder && { embedder }),
    });
    this.runner = new TestRunner(
      client,
      factory,
      new PromptRenderer(path.join(settings.dataDir, 'prompts')),
    );
  }

  static create(settings: Settings, overrides: HarnessOverrides = {}): Harness {
    return new Harness(
      settings,
      overrides.client ?? buildClient(settings, 'target'),
      overrides.judgeClient ?? buildClient(settings, 'judge'),
      overrides.embedder,
    );
  }

  get casesDir(): string {
    return path.join(this.settings.dataDir, 'cases');
  }

  loadCases(filter: CaseFilter = {}): TestCase[] {
    return loadCases(this.casesDir, filter);
  }

  run(c: TestCase): Promise<TestResult> {
    return this.runner.run(c);
  }
}
