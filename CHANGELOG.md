# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [1.1.0] - 2026-10-14

### Added

- silkcrawl.dev is now the tool: paste a site, press Crawl, and watch pages, words, estimated tokens and RAG chunks stream in. Click a page for its clean text, ask the site questions with BM25 running in the browser (cited sources), and download `pages.jsonl` and `chunks.jsonl`. Shareable links with `?url=` and `?max=`, and an example button.
- `api/crawl.js`: a Vercel function that runs silk's crawler, extraction and chunking on up to 25 same-site pages and streams NDJSON events. robots.txt is honoured, only public `http(s)` hosts on ports 80 and 443 are fetched (every redirect hop is re-checked against private, loopback and link-local ranges), 2 MB per page, 45 second budget, per-network rate limit.
- `scripts/dev-site.mjs`: serves `docs/` and routes `/api/*` like Vercel, with `--fixture` to crawl the local test site.
- Tests for the function, the network guard, the browser helpers and an end to end browser run (skipped when Playwright is not installed).

### Changed

- The website loads Mona Sans and JetBrains Mono from `docs/fonts/` instead of relying on system fallbacks.

## [1.0.0] - 2026-10-14

First public release, released as Silk (`silk` command, `silk-crawl` on npm, ticker $SILK).

### Added

- Sitemap seeding: `--sitemap auto` reads robots.txt `Sitemap:` lines (falling back to `/sitemap.xml`), follows sitemap indexes and reads gzip-compressed sitemaps. `--sitemap <url>` uses one sitemap. Sitemap entries obey robots.txt, `--same-host` and the include/exclude filters.
- `--resume`: reads the existing output file, skips every known URL and text hash, and appends new records. With a sitemap, known pages are not requested at all.
- `silk chunk`: token-aware chunking for retrieval (`--size`, `--overlap`). Splits on headings, then paragraphs (code blocks stay whole), then sentences. Each chunk keeps `url`, `title`, `heading_path` and `chunk_index`.
- `silk index`: a BM25 inverted index in one JSON file, with a tokenizer that lowercases, removes stopwords, applies light stemming and splits camelCase and snake_case identifiers.
- `silk ask`: ranked passages with URL and heading path plus a short extractive answer. `--llm` sends the top passages to Anthropic (`ANTHROPIC_API_KEY`) or OpenAI (`OPENAI_API_KEY`) for a cited answer.
- `silk export`: clean JSONL, a folder of Markdown files with front matter, or a Hugging Face style dataset folder with a generated dataset card.
- `silk stats`: pages, words, estimated tokens, length distribution, top domains and duplicate rate.
- `silk mcp`: Model Context Protocol server over stdio with the tools `crawl_site` (capped at 200 pages), `chunk_dataset`, `search_index` and `dataset_stats`.
- `silk ui`: local dashboard to start a crawl, watch live progress, browse pages and ask the index, backed by a small JSON API.
- Programmatic API additions: `chunkRecords`, `buildIndex`, `search`, `ask`, `datasetStats`, `exportDataset`, `crawlToFile`, `readSitemaps`, `crawler.stop()` and more (see README).
- Brand: 3D app icon (`assets/icon.png`), flat mark (`logo.svg`, `logo-mono.svg`), coin image, banner, terminal demo and dashboard screenshot on a neutral near-black palette with one accent (`#B9A3F5`), plus `BRAND.md` and a landing page in `docs/`.
- CI on Node 18, 20 and 22, issue and pull request templates, `SECURITY.md` and `CODE_OF_CONDUCT.md`.

### Changed

- The CLI is now command based. `silk <url>` still crawls (same as `silk crawl <url>`); options that do not apply to a command are rejected with exit code 2.
- The crawl summary (`--json`) gains `sitemap` and `skipped.known`, and the run result gains `resumed`.
- Progress lines are aligned and sitemap reads are reported.

## [0.1.0] - 2026-10-14

### Added

- `silk <url>` CLI that crawls a site and writes one JSONL record per page.
- robots.txt support: user-agent groups, Allow/Disallow with the longest-match rule, `*` and `$` wildcards, Crawl-delay.
- Per-host rate limiting, same-host crawling by default, `--include` and `--exclude` filters.
- URL normalisation (fragments, query order, trailing slash) and deduplication by URL and by text hash.
- `<link rel="canonical">`, `<meta name="robots">` and `X-Robots-Tag` handling (noindex, nofollow).
- Dependency-free HTML to text extractor that keeps headings, lists and fenced code blocks.
- Programmatic API: `crawl()` returns an async iterable of records with live `stats`.
