/**
 * Test cases are shared with the Python version, so their regexes use Python syntax.
 * JavaScript lacks a few of its constructs; translate them instead of rewriting the YAML:
 *
 *   \A  -> (?<![\s\S])   start of input (independent of the `m` flag)
 *   \Z  -> (?![\s\S])    end of input
 *   (?i) at the start  -> `i` flag
 */
export function toJsRegExp(pattern: string, { caseSensitive = false } = {}): RegExp {
  let source = pattern;
  let ignoreCase = !caseSensitive;
  if (source.startsWith('(?i)')) {
    source = source.slice(4);
    ignoreCase = true;
  }
  let out = '';
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\\' && i + 1 < source.length) {
      const next = source[i + 1];
      if (next === 'A') out += '(?<![\\s\\S])';
      else if (next === 'Z' || next === 'z') out += '(?![\\s\\S])';
      else out += ch + next;
      i++;
      continue;
    }
    out += ch;
  }
  // `m` mirrors Python's re.MULTILINE. No `u` flag: it rejects identity escapes such as
  // `\-` that Python accepts.
  return new RegExp(out, `m${ignoreCase ? 'i' : ''}`);
}
