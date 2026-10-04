// Search-free discovery of an authority's official municipal site.
//
// WHY THIS EXISTS: every public search engine (Brave, DuckDuckGo, Bing, Google,
// Mojeek, Startpage, Marginalia) commonly answers a datacenter IP with a bot
// challenge or a 429, so `searchPublicWeb` reports "no provider available" and the
// run fails before it ever reaches a municipal page. Crawling municipal sites
// themselves works fine — the scraper only lacks a way to learn the site's address.
//
// Wikipedia's API is not bot-walled from servers and carries an official-website
// external link for the overwhelming majority of Israeli local authorities, so it
// supplies the missing address. A directory hit is only ever a LEAD: the caller
// still applies the normal authority-identity and provenance gates before trusting
// it, exactly as it does for a search result.

const WIKI_API = "https://he.wikipedia.org/w/api.php";

// Hosts that are never an authority's own site, even when the article links them.
const NEVER_OFFICIAL =
  /(?:^|\.)(?:wikipedia|wikimedia|wikidata|archive)\.org$|(?:^|\.)web\.archive\.org$|(?:^|\.)(?:facebook|instagram|twitter|x|youtube|linkedin|google|blogspot|wordpress)\.com$/i;

// Municipal bodies that share a town's name but are not the authority itself.
// Wikidata listed מתנ"ס דימונה as the town's "official website"; the authority is
// dimona.muni.il. Keep this list tight and evidence-driven.
const NOT_THE_AUTHORITY = /(?:^|[.-])(?:matnas|matnasim|sport|museum|teatron|tourism|archive)(?:[.-]|$)/i;

