'use strict';

/**
 * Unified insight feed.
 *
 * Each engine ranks its own output, but a store manager does not care which
 * engine spoke - they care what costs the most money today. This collapses
 * every scenario into one stream with a common currency: euros at stake, plus
 * a confidence the model attaches to its own recommendation.
 *
 * Confidence is deliberately explicit rather than implied. A markdown backed by
 * hundreds of observations is trusted more than a shrink alert built on three
 * cancellations, and the feed shows that difference instead of hiding it.
 */

const { round, clamp, criticalityFor } = require('../stats');

/**
 * Build the feed from whatever engine output is available.
 * @returns {Array} AIInsights rows
 */
function buildInsightFeed({
  shrinkAlerts = [], replenishmentTasks = [], markdowns = [],
  affinities = [], offers = [], coldChainAlerts = [], forecasts = [],
  articles = [], stores = [], limitPerScenario = 25,
}) {
  const articleById = new Map(articles.map((article) => [article.ID, article]));
  const storeById = new Map(stores.map((store) => [store.ID, store]));
  const name = (id) => articleById.get(id)?.name || id;
  const storeName = (id) => storeById.get(id)?.name || id;

  const insights = [];
  const push = (row) => insights.push(row);

  // --- Checkout integrity ---------------------------------------------------
  for (const alert of shrinkAlerts.slice(0, limitPerScenario)) {
    push({
      store_ID: alert.store_ID,
      scenario: 'CHECKOUT_INTEGRITY',
      title: `${alert.pattern.replace(/_/g, ' ').toLowerCase()} on ${name(alert.article_ID)}`,
      narrative: `${storeName(alert.store_ID)}: ${alert.evidence}`,
      severity: alert.severity,
      impactValue: alert.valueAtRisk,
      // More cancellations behind the signal means a firmer conclusion.
      confidence: round(clamp(0.55 + Number(alert.anomalyScore) / 250, 0.4, 0.95), 3),
      detectedOn: alert.detectedOn,
      sourceEntity: 'ShrinkAlerts',
      sourceId: alert.ID,
      recommendedAction: alert.recommendedAction,
    });
  }

  // --- Replenishment --------------------------------------------------------
  for (const task of replenishmentTasks.slice(0, limitPerScenario)) {
    push({
      store_ID: task.store_ID,
      scenario: 'REPLENISHMENT',
      title: `${name(task.article_ID)} runs out in ${round(task.coverageHours, 1)}h`,
      narrative: `${storeName(task.store_ID)}: ${task.reasoning} Order ${task.recommendedQty} units.`,
      severity: task.urgency,
      impactValue: task.lostSalesValue,
      confidence: round(clamp(Number(task.stockoutRisk) * 0.5 + 0.45, 0.4, 0.95), 3),
      detectedOn: task.dueOn,
      sourceEntity: 'ReplenishmentTasks',
      sourceId: task.ID,
      recommendedAction: `Raise a ${task.recommendedQty}-unit order for delivery before cover runs out.`,
    });
  }

  // --- Waste and markdown ---------------------------------------------------
  for (const markdown of markdowns.slice(0, limitPerScenario)) {
    const wasteShare = Number(markdown.projectedWaste) / Math.max(Number(markdown.onHand), 1);
    push({
      store_ID: markdown.store_ID,
      scenario: 'WASTE_MARKDOWN',
      title: `Mark ${name(markdown.article_ID)} down ${round(markdown.recommendedDiscountPct, 0)}%`,
      narrative: `${storeName(markdown.store_ID)}: ${markdown.reasoning}`,
      severity: wasteShare > 0.6 ? 'HIGH' : wasteShare > 0.35 ? 'MEDIUM' : 'LOW',
      impactValue: markdown.marginImpact,
      confidence: round(clamp(0.6 + (1 - wasteShare) * 0.25, 0.45, 0.9), 3),
      detectedOn: markdown.businessDate,
      sourceEntity: 'MarkdownRecommendations',
      sourceId: markdown.ID,
      recommendedAction: `Apply a ${round(markdown.recommendedDiscountPct, 0)}% markdown at the shelf label now.`,
    });
  }

  // --- Cold chain -----------------------------------------------------------
  // One cabinet breaching on several days produces one alert per day, which
  // would crowd the feed with near-identical rows for the same asset. The feed
  // carries the worst open excursion per cabinet; the full history stays in
  // ColdChainAlerts for the cold-chain app.
  const worstPerAsset = new Map();
  for (const alert of coldChainAlerts) {
    const current = worstPerAsset.get(alert.assetId);
    if (!current || Number(alert.stockAtRisk) > Number(current.stockAtRisk)) {
      worstPerAsset.set(alert.assetId, alert);
    }
  }
  const dedupedColdChain = [...worstPerAsset.values()]
    .sort((a, b) => Number(b.stockAtRisk) - Number(a.stockAtRisk));

  for (const alert of dedupedColdChain.slice(0, limitPerScenario)) {
    push({
      store_ID: alert.store_ID,
      scenario: 'COLD_CHAIN',
      title: `${alert.assetName} at ${round(alert.measuredTemp, 1)}C`,
      narrative: `${storeName(alert.store_ID)}: unit held ${round(alert.measuredTemp, 1)}C against a target of `
        + `${alert.targetTemp}C +/-${alert.toleranceBand}C for ${alert.breachMinutes} minutes. `
        + `Stock exposed is worth EUR ${round(alert.stockAtRisk, 2)}.`,
      severity: alert.severity,
      impactValue: alert.stockAtRisk,
      // Probe readings are direct measurements, so confidence is high.
      confidence: 0.92,
      detectedOn: String(alert.detectedAt).slice(0, 10),
      sourceEntity: 'ColdChainAlerts',
      sourceId: alert.ID,
      recommendedAction: alert.recommendedAction,
    });
  }

  // --- Merchandising --------------------------------------------------------
  const crossZone = affinities.filter((rule) => rule.isCrossZone === true || rule.isCrossZone === 'true');
  for (const rule of crossZone.slice(0, Math.floor(limitPerScenario / 2))) {
    // Value the rule over a period rather than per basket, so it ranks sanely.
    const impact = Number(rule.upliftPerBasket) * Number(rule.basketCount);
    push({
      store_ID: rule.store_ID,
      scenario: 'MERCHANDISING',
      title: `${name(rule.consequent_ID)} attaches to ${name(rule.antecedent_ID)}`,
      narrative: `${storeName(rule.store_ID)}: the pair appears in ${rule.basketCount} baskets at `
        + `${round(Number(rule.lift), 2)}x lift and ${round(Number(rule.confidence) * 100, 1)}% confidence, `
        + `but sits in different zones today.`,
      severity: Number(rule.lift) > 3 ? 'MEDIUM' : 'LOW',
      impactValue: round(impact, 2),
      confidence: round(clamp(0.4 + Number(rule.confidence) * 0.5, 0.4, 0.9), 3),
      detectedOn: null,
      sourceEntity: 'BasketAffinities',
      sourceId: rule.ID,
      recommendedAction: rule.recommendedPlacement,
    });
  }

  // --- Personalisation ------------------------------------------------------
  const topOffers = offers.slice(0, Math.floor(limitPerScenario / 2));
  for (const offer of topOffers) {
    push({
      store_ID: offer.store_ID,
      scenario: 'PERSONALISATION',
      title: `Offer ${name(offer.article_ID)} at ${round(offer.offerDiscountPct, 0)}%`,
      narrative: `${storeName(offer.store_ID)}: ${offer.rationale}`,
      severity: 'LOW',
      impactValue: offer.expectedRevenue,
      confidence: round(clamp(Number(offer.propensity), 0.3, 0.95), 3),
      detectedOn: offer.validFrom,
      sourceEntity: 'NextBestOffers',
      sourceId: offer.ID,
      recommendedAction: `Send via ${offer.channel === 'APP_PUSH' ? 'the S.Mart app' : 'the shelf label'}.`,
    });
  }

  // Rank by money at stake, weighted by how much we trust the call.
  insights.sort((a, b) =>
    (Number(b.impactValue) * Number(b.confidence)) - (Number(a.impactValue) * Number(a.confidence)));

  const lastDate = insights.map((row) => row.detectedOn).filter(Boolean).sort().pop();
  return insights.map((insight, index) => ({
    ID: `IN-${(index + 1).toString().padStart(6, '0')}`,
    ...insight,
    criticality: criticalityFor(insight.severity),
    detectedOn: insight.detectedOn || lastDate,
    currency_code: 'EUR',
    state: 'OPEN',
    narrative: String(insight.narrative).slice(0, 600),
    title: String(insight.title).slice(0, 120),
    recommendedAction: String(insight.recommendedAction).slice(0, 240),
    impactValue: round(insight.impactValue, 2),
  }));
}

