# S.Mart Retail AI on SAP Business Data Cloud

Readiness scorecard and target architecture. A worked example of the BDC Readiness Assessment
framework applied to our own landscape, and what the BTP-plus-BDC version of this demo would
look like.

---

## 1. Purpose and honest framing

The readiness framework in the BDC starter kit is written for a customer estate: an existing BW
landscape, real data owners, a live extraction pipeline. Ours is a demo built on BTP with no
legacy behind it, so several criteria do not apply in the form they are asked.

Rather than skip them, each is scored on the closest honest equivalent and the substitution is
stated. Where a criterion cannot be answered at all, it is scored N/A and excluded from the
dimension average rather than counted as full marks. Scoring a demo five out of five for having
no BW complexity would flatter the exercise and teach nobody anything.

The framework asks for a score out of 5 but does not define what each point means, so this
assessment uses its own scale, stated here so the numbers can be challenged: **1 = absent,
2 = done but with no process behind it, 3 = a real control exists but is narrow, 4 = systematic
with gaps, 5 = established and monitored.** Each dimension is the mean of its scored criteria.

The result is more useful than a flattering one: the framework, applied honestly, identifies a
single weak dimension, and it is exactly the one BDC is sold to fix.

---

## 2. Readiness scorecard

### Dimension 1 — Data architecture readiness: **3.5 / 5**

| Criterion | Assessment | Score |
|---|---|---|
| Current BW complexity | No BW estate. Nothing to untangle, nothing to migrate off. | N/A |
| Data volumes and ingestion patterns | 25 tables, 120,324 rows in HANA Cloud. Incremental ingestion is supported and tested — the pipeline picks its primary source by row count rather than filename, and a single-day export exercises the delta path. | 4 |
| ECC/S4 extraction landscape health | No extraction landscape. Source is a file-based SAP Customer Checkout export. Its figures reconciled exactly against the totals SAP prints in its own report when checked, and those totals are captured in `data/canonical/manifest.json` on every run — but see dimension 2: the comparison is not automated. | 3 |
| Custom ABAP / BAdI usage | None. The whole stack is CAP, CDS and Node.js. | N/A |

The architecture is clean because it is new, not because it has been rationalised. That is worth
saying plainly: this dimension scores well for a reason that would not transfer to a customer.

### Dimension 2 — Data governance and quality: **1.5 / 5**

| Criterion | Assessment | Score |
|---|---|---|
| Active data ownership structure | None. No owners, no stewards, no defined accountability for any entity. | 1 |
| Master data governance maturity | The article master was enriched by us — unit cost, temperature zone, shelf life, ABC class, RFID flag, reorder point, supplier — with no governance process behind any of it. The values are defensible; the process is absent. | 2 |
| Data quality KPIs and monitoring | Weaker than it first appears. `extract_cashing_up()` reads SAP's own totals into the manifest on every run, but nothing compares them to the extracted rows — there is no assertion and no failure on mismatch. The reconciliation was verified by hand once and recorded for inspection. A recorded figure is not a control. | 2 |
| Catalogue and lineage tooling | None. Lineage exists only as prose in the project report. | 1 |

**This is the gap.** Under the framework's own rule — any dimension below 3 becomes a Phase 1
workstream — governance is the single workstream this assessment produces. It is also precisely
what a data product is: a governed, owned, catalogued, lineage-tracked unit. The framework
applied to us returns the argument for BDC.

### Dimension 3 — Skills and organisation: **3.3 / 5**

| Criterion | Assessment | Score |
|---|---|---|
| SAP BW / HANA technical skills depth | HANA Cloud side is proven — 131 artifacts deployed, 0 warnings, the CDS model compiled to HANA unchanged. BW: none. | 3 |
| Cloud analytics skills | BTP, CAP, CDS, Fiori Elements, XSUAA and the Application Router are all exercised end to end. SAP Analytics Cloud: none. | 3 |
| Data engineering capability | An ETL pipeline that handles report-shaped exports properly — metadata rows above the header, group keys printed once per block, total rows mixed in with real ones, and a primary source chosen by row count rather than filename. | 4 |
| Change management readiness | Not applicable to a demo team. | N/A |