/** Latin domain slugs for the authority, mirroring the host-probing slug rules. */
function directorySlugs(city) {
  const slugs = new Set();
  for (const alias of city.aliases ?? []) {
    if (!/^[a-z0-9 .'’-]+$/i.test(alias)) continue;
    const words = alias.toLowerCase().replace(/[’']/g, "").split(/[^a-z0-9]+/).filter(Boolean);
    if (!words.length) continue;
    for (const value of [words.join(""), words.join("-")]) {
      slugs.add(value.replaceAll("gh", "g"));
      slugs.add(value);
    }
  }
  return [...slugs];
}

/** The registrable label of a host: www.nazareth.muni.il → nazareth. */
function hostSlug(hostname) {
  return hostname.replace(/^www\./i, "").split(".")[0].toLowerCase();
}

function normaliseName(raw) {
  return String(raw ?? "")
    // The registry writes "תל אביב -יפו"; Wikipedia titles it "תל אביב-יפו".
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Ordered Hebrew Wikipedia article titles for an authority.
 *
 * A regional council's bare name is usually a different article (a settlement or a
 * region), so its council title leads. Cities and local councils are titled by
 * their bare name. The authoritative registry also spells optional yod differently
 * from Wikipedia ("נהרייה" vs "נהריה"), which is why the collapsed variant is tried.
 */
export function municipalDirectoryTitles(city) {
  const name = normaliseName(city.name);
  const muni = String(city.muni_name ?? "");
  const regional = /מועצה\s+אזורית/u.test(muni) || /\bregional\s+council\b/i.test(muni);
  const local = /מועצה\s+מקומית/u.test(muni) || /\blocal\s+council\b/i.test(muni);

  const spellings = [name];
  const collapsed = name.replace(/יי/g, "י");
  if (collapsed !== name) spellings.push(collapsed);

  const titles = [];
  for (const spelling of spellings) {
    if (regional) {
      titles.push(`מועצה אזורית ${spelling}`, spelling);
    } else if (local) {
      titles.push(spelling, `מועצה מקומית ${spelling}`);
    } else {
      titles.push(spelling);
    }
  }
  return [...new Set(titles.filter(Boolean))].slice(0, 8);
}

/** Hosts that can never be an authority's own site, whatever the source claims. */
function isDisqualifiedHost(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return true; }
  if (!/^https?:$/.test(parsed.protocol)) return true;
  const host = parsed.hostname.toLowerCase();
  return NEVER_OFFICIAL.test(host) || NOT_THE_AUTHORITY.test(host);
}

/**
 * Choose the authority's own site from an article's raw external links.
 *
 * Raw external links are untyped: every Hebrew Wikipedia article also links the
 * National Library's authority record (`nli.org.il`) and often unrelated media
 * pages, and merely preferring Israeli TLDs let those win for four authorities in
 * one batch. A raw link is therefore accepted only on positive evidence that the
 * host belongs to THIS authority — the municipal namespace, or its own name.
 * Anything weaker must come from the declared official-website property instead.
 */
export function officialSiteFromDirectoryLinks(links, city) {
  const slugs = new Set(directorySlugs(city));
  let best = null;
  let bestScore = 0;

  for (const raw of links ?? []) {
    const url = String(raw ?? "").trim();
    if (isDisqualifiedHost(url)) continue;
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();

    const municipalNamespace = /\.muni\.il$/i.test(host);
    const namedForAuthority = slugs.has(hostSlug(host));
    if (!municipalNamespace && !namedForAuthority) continue;

    let score = municipalNamespace ? 6 : 0;
    if (namedForAuthority) score += 4;
    if (parsed.protocol === "https:") score += 1;

    if (score > bestScore) { bestScore = score; best = url; }
  }
  return best;
}

function pagesFrom(payload) {
  return Object.values(payload?.query?.pages ?? {});
}

function extlinksFrom(payload) {
  const out = [];
  for (const page of pagesFrom(payload)) {
    if (page?.missing !== undefined) continue;
    for (const link of page?.extlinks ?? []) {
      const value = typeof link === "string" ? link : link?.["*"];
      if (value) out.push(value.startsWith("//") ? `https:${value}` : value);
    }
  }
  return out;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wikimedia throttles bursts. A throttled response must never be mistaken for
 * "this authority has no official site": measuring all 259 authorities back to
 * back reported five false misses that resolved fine when retried. Retry a
 * refused or failed request before giving up.
 */
const defaultFetchJson = async (url, attempt = 0) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const res = await fetch(url, {
      headers: {
        // Wikimedia asks automated clients to identify themselves.
        "user-agent": process.env.ARNONA_USER_AGENT_CONTACT
          ? `arnona-israel-scraper/1.0 (municipal arnona order discovery; ${process.env.ARNONA_USER_AGENT_CONTACT})`
          : "arnona-israel-scraper/1.0 (municipal arnona order discovery; open-source)",
        accept: "application/json",
      },
      signal: controller.signal,
    });
    if (res.status === 429 || res.status >= 500) throw new Error(`directory ${res.status}`);
    if (!res.ok) return null;
    return await res.json();
  } catch (error) {
    if (attempt >= 2) throw error;
    await sleep(1_500 * (attempt + 1));
    return defaultFetchJson(url, attempt + 1);
  } finally {
    clearTimeout(timer);
  }
};

function extlinksUrl(title) {
  return `${WIKI_API}?action=query&format=json&formatversion=1&redirects=1`
    + `&prop=extlinks&ellimit=500&titles=${encodeURIComponent(title)}`;
}

function wikibaseItemUrl(title) {
  return `${WIKI_API}?action=query&format=json&formatversion=1&redirects=1`
    + `&prop=pageprops&ppprop=wikibase_item&titles=${encodeURIComponent(title)}`;
}

function claimsUrl(entity) {
  return "https://www.wikidata.org/w/api.php"
    + `?action=wbgetclaims&format=json&property=P856&entity=${encodeURIComponent(entity)}`;
}

/**
 * The authority's declared official website (Wikidata P856).
 *
 * This is the only source that actually MEANS "official website", so it needs no
 * naming heuristics: דבורייה publishes on `dabburiya.net` and דאלית אל-כרמל on
 * `mdec.co.il`, neither of which any municipal-namespace or name rule would allow.
 * The caller still verifies the live site identifies itself as this authority.
 */
async function declaredOfficialSite(title, fetchJson) {
  const props = await fetchJson(wikibaseItemUrl(title));
  const page = Object.values(props?.query?.pages ?? {})[0];
  const entity = page?.pageprops?.wikibase_item;
  if (!entity) return null;

  const claims = await fetchJson(claimsUrl(entity));
  for (const claim of claims?.claims?.P856 ?? []) {
    const value = claim?.mainsnak?.datavalue?.value;
    const url = typeof value === "string" ? value.trim() : null;
    if (url && !isDisqualifiedHost(url)) return url;
  }
  return null;
}

function searchUrl(term) {
  return `${WIKI_API}?action=query&format=json&formatversion=1`
    + `&list=search&srlimit=3&srsearch=${encodeURIComponent(term)}`;
}

/**
 * Resolve the authority's official site from the open municipal directory.
 * @returns {Promise<{site: string, source: string, title: string} | null>}
 */
export async function resolveMunicipalSiteFromDirectory(city, { fetchJson = defaultFetchJson, log } = {}) {
  const titles = municipalDirectoryTitles(city);

  for (const title of titles) {
    try {
      // The declared official website first: it is a typed claim, not a guess.
      const declared = await declaredOfficialSite(title, fetchJson);
      if (declared) return { site: declared, source: "wikidata:P856", title };

      const payload = await fetchJson(extlinksUrl(title));
      const site = officialSiteFromDirectoryLinks(extlinksFrom(payload), city);
      if (site) return { site, source: "he.wikipedia", title };
    } catch {
      // A single unavailable article must not abort the remaining titles.
    }
  }

  // Exact titles can miss an authority whose article is named differently
  // ("פקיעין (בוקייעה)"). Wikipedia's own search finds it without any engine.
  //
  // A search hit is NOT evidence of identity: searching מודיעין עילית returned
  // ביתר עילית, which would have handed one authority another's municipal site.
  // Only an article that actually names this authority may be used.
  try {
    const wanted = normaliseName(city.name);
    const collapsed = wanted.replace(/יי/g, "י");
    const found = await fetchJson(searchUrl(`${wanted} ${city.muni_name ?? ""}`.trim()));
    for (const hit of found?.query?.search ?? []) {
      if (!hit?.title) continue;
      const titleCollapsed = normaliseName(hit.title).replace(/יי/g, "י");
      // The article must BE the authority or the place, not an institution that
      // merely carries its name — "ספריית קריית טבעון" declares the library's site.
      const isTheAuthority = titleCollapsed === collapsed
        || titleCollapsed.startsWith(`${collapsed} (`)
        || ["עיריית", "מועצה אזורית", "מועצה מקומית"]
          .some((prefix) => titleCollapsed === `${prefix} ${collapsed}`);
      if (!isTheAuthority) continue;

      const declared = await declaredOfficialSite(hit.title, fetchJson);
      if (declared) {
        log?.(`    · directory article matched by search  ${hit.title}`);
        return { site: declared, source: "wikidata:P856:search", title: hit.title };
      }
      const payload = await fetchJson(extlinksUrl(hit.title));
      const site = officialSiteFromDirectoryLinks(extlinksFrom(payload), city);
      if (site) {
        log?.(`    · directory article matched by search  ${hit.title}`);
        return { site, source: "he.wikipedia:search", title: hit.title };
      }
    }
  } catch {
    // Directory unavailable — the caller keeps its existing discovery failure.
  }
  return null;
}
