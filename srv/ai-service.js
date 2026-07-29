'use strict';

/**
 * AIService implementation.
 *
 * The `recalculate` action re-runs the scenario engines against whatever is
 * currently in the database and replaces the stored output. It is the same code
 * path `tools/generate_ai_outputs.js` uses at build time, so a live
 * recalculation and the seeded data cannot drift apart.
 */

const cds = require('@sap/cds');

const { generateForecasts } = require('./lib/engines/forecast');
const { detectShrink } = require('./lib/engines/shrink');
const { planReplenishment } = require('./lib/engines/replenishment');
const { recommendMarkdowns, upliftFactor } = require('./lib/engines/markdown');
const { mineAffinities } = require('./lib/engines/affinity');
const { buildOffers } = require('./lib/engines/personalization');
const { detectColdChain } = require('./lib/engines/coldchain');
const { buildInsightFeed, buildModelMetrics } = require('./lib/engines/insights');
const { round, clamp } = require('./lib/stats');

const SCENARIOS = [
  'DEMAND_FORECAST', 'CHECKOUT_INTEGRITY', 'REPLENISHMENT',
  'WASTE_MARKDOWN', 'MERCHANDISING', 'PERSONALISATION', 'COLD_CHAIN',
];

module.exports = class AIService extends cds.ApplicationService {
  async init() {
    const db = await cds.connect.to('db');
    const {
      DemandForecasts, ShrinkAlerts, ReplenishmentTasks, MarkdownRecommendations,
      BasketAffinities, NextBestOffers, ColdChainAlerts, AIInsights, ModelMetrics,
    } = cds.entities('smart.retail');

    const {
      Stores, Articles, ArticleGroups, Suppliers, Customers, PosSystems,
      HourlySales, Receipts, ReceiptItems, Cancellations,
      InventorySnapshots, ShelfSensorReadings,
    } = cds.entities('smart.retail');

    /** Read the base tables the engines need, optionally narrowed to one store. */
    const loadBase = async (storeId) => {
      const scope = (query) => (storeId ? query.where({ store_ID: storeId }) : query);
      const [
        stores, articles, articleGroups, suppliers, customers, posSystems,
        hourlySales, receipts, receiptItems, cancellations, inventory, sensors,
      ] = await Promise.all([
        db.run(SELECT.from(Stores)),
        db.run(SELECT.from(Articles)),
        db.run(SELECT.from(ArticleGroups)),
        db.run(SELECT.from(Suppliers)),
        db.run(SELECT.from(Customers)),
        db.run(SELECT.from(PosSystems)),
        db.run(scope(SELECT.from(HourlySales))),
        db.run(scope(SELECT.from(Receipts))),
        db.run(SELECT.from(ReceiptItems)),
        db.run(scope(SELECT.from(Cancellations))),
        db.run(scope(SELECT.from(InventorySnapshots))),
        db.run(scope(SELECT.from(ShelfSensorReadings))),
      ]);
      return {
        stores, articles, articleGroups, suppliers, customers, posSystems,
        hourlySales, receipts, receiptItems, cancellations, inventory, sensors,
      };
    };

    /** Replace the rows of one entity, scoped to a store when one is given. */
    const replace = async (entity, rows, storeId) => {
      await db.run(storeId ? DELETE.from(entity).where({ store_ID: storeId }) : DELETE.from(entity));
      if (rows.length) await db.run(INSERT.into(entity).entries(rows));
      return rows.length;
    };

    // -----------------------------------------------------------------------
    // recalculate
    // -----------------------------------------------------------------------
    this.on('recalculate', async (request) => {
      const { scenario, store_ID: storeId } = request.data;
      const wanted = scenario ? [scenario.toUpperCase()] : SCENARIOS;

      const unknown = wanted.filter((name) => !SCENARIOS.includes(name));
      if (unknown.length) {
        return request.reject(400,
          `Unknown scenario ${unknown.join(', ')}. Expected one of ${SCENARIOS.join(', ')}.`);
      }

      const base = await loadBase(storeId);
      if (!base.hourlySales.length) {
        return request.reject(404, storeId
          ? `No sales history for store ${storeId}.`
          : 'No sales history loaded.');
      }

      const results = [];
      // Later scenarios consume earlier output, so keep what each one produced.
      const produced = {};

      const run = async (name, work) => {
        if (!wanted.includes(name)) return;
        const started = Date.now();
        const { rows, entity, summary } = await work();
        const written = await replace(entity, rows, storeId);
        results.push({
          scenario: name,
          rowsWritten: written,
          durationMs: Date.now() - started,
          summary,
        });
      };

      await run('DEMAND_FORECAST', async () => {
        const rows = generateForecasts(base.hourlySales, { horizonHours: 48, maxArticlesPerStore: 45 });
        produced.forecasts = rows;
        return {
          rows, entity: DemandForecasts,
          summary: `${rows.length} hourly forecasts, store-day WAPE ${rows.storeDayWape ?? 'n/a'}%.`,
        };
      });

      await run('CHECKOUT_INTEGRITY', async () => {
        const rows = detectShrink({
          cancellations: base.cancellations, hourlySales: base.hourlySales,
          articles: base.articles, posSystems: base.posSystems, inventory: base.inventory,
        });
        produced.shrinkAlerts = rows;
        const exposure = rows.reduce((total, row) => total + Number(row.valueAtRisk), 0);
        return { rows, entity: ShrinkAlerts, summary: `${rows.length} alerts, EUR ${round(exposure, 2)} at risk.` };
      });

      await run('REPLENISHMENT', async () => {
        const forecasts = produced.forecasts
          ?? await db.run(storeId
            ? SELECT.from(DemandForecasts).where({ store_ID: storeId })
            : SELECT.from(DemandForecasts));
        const rows = planReplenishment({
          inventory: base.inventory, hourlySales: base.hourlySales, articles: base.articles,
          suppliers: base.suppliers, stores: base.stores, forecasts,
        });
        produced.replenishmentTasks = rows;
        const lost = rows.reduce((total, row) => total + Number(row.lostSalesValue), 0);
        return { rows, entity: ReplenishmentTasks, summary: `${rows.length} tasks, EUR ${round(lost, 2)} exposure.` };
      });

      await run('WASTE_MARKDOWN', async () => {
        const rows = recommendMarkdowns({
          inventory: base.inventory, hourlySales: base.hourlySales,
          articles: base.articles, articleGroups: base.articleGroups, stores: base.stores,
        });
        produced.markdowns = rows;
        const margin = rows.reduce((total, row) => total + Number(row.marginImpact), 0);
        return { rows, entity: MarkdownRecommendations, summary: `${rows.length} markdowns, EUR ${round(margin, 2)} protected.` };
      });

      await run('MERCHANDISING', async () => {
        const rows = mineAffinities({
          receipts: base.receipts, receiptItems: base.receiptItems,
          articles: base.articles, articleGroups: base.articleGroups,
        });
        produced.affinities = rows;
        return { rows, entity: BasketAffinities, summary: `${rows.length} association rules mined.` };
      });

      await run('PERSONALISATION', async () => {
        const affinities = produced.affinities
          ?? await db.run(SELECT.from(BasketAffinities));
        const rows = buildOffers({
          customers: base.customers, receipts: base.receipts,
          receiptItems: base.receiptItems, articles: base.articles, affinities,
        });
        produced.offers = rows;
        return { rows, entity: NextBestOffers, summary: `${rows.length} offers for consenting customers.` };
      });

      await run('COLD_CHAIN', async () => {
        const rows = detectColdChain({
          sensors: base.sensors, articles: base.articles,
          articleGroups: base.articleGroups, inventory: base.inventory,
        });
        produced.coldChainAlerts = rows;
        const exposed = rows.reduce((total, row) => total + Number(row.stockAtRisk), 0);
        return { rows, entity: ColdChainAlerts, summary: `${rows.length} alerts, EUR ${round(exposed, 2)} exposed.` };
      });

      // Rebuild the unified feed only when every scenario has been refreshed;
      // a partial run would otherwise drop insights from untouched scenarios.
      if (!scenario) {
        const insights = buildInsightFeed({ ...produced, articles: base.articles, stores: base.stores });
        const metrics = buildModelMetrics(produced);
        const insightCount = await replace(AIInsights, insights, storeId);
        await replace(ModelMetrics, metrics, null);
        results.push({
          scenario: 'INSIGHT_FEED',
          rowsWritten: insightCount,
          durationMs: 0,
          summary: `${insightCount} ranked insights, ${metrics.length} model metrics.`,
        });
      }

      return results;
    });

    // -----------------------------------------------------------------------
    // simulateForecast - forecast without persisting
    // -----------------------------------------------------------------------
    this.on('simulateForecast', async (request) => {
      const { store_ID: storeId, article_ID: articleId, horizonHours } = request.data;
      if (!storeId || !articleId) {
        return request.reject(400, 'store_ID and article_ID are both required.');
      }

      const history = await db.run(
        SELECT.from(HourlySales).where({ store_ID: storeId, article_ID: articleId }),
      );
      if (history.length < 12) {
        return request.reject(404,
          `Not enough history for ${articleId} at ${storeId}: ${history.length} hours, 12 needed.`);
      }

      // The engine learns per store, so give it this store's full history to
      // keep the day-of-week factors representative, then filter to the article.
      const storeHistory = await db.run(SELECT.from(HourlySales).where({ store_ID: storeId }));
      const forecasts = generateForecasts(storeHistory, {
        horizonHours: horizonHours || 48,
        maxArticlesPerStore: 5000,
      });

      return forecasts
        .filter((row) => row.article_ID === articleId)
        .map((row) => ({
          forecastFor: row.forecastFor,
          hourOfDay: row.hourOfDay,
          predictedQty: row.predictedQty,
          lowerBound: row.lowerBound,
          upperBound: row.upperBound,
        }));
    });

    // -----------------------------------------------------------------------
    // simulateMarkdown - score one candidate depth
    // -----------------------------------------------------------------------
    this.on('simulateMarkdown', async (request) => {
      const { store_ID: storeId, article_ID: articleId, discountPct } = request.data;
      const depth = clamp(Number(discountPct) / 100, 0, 0.9);

      const [article] = await db.run(SELECT.from(Articles).where({ ID: articleId }));
      if (!article) return request.reject(404, `Unknown article ${articleId}.`);

      const [store] = await db.run(SELECT.from(Stores).where({ ID: storeId }));
      if (!store) return request.reject(404, `Unknown store ${storeId}.`);

      const snapshots = await db.run(
        SELECT.from(InventorySnapshots).where({ store_ID: storeId, article_ID: articleId })
          .orderBy({ businessDate: 'desc' }).limit(1),
      );
      if (!snapshots.length) {
        return request.reject(404, `No stock on record for ${articleId} at ${storeId}.`);
      }

      const history = await db.run(
        SELECT.from(HourlySales).where({ store_ID: storeId, article_ID: articleId }),
      );
      const tradingDays = new Set(
        (await db.run(SELECT.distinct.columns('businessDate').from(HourlySales)
          .where({ store_ID: storeId }))).map((row) => row.businessDate),
      ).size || 1;

      const onHand = Number(snapshots[0].countedStock) || 0;
      const openHoursPerDay = Math.max(1, (Number(store.closesAt) || 24) - (Number(store.opensAt) || 0));
      const shelfLife = Number(article.shelfLifeDays) || 1;
      const hoursLeft = clamp(Number(store.closesAt) - 15, 1, openHoursPerDay)
        + (shelfLife - 1) * openHoursPerDay;

      const unitsSold = history.reduce((total, row) => total + (Number(row.quantity) || 0), 0);
      const perHour = unitsSold / tradingDays / openHoursPerDay;
      const baseline = perHour * hoursLeft;

      const grossPrice = Number(article.unitPriceGross) || 0;
      const netPrice = grossPrice / (1 + (Number(article.vatRatePct) || 0) / 100);
      const unitCost = Number(article.unitCost) || netPrice * 0.6;

      const expectedSales = Math.min(onHand, baseline * upliftFactor(depth));
      const unsold = Math.max(0, onHand - expectedSales);
      const recovery = expectedSales * netPrice * (1 - depth);

      const doNothingSales = Math.min(onHand, baseline);
      const doNothingValue = doNothingSales * netPrice - Math.max(0, onHand - doNothingSales) * unitCost;
      const marginImpact = (recovery - unsold * unitCost) - doNothingValue;

      return {
        discountPct: round(depth * 100, 2),
        expectedSales: round(expectedSales, 3),
        expectedRecovery: round(recovery, 2),
        projectedWaste: round(unsold, 3),
        marginImpact: round(marginImpact, 2),
        verdict: marginImpact > 0
          ? `A ${round(depth * 100, 0)}% markdown is worth EUR ${round(marginImpact, 2)} more than doing nothing.`
          : `A ${round(depth * 100, 0)}% markdown gives away EUR ${round(-marginImpact, 2)} more than it recovers.`,
      };
    });

    // -----------------------------------------------------------------------
    // Queue actions - state transitions on alerts and tasks
    // -----------------------------------------------------------------------
    const transition = (entity, nextState, noteField) => async (request) => {
      const key = request.params[request.params.length - 1];
      const id = typeof key === 'object' ? key.ID : key;
      const [row] = await db.run(SELECT.from(entity).where({ ID: id }));
      if (!row) return request.reject(404, `No such record: ${id}.`);
      if (row.state === nextState) {
        return request.reject(409, `Record ${id} is already ${nextState}.`);
      }

      const patch = { state: nextState };
      const note = request.data[noteField];
      // Keep the operator's note where the entity has somewhere to put it.
      if (note && 'recommendedAction' in row) {
        patch.recommendedAction = `${nextState}: ${note}`.slice(0, 240);
      }
      await db.run(UPDATE(entity).set(patch).where({ ID: id }));
      return { ...row, ...patch };
    };

    this.on('acknowledge', 'ShrinkAlerts', transition(ShrinkAlerts, 'ACKNOWLEDGED', 'note'));
    this.on('resolveAlert', 'ShrinkAlerts', transition(ShrinkAlerts, 'RESOLVED', 'resolution'));
    this.on('dismiss', 'ShrinkAlerts', transition(ShrinkAlerts, 'DISMISSED', 'reason'));

    this.on('dismiss', 'ReplenishmentTasks', transition(ReplenishmentTasks, 'DISMISSED', 'reason'));
    this.on('releaseOrder', 'ReplenishmentTasks', async (request) => {
      const key = request.params[request.params.length - 1];
      const id = typeof key === 'object' ? key.ID : key;
      const [task] = await db.run(SELECT.from(ReplenishmentTasks).where({ ID: id }));
      if (!task) return request.reject(404, `No such task: ${id}.`);

      const quantity = request.data.quantity ?? task.recommendedQty;
      if (Number(quantity) <= 0) {
        return request.reject(400, 'Order quantity must be greater than zero.');
      }
      await db.run(UPDATE(ReplenishmentTasks)
        .set({ state: 'RESOLVED', recommendedQty: quantity })
        .where({ ID: id }));
      return { ...task, state: 'RESOLVED', recommendedQty: quantity };
    });

    this.on('dismiss', 'MarkdownRecommendations', transition(MarkdownRecommendations, 'DISMISSED', 'reason'));
    this.on('applyMarkdown', 'MarkdownRecommendations', async (request) => {
      const key = request.params[request.params.length - 1];
      const id = typeof key === 'object' ? key.ID : key;
      const [row] = await db.run(SELECT.from(MarkdownRecommendations).where({ ID: id }));
      if (!row) return request.reject(404, `No such recommendation: ${id}.`);

      const discount = request.data.discountPct ?? row.recommendedDiscountPct;
      if (Number(discount) <= 0 || Number(discount) > 90) {
        return request.reject(400, 'Markdown must be between 0 and 90 percent.');
      }
      await db.run(UPDATE(MarkdownRecommendations)
        .set({ state: 'RESOLVED', recommendedDiscountPct: discount })
        .where({ ID: id }));
      return { ...row, state: 'RESOLVED', recommendedDiscountPct: discount };
    });

    this.on('activate', 'NextBestOffers', transition(NextBestOffers, 'ACKNOWLEDGED', 'note'));
    this.on('dismiss', 'NextBestOffers', transition(NextBestOffers, 'DISMISSED', 'reason'));

    this.on('acknowledge', 'ColdChainAlerts', transition(ColdChainAlerts, 'ACKNOWLEDGED', 'note'));
    this.on('resolveAlert', 'ColdChainAlerts', transition(ColdChainAlerts, 'RESOLVED', 'resolution'));

    this.on('acknowledge', 'AIInsights', transition(AIInsights, 'ACKNOWLEDGED', 'note'));
    this.on('dismiss', 'AIInsights', transition(AIInsights, 'DISMISSED', 'reason'));

    await super.init();
  }
};
