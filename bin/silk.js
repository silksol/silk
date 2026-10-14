#!/usr/bin/env node
// silk command line interface.

import { VERSION, DEFAULTS } from '../src/crawl.js';
import { CHUNK_DEFAULTS } from '../src/chunk.js';
import { crawlToFile, chunkFile, indexFile, loadIndex, askIndex } from '../src/pipeline.js';
import { readJsonl } from '../src/dataset.js';
import { datasetStats, formatStats } from '../src/stats.js';
import { exportDataset, EXPORT_FORMATS } from '../src/export.js';

const HELP = `silk ${VERSION}
any site in, clean dataset out.

Usage
  silk <url> [options]                 crawl a site to JSONL (same as "silk crawl")
  silk chunk <dataset.jsonl> [options] cut pages into chunks for RAG
  silk index <chunks.jsonl> [options]  build a local BM25 index, one JSON file
  silk ask "<question>" [options]      search the index, get passages and an answer
  silk export <dataset.jsonl> [opts]   jsonl, a markdown folder or a Hugging Face folder
  silk stats <dataset.jsonl>           pages, words, tokens, domains, dupes
  silk ui [--port 4321]                local dashboard on 127.0.0.1
  silk mcp                             MCP server on stdio for Claude, Cursor and co

Crawl options
  --max-pages <n>      stop after n saved pages (default ${DEFAULTS.maxPages})
  --depth <n>          max link depth from the start URL (default ${DEFAULTS.depth})
  --concurrency <n>    requests in flight (default ${DEFAULTS.concurrency})
  --delay <ms>         min gap between two requests to one host (default ${DEFAULTS.delay})
  --out <file>         output JSONL, "-" for stdout (default dataset.jsonl)
  --sitemap <src>      seed from sitemaps: "auto" (robots.txt, then /sitemap.xml) or a URL
  --resume             append to --out, skip URLs and text already in it
  --same-host <bool>   stay on the start URL's host (default true)
  --include <regex>    only queue URLs that match
  --exclude <regex>    never queue URLs that match
  --user-agent <ua>    User-Agent header and robots.txt identity
  --timeout <ms>       per-request timeout (default ${DEFAULTS.timeout})

chunk     --size <tokens> (${CHUNK_DEFAULTS.size})  --overlap <tokens> (${CHUNK_DEFAULTS.overlap})  --out <file> (chunks.jsonl)
index     --out <file> (silk.index.json)
ask       --index <file> (silk.index.json)  --k <n> (5)  --llm
export    --format ${EXPORT_FORMATS.join('|')} (jsonl)  --out <path>  --name <dataset name>
stats     --top <n> (10)
ui        --port <n> (4321)  --host <addr> (127.0.0.1)  --dir <folder> (silk-data)  --index <file>

Common
  --json               JSON output for scripts
  --quiet              no progress output
  -h, --help           this help
  -v, --version        print the version

Examples
  silk https://docs.example.com --sitemap auto --max-pages 200 --out docs.jsonl
  silk chunk docs.jsonl --size 512 --overlap 64 --out chunks.jsonl
  silk index chunks.jsonl --out silk.index.json
  silk ask "how do I configure retries?" --index silk.index.json --k 5

Docs: https://github.com/OWNER/silk
`;

const FLAGS = {
  'max-pages': 'number', depth: 'number', concurrency: 'number', delay: 'number', timeout: 'number',
  out: 'string', 'same-host': 'boolean', include: 'string', exclude: 'string', 'user-agent': 'string',
  sitemap: 'string', resume: 'flag', size: 'number', overlap: 'number', index: 'string', k: 'number', llm: 'flag',
  format: 'string', name: 'string', top: 'number', port: 'number', host: 'string', dir: 'string',
  json: 'flag', quiet: 'flag', help: 'flag', version: 'flag',
};

const ALLOWED = {
  crawl: ['max-pages', 'depth', 'concurrency', 'delay', 'timeout', 'out', 'same-host', 'include', 'exclude', 'user-agent', 'sitemap', 'resume'],
  chunk: ['size', 'overlap', 'out'],
  index: ['out'],
  ask: ['index', 'k', 'llm'],
  export: ['format', 'out', 'name'],
  stats: ['top'],
  ui: ['port', 'host', 'dir', 'index'],
  mcp: [],
};
const COMMON = ['json', 'quiet', 'help', 'version'];

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    if (arg === '-h') arg = '--help';
    if (arg === '-v') arg = '--version';
    if (!arg.startsWith('--') || arg === '--') {
      opts._.push(arg);
      continue;
    }
    let [name, value] = arg.slice(2).split(/=(.*)/s);
    const kind = FLAGS[name];
    if (!kind) throw new UsageError(`Unknown option --${name}`);
    if (kind === 'flag') {
      opts[name] = true;
      continue;
    }
    if (value === undefined) {
      value = argv[++i];
      if (value === undefined) throw new UsageError(`Option --${name} needs a value`);
    }
    if (kind === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) throw new UsageError(`Option --${name} expects a non-negative number, got "${value}"`);
      opts[name] = n;
    } else if (kind === 'boolean') {
      if (!/^(true|false|1|0|yes|no)$/i.test(value)) throw new UsageError(`Option --${name} expects true or false, got "${value}"`);
      opts[name] = /^(true|1|yes)$/i.test(value);
    } else {
      opts[name] = value;
    }
  }
  return opts;
}

