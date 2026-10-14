// URL helpers. Two forms are used:
//   fetchUrl: what we request. Fragment and credentials removed, query sorted.
//   urlKey:   what we dedupe on. fetchUrl without a trailing slash.

/** Resolve `input` against `base` and return a clean http(s) URL string, or null. */
export function toFetchUrl(input, base) {
  let u;
  try {
    u = new URL(String(input).trim(), base);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  u.username = '';
  u.password = '';
  if (u.search) {
    u.searchParams.sort();
    if (![...u.searchParams.keys()].length) u.search = '';
  }
  return u.href;
}

/** Normalised key used for deduplication. */
export function urlKey(input, base) {
  const href = toFetchUrl(input, base);
  if (!href) return null;
  const u = new URL(href);
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/\/+$/, '');
  return u.href;
}
