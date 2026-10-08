#!/usr/bin/env node
// Official orders behind an interactive "verify you are human" check cannot be
// downloaded by the scraper (and the check should not be automated). A person
// opens them once in a normal browser; this script does the rest.
//
//   node scripts/blocked-sources.mjs --open   # open every missing verified order in Chrome
//   node scripts/blocked-sources.mjs          # import matching files from ~/Downloads
//   node scripts/blocked-sources.mjs --archive  # ask the Internet Archive to capture them
//
// The Internet Archive's crawler is a recognised bot that such firewalls usually let
// through; once a capture exists, the scraper's archive fallback downloads the
// original bytes of the exact official URL. The daily job runs --archive and import.
//
// Import matches a downloaded file by the URL's own file name (e.g. 1766385448.3653.pdf)
// and copies it to scraper/state/sources/<city_key>.pdf (gitignored), where the
// scraper uses it in place of the blocked download. The daily job runs the import.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCES = join(ROOT, "scraper", "state", "sources");
const DOWNLOADS = process.env.ARNONA_DOWNLOADS_DIR ?? join(homedir(), "Downloads");

const cities = JSON.parse(readFileSync(join(ROOT, "data", "cities.json"), "utf8"));
const registry = JSON.parse(readFileSync(join(ROOT, "scraper", "state", "registry.json"), "utf8"));
const missing = new Set(cities.filter((c) => !c.tariff_count).map((c) => c.key));
const pending = registry.filter((row) => missing.has(row.key) && row.verified_source?.url
  && row.verified_source.format !== "html"
  && !existsSync(join(SOURCES, `${row.key}.pdf`)));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fileName = (url) => {
  try { return decodeURIComponent(basename(new URL(url).pathname)); } catch { return null; }
};

if (process.argv.includes("--archive")) {
  const rows = registry.filter((row) => missing.has(row.key) && row.verified_source?.url
    && !existsSync(join(SOURCES, `${row.key}.${row.verified_source.format === "html" ? "html" : "pdf"}`)));
  for (const row of rows) {
    for (const url of [row.verified_source.url, ...(row.verified_source.extra_urls ?? [])]) {
      const res = await fetch(`https://web.archive.org/save/${url}`, { signal: AbortSignal.timeout(120_000) })
        .catch((error) => ({ status: error.name }));
      console.log(`${row.key} capture ${res.status}  ${url}`);
      await sleep(12_000); // Save Page Now rate-limits anonymous clients
    }
  }
} else if (process.argv.includes("--open")) {
  for (const row of pending) {
    console.log(`${row.key} ${row.name}  ${row.verified_source.url}`);
    spawnSync("open", ["-a", "Google Chrome", row.verified_source.url]);
  }
  console.log(`\nopened ${pending.length} orders — save each PDF to ${DOWNLOADS}, then run this script without --open`);
} else {
  mkdirSync(SOURCES, { recursive: true });
  const downloaded = existsSync(DOWNLOADS) ? readdirSync(DOWNLOADS) : [];
  let imported = 0;
  for (const row of pending) {
    const want = fileName(row.verified_source.url);
    const stem = want?.replace(/\.pdf$/i, "");
    // Chrome may append " (1)" to a repeated download.
    const hit = downloaded.find((name) => name === want
      || (stem && name.startsWith(stem) && /\.pdf$/i.test(name)));
    if (!hit) continue;
    const head = readFileSync(join(DOWNLOADS, hit)).subarray(0, 5).toString();
    if (head !== "%PDF-") continue;
    copyFileSync(join(DOWNLOADS, hit), join(SOURCES, `${row.key}.pdf`));
    console.log(`imported ${row.key} ${row.name} ← ${hit}`);
    imported++;
  }
  console.log(`${imported} imported; ${pending.length - imported} verified orders still need a manual download`);
}
