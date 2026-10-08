#!/usr/bin/env node
// Israeli ארנונה (municipal property tax) rate-book scraper.
//
//   node scraper/scrape-arnona.mjs --city tel-aviv --year 2026   # one authority (key or any alias)
//   node scraper/scrape-arnona.mjs --year 2026                   # refresh every authority with a known source
//   node scraper/scrape-arnona.mjs --city חולון --dry            # discover + extract, write nothing
//   node scraper/scrape-arnona.mjs --city holon --force          # re-scrape a year we already have
//   node scraper/scrape-arnona.mjs --show --year 2026            # print the stored rate book and exit
//   node scraper/scrape-arnona.mjs --show --city tel-aviv        # ... for one authority
//   node scraper/scrape-arnona.mjs --national --batch 2          # next nationwide batch (CBS registry)
//   node scraper/scrape-arnona.mjs --national --plan             # print the next batch, no scrape
//   node scraper/scrape-arnona.mjs --national --batch 10 --retry-failed
//                                                               # only authorities whose last run failed
//   node scraper/scrape-arnona.mjs --sync-registry-only          # sync the official CBS authority list
//   node scraper/scrape-arnona.mjs --city CITY --dry --discover-only  # verify source discovery only
//   node scraper/scrape-arnona.mjs --self-test                   # offline wiring check
//
// WHY A SCRAPER AT ALL — there is no national tariff dataset. CBS publishes the
// canonical local-authority registry (which --national syncs), but data.gov.il has
// exactly two arnona datasets (a Haifa assessment-zone map and a Be'er Sheva business
// file), and the Ministry of Interior publishes only the allowed *increase* (1.626% for
// 2026), never the rates. The rates live in each municipality's "צו הארנונה" — a PDF,
// approved the preceding summer, effective 01.01 — and nowhere else.
//
// MODEL QUALITY — a municipal tax order is a legal/financial source, and a plausible
// partial extraction is more dangerous than a loud failure. Use the strongest model you
// have (see lib/llm.mjs). Deterministic validation still checks the document year, core
// uses, sanity bands and year-over-year movement, and row-level uncertainty remains
// visible as needs_review.
//
// DISCOVERY is a 5-rung ladder, cheapest first, and self-healing — whatever rung wins
// is written back to scraper/state/registry.json (last_doc_url), so next year starts
// from a known-good link:
//   1. doc_url_template with {year}          (exact, free)
//   2. last year's URL with the year swapped (exact, free — most munis keep the pattern)
//   3. crawl the official site's search/archive pages and index_urls (free); an
//      authority with no known site is resolved by probing conventional hostnames
//      and then the Hebrew Wikipedia article's official-website link
//   4. optional LLM live web search ("X צו ארנונה YYYY" — the search a person runs)
//   5. public web search (Brave, DuckDuckGo, Bing — free, but often bot-walled)
//
// Rates are stored as printed: ₪ per m² per YEAR, in data/tariffs/<year>/<city_key>.json.

import { createHash } from "node:crypto";
import { strFromU8, unzipSync } from "fflate";
import { spawnSync } from "node:child_process";
import {
  closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync,
  rmSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  arnonaCandidateOfferedYears,
  arnonaCandidateUrlHasOrderName,
  arnonaCandidateUrlIsClearlyNotOrder,
  arnonaCandidateUrlMatchesYear,
  arnonaFallbackYearOrder,
  classifyArnonaDiscoveryMiss,
  describeArnonaPublishedYears,
  arnonaIdentityVariants,
  arnonaMunicipalHostCandidates,
  arnonaOrderHeaderIsPresent,
  arnonaOrderYearFromHeader,
  isVerifiedArnonaOrderCandidate,
  selectArnonaRequestedOrFallbackFailure,
  selectBestVerifiedArnonaOrderCandidate,
  shouldCrawlRecoveredOfficialSite,
} from "./lib/arnona-candidate.mjs";
import {
  CBS_LOCAL_AUTHORITIES_URL,
  cbsAuthorityCityKey,
  parseCbsLocalAuthoritiesXlsx,
} from "./lib/cbs-local-authorities.mjs";
import {
  linksFromMunicipalHtml,
  municipalCrawlLinks,
  municipalLinkScore,
  municipalSearchResponseUsable,
} from "./lib/arnona-links.mjs";
import { resolveMunicipalSiteFromDirectory } from "./lib/arnona-directory.mjs";
import { researchArnonaSource } from "./lib/arnona-research.mjs";
import {
  nationalManualFailedRetryError,
  selectNationalTargets,
} from "./lib/arnona-national-selection.mjs";
import { arnonaSourceRelayRequest, fetchArnonaCandidateWithRelay } from "./lib/arnona-source-relay.mjs";
import { NO_LLM_MESSAGE, parseJsonAnswer, runLlmText, selectLlmBackend } from "./lib/llm.mjs";
import { SCRAPER_DIR, createStore } from "./lib/store.mjs";

const CACHE_DIR = join(SCRAPER_DIR, "cache");

// ── env ──────────────────────────────────────────────────────────────────────
// scraper/.env (optional, gitignored) — real environment variables win.
const ENV_FILE = join(SCRAPER_DIR, ".env");
if (existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!match || line.trimStart().startsWith("#")) continue;
    const value = match[2].replace(/^(["'])(.*)\1$/, "$2");
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

const store = createStore();

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const YEAR = Number(opt("year", String(new Date().getFullYear())));
const DRY = flag("dry");
const FORCE = flag("force");
const QUIET = flag("quiet");
const SHOW = flag("show");
const ONLY_CITY = opt("city");
const NATIONAL = flag("national") || flag("sync-registry-only");
const SYNC_REGISTRY_ONLY = flag("sync-registry-only");
const PLAN_ONLY = flag("plan");
const DISCOVER_ONLY = flag("discover-only");
const NATIONAL_RETRY_BEFORE = opt("retry-before");
const RETRY_FAILED = flag("retry-failed");
const SELF_TEST = flag("self-test");
if (!Number.isInteger(YEAR) || YEAR < 2000 || YEAR > 2100) throw new Error("--year must be a four-digit year");
if (DISCOVER_ONLY && !DRY) throw new Error("--discover-only must be used with --dry");
if (NATIONAL_RETRY_BEFORE && (!NATIONAL || !Number.isFinite(Date.parse(NATIONAL_RETRY_BEFORE)))) {
  throw new Error("--retry-before requires --national and a valid ISO timestamp");
}
if (RETRY_FAILED && (!flag("national") || SYNC_REGISTRY_ONLY || ONLY_CITY || NATIONAL_RETRY_BEFORE)) {
  throw new Error("--retry-failed requires --national and cannot be combined with another retry scope");
}
const NATIONAL_BATCH = Number(opt("batch", "2"));
if (!Number.isInteger(NATIONAL_BATCH) || NATIONAL_BATCH < 1 || NATIONAL_BATCH > 10) {
  throw new Error("--batch must be an integer from 1 to 10");
}

const normalizeCity = (value) => String(value ?? "")
  .trim().replace(/[–—]/g, "-").replace(/\s*-\s*/g, "-").replace(/\s+/g, " ");

// One run per authority at a time. A --city run locks only that authority, so several
// authorities can be scraped in parallel; shared files are guarded by the store's lock.
const LOCK_FILE = join(
  CACHE_DIR,
  ONLY_CITY
    ? `.scrape-${createHash("sha1").update(normalizeCity(ONLY_CITY)).digest("hex").slice(0, 12)}.lock`
    : ".scrape.lock",
);

function acquireScrapeLock() {
  mkdirSync(CACHE_DIR, { recursive: true });
  const attempt = () => {
    try {
      const fd = openSync(LOCK_FILE, "wx");
      writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      closeSync(fd);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          const holder = JSON.parse(readFileSync(LOCK_FILE, "utf8"));
          if (Number(holder.pid) === process.pid) unlinkSync(LOCK_FILE);
        } catch { /* already released or replaced */ }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let holder = null;
      try { holder = JSON.parse(readFileSync(LOCK_FILE, "utf8")); } catch { /* stale/corrupt */ }
      if (Number.isInteger(Number(holder?.pid))) {
        try {
          process.kill(Number(holder.pid), 0);
          return null;
        } catch (probeError) {
          if (probeError?.code !== "ESRCH") return null;
        }
      }
      try { unlinkSync(LOCK_FILE); } catch (unlinkError) {
        if (unlinkError?.code !== "ENOENT") throw unlinkError;
      }
      return attempt();
    }
  };
  return attempt();
}


// ── sanity bands (₪ per m² per year) ─────────────────────────────────────────
// Deliberately wide — they exist to catch a decimal slip or a column mix-up
// (a rate read out of the "total charge" column), not to second-guess a city.
// Israel's national floor/ceiling for residential is roughly 25–160 ₪/m².
const BANDS = {
  residential: [15, 200],
  // Banks are legitimately around ₪1,600/m²/year in several city orders.
  office: [40, 2000],
  commerce: [40, 900],
  industry: [20, 600],
  workshop: [20, 400],
  // Bank archives/storage are a special high-value class in some city orders.
  storage: [10, 800],
  parking: [3, 300],
  hotel: [20, 400],
  // Occupied agricultural/water-infrastructure land can legally be only a few
  // agorot per m²; solar-land bands can also sit below one shekel.
  land: [0.01, 200],
  // Orchards/field crops can be only a few agorot, while farm buildings and
  // covered horse-farm sheds legitimately use ordinary built-property rates.
  farm: [0.01, 300],
  public: [5, 500],
  other: [0.01, 2000],
};
const CATEGORIES = Object.keys(BANDS);

// ── http ─────────────────────────────────────────────────────────────────────
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
  + "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// Identify honestly first. Cloudflare challenges a client that claims to be Chrome
// but does not behave like one: on 2026-10-08 Kfar Saba, Bat Yam, Netanya and ten
// regional councils answered our Chrome User-Agent with "verify you are human",
// while the same files downloaded at once under a plain, non-browser agent. Some
// SPD-hosted sites conversely bounce non-browser agents to abuse.spd.co.il, so
// those (only) are retried with the browser string.
const HONEST_UA = "arnona-israel-scraper (+https://github.com/mikey641/arnona-israel)";
const refused = (res) => !res.ok || /abuse\.spd\.co\.il/.test(res.url ?? "");

async function get(url, options = {}) {
  if (options.headers) return getOnce(url, options);
  const honest = await getOnce(url, { ...options, headers: { "user-agent": HONEST_UA, "accept-language": "he-IL,he;q=0.9,en;q=0.8" } });
  if (!refused(honest)) return honest;
  const browser = await getOnce(url, options);
  return refused(browser) ? honest : browser;
}

async function getOnce(url, { timeout = 45_000, binary = false, headers = null } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      redirect: "follow",
      headers: headers ?? { "user-agent": UA, "accept-language": "he-IL,he;q=0.9,en;q=0.8" },
    });
    if (!res.ok) return { ok: false, status: res.status };
    const type = res.headers.get("content-type") ?? "";
    if (binary) return { ok: true, type, buf: Buffer.from(await res.arrayBuffer()), url: res.url };
    return { ok: true, type, body: await res.text(), url: res.url };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  } finally {
    clearTimeout(timer);
  }
}

const isPdf = (r) => r.ok && (r.type?.includes("pdf") || r.buf?.subarray(0, 5).toString() === "%PDF-");

// ── discovery ────────────────────────────────────────────────────────────────

const YEAR_RE = /20\d{2}/g;
// A link worth trying: a PDF whose URL or anchor text reads like a צו ארנונה.
const TZAV_WORDS = ["צו", "ארנונה", "tzav", "arnona", "zav", "arnona-order", "tashlum"];

// Scoring lives in ./lib/arnona-links.mjs so the crawl thresholds stay covered
// by regression tests (a council's "צו המיסים" page must remain followable).
const scoreLink = municipalLinkScore;

