import type { Metadata } from "next";
import { CATEGORIES } from "@/lib/data";

export const metadata: Metadata = { title: "API · Arnona Israel" };

const BASE = process.env.NEXT_PUBLIC_SITE_URL ?? "https://arnona-israel.vercel.app";

const examples: [string, string][] = [
  ["All rates for a city, newest year", "/api/v1/tariffs?city=tel-aviv&year=latest"],
  ["By Hebrew or English name", "/api/v1/tariffs?city=Jerusalem&category=office"],
  ["Several cities, one use, one year", "/api/v1/tariffs?city=jerusalem,ראשון לציון&category=residential&year=2026"],
  ["Text search inside the classification", "/api/v1/tariffs?q=בנקים&year=2026"],
  ["Everything as CSV (Excel-ready, UTF-8 BOM)", "/api/v1/tariffs?format=csv&include_flagged=true"],
  ["Authorities that have rates", "/api/v1/cities"],
  ["The full CBS registry (all 259 authorities)", "/api/v1/cities?all=true"],
  ["One authority + its latest rate book", "/api/v1/cities/petah-tikva"],
  ["Coverage, years, sync time", "/api/v1/meta"],
  ["OpenAPI 3 spec", "/api/v1/openapi.json"],
];

export default function Docs() {
  return (
    <article className="docs" dir="ltr">
      <h1>Public API</h1>
      <p className="lede">
        Free and read-only. No key, no sign-up, CORS open to every origin. Responses are cached at the edge
        for an hour. Base URL: <code>{BASE}</code>
      </p>

      <h2>Examples</h2>
      <ul className="examples">
        {examples.map(([label, path]) => (
          <li key={path}>
            <span>{label}</span>
            <a href={path}><code>GET {path}</code></a>
          </li>
        ))}
      </ul>

      <h2>GET /api/v1/tariffs</h2>
      <table className="params">
        <thead>
          <tr><th>Parameter</th><th>Meaning</th></tr>
        </thead>
        <tbody>
          <tr><td><code>city</code></td><td>City key (<code>tel-aviv</code>, <code>cbs-3000</code>), Hebrew or English name. Comma-separate for several.</td></tr>
          <tr><td><code>year</code></td><td>A year, comma-separated years, or <code>latest</code> (newest year available per city). Default: all years.</td></tr>
          <tr><td><code>category</code></td><td>Use category key(s), comma-separated — see below.</td></tr>
          <tr><td><code>zone</code></td><td>Exact tax zone as printed (<code>א</code>, <code>1</code>, …). Rows with no zone apply city-wide.</td></tr>
          <tr><td><code>q</code></td><td>Substring search in classification label, code, notes and building type.</td></tr>
          <tr><td><code>include_flagged</code></td><td><code>true</code> to include rows that failed an automatic sanity check (<code>needs_review</code>). Default false.</td></tr>
          <tr><td><code>format</code></td><td><code>json</code> (default) or <code>csv</code>.</td></tr>
          <tr><td><code>limit</code> / <code>offset</code></td><td>Paging for JSON. Default 1000, max 10000. Follow <code>next_offset</code>.</td></tr>
        </tbody>
      </table>

      <h2>Row fields</h2>
      <pre>{`{
  "city_key": "tel-aviv",
  "city_name": "תל אביב-יפו",
  "city_name_en": "Tel Aviv - Yafo",
  "year": 2026,
  "category_key": "office",            // normalised use, see below
  "category_label": "משרדים, שירותים ומסחר", // classification exactly as printed
  "code": "301",                       // סמל, when printed
  "zone": "1",                         // null = all zones
  "building_type": null,               // סוג בנין (e.g. Tel Aviv's construction-era classes)
  "size_from": null, "size_to": null,  // m² band; null = open-ended
  "rate_per_sqm": 449.78,              // ₪ per m² per YEAR, as printed
  "rate_per_sqm_monthly": 37.48,       // convenience: annual ÷ 12
  "notes": null,
  "source_url": "https://…/צו הארנונה לשנת 2026.pdf",
  "confidence": "high",
  "needs_review": false,
  "review_reason": null,
  "updated_at": "2026-08-04T10:15:45Z"
}`}</pre>

      <h2>Use categories</h2>
      <table className="params">
        <tbody>
          {CATEGORIES.map((c) => (
            <tr key={c.key}><td><code>{c.key}</code></td><td>{c.en} · {c.he}</td></tr>
          ))}
        </tbody>
      </table>

      <h2>How to compute a bill</h2>
      <p>
        Annual Arnona = area (m²) × <code>rate_per_sqm</code> of the row matching the property&apos;s use,
        zone, building class and size band. Many cities apply size bands to the whole area (not marginally) —
        read the order&apos;s wording in <code>notes</code> and at <code>source_url</code>. Discounts
        (הנחות) are personal and not included.
      </p>

      <h2>Data & licence</h2>
      <p>
        Rates are extracted automatically from each local authority&apos;s official annual order (צו ארנונה)
        and validated deterministically (year, core sections, sanity bands, year-over-year movement). The
        order linked in <code>source_url</code> is always the legal source. Code is MIT; the dataset is CC BY
        4.0. The raw JSON lives in the <a href="https://github.com/mikey641/arnona-israel/tree/main/data">data/</a> folder
        on GitHub, together with the open-source scraper that produces it.
      </p>
    </article>
  );
}
