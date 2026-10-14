import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  tokenize, stem, sentences, chunkRecords, chunkText, sections, buildIndex, search, ask, datasetStats,
  exportDataset, llmAnswer, llmProvider, crawl, estimateTokens,
} from '../src/index.js';
import { startSite } from '../fixtures/site.js';

const run = promisify(execFile);
const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'silk.js');
let site;
let dir;
let pages;
before(async () => {
  site = await startSite();
  dir = await mkdtemp(join(tmpdir(), 'silk-rag-'));
  pages = await crawl(site.url, { delay: 0, sitemap: 'auto' }).toArray();
});
after(async () => {
  await site.close();
  await rm(dir, { recursive: true, force: true });
});

test('tokenizer: lowercase, stopwords, stemming', () => {
  assert.deepEqual(tokenize('The Crawler is crawling; it crawled and crawls!'), ['crawl', 'crawl', 'crawl', 'crawl']);
  assert.deepEqual(tokenize("Running parsers' retries in 2026"), ['run', 'pars', 'retry', '2026']);
  assert.equal(stem('configuration'), stem('configurations'));
  assert.equal(stem('libraries'), 'library');
  assert.equal(stem('class'), 'class');
  assert.equal(stem('status'), 'status');
  assert.equal(stem('use'), 'use');
  assert.deepEqual(sentences('# Title\n\nFirst one. Second one?\n```js\ncode();\n```\n- item here'), ['Title', 'First one.', 'Second one?', 'item here']);
});

