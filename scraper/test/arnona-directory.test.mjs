import assert from "node:assert/strict";
import test from "node:test";
import {
  municipalDirectoryTitles,
  officialSiteFromDirectoryLinks,
  resolveMunicipalSiteFromDirectory,
} from "../lib/arnona-directory.mjs";

const city = (over = {}) => ({
  name: "נצרת",
  muni_name: "עיריית נצרת",
  aliases: ["Nazareth"],
  ...over,
});

test("a city article title is tried before any council wording", () => {
  assert.equal(municipalDirectoryTitles(city())[0], "נצרת");
});

test("a regional council is looked up under its full council title", () => {
  const titles = municipalDirectoryTitles(city({
    name: "משגב",
    muni_name: "מועצה אזורית משגב",
  }));

  assert.equal(titles[0], "מועצה אזורית משגב");
  assert.ok(titles.includes("משגב"));
});

test("a local council keeps the bare name first and the council title as a fallback", () => {
  const titles = municipalDirectoryTitles(city({
    name: "שלומי",
    muni_name: "מועצה מקומית שלומי",
  }));

  assert.equal(titles[0], "שלומי");
  assert.ok(titles.includes("מועצה מקומית שלומי"));
});

// The authoritative registry and Wikipedia disagree on optional yod spelling
// ("נהרייה" vs "נהריה"), which silently lost 61 authorities in the coverage probe.
test("optional-yod spelling variants are tried so registry names still match Wikipedia", () => {
  const titles = municipalDirectoryTitles(city({ name: "נהרייה", muni_name: "עיריית נהרייה" }));

  assert.ok(titles.includes("נהריה"), `expected a collapsed-yod variant, got ${titles.join(", ")}`);
});

test("registry spacing around a hyphen is normalised for the article title", () => {
  const titles = municipalDirectoryTitles(city({ name: "תל אביב -יפו", muni_name: "עיריית תל אביב -יפו" }));

  assert.ok(titles.includes("תל אביב-יפו"), `got ${titles.join(", ")}`);
});

test("an official municipal host is preferred over other external links", () => {
  const site = officialSiteFromDirectoryLinks([
    "https://he.wikipedia.org/wiki/x",
    "https://www.facebook.com/nazareth",
    "http://www.nazareth.muni.il/",
  ], city());

  assert.equal(site, "http://www.nazareth.muni.il/");
});

// Wikidata listed the community centre for דימונה; a directory hit is a lead, never proof.
test("community-centre and other non-authority hosts are rejected", () => {
  const site = officialSiteFromDirectoryLinks([
    "https://www.matnas-dimona.org.il/",
    "https://www.dimona.muni.il/",
  ], city({ name: "דימונה", muni_name: "עיריית דימונה", aliases: ["Dimona"] }));

  assert.equal(site, "https://www.dimona.muni.il/");
});

test("an archived snapshot is never offered as the official site", () => {
  const site = officialSiteFromDirectoryLinks([
    "https://archive.qbialik.org.il/",
    "https://web.archive.org/web/http://qbialik.org.il/",
  ], city({ name: "קריית ביאליק", muni_name: "עיריית קריית ביאליק", aliases: ["Kiryat Bialik"] }));

  assert.equal(site, null);
});

test("no usable external link resolves to null rather than a guess", () => {
  assert.equal(officialSiteFromDirectoryLinks(["https://he.wikipedia.org/wiki/x"], city()), null);
});

// Every Hebrew Wikipedia article carries National Library authority-control links,
// and accepting any .org.il host made those beat the real site for four authorities
// in one batch (גוש עציון, גן רווה, גני תקווה, דאלית אל-כרמל).
test("National Library authority-control links are never an official site", () => {
  const site = officialSiteFromDirectoryLinks([
    "https://www.nli.org.il/he/authorities/987007312187105171",
    "https://www.nli.org.il/he/a-topic/987007538070805171",
  ], city({ name: "גוש עציון", muni_name: "מועצה אזורית גוש עציון", aliases: ["Gush Etzion"] }));

  assert.equal(site, null);
});

