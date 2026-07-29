using { smart.retail as db } from '../db/ai-schema';
using { smart.retail as base } from '../db/schema';

/**
 * The AI scenario surface.
 *
 * Every entity is the persisted output of an engine in `srv/lib/engines/`. The
 * `recalculate*` actions re-run those same engines against current data and
 * replace the stored rows, so a demo can show the models responding to changed
 * facts rather than serving a fixed extract.
 */
@path: '/ai'
service AIService @(requires: 'Viewer') {

  // Master data the scenario entities point at. These have to be exposed
  // explicitly or their associations have no navigation target in this service
  // and `$expand=supplier(...)` / `$expand=customer(...)` fail with HTTP 400.
  // (PosSystems arrives on its own, auto-exposed as a composition of Stores.)
  @readonly entity Stores    as projection on base.Stores;
  @readonly entity Articles  as projection on base.Articles;
  @readonly entity Suppliers as projection on base.Suppliers;
  @readonly entity Customers as projection on base.Customers;

  entity DemandForecasts as projection on db.DemandForecasts;
  entity BasketAffinities as projection on db.BasketAffinities;

  /** Alerts and tasks are updatable so an operator can work the queue. */
  entity ShrinkAlerts as projection on db.ShrinkAlerts
    actions {
      @Common.SideEffects: { TargetProperties: ['in/state'] }
      @(requires: 'StoreManager') action acknowledge(note: String(200)) returns ShrinkAlerts;
      @(requires: 'StoreManager') action resolveAlert(resolution: String(200)) returns ShrinkAlerts;
      @(requires: 'StoreManager') action dismiss(reason: String(200)) returns ShrinkAlerts;
    };

  entity ReplenishmentTasks as projection on db.ReplenishmentTasks
    actions {
      /** Confirm the proposal and hand it to the ordering process. */
      @(requires: 'StoreManager') action releaseOrder(quantity: Decimal(11,3)) returns ReplenishmentTasks;
      @(requires: 'StoreManager') action dismiss(reason: String(200)) returns ReplenishmentTasks;
    };

  entity MarkdownRecommendations as projection on db.MarkdownRecommendations
    actions {
      /** Push the markdown to the electronic shelf labels. */
      @(requires: 'StoreManager') action applyMarkdown(discountPct: Decimal(5,2)) returns MarkdownRecommendations;
      @(requires: 'StoreManager') action dismiss(reason: String(200)) returns MarkdownRecommendations;
    };

  entity NextBestOffers as projection on db.NextBestOffers
    actions {
      @(requires: 'StoreManager') action activate() returns NextBestOffers;
      @(requires: 'StoreManager') action dismiss(reason: String(200)) returns NextBestOffers;
    };

  entity ColdChainAlerts as projection on db.ColdChainAlerts
    actions {
      @(requires: 'StoreManager') action acknowledge(note: String(200)) returns ColdChainAlerts;
      @(requires: 'StoreManager') action resolveAlert(resolution: String(200)) returns ColdChainAlerts;
    };

  entity AIInsights as projection on db.AIInsights
    actions {
      @(requires: 'StoreManager') action acknowledge(note: String(200)) returns AIInsights;
      @(requires: 'StoreManager') action dismiss(reason: String(200)) returns AIInsights;
    };

  @readonly entity ModelMetrics as projection on db.ModelMetrics;

  /**
   * Audit trail. Read-only over the service: rows are written by the queue
   * actions, never by a client, so there is no way to forge history.
   */
  @readonly entity ActivityLog as projection on db.ActivityLog;

  /** Whether acting on a recommendation actually worked. */
  @readonly entity ScenarioOutcomes as projection on db.ScenarioOutcomes;

  /** Rolling forecast accuracy, once actuals have been matched to forecasts. */
  @readonly
  entity ForecastAccuracy as
    select from db.DemandForecasts {
      key store.ID as storeId,
      key businessDate,
          store.name as storeName,
          count(*)              as forecastCount : Integer,
          sum(predictedQty)     as predicted     : Decimal(15,3),
          sum(actualQty)        as actual        : Decimal(15,3),
          // No absolute error here: absError is a virtual element and cannot be
          // aggregated. WAPE is computed by backfillActuals and stored in
          // ModelMetrics, where it belongs alongside the other scorecard rows.
    }
    where actualQty is not null
    group by store.ID, store.name, businessDate;

  // -------------------------------------------------------------------------
  // Aggregates for the command centre
  // -------------------------------------------------------------------------

  /** Open insights and money at stake, per store and scenario. */
  @readonly
  entity InsightSummary as
    select from db.AIInsights {
      key store.ID   as storeId,
      key scenario,
          store.name as storeName,
          count(*)          as insightCount : Integer,
          sum(impactValue)  as totalImpact  : Decimal(15,2),
          avg(confidence)   as avgConfidence : Decimal(6,4),
    }
    where state = 'OPEN'
    group by store.ID, store.name, scenario;

  /** Checkout-integrity exposure by failure pattern. */
  @readonly
  entity ShrinkByPattern as
    select from db.ShrinkAlerts {
      key store.ID   as storeId,
      key pattern,
          store.name as storeName,
          count(*)             as alertCount  : Integer,
          sum(valueAtRisk)     as valueAtRisk : Decimal(15,2),
          avg(anomalyScore)    as avgScore    : Decimal(6,2),
    }
    where state = 'OPEN'
    group by store.ID, store.name, pattern;

  // -------------------------------------------------------------------------
  // Engine re-runs
  // -------------------------------------------------------------------------

  type RecalcResult : {
    scenario   : String(30);
    rowsWritten : Integer;
    durationMs : Integer;
    summary    : String(300);
  };

  /**
   * Re-run one scenario, or all of them when `scenario` is omitted.
   *
   * `asOf` replays the demand forecast from a past instant: history after it is
   * withheld from the model and the horizon runs forward from there, so the
   * forecast lands on hours that have already happened and `backfillActuals`
   * can score it against what really sold.
   */
  @(requires: 'Analyst')
  action recalculate(
    scenario : String(30),
    store_ID : String(10),
    asOf     : Timestamp,
  ) returns array of RecalcResult;

  /**
   * Measure every pending outcome whose window has now elapsed, and record
   * whether the recommendation actually delivered what it promised.
   *
   * Outcomes acted on after the last day of loaded sales are left INCONCLUSIVE,
   * because no evidence exists either way. Pass `asOf` to replay the
   * measurement from a date inside the loaded history instead; replayed
   * verdicts are labelled as such in their narrative.
   */
  @(requires: 'Analyst')
  action evaluateOutcomes(asOf: Date) returns {
    /** How many were actually measured - not how many were looked at. */
    evaluated    : Integer;
    confirmed    : Integer;
    missed       : Integer;
    inconclusive : Integer;
    /** Left PENDING because their observation window has not elapsed yet. */
    stillPending : Integer;
    summary      : String(400);
  };

  /**
   * Match elapsed forecasts against what actually sold, so accuracy can be
   * tracked as it drifts rather than only measured by backtest.
   */
  @(requires: 'Analyst')
  action backfillActuals() returns {
    matched : Integer;
    /** Null when nothing sold in the matched hours - WAPE is undefined there. */
    wape    : Decimal(6,2);
    /**
     * Signed forecast error over the same window: positive is over-forecast.
     * Read it with `wape`, never instead of it - at SKU-hour grain WAPE falls
     * whenever the model predicts less, so only the bias says which direction
     * the error runs.
     */
    bias    : Decimal(8,2);
    summary : String(400);
  };

  /**
   * Forecast a single article without persisting anything - the "what if"
   * path used by the forecast dashboard's simulation panel.
   */
  action simulateForecast(
    store_ID   : String(10),
    article_ID : String(20),
    horizonHours : Integer,
  ) returns array of {
    forecastFor  : Timestamp;
    hourOfDay    : Integer;
    predictedQty : Decimal(11,3);
    lowerBound   : Decimal(11,3);
    upperBound   : Decimal(11,3);
  };

  /**
   * Score a candidate markdown depth for an article, so a manager can compare
   * the engine's recommendation against their own judgement before applying it.
   */
  action simulateMarkdown(
    store_ID    : String(10),
    article_ID  : String(20),
    discountPct : Decimal(5,2),
  ) returns {
    discountPct      : Decimal(5,2);
    expectedSales    : Decimal(11,3);
    expectedRecovery : Decimal(13,2);
    projectedWaste   : Decimal(11,3);
    marginImpact     : Decimal(13,2);
    verdict          : String(200);
  };
}
