// The crawler. A breadth-first frontier with a small worker pool, per-host
// politeness delays, robots.txt checks, sitemap seeding, resume support and
// content deduplication.

import { createHash } from 'node:crypto';
import { Robots } from './robots.js';
import { toFetchUrl, urlKey } from './url.js';
import { extract, countWords } from './extract.js';
import { readSitemaps } from './sitemap.js';

export const VERSION = '1.1.0';

export const DEFAULTS = {
  maxPages: 50,
  depth: 3,
  concurrency: 2,
  delay: 500, // minimum milliseconds between requests to the same host
  sameHost: true,
  include: null, // RegExp or string; only URLs matching it are queued
  exclude: null, // RegExp or string; URLs matching it are never queued
  userAgent: `silk/${VERSION} (+https://github.com/OWNER/silk)`,
  timeout: 15000, // per request, milliseconds
  maxBytes: 5 * 1024 * 1024, // per page
  maxCrawlDelay: 60, // cap for robots.txt Crawl-delay, seconds
  sitemap: null, // 'auto' (robots.txt Sitemap: lines, then /sitemap.xml) or a sitemap URL
  known: null, // { urls, hashes } from an earlier run (resume): never written again
  onProgress: null, // (event) => void
  fetch: undefined, // custom fetch implementation, defaults to globalThis.fetch
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Start a crawl. The returned object is an async iterable of page records and
 * exposes live counters on `.stats`.
 *
 *   const job = crawl('https://example.com/docs');
 *   for await (const page of job) console.log(page.url);
 *   console.log(job.stats);
 */
export function crawl(startUrl, options = {}) {
  return new Crawler(startUrl, options);
}

export class Crawler {
  constructor(startUrl, options = {}) {
    const defined = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined));
    const o = (this.options = { ...DEFAULTS, ...defined });
    for (const k of ['maxPages', 'depth', 'concurrency', 'delay', 'timeout']) {
      if (!Number.isFinite(o[k]) || o[k] < 0) throw new TypeError(`Option "${k}" must be a non-negative number`);
    }
    if (o.concurrency < 1) throw new TypeError('Option "concurrency" must be at least 1');
    o.include = toRegExp(o.include, 'include');
    o.exclude = toRegExp(o.exclude, 'exclude');
    this.fetchImpl = o.fetch || globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') throw new Error('No fetch implementation available (Node 18+ required)');

    const start = toFetchUrl(startUrl);
    if (!start) throw new TypeError(`Invalid start URL: ${startUrl} (expected http:// or https://)`);
    this.startUrl = start;
    this.startHost = new URL(start).host;
    this.queue = [{ url: start, depth: 0 }];
    this.seen = new Set([urlKey(start)]);
    this.hashes = new Set();
    this.knownUrls = new Set([...(o.known?.urls || [])].map((u) => urlKey(u)).filter(Boolean));
    for (const h of o.known?.hashes || []) this.hashes.add(h);
    this.stopped = false;
    this.robots = new Map(); // origin -> Promise<Robots>
    this.nextSlot = new Map(); // host -> timestamp of the next allowed request
    this.stats = {
      pages: 0, words: 0, tokens: 0, fetched: 0, queued: 1,
      robotsSkipped: 0, nonHtml: 0, duplicates: 0, noindex: 0, canonicalized: 0, filtered: 0,
      known: 0, sitemaps: 0, sitemapUrls: 0, errors: 0, errorSamples: [], elapsedMs: 0,
    };
  }

  [Symbol.asyncIterator]() {
    return this._run();
  }

  /** Stop after the requests already in flight. Safe to call at any time. */
  stop() {
    this.stopped = true;
    this.queue.length = 0;
  }

  /** Convenience: collect every record into an array. */
  async toArray() {
    const out = [];
    for await (const rec of this) out.push(rec);
    return out;
  }

  async *_run() {
    const started = Date.now();
    const active = new Set();
    const ready = [];
    const { concurrency, maxPages } = this.options;

    const launch = () => {
      while (!this.stopped && active.size < concurrency && this.queue.length && this.stats.pages + active.size < maxPages) {
        const item = this.queue.shift();
        const task = this._process(item)
          .then((rec) => rec && ready.push(rec))
          .catch((err) => this._error(item.url, err))
          .finally(() => active.delete(task));
        active.add(task);
      }
    };

    try {
      if (this.options.sitemap) await this._seedFromSitemaps();
      launch();
      while (active.size) {
        await Promise.race(active);
        while (ready.length) yield ready.shift();
        this.stats.elapsedMs = Date.now() - started;
        launch();
      }
    } finally {
      this.stats.elapsedMs = Date.now() - started;
    }
  }

  _emit(type, url, extra) {
    if (this.options.onProgress) this.options.onProgress({ type, url, ...extra, stats: this.stats, queue: this.queue.length });
  }

  _error(url, err) {
    this.stats.errors++;
    let message = String(err);
    if (err instanceof Error) {
      // undici reports network failures as "fetch failed" with the real reason in `cause`.
      const cause = err.cause && (err.cause.code || err.cause.message);
      message = err.name === 'TimeoutError' ? 'request timed out' : cause ? `${err.message} (${cause})` : err.message;
    }
    if (this.stats.errorSamples.length < 20) this.stats.errorSamples.push({ url, message });
    this._emit('error', url, { message });
  }

  _request(url, accept) {
    return this.fetchImpl(url, {
      headers: { 'user-agent': this.options.userAgent, accept },
      redirect: 'follow',
      signal: AbortSignal.timeout(this.options.timeout),
    });
  }

  /** Fetch and cache robots.txt per origin. Missing or unreachable means allow all. */
  _robotsFor(origin) {
    if (!this.robots.has(origin)) {
      const ua = this.options.userAgent;
      this.robots.set(origin, (async () => {
        try {
          const res = await this._request(origin + '/robots.txt', 'text/plain');
          if (!res.ok) {
            await res.body?.cancel();
            return new Robots('', ua);
          }
          return new Robots(await res.text(), ua, origin);
        } catch {
          return new Robots('', ua);
        }
      })());
    }
    return this.robots.get(origin);
  }

  /** Reserve the next request slot for a host and wait for it. */
  async _politeWait(host, crawlDelay) {
    const robotsMs = Math.min(crawlDelay ?? 0, this.options.maxCrawlDelay) * 1000;
    const gap = Math.max(this.options.delay, robotsMs);
    const now = Date.now();
    const at = Math.max(now, this.nextSlot.get(host) ?? 0);
    this.nextSlot.set(host, at + gap);
    if (at > now) await sleep(at - now);
  }

  /** Queue every page URL listed in the site's sitemaps, at depth 0. */
  async _seedFromSitemaps() {
    const origin = new URL(this.startUrl).origin;
    let roots;
    if (this.options.sitemap === 'auto' || this.options.sitemap === true) {
      const robots = await this._robotsFor(origin);
      roots = robots.sitemaps.length ? robots.sitemaps : [origin + '/sitemap.xml'];
    } else {
      const explicit = toFetchUrl(this.options.sitemap, this.startUrl);
      if (!explicit) throw new TypeError(`Invalid sitemap URL: ${this.options.sitemap}`);
      roots = [explicit];
    }
    const request = async (url) => {
      await this._politeWait(new URL(url).host, (await this._robotsFor(new URL(url).origin)).crawlDelay);
      return this._request(url, 'application/xml,text/xml;q=0.9,*/*;q=0.1');
    };
    const found = await readSitemaps(roots, { request });
    this.stats.sitemaps = found.files;
    for (const e of found.errors) this._error(e.url, new Error(`sitemap: ${e.message}`));
    for (const url of found.urls) {
      const clean = toFetchUrl(url);
      if (!clean) continue;
      const before = this.stats.queued;
      this._enqueue(clean, 0);
      if (this.stats.queued > before) this.stats.sitemapUrls++;
    }
    this._emit('sitemap', roots[0], { urls: this.stats.sitemapUrls });
  }

  _enqueue(url, depth) {
    const key = urlKey(url);
    if (!key || this.seen.has(key)) return;
    const { sameHost, include, exclude } = this.options;
    if (sameHost && new URL(url).host !== this.startHost) return;
    this.seen.add(key);
    // Resuming with a sitemap: the sitemap already lists every page, so known
    // pages need no request at all. Without one they are still visited for links.
    if (this.options.sitemap && this.knownUrls.has(key)) {
      this.stats.known++;
      this._emit('known', url);
      return;
    }
    if ((include && !include.test(url)) || (exclude && exclude.test(url))) {
      this.stats.filtered++;
      return;
    }
    this.queue.push({ url, depth });
    this.stats.queued++;
  }

  async _process({ url, depth }) {
    const u = new URL(url);
    const robots = await this._robotsFor(u.origin);
    if (!robots.isAllowed(u.pathname + u.search)) {
      this.stats.robotsSkipped++;
      this._emit('robots', url);
      return null;
    }
    await this._politeWait(u.host, robots.crawlDelay);
    this._emit('fetch', url);

    const res = await this._request(url, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1');
    this.stats.fetched++;
    const finalUrl = toFetchUrl(res.url || url) || url;
    const skip = async (counter, type) => {
      await res.body?.cancel().catch(() => {});
      if (counter) this.stats[counter]++;
      this._emit(type, url);
      return null;
    };

    // Redirects: the target may already be known, or may leave the host.
    if (urlKey(finalUrl) !== urlKey(url)) {
      if (this.options.sameHost && new URL(finalUrl).host !== this.startHost) return skip('filtered', 'offsite');
      if (this.seen.has(urlKey(finalUrl))) return skip('duplicates', 'duplicate');
      this.seen.add(urlKey(finalUrl));
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`HTTP ${res.status}`);
    }
    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (!/text\/html|application\/xhtml\+xml/.test(type)) return skip('nonHtml', 'non-html');

    const html = await readCapped(res, this.options.maxBytes);
    const page = extract(html, finalUrl);
    const xRobots = (res.headers.get('x-robots-tag') || '').toLowerCase();
    const noindex = page.noindex || /noindex|none/.test(xRobots);
    const nofollow = page.nofollow || /nofollow|none/.test(xRobots);

    if (!nofollow && depth < this.options.depth) {
      for (const link of page.links) this._enqueue(link, depth + 1);
    }
    // A canonical pointing elsewhere: crawl the canonical URL instead of this copy.
    if (page.canonical && urlKey(page.canonical) !== urlKey(finalUrl)) {
      this.stats.canonicalized++;
      this._enqueue(page.canonical, depth);
      this._emit('canonical', url, { canonical: page.canonical });
      return null;
    }
    if (noindex) return skip('noindex', 'noindex');
    if (this.knownUrls.has(urlKey(finalUrl))) return skip('known', 'known');

    const words = countWords(page.text);
    if (!words) return skip(null, 'empty');
    const sha256 = createHash('sha256').update(page.text).digest('hex');
    if (this.hashes.has(sha256)) return skip('duplicates', 'duplicate');
    if (this.stats.pages >= this.options.maxPages) return null;
    this.hashes.add(sha256);

    const record = {
      url: finalUrl,
      title: page.title,
      text: page.text,
      headings: page.headings,
      links_out: page.links.length,
      words,
      tokens_est: Math.round(words * 1.33),
      fetched_at: new Date().toISOString(),
      sha256,
    };
    this.stats.pages++;
    this.stats.words += words;
    this.stats.tokens += record.tokens_est;
    this._emit('page', finalUrl, { words });
    return record;
  }
}

function toRegExp(value, name) {
  if (value == null || value === '') return null;
  if (value instanceof RegExp) return value;
  try {
    return new RegExp(value);
  } catch (err) {
    throw new TypeError(`Option "${name}" is not a valid regular expression: ${err.message}`);
  }
}

async function readCapped(res, maxBytes) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
