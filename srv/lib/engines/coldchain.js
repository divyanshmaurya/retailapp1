'use strict';

/**
 * Cold chain monitoring.
 *
 * The store's chillers and freezers report a probe temperature. A single
 * reading outside the band is noise - a door held open, a delivery being put
 * away - so an alert only fires on a sustained excursion, and its severity
 * scales with both how far outside the band the unit ran and how much stock
 * sits in it. That keeps the alert list short enough to act on.
 */

const { groupBy, mean, round, clamp, severityFor, criticalityFor } = require('../stats');

/** Target temperature and tolerance per temperature zone, in Celsius. */
const ZONE_TARGETS = {
  CHILLED: { target: 5, tolerance: 3 },
  FROZEN: { target: -18, tolerance: 3 },
  HOT: { target: 63, tolerance: 5 },
};

/** Minutes each reading is taken to represent. */
const MINUTES_PER_READING = 60;

/**
 * @param {Object} input
 * @param {Array} input.sensors  ShelfSensorReadings rows
 * @param {Array} input.articles
 * @param {Array} input.articleGroups
 * @param {Array} input.inventory
 * @returns {Array} ColdChainAlerts rows
 */
function detectColdChain({ sensors, articles, articleGroups, inventory = [] }) {
  const temperatureReadings = sensors.filter((row) => row.sensorType === 'TEMPERATURE');
  if (!temperatureReadings.length) return [];

  const articleById = new Map(articles.map((article) => [article.ID, article]));
  const groupById = new Map(articleGroups.map((group) => [group.ID, group]));

  // Value of stock sitting in each store's temperature-controlled zones. Only
  // the most recent snapshot per article counts - summing every snapshot day
  // would multiply the store's stock by the length of the history.
  const latestSnapshot = new Map();
  for (const snapshot of inventory) {
    const key = `${snapshot.store_ID}|${snapshot.article_ID}`;
    const current = latestSnapshot.get(key);
    if (!current || snapshot.businessDate > current.businessDate) latestSnapshot.set(key, snapshot);
  }

  const stockValue = new Map();
  for (const snapshot of latestSnapshot.values()) {
    const article = articleById.get(snapshot.article_ID);
    if (!article) continue;
    const zone = groupById.get(article.group_ID)?.tempZone;
    if (zone !== 'CHILLED' && zone !== 'FROZEN' && zone !== 'HOT') continue;
    const key = `${snapshot.store_ID}|${zone}`;
    const value = (Number(snapshot.countedStock) || 0) * (Number(article.unitCost) || 0);
    stockValue.set(key, (stockValue.get(key) || 0) + value);
  }

  // Group readings by store, zone and day: one asset, one trading day.
  const grouped = groupBy(temperatureReadings, (row) => {
    const article = articleById.get(row.article_ID);
    const zone = groupById.get(article?.group_ID)?.tempZone || 'CHILLED';
    return `${row.store_ID}|${zone}|${String(row.readingAt).slice(0, 10)}`;
  });

  const alerts = [];
  for (const [key, readings] of grouped) {
    const [storeId, zone, day] = key.split('|');
    const profile = ZONE_TARGETS[zone];
    if (!profile) continue;

    const breaches = readings.filter((row) => {
      const value = Number(row.value);
      return Number.isFinite(value) && Math.abs(value - profile.target) > profile.tolerance;
    });
    if (!breaches.length) continue;

    const measured = mean(breaches.map((row) => Number(row.value)));
    const excursion = Math.abs(measured - profile.target) - profile.tolerance;
    const breachMinutes = breaches.length * MINUTES_PER_READING;

    // Severity rises with how far out and for how long, weighted by the value
    // of what is sitting in the unit.
    const zoneStock = stockValue.get(`${storeId}|${zone}`) || 0;
    const exposure = clamp(Math.log10(1 + zoneStock) * 10, 0, 30);
    const score = clamp(excursion * 12 + (breachMinutes / 60) * 8 + exposure, 0, 100);

    // Only the stock actually exposed is at risk, not the whole zone.
    const atRisk = zoneStock * clamp(breachMinutes / (8 * 60), 0.05, 1);

    alerts.push({
      store_ID: storeId,
      assetId: `${zone.slice(0, 2)}-${storeId}`,
      assetName: `${zone === 'FROZEN' ? 'Freezer' : zone === 'HOT' ? 'Hot hold' : 'Chiller'} cabinet - ${storeId}`,
      detectedAt: `${day}T12:00:00Z`,
      measuredTemp: round(measured, 2),
      targetTemp: profile.target,
      toleranceBand: profile.tolerance,
      breachMinutes,
      severity: severityFor(score, [30, 55, 78]),
      criticality: criticalityFor(severityFor(score, [30, 55, 78])),
      state: 'OPEN',
      stockAtRisk: round(atRisk, 2),
      currency_code: 'EUR',
      recommendedAction: excursion > 5
        ? 'Move stock to a working cabinet and raise a service call - the unit is far outside band.'
        : 'Check door seals and airflow, then re-read in one hour before moving stock.',
    });
  }

  alerts.sort((a, b) => b.stockAtRisk - a.stockAtRisk);
  return alerts.map((alert, index) => ({
    ID: `CC-${(index + 1).toString().padStart(5, '0')}`,
    ...alert,
  }));
}

module.exports = { detectColdChain };
