# S.Mart Retail AI

An SAP CAP application that takes a real **SAP Customer Checkout** export from the S.Mart
Walldorf autonomous store, enriches it into a six-store network, runs six retail AI scenarios
over it, and surfaces the results through SAP Fiori dashboards on SAP HANA Cloud.

The Walldorf numbers are the real exported figures. Everything else is synthesized *from* them —
the hour-of-day and day-of-week demand curve, the article mix, the cancellation rates per terminal
type and the payment split are all measured from the export and replayed against stores with
different sizes, opening hours and catchments.

---

## What the source data is

Two `CompleteSalesReport` workbooks exported from SAP Customer Checkout, covering the S.Mart
store on the SAP campus in Walldorf — a 24/7 autonomous shop where entry is by QR code from the
S.Mart Grocery App and RFID plus the `payfree` gate replaces the till.

| | |
|---|---|
| Period | 1 Jan 2026 – 3 Jul 2026 (179 trading days) |
| Receipts | 2,550 |
| Gross / net revenue | €10,588.86 / €9,563.36 |
| Units | 6,452 across 327 articles in 63 article groups |
| Terminals | `PF02` payfree autonomous gate (1,664 receipts), `SM01` self-checkout (830), `MOB1` mobile (56) |
| Cancellations | **3,217 events worth €5,830.73** — more voided value than a third of completed sales |
| Tax | German 19% / 7% bands |

The ETL reconciles exactly against SAP's own totals; see `data/canonical/manifest.json`.

That cancellation figure is the reason this project exists. At a staffed till a voided line means
a change of mind. At an unstaffed RFID gate it usually means something went wrong — and nobody is
standing there to notice.

## The six scenarios

Each engine is a pure function in `srv/lib/engines/`, used both by the build pipeline and by the
service's live `recalculate` action, so the seeded rows and a live re-run cannot drift apart.

| # | Scenario | What it does | Signal it keys on |
|---|---|---|---|
| 1 | **Demand forecast** | Hourly forecast per store and article, with prediction intervals | Level × hour-of-day share × day-of-week factor, learned from the export |
| 2 | **Checkout integrity** | Flags RFID misreads, absent tags, stock variance and price errors | Cancellation rate vs the article's own network baseline, plus value at risk |
| 3 | **Replenishment** | Reorder proposals sized to lead-time demand plus safety stock | Counted stock, forecast demand, supplier lead time and reliability |
| 4 | **Fresh waste & markdown** | Picks the discount depth that recovers the most margin | Projected waste before expiry, swept against a constant-elasticity demand response |
| 5 | **Basket affinity** | Association rules; flags pairs split across temperature zones | Support, confidence and lift over reconstructed baskets |
| 6 | **Personalisation** | Next best offer per consenting app customer | Purchase cadence (routine) and affinity lift (discovery) |

Plus **cold chain** monitoring over the chiller probes, and a **unified insight feed** that ranks
every scenario in one queue by euros at stake weighted by model confidence.

### Two things the engines found in the real data

- **`Sunny Bites Banana Chips` — price error, €635.94.** 7 cancellation events covering 20 units
  for €635.94 implies €31.80 a unit against a master price of a few euros. That is a master-data
  or shelf-label fault, not theft, and the engine says so.
- **`Leergut 0,25 EUR` — tag absent, €126.90.** Deposit returns are the single most-cancelled line
  at the autonomous gate (508 events). Empty bottles cannot carry an RFID tag, so every deposit
  return is a fight with a gate designed around tags.

Neither was planted. Both fall out of the rules described above.

---

## Running it

```bash
npm install
npm run deploy:local      # build the SQLite database from db/data
npm start                 # http://localhost:4004
```

Open <http://localhost:4004/index.html>. Development uses CAP's mocked authentication — sign in as
`manager` / `manager` (or `analyst`, `viewer`).

### Rebuilding the dataset from the SAP export

```bash
npm run pipeline          # etl -> synthesize -> build:ai
```

Three stages, each independently runnable:

| Stage | Command | What it does |
|---|---|---|
| 1. Extract | `npm run etl` | Parses the report workbooks into tidy CSVs in `data/canonical/` |
| 2. Synthesize | `npm run synthesize` | Builds the store network and all fact tables into `db/data/` |
| 3. Score | `npm run build:ai` | Runs the six engines and writes the AI entity CSVs |

The whole pipeline is reproducible byte for byte: stage 2 is seeded, and stage 3
stamps its output from the last observed business date rather than from the
clock. CI re-runs it and fails if the committed CSVs no longer match.

#### Loading a new export

A fresh export can be merged into what is already there instead of replacing it:

```bash
cp CompleteSalesReport_July.xlsx data/source/
npm run etl:incremental
```

Not every table merges the same way, and the difference matters:

- **`hourly_sales` is a fact table** - one row per article per trading hour. New
  days are added; an hour that appears in both exports is superseded by the
  later one, on the assumption that a re-export is a correction.
- **Everything else is a summary of the reported period.** `articles` is units
  and revenue per article across the whole window, not per day, so two
  overlapping exports cannot be added together without double-counting. The
  wider export replaces the narrower one, and a narrower one is left alone.

Each workbook is recorded in `data/canonical/manifest.json` with a content hash
and the date range it covered, so re-running over unchanged files does nothing
and you can see which export contributed what. `--force` re-ingests anyway;
merging is idempotent, so that is safe.

### Tests

