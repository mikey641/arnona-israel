#!/usr/bin/env node
// Structural gate for ./data — run before every publish (and in CI). It rejects
// files the site/API could not serve correctly; it does not judge the rates themselves
// (the scraper's sanity checks set needs_review for that).

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DATA = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const CATEGORIES = new Set([
  "residential", "office", "commerce", "industry", "workshop", "storage",
  "parking", "hotel", "land", "farm", "public", "other",
]);
const errors = [];
const cities = JSON.parse(readFileSync(join(DATA, "cities.json"), "utf8"));
const keys = new Set(cities.map((c) => c.key));
if (keys.size !== cities.length) errors.push("cities.json: duplicate keys");

let total = 0;
for (const year of readdirSync(join(DATA, "tariffs"))) {
  if (!/^\d{4}$/.test(year)) { errors.push(`tariffs/${year}: not a year directory`); continue; }
  for (const file of readdirSync(join(DATA, "tariffs", year))) {
    const where = `tariffs/${year}/${file}`;
    const cityKey = file.replace(/\.json$/, "");
    if (!keys.has(cityKey)) errors.push(`${where}: city not in cities.json`);
    const rows = JSON.parse(readFileSync(join(DATA, "tariffs", year, file), "utf8"));
    if (!Array.isArray(rows) || !rows.length) { errors.push(`${where}: empty`); continue; }
    const grain = new Set();
    rows.forEach((r, i) => {
      const at = `${where}[${i}]`;
      if (r.city_key !== cityKey) errors.push(`${at}: city_key ${r.city_key}`);
      if (r.year !== Number(year)) errors.push(`${at}: year ${r.year}`);
      if (!CATEGORIES.has(r.category_key)) errors.push(`${at}: category ${r.category_key}`);
      if (!r.category_label) errors.push(`${at}: missing category_label`);
      if (!(typeof r.rate_per_sqm === "number" && r.rate_per_sqm >= 0 && r.rate_per_sqm < 100000))
        errors.push(`${at}: rate ${r.rate_per_sqm}`);
      if (r.size_from != null && r.size_to != null && r.size_to < r.size_from)
        errors.push(`${at}: size band ${r.size_from}-${r.size_to}`);
      if (r.source_url && !/^https?:\/\//.test(r.source_url)) errors.push(`${at}: source_url`);
      const g = [r.category_label, r.zone, r.building_type, r.code, r.size_from, r.size_to].join("|");
      if (grain.has(g)) errors.push(`${at}: duplicate row ${g}`);
      grain.add(g);
    });
    total += rows.length;
    const city = cities.find((c) => c.key === cityKey);
    if (city && !city.years.includes(Number(year))) errors.push(`${where}: year missing from cities.json`);
  }
}
const meta = JSON.parse(readFileSync(join(DATA, "meta.json"), "utf8"));
if (meta.tariffs !== total) errors.push(`meta.json: tariffs ${meta.tariffs} != ${total}`);

if (errors.length) {
  console.error(errors.slice(0, 50).join("\n"));
  console.error(`${errors.length} data error(s)`);
  process.exit(1);
}
console.log(`data ok: ${total} tariffs, ${cities.length} authorities`);
