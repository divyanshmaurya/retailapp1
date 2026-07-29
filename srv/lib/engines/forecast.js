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
const { isIntermittent, selectModel } = require('./croston');

const MODEL_NAME = 'SeasonalProfile+EWMA';

/** Minimum observations before an article gets its own profile. */
const MIN_OBSERVATIONS = 12;

/**
 * @param {Array} hourlySales rows of {store_ID, article_ID, businessDate, hourOfDay, dayOfWeek, quantity}
 * @param {Object} [options]
 * @param {boolean} [options.intermittentModels] offer Croston/SBA to sparse series
 * @param {boolean} [options.reconcile] scale article levels back onto the store total
 * @returns {Map} storeId -> {storeHourShare, dayFactor, articles}
 */
function learnProfiles(hourlySales, { intermittentModels = true, reconcile = true } = {}) {
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

    // Daily totals of the articles that end up with a profile, used below to
    // reconcile the sum of the parts back onto the whole.
    const coveredDaily = new Map();

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

      // At SKU-hour grain most of these series are intermittent - long runs of
      // zeros broken by a sale of one or two units - and smoothing a series
      // that is mostly zeros drags the level down and smears it across every
      // hour. Where that is the case, offer Croston as an alternative and let a
      // holdout decide which of the two actually forecasts better. The seasonal
      // model wins ties because it carries the hour and weekday shape, which
      // Croston has no notion of.
      let dailyRate = level;
      let model = MODEL_NAME;
      if (intermittentModels && isIntermittent(series)) {
        const chosen = selectModel(series, level, Math.min(14, Math.floor(series.length * 0.25)));
        if (chosen.winner !== 'seasonal') {
          dailyRate = chosen.rate;
          model = chosen.winner;
        }
      }

      articleProfiles.set(articleId, {
        level: dailyRate, hourShare, spread, model,
        observations: rows.length,
        lastDate: activeDates[activeDates.length - 1],
      });
      for (const [date, quantity] of dailyTotals) {
        coveredDaily.set(date, (coveredDaily.get(date) || 0) + quantity);
      }
    }

    // Reconcile bottom-up to the store total.
    //
    // Croston deliberately forecasts low on a sparse series - that is where its
    // gain at SKU-hour comes from - but summing several hundred deliberately low
    // article forecasts gives a store total that is low by the same margin, and
    // store-day is the grain replenishment and staffing are actually decided at.
    // So we rescale the article levels by a single factor that puts their sum
    // back on the store's own smoothed daily volume, which is measured on a
    // dense series and needs no intermittent handling.
    //
    // The relative split between articles - Croston's actual contribution - is
    // untouched. For a store where every article kept the seasonal model the
    // factor is ~1 and this is a no-op, because EWMA is linear.
    if (reconcile && articleProfiles.size) {
      const coveredSeries = calendar.map((date) => coveredDaily.get(date) || 0);
      const anchor = ewma(coveredSeries, 0.25);
      const bottomUp = sum([...articleProfiles.values()].map((profile) => profile.level));
      if (anchor > 0 && bottomUp > 0) {
        // Bound the correction: a factor far from 1 means the two estimates
        // disagree about more than intermittency, and scaling hard on that would
        // be fitting noise rather than removing a known bias.
        const factor = clamp(anchor / bottomUp, 0.5, 2);
        for (const profile of articleProfiles.values()) {
          profile.level *= factor;
          profile.reconciliation = round(factor, 4);
        }
      }
    }

    profiles.set(storeId, { storeHourShare, dayFactor, articles: articleProfiles });
  }
  return profiles;
}

/**
 * Seasonal-naive benchmark: predict what this store/article sold in the same
 * hour of the same weekday one week ago.
 *
 * Every accuracy number needs something to be better than, and at SKU-hour
 * grain the obvious candidate - a WAPE near zero - is unreachable and the
 * reachable one is perverse. WAPE on an intermittent series is minimised by
 * forecasting nothing at all: predict zero everywhere and the total absolute
 * error equals the total actual volume, giving exactly 100%. Any honest
 * forecast that puts demand into hours where none arrives scores worse than
 * that, so "improving" SKU-hour WAPE by shrinking the forecast toward zero is
 * chasing a degenerate optimum, not gaining skill - and it buys the number with
 * a systematic under-forecast that empties shelves.
 *
 * Comparing against last week instead makes the figure mean something: it is a
 * forecast a human could produce with no model at all, it carries the same
 * hour-of-day and day-of-week shape the real model claims to exploit, and it
 * cannot be gamed by shrinkage.
 *
 * @returns {{wape: number, storeDayWape: number}}
 */
