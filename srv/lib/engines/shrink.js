'use strict';

/**
 * Scenario 2 - autonomous checkout integrity.
 *
 * At a staffed till a voided line usually means a customer changed their mind.
 * At an RFID gate it usually means something went wrong: a tag that did not
 * read, a tag still on an item that left the store, a basket abandoned at the
 * gate, or a price that does not match the master record. The SAP export from
 * Walldorf shows the scale of it - 3,217 cancellations against 2,550 completed
 * receipts - which is why this is worth its own engine.
 *
 * Four independent signals are evaluated per store/terminal/article:
 *
 *   1. Cancellation rate well above the article's own network baseline.
 *   2. An article sold through an autonomous gate without an RFID tag.
 *   3. Counted stock persistently below book stock.
 *   4. A cancelled value per unit that disagrees with the master price, which
 *      catches master-data and shelf-label errors rather than theft.
 *
 * Each produces a 0..100 score; the strongest signal names the pattern and the
 * alert carries the evidence behind it.
 */

const { sum, mean, stdev, groupBy, round, clamp, severityFor, criticalityFor } = require('../stats');

/** An article needs this many cancellations before its rate is meaningful. */
const MIN_CANCELLATIONS = 3;

/** Book-vs-counted gap, as a share of book stock, that counts as a variance. */
const VARIANCE_THRESHOLD = 0.06;

function buildContext({ cancellations, hourlySales, articles, posSystems, inventory = [] }) {
  const articleById = new Map(articles.map((article) => [article.ID, article]));
  const posById = new Map(posSystems.map((terminal) => [terminal.ID, terminal]));

  const soldByStoreArticle = new Map();
  for (const row of hourlySales) {
    const key = `${row.store_ID}|${row.article_ID}`;
    soldByStoreArticle.set(key, (soldByStoreArticle.get(key) || 0) + (Number(row.quantity) || 0));
  }

  // Network-wide cancellation rate per article: the baseline each store is
  // compared against, so a genuinely fiddly product does not alarm everywhere.
  const cancelledByArticle = new Map();
  const soldByArticle = new Map();
  for (const row of cancellations) {
    cancelledByArticle.set(row.article_ID,
      (cancelledByArticle.get(row.article_ID) || 0) + (Number(row.cancelledQuantity) || 0));
  }
  for (const row of hourlySales) {
    soldByArticle.set(row.article_ID,
      (soldByArticle.get(row.article_ID) || 0) + (Number(row.quantity) || 0));
  }
  const baselineRate = new Map();
  for (const [articleId, cancelled] of cancelledByArticle) {
    const soldUnits = soldByArticle.get(articleId) || 0;
    baselineRate.set(articleId, cancelled / Math.max(cancelled + soldUnits, 1));
  }

  const varianceByStoreArticle = new Map();
  for (const snapshot of inventory) {
    const key = `${snapshot.store_ID}|${snapshot.article_ID}`;
    const book = Number(snapshot.bookStock) || 0;
    const counted = Number(snapshot.countedStock) || 0;
    if (book <= 0) continue;
    if (!varianceByStoreArticle.has(key)) varianceByStoreArticle.set(key, []);
    varianceByStoreArticle.get(key).push((book - counted) / book);
  }

  return { articleById, posById, soldByStoreArticle, baselineRate, varianceByStoreArticle };
}

/**
 * @returns {Array} ShrinkAlerts rows, highest score first
 */
