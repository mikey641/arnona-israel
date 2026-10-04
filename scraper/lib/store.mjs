// File-based storage. The repository's data/ directory IS the database:
//
//   data/cities.json                      public index of every local authority
//   data/meta.json                        {synced_at, authorities, authorities_with_rates, tariffs}
//   data/tariffs/<year>/<city_key>.json   one array of tariff rows per authority-year
//   scraper/state/registry.json           the scraper's richer discovery state per authority
//   scraper/state/national.json           CBS registry snapshot + last national batch
//   scraper/state/runs.jsonl              one JSON line per scrape attempt
//
// Every writer produces stable, pretty-printed JSON so a scrape shows up as a
// readable git diff — reviewing that diff is the human review step.

import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SCRAPER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_ROOT = join(SCRAPER_DIR, "..");

/** The exact public row shape, in order. */
export const TARIFF_FIELDS = [
  "city_key", "year", "category_key", "category_label", "code", "zone", "building_type",
  "size_from", "size_to", "rate_per_sqm", "notes", "source_url", "confidence",
  "needs_review", "review_reason", "updated_at",
];

const REGISTRY_FIELDS = [
  "key", "name", "muni_name", "aliases", "site", "index_urls", "doc_url_template",
  "last_doc_url", "last_doc_year", "active",
];

const LATIN = /[A-Za-z]/;
const num = (value) => (value === null || value === undefined || value === "" ? null : Number(value));
const str = (value) => (value === null || value === undefined || value === "" ? null : String(value));

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 1)}\n`);
  renameSync(tmp, file);
}

const nullsFirst = (a, b) => {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
};

export function compareTariffRows(a, b) {
  return nullsFirst(a.category_key, b.category_key)
    || nullsFirst(a.code, b.code)
    || nullsFirst(a.zone, b.zone)
    || nullsFirst(a.building_type, b.building_type)
    || nullsFirst(a.size_from, b.size_from)
    || nullsFirst(a.category_label, b.category_label);
}

/** Normalize one row to the public shape and field order. */
export function toPublicTariffRow(row) {
  return {
    city_key: String(row.city_key),
    year: Number(row.year),
    category_key: String(row.category_key),
    category_label: String(row.category_label ?? ""),
    code: str(row.code),
    zone: str(row.zone),
    building_type: str(row.building_type),
    size_from: num(row.size_from),
    size_to: num(row.size_to),
    rate_per_sqm: num(row.rate_per_sqm),
    notes: str(row.notes),
    source_url: str(row.source_url),
    confidence: str(row.confidence) ?? "high",
    needs_review: Boolean(row.needs_review),
    review_reason: str(row.review_reason),
    updated_at: str(row.updated_at),
  };
}

export function createStore({ repoRoot = REPO_ROOT, scraperDir = join(repoRoot, "scraper") } = {}) {
  const dataDir = join(repoRoot, "data");
  const stateDir = join(scraperDir, "state");
  const paths = {
    dataDir,
    stateDir,
    cities: join(dataDir, "cities.json"),
    meta: join(dataDir, "meta.json"),
    tariffsDir: join(dataDir, "tariffs"),
    registry: join(stateDir, "registry.json"),
    national: join(stateDir, "national.json"),
    runs: join(stateDir, "runs.jsonl"),
  };
  const tariffFile = (cityKey, year) => join(paths.tariffsDir, String(year), `${cityKey}.json`);

  const tariffYears = () => (existsSync(paths.tariffsDir) ? readdirSync(paths.tariffsDir) : [])
    .filter((name) => /^\d{4}$/.test(name)).map(Number).sort((a, b) => a - b);

  const store = {
    paths,

    readRegistry() {
      return readJson(paths.registry, []).map((city) => ({
        site: null, index_urls: [], doc_url_template: null, last_doc_url: null,
        last_doc_year: null, aliases: [], active: true, ...city,
      }));
    },

    writeRegistry(cities) {
      const rows = [...cities]
        .map((city) => Object.fromEntries(REGISTRY_FIELDS.map((field) => [field, city[field] ?? (
          field === "aliases" || field === "index_urls" ? [] : field === "active" ? true : null
        )])))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      writeJson(paths.registry, rows);
    },

    /** Merge one registry row by key (partial patch) and persist. */
    patchRegistryCity(key, patch) {
      const cities = store.readRegistry();
      const index = cities.findIndex((city) => city.key === key);
      if (index < 0) cities.push({ key, ...patch });
      else cities[index] = { ...cities[index], ...patch };
      store.writeRegistry(cities);
    },

    readTariffs(cityKey, year) {
      return readJson(tariffFile(cityKey, year), []);
    },

    /** Every stored row for `year`, across all authorities. */
    readTariffsForYear(year) {
      const dir = join(paths.tariffsDir, String(year));
      if (!existsSync(dir)) return [];
      return readdirSync(dir).filter((name) => name.endsWith(".json")).sort()
        .flatMap((name) => readJson(join(dir, name), []));
    },

    /** Rows of earlier years for one authority, newest year first. */
    readPriorTariffs(cityKey, beforeYear, limit = 400) {
      return tariffYears().filter((year) => year < beforeYear).reverse()
        .flatMap((year) => store.readTariffs(cityKey, year)).slice(0, limit);
    },

    yearsWithTariffs(cityKey) {
      return tariffYears().filter((year) => store.readTariffs(cityKey, year).length > 0);
    },

    writeTariffs(cityKey, year, rows) {
      const out = rows.map(toPublicTariffRow).sort(compareTariffRows);
      writeJson(tariffFile(cityKey, year), out);
      return out.length;
    },

    readRuns() {
      if (!existsSync(paths.runs)) return [];
      return readFileSync(paths.runs, "utf8").split("\n").filter(Boolean).map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
    },

    appendRun(run) {
      mkdirSync(paths.stateDir, { recursive: true });
      appendFileSync(paths.runs, `${JSON.stringify(run)}\n`);
    },

    readNational() {
      return readJson(paths.national, {});
    },

    patchNational(patch) {
      const next = { ...store.readNational(), ...patch };
      writeJson(paths.national, next);
      return next;
    },

    /** The public data/cities.json entry for one registry authority. */
    publicCityEntry(city) {
      const years = store.yearsWithTariffs(city.key);
      const tariffCount = years.reduce((sum, year) => sum + store.readTariffs(city.key, year).length, 0);
      return {
        key: city.key,
        name: city.name,
        name_en: (city.aliases ?? []).find((alias) => LATIN.test(alias)) ?? null,
        muni_name: city.muni_name,
        site: city.site ?? null,
        source_url: tariffCount ? city.last_doc_url ?? null : null,
        source_year: tariffCount ? city.last_doc_year ?? null : null,
        years,
        tariff_count: tariffCount,
      };
    },

    /**
     * Upsert public index entries for the given registry authorities (inactive ones
     * are removed), then recompute data/meta.json.
     */
    updatePublicIndex(registryCities) {
      const index = new Map(readJson(paths.cities, []).map((entry) => [entry.key, entry]));
      for (const city of registryCities) {
        if (city.active === false) index.delete(city.key);
        else index.set(city.key, store.publicCityEntry(city));
      }
      const cities = [...index.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      writeJson(paths.cities, cities);
      const tariffs = tariffYears().reduce((sum, year) => sum + store.readTariffsForYear(year).length, 0);
      const meta = {
        synced_at: new Date().toISOString(),
        authorities: cities.length,
        authorities_with_rates: cities.filter((entry) => entry.tariff_count).length,
        tariffs,
      };
      writeJson(paths.meta, meta);
      return meta;
    },
  };
  return store;
}
