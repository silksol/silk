window.__SITE__ = {"name": "silk", "ticker": "$SILK", "colors": {"bg": "#0F0F12", "fg": "#F2F2F3", "muted": "#8B8B93", "accent": "#B9A3F5", "accentText": "#B9A3F5", "onAccent": "#0A0A0C", "line": "rgba(255,255,255,.10)"}, "sans": "\"Mona Sans\",system-ui,sans-serif", "mono": "\"JetBrains Mono\",ui-monospace,monospace", "radius": "8px"};
// Token bar and link fixer. Reads /api/config (Vercel env vars) and, when set,
// shows the ticker, contract address with copy, chart and X links at the top of the page.
(() => {
  const T = window.__SITE__ || {};
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const xIcon = '<svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M18.9 2H22l-6.8 7.8L23 22h-6.2l-4.9-6.4L6.3 22H3.2l7.3-8.3L1 2h6.3l4.4 5.8L18.9 2Zm-1.1 18h1.7L6.3 3.9H4.5L17.8 20Z"/></svg>';

  function fixLinks(repo) {
    if (!repo || !T.name) return;
    const from = 'OWNER/' + T.name;
    document.querySelectorAll('a[href*="' + from + '"]').forEach((a) => { a.href = a.href.split(from).join(repo); });
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n; while ((n = walk.nextNode())) if (n.nodeValue.includes(from)) n.nodeValue = n.nodeValue.split(from).join(repo);
    document.querySelectorAll('textarea').forEach((t) => { if (t.value.includes(from)) t.value = t.value.split(from).join(repo); });
  }

  function bar(cfg) {
    if (!cfg.ca && !cfg.x && !cfg.buy) return;
    const c = T.colors || {};
    const css = `
#tokenbar{background:${c.bg};color:${c.fg};border-bottom:1px solid ${c.line};font:500 13px/1.2 ${T.sans || 'inherit'};position:relative;z-index:50}
#tokenbar .tbx-row{max-width:1200px;margin:0 auto;padding:8px 16px;min-width:0;display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:center}
#tokenbar .tbx-tk{font-weight:700;color:${c.accentText || c.fg}}
#tokenbar .tbx-ca{display:inline-flex;align-items:center;gap:8px;min-width:0}
#tokenbar .tbx-lbl{color:${c.muted}}
#tokenbar *{box-sizing:border-box;letter-spacing:normal;text-transform:none;box-shadow:none}
#tokenbar span{background:none;border:0;padding:0;margin:0}
#tokenbar code{background:none;border:0;padding:0;margin:0;font:500 12px/1 ${T.mono || 'ui-monospace,monospace'};color:${c.fg};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:44ch}
#tokenbar button,#tokenbar a{font:600 12px/1 ${T.sans || 'inherit'};color:${c.fg};background:transparent;border:1px solid ${c.line};border-radius:${T.radius || '8px'};padding:6px 10px;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:6px}
#tokenbar button:hover,#tokenbar a:hover{border-color:${c.accent}}
#tokenbar .tbx-buy{background:${c.accent};border-color:${c.accent};color:${c.onAccent}}
#tokenbar button:focus-visible,#tokenbar a:focus-visible{outline:2px solid ${c.accent};outline-offset:2px}
@media (max-width:560px){#tokenbar *{box-sizing:border-box;letter-spacing:normal;text-transform:none;box-shadow:none}
#tokenbar span{background:none;border:0;padding:0;margin:0}
#tokenbar code{background:none;border:0;padding:0;margin:0;max-width:16ch}#tokenbar .tbx-lbl{display:none}}`;
    const style = document.createElement('style'); style.textContent = css; document.head.appendChild(style);
    const sol = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(cfg.ca);
    const chart = cfg.ca ? (sol ? 'https://dexscreener.com/solana/' + cfg.ca : 'https://dexscreener.com/search?q=' + cfg.ca) : '';
    const el = document.createElement('div'); el.id = 'tokenbar'; el.setAttribute('role', 'region'); el.setAttribute('aria-label', 'token');
    el.innerHTML = '<div class="tbx-row">'
      + (T.ticker ? '<span class="tbx-tk">' + esc(T.ticker) + '</span>' : '')
      + (cfg.ca ? '<span class="tbx-ca"><span class="tbx-lbl">CA</span><code title="' + esc(cfg.ca) + '">' + esc(cfg.ca) + '</code><button type="button" data-copy>Copy</button></span>'
        + '<a href="' + esc(chart) + '" target="_blank" rel="noopener">Chart</a>' : '')
      + (cfg.buy ? '<a class="tbx-buy" href="' + esc(cfg.buy) + '" target="_blank" rel="noopener">Buy ' + esc(T.ticker || '') + '</a>' : '')
      + (cfg.x ? '<a href="' + esc(cfg.x) + '" target="_blank" rel="noopener" aria-label="X">' + xIcon + '</a>' : '')
      + '</div>';
    document.body.insertBefore(el, document.body.firstChild);
    const btn = el.querySelector('[data-copy]');
    if (btn) btn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(cfg.ca); } catch {
        const r = document.createRange(); r.selectNodeContents(el.querySelector('code'));
        const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.execCommand('copy'); s.removeAllRanges();
      }
      btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = 'Copy'; }, 1400);
    });
  }

  async function run() {
    let cfg = { ca: '', x: '', buy: '', repo: '' };
    try {
      const r = await fetch('/api/config', { cache: 'no-store' });
      if (r.ok && (r.headers.get('content-type') || '').includes('json')) cfg = Object.assign(cfg, await r.json());
    } catch { /* local file or no function: keep defaults */ }
    if (cfg.repo) {
      window.__SITE_REPO__ = cfg.repo;
      fixLinks(cfg.repo);
      new MutationObserver(() => fixLinks(cfg.repo)).observe(document.body, { childList: true, subtree: true });
    }
    bar(cfg);
    window.dispatchEvent(new CustomEvent('site-config', { detail: cfg }));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
})();
