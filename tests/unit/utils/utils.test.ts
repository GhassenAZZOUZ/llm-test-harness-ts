import { inspect } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger, setLogLevel } from '../../../src/utils/logger.js';
import { Secret, redact } from '../../../src/utils/redact.js';
import { toJsRegExp } from '../../../src/utils/regex.js';
import {
  containsPhrase,
  contentTokens,
  cosineSimilarity,
  countWords,
  extractJson,
  normalize,
  splitSentences,
  truncate,
} from '../../../src/utils/text.js';

describe('toJsRegExp (Python regex syntax used by the shared YAML cases)', () => {
  it('translates \\A and \\Z to input anchors independent of multiline mode', () => {
    const re = toJsRegExp('\\A(?:[-*] [^\\n]+\\n?){3}\\Z');
    expect(re.test('- Red\n- Yellow\n- Blue')).toBe(true);
    expect(re.test('Intro\n- Red\n- Yellow\n- Blue')).toBe(false);
    expect(toJsRegExp('\\A\\s*\\{').test('Sure! {"a": 1}')).toBe(false);
    expect(toJsRegExp('end\\z').test('the end')).toBe(true);
  });

  it('keeps escaped backslashes and other escapes intact', () => {
    expect(toJsRegExp('a\\\\A').test('a\\A')).toBe(true);
    expect(toJsRegExp('\\d+').test('42')).toBe(true);
  });

  it('is case-insensitive by default, honours caseSensitive and a leading (?i)', () => {
    expect(toJsRegExp('paris').test('PARIS')).toBe(true);
    expect(toJsRegExp('paris', { caseSensitive: true }).test('PARIS')).toBe(false);
    expect(toJsRegExp('(?i)step\\s*1', { caseSensitive: true }).test('STEP 1')).toBe(true);
  });

  it('uses multiline anchors like Python re.MULTILINE', () => {
    expect(toJsRegExp('^Tokyo$').test('city:\nTokyo')).toBe(true);
  });
});

describe('text utilities', () => {
  it('normalizes and tokenizes Unicode text', () => {
    expect(normalize('  Ｈello\n  World ')).toBe('hello world');
    expect(contentTokens('The capitals of France are cities')).toEqual([
      'capital',
      'france',
      'citi',
    ]);
    expect(contentTokens('ما هي عاصمة اليابان')).toContain('عاصمة');
  });

  it('computes bag-of-words cosine similarity', () => {
    expect(cosineSimilarity('Paris is the capital', 'the capital is Paris')).toBeCloseTo(1);
    expect(cosineSimilarity('apples', 'kubernetes')).toBe(0);
    expect(cosineSimilarity('', 'x y')).toBe(0);
  });

  it('splits sentences and counts words', () => {
    expect(splitSentences('One. Two!  Three?\nFour')).toEqual(['One.', 'Two!', 'Three?', 'Four']);
    expect(splitSentences('   ')).toEqual([]);
    expect(countWords('  a  b\nc ')).toBe(3);
  });

  it('extracts JSON from fences, prose and arrays', () => {
    expect(extractJson('{"a": 1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a": 2}\n```')).toEqual({ a: 2 });
    expect(extractJson('Sure! Here it is: {"a": 3} hope it helps')).toEqual({ a: 3 });
    expect(extractJson('list: [1, 2]')).toEqual([1, 2]);
    expect(() => extractJson('no json {here')).toThrow(/no valid JSON/);
    expect(() => extractJson('{bad} and [also bad]')).toThrow();
  });

  it('finds phrases with curly apostrophes', () => {
    expect(containsPhrase('I don’t know.', ["i don't know"])).toBe("i don't know");
    expect(containsPhrase('Paris.', ['london'])).toBeNull();
  });

  it('truncates long text', () => {
    expect(truncate('abcdef', 3)).toBe('abc…');
    expect(truncate('abc', 3)).toBe('abc');
  });
});

describe('secret handling', () => {
  it('Secret never prints its value', () => {
    const key = new Secret('sk-supersecretvalue123');
    expect(String(key)).toBe('***REDACTED***');
    expect(JSON.stringify({ key })).toBe('{"key":"***REDACTED***"}');
    expect(inspect({ key })).not.toContain('supersecret');
    expect(key.reveal()).toBe('sk-supersecretvalue123');
  });

  it('redact masks key-like strings and known secrets', () => {
    expect(redact('Authorization: Bearer abcdefghijkl')).toBe('Authorization: ***REDACTED***');
    expect(redact('key sk-abcdefghijkl')).toBe('key ***REDACTED***');
    expect(redact('custom key ollama-1234 here', ['ollama-1234'])).toBe(
      'custom key ***REDACTED*** here',
    );
    expect(redact('abc', ['abc'])).toBe('abc'); // too short to be a secret
  });
});

describe('logger', () => {
  afterEach(() => setLogLevel('silent'));

  it('filters by level and redacts every line', () => {
    const lines: string[] = [];
    const log = createLogger('test', (l) => lines.push(l));
    setLogLevel('warn');
    log.debug('hidden');
    log.info('hidden');
    log.warn('token sk-abcdefghijklmnop');
    log.error('boom');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/WARN {2}test \| token \*\*\*REDACTED\*\*\*/);
    expect(lines[1]).toContain('ERROR test | boom');
  });

  it('can be silenced', () => {
    const lines: string[] = [];
    setLogLevel('silent');
    createLogger('t', (l) => lines.push(l)).error('x');
    expect(lines).toEqual([]);
  });
});
