/** Shared value formatting for the Markdown / HTML / console outputs. */

export function isRateMetric(name: string): boolean {
  return name.endsWith('Rate');
}

export function fmt(value: number | null | undefined, pct = false): string {
  if (value == null) return 'n/a';
  if (pct) return `${(value * 100).toFixed(1)}%`;
  if (Number.isInteger(value)) return value.toLocaleString('en-US');
  return String(Math.round(value * 1e4) / 1e4);
}

export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
