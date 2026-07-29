'use strict';

/**
 * Scenario 1 - hourly demand forecast.
 *
 * The store's demand is dominated by two repeating shapes: which hour of the
 * day it is (a campus store peaks over lunch) and which day of the week it is
 * (weekends collapse to a third of a weekday). So rather than fit a heavyweight
 * model, we decompose observed sales into
 *
 *     quantity ~= level x hourShare(hour) x dayFactor(weekday)
 *
 * estimate each part from history, and recombine. The level is an EWMA over
 * recent daily totals so the forecast tracks trend without over-reacting to a
 * single busy day. Prediction intervals come from the residual spread of the
 * same model on the history it was fitted to, which keeps them honest for
 * erratic slow-movers.
 */

const { sum, mean, stdev, ewma, groupBy, round, clamp } = require('../stats');

const MODEL_NAME = 'SeasonalProfile+EWMA';

/** Minimum observations before an article gets its own profile. */
const MIN_OBSERVATIONS = 12;

/**
 * @param {Array} hourlySales rows of {store_ID, article_ID, businessDate, hourOfDay, dayOfWeek, quantity}
 * @param {Object} options
 * @returns {{profiles: Map, horizonStart: string}}
 */
function learnProfiles(hourlySales) {
  const byStore = groupBy(hourlySales, (row) => row.store_ID);
  const profiles = new Map();

  for (const [storeId, storeRows] of byStore) {
    // The store's trading calendar. An article that sold on 30 of 179 days has
    // 149 genuine zeros, and they have to be part of the level - averaging only
    // the days it sold would give the mean of a selling day, not the mean of a
    // day, and the forecast would run several times too high.
    const calendar = [...new Set(storeRows.map((row) => row.businessDate))].sort();

    // Hour-of-day shares across the whole store, used as the fallback shape
    // for articles that are too sparse to have their own.
    const hourTotals = new Array(24).fill(0);
    for (const row of storeRows) hourTotals[Number(row.hourOfDay)] += Number(row.quantity) || 0;
    const hourSum = sum(hourTotals) || 1;
    const storeHourShare = hourTotals.map((value) => value / hourSum);

    // Day-of-week factors, normalised so an average day is 1.0.
    const dayTotals = new Map();
    const daySeen = new Map();
    for (const row of storeRows) {
      const weekday = Number(row.dayOfWeek);
      dayTotals.set(weekday, (dayTotals.get(weekday) || 0) + (Number(row.quantity) || 0));
      if (!daySeen.has(weekday)) daySeen.set(weekday, new Set());
      daySeen.get(weekday).add(row.businessDate);
    }
    const perWeekday = new Map();
    for (const [weekday, total] of dayTotals) {
      perWeekday.set(weekday, total / Math.max(daySeen.get(weekday).size, 1));
    }
    const averageDay = mean([...perWeekday.values()]) || 1;
    const dayFactor = new Map();
    for (const [weekday, value] of perWeekday) dayFactor.set(weekday, value / averageDay);

    const byArticle = groupBy(storeRows, (row) => row.article_ID);
    const articleProfiles = new Map();

    for (const [articleId, rows] of byArticle) {
      if (rows.length < MIN_OBSERVATIONS) continue;

      // Daily totals over the store's full calendar, zeros included, give the
      // level and its recent trend.
      const dailyTotals = new Map();
      for (const row of rows) {
        dailyTotals.set(row.businessDate,
          (dailyTotals.get(row.businessDate) || 0) + (Number(row.quantity) || 0));
      }
      const firstSale = [...dailyTotals.keys()].sort()[0];
      // Only count days from the article's first sale onwards, so a line
      // introduced late in the period is not penalised for not existing yet.
      const activeDates = calendar.filter((date) => date >= firstSale);
      const series = activeDates.map((date) => dailyTotals.get(date) || 0);
      const level = ewma(series, 0.25);

      // Article-specific hour shape, falling back to the store shape where the
      // article has too few observations in an hour to say anything.
      const articleHourTotals = new Array(24).fill(0);
      for (const row of rows) articleHourTotals[Number(row.hourOfDay)] += Number(row.quantity) || 0;
      const articleHourSum = sum(articleHourTotals) || 1;
      const blend = clamp(rows.length / 120, 0, 1);
      const hourShare = articleHourTotals.map((value, hour) =>
        blend * (value / articleHourSum) + (1 - blend) * storeHourShare[hour]);

      // Residual spread of the fitted model, used for the interval.
      const residuals = rows.map((row) => {
        const predicted = level * hourShare[Number(row.hourOfDay)] * (dayFactor.get(Number(row.dayOfWeek)) || 1);
        return (Number(row.quantity) || 0) - predicted;
      });
      const spread = stdev(residuals);

      articleProfiles.set(articleId, {
        level, hourShare, spread,
        observations: rows.length,
        lastDate: activeDates[activeDates.length - 1],
      });
    }

    profiles.set(storeId, { storeHourShare, dayFactor, articles: articleProfiles });
  }
  return profiles;
}

