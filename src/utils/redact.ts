/**
 * Secrets never reach logs or reports.
 *
 * `Secret` wraps the API key so that accidental `console.log(settings)`,
 * `JSON.stringify(settings)` or string interpolation prints a mask; `redact()` is the
 * belt-and-braces filter applied to every log line and provider error message.
 */
import { inspect } from 'node:util';

const MASK = '***REDACTED***';
const SECRET_PATTERN = /(sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9_\-.]{8,})/g;

export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** The only way to read the value. Grep for `reveal(` to audit usages. */
  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return MASK;
  }

  toJSON(): string {
    return MASK;
  }

  [inspect.custom](): string {
    return `Secret(${MASK})`;
  }
}

/** Mask anything that looks like an API key, plus any explicitly known secrets. */
export function redact(text: string, known: readonly string[] = []): string {
  let out = text.replace(SECRET_PATTERN, MASK);
  for (const secret of known) {
    if (secret.length >= 4) out = out.replaceAll(secret, MASK);
  }
  return out;
}
