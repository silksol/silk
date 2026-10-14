// A tiny local website used by the tests and the README demo.
// "ORIGIN" in a response body is replaced with the server's own origin, so
// robots.txt and the sitemaps can carry absolute URLs.
import http from 'node:http';
import { gzipSync } from 'node:zlib';

const page = (title, body, head = '') => `<!doctype html>
<html><head><title>${title}</title>${head}</head>
<body>
<nav><a href="/">Home</a> <a href="/docs/">Docs</a> <a href="/blog">Blog</a></nav>
<main>${body}</main>
<footer>Copyright 2026 Example Project. <a href="/legal">Legal</a></footer>
<script>window.analytics = "<p>do not index</p>";</script>
</body></html>`;

export const routes = {
  '/robots.txt': ['text/plain', `# fixture robots
User-agent: BadBot
Disallow: /

User-agent: *
Disallow: /private
Allow: /private/open
Crawl-delay: 0

Sitemap: ORIGIN/sitemap_index.xml
`],
  '/sitemap_index.xml': ['application/xml', `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>ORIGIN/sitemap-pages.xml</loc><lastmod>2026-10-01</lastmod></sitemap>
  <sitemap><loc>ORIGIN/sitemap-guides.xml.gz</loc></sitemap>
  <sitemap><loc>ORIGIN/sitemap-missing.xml</loc></sitemap>
</sitemapindex>`],
  '/sitemap-pages.xml': ['application/xml', `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>ORIGIN/</loc></url>
  <url><loc>ORIGIN/docs/</loc><lastmod>2026-10-01</lastmod></url>
  <url><loc>ORIGIN/private/keys</loc></url>
  <url><loc>ORIGIN/changelog?v=1&amp;lang=en</loc></url>
  <url><loc>https://other.example.org/elsewhere</loc></url>
</urlset>`],
  // Served gzip-compressed without Content-Encoding, like many .xml.gz files.
  '/sitemap-guides.xml.gz': ['application/gzip', null, `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>ORIGIN/guides/retries</loc></url>
  <url><loc>ORIGIN/guides/caching</loc></url>
</urlset>`],
  '/changelog?lang=en&v=1': ['text/html', page('Changelog', `<h1>Changelog</h1><p>Version 2.0 adds strict mode and environment expansion.</p>`)],
  '/guides/retries': ['text/html', page('Retries | Example Project', `
<h1>Retries</h1>
<p>Network calls made by the loader are retried automatically when they fail with a timeout or a 5xx status.</p>
<h2>Configure retries</h2>
<p>Set the retries option to the number of attempts you want. The default is three attempts with exponential backoff starting at 200 milliseconds.</p>
<pre><code class="language-js">parse(src, { retries: 5, backoff: 'exponential' });</code></pre>
<h2>Disable retries</h2>
<p>Pass retries: 0 to fail fast. This is useful in tests where a slow mock should surface immediately.</p>`)],
  '/guides/caching': ['text/html', page('Caching | Example Project', `
<h1>Caching</h1>
<p>Parsed configuration is cached in memory by file path and modification time.</p>
<h2>Cache invalidation</h2>
<p>Call clearCache() after editing a file programmatically. The cache never stores secrets expanded from environment variables.</p>`)],
  '/': ['text/html; charset=utf-8', page('Example Project', `
<h1>Example Project</h1>
<p>Example Project is a small library for parsing &amp; validating   configuration files.</p>
<ul><li><a href="/docs/">Read the docs</a></li><li><a href="/docs/install?b=2&amp;a=1#top">Install guide</a></li></ul>
<p><a href="/private/keys">Private keys</a> <a href="/private/open">Open notes</a>
<a href="/whitepaper.pdf">Whitepaper (PDF)</a> <a href="/dup-a">Copy A</a> <a href="/dup-b">Copy B</a>
<a href="/hidden">Draft</a> <a href="/print">Print view</a> <a href="/deep/1">Deep</a>
<a href="https://other.example.org/">External</a> <a href="mailto:hi@example.com">Mail</a></p>`)],
  '/docs': ['text/html', page('Docs | Example Project', `
<article><h1>Documentation</h1>
<p>Welcome to the docs. Start with the <code>parse()</code> function.</p>
<h2>Quick start</h2>
<pre><code class="language-js">import { parse } from 'example';
const cfg = parse('a = 1');
if (cfg.a &lt; 2) console.log(cfg);</code></pre>
<h2>Options</h2>
<ol><li>strict: fail on unknown keys</li><li>env: expand environment variables</li></ol>
<aside>Was this page helpful? Yes No</aside>
</article>`)],
  '/docs/install?a=1&b=2': ['text/html', page('Install', `<h1>Install</h1><p>Run npm install example to get started.</p>`)],
  '/private/keys': ['text/html', page('Secret', `<h1>Secret</h1><p>This must never be fetched.</p>`)],
  '/private/open': ['text/html', page('Open notes', `<h1>Open notes</h1><p>Allowed by a more specific Allow rule.</p>`)],
  '/whitepaper.pdf': ['application/pdf', '%PDF-1.4 fake'],
  '/dup-a': ['text/html', page('Copy', `<h1>Mirror</h1><p>The same article published twice.</p>`)],
  '/dup-b': ['text/html', page('Copy', `<h1>Mirror</h1><p>The same article published twice.</p>`)],
  '/hidden': ['text/html', page('Draft', `<h1>Draft</h1><p>Not ready.</p><a href="/hidden-child">child</a>`,
    '<meta name="robots" content="noindex, nofollow">')],
  '/hidden-child': ['text/html', page('Child', `<h1>Child</h1><p>Only linked from a nofollow page.</p>`)],
  '/print': ['text/html', page('Docs (print)', `<h1>Documentation (print)</h1><p>Printable copy.</p>`,
    '<link rel="canonical" href="/docs/">')],
  '/blog': ['text/html', page('Blog', `<h1>Blog</h1><p>Release notes and updates.</p>`,
    '<meta name="robots" content="noindex">')],
  '/legal': ['text/html', page('Legal', `<h1>Legal</h1><p>MIT licensed.</p>`)],
  '/deep/1': ['text/html', page('Deep 1', `<h1>Level one</h1><p>First level.</p><a href="/deep/2">next</a>`)],
  '/deep/2': ['text/html', page('Deep 2', `<h1>Level two</h1><p>Second level.</p><a href="/deep/3">next</a>`)],
  '/deep/3': ['text/html', page('Deep 3', `<h1>Level three</h1><p>Third level.</p><a href="/deep/4">next</a>`)],
  '/deep/4': ['text/html', page('Deep 4', `<h1>Level four</h1><p>Fourth level.</p>`)],
};

/** Start the fixture server. Resolves to { url, requests, close }. */
export function startSite(port = 0) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    requests.push(u.pathname + u.search);
    let path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : u.pathname;
    if (u.search) path += '?' + [...u.searchParams].map(([k, v]) => `${k}=${v}`).sort().join('&');
    const route = routes[path];
    if (!route) {
      res.writeHead(404, { 'content-type': 'text/html' });
      return res.end('<h1>Not found</h1>');
    }
    const origin = `http://${req.headers.host}`;
    const fill = (body) => body.replaceAll('ORIGIN', origin);
    res.writeHead(200, { 'content-type': route[0] });
    res.end(route[1] === null ? gzipSync(fill(route[2])) : fill(route[1]));
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}
