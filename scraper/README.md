# Arnona scraper

This scraper finds each Israeli local authority's official **צו ארנונה** (the annual
municipal property-tax order), pulls the tariff tables out of it with an LLM, checks
them, and writes the results as JSON into this repository's `data/` directory. The
website and API serve those same files.

```sh
cd scraper
npm install
node scrape-arnona.mjs --city tel-aviv --year 2026
```

## Why a scraper at all

Israel has no national Arnona tariff dataset.

- The **Central Bureau of Statistics (CBS)** publishes the official list of local
  authorities (municipalities, local councils and regional councils). We use it as the
  registry, but it has no rates.
- **data.gov.il** has only two Arnona datasets: a Haifa assessment-zone map and a
  Be'er Sheva business file.
- The **Ministry of Interior** publishes only the allowed yearly *increase* (for
  example 1.626% for 2026), never the rates.

The rates exist only in each authority's own צו ארנונה (sometimes called צו המיסים).
That is a PDF, approved the summer before and in force from January 1, and every
authority publishes it differently. A municipality's order is the legal source, so
each rate this scraper stores links back to the exact PDF it came from.

## How it works

For each authority and year, the scraper runs these steps:

1. **Discover** candidate PDFs on a ladder that starts with the cheapest rung.
2. **Validate** every candidate and keep only a complete, same-year, same-authority
   order.
3. **Read** the PDF into right-to-left text, falling back to OCR for scans.
4. **Extract** the tariff rows with an LLM, in small chunks.
5. **Check** the rows (sanity bands, year-over-year change, completeness), then write
   them or reject them.

### Discovery ladder

| Rung | Source | Cost |
| --- | --- | --- |
| 1 | `doc_url_template` with `{year}` filled in | free |
| 2 | Last year's winning URL with the year swapped (most authorities keep the path) | free |
| 3 | Crawl the official site: its own search, `index_urls`, and Arnona-looking pages one level deep, including embedded document browsers | free |
| 4 | LLM live web search for `<authority> צו ארנונה <year>`, the same search a person would run (optional) | one LLM call |
| 5 | Public web search (Brave, DuckDuckGo Lite, Bing), keeping official domains only | free, often bot-walled |

If an authority has no known site, rung 3 first tries conventional hostnames
(`<name>.muni.il`, `<name>.org.il`, `ma-<name>.org.il`, …). If none works, it takes the official
website link from the authority's Hebrew Wikipedia article. A site counts only if the
page itself names the authority: guessing from the URL alone once accepted an empty IIS
placeholder.

Every lead from search, an LLM or Wikipedia is treated as a hint, never as proof.

Whichever rung wins is saved to `scraper/state/registry.json` (`last_doc_url`,
`last_doc_year`, `site`). Next year then usually resolves on rung 1 or 2.

If no complete order exists for the requested year, the scraper tries two fallbacks:

- the order year already recorded for that authority;
- the nearest year the authority was actually seen publishing (some councils stopped
  publishing years ago).

A fallback order is always stored under **its own year**, never relabeled as the
requested year.

### Candidate validation

A PDF that downloads successfully is not yet a discovery. Each candidate must pass all
of these checks:

- **Year gate.** A URL or link text naming a different year is skipped before download.
  The order's own header must state the requested year.
- **Legal-order header.** The opening must identify a צו ארנונה / צו המיסים, not a
  tender, a discount form, a map, a budget or a news item.
- **Authority match.** The first pages must name the authority, through its Hebrew or
  English names, aliases, or `עיריית` / `מועצה מקומית` / `מועצה אזורית` variants. The
  one exception is a document served from the authority's own verified official site,
  which carries equally strong provenance (Judea and Samaria regional orders, for
  example, never name the council).
- **Completeness.** The document needs residential *and* non-residential sections and
  real rate pages.

When several candidates pass, the scraper chooses the largest complete one and
penalizes `draft`, `cleaned`, appendix, amendment and exemption filenames.

**OCR fallback.** If a PDF has no usable text layer, and both `pdftoppm` (poppler) and
`tesseract` (with `heb`) are installed, the pages are OCR'd locally. Without those
tools, scanned orders fail validation instead of producing guesses.

### Extraction and checks

Pages are rebuilt into right-to-left table lines and sent to the LLM in chunks of about
4,500 characters. The model must return one row for each printed rate, copied exactly
as printed (₪ per m² per year), together with zone, building type, size band, the
Hebrew label exactly as printed, and a confidence value. Answers are cached in
`scraper/cache/extract/`, so re-running costs nothing.

The scraper then checks the extraction at two levels.

