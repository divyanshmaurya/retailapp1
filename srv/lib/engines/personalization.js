'use strict';

/**
 * Scenario 6 - personalised offers for the S.Mart Grocery App.
 *
 * Entry to an autonomous store is by QR code from the app, so every autonomous
 * basket is attributable to a known customer. That makes a light-touch
 * recommender practical without any tracking the customer has not opted into -
 * and the engine only ever emits offers for customers who granted marketing
 * consent.
 *
 * Candidates come from two places:
 *
 *   - Affinity: articles that co-occur with what this customer already buys,
 *     taken from the scenario 5 rules, which covers discovery.
 *   - Replenishment: articles the customer buys on a regular cadence and is now
 *     due to buy again, which covers routine.
 *
 * Propensity blends how often the customer buys the category, how recently they
 * shopped, and the strength of the affinity rule. It is a transparent score,
 * not a black box, so the rationale can be shown next to the offer.
 */

const { mean, stdev, groupBy, round, clamp } = require('../stats');

const MAX_OFFERS_PER_CUSTOMER = 3;

/** Customers with fewer baskets than this have too little signal. */
const MIN_BASKETS = 4;

/**
 * @param {Object} input
 * @param {Array} input.customers
 * @param {Array} input.receipts
 * @param {Array} input.receiptItems
 * @param {Array} input.articles
 * @param {Array} input.affinities  output of the affinity engine
 * @returns {Array} NextBestOffers rows
 */
