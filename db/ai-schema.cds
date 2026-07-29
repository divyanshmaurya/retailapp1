namespace smart.retail;

using { managed, Currency } from '@sap/cds/common';
using { smart.retail.recordKey } from './common';
using { smart.retail.Stores, smart.retail.Articles, smart.retail.Customers,
        smart.retail.PosSystems, smart.retail.Suppliers } from './schema';

/**
 * Outputs of the six AI scenarios. Each entity persists what a scenario engine
 * decided, together with the evidence behind it, so a dashboard can show both
 * the recommendation and why it was made. The engines live in
 * `srv/lib/engines/` and are re-runnable against live data.
 */

type Severity   : String(10) enum { LOW; MEDIUM; HIGH; CRITICAL };
type AlertState : String(12) enum { OPEN; ACKNOWLEDGED; RESOLVED; DISMISSED };

// ---------------------------------------------------------------------------
// Scenario 1 - Hourly demand forecast
// ---------------------------------------------------------------------------

/**
 * Per store, article and hour. Produced by a seasonal-naive baseline blended
 * with a day-of-week/hour-of-day profile learned from the SAP history; the
 * interval widens with the article's observed volatility.
 */
entity DemandForecasts : recordKey {
  store            : Association to Stores;
  article          : Association to Articles;
  forecastFor      : Timestamp;
  businessDate     : Date;
  hourOfDay        : Integer;
  predictedQty     : Decimal(11,3);
  lowerBound       : Decimal(11,3);
  upperBound       : Decimal(11,3);
  /** Populated once the hour has passed, for accuracy tracking. */
  actualQty        : Decimal(11,3);
  /** Mean absolute percentage error of this model on recent history. */
  mape             : Decimal(6,2);
  /**
   * Weighted absolute percentage error - total error over total volume. The
   * headline accuracy measure here, because hourly demand is intermittent and
   * MAPE explodes when the actual is one or two units.
   */
  wape             : Decimal(6,2);
  model            : String(30);
  generatedAt      : Timestamp;

  virtual absError : Decimal(11,3);
}

// ---------------------------------------------------------------------------
// Scenario 2 - Autonomous checkout integrity
// ---------------------------------------------------------------------------

/**
 * Cancellation and stock-variance anomalies on the unstaffed terminals. The
 * score combines how far an article's cancellation rate sits above its own
 * baseline with the value at risk, so a cheap high-frequency misread and an
 * expensive one-off both surface.
 */
entity ShrinkAlerts : recordKey, managed {
  store            : Association to Stores;
  posSystem        : Association to PosSystems;
  article          : Association to Articles;
  detectedOn       : Date;
  /** RFID_MISREAD, TAG_ABSENT, BASKET_ABANDONED, STOCK_VARIANCE, PRICE_ERROR */
  pattern          : String(24);
  severity         : Severity;
  /** Fiori criticality for `severity`: 1 red, 2 orange, 3 green. */
  criticality      : Integer;
  state            : AlertState default 'OPEN';
  /** 0..100; higher means further from this article's own normal behaviour. */
  anomalyScore     : Decimal(5,2);
  cancellationRate : Decimal(6,4);
  baselineRate     : Decimal(6,4);
  valueAtRisk      : Decimal(13,2);
  currency         : Currency;
  evidence         : String(400);
  recommendedAction : String(200);
}

// ---------------------------------------------------------------------------
// Scenario 3 - Autonomous replenishment
// ---------------------------------------------------------------------------

entity ReplenishmentTasks : recordKey, managed {
  store           : Association to Stores;
  article         : Association to Articles;
  supplier        : Association to Suppliers;
  dueOn           : Date;
  onHand          : Decimal(11,3);
  reorderPoint    : Decimal(11,3);
  /** Forecast demand over the supplier lead time plus safety stock. */
  recommendedQty  : Decimal(11,3);
  coverageHours   : Decimal(8,2);
  urgency         : Severity;
  /** Fiori criticality for `urgency`: 1 red, 2 orange, 3 green. */
  criticality     : Integer;
  state           : AlertState default 'OPEN';
  /** Expected lost margin if the shelf runs empty before the next delivery. */
  stockoutRisk    : Decimal(5,4);
  lostSalesValue  : Decimal(13,2);
  currency        : Currency;
  reasoning       : String(300);
}

// ---------------------------------------------------------------------------
// Scenario 4 - Fresh-food waste and markdown
// ---------------------------------------------------------------------------

/**
 * Markdown proposals for perishables. The recommended discount is the one that
 * maximises expected recovered revenue: deeper cuts clear more units but give
 * away margin, so the engine sweeps candidate depths and keeps the best.
 */
entity MarkdownRecommendations : recordKey, managed {
  store             : Association to Stores;
  article           : Association to Articles;
  businessDate      : Date;
  expiresOn         : Date;
  hoursToExpiry     : Decimal(8,2);
  onHand            : Decimal(11,3);
  forecastSellThrough : Decimal(11,3);
  /** Units expected to be thrown away if nothing is done. */
  projectedWaste    : Decimal(11,3);
  recommendedDiscountPct : Decimal(5,2);
  expectedRecovery  : Decimal(13,2);
  wasteCostAvoided  : Decimal(13,2);
  marginImpact      : Decimal(13,2);
  currency          : Currency;
  /** Fiori criticality derived from the share of stock at risk. */
  criticality       : Integer;
  state             : AlertState default 'OPEN';
  reasoning         : String(300);
}

// ---------------------------------------------------------------------------
// Scenario 5 - Basket affinity and micro-planogram
// ---------------------------------------------------------------------------

