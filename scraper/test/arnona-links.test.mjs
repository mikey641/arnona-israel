import assert from "node:assert/strict";
import test from "node:test";
import {
  linksFromMunicipalHtml,
  municipalCrawlLinks,
  municipalLinkScore,
  municipalSearchResponseUsable,
} from "../lib/arnona-links.mjs";

const landingUrl = "https://www.shelomi.org.il/%D7%A6%D7%95%D7%95%D7%99-%D7%9E%D7%99%D7%A1%D7%99%D7%9D/";

test("a relative municipal iframe probes both root and browser-resolved archive routes", () => {
  const links = linksFromMunicipalHtml(
    '<main><iframe src="filebrowser/?folder=15" title="צווי מיסים"></iframe></main>',
    landingUrl,
  );

  assert.deepEqual(links.filter((link) => link.kind === "embedded").map((link) => link.url), [
    "https://www.shelomi.org.il/filebrowser/?folder=15",
    "https://www.shelomi.org.il/%D7%A6%D7%95%D7%95%D7%99-%D7%9E%D7%99%D7%A1%D7%99%D7%9D/filebrowser/?folder=15",
  ]);
});

test("the Shlomi archive resolves its opaque 2026 PDF", () => {
  const links = linksFromMunicipalHtml(
    '<a href="../uploads/n/1755764009.6041.pdf">צו מיסים 2026</a>',
    "https://www.shelomi.org.il/filebrowser/?folder=15",
  );

  assert.deepEqual(links[0], {
    url: "https://www.shelomi.org.il/uploads/n/1755764009.6041.pdf",
    text: "צו מיסים 2026",
    kind: "link",
  });
});

test("bare municipal upload anchors are also recovered from the origin root", () => {
  const links = linksFromMunicipalHtml(
    '<a href="uploads/n/1777367943.6402.pdf">צו ארנונה 2026.pdf</a>',
    "https://www.alona.org.il/%D7%A6%D7%95-%D7%90%D7%A8%D7%A0%D7%95%D7%A0%D7%94-2026/",
  );

  assert.deepEqual(links.map((link) => link.url), [
    "https://www.alona.org.il/uploads/n/1777367943.6402.pdf",
    "https://www.alona.org.il/%D7%A6%D7%95-%D7%90%D7%A8%D7%A0%D7%95%D7%A0%D7%94-2026/uploads/n/1777367943.6402.pdf",
  ]);
});

test("a declared base URL remains authoritative for document links", () => {
  const links = linksFromMunicipalHtml(
    '<base href="/"><a href="./uploads/order.pdf">צו ארנונה 2026</a>',
    "https://example.muni.il/taxes/orders/",
  );
  assert.equal(links[0].url, "https://example.muni.il/uploads/order.pdf");
});

test("Elementor JSON payloads expose their escaped Arnona PDF URL", () => {
  const links = linksFromMunicipalHtml(
    String.raw`{\"title\":\"\\u05e6\\u05d5 \\u05d0\\u05e8\\u05e0\\u05d5\\u05e0\\u05d4 2026\",\"column_button_link\":\"https:\\/\\/bet-shean.org.il\\/wp-content\\/uploads\\/sites\\/64\\/2025\\/12\\/\\u05e6\\u05d5-\\u05d0\\u05e8\\u05e0\\u05d5\\u05e0\\u05d4-2026-\\u05d7\\u05ea\\u05d5\\u05dd.pdf\"}`,
    "https://bet-shean.org.il/%D7%90%D7%A8%D7%A0%D7%95%D7%A0%D7%94/",
  );

  assert.deepEqual(links, [{
    url: "https://bet-shean.org.il/wp-content/uploads/sites/64/2025/12/%D7%A6%D7%95-%D7%90%D7%A8%D7%A0%D7%95%D7%A0%D7%94-2026-%D7%97%D7%AA%D7%95%D7%9D.pdf",
    text: "",
    kind: "document",
  }]);
});

