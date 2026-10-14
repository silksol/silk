# Contributing to Silk

Thanks for helping out. Silk is small on purpose, so the bar for new code is
"does this make datasets or answers better without adding a dependency?"

## Setup

```sh
git clone https://github.com/OWNER/silk.git
cd silk
npm test
```

There is nothing to install: Silk has no runtime or dev dependencies and needs Node 18 or newer.

## Layout

| Path | What lives there |
| --- | --- |
| `src/crawl.js` | Frontier, politeness, robots.txt, sitemap seeding, resume |
| `src/extract.js` | HTML to markdown-style text |
| `src/sitemap.js`, `src/robots.js`, `src/url.js` | Parsing helpers |
| `src/chunk.js`, `src/text.js` | Chunking, tokenizer, stemmer, sentence splitter |
| `src/search.js`, `src/llm.js` | BM25 index, extractive answers, optional hosted model |
| `src/stats.js`, `src/export.js` | `silk stats` and `silk export` |
| `src/pipeline.js` | File-level operations shared by the CLI, MCP server and dashboard |
| `src/mcp.js` | MCP server (JSON-RPC over stdio) |
| `src/ui.js`, `src/ui.html` | Dashboard server and page |
| `fixtures/site.js` | The offline test website, including sitemaps |

## Guidelines

- Plain JavaScript (ESM), no build step, no runtime dependencies.
- Every behaviour change needs a test. Tests run offline against `fixtures/site.js` or a local `node:http` mock; add pages there if you need new cases. Never call a real network service from a test.
- Be polite by default. Features that make Silk crawl harder or faster than a site asks for will not be merged.
- MCP server: stdout carries protocol messages only. Log to stderr.
- No em or en dashes in code, comments or docs. Keep the README examples real: regenerate them from a run against the fixture site.
- Run `npm test` before opening a pull request and describe what you changed and why.

## Reporting bugs

Open an issue at https://github.com/OWNER/silk/issues with the command you ran,
the URL (if public) and what you expected. For extraction bugs, a small HTML
snippet that reproduces the problem is the most useful thing you can attach.