/**
 * Association rules mined from receipt baskets. `lift` above 1 means the pair
 * sells together more often than independence would predict.
 */
entity BasketAffinities : recordKey {
  store           : Association to Stores;
  antecedent      : Association to Articles;
  consequent      : Association to Articles;
  support         : Decimal(7,5);
  confidence      : Decimal(6,4);
  lift            : Decimal(8,3);
  basketCount     : Integer;
  /** Revenue uplift per basket when the pair is placed adjacently. */
  upliftPerBasket : Decimal(9,2);
  currency        : Currency;
  /** True when the two articles sit in different zones today. */
  isCrossZone     : Boolean;
  recommendedPlacement : String(120);
}

// ---------------------------------------------------------------------------
// Scenario 6 - Personalisation
// ---------------------------------------------------------------------------

entity NextBestOffers : recordKey, managed {
  customer        : Association to Customers;
  store           : Association to Stores;
  article         : Association to Articles;
  validFrom       : Date;
  validTo         : Date;
  /** 0..1 likelihood the customer redeems this offer. */
  propensity      : Decimal(6,4);
  offerDiscountPct : Decimal(5,2);
  expectedRevenue : Decimal(11,2);
  currency        : Currency;
  channel         : String(20) enum { APP_PUSH; ESL; RECEIPT; EMAIL };
  rationale       : String(240);
  state           : AlertState default 'OPEN';
}

// ---------------------------------------------------------------------------
// Cold chain
// ---------------------------------------------------------------------------

entity ColdChainAlerts : recordKey, managed {
  store          : Association to Stores;
  /** Chiller, freezer or hot-hold unit the probe belongs to. */
  assetId        : String(20);
  assetName      : String(60);
  detectedAt     : Timestamp;
  measuredTemp   : Decimal(6,2);
  targetTemp     : Decimal(6,2);
  toleranceBand  : Decimal(6,2);
  /** Consecutive minutes outside the band. */
  breachMinutes  : Integer;
  severity       : Severity;
  /** Fiori criticality for `severity`: 1 red, 2 orange, 3 green. */
  criticality    : Integer;
  state          : AlertState default 'OPEN';
  stockAtRisk    : Decimal(13,2);
  currency       : Currency;
  recommendedAction : String(200);
}

// ---------------------------------------------------------------------------
// Unified insight feed
// ---------------------------------------------------------------------------

/**
 * One stream the command centre reads, so a store manager sees every scenario
 * ranked by money at stake rather than by which engine produced it.
 */
entity AIInsights : recordKey, managed {
  store          : Association to Stores;
  scenario       : String(30);
  title          : String(120);
  narrative      : String(600);
  severity       : Severity;
  /** Fiori criticality for `severity`: 1 red, 2 orange, 3 green. */
  criticality    : Integer;
  state          : AlertState default 'OPEN';
  impactValue    : Decimal(13,2);
  currency       : Currency;
  /** 0..1 model confidence, shown next to the recommendation. */
  confidence     : Decimal(4,3);
  detectedOn     : Date;
  /** Key of the row in the scenario-specific table this summarises. */
  sourceEntity   : String(40);
  sourceId       : String(40);
  recommendedAction : String(240);
}

/** Accuracy and value tracking, one row per scenario per day. */
entity ModelMetrics : recordKey {
  scenario     : String(30);
  businessDate : Date;
  metricName   : String(30);
  metricValue  : Decimal(13,4);
  unit         : String(20);
}

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

/**
 * Every state change on an alert, task or recommendation.
 *
 * This exists because the first version recorded the operator's note by
 * overwriting `recommendedAction` on the record itself, which destroyed the
 * engine's advice the moment somebody acknowledged it - the one field you most
 * want to keep. Notes belong in their own history, alongside who made the
 * change and when, which is also what an auditor would ask for.
 */
entity ActivityLog : recordKey {
  /** Entity the change was made on, e.g. 'ShrinkAlerts'. */
  targetEntity : String(40);
  /** Key of the changed row. */
  targetId     : String(40);
  store        : Association to Stores;
  scenario     : String(30);
  action       : String(24);
  fromState    : AlertState;
  toState      : AlertState;
  note         : String(400);
  changedBy    : String(60);
  changedAt    : Timestamp;
  /** Quantity or discount actually confirmed, where the action carried one. */
  actedValue   : Decimal(13,3);
}

// ---------------------------------------------------------------------------
// Outcome tracking
// ---------------------------------------------------------------------------

type OutcomeVerdict : String(16) enum { PENDING; CONFIRMED; MISSED; INCONCLUSIVE };

/**
 * Did acting on a recommendation actually work?
 *
 * Every engine produces advice and, until now, nothing checked whether taking
 * it changed anything. This closes the loop: when a recommendation is acted on
 * the expected effect is recorded, and once enough time has passed the observed
 * effect is measured against it. That is what turns a dashboard into something
 * that can be held to account - and what lets a model be judged on outcomes
 * rather than on its own confidence.
 */
entity ScenarioOutcomes : recordKey, managed {
  scenario      : String(30);
  targetEntity  : String(40);
  targetId      : String(40);
  store         : Association to Stores;
  article       : Association to Articles;
  actedOn       : Date;
  /** Business date the effect is measured on. */
  measuredOn    : Date;
  /** What the engine said would happen, in the scenario's own unit. */
  expectedValue : Decimal(13,3);
  /** What actually happened over the same window. */
  observedValue : Decimal(13,3);
  unit          : String(20);
  verdict       : OutcomeVerdict default 'PENDING';
  /** Signed euro value of the difference; positive means better than expected. */
  valueDelta    : Decimal(13,2);
  currency      : Currency;
  narrative     : String(400);
}