function checkFlags(command, args) {
  for (const key of Object.keys(args)) {
    if (key === '_' || COMMON.includes(key) || ALLOWED[command].includes(key)) continue;
    throw new UsageError(`Option --${key} does not apply to "silk ${command}"`);
  }
}

const fmt = (n) => Number(n).toLocaleString('en-US');
const short = (u, max = 60) => (u.length > max ? u.slice(0, max - 3) + '...' : u);
const print = (s) => process.stdout.write(s);
const printJson = (v) => print(JSON.stringify(v, null, 2) + '\n');

function one(args, what) {
  if (args._.length !== 1) throw new UsageError(args._.length ? `Expected exactly one ${what}` : `Missing <${what}>`);
  return args._[0];
}

async function cmdCrawl(args) {
  let url = one(args, 'url');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = 'https://' + url;
  const outPath = args.out ?? 'dataset.jsonl';
  const toStdout = outPath === '-';
  if (toStdout && args.resume) throw new UsageError('--resume needs a file for --out');
  const tty = process.stderr.isTTY;
  const log = (line) => !args.quiet && process.stderr.write(line);

  const onProgress = (e) => {
    if (args.quiet) return;
    const s = e.stats;
    if (tty) {
      const status = `[silk] ${s.pages} pages, ${fmt(s.words)} words, queue ${e.queue} | ${e.type} ${short(e.url, 50)}`;
      process.stderr.write('\r\x1b[K' + status.slice(0, (process.stderr.columns || 100) - 1));
    } else if (e.type === 'sitemap') {
      log(`  sitemap  ${short(e.url)}  (${e.urls} URLs queued)\n`);
    } else if (e.type !== 'fetch') {
      const detail = e.type === 'page' ? `${e.words} words` : e.type === 'error' ? e.message : e.type;
      log(`  ${e.type === 'page' ? 'saved  ' : 'skip   '}  ${short(e.url)}  (${detail})\n`);
    }
  };

  const options = {
    maxPages: args['max-pages'], depth: args.depth, concurrency: args.concurrency, delay: args.delay,
    timeout: args.timeout, sameHost: args['same-host'], include: args.include, exclude: args.exclude,
    userAgent: args['user-agent'], sitemap: args.sitemap || null, onProgress,
  };
  let result;
  try {
    log(`silk ${VERSION}: crawling ${url}${args.resume ? ` (resuming ${outPath})` : ''}\n`);
    result = await crawlToFile(url, { ...options, out: outPath, resume: !!args.resume, stream: toStdout ? process.stdout : null });
  } catch (err) {
    if (err instanceof TypeError) throw new UsageError(err.message);
    throw err;
  }
  if (tty && !args.quiet) process.stderr.write('\r\x1b[K');

  const { summary } = result;
  if (args.json) {
    (toStdout ? process.stderr : process.stdout).write(JSON.stringify(summary, null, 2) + '\n');
  } else {
    const k = summary.skipped;
    log(
      `\nDone in ${summary.seconds}s\n` +
      `  pages        ${fmt(summary.pages)}${args.resume ? ` new (${fmt(summary.resumed)} already in ${outPath})` : ''}\n` +
      `  words        ${fmt(summary.words)}\n` +
      `  est. tokens  ${fmt(summary.tokens_est)}\n` +
      (args.sitemap ? `  sitemaps     ${summary.sitemap.files} read, ${fmt(summary.sitemap.urls)} URLs queued\n` : '') +
      `  robots.txt   ${fmt(k.robots)} skipped\n` +
      `  other skips  ${k.non_html} non-HTML, ${k.duplicates} duplicate, ${k.noindex} noindex, ${k.canonical} canonical${args.resume ? `, ${k.known} known` : ''}\n` +
      `  errors       ${fmt(summary.errors)}\n` +
      `  output       ${toStdout ? 'stdout' : outPath}\n`,
    );
  }
  if (summary.pages === 0 && !(args.resume && summary.resumed)) {
    const reason = summary.error_samples[0] ? `: ${summary.error_samples[0].message}` : summary.skipped.robots ? ' (blocked by robots.txt)' : '';
    process.stderr.write(`silk: no pages were saved${reason}\n`);
    return 1;
  }
  return 0;
}

