# Arnona Israel · ארנונה ישראל

**Every Israeli municipal Arnona (property tax) rate, per m², per use, zone and year — as an open
table, a free public API, and the open-source scraper that builds it.**

🌐 **Site:** https://arnona-israel.vercel.app · 📖 **API docs:** https://arnona-israel.vercel.app/docs

Israel has no national Arnona dataset. The Ministry of Interior publishes only the allowed yearly
*increase*; the actual rates live in each of the ~259 local authorities' annual tax order
(צו ארנונה) — usually a PDF on the municipality's website, in a different format every time.
This project finds those official orders, extracts every tariff row, validates it, and publishes
the result with a link back to the exact source document.

| | |
|---|---|
| Authorities with rates | see [`/api/v1/meta`](https://arnona-israel.vercel.app/api/v1/meta) |
| Unit | ₪ per m² per **year**, exactly as printed in the order |
| Grain | authority × year × classification × zone × building class × size band |
| Source | every row has `source_url` → the official order PDF |

## Public API

Free, read-only, no key, CORS open. Full reference: [/docs](https://arnona-israel.vercel.app/docs) ·
[OpenAPI](https://arnona-israel.vercel.app/api/v1/openapi.json).

```sh
# Tel Aviv, newest year, offices
curl 'https://arnona-israel.vercel.app/api/v1/tariffs?city=tel-aviv&year=latest&category=office'

# Hebrew or English names work
curl 'https://arnona-israel.vercel.app/api/v1/tariffs?city=ירושלים&category=residential&year=2026'

# Everything, as Excel-ready CSV
curl -o arnona.csv 'https://arnona-israel.vercel.app/api/v1/tariffs?format=csv'

# Which authorities are covered
curl 'https://arnona-israel.vercel.app/api/v1/cities'
```

Categories: `residential`, `office`, `commerce`, `industry`, `workshop`, `storage`, `parking`,
`hotel`, `land`, `farm`, `public`, `other`. The original Hebrew classification is always kept in
`category_label`, and the printed code (סמל) in `code`.

## Raw data

Plain JSON in [`data/`](data/) — no database needed:

- `data/cities.json` — all local authorities (CBS registry) with their latest official order
- `data/tariffs/<year>/<city_key>.json` — tariff rows for one authority-year
- `data/meta.json` — coverage counts and sync time

Data is CC BY 4.0 ([data/LICENSE.md](data/LICENSE.md)). Code is MIT.

## The scraper

[`scraper/`](scraper/) is the pipeline that discovers each authority's official order, verifies it
is the complete final order for the requested year (not a draft, appendix, news item or the wrong
city), extracts rows with an LLM, runs deterministic sanity and year-over-year checks, and writes
`data/`. See [scraper/README.md](scraper/README.md).

```sh
cd scraper && npm install
node scrape-arnona.mjs --city tel-aviv --year 2026 --dry --discover-only   # find the order
node scrape-arnona.mjs --city tel-aviv --year 2026                          # extract + write data/
```

## Run the site locally

```sh
npm install
npm run dev        # http://localhost:3000
npm run validate   # structural check of data/
npm test
```

The site is a small Next.js app (`app/`) that reads `data/` at build time and serves the API from
memory. Deployed on Vercel's free tier at `arnona-israel.vercel.app` — no custom domain needed.

## Contributing

A municipality's order is the legal source: if a row is wrong, open an issue or PR with the page
of the official order that shows the correct value. Prefer flagging uncertainty
(`needs_review`) over guessing. Rates are informational — always confirm with the authority
before relying on them for billing, and remember personal discounts (הנחות) are not included.
