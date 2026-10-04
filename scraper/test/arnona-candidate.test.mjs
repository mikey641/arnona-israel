import assert from "node:assert/strict";
import test from "node:test";
import {
  arnonaCandidateOfferedYears,
  arnonaCandidateUrlHasOrderName,
  arnonaFallbackYearOrder,
  describeArnonaPublishedYears,
  arnonaCandidateUrlIsClearlyNotOrder,
  arnonaCandidateUrlMatchesYear,
  classifyArnonaDiscoveryMiss,
  arnonaIdentityVariants,
  arnonaMunicipalHostCandidates,
  arnonaOrderHeaderIsPresent,
  arnonaOrderYearFromHeader,
  isVerifiedArnonaOrderCandidate,
  selectArnonaRequestedOrFallbackFailure,
  selectBestVerifiedArnonaOrderCandidate,
  shouldCrawlRecoveredOfficialSite,
} from "../lib/arnona-candidate.mjs";

const candidate = (year, score, extra = {}) => ({
  url: `https://www.rishonlezion.muni.il/Residents/arnona/ArnonaOrders/צו_ארנונה_${year}.pdf`,
  documentYears: [String(year)],
  hasCityIdentity: true,
  hasOrderHeader: true,
  hasResidential: true,
  hasNonResidential: true,
  ratePages: 15,
  score,
  ...extra,
});

test("a larger wrong-year order cannot beat the requested-year order", () => {
  const exact2026 = candidate(2026, 255_000);
  const larger2027 = candidate(2027, 999_000, {
    // The 2027 order mentions 2026 in comparison tables, which caused the
    // production failure this regression test represents.
    documentYears: ["2026", "2027"],
    ratePages: 17,
  });

  assert.equal(
    selectBestVerifiedArnonaOrderCandidate([larger2027, exact2026], 2026),
    exact2026,
  );
  assert.equal(isVerifiedArnonaOrderCandidate(larger2027, 2026), false);
});

test("the filename year wins over an archive path year", () => {
  assert.equal(
    arnonaCandidateUrlMatchesYear(
      "https://example.muni.il/archive/2026/צו_ארנונה_2027.pdf",
      2026,
    ),
    false,
  );
  assert.equal(
    arnonaCandidateUrlMatchesYear(
      "https://example.muni.il/archive/2025/צו_ארנונה_2026.pdf",
      2026,
    ),
    true,
  );
});

test("an opaque filename is not rejected because its archive directory names another year", () => {
  assert.equal(
    arnonaCandidateUrlMatchesYear(
      "https://example.muni.il/archive/2025/opaque-upload.pdf",
      2026,
    ),
    true,
  );
});

test("an opaque later-year order mentioning the requested year cannot pass", () => {
  const opaque2027 = candidate(2027, 999_000, {
    url: "https://example.muni.il/archive/2026/opaque-upload.pdf",
    documentYears: ["2026", "2027"],
    orderYear: 2027,
  });
  assert.equal(isVerifiedArnonaOrderCandidate(opaque2027, 2026), false);
  assert.equal(arnonaOrderYearFromHeader([
    "מועצה מקומית לדוגמה — צו הארנונה הכללית לשנת 2027",
    "טבלת השוואה לתעריפי 2026",
  ]), 2027);
});

test("no candidate is returned when every full order is for another year", () => {
  assert.equal(selectBestVerifiedArnonaOrderCandidate([candidate(2027, 999_000)], 2026), null);
});

test("a municipal collection-services tender cannot beat the exact Arnona order", () => {
  const exactOrder = candidate(2026, 80_000);
  const tender = candidate(2026, 2_000_000, {
    url: "https://www.orakiva.muni.il/wp-content/uploads/2026/05/מכרז-לשירותי-גבייה-כולליים-05.26-עיריית-אור-עקיבא.pdf",
    ratePages: 142,
  });

  assert.equal(arnonaCandidateUrlIsClearlyNotOrder(tender.url), true);
  assert.equal(isVerifiedArnonaOrderCandidate(tender, 2026), false);
  assert.equal(selectBestVerifiedArnonaOrderCandidate([tender, exactOrder], 2026), exactOrder);
});