function seasonalNaive(hourlySales, evaluationDates) {
  const observed = new Map();
  const keys = new Set();
  for (const row of hourlySales) {
    const key = `${row.store_ID}|${row.article_ID}`;
    keys.add(key);
    observed.set(`${key}|${row.businessDate}|${row.hourOfDay}`, Number(row.quantity) || 0);
  }

  const lagged = (businessDate) => {
    const date = new Date(`${businessDate}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - 7);
    return date.toISOString().slice(0, 10);
  };

  let totalError = 0;
  let totalActual = 0;
  const storeDay = new Map();

  for (const key of keys) {
    const storeId = key.slice(0, key.indexOf('|'));
    for (const businessDate of evaluationDates) {
      const lastWeek = lagged(businessDate);
      for (let hour = 0; hour < 24; hour += 1) {
        const actual = observed.get(`${key}|${businessDate}|${hour}`) || 0;
        const predicted = observed.get(`${key}|${lastWeek}|${hour}`) || 0;
        // Both zero contributes nothing to either total, at either grain.
        if (actual === 0 && predicted === 0) continue;
        totalError += Math.abs(actual - predicted);
        totalActual += actual;

        const storeDayKey = `${storeId}|${businessDate}`;
        const bucket = storeDay.get(storeDayKey) || { actual: 0, predicted: 0 };
        bucket.actual += actual;
        bucket.predicted += predicted;
        storeDay.set(storeDayKey, bucket);
      }
    }
  }

  let storeDayError = 0;
  let storeDayTotal = 0;
  for (const bucket of storeDay.values()) {
    storeDayError += Math.abs(bucket.actual - bucket.predicted);
    storeDayTotal += bucket.actual;
  }

  return {
    wape: totalActual > 0 ? round((totalError / totalActual) * 100, 2) : 0,
    storeDayWape: storeDayTotal > 0 ? round((storeDayError / storeDayTotal) * 100, 2) : 0,
  };
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
 * The profiles are refitted here on the training window alone. Scoring profiles
 * that were fitted on the whole series - the holdout included - measures how
 * well the model memorised the answer, not how well it forecasts, and flatters
 * every number it produces.
 *
 * @param {Array} hourlySales
 * @param {number} [holdoutDays]
 * @param {Object} [options] passed through to learnProfiles
 * @returns {{mape: Map, wape: Map, overallWape: number, storeDayWape: number, bias: number}}
 */
function backtest(hourlySales, holdoutDays = 14, options = {}) {
  const dates = [...new Set(hourlySales.map((row) => row.businessDate))].sort();
  const cutoff = dates[Math.max(0, dates.length - holdoutDays)];
  const holdout = hourlySales.filter((row) => row.businessDate >= cutoff);
  const training = hourlySales.filter((row) => row.businessDate < cutoff);
  const profiles = learnProfiles(training.length ? training : hourlySales, options);

  const absoluteErrors = new Map();
  const actualVolume = new Map();
  const percentErrors = new Map();
  let totalError = 0;
  let totalActual = 0;
  let totalPredicted = 0;

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
          totalPredicted += predicted;

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

  const naive = seasonalNaive(hourlySales, evaluationDates);

  return {
    mape,
    wape,
    overallWape: totalActual > 0 ? round((totalError / totalActual) * 100, 2) : 0,
    storeDayWape: storeDayTotal > 0 ? round((storeDayError / storeDayTotal) * 100, 2) : 0,
    // Signed, unlike WAPE. Two models can share a WAPE while one runs the
    // shelves empty and the other fills the bins, and only this tells them
    // apart: positive is over-forecast, negative is under-forecast.
    bias: totalActual > 0 ? round((totalPredicted / totalActual - 1) * 100, 2) : 0,
    naiveWape: naive.wape,
    naiveStoreDayWape: naive.storeDayWape,
    // Skill against the naive benchmark: positive means the model earns its
    // keep, zero or negative means last week's numbers would have done as well.
    skill: naive.wape > 0
      ? round((1 - (totalActual > 0 ? totalError / totalActual : 0) / (naive.wape / 100)) * 100, 2)
      : 0,
    storeDaySkill: naive.storeDayWape > 0
      ? round((1 - (storeDayTotal > 0 ? storeDayError / storeDayTotal : 0) / (naive.storeDayWape / 100)) * 100, 2)
      : 0,
  };
}

/**
 * Produce forecasts for the next `horizonHours` after the last observed hour.
 *
 * Passing `asOf` rolls the clock back: history after that timestamp is withheld
 * and the forecast runs forward from it. That makes the forecast horizon land on
 * hours that have already happened, so `backfillActuals` can score it against
 * what really sold. Without it, on a fixed dataset every forecast sits in the
 * future and live accuracy can never be measured at all.
 *
 * @param {Array} hourlySales
 * @param {Object} [options]
 * @param {number} [options.horizonHours]
 * @param {number} [options.maxArticlesPerStore]
 * @param {string|Date} [options.asOf] withhold everything after this instant
 * @returns {Array} DemandForecasts rows
 */
function generateForecasts(hourlySales, {
  horizonHours = 48, maxArticlesPerStore = 60, asOf = null, generatedAt = null,
} = {}) {
  if (!hourlySales.length) return [];

  const stampOf = (row) => (row.hourStart
    ? new Date(row.hourStart)
    : new Date(`${row.businessDate}T${String(row.hourOfDay).padStart(2, '0')}:00:00Z`));

  // Cut the history down to what was knowable at `asOf`. Forecasting from a past
  // origin while still fitting on the whole series would be a model grading its
  // own homework, and the live WAPE that came out of it would be meaningless.
  const cutoff = asOf ? new Date(asOf) : null;
  const history = cutoff && !Number.isNaN(cutoff.getTime())
    ? hourlySales.filter((row) => stampOf(row) <= cutoff)
    : hourlySales;
  if (!history.length) return [];

  // Forward forecasts use everything known; accuracy is measured by a model
  // refitted on the training window only, so the score is not self-graded.
  const profiles = learnProfiles(history);
  const accuracy = backtest(history, 14);
  // Provenance. Defaults to now, which is what the recalculate action wants.
  // The seed generator passes a stamp derived from the data instead, so that
  // rebuilding the committed dataset is byte-identical and a diff means the
  // numbers changed rather than that the clock moved.
  const stampedAt = generatedAt || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  // Forecast forward from the last hour actually observed, not from midnight of
  // the last date - otherwise a short horizon lands entirely in the small hours
  // and returns nothing useful.
  let origin = cutoff && !Number.isNaN(cutoff.getTime()) ? cutoff : null;
  if (!origin) {
    for (const row of history) {
      const stamp = stampOf(row);
      if (!Number.isNaN(stamp.getTime()) && (!origin || stamp > origin)) origin = stamp;
    }
  }
  if (!origin) {
    const lastDate = history.map((row) => row.businessDate).sort().pop();
    origin = new Date(`${lastDate}T00:00:00Z`);
  }

  // Rank articles by recent volume so the table stays useful rather than huge.
  // Ranked on the withheld history too - which lines matter is itself something
  // only knowable as of the cutoff.
  const volume = new Map();
  for (const row of history) {
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
          // Null, not an empty string. These rows are written both to CSV and,
          // by the recalculate action, straight into the database; the CSV
          // writer renders null as an empty field either way, but an empty
          // string inserted at runtime is stored as text and then satisfies
          // `actualQty is not null`, which would report every unmeasured
          // forecast as a confirmed zero sale.
          actualQty: null,
          mape: mape === undefined ? null : mape,
          wape: wape === undefined ? null : wape,
          model: articleProfile.model || MODEL_NAME,
          generatedAt: stampedAt,
        });
      }
    }
  }
  // Run-level accuracy belongs to the run, not to any one row; expose it on the
  // array so the caller can record it as a model metric.
  for (const measure of ['overallWape', 'storeDayWape', 'bias', 'skill',
    'storeDaySkill', 'naiveWape', 'naiveStoreDayWape']) {
    Object.defineProperty(rows, measure, { value: accuracy[measure], enumerable: false });
  }
  return rows;
}

module.exports = { generateForecasts, learnProfiles, backtest, MODEL_NAME };
