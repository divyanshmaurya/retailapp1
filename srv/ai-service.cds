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
service AIService @(requires: 'authenticated-user') {

  @readonly entity Stores   as projection on base.Stores;
  @readonly entity Articles as projection on base.Articles;

  entity DemandForecasts as projection on db.DemandForecasts;
  entity BasketAffinities as projection on db.BasketAffinities;

  /** Alerts and tasks are updatable so an operator can work the queue. */
  entity ShrinkAlerts as projection on db.ShrinkAlerts
    actions {
      @Common.SideEffects: { TargetProperties: ['in/state'] }
      action acknowledge(note: String(200)) returns ShrinkAlerts;
      action resolveAlert(resolution: String(200)) returns ShrinkAlerts;
      action dismiss(reason: String(200)) returns ShrinkAlerts;
    };

  entity ReplenishmentTasks as projection on db.ReplenishmentTasks
    actions {
      /** Confirm the proposal and hand it to the ordering process. */
      action releaseOrder(quantity: Decimal(11,3)) returns ReplenishmentTasks;
      action dismiss(reason: String(200)) returns ReplenishmentTasks;
    };

  entity MarkdownRecommendations as projection on db.MarkdownRecommendations
    actions {
      /** Push the markdown to the electronic shelf labels. */
      action applyMarkdown(discountPct: Decimal(5,2)) returns MarkdownRecommendations;
      action dismiss(reason: String(200)) returns MarkdownRecommendations;
    };

  entity NextBestOffers as projection on db.NextBestOffers
    actions {
      action activate() returns NextBestOffers;
      action dismiss(reason: String(200)) returns NextBestOffers;
    };

  entity ColdChainAlerts as projection on db.ColdChainAlerts
    actions {
      action acknowledge(note: String(200)) returns ColdChainAlerts;
      action resolveAlert(resolution: String(200)) returns ColdChainAlerts;
    };

  entity AIInsights as projection on db.AIInsights
    actions {
      action acknowledge(note: String(200)) returns AIInsights;
      action dismiss(reason: String(200)) returns AIInsights;
    };

  @readonly entity ModelMetrics as projection on db.ModelMetrics;

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

  /** Re-run one scenario, or all of them when `scenario` is omitted. */
  action recalculate(scenario: String(30), store_ID: String(10)) returns array of RecalcResult;

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
