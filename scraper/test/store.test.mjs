import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TARIFF_FIELDS, createStore, toPublicTariffRow } from "../lib/store.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "arnona-store-"));
  mkdirSync(join(root, "data", "tariffs", "2025"), { recursive: true });
  mkdirSync(join(root, "scraper", "state"), { recursive: true });
  const row = (over) => ({
    city_key: "holon", year: 2025, category_key: "residential", category_label: "מגורים",
    code: null, zone: null, building_type: null, size_from: null, size_to: null,
    rate_per_sqm: 50, notes: null, source_url: "https://www.holon.muni.il/a.pdf", confidence: "high",
    needs_review: false, review_reason: null, updated_at: "2025-01-01T00:00:00.000Z", ...over,
  });
  writeFileSync(join(root, "data", "tariffs", "2025", "holon.json"), JSON.stringify([row({})]));
  writeFileSync(join(root, "data", "cities.json"), JSON.stringify([
    { key: "holon", name: "חולון", name_en: null, muni_name: "עיריית חולון", site: null, source_url: null, source_year: null, years: [2025], tariff_count: 1 },
  ]));
  return { root, row, store: createStore({ repoRoot: root }) };
}

test("tariff rows are written with exactly the public fields, in order", () => {
  const { root, row, store } = fixture();
  try {
    store.writeTariffs("holon", 2026, [
      { ...row({ year: 2026, category_key: "office", rate_per_sqm: "120.5", extracted_by: "x" }) },
      { ...row({ year: 2026, size_from: "100" }) },
    ]);
    const written = JSON.parse(readFileSync(join(root, "data", "tariffs", "2026", "holon.json"), "utf8"));
    assert.deepEqual(Object.keys(written[0]), TARIFF_FIELDS);
    assert.equal(written[0].category_key, "office");
    assert.equal(written[0].rate_per_sqm, 120.5);
    assert.equal(written[1].size_from, 100);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prior years are read newest first for the year-over-year check", () => {
  const { root, row, store } = fixture();
  try {
    store.writeTariffs("holon", 2024, [row({ year: 2024, rate_per_sqm: 40 })]);
    store.writeTariffs("holon", 2026, [row({ year: 2026, rate_per_sqm: 60 })]);
    assert.deepEqual(store.readPriorTariffs("holon", 2026).map((r) => r.year), [2025, 2024]);
    assert.deepEqual(store.yearsWithTariffs("holon"), [2024, 2025, 2026]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the public index and meta follow the registry and tariff files", () => {
  const { root, row, store } = fixture();
  try {
    store.writeTariffs("holon", 2026, [row({ year: 2026 }), row({ year: 2026, zone: "2" })]);
    store.writeRegistry([{
      key: "holon", name: "חולון", muni_name: "עיריית חולון", aliases: ["חולון", "Holon"],
      site: "https://www.holon.muni.il", last_doc_url: "https://www.holon.muni.il/2026.pdf", last_doc_year: 2026,
    }]);
    const meta = store.updatePublicIndex(store.readRegistry());
    const cities = JSON.parse(readFileSync(join(root, "data", "cities.json"), "utf8"));
    assert.deepEqual(cities[0], {
      key: "holon", name: "חולון", name_en: "Holon", muni_name: "עיריית חולון",
      site: "https://www.holon.muni.il", source_url: "https://www.holon.muni.il/2026.pdf",
      source_year: 2026, years: [2025, 2026], tariff_count: 3,
    });
    assert.equal(meta.tariffs, 3);
    assert.equal(meta.authorities_with_rates, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runs are an append-only JSON-lines log", () => {
  const { root, store } = fixture();
  try {
    store.appendRun({ city_key: "holon", year: 2026, status: "ok" });
    store.appendRun({ city_key: "holon", year: 2026, status: "discovery_failed" });
    assert.deepEqual(store.readRuns().map((run) => run.status), ["ok", "discovery_failed"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("blank optional values normalize to null", () => {
  const row = toPublicTariffRow({ city_key: "x", year: "2026", category_key: "other", category_label: "y", code: "", rate_per_sqm: 1 });
  assert.equal(row.code, null);
  assert.equal(row.year, 2026);
  assert.equal(row.confidence, "high");
  assert.equal(row.needs_review, false);
});

test("the shared-file lock serializes writers and recovers a stale lock", async () => {
  const { mkdtempSync, mkdirSync, utimesSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { withFileLock } = await import("../lib/store.mjs");
  const lock = join(mkdtempSync(join(tmpdir(), "arnona-lock-")), ".lock");
  assert.equal(withFileLock(lock, () => 42), 42);
  assert.equal(existsSync(lock), false);
  mkdirSync(lock);
  const old = new Date(Date.now() - 10 * 60_000);
  utimesSync(lock, old, old);
  assert.equal(withFileLock(lock, () => "recovered"), "recovered");
  assert.throws(() => withFileLock(lock, () => { throw new Error("boom"); }), /boom/);
  assert.equal(existsSync(lock), false);
});
