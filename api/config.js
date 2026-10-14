// GET /api/config: public site settings from Vercel environment variables.
// Every value is optional. Nothing secret is ever returned here.
//   TOKEN_CA     contract address of the coin (Solana mint or 0x address)
//   X_URL        X account, as a link or a handle like @name
//   BUY_URL      optional link for a "Buy" button
//   GITHUB_REPO  owner/repo, used to fix the GitHub links on the site
const clean = (v, max = 200) => String(v ?? '').trim().slice(0, max);

export function siteConfig(env = process.env) {
  const ca = clean(env.TOKEN_CA, 64);
  let x = clean(env.X_URL);
  if (x && !/^https?:\/\//i.test(x)) x = 'https://x.com/' + x.replace(/^@/, '');
  let buy = clean(env.BUY_URL, 300);
  if (buy && !/^https:\/\//i.test(buy)) buy = '';
  let repo = clean(env.GITHUB_REPO, 120).replace(/^https?:\/\/github\.com\//i, '').replace(/\/+$/, '');
  if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) repo = '';
  return {
    ca: /^([1-9A-HJ-NP-Za-km-z]{32,44}|0x[0-9a-fA-F]{40})$/.test(ca) ? ca : '',
    x: /^https:\/\/(x|twitter)\.com\/[\w]{1,30}\/?$/i.test(x) ? x : '',
    buy,
    repo,
  };
}

export default function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.statusCode = 200;
  res.end(JSON.stringify(siteConfig()));
}