function detectShrink(input) {
  const { cancellations, articles } = input;
  if (!cancellations.length || !articles.length) return [];

  const context = buildContext(input);
  const { articleById, posById, soldByStoreArticle, baselineRate, varianceByStoreArticle } = context;

  // Roll the daily cancellation rows up to store/terminal/article.
  const grouped = groupBy(cancellations,
    (row) => `${row.store_ID}|${row.posSystem_ID}|${row.article_ID}`);

  const alerts = [];
  for (const [key, rows] of grouped) {
    const [storeId, posId, articleId] = key.split('|');
    const article = articleById.get(articleId);
    const terminal = posById.get(posId);
    if (!article) continue;

    const events = sum(rows.map((row) => Number(row.cancellationCount) || 0));
    const quantity = sum(rows.map((row) => Number(row.cancelledQuantity) || 0));
    const amount = sum(rows.map((row) => Number(row.cancelledAmount) || 0));
    if (events < MIN_CANCELLATIONS) continue;

    const soldUnits = soldByStoreArticle.get(`${storeId}|${articleId}`) || 0;
    const rate = quantity / Math.max(quantity + soldUnits, 1);
    const baseline = baselineRate.get(articleId) ?? 0.05;
    const isAutonomous = terminal?.kind === 'RFID_AUTONOMOUS';

    const signals = [];

    // 1. Rate above the article's own baseline. Expressed as a ratio so a
    //    product that is cancelled 2% of the time everywhere does not fire.
    if (rate > baseline && baseline > 0) {
      const excess = (rate - baseline) / baseline;
      signals.push({
        pattern: isAutonomous ? 'RFID_MISREAD' : 'BASKET_ABANDONED',
        score: clamp(excess * 45, 0, 100),
        evidence: `Cancellation rate ${(rate * 100).toFixed(1)}% against a network baseline of `
          + `${(baseline * 100).toFixed(1)}% for this article (${events} events, ${quantity} units).`,
        action: isAutonomous
          ? 'Re-tag the facing and run an RFID read test at the gate antenna.'
          : 'Review basket abandonment at this terminal with the shift lead.',
      });
    }

    // 2. Untagged article moving through an unstaffed gate: it cannot be read,
    //    so every trip is a manual intervention or a walkout.
    if (isAutonomous && article.isRfidTagged === false) {
      signals.push({
        pattern: 'TAG_ABSENT',
        score: clamp(60 + events, 0, 100),
        evidence: `${article.name} is not RFID tagged but is being presented at an autonomous gate `
          + `(${events} cancellations, ${quantity} units).`,
        action: 'Add the article to the RFID tagging list or block it from the autonomous assortment.',
      });
    }

    // 3. Cancelled value per unit disagreeing with the master price points at a
    //    master-data or shelf-label problem rather than at loss.
    const listPrice = Number(article.unitPriceGross) || 0;
    const impliedPrice = quantity > 0 ? amount / quantity : 0;
    if (listPrice > 0 && impliedPrice > 0) {
      const ratio = impliedPrice / listPrice;
      if (ratio > 1.5 || ratio < 0.5) {
        signals.push({
          pattern: 'PRICE_ERROR',
          score: clamp(Math.abs(Math.log2(ratio)) * 55, 0, 100),
          evidence: `Cancelled value implies EUR ${impliedPrice.toFixed(2)} per unit but the master `
            + `price is EUR ${listPrice.toFixed(2)} (factor ${ratio.toFixed(2)}).`,
          action: 'Reconcile the article master price with the electronic shelf label.',
        });
      }
    }

    // 4. Counted stock persistently short of book stock.
    const variances = varianceByStoreArticle.get(`${storeId}|${articleId}`) || [];
    if (variances.length >= 5) {
      const averageVariance = mean(variances);
      if (averageVariance > VARIANCE_THRESHOLD) {
        signals.push({
          pattern: 'STOCK_VARIANCE',
          score: clamp(averageVariance * 220, 0, 100),
          evidence: `Counted stock runs ${(averageVariance * 100).toFixed(1)}% below book stock across `
            + `${variances.length} daily counts.`,
          action: 'Schedule a cycle count and check the shelf for concealed removals.',
        });
      }
    }

    if (!signals.length) continue;
    signals.sort((a, b) => b.score - a.score);
    const strongest = signals[0];

    // Blend in value at risk so an expensive rare failure ranks alongside a
    // cheap frequent one.
    const valueWeight = clamp(Math.log10(1 + amount) * 12, 0, 30);
    const finalScore = clamp(strongest.score * 0.75 + valueWeight, 0, 100);

    alerts.push({
      store_ID: storeId,
      posSystem_ID: posId,
      article_ID: articleId,
      detectedOn: rows.map((row) => row.businessDate).sort().pop(),
      pattern: strongest.pattern,
      severity: severityFor(finalScore, [30, 55, 78]),
      criticality: criticalityFor(severityFor(finalScore, [30, 55, 78])),
      state: 'OPEN',
      anomalyScore: round(finalScore, 2),
      cancellationRate: round(rate, 4),
      baselineRate: round(baseline, 4),
      valueAtRisk: round(amount, 2),
      currency_code: 'EUR',
      evidence: signals.map((signal) => signal.evidence).join(' ').slice(0, 400),
      recommendedAction: strongest.action.slice(0, 200),
    });
  }

  alerts.sort((a, b) => b.anomalyScore - a.anomalyScore);
  return alerts.map((alert, index) => ({
    ID: `SA-${(index + 1).toString().padStart(6, '0')}`,
    ...alert,
  }));
}

module.exports = { detectShrink };
