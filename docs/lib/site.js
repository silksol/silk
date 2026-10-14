// Pure helpers for the silkcrawl.dev page (no DOM), tested in node.

export const MAX_PAGES = 25;
export const PAGE_CHOICES = [5, 10, 25];

/** "docs.example.com/guide" -> "https://docs.example.com/guide". Null when it is not a web address. */
export function normalizeInput(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  if (/^[a-z][a-z0-9+.-]*:(?!\/\/|\d)/i.test(raw)) return null; // mailto:, javascript:, ...
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw;
  let u;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (!u.hostname || (!u.hostname.includes('.') && u.hostname !== 'localhost' && !u.hostname.startsWith('['))) return null;
  u.hash = '';
  return u.href;
}

export function clampPages(n) {
  const v = parseInt(n, 10);
  if (!Number.isFinite(v)) return 10;
  return Math.min(MAX_PAGES, Math.max(1, v));
}

/** Read ?url= and ?max= from a query string. */
export function readQuery(search) {
  const q = new URLSearchParams(search);
  const url = q.get('url') || q.get('site') || '';
  return { url, max: clampPages(q.get('max') ?? 10) };
}

/** The shareable query string for a crawl. */
export function shareQuery(url, max) {
  const q = new URLSearchParams();
  q.set('url', url);
  if (clampPages(max) !== 10) q.set('max', String(clampPages(max)));
  return '?' + q.toString();
}

/** Incremental NDJSON parser: feed text chunks, get whole objects back. */
export function ndjsonSplitter() {
  let buf = '';
  const parse = (lines) => lines.map((l) => l.trim()).filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l)]; } catch { return []; }
  });
  return {
    push(text) {
      buf += text;
      const lines = buf.split('\n');
      buf = lines.pop();
      return parse(lines);
    },
    end() {
      const rest = buf;
      buf = '';
      return parse([rest]);
    },
  };
}

export const toJsonl = (records) => records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');

export const fmt = (n) => Number(n || 0).toLocaleString('en-US');

/** Path plus query of a URL, for compact lists. */
export function pathOf(url) {
  try {
    const u = new URL(url);
    return (u.pathname + u.search) || '/';
  } catch {
    return url;
  }
}

export function hostOf(url) {
  try { return new URL(url).hostname; } catch { return 'site'; }
}

/** File-name safe slug of a host. */
export const fileSlug = (url) => hostOf(url).replace(/^www\./, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'site';

/** Human message for an HTTP error from /api/crawl. */
export function errorFor(status, body) {
  const message = body && typeof body.message === 'string' ? body.message : '';
  if (status === 429) return { title: 'Rate limited', message: message || 'Too many crawls from your network. Wait a few minutes and try again.' };
  if (status === 400 && body?.error === 'blocked') return { title: 'Not a public site', message };
  if (status === 400 && body?.error === 'not_found') return { title: 'Site not found', message };
  if (status === 400) return { title: 'Bad address', message: message || 'That does not look like a web address.' };
  if (status === 0) return { title: 'Crawler unreachable', message: 'The crawl service did not answer. Check your connection and try again.' };
  return { title: 'Crawl failed', message: message || `The crawl service answered with HTTP ${status}. Try again in a minute.` };
}

/**
 * Explain a crawl that ended with zero pages, from the done summary.
 * Returns null when there were pages.
 */
export function emptyReason(summary) {
  if (!summary || summary.pages > 0) return null;
  const sk = summary.skipped || {};
  const sample = summary.error_samples?.[0]?.message || '';
  if (sk.robots > 0 && !summary.fetched) {
    return { title: 'robots.txt says no', message: 'This site asks crawlers to stay out of that path, so silk did not fetch it.' };
  }
  if (summary.errors > 0 && /BLOCKED|private|local/i.test(sample)) {
    return { title: 'Redirected somewhere private', message: 'The site redirected to an address silk will not fetch.' };
  }
  if (summary.errors > 0) {
    const http = sample.match(/HTTP (\d{3})/);
    if (http && (http[1] === '403' || http[1] === '429')) {
      return { title: 'The site refused', message: `It answered HTTP ${http[1]}. Some sites block crawlers from cloud servers. Run it locally with npx silk-crawl.` };
    }
    if (http && http[1] === '404') return { title: 'Page not found', message: 'The site answered HTTP 404 for that address.' };
    if (/timed out/i.test(sample)) return { title: 'The site did not answer', message: 'The request timed out. Try again, or try a different page on the site.' };
    return { title: 'Could not reach the site', message: sample ? `The first request failed: ${sample}.` : 'Every request failed.' };
  }
  if (sk.non_html > 0 && !sk.duplicates) return { title: 'Not an HTML page', message: 'That address serves a file, not a web page. Try the docs home page.' };
  if (sk.noindex > 0) return { title: 'Marked noindex', message: 'The pages ask not to be indexed, so silk left them out.' };
  return { title: 'No readable text', message: 'The pages came back without text. The site probably builds its content with JavaScript, which silk does not run.' };
}

/**
 * Up to `n` short questions to suggest, taken from page headings.
 * Skips headings that just repeat a page title.
 */
export function suggestQuestions(pages, n = 3) {
  const titles = new Set(pages.map((p) => String(p.title || '').toLowerCase().trim()));
  const seen = new Set();
  const out = [];
  for (const p of pages) {
    for (const h of (p.headings || []).slice(1)) {
      const t = String(h).replace(/\s+/g, ' ').replace(/[#¶]+\s*$/, '').trim();
      const key = t.toLowerCase();
      if (t.length < 4 || t.length > 40 || titles.has(key) || seen.has(key)) continue;
      if (!/[a-z]/i.test(t) || /^(contents|table of contents|navigation|search|menu|footer|see also|related)$/i.test(t)) continue;
      seen.add(key);
      out.push(t);
      if (out.length >= n) return out;
    }
  }
  return out;
}
