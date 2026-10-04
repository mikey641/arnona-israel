// The dataset is plain JSON in ./data (written by the scraper or the sync script).
// It is read once per server instance and filtered in memory: ~5k rows is small
// enough that a database would only add latency and cost.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export type CategoryKey =
  | "residential" | "office" | "commerce" | "industry" | "workshop" | "storage"
  | "parking" | "hotel" | "land" | "farm" | "public" | "other";

export interface Tariff {
  city_key: string;
  year: number;
  category_key: CategoryKey;
  category_label: string;
  code: string | null;
  zone: string | null;
  building_type: string | null;
  size_from: number | null;
  size_to: number | null;
  rate_per_sqm: number;
  notes: string | null;
  source_url: string | null;
  confidence: "high" | "medium" | "low";
  needs_review: boolean;
  review_reason: string | null;
  updated_at: string;
}

export interface City {
  key: string;
  name: string;
  name_en: string | null;
  muni_name: string;
  site: string | null;
  source_url: string | null;
  source_year: number | null;
  years: number[];
  tariff_count: number;
}

export interface Meta {
  synced_at: string;
  authorities: number;
  authorities_with_rates: number;
  tariffs: number;
}

export const CATEGORIES: { key: CategoryKey; he: string; en: string }[] = [
  { key: "residential", he: "מגורים", en: "Residential" },
  { key: "office", he: "משרדים", en: "Offices" },
  { key: "commerce", he: "מסחר", en: "Commerce" },
  { key: "industry", he: "תעשייה", en: "Industry" },
  { key: "workshop", he: "מלאכה", en: "Workshops" },
  { key: "storage", he: "אחסנה", en: "Storage" },
  { key: "parking", he: "חניה", en: "Parking" },
  { key: "hotel", he: "מלונאות", en: "Hotels" },
  { key: "land", he: "קרקע", en: "Land" },
  { key: "farm", he: "חקלאות", en: "Agriculture" },
  { key: "public", he: "ציבורי", en: "Public" },
  { key: "other", he: "אחר", en: "Other" },
];

const DATA = join(process.cwd(), "data");

let cache: { cities: City[]; tariffs: Tariff[]; meta: Meta } | null = null;

export function dataset() {
  if (cache) return cache;
  const read = <T,>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;
  const cities = read<City[]>(join(DATA, "cities.json"));
  const meta = read<Meta>(join(DATA, "meta.json"));
  const tariffs: Tariff[] = [];
  for (const year of readdirSync(join(DATA, "tariffs")).sort()) {
    for (const file of readdirSync(join(DATA, "tariffs", year)).sort()) {
      if (file.endsWith(".json")) tariffs.push(...read<Tariff[]>(join(DATA, "tariffs", year, file)));
    }
  }
  cache = { cities, tariffs, meta };
  return cache;
}

export function citiesByKey() {
  return new Map(dataset().cities.map((c) => [c.key, c]));
}

export interface TariffQuery {
  city?: string | null;
  year?: string | null;
  category?: string | null;
  zone?: string | null;
  q?: string | null;
  include_flagged?: boolean;
}

/** Resolve a city by key, Hebrew name, or English name (case/space-insensitive). */
export function findCity(input: string): City | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/[\s'"׳״\-–]/g, "");
  const want = norm(input);
  return dataset().cities.find(
    (c) => c.key === input || norm(c.name) === want || (c.name_en && norm(c.name_en) === want),
  );
}

export function queryTariffs(query: TariffQuery): { tariffs: Tariff[]; error?: string } {
  let rows = dataset().tariffs;
  if (query.city) {
    const keys = new Set<string>();
    for (const part of query.city.split(",").map((s) => s.trim()).filter(Boolean)) {
      const city = findCity(part);
      if (!city) return { tariffs: [], error: `unknown city: ${part}` };
      keys.add(city.key);
    }
    rows = rows.filter((t) => keys.has(t.city_key));
  }
  if (query.year === "latest") {
    const latest = new Map<string, number>();
    for (const t of rows) latest.set(t.city_key, Math.max(latest.get(t.city_key) ?? 0, t.year));
    rows = rows.filter((t) => latest.get(t.city_key) === t.year);
  } else if (query.year) {
    const years = new Set(query.year.split(",").map(Number));
    rows = rows.filter((t) => years.has(t.year));
  }
  if (query.category) {
    const cats = new Set(query.category.split(","));
    rows = rows.filter((t) => cats.has(t.category_key));
  }
  if (query.zone) rows = rows.filter((t) => t.zone === query.zone);
  if (query.q) {
    const q = query.q.toLowerCase();
    rows = rows.filter((t) =>
      [t.category_label, t.code, t.notes, t.building_type].some((v) => v?.toLowerCase().includes(q)),
    );
  }
  if (!query.include_flagged) rows = rows.filter((t) => !t.needs_review);
  return { tariffs: rows };
}

const CSV_COLUMNS = [
  "city_key", "city_name", "city_name_en", "year", "category_key", "category_label", "code",
  "zone", "building_type", "size_from", "size_to", "rate_per_sqm", "notes", "source_url",
  "needs_review", "review_reason",
] as const;

export function toCsv(rows: Tariff[]): string {
  const cities = citiesByKey();
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [CSV_COLUMNS.join(",")];
  for (const t of rows) {
    const c = cities.get(t.city_key);
    const record: Record<string, unknown> = { ...t, city_name: c?.name, city_name_en: c?.name_en };
    lines.push(CSV_COLUMNS.map((k) => cell(record[k])).join(","));
  }
  // BOM so Excel opens Hebrew correctly.
  return "﻿" + lines.join("\r\n") + "\r\n";
}
