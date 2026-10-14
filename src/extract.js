// Dependency-free HTML to text extraction.
// Produces markdown-ish text: `#` headings, `-` list items, fenced code blocks.
// It is a tokenizer-style pass built on regular expressions, which is good
// enough for normal documentation pages, blogs and whitepapers.

import { toFetchUrl } from './url.js';

// Elements whose content is never useful text. They cannot contain markup we
// care about, so a simple non-greedy match is safe.
const OPAQUE = /<(script|style|noscript|template|svg|canvas|iframe|object)\b[\s\S]*?<\/\1\s*>/gi;
// Boilerplate containers. These can nest, so they are removed with depth tracking.
const BOILERPLATE = ['nav', 'footer', 'aside', 'form', 'button', 'select', 'dialog'];

// Named entities, stored as code points so this file stays plain ASCII.
const NAMED = Object.fromEntries(Object.entries({
  amp: 38, lt: 60, gt: 62, quot: 34, apos: 39, nbsp: 32, copy: 0xa9, reg: 0xae, trade: 0x2122,
  hellip: 0x2026, middot: 0xb7, mdash: 0x2014, ndash: 0x2013, lsquo: 0x2018, rsquo: 0x2019,
  ldquo: 0x201c, rdquo: 0x201d, laquo: 0xab, raquo: 0xbb, times: 0xd7, rarr: 0x2192, larr: 0x2190,
}).map(([name, code]) => [name, String.fromCodePoint(code)]));

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, ent) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    const v = NAMED[ent.toLowerCase()];
    return v === undefined ? m : v;
  });
}

/** Parse the attributes of a single start tag into a lowercase-keyed object. */
export function parseAttrs(tag) {
  const attrs = {};
  const body = tag.replace(/^<\s*[\w-]+/, '').replace(/\/?>$/, '');
  const re = /([^\s=/>]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m;
  while ((m = re.exec(body))) attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  return attrs;
}

/** Remove elements (and their content) by tag name, handling nesting. */
function removeElements(html, names) {
  const re = new RegExp(`<(/?)(${names.join('|')})\\b[^>]*?(/?)>`, 'gi');
  let out = '';
  let depth = 0;
  let last = 0;
  let m;
  while ((m = re.exec(html))) {
    if (m[1]) {
      if (depth > 0 && --depth === 0) last = re.lastIndex;
    } else if (!m[3]) {
      if (depth === 0) out += html.slice(last, m.index);
      depth++;
    }
  }
  // An unclosed element: keep the remainder rather than losing the page.
  return out + html.slice(last);
}

// Tag-free, whitespace-collapsed text. Entities stay encoded until the final
// pass, so a decoded `<` can never be mistaken for markup.
const flat = (s) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const inline = (s) => decodeEntities(flat(s));

/**
 * Extract structured content from an HTML document.
 * @param {string} html
 * @param {string} pageUrl used to resolve relative links
 */
export function extract(html, pageUrl) {
  html = String(html).replace(/<!--[\s\S]*?-->/g, '').replace(OPAQUE, '');

  // Head metadata.
  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  let title = titleMatch ? inline(titleMatch[1]) : '';
  let base = pageUrl;
  const baseTag = html.match(/<base\b[^>]*>/i);
  if (baseTag) base = toFetchUrl(parseAttrs(baseTag[0]).href || '', pageUrl) || pageUrl;

  let noindex = false;
  let nofollow = false;
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const a = parseAttrs(tag);
    if (/^(robots|silk)$/i.test(a.name || '')) {
      const c = (a.content || '').toLowerCase();
      if (/\b(noindex|none)\b/.test(c)) noindex = true;
      if (/\b(nofollow|none)\b/.test(c)) nofollow = true;
    }
  }

  let canonical = null;
  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    const a = parseAttrs(tag);
    if (/(^|\s)canonical(\s|$)/i.test(a.rel || '') && a.href) {
      canonical = toFetchUrl(a.href, base);
      break;
    }
  }

  // Links are collected from the whole document, including navigation,
  // because navigation is how a crawler discovers pages.
  const links = new Set();
  for (const tag of html.match(/<a\b[^>]*>/gi) || []) {
    const href = parseAttrs(tag).href;
    if (!href || href.startsWith('#')) continue;
    const abs = toFetchUrl(href, base);
    if (abs) links.add(abs);
  }

  // Body text: prefer <main>, then <article>, then <body>.
  let body = html;
  for (const name of ['main', 'article', 'body']) {
    const start = body.search(new RegExp(`<${name}\\b`, 'i'));
    const end = body.toLowerCase().lastIndexOf(`</${name}>`);
    if (start >= 0 && end > start) {
      body = body.slice(start, end);
      break;
    }
  }
  body = removeElements(body, BOILERPLATE);

  // Code blocks are lifted out first so whitespace collapsing does not touch them.
  const blocks = [];
  body = body.replace(/<pre\b([^>]*)>([\s\S]*?)<\/pre\s*>/gi, (m, attrs, inner) => {
    const lang = ((attrs + inner.slice(0, 200)).match(/(?:language|lang)-([\w+-]+)/i) || [])[1] || '';
    const code = decodeEntities(inner.replace(/<[^>]+>/g, '')).replace(/^\n+|\s+$/g, '');
    blocks.push('```' + lang + '\n' + code + '\n```');
    return `\n\n\u0000${blocks.length - 1}\u0000\n\n`;
  });

  const headings = [];
  body = body
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (m, level, inner) => {
      const text = flat(inner);
      if (!text) return '\n';
      headings.push(decodeEntities(text));
      return `\n\n${'#'.repeat(Number(level))} ${text}\n\n`;
    })
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code\s*>/gi, (m, inner) => '`' + flat(inner) + '`')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|ul|ol|dl|table|blockquote|section|article|main|header|figure|hr)\b[^>]*>/gi, '\n\n')
    .replace(/<\/?(div|tr|dt|dd|figcaption)\b[^>]*>/gi, '\n')
    .replace(/<\/?(td|th)\b[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '');

  let text = decodeEntities(body)
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line !== '-')
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .replace(/\u0000(\d+)\u0000/g, (m, i) => blocks[Number(i)]);

  if (!title && headings.length) title = headings[0];
  return { title, text, headings, links: [...links], canonical, noindex, nofollow };
}

export function countWords(text) {
  const m = text.match(/\S+/g);
  return m ? m.length : 0;
}