test("an unrelated broadcaster page is never an official site", () => {
  const site = officialSiteFromDirectoryLinks([
    "https://www.kan.org.il/podcast/program.aspx/?progid=2042",
  ], city({ name: "גני תקווה", muni_name: "עיריית גני תקווה", aliases: ["Ganei Tikva"] }));

  assert.equal(site, null);
});

test("an .org.il host matching the authority's own name is still accepted", () => {
  const site = officialSiteFromDirectoryLinks([
    "https://www.nli.org.il/he/authorities/1",
    "https://www.ganrave.org.il/",
  ], city({ name: "גן רווה", muni_name: "מועצה אזורית גן רווה", aliases: ["Gan Rave"] }));

  assert.equal(site, "https://www.ganrave.org.il/");
});

test("the declared official website is preferred over any external link", async () => {
  const result = await resolveMunicipalSiteFromDirectory(
    city({ name: "גני תקווה", muni_name: "עיריית גני תקווה", aliases: ["Ganei Tikva"] }),
    {
      fetchJson: async (url) => {
        if (url.includes("ppprop=wikibase_item")) {
          return { query: { pages: { 1: { pageprops: { wikibase_item: "Q2920123" } } } } };
        }
        if (url.includes("wbgetclaims")) {
          return { claims: { P856: [{ mainsnak: { datavalue: { value: "http://www.ganeytikva.org.il" } } }] } };
        }
        return { query: { pages: { 1: { extlinks: [{ "*": "https://www.kan.org.il/podcast/" }] } } } };
      },
    },
  );

  assert.equal(result.site, "http://www.ganeytikva.org.il");
  assert.equal(result.source, "wikidata:P856");
});

// דבורייה publishes on dabburiya.net and דאלית אל-כרמל on mdec.co.il — neither is a
// .il municipal host nor guessable from the name, so the declared property must not
// be filtered by the naming rules that guard raw external links.
test("a declared official website outside the .il municipal namespace is kept", async () => {
  const result = await resolveMunicipalSiteFromDirectory(
    city({ name: "דבורייה", muni_name: "מועצה מקומית דבורייה", aliases: ["Daburiyya"] }),
    {
      fetchJson: async (url) => {
        if (url.includes("ppprop=wikibase_item")) {
          return { query: { pages: { 1: { pageprops: { wikibase_item: "Q2915531" } } } } };
        }
        if (url.includes("wbgetclaims")) {
          return { claims: { P856: [{ mainsnak: { datavalue: { value: "http://www.dabburiya.net/" } } }] } };
        }
        return { query: { pages: {} } };
      },
    },
  );

  assert.equal(result.site, "http://www.dabburiya.net/");
});

test("a declared website that is an archive or social page is still rejected", async () => {
  const result = await resolveMunicipalSiteFromDirectory(city(), {
    fetchJson: async (url) => {
      if (url.includes("ppprop=wikibase_item")) {
        return { query: { pages: { 1: { pageprops: { wikibase_item: "Q1" } } } } };
      }
      if (url.includes("wbgetclaims")) {
        return { claims: { P856: [{ mainsnak: { datavalue: { value: "https://www.facebook.com/nazareth" } } }] } };
      }
      return { query: { pages: {} } };
    },
  });

  assert.equal(result, null);
});

test("the directory resolves a site without any search engine", async () => {
  const calls = [];
  const result = await resolveMunicipalSiteFromDirectory(city(), {
    fetchJson: async (url) => {
      calls.push(url);
      return {
        query: {
          pages: {
            1: { extlinks: [{ "*": "http://www.nazareth.muni.il/" }] },
          },
        },
      };
    },
  });

  assert.equal(result.site, "http://www.nazareth.muni.il/");
  assert.equal(result.source, "he.wikipedia");
  assert.equal(result.title, "נצרת");
  assert.ok(calls[0].includes("he.wikipedia.org"), calls[0]);
  assert.ok(calls[0].includes("redirects=1"), "must follow Wikipedia redirects");
});

