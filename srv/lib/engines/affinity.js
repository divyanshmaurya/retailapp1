'use strict';

/**
 * Scenario 5 - basket affinity and micro-planogram.
 *
 * Classic association-rule mining over the reconstructed baskets. For a pair
 * (A, B) we compute
 *
 *     support(A,B)    = baskets containing both / all baskets
 *     confidence(A>B) = baskets containing both / baskets containing A
 *     lift            = confidence / support(B)
 *
 * Lift above 1 means the two sell together more often than chance. In a 68 m2
 * autonomous store the actionable output is placement: a strong pair sitting in
 * different temperature zones is a candidate for a secondary facing, which is
 * the one merchandising lever an unstaffed store still has.
 */

const { groupBy, round, clamp } = require('../stats');

/** A pair needs this many co-occurrences before it is worth reporting. */
const MIN_BASKETS = 8;

/** Only pairs that beat chance by this margin are kept. */
const MIN_LIFT = 1.25;

/**
 * @param {Object} input
 * @param {Array} input.receipts
 * @param {Array} input.receiptItems
 * @param {Array} input.articles
 * @param {Array} input.articleGroups
 * @param {Object} [options]
 * @returns {Array} BasketAffinities rows
 */
function mineAffinities({ receipts, receiptItems, articles, articleGroups }, { maxPerStore = 40 } = {}) {
  if (!receiptItems.length) return [];

  const articleById = new Map(articles.map((article) => [article.ID, article]));
  const groupById = new Map(articleGroups.map((group) => [group.ID, group]));
  const storeByReceipt = new Map(receipts.map((receipt) => [receipt.ID, receipt.store_ID]));

  // Basket = the distinct set of articles on one receipt.
  const basketsByStore = new Map();
  const itemsByReceipt = groupBy(receiptItems, (item) => item.receipt_ID);
  for (const [receiptId, items] of itemsByReceipt) {
    const storeId = storeByReceipt.get(receiptId);
    if (!storeId) continue;
    const distinct = [...new Set(items.map((item) => item.article_ID))];
    // Single-line baskets carry no pair information.
    if (distinct.length < 2) continue;
    if (!basketsByStore.has(storeId)) basketsByStore.set(storeId, []);
    basketsByStore.get(storeId).push(distinct);
  }

  const results = [];

  for (const [storeId, baskets] of basketsByStore) {
    const totalBaskets = baskets.length;
    if (totalBaskets < 50) continue;

    const itemCounts = new Map();
    const pairCounts = new Map();

    for (const basket of baskets) {
      for (const article of basket) {
        itemCounts.set(article, (itemCounts.get(article) || 0) + 1);
      }
      // Order the pair key so (A,B) and (B,A) land in the same bucket.
      const sorted = [...basket].sort();
      for (let i = 0; i < sorted.length; i += 1) {
        for (let j = i + 1; j < sorted.length; j += 1) {
          const key = `${sorted[i]}|${sorted[j]}`;
          pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
        }
      }
    }

    const storeRules = [];
    for (const [key, together] of pairCounts) {
      if (together < MIN_BASKETS) continue;
      const [left, right] = key.split('|');
      const leftCount = itemCounts.get(left) || 0;
      const rightCount = itemCounts.get(right) || 0;
      if (!leftCount || !rightCount) continue;

      const support = together / totalBaskets;
      const supportRight = rightCount / totalBaskets;
      const confidence = together / leftCount;
      const lift = confidence / supportRight;
      if (lift < MIN_LIFT) continue;

      const leftArticle = articleById.get(left);
      const rightArticle = articleById.get(right);
      if (!leftArticle || !rightArticle) continue;

      const leftZone = groupById.get(leftArticle.group_ID)?.tempZone || 'AMBIENT';
      const rightZone = groupById.get(rightArticle.group_ID)?.tempZone || 'AMBIENT';
      const isCrossZone = leftZone !== rightZone;

      // Uplift approximates the incremental attach revenue if the consequent
      // were placed within reach of the antecedent.
      const consequentPrice = Number(rightArticle.unitPriceGross) || 0;
      const attachGain = clamp(lift - 1, 0, 3) * 0.15;
      const upliftPerBasket = consequentPrice * confidence * attachGain;

      storeRules.push({
        store_ID: storeId,
        antecedent_ID: left,
        consequent_ID: right,
        support: round(support, 5),
        confidence: round(confidence, 4),
        lift: round(lift, 3),
        basketCount: together,
        upliftPerBasket: round(upliftPerBasket, 2),
        currency_code: 'EUR',
        isCrossZone,
        recommendedPlacement: isCrossZone
          ? `Add a secondary facing of ${rightArticle.name} beside ${leftArticle.name} `
            + `(${leftZone} vs ${rightZone} zone).`
          : `Keep ${rightArticle.name} adjacent to ${leftArticle.name} in the ${leftZone} zone.`,
      });
    }

    storeRules.sort((a, b) => (b.lift * b.basketCount) - (a.lift * a.basketCount));
    results.push(...storeRules.slice(0, maxPerStore));
  }

  results.sort((a, b) => b.lift - a.lift);
  return results.map((rule, index) => ({
    ID: `AF-${(index + 1).toString().padStart(6, '0')}`,
    ...rule,
    recommendedPlacement: rule.recommendedPlacement.slice(0, 120),
  }));
}

module.exports = { mineAffinities };