test("legal-order identity must be present near the start of the document", () => {
  assert.equal(arnonaCandidateUrlHasOrderName(candidate(2026, 1).url), true);
  assert.equal(arnonaOrderHeaderIsPresent([
    "עיריית אור עקיבא — צו הארנונה הכללית לשנת 2026",
    "סיווג מגורים ותעריפים",
  ]), true);
  assert.equal(arnonaOrderHeaderIsPresent([
    "מכרז פומבי למתן שירותי גבייה",
    "המפרט כולל טיפול בשומות ובחיובים",
    "טבלאות שירות ותמחור",
  ]), false);
});

test("regional councils probe the ma-*.org.il convention before declaring no document", () => {
  const hosts = arnonaMunicipalHostCandidates(["tamar"], "מועצה אזורית תמר");
  assert.ok(hosts.includes("ma-tamar.org.il"));
  assert.ok(hosts.includes("www.ma-tamar.org.il"));
  assert.ok(hosts.includes("tamar.muni.il"));
  assert.equal(new Set(hosts).size, hosts.length);
});

test("local councils also probe their common *.org.il municipal host", () => {
  const hosts = arnonaMunicipalHostCandidates(["oranit"], "מועצה מקומית אורנית");
  assert.ok(hosts.includes("oranit.org.il"));
  assert.ok(hosts.includes("www.oranit.org.il"));
  assert.ok(hosts.includes("m-oranit.muni.il"));
  assert.equal(new Set(hosts).size, hosts.length);
});

test("three-letter Hebrew authority names remain valid document identities", () => {
  const [tamar] = arnonaIdentityVariants("תמר");
  const [opening] = arnonaIdentityVariants("החלטת המועצה האזורית תמר בדבר היטל המסים לשנת 2026");
  assert.equal(tamar, "תמר");
  assert.ok(opening.includes(tamar));
});

test("a search miss without a reachable official source is retryable discovery failure", () => {
  const result = classifyArnonaDiscoveryMiss({
    availableSearchProviders: ["DuckDuckGo", "Bing"],
    unavailableSearchProviders: ["Brave"],
  });

  assert.equal(result.status, "discovery_failed");
  assert.match(result.error, /לא זוהה אתר רשמי מאומת/);
  assert.match(result.error, /Brave/);
});

// Every public engine bot-challenges a datacenter IP, so the operator
// needs to see that the search-free directory was consulted too before treating
// "no official site" as a real gap rather than another transport failure.
test("a directory lookup that found no official site is reported explicitly", () => {
  const result = classifyArnonaDiscoveryMiss({
    directoryChecked: true,
    unavailableSearchProviders: ["Brave", "Bing", "DuckDuckGo"],
  });

  assert.equal(result.status, "discovery_failed");
  assert.match(result.error, /מדריך/);
});

test("an unchecked directory is not claimed as checked", () => {
  const result = classifyArnonaDiscoveryMiss({ availableSearchProviders: ["Brave"] });

  assert.doesNotMatch(result.error, /מדריך/);
});

test("no_doc is reserved for a reachable verified municipal source", () => {
  const result = classifyArnonaDiscoveryMiss({
    hadConfiguredSource: true,
    officialPagesChecked: 2,
    availableSearchProviders: ["Brave"],
  });

  assert.equal(result.status, "no_doc");
  assert.match(result.error, /2 עמודים באתר הרשמי/);
});

test("a blocked configured PDF plus relay 502 remains an access failure, not no_doc", () => {
  const result = classifyArnonaDiscoveryMiss({
    hadConfiguredSource: true,
    officialPagesChecked: 2,
    availableSearchProviders: ["Google"],
    configuredSourceAccessFailure: {
      directStatus: null,
      relayStatus: 502,
    },
  });
  assert.equal(result.status, "discovery_failed");
  assert.equal(result.reason, "source_access_failed");
  assert.match(result.error, /502/);
});

