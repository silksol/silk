// JSONL helpers shared by the CLI, the MCP server and the dashboard.

import { createReadStream, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Read a JSONL file into an array. Blank lines are ignored; bad lines throw with a line number. */
export async function readJsonl(path) {
  const out = [];
  const rl = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
  let n = 0;
  for await (const line of rl) {
    n++;
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch (err) {
      throw new Error(`${path}:${n}: invalid JSON (${err.message})`);
    }
  }
  return out;
}

/** Write records as JSONL, creating the parent directory. */
export async function writeJsonl(path, records) {
  await mkdir(dirname(path), { recursive: true });
  const out = createWriteStream(path);
  await once(out, 'open');
  for (const r of records) {
    if (!out.write(JSON.stringify(r) + '\n')) await once(out, 'drain');
  }
  out.end();
  await once(out, 'finish');
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value) + '\n');
}

/** URLs and text hashes already present in a dataset, for `--resume`. */
export async function knownFrom(path) {
  let records;
  try {
    records = await readJsonl(path);
  } catch (err) {
    if (err.code === 'ENOENT') return { urls: [], hashes: [], count: 0 };
    throw err;
  }
  return {
    urls: records.map((r) => r.url).filter(Boolean),
    hashes: records.map((r) => r.sha256).filter(Boolean),
    count: records.length,
  };
}