**Document level.** Any of these failures rejects the extraction, and nothing is
written:

- the stated year is wrong;
- fewer than 3 rows were extracted;
- no residential rate;
- no office or commerce rate;
- a size band ends before it starts;
- more than 35% of rows are suspicious;
- a known matrix table has collapsed to a single column.

**Row level.** These problems are kept but flagged with `needs_review: true` and a
Hebrew `review_reason`:

- **Sanity bands.** A rate is outside a deliberately wide band for its category, for
  example residential 15–200 ₪/m². The bands catch decimal slips and column mix-ups,
  not policy.
- **Year-over-year check.** A rate moved more than ±25% against the same row in an
  earlier stored year. A real order moves by the ministry index plus a few approved
  percent.

An authority-year that still has flagged rows is retried automatically on the next run.

## Verified sources

Discovery is heuristic on purpose: it must reject drafts, appendices, discount
notices, other cities and other years without a human in the loop. Some genuine
orders defeat those rules — a title such as "הוראה בדבר ארנונה" or "החלטה על הטלת
מסים", a body that misprints the year, a PDF font that turns נ into "ð", a file listed
only inside a JavaScript file browser, an order published as web pages (נתניה, ראש
פינה), or an industrial council with no homes and therefore no residential rate.

When a person has opened the official document and checked it, record that in
`state/registry.json` on the authority's row:

```json
"verified_source": {
  "url": "https://…/צו-ארנונה-2026.pdf",
  "year": 2026,
  "format": "pdf | scanned_pdf | html",
  "extra_urls": ["…more chapter pages, html only"],
  "no_residential": true,
  "evidence": "what was checked: title, approval date, sample rates",
  "verified_at": "2026-10-07"
}
```

The scraper then skips discovery and the document-identity gates for that authority,
downloads the file (retrying the www/bare host and plain http, which some municipal
CDNs require), reads scans from page images, and still runs every rate-level check.
Rows are stored under the document's own year, so a 2025 or 2027 order is never
relabelled as 2026.

## Requirements

- **Node.js 20+.**
- **An LLM.** The first one available is used:
  1. `ANTHROPIC_API_KEY`: the Anthropic Messages API directly. The default model is
     `claude-opus-5-5`; override it with `ARNONA_MODEL`.
  2. The `claude` CLI (Claude Code), installed and logged in. It runs `claude -p` with
     no tools for extraction, and with only WebSearch/WebFetch for research.
  3. The `codex` CLI, installed and logged in. It runs `codex exec` in a read-only
     sandbox, with `--search` for research.

  Set `ARNONA_LLM=anthropic|claude|codex` to force a backend. If none is available,
  extraction stops with an explanation. `--discover-only` and `--show` need no LLM.
- **Optional: `pdftoppm` (poppler-utils) and `tesseract` with the `heb` language**,
  for scanned orders. On macOS: `brew install poppler tesseract tesseract-lang`. On
  Debian/Ubuntu: `apt install poppler-utils tesseract-ocr tesseract-ocr-heb`.

Copy `.env.example` to `.env` (it is gitignored) or export the variables yourself.

## Usage

All commands run from `scraper/`.

```sh
# One authority (key, Hebrew name or English alias), current year
node scrape-arnona.mjs --city tel-aviv
node scrape-arnona.mjs --city "פתח תקווה" --year 2026

# Check that discovery finds and validates the order: no LLM, writes nothing
node scrape-arnona.mjs --city tel-aviv --year 2026 --dry --discover-only

# Discover and extract, print a sample, write nothing
node scrape-arnona.mjs --city holon --year 2026 --dry

# Re-scrape a year that is already stored and clean
node scrape-arnona.mjs --city holon --year 2026 --force

# Print stored rates (all authorities, or one)
node scrape-arnona.mjs --show --year 2026
node scrape-arnona.mjs --show --city tel-aviv --year 2026

# Annual refresh of every authority whose source is already known
node scrape-arnona.mjs --year 2027

# Nationwide: sync the CBS registry, then scrape the next N authorities without rates
node scrape-arnona.mjs --national --batch 2
node scrape-arnona.mjs --national --plan --batch 10        # show the batch only
node scrape-arnona.mjs --national --batch 10 --retry-failed # only last-run failures
node scrape-arnona.mjs --sync-registry-only                # CBS registry only

# Offline wiring check, and the unit tests
node scrape-arnona.mjs --self-test
npm test
```

