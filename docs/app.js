// silkcrawl.dev: crawl a site through /api/crawl (silk's own crawler on a
// serverless function), then chunk-aware search over the result in the tab.
import { buildIndex, ask } from './lib/search.js';
import { sentences, tokenize } from './lib/text.js';
import {
  normalizeInput, clampPages, readQuery, shareQuery, ndjsonSplitter, toJsonl, fmt, pathOf, fileSlug, errorFor, emptyReason, suggestQuestions,
} from './lib/site.js';

const API = (window.__SILK_API__ || '') + '/api/crawl';
const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else n.setAttribute(k, v);
  }
  for (const k of kids) if (k != null) n.append(k);
  return n;
};

const ui = {
  tool: $('tool'), form: $('crawl-form'), url: $('url'), max: $('max'), go: $('go'), example: $('example'),
  pages: $('s-pages'), words: $('s-words'), tokens: $('s-tokens'), chunks: $('s-chunks'), time: $('s-time'),
  state: $('state'), meter: $('meter'), event: $('event'), plist: $('plist'), pagesNote: $('pages-note'),
  q: $('q'), ask: $('ask'), askForm: $('ask-form'), chips: $('chips'), answer: $('answer'), indexNote: $('index-note'),
  dlPages: $('dl-pages'), dlChunks: $('dl-chunks'), dlMeta: $('dl-meta'),
};

let run = null; // { controller, pages, chunks, index, started, max, url, timer }

function setMode(mode, label) {
  ui.tool.classList.remove('idle', 'running', 'done', 'failed');
  ui.tool.classList.add(mode);
  ui.state.textContent = label;
  ui.go.textContent = mode === 'running' ? 'Stop' : 'Crawl';
  ui.go.classList.toggle('stop', mode === 'running');
}

function setEvent(text, strong) {
  ui.event.textContent = '';
  ui.event.append(text);
  if (strong) ui.event.append(' ', el('em', { text: strong }));
}

function renderStats() {
  const words = run.pages.reduce((a, p) => a + p.words, 0);
  const tokens = run.pages.reduce((a, p) => a + p.tokens_est, 0);
  ui.pages.textContent = fmt(run.pages.length);
  ui.words.textContent = fmt(words);
  ui.tokens.textContent = fmt(tokens);
  ui.chunks.textContent = fmt(run.chunks.length);
  ui.meter.style.width = Math.min(100, (run.pages.length / run.max) * 100) + '%';
}

function tick() {
  if (run) ui.time.textContent = ((Date.now() - run.started) / 1000).toFixed(1) + 's';
}

function skeleton(n = 4) {
  const box = el('div', { id: 'skeleton' });
  for (let i = 0; i < n; i++) box.append(el('div', { class: 'sk' }, el('i'), el('i', { style: `width:${55 + ((i * 17) % 35)}%` }), el('i')));
  return box;
}

function preview(text) {
  const t = text.length > 1800 ? text.slice(0, 1800).replace(/\s+\S*$/, '') + '\n\n[...]' : text;
  return el('pre', { text: t });
}

function addPage(page) {
  $('skeleton')?.remove();
  $('blank')?.remove();
  const n = run.pages.length;
  const d = el('details', { class: 'pg new' },
    el('summary', {},
      el('span', { class: 'i', text: String(n).padStart(2, '0') }),
      el('span', { class: 't', text: page.title || pathOf(page.url) }, el('small', { text: pathOf(page.url) })),
      el('span', { class: 'w', text: fmt(page.words) + ' w' })));
  d.addEventListener('toggle', () => {
    if (d.open && !d.querySelector('pre')) {
      const pre = preview(page.text);
      pre.prepend(el('a', { href: page.url, target: '_blank', rel: 'noopener', text: page.url }), '\n\n');
      d.append(pre);
    }
  }, { once: false });
  ui.plist.append(d);
  setTimeout(() => d.classList.remove('new'), 600);
}

function notice(title, message) {
  $('skeleton')?.remove();
  $('blank')?.remove();
  $('notice')?.remove();
  const box = el('div', { class: 'notice', id: 'notice', role: 'alert' }, el('b', { text: title }), el('span', { text: message }));
  ui.plist.prepend(box);
}

function resetResults() {
  ui.plist.textContent = '';
  ui.answer.textContent = '';
  ui.chips.textContent = '';
  ui.q.value = '';
  ui.q.disabled = true;
  ui.ask.disabled = true;
  ui.q.placeholder = 'Crawl a site first';
  ui.dlPages.disabled = true;
  ui.dlChunks.disabled = true;
  ui.dlMeta.textContent = 'pages.jsonl and chunks.jsonl, same format as the CLI';
  ui.indexNote.textContent = 'BM25, runs in your browser';
  ui.pagesNote.textContent = 'click a page for its clean text';
}

