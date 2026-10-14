import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crawl } from '../src/index.js';
import { startSite } from '../fixtures/site.js';

const run = promisify(execFile);
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'silk.js');
let site;

before(async () => { site = await startSite(); });
after(async () => { await site.close(); });

const paths = (records) => records.map((r) => new URL(r.url).pathname + new URL(r.url).search).sort();

test('crawls the fixture site and respects every rule', async () => {
  site.requests.length = 0;
  const job = crawl(site.url, { delay: 0 });
  const records = await job.toArray();

  assert.deepEqual(paths(records), [
    '/', '/deep/1', '/deep/2', '/deep/3', '/docs/', '/docs/install?a=1&b=2', '/dup-a', '/legal', '/private/open',
  ]);
  // robots.txt: disallowed path never requested, the more specific Allow is.
  assert.ok(!site.requests.includes('/private/keys'));
  assert.ok(site.requests.includes('/private/open'));
  assert.equal(site.requests.filter((p) => p === '/robots.txt').length, 1, 'robots.txt fetched once');
  // nofollow: the child of /hidden is never discovered.
  assert.ok(!site.requests.includes('/hidden-child'));
  // URL normalisation: /docs/ requested once even though linked as /docs/ and canonical /docs/.
  assert.equal(site.requests.filter((p) => p.startsWith('/docs/') && !p.includes('install')).length, 1);
  assert.ok(!site.requests.some((p) => p.includes('other.example')));

  const s = job.stats;
  assert.equal(s.pages, 9);
  assert.equal(s.robotsSkipped, 1);
  assert.equal(s.nonHtml, 1);
  assert.equal(s.duplicates, 1);
  assert.equal(s.noindex, 2); // /blog and /hidden
  assert.equal(s.canonicalized, 1); // /print
  assert.equal(s.errors, 0);
  assert.equal(s.words, records.reduce((a, r) => a + r.words, 0));

  const docs = records.find((r) => r.url.endsWith('/docs/'));
  assert.equal(docs.title, 'Docs | Example Project');
  assert.deepEqual(docs.headings, ['Documentation', 'Quick start', 'Options']);
  assert.match(docs.text, /```js\nimport \{ parse \} from 'example';/);
  assert.match(docs.text, /if \(cfg\.a < 2\)/);
  assert.match(docs.text, /- strict: fail on unknown keys\n- env:/);
  assert.ok(!/Copyright|Was this page helpful|Home|analytics/.test(docs.text));
  assert.equal(docs.tokens_est, Math.round(docs.words * 1.33));
  assert.match(docs.sha256, /^[0-9a-f]{64}$/);
  assert.ok(!Number.isNaN(Date.parse(docs.fetched_at)));
  assert.equal(new Set(records.map((r) => r.sha256)).size, records.length);
});

test('depth and max-pages limits', async () => {
  const shallow = await crawl(site.url, { delay: 0, depth: 0 }).toArray();
  assert.deepEqual(paths(shallow), ['/']);

  const two = await crawl(site.url + '/deep/1', { delay: 0, depth: 1 }).toArray();
  assert.ok(paths(two).includes('/deep/2'));
  assert.ok(!paths(two).includes('/deep/3'));

  const limited = crawl(site.url, { delay: 0, maxPages: 3, concurrency: 4 });
  assert.equal((await limited.toArray()).length, 3);
  assert.equal(limited.stats.pages, 3);
});

test('include/exclude filters and a user agent blocked by robots.txt', async () => {
  // The start URL is always fetched; filters apply to discovered links.
  const docsOnly = await crawl(site.url, { delay: 0, include: '/docs/' }).toArray();
  assert.deepEqual(paths(docsOnly), ['/', '/docs/', '/docs/install?a=1&b=2']);

  const noDeep = await crawl(site.url, { delay: 0, exclude: /deep|dup/ }).toArray();
  assert.ok(!paths(noDeep).some((p) => /deep|dup/.test(p)));

  const blocked = crawl(site.url, { delay: 0, userAgent: 'BadBot/1.0' });
  assert.equal((await blocked.toArray()).length, 0);
  assert.equal(blocked.stats.robotsSkipped, 1);
});

test('per-host delay spaces out requests', async () => {
  const t0 = Date.now();
  await crawl(site.url + '/deep/1', { delay: 150, depth: 2, concurrency: 3 }).toArray();
  assert.ok(Date.now() - t0 >= 300, 'three pages at 150ms spacing take at least 300ms');
});

test('errors are counted, not thrown', async () => {
  const job = crawl(site.url + '/missing', { delay: 0 });
  assert.equal((await job.toArray()).length, 0);
  assert.equal(job.stats.errors, 1);
  assert.equal(job.stats.errorSamples[0].message, 'HTTP 404');
  assert.throws(() => crawl('ftp://example.com'), /Invalid start URL/);
  assert.throws(() => crawl(site.url, { include: '(' }), /not a valid regular expression/);
});

test('CLI writes JSONL, prints a summary and uses exit codes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'silk-'));
  try {
    const out = join(dir, 'data.jsonl');
    const { stdout, stderr } = await run('node', [BIN, site.url, '--delay', '0', '--out', out, '--json']);
    const summary = JSON.parse(stdout);
    assert.equal(summary.pages, 9);
    assert.equal(summary.skipped.robots, 1);
    assert.match(stderr, /saved/);
    const lines = (await readFile(out, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 9);
    assert.deepEqual(Object.keys(lines[0]), ['url', 'title', 'text', 'headings', 'links_out', 'words', 'tokens_est', 'fetched_at', 'sha256']);

    const stdoutRun = await run('node', [BIN, site.url, '--delay=0', '--out', '-', '--max-pages', '2', '--quiet']);
    assert.equal(stdoutRun.stdout.trim().split('\n').length, 2);

    const help = await run('node', [BIN, '--help']);
    assert.match(help.stdout, /Usage/);
    await assert.rejects(run('node', [BIN]), (e) => e.code === 2 && /Missing <url>/.test(e.stderr));
    await assert.rejects(run('node', [BIN, site.url, '--depth', 'x']), (e) => e.code === 2);
    await assert.rejects(run('node', [BIN, site.url, '--bogus']), (e) => e.code === 2);
    await assert.rejects(run('node', [BIN, site.url + '/missing', '--out', out]), (e) => e.code === 1 && /no pages were saved/.test(e.stderr));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