test("serialized cross-origin PDF URLs are not emitted from an official page", () => {
  const links = linksFromMunicipalHtml(
    String.raw`{\"column_button_link\":\"https:\\/\\/attacker.example\\/internal.pdf\"}`,
    "https://bet-shean.org.il/%D7%90%D7%A8%D7%A0%D7%95%D7%A0%D7%94/",
  );

  assert.deepEqual(links, []);
});

test("a hostile base element cannot authorize a serialized cross-origin PDF", () => {
  const links = linksFromMunicipalHtml(
    String.raw`<base href="https://attacker.example/"><script>{\"document\":\"https:\\/\\/attacker.example\\/internal.pdf\"}</script>`,
    "https://bet-shean.org.il/%D7%90%D7%A8%D7%A0%D7%95%D7%A0%D7%94/",
  );

  assert.deepEqual(links, []);
});

test("a bare year-specific Arnona page slug is also recovered from the origin root", () => {
  const links = linksFromMunicipalHtml(
    '<a href="%D7%A6%D7%95-%D7%90%D7%A8%D7%A0%D7%95%D7%A0%D7%94-2026/">צו ארנונה 2026</a>',
    "https://www.bney-ayish.muni.il/48/",
  );

  assert.deepEqual(links.map((link) => link.url), [
    "https://www.bney-ayish.muni.il/%D7%A6%D7%95-%D7%90%D7%A8%D7%A0%D7%95%D7%A0%D7%94-2026/",
    "https://www.bney-ayish.muni.il/48/%D7%A6%D7%95-%D7%90%D7%A8%D7%A0%D7%95%D7%A0%D7%94-2026/",
  ]);
});

test("challenge iframes are not treated as municipal archives", () => {
  const links = linksFromMunicipalHtml(
    '<iframe src="https://www.google.com/recaptcha/api2/anchor"></iframe>',
    landingUrl,
  );
  assert.deepEqual(links, []);
});

test("official iframe filtering happens before the crawl limit and requires an exact origin", () => {
  const parsed = linksFromMunicipalHtml([
    '<iframe src="https://external.example/archive"></iframe>',
    '<iframe src="https://www.shelomi.org.il.evil.example/archive"></iframe>',
    '<iframe src="filebrowser/?folder=15" title="צווי מיסים"></iframe>',
  ].join(""), landingUrl).map((link, index) => ({ ...link, score: 10 - index }));

  assert.deepEqual(municipalCrawlLinks(parsed, "https://www.shelomi.org.il", 2).map((link) => link.url), [
    "https://www.shelomi.org.il/filebrowser/?folder=15",
    "https://www.shelomi.org.il/%D7%A6%D7%95%D7%95%D7%99-%D7%9E%D7%99%D7%A1%D7%99%D7%9D/filebrowser/?folder=15",
  ]);
});

test("already queued municipal pages do not consume the crawl limit", () => {
  const links = [
    { url: "https://www.elad.muni.il/he/?s=arnona", text: "search", kind: "link", score: 10 },
    { url: "https://www.elad.muni.il/?s=arnona", text: "search", kind: "link", score: 9 },
    {
      url: "https://www.elad.muni.il/FreedomOfInformation/Pages/Arnona.aspx",
      text: "צווי מיסים וארנונה",
      kind: "link",
      score: 5,
    },
  ];

  assert.deepEqual(municipalCrawlLinks(
    links,
    "https://www.elad.muni.il",
    2,
    new Set([
      "https://www.elad.muni.il/he/?s=arnona",
      "https://www.elad.muni.il/?s=arnona",
    ]),
  ).map((link) => link.url), [
    "https://www.elad.muni.il/FreedomOfInformation/Pages/Arnona.aspx",
  ]);
});

test("public-search bot challenges are not reported as available search providers", () => {
  assert.equal(municipalSearchResponseUsable(`
    <html><body>Unfortunately, bots use DuckDuckGo too.
    Please complete the following challenge to confirm this search was made by a human.</body></html>
  `), false);
  assert.equal(municipalSearchResponseUsable(`
    <html><script>window.challenge = true</script><body>
    שלב אחד אחרון פתור את האתגר שלהלן כדי להמשיך</body></html>
  `), false);
});

