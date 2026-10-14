// GET /api/crawl?url=<site>&max=<1..25>
// The hosted crawler behind silkcrawl.dev. Runs silk's own crawler and
// extraction on a Vercel function and streams NDJSON events:
//   {"type":"start", url, max}
//   {"type":"fetch", url, stats}              a request is going out
//   {"type":"skip", reason, url, stats}       robots, duplicate, non-html, ...
//   {"type":"error", url, message, stats}     one page failed
//   {"type":"page", page, chunks}             a cleaned page and its RAG chunks
//   {"type":"done", summary, stopped}         stopped: null | "limit" | "time"
// Errors before the crawl starts are plain JSON with a 4xx status.

import { Crawler, DEFAULTS, VERSION } from '../src/crawl.js';
import { toFetchUrl } from '../src/url.js';
import { chunkRecords } from '../src/chunk.js';
import { crawlSummary } from '../src/pipeline.js';
import { createSafeFetch, assertPublicUrl } from './_guard.js';

export const LIMITS = {
  maxPages: 25,
  defaultPages: 10,
  pageBytes: 2 * 1024 * 1024,
  budgetMs: 45000,
  requestTimeoutMs: 10000,
  depth: 3,
  rateWindowMs: 10 * 60 * 1000,
  rateMax: 12,
};

const SKIP_EVENTS = new Set(['robots', 'non-html', 'duplicate', 'noindex', 'known', 'offsite', 'canonical', 'empty']);

/** Accept "example.com/docs" as well as full URLs. */
export function normalizeTarget(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  if (/^[a-z][a-z0-9+.-]*:(?!\/\/|\d)/i.test(raw)) return null; // mailto:, javascript:, ...
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw;
  const url = toFetchUrl(withScheme);
  if (!url || /^[a-z]+:\/\/[^/]*@/i.test(withScheme)) return null;
  const host = new URL(url).hostname;
  if (!host || (!host.includes('.') && !host.includes(':') && host !== 'localhost')) return null;
  return url;
}

function sendJson(res, status, body, extra = {}) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

function clientIp(req) {
  const fwd = req.headers?.['x-forwarded-for'];
  return (typeof fwd === 'string' && fwd.split(',')[0].trim()) || req.headers?.['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}

/**
 * Build a handler. The default export uses production settings; tests and the
 * local dev server pass `allowLocal` and `delay` to crawl the fixture site.
 */
export function createHandler({
  allowLocal = false, delay = DEFAULTS.delay, fetchImpl = globalThis.fetch, lookup,
  budgetMs = LIMITS.budgetMs, rateMax = LIMITS.rateMax, rateWindowMs = LIMITS.rateWindowMs,
} = {}) {
  const hits = new Map(); // ip -> [timestamps]

  const limited = (ip) => {
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter((t) => now - t < rateWindowMs);
    if (recent.length >= rateMax) {
      hits.set(ip, recent);
      return Math.ceil((rateWindowMs - (now - recent[0])) / 1000);
    }
    recent.push(now);
    hits.set(ip, recent);
    if (hits.size > 5000) hits.clear();
    return 0;
  };

  return async function handler(req, res) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method', message: 'Use GET.' }, { allow: 'GET' });
    const q = new URL(req.url, 'http://localhost').searchParams;
    const start = normalizeTarget(q.get('url'));
    if (!start) return sendJson(res, 400, { error: 'bad_url', message: 'That does not look like a web address. Try something like docs.example.com.' });
    const max = Math.min(LIMITS.maxPages, Math.max(1, parseInt(q.get('max'), 10) || LIMITS.defaultPages));

    if (!allowLocal) {
      try {
        await assertPublicUrl(start, lookup ? { lookup } : {});
      } catch (err) {
        if (err.code === 'BLOCKED') return sendJson(res, 400, { error: 'blocked', message: `silk only crawls public sites: ${err.message}.` });
        return sendJson(res, 400, { error: 'not_found', message: `Could not find ${new URL(start).hostname}. Check the spelling.` });
      }
    }

    const wait = limited(clientIp(req));
    if (wait) {
      return sendJson(res, 429, { error: 'rate_limited', message: `Too many crawls from your network. Try again in ${Math.ceil(wait / 60)} min, or run it locally with npx silk-crawl.`, retry_after: wait }, { 'retry-after': String(wait) });
    }

    res.statusCode = 200;
    res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-accel-buffering', 'no');
    let open = true;
    const write = (obj) => { if (open) res.write(JSON.stringify(obj) + '\n'); };

    const safeFetch = createSafeFetch({ fetchImpl, allowLocal, ...(lookup ? { lookup } : {}) });
    const job = new Crawler(start, {
      maxPages: max,
      depth: LIMITS.depth,
      concurrency: 2,
      delay,
      timeout: LIMITS.requestTimeoutMs,
      maxBytes: LIMITS.pageBytes,
      userAgent: `silk/${VERSION} (+https://silkcrawl.dev)`,
      fetch: safeFetch,
      onProgress(e) {
        const stats = { pages: e.stats.pages, words: e.stats.words, tokens: e.stats.tokens, fetched: e.stats.fetched, queued: e.queue, errors: e.stats.errors };
        if (e.type === 'fetch') write({ type: 'fetch', url: e.url, stats });
        else if (e.type === 'error') write({ type: 'error', url: e.url, message: e.message, stats });
        else if (SKIP_EVENTS.has(e.type)) write({ type: 'skip', reason: e.type, url: e.url, stats });
      },
    });
    req.on?.('close', () => { if (!res.writableFinished) { open = false; job.stop(); } });

    write({ type: 'start', url: start, max, version: VERSION });
    const t0 = Date.now();
    let stopped = null;
    let timer;
    const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve('time'), budgetMs); });
    const it = job[Symbol.asyncIterator]();
    try {
      for (;;) {
        const step = await Promise.race([it.next(), deadline]);
        if (step === 'time') {
          stopped = 'time';
          job.stop();
          break;
        }
        if (step.done) break;
        const page = step.value;
        write({ type: 'page', page, chunks: chunkRecords([page]) });
      }
      if (!stopped && job.stats.pages >= max) stopped = 'limit';
      if (stopped === 'time') job.stats.elapsedMs = Date.now() - t0;
      write({ type: 'done', summary: crawlSummary(job), stopped });
    } catch (err) {
      write({ type: 'fatal', message: err.message || String(err) });
    } finally {
      clearTimeout(timer);
      open = false;
      res.end();
    }
  };
}

export default createHandler();
