#!/usr/bin/env node
// Pull the reviewed Arnona rate book out of a Supabase project that the scraper
// writes to (tables arnona_cities + arnona_tariffs) and
// write it into ./data as plain JSON (the private publishing path; the open
// scraper in ./scraper writes the same files directly) — the files the website and API serve.
//
//   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/sync-from-supabase.mjs
//
// Values are read from the environment or from a gitignored .env.local.
// Output layout (stable, documented in README):
//   data/cities.json                    every local authority + its latest source
//   data/tariffs/<year>/<city_key>.json one array of tariff rows per authority-year

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data");

const envFile = join(ROOT, ".env.local");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

const URL_ = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  process.exit(1);
}

async function selectAll(table, select, order) {
  const out = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const res = await fetch(`${URL_}/rest/v1/${table}?select=${select}&order=${order}`, {
      headers: {
        apikey: KEY,
        authorization: `Bearer ${KEY}`,
        range: `${from}-${from + page - 1}`,
      },
    });
    if (!res.ok) throw new Error(`${table}: HTTP ${res.status} ${await res.text()}`);
    const rows = await res.json();
    out.push(...rows);
    if (rows.length < page) return out;
  }
}

const num = (v) => (v === null || v === undefined ? null : Number(v));

const cities = await selectAll(
  "arnona_cities",
  "key,name,muni_name,aliases,site,last_doc_url,last_doc_year,active",
  "key.asc",
);
const tariffs = await selectAll(
  "arnona_tariffs",
  "city_key,year,category_key,category_label,code,zone,building_type,size_from,size_to," +
    "rate_per_sqm,notes,source_url,confidence,needs_review,review_reason,updated_at",
  "city_key.asc,year.asc,category_key.asc,code.asc.nullsfirst,zone.asc.nullsfirst," +
    "building_type.asc.nullsfirst,size_from.asc.nullsfirst,category_label.asc",
);

// Authority-years the database knows are overwritten. Files and cities it does not
// know (e.g. a community-contributed authority) are kept, so a sync never erases
// someone else's work; coverage is therefore counted from the files on disk.
const grouped = new Map();
for (const t of tariffs) {
  const id = `${t.year}/${t.city_key}`;
  if (!grouped.has(id)) grouped.set(id, []);
  grouped.get(id).push({
    city_key: t.city_key,
    year: t.year,
    category_key: t.category_key,
    category_label: t.category_label,
    code: t.code,
    zone: t.zone,
    building_type: t.building_type,
    size_from: num(t.size_from),
    size_to: num(t.size_to),
    rate_per_sqm: num(t.rate_per_sqm),
    notes: t.notes,
    source_url: t.source_url,
    confidence: t.confidence,
    needs_review: t.needs_review,
    review_reason: t.review_reason,
    updated_at: t.updated_at,
  });
}
for (const [id, rows] of grouped) {
  const file = join(DATA, "tariffs", `${id}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(rows, null, 1) + "\n");
}

const onDisk = new Map();
for (const year of readdirSync(join(DATA, "tariffs"))) {
  for (const file of readdirSync(join(DATA, "tariffs", year))) {
    const key = file.replace(/\.json$/, "");
    const rows = JSON.parse(readFileSync(join(DATA, "tariffs", year, file), "utf8"));
    onDisk.set(key, [...(onDisk.get(key) ?? []), ...rows]);
  }
}
const published = [...onDisk.values()].reduce((n, rows) => n + rows.length, 0);

const citiesFile = join(DATA, "cities.json");
const previous = existsSync(citiesFile) ? JSON.parse(readFileSync(citiesFile, "utf8")) : [];
const dbKeys = new Set(cities.map((c) => c.key));
const latin = /[A-Za-z]/;
const coverage = (key) => {
  const rows = onDisk.get(key) ?? [];
  return { years: [...new Set(rows.map((t) => t.year))].sort(), tariff_count: rows.length };
};
const cityOut = [
  ...cities
    .filter((c) => c.active !== false || onDisk.has(c.key))
    .map((c) => {
      const cov = coverage(c.key);
      return {
        key: c.key,
        name: c.name,
        name_en: (c.aliases ?? []).find((a) => latin.test(a)) ?? null,
        muni_name: c.muni_name,
        site: c.site,
        source_url: cov.tariff_count ? c.last_doc_url : null,
        source_year: cov.tariff_count ? c.last_doc_year : null,
        ...cov,
      };
    }),
  ...previous.filter((c) => !dbKeys.has(c.key)).map((c) => ({ ...c, ...coverage(c.key) })),
].sort((a, b) => a.key.localeCompare(b.key));
writeFileSync(citiesFile, JSON.stringify(cityOut, null, 1) + "\n");
writeFileSync(
  join(DATA, "meta.json"),
  JSON.stringify(
    {
      synced_at: new Date().toISOString(),
      authorities: cityOut.length,
      authorities_with_rates: cityOut.filter((c) => c.tariff_count).length,
      tariffs: published,
    },
    null,
    1,
  ) + "\n",
);
console.log(
  `synced ${tariffs.length} database tariffs; publishing ${published} across ` +
    `${cityOut.filter((c) => c.tariff_count).length}/${cityOut.length} authorities`,
);
