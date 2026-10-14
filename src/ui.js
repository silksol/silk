// `silk ui`: a local dashboard over node:http. One HTML page (src/ui.html)
// plus a small JSON API backed by the same pipeline functions as the CLI.
//
//   GET  /             dashboard
//   GET  /api/state    crawl progress, recent pages, index status
//   GET  /api/page?url record for one page
//   POST /api/crawl    { url, maxPages, depth, sitemap, delay } starts a crawl
//   POST /api/stop     stops the running crawl
//   POST /api/ask      { question, k, llm } searches the loaded index

import http from 'node:http';
import { readFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { VERSION } from './crawl.js';
import { crawlToFile, chunkFile, indexFile, loadIndex, askIndex } from './pipeline.js';
import { readJsonl } from './dataset.js';
import { datasetStats } from './stats.js';
import { llmProvider } from './llm.js';

const HTML_PATH = new URL('./ui.html', import.meta.url);
const MAX_BODY = 64 * 1024;
const exists = (p) => access(p).then(() => true, () => false);

const summarise = (r) => ({ url: r.url, title: r.title, words: r.words, tokens_est: r.tokens_est, headings: r.headings?.length ?? 0, fetched_at: r.fetched_at });

/**
 * Create the dashboard server (not yet listening).
 * @param {object} o
 * @param {string} [o.dir] workspace folder for dataset.jsonl, chunks.jsonl and silk.index.json
 * @param {string} [o.index] an existing index file to load instead of <dir>/silk.index.json
 */
export async function createDashboard({ dir = 'silk-data', index: indexPath, env = process.env, fetch } = {}) {
  dir = resolve(dir);
  const files = {
    dataset: join(dir, 'dataset.jsonl'),
    chunks: join(dir, 'chunks.jsonl'),
    index: indexPath ? resolve(indexPath) : join(dir, 'silk.index.json'),
  };
  const state = {
    crawl: { status: 'idle', url: null, maxPages: 0, stats: null, queue: 0, startedAt: null, finishedAt: null, error: null, last: null },
    pages: [],
    index: null,
    indexInfo: null,
  };
  let job = null;
  let html = null;

  async function loadExisting() {
    if (await exists(files.dataset)) state.pages = (await readJsonl(files.dataset)).map(summarise);
    if (await exists(files.index)) {
      state.index = await loadIndex(files.index);
      state.indexInfo = { path: files.index, docs: state.index.stats.docs, terms: state.index.stats.terms, created_at: state.index.created_at };
    }
  }
  await loadExisting();

  async function startCrawl(body) {
    if (job) return [409, { error: 'A crawl is already running' }];
    let url = String(body.url || '').trim();
    if (!url) return [400, { error: 'Missing url' }];
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = 'https://' + url;
    const num = (v, d, lo, hi) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Math.min(hi, Math.max(lo, Number(v))) : d);
    const options = {
      maxPages: num(body.maxPages, 50, 1, 5000),
      depth: num(body.depth, 3, 0, 20),
      delay: num(body.delay, 500, 0, 60000),
      sitemap: body.sitemap ? 'auto' : null,
      include: body.include || null,
      exclude: body.exclude || null,
      fetch,
    };
    const c = state.crawl;
    Object.assign(c, { status: 'crawling', stopped: false, summary: null, url, maxPages: options.maxPages, stats: null, queue: 0, startedAt: new Date().toISOString(), finishedAt: null, error: null, last: null });
    state.pages = [];
    job = { stop() { this.stopped = true; } }; // reserved until the crawler exists
    const run = crawlToFile(url, {
      ...options,
      out: files.dataset,
      onStart: (crawler) => {
        if (job.stopped) crawler.stop();
        job = crawler;
      },
      onProgress: (e) => {
        c.stats = { ...e.stats, errorSamples: e.stats.errorSamples.slice(-5) };
        c.queue = e.queue;
        c.last = { type: e.type, url: e.url };
      },
      onRecord: (r) => state.pages.push(summarise(r)),
    });
    run.then(async ({ job: done, summary }) => {
      c.stats = { ...done.stats };
      c.summary = summary;
      if (summary.pages) {
        c.status = 'indexing';
        const chunked = await chunkFile(files.dataset, files.chunks);
        await indexFile(files.chunks, files.index);
        state.index = await loadIndex(files.index);
        state.indexInfo = { path: files.index, docs: state.index.stats.docs, terms: state.index.stats.terms, created_at: state.index.created_at, chunks: chunked.chunks };
      }
      c.status = c.stopped ? 'stopped' : 'done';
    }).catch((err) => {
      c.status = 'error';
      c.error = err.message;
    }).finally(() => {
      c.finishedAt = new Date().toISOString();
      job = null;
    });
    return [202, { ok: true, url }];
  }

  const routes = {
    'GET /api/state': () => [200, {
      version: VERSION,
      dir,
      files,
      crawl: state.crawl,
      pages: state.pages.slice(-500),
      totals: datasetStats(state.pages),
      index: state.indexInfo,
      llm: llmProvider(env),
    }],
    'GET /api/page': async (u) => {
      const target = u.searchParams.get('url');
      if (!target || !(await exists(files.dataset))) return [404, { error: 'No such page' }];
      const rec = (await readJsonl(files.dataset)).find((r) => r.url === target);
      return rec ? [200, rec] : [404, { error: 'No such page' }];
    },
    'POST /api/crawl': (u, body) => startCrawl(body),
    'POST /api/stop': () => {
      if (!job) return [409, { error: 'No crawl is running' }];
      job.stop();
      state.crawl.stopped = true;
      return [200, { ok: true }];
    },
    'POST /api/ask': async (u, body) => {
      if (!state.index) return [409, { error: 'No index yet. Run a crawl first, or start silk ui with --index.' }];
      const question = String(body.question || '').trim();
      if (!question) return [400, { error: 'Missing question' }];
      const k = Math.min(20, Math.max(1, Number(body.k) || 5));
      try {
        return [200, await askIndex(state.index, question, { k, llm: Boolean(body.llm), env, fetch })];
      } catch (err) {
        return [502, { error: err.message }];
      }
    },
  };

  const server = http.createServer(async (req, res) => {
    const send = (status, data, type = 'application/json; charset=utf-8') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(type.startsWith('application/json') ? JSON.stringify(data) : data);
    };
    try {
      const u = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
        html ??= await readFile(HTML_PATH, 'utf8');
        return send(200, html, 'text/html; charset=utf-8');
      }
      const route = routes[`${req.method} ${u.pathname}`];
      if (!route) return send(404, { error: 'Not found' });
      let body = {};
      if (req.method === 'POST') {
        // JSON only: a plain cross-site form post cannot set this content type.
        if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return send(415, { error: 'Expected application/json' });
        let raw = '';
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > MAX_BODY) return send(413, { error: 'Body too large' });
        }
        try { body = raw ? JSON.parse(raw) : {}; } catch { return send(400, { error: 'Invalid JSON' }); }
      }
      const [status, data] = await route(u, body);
      send(status, data);
    } catch (err) {
      send(500, { error: err.message });
    }
  });
  return { server, state, files };
}

/** Start the dashboard and resolve to { url, close }. */
export async function startDashboard({ port = 4321, host = '127.0.0.1', ...opts } = {}) {
  const { server, state, files } = await createDashboard(opts);
  await new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, host, ok);
  });
  const addr = server.address();
  return { url: `http://${host}:${addr.port}`, state, files, close: () => new Promise((r) => server.close(r)) };
}
