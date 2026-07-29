'use strict';

/**
 * Scenario 4 - fresh-food waste and markdown.
 *
 * The Walldorf assortment carries a lot of same-day food: homemade buns,
 * sandwiches, wraps, salads. Anything unsold at closing is written off, so the
 * question is not "should we discount" but "how deep, and when".
 *
 * For each perishable holding we project how much will sell at full price in
 * the hours left before expiry, then sweep candidate discount depths. A deeper
 * cut lifts demand but gives away margin, so we score each depth by
 *
 *     recovery(d) = min(onHand, sellThrough x uplift(d)) x price x (1 - d)
 *                   - writeOffCost(units still unsold)
 *
 * and keep the best. Uplift uses a constant-elasticity response calibrated so
 * a 30% cut roughly doubles velocity, which is typical for food-to-go.
 */

const { mean, groupBy, round, clamp, severityFor, criticalityFor } = require('../stats');

/** Discount depths the engine is allowed to propose. */
const CANDIDATE_DEPTHS = [0, 0.10, 0.20, 0.30, 0.40, 0.50];

/** Price elasticity of demand for food-to-go; negative by convention. */
const ELASTICITY = -2.3;

/** Disposal costs money as well as losing the margin. */
const DISPOSAL_COST_PER_UNIT = 0.08;

function upliftFactor(depth) {
  if (depth <= 0) return 1;
  // Constant-elasticity response: quantity scales with (newPrice/oldPrice)^e.
  return (1 - depth) ** ELASTICITY;
}

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
 * @param {Array} input.inventory
 * @param {Array} input.hourlySales
 * @param {Array} input.articles
 * @param {Array} input.articleGroups
 * @param {Array} input.stores
 * @returns {Array} MarkdownRecommendations rows
 */
