// Dataset statistics for `silk stats`, the dataset card and the dashboard.

import { estimateTokens, wordCount } from './text.js';

/**
 * Summarise page records (or chunk records).
 * Duplicate rate counts records whose URL or text hash already appeared earlier.
 */
export function datasetStats(records, { top = 10 } = {}) {
  const domains = new Map();
  const urls = new Set();
  const hashes = new Set();
  let words = 0;
  let tokens = 0;
  let duplicates = 0;
  const lengths = [];
  let first = null;
  let last = null;
  for (const r of records) {
    const w = Number.isFinite(r.words) ? r.words : wordCount(r.text || '');
    words += w;
    tokens += Number.isFinite(r.tokens_est) ? r.tokens_est : estimateTokens(w);
    lengths.push(w);
    let host = '(invalid url)';
    try { host = new URL(r.url).host; } catch { /* keep placeholder */ }
    domains.set(host, (domains.get(host) || 0) + 1);
    const hash = r.sha256 || null;
    if (urls.has(r.url) || (hash && hashes.has(hash))) duplicates++;
    urls.add(r.url);
    if (hash) hashes.add(hash);
    if (r.fetched_at) {
      if (!first || r.fetched_at < first) first = r.fetched_at;
      if (!last || r.fetched_at > last) last = r.fetched_at;
    }
  }
  const n = lengths.length;
  lengths.sort((a, b) => a - b);
  const median = n ? (n % 2 ? lengths[(n - 1) / 2] : (lengths[n / 2 - 1] + lengths[n / 2]) / 2) : 0;
  return {
    pages: n,
    words,
    tokens_est: tokens,
    avg_words: n ? Math.round(words / n) : 0,
    median_words: median,
    min_words: n ? lengths[0] : 0,
    max_words: n ? lengths[n - 1] : 0,
    duplicates,
    duplicate_rate: n ? Math.round((duplicates / n) * 10000) / 10000 : 0,
    domains: domains.size,
    top_domains: [...domains].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, top).map(([domain, pages]) => ({ domain, pages })),
    fetched_from: first,
    fetched_to: last,
  };
}

const fmt = (n) => Number(n).toLocaleString('en-US');

/** Human-readable stats block for the terminal. */
export function formatStats(s, label = '') {
  const lines = [
    label ? `${label}` : null,
    `  pages          ${fmt(s.pages)}`,
    `  words          ${fmt(s.words)}`,
    `  est. tokens    ${fmt(s.tokens_est)}`,
    `  avg length     ${fmt(s.avg_words)} words (median ${fmt(s.median_words)}, min ${fmt(s.min_words)}, max ${fmt(s.max_words)})`,
    `  duplicates     ${fmt(s.duplicates)} (${(s.duplicate_rate * 100).toFixed(1)}%)`,
    `  domains        ${fmt(s.domains)}`,
    ...s.top_domains.map((d) => `    ${d.domain.padEnd(28)} ${fmt(d.pages)}`),
  ];
  return lines.filter((l) => l !== null).join('\n') + '\n';
}
