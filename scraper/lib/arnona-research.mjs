// Optional last-resort discovery rung: ask an LLM with live web search to run the
// plain Hebrew search a person would run, and report the official order it finds.
//
// WHY THIS EXISTS: many servers cannot use public search engines at all — Brave
// answers datacenter IPs with 429, and DuckDuckGo, Bing, Google, Mojeek, Startpage
// and Marginalia answer with a bot challenge. The deterministic ladder (configured
// source → conventional host → open directory → crawl) covers most authorities, but
// it can only find sites whose address is derivable. חורפיש publishes on lch.org.il,
// which no naming rule or directory reaches; one search finds it in seconds and also
// establishes that the council published nothing after 2022, which turns a vague
// "no verified site" into a justified no_doc.
//
// TRUST: this is the LAST resort, used only when every cheaper path found nothing,
// and it is skipped entirely when ARNONA_LIVE_RESEARCH=0 or no LLM backend is
// available. The answer is a LEAD, never an authority: whatever it returns still
// passes the scraper's own provenance, authority-identity, year and full-order
// audits before a single rate is stored.

import { runLlmText } from "./llm.mjs";

const RESEARCH_SYSTEM = "You are a careful research assistant. You search the web for official "
  + "Israeli municipal documents and answer with a single line of JSON.";

export function arnonaResearchPrompt(city, year) {
  const authority = city.muni_name || city.name;
  return `חפש באינטרנט: ${city.name} צו ארנונה ${year}

מצא את צו הארנונה (או "צו המיסים") הרשמי והמלא של ${authority} לשנת ${year}.

חשוב: אל תנחש כתובות דומיין ואל תנסה לפתוח דומיינים משוערים. הכתובת של אתר הרשות
לרוב אינה נגזרת מהשם (לדוגמה חורפיש מפרסמת ב-lch.org.il). אתר הרשות צריך להגיע
מתוך תוצאות החיפוש עצמן. אם החיפוש הראשון לא מצא, חפש "${city.name} מועצה אתר רשמי"
או "${authority}" ואז אתר בו את עמוד הארנונה/צווי המיסים.

אם אין צו לשנת ${year}, החזר את השנה הרשמית הקרובה ביותר שכן קיימת, וציין ב-note
אילו שנים כן מופיעות באתר.
אל תחזיר כתבת חדשות, טופס הנחה, מכרז, מפה, מצגת או מסמך של רשות אחרת.

ענה רק JSON בשורה אחת:
{"found":true/false,"site":"כתובת האתר הרשמי או null","document_urls":["כתובת PDF ישירה"],"year":${year},"note":"ראיה קצרה"}`;
}

function httpUrlsFrom(value) {
  const out = [];
  for (const raw of Array.isArray(value) ? value : [value]) {
    if (typeof raw !== "string") continue;
    const url = raw.trim();
    if (/^https?:\/\/\S+$/i.test(url)) out.push(url);
  }
  return out;
}

/** Read the agent's answer without trusting it: only well-formed http(s) URLs survive. */
export function parseArnonaResearchAnswer(text) {
  const body = String(text ?? "");
  // The CLI often wraps the object in prose; take the widest balanced-looking span.
  const match = body.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let payload;
  try { payload = JSON.parse(match[0]); } catch { return null; }
  if (!payload || typeof payload !== "object") return null;

  const documentUrls = [...new Set([
    ...httpUrlsFrom(payload.document_url),
    ...httpUrlsFrom(payload.document_urls),
  ])];
  const [site] = httpUrlsFrom(payload.site);
  const year = Number.isInteger(payload.year) ? payload.year : null;

  return {
    found: payload.found === true,
    site: site ?? null,
    documentUrls,
    year,
    note: typeof payload.note === "string" ? payload.note : "",
  };
}

async function runResearchLlm(prompt) {
  const { text } = await runLlmText({
    system: RESEARCH_SYSTEM, prompt, web: true, maxTokens: 8_000, timeoutMs: 6 * 60_000,
  });
  return text;
}

/**
 * @returns {Promise<{found: boolean, site: string|null, documentUrls: string[], year: number|null, note: string} | null>}
 */
export async function researchArnonaSource(city, year, { runCli = runResearchLlm, log } = {}) {
  try {
    const answer = parseArnonaResearchAnswer(await runCli(arnonaResearchPrompt(city, year)));
    if (!answer) return null;
    log?.(`    · live-search lead: ${answer.documentUrls.length} document URL(s)`
      + `${answer.site ? " and an official site" : ""}${answer.note ? ` — ${answer.note.slice(0, 160)}` : ""}`);
    return answer;
  } catch (error) {
    log?.(`    · live-search unavailable (${String(error?.message ?? error).slice(0, 120)})`);
    return null;
  }
}
