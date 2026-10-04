import assert from "node:assert/strict";
import test from "node:test";
import {
  selectNationalTargets,
} from "../lib/arnona-national-selection.mjs";

const city = (index) => ({ key: `city-${index}`, name: `רשות ${index}` });
const failedRun = (index, startedAt) => ({
  city_key: `city-${index}`,
  status: "extract_failed",
  started_at: startedAt,
});

test("ordinary national batches preserve the seven-day retry cooldown", () => {
  const now = Date.parse("2026-08-08T10:00:00.000Z");
  const result = selectNationalTargets({
    cities: [city(1), city(2), city(3)],
    tariffs: [],
    runs: [
      failedRun(1, "2026-08-08T09:00:00.000Z"),
      failedRun(2, "2026-07-30T09:00:00.000Z"),
    ],
    batchSize: 10,
    now,
  });

  assert.deepEqual(result.targets.map((item) => item.key), ["city-3", "city-2"]);
  assert.equal(result.pending, 3);
  assert.equal(result.eligible, 2);
});

test("incomplete source discovery retries on the next daily rotation", () => {
  const now = Date.parse("2026-08-08T10:00:00.000Z");
  const result = selectNationalTargets({
    cities: [city(1), city(2)],
    tariffs: [],
    runs: [
      { city_key: "city-1", status: "discovery_failed", started_at: "2026-08-07T09:59:59.000Z" },
      { city_key: "city-2", status: "discovery_failed", started_at: "2026-08-07T10:00:01.000Z" },
    ],
    batchSize: 10,
    now,
  });

  assert.deepEqual(result.targets.map((item) => item.key), ["city-1"]);
  assert.equal(result.eligible, 1);
});

test("a retry sweep includes pre-cutoff failures once and never includes covered authorities", () => {
  const cutoff = "2026-08-08T10:00:00.000Z";
  const allCities = Array.from({ length: 24 }, (_, index) => city(index + 1));
  const tariffs = [{ city_key: "city-24", needs_review: false }];
  const runs = Array.from({ length: 22 }, (_, index) => failedRun(index + 1, "2026-08-08T09:00:00.000Z"));
  const selected = [];

  for (;;) {
    const result = selectNationalTargets({
      cities: allCities,
      tariffs,
      runs,
      batchSize: 10,
      retryBefore: cutoff,
    });
    if (!result.targets.length) break;
    selected.push(...result.targets.map((item) => item.key));
    for (const target of result.targets) {
      runs.push({ city_key: target.key, status: "extract_failed", started_at: "2026-08-08T10:01:00.000Z" });
    }
  }

  assert.equal(selected.length, 23);
  assert.equal(new Set(selected).size, 23);
  assert.equal(selected.includes("city-24"), false);
});

test("all tariff pages are honored when deciding that an authority is covered", () => {
  const tariffs = Array.from({ length: 1_201 }, (_, index) => ({
    city_key: "city-1",
    needs_review: false,
    code: String(index),
  }));
  const result = selectNationalTargets({
    cities: [city(1), city(2)],
    tariffs,
    runs: [],
    batchSize: 10,
    retryBefore: "2026-08-08T10:00:00.000Z",
  });

  assert.deepEqual(result.targets.map((item) => item.key), ["city-2"]);
  assert.equal(result.pending, 1);
});
