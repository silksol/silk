// Programmatic usage: crawl a site, chunk it, index it and ask a question,
// all in memory.
//   node examples/api.js https://docs.example.com "how do I install it?"
import { crawl, chunkRecords, buildIndex, ask } from '../src/index.js';

const [url = 'https://example.com', question = 'what is this site about?'] = process.argv.slice(2);

const job = crawl(url, { maxPages: 20, depth: 2, sitemap: 'auto' });
const pages = [];
for await (const page of job) {
  console.log(`${String(page.tokens_est).padStart(6)} tokens  ${page.url}`);
  pages.push(page);
}

const chunks = chunkRecords(pages, { size: 512, overlap: 64 });
const index = buildIndex(chunks);
const result = ask(index, question, { k: 3 });

console.log(`\n${pages.length} pages, ${chunks.length} chunks\n`);
console.log(`Q: ${question}\nA: ${result.answer || '(no matching sentence)'}\n`);
for (const p of result.passages) console.log(`  ${p.score.toFixed(2)}  ${[p.title, ...p.heading_path].join(' > ')}  ${p.url}`);