/**
 * Backtest on the trailing `holdoutDays`.
 *
 * Hourly SKU demand here is intermittent - most non-zero hours sell one or two
 * units - and plain MAPE is close to meaningless on that shape, because a
 * one-unit miss against a one-unit actual is a 100% error. So accuracy is
 * reported as WAPE (total absolute error over total actual volume), which is
 * the standard measure for intermittent retail demand and does not blow up on
 * small denominators. Per-article MAPE is still returned for reference.
 *
 * @returns {{mape: Map, wape: Map, overallWape: number}}
 */
function backtest(hourlySales, profiles, holdoutDays = 14) {
  const dates = [...new Set(hourlySales.map((row) => row.businessDate))].sort();
  const cutoff = dates[Math.max(0, dates.length - holdoutDays)];
  const holdout = hourlySales.filter((row) => row.businessDate >= cutoff);

  const absoluteErrors = new Map();
  const actualVolume = new Map();
  const percentErrors = new Map();
  let totalError = 0;
  let totalActual = 0;

  // Aggregated to store-day as well. Errors on individual SKU-hours partly
  // cancel out once summed, and store-day is the grain replenishment and
  // staffing decisions are actually taken at, so it is the fairer headline.
  const storeDayPredicted = new Map();
  const storeDayActual = new Map();

  // Index the observed holdout so absent slots can be scored as a true zero.
  // Scoring only the hours that recorded a sale would quietly discard every
  // hour the model predicted demand into and none arrived, which is exactly
  // the error that matters for intermittent demand.
  const observed = new Map();
  const holdoutDates = new Set();
  for (const row of holdout) {
    observed.set(`${row.store_ID}|${row.article_ID}|${row.businessDate}|${row.hourOfDay}`,
      Number(row.quantity) || 0);
    holdoutDates.add(row.businessDate);
  }
  const evaluationDates = [...holdoutDates].sort();

  for (const [storeId, storeProfile] of profiles) {
    for (const [articleId, articleProfile] of storeProfile.articles) {
      const key = `${storeId}|${articleId}`;

      for (const businessDate of evaluationDates) {
        const weekday = (new Date(`${businessDate}T00:00:00Z`).getUTCDay() + 6) % 7;
        const dayFactor = storeProfile.dayFactor.get(weekday) || 1;

        for (let hour = 0; hour < 24; hour += 1) {
          const share = articleProfile.hourShare[hour];
          const actual = observed.get(`${key}|${businessDate}|${hour}`) || 0;
          // Hours this article never trades in carry no information either way.
          if (share <= 0 && actual === 0) continue;

          const predicted = articleProfile.level * share * dayFactor;
          const error = Math.abs(actual - predicted);

          const storeDayKey = `${storeId}|${businessDate}`;
          storeDayPredicted.set(storeDayKey, (storeDayPredicted.get(storeDayKey) || 0) + predicted);
          storeDayActual.set(storeDayKey, (storeDayActual.get(storeDayKey) || 0) + actual);

          absoluteErrors.set(key, (absoluteErrors.get(key) || 0) + error);
          actualVolume.set(key, (actualVolume.get(key) || 0) + actual);
          totalError += error;
          totalActual += actual;

          // MAPE is undefined against a zero actual, so it stays on the
          // non-zero hours only; WAPE above covers the full grid.
          if (actual > 0) {
            if (!percentErrors.has(key)) percentErrors.set(key, []);
            percentErrors.get(key).push(error / actual);
          }
        }
      }
    }
  }

  const wape = new Map();
  for (const [key, error] of absoluteErrors) {
    wape.set(key, round((error / Math.max(actualVolume.get(key), 1e-9)) * 100, 2));
  }
  const mape = new Map();
  for (const [key, values] of percentErrors) mape.set(key, round(mean(values) * 100, 2));

  let storeDayError = 0;
  let storeDayTotal = 0;
  for (const [key, actual] of storeDayActual) {
    storeDayError += Math.abs(actual - (storeDayPredicted.get(key) || 0));
    storeDayTotal += actual;
  }

  return {
    mape,
    wape,
    overallWape: totalActual > 0 ? round((totalError / totalActual) * 100, 2) : 0,
    storeDayWape: storeDayTotal > 0 ? round((storeDayError / storeDayTotal) * 100, 2) : 0,
  };
}

