/**
 * Small, dependency-free text utilities used by the heuristic evaluators.
 *
 * Intentionally simple and deterministic (bag-of-words cosine, token-overlap support):
 * a cheap, reproducible first filter. Swap in embeddings through the `Embedder`
 * interface when real semantic similarity is needed.
 */

export const STOPWORDS: ReadonlySet<string> = new Set(
  (
    'a an and are as at be been but by can could did do does for from had has have he her ' +
    'his i if in into is it its me my no not of on or our she so than that the their them ' +
    'then there these they this to was we were what when where which who why will with ' +
    'would you your about also any just more most only other some such very'
  ).split(' '),
);

const WORD = /[\p{L}\p{M}\p{N}]+/gu;
const SENTENCE = /(?<=[.!?])\s+|\n+/;
const FENCE = /```(?:json)?\s*([\s\S]*?)```/gi;

/** NFKC, lower-case, collapse whitespace. */
export function normalize(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function tokenize(text: string): string[] {
  return normalize(text).match(WORD) ?? [];
}

/** Extremely light stemming, enough to match "capital" / "capitals". */
function stem(token: string): string {
  for (const suffix of ['ing', 'ed', 'es', 's']) {
    if (token.length > suffix.length + 2 && token.endsWith(suffix)) {
      return token.slice(0, -suffix.length);
    }
  }
  return token;
}

export function contentTokens(text: string): string[] {
  return tokenize(text)
    .filter((t) => !STOPWORDS.has(t) && [...t].length > 1)
    .map(stem);
}

function counts(tokens: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

export function cosineSimilarity(a: string, b: string): number {
  const va = counts(contentTokens(a));
  const vb = counts(contentTokens(b));
  if (va.size === 0 || vb.size === 0) return 0;
  let dot = 0;
  for (const [t, n] of va) dot += n * (vb.get(t) ?? 0);
  const norm = (v: Map<string, number>) =>
    Math.sqrt([...v.values()].reduce((s, n) => s + n * n, 0));
  return dot / (norm(va) * norm(vb));
}

export function splitSentences(text: string): string[] {
  return text
    .split(SENTENCE)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** Parse JSON from a raw response, tolerating ```json fences and leading prose. */
export function extractJson(text: string): unknown {
  const candidates = [...text.matchAll(FENCE)].map((m) => m[1] ?? '').concat(text);
  for (const raw of candidates) {
    const candidate = raw.trim();
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // fall back to the first {...} or [...] block
    }
    for (const [open, close] of [
      ['{', '}'],
      ['[', ']'],
    ] as const) {
      const start = candidate.indexOf(open);
      const end = candidate.lastIndexOf(close);
      if (start >= 0 && start < end) {
        try {
          return JSON.parse(candidate.slice(start, end + 1)) as unknown;
        } catch {
          continue;
        }
      }
    }
  }
  throw new SyntaxError('no valid JSON found in response');
}

/** Return the first phrase found in `text` (normalised), else null. */
export function containsPhrase(text: string, phrases: readonly string[]): string | null {
  const haystack = normalize(text).replaceAll('’', "'");
  return phrases.find((p) => haystack.includes(normalize(p))) ?? null;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
