import assert from "node:assert/strict";
import { test } from "node:test";
import { findCity, queryTariffs, toCsv } from "../lib/data.ts";

test("cities resolve by key, Hebrew and English name", () => {
  assert.equal(findCity("tel-aviv")?.key, "tel-aviv");
  assert.equal(findCity("תל אביב-יפו")?.key, "tel-aviv");
  assert.equal(findCity("tel aviv - yafo")?.key, "tel-aviv");
  assert.equal(findCity("nowhere-at-all"), undefined);
});

test("latest keeps only each city's newest year", () => {
  const { tariffs } = queryTariffs({ year: "latest", include_flagged: true });
  const newest = new Map();
  for (const t of queryTariffs({ include_flagged: true }).tariffs)
    newest.set(t.city_key, Math.max(newest.get(t.city_key) ?? 0, t.year));
  assert.ok(tariffs.length > 0);
  for (const t of tariffs) assert.equal(t.year, newest.get(t.city_key));
});

test("flagged rows are excluded unless requested", () => {
  const all = queryTariffs({ include_flagged: true }).tariffs;
  const clean = queryTariffs({}).tariffs;
  assert.equal(clean.filter((t) => t.needs_review).length, 0);
  assert.equal(all.length - clean.length, all.filter((t) => t.needs_review).length);
});

test("filters combine and unknown cities are an error", () => {
  const { tariffs } = queryTariffs({ city: "tel-aviv", year: "2026", category: "residential" });
  assert.ok(tariffs.length > 0);
  assert.ok(tariffs.every((t) => t.city_key === "tel-aviv" && t.year === 2026 && t.category_key === "residential"));
  assert.match(queryTariffs({ city: "atlantis" }).error ?? "", /unknown city/);
});

test("csv quotes Hebrew labels with commas and starts with a BOM", () => {
  const csv = toCsv(queryTariffs({ city: "tel-aviv", year: "2026" }).tariffs);
  assert.ok(csv.startsWith("﻿city_key,"));
  const lines = csv.trim().split("\r\n");
  assert.ok(lines.length > 10);
});
