#!/usr/bin/env node
// `npx llm-harness ...`: run the TypeScript CLI through tsx (no build step).
import { register } from 'tsx/esm/api';

register();
const { loadDotEnv } = await import('../src/config/settings.ts');
const { main } = await import('../src/cli.ts');
loadDotEnv();
process.exitCode = await main(process.argv.slice(2));
