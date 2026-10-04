const YEAR_RE = /20\d{2}/g;

export function arnonaIdentityVariants(value) {
  let decoded = String(value ?? "");
  try { decoded = decodeURIComponent(decoded); } catch { /* keep undecoded text */ }
  const compact = decoded.toLocaleLowerCase("he-IL").replace(/[^\p{L}\p{N}]+/gu, "");
  // Three-letter Hebrew authority names such as תמר, גזר and זמר are common and
  // sufficiently specific in a document header. The previous four-character
  // floor silently removed them and made their own orders look cross-city.
  const minimumLength = /^[\p{Script=Hebrew}\d]+$/u.test(compact) ? 3 : 4;
  if (compact.length < minimumLength) return [];
  const variants = new Set([compact]);
  if (/^[a-z0-9]+$/i.test(compact)) variants.add(compact.replaceAll("h", ""));
  // Hebrew כתיב מלא/חסר: the authoritative registry writes "הרצלייה" and
  // "נהרייה" while the municipalities' own sites write "הרצליה" and "נהריה".
  // Without the collapsed spelling the identity check rejected herzliya.muni.il
  // as a different authority and threw away a correctly discovered site.
  const collapsed = compact.replace(/יי/g, "י").replace(/וו/g, "ו");
  if (collapsed !== compact) variants.add(collapsed);
  return [...variants].filter((variant) => variant.length >= minimumLength);
}