/**
 * Daily scorecard per scenario: how accurate the models are and how much value
 * they have surfaced. Drives the model-performance dashboard.
 */
function buildModelMetrics({ forecasts = [], shrinkAlerts = [], replenishmentTasks = [],
  markdowns = [], offers = [], coldChainAlerts = [], affinities = [] }) {
  const metrics = [];
  const businessDate = forecasts[0]?.businessDate
    || markdowns[0]?.businessDate
    || new Date().toISOString().slice(0, 10);

  const add = (scenario, metricName, metricValue, unit) => {
    metrics.push({
      ID: `MM-${(metrics.length + 1).toString().padStart(5, '0')}`,
      scenario, businessDate, metricName,
      metricValue: round(metricValue, 4), unit,
    });
  };

  if (forecasts.length) {
    // Volume-weighted accuracy across the whole backtest, when the engine
    // attached it to the run; otherwise average the per-article WAPE.
    const scored = forecasts.filter((row) => row.wape !== '' && row.wape !== undefined && row.wape !== null);
    const overall = forecasts.overallWape
      ?? (scored.length
        ? scored.reduce((total, row) => total + Number(row.wape), 0) / scored.length
        : null);
    if (overall !== null) add('DEMAND_FORECAST', 'WAPE (SKU-hour)', overall, '%');
    if (forecasts.storeDayWape !== undefined) {
      add('DEMAND_FORECAST', 'WAPE (store-day)', forecasts.storeDayWape, '%');
    }

    // A WAPE on its own is unreadable at SKU-hour grain, where forecasting
    // nothing at all scores 100% and every honest forecast scores worse. These
    // three make it interpretable: what a no-model baseline achieves, how much
    // the model beats it by, and whether the error leans to over- or
    // under-forecasting. Skill, not WAPE, is the number to watch.
    if (forecasts.naiveWape !== undefined) {
      add('DEMAND_FORECAST', 'Naive WAPE (SKU-hour)', forecasts.naiveWape, '%');
      add('DEMAND_FORECAST', 'Naive WAPE (store-day)', forecasts.naiveStoreDayWape, '%');
    }
    if (forecasts.skill !== undefined) {
      add('DEMAND_FORECAST', 'Skill vs naive (SKU-hour)', forecasts.skill, '%');
      add('DEMAND_FORECAST', 'Skill vs naive (store-day)', forecasts.storeDaySkill, '%');
    }
    if (forecasts.bias !== undefined) add('DEMAND_FORECAST', 'Forecast bias', forecasts.bias, '%');

    const withMape = forecasts.filter((row) => row.mape !== '' && row.mape !== undefined && row.mape !== null);
    if (withMape.length) {
      add('DEMAND_FORECAST', 'MAPE',
        withMape.reduce((total, row) => total + Number(row.mape), 0) / withMape.length, '%');
    }
    add('DEMAND_FORECAST', 'Forecast rows', forecasts.length, 'rows');
  }

  if (shrinkAlerts.length) {
    add('CHECKOUT_INTEGRITY', 'Open alerts', shrinkAlerts.length, 'alerts');
    add('CHECKOUT_INTEGRITY', 'Value at risk',
      shrinkAlerts.reduce((total, row) => total + Number(row.valueAtRisk), 0), 'EUR');
  }
  if (replenishmentTasks.length) {
    add('REPLENISHMENT', 'Open tasks', replenishmentTasks.length, 'tasks');
    add('REPLENISHMENT', 'Lost sales avoided',
      replenishmentTasks.reduce((total, row) => total + Number(row.lostSalesValue), 0), 'EUR');
  }
  if (markdowns.length) {
    add('WASTE_MARKDOWN', 'Recommendations', markdowns.length, 'items');
    add('WASTE_MARKDOWN', 'Margin protected',
      markdowns.reduce((total, row) => total + Number(row.marginImpact), 0), 'EUR');
    add('WASTE_MARKDOWN', 'Waste cost avoided',
      markdowns.reduce((total, row) => total + Number(row.wasteCostAvoided), 0), 'EUR');
  }
  if (offers.length) {
    add('PERSONALISATION', 'Offers generated', offers.length, 'offers');
    add('PERSONALISATION', 'Expected revenue',
      offers.reduce((total, row) => total + Number(row.expectedRevenue), 0), 'EUR');
  }
  if (coldChainAlerts.length) {
    add('COLD_CHAIN', 'Open alerts', coldChainAlerts.length, 'alerts');
    add('COLD_CHAIN', 'Stock protected',
      coldChainAlerts.reduce((total, row) => total + Number(row.stockAtRisk), 0), 'EUR');
  }
  if (affinities.length) {
    add('MERCHANDISING', 'Rules mined', affinities.length, 'rules');
    add('MERCHANDISING', 'Cross-zone opportunities',
      affinities.filter((row) => row.isCrossZone === true || row.isCrossZone === 'true').length, 'rules');
  }
  return metrics;
}

module.exports = { buildInsightFeed, buildModelMetrics };