test("a normal search result remains usable even when scripts mention challenge support", () => {
  assert.equal(municipalSearchResponseUsable(`
    <html><script src="/challenge-runtime.js"></script><body>
    <h1>Search results</h1><a href="https://example.muni.il/order.pdf">צו ארנונה 2026</a>
    </body></html>
  `), true);
  assert.equal(municipalSearchResponseUsable("<html><body>No results</body></html>"), true);
});

// גדרות linked its order as "צו המיסים" from /47/. Scoring that below the crawl
// threshold made the council report no_doc with the order one click away.
test("a council's צו המיסים page outranks the crawl threshold", () => {
  assert.ok(
    municipalLinkScore("https://www.gderot.muni.il/47/", "צו המיסים", 2026) >= 4,
    "צו המיסים must be followable",
  );
});

test("an Arnona order page is still ranked above the crawl threshold", () => {
  assert.ok(municipalLinkScore("/arnona-2026/", "צו ארנונה 2026", 2026) >= 4);
});

test("discount and appeal pages stay below the crawl threshold", () => {
  assert.ok(municipalLinkScore("https://www.gderot.muni.il/48/", "הנחה בארנונה", 2026) < 4);
  assert.ok(municipalLinkScore("/forms/", "טופס בקשה להנחה בארנונה", 2026) < 4);
});

// Or Akiva once selected a 142-page collection tender instead of its 8-page order,
// so a tender must stay below the page-crawl and PDF-candidate thresholds even when
// it names Arnona and the exact year.
test("budgets and tenders stay below the crawl and PDF thresholds", () => {
  assert.ok(municipalLinkScore("/budget-2026/", "תקציב 2026", 2026) < 4);
  assert.ok(municipalLinkScore("/tender/", "מכרז צו ארנונה 2026", 2026) < 4);
  assert.ok(municipalLinkScore("/tender/arnona-2026.pdf", "מכרז צו ארנונה 2026", 2026) < 6);
});

// גדרות is configured as http:// but links to its own https:// pages, which an
// exact-origin comparison treated as cross-site — so the order page was skipped.
test("a site's own links are crawled across scheme and www differences", () => {
  const links = [
    { url: "https://www.gderot.muni.il/47/", text: "צו המיסים", score: 5 },
    { url: "https://gderot.muni.il/45/", text: "ארנונה 2026", score: 7 },
  ];

  assert.deepEqual(
    municipalCrawlLinks(links, "http://www.gderot.muni.il", 2).map((l) => l.url),
    ["https://www.gderot.muni.il/47/", "https://gderot.muni.il/45/"],
  );
});

test("another authority's site is still never crawled", () => {
  const links = [{ url: "https://www.other.muni.il/47/", text: "צו המיסים", score: 5 }];

  assert.deepEqual(municipalCrawlLinks(links, "http://www.gderot.muni.il", 2), []);
});

// A stray percent sign in a municipal URL threw "URI malformed" out of scoring
// and killed the entire זכרון יעקב run instead of skipping one link.
test("an undecodable municipal URL is scored instead of throwing", () => {
  assert.doesNotThrow(() => municipalLinkScore("https://www.zy1882.co.il/100%", "צו ארנונה 2026", 2026));
  assert.ok(municipalLinkScore("https://www.zy1882.co.il/100%", "צו ארנונה 2026", 2026) >= 4);
});

// גוש עציון embeds its order archive as "./filebrowser/?folder=361" from /375/.
// The browser-relative form 404s; the origin-root form serves the real 2026 order.
test("a dot-slash embedded archive is also probed at the origin root", () => {
  const links = linksFromMunicipalHtml(
    '<iframe src="./filebrowser/?folder=361" onload="resizeIframe(this)"></iframe>',
    "https://www.baitisraeli.co.il/375/",
  );

  assert.deepEqual(links.filter((l) => l.kind === "embedded").map((l) => l.url), [
    "https://www.baitisraeli.co.il/filebrowser/?folder=361",
    "https://www.baitisraeli.co.il/375/filebrowser/?folder=361",
  ]);
});