/**
 * Produce forecasts for the next `horizonHours` after the last observed hour.
 *
 * @returns {Array} DemandForecasts rows
 */
function generateForecasts(hourlySales, { horizonHours = 48, maxArticlesPerStore = 60 } = {}) {
  if (!hourlySales.length) return [];

  const profiles = learnProfiles(hourlySales);
  const accuracy = backtest(hourlySales, profiles);
  const generatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  // Forecast forward from the last hour actually observed, not from midnight of
  // the last date - otherwise a short horizon lands entirely in the small hours
  // and returns nothing useful.
  let origin = null;
  for (const row of hourlySales) {
    const stamp = row.hourStart
      ? new Date(row.hourStart)
      : new Date(`${row.businessDate}T${String(row.hourOfDay).padStart(2, '0')}:00:00Z`);
    if (!Number.isNaN(stamp.getTime()) && (!origin || stamp > origin)) origin = stamp;
  }
  if (!origin) {
    const lastDate = hourlySales.map((row) => row.businessDate).sort().pop();
    origin = new Date(`${lastDate}T00:00:00Z`);
  }

  // Rank articles by recent volume so the table stays useful rather than huge.
  const volume = new Map();
  for (const row of hourlySales) {
    const key = `${row.store_ID}|${row.article_ID}`;
    volume.set(key, (volume.get(key) || 0) + (Number(row.quantity) || 0));
  }

  const rows = [];
  let counter = 0;

  for (const [storeId, storeProfile] of profiles) {
    const ranked = [...storeProfile.articles.keys()]
      .sort((a, b) => (volume.get(`${storeId}|${b}`) || 0) - (volume.get(`${storeId}|${a}`) || 0))
      .slice(0, maxArticlesPerStore);

    for (const articleId of ranked) {
      const articleProfile = storeProfile.articles.get(articleId);
      const key = `${storeId}|${articleId}`;
      const mape = accuracy.mape.get(key);
      const wape = accuracy.wape.get(key);

      for (let offset = 1; offset <= horizonHours; offset += 1) {
        const target = new Date(origin.getTime() + offset * 3600 * 1000);
        const hour = target.getUTCHours();
        const share = articleProfile.hourShare[hour];
        if (share <= 0.0005) continue;

        // JS getUTCDay is Sunday-based; the data uses Monday-based weekdays.
        const weekday = (target.getUTCDay() + 6) % 7;
        const predicted = articleProfile.level * share * (storeProfile.dayFactor.get(weekday) || 1);
        // Below this the expectation is effectively "no sale this hour", which
        // is not worth a row; the daily roll-up still carries the demand.
        if (predicted < 0.015) continue;

        const interval = 1.28 * articleProfile.spread; // ~80% band
        counter += 1;
        rows.push({
          ID: `FC-${storeId}-${counter.toString().padStart(6, '0')}`,
          store_ID: storeId,
          article_ID: articleId,
          forecastFor: target.toISOString().replace(/\.\d{3}Z$/, 'Z'),
          businessDate: target.toISOString().slice(0, 10),
          hourOfDay: hour,
          predictedQty: round(predicted, 3),
          lowerBound: round(Math.max(0, predicted - interval), 3),
          upperBound: round(predicted + interval, 3),
          actualQty: '',
          mape: mape === undefined ? '' : mape,
          wape: wape === undefined ? '' : wape,
          model: MODEL_NAME,
          generatedAt,
        });
      }
    }
  }
  // The overall WAPE belongs to the run, not to any one row; expose it on the
  // array so the caller can record it as a model metric.
  Object.defineProperty(rows, 'overallWape', { value: accuracy.overallWape, enumerable: false });
  Object.defineProperty(rows, 'storeDayWape', { value: accuracy.storeDayWape, enumerable: false });
  return rows;
}

module.exports = { generateForecasts, learnProfiles, backtest, MODEL_NAME };
