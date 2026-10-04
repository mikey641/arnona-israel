function absolutize(href, base) {
  try {
    const url = new URL(href, base);
    // "/#panel_3" is the page we already fetched, not another page. Treating an
    // in-page anchor as a separate crawl target spent one of חיפה's two crawl
    // slots re-queuing its own home page. SPA hash routes (#/x, #!x) are kept.
    if (url.hash && !/^#[!/]/.test(url.hash)) url.hash = "";
    return url.toString();
  } catch { return null; }
}

function decodedAttribute(value) {
  return String(value ?? "").replace(/&amp;/gi, "&").trim();
}

function attributeFrom(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i"));
  return decodedAttribute(match?.[2]);
}

function isNavigationalEmbeddedUrl(url) {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return false;
    return !/(?:^|[./_-])(?:captcha|recaptcha|challenge)(?:[./?&=_-]|$)/i.test(
      `${parsed.hostname}${parsed.pathname}${parsed.search}`,
    );
  } catch {
    return false;
  }
}

/**
 * `./x` and `x` mean the same thing to a browser, so they must be treated the
 * same when probing the origin root. גוש עציון embeds its order archive as
 * `./filebrowser/?folder=361` from /375/: the browser-relative form 404s and the
 * root form serves the real order, and the leading `./` was skipping the probe.
 */
