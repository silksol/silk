// Model Context Protocol server over stdio: JSON-RPC 2.0, one JSON message per
// line on stdin and stdout. Logs go to stderr only, stdout carries protocol.

import { createInterface } from 'node:readline';
import { VERSION, crawl } from './crawl.js';
import { crawlToFile, crawlSummary, chunkFile, indexFile, loadIndex, askIndex } from './pipeline.js';
import { readJsonl } from './dataset.js';
import { datasetStats } from './stats.js';

const PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18'];
const LATEST = '2025-06-18';
const MAX_PAGES_CAP = 200;

export const TOOLS = [
  {
    name: 'crawl_site',
    description:
      'Crawl a website politely (robots.txt, crawl delays, noindex, canonical links) and return clean page text. ' +
      `Bounded to at most ${MAX_PAGES_CAP} pages. With "out", records are written to a JSONL file and only a summary is returned.`,
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Start URL (http or https).' },
        max_pages: { type: 'integer', minimum: 1, maximum: MAX_PAGES_CAP, default: 20, description: 'Pages to save.' },
        depth: { type: 'integer', minimum: 0, maximum: 10, default: 2, description: 'Link depth from the start URL.' },
        sitemap: { type: 'string', description: '"auto" to seed from robots.txt Sitemap: lines or /sitemap.xml, or a sitemap URL.' },
        include: { type: 'string', description: 'Regex; only discovered URLs matching it are queued.' },
        exclude: { type: 'string', description: 'Regex; discovered URLs matching it are never queued.' },
        out: { type: 'string', description: 'Optional JSONL file path to write records to.' },
        delay_ms: { type: 'integer', minimum: 0, default: 500, description: 'Minimum milliseconds between requests to one host.' },
        max_chars: { type: 'integer', minimum: 100, default: 4000, description: 'Per-page text limit in the inline result.' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'chunk_dataset',
    description:
      'Split a crawled JSONL dataset into retrieval chunks (token-aware, heading and paragraph boundaries first, with overlap). ' +
      'Optionally also build a BM25 search index from the chunks.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Dataset JSONL file from crawl_site or "silk <url>".' },
        out: { type: 'string', description: 'Chunks JSONL output path. Default: <path>.chunks.jsonl' },
        size: { type: 'integer', minimum: 16, default: 512, description: 'Target chunk size in estimated tokens.' },
        overlap: { type: 'integer', minimum: 0, default: 64, description: 'Overlap between consecutive chunks in tokens.' },
        index_out: { type: 'string', description: 'If set, also write a BM25 index to this path for search_index.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_index',
    description:
      'Ask a question against a silk BM25 index. Returns ranked passages with URL and heading path and a short extractive answer. ' +
      'With llm=true and an API key in the server environment, a hosted model writes a cited answer.',
    inputSchema: {
      type: 'object',
      properties: {
        index: { type: 'string', description: 'Path to an index file built by chunk_dataset or "silk index".' },
        question: { type: 'string', description: 'Natural language question or keywords.' },
        k: { type: 'integer', minimum: 1, maximum: 50, default: 5, description: 'Number of passages.' },
        llm: { type: 'boolean', default: false, description: 'Use ANTHROPIC_API_KEY or OPENAI_API_KEY for a cited answer.' },
      },
      required: ['index', 'question'],
      additionalProperties: false,
    },
  },
  {
    name: 'dataset_stats',
    description: 'Statistics for a JSONL dataset: pages, words, estimated tokens, average length, top domains and duplicate rate.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Dataset or chunks JSONL file.' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
];

class InvalidParams extends Error {}

function need(args, key, type) {
  const v = args[key];
  if (v === undefined) return undefined;
  const ok = type === 'integer' ? Number.isInteger(v) : typeof v === type;
  if (!ok) throw new InvalidParams(`"${key}" must be ${type === 'integer' ? 'an integer' : 'a ' + type}`);
  return v;
}

function required(args, key) {
  const v = need(args, key, 'string');
  if (!v) throw new InvalidParams(`Missing required argument "${key}"`);
  return v;
}

const clamp = (v, lo, hi, dflt) => (v === undefined ? dflt : Math.min(hi, Math.max(lo, v)));

export function createHandlers({ env = process.env, fetch } = {}) {
  return {
    async crawl_site(args) {
      const url = required(args, 'url');
      const options = {
        maxPages: clamp(need(args, 'max_pages', 'integer'), 1, MAX_PAGES_CAP, 20),
        depth: clamp(need(args, 'depth', 'integer'), 0, 10, 2),
        delay: clamp(need(args, 'delay_ms', 'integer'), 0, 60000, 500),
        sitemap: need(args, 'sitemap', 'string') || null,
        include: need(args, 'include', 'string'),
        exclude: need(args, 'exclude', 'string'),
        fetch,
      };
      const out = need(args, 'out', 'string');
      const maxChars = clamp(need(args, 'max_chars', 'integer'), 100, 100000, 4000);
      if (out) {
        const records = [];
        const { summary } = await crawlToFile(url, { ...options, out, onRecord: (r) => records.push({ url: r.url, title: r.title, words: r.words }) });
        return { ...summary, records };
      }
      const job = crawl(url, options);
      const records = [];
      for await (const r of job) {
        records.push({ url: r.url, title: r.title, words: r.words, headings: r.headings, text: r.text.length > maxChars ? r.text.slice(0, maxChars) + ' [truncated]' : r.text });
      }
      return { ...crawlSummary(job), records };
    },
    async chunk_dataset(args) {
      const path = required(args, 'path');
      const out = need(args, 'out', 'string') || path.replace(/\.jsonl$/i, '') + '.chunks.jsonl';
      const result = await chunkFile(path, out, { size: need(args, 'size', 'integer') ?? 512, overlap: need(args, 'overlap', 'integer') ?? 64 });
      const indexOut = need(args, 'index_out', 'string');
      if (indexOut) result.index = await indexFile(out, indexOut);
      return result;
    },
    async search_index(args) {
      const index = await loadIndex(required(args, 'index'));
      const result = await askIndex(index, required(args, 'question'), {
        k: clamp(need(args, 'k', 'integer'), 1, 50, 5), llm: need(args, 'llm', 'boolean') || false, env, fetch,
      });
      return result;
    },
    async dataset_stats(args) {
      return datasetStats(await readJsonl(required(args, 'path')));
    },
  };
}

/** Handle one parsed JSON-RPC message. Returns a response object, or null for notifications. */
export async function handleMessage(msg, handlers) {
  const isRequest = msg && msg.id !== undefined && msg.id !== null;
  const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id: isRequest ? msg.id : null, error: { code, message } });
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(-32600, 'Invalid Request');
  if (!isRequest) return null; // notifications/initialized and friends need no answer

  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion;
      return reply({
        protocolVersion: PROTOCOLS.includes(asked) ? asked : LATEST,
        capabilities: { tools: {} },
        serverInfo: { name: 'silk', version: VERSION },
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const { name, arguments: args = {} } = msg.params || {};
      const handler = typeof name === 'string' && Object.hasOwn(handlers, name) ? handlers[name] : null;
      if (!handler) return fail(-32602, `Unknown tool: ${name}`);
      if (!args || typeof args !== 'object' || Array.isArray(args)) return fail(-32602, 'arguments must be an object');
      try {
        const result = await handler(args);
        return reply({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
      } catch (err) {
        if (err instanceof InvalidParams) return fail(-32602, err.message);
        return reply({ content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });
      }
    }
    default:
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

/** Run the server on stdin/stdout until stdin closes. */
export function serveMcp({ input = process.stdin, output = process.stdout, log = process.stderr, ...opts } = {}) {
  const handlers = createHandlers(opts);
  const rl = createInterface({ input, crlfDelay: Infinity });
  const pending = new Set();
  log.write(`silk ${VERSION} MCP server ready on stdio\n`);
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      output.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
      return;
    }
    const task = handleMessage(msg, handlers)
      .then((res) => { if (res) output.write(JSON.stringify(res) + '\n'); })
      .catch((err) => log.write(`silk mcp: ${err.stack || err}\n`))
      .finally(() => pending.delete(task));
    pending.add(task);
  });
  return new Promise((resolve) => rl.on('close', () => Promise.all(pending).then(resolve)));
}