test("a dot-slash upload anchor is also recovered from the origin root", () => {
  const links = linksFromMunicipalHtml(
    '<a href="./uploads/n/1768136590.7660.pdf">צו מיסים 2026</a>',
    "https://www.baitisraeli.co.il/375/",
  );

  assert.ok(links.map((l) => l.url).includes("https://www.baitisraeli.co.il/uploads/n/1768136590.7660.pdf"));
});

test("a parent-relative link is still resolved only as the browser would", () => {
  const links = linksFromMunicipalHtml(
    '<iframe src="../filebrowser/?folder=2"></iframe>',
    "https://example.muni.il/a/b/",
  );

  assert.deepEqual(links.map((l) => l.url), ["https://example.muni.il/a/filebrowser/?folder=2"]);
});

// The גוש עציון archive iframe carries no title, so it scores 0 and sorted last
// behind ordinary navigation links that consumed the whole crawl budget.
test("an untitled embedded archive outranks ordinary pages for the crawl budget", () => {
  const links = [
    { url: "https://x.muni.il/news/268/", text: "חדשות 2026", kind: "link", score: 4 },
    { url: "https://x.muni.il/tables-2026/", text: "טבלת מבחן הכנסה 2026", kind: "link", score: 4 },
    { url: "https://x.muni.il/filebrowser/?folder=361", text: "", kind: "embedded", score: 0 },
  ];

  assert.equal(
    municipalCrawlLinks(links, "https://x.muni.il", 2)[0].url,
    "https://x.muni.il/filebrowser/?folder=361",
  );
});

test("ordinary pages are still crawled when there is no embedded archive", () => {
  const links = [
    { url: "https://x.muni.il/arnona-2026/", text: "צו ארנונה 2026", kind: "link", score: 9 },
    { url: "https://x.muni.il/taxes/", text: "צווי מיסים", kind: "link", score: 5 },
  ];

  assert.deepEqual(municipalCrawlLinks(links, "https://x.muni.il", 2).map((l) => l.url), [
    "https://x.muni.il/arnona-2026/",
    "https://x.muni.il/taxes/",
  ]);
});

// חולון links its tax section as the bare word "ארנונה". Below the crawl
// threshold, the section — and the order inside it — was never entered.
test("a bare Arnona section link is followable", () => {
  assert.ok(municipalLinkScore("https://www.holon.muni.il/Residents/TaxesWater/Pages/default.aspx", "ארנונה", 2026) >= 4);
});

test("Arnona discount, form and appeal pages stay below the threshold", () => {
  assert.ok(municipalLinkScore("/x/", "הנחות בארנונה", 2026) < 4);
  assert.ok(municipalLinkScore("/x/", "טופס בקשה להנחה בארנונה", 2026) < 4);
  assert.ok(municipalLinkScore("/x/", "ערר על ארנונה", 2026) < 4);
  assert.ok(municipalLinkScore("/x/", "מכרז ארנונה 2026", 2026) < 4);
});

// חיפה links "ארנונה, מים ושירותים מקוונים" as "/#panel_3", an anchor into the
// page already fetched. It consumed one of only two depth-2 crawl slots.
test("an in-page anchor is not a separate crawl target", () => {
  const links = linksFromMunicipalHtml(
    '<a href="/#panel_3">ארנונה, מים ושירותים מקוונים</a><a href="/resident-service/arnona/">ארנונה</a>',
    "https://www.haifa.muni.il/",
  );

  assert.deepEqual(links.map((l) => l.url), [
    "https://www.haifa.muni.il/",
    "https://www.haifa.muni.il/resident-service/arnona/",
  ]);
});

test("a single-page-app hash route is still followed", () => {
  const links = linksFromMunicipalHtml(
    '<a href="/#/arnona/2026">צו ארנונה 2026</a>',
    "https://example.muni.il/",
  );

  assert.equal(links[0].url, "https://example.muni.il/#/arnona/2026");
});
