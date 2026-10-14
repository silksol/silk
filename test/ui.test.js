import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startDashboard } from '../src/ui.js';
import { startSite } from '../fixtures/site.js';

let site;
let ui;
let dir;
before(async () => {
  site = await startSite();
  dir = await mkdtemp(join(tmpdir(), 'silk-ui-'));
  ui = await startDashboard({ port: 0, dir, env: {} });
});
after(async () => {
  await ui.close();
  await site.close();
  await rm(dir, { recursive: true, force: true });
});

const get = async (path) => {
  const res = await fetch(ui.url + path);
  return { status: res.status, type: res.headers.get('content-type'), body: res.headers.get('content-type').includes('json') ? await res.json() : await res.text() };
};
const post = async (path, body, type = 'application/json') => {
  const res = await fetch(ui.url + path, { method: 'POST', headers: { 'content-type': type }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

test('serves the branded single-page dashboard', async () => {
  const page = await get('/');
  assert.equal(page.status, 200);
  assert.match(page.type, /text\/html/);
  assert.match(page.body, /<title>Silk dashboard<\/title>/);
  assert.match(page.body, /#0A0A0C/);
  assert.ok(!/<script src=|<link rel="stylesheet"/.test(page.body), 'no external assets');
  assert.equal((await get('/nope')).status, 404);
});

test('crawl from the API, poll progress, then ask the built index', async () => {
  let s = (await get('/api/state')).body;
  assert.equal(s.crawl.status, 'idle');
  assert.equal(s.index, null);
  assert.equal((await post('/api/ask', { question: 'retries' })).status, 409);

  const started = await post('/api/crawl', { url: site.url, maxPages: 50, depth: 3, delay: 0, sitemap: true });
  assert.equal(started.status, 202);
  assert.equal((await post('/api/crawl', { url: site.url })).status, 409, 'one crawl at a time');

  for (let i = 0; i < 100 && !['done', 'error'].includes(s.crawl.status); i++) {
    await new Promise((r) => setTimeout(r, 50));
    s = (await get('/api/state')).body;
  }
  assert.equal(s.crawl.status, 'done', s.crawl.error || '');
  assert.equal(s.pages.length, 12);
  assert.equal(s.crawl.stats.pages, 12);
  assert.equal(s.totals.words, s.pages.reduce((a, p) => a + p.words, 0));
  assert.ok(s.index.docs >= 12);
  await access(join(dir, 'dataset.jsonl'));
  await access(join(dir, 'silk.index.json'));

  const answer = await post('/api/ask', { question: 'How do I clear the cache?', k: 3 });
  assert.equal(answer.status, 200);
  assert.ok(answer.body.passages[0].url.endsWith('/guides/caching'));
  assert.match(answer.body.answer, /clearCache\(\)/);

  const page = await get('/api/page?url=' + encodeURIComponent(site.url + '/guides/retries'));
  assert.equal(page.body.title, 'Retries | Example Project');
  assert.equal((await get('/api/page?url=x')).status, 404);
});

test('input validation and a restarted dashboard reloads the workspace', async () => {
  assert.equal((await post('/api/crawl', 'url=x', 'application/x-www-form-urlencoded')).status, 415);
  assert.equal((await post('/api/crawl', '{bad', 'application/json')).status, 400);
  assert.equal((await post('/api/crawl', {})).status, 400);
  assert.equal((await post('/api/stop', {})).status, 409);
  assert.equal((await post('/api/ask', { question: 'x', llm: true })).status, 502, 'no API key configured');

  const again = await startDashboard({ port: 0, dir, env: {} });
  try {
    const s = await (await fetch(again.url + '/api/state')).json();
    assert.equal(s.pages.length, 12);
    assert.ok(s.index.docs >= 12);
  } finally {
    await again.close();
  }
});