function recommendMarkdowns({ inventory, hourlySales, articles, articleGroups, stores }) {
  const groupById = new Map(articleGroups.map((group) => [group.ID, group]));
  const articleById = new Map(articles.map((article) => [article.ID, article]));
  const storeById = new Map(stores.map((store) => [store.ID, store]));
  const snapshots = latestSnapshots(inventory);

  // Units sold and the days over which they sold, per store/article. The rate
  // has to be per *trading* hour, not per hour that happened to record a sale -
  // dividing by the latter would make every article look like it sells every
  // hour it is on the shelf, and nothing would ever be at risk.
  const daysSeen = new Map();
  const unitsSold = new Map();
  for (const row of hourlySales) {
    const key = `${row.store_ID}|${row.article_ID}`;
    unitsSold.set(key, (unitsSold.get(key) || 0) + (Number(row.quantity) || 0));
    if (!daysSeen.has(key)) daysSeen.set(key, new Set());
    daysSeen.get(key).add(row.businessDate);
  }
  const tradingDays = new Set(hourlySales.map((row) => row.businessDate)).size || 1;

  const lastDate = hourlySales.map((row) => row.businessDate).sort().pop();
  const recommendations = [];

  for (const [key, snapshot] of snapshots) {
    const [storeId, articleId] = key.split('|');
    const article = articleById.get(articleId);
    const store = storeById.get(storeId);
    if (!article || !store) continue;

    const group = groupById.get(article.group_ID);
    const shelfLife = Number(article.shelfLifeDays ?? group?.shelfLifeDays ?? 0);
    // Non-perishables never expire on the shelf; nothing to mark down.
    if (!shelfLife || shelfLife <= 0 || shelfLife > 4) continue;

    const onHand = Number(snapshot.countedStock) || 0;
    if (onHand < 2) continue;

    // Trading hours left before the stock has to be written off: the rest of
    // today plus a full trading day for each additional day of shelf life.
    const opensAt = Number(store.opensAt) || 0;
    const closesAt = Number(store.closesAt) || 24;
    const openHoursPerDay = Math.max(1, closesAt - opensAt);
    // Markdown decisions are taken mid-afternoon, once the lunch peak is known.
    const decisionHour = 15;
    const hoursLeftToday = clamp(closesAt - decisionHour, 1, openHoursPerDay);
    const hoursLeft = hoursLeftToday + (shelfLife - 1) * openHoursPerDay;

    // Average daily sales for this article, spread over the trading day.
    const soldDays = daysSeen.get(key)?.size || 0;
    if (soldDays < 5) continue;
    const dailyRate = (unitsSold.get(key) || 0) / tradingDays;
    const perHour = dailyRate / openHoursPerDay;
    if (perHour <= 0) continue;

    const baselineSellThrough = perHour * hoursLeft;
    const projectedWaste = Math.max(0, onHand - baselineSellThrough);
    // Nothing meaningful at risk - the shelf will clear on its own.
    if (projectedWaste < 1) continue;

    const grossPrice = Number(article.unitPriceGross) || 0;
    const vatRate = Number(article.vatRatePct) || 0;
    const netPrice = grossPrice / (1 + vatRate / 100);
    const unitCost = Number(article.unitCost) || netPrice * 0.6;

    let best = null;
    for (const depth of CANDIDATE_DEPTHS) {
      const expectedSales = Math.min(onHand, baselineSellThrough * upliftFactor(depth));
      const unsold = Math.max(0, onHand - expectedSales);
      const revenue = expectedSales * netPrice * (1 - depth);
      const writeOff = unsold * (unitCost + DISPOSAL_COST_PER_UNIT);
      const netValue = revenue - writeOff;
      if (!best || netValue > best.netValue) {
        best = { depth, expectedSales, unsold, revenue, writeOff, netValue };
      }
    }
    if (!best || best.depth === 0) continue;

    // What doing nothing would have yielded, for the comparison shown in the UI.
    const doNothingSales = Math.min(onHand, baselineSellThrough);
    const doNothingValue = doNothingSales * netPrice
      - Math.max(0, onHand - doNothingSales) * (unitCost + DISPOSAL_COST_PER_UNIT);

    const wasteCostAvoided = (projectedWaste - best.unsold) * (unitCost + DISPOSAL_COST_PER_UNIT);
    const marginImpact = best.netValue - doNothingValue;
    const riskScore = clamp((projectedWaste / onHand) * 100, 0, 100);

    recommendations.push({
      store_ID: storeId,
      article_ID: articleId,
      businessDate: lastDate,
      expiresOn: addDays(lastDate, shelfLife),
      hoursToExpiry: round(hoursLeft, 2),
      onHand: round(onHand, 3),
      forecastSellThrough: round(baselineSellThrough, 3),
      projectedWaste: round(projectedWaste, 3),
      recommendedDiscountPct: round(best.depth * 100, 2),
      expectedRecovery: round(best.revenue, 2),
      wasteCostAvoided: round(Math.max(0, wasteCostAvoided), 2),
      marginImpact: round(marginImpact, 2),
      currency_code: 'EUR',
      criticality: criticalityFor(severityFor(riskScore, [30, 55, 75])),
      state: 'OPEN',
      severityHint: severityFor(riskScore, [30, 55, 75]),
      reasoning: `${round(onHand, 0)} units on hand against ${round(baselineSellThrough, 1)} expected `
        + `to sell in the ${round(hoursLeft, 0)}h left. A ${round(best.depth * 100, 0)}% markdown lifts `
        + `expected sales to ${round(best.expectedSales, 1)} units and recovers `
        + `EUR ${round(best.revenue, 2)} instead of writing off ${round(projectedWaste, 1)} units.`,
    });
  }

  recommendations.sort((a, b) => b.marginImpact - a.marginImpact);
  return recommendations.map((row, index) => {
    const { severityHint, ...rest } = row;
    return { ID: `MD-${(index + 1).toString().padStart(6, '0')}`, ...rest };
  });
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

module.exports = { recommendMarkdowns, upliftFactor };
