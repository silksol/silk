// Token-aware chunking for retrieval. Pages are split on headings first, then
// on paragraph boundaries (fenced code blocks stay whole), then on sentences,
// and only as a last resort on words. Every chunk keeps the page URL, title
// and the heading path it sits under.

import { createHash } from 'node:crypto';
import { estimateTokens, wordCount } from './text.js';

export const CHUNK_DEFAULTS = { size: 512, overlap: 64 };

/** Split markdown-ish page text into sections, each with its heading path. */
export function sections(text) {
  const out = [];
  const path = []; // [{ level, title }]
  let current = { headingPath: [], lines: [] };
  let inFence = false;
  // A section that is only a heading (directly followed by a subheading) is dropped.
  const keep = (s) => s.lines.some((l, i) => l.trim() && !(i === 0 && s.headingPath.length));
  for (const line of String(text).split('\n')) {
    if (line.startsWith('```')) inFence = !inFence;
    const h = !inFence && line.match(/^(#{1,6})\s+(.+)$/);
    if (h) {
      if (keep(current)) out.push(current);
      const level = h[1].length;
      while (path.length && path[path.length - 1].level >= level) path.pop();
      path.push({ level, title: h[2].trim() });
      current = { headingPath: path.map((p) => p.title), lines: [line] };
    } else {
      current.lines.push(line);
    }
  }
  if (keep(current)) out.push(current);
  return out.map((s) => ({ headingPath: s.headingPath, text: s.lines.join('\n').trim() }));
}

/** Paragraph blocks; a fenced code block is one block even if it has blank lines. */
function blocks(text) {
  const out = [];
  let buf = [];
  let inFence = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) inFence = !inFence;
    if (!inFence && !line.trim()) {
      if (buf.length) out.push(buf.join('\n'));
      buf = [];
    } else {
      buf.push(line);
    }
  }
  if (buf.length) out.push(buf.join('\n'));
  return out;
}

const tokensOf = (s) => estimateTokens(wordCount(s));

/** Break one oversized block into pieces under `size` tokens: sentences, then words. */
function splitBlock(block, size) {
  const maxWords = Math.max(1, Math.floor(size / 1.33));
  const pieces = [];
  const parts = block.startsWith('```') ? block.split('\n') : block.split(/(?<=[.!?])\s+/);
  let buf = '';
  const flush = () => { if (buf.trim()) pieces.push(buf.trim()); buf = ''; };
  for (const part of parts) {
    if (tokensOf(part) > size) {
      flush();
      const words = part.split(/\s+/);
      for (let i = 0; i < words.length; i += maxWords) pieces.push(words.slice(i, i + maxWords).join(' '));
      continue;
    }
    const joiner = block.startsWith('```') ? '\n' : ' ';
    if (buf && tokensOf(buf + joiner + part) > size) flush();
    buf = buf ? buf + joiner + part : part;
  }
  flush();
  return pieces;
}

/** The last `tokens` worth of words from `text`, used to start the next chunk. */
function tail(text, tokens) {
  if (tokens <= 0) return '';
  const words = text.split(/\s+/);
  const n = Math.min(words.length, Math.max(1, Math.round(tokens / 1.33)));
  return words.slice(-n).join(' ');
}

/** Chunk the text of one section into strings of at most about `size` tokens. */
export function chunkText(text, { size = CHUNK_DEFAULTS.size, overlap = CHUNK_DEFAULTS.overlap } = {}) {
  validate(size, overlap);
  const units = blocks(text).flatMap((b) => (tokensOf(b) > size ? splitBlock(b, size) : [b]));
  const chunks = [];
  let buf = '';
  for (const unit of units) {
    if (buf && tokensOf(buf + '\n\n' + unit) > size) {
      chunks.push(buf);
      const carry = tail(buf, overlap);
      // Keep the overlap only if it leaves room for the next unit.
      buf = carry && tokensOf(carry + '\n\n' + unit) <= size ? carry + '\n\n' + unit : unit;
    } else {
      buf = buf ? buf + '\n\n' + unit : unit;
    }
  }
  if (buf.trim()) chunks.push(buf);
  return chunks;
}

function validate(size, overlap) {
  if (!Number.isFinite(size) || size < 16) throw new RangeError('size must be at least 16 tokens');
  if (!Number.isFinite(overlap) || overlap < 0 || overlap >= size) throw new RangeError('overlap must be between 0 and size - 1');
}

/**
 * Turn page records into chunk records.
 * @param {Iterable<object>} records records with url, title and text
 * @returns {object[]} { id, url, title, heading_path, chunk_index, text, words, tokens_est }
 */
export function chunkRecords(records, { size = CHUNK_DEFAULTS.size, overlap = CHUNK_DEFAULTS.overlap } = {}) {
  validate(size, overlap);
  const out = [];
  for (const rec of records) {
    if (!rec || typeof rec.text !== 'string') continue;
    const pageId = (rec.sha256 || createHash('sha256').update(rec.url + rec.text).digest('hex')).slice(0, 12);
    let index = 0;
    for (const section of sections(rec.text)) {
      for (const text of chunkText(section.text, { size, overlap })) {
        const words = wordCount(text);
        out.push({
          id: `${pageId}-${index}`,
          url: rec.url,
          title: rec.title || '',
          heading_path: section.headingPath,
          chunk_index: index++,
          text,
          words,
          tokens_est: estimateTokens(words),
        });
      }
    }
  }
  return out;
}
