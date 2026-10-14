// Text utilities for chunking and search: token estimates, a search
// tokenizer with stopwords and light suffix stemming, and a sentence splitter.

/** Token estimate used everywhere in silk: words * 1.33, rounded. */
export const estimateTokens = (words) => Math.round(words * 1.33);

export const wordCount = (text) => (String(text).match(/\S+/g) || []).length;

// Common English function words. Small on purpose: BM25's IDF already
// discounts frequent terms, this list only removes pure noise.
export const STOPWORDS = new Set(`a about above after again against all am an and any are as at be because been
before being below between both but by can could did do does doing down during each few for from further had has
have having he her here hers him his how i if in into is it its itself just me more most my no nor not of off on once
only or other our ours out over own same she should so some such than that the their theirs them then there these
they this those through to too under until up very was we were what when where which while who whom why will with
would you your yours`.split(/\s+/));

// Suffix rules, tried in order; the first one that leaves a stem of at least
// three characters wins. A deliberately small cousin of the Porter stemmer.
const SUFFIXES = [
  ['ational', 'ate'], ['ization', 'ize'], ['fulness', 'ful'], ['iveness', 'ive'], ['ations', 'ate'], ['ation', 'ate'],
  ['ments', ''], ['ment', ''], ['ness', ''], ['ingly', ''], ['ings', ''], ['ing', ''], ['edly', ''], ['ies', 'y'],
  ['sses', 'ss'], ['ied', 'y'], ['ed', ''], ['ly', ''], ['ers', ''], ['er', ''], ['es', ''], ['s', ''],
];

/** Reduce an English word to a stem so "crawling", "crawled" and "crawls" match. */
export function stem(word) {
  let w = word;
  if (w.length <= 3 || /\d/.test(w)) return w;
  for (const [suffix, repl] of SUFFIXES) {
    if (!w.endsWith(suffix)) continue;
    if (suffix === 's' && /(ss|us|is)$/.test(w)) break;
    const candidate = w.slice(0, -suffix.length) + repl;
    if (candidate.length >= 3) {
      w = candidate;
      break;
    }
  }
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
  // "running" -> "runn" -> "run"
  if (/([^aeiouslz])\1$/.test(w) && w.length > 3) w = w.slice(0, -1);
  return w;
}

/**
 * Search tokens: lowercase words and numbers, stopwords removed, stemmed.
 * camelCase and snake_case identifiers also yield their parts, so
 * "clearCache()" matches a question about clearing the cache.
 */
export function tokenize(text) {
  const out = [];
  const push = (word) => {
    const t = word.toLowerCase().replace(/'s$/, '').replace(/'/g, '');
    if (t.length < 2 && !/\d/.test(t)) return;
    if (STOPWORDS.has(t)) return;
    out.push(stem(t));
  };
  for (const raw of String(text).match(/[\p{L}\p{N}]+(?:['_.][\p{L}\p{N}]+)*/gu) || []) {
    push(raw);
    const parts = raw.replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2').split(/[\s_.]+/);
    if (parts.length > 1) for (const p of parts) push(p);
  }
  return out;
}

/** Split prose into sentences. Code fences, heading markers and list bullets are removed first. */
export function sentences(text) {
  const prose = String(text)
    .replace(/```[\s\S]*?(```|$)/g, '\n')
    .split('\n')
    .map((l) => l.replace(/^#{1,6}\s+/, '').replace(/^[-*]\s+/, '').trim())
    .filter(Boolean);
  const out = [];
  for (const line of prose) {
    for (const s of line.split(/(?<=[.!?])\s+(?=[\p{Lu}\p{N}"'(`])/u)) {
      const t = s.trim();
      if (t) out.push(t);
    }
  }
  return out;
}