```bash
npm test                  # 61 tests: the engines, and the OData services
npm run test:etl          # the incremental merge
npm run test:ui           # loads every page in Chromium, needs a running server
```

`npm test` covers the engines on hand-built fixtures and the services through
`cds.test`, which boots CAP in-process against a throwaway database. The service
tests are where the projections, the role enforcement, the queue actions and the
audit trail are pinned down - none of which the engine tests can see.

---

## The dashboards

| App | Template | Covers |
|---|---|---|
| **AI Command Centre** | Self-contained HTML/SVG | KPI tiles, trading pattern, integrity breakdown, ranked insight feed, one-click engine re-run |
| Checkout Integrity Radar | Fiori elements List Report + Object Page | Scenario 2, with the evidence behind every alert |
| Replenishment Cockpit | Fiori elements | Scenario 3 |
| Fresh Waste Guard | Fiori elements | Scenario 4 |
| Demand Forecast | Fiori elements | Scenario 1 |
| Basket Affinity & Planogram | Fiori elements | Scenario 5 |
| Personalised Offers | Fiori elements | Scenario 6 |
| Cold Chain Monitor | Fiori elements | Temperature excursions |
| AI Insight Feed | Fiori elements | All scenarios in one queue |

The Fiori elements apps are annotation-driven — the UI is defined in `srv/annotations/`, not in
app code — and bootstrap SAPUI5 from `https://ui5.sap.com`, so they need that host to be
reachable.

**The AI Command Centre deliberately has no external dependency.** It renders its own charts in
SVG and loads no script, font or stylesheet from anywhere, so it works in an air-gapped
environment where the SAPUI5 CDN is blocked. Its charts use a palette validated for
colour-vision deficiency, every chart has a table view, and severity is always carried by a text
label rather than by colour alone.

---

## Architecture

```
db/          CDS model  — schema.cds (operational), ai-schema.cds (scenario output)
             db/data/   — the generated dataset CAP deploys
srv/         Services   — analytics-service (read-only aggregates), ai-service (scenarios + actions)
             lib/engines/ — the six engines, as pure functions
             annotations/ — Fiori elements UI definitions
app/         Launchpad, the command centre, and eight Fiori elements apps
tools/       The three pipeline stages
data/source/ The SAP Customer Checkout exports, unmodified
```

### Services

`AnalyticsService` at `/analytics` exposes the operational data plus pre-aggregated daily, hourly,
article-performance and channel-mix views. `AIService` at `/ai` exposes the scenario output, the
queue actions (`acknowledge`, `resolveAlert`, `releaseOrder`, `applyMarkdown`, `dismiss`) and three
unbound actions:

```bash
# Re-run one scenario, or all of them when scenario is omitted
curl -u manager:manager -X POST localhost:4004/ai/recalculate \
  -H 'Content-Type: application/json' -d '{"scenario":"COLD_CHAIN"}'

# Forecast one article without persisting anything
curl -u manager:manager -X POST localhost:4004/ai/simulateForecast \
  -H 'Content-Type: application/json' \
  -d '{"store_ID":"WDF01","article_ID":"AR90013","horizonHours":8}'

# Score a candidate markdown depth against doing nothing
curl -u manager:manager -X POST localhost:4004/ai/simulateMarkdown \
  -H 'Content-Type: application/json' \
  -d '{"store_ID":"WDF01","article_ID":"AR00245","discountPct":30}'
```

---

## Deploying to SAP HANA Cloud

See [`docs/hana-deployment.md`](docs/hana-deployment.md) for the full walkthrough. In short:

```bash
npm run build                       # generates gen/db (30 .hdbtable + seed .hdbtabledata) and gen/srv
cf create-service hana hdi-shared smartstore-db
npm run deploy:hana                 # or: mbt build && cf deploy mta_archives/*.mtar
```

`mta.yaml` and `xs-security.json` describe the full Cloud Foundry deployment: the CAP service, the
HDI deployer, the static UI module, an HDI container and an XSUAA instance with Viewer, Analyst and
StoreManager roles.

---

## Honest notes on the models

- **Forecast accuracy is reported as WAPE, not MAPE.** Hourly SKU demand here is intermittent —
  most non-zero hours sell one or two units — and MAPE is close to meaningless on that shape,
  because a one-unit miss against a one-unit actual is a 100% error. Current backtest over a
  14-day holdout: **28.8% WAPE at store-day grain**, 186% at SKU-hour grain. The store-day figure
  is the one to judge it by; the SKU-hour figure is reported rather than hidden because that is
  genuinely how hard the grain is.
- **The backtest scores the full grid, including hours with no sale.** Scoring only the hours that
  recorded a sale would quietly discard every hour the model predicted demand into and none
  arrived — which flattered an earlier version of this model by a wide margin.
- **The engines are transparent, not black boxes.** Every alert carries the evidence and the
  arithmetic behind it, and every insight carries an explicit confidence. That is deliberate: a
  store manager acting on a recommendation should be able to see why.
- **Synthesized data is labelled as such.** `Stores.isReferenceStore` and `Articles.isFromSapExport`
  mark what came from SAP; the command centre states the provenance on screen.

## Source data note

The two workbooks in `data/source/` are the SAP Customer Checkout exports as received. Their
filenames refer to 2025 and YTD 2026, but the report headers show the larger export covers
1 Jan – 3 Jul 2026 and the smaller one covers 3 Jul 2026 alone. The ETL picks whichever workbook
carries more hourly rows as the primary source rather than trusting the filenames.
