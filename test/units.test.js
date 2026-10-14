import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Robots, parseRobots, extract, toFetchUrl, urlKey, countWords } from '../src/index.js';

test('robots: groups, longest match, Allow wins ties, wildcards', () => {
  const txt = `User-agent: *
Disallow: /private
Allow: /private/open
Disallow: /*.json$
Disallow: /search?

User-agent: silk
User-agent: other
Disallow: /only-for-silk
Crawl-delay: 2`;
  assert.equal(parseRobots(txt).length, 2);

  const generic = new Robots(txt, 'SomeBot/1.0');
  assert.equal(generic.isAllowed('/'), true);
  assert.equal(generic.isAllowed('/private/keys'), false);
  assert.equal(generic.isAllowed('/private/open/page'), true);
  assert.equal(generic.isAllowed('/data/x.json'), false);
  assert.equal(generic.isAllowed('/data/x.json?v=1'), true);
  assert.equal(generic.isAllowed('/search?q=1'), false);
  assert.equal(generic.crawlDelay, null);

  const silk = new Robots(txt, 'silk/0.1.0 (+https://github.com/OWNER/silk)');
  assert.equal(silk.isAllowed('/private/keys'), true, 'specific group replaces *');
  assert.equal(silk.isAllowed('/only-for-silk'), false);
  assert.equal(silk.crawlDelay, 2);

  const tie = new Robots('User-agent: *\nDisallow: /a\nAllow: /a', 'x');
  assert.equal(tie.isAllowed('/a'), true);
  assert.equal(new Robots('', 'x').isAllowed('/anything'), true);
  assert.equal(new Robots('User-agent: *\nDisallow: /', 'x').isAllowed('/robots.txt'), true);
});

test('url: fragments stripped, query sorted, trailing slash folded in key', () => {
  assert.equal(toFetchUrl('/a/?b=2&a=1#frag', 'https://Example.COM:443/x'), 'https://example.com/a/?a=1&b=2');
  assert.equal(urlKey('https://example.com/a/?b=2&a=1'), 'https://example.com/a?a=1&b=2');
  assert.equal(urlKey('https://example.com/'), 'https://example.com/');
  assert.equal(toFetchUrl('mailto:hi@example.com'), null);
  assert.equal(toFetchUrl('javascript:void(0)', 'https://example.com'), null);
  assert.equal(toFetchUrl('not a url'), null);
});

test('extract: clean markdown-ish text, metadata and links', () => {
  const html = `<html><head><title>T &amp; C</title>
<meta name="robots" content="NOINDEX">
<link rel="canonical" href="/canonical/">
<style>.x{}</style></head><body>
<nav><ul><li><a href="/nav">Nav</a></li></ul></nav>
<main>
  <h1>Hello <em>world</em></h1>
  <p>First   paragraph
     with <a href="b.html#x">a link</a> &hellip;</p>
  <div><div><aside><p>ad</p><aside>nested</aside></aside>Inner text</div></div>
  <ul><li>one</li><li>two <code>x &lt; y</code></li></ul>
  <pre class="language-py">def f():
    return 1 &gt; 0</pre>
  <!-- <p>comment</p> -->
  <script>var s = "<p>hidden</p>";</script>
</main>
<footer>footer text</footer></body></html>`;
  const r = extract(html, 'https://ex.com/dir/page');
  assert.equal(r.title, 'T & C');
  assert.equal(r.noindex, true);
  assert.equal(r.nofollow, false);
  assert.equal(r.canonical, 'https://ex.com/canonical/');
  assert.deepEqual(r.headings, ['Hello world']);
  assert.ok(r.links.includes('https://ex.com/nav'), 'nav links are still discovered');
  assert.ok(r.links.includes('https://ex.com/dir/b.html'));
  assert.equal(
    r.text,
    '# Hello world\n\nFirst paragraph\nwith a link \u2026\n\nInner text\n\n- one\n- two `x < y`\n\n```py\ndef f():\n    return 1 > 0\n```',
  );
  for (const junk of ['Nav', 'footer', 'ad', 'nested', 'hidden', 'comment', '.x{}']) {
    assert.ok(!r.text.includes(junk), `text should not contain "${junk}"`);
  }
  assert.equal(countWords(r.text), 26);
});