function unwrapSearchUrl(raw) {
  try {
    const url = new URL(raw);
    // DuckDuckGo wraps result URLs in /l/?uddg=<encoded target>.
    if (/(^|\.)duckduckgo\.com$/i.test(url.hostname)) return url.searchParams.get("uddg") ?? raw;
    // Bing wraps result URLs in /ck/a?...&u=a1<base64url(target)>.
    if (/(^|\.)bing\.com$/i.test(url.hostname) && url.pathname === "/ck/a") {
      const packed = url.searchParams.get("u");
      if (packed?.startsWith("a1")) return Buffer.from(packed.slice(2), "base64url").toString("utf8");
    }
    return url.toString();
  } catch { return raw; }
}

function isOfficialMunicipalUrl(url, city) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (city.site) {
      const siteHost = new URL(city.site).hostname.toLowerCase();
      if (host === siteHost || host.endsWith(`.${siteHost}`) || siteHost.endsWith(`.${host}`)) return true;
    }
    // Both government municipal sites (for example tel-aviv.gov.il) and the
    // traditional municipal domain are official. For a newly discovered city,
    // reject commercial aggregators even if a search engine ranks them first.
    return host.endsWith(".gov.il") || host.endsWith(".muni.il");
  } catch { return false; }
}

function identityVariants(value) {
  return arnonaIdentityVariants(value);
}

function cityIdentityVariants(city) {
  return [city.name, city.muni_name, ...(city.aliases ?? [])].flatMap(identityVariants);
}

function latinConsonantSignature(value) {
  return String(value ?? "").toLowerCase().normalize("NFKD")
    .replace(/[aeiou\W_]+/g, "").replace(/(.)\1+/g, "$1");
}

