# S.Mart Retail AI on SAP Business Data Cloud

Readiness scorecard and target architecture. A worked example of the BDC Readiness Assessment
framework applied to our own landscape, and what the BTP-plus-BDC version of this demo would
look like.

---

## 1. Purpose, method and scoring

This is an assessment of **the S.Mart Retail AI demo we built** — the CAP application, its data
pipeline, the HANA Cloud deployment and the BTP landscape around it — not of a customer estate.
It is a worked example: the framework turned on ourselves before we propose using it on anyone
else.

The framework is **slide 6 of the BDC starter kit**, "BDC Readiness Assessment Framework". All
five dimensions and all twenty sub-criteria are taken from that slide unchanged. The rule that a
dimension scoring below 3 becomes a Phase 1 workstream is from the slide's speaker notes.

### How the scores were derived

Slide 6 asks for a score out of 5 per dimension but does not define what each point means, so
this assessment states its own scale. It is written down here so that a reader can disagree with
a specific score rather than with the exercise:

| Score | Meaning |
|---|---|
| 1 | Absent. The thing does not exist. |
| 2 | Done, but with no process behind it. Reproducible by the person who did it, not by anyone else. |
| 3 | A real control exists, but it is narrow — one check, one source, or one skill. |
| 4 | Systematic, with known gaps. |
| 5 | Established, monitored, and would survive the author leaving. |

Each dimension score is the arithmetic mean of its scored criteria, rounded to one decimal.

Several of slide 6's criteria assume a legacy estate we do not have — BW complexity, custom
ABAP, an ECC/S4 extraction landscape — and one assumes an organisation rather than a project
team. Those are marked **N/A** and excluded from the mean rather than counted as full marks.
Scoring ourselves 5 out of 5 for having no BW complexity would flatter the exercise and teach
nobody anything.

---

## 2. Readiness assessment

### Dimension 1 — Data architecture readiness: **3.5 / 5**

| Slide 6 criterion | What we have | Score |
|---|---|---|
| Current BW complexity | No BW estate at all. Nothing to untangle, nothing to migrate off. | N/A |
| Data volumes and ingestion patterns | 25 tables, 120,324 rows deployed to HANA Cloud. Incremental ingestion works and is exercised — the pipeline picks its primary source by row count rather than filename, and a single-day export drives the delta path. Systematic with gaps: it handles the sources we have, not sources we do not. | 4 |
| ECC/S4 extraction landscape health | No extraction landscape. A file-based Customer Checkout export, whose figures reconciled exactly against SAP's own printed totals when checked by hand. A real control, but a narrow one — one check, one source, and not automated. | 3 |
| Custom ABAP / BAdI usage | None. The stack is CAP, CDS and Node.js throughout. | N/A |

Strong, but for a reason that would not transfer to a customer: the architecture is clean
because it is new, not because it has been rationalised.

### Dimension 2 — Data governance and quality: **1.5 / 5**

| Slide 6 criterion | What we have | Score |
|---|---|---|
| Active data ownership structure | Nothing assigns an owner, steward or accountable party to any entity. No `CODEOWNERS` file, no ownership annotation anywhere in the model. Absent. | 1 |
| Master data governance maturity | The article master was enriched by us — unit cost, temperature zone, shelf life, ABC class, RFID flag, reorder point, supplier — under a fixed seed, so the values are reproducible and documented. But there is no source of record, no approval step and no change process. Done, with no process behind it. | 2 |
| Data quality KPIs and monitoring | `extract_cashing_up()` reads SAP's own totals into the manifest on every run, but nothing compares them to the extracted rows — no assertion, no failure on mismatch. The reconciliation was verified once, by hand. A recorded figure is not a control, so this is a 2 and not a 3. | 2 |
| Catalogue and lineage tooling | No catalogue, no glossary, no lineage tooling. Lineage exists only as prose in the project report. Absent. | 1 |

**This is the gap, and it is the only one.** Under the rule in slide 6's speaker notes — any
dimension below 3 becomes a Phase 1 workstream — governance is the single workstream this
assessment produces. It is also precisely what a data product is: a governed, owned, catalogued,
lineage-tracked unit. The framework applied to us returns the argument for BDC.

### Dimension 3 — Skills and organisation: **3.3 / 5**

| Slide 6 criterion | What we have | Score |
|---|---|---|
| SAP BW / HANA technical skills depth | HANA Cloud is proven — 131 artifacts deployed, 0 warnings, the CDS model compiled to HANA unchanged. BW is at zero. A real skill, narrowly held. | 3 |
| Cloud analytics skills (SAC, Azure) | BTP, CAP, CDS, Fiori Elements, XSUAA and the Application Router all exercised end to end. SAP Analytics Cloud at zero, which is half of what this criterion asks for. | 3 |
| Data engineering capability | The ETL handles report-shaped exports properly — metadata rows above the header, group keys printed once per block, total rows mixed in with real ones — rather than assuming a tidy table. Systematic, with the automation gap noted above. | 4 |
| Change management readiness | Not applicable to a project team of this size. | N/A |

### Dimension 4 — Business use case clarity: **4.2 / 5**

| Slide 6 criterion | What we have | Score |
|---|---|---|
| Prioritised analytics use case backlog | Seven scenarios built and running, each ranked by euros at stake weighted by model confidence. The prioritisation is not a slide, it is a live query — it would survive any of us leaving. | 5 |
| Business sponsor engagement level | Active and specific, with direction given on both the demo and the BDC direction. Systematic rather than established only because it rests on one sponsor. | 4 |
| Value metrics agreed for target state | Value at stake, skill against a seasonal-naive benchmark and signed bias are all measured. No threshold has been agreed that would say the system is performing well enough. We can tell you the number; we have not agreed what a good number is. | 3 |
| AI/ML use cases identified | Seven identified and implemented, not merely listed. | 5 |

The strongest dimension, and the reason the BDC conversation is worth having at all: the use
cases already exist and run. What is missing sits underneath them.

### Dimension 5 — Technical infrastructure: **3.0 / 5**

| Slide 6 criterion | What we have | Score |
|---|---|---|
| BTP account and landscape setup | Complete and in use: Cloud Foundry org and space, HANA Cloud instance, HDI container, MTA deployment, all reproducible from the repository. | 5 |
| Network and security architecture | XSUAA with three role templates and three role collections, Application Router fronting both services, destinations with token forwarding. Systematic; the gap is that it has never been tested against a real corporate network policy. | 4 |
| Integration platform (CPI/IS) health | No Cloud Integration or Integration Suite anywhere in the picture. Every integration is file-based or direct. Absent. | 1 |
| Licence entitlements and contracts | HANA Cloud entitlement in place. No BDC entitlement, which is what blocks the next step. | 2 |

In place for an application, not for a data platform.

### Summary

| # | Dimension (slide 6) | Score |
|---|---|---|
| 1 | Data architecture readiness | 3.5 / 5 |
| 2 | **Data governance and quality** | **1.5 / 5** |
| 3 | Skills and organisation | 3.3 / 5 |
| 4 | Business use case clarity | 4.2 / 5 |
| 5 | Technical infrastructure | 3.0 / 5 |

One dimension below the threshold, and it is governance.

For a customer that finding would be uncomfortable; for us it is the point. We built seven
working AI scenarios on data we harmonised by hand, with no ownership, no catalogue and no
lineage. That is a demo. It is not a landscape anyone can point an agent at, and no amount of
additional model quality fixes it.

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
