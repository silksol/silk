import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crawl, parseSitemap, robotsSitemaps, Robots, crawlToFile, readJsonl } from '../src/index.js';
import { startSite } from '../fixtures/site.js';

let site;
let dir;
before(async () => {
  site = await startSite();
  dir = await mkdtemp(join(tmpdir(), 'silk-sitemap-'));
});
after(async () => {
  await site.close();
  await rm(dir, { recursive: true, force: true });
});

const paths = (records) => records.map((r) => new URL(r.url).pathname + new URL(r.url).search).sort();
const FULL = [
  '/', '/changelog?lang=en&v=1', '/deep/1', '/deep/2', '/deep/3', '/docs/', '/docs/install?a=1&b=2', '/dup-a',
  '/guides/caching', '/guides/retries', '/legal', '/private/open',
];

test('parseSitemap: urlset, sitemap index, entities and CDATA', () => {
  const urlset = parseSitemap(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <url><loc> https://ex.com/a?x=1&amp;y=2 </loc><lastmod>2026-01-01</lastmod></url>
    <url><loc><![CDATA[https://ex.com/b]]></loc></url></urlset>`);
  assert.deepEqual(urlset, { type: 'urlset', urls: ['https://ex.com/a?x=1&y=2', 'https://ex.com/b'] });
  const index = parseSitemap('<sitemapindex><sitemap><loc>https://ex.com/s1.xml</loc></sitemap></sitemapindex>');
  assert.deepEqual(index, { type: 'index', urls: ['https://ex.com/s1.xml'] });
  assert.equal(parseSitemap('<html>nope</html>').type, 'unknown');
});

test('robots.txt Sitemap: lines are global and resolved to absolute URLs', () => {
  const txt = 'User-agent: *\nDisallow: /x\nSitemap: https://ex.com/a.xml\n\nUser-agent: other\nsitemap:/b.xml # relative\nSitemap: https://ex.com/a.xml';
  assert.deepEqual(robotsSitemaps(txt, 'https://ex.com'), ['https://ex.com/a.xml', 'https://ex.com/b.xml']);
  assert.deepEqual(new Robots(txt, 'silk', 'https://ex.com').sitemaps, ['https://ex.com/a.xml', 'https://ex.com/b.xml']);
  assert.equal(new Robots(txt, 'silk').isAllowed('/x'), false, 'Sitemap lines do not break groups');
});

test('--sitemap auto: robots.txt index, nested and gzip sitemaps seed orphan pages', async () => {
  site.requests.length = 0;
  const job = crawl(site.url, { delay: 0, sitemap: 'auto' });
  const records = await job.toArray();
  assert.deepEqual(paths(records), FULL);
  const s = job.stats;
  assert.equal(s.sitemaps, 4, 'index + pages + gzip + missing');
  assert.equal(s.sitemapUrls, 5, 'start URL and the off-site entry are not queued');
  assert.equal(s.errors, 1);
  assert.match(s.errorSamples[0].message, /sitemap: HTTP 404/);
  assert.ok(!site.requests.includes('/private/keys'), 'sitemap entries still obey robots.txt');
  assert.equal(s.robotsSkipped, 1);
});

test('explicit sitemap URL and include filter', async () => {
  const job = crawl(site.url, { delay: 0, depth: 0, sitemap: '/sitemap-guides.xml.gz' });
  assert.deepEqual(paths(await job.toArray()), ['/', '/guides/caching', '/guides/retries']);
  const filtered = await crawl(site.url, { delay: 0, depth: 0, sitemap: 'auto', include: '/guides/' }).toArray();
  assert.deepEqual(paths(filtered), ['/', '/guides/caching', '/guides/retries']);
});

test('resume: an interrupted crawl continues without repeating pages', async () => {
  const out = join(dir, 'resume.jsonl');
  const first = await crawlToFile(site.url, { out, delay: 0, sitemap: 'auto', maxPages: 4 });
  assert.equal(first.summary.pages, 4);

  site.requests.length = 0;
  const second = await crawlToFile(site.url, { out, delay: 0, sitemap: 'auto', resume: true });
  assert.equal(second.summary.resumed, 4);
  assert.equal(second.summary.pages, FULL.length - 4);
  const all = await readJsonl(out);
  assert.deepEqual(paths(all), FULL, 'appended file has every page exactly once');
  // With a sitemap, known pages other than the start URL are not requested again.
  const known = paths(all.slice(0, 4)).filter((p) => p !== '/');
  for (const p of known) assert.ok(!site.requests.includes(p), `${p} was not refetched`);
  assert.ok(second.summary.skipped.known >= known.length);

  // Nothing new: a third run saves zero pages and leaves the file alone.
  const before = await readFile(out, 'utf8');
  const third = await crawlToFile(site.url, { out, delay: 0, sitemap: 'auto', resume: true });
  assert.equal(third.summary.pages, 0);
  assert.equal(await readFile(out, 'utf8'), before);
});

test('resume without a sitemap revisits known pages for links but never rewrites them', async () => {
  const out = join(dir, 'links.jsonl');
  await crawlToFile(site.url, { out, delay: 0, maxPages: 3 });
  const r = await crawlToFile(site.url, { out, delay: 0, resume: true });
  assert.equal(r.summary.skipped.known, 3);
  const all = await readJsonl(out);
  assert.equal(all.length, 9);
  assert.equal(new Set(all.map((x) => x.url)).size, 9);
});

test('stop() ends a crawl early', async () => {
  const job = crawl(site.url, { delay: 0, concurrency: 1, sitemap: 'auto' });
  const got = [];
  for await (const r of job) {
    got.push(r);
    if (got.length === 2) job.stop();
  }
  assert.ok(got.length <= 3, `stopped after ${got.length} pages`);
});