### Dimension 4 — Business use case clarity: **4.2 / 5**

| Criterion | Assessment | Score |
|---|---|---|
| Prioritised analytics use case backlog | Seven scenarios built and running, each ranked by euros at stake weighted by model confidence. The prioritisation is not a slide; it is a live query. | 5 |
| Business sponsor engagement | Active and specific. | 4 |
| Value metrics agreed for target state | Partially. Value at stake, skill against a seasonal-naive benchmark and signed bias are all measured. What is not agreed is the target — no threshold has been set that would say the system is performing. | 3 |
| AI/ML use cases identified | Seven identified and implemented, not merely listed. | 5 |

The strongest dimension, and the reason the BDC conversation is worth having at all: the use
cases already exist and run. What is missing sits underneath them.

### Dimension 5 — Technical infrastructure: **3.0 / 5**

| Criterion | Assessment | Score |
|---|---|---|
| BTP account and landscape setup | Complete. Cloud Foundry org and space, HANA Cloud instance, HDI container, MTA deployment. | 5 |
| Network and security architecture | XSUAA with three role templates and three role collections, Application Router fronting both services, destinations with token forwarding. | 4 |
| Integration platform health | No CPI or Integration Suite in the picture. Every integration is file-based or direct. | 1 |
| Licence entitlements and contracts | HANA Cloud entitlement in place. No BDC entitlement. | 2 |

### Summary

| # | Dimension | Score |
|---|---|---|
| 1 | Data architecture readiness | 3.5 / 5 |
| 2 | Data governance and quality | **1.5 / 5** |
| 3 | Skills and organisation | 3.3 / 5 |
| 4 | Business use case clarity | 4.2 / 5 |
| 5 | Technical infrastructure | 3.0 / 5 |

One dimension below the threshold, and it is governance. For a customer that finding would be
uncomfortable; for us it is the point. We built working AI on data we harmonised by hand, with
no ownership, no catalogue and no lineage. That is a demo. It is not a landscape anyone can run
an agent against, and no amount of additional model quality fixes it.

---

## 3. Target architecture

**BDC harmonizes, serves and trains. BTP reasons and acts.**

The division is not arbitrary. Engines that want history, scale and non-SAP signal belong where
the data lives. Engines that sit behind a button a store manager presses belong next to the
transaction.

### 3.1 Data products to publish

Our 120,324 rows fall into four families that map onto data products with no restructuring:

| Family | Tables | Rows | Notes |
|---|---|---|---|
| Retail master data | Articles, ArticleGroups, Stores, Suppliers, PosSystems, Employees, Customers | 925 | The enriched article master is the valuable one — the export gave identifier, name, quantity and revenue; everything a scenario reasons with was added. |
| POS transactions | Receipts, ReceiptItems, PaymentFacts, Cancellations, Returns | 57,651 | Line-item grain. This is the grain that matters and the one standard products are least likely to reach. |
| Operational signals | HourlySales, InventorySnapshots, FootfallReadings, ShelfSensorReadings | 57,717 | The non-SAP half of the estate in miniature — sensors, footfall, shelf state. |
| AI outputs | AIInsights, DemandForecasts, ShrinkAlerts, ReplenishmentTasks, MarkdownRecommendations, ColdChainAlerts, BasketAffinities, NextBestOffers, ModelMetrics | 4,031 | Published **back** as products, not kept inside the service. |

That last row is the part worth demonstrating. Publishing AI output as a governed product shows
BDC as a two-way fabric rather than a source you read from, and it means a second application
consumes our scenario output without reimplementing a line of the logic.

**Custom rather than standard**, at least to begin with. Every scenario depends on POS
line-item and article-hour grain, and standard retail products are unlikely to reach it.
Building our own also demonstrates the capability instead of merely consuming it, which is
closer to what the demo needs to prove. Validate against the standard catalogue as we go and
switch wherever one genuinely fits.

### 3.2 Engine placement

