// Export a crawled dataset as clean JSONL, a folder of Markdown files, or a
// Hugging Face style dataset folder (data/train.jsonl plus a README.md card).

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJsonl } from './dataset.js';
import { datasetStats } from './stats.js';
import { VERSION } from './crawl.js';

export const EXPORT_FORMATS = ['jsonl', 'markdown', 'hf'];

/** Drop records that repeat an earlier URL or text hash and add a stable id. */
export function cleanRecords(records) {
  const urls = new Set();
  const hashes = new Set();
  const out = [];
  for (const r of records) {
    if (!r || typeof r.text !== 'string' || !r.url) continue;
    if (urls.has(r.url) || (r.sha256 && hashes.has(r.sha256))) continue;
    urls.add(r.url);
    if (r.sha256) hashes.add(r.sha256);
    out.push({ id: (r.sha256 || String(out.length)).slice(0, 16), ...r });
  }
  return out;
}

/** File name for a page: host and path folded into a readable slug. */
export function slugFor(url) {
  let u;
  try { u = new URL(url); } catch { return 'page'; }
  const path = (u.pathname + (u.search ? '-' + u.search.slice(1) : ''))
    .replace(/\.(html?|php|aspx?)$/i, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return (path || 'index').slice(0, 120);
}

const yamlString = (s) => JSON.stringify(String(s ?? ''));

function toMarkdown(r) {
  const front = [
    '---',
    `title: ${yamlString(r.title)}`,
    `url: ${yamlString(r.url)}`,
    r.fetched_at ? `fetched_at: ${yamlString(r.fetched_at)}` : null,
    Number.isFinite(r.words) ? `words: ${r.words}` : null,
    r.sha256 ? `sha256: ${yamlString(r.sha256)}` : null,
    '---',
  ].filter((l) => l !== null);
  // Pages usually start with their own h1; add the title only when they do not.
  const body = /^#\s/.test(r.text) ? r.text : `# ${r.title || r.url}\n\n${r.text}`;
  return front.join('\n') + '\n\n' + body + '\n';
}

function sizeCategory(n) {
  if (n < 1e3) return 'n<1K';
  if (n < 1e4) return '1K<n<10K';
  if (n < 1e5) return '10K<n<100K';
  if (n < 1e6) return '100K<n<1M';
  return '1M<n<10M';
}

/** A Hugging Face dataset card (README.md with YAML metadata) describing the export. */
export function datasetCard(records, { name = 'silk-dataset', stats = datasetStats(records) } = {}) {
  const fmt = (n) => Number(n).toLocaleString('en-US');
  const domains = stats.top_domains.map((d) => `| ${d.domain} | ${fmt(d.pages)} |`).join('\n');
  return `---
pretty_name: ${yamlString(name)}
size_categories:
- ${sizeCategory(stats.pages)}
task_categories:
- text-generation
- question-answering
tags:
- web-crawl
- rag
- silk
configs:
- config_name: default
  data_files:
  - split: train
    path: data/train.jsonl
---

# ${name}

Web pages collected with [silk](https://github.com/OWNER/silk) ${VERSION}. Each row is one page:
navigation, footers, scripts and other boilerplate are removed and the text keeps
markdown-style headings, lists and fenced code blocks.

## Statistics

| Metric | Value |
| --- | --- |
| Pages | ${fmt(stats.pages)} |
| Words | ${fmt(stats.words)} |
| Estimated tokens (words x 1.33) | ${fmt(stats.tokens_est)} |
| Average words per page | ${fmt(stats.avg_words)} |
| Median words per page | ${fmt(stats.median_words)} |
| Domains | ${fmt(stats.domains)} |
${stats.fetched_from ? `| Collected | ${stats.fetched_from.slice(0, 10)} to ${stats.fetched_to.slice(0, 10)} |\n` : ''}
## Sources

| Domain | Pages |
| --- | --- |
${domains}

## Fields

| Field | Type | Description |
| --- | --- | --- |
| \`id\` | string | First 16 hex characters of \`sha256\`. |
| \`url\` | string | Final URL after redirects. |
| \`title\` | string | Page title. |
| \`text\` | string | Clean page text with markdown-style structure. |
| \`headings\` | list of strings | h1 to h6 texts in document order. |
| \`words\` | int | Word count of \`text\`. |
| \`tokens_est\` | int | \`round(words * 1.33)\`, an estimate. |
| \`fetched_at\` | string | ISO 8601 fetch time. |
| \`sha256\` | string | SHA-256 of \`text\`. |

## Collection

The crawler honoured robots.txt (including Crawl-delay), \`noindex\` and \`nofollow\`
directives and canonical links, and removed exact duplicates by text hash.

## License

The text belongs to the owners of the source sites. Check their terms before
redistributing this dataset, and set a \`license\` field in the metadata above.
`;
}

/**
 * Export records. Returns { format, out, files, pages }.
 * - jsonl:    `out` is a file
 * - markdown: `out` is a folder, one .md per page
 * - hf:       `out` is a folder with README.md and data/train.jsonl
 */
export async function exportDataset(records, { format = 'jsonl', out, name } = {}) {
  if (!EXPORT_FORMATS.includes(format)) throw new Error(`Unknown format "${format}" (expected ${EXPORT_FORMATS.join(', ')})`);
  if (!out) throw new Error('Missing output path');
  const clean = cleanRecords(records);
  if (format === 'jsonl') {
    await writeJsonl(out, clean);
    return { format, out, files: 1, pages: clean.length };
  }
  await mkdir(out, { recursive: true });
  if (format === 'markdown') {
    const used = new Map();
    for (const r of clean) {
      const base = slugFor(r.url);
      const n = used.get(base) || 0;
      used.set(base, n + 1);
      await writeFile(join(out, `${n ? `${base}-${n + 1}` : base}.md`), toMarkdown(r));
    }
    return { format, out, files: clean.length, pages: clean.length };
  }
  await writeJsonl(join(out, 'data', 'train.jsonl'), clean);
  await writeFile(join(out, 'README.md'), datasetCard(clean, { name }));
  return { format, out, files: 2, pages: clean.length };
}
