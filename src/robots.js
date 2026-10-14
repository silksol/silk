// robots.txt parsing and matching, following RFC 9309:
// user-agent groups, Allow/Disallow with the longest-match rule
// (Allow wins ties), `*` and `$` wildcards, the Crawl-delay extension and
// the group-independent Sitemap: lines.

/** Parse robots.txt text into an array of groups. */
export function parseRobots(text) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;

  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (key === 'user-agent') {
      // Consecutive User-agent lines share one group.
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;

    if ((key === 'allow' || key === 'disallow') && value) {
      current.rules.push({ allow: key === 'allow', path: value, re: patternToRegExp(value) });
    } else if (key === 'crawl-delay') {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.crawlDelay = n;
    }
  }
  return groups;
}

function patternToRegExp(pattern) {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp('^' + body + (anchored ? '$' : ''));
}

/** Absolute URLs from `Sitemap:` lines. They apply to every user agent. */
export function robotsSitemaps(text, base) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const m = raw.replace(/#.*/, '').match(/^\s*sitemap\s*:\s*(\S+)/i);
    if (!m) continue;
    try {
      out.push(new URL(m[1], base).href);
    } catch { /* ignore malformed lines */ }
  }
  return [...new Set(out)];
}

/** Rules that apply to one user agent. */
export class Robots {
  constructor(text, userAgent = '*', base = undefined) {
    const groups = parseRobots(text);
    this.sitemaps = base ? robotsSitemaps(text, base) : [];
    const ua = String(userAgent).toLowerCase();
    // The most specific (longest) matching agent token wins; `*` is the fallback.
    let best = null;
    for (const g of groups) {
      for (const agent of g.agents) {
        if (agent !== '*' && ua.includes(agent) && (!best || agent.length > best.length)) best = agent;
      }
    }
    const chosen = groups.filter((g) => g.agents.includes(best || '*'));
    this.rules = chosen.flatMap((g) => g.rules);
    const delays = chosen.map((g) => g.crawlDelay).filter((d) => d !== null);
    this.crawlDelay = delays.length ? Math.max(...delays) : null;
  }

  /** `path` is the URL path plus query string, e.g. "/docs?page=2". */
  isAllowed(path) {
    if (path === '/robots.txt') return true;
    let match = null;
    for (const rule of this.rules) {
      if (!rule.re.test(path)) continue;
      if (!match || rule.path.length > match.path.length || (rule.path.length === match.path.length && rule.allow)) {
        match = rule;
      }
    }
    return match ? match.allow : true;
  }
}