test("a configured fallback access failure replaces an earlier exact-year no_doc", () => {
  const exact = { missing: true, status: "no_doc", error: "no exact order" };
  const fallback = {
    missing: true,
    status: "discovery_failed",
    reason: "source_access_failed",
    error: "configured fallback relay returned 502",
  };
  assert.equal(selectArnonaRequestedOrFallbackFailure(exact, fallback), fallback);
  assert.equal(selectArnonaRequestedOrFallbackFailure(exact, {
    invalid: true,
    error: "fallback is not a full order",
  }), exact);
});

// The registry writes "הרצלייה"; herzliya.muni.il writes "הרצליה". The identity
// check rejected the municipality's own correct site as a different authority.
test("optional-yod spellings identify the same authority", () => {
  const registry = arnonaIdentityVariants("הרצלייה");
  const site = arnonaIdentityVariants("עיריית הרצליה");

  assert.ok(
    registry.some((r) => site.some((s) => s.includes(r))),
    `no shared identity between ${registry.join(",")} and ${site.join(",")}`,
  );
});

test("a genuinely different authority is still not matched", () => {
  const modiinIllit = arnonaIdentityVariants("מודיעין עילית");
  const betarIllit = arnonaIdentityVariants("עיריית ביתר עילית");

  assert.ok(!modiinIllit.some((r) => betarIllit.some((s) => s.includes(r))));
});

// חבל מודיעין: the directory named modiin-region.muni.il, which the scraper could
// not reach. Reporting that as "the directory had no site" sends the operator
// looking for an address that is already known.
test("a directory site that was found but unusable is reported as such", () => {
  const result = classifyArnonaDiscoveryMiss({
    directoryChecked: true,
    directorySiteUnusable: "http://www.modiin-region.muni.il/ (לא נגיש משרת העבודה)",
  });

  assert.match(result.error, /הצביע על/);
  assert.match(result.error, /modiin-region/);
  assert.doesNotMatch(result.error, /לא כלל אתר רשמי מאומת/);
});

// חורפיש publishes on lch.org.il and stopped at 2022. Reporting "no source" for
// an authority that plainly published an order — just not this year — hid a
// usable rate book and sent the operator hunting for a document that does not
// exist.
test("a document named for another year is remembered as a published year", () => {
  assert.deepEqual(
    arnonaCandidateOfferedYears("https://www.lch.org.il/uploads/צו-ארנונה-2022.pdf"),
    [2022],
  );
  assert.deepEqual(
    arnonaCandidateOfferedYears("https://www.lch.org.il/uploads/n/17557.pdf", "צו ארנונה 2021"),
    [2021],
  );
});

test("the nearest published year is tried first, and the newer one breaks a tie", () => {
  assert.deepEqual(
    arnonaFallbackYearOrder([2019, 2020, 2021, 2022], 2026),
    [2022, 2021],
  );
  assert.deepEqual(
    arnonaFallbackYearOrder([2025, 2027], 2026, { limit: 2 }),
    [2027, 2025],
  );
});

test("a published year already tried, or too old to be a rate book, is not retried", () => {
  assert.deepEqual(arnonaFallbackYearOrder([2025, 2024], 2026, { exclude: [2025] }), [2024]);
  assert.deepEqual(arnonaFallbackYearOrder([2005, 2026], 2026), []);
});

test("the published years an authority does have are stated in the failure", () => {
  assert.match(describeArnonaPublishedYears([2022, 2019, 2021], 2026), /2019, 2021, 2022/);
  assert.equal(describeArnonaPublishedYears([], 2026), "");
});

// חצור הגלילית: the live search identified hatzorg.co.il and the same run then
// reported "no verified official site", because the crawl had already finished.
test("a site recovered by the live search is crawled before the run gives up", () => {
  assert.equal(shouldCrawlRecoveredOfficialSite({
    candidateCount: 0, site: "https://hatzorg.co.il", siteSource: "live_search",
  }), true);
  assert.equal(shouldCrawlRecoveredOfficialSite({
    candidateCount: 2, site: "https://hatzorg.co.il", siteSource: "live_search",
  }), false);
  assert.equal(shouldCrawlRecoveredOfficialSite({
    candidateCount: 0, site: "https://gezer.muni.il", siteSource: "host_probe",
  }), false);
  assert.equal(shouldCrawlRecoveredOfficialSite({ candidateCount: 0 }), false);
});
