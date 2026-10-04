import assert from "node:assert/strict";
import test from "node:test";
import {
  arnonaResearchPrompt,
  parseArnonaResearchAnswer,
  researchArnonaSource,
} from "../lib/arnona-research.mjs";

const city = (over = {}) => ({
  name: "חורפיש",
  muni_name: "מועצה מקומית חורפיש",
  aliases: ["Hurfeish"],
  ...over,
});

test("the prompt asks the plain Hebrew question a person would type", () => {
  const prompt = arnonaResearchPrompt(city(), 2026);
  assert.match(prompt, /חורפיש צו ארנונה 2026/);
  assert.match(prompt, /מועצה מקומית חורפיש/);
});

test("a JSON answer surrounded by prose is still read", () => {
  const answer = parseArnonaResearchAnswer(`בדקתי את האתר.
    {"found":true,"site":"https://www.lch.org.il/he/66/","document_url":"https://www.lch.org.il/uploads/n/1665043210.5674.pdf","year":2022,"note":"רק 2019-2022"}
    זה הכל.`);

  assert.equal(answer.site, "https://www.lch.org.il/he/66/");
  assert.deepEqual(answer.documentUrls, ["https://www.lch.org.il/uploads/n/1665043210.5674.pdf"]);
  assert.equal(answer.year, 2022);
});

test("multiple document URLs are collected and deduplicated", () => {
  const answer = parseArnonaResearchAnswer(
    '{"found":true,"document_url":"https://a.muni.il/x.pdf","document_urls":["https://a.muni.il/x.pdf","https://a.muni.il/y.pdf"]}',
  );

  assert.deepEqual(answer.documentUrls, ["https://a.muni.il/x.pdf", "https://a.muni.il/y.pdf"]);
});

// The agent is a lead generator, never an authority: anything it returns still has
// to survive the scraper's own provenance, year and full-order audits.
test("non-http answers are discarded rather than passed to the downloader", () => {
  const answer = parseArnonaResearchAnswer(
    '{"found":true,"site":"ftp://x","document_urls":["javascript:alert(1)","/relative.pdf","https://ok.muni.il/a.pdf"]}',
  );

  assert.equal(answer.site, null);
  assert.deepEqual(answer.documentUrls, ["https://ok.muni.il/a.pdf"]);
});

test("an answer with no JSON at all is not invented into a result", () => {
  assert.equal(parseArnonaResearchAnswer("לא הצלחתי למצוא"), null);
  assert.equal(parseArnonaResearchAnswer(""), null);
});

test("a not-found answer still reports its note so no_doc can be justified", () => {
  const answer = parseArnonaResearchAnswer('{"found":false,"note":"האתר מכיל רק 2019-2022"}');

  assert.equal(answer.found, false);
  assert.deepEqual(answer.documentUrls, []);
  assert.match(answer.note, /2019-2022/);
});

test("the researcher returns the parsed lead from the CLI", async () => {
  const seen = [];
  const result = await researchArnonaSource(city(), 2026, {
    runCli: async (prompt) => {
      seen.push(prompt);
      return '{"found":true,"site":"https://www.lch.org.il","document_urls":["https://www.lch.org.il/a.pdf"],"year":2026}';
    },
  });

  assert.equal(result.site, "https://www.lch.org.il");
  assert.equal(seen.length, 1);
  assert.match(seen[0], /חורפיש/);
});

test("a failing CLI degrades to null instead of failing the authority", async () => {
  const result = await researchArnonaSource(city(), 2026, {
    runCli: async () => { throw new Error("llm unavailable"); },
  });

  assert.equal(result, null);
});

test("a CLI that answers with nothing usable degrades to null", async () => {
  const result = await researchArnonaSource(city(), 2026, { runCli: async () => "   " });
  assert.equal(result, null);
});

// The first live run spent its whole budget probing guessed hostnames
// (www.hurfeish.muni.il) instead of reading search results, and missed lch.org.il.
test("the prompt forbids guessing domains and names the counter-example", () => {
  const prompt = arnonaResearchPrompt(
    { name: "חורפיש", muni_name: "מועצה מקומית חורפיש" },
    2026,
  );

  assert.match(prompt, /אל תנחש כתובות דומיין/);
  assert.match(prompt, /lch\.org\.il/);
  assert.match(prompt, /אתר רשמי/);
});
