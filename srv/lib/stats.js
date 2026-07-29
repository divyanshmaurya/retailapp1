'use strict';

/**
 * Small numeric helpers shared by the scenario engines. Everything here works
 * on plain arrays so the engines can run against rows read from the database
 * at request time or from CSV files at build time.
 */

const sum = (values) => values.reduce((total, value) => total + (Number(value) || 0), 0);

const mean = (values) => (values.length ? sum(values) / values.length : 0);

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].map(Number).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function stdev(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  const variance = sum(values.map((value) => (value - average) ** 2)) / (values.length - 1);
  return Math.sqrt(variance);
}

function quantile(values, probability) {
  if (!values.length) return 0;
  const sorted = [...values].map(Number).sort((a, b) => a - b);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/**
 * Exponentially weighted mean: recent observations dominate, which is what we
 * want for a store whose footfall shifts with the academic and holiday calendar.
 */
function ewma(values, alpha = 0.3) {
  if (!values.length) return 0;
  return values.reduce((accumulator, value, index) =>
    index === 0 ? Number(value) : alpha * Number(value) + (1 - alpha) * accumulator, 0);
}

/** Group rows into a Map keyed by the value the accessor returns. */
function groupBy(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (key === undefined || key === null) continue;
    let bucket = groups.get(key);
    if (!bucket) groups.set(key, (bucket = []));
    bucket.push(row);
  }
  return groups;
}

const round = (value, places = 2) => {
  const factor = 10 ** places;
  return Math.round((Number(value) || 0) * factor) / factor;
};

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/** Map a ratio onto the four severity bands the UI colours by. */
function severityFor(score, thresholds = [25, 50, 75]) {
  if (score >= thresholds[2]) return 'CRITICAL';
  if (score >= thresholds[1]) return 'HIGH';
  if (score >= thresholds[0]) return 'MEDIUM';
  return 'LOW';
}

/**
 * Translate a severity band into the SAP Fiori criticality scale that
 * `@UI.Criticality` colours by: 1 negative (red), 2 critical (orange),
 * 3 positive (green), 0 neutral. Fiori elements reads the number, not the
 * label, so it has to be stored alongside the severity.
 */
function criticalityFor(severity) {
  switch (severity) {
    case 'CRITICAL':
    case 'HIGH':
      return 1;
    case 'MEDIUM':
      return 2;
    case 'LOW':
      return 3;
    default:
      return 0;
  }
}

const isoDate = (value) => new Date(value).toISOString().slice(0, 10);

const addDays = (dateString, days) => {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

module.exports = {
  sum, mean, median, stdev, quantile, ewma, groupBy,
  round, clamp, severityFor, criticalityFor, isoDate, addDays,
};