function withoutLeadingDot(value) {
  return value.replace(/^\.\//, "");
}

function embeddedUrlVariants(rawSrc, linkBase) {
  const src = decodedAttribute(rawSrc);
  const resolved = absolutize(src, linkBase);
  if (!resolved) return [];

  // A recurring municipal-CMS pattern embeds `filebrowser/?folder=...` from a
  // Hebrew landing-page slug even though the route actually lives at the site
  // root. Browsers resolve the bare path below the slug, which produces a 404.
  // Probe the origin-root interpretation as well for any bare embedded route;
  // the crawl remains same-origin, depth-limited, and document-validated.
  const bare = withoutLeadingDot(src);
  if (/^(?:[a-z0-9_%~-]+\/)+[^/?#]*(?:[?#]|$)/i.test(bare)
      && !/^(?:\.\.\/|\/)/.test(bare)) {
    const rootResolved = absolutize(`/${bare}`, new URL(linkBase).origin);
    return [...new Set([rootResolved, resolved].filter(Boolean))];
  }
  return [resolved];
}

function isYearSpecificArnonaSlug(rawHref) {
  const href = withoutLeadingDot(String(rawHref ?? ""));
  if (!href || /^(?:[a-z][a-z0-9+.-]*:|[./])/i.test(href)) return false;
  const withoutTrailingSlash = href.replace(/\/$/, "");
  if (withoutTrailingSlash.includes("/")) return false;
  let decoded = withoutTrailingSlash;
  try { decoded = decodeURIComponent(withoutTrailingSlash); } catch { /* keep the raw slug */ }
  return /20\d{2}/.test(decoded) && /(?:ארנונה|מסים|מיסים)/.test(decoded);
}

function anchorUrlVariants(rawHref, linkBase) {
  const href = decodedAttribute(rawHref);
  const resolved = absolutize(href, linkBase);
  if (!resolved) return [];
  const bare = withoutLeadingDot(href);
  if (/^(?:uploads|documents|userfiles|filebrowser)\//i.test(bare)
      || isYearSpecificArnonaSlug(bare)) {
    const rootResolved = absolutize(`/${bare}`, new URL(linkBase).origin);
    return [...new Set([rootResolved, resolved].filter(Boolean))];
  }
  return [resolved];
}

/**
 * Extract municipal navigation targets from ordinary links, embedded archives,
 * and PDF URLs serialized inside SPA payloads.
 */
export function linksFromMunicipalHtml(html, base) {
  const out = [];
  const seen = new Set();
  const push = (link) => {
    if (!link.url || seen.has(link.url)) return;
    seen.add(link.url);
    out.push(link);
  };

  // Respect the document's base URL. Some municipal CMS pages use
  // <base href="/"> with links such as ./uploads/order.pdf.
  const declaredBase = html.match(/<base\b[^>]*href=["']([^"']+)["']/i)?.[1];
  const linkBase = declaredBase
    ? absolutize(decodedAttribute(declaredBase), base) ?? base
    : base;

  const anchor = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchor.exec(html))) {
    const text = match[2].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    for (const url of anchorUrlVariants(match[1], linkBase)) {
      if (/^https?:\/\//i.test(url)) push({ url, text, kind: "link" });
    }
  }

  const iframe = /<iframe\b[^>]*>/gi;
  while ((match = iframe.exec(html))) {
    const src = attributeFrom(match[0], "src");
    if (!src) continue;
    const text = attributeFrom(match[0], "title") || attributeFrom(match[0], "aria-label");
    for (const url of embeddedUrlVariants(src, linkBase)) {
      if (isNavigationalEmbeddedUrl(url)) push({ url, text, kind: "embedded" });
    }
  }

  // Page builders often ship document URLs inside JSON payloads rather than
  // links. Decode only JSON's slash and Unicode escapes before scanning; the
  // resulting URL still passes the caller's same-origin and PDF validation.
  const serializedDocuments = html.replace(/\\+\//g, "/")
    .replace(/\\+u([0-9a-f]{4})/gi, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
  let sourceOrigin = null;
  try { sourceOrigin = new URL(base).origin; } catch { /* invalid fetched page URL */ }
  const barePdf = /https?:\/\/[^\s"'<>\\]+\.pdf/gi;
  while ((match = barePdf.exec(serializedDocuments))) {
    const url = absolutize(match[0], linkBase);
    try {
      if (url && sourceOrigin && new URL(url).origin === sourceOrigin) {
        push({ url, text: "", kind: "document" });
      }
    } catch { /* malformed serialized URL */ }
  }
  return out;
}

export function municipalSearchResponseUsable(html) {
  const visibleText = String(html ?? "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:[a-z][a-z0-9]+|#\d+|#x[0-9a-f]+);/gi, " ")
    .replace(/\s+/g, " ").trim();
  if (!visibleText) return false;
  return !/(?:unfortunately,?\s*bots use duckduckgo too|please complete the following challenge|verify (?:you are|that you are) (?:a )?human|unusual traffic from|שלב אחד אחרון.{0,120}פתור את האתגר)/i.test(visibleText);
}

/**
 * Rank a municipal link as a lead towards the year's full Arnona order.
 *
 * "צו המיסים" is the ordinary title for the same legal document, especially in
 * regional councils. Scoring it below the crawl threshold left councils such as
 * גדרות reporting `no_doc` while their order page sat one unfollowed click away.
 */
export function municipalLinkScore(href, text, year) {
  // A municipal page may contain a stray percent sign. decodeURIComponent throws
  // "URI malformed" on it, which killed the whole זכרון יעקב run rather than
  // skipping one link, so scoring must never depend on the URL being decodable.
  let decodedHref = String(href ?? "");
  try { decodedHref = decodeURIComponent(decodedHref); } catch { /* score the raw URL */ }
  const hay = `${decodedHref} ${text}`.toLowerCase();
  let score = 0;
  if (/\.pdf(\?|$)/i.test(href)) score += 3;
  // A municipality's Arnona SECTION is usually linked as the bare word "ארנונה".
  // At +3 it sat below the crawl threshold, so חולון's whole tax section — and
  // with it the order — was never entered. Discounts, forms and tenders still
  // fall back below the threshold through their own negative terms.
  if (/ארנונה|arnona|מיסים|מסים/.test(hay)) score += 4;
  if (hay.includes("צו") || hay.includes("tzav")) score += 2;
  // Municipal navigation often calls the archive only "צווים ודוחות". It is a
  // useful page to follow even though it does not name Arnona or the year itself.
  if (/דוחות|reports|report archive/.test(hay)) score += 2;
  if (hay.includes(String(year))) score += 4;
  if (hay.includes(String(year - 1))) score -= 2;          // last year's book
  if (/הנח|פטור|ערר|בקש|טופס|form|discount/.test(hay)) score -= 4;  // discounts, not rates
  if (/תכניות?\s*עבודה|תקציב|מאזן|מכרז|work.?plan|budget|tender/.test(hay)) score -= 8;
  return score;
}

/**
 * The authority's own site, ignoring scheme and a leading `www.`.
 *
 * A configured or directory-supplied site is often `http://…` while the pages it
 * serves link to `https://…` (and vice versa). Comparing full origins made those
 * links look cross-site, so councils such as גדרות never followed their own
 * "צו המיסים" page. Host identity still confines the crawl to one authority.
 */
function crawlSiteIdentity(rawUrl) {
  try {
    return new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function municipalCrawlLinks(links, officialBase, limit = 2, excludedUrls = new Set()) {
  const officialSite = crawlSiteIdentity(officialBase);
  if (!officialSite) return [];
  return (links ?? []).filter((link) => (link.kind === "embedded" || Number(link.score) >= 4)
    && !/\.pdf(?:$|[?#])/i.test(String(link.url ?? "")))
    .filter((link) => !excludedUrls.has(link.url))
    .filter((link) => crawlSiteIdentity(link.url) === officialSite)
    // An embedded document browser IS the archive, and its iframe usually carries
    // no text at all, so it scores zero and would lose the crawl budget to any two
    // ordinary navigation links — which is how גוש עציון's order stayed hidden.
    .sort((a, b) => (b.kind === "embedded" ? 1 : 0) - (a.kind === "embedded" ? 1 : 0))
    .slice(0, limit);
}
