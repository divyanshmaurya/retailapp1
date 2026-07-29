'use strict';

/**
 * Scenario 3 - autonomous replenishment.
 *
 * An unstaffed store cannot notice an empty shelf, so the reorder decision has
 * to come from the data. For every store/article we take the latest counted
 * stock, project demand over the supplier's lead time using the forecast from
 * scenario 1, and compare against a safety stock sized from demand variability
 * and the supplier's reliability:
 *
 *     safetyStock = z * sigma(demand over lead time) / reliability
 *     recommended = leadTimeDemand + safetyStock - onHand - onOrder
 *
 * Urgency is driven by coverage - how many trading hours the shelf lasts - not
 * by order size, because a slow mover about to go empty still loses the sale.
 */

const { sum, mean, stdev, groupBy, round, clamp, severityFor, criticalityFor } = require('../stats');

/** Service-level factor: 1.65 targets roughly 95% availability. */
const SERVICE_FACTOR = 1.65;

function latestSnapshots(inventory) {
  const latest = new Map();
  for (const snapshot of inventory) {
    const key = `${snapshot.store_ID}|${snapshot.article_ID}`;
    const current = latest.get(key);
    if (!current || snapshot.businessDate > current.businessDate) latest.set(key, snapshot);
  }
  return latest;
}

/**
 * @param {Object} input
 * @param {Array} input.inventory  InventorySnapshots rows
 * @param {Array} input.hourlySales
 * @param {Array} input.articles
 * @param {Array} input.suppliers
 * @param {Array} input.stores
 * @param {Array} [input.forecasts] DemandForecasts rows, used when available
 * @returns {Array} ReplenishmentTasks rows
 */
function planReplenishment({ inventory, hourlySales, articles, suppliers, stores, forecasts = [] }) {
  if (!inventory.length || !articles.length) return [];

  const articleById = new Map(articles.map((article) => [article.ID, article]));
  const supplierById = new Map(suppliers.map((supplier) => [supplier.ID, supplier]));
  const storeById = new Map(stores.map((store) => [store.ID, store]));
  const snapshots = latestSnapshots(inventory);

  // Daily demand history per store/article, for the level and its variability.
  const dailyByKey = new Map();
  for (const row of hourlySales) {
    const key = `${row.store_ID}|${row.article_ID}`;
    if (!dailyByKey.has(key)) dailyByKey.set(key, new Map());
    const perDay = dailyByKey.get(key);
    perDay.set(row.businessDate, (perDay.get(row.businessDate) || 0) + (Number(row.quantity) || 0));
  }

  // Forecast demand per store/article per day, when scenario 1 has run.
  const forecastByKey = new Map();
  for (const row of forecasts) {
    const key = `${row.store_ID}|${row.article_ID}`;
    forecastByKey.set(key, (forecastByKey.get(key) || 0) + (Number(row.predictedQty) || 0));
  }
  const forecastHorizonDays = forecasts.length
    ? new Set(forecasts.map((row) => row.businessDate)).size
    : 0;

  const lastDate = hourlySales.map((row) => row.businessDate).sort().pop();
  const tasks = [];

  for (const [key, snapshot] of snapshots) {
    const [storeId, articleId] = key.split('|');
    const article = articleById.get(articleId);
    const store = storeById.get(storeId);
    if (!article || !store) continue;

    const supplier = supplierById.get(article.supplier_ID);
    const leadTimeDays = Number(supplier?.leadTimeDays) || 3;
    const reliability = clamp(Number(supplier?.reliability) || 0.95, 0.5, 1);

    const perDay = dailyByKey.get(key);
    if (!perDay || perDay.size < 5) continue;
    const series = [...perDay.values()];
    const dailyDemand = mean(series);
    if (dailyDemand <= 0) continue;

    // Prefer the forecast where we have one; fall back to the historical mean.
    const forecastDaily = forecastHorizonDays
      ? (forecastByKey.get(key) || 0) / forecastHorizonDays
      : 0;
    const expectedDaily = forecastDaily > 0 ? forecastDaily : dailyDemand;

    const leadTimeDemand = expectedDaily * leadTimeDays;
    const demandSigma = stdev(series) * Math.sqrt(leadTimeDays);
    const safetyStock = (SERVICE_FACTOR * demandSigma) / reliability;

    const onHand = Number(snapshot.countedStock) || 0;
    const onOrder = Number(snapshot.onOrder) || 0;
    const reorderPoint = leadTimeDemand + safetyStock;
    const recommended = reorderPoint - onHand - onOrder;
    if (recommended <= 0.5) continue;

    // Coverage in trading hours, which is what a store manager acts on.
    const openHours = Math.max(1, (Number(store.closesAt) || 24) - (Number(store.opensAt) || 0));
    const hourlyDemand = expectedDaily / openHours;
    const coverageHours = hourlyDemand > 0 ? onHand / hourlyDemand : 999;

    // Probability of running out before the delivery lands, from the normal
    // approximation of demand over the lead time.
    const shortfall = leadTimeDemand - (onHand + onOrder);
    const stockoutRisk = demandSigma > 0
      ? clamp(0.5 * (1 + erf(shortfall / (demandSigma * Math.SQRT2))), 0, 1)
      : (shortfall > 0 ? 0.95 : 0.05);

    const unitMargin = (Number(article.unitPriceGross) || 0) / (1 + (Number(article.vatRatePct) || 0) / 100)
      - (Number(article.unitCost) || 0);
    const lostSalesValue = Math.max(0, shortfall) * Math.max(unitMargin, 0) * stockoutRisk;

    // Urgency: below a shift's worth of cover is critical for an unstaffed store.
    const urgencyScore = clamp(100 - coverageHours * 4, 0, 100);

    tasks.push({
      store_ID: storeId,
      article_ID: articleId,
      supplier_ID: article.supplier_ID,
      dueOn: lastDate,
      onHand: round(onHand, 3),
      reorderPoint: round(reorderPoint, 3),
      recommendedQty: round(Math.ceil(recommended), 3),
      coverageHours: round(Math.min(coverageHours, 999), 2),
      urgency: severityFor(urgencyScore, [35, 60, 80]),
      criticality: criticalityFor(severityFor(urgencyScore, [35, 60, 80])),
      state: 'OPEN',
      stockoutRisk: round(stockoutRisk, 4),
      lostSalesValue: round(lostSalesValue, 2),
      currency_code: 'EUR',
      reasoning: `${round(expectedDaily, 2)} units/day expected, ${leadTimeDays}-day lead time from `
        + `${supplier?.name || 'supplier'} (reliability ${(reliability * 100).toFixed(1)}%). `
        + `Cover is ${round(coverageHours, 1)}h against a reorder point of ${round(reorderPoint, 1)} units.`,
    });
  }

  tasks.sort((a, b) => (b.lostSalesValue - a.lostSalesValue) || (a.coverageHours - b.coverageHours));
  return tasks.map((task, index) => ({
    ID: `RP-${(index + 1).toString().padStart(6, '0')}`,
    ...task,
  }));
}

/** Abramowitz-Stegun error function; accurate to ~1e-7, which is plenty here. */
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const absolute = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * absolute);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t
    + 0.254829592) * t * Math.exp(-absolute * absolute);
  return sign * y;
}

module.exports = { planReplenishment };
