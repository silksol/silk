// The hosted site: /api/crawl, its network guard, the dev server and the
// pure browser helpers in docs/lib.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startSite } from '../fixtures/site.js';
import { startDevSite } from '../scripts/dev-site.mjs';
import { createHandler, normalizeTarget, LIMITS } from '../api/crawl.js';
import { isPrivateIp, assertPublicUrl, createSafeFetch } from '../api/_guard.js';
import * as site from '../docs/lib/site.js';
import { buildIndex, ask } from '../docs/lib/search.js';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

let fixture;
let dev;
before(async () => {
  fixture = await startSite();
  dev = await startDevSite({ port: 0, allowLocal: true, delay: 0 });
});
after(async () => {
  await dev.close();
  await fixture.close();
});

const events = async (res) => (await res.text()).trim().split('\n').map((l) => JSON.parse(l));

test('docs/lib copies of src stay identical', () => {
  for (const f of ['search.js', 'text.js']) assert.equal(read(`docs/lib/${f}`), read(`src/${f}`), `docs/lib/${f} drifted from src/${f}`);
});

test('isPrivateIp covers loopback, private, link-local, mapped and public addresses', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '224.0.0.1', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::a00:1', '[::1]', 'nonsense']) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) assert.equal(isPrivateIp(ip), false, ip);
});

test('assertPublicUrl refuses schemes, ports, local names and private DNS answers', async () => {
  const lookup = async (host) => (host === 'evil.example' ? [{ address: '10.0.0.5', family: 4 }] : [{ address: '93.184.215.14', family: 4 }]);
  await assertPublicUrl('https://docs.example.com/x', { lookup });
  await assertPublicUrl('http://docs.example.com:80/', { lookup });
  for (const bad of ['ftp://docs.example.com/', 'https://docs.example.com:8443/', 'http://localhost/', 'http://printer.local/', 'http://intranet/',
    'http://127.0.0.1/', 'http://[::1]/', 'http://evil.example/']) {
    await assert.rejects(assertPublicUrl(bad, { lookup }), (e) => e.code === 'BLOCKED', bad);
  }
});

test('safe fetch re-checks every redirect hop', async () => {
  const lookup = async () => [{ address: '93.184.215.14', family: 4 }];
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url === 'https://a.example.com/') return new Response(null, { status: 302, headers: { location: '/b' } });
    if (url === 'https://a.example.com/b') return new Response(null, { status: 301, headers: { location: 'http://169.254.169.254/latest' } });
    return new Response('ok');
  };
  const safe = createSafeFetch({ fetchImpl, lookup });
  await assert.rejects(safe('https://a.example.com/'), (e) => e.code === 'BLOCKED');
  assert.deepEqual(calls, ['https://a.example.com/', 'https://a.example.com/b']);
  const res = await createSafeFetch({ fetchImpl: async (u) => (u.endsWith('/x') ? new Response('fine') : new Response(null, { status: 307, headers: { location: '/x' } })), lookup })('https://a.example.com/');
  assert.equal(await res.text(), 'fine');
  assert.equal(res.url, 'https://a.example.com/x');
});

test('normalizeTarget accepts bare hosts and rejects junk', () => {
  assert.equal(normalizeTarget('docs.example.com/guide'), 'https://docs.example.com/guide');
  assert.equal(normalizeTarget(' http://x.org '), 'http://x.org/');
  for (const bad of ['', 'nope', 'ftp://x.org', 'javascript:alert(1)', 'mailto:a@b.c', 'https://user:pw@x.org/']) assert.equal(normalizeTarget(bad), null, bad);
});

