/** Minimal levelled logger on stderr. Every line goes through `redact()`. */
import { redact } from './redact.js';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

let threshold: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  threshold = level;
}

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export function createLogger(name: string, sink: (line: string) => void = defaultSink): Logger {
  const log = (level: Exclude<LogLevel, 'silent'>) => (msg: string) => {
    if (LOG_LEVELS.indexOf(level) < LOG_LEVELS.indexOf(threshold)) return;
    const time = new Date().toISOString().slice(11, 19);
    sink(redact(`${time} ${level.toUpperCase().padEnd(5)} ${name} | ${msg}`));
  };
  return { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
}

function defaultSink(line: string): void {
  process.stderr.write(`${line}\n`);
}
