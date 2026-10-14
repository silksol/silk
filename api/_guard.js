// Network guard for the hosted crawler (/api/crawl). The function fetches
// URLs that visitors type in, so every request, including each redirect hop
// and robots.txt, must point at a public host on a standard port.
// Files starting with "_" in /api are not routed by Vercel.

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class BlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BlockedError';
    this.code = 'BLOCKED';
  }
}

const V4_BLOCKS = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

const v4ToInt = (ip) => ip.split('.').reduce((n, part) => (n * 256) + Number(part), 0);

function blockedV4(ip) {
  const n = v4ToInt(ip);
  return V4_BLOCKS.some(([base, bits]) => {
    const size = 2 ** (32 - bits);
    const start = v4ToInt(base);
    return n >= start && n < start + size;
  });
}

/** Expand an IPv6 address into 8 numeric groups. */
function v6Groups(ip) {
  let s = ip.toLowerCase().replace(/%.*$/, '');
  // A trailing dotted IPv4 part (::ffff:1.2.3.4) becomes two groups.
  const tail = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) {
    const n = v4ToInt(tail[1]);
    s = s.slice(0, -tail[1].length) + ((n >>> 16) & 0xffff).toString(16) + ':' + (n & 0xffff).toString(16);
  }
  const [head, rest] = s.split('::');
  const a = head ? head.split(':') : [];
  const b = rest !== undefined && rest ? rest.split(':') : [];
  const fill = s.includes('::') ? 8 - a.length - b.length : 0;
  return [...a, ...Array(fill).fill('0'), ...b].map((g) => parseInt(g || '0', 16));
}

const embeddedV4 = (g) => [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255].join('.');

/** True for loopback, private, link-local, CGNAT, multicast, documentation and other non-public addresses. */
export function isPrivateIp(ip) {
  const kind = isIP(String(ip).replace(/^\[|\]$/g, ''));
  ip = String(ip).replace(/^\[|\]$/g, '');
  if (kind === 4) return blockedV4(ip);
  if (kind !== 6) return true; // not an IP at all: refuse rather than guess
  const g = v6Groups(ip);
  if (g.length !== 8) return true;
  if (g.every((x) => x === 0)) return true; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return blockedV4(embeddedV4(g)); // v4-mapped / compatible
  if (g[0] === 0x64 && g[1] === 0xff9b) return blockedV4(embeddedV4(g)); // NAT64
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x2002) return blockedV4(`${g[1] >> 8}.${g[1] & 255}.${g[2] >> 8}.${g[2] & 255}`); // 6to4
  return false;
}

const LOCAL_NAMES = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain)$/i;

/**
 * Throw BlockedError unless `url` is http(s) on the default port and every
 * address its host resolves to is public.
 */
export async function assertPublicUrl(url, { lookup = dnsLookup } = {}) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new BlockedError('not a valid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new BlockedError('only http and https URLs can be crawled');
  if (u.port && !((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443'))) {
    throw new BlockedError('only the standard ports 80 and 443 can be crawled');
  }
  const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) throw new BlockedError('missing host');
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new BlockedError('that address is on a private or local network');
    return;
  }
  if (LOCAL_NAMES.test(host) || !host.includes('.')) throw new BlockedError('that host name is local, not public');
  let addrs;
  try {
    addrs = await lookup(host, { all: true, verbatim: true });
  } catch (err) {
    const e = new Error(`could not resolve ${host}`);
    e.code = 'ENOTFOUND';
    e.cause = err;
    throw e;
  }
  const list = Array.isArray(addrs) ? addrs : [addrs];
  if (!list.length) throw new BlockedError(`could not resolve ${host}`);
  if (list.some((a) => isPrivateIp(a.address ?? a))) throw new BlockedError('that host resolves to a private or local network address');
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * A fetch that checks every hop with assertPublicUrl and follows redirects
 * itself (at most `maxRedirects`). The returned Response's `url` is the final URL.
 * `allowLocal` skips the checks; it exists for local development and tests only.
 */
export function createSafeFetch({ fetchImpl = globalThis.fetch, lookup = dnsLookup, allowLocal = false, maxRedirects = 5 } = {}) {
  return async function safeFetch(url, init = {}) {
    let current = String(url);
    for (let hop = 0; ; hop++) {
      if (!allowLocal) await assertPublicUrl(current, { lookup });
      const res = await fetchImpl(current, { ...init, redirect: 'manual' });
      const location = res.headers.get('location');
      if (!REDIRECTS.has(res.status) || !location) {
        if (!res.url) Object.defineProperty(res, 'url', { value: current });
        return res;
      }
      await res.body?.cancel().catch(() => {});
      if (hop >= maxRedirects) throw new Error('too many redirects');
      current = new URL(location, current).href;
    }
  };
}