function nonStandardHostMatchesCity(url, city) {
  let labels;
  try { labels = new URL(url).hostname.toLowerCase().split("."); } catch { return false; }
  while (["www", "he", "ar", "en"].includes(labels[0])) labels.shift();
  const suffixLength = labels.at(-1) === "il" && labels.length > 2 ? 2 : 1;
  const hostSignature = latinConsonantSignature(labels.slice(0, -suffixLength).join(""));
  if (hostSignature.length < 4) return false;
  return (city.aliases ?? []).filter((alias) => /^[a-z0-9 .'’-]+$/i.test(alias))
    .map(latinConsonantSignature).filter((identity) => identity.length >= 4)
    .some((identity) => hostSignature.includes(identity) || identity.includes(hostSignature));
}

function candidateMatchesCity(candidate, city) {
  const haystacks = [candidate.url, candidate.text].flatMap(identityVariants);
  return cityIdentityVariants(city)
    .some((identity) => haystacks.some((haystack) => haystack.includes(identity)));
}

function documentMatchesCity(pages, city) {
  // The issuing authority is printed in the cover/header. This cross-city guard
  // prevents a search engine's valid 2026 order for another municipality from
  // ever reaching extraction.
  const opening = identityVariants(pages.slice(0, 5).join(" "));
  return cityIdentityVariants(city)
    .some((identity) => opening.some((haystack) => haystack.includes(identity)));
}

function municipalDomainSlugs(city) {
  const slugs = new Set();
  for (const alias of city.aliases ?? []) {
    if (!/^[a-z0-9 .'’-]+$/i.test(alias)) continue;
    const words = alias.toLowerCase().replace(/[’']/g, "")
      .split(/[^a-z0-9]+/).filter(Boolean);
    if (!words.length) continue;
    for (const value of [words.join(""), words.join("-")]) {
      slugs.add(value.replaceAll("gh", "g"));
      slugs.add(value);
    }
  }
  return [...slugs].filter((slug) => slug.length >= 4).slice(0, 8);
}

async function discoverMunicipalSite(city, year, log) {
  const pagesFor = (origin, homeUrl = origin) => {
    const query = encodeURIComponent(`צו ארנונה ${year}`);
    return [`${origin}/he/?s=${query}`, `${origin}/?s=${query}`, homeUrl];
  };
  if (city.site) {
    const origin = new URL(city.site).origin;
    // A configured site can be stale: חיפה pointed at https://haifa.muni.il,
    // which serves the blank "IIS Windows Server" placeholder, and the run kept
    // reporting "no order after checking 2 pages" instead of looking anywhere
    // else. Trusting a configured host that serves no municipal content at all
    // makes the failure permanent, so fall through to rediscovery instead.
    const home = await get(origin, { timeout: 12_000 });
    const pageText = (home.body ?? "").slice(0, 160_000).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
    // Judge the CONTENT, never the address: haifa.muni.il names the city in its
    // own hostname, so matching the URL would call an empty IIS placeholder a
    // municipal site and keep the authority permanently undiscoverable.
    const servesMunicipalContent = home.ok && Boolean(home.body)
      && (/עיריית|מועצה\s+(?:מקומית|אזורית)|بلدية|municipality|local council/i.test(pageText)
        || candidateMatchesCity({ url: "", text: pageText }, city));
    if (servesMunicipalContent) return pagesFor(origin, home.url ?? origin);
    log(`    · configured site serves no municipal content; rediscovering  ${origin}`);
    city.site = null;
    city.configured_site_dead = origin;
  }
  const hosts = arnonaMunicipalHostCandidates(municipalDomainSlugs(city), city.muni_name);
  for (const host of hosts) {
    const home = await get(`https://${host}`, { timeout: 12_000 });
    if (!home.ok || !home.body || !home.url) continue;
    const pageText = home.body.slice(0, 120_000).replace(/<[^>]*>/g, " ");
    // A conventional host is a guess about the address, so the page itself has to
    // earn it. Matching the URL would accept haifa.muni.il's empty IIS placeholder
    // purely because the hostname says "haifa", and never reach www.haifa.muni.il.
    const municipalContent = /עיריית|מועצה\s+(?:מקומית|אזורית)|بلدية|municipality|local council/i
      .test(pageText) || candidateMatchesCity({ url: "", text: pageText }, city);
    if (!municipalContent) continue;
    const origin = new URL(home.url).origin;
    city.site = origin;
    city.site_source = "host_probe";
    log(`    · learned official site  ${origin}`);
    return pagesFor(origin, home.url);
  }

  // Conventional hostnames only cover authorities whose domain matches their
  // latin name. Every other authority previously depended on public web search,
  // which Brave, DuckDuckGo, Bing, Google, Mojeek and Startpage all answer with a
  // bot challenge or 429 from a datacenter IP — so discovery ended as
  // "no verified official site" before a single municipal page was ever read.
  // Wikipedia is not bot-walled and carries the official-website link, so it
  // supplies the missing address. It is a LEAD ONLY: the site still has to
  // identify itself as this authority below, exactly as a search result would.
  city.directory_checked = true;
  const directory = await resolveMunicipalSiteFromDirectory(city, { log });
  if (directory) {
    const home = await get(directory.site, { timeout: 12_000 });
    if (home.ok && home.body && home.url) {
      const pageText = home.body.slice(0, 160_000).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
      const looksMunicipal = /עיריית|מועצה\s+(?:מקומית|אזורית)|بلدية|municipality|local council/i
        .test(pageText);
      if (looksMunicipal && candidateMatchesCity({ url: home.url, text: pageText }, city)) {
        const origin = new URL(home.url).origin;
        city.site = origin;
        city.site_source = directory.source;
        log(`    · learned official site from ${directory.source} "${directory.title}"  ${origin}`);
        return pagesFor(origin, home.url);
      }
      city.directory_site_unusable = `${directory.site} (זהות הרשות לא אומתה)`;
      log(`    · directory site rejected by authority check  ${directory.site}`);
    } else {
      city.directory_site_unusable = `${directory.site} (לא נגיש משרת העבודה)`;
      log(`    · directory site unreachable  ${directory.site}`);
    }
  }
  return [];
}

async function learnMunicipalSiteFromSearch(candidate, city, log) {
  if (isOfficialMunicipalUrl(candidate.url, city)) return true;
  if (!nonStandardHostMatchesCity(candidate.url, city)) return false;
  let origin;
  try { origin = new URL(candidate.url).origin; } catch { return false; }
  const home = await get(origin, { timeout: 12_000 });
  if (!home.ok || !home.body || !home.url) return false;
  const pageText = home.body.slice(0, 160_000).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
  if (!/עיריית|מועצה\s+(?:מקומית|אזורית)|بلدية|municipality|local council/i.test(pageText)) return false;
  if (!candidateMatchesCity({ url: home.url, text: pageText }, city)) return false;
  city.site = new URL(home.url).origin;
  log(`    · learned official site from verified search result  ${city.site}`);
  return isOfficialMunicipalUrl(candidate.url, city);
}

/**
 * A document URL proposed by the live-search agent is a lead, not provenance.
 * Accept it only when it already sits on the authority's official site, or when
 * the host's own home page identifies itself as this authority.
 */
async function verifyMunicipalDocumentOrigin(documentUrl, city, log) {
  if (isOfficialMunicipalUrl(documentUrl, city)) return true;
  if (!nonStandardHostMatchesCity(documentUrl, city)) return false;
  let origin;
  try { origin = new URL(documentUrl).origin; } catch { return false; }
  const home = await get(origin, { timeout: 12_000 });
  if (!home.ok || !home.body || !home.url) return false;
  const pageText = home.body.slice(0, 160_000).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
  if (!/עיריית|מועצה\s+(?:מקומית|אזורית)|بلدية|municipality|local council/i.test(pageText)) return false;
  if (!candidateMatchesCity({ url: "", text: pageText }, city)) return false;
  city.site = new URL(home.url).origin;
  log(`    · verified official site from document host  ${city.site}`);
  return isOfficialMunicipalUrl(documentUrl, city);
}

function isTargetYearCandidate(link, year) {
  // A document URL/title that names a different tax year is never a useful
  // fallback: accepting it would spend an LLM call only to fail the
  // later PDF-year validation. Opaque URLs are retained and validated from the
  // document itself, since many municipal CMSes use numeric upload paths.
  if (!arnonaCandidateUrlMatchesYear(link.url, year)) return false;
  const textYears = String(link.text ?? "").match(YEAR_RE) ?? [];
  return !textYears.length || textYears.includes(String(year));
}

async function searchPublicWeb(city, year, log) {
  // Municipal sites use inconsistent names (עירייה / מועצה / no prefix), so
  // search both the formal name and the city name. The exact year is included
  // in every query and remains independently verified from the downloaded PDF.
  const queries = [
    `\"צו ארנונה\" ${year} \"${city.muni_name}\" filetype:pdf`,
    `\"צו ארנונה\" ${year} \"${city.name}\" filetype:pdf`,
    `${city.name} צו ארנונה ${year} pdf`,
  ];
  const results = [];
  const seen = new Set();
  const providerHealth = new Map();
  const recordProvider = (name, ok) => {
    const health = providerHealth.get(name) ?? { available: 0, unavailable: 0 };
    health[ok ? "available" : "unavailable"] += 1;
    providerHealth.set(name, health);
  };
  for (const query of queries) {
    const providers = [
      // Brave's server-rendered result page is the most reliable current source
      // for Hebrew municipal PDFs. Keep the other two as independent fallbacks.
      { name: "Brave", url: `https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`, headers: {} },
      // The Lite endpoint is server-rendered and has proved more reliable than
      // DuckDuckGo's JS-oriented HTML endpoint for Hebrew municipal searches.
      { name: "DuckDuckGo", url: `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}` },
      { name: "Bing", url: `https://www.bing.com/search?q=${encodeURIComponent(query)}` },
    ];
    for (const provider of providers) {
      const page = await get(provider.url, { headers: provider.headers ?? null });
      if (!page.ok || !page.body) {
        recordProvider(provider.name, false);
        log(`    · ${provider.name} search unavailable${page.status ? ` (${page.status})` : ""}`);
        continue;
      }
      if (!municipalSearchResponseUsable(page.body)) {
        recordProvider(provider.name, false);
        log(`    · ${provider.name} search unavailable (bot challenge)`);
        continue;
      }
      recordProvider(provider.name, true);
      const parsed = linksFromMunicipalHtml(page.body, page.url ?? provider.url)
        .map((link) => ({ ...link, url: unwrapSearchUrl(link.url) }))
        .filter((link) => /^https?:\/\//.test(link.url))
        .filter((link) => candidateMatchesCity(link, city))
        .filter((link) => isTargetYearCandidate(link, year));
      const official = [];
      for (const link of parsed) {
        if (await learnMunicipalSiteFromSearch(link, city, log)) official.push(link);
      }
      const hits = official.map((link) => ({
          ...link,
          score: scoreLink(link.url, link.text, year)
            + (`${link.url} ${link.text}`.includes(city.name) ? 3 : 0),
        }))
        .sort((a, b) => b.score - a.score);
      for (const hit of hits) {
        if (!seen.has(hit.url)) { seen.add(hit.url); results.push(hit); }
      }
      if (hits.length) break; // Bing is a resilience fallback, not extra traffic.
    }
    // Circuit breaker: if every provider was unavailable on this query (the
    // common case from a datacenter IP — Brave 429, DDG/Bing bot challenge),
    // the remaining queries will fail identically. Skip them to save 6 wasted
    // HTTP requests per city.
    const anyAvailable = [...providerHealth.values()].some((h) => h.available > 0);
    if (!anyAvailable) {
      log("    · all public search providers unavailable — skipping remaining queries");
      break;
    }
  }
  return {
    results: results.sort((a, b) => b.score - a.score).slice(0, 12),
    availableProviders: [...providerHealth.entries()]
      .filter(([, health]) => health.available > 0).map(([name]) => name),
    unavailableProviders: [...providerHealth.entries()]
      .filter(([, health]) => health.available === 0 && health.unavailable > 0).map(([name]) => name),
  };
}

async function documentsFromPublicSearchResult(candidate, city, year, log) {
  // Some municipalities rank their Arnona landing page above the PDF. First
  // collect a direct document, then crawl that one official page for year-matched
  // document links. This makes search useful for CMSes with opaque upload URLs.
  const documents = [];
  log(`    · ${candidate.url}`);
  const direct = await tryCandidate(candidate.url, city, year, log);
  if (direct) documents.push(direct);
  if (direct) return documents;
  const pageQueue = [candidate.url];
  const seenPages = new Set();
  let embeddedBudget = 2;
  while (pageQueue.length) {
    const pageUrl = pageQueue.shift();
    if (!pageUrl || seenPages.has(pageUrl)) continue;
    seenPages.add(pageUrl);
    const page = await get(pageUrl);
    if (!page.ok || !page.body) continue;
    const links = linksFromMunicipalHtml(page.body, page.url ?? pageUrl)
      .filter((link) => isOfficialMunicipalUrl(link.url, city) && isTargetYearCandidate(link, year))
      .map((link) => ({ ...link, score: scoreLink(link.url, link.text, year) }))
      .sort((a, b) => b.score - a.score);
    for (const link of links.filter((link) => /\.pdf(?:\?|$)/i.test(link.url)).slice(0, 8)) {
      const hit = await tryCandidate(link.url, city, year, log);
      if (hit) documents.push(hit);
    }
    for (const link of links.filter((link) => link.kind === "embedded" && !/\.pdf/i.test(link.url))) {
      if (embeddedBudget-- <= 0) break;
      pageQueue.push(link.url);
    }
  }
  return documents;
}

// Rung 2: most municipalities keep the same path year over year and only bump the
// digits — so last year's winning URL is the best guess for this year's.
function swapYear(url, fromYear, toYear) {
  if (!url) return null;
  const swapped = url.replace(new RegExp(String(fromYear), "g"), String(toYear));
  return swapped === url ? null : swapped;
}

async function tryCandidate(url, city, year, log, sourceAccessFailures = null) {
  const hit = await fetchArnonaCandidateWithRelay({
    city,
    url,
    year,
    relayUrl: process.env.ARNONA_RELAY_URL || null,
    token: process.env.ARNONA_RELAY_TOKEN || null,
    fetchBinary: get,
    isPdf,
  });
  if (hit?.failure) {
    sourceAccessFailures?.push(hit.failure);
    log(`    ✗ configured official PDF inaccessible (direct: ${hit.failure.directStatus ?? "network"}; relay: ${hit.failure.relayStatus ?? "not configured"})  ${url}`);
    return null;
  }
  if (!hit) return null;
  log(`    ✓ pdf ${Math.round(hit.buf.length / 1024)}KB${hit.relayed ? " via relay" : ""}  ${url}`);
  return { url: hit.url, buf: hit.buf };
}

async function discover(city, year, log) {
  const hadConfiguredSource = Boolean(city.site || city.doc_url_template || city.last_doc_url
    || (city.index_urls ?? []).length);
  const tried = new Set();
  const candidates = new Map();
  const sourceAccessFailures = [];
  // Which tax years this authority was seen publishing at all. A council that
  // stopped in 2022 is a different fact from one whose 2026 order the crawl
  // failed to reach, and only this set can tell them apart.
  const offeredYears = new Set();
  const attempt = async (url, linkText = "") => {
    if (!url || tried.has(url)) return;
    tried.add(url);
    // Municipality index pages commonly expose several annual orders together.
    // A PDF whose own URL names another year must never enter the candidate set,
    // even if its body mentions the requested year in a comparison or footnote.
    if (!isTargetYearCandidate({ url, text: "" }, year)) {
      for (const offered of arnonaCandidateOfferedYears(url, linkText)) offeredYears.add(offered);
      log(`    · skipped different-year document  ${url}`);
      return;
    }
    log(`    · ${url}`);
    const hit = await tryCandidate(url, city, year, log, sourceAccessFailures);
    if (hit) candidates.set(hit.url, hit);
  };

  // 1. explicit template
  if (city.doc_url_template) {
    await attempt(city.doc_url_template.replaceAll("{year}", String(year)));
  }
  // 2. last year's URL, year swapped
  if (city.last_doc_url) {
    await attempt(swapYear(city.last_doc_url, city.last_doc_year ?? year - 1, year));
    if (city.last_doc_year === year) await attempt(city.last_doc_url);
  }
  // 3. crawl the index pages (and one level of arnona-looking sub-pages). A CBS-
  // registered authority with no source config first probes its conventional
  // municipal hostname and the site's own search, then persists the winning site.
  const learnedPages = await discoverMunicipalSite(city, year, log);
  const queuedPages = new Set();
  const seenPages = new Set();
  let officialPagesChecked = 0;
  let officialPagesUnavailable = 0;
  let depth2Budget = 4;
  const crawlOfficialPages = async (startUrls) => {
    const queue = [...startUrls];
    for (const url of queue) queuedPages.add(url);
    while (queue.length) {
      const pageUrl = queue.shift();
      if (!pageUrl || seenPages.has(pageUrl)) continue;
      seenPages.add(pageUrl);
      const page = await get(pageUrl);
      if (!page.ok || !page.body) {
        officialPagesUnavailable += 1;
        continue;
      }
      // Both site-search probes commonly redirect to the home page. Expanding the
      // same page three times spent the whole depth-2 budget on duplicate links,
      // so גוש עציון never expanded its own "צווי מיסים" page — the one holding
      // the order — even though it was queued. Identify a page by where it landed.
      const landedUrl = page.url ?? pageUrl;
      if (landedUrl !== pageUrl && seenPages.has(landedUrl)) continue;
      seenPages.add(landedUrl);
      officialPagesChecked += 1;
      const links = linksFromMunicipalHtml(page.body, page.url ?? pageUrl)
        .map((l) => ({ ...l, score: scoreLink(l.url, l.text, year) }))
        .sort((a, b) => b.score - a.score);
      const pdfThreshold = learnedPages.includes(pageUrl) ? 8 : 6;
      for (const l of links.filter((l) => l.score >= pdfThreshold && /\.pdf/i.test(l.url)).slice(0, 6)) {
        await attempt(l.url, l.text);
      }
      // Follow the most Arnona-shaped in-domain pages one level down even when the
      // landing page already had a PDF: a second link is often the final/full order.
      // An embedded document browser is the archive itself, not a navigation guess,
      // so it is always followed. Both site-search probes and the home page carry the
      // same menu, which used up the whole budget before גוש עציון's "צווי מיסים"
      // page was expanded — and its order lives only inside that page's iframe.
      for (const l of municipalCrawlLinks(links, city.site ?? pageUrl, 2, queuedPages)) {
        if (l.kind !== "embedded" && depth2Budget-- <= 0) continue;
        queue.push(l.url);
        queuedPages.add(l.url);
      }
    }
  };
  await crawlOfficialPages([...(city.index_urls ?? []), ...learnedPages]);
  // 4. LLM live search (optional): run the plain Hebrew search a person would
  // run, through an LLM with web tools (lib/llm.mjs). Every deterministic path
  // above can only find a site whose address is derivable; חורפיש publishes on
  // lch.org.il, which no naming rule or public directory reaches. From a
  // datacenter IP, raw HTTP search engines (Brave, DDG, Bing) all block or
  // challenge, so this is often the only search that works. The answer is a
  // lead: each URL still passes the provenance, authority, year and full-order
  // audits below. Disable with ARNONA_LIVE_RESEARCH=0.
  // A closest-year pass re-runs this discovery for a year the authority is
  // already known to publish, so spending another LLM call asking the web
  // about that year buys nothing the crawl has not already answered.
  let publicSearch = { results: [], availableProviders: [], unavailableProviders: [] };
  if (!candidates.size && !city.skip_live_research && process.env.ARNONA_LIVE_RESEARCH !== "0") {
    const lead = await researchArnonaSource(city, year, { log });
    if (lead) {
      city.research_note = lead.note || null;
      if (!city.site && lead.site) {
        const home = await get(lead.site, { timeout: 12_000 });
        if (home.ok && home.body && home.url) {
          const pageText = home.body.slice(0, 160_000).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
          const looksMunicipal = /עיריית|מועצה\s+(?:מקומית|אזורית)|بلدية|municipality|local council/i
            .test(pageText);
          if (looksMunicipal && candidateMatchesCity({ url: "", text: pageText }, city)) {
            city.site = new URL(home.url).origin;
            city.site_source = "live_search";
            log(`    · learned official site from live search  ${city.site}`);
          } else {
            log(`    · live-search site rejected by authority check  ${lead.site}`);
          }
        }
      }
      for (const documentUrl of lead.documentUrls.slice(0, 3)) {
        if (!(await verifyMunicipalDocumentOrigin(documentUrl, city, log))) {
          log(`    · live-search document rejected: no official provenance  ${documentUrl}`);
          continue;
        }
        await attempt(documentUrl);
      }
      // A site learned here arrived after the crawl had already finished, so
      // חצור הגלילית reported "no verified official site" in the same run that
      // had just identified hatzorg.co.il. The whole point of the last resort is
      // the address it recovers, so crawl the site it found before giving up.
      if (shouldCrawlRecoveredOfficialSite({
        candidateCount: candidates.size, site: city.site, siteSource: city.site_source,
      })) {
        log(`    · crawling the official site the live search recovered  ${city.site}`);
        await crawlOfficialPages(await discoverMunicipalSite(city, year, log));
      }
    }
  }
  // 5. Public web search fallback: entirely HTTP based, so it never spends
  // any LLM call. From a datacenter IP these engines usually block or challenge,
  // but from a home connection they often work.
  // Search results are only leads; we accept a PDF from an official municipal
  // domain (directly or linked by one result page), and extraction/year
  // validation is the final gate.
  if (!candidates.size) {
    log("    · public web search (no model/API tokens)…");
    publicSearch = await searchPublicWeb(city, year, log);
    for (const candidate of publicSearch.results.slice(0, 8)) {
      for (const hit of await documentsFromPublicSearchResult(candidate, city, year, log)) {
        candidates.set(hit.url, hit);
      }
    }
  }

  if (!candidates.size) {
    const miss = classifyArnonaDiscoveryMiss({
      hadConfiguredSource: hadConfiguredSource || Boolean(city.site),
      officialPagesChecked,
      officialPagesUnavailable,
      availableSearchProviders: publicSearch.availableProviders,
      unavailableSearchProviders: publicSearch.unavailableProviders,
      configuredSourceAccessFailure: sourceAccessFailures.at(-1) ?? null,
      directoryChecked: Boolean(city.directory_checked),
      directorySiteUnusable: city.directory_site_unusable ?? null,
    });
    log(`    · ${miss.error}`);
    return { missing: true, ...miss, offeredYears: [...offeredYears] };
  }

  // Never accept the first downloadable PDF. Inspect every same-year candidate and
  // choose the complete rate book: exact year + both core use sections + real rates.
  const inspected = [];
  for (const candidate of candidates.values()) {
    try {
      let pages = await pdfPages(candidate.buf);
      let ocr = false;
      // An undecodable municipal URL must not abort the whole authority.
      let decodedUrl = String(candidate.url ?? "");
      try { decodedUrl = decodeURIComponent(decodedUrl); } catch { /* keep the raw URL */ }
      const clearlyIrrelevantName = arnonaCandidateUrlIsClearlyNotOrder(candidate.url);
      const needsOcr = pages.join("").length < pages.length * 80 || !pages.some(hasRates);
      if (needsOcr && clearlyIrrelevantName) {
        log(`    · skipped OCR for clearly unrelated document  ${candidate.url}`);
      } else if (needsOcr) {
        log(`    · no usable text layer; running local Hebrew OCR  ${candidate.url}`);
        const ocrPages = ocrPdfPages(candidate.buf);
        if (ocrPages.length) { pages = ocrPages; ocr = true; }
      } else if (!clearlyIrrelevantName && !arnonaOrderHeaderIsPresent(pages)) {
        // Some scanned orders carry a garbage text layer (font-mapped digits, no
        // Hebrew words): it passes the "has text" test, yet the printed title is
        // missing. בענה's 2026 order was rejected that way although its scan
        // reads "צו הארנונה לשנת 2026". Read the scan before calling it headerless.
        const ocrPages = ocrPdfPages(candidate.buf);
        if (ocrPages.length && arnonaOrderHeaderIsPresent(ocrPages)) {
          log(`    · text layer lacks the order title; using local OCR  ${candidate.url}`);
          pages = ocrPages;
          ocr = true;
        }
      }
      const text = pages.join("\n");
      const years = text.match(YEAR_RE) ?? [];
      // Identity comes from the document OR from where it was published. Judea &
      // Samaria regional councils issue orders headed only "תקנון המועצות
      // האזוריות (יהודה ושומרון)", never naming the authority: גוש עציון's real
      // signed 2026 order was rejected as a foreign document for that reason.
      // Serving it from the authority's own verified official site is equally
      // strong provenance, and the cross-city guard still protects every document
      // reached through search, a CDN, or an unverified host.
      const publishedByTheAuthority = Boolean(city.site)
        && isOfficialMunicipalUrl(candidate.url, city);
      const documentNamesCity = documentMatchesCity(pages, city);
      const hasCityIdentity = documentNamesCity || publishedByTheAuthority;
      if (!documentNamesCity && publishedByTheAuthority) {
        log(`    · identity from the authority's own site, not the document text  ${candidate.url}`);
      }
      const hasOrderHeader = arnonaOrderHeaderIsPresent(pages);
      const orderYear = arnonaOrderYearFromHeader(pages);
      const hasResidential = /מגורים/.test(text);
      const hasNonResidential = /משרדים|מסחר|חנויות/.test(text);
      const ratePages = pages.filter(hasRates).length;
      const partialName = /cleaned|טיוט|draft|הנח|פטור|בקשה|חריג|תיקון|נספח/i.test(decodedUrl);
      const inspection = {
        ...candidate,
        pages,
        ocr,
        documentYears: years,
        hasCityIdentity,
        hasOrderHeader,
        orderYear,
        hasResidential,
        hasNonResidential,
        ratePages,
      };
      const valid = isVerifiedArnonaOrderCandidate(inspection, year);
      // A municipal CMS that serves opaque upload paths hides the year until the
      // document is read. Its own header is the strongest evidence of which
      // years this authority actually published.
      if (!valid && hasCityIdentity && hasOrderHeader && Number.isInteger(orderYear)
          && orderYear !== year) {
        offeredYears.add(orderYear);
      }
      const score = (arnonaCandidateUrlHasOrderName(candidate.url) ? 2_000_000 : 0)
        + Math.min(pages.length, 50) * 10_000 + text.length
        + Math.min(ratePages, 50) * 1_000 - (partialName ? 500_000 : 0);
      inspected.push({ ...inspection, valid, score });
      log(`    ${valid ? "✓" : "✗"} inspected ${pages.length}p/${ratePages} rate pages`
        + `${!arnonaCandidateUrlMatchesYear(candidate.url, year) ? " [wrong year in filename]" : ""}`
        + `${!years.includes(String(year)) ? " [requested year absent]" : ""}`
        + `${!hasCityIdentity ? " [wrong authority]" : ""}`
        + `${!hasOrderHeader ? " [no legal-order header]" : ""}`
        + `${orderYear !== year ? ` [order header year ${orderYear ?? "unknown"}]` : ""}`
        + `${clearlyIrrelevantName ? " [non-order filename]" : ""}`
        + `${partialName ? " [partial/draft filename]" : ""}  ${candidate.url}`);
    } catch (e) {
      log(`    ✗ unreadable candidate: ${e?.message ?? e}  ${candidate.url}`);
    }
  }
  const best = selectBestVerifiedArnonaOrderCandidate(inspected, year);
  if (!best) {
    log("    · PDFs were found, but none passed full-order validation");
    return {
      invalid: true,
      error: "נמצאו מסמכים אך אף אחד מהם אינו צו מלא ומאומת לשנה המבוקשת",
      offeredYears: [...offeredYears],
    };
  }
  return {
    url: best.url,
    buf: best.buf,
    pages: best.pages,
    ocr: Boolean(best.ocr),
    via: "audited-candidates",
    sourceYear: year,
    offeredYears: [...offeredYears],
  };
}

const discovered = (result) => Boolean(result) && !result.invalid && !result.missing;

async function discoverRequestedOrConfiguredYear(city, requestedYear, log) {
  const exact = await discover(city, requestedYear, log);
  if (discovered(exact)) return exact;

  const triedYears = [];
  let failure = exact;
  const configuredYear = Number(city.last_doc_year);
  if (city.last_doc_url && Number.isInteger(configuredYear) && configuredYear !== requestedYear) {
    log(`    · no verified ${requestedYear} order; validating configured closest official year ${configuredYear}`);
    const fallback = await discover({
      ...city,
      // The configured last_doc_url is the reusable control. Discovery still
      // audits the official site's own search, but cannot invent a template from a
      // different requested year.
      doc_url_template: null,
      skip_live_research: true,
    }, configuredYear, log);
    if (discovered(fallback)) {
      return {
        ...fallback,
        sourceYear: configuredYear,
        requestedYear,
        via: `${fallback.via}+closest-year-fallback`,
      };
    }
    log(`    · configured ${configuredYear} order also failed full-order validation`);
    triedYears.push(configuredYear);
    failure = selectArnonaRequestedOrFallbackFailure(exact, fallback);
  }

  // Some authorities simply stopped publishing: חורפיש's official site holds
  // 2019–2022 and nothing since. An older complete order is still the real rate
  // book — better than reporting no source at all — as long as its own year is
  // what gets stored and shown, so fall back to the nearest year the authority
  // was actually seen publishing.
  const offered = [...new Set([...(exact?.offeredYears ?? []), ...(failure?.offeredYears ?? [])])];
  for (const publishedYear of arnonaFallbackYearOrder(offered, requestedYear, { exclude: triedYears })) {
    log(`    · no verified ${requestedYear} order; validating the ${publishedYear} order this authority did publish`);
    const older = await discover({
      ...city, doc_url_template: null, skip_live_research: true,
    }, publishedYear, log);
    if (discovered(older)) {
      return {
        ...older,
        sourceYear: publishedYear,
        requestedYear,
        via: `${older.via}+published-year-fallback`,
      };
    }
    log(`    · the ${publishedYear} order also failed full-order validation`);
  }

  // "No order found" and "this authority last published in 2022" are different
  // facts, and only the second tells the maintainer there is nothing left to fix.
  const publishedYearNote = describeArnonaPublishedYears(offered, requestedYear);
  return failure?.error && publishedYearNote
    ? { ...failure, error: `${failure.error}${publishedYearNote}` }
    : failure;
}

// ── pdf → layout-aware text ──────────────────────────────────────────────────
// A naive getTextContent() join scrambles Hebrew tables: items come in paint order,
// so a rate can land three lines from its classification. Grouping by baseline and
// sorting right-to-left reproduces the printed row, which is what makes a cheap
// model able to read the tables at all.

async function pdfPages(buf) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent();
    const rows = new Map();
    for (const it of content.items) {
      if (!it.str?.trim()) continue;
      const y = Math.round(it.transform[5] / 3) * 3;   // 3pt baseline buckets
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push({ x: it.transform[4], s: it.str });
    }
    pages.push([...rows.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([, cells]) => cells.sort((a, b) => b.x - a.x).map((c) => c.s).join(" ")
        .replace(/\s+/g, " ").trim())
      .filter(Boolean).join("\n"));
  }
  return pages;
}

function ocrPdfPages(buf) {
  const work = mkdtempSync(join(tmpdir(), "arnona-ocr-"));
  try {
    const input = join(work, "order.pdf");
    const prefix = join(work, "page");
    writeFileSync(input, buf);
    const render = spawnSync("pdftoppm", ["-jpeg", "-r", "220", input, prefix], {
      encoding: "utf8", timeout: 5 * 60_000, maxBuffer: 10 * 1024 * 1024,
    });
    if (render.error || render.status !== 0) return [];
    const images = readdirSync(work).filter((name) => /^page-\d+\.jpg$/i.test(name))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const pages = [];
    for (const image of images) {
      const ocr = spawnSync("tesseract", [join(work, image), "stdout", "-l", "heb+ara+eng", "--psm", "6"], {
        encoding: "utf8", timeout: 2 * 60_000, maxBuffer: 20 * 1024 * 1024,
      });
      if (ocr.error || ocr.status !== 0) return [];
      pages.push(String(ocr.stdout ?? "").replace(/\r/g, "").trim());
    }
    return pages;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Render chosen 1-based pages to PNG files in a fresh temp dir (caller removes it). */
function renderPdfPageImages(buf, pageNumbers, dpi = 150) {
  const work = mkdtempSync(join(tmpdir(), "arnona-pages-"));
  const input = join(work, "order.pdf");
  writeFileSync(input, buf);
  const files = [];
  for (const page of pageNumbers) {
    const prefix = join(work, `page-${String(page).padStart(3, "0")}`);
    const render = spawnSync("pdftoppm", [
      "-png", "-r", String(dpi), "-f", String(page), "-l", String(page), "-singlefile", input, prefix,
    ], { encoding: "utf8", timeout: 2 * 60_000 });
    if (!render.error && render.status === 0) files.push({ page, file: `${prefix}.png` });
  }
  return { work, files };
}

const MAX_WHOLE_SCAN_PAGES = 24;

// A page with a tariff table always prints money: 121.34 / 1,642.06 / 80.64.
const hasRates = (text) => /\d[\d,]*\.\d{2}/.test(text);

// Keep each LLM task comfortably small. Long
// 12–15k-character table chunks produced valid work but occasionally timed out before
// returning their large JSON payload; smaller chunks retry independently and cheaply.
function chunkPages(pages, limit = 4_500, rateLimit = 45) {
  const chunks = [];
  let cur = [], curLen = 0, curRates = 0;
  pages.forEach((text, i) => {
    if (!hasRates(text)) return;
    const block = `\n=== עמוד ${i + 1} ===\n${text}`;
    const blockRates = text.match(/\d[\d,]*\.\d{2}/g)?.length ?? 0;
    if ((curLen + block.length > limit || curRates + blockRates > rateLimit) && cur.length) {
      chunks.push(cur.join("")); cur = []; curLen = 0; curRates = 0;
    }
    cur.push(block); curLen += block.length; curRates += blockRates;
  });
  if (cur.length) chunks.push(cur.join(""));
  return chunks;
}

// ── extraction ───────────────────────────────────────────────────────────────

const ROW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["doc_year", "rows"],
  properties: {
    doc_year: {
      anyOf: [{ type: "integer" }, { type: "null" }],
      description: "The tax year this excerpt states it applies to, if printed. Else null.",
    },
    rows: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["category_key", "category_label", "code", "zone", "building_type",
          "size_from", "size_to", "rate_per_sqm", "notes", "confidence"],
        properties: {
          category_key: { type: "string", enum: CATEGORIES },
          category_label: { type: "string", description: "The classification verbatim in Hebrew" },
          code: { anyOf: [{ type: "string" }, { type: "null" }], description: "סמל / classification number" },
          zone: {
            anyOf: [{ type: "string" }, { type: "null" }],
            description: "אזור exactly as printed ('1', '3', '4 ו-5', 'א'). null = all zones",
          },
          building_type: {
            anyOf: [{ type: "string" }, { type: "null" }],
            description: "סוג בנין as printed ('אא', 'ב+ג'). null when the table has no such axis",
          },
          size_from: { anyOf: [{ type: "number" }, { type: "null" }], description: "Band start m², null = from 0" },
          size_to: { anyOf: [{ type: "number" }, { type: "null" }], description: "Band end m², null = unbounded" },
          rate_per_sqm: { type: "number", description: "₪ per m² per YEAR, exactly as printed" },
          notes: { anyOf: [{ type: "string" }, { type: "null" }] },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
        },
      },
    },
  },
};

const SYSTEM = `You read Israeli municipal "צו ארנונה" documents and return their tariff tables as data.

The text you receive was extracted from a PDF with right-to-left layout reconstruction. Words inside a line may read oddly, numbers are reliable, and a table row is one line.

Rules:
- Emit ONE row per PRINTED RATE. A classification charged at three zone rates is three rows; a classification with "עד 140 מ\\"ר" / "מעל 140 מ\\"ר" bands is two rows.
- MATRIX TABLES APPLY TO EVERY USE, not only residential. Petah Tikva, for example, prints office, shop, event-hall and storage tables whose one axis is סוג בנין א/ב/ג and whose other axis is אזור א/ב/ג plus area bands. EVERY CELL IS ITS OWN ROW: take building_type and zone from their printed row/column headings, even when RTL extraction visually reverses the axes. Count every rate in the grid and emit one row per rate. Never collapse a grid onto one axis, never discard a second/third rate column, and never let a building class end up in the zone field.
- rate_per_sqm is ANNUAL ₪ per m², copied exactly as printed (2 decimals). Never convert, average, or round. If a figure is a bi-monthly or total charge rather than ₪ per m² per year, skip it.
- zone: exactly as the table prints it — "1", "3", "4 ו-5", "א", "ב". null when the rate applies to all zones ("בכל האזורים").
- building_type: the printed סוג בנין axis of any matrix table, verbatim. null only when the table genuinely has no building-type axis.
- size_from/size_to in m². "עד 500 מ\\"ר" → from null, to 500. "מעל 500 מ\\"ר ואילך" → from 500, to null.
- category_key maps the Hebrew classification onto a fixed vocabulary:
  residential=מגורים · office=משרדים/שירותים/בנקים/היי-טק · commerce=מסחר/חנויות/מסעדות
  industry=תעשייה · workshop=מלאכה · storage=מחסנים/אחסנה · parking=חניונים
  hotel=בתי מלון · land=קרקע תפוסה · farm=אדמה חקלאית · public=מוסדות/בתי ספר/בריאות
  other=anything that fits none of the above.
- category_label keeps the municipality's own wording, verbatim.
- Ignore everything that is not a rate: discounts (הנחות), exemptions, payment dates, appeal procedures, definitions, minimum/maximum charge rules.
- Ignore tariff tables issued BY local village committees (headed e.g. "תעריפי ארנונה - ועדים מקומיים") that some regional councils print after their own order: those are a separate committee levy. Keep the council's own rates even when they differ by whether a settlement has a local committee ("ישוב עם ועד מקומי").
- Do not infer, complete, or carry over rates between sections. If a section states no number, it produces no row.
- confidence: "high" when classification, zone, band and rate are unambiguous on the line; "medium" when you had to associate across lines; "low" when the layout is genuinely unclear.
- No tariffs in the excerpt → {"doc_year": …, "rows": []}.

Return JSON only.`;

const SYSTEM_SCANNED = SYSTEM.replace(
  "The text you receive was extracted from a PDF with right-to-left layout reconstruction. Words inside a line may read oddly, numbers are reliable, and a table row is one line.",
  "You receive an IMAGE of one scanned page. Read Hebrew right-to-left. Read every digit carefully from the image; when a printed figure is genuinely illegible, skip that row rather than guess, and use confidence \"medium\" for rows you read from a faint or skewed scan.",
);

let llmBackend = null;
let tokensIn = 0;
let tokensOut = 0;

async function extractChunk(city, year, chunk, index, total) {
  const prompt = `עיר: ${city.name} (${city.muni_name}). שנת המס המבוקשת: ${year}.\n`
    + `קטע ${index + 1} מתוך ${total} מתוך צו הארנונה.\n\n${chunk}\n\n`
    + `Return ONLY valid JSON matching this schema:\n${JSON.stringify(ROW_SCHEMA)}`;
  const modelId = llmBackend === "anthropic"
    ? process.env.ARNONA_MODEL || "default"
    : process.env[`ARNONA_${llmBackend.toUpperCase()}_MODEL`] || "default";
  const cacheKey = createHash("sha256")
    .update(`${llmBackend}\0${modelId}\0${SYSTEM}\0${prompt}`).digest("hex");
  const cacheFile = join(CACHE_DIR, "extract", `${cacheKey}.json`);
  try {
    return JSON.parse(readFileSync(cacheFile, "utf8"));
  } catch { /* cache miss or truncated cache */ }

  const answer = await runLlmText({
    system: SYSTEM, prompt, schema: ROW_SCHEMA, maxTokens: 24_000, backend: llmBackend,
  });
  tokensIn += (answer.usage?.input_tokens ?? 0) + (answer.usage?.cache_read_input_tokens ?? 0);
  tokensOut += answer.usage?.output_tokens ?? 0;
  const parsed = parseJsonAnswer(answer.text);
  if (!parsed || !Array.isArray(parsed.rows)) throw new Error("model answer has no rows array");
  mkdirSync(join(CACHE_DIR, "extract"), { recursive: true });
  writeFileSync(cacheFile, JSON.stringify(parsed));
  return parsed;
}

// Scanned orders: local OCR is good enough to find and identify the order, but it
// garbles table digits (בענה 2026: "75.14" → "|75.14", "1.000", "וי"). Rates are
// therefore read by the model from the page images themselves, one page per task.
async function extractScannedPage(city, year, image, pageNumber, totalPages) {
  const prompt = `עיר: ${city.name} (${city.muni_name}). שנת המס המבוקשת: ${year}.\n`
    + `The attached image is page ${pageNumber} of ${totalPages} of a scanned צו ארנונה. `
    + `Read the tariff table(s) on it directly from the image; there is no text layer.\n\n`
    + `Return ONLY valid JSON matching this schema:\n${JSON.stringify(ROW_SCHEMA)}`;
  const modelId = llmBackend === "anthropic"
    ? process.env.ARNONA_MODEL || "default"
    : process.env[`ARNONA_${llmBackend.toUpperCase()}_MODEL`] || "default";
  const cacheKey = createHash("sha256")
    .update(`${llmBackend}\0${modelId}\0${SYSTEM_SCANNED}\0${prompt}\0`)
    .update(readFileSync(image)).digest("hex");
  const cacheFile = join(CACHE_DIR, "extract", `${cacheKey}.json`);
  try {
    return JSON.parse(readFileSync(cacheFile, "utf8"));
  } catch { /* cache miss */ }
  const answer = await runLlmText({
    system: SYSTEM_SCANNED, prompt, schema: ROW_SCHEMA, maxTokens: 24_000, backend: llmBackend,
    images: [image],
  });
  tokensIn += (answer.usage?.input_tokens ?? 0) + (answer.usage?.cache_read_input_tokens ?? 0);
  tokensOut += answer.usage?.output_tokens ?? 0;
  const parsed = parseJsonAnswer(answer.text);
  if (!parsed || !Array.isArray(parsed.rows)) throw new Error("model answer has no rows array");
  mkdirSync(join(CACHE_DIR, "extract"), { recursive: true });
  writeFileSync(cacheFile, JSON.stringify(parsed));
  return parsed;
}

// ── validation ───────────────────────────────────────────────────────────────
// Two tiers. Document-level failures reject the whole extraction (nothing is
// written); row-level failures are stored with needs_review + review_reason so a
// human sees them instead of the whole year silently going missing.

function validate(rows, docYears, year, priorRows, cityKey = null, verified = null) {
  const fatal = [];
  const clean = [];
  const seen = new Set();

  for (const r of rows) {
    const key = [r.category_label, r.zone ?? "", r.building_type ?? "", r.code ?? "",
      r.size_from ?? "", r.size_to ?? ""].join("|");
    if (seen.has(key)) continue;                       // same row from an overlapping chunk
    seen.add(key);
    if (!Number.isFinite(r.rate_per_sqm) || r.rate_per_sqm <= 0) continue;
    if (!CATEGORIES.includes(r.category_key)) r.category_key = "other";

    const [lo, hi] = BANDS[r.category_key];
    const reasons = [];
    if (r.rate_per_sqm < lo || r.rate_per_sqm > hi) {
      reasons.push(`תעריף ${r.rate_per_sqm} מחוץ לטווח הסביר ל-${r.category_key} (${lo}–${hi})`);
    }
    if (r.size_from != null && r.size_to != null && r.size_from >= r.size_to) {
      reasons.push("טווח שטח הפוך");
    }
    const prior = priorRows.find((p) => p.category_label === r.category_label
      && (p.zone ?? "") === (r.zone ?? "") && (p.building_type ?? "") === (r.building_type ?? "")
      && Number(p.size_from ?? -1) === Number(r.size_from ?? -1));
    if (prior) {
      const delta = (r.rate_per_sqm - Number(prior.rate_per_sqm)) / Number(prior.rate_per_sqm);
      // A real צו moves by the Interior Ministry's index (~1.6%) plus any approved
      // exception (a few %). ±25% is a data error, not a policy change.
      if (Math.abs(delta) > 0.25) {
        reasons.push(`שינוי של ${(delta * 100).toFixed(0)}% מול ${prior.year} (${prior.rate_per_sqm})`);
      }
    }
    clean.push({ ...r, needs_review: reasons.length > 0, review_reason: reasons.join("; ") || null });
  }

  // document-level gates
  const years = docYears.filter(Boolean);
  // A verified source's year was checked by a person; a body that misprints it
  // (עמק הירדן 2026 says "לשנת 2025") must not veto the recorded verification.
  if (!verified && years.length && !years.includes(year)) {
    fatal.push(`המסמך מדבר על ${[...new Set(years)].join("/")} ולא על ${year}`);
  }
  if (clean.length < 3) fatal.push(`רק ${clean.length} תעריפים נחלצו`);
  // A band that ends before it starts is a misread table, not a policy: the data
  // gate (scripts/validate-data.mjs) refuses it, so never write such a year.
  const inverted = clean.filter((r) => r.size_from != null && r.size_to != null && r.size_to < r.size_from);
  if (inverted.length) {
    fatal.push(`${inverted.length} טווחי שטח הפוכים (${inverted[0].category_label}: ${inverted[0].size_from}–${inverted[0].size_to})`);
  }
  const cats = new Set(clean.map((r) => r.category_key));
  // Industrial councils (נאות חובב, מגדל תפן) have no homes and print no residential rate.
  if (!cats.has("residential") && !verified?.no_residential) fatal.push("לא נמצא תעריף מגורים");
  if (!cats.has("office") && !cats.has("commerce")) fatal.push("לא נמצא תעריף משרדים/מסחר");
  // A recurring RTL failure mode is to return only the first numeric column of a
  // non-residential matrix. These Petah Tikva sections legally require a building
  // type axis; reject a collapsed extraction before it can replace reviewed rows.
  if (cityKey === "petah-tikva") {
    const matrixRequirements = [
      [/^משרדים שאינם באזורי תעשייה/u, 2],
      [/^משרדים באזורי תעשייה/u, 3],
      [/^חנויות, מרכולים/u, 3],
      [/^אולמות לשמחות ולנשפים/u, 3],
      [/^מחסנים, למעט מחסני שיווק/u, 3],
      [/^מחסני שיווק$/u, 3],
    ];
    for (const [labelPattern, minimumTypes] of matrixRequirements) {
      const matching = clean.filter((row) => labelPattern.test(row.category_label));
      if (!matching.length) continue;
      const types = new Set(matching.map((row) => String(row.building_type ?? "")
        .replace(/^סוג\s*/u, "").trim()).filter(Boolean));
      if (types.size < minimumTypes) {
        fatal.push(`${matching[0].category_label}: ציר סוג בנין קרס (${types.size}/${minimumTypes})`);
      }
    }
  }
  const flagged = clean.filter((r) => r.needs_review).length;
  if (clean.length && flagged / clean.length > 0.35) {
    fatal.push(`${flagged}/${clean.length} תעריפים חשודים`);
  }
  return { fatal, rows: clean, flagged };
}


// ── per-city run ─────────────────────────────────────────────────────────────

const TRANSIENT_LLM_ERROR = /timed out|empty text|exited|HTTP 5\d\d|API 5\d\d|API 429|overloaded|ECONNRESET|fetch failed/iu;

// ── verified sources ─────────────────────────────────────────────────────────
// Discovery is heuristic: it must reject drafts, appendices, other cities and
// other years without a human. Some official orders defeat those heuristics —
// a title like "הוראה בדבר ארנונה", a body that misprints the year, a broken
// Hebrew font ("ð" for נ), a file only listed inside a JavaScript file browser,
// an order published as web pages, or an industrial council with no homes and
// so no residential rate. Once a person (or a research agent whose evidence is
// recorded) has verified the document, registry.verified_source pins it:
//   { url, year, extra_urls?, format?, no_residential?, evidence }
// Extraction and every rate-level check still run; only discovery and the
// document-identity gates are replaced by the recorded verification.

function hostVariants(url) {
  const out = [url];
  try {
    const u = new URL(url);
    const alt = new URL(url);
    alt.hostname = u.hostname.startsWith("www.") ? u.hostname.slice(4) : `www.${u.hostname}`;
    out.push(alt.href);
    for (const v of [...out]) {
      if (v.startsWith("https:")) out.push(`http:${v.slice(6)}`);
    }
  } catch { /* keep the original only */ }
  return [...new Set(out)];
}

/**
 * Download, retrying the www/bare host and http (some municipal CDNs block one),
 * then the optional relay: several municipal firewalls challenge whole networks.
 */
async function fetchVerified(url, binary, city) {
  let last = null;
  for (const candidate of hostVariants(url)) {
    const res = await get(candidate, { binary, timeout: 90_000 });
    if (res.ok && !/abuse\.spd\.co\.il/.test(res.url ?? "")) return res;
    last = res;
  }
  const relay = arnonaSourceRelayRequest({
    city, url, year: city?.verified_source?.year,
    relayUrl: process.env.ARNONA_RELAY_URL || null, token: process.env.ARNONA_RELAY_TOKEN || null,
  });
  if (relay) {
    const res = await get(relay.url, { binary, timeout: 90_000, headers: relay.headers });
    if (res.ok) return { ...res, url };
    last = { status: `relay ${res.status ?? res.error}` };
  }
  // The Internet Archive's latest capture of the exact same official file
  // (`id_` = original bytes, no Wayback toolbar). Brenner's 2026 order is
  // reachable only this way once its host started challenging every client.
  if (binary) {
    const archived = await get(`https://web.archive.org/web/2026id_/${url}`, { binary, timeout: 120_000 });
    if (isPdf(archived)) return { ...archived, url };
  }
  throw new Error(`download failed: ${last?.status ?? last?.error ?? "blocked"} ${url}`);
}

function htmlToText(html) {
  return String(html)
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|tr|li|h[1-6]|table|section)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

// A copy saved by hand when every network path is challenged (Cloudflare's
// "verify you are human" check cannot and should not be automated). Gitignored:
// the official URL stays the published source_url.
const LOCAL_SOURCES_DIR = join(SCRAPER_DIR, "state", "sources");
function localVerifiedCopy(city) {
  for (const ext of ["pdf", "html", "docx"]) {
    const file = join(LOCAL_SOURCES_DIR, `${city.key}.${ext}`);
    let buf;
    try {
      buf = readFileSync(file);
    } catch {
      continue;
    }
    // A Word order (אפרת publishes .docx) is read as its paragraphs and table cells.
    if (ext === "docx") return { file, ext: "html", buf: Buffer.from(docxToHtml(buf)) };
    return { file, ext, buf };
  }
  return null;
}

function docxToHtml(buf) {
  const xml = strFromU8(unzipSync(new Uint8Array(buf))["word/document.xml"] ?? new Uint8Array());
  return xml
    .replace(/<w:tab\/>/g, " ")
    .replace(/<\/w:tc>/g, "</td>")
    .replace(/<\/w:tr>/g, "</tr>")
    .replace(/<\/w:p>/g, "</p>")
    .replace(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g, "$1")
    .replace(/<w:[^>]+>/g, "");
}

async function loadVerifiedSource(city, log) {
  const vs = city.verified_source;
  const local = localVerifiedCopy(city);
  if (local) log(`  using the hand-saved copy ${local.file}`);
  const urls = [vs.url, ...(vs.extra_urls ?? [])].filter(Boolean);
  if (vs.format === "html") {
    const pages = [];
    // A hand-saved HTML copy holds every chapter, so it replaces all the URLs.
    for (const url of local?.ext === "html" ? [] : urls) {
      const res = await fetchVerified(url, false, city);
      const text = htmlToText(res.body);
      // Keep pages near the extraction chunk size so each LLM task stays small.
      for (let i = 0; i < text.length; i += 4_000) pages.push(text.slice(i, i + 4_000));
    }
    if (local?.ext === "html") {
      pages.push(...htmlToText(local.buf.toString("utf8")).match(/[\s\S]{1,4000}/g) ?? []);
    }
    log(`  verified HTML order: ${urls.length} page(s), ${pages.length} text blocks`);
    return { url: vs.url, buf: null, pages, ocr: false, via: "verified-source", sourceYear: vs.year };
  }
  const res = local?.ext === "pdf"
    ? { ok: true, type: "application/pdf", buf: local.buf, url: vs.url }
    : await fetchVerified(vs.url, true, city);
  if (!isPdf(res)) throw new Error(`verified source is not a PDF: ${vs.url}`);
  let pages = await pdfPages(res.buf);
  const text = pages.join("\n");
  // Use the text layer only when it is real Hebrew with rates; otherwise read the scan.
  const usableText = /ארנונה|מגורים|משרדים|מסחר/.test(text) && pages.some(hasRates)
    && text.length >= pages.length * 80;
  let ocr = false;
  if (!usableText) {
    const ocrPages = ocrPdfPages(res.buf);
    ocr = true;
    // OCR only decides which pages hold tables; the model reads the images.
    pages = ocrPages.length && ocrPages.some(hasRates)
      ? ocrPages
      : pages.map((page) => page || "0.00");
    if (!pages.some(hasRates)) pages = pages.map(() => "0.00");
  }
  // verified_source.pages restricts a compilation to the order's own pages
  // (שבלי-אום אל-גנם publishes its 2021–2024 rate letters in one PDF; only page 6 is 2024).
  const onlyPages = Array.isArray(vs.pages) && vs.pages.length ? vs.pages : null;
  if (onlyPages) pages = pages.map((text, i) => (onlyPages.includes(i + 1) ? text : ""));
  log(`  verified ${ocr ? "scanned " : ""}order: ${pages.length} pages${onlyPages ? ` (reading ${onlyPages.join(", ")})` : ""}`);
  return { url: vs.url, buf: res.buf, pages, ocr, onlyPages, via: "verified-source", sourceYear: vs.year };
}

async function scrapeCity(city, year) {
  const log = (s) => { if (!QUIET) console.log(s); };
  const run = {
    city_key: city.key, year, source_year: year, status: "skipped", doc_url: null, backend: null,
    rows: 0, flagged: 0, error: null,
  };
  log(`\n▸ ${city.name} (${city.key}) — ${year}`);

  // already have it? A stored year with flagged rows keeps healing automatically;
  // a clean stored year is skipped unless --force. --discover-only writes nothing,
  // so it always re-runs discovery.
  const REDISCOVER = FORCE || DISCOVER_ONLY;
  let existingRows = store.readTariffs(city.key, year);
  let flaggedExisting = existingRows.filter((row) => row.needs_review).length;
  if (existingRows.length && !flaggedExisting && !REDISCOVER) {
    log(`  already have ${existingRows.length} reviewed tariffs — skipping (--force to re-scrape)`);
    return { ...run, status: "skipped", rows: existingRows.length, skipped: true };
  }
  if (existingRows.length && flaggedExisting && !REDISCOVER) {
    log(`  retrying automatically — ${flaggedExisting}/${existingRows.length} stored tariffs still need review`);
  }

  // 1. find the document
  let doc;
  if (city.verified_source?.url) {
    log(`  using verified source (${city.verified_source.year}): ${city.verified_source.url}`);
    try {
      doc = await loadVerifiedSource(city, log);
    } catch (e) {
      log(`  ✗ ${e?.message ?? e}`);
      return { ...run, status: "download_failed", error: e?.message ?? String(e) };
    }
  } else {
    log("  discovering צו…");
    doc = await discoverRequestedOrConfiguredYear(city, year, log);
  }
  // An official site identified during a failed run is still hard-won, so keep it:
  // the next attempt then starts from the municipality's own search/archive.
  const persistLearnedSite = () => {
    if (DRY || !city.site || !city.site_source) return;
    store.patchRegistryCity(city.key, { site: city.site });
    log(`  · saved the learned official site for future runs  ${city.site}`);
  };
  if (!doc || doc.missing) {
    const status = doc?.status ?? "discovery_failed";
    const error = doc?.error ?? "גילוי המקור לא הושלם: לא התקבלה תוצאת גילוי מתועדת";
    persistLearnedSite();
    log(`  ✗ ${error}`);
    return { ...run, status, error };
  }
  if (doc.invalid) {
    persistLearnedSite();
    log(`  ✗ ${doc.error}`);
    return { ...run, status: "validation_failed", error: doc.error };
  }
  run.doc_url = doc.url;
  const sourceYear = Number(doc.sourceYear) || year;
  run.source_year = sourceYear;
  log(`  document (${doc.via}): ${doc.url}`);
  if (sourceYear !== year) {
    log(`  ⚠ requested ${year}; storing the official ${sourceYear} order under its own year `
      + `(${sourceYear}) — consumers should quote it as the closest available year for ${year}`);
    existingRows = store.readTariffs(city.key, sourceYear);
    flaggedExisting = existingRows.filter((row) => row.needs_review).length;
    if (existingRows.length && !flaggedExisting && !REDISCOVER) {
      log(`  already have ${existingRows.length} reviewed ${sourceYear} tariffs — recording explicit fallback`);
      return { ...run, status: "ok", rows: existingRows.length, fallback: true };
    }
  }
  if (DISCOVER_ONLY) {
    return {
      ...run, status: "ok", doc_url: doc.url, source_year: sourceYear,
      discoverOnly: true, fallback: sourceYear !== year,
    };
  }
  mkdirSync(join(CACHE_DIR, "pdf"), { recursive: true });
  if (doc.buf) writeFileSync(join(CACHE_DIR, "pdf", `${city.key}-${sourceYear}.pdf`), doc.buf);

  // 2. read it
  let pages = doc.pages;
  if (!pages) {
    try {
      pages = await pdfPages(doc.buf);
    } catch (e) {
      return { ...run, status: "parse_failed", error: `pdfjs: ${e?.message ?? e}` };
    }
  }
  const chars = pages.join("").length;
  log(`  ${pages.length} pages, ${chars} chars of text`);
  if (!doc.ocr && !doc.onlyPages && chars < pages.length * 80) {
    return { ...run, status: "parse_failed", error: "לא ניתן לקרוא את המסמך גם לאחר OCR מקומי" };
  }
  const chunks = doc.ocr ? [] : chunkPages(pages);
  // A short scan is read whole: local OCR misses rotated or faint tables (כוכב יאיר
  // prints its rate table sideways on page 7), so it only narrows long documents.
  const scanPages = !doc.ocr ? []
    : doc.onlyPages ? doc.onlyPages
    : pages.length <= MAX_WHOLE_SCAN_PAGES ? pages.map((_, i) => i + 1)
    : pages.map((text, i) => (hasRates(text) ? i + 1 : null)).filter(Boolean);
  if (!chunks.length && !scanPages.length) {
    return { ...run, status: "parse_failed", error: "לא נמצאו טבלאות תעריפים" };
  }
  if (chunks.length) log(`  ${chunks.length} chunks with rates`);
  else log(`  scanned order: reading ${scanPages.length} rate page images`);

  // 3. prior years, for the year-over-year check
  const priorRows = store.readPriorTariffs(city.key, sourceYear);

  // 4. extraction
  run.backend = llmBackend;
  log(`  extracting with ${llmBackend}…`);
  const rows = [];
  const docYears = [];
  // Read page images with the model (scanned orders, or a text layer that failed).
  const readPageImages = async (pageNumbers) => {
    const { work, files } = renderPdfPageImages(doc.buf, pageNumbers);
    try {
      if (files.length !== pageNumbers.length) {
        return { error: "לא ניתן היה להמיר את עמודי הסריקה לתמונות", status: "parse_failed" };
      }
      for (const { page, file } of files) {
        let crashed = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            const out = await extractScannedPage(city, sourceYear, file, page, pages.length);
            rows.push(...(out.rows ?? []));
            docYears.push(out.doc_year);
            crashed = null;
            break;
          } catch (e) {
            crashed = e?.message ?? String(e);
            if (attempt < 2 && TRANSIENT_LLM_ERROR.test(crashed)) continue;
            log(`    page ${page} failed: ${crashed}`);
          }
        }
        if (crashed) return { error: crashed, status: "extract_failed" };
      }
      return {};
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  };
  if (scanPages.length) {
    const read = await readPageImages(scanPages);
    if (read.error) return { ...run, status: read.status, error: read.error };
  }
  for (let c = 0; c < chunks.length; c++) {
    let crashed = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const out = await extractChunk(city, sourceYear, chunks[c], c, chunks.length);
        rows.push(...(out.rows ?? []));
        docYears.push(out.doc_year);
        crashed = null;
        break;
      } catch (e) {
        crashed = e?.message ?? String(e);
        if (attempt < 2 && TRANSIENT_LLM_ERROR.test(crashed)) {
          log(`    chunk ${c + 1} transient failure: ${crashed} · retrying`);
          continue;
        }
        log(`    chunk ${c + 1} failed: ${crashed}`);
      }
    }
    if (crashed) return { ...run, status: "extract_failed", error: crashed };
  }
  const verifiedSource = doc.via === "verified-source" ? city.verified_source : null;
  let check = validate(rows, docYears, sourceYear, priorRows, city.key, verifiedSource);
  // A text layer can look fine yet hide the tables (שעב 2026: a broken TrueType font
  // dropped every residential row). Before failing, read the pages as images.
  if (check.fatal.length && chunks.length && doc.buf && pages.length <= MAX_WHOLE_SCAN_PAGES && !doc.onlyPages) {
    log(`    ✗ ${check.fatal.join(" · ")} — retrying from page images`);
    rows.length = 0;
    docYears.length = 0;
    const read = await readPageImages(pages.map((_, i) => i + 1));
    if (read.error) return { ...run, status: read.status, error: read.error };
    check = validate(rows, docYears, sourceYear, priorRows, city.key, verifiedSource);
  }
  if (check.fatal.length) {
    log(`    ✗ ${check.fatal.join(" · ")}`);
    return { ...run, status: "extract_failed", error: check.fatal.join("; ") };
  }
  log(`    ✓ ${check.rows.length} tariffs (${check.flagged} flagged)`);
  run.flagged = check.flagged;
  if (DRY) {
    log(`  [dry] would write ${check.rows.length} tariffs to data/tariffs/${sourceYear}/${city.key}.json`);
    console.log(sample(check.rows));
    return { ...run, status: "ok", rows: check.rows.length, dry: true };
  }

  // 5. Replace the authority-year file. The previous contents stay in git history,
  // and the diff is the human review of the new extraction.
  const updatedAt = new Date().toISOString();
  const written = store.writeTariffs(city.key, sourceYear, check.rows.map((r) => ({
    city_key: city.key, year: sourceYear,
    category_key: r.category_key, category_label: String(r.category_label ?? "").slice(0, 300),
    code: r.code || null, zone: r.zone || null, building_type: r.building_type || null,
    size_from: r.size_from ?? null, size_to: r.size_to ?? null,
    rate_per_sqm: r.rate_per_sqm, notes: r.notes || null,
    source_url: doc.url, confidence: r.confidence ?? "high",
    needs_review: r.needs_review, review_reason: r.review_reason, updated_at: updatedAt,
  })));
  store.patchRegistryCity(city.key, {
    last_doc_url: doc.url, last_doc_year: sourceYear, site: city.site ?? null,
  });
  const registryCity = store.readRegistry().find((entry) => entry.key === city.key);
  store.updatePublicIndex([registryCity]);

  log(`  ✓ wrote ${written} tariffs → data/tariffs/${sourceYear}/${city.key}.json`);
  console.log(sample(check.rows));
  return { ...run, status: "ok", rows: written };
}

function sample(rows) {
  const pick = ["residential", "office", "commerce", "industry", "storage", "parking"];
  return pick.flatMap((c) => rows.filter((r) => r.category_key === c).slice(0, 2))
    .map((r) => `      ${r.category_key.padEnd(12)} ${String(r.rate_per_sqm).padStart(9)} ₪/מ״ר`
      + `${r.zone ? ` · אזור ${r.zone}` : ""}${r.building_type ? ` · בנין ${r.building_type}` : ""}`
      + `${r.size_from != null || r.size_to != null ? ` · ${r.size_from ?? 0}–${r.size_to ?? "∞"} מ״ר` : ""}`
      + `  ${r.category_label.slice(0, 40)}`)
    .join("\n");
}


// ── official nationwide registry + little-and-often rotation ────────────────

function aliasesForCity(city) {
  return [city.key, city.name, ...(city.aliases ?? [])].map(normalizeCity).filter(Boolean);
}

async function syncNationalRegistry(existingCities) {
  const cached = store.readNational();
  // The CBS edge resets Chrome-identifying requests for this workbook; Node's
  // ordinary fetch identity succeeds, so do not send the municipal crawler UA.
  const workbook = await get(CBS_LOCAL_AUTHORITIES_URL, { binary: true, timeout: 60_000, headers: {} });
  if (!workbook.ok || !workbook.buf) {
    const cachedKeys = Array.isArray(cached.city_keys) ? cached.city_keys : [];
    const fallbackKeys = cachedKeys.length
      ? cachedKeys
      : existingCities.filter((city) => city.active !== false).map((city) => city.key);
    if (!fallbackKeys.length) {
      throw new Error(`CBS municipality registry unavailable (${workbook.status ?? workbook.error ?? "network error"})`);
    }
    console.log(`  ! CBS registry unavailable; using ${fallbackKeys.length} authorities from local state`);
    return {
      cities: existingCities.filter((city) => fallbackKeys.includes(city.key)),
      cityKeys: fallbackKeys,
      sourceYear: Number(cached.source_year) || null,
      created: 0,
      cached: true,
    };
  }

  const authorities = parseCbsLocalAuthoritiesXlsx(workbook.buf);
  const byKey = new Map(existingCities.map((city) => [city.key, city]));
  const byAlias = new Map();
  for (const city of existingCities) {
    for (const alias of aliasesForCity(city)) if (!byAlias.has(alias)) byAlias.set(alias, city);
  }
  const synced = [];
  const cityKeys = [];
  let created = 0;
  for (const authority of authorities) {
    const registryKey = cbsAuthorityCityKey(authority.code);
    const matched = byKey.get(registryKey) ?? byAlias.get(normalizeCity(authority.name));
    const key = matched?.key ?? registryKey;
    const officialName = normalizeCity(authority.name);
    const name = matched && !matched.key.startsWith("cbs-") ? matched.name : officialName;
    const aliases = [...new Set([
      ...(matched?.aliases ?? []), matched?.name, authority.name, officialName, authority.englishName,
    ].map((value) => String(value ?? "").trim()).filter(Boolean))];
    synced.push({
      site: null, index_urls: [], doc_url_template: null, last_doc_url: null, last_doc_year: null,
      ...matched,
      key, name, muni_name: normalizeCity(authority.municipalName), aliases, active: true,
    });
    cityKeys.push(key);
    if (!matched) created += 1;
  }
  if (new Set(cityKeys).size !== authorities.length) {
    throw new Error("CBS municipality registry matched more than one authority to the same city row");
  }

  const sourceYear = Math.max(...authorities.map((authority) => authority.sourceYear));
  if (!DRY) {
    const syncedKeys = new Set(cityKeys);
    store.writeRegistry([...existingCities.filter((city) => !syncedKeys.has(city.key)), ...synced]);
    const typeCounts = Object.fromEntries([...new Set(authorities.map((authority) => authority.authorityType))]
      .map((type) => [type, authorities.filter((authority) => authority.authorityType === type).length]));
    store.patchNational({
      source_url: CBS_LOCAL_AUTHORITIES_URL,
      source_year: sourceYear,
      authority_count: authorities.length,
      authority_type_counts: typeCounts,
      city_keys: cityKeys,
      synced_at: new Date().toISOString(),
    });
    store.updatePublicIndex(synced);
  }
  console.log(`  CBS registry ${sourceYear}: ${authorities.length} authorities${created ? ` · ${created} new` : ""}${DRY ? " [dry]" : ""}`);
  return { cities: synced, cityKeys, sourceYear, created, cached: false };
}

function chooseNationalTargets(cities, registryKeys) {
  const keys = new Set(registryKeys);
  return selectNationalTargets({
    cities,
    tariffs: store.readTariffsForYear(YEAR).filter((row) => keys.has(row.city_key)),
    runs: store.readRuns().filter((run) => run.year === YEAR && keys.has(run.city_key)),
    batchSize: NATIONAL_BATCH,
    retryBefore: NATIONAL_RETRY_BEFORE,
    mode: RETRY_FAILED ? "retry_failed" : "scheduled",
  });
}

// ── show mode ────────────────────────────────────────────────────────────────

function cityLookup(cities) {
  const byAlias = new Map();
  for (const city of cities) {
    for (const alias of aliasesForCity(city)) if (!byAlias.has(alias)) byAlias.set(alias, city);
  }
  return (value) => byAlias.get(normalizeCity(value)) ?? null;
}

function show(year) {
  let rows = store.readTariffsForYear(year);
  if (ONLY_CITY) {
    const city = cityLookup(store.readRegistry())(ONLY_CITY);
    const key = city?.key ?? ONLY_CITY;
    rows = rows.filter((row) => row.city_key === key);
  }
  if (!rows.length) {
    console.log(`no tariffs stored for ${ONLY_CITY ? `${ONLY_CITY} ` : ""}${year}`);
    return;
  }
  let city = null;
  for (const r of rows) {
    if (r.city_key !== city) {
      city = r.city_key;
      console.log(`\n== ${city} ${year} ==${r.source_url ? `  ${r.source_url}` : ""}`);
    }
    console.log(`  ${r.needs_review ? "⚠" : " "} ${r.category_key.padEnd(12)}`
      + `${String(r.rate_per_sqm).padStart(10)} ₪/מ״ר/שנה`
      + `${r.code ? ` · סמל ${r.code}` : ""}`
      + `${r.zone ? ` · אזור ${r.zone}` : ""}${r.building_type ? ` · בנין ${r.building_type}` : ""}`
      + `${r.size_from != null || r.size_to != null ? ` · ${r.size_from ?? 0}–${r.size_to ?? "∞"}` : ""}`
      + `  ${r.category_label.slice(0, 46)}`);
  }
  console.log(`\n${rows.length} tariffs, ${rows.filter((r) => r.needs_review).length} flagged`);
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (SHOW) return show(YEAR);

  let cities = store.readRegistry();
  let registry = null;
  if (NATIONAL) {
    registry = await syncNationalRegistry(cities);
    const merged = new Map(cities.map((city) => [city.key, city]));
    for (const city of registry.cities) merged.set(city.key, city);
    cities = [...merged.values()];
  }
  if (!cities.length) {
    throw new Error("scraper/state/registry.json is empty — run with --sync-registry-only first");
  }
  const cityFor = cityLookup(cities);

  let pendingNational = null;
  let targets;
  if (ONLY_CITY) {
    targets = [cityFor(ONLY_CITY)].filter(Boolean);
    if (!targets.length) throw new Error(`no authority matches "${ONLY_CITY}" (use a key such as tel-aviv, or a Hebrew/English name)`);
  } else if (NATIONAL) {
    if (SYNC_REGISTRY_ONLY) {
      console.log(`ארנונה — registry synced: ${registry.cityKeys.length} authorities${DRY ? " [dry]" : ""}`);
      return;
    }
    const selection = chooseNationalTargets(registry.cities, registry.cityKeys);
    targets = selection.targets;
    pendingNational = selection.pending;
    if (RETRY_FAILED) {
      const failure = nationalManualFailedRetryError({
        lockAcquired: true,
        targetCount: targets.length,
        failedPending: selection.failedPending,
      });
      if (failure) throw new Error(failure);
    }
    if (NATIONAL_RETRY_BEFORE) {
      console.log(`  retry snapshot: ${selection.eligible} authorities still eligible before ${NATIONAL_RETRY_BEFORE}`);
    }
  } else {
    // Annual refresh: every active authority whose order location is already known.
    targets = cities.filter((city) => city.active !== false && (city.last_doc_url || city.doc_url_template));
    if (!targets.length) throw new Error("no authority has a known source yet — use --city or --national");
  }

  const scope = NATIONAL && !ONLY_CITY
    ? `${targets.length}/${pendingNational} pending national authorities (batch ${NATIONAL_BATCH})`
    : `${targets.length} ${targets.length === 1 ? "authority" : "authorities"}`;
  console.log(`ארנונה ${YEAR} — ${scope}${DRY ? " [dry]" : ""}${DISCOVER_ONLY ? " [discover-only]" : ""}`);
  if (PLAN_ONLY) {
    for (const city of targets) console.log(`  → ${city.name} (${city.key})`);
    return;
  }
  if (!DISCOVER_ONLY) {
    llmBackend = selectLlmBackend();
    if (!llmBackend) throw new Error(NO_LLM_MESSAGE);
    console.log(`  LLM backend: ${llmBackend}`);
  }

  const batchStartedAt = new Date().toISOString();
  const results = [];
  for (const city of targets) {
    const started = new Date().toISOString();
    const knownSite = city.site ?? null;
    let result;
    try {
      result = await scrapeCity(city, YEAR);
    } catch (e) {
      result = {
        city_key: city.key, year: YEAR, source_year: YEAR, status: "extract_failed",
        rows: 0, flagged: 0, error: e?.message ?? String(e),
      };
      console.error(`  ✗ ${city.key}: ${result.error}`);
    }
    results.push({ ...result, name: city.name });
    // A verified official homepage is durable discovery progress even when this
    // year's complete order was not found.
    if (!DRY && city.site && city.site !== knownSite) {
      store.patchRegistryCity(city.key, { site: city.site });
    }
    if (!DRY && !result.skipped) {
      store.appendRun({
        city_key: city.key, year: YEAR, source_year: result.source_year ?? YEAR,
        status: result.status, doc_url: result.doc_url ?? null, backend: result.backend ?? null,
        rows: result.rows ?? 0, flagged: result.flagged ?? 0, error: result.error ?? null,
        started_at: started, finished_at: new Date().toISOString(),
      });
    }
  }

  const ok = results.filter((r) => r.status === "ok" && !r.skipped);
  const skipped = results.filter((r) => r.skipped);
  const failed = results.filter((r) => r.status !== "ok" && r.status !== "skipped");
  const flagged = results.reduce((s, r) => s + (r.flagged ?? 0), 0);
  const verb = DISCOVER_ONLY ? "discovered" : "scraped";
  console.log(`\n── ${YEAR}: ${ok.length} ${verb} · ${skipped.length} already had · `
    + `${failed.length} failed · ${flagged} flagged`
    + `${tokensIn || tokensOut ? ` · ${tokensIn} in / ${tokensOut} out tokens` : ""}`);
  for (const r of ok.filter((item) => item.doc_url)) {
    console.log(`   ✓ ${r.name}: ${r.doc_url}${r.source_year !== YEAR ? ` (order year ${r.source_year})` : ""}`);
  }
  for (const f of failed) console.log(`   ✗ ${f.name}: ${f.error}`);

  if (!DRY && NATIONAL && !ONLY_CITY) {
    store.patchNational({
      last_batch_started_at: batchStartedAt,
      last_batch_finished_at: new Date().toISOString(),
      last_batch_city_keys: results.map((result) => result.city_key),
      last_batch_ok: ok.length,
      last_batch_failed: failed.length,
      pending_before_batch: pendingNational,
    });
  }
  if (failed.length && !ok.length) process.exitCode = 1;
}

// A merge once shipped a scrape-arnona.mjs that imported five helpers which were
// never committed, so the file could not even be loaded, while `node --check`
// still reported valid syntax. This gate exercises the real discovery wiring —
// link extraction, embedded-archive crawling, challenge detection and the
// search-free directory — with no network, LLM or lock. Run it after every change.
if (SELF_TEST) {
  const failures = [];
  const check = (name, condition) => { if (!condition) failures.push(name); };
  try {
    const base = "https://www.example.org.il/צווי-מיסים/";
    const html = `<html><body>
      <a href="uploads/n/order-2026.pdf">צו ארנונה 2026</a>
      <a href="/arnona-2026/">צו ארנונה לשנת 2026</a>
      <iframe src="filebrowser/?folder=15" title="צווי מיסים"></iframe>
    </body></html>`;

    const links = linksFromMunicipalHtml(html, base)
      .map((l) => ({ ...l, score: scoreLink(l.url, l.text, 2026) }))
      .sort((a, b) => b.score - a.score);
    check("links extracted", links.length > 0);
    check("embedded archive discovered", links.some((l) => l.kind === "embedded"));
    check("pdf candidate discovered", links.some((l) => /\.pdf$/i.test(l.url)));

    const crawl = municipalCrawlLinks(links, base, 2, new Set());
    check("municipalCrawlLinks callable", Array.isArray(crawl));
    check("embedded archive is crawled", crawl.some((l) => l.kind === "embedded"));

    check("real page usable", municipalSearchResponseUsable("<html><body>תוצאות</body></html>"));
    check("challenge page rejected", !municipalSearchResponseUsable(
      "<html><body>שלב אחד אחרון פתור את האתגר שלהלן כדי להמשיך</body></html>",
    ));

    const directory = await resolveMunicipalSiteFromDirectory(
      { name: "נצרת", muni_name: "עיריית נצרת", aliases: ["Nazareth"] },
      {
        fetchJson: async () => ({
          query: { pages: { 1: { extlinks: [{ "*": "http://www.nazareth.muni.il/" }] } } },
        }),
      },
    );
    check("directory resolves an official site", directory?.site === "http://www.nazareth.muni.il/");

    const miss = classifyArnonaDiscoveryMiss({
      directoryChecked: true,
      unavailableSearchProviders: ["Brave", "Bing", "DuckDuckGo"],
    });
    check("discovery miss stays retryable", miss.status === "discovery_failed");
    check("directory attempt is reported", /מדריך/.test(miss.error));

    const lead = await researchArnonaSource(
      { name: "חורפיש", muni_name: "מועצה מקומית חורפיש", aliases: ["Hurfeish"] },
      2026,
      { runCli: async () => '{"found":true,"site":"https://www.lch.org.il","document_urls":["https://www.lch.org.il/a.pdf"]}' },
    );
    check("live-search lead is parsed", lead?.site === "https://www.lch.org.il");

    // חורפיש publishes nothing after 2022. The order that exists must be usable
    // under its own year instead of being reported as no source at all.
    const publishedOnly = arnonaCandidateOfferedYears(
      "https://www.lch.org.il/uploads/n/1755764009.pdf", "צו ארנונה 2022",
    );
    check("a published year is remembered from the link", publishedOnly.includes(2022));
    check("the nearest published year is tried first",
      arnonaFallbackYearOrder([2019, 2020, 2021, 2022], 2026)[0] === 2022);
    check("the published years are stated in the failure",
      /2019, 2020/.test(describeArnonaPublishedYears([2020, 2019], 2026)));
    check("verified sources retry the other host and plain http",
      JSON.stringify(hostVariants("https://www.x.muni.il/a.pdf")) === JSON.stringify([
        "https://www.x.muni.il/a.pdf", "https://x.muni.il/a.pdf",
        "http://www.x.muni.il/a.pdf", "http://x.muni.il/a.pdf",
      ]));
    check("an HTML order keeps its table cells apart",
      htmlToText("<table><tr><td>מגורים</td><td>47.02</td></tr></table><script>x()</script>")
        === "מגורים | 47.02 |");
    check("a verified industrial council may lack a residential rate", (() => {
      const rows = [1, 2, 3].map((i) => ({
        category_key: "office", category_label: `משרדים ${i}`, rate_per_sqm: 100 + i,
      }));
      const strict = validate(rows.map((r) => ({ ...r })), [], 2026, [], "x");
      const pinned = validate(rows.map((r) => ({ ...r })), [2025], 2026, [], "x", { no_residential: true });
      return strict.fatal.some((m) => /מגורים/.test(m)) && pinned.fatal.length === 0;
    })());
    check("live-search failure degrades to null", await researchArnonaSource(
      { name: "x", muni_name: "x" }, 2026, { runCli: async () => { throw new Error("down"); } },
    ) === null);
  } catch (error) {
    failures.push(`threw ${error?.message ?? error}`);
  }
  if (failures.length) {
    console.error(`scrape-arnona --self-test FAILED: ${failures.join("; ")}`);
    process.exit(1);
  }
  console.log("scrape-arnona --self-test OK");
  process.exit(0);
}

const releaseLock = SHOW ? () => {} : acquireScrapeLock();
if (!releaseLock) {
  const failure = RETRY_FAILED
    ? nationalManualFailedRetryError({ lockAcquired: false, targetCount: null })
    : null;
  console.error(`ארנונה — ${failure ?? "another scraper run is active in this checkout; try again later"}`);
  process.exitCode = 1;
} else {
  process.once("exit", releaseLock);
  try {
    await main();
  } finally {
    releaseLock();
  }
  // Municipal crawls can leave many keep-alive sockets behind. Every write above is
  // synchronous or awaited, so lingering transport handles must not hold the process.
  process.exit(process.exitCode ?? 0);
}