async function cmdChunk(args) {
  const input = one(args, 'dataset.jsonl');
  const out = args.out ?? 'chunks.jsonl';
  let r;
  try {
    r = await chunkFile(input, out, { size: args.size ?? CHUNK_DEFAULTS.size, overlap: args.overlap ?? CHUNK_DEFAULTS.overlap });
  } catch (err) {
    if (err instanceof RangeError) throw new UsageError(err.message);
    throw err;
  }
  if (args.json) return printJson(r);
  print(`Chunked ${fmt(r.pages)} pages into ${fmt(r.chunks)} chunks (avg ${fmt(r.avg_tokens)} tokens, max ${fmt(r.max_tokens)})\n  output  ${out}\n`);
}

async function cmdIndex(args) {
  const input = one(args, 'chunks.jsonl');
  const r = await indexFile(input, args.out ?? 'silk.index.json');
  if (args.json) return printJson(r);
  print(`Indexed ${fmt(r.docs)} chunks, ${fmt(r.terms)} terms (avg ${r.avgdl} terms per chunk)\n  output  ${r.out}\n`);
}

function wrap(text, width = 76, indent = '  ') {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && (line + ' ' + word).length > width) { lines.push(indent + line); line = word; } else line = line ? line + ' ' + word : word;
  }
  if (line) lines.push(indent + line);
  return lines.join('\n');
}

async function cmdAsk(args) {
  const question = args._.join(' ').trim();
  if (!question) throw new UsageError('Missing "<question>"');
  const index = await loadIndex(args.index ?? 'silk.index.json');
  const r = await askIndex(index, question, { k: args.k || 5, llm: !!args.llm });
  if (args.json) return printJson(r);
  if (!r.passages.length) {
    print('No passage matches those terms.\n');
    return 1;
  }
  const answer = r.llm ? r.llm.text : r.answer || 'No sentence in the top passages matches the question well.';
  print(`${r.llm ? `Answer (${r.llm.provider}, ${r.llm.model})` : 'Answer (extractive)'}\n${r.llm ? answer.split('\n').map((l) => '  ' + l).join('\n') : wrap(answer)}\n\nSources\n`);
  r.passages.forEach((p, i) => {
    const where = [p.title, ...p.heading_path.filter((h) => h !== p.title)].join(' > ');
    print(`  [${i + 1}] ${p.score.toFixed(2).padStart(5)}  ${where}\n            ${p.url}\n`);
  });
}

async function cmdExport(args) {
  const input = one(args, 'dataset.jsonl');
  const format = args.format ?? 'jsonl';
  if (!EXPORT_FORMATS.includes(format)) throw new UsageError(`--format must be one of ${EXPORT_FORMATS.join(', ')}`);
  const out = args.out ?? { jsonl: 'export.jsonl', markdown: 'export-md', hf: 'hf-dataset' }[format];
  const r = await exportDataset(await readJsonl(input), { format, out, name: args.name });
  if (args.json) return printJson(r);
  const what = { jsonl: 'JSONL file', markdown: 'Markdown files', hf: 'Hugging Face dataset folder (README.md + data/train.jsonl)' }[format];
  print(`Exported ${fmt(r.pages)} pages as ${what}\n  output  ${out}\n`);
}

async function cmdStats(args) {
  const input = one(args, 'dataset.jsonl');
  const s = datasetStats(await readJsonl(input), { top: args.top ?? 10 });
  if (args.json) return printJson(s);
  print(formatStats(s, input));
}

async function cmdUi(args) {
  const { startDashboard } = await import('../src/ui.js');
  const ui = await startDashboard({ port: args.port ?? 4321, host: args.host ?? '127.0.0.1', dir: args.dir ?? 'silk-data', index: args.index });
  process.stderr.write(`silk ${VERSION} dashboard: ${ui.url}\n  workspace  ${ui.files.dataset.replace(/dataset\.jsonl$/, '')}\n  Press Ctrl+C to stop.\n`);
  await new Promise(() => {}); // run until interrupted
}

async function cmdMcp() {
  const { serveMcp } = await import('../src/mcp.js');
  await serveMcp();
}

const COMMANDS = { crawl: cmdCrawl, chunk: cmdChunk, index: cmdIndex, ask: cmdAsk, export: cmdExport, stats: cmdStats, ui: cmdUi, mcp: cmdMcp };

async function main(argv) {
  const args = parseArgs(argv);
  if (args.version) return void print(VERSION + '\n');
  let command = 'crawl';
  if (args._.length && Object.hasOwn(COMMANDS, args._[0])) command = args._.shift();
  if (args.help || (!argv.length)) {
    if (!argv.length) throw new UsageError('Missing <url> or command');
    return void print(HELP);
  }
  checkFlags(command, args);
  const code = await COMMANDS[command](args);
  return typeof code === 'number' ? code : 0;
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code ?? 0; },
  (err) => {
    if (err instanceof UsageError) {
      process.stderr.write(`silk: ${err.message}\nRun "silk --help" for usage.\n`);
      process.exitCode = 2;
    } else {
      process.stderr.write(`silk: ${err.code === 'ENOENT' ? `file not found: ${err.path}` : err.message}\n`);
      process.exitCode = 1;
    }
  },
);