test("a missing article falls through to the next title instead of failing", async () => {
  const seen = [];
  const result = await resolveMunicipalSiteFromDirectory(
    city({ name: "משגב", muni_name: "מועצה אזורית משגב", aliases: ["Misgav"] }),
    {
      fetchJson: async (url) => {
        seen.push(decodeURIComponent(url));
        if (seen.length === 1) return { query: { pages: { "-1": { missing: "" } } } };
        return { query: { pages: { 2: { extlinks: [{ "*": "https://www.misgav.org.il/" }] } } } };
      },
    },
  );

  assert.equal(result.site, "https://www.misgav.org.il/");
  assert.equal(seen.length, 2);
});

// Wikipedia's search returned "ביתר עילית" for מודיעין עילית, which would have
// handed one authority another authority's municipal site.
test("the search fallback refuses an article about a different authority", async () => {
  const result = await resolveMunicipalSiteFromDirectory(
    city({ name: "מודיעין עילית", muni_name: "עיריית מודיעין עילית", aliases: ["Modi'in Illit"] }),
    {
      fetchJson: async (url) => {
        if (url.includes("list=search")) {
          return { query: { search: [{ title: "ביתר עילית" }] } };
        }
        if (url.includes("wbgetclaims")) {
          return { claims: { P856: [{ mainsnak: { datavalue: { value: "http://www.betar-illit.muni.il/" } } }] } };
        }
        if (url.includes("ppprop=wikibase_item")) return { query: { pages: { "-1": { missing: "" } } } };
        return { query: { pages: { "-1": { missing: "" } } } };
      },
    },
  );

  assert.equal(result, null);
});

// Searching קריית טבעון returned the town library, whose declared website is
// tivon-lib.co.il. Merely containing the authority's name is not enough.
test("the search fallback refuses an institution that merely contains the name", async () => {
  const result = await resolveMunicipalSiteFromDirectory(
    city({ name: "קריית טבעון", muni_name: "מועצה מקומית קריית טבעון", aliases: ["Qiryat Tiv'on"] }),
    {
      fetchJson: async (url) => {
        if (url.includes("list=search")) return { query: { search: [{ title: "ספריית קריית טבעון" }] } };
        if (url.includes("wbgetclaims")) {
          return { claims: { P856: [{ mainsnak: { datavalue: { value: "https://tivon-lib.co.il/" } } }] } };
        }
        return { query: { pages: { "-1": { missing: "" } } } };
      },
    },
  );

  assert.equal(result, null);
});

test("the search fallback accepts an article that names the authority", async () => {
  const result = await resolveMunicipalSiteFromDirectory(
    city({ name: "פקיעין", muni_name: "מועצה מקומית פקיעין", aliases: ["Peki'in"] }),
    {
      fetchJson: async (url) => {
        if (url.includes("list=search")) {
          return { query: { search: [{ title: "פקיעין (בוקייעה)" }] } };
        }
        if (url.includes("wbgetclaims")) {
          return { claims: { P856: [{ mainsnak: { datavalue: { value: "https://www.peqiin.muni.il/" } } }] } };
        }
        if (url.includes("ppprop=wikibase_item") && url.includes("%D7%91%D7%95%D7%A7")) {
          return { query: { pages: { 1: { pageprops: { wikibase_item: "Q123" } } } } };
        }
        return { query: { pages: { "-1": { missing: "" } } } };
      },
    },
  );

  assert.equal(result.site, "https://www.peqiin.muni.il/");
});

test("a directory outage returns null instead of throwing", async () => {
  const result = await resolveMunicipalSiteFromDirectory(city(), {
    fetchJson: async () => { throw new Error("network"); },
  });

  assert.equal(result, null);
});
