// File-level operations shared by the CLI, the MCP server and the dashboard:
// crawl to a JSONL file, chunk a dataset, build an index, ask an index.

import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { once } from 'node:events';
import { crawl } from './crawl.js';
import { chunkRecords } from './chunk.js';
import { buildIndex, ask, assertIndex } from './search.js';
import { readJsonl, writeJsonl, readJson, writeJson, knownFrom } from './dataset.js';
import { llmAnswer, llmProvider } from './llm.js';

/** The summary object printed by `silk <url> --json` and returned by MCP. */
export function crawlSummary(job, out) {
  const s = job.stats;
  return {
    pages: s.pages, words: s.words, tokens_est: s.tokens, fetched: s.fetched,
    sitemap: { files: s.sitemaps, urls: s.sitemapUrls },
    skipped: {
      robots: s.robotsSkipped, non_html: s.nonHtml, duplicates: s.duplicates, noindex: s.noindex,
      canonical: s.canonicalized, filtered: s.filtered, known: s.known,
    },
    errors: s.errors, error_samples: s.errorSamples, seconds: +(s.elapsedMs / 1000).toFixed(2), out: out ?? null,
  };
}

/**
 * Crawl `url` and stream records into a JSONL file (or a writable stream).
 * With `resume: true` the existing file is read first, its URLs and hashes are
 * skipped, and new records are appended.
 * @returns {Promise<{ job, summary, resumed }>}
 */
export async function crawlToFile(url, { out = 'dataset.jsonl', resume = false, stream = null, onRecord, onStart, ...options } = {}) {
  let resumed = 0;
  if (resume && !stream) {
    const known = await knownFrom(out);
    resumed = known.count;
    options.known = known;
  }
  const job = crawl(url, options);
  if (onStart) onStart(job);
  let sink = stream;
  if (!sink) {
    await mkdir(dirname(out), { recursive: true });
    sink = createWriteStream(out, { flags: resume ? 'a' : 'w' });
    await once(sink, 'open');
  }
  for await (const record of job) {
    if (onRecord) onRecord(record);
    if (!sink.write(JSON.stringify(record) + '\n')) await once(sink, 'drain');
  }
  if (!stream) {
    sink.end();
    await once(sink, 'finish');
  }
  return { job, summary: { ...crawlSummary(job, stream ? null : out), resumed }, resumed };
}

/** Read a dataset, chunk it, write chunks. */
export async function chunkFile(input, out, { size, overlap } = {}) {
  const records = await readJsonl(input);
  const chunks = chunkRecords(records, { size, overlap });
  await writeJsonl(out, chunks);
  const tokens = chunks.reduce((a, c) => a + c.tokens_est, 0);
  return {
    pages: records.length, chunks: chunks.length, out,
    avg_tokens: chunks.length ? Math.round(tokens / chunks.length) : 0,
    max_tokens: chunks.reduce((m, c) => Math.max(m, c.tokens_est), 0),
  };
}

/** Read chunks (or page records, which are indexed whole), build and save an index. */
export async function indexFile(input, out) {
  const chunks = await readJsonl(input);
  const index = buildIndex(chunks);
  await writeJson(out, index);
  return { docs: index.stats.docs, terms: index.stats.terms, avgdl: Math.round(index.stats.avgdl * 10) / 10, out };
}

export async function loadIndex(path) {
  return assertIndex(await readJson(path));
}

/** Ask a loaded index, optionally with a hosted model writing a cited answer. */
export async function askIndex(index, question, { k = 5, llm = false, env = process.env, fetch } = {}) {
  if (llm && !llmProvider(env)) throw new Error('--llm needs ANTHROPIC_API_KEY or OPENAI_API_KEY in the environment');
  const result = ask(index, question, { k });
  if (llm && result.passages.length) {
    const generated = await llmAnswer(question, result.passages, { env, fetch });
    result.llm = generated;
  }
  return result;
}