function decodedUrlParts(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const pathname = decodeURIComponent(url.pathname);
    return {
      filename: pathname.split("/").filter(Boolean).at(-1) ?? "",
      full: `${pathname} ${decodeURIComponent(url.search)}`,
    };
  } catch {
    let decoded = String(rawUrl ?? "");
    try { decoded = decodeURIComponent(decoded); } catch { /* retain the original */ }
    return { filename: decoded.split(/[/?#]/).filter(Boolean).at(-1) ?? "", full: decoded };
  }
}

export function arnonaCandidateUrlIsClearlyNotOrder(rawUrl) {
  const { full } = decodedUrlParts(rawUrl);
  return /(?:מכרז|קול קורא|תכניות?[-_\s]*עבודה|תקציב|מאזן|מפה|citymap|(?:^|[-_])map\d|tender|procurement|work[-_\s]*plan|budget)/iu
    .test(full);
}

export function arnonaCandidateUrlHasOrderName(rawUrl) {
  const { full } = decodedUrlParts(rawUrl);
  return /(?:צו.{0,24}ארנונה|ארנונה.{0,24}צו)/iu.test(full);
}

export function arnonaOrderHeaderIsPresent(pages = []) {
  // Collection-service tenders repeat tariff tables and can satisfy every
  // whole-document keyword check. A legal order must identify itself near the
  // beginning of the document, where a real order names itself.
  const header = (pages ?? []).slice(0, 3).join("\n").replace(/\s+/g, " ");
  return /(?:צו.{0,50}ארנונה|ארנונה.{0,50}(?:כללית|לשנת|שנת\s+הכספים)|הטלת.{0,40}ארנונה)/u
    .test(header);
}

export function arnonaOrderYearFromHeader(pages = []) {
  const openings = (pages ?? []).slice(0, 3).map((page) => String(page ?? "")
    .replace(/[\u200e\u200f\u202a-\u202e]/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 2_000));
  const patterns = [
    /(?:צו(?:וי)?|החלטה|הודעה|הטלת).{0,140}?ארנונה.{0,100}?(?:לשנת(?:\s+הכספים)?|שנת\s+הכספים)?\s*(20\d{2})/u,
    /ארנונה(?:\s+כללית)?.{0,60}?(?:לשנת(?:\s+הכספים)?|שנת\s+הכספים)\s*(20\d{2})/u,
  ];
  for (const opening of openings) {
    for (const pattern of patterns) {
      const match = opening.match(pattern);
      if (match) return Number(match[1]);
    }
  }
  return null;
}

/**
 * Prefer the PDF filename as the legal-order year signal. A surrounding archive
 * path can legitimately contain the upload year, but a file named for another
 * tax year is never an exact-year candidate.
 */
export function arnonaCandidateUrlMatchesYear(rawUrl, requestedYear) {
  const target = String(requestedYear);
  const { filename } = decodedUrlParts(rawUrl);
  const filenameYears = filename.match(YEAR_RE) ?? [];
  if (filenameYears.length) return filenameYears.includes(target);
  return true;
}

/**
 * CBS supplies authority names, but not the municipality's website. Regional
 * councils commonly use ma-<english-name>.org.il instead of the older
 * <english-name>.muni.il convention. Keep the probes deterministic and bounded;
 * callers still verify the homepage identity before trusting a host.
 */
export function arnonaMunicipalHostCandidates(slugs, municipalityName = "") {
  const regional = /\bregional\s+council\b/i.test(municipalityName)
    || /מועצה\s+אזורית/u.test(municipalityName);
  const local = /\blocal\s+council\b/i.test(municipalityName)
    || /מועצה\s+מקומית/u.test(municipalityName);
  const hosts = new Set();
  for (const slug of slugs.slice(0, 8)) {
    const prefixes = regional ? [`ma-${slug}.org.il`, `${slug}.org.il`]
      : local ? [`${slug}.org.il`, `m-${slug}.muni.il`]
      : [];
    for (const host of [...prefixes, `${slug}.muni.il`]) {
      hosts.add(host);
      hosts.add(`www.${host}`);
    }
  }
  return [...hosts].slice(0, 32);
}

/**
 * `no_doc` is a strong claim: it is only justified after at least one page on a
 * verified official municipal source was actually reachable. A public-search
 * miss on its own is an incomplete discovery attempt, not evidence that the
 * authority did not publish an order.
 */
export function classifyArnonaDiscoveryMiss({
  hadConfiguredSource = false,
  officialPagesChecked = 0,
  officialPagesUnavailable = 0,
  availableSearchProviders = [],
  unavailableSearchProviders = [],
  configuredSourceAccessFailure = null,
  directoryChecked = false,
  directorySiteUnusable = null,
} = {}) {
  const available = [...new Set(availableSearchProviders)].sort();
  const unavailable = [...new Set(unavailableSearchProviders)].sort();
  const searchSummary = available.length
    ? `החיפוש הציבורי הושלם דרך ${available.join(", ")}`
    : "לא היה ספק חיפוש ציבורי זמין";

  if (configuredSourceAccessFailure) {
    const direct = configuredSourceAccessFailure.directStatus ?? "network";
    const relay = configuredSourceAccessFailure.relayStatus ?? "unavailable";
    return {
      status: "discovery_failed",
      reason: "source_access_failed",
      error: `המקור הרשמי המוגדר לא היה נגיש (ישיר: ${direct}; ממסר מאומת: ${relay}); ${searchSummary}`,
    };
  }

  if (officialPagesChecked > 0) {
    return {
      status: "no_doc",
      error: `לא נמצא צו לאחר בדיקת ${officialPagesChecked} עמודים באתר הרשמי; ${searchSummary}`,
    };
  }

  const sourceSummary = hadConfiguredSource || officialPagesUnavailable > 0
    ? "המקור הרשמי שהוגדר לא היה נגיש"
    : "לא זוהה אתר רשמי מאומת";
  const unavailableSummary = unavailable.length
    ? `; ספקים שלא היו זמינים: ${unavailable.join(", ")}`
    : "";
  // Distinguish "the directory has no official site for this authority" from
  // "the directory named a site we could not use" and from "we never looked".
  // Only the first is evidence about the authority itself; reporting a site that
  // was found but unreachable as a directory gap sends the operator hunting for
  // an address that is already known.
  const directorySummary = directorySiteUnusable
    ? `; מדריך הרשויות הציבורי הצביע על ${directorySiteUnusable}`
    : directoryChecked
      ? "; מדריך הרשויות הציבורי נבדק ולא כלל אתר רשמי מאומת"
      : "";
  return {
    status: "discovery_failed",
    error: `גילוי המקור לא הושלם: ${sourceSummary}; ${searchSummary}${unavailableSummary}${directorySummary}`,
  };
}

/**
 * Tax years an authority was seen offering, read from a document URL and the
 * link that pointed at it. A council that stopped publishing — חורפיש's site
 * holds 2019–2022 and nothing since — otherwise looks identical to one whose
 * order the crawl simply failed to reach.
 */
export function arnonaCandidateOfferedYears(rawUrl, linkText = "") {
  const { filename } = decodedUrlParts(rawUrl);
  const found = [
    ...(filename.match(YEAR_RE) ?? []),
    ...(String(linkText ?? "").match(YEAR_RE) ?? []),
  ].map(Number);
  return [...new Set(found)].filter((year) => Number.isInteger(year));
}

/**
 * Which published year to try once the requested one has been exhausted, best
 * first: nearest year wins, and the newer year wins a tie. An order more than
 * `span` years old is a historical document rather than a usable rate book, and
 * the attempt count is bounded because every attempt re-crawls the authority.
 */
export function arnonaFallbackYearOrder(offeredYears, requestedYear, {
  exclude = [], limit = 2, span = 12,
} = {}) {
  const requested = Number(requestedYear);
  if (!Number.isInteger(requested)) return [];
  const excluded = new Set((exclude ?? []).map(Number));
  return [...new Set([...(offeredYears ?? [])].map(Number))]
    .filter((year) => Number.isInteger(year)
      && year !== requested
      && !excluded.has(year)
      && year >= requested - span
      && year <= requested + 2)
    .sort((left, right) =>
      Math.abs(left - requested) - Math.abs(right - requested) || right - left)
    .slice(0, limit);
}

/**
 * "No order found" and "this authority last published in 2022" are different
 * facts, and only the second tells the operator there is nothing to fix.
 */
export function describeArnonaPublishedYears(offeredYears, requestedYear) {
  const years = [...new Set([...(offeredYears ?? [])].map(Number))]
    .filter((year) => Number.isInteger(year) && year !== Number(requestedYear)
      && year >= 2000 && year <= 2100)
    .sort((left, right) => left - right);
  if (!years.length) return "";
  return `; באתר הרשמי פורסמו צווים לשנים ${years.join(", ")} בלבד`;
}

/**
 * The live search runs after the crawl has already finished, so a site it
 * recovers arrives too late to be read: חצור הגלילית reported "no verified
 * official site" in the same run that had just identified hatzorg.co.il. An
 * address is the whole point of that last resort, so it must be crawled before
 * the run gives up — and only when it is genuinely new and nothing was found.
 */
export function shouldCrawlRecoveredOfficialSite({
  candidateCount = 0, site = null, siteSource = null,
} = {}) {
  return candidateCount === 0 && Boolean(site) && siteSource === "live_search";
}

export function selectArnonaRequestedOrFallbackFailure(exact, fallback) {
  if (fallback?.missing && fallback.reason === "source_access_failed") return fallback;
  return exact;
}

export function isVerifiedArnonaOrderCandidate(candidate, requestedYear) {
  const { filename } = decodedUrlParts(candidate.url);
  const filenameYears = filename.match(YEAR_RE) ?? [];
  const hasVerifiedOrderYear = filenameYears.length > 0
    ? filenameYears.includes(String(requestedYear))
    : Number(candidate.orderYear) === Number(requestedYear);
  return arnonaCandidateUrlMatchesYear(candidate.url, requestedYear)
    && hasVerifiedOrderYear
    && !arnonaCandidateUrlIsClearlyNotOrder(candidate.url)
    && (candidate.documentYears ?? []).includes(String(requestedYear))
    && candidate.hasCityIdentity === true
    && candidate.hasOrderHeader === true
    && candidate.hasResidential === true
    && candidate.hasNonResidential === true
    && Number(candidate.ratePages) > 0;
}

/**
 * Eligibility is rechecked here, before quality scoring. This prevents a longer
 * wrong-year PDF from winning even if a caller accidentally gives it a high score.
 */
export function selectBestVerifiedArnonaOrderCandidate(candidates, requestedYear) {
  return candidates
    .filter((candidate) => isVerifiedArnonaOrderCandidate(candidate, requestedYear))
    .sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0))[0] ?? null;
}
