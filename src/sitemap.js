// sitemap.xml support (https://www.sitemaps.org/protocol.html):
// <urlset> files with <url><loc>, <sitemapindex> files that point at more
// sitemaps, and gzip-compressed sitemaps. Parsing is a small regex pass,
// which is enough for the strict, flat format the protocol defines.

import { gunzipSync } from 'node:zlib';
import { decodeEntities } from './extract.js';

const LOC = /<loc\b[^>]*>([\s\S]*?)<\/loc\s*>/gi;

function locs(xml) {
  const out = [];
  let m;
  LOC.lastIndex = 0;
  while ((m = LOC.exec(xml))) {
    const raw = decodeEntities(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim();
    if (raw) out.push(raw);
  }
  return out;
}

/**
 * Parse one sitemap document.
 * @returns {{ type: 'urlset' | 'index' | 'unknown', urls: string[] }}
 */
export function parseSitemap(xml) {
  const text = String(xml || '');
  if (/<sitemapindex\b/i.test(text)) return { type: 'index', urls: locs(text) };
  if (/<urlset\b/i.test(text)) return { type: 'urlset', urls: locs(text) };
  return { type: 'unknown', urls: [] };
}

/**
 * Fetch sitemaps breadth-first, following sitemap indexes, and return the page
 * URLs they list. Failures are collected in `errors` instead of thrown.
 *
 * @param {string[]} roots sitemap URLs to start from
 * @param {object} o
 * @param {(url: string) => Promise<Response>} o.request
 * @param {number} [o.maxSitemaps=50] stop after this many sitemap files
 * @param {number} [o.maxUrls=50000] stop after this many page URLs
 */
export async function readSitemaps(roots, { request, maxSitemaps = 50, maxUrls = 50000 }) {
  const queue = [...roots];
  const seen = new Set(queue);
  const urls = [];
  const errors = [];
  let files = 0;
  while (queue.length && files < maxSitemaps && urls.length < maxUrls) {
    const url = queue.shift();
    files++;
    let xml;
    try {
      const res = await request(url);
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new Error(`HTTP ${res.status}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      // fetch already undoes Content-Encoding: gzip. A .xml.gz file served as
      // application/gzip still arrives compressed; the magic bytes tell.
      xml = (buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf).toString('utf8');
    } catch (err) {
      errors.push({ url, message: err.message || String(err) });
      continue;
    }
    const doc = parseSitemap(xml);
    if (doc.type === 'unknown') errors.push({ url, message: 'not a sitemap document' });
    for (const loc of doc.urls) {
      let abs;
      try { abs = new URL(loc, url).href; } catch { continue; }
      if (doc.type === 'index') {
        if (!seen.has(abs)) { seen.add(abs); queue.push(abs); }
      } else if (urls.length < maxUrls) {
        urls.push(abs);
      }
    }
  }
  return { urls, files, errors };
}
