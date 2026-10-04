export const NATIONAL_RETRY_AFTER_MS = 7 * 24 * 60 * 60_000;
export const NATIONAL_DISCOVERY_RETRY_AFTER_MS = 24 * 60 * 60_000;

const validStartedAt = (value) => {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
};

export function arnonaNationalRetryAfterMs(status) {
  // Source discovery is HTTP-only and does not spend an LLM extraction call.
  // Retry an incomplete source lookup on the next daily rotation instead of
  // suppressing it for a week like a model/PDF extraction failure.
  return status === "discovery_failed"
    ? NATIONAL_DISCOVERY_RETRY_AFTER_MS
    : NATIONAL_RETRY_AFTER_MS;
}

/**
 * Pure nationwide target selection shared by the scraper and its tests.
 * A retryBefore cutoff snapshots one bulk repair: authorities attempted after the
 * cutoff are excluded from later queued batches, so each pending authority is
 * retried at most once even though its failed tariff state remains pending.
 */
export function selectNationalTargets({
  cities,
  tariffs,
  runs,
  batchSize,
  now = Date.now(),
  retryBefore = null,
  mode = "scheduled",
}) {
  if (!new Set(["scheduled", "retry_failed"]).has(mode)) {
    throw new Error(`invalid national selection mode: ${mode}`);
  }
  if (mode === "retry_failed" && retryBefore != null) {
    throw new Error("retry_failed cannot be combined with retryBefore");
  }
  const rowsByCity = new Map();
  for (const row of tariffs ?? []) {
    rowsByCity.set(row.city_key, [...(rowsByCity.get(row.city_key) ?? []), row]);
  }

  const latestRunByCity = new Map();
  for (const run of runs ?? []) {
    const candidateAt = validStartedAt(run.started_at);
    const currentAt = validStartedAt(latestRunByCity.get(run.city_key)?.started_at);
    if (!latestRunByCity.has(run.city_key)
        || (candidateAt != null && (currentAt == null || candidateAt > currentAt))) {
      latestRunByCity.set(run.city_key, run);
    }
  }

  const pending = (cities ?? []).filter((city) => {
    const rows = rowsByCity.get(city.key) ?? [];
    return !rows.length || rows.some((row) => row.needs_review);
  });

  const retryBeforeMs = retryBefore == null ? null : validStartedAt(retryBefore);
  if (retryBefore != null && retryBeforeMs == null) throw new Error("invalid retryBefore cutoff");

  const failed = pending.filter((city) => {
    const latestRun = latestRunByCity.get(city.key);
    return latestRun && !["ok", "skipped"].includes(latestRun.status);
  });
  const eligible = mode === "retry_failed"
    ? failed
    : pending.filter((city) => {
      const latestRun = latestRunByCity.get(city.key);
      const attemptedAt = validStartedAt(latestRun?.started_at);
      if (attemptedAt == null) return true;
      if (retryBeforeMs != null) return attemptedAt < retryBeforeMs;
      return now - attemptedAt >= arnonaNationalRetryAfterMs(latestRun?.status);
    });

  eligible.sort((a, b) => {
    const aRun = latestRunByCity.get(a.key)?.started_at;
    const bRun = latestRunByCity.get(b.key)?.started_at;
    if (!aRun && bRun) return -1;
    if (aRun && !bRun) return 1;
    if (aRun && bRun && aRun !== bRun) return aRun.localeCompare(bRun);
    return a.name.localeCompare(b.name, "he");
  });

  return {
    targets: eligible.slice(0, batchSize),
    pending: pending.length,
    eligible: eligible.length,
    failedPending: failed.length,
  };
}

export function nationalManualFailedRetryError({ lockAcquired, targetCount, failedPending = 0 }) {
  if (!lockAcquired) return "another scraper run is active; the manual failed retry did not run";
  if (targetCount === 0) return `manual failed retry selected zero of ${failedPending} failed authorities`;
  return null;
}