| Engine | Lines | Placement | Reason |
|---|---|---|---|
| `forecast.js` | 305 | **Databricks** | Heaviest engine, batch by nature, and the one that improves most with more history and more non-SAP signal than a CAP service should carry. |
| `affinity.js` | 137 | **Databricks** | Association rule mining over baskets — combinatorial, batch, and it wants the full transaction history rather than a window. |
| `shrink.js` | 201 | CAP | Rules and statistics over recent events, feeding an alert a user acts on. |
| `replenishment.js` | 163 | CAP | Consumes the forecast, sizes an order, releases it. Tied to an action on screen. |
| `markdown.js` | 180 | CAP | Sweeps candidate discounts against shelf life. Fast, and the output is a decision someone applies. |
| `coldchain.js` | 120 | CAP | Near-real-time excursion scoring. Latency is the whole point. |
| `personalization.js` | 194 | CAP | Per-customer, on demand, consent-gated. |
| `insights.js` | 256 | CAP | Aggregator. Must sit where every scenario's output lands. |

Two of eight move. That is the honest answer, and it is the right one — relocating the other six
would add network hops and gain nothing.

### 3.3 What makes this cheap

The batch scoring job and the service's `recalculate` action call the same engine functions.
There is no second implementation to keep in step, which means an engine can be relocated to
Databricks without touching the UI, the service contract, or any other engine. That was a
correctness decision when it was made; it turns out to have been an architecture decision.

The CDS model also compiled to HANA unchanged — 131 artifacts, 0 warnings — so the semantic
layer that would be published as data products is the one already running.

---

## 4. What it would take

Shaped to the four phases in the starter kit rather than inventing a different structure.

| Phase | Scope | Depends on |
|---|---|---|
| **1 — Foundation** | BDC tenant and entitlement. Governance workstream: name an owner per entity, register lineage from the export through the pipeline to the served table, catalogue the enriched article attributes. Publish the retail master data family as the first data products. | The governance gap above. This phase exists because of it. |
| **2 — Products** | Publish POS transactions and operational signals. Validate against the standard retail catalogue and substitute where one fits. Point the CAP service at the published products rather than at HDI tables directly. | Phase 1 |
| **3 — Intelligence** | Move `forecast.js` and `affinity.js` to Databricks. Retrain on full history. Publish AI outputs back as data products. | Phase 2 |
| **4 — Demonstrate** | A second consumer — a Fiori app, an SAC story, or an agent — reading our AI output products without touching our service. This is what proves the fabric. | Phase 3 |

The demo does not need all four. Phase 1 plus the master data family is enough to show a data
product being published from a BTP-native application, which is the part of the story that does
not exist today.

---

## 5. A sixth migration path

Slide 5 of the starter kit maps five source platforms — BW Classic, BW/4HANA, Datasphere/DWC,
non-SAP, and on-premise HANA. All five assume a legacy estate to migrate away from.

Ours is a sixth pattern, and if customers are increasingly building on BTP first it will not stay
rare:

| Source platform | Strategy | Approach | Key tooling | Complexity |
|---|---|---|---|---|
| BTP-native application (CAP + HANA Cloud, no BW) | **Publish and extend** | Expose the existing CDS semantic model as data products; move batch ML workloads to Databricks; keep transactional and action logic on CAP | HANA Cloud, CAP, BDC data product publishing | Low |

Complexity is low because there is nothing to migrate. The work is governance and publishing,
not conversion — which makes it a good first demonstration rather than a hard one.

---

## 6. Limits of this assessment

Three things this document does not do, stated so nobody plans around them.

It has not been validated against a real BDC tenant. There is no BDC entitlement in the
subaccount, so the architecture is reasoned from the framework and our own landscape, not tested.

The dataset is synthesized on top of a single real store's export. That is sufficient to
demonstrate AI scenarios and entirely insufficient to demonstrate landscape harmonization, which
by definition needs more than one landscape. A convincing BDC demo would want a second,
genuinely non-SAP source.

The scores are judgements, not measurements. They are defensible and each one carries its
evidence, but a different assessor would move one or two of them by a point. The finding that
matters — governance is the weak dimension — is not sensitive to that.
