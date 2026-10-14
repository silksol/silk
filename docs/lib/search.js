// The local search brain: a BM25 inverted index over chunk records, stored as
// one JSON file, plus an extractive answerer that picks the sentences sharing
// the most terms with the question.

import { tokenize, sentences } from './text.js';

export const INDEX_FORMAT = 'silk-index';
export const INDEX_VERSION = 1;
export const BM25 = { k1: 1.2, b: 0.75 };

/**
 * Build a BM25 index from chunk records ({ url, title, heading_path, text, ... }).
 * Titles and heading paths are indexed with the text so a question that names
 * a section finds it.
 */
export function buildIndex(chunks, { k1 = BM25.k1, b = BM25.b } = {}) {
  const docs = [];
  const postings = Object.create(null); // term -> [docIndex, tf, docIndex, tf, ...]
  let totalLen = 0;
  for (const c of chunks) {
    if (!c || typeof c.text !== 'string') continue;
    const headingPath = c.heading_path || [];
    const terms = tokenize([c.title || '', headingPath.join(' '), c.text].join('\n'));
    const tf = new Map();
    for (const t of terms) tf.set(t, (tf.get(t) || 0) + 1);
    const d = docs.length;
    for (const [term, n] of tf) (postings[term] ||= []).push(d, n);
    docs.push({
      id: c.id ?? String(d), url: c.url, title: c.title || '', heading_path: headingPath,
      chunk_index: c.chunk_index ?? 0, text: c.text, len: terms.length,
    });
    totalLen += terms.length;
  }
  return {
    format: INDEX_FORMAT,
    version: INDEX_VERSION,
    created_at: new Date().toISOString(),
    params: { k1, b },
    stats: { docs: docs.length, terms: Object.keys(postings).length, avgdl: docs.length ? totalLen / docs.length : 0 },
    docs,
    postings,
  };
}

export function assertIndex(index) {
  if (!index || index.format !== INDEX_FORMAT || !Array.isArray(index.docs) || !index.postings) {
    throw new Error('Not a silk index file (build one with "silk index chunks.jsonl")');
  }
  if (index.version > INDEX_VERSION) throw new Error(`Index version ${index.version} is newer than this silk supports`);
  return index;
}

/** Rank chunks for a query with BM25. Returns [{ score, ...doc }] best first. */
export function search(index, query, { k = 5 } = {}) {
  assertIndex(index);
  const { k1, b } = index.params;
  const N = index.docs.length;
  const avgdl = index.stats.avgdl || 1;
  const scores = new Map();
  for (const term of new Set(tokenize(query))) {
    const list = index.postings[term];
    if (!list) continue;
    const df = list.length / 2;
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    for (let i = 0; i < list.length; i += 2) {
      const d = list[i];
      const tf = list[i + 1];
      const norm = tf + k1 * (1 - b + (b * index.docs[d].len) / avgdl);
      scores.set(d, (scores.get(d) || 0) + idf * ((tf * (k1 + 1)) / norm));
    }
  }
  return [...scores]
    .sort((x, y) => y[1] - x[1] || x[0] - y[0])
    .slice(0, Math.max(1, k))
    .map(([d, score]) => {
      const { len, ...doc } = index.docs[d];
      return { score: Math.round(score * 1000) / 1000, ...doc };
    });
}

/**
 * Pick up to `max` sentences from the passages that share the most distinct
 * query terms. Earlier (higher ranked) passages win ties.
 */
export function extractiveAnswer(query, passages, { max = 3 } = {}) {
  const q = new Set(tokenize(query));
  if (!q.size) return '';
  const candidates = [];
  passages.forEach((p, rank) => {
    sentences(p.text).forEach((s, pos) => {
      const terms = new Set(tokenize(s));
      if (terms.size < 3) return; // headings and fragments
      let hits = 0;
      for (const t of q) if (terms.has(t)) hits++;
      if (!hits) return;
      candidates.push({ s, score: hits / q.size + 0.1 / (rank + 1) + 0.01 / (pos + 1), rank, pos });
    });
  });
  const seen = new Set();
  return candidates
    .sort((a, b) => b.score - a.score)
    .filter((c) => !seen.has(c.s) && seen.add(c.s))
    .slice(0, max)
    .sort((a, b) => a.rank - b.rank || a.pos - b.pos)
    .map((c) => c.s)
    .join(' ');
}

/** Search and answer in one call. */
export function ask(index, question, { k = 5 } = {}) {
  const passages = search(index, question, { k });
  return { question, answer: extractiveAnswer(question, passages), passages };
}