| Flag | Meaning |
| --- | --- |
| `--year N` | Tax year (default: the current year) |
| `--city X` | One authority, by key, Hebrew name or alias |
| `--dry` | Write nothing: no data, registry or run log |
| `--discover-only` | Stop after discovery and validation (needs `--dry`) |
| `--force` | Re-scrape even when a clean year is already stored |
| `--show` | Print stored rows and exit |
| `--national` | Sync the CBS registry and pick the next batch of authorities without rates |
| `--batch N` | Size of the national batch, 1–10 (default 2) |
| `--plan` | Print the selected targets and exit |
| `--retry-failed` | National mode: only authorities whose latest run failed |
| `--retry-before ISO` | National mode: one bounded retry sweep of runs before a cutoff |
| `--sync-registry-only` | Sync the CBS authority list into the registry and exit |
| `--quiet` | Less per-authority output |

National rotation retries a failed authority after 7 days, or after 1 day when only
discovery failed. Only one run can write at a time per checkout, enforced by a lock
file at `cache/.scrape.lock`.

Optional environment variables:

- `ARNONA_LIVE_RESEARCH=0`: skip discovery rung 4.
- `ARNONA_RELAY_URL` and `ARNONA_RELAY_TOKEN`: an HTTPS relay of your own for official
  PDFs that a municipality blocks from your network. Only already-trusted registry
  URLs are ever relayed.
- `ARNONA_USER_AGENT_CONTACT`: a contact string added to the User-Agent sent to
  Wikipedia.

## Data format

| Path | Contents |
| --- | --- |
| `data/tariffs/<year>/<city_key>.json` | Rows for one authority and year |
| `data/cities.json` | One entry per authority: `key, name, name_en, muni_name, site, source_url, source_year, years, tariff_count` |
| `data/meta.json` | `{synced_at, authorities, authorities_with_rates, tariffs}` |
| `scraper/state/registry.json` | Discovery state per authority: `aliases`, `index_urls`, `doc_url_template`, `last_doc_url`, `last_doc_year`, `active` |
| `scraper/state/national.json` | Last CBS registry snapshot and last national batch |
| `scraper/state/runs.jsonl` | One line per attempt: `city_key, year, source_year, status, doc_url, backend, rows, flagged, error, started_at, finished_at` |
| `scraper/cache/` | Downloaded PDFs and cached LLM answers (gitignored) |

Each tariff row has exactly these fields, in this order:

| Field | Meaning |
| --- | --- |
| `city_key` | Authority key (`tel-aviv`, `cbs-0031`, …) |
| `year` | The order's own tax year |
| `category_key` | `residential`, `office`, `commerce`, `industry`, `workshop`, `storage`, `parking`, `hotel`, `land`, `farm`, `public` or `other` |
| `category_label` | The order's own Hebrew classification, exactly as printed |
| `code` | סמל / classification number, or `null` |
| `zone` | אזור exactly as printed (`"1"`, `"4 ו-5"`, `"א"`); `null` means all zones |
| `building_type` | סוג בנין exactly as printed; `null` when the table has no such axis |
| `size_from`, `size_to` | Size band in m²; `null` means from 0 / unbounded |
| `rate_per_sqm` | **₪ per m² per year**, exactly as printed |
| `notes` | Free text, or `null` |
| `source_url` | The exact official PDF |
| `confidence` | `high`, `medium` or `low` (from the extraction) |
| `needs_review`, `review_reason` | Set by the sanity and year-over-year checks |
| `updated_at` | When the row was written |

`runs.jsonl` uses these status values:

- `ok`
- `skipped`
- `discovery_failed` (search or source access was incomplete, so it is worth retrying)
- `no_doc` (the official archive was checked and has no order for that year)
- `validation_failed` (PDFs were found but none is a complete order)
- `parse_failed`
- `extract_failed`

A scrape replaces that authority-year's file entirely. The previous version stays in
git history, and **reviewing the git diff is the human review step**. Hand corrections
to a stored year are overwritten by a later `--force` run, so re-check the diff after
forcing.

## Contributing

- **A municipality's order is the legal source.** Never type rates from news articles,
  search snippets, AI summaries, aggregator sites or memory. Every row must trace back
  to its `source_url`.
- **Flag uncertainty instead of guessing.** If a row is ambiguous, keep it with
  `needs_review: true` and a reason, or leave it out. A loud gap is better than a
  plausible wrong number.
- **To fix a discovery failure, change the source, not the data.** Add the official
  archive page to `index_urls`, or set `doc_url_template` (with `{year}`) or
  `last_doc_url` in `scraper/state/registry.json`, then re-run that authority.
- If you change the validation or discovery rules, add a regression test under `test/`
  for the case that motivated the change, then run `npm test`.