function enableAsk() {
  if (!run.chunks.length) return;
  run.index = buildIndex(run.chunks);
  ui.q.disabled = false;
  ui.ask.disabled = false;
  ui.q.placeholder = 'Ask anything about this site';
  ui.indexNote.textContent = `${fmt(run.index.stats.docs)} chunks, ${fmt(run.index.stats.terms)} terms`;
  ui.chips.textContent = '';
  for (const s of suggestQuestions(run.pages)) {
    const b = el('button', { type: 'button', text: s });
    b.addEventListener('click', () => { ui.q.value = s; answer(s); });
    ui.chips.append(b);
  }
  ui.dlPages.disabled = false;
  ui.dlChunks.disabled = false;
  const kb = (s) => Math.max(1, Math.round(new Blob([s]).size / 1024));
  ui.dlMeta.textContent = `${fmt(run.pages.length)} pages, ${kb(toJsonl(run.pages))} KB  /  ${fmt(run.chunks.length)} chunks, ${kb(toJsonl(run.chunks))} KB`;
}

function answer(question) {
  if (!run?.index || !question.trim()) return;
  const result = ask(run.index, question, { k: 4 });
  ui.answer.textContent = '';
  if (!result.passages.length) {
    ui.answer.append(el('div', { class: 'notice' }, el('b', { text: 'No match' }), el('span', { text: 'None of the crawled pages use those words. Try the words the site would use.' })));
    return;
  }
  const para = el('p');
  const cited = citeAnswer(result);
  if (cited.length) {
    cited.forEach((c, i) => para.append(i ? ' ' : '', c.s, ' ', el('sup', { text: `[${c.n}]` })));
  } else {
    para.append(result.passages[0].text.slice(0, 280).replace(/\s+\S*$/, '') + ' ...', ' ', el('sup', { text: '[1]' }));
  }
  ui.answer.append(el('div', { class: 'answer' }, el('div', { class: 'k', text: cited.length ? 'Answer (extractive)' : 'Best passage' }), para));
  const list = el('ol', { class: 'srcs' });
  result.passages.forEach((p, i) => {
    const path = p.heading_path?.length ? p.heading_path.join(' > ') : pathOf(p.url);
    list.append(el('li', {},
      el('span', { class: 'n', text: `[${i + 1}]` }),
      el('a', { href: p.url, target: '_blank', rel: 'noopener', title: p.url }, path, ' ', el('small', { text: pathOf(p.url) })),
      el('span', { class: 's', text: p.score.toFixed(2) })));
  });
  ui.answer.append(list);
}

/** Split the extractive answer back into sentences, each with the passage it came from. */
function citeAnswer(result) {
  if (!result.answer) return [];
  const parts = [];
  result.passages.forEach((p, i) => {
    for (const s of sentences(p.text)) {
      if (new Set(tokenize(s)).size < 3) continue; // headings and fragments, as in extractiveAnswer
      const at = result.answer.indexOf(s);
      if (at >= 0 && !parts.some((x) => at < x.at + x.s.length && x.at < at + s.length)) parts.push({ s, at, n: i + 1 });
    }
  });
  return parts.sort((a, b) => a.at - b.at);
}