test('/api/crawl streams pages, chunks, skips and a summary from silk\'s own crawler', async () => {
  const res = await fetch(`${dev.url}/api/crawl?url=${encodeURIComponent(fixture.url)}&max=25`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/x-ndjson/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const ev = await events(res);
  assert.equal(ev[0].type, 'start');
  assert.equal(ev.at(-1).type, 'done');
  const pages = ev.filter((e) => e.type === 'page');
  const done = ev.at(-1);
  assert.ok(pages.length >= 5);
  assert.equal(done.summary.pages, pages.length);
  assert.equal(done.summary.words, pages.reduce((a, e) => a + e.page.words, 0));
  for (const { page, chunks } of pages) {
    assert.ok(page.url.startsWith(fixture.url));
    assert.ok(page.text && page.sha256 && page.tokens_est >= page.words);
    assert.ok(!/do not index|Copyright 2026/.test(page.text), 'boilerplate removed');
    assert.ok(chunks.length >= 1 && chunks.every((c) => c.url === page.url));
  }
  assert.ok(ev.some((e) => e.type === 'skip' && e.reason === 'robots' && e.url.endsWith('/private/keys')), 'robots.txt respected');
  assert.ok(ev.some((e) => e.type === 'fetch'));
  // The browser side: index the streamed chunks and ask.
  const index = buildIndex(pages.flatMap((e) => e.chunks));
  const r = ask(index, 'what does strict mode do with unknown keys?', { k: 3 });
  assert.match(r.passages[0].url, /\/docs\/$/);
});

test('/api/crawl caps pages at 25 and reports the limit', async () => {
  const ev = await events(await fetch(`${dev.url}/api/crawl?url=${encodeURIComponent(fixture.url)}&max=2`));
  assert.equal(ev.filter((e) => e.type === 'page').length, 2);
  assert.equal(ev.at(-1).stopped, 'limit');
  const start = (await events(await fetch(`${dev.url}/api/crawl?url=${encodeURIComponent(fixture.url)}&max=999`)))[0];
  assert.equal(start.max, LIMITS.maxPages);
});

test('/api/crawl stops at the time budget', async () => {
  const handler = createHandler({ allowLocal: true, delay: 400, budgetMs: 250 });
  const http = await import('node:http');
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const ev = await events(await fetch(`http://127.0.0.1:${server.address().port}/?url=${encodeURIComponent(fixture.url)}&max=25`));
    assert.equal(ev.at(-1).type, 'done');
    assert.equal(ev.at(-1).stopped, 'time');
    assert.ok(ev.at(-1).summary.pages < 25);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});

test('production handler refuses bad, private and local targets, and rate limits', async () => {
  const prod = await startDevSite({ port: 0 });
  try {
    const get = async (u) => {
      const res = await fetch(`${prod.url}/api/crawl?url=${encodeURIComponent(u)}`);
      return { status: res.status, body: await res.json() };
    };
    assert.equal((await get('nope')).body.error, 'bad_url');
    assert.equal((await get(fixture.url)).body.error, 'blocked', 'loopback with a custom port');
    assert.equal((await get('http://169.254.169.254/latest/meta-data')).body.error, 'blocked');
    assert.equal((await get('http://10.0.0.1/')).status, 400);
    assert.equal((await fetch(`${prod.url}/api/crawl`, { method: 'POST' })).status, 405);
  } finally {
    await prod.close();
  }
  const http = await import('node:http');
  const server = http.createServer(createHandler({ allowLocal: true, delay: 0, rateMax: 1 }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${server.address().port}/?url=${encodeURIComponent(fixture.url)}&max=1`;
    const first = await fetch(base);
    assert.equal(first.status, 200);
    await first.text();
    const res = await fetch(base);
    assert.equal(res.status, 429);
    assert.ok(Number(res.headers.get('retry-after')) > 0);
    assert.equal((await res.json()).error, 'rate_limited');
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});

test('dev server serves docs/ and the module graph the page needs', async () => {
  const html = await (await fetch(dev.url + '/')).text();
  assert.match(html, /<script type="module" src="app.js"><\/script>/);
  assert.match(html, /id="crawl-form"/);
  for (const p of ['/app.js', '/lib/site.js', '/lib/search.js', '/lib/text.js', '/fonts/mona-sans.woff2']) {
    assert.equal((await fetch(dev.url + p)).status, 200, p);
  }
  assert.equal((await fetch(dev.url + '/../package.json')).status, 404);
});

test('browser helpers: input, query, NDJSON, messages, suggestions', () => {
  assert.equal(site.normalizeInput('docs.example.com'), 'https://docs.example.com/');
  assert.equal(site.normalizeInput('https://x.org/a#b'), 'https://x.org/a');
  assert.equal(site.normalizeInput('not a url'), null);
  assert.equal(site.normalizeInput('mailto:a@b.c'), null);
  assert.deepEqual(site.readQuery('?url=x.org&max=99'), { url: 'x.org', max: 25 });
  assert.deepEqual(site.readQuery(''), { url: '', max: 10 });
  assert.equal(site.shareQuery('https://x.org/', 10), '?url=https%3A%2F%2Fx.org%2F');
  assert.equal(site.shareQuery('https://x.org/', 5), '?url=https%3A%2F%2Fx.org%2F&max=5');

  const split = site.ndjsonSplitter();
  assert.deepEqual(split.push('{"a":1}\n{"b"'), [{ a: 1 }]);
  assert.deepEqual(split.push(':2}\nnot json\n{"c":3}'), [{ b: 2 }]);
  assert.deepEqual(split.end(), [{ c: 3 }]);
  assert.equal(site.toJsonl([{ a: 1 }, { b: 2 }]), '{"a":1}\n{"b":2}\n');
  assert.equal(site.toJsonl([]), '');
  assert.equal(site.fileSlug('https://www.Docs.example.com/x'), 'docs-example-com');
  assert.equal(site.pathOf('https://x.org/a?b=1'), '/a?b=1');

  assert.equal(site.errorFor(429, {}).title, 'Rate limited');
  assert.equal(site.errorFor(400, { error: 'blocked', message: 'm' }).title, 'Not a public site');
  assert.equal(site.errorFor(0).title, 'Crawler unreachable');
  assert.match(site.errorFor(502, null).message, /HTTP 502/);

  const base = { pages: 0, fetched: 1, errors: 0, error_samples: [], skipped: { robots: 0, non_html: 0, duplicates: 0, noindex: 0 } };
  assert.equal(site.emptyReason({ ...base, pages: 3 }), null);
  assert.match(site.emptyReason({ ...base, fetched: 0, skipped: { ...base.skipped, robots: 1 } }).title, /robots/);
  assert.match(site.emptyReason({ ...base, errors: 1, error_samples: [{ message: 'HTTP 403' }] }).message, /403/);
  assert.match(site.emptyReason({ ...base, errors: 1, error_samples: [{ message: 'request timed out' }] }).title, /did not answer/);
  assert.match(site.emptyReason(base).message, /JavaScript/);

  const qs = site.suggestQuestions([
    { title: 'Retries', headings: ['Retries', 'Configure retries', 'Retries', 'Contents'] },
    { title: 'Caching', headings: ['Caching', 'Cache invalidation', 'Configure retries'] },
  ]);
  assert.deepEqual(qs, ['Configure retries', 'Cache invalidation']);
});
