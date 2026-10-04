#!/usr/bin/env node
// Scrape every authority that still has no published rates, a few at a time.
//
//   node scripts/scrape-missing.mjs [--year 2026] [--concurrency 4] [--limit N]
//
// The scraper itself falls back to the closest published year when the requested
// year's order does not exist yet, and stores rows under the order's own year.

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const YEAR = opt("year", String(new Date().getFullYear()));
const CONCURRENCY = Number(opt("concurrency", "4"));
const LIMIT = Number(opt("limit", "100000"));

const cities = JSON.parse(readFileSync(join(ROOT, "data", "cities.json"), "utf8"));
const missing = cities.filter((c) => !c.tariff_count).slice(0, LIMIT);
console.log(`${missing.length} authorities without rates; running ${CONCURRENCY} at a time`);

const logDir = join(ROOT, "logs", "scrape");
mkdirSync(logDir, { recursive: true });
const results = [];

function scrape(city) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(
      process.execPath,
      ["scrape-arnona.mjs", "--city", city.key, "--year", YEAR],
      { cwd: join(ROOT, "scraper"), env: process.env },
    );
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const kill = setTimeout(() => child.kill("SIGTERM"), 45 * 60_000);
    child.on("close", (code) => {
      clearTimeout(kill);
      writeFileSync(join(logDir, `${city.key}.log`), out);
      const ok = /✓ wrote \d+ tariffs|\d+ scraped/.test(out) && !/0 scraped/.test(out);
      const why = ok ? "" : (out.match(/(?:✗|failed|error)[^\n]{0,160}/i)?.[0] ?? `exit ${code}`);
      const line = `${ok ? "✓" : "✗"} ${city.key} ${city.name} (${Math.round((Date.now() - started) / 1000)}s) ${why}`;
      console.log(line);
      results.push({ key: city.key, name: city.name, ok, why });
      resolve();
    });
  });
}

const queue = [...missing];
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) await scrape(queue.shift());
  }),
);
writeFileSync(join(logDir, "_summary.json"), JSON.stringify(results, null, 1));
console.log(`done: ${results.filter((r) => r.ok).length}/${results.length} succeeded`);