function download(kind) {
  if (!run) return;
  const data = kind === 'chunks' ? run.chunks : run.pages;
  const blob = new Blob([toJsonl(data)], { type: 'application/x-ndjson' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `${fileSlug(run.url)}-${kind}.jsonl` });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

function handle(evt) {
  switch (evt.type) {
    case 'start':
      setEvent('reading robots.txt for', new URL(evt.url).host);
      break;
    case 'fetch':
      setEvent('fetching', pathOf(evt.url));
      break;
    case 'skip':
      setEvent(`skipped (${evt.reason})`, pathOf(evt.url));
      break;
    case 'error':
      setEvent('failed', `${pathOf(evt.url)}: ${evt.message}`);
      break;
    case 'page':
      run.pages.push(evt.page);
      run.chunks.push(...(evt.chunks || []));
      addPage(evt.page);
      renderStats();
      setEvent('saved', `${pathOf(evt.page.url)} (${fmt(evt.page.words)} words)`);
      break;
    case 'done':
      run.summary = evt.summary;
      run.stopped = evt.stopped;
      break;
    case 'fatal':
      run.fatal = evt.message;
      break;
    default:
  }
}

function finish() {
  clearInterval(run.timer);
  tick();
  const s = run.summary;
  if (run.aborted) {
    setMode(run.pages.length ? 'done' : 'idle', 'stopped');
    setEvent('stopped by you after', `${run.pages.length} pages`);
  } else if (!s) {
    setMode('failed', 'error');
    notice('Crawl cut off', run.fatal || 'The connection closed before the crawl finished. Try again, or try fewer pages.');
    setEvent('the stream ended early');
  } else {
    ui.time.textContent = s.seconds.toFixed(1) + 's';
    const empty = emptyReason(s);
    if (empty) {
      setMode('failed', 'no pages');
      notice(empty.title, empty.message);
      setEvent('done:', `${s.fetched} fetched, 0 saved`);
    } else {
      setMode('done', 'done');
      const skipped = Object.values(s.skipped).reduce((a, b) => a + b, 0);
      const why = run.stopped === 'limit' ? `page limit of ${run.max} reached` : run.stopped === 'time' ? 'time limit reached' : 'no more pages to follow';
      setEvent(`done in ${s.seconds.toFixed(1)}s, ${why}.`, `${s.fetched} fetched, ${skipped} skipped, ${s.errors} errors`);
      ui.meter.style.width = '100%';
    }
  }
  if (run.pages.length) enableAsk();
  ui.pagesNote.textContent = run.pages.length ? `${fmt(run.pages.length)} saved, click for clean text` : 'click a page for its clean text';
}

async function crawl(input, max) {
  if (run?.controller && !run.done) {
    clearInterval(run.timer);
    run.controller.abort();
  }
  const url = normalizeInput(input);
  resetResults();
  if (!url) {
    run = null;
    setMode('failed', 'error');
    notice('Bad address', 'That does not look like a web address. Try something like docs.example.com.');
    setEvent('nothing crawled');
    return;
  }
  max = clampPages(max);
  ui.url.value = url;
  history.replaceState(null, '', location.pathname + shareQuery(url, max));
  const controller = new AbortController();
  run = { controller, pages: [], chunks: [], index: null, started: Date.now(), max, url, done: false };
  const mine = run;
  ui.pages.textContent = ui.words.textContent = ui.tokens.textContent = ui.chunks.textContent = '0';
  ui.meter.style.width = '0';
  setMode('running', 'crawling');
  setEvent('starting crawl of', url);
  ui.plist.append(skeleton());
  run.timer = setInterval(tick, 100);

  try {
    const res = await fetch(`${API}?url=${encodeURIComponent(url)}&max=${max}`, { signal: controller.signal });
    if (!res.ok) {
      let body = null;
      try { body = await res.json(); } catch { /* not json */ }
      const e = errorFor(res.status, body);
      clearInterval(run.timer);
      setMode('failed', 'error');
      notice(e.title, e.message);
      setEvent(`HTTP ${res.status}`);
      mine.done = true;
      return;
    }
    const split = ndjsonSplitter();
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (run !== mine) return;
      for (const evt of split.push(dec.decode(value, { stream: true }))) handle(evt);
    }
    for (const evt of split.end()) handle(evt);
  } catch (err) {
    if (run !== mine) return;
    if (err.name === 'AbortError') {
      mine.aborted = true;
    } else if (!mine.pages.length) {
      clearInterval(mine.timer);
      const e = errorFor(0);
      setMode('failed', 'error');
      notice(e.title, e.message);
      setEvent('network error');
      mine.done = true;
      return;
    }
  }
  if (run !== mine) return;
  mine.done = true;
  finish();
}

ui.form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (run && !run.done && ui.tool.classList.contains('running')) {
    run.controller.abort();
    return;
  }
  crawl(ui.url.value, ui.max.value);
});
ui.example.addEventListener('click', () => {
  ui.url.value = ui.example.dataset.url;
  ui.max.value = ui.example.dataset.max;
  crawl(ui.url.value, ui.max.value);
});
ui.askForm.addEventListener('submit', (e) => {
  e.preventDefault();
  answer(ui.q.value);
});
ui.dlPages.addEventListener('click', () => download('pages'));
ui.dlChunks.addEventListener('click', () => download('chunks'));

$('copy')?.addEventListener('click', async (e) => {
  try {
    await navigator.clipboard.writeText('npx silk-crawl docs.example.com');
    e.target.textContent = 'Copied';
  } catch {
    e.target.textContent = 'Select and copy';
  }
  setTimeout(() => { e.target.textContent = 'Copy'; }, 1600);
});

const initial = readQuery(location.search);
if (initial.url) {
  ui.url.value = initial.url;
  if (![...ui.max.options].some((o) => o.value === String(initial.max))) {
    ui.max.append(el('option', { value: String(initial.max), text: `${initial.max} pages` }));
  }
  ui.max.value = String(initial.max);
  crawl(initial.url, initial.max);
}