function buildOffers({ customers, receipts, receiptItems, articles, affinities = [] }) {
  const articleById = new Map(articles.map((article) => [article.ID, article]));
  const itemsByReceipt = groupBy(receiptItems, (item) => item.receipt_ID);

  // Affinity rules indexed by antecedent, strongest first.
  const rulesByAntecedent = new Map();
  for (const rule of affinities) {
    if (!rulesByAntecedent.has(rule.antecedent_ID)) rulesByAntecedent.set(rule.antecedent_ID, []);
    rulesByAntecedent.get(rule.antecedent_ID).push(rule);
  }
  for (const rules of rulesByAntecedent.values()) {
    rules.sort((a, b) => Number(b.lift) - Number(a.lift));
  }

  const receiptsByCustomer = groupBy(
    receipts.filter((receipt) => receipt.customer_ID),
    (receipt) => receipt.customer_ID,
  );

  const lastDate = receipts.map((receipt) => receipt.businessDate).sort().pop();
  const today = new Date(`${lastDate}T00:00:00Z`);
  const offers = [];

  for (const customer of customers) {
    // No consent, no offer.
    if (String(customer.consentMarketing).toLowerCase() !== 'true') continue;

    const customerReceipts = receiptsByCustomer.get(customer.ID) || [];
    if (customerReceipts.length < MIN_BASKETS) continue;

    const dates = customerReceipts.map((receipt) => receipt.businessDate).sort();
    const daysSinceLast = Math.round(
      (today - new Date(`${dates[dates.length - 1]}T00:00:00Z`)) / 86400000,
    );

    // Purchase counts and per-article cadence.
    const purchaseCount = new Map();
    const purchaseDates = new Map();
    for (const receipt of customerReceipts) {
      for (const item of itemsByReceipt.get(receipt.ID) || []) {
        purchaseCount.set(item.article_ID, (purchaseCount.get(item.article_ID) || 0) + 1);
        if (!purchaseDates.has(item.article_ID)) purchaseDates.set(item.article_ID, []);
        purchaseDates.get(item.article_ID).push(receipt.businessDate);
      }
    }
    if (!purchaseCount.size) continue;

    const owned = new Set(purchaseCount.keys());
    const totalBaskets = customerReceipts.length;
    const candidates = new Map();

    // --- Routine: articles bought on a regular cadence and now due ------------
    for (const [articleId, dateList] of purchaseDates) {
      if (dateList.length < 3) continue;
      const sorted = [...dateList].sort();
      const gaps = [];
      for (let index = 1; index < sorted.length; index += 1) {
        gaps.push((new Date(`${sorted[index]}T00:00:00Z`)
          - new Date(`${sorted[index - 1]}T00:00:00Z`)) / 86400000);
      }
      const cadence = mean(gaps);
      if (cadence <= 0) continue;
      const sinceLastPurchase = (today - new Date(`${sorted[sorted.length - 1]}T00:00:00Z`)) / 86400000;
      const overdue = sinceLastPurchase / cadence;
      // Due, but not so stale that the habit has clearly lapsed.
      if (overdue < 0.8 || overdue > 3) continue;

      const regularity = 1 - clamp(stdev(gaps) / cadence, 0, 1);
      candidates.set(articleId, {
        articleId,
        source: 'ROUTINE',
        score: clamp(0.35 + regularity * 0.4 + clamp(overdue - 0.8, 0, 1) * 0.2, 0, 0.95),
        rationale: `Buys ${articleById.get(articleId)?.name || articleId} about every `
          + `${round(cadence, 1)} days and is ${round(sinceLastPurchase, 0)} days on from the last one.`,
      });
    }

    // --- Discovery: strong affinity from something they already buy -----------
    const topOwned = [...purchaseCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    for (const [articleId, count] of topOwned) {
      for (const rule of (rulesByAntecedent.get(articleId) || []).slice(0, 3)) {
        const target = rule.consequent_ID;
        if (owned.has(target) || candidates.has(target)) continue;
        const article = articleById.get(target);
        if (!article) continue;

        const attachment = count / totalBaskets;
        const liftScore = clamp((Number(rule.lift) - 1) / 2, 0, 1);
        candidates.set(target, {
          articleId: target,
          source: 'DISCOVERY',
          score: clamp(0.2 + liftScore * 0.45 + attachment * 0.25, 0, 0.9),
          rationale: `${article.name} sells with ${articleById.get(articleId)?.name || articleId} at `
            + `${round(Number(rule.lift), 2)}x lift, and that is one of this customer's regular buys.`,
        });
      }
    }

    if (!candidates.size) continue;

    // Recency: someone who shopped yesterday is far more likely to act.
    const recencyFactor = clamp(1 - daysSinceLast / 30, 0.2, 1);
    // Loyalty tier gets a modest nudge and a deeper offer.
    const tierBoost = { PLATINUM: 0.12, GOLD: 0.08, SILVER: 0.04, BRONZE: 0 }[customer.loyaltyTier] || 0;

    const ranked = [...candidates.values()]
      .map((candidate) => ({
        ...candidate,
        propensity: clamp(candidate.score * recencyFactor + tierBoost, 0, 0.99),
      }))
      .sort((a, b) => b.propensity - a.propensity)
      .slice(0, MAX_OFFERS_PER_CUSTOMER);

    for (const candidate of ranked) {
      const article = articleById.get(candidate.articleId);
      if (!article) continue;
      const grossPrice = Number(article.unitPriceGross) || 0;

      // Discovery needs a reason to try; routine only needs a reminder.
      const baseDiscount = candidate.source === 'DISCOVERY' ? 15 : 8;
      const discountPct = round(clamp(baseDiscount + tierBoost * 40, 5, 30), 2);

      offers.push({
        ID: `NBO-${(offers.length + 1).toString().padStart(6, '0')}`,
        customer_ID: customer.ID,
        store_ID: customer.homeStore_ID,
        article_ID: candidate.articleId,
        validFrom: lastDate,
        validTo: addDays(lastDate, 14),
        propensity: round(candidate.propensity, 4),
        offerDiscountPct: discountPct,
        expectedRevenue: round(grossPrice * (1 - discountPct / 100) * candidate.propensity, 2),
        currency_code: 'EUR',
        // The app is the primary channel; shelf labels carry the rest.
        channel: candidate.propensity > 0.5 ? 'APP_PUSH' : 'ESL',
        rationale: candidate.rationale.slice(0, 240),
        state: 'OPEN',
      });
    }
  }

  offers.sort((a, b) => b.propensity - a.propensity);
  return offers;
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

module.exports = { buildOffers };
