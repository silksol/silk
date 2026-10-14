// End to end: the real page in headless Chromium against the local dev server
// and the fixture site. Skipped when Playwright is not available (CI does not
// install it; silk has zero dependencies). Point SILK_PLAYWRIGHT at playwright's
// index.mjs and SILK_CHROMIUM at a Chromium binary to run it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { startSite } from '../fixtures/site.js';
import { startDevSite } from '../scripts/dev-site.mjs';

const PW = process.env.SILK_PLAYWRIGHT || '/home/claude/src-reels/tools/node_modules/playwright/index.mjs';
const CHROMIUM = process.env.SILK_CHROMIUM || '/opt/pw-browsers/chromium';
const available = existsSync(PW) && existsSync(CHROMIUM);

let fixture;
let dev;
let browser;
before(async () => {
  if (!available) return;
  const { chromium } = await import(PW);
  fixture = await startSite();
  dev = await startDevSite({ port: 0, allowLocal: true, delay: 0 });
  browser = await chromium.launch({ executablePath: CHROMIUM });
});
after(async () => {
  await browser?.close();
  await dev?.close();
  await fixture?.close();
});

test('type a site, crawl, see pages and stats, ask, download', { skip: !available && 'playwright not installed' }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(dev.url + '/');
  assert.equal(await page.textContent('#state'), 'ready');
  await page.fill('#url', fixture.url);
  await page.click('#go');
  await page.waitForSelector('.tool.done', { timeout: 20000 });
  const n = await page.$$eval('.pg', (els) => els.length);
  assert.ok(n >= 5);
  assert.equal(await page.textContent('#s-pages'), String(n));
  assert.match(page.url(), /\?url=http%3A%2F%2F127\.0\.0\.1/);
  // Clean text on click.
  await page.click('.pg summary >> nth=1');
  assert.match(await page.textContent('.pg pre'), /# Documentation/);
  // Ask.
  assert.equal(await page.isDisabled('#q'), false);
  await page.fill('#q', 'what does strict mode do with unknown keys?');
  await page.click('#ask');
  await page.waitForSelector('.srcs li');
  assert.match(await page.textContent('.srcs li'), /Documentation/);
  // Download.
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#dl-chunks')]);
  assert.match(dl.suggestedFilename(), /^127-0-0-1-chunks\.jsonl$/);
  assert.equal(errors.length, 0, errors.join('\n'));
  await page.close();
});

test('shareable URL auto-runs; bad input and API errors show a human message', { skip: !available && 'playwright not installed' }, async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(`${dev.url}/?url=${encodeURIComponent(fixture.url)}&max=2`);
  await page.waitForSelector('.tool.done', { timeout: 20000 });
  assert.equal(await page.$$eval('.pg', (els) => els.length), 2);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390, 'no horizontal scroll at 390px');

  await page.fill('#url', 'not a url');
  await page.click('#go');
  assert.match(await page.textContent('#notice'), /Bad address/);

  await page.route('**/api/crawl*', (r) => r.fulfill({ status: 429, contentType: 'application/json', body: '{"error":"rate_limited","message":"Too many crawls."}' }));
  await page.fill('#url', 'docs.example.com');
  await page.click('#go');
  await page.waitForSelector('#notice');
  assert.match(await page.textContent('#notice'), /Rate limited/);
  await page.close();
});
