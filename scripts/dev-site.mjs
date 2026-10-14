#!/usr/bin/env node
// Local stand-in for the Vercel deployment: serves docs/ as static files and
// routes /api/<name> to the handler in api/<name>.js, the way Vercel does.
//
//   node scripts/dev-site.mjs                 # http://127.0.0.1:3000
//   node scripts/dev-site.mjs --fixture       # also start the fixture site and allow crawling it
//   node scripts/dev-site.mjs --port 4000
//
// --fixture (and --allow-local) let the crawler reach 127.0.0.1, which the
// production handler refuses. Never use them on a public host.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

/** Start the dev site. Returns { url, close }. */
export async function startDevSite({ port = 3000, host = '127.0.0.1', allowLocal = false, delay } = {}) {
  const handlers = new Map();
  const handlerFor = async (name) => {
    if (!handlers.has(name)) {
      const mod = await import(pathToFileURL(join(root, 'api', name + '.js')).href);
      handlers.set(name, allowLocal && mod.createHandler ? mod.createHandler({ allowLocal: true, ...(delay !== undefined ? { delay } : {}) }) : mod.default);
    }
    return handlers.get(name);
  };

  const server = http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    try {
      const api = pathname.match(/^\/api\/([a-z0-9-]+)$/);
      if (api) {
        let handler;
        try { handler = await handlerFor(api[1]); } catch { handler = null; }
        if (!handler) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
        return await handler(req, res);
      }
      let file = normalize(join(root, 'docs', decodeURIComponent(pathname)));
      if (!file.startsWith(join(root, 'docs'))) { res.writeHead(403); return res.end(); }
      if ((await stat(file).catch(() => null))?.isDirectory()) file = join(file, 'index.html');
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch (err) {
      if (!res.headersSent) res.writeHead(err.code === 'ENOENT' ? 404 : 500, { 'content-type': 'text/plain' });
      res.end(err.code === 'ENOENT' ? 'not found' : String(err));
    }
  });
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(port, host, ok); });
  return { url: `http://${host}:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const port = Number(args[args.indexOf('--port') + 1]) || 3000;
  const fixture = args.includes('--fixture');
  const allowLocal = fixture || args.includes('--allow-local');
  const site = await startDevSite({ port: args.includes('--port') ? port : 3000, allowLocal, delay: fixture ? 150 : undefined });
  console.log(`silk site: ${site.url}`);
  if (fixture) {
    const { startSite } = await import('../fixtures/site.js');
    const f = await startSite();
    console.log(`fixture:   ${f.url}  (try ${site.url}/?url=${encodeURIComponent(f.url)})`);
  }
}
