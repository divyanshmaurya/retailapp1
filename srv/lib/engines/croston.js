'use strict';

/**
 * Croston's method, and the Syntetos-Boylan correction to it.
 *
 * The seasonal-profile model in `forecast.js` does a reasonable job at store-day
 * grain but badly at SKU-hour, because at that grain demand is *intermittent*:
 * most hours sell nothing at all, and the occasional hour sells one or two
 * units. Exponential smoothing over a series that is mostly zeros drags the
 * level toward zero and smears a small forecast across every hour.
 *
 * Croston's insight is to stop forecasting the series and forecast two separate
 * things instead:
 *
 *   z - the size of a demand, when one occurs
 *   p - the number of periods between demands
 *
 * Each is smoothed only when a demand actually happens, and the rate is z / p.
 * Because the two are updated independently, a long run of zeros no longer
 * corrupts the estimate of how big a sale is when it comes.
 *
 * Croston's estimator is known to be biased upward by roughly p / (p - a/2).
 * Syntetos and Boylan showed the bias is removed by scaling the rate by
 * (1 - alpha / 2), which is what SBA does and why it is the default here.
 *
 * Reference: Croston (1972), Syntetos & Boylan (2005).
 */

const { mean, round } = require('../stats');

/** Smoothing constant. Low values suit sparse series; 0.1-0.2 is the usual range. */
const DEFAULT_ALPHA = 0.15;

/**
 * Fit Croston / SBA to a series of per-period demands, zeros included.
 *
 * @param {number[]} series  demand per period, in order, with zeros
 * @param {Object} options
 * @param {number} [options.alpha]   smoothing constant
 * @param {boolean} [options.sba]    apply the Syntetos-Boylan bias correction
 * @returns {{rate: number, size: number, interval: number, demands: number,
 *            method: string, alpha: number}|null}
 */
function fitCroston(series, { alpha = DEFAULT_ALPHA, sba = true } = {}) {
  const values = series.map((v) => Number(v) || 0);
  const nonZero = values.filter((v) => v > 0);

  // Two demands is the minimum that gives an interval to smooth at all.
  if (nonZero.length < 2) return null;

  let size = null;      // z: smoothed demand size
  let interval = null;  // p: smoothed inter-demand interval
  let sinceLast = 0;
  let demands = 0;

  for (const value of values) {
    sinceLast += 1;
    if (value <= 0) continue;

    demands += 1;
    if (size === null) {
      // Seed from the first observed demand rather than from zero, so the
      // estimate does not have to climb out of a hole it was never in.
      //
      // The interval is deliberately left unseeded here. At the first demand
      // there is no preceding demand to have an interval from - `sinceLast`
      // just counts how far into the series we are - and seeding with it drags
      // the smoothed interval below the truth for a long time, which inflates
      // the rate, since the rate is size / interval.
      size = value;
    } else if (interval === null) {
      size += alpha * (value - size);
      interval = sinceLast; // the first genuine gap between two demands
    } else {
      size += alpha * (value - size);
      interval += alpha * (sinceLast - interval);
    }
    sinceLast = 0;
  }

  if (!size || !interval || interval <= 0) return null;

  const raw = size / interval;
  const rate = sba ? raw * (1 - alpha / 2) : raw;

  return {
    rate,
    size,
    interval,
    demands,
    method: sba ? 'SBA' : 'Croston',
    alpha,
  };
}

/**
 * Is this series intermittent enough that Croston is the right tool?
 *
 * The usual rule of thumb is an average inter-demand interval above about 1.32
 * periods; below that the series is smooth enough for ordinary smoothing. We
 * also require a reasonable share of zeros, so a merely noisy series does not
 * get routed here.
 */
function isIntermittent(series) {
  const values = series.map((v) => Number(v) || 0);
  if (values.length < 12) return false;
  const nonZero = values.filter((v) => v > 0).length;
  if (nonZero < 2) return false;
  const averageInterval = values.length / nonZero;
  const zeroShare = 1 - nonZero / values.length;
  return averageInterval > 1.32 && zeroShare > 0.35;
}

/**
 * Compare the two candidate models on a holdout and return whichever actually
 * did better, rather than assuming Croston wins because the series is sparse.
 *
 * Both are compared on total absolute error over the holdout - the numerator of
 * WAPE - because on an intermittent series a per-period percentage error is
 * meaningless.
 *
 * @param {number[]} series          full history, zeros included
 * @param {number} seasonalRate      per-period rate the seasonal model predicts
 * @param {number} [holdout]         periods held back for the comparison
 * @returns {{winner: string, croston: number|null, seasonal: number, rate: number}}
 */
function selectModel(series, seasonalRate, holdout = 0) {
  const values = series.map((v) => Number(v) || 0);
  const split = holdout > 0 && holdout < values.length
    ? values.length - holdout
    : Math.max(1, Math.floor(values.length * 0.75));

  const train = values.slice(0, split);
  const test = values.slice(split);
  if (!test.length) {
    return { winner: 'seasonal', croston: null, seasonal: 0, rate: seasonalRate };
  }

  const actual = test.reduce((s, v) => s + v, 0);
  const seasonalError = test.reduce((s, v) => s + Math.abs(v - seasonalRate), 0);

  const fitted = fitCroston(train);
  if (!fitted) {
    return { winner: 'seasonal', croston: null, seasonal: seasonalError, rate: seasonalRate };
  }
  const crostonError = test.reduce((s, v) => s + Math.abs(v - fitted.rate), 0);

  // Ties go to the seasonal model: it carries the hour-of-day and day-of-week
  // shape, which Croston has no notion of, so it is more useful when equal.
  const winner = crostonError < seasonalError ? fitted.method : 'seasonal';
  return {
    winner,
    croston: crostonError,
    seasonal: seasonalError,
    rate: winner === 'seasonal' ? seasonalRate : fitted.rate,
    actual,
  };
}

module.exports = { fitCroston, isIntermittent, selectModel, DEFAULT_ALPHA };
