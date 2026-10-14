import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSite } from '../fixtures/site.js';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'silk.js');
let site;
let dir;
let server;

/** Spawn `silk mcp` and talk to it line by line. */
function startServer() {
  const child = spawn(process.execPath, [BIN, 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' } });
  const waiting = new Map();
  const lines = [];
  createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line); // stdout must carry nothing but JSON-RPC
    lines.push(msg);
    waiting.get(msg.id)?.(msg);
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  let nextId = 1;
  return {
    child,
    lines,
    stderr: () => stderr,
    send: (obj) => child.stdin.write((typeof obj === 'string' ? obj : JSON.stringify(obj)) + '\n'),
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve) => {
        waiting.set(id, resolve);
        this.send({ jsonrpc: '2.0', id, method, params });
      });
    },
    async call(name, args) {
      const res = await this.request('tools/call', { name, arguments: args });
      return res;
    },
  };
}

before(async () => {
  site = await startSite();
  dir = await mkdtemp(join(tmpdir(), 'silk-mcp-'));
  server = startServer();
});
after(async () => {
  server.child.stdin.end();
  await new Promise((r) => server.child.on('exit', r));
  await site.close();
  await rm(dir, { recursive: true, force: true });
});

test('initialize, ping and tools/list', async () => {
  const init = await server.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  assert.equal(init.result.protocolVersion, '2025-03-26', 'echoes a supported client version');
  assert.deepEqual(init.result.capabilities, { tools: {} });
  assert.deepEqual(init.result.serverInfo, { name: 'silk', version: '1.1.0' });
  server.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const other = await server.request('initialize', { protocolVersion: '1999-01-01' });
  assert.equal(other.result.protocolVersion, '2025-06-18');
  assert.deepEqual((await server.request('ping')).result, {});

  const { tools } = (await server.request('tools/list')).result;
  assert.deepEqual(tools.map((t) => t.name), ['crawl_site', 'chunk_dataset', 'search_index', 'dataset_stats']);
  for (const t of tools) {
    assert.equal(t.inputSchema.type, 'object');
    assert.ok(t.description.length > 40);
    assert.ok(Array.isArray(t.inputSchema.required));
  }
});

test('crawl_site, chunk_dataset, search_index and dataset_stats against the fixture site', async () => {
  const inline = await server.call('crawl_site', { url: site.url, max_pages: 3, delay_ms: 0, max_chars: 100 });
  assert.equal(inline.result.isError, undefined);
  const crawled = JSON.parse(inline.result.content[0].text);
  assert.equal(crawled.pages, 3);
  assert.equal(crawled.records.length, 3);
  assert.ok(crawled.records.every((r) => r.text.length <= 100 + ' [truncated]'.length));

  const out = join(dir, 'site.jsonl');
  const toFile = JSON.parse((await server.call('crawl_site', { url: site.url, sitemap: 'auto', depth: 3, delay_ms: 0, max_pages: 200, out })).result.content[0].text);
  assert.equal(toFile.pages, 12);
  assert.equal(toFile.records.length, 12);
  assert.equal(toFile.out, out);
  assert.ok(!('text' in toFile.records[0]), 'file mode returns a page list, not the text');

  const index = join(dir, 'site.index.json');
  const chunked = JSON.parse((await server.call('chunk_dataset', { path: out, size: 128, overlap: 16, index_out: index })).result.content[0].text);
  assert.equal(chunked.out, join(dir, 'site.chunks.jsonl'));
  assert.ok(chunked.chunks >= 12);
  assert.equal(chunked.index.docs, chunked.chunks);

  const asked = JSON.parse((await server.call('search_index', { index, question: 'what is the default backoff for retries?', k: 2 })).result.content[0].text);
  assert.equal(asked.passages.length, 2);
  assert.deepEqual(asked.passages[0].heading_path, ['Retries', 'Configure retries']);
  assert.match(asked.answer, /200 milliseconds/);

  const stats = JSON.parse((await server.call('dataset_stats', { path: out })).result.content[0].text);
  assert.equal(stats.pages, 12);
  assert.equal(stats.duplicate_rate, 0);
});

test('errors: tool failures are isError results, protocol errors are JSON-RPC errors', async () => {
  const missing = await server.call('dataset_stats', { path: join(dir, 'nope.jsonl') });
  assert.equal(missing.result.isError, true);
  assert.match(missing.result.content[0].text, /ENOENT|no such file/);

  const llm = await server.call('search_index', { index: join(dir, 'site.index.json'), question: 'retries', llm: true });
  assert.equal(llm.result.isError, true, 'no API key in the server environment');

  assert.equal((await server.request('tools/call', { name: 'nope', arguments: {} })).error.code, -32602);
  assert.equal((await server.call('crawl_site', {})).error.code, -32602);
  assert.equal((await server.call('crawl_site', { url: site.url, max_pages: 'many' })).error.code, -32602);
  assert.equal((await server.request('resources/list')).error.code, -32601);

  const before = server.lines.length;
  server.send('{not json');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(server.lines[before].error.code, -32700);
  assert.match(server.stderr(), /MCP server ready/);
});
