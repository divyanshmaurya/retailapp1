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
      ActivityLog, ScenarioOutcomes,
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
      const { scenario, store_ID: storeId, asOf } = request.data;
      const wanted = scenario ? [scenario.toUpperCase()] : SCENARIOS;

      const unknown = wanted.filter((name) => !SCENARIOS.includes(name));
      if (unknown.length) {
        return request.reject(400,
          `Unknown scenario ${unknown.join(', ')}. Expected one of ${SCENARIOS.join(', ')}.`);
      }
      if (asOf && Number.isNaN(new Date(asOf).getTime())) {
        return request.reject(400, `asOf is not a valid timestamp: ${asOf}`);
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
        const rows = generateForecasts(base.hourlySales, {
          horizonHours: 48, maxArticlesPerStore: 45, asOf,
        });
        produced.forecasts = rows;
        return {
          rows, entity: DemandForecasts,
          // Store-day is the grain replenishment is decided at, and the skill
          // figure says whether the model beat simply reusing last week - which
          // a bare WAPE at this grain does not.
          summary: `${rows.length} hourly forecasts, store-day WAPE ${rows.storeDayWape ?? 'n/a'}%`
            + ` (${rows.storeDaySkill ?? 'n/a'}% better than seasonal-naive),`
            + ` bias ${rows.bias ?? 'n/a'}%.`,
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
    // backfillActuals - match elapsed forecasts against what actually sold
    // -----------------------------------------------------------------------
    this.on('backfillActuals', async () => {
      const forecasts = await db.run(SELECT.from(DemandForecasts));
      if (!forecasts.length) return { matched: 0, wape: 0, summary: 'No forecasts to match.' };

      const sales = await db.run(SELECT.from(HourlySales));
      // Index actual sales at the forecast's own grain so a missing slot can be
      // scored as a true zero rather than skipped - an hour the model predicted
      // demand into and none arrived is exactly the error worth counting.
      const actualBy = new Map();
      for (const row of sales) {
        actualBy.set(`${row.store_ID}|${row.article_ID}|${row.businessDate}|${row.hourOfDay}`,
          Number(row.quantity) || 0);
      }

      // The last hour each store actually traded, not just the last date. A
      // forecast for 18:00 on the final day has not elapsed merely because that
      // date has been reached, and scoring it would record a confident zero for
      // an hour that has not happened yet. Stores close at different times, so
      // this is tracked per store rather than globally.
      const lastObservedHour = new Map();
      for (const row of sales) {
        const stamp = `${row.businessDate}T${String(row.hourOfDay).padStart(2, '0')}`;
        const current = lastObservedHour.get(row.store_ID);
        if (!current || stamp > current) lastObservedHour.set(row.store_ID, stamp);
      }
      const lastObserved = sales.map((row) => row.businessDate).sort().pop();

      let matched = 0;
      let totalError = 0;
      let totalActual = 0;
      let totalPredicted = 0;

      for (const forecast of forecasts) {
        // Only score hours that have actually elapsed for that store.
        if (!forecast.businessDate) continue;
        const horizon = lastObservedHour.get(forecast.store_ID);
        const stamp = `${forecast.businessDate}T${String(forecast.hourOfDay).padStart(2, '0')}`;
        if (!horizon || stamp > horizon) continue;
        const key = `${forecast.store_ID}|${forecast.article_ID}|${forecast.businessDate}|${forecast.hourOfDay}`;
        const actual = actualBy.get(key) ?? 0;
        const predicted = Number(forecast.predictedQty) || 0;

        await db.run(UPDATE(DemandForecasts)
          .set({ actualQty: actual })
          .where({ ID: forecast.ID }));

        matched += 1;
        totalError += Math.abs(actual - predicted);
        totalActual += actual;
        totalPredicted += predicted;
      }

      // WAPE divides by observed volume. If nothing sold in the matched hours
      // the ratio is undefined, and reporting it as 0% would claim perfect
      // accuracy for a window with nothing to be accurate about. Say so instead.
      const measurable = totalActual > 0;
      const wape = measurable ? round((totalError / totalActual) * 100, 2) : null;
      const bias = measurable ? round((totalPredicted / totalActual - 1) * 100, 2) : null;

      if (matched && measurable) {
        // Record these alongside the other scorecard rows so accuracy can be
        // tracked as it drifts, not only measured at backtest time.
        //
        // The bias goes with the WAPE deliberately. At SKU-hour grain a WAPE on
        // its own cannot be read: the all-zero forecast scores 100% there, so a
        // lower number can just as easily mean the model stopped predicting
        // demand as that it got better. The signed bias is what distinguishes
        // the two, and it is the one that tells a planner whether the shelves
        // are about to run empty or overfill.
        const stamp = Date.now().toString(36);
        await db.run(DELETE.from(ModelMetrics).where({
          scenario: 'DEMAND_FORECAST',
          metricName: { in: ['WAPE (live)', 'Bias (live)'] },
        }));
        await db.run(INSERT.into(ModelMetrics).entries(
          {
            ID: `MM-live-wape-${stamp}`,
            scenario: 'DEMAND_FORECAST',
            businessDate: lastObserved,
            metricName: 'WAPE (live)',
            metricValue: wape,
            unit: '%',
          },
          {
            ID: `MM-live-bias-${stamp}`,
            scenario: 'DEMAND_FORECAST',
            businessDate: lastObserved,
            metricName: 'Bias (live)',
            metricValue: bias,
            unit: '%',
          },
        ));
      }

      const summary = !matched
        ? 'No forecasts have elapsed yet - forecasts run forward from the last observed hour. '
          + 'Replay the forecast with recalculate(asOf: ...) to score it against known sales.'
        : measurable
          ? `Matched ${matched} elapsed forecasts against actual sales. Live WAPE ${wape}% at `
            + `SKU-hour grain, bias ${bias}%. Read the two together - WAPE alone falls when the `
            + 'model simply predicts less.'
          : `Matched ${matched} elapsed forecasts, but nothing sold in those hours, so WAPE is not `
            + `defined. Absolute error over the window was ${round(totalError, 2)} units.`;

      return { matched, wape, bias, summary };
    });

    // -----------------------------------------------------------------------
    // evaluateOutcomes - did acting on the recommendation actually work?
    // -----------------------------------------------------------------------
    this.on('evaluateOutcomes', async (request) => {
      const { asOf } = request.data;
      if (asOf && Number.isNaN(new Date(asOf).getTime())) {
        return request.reject(400, `asOf is not a valid date: ${asOf}`);
      }
      // Replaying measures the outcome as if the recommendation had been acted
      // on at this date instead, so the days that follow it are days the loaded
      // sales data actually covers. It changes nothing in the record of who did
      // what and when - `actedOn` is left as it was.
      const replayFrom = asOf ? new Date(asOf).toISOString().slice(0, 10) : null;

      const pending = await db.run(SELECT.from(ScenarioOutcomes).where({ verdict: 'PENDING' }));
      if (!pending.length) {
        return { evaluated: 0, confirmed: 0, missed: 0, inconclusive: 0, summary: 'Nothing pending.' };
      }

      const sales = await db.run(SELECT.from(HourlySales));
      const lastObserved = sales.map((row) => row.businessDate).sort().pop();

      // The money each replenishment task was placed to protect. It is kept on
      // the task rather than on the outcome because the outcome's expected and
      // observed values are both in units - mixing a euro figure into that pair
      // would make the two incomparable.
      const replenishmentValue = new Map(
        (await db.run(SELECT.from(ReplenishmentTasks).columns('ID', 'lostSalesValue')))
          .map((task) => [task.ID, task.lostSalesValue]),
      );

      // Units sold per store/article on or after a given date, which is the
      // observation both scenarios are measured against.
      const soldSince = (storeId, articleId, since) => sales
        .filter((row) => row.store_ID === storeId && row.article_ID === articleId
          && row.businessDate >= since)
        .reduce((total, row) => total + (Number(row.quantity) || 0), 0);

      let confirmed = 0;
      let missed = 0;
      let inconclusive = 0;
      let notYetMeasurable = 0;

      for (const outcome of pending) {
        let observed = null;
        let verdict = 'INCONCLUSIVE';
        let narrative = '';
        let delta = 0;

        // Where the measurement window starts. Normally the day the manager
        // acted; under a replay, the date being replayed to.
        const windowStart = replayFrom || outcome.actedOn;

        // An action taken after the last day of sales data has no evidence for
        // or against it yet. Saying MISSED there would be a claim the data
        // cannot support - it would mark every recommendation acted on today as
        // a failure purely because tomorrow has not been loaded.
        if (!windowStart || windowStart > lastObserved) {
          notYetMeasurable += 1;
          // Stays PENDING on purpose. INCONCLUSIVE means the measurement ran and
          // could not decide; this is the measurement not having been possible
          // yet, and writing a verdict here would freeze the row so that loading
          // the next day of sales could never settle it.
          await db.run(UPDATE(ScenarioOutcomes).set({
            narrative: `Acted on ${outcome.actedOn}, but sales data ends ${lastObserved}, so the `
              + 'observation window has not elapsed. Still pending. Re-run with asOf set to a date '
              + 'inside the loaded history to replay this against sales that are already known.',
          }).where({ ID: outcome.ID }));
          continue;
        }

        if (outcome.scenario === 'WASTE_MARKDOWN') {
          // The markdown promised to clear units that would otherwise be
          // written off. Did they move?
          observed = soldSince(outcome.store_ID, outcome.article_ID, windowStart);
          const expected = Number(outcome.expectedValue) || 0;
          if (expected <= 0) {
            verdict = 'INCONCLUSIVE';
            narrative = 'No waste was projected, so there is nothing to confirm.';
          } else if (observed >= expected) {
            verdict = 'CONFIRMED';
            delta = observed - expected;
            narrative = `${round(observed, 1)} units sold after the markdown against `
              + `${round(expected, 1)} projected as waste - the stock cleared.`;
          } else {
            verdict = 'MISSED';
            delta = observed - expected;
            narrative = `${round(observed, 1)} units sold against ${round(expected, 1)} projected as `
              + `waste, so roughly ${round(expected - observed, 1)} units were still lost.`;
          }
        } else if (outcome.scenario === 'REPLENISHMENT') {
          // The order predicted that `expected` units of demand would arrive
          // over the lead time. Selling at least that much means the demand was
          // real and the shelf served it. Selling nothing means the order was
          // not what the shelf needed. Selling some of it says neither: the
          // stock moved, but not enough to claim the projected loss was avoided,
          // so the value protected is prorated rather than granted in full.
          observed = soldSince(outcome.store_ID, outcome.article_ID, windowStart);
          const expected = Number(outcome.expectedValue) || 0;
          const atRisk = Number(replenishmentValue.get(outcome.targetId)) || 0;

          if (expected <= 0) {
            verdict = 'INCONCLUSIVE';
            narrative = 'The order covered no forecast demand, so there is nothing to confirm.';
          } else if (observed >= expected) {
            verdict = 'CONFIRMED';
            delta = atRisk;
            narrative = `${round(observed, 1)} units sold against ${round(expected, 1)} ordered to `
              + `cover demand - the shelf served it and EUR ${round(atRisk, 2)} of sales was protected.`;
          } else if (observed <= 0) {
            verdict = 'MISSED';
            delta = -atRisk;
            narrative = `Nothing sold in the ${round(expected, 1)} units the order covered, so the `
              + 'demand it was placed against did not arrive.';
          } else {
            verdict = 'INCONCLUSIVE';
            delta = round(atRisk * (observed / expected), 2);
            narrative = `${round(observed, 1)} of the ${round(expected, 1)} units ordered sold. `
              + 'The stock moved but did not meet the forecast, so only part of the projected loss '
              + `can be said to have been avoided - about EUR ${round(delta, 2)}.`;
          }
        }

        if (verdict === 'CONFIRMED') confirmed += 1;
        else if (verdict === 'MISSED') missed += 1;
        else inconclusive += 1;

        // Say so on the record when the verdict came from a replay rather than
        // from the window that actually followed the action, so a confirmed
        // outcome can never be read as more evidence than it is.
        if (replayFrom) {
          narrative = `[replayed from ${replayFrom}] ${narrative}`;
        }

        await db.run(UPDATE(ScenarioOutcomes).set({
          measuredOn: lastObserved,
          observedValue: observed,
          verdict,
          valueDelta: round(delta, 2),
          narrative: narrative.slice(0, 400),
        }).where({ ID: outcome.ID }));
      }

      // `evaluated` counts what was actually measured, not what was looked at.
      // Rows whose window has not elapsed are still pending and are reported
      // separately, so the totals never imply evidence that does not exist.
      const evaluated = confirmed + missed + inconclusive;
      return {
        evaluated,
        confirmed,
        missed,
        inconclusive,
        stillPending: notYetMeasurable,
        summary: `Evaluated ${evaluated} outcomes: ${confirmed} confirmed, ${missed} missed, `
          + `${inconclusive} inconclusive.`
          + (notYetMeasurable
            ? ` ${notYetMeasurable} left pending - acted on after the last day of loaded sales, `
              + 'so there is nothing yet to measure them against.'
            : ''),
      };
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

    /** Who is acting, for the audit trail. */
    const actor = (request) => request.user?.id || 'anonymous';

    /**
     * Record a state change. The operator's note goes here rather than onto the
     * record: an earlier version wrote it over `recommendedAction`, which threw
     * away the engine's advice the moment anyone acknowledged an alert.
     */
    const logActivity = async (request, entity, row, action, fromState, toState, note, actedValue) => {
      await db.run(INSERT.into(ActivityLog).entries({
        ID: `AL-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        targetEntity: entity,
        targetId: row.ID,
        store_ID: row.store_ID ?? null,
        scenario: row.scenario ?? SCENARIO_OF[entity] ?? null,
        action,
        fromState: fromState ?? null,
        toState: toState ?? null,
        note: note ? String(note).slice(0, 400) : null,
        changedBy: actor(request),
        changedAt: new Date().toISOString(),
        actedValue: actedValue ?? null,
      }));
    };

    /**
     * Open an outcome for measurement. Acting on a recommendation makes a
     * prediction; this is what later gets checked against what happened.
     */
    const openOutcome = async (row, scenario, entity, expected, unit, narrative) => {
      const today = new Date().toISOString().slice(0, 10);
      await db.run(INSERT.into(ScenarioOutcomes).entries({
        ID: `SO-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        scenario,
        targetEntity: entity,
        targetId: row.ID,
        store_ID: row.store_ID ?? null,
        article_ID: row.article_ID ?? null,
        actedOn: today,
        measuredOn: null,
        expectedValue: expected,
        observedValue: null,
        unit,
        verdict: 'PENDING',
        valueDelta: null,
        currency_code: 'EUR',
        narrative: narrative.slice(0, 400),
      }));
    };

    const SCENARIO_OF = {
      ShrinkAlerts: 'CHECKOUT_INTEGRITY',
      ReplenishmentTasks: 'REPLENISHMENT',
      MarkdownRecommendations: 'WASTE_MARKDOWN',
      NextBestOffers: 'PERSONALISATION',
      ColdChainAlerts: 'COLD_CHAIN',
      AIInsights: 'INSIGHT_FEED',
    };

    const transition = (entity, entityName, nextState, noteField, actionId) => async (request) => {
      const key = request.params[request.params.length - 1];
      const id = typeof key === 'object' ? key.ID : key;
      const [row] = await db.run(SELECT.from(entity).where({ ID: id }));
      if (!row) return request.reject(404, `No such record: ${id}.`);
      if (row.state === nextState) {
        return request.reject(409, `Record ${id} is already ${nextState}.`);
      }

      await db.run(UPDATE(entity).set({ state: nextState }).where({ ID: id }));
      await logActivity(request, entityName, row, actionId, row.state, nextState,
        request.data[noteField]);
      return { ...row, state: nextState };
    };

    const bind = (actionId, entityName, entity, nextState, noteField) =>
      this.on(actionId, entityName, transition(entity, entityName, nextState, noteField, actionId));

    bind('acknowledge', 'ShrinkAlerts', ShrinkAlerts, 'ACKNOWLEDGED', 'note');
    bind('resolveAlert', 'ShrinkAlerts', ShrinkAlerts, 'RESOLVED', 'resolution');
    bind('dismiss', 'ShrinkAlerts', ShrinkAlerts, 'DISMISSED', 'reason');
    bind('dismiss', 'ReplenishmentTasks', ReplenishmentTasks, 'DISMISSED', 'reason');
    bind('dismiss', 'MarkdownRecommendations', MarkdownRecommendations, 'DISMISSED', 'reason');
    bind('activate', 'NextBestOffers', NextBestOffers, 'ACKNOWLEDGED', 'note');
    bind('dismiss', 'NextBestOffers', NextBestOffers, 'DISMISSED', 'reason');
    bind('acknowledge', 'ColdChainAlerts', ColdChainAlerts, 'ACKNOWLEDGED', 'note');
    bind('resolveAlert', 'ColdChainAlerts', ColdChainAlerts, 'RESOLVED', 'resolution');
    bind('acknowledge', 'AIInsights', AIInsights, 'ACKNOWLEDGED', 'note');
    bind('dismiss', 'AIInsights', AIInsights, 'DISMISSED', 'reason');

    this.on('releaseOrder', 'ReplenishmentTasks', async (request) => {
      const key = request.params[request.params.length - 1];
      const id = typeof key === 'object' ? key.ID : key;
      const [task] = await db.run(SELECT.from(ReplenishmentTasks).where({ ID: id }));
      if (!task) return request.reject(404, `No such task: ${id}.`);
      if (task.state !== 'OPEN') return request.reject(409, `Task ${id} is already ${task.state}.`);

      const quantity = request.data.quantity ?? task.recommendedQty;
      if (Number(quantity) <= 0) {
        return request.reject(400, 'Order quantity must be greater than zero.');
      }
      // The recommendation is history now, so record what was actually ordered
      // in the audit trail rather than overwriting the proposal.
      await db.run(UPDATE(ReplenishmentTasks).set({ state: 'RESOLVED' }).where({ ID: id }));
      await logActivity(request, 'ReplenishmentTasks', task, 'releaseOrder',
        task.state, 'RESOLVED', `Ordered ${quantity} units`, quantity);
      // Measured in units, not euros. The order predicts that this much demand
      // will arrive and be served; units sold is the observation that answers
      // it. The money the order was meant to protect is carried separately as
      // the outcome's value, so the expected and observed figures stay on the
      // same scale and can honestly be compared.
      await openOutcome(task, 'REPLENISHMENT', 'ReplenishmentTasks',
        Number(task.recommendedQty) || 0, 'units',
        `Ordered ${quantity} units against a recommended ${task.recommendedQty}. `
        + `Expected to avoid EUR ${task.lostSalesValue} of lost sales.`);
      return { ...task, state: 'RESOLVED' };
    });

    this.on('applyMarkdown', 'MarkdownRecommendations', async (request) => {
      const key = request.params[request.params.length - 1];
      const id = typeof key === 'object' ? key.ID : key;
      const [row] = await db.run(SELECT.from(MarkdownRecommendations).where({ ID: id }));
      if (!row) return request.reject(404, `No such recommendation: ${id}.`);
      if (row.state !== 'OPEN') return request.reject(409, `Recommendation ${id} is already ${row.state}.`);

      const discount = request.data.discountPct ?? row.recommendedDiscountPct;
      if (Number(discount) <= 0 || Number(discount) > 90) {
        return request.reject(400, 'Markdown must be between 0 and 90 percent.');
      }
      await db.run(UPDATE(MarkdownRecommendations).set({ state: 'RESOLVED' }).where({ ID: id }));
      await logActivity(request, 'MarkdownRecommendations', row, 'applyMarkdown',
        row.state, 'RESOLVED', `Applied ${discount}% markdown`, discount);
      await openOutcome(row, 'WASTE_MARKDOWN', 'MarkdownRecommendations',
        Number(row.projectedWaste) || 0, 'units',
        `Applied ${discount}% against a recommended ${row.recommendedDiscountPct}%. `
        + `Expected to clear ${row.projectedWaste} units that would otherwise be written off.`);
      return { ...row, state: 'RESOLVED' };
    });

    await super.init();
  }
};