test('sections keep the heading path; fenced code is not a heading', () => {
  const s = sections('# A\n\nintro\n\n## B\n\nb text\n\n```py\n# not a heading\n```\n\n### C\n\nc text\n\n## D\n\n# E\n\ne text');
  assert.deepEqual(s.map((x) => x.headingPath), [['A'], ['A', 'B'], ['A', 'B', 'C'], ['E']]);
  assert.match(s[1].text, /# not a heading/);
});

test('chunkText respects size, splits on paragraphs first and overlaps', () => {
  const para = (n, w) => Array.from({ length: w }, (_, i) => `p${n}w${i}`).join(' ');
  const text = [para(1, 40), para(2, 40), para(3, 40), para(4, 200)].join('\n\n');
  const chunks = chunkText(text, { size: 120, overlap: 16 });
  for (const c of chunks) assert.ok(estimateTokens(c.split(/\s+/).length) <= 120, `chunk too big: ${c.split(/\s+/).length} words`);
  assert.ok(chunks[0].startsWith('p1w0') && chunks[0].includes('p2w39') && !chunks[0].includes('p3w'), 'paragraphs 1 and 2 fit together');
  assert.ok(chunks[1].startsWith('p2w'), 'second chunk starts with the overlap from the first');
  assert.ok(chunks[1].includes('p3w0'));
  assert.ok(chunks.at(-1).includes('p4w199'), 'oversized paragraph split by words, nothing lost');
  assert.deepEqual(chunkText(text, { size: 100, overlap: 0 }).join(' ').split(/\s+/).length, 320);
  assert.throws(() => chunkText('x', { size: 64, overlap: 64 }), /overlap/);
  assert.throws(() => chunkText('x', { size: 4 }), /size/);
});

test('chunkRecords on the crawled fixture: metadata, ids and heading paths', () => {
  const chunks = chunkRecords(pages, { size: 128, overlap: 16 });
  const retries = chunks.filter((c) => c.url.endsWith('/guides/retries'));
  assert.deepEqual(retries.map((c) => c.heading_path), [['Retries'], ['Retries', 'Configure retries'], ['Retries', 'Disable retries']]);
  assert.deepEqual(retries.map((c) => c.chunk_index), [0, 1, 2]);
  assert.equal(retries[0].title, 'Retries | Example Project');
  assert.match(retries[1].text, /```js\nparse\(src/);
  assert.equal(new Set(chunks.map((c) => c.id)).size, chunks.length);
  for (const c of chunks) assert.equal(c.tokens_est, estimateTokens(c.words));
});

test('BM25 index ranks the right section first and answers extractively', () => {
  const index = buildIndex(chunkRecords(pages, { size: 128, overlap: 16 }));
  assert.equal(index.format, 'silk-index');
  assert.ok(index.stats.docs > 10 && index.stats.terms > 50);
  const json = JSON.parse(JSON.stringify(index)); // survives a round trip to disk

  const hits = search(json, 'how do I configure retries', { k: 3 });
  assert.equal(hits.length, 3);
  assert.deepEqual(hits[0].heading_path, ['Retries', 'Configure retries']);
  assert.ok(hits[0].score > hits[1].score);
  assert.equal(search(json, 'cache invalidation', { k: 1 })[0].heading_path.at(-1), 'Cache invalidation');
  assert.deepEqual(search(json, 'zzzz qqqq'), []);

  const r = ask(json, 'What is the default number of retry attempts?', { k: 3 });
  assert.match(r.answer, /default is three attempts/);
  assert.ok(r.passages[0].url.endsWith('/guides/retries'));
  assert.throws(() => search({ format: 'other' }, 'x'), /Not a silk index/);
});

test('datasetStats counts duplicates and domains', () => {
  const recs = [
    { url: 'https://a.com/1', text: 'one two three', words: 3, sha256: 'h1' },
    { url: 'https://a.com/2', text: 'one two', words: 2, sha256: 'h1' },
    { url: 'https://b.com/1', text: 'x', words: 1, sha256: 'h2' },
    { url: 'https://a.com/1', text: 'one two three', words: 3, sha256: 'h3' },
  ];
  const s = datasetStats(recs);
  assert.equal(s.pages, 4);
  assert.equal(s.words, 9);
  assert.equal(s.duplicates, 2);
  assert.equal(s.duplicate_rate, 0.5);
  assert.deepEqual(s.top_domains, [{ domain: 'a.com', pages: 3 }, { domain: 'b.com', pages: 1 }]);
  assert.equal(s.median_words, 2.5);
  assert.equal(datasetStats([]).pages, 0);
});

test('export: jsonl, markdown folder and Hugging Face card', async () => {
  const dupes = [...pages, pages[0]];
  const j = await exportDataset(dupes, { format: 'jsonl', out: join(dir, 'x.jsonl') });
  assert.equal(j.pages, pages.length, 'duplicates removed');
  const md = await exportDataset(pages, { format: 'markdown', out: join(dir, 'md') });
  const files = await readdir(join(dir, 'md'));
  assert.equal(files.length, md.pages);
  assert.ok(files.includes('index.md') && files.includes('guides-retries.md'));
  const retries = await readFile(join(dir, 'md', 'guides-retries.md'), 'utf8');
  assert.match(retries, /^---\ntitle: "Retries \| Example Project"\nurl: "http:/);
  assert.match(retries, /\n---\n\n# Retries\n/);
  await exportDataset(pages, { format: 'hf', out: join(dir, 'hf'), name: 'fixture-docs' });
  const card = await readFile(join(dir, 'hf', 'README.md'), 'utf8');
  assert.match(card, /^---\npretty_name: "fixture-docs"\nsize_categories:\n- n<1K/);
  assert.match(card, new RegExp(`\\| Pages \\| ${pages.length} \\|`));
  assert.equal((await readFile(join(dir, 'hf', 'data', 'train.jsonl'), 'utf8')).trim().split('\n').length, pages.length);
  await assert.rejects(exportDataset(pages, { format: 'csv', out: 'x' }), /Unknown format/);
});

/** A mock model API that records requests and answers in the given provider's shape. */
async function mockModel(provider) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    calls.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(provider === 'anthropic'
      ? { content: [{ type: 'text', text: 'Three attempts by default [1].' }] }
      : { choices: [{ message: { content: 'Three attempts by default [1].' } }] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { calls, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

test('--llm: Anthropic and OpenAI requests are well formed (mocked)', async () => {
  const passages = search(buildIndex(chunkRecords(pages)), 'retries default', { k: 2 });
  assert.equal(llmProvider({}), null);
  assert.equal(llmProvider({ OPENAI_API_KEY: 'o', ANTHROPIC_API_KEY: 'a' }), 'anthropic');
  assert.equal(llmProvider({ OPENAI_API_KEY: 'o', ANTHROPIC_API_KEY: 'a', SILK_LLM_PROVIDER: 'openai' }), 'openai');

  const a = await mockModel('anthropic');
  try {
    const r = await llmAnswer('default retries?', passages, { env: { ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_BASE_URL: a.url } });
    assert.deepEqual(r, { provider: 'anthropic', model: 'claude-haiku-5-5', text: 'Three attempts by default [1].' });
    const call = a.calls[0];
    assert.equal(call.url, '/v1/messages');
    assert.equal(call.headers['x-api-key'], 'sk-test');
    assert.equal(call.headers['anthropic-version'], '2023-06-01');
    assert.match(call.body.system, /Cite every claim/);
    assert.match(call.body.messages[0].content, /\[1\] Retries \| Example Project/);
  } finally { await a.close(); }

  const o = await mockModel('openai');
  try {
    const r = await llmAnswer('default retries?', passages, { env: { OPENAI_API_KEY: 'sk-o', OPENAI_BASE_URL: o.url, SILK_LLM_MODEL: 'test-model' } });
    assert.equal(r.provider, 'openai');
    assert.equal(r.model, 'test-model');
    assert.equal(o.calls[0].url, '/chat/completions');
    assert.equal(o.calls[0].headers.authorization, 'Bearer sk-o');
    assert.equal(o.calls[0].body.messages[0].role, 'system');
  } finally { await o.close(); }

  await assert.rejects(llmAnswer('q', passages, { env: {} }), /ANTHROPIC_API_KEY or OPENAI_API_KEY/);
});

test('CLI: crawl, chunk, index, ask, stats, export end to end', async () => {
  const opts = { cwd: dir };
  const crawled = await run('node', [BIN, 'crawl', site.url, '--delay=0', '--sitemap=auto', '--out', 'data.jsonl', '--json', '--quiet'], opts);
  assert.equal(JSON.parse(crawled.stdout).pages, 12);
  assert.equal(JSON.parse(crawled.stdout).sitemap.urls, 5);

  const chunked = JSON.parse((await run('node', [BIN, 'chunk', 'data.jsonl', '--size', '128', '--overlap', '16', '--out', 'chunks.jsonl', '--json'], opts)).stdout);
  assert.equal(chunked.pages, 12);
  assert.ok(chunked.max_tokens <= 128);
  const indexed = await run('node', [BIN, 'index', 'chunks.jsonl'], opts);
  assert.match(indexed.stdout, /Indexed \d+ chunks/);

  const answer = await run('node', [BIN, 'ask', 'how do I disable retries?', '--k', '2'], opts);
  assert.match(answer.stdout, /^Answer \(extractive\)\n/);
  assert.match(answer.stdout, /Pass retries: 0 to fail fast/);
  assert.match(answer.stdout, /\[1\] +[\d.]+ +Retries \| Example Project > Retries > Disable retries/);
  const asJson = JSON.parse((await run('node', [BIN, 'ask', 'cache', '--json'], opts)).stdout);
  assert.equal(asJson.passages[0].url, site.url + '/guides/caching');

  const stats = await run('node', [BIN, 'stats', 'data.jsonl'], opts);
  assert.match(stats.stdout, /pages +12\n/);
  assert.match(stats.stdout, /duplicates +0 \(0\.0%\)/);
  const hf = await run('node', [BIN, 'export', 'data.jsonl', '--format', 'hf', '--out', 'hf', '--json'], opts);
  assert.deepEqual(JSON.parse(hf.stdout), { format: 'hf', out: 'hf', files: 2, pages: 12 });

  await assert.rejects(run('node', [BIN, 'chunk', 'data.jsonl', '--overlap', '600'], opts), (e) => e.code === 2 && /overlap/.test(e.stderr));
  await assert.rejects(run('node', [BIN, 'stats', 'nope.jsonl'], opts), (e) => e.code === 1 && /file not found/.test(e.stderr));
  await assert.rejects(run('node', [BIN, 'stats', 'data.jsonl', '--depth', '2'], opts), (e) => e.code === 2 && /does not apply/.test(e.stderr));
  await assert.rejects(run('node', [BIN, 'ask', 'x', '--llm'], { ...opts, env: { ...process.env, ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' } }), (e) => e.code === 1 && /needs ANTHROPIC_API_KEY/.test(e.stderr));
  await assert.rejects(run('node', [BIN, 'export', 'data.jsonl', '--format', 'csv'], opts), (e) => e.code === 2);
});
