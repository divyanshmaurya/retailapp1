'use strict';

/**
 * Unit tests for the scenario engines.
 *
 * These use small hand-built fixtures rather than the generated dataset, so a
 * failure points at the algorithm rather than at the data. Run with `npm test`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { generateForecasts, learnProfiles, backtest } = require('../srv/lib/engines/forecast');
const { fitCroston, isIntermittent, selectModel } = require('../srv/lib/engines/croston');
const { detectShrink } = require('../srv/lib/engines/shrink');
const { planReplenishment } = require('../srv/lib/engines/replenishment');
const { recommendMarkdowns, upliftFactor } = require('../srv/lib/engines/markdown');
const { mineAffinities } = require('../srv/lib/engines/affinity');
const { buildOffers } = require('../srv/lib/engines/personalization');
const { detectColdChain } = require('../srv/lib/engines/coldchain');
const { buildInsightFeed } = require('../srv/lib/engines/insights');
const { parseCsv } = require('../srv/lib/csv');
const stats = require('../srv/lib/stats');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STORE = {
  ID: 'S1', name: 'Test Store', format: 'AUTONOMOUS', opensAt: 0, closesAt: 24,
};

const ARTICLE = {
  ID: 'A1', name: 'Test Cola', group_ID: 'DRINKS', supplier_ID: 'SUP1',
  unitPriceGross: 2.00, unitCost: 0.80, vatRatePct: 19, isRfidTagged: true,
  shelfLifeDays: 0, abcClass: 'A', shelfCapacity: 20,
};

const FRESH = {
  ID: 'A2', name: 'Test Sandwich', group_ID: 'FOOD', supplier_ID: 'SUP1',
  unitPriceGross: 4.00, unitCost: 1.60, vatRatePct: 7, isRfidTagged: true,
  shelfLifeDays: 1, abcClass: 'B', shelfCapacity: 12,
};

const GROUPS = [
  { ID: 'DRINKS', name: 'Drinks', category: 'Beverages', tempZone: 'CHILLED', shelfLifeDays: 0 },
  { ID: 'FOOD', name: 'Food', category: 'Food to Go', tempZone: 'CHILLED', shelfLifeDays: 1 },
];

const SUPPLIER = { ID: 'SUP1', name: 'Test Supplier', leadTimeDays: 2, reliability: 0.95 };

/** Build `days` of hourly sales, `perHour` units in each of `hours`. */
function makeHourlySales({ days = 30, hours = [12, 13], perHour = 2, article = 'A1', store = 'S1' } = {}) {
  const rows = [];
  const start = new Date('2026-01-05T00:00:00Z'); // a Monday
  for (let day = 0; day < days; day += 1) {
    const date = new Date(start.getTime() + day * 86400000);
    const businessDate = date.toISOString().slice(0, 10);
    const dayOfWeek = (date.getUTCDay() + 6) % 7;
    for (const hour of hours) {
      rows.push({
        ID: `HS-${day}-${hour}`,
        store_ID: store, article_ID: article,
        businessDate, hourOfDay: hour, dayOfWeek,
        hourStart: `${businessDate}T${String(hour).padStart(2, '0')}:00:00Z`,
        quantity: perHour, netRevenue: perHour * 1.68, vatAmount: perHour * 0.32,
        grossAmount: perHour * 2, isActual: true,
      });
    }
  }
  return rows;
}

/**
 * Keep every `nth` trading day, dropping the rest, to make an intermittent
 * series. Selecting on the position of the date rather than on its digits keeps
 * the gap exactly `nth` days regardless of where the fixture starts or how month
 * boundaries fall - the holdout is then guaranteed to contain some demand.
 */
function sparsify(rows, nth = 3) {
  const dates = [...new Set(rows.map((row) => row.businessDate))].sort();
  const kept = new Set(dates.filter((_, index) => index % nth === 0));
  return rows.filter((row) => kept.has(row.businessDate));
}

// ---------------------------------------------------------------------------
// stats helpers
// ---------------------------------------------------------------------------

test('stats: severity bands map onto Fiori criticality', () => {
  assert.equal(stats.severityFor(90), 'CRITICAL');
  assert.equal(stats.severityFor(60), 'HIGH');
  assert.equal(stats.severityFor(30), 'MEDIUM');
  assert.equal(stats.severityFor(5), 'LOW');

  assert.equal(stats.criticalityFor('CRITICAL'), 1);
  assert.equal(stats.criticalityFor('MEDIUM'), 2);
  assert.equal(stats.criticalityFor('LOW'), 3);
  assert.equal(stats.criticalityFor('NONSENSE'), 0);
});

test('stats: ewma weights recent observations more heavily than a plain mean', () => {
  const rising = [1, 1, 1, 1, 10];
  assert.ok(stats.ewma(rising, 0.5) > stats.mean(rising),
    'a series ending high should pull the EWMA above the arithmetic mean');
});

// ---------------------------------------------------------------------------
// CSV round-trip
// ---------------------------------------------------------------------------

test('csv: quoted fields, embedded commas, quotes and newlines survive parsing', () => {
  const rows = parseCsv('a,b\n"x,1","he said ""hi"""\n"multi\nline",2\n');
  assert.deepEqual(rows[0], ['a', 'b']);
  assert.deepEqual(rows[1], ['x,1', 'he said "hi"']);
  assert.deepEqual(rows[2], ['multi\nline', '2']);
});

// ---------------------------------------------------------------------------
// Forecast
// ---------------------------------------------------------------------------

test('forecast: the level is the mean per calendar day, not per selling day', () => {
  // Sells 4 units, but only on every other hour of every day; the store trades
  // all 30 days. A level built from selling days only would be far too high.
  const sales = makeHourlySales({ days: 30, hours: [12, 13], perHour: 2 });
  const profiles = learnProfiles(sales);
  const profile = profiles.get('S1').articles.get('A1');

  // 4 units a day, every day.
  assert.ok(Math.abs(profile.level - 4) < 0.5,
    `expected a level near 4 units/day, got ${profile.level}`);
});

test('forecast: predictions concentrate in the hours the article actually sells', () => {
  const sales = makeHourlySales({ days: 30, hours: [12, 13], perHour: 2 });
  const rows = generateForecasts(sales, { horizonHours: 48, maxArticlesPerStore: 10 });

  assert.ok(rows.length > 0, 'expected forecasts to be produced');
  const byHour = new Map();
  for (const row of rows) {
    byHour.set(row.hourOfDay, (byHour.get(row.hourOfDay) || 0) + Number(row.predictedQty));
  }
  const selling = (byHour.get(12) || 0) + (byHour.get(13) || 0);
  const other = [...byHour.entries()]
    .filter(([hour]) => hour !== 12 && hour !== 13)
    .reduce((total, [, value]) => total + value, 0);

  assert.ok(selling > other * 5,
    `selling hours should dominate: ${selling} vs ${other}`);
});

test('forecast: a perfectly regular series backtests to near-zero error', () => {
  const sales = makeHourlySales({ days: 40, hours: [12], perHour: 3 });
  const accuracy = backtest(sales, 10);

  assert.ok(accuracy.storeDayWape < 15,
    `a constant series should be easy to forecast, got WAPE ${accuracy.storeDayWape}%`);
});

test('forecast: the backtest refits on training data and never sees the holdout', () => {
  // Flat for the training window, then demand triples for the last 10 days. A
  // model that had peeked would track the jump; one fitted on training alone
  // must under-forecast it, and the signed bias has to show that.
  const flat = makeHourlySales({ days: 40, hours: [12], perHour: 3 });
  const dates = [...new Set(flat.map((row) => row.businessDate))].sort();
  const jump = dates[dates.length - 10];
  const spiked = flat.map((row) => (row.businessDate >= jump
    ? { ...row, quantity: row.quantity * 3 }
    : row));

  const accuracy = backtest(spiked, 10);
  assert.ok(accuracy.bias < -30,
    `a model blind to the holdout must under-forecast a tripling, got bias ${accuracy.bias}%`);
});

test('forecast: skill is measured against a seasonal-naive benchmark', () => {
  const sales = makeHourlySales({ days: 40, hours: [12], perHour: 3 });
  const accuracy = backtest(sales, 10);

  // On a constant series last week is a perfect forecast, so the benchmark is
  // unbeatable and the model can only draw with it.
  assert.equal(accuracy.naiveStoreDayWape, 0);
  assert.ok(accuracy.storeDaySkill <= 0,
    `nothing beats a perfect benchmark, got skill ${accuracy.storeDaySkill}%`);
});

test('forecast: reconciliation is a no-op when no article uses Croston', () => {
  const sales = makeHourlySales({ days: 40, hours: [12, 13], perHour: 2 });
  const plain = backtest(sales, 10, { intermittentModels: false, reconcile: false });
  const reconciled = backtest(sales, 10, { intermittentModels: false, reconcile: true });

  // EWMA is linear, so the sum of the article levels already equals the store
  // level and the correction factor is 1. If this drifts, the anchor and the
  // per-article levels have stopped being measured on the same footing.
  assert.equal(plain.storeDayWape, reconciled.storeDayWape);
  assert.equal(plain.bias, reconciled.bias);
});

test('forecast: reconciliation removes the aggregate bias Croston introduces', () => {
  // Intermittent: one sale every third day, so Croston is offered the series.
  // 120 days thinned to every third leaves 40 trading days: enough that the
  // training window still clears the minimum observation count once the
  // holdout is taken off the end.
  const sparse = sparsify(makeHourlySales({ days: 120, hours: [12], perHour: 3 }));

  const raw = backtest(sparse, 14, { intermittentModels: true, reconcile: false });
  const reconciled = backtest(sparse, 14, { intermittentModels: true, reconcile: true });

  assert.ok(Math.abs(reconciled.bias) <= Math.abs(raw.bias) + 1e-9,
    `reconciliation should not worsen bias: ${raw.bias}% -> ${reconciled.bias}%`);
});

test('forecast: prediction interval brackets the prediction', () => {
  const sales = makeHourlySales({ days: 30, hours: [12, 13], perHour: 2 });
  for (const row of generateForecasts(sales, { horizonHours: 24 })) {
    assert.ok(Number(row.lowerBound) <= Number(row.predictedQty), 'lower bound above prediction');
    assert.ok(Number(row.upperBound) >= Number(row.predictedQty), 'upper bound below prediction');
    assert.ok(Number(row.lowerBound) >= 0, 'negative lower bound');
  }
});

test('forecast: no history yields no forecasts rather than throwing', () => {
  assert.deepEqual(generateForecasts([]), []);
});

test('forecast: asOf replays from a past origin and withholds later history', () => {
  const sales = makeHourlySales({ days: 40, hours: [12], perHour: 3 });
  const dates = [...new Set(sales.map((row) => row.businessDate))].sort();
  const asOf = `${dates[dates.length - 6]}T12:00:00Z`;

  const replayed = generateForecasts(sales, { horizonHours: 48, asOf });
  assert.ok(replayed.length > 0, 'expected a replayed forecast');

  // Every forecast has to land after the cutoff, and inside the horizon.
  for (const row of replayed) {
    assert.ok(row.forecastFor > asOf, `${row.forecastFor} is not after ${asOf}`);
  }
  // And it has to reach into days the model was not shown, which is the whole
  // point: those hours have already happened, so they can be scored.
  assert.ok(replayed.some((row) => row.businessDate > asOf.slice(0, 10)),
    'the horizon should extend past the cutoff date into observed history');
});

test('forecast: asOf changes the forecast, proving later history was withheld', () => {
  // Flat, then a tripling in the last five days. A forecast cut off before the
  // jump cannot know about it; one cut off after must.
  const flat = makeHourlySales({ days: 40, hours: [12], perHour: 3 });
  const dates = [...new Set(flat.map((row) => row.businessDate))].sort();
  const jump = dates[dates.length - 5];
  const sales = flat.map((row) => (row.businessDate >= jump
    ? { ...row, quantity: row.quantity * 3 }
    : row));

  const total = (rows) => rows.reduce((sum, row) => sum + Number(row.predictedQty), 0);
  const before = generateForecasts(sales, { horizonHours: 24, asOf: `${dates[dates.length - 6]}T12:00:00Z` });
  const after = generateForecasts(sales, { horizonHours: 24, asOf: `${dates[dates.length - 1]}T12:00:00Z` });

  assert.ok(total(after) > total(before) * 1.2,
    `a forecast made after the jump should be higher: ${total(before)} vs ${total(after)}`);
});

// ---------------------------------------------------------------------------
// Croston / SBA
// ---------------------------------------------------------------------------

test('croston: recovers the rate of a regular intermittent series', () => {
  // 6 units every 4th period; the true rate is 1.5 per period.
  const series = Array.from({ length: 40 }, (_, i) => (i % 4 === 0 ? 6 : 0));
  const fit = fitCroston(series, { sba: false });

  assert.equal(fit.method, 'Croston');
  assert.ok(Math.abs(fit.size - 6) < 0.01, `size ${fit.size}`);
  assert.ok(Math.abs(fit.interval - 4) < 0.01, `interval ${fit.interval}`);
  assert.ok(Math.abs(fit.rate - 1.5) < 0.01, `rate ${fit.rate}`);
});

test('croston: the SBA correction shrinks the rate by exactly 1 - alpha/2', () => {
  const series = Array.from({ length: 40 }, (_, i) => (i % 4 === 0 ? 6 : 0));
  const plain = fitCroston(series, { sba: false });
  const corrected = fitCroston(series, { sba: true });

  assert.equal(corrected.method, 'SBA');
  assert.ok(Math.abs(corrected.rate - plain.rate * (1 - corrected.alpha / 2)) < 1e-9);
});

test('croston: refuses to fit a series with fewer than two demands', () => {
  assert.equal(fitCroston([0, 0, 0, 0, 0]), null);
  assert.equal(fitCroston([0, 0, 5, 0, 0]), null);
});

test('croston: a dense series is not treated as intermittent', () => {
  assert.equal(isIntermittent(Array.from({ length: 40 }, () => 3)), false);
  // Noisy but rarely zero - ordinary smoothing territory, not Croston's.
  assert.equal(isIntermittent(Array.from({ length: 40 }, (_, i) => (i % 10 === 0 ? 0 : 4))), false);
  assert.equal(isIntermittent(Array.from({ length: 40 }, (_, i) => (i % 4 === 0 ? 6 : 0))), true);
});

test('croston: a short series is left alone, since neither model can be judged', () => {
  assert.equal(isIntermittent([0, 3, 0, 0, 3, 0]), false);
});

test('croston: model selection breaks ties in favour of the seasonal model', () => {
  const series = Array.from({ length: 40 }, (_, i) => (i % 4 === 0 ? 6 : 0));
  // Hand the seasonal model the exact rate Croston finds on the same training
  // split the selector uses, so the two score identically on the holdout. The
  // seasonal model should keep its place, because it also carries the hour and
  // weekday shape that Croston has no notion of.
  const tied = fitCroston(series.slice(0, series.length - 10)).rate;
  const chosen = selectModel(series, tied, 10);

  assert.ok(Math.abs(chosen.croston - chosen.seasonal) < 1e-9,
    `expected a tie, got croston ${chosen.croston} vs seasonal ${chosen.seasonal}`);
  assert.equal(chosen.winner, 'seasonal');
  assert.equal(chosen.rate, tied);
});

test('croston: model selection keeps the seasonal rate when it scores better', () => {
  const series = Array.from({ length: 40 }, (_, i) => (i % 4 === 0 ? 6 : 0));
  // 1.2 beats the ~1.39 Croston settles on over this holdout, so the selector
  // has to leave the seasonal model in place.
  const chosen = selectModel(series, 1.2, 10);

  assert.ok(chosen.seasonal < chosen.croston,
    `expected the seasonal rate to score better, got ${chosen.seasonal} vs ${chosen.croston}`);
  assert.equal(chosen.winner, 'seasonal');
  assert.equal(chosen.rate, 1.2);
});

test('croston: model selection switches when the seasonal rate is far off', () => {
  const series = Array.from({ length: 40 }, (_, i) => (i % 4 === 0 ? 6 : 0));
  const chosen = selectModel(series, 5, 10);

  assert.ok(chosen.croston < chosen.seasonal);
  assert.equal(chosen.winner, 'SBA');
  assert.ok(chosen.rate < 5, `expected Croston's rate, got ${chosen.rate}`);
});

test('forecast: WAPE at SKU-hour is minimised by forecasting nothing', () => {
  // This is why the pipeline reports skill against a benchmark and not WAPE on
  // its own. It is a property of the measure, not of any model: on intermittent
  // demand the all-zero forecast scores exactly 100%, because its total absolute
  // error is the total actual volume. An unbiased forecast scores worse than
  // that, and shrinking it toward zero improves the number all the way down. So
  // a falling SKU-hour WAPE is not evidence of a better forecast - it is just as
  // likely to be evidence of one that has quietly stopped predicting demand.
  const actual = Array.from({ length: 200 }, (_, i) => (i % 4 === 0 ? 6 : 0));
  const trueRate = 1.5; // 6 units every 4 periods, so this forecast is unbiased
  const volume = actual.reduce((total, value) => total + value, 0);
  const wapeAtShrink = (shrink) =>
    (actual.reduce((total, value) => total + Math.abs(value - trueRate * shrink), 0)
      / volume) * 100;

  assert.ok(Math.abs(wapeAtShrink(0) - 100) < 1e-9,
    `the all-zero forecast must score exactly 100%, got ${wapeAtShrink(0)}`);
  assert.ok(wapeAtShrink(1) > wapeAtShrink(0),
    'an unbiased forecast scores worse than predicting nothing');
  assert.ok(wapeAtShrink(0.5) < wapeAtShrink(1),
    'halving the forecast improves WAPE, which is the pathology');
});

// ---------------------------------------------------------------------------
// Checkout integrity
// ---------------------------------------------------------------------------

test('shrink: a cancelled value far from the master price is flagged as a price error', () => {
  const sales = makeHourlySales({ days: 30, hours: [12], perHour: 2 });
  const cancellations = [{
    ID: 'C1', store_ID: 'S1', posSystem_ID: 'PF1', article_ID: 'A1',
    cashier: 'payfree', businessDate: '2026-02-01',
    // 10 units cancelled for 300 EUR implies 30.00/unit against a 2.00 master price.
    cancellationCount: 10, cancelledQuantity: 10, cancelledAmount: 300,
  }];
  const alerts = detectShrink({
    cancellations, hourlySales: sales, articles: [ARTICLE],
    posSystems: [{ ID: 'PF1', kind: 'RFID_AUTONOMOUS' }], inventory: [],
  });

  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].pattern, 'PRICE_ERROR');
  assert.equal(alerts[0].severity, 'CRITICAL');
  assert.equal(alerts[0].criticality, 1);
  assert.ok(alerts[0].evidence.includes('30.00'), 'evidence should quote the implied unit price');
});

test('shrink: an untagged article at an autonomous gate is flagged as a missing tag', () => {
  const sales = makeHourlySales({ days: 30, hours: [12], perHour: 2 });
  const untagged = { ...ARTICLE, isRfidTagged: false };
  const cancellations = [{
    ID: 'C1', store_ID: 'S1', posSystem_ID: 'PF1', article_ID: 'A1',
    cashier: 'payfree', businessDate: '2026-02-01',
    cancellationCount: 20, cancelledQuantity: 20, cancelledAmount: 40,
  }];
  const alerts = detectShrink({
    cancellations, hourlySales: sales, articles: [untagged],
    posSystems: [{ ID: 'PF1', kind: 'RFID_AUTONOMOUS' }], inventory: [],
  });

  assert.equal(alerts[0].pattern, 'TAG_ABSENT');
});

test('shrink: a handful of cancellations below the floor produces no alert', () => {
  const sales = makeHourlySales({ days: 30, hours: [12], perHour: 2 });
  const cancellations = [{
    ID: 'C1', store_ID: 'S1', posSystem_ID: 'PF1', article_ID: 'A1',
    cashier: 'payfree', businessDate: '2026-02-01',
    cancellationCount: 1, cancelledQuantity: 1, cancelledAmount: 2,
  }];
  const alerts = detectShrink({
    cancellations, hourlySales: sales, articles: [ARTICLE],
    posSystems: [{ ID: 'PF1', kind: 'RFID_AUTONOMOUS' }], inventory: [],
  });

  assert.equal(alerts.length, 0, 'one cancellation is not evidence of anything');
});

// ---------------------------------------------------------------------------
// Replenishment
// ---------------------------------------------------------------------------

test('replenishment: an empty shelf on a moving article raises an urgent task', () => {
  const sales = makeHourlySales({ days: 30, hours: [12, 13], perHour: 2 });
  const inventory = [{
    ID: 'IV1', store_ID: 'S1', article_ID: 'A1', businessDate: '2026-02-03',
    bookStock: 1, countedStock: 1, onOrder: 0,
  }];
  const tasks = planReplenishment({
    inventory, hourlySales: sales, articles: [ARTICLE],
    suppliers: [SUPPLIER], stores: [STORE], forecasts: [],
  });

  assert.equal(tasks.length, 1);
  assert.ok(Number(tasks[0].recommendedQty) > 0, 'should recommend ordering something');
  assert.ok(Number(tasks[0].stockoutRisk) > 0.5, 'an almost-empty shelf is a likely stockout');
  assert.ok(tasks[0].reasoning.includes('Test Supplier'));
});

test('replenishment: a full shelf raises no task', () => {
  const sales = makeHourlySales({ days: 30, hours: [12, 13], perHour: 2 });
  const inventory = [{
    ID: 'IV1', store_ID: 'S1', article_ID: 'A1', businessDate: '2026-02-03',
    bookStock: 500, countedStock: 500, onOrder: 0,
  }];
  const tasks = planReplenishment({
    inventory, hourlySales: sales, articles: [ARTICLE],
    suppliers: [SUPPLIER], stores: [STORE], forecasts: [],
  });

  assert.equal(tasks.length, 0);
});

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

test('markdown: deeper discounts lift expected demand monotonically', () => {
  assert.equal(upliftFactor(0), 1);
  assert.ok(upliftFactor(0.2) > upliftFactor(0.1));
  assert.ok(upliftFactor(0.5) > upliftFactor(0.3));
});

test('markdown: stock that cannot sell through before expiry is marked down', () => {
  // Sells 2 units a day but 12 are on the shelf with one day of life left.
  const sales = makeHourlySales({ days: 30, hours: [12], perHour: 2, article: 'A2' });
  const inventory = [{
    ID: 'IV2', store_ID: 'S1', article_ID: 'A2', businessDate: '2026-02-03',
    bookStock: 12, countedStock: 12, onOrder: 0,
  }];
  const rows = recommendMarkdowns({
    inventory, hourlySales: sales, articles: [FRESH], articleGroups: GROUPS, stores: [STORE],
  });

  assert.equal(rows.length, 1);
  assert.ok(Number(rows[0].recommendedDiscountPct) > 0, 'expected a markdown to be proposed');
  assert.ok(Number(rows[0].projectedWaste) > 0, 'expected waste to be projected');
  assert.ok(Number(rows[0].marginImpact) > 0,
    'a proposed markdown must beat doing nothing, else it should not be proposed');
});

test('markdown: non-perishables are never marked down for expiry', () => {
  const sales = makeHourlySales({ days: 30, hours: [12], perHour: 1 });
  const inventory = [{
    ID: 'IV1', store_ID: 'S1', article_ID: 'A1', businessDate: '2026-02-03',
    bookStock: 200, countedStock: 200, onOrder: 0,
  }];
  const rows = recommendMarkdowns({
    inventory, hourlySales: sales, articles: [ARTICLE], articleGroups: GROUPS, stores: [STORE],
  });

  assert.equal(rows.length, 0, 'a shelf-stable article does not expire');
});

// ---------------------------------------------------------------------------
// Affinity
// ---------------------------------------------------------------------------

test('affinity: a pair that always co-occurs is mined with lift above 1', () => {
  const receipts = [];
  const receiptItems = [];
  // 60 baskets with both articles, 40 with only a third article.
  for (let index = 0; index < 100; index += 1) {
    const id = `R${index}`;
    receipts.push({ ID: id, store_ID: 'S1', businessDate: '2026-02-01' });
    if (index < 60) {
      receiptItems.push({ ID: `${id}-1`, receipt_ID: id, article_ID: 'A1' });
      receiptItems.push({ ID: `${id}-2`, receipt_ID: id, article_ID: 'A2' });
    } else {
      receiptItems.push({ ID: `${id}-1`, receipt_ID: id, article_ID: 'A3' });
      receiptItems.push({ ID: `${id}-2`, receipt_ID: id, article_ID: 'A4' });
    }
  }
  const articles = [
    ARTICLE, FRESH,
    { ...ARTICLE, ID: 'A3', name: 'Third' },
    { ...ARTICLE, ID: 'A4', name: 'Fourth' },
  ];
  const rules = mineAffinities({ receipts, receiptItems, articles, articleGroups: GROUPS });

  const pair = rules.find((rule) =>
    (rule.antecedent_ID === 'A1' && rule.consequent_ID === 'A2'));
  assert.ok(pair, 'expected the A1/A2 pair to be mined');
  assert.ok(Number(pair.lift) > 1, 'co-occurring pair should have lift above 1');
  assert.equal(Number(pair.confidence), 1, 'A1 always appears with A2');
});

// ---------------------------------------------------------------------------
// Personalisation
// ---------------------------------------------------------------------------

test('personalisation: customers without marketing consent never receive an offer', () => {
  const customers = [
    { ID: 'C1', consentMarketing: false, homeStore_ID: 'S1', loyaltyTier: 'GOLD' },
  ];
  const receipts = [];
  const receiptItems = [];
  for (let index = 0; index < 10; index += 1) {
    const id = `R${index}`;
    receipts.push({ ID: id, store_ID: 'S1', customer_ID: 'C1', businessDate: `2026-02-0${(index % 9) + 1}` });
    receiptItems.push({ ID: `${id}-1`, receipt_ID: id, article_ID: 'A1' });
  }

  const offers = buildOffers({
    customers, receipts, receiptItems, articles: [ARTICLE, FRESH], affinities: [],
  });
  assert.equal(offers.length, 0, 'consent gates the whole recommender');
});

test('personalisation: a regular repeat purchase becomes a routine offer', () => {
  const customers = [
    { ID: 'C1', consentMarketing: true, homeStore_ID: 'S1', loyaltyTier: 'GOLD' },
  ];
  const receipts = [];
  const receiptItems = [];
  // Buys every 3 days, then goes quiet for 4 - due for another.
  for (const day of ['01', '04', '07', '10', '13']) {
    const id = `R${day}`;
    receipts.push({ ID: id, store_ID: 'S1', customer_ID: 'C1', businessDate: `2026-02-${day}` });
    receiptItems.push({ ID: `${id}-1`, receipt_ID: id, article_ID: 'A1' });
  }
  receipts.push({ ID: 'R17', store_ID: 'S1', customer_ID: 'C1', businessDate: '2026-02-17' });
  receiptItems.push({ ID: 'R17-1', receipt_ID: 'R17', article_ID: 'A2' });

  const offers = buildOffers({
    customers, receipts, receiptItems, articles: [ARTICLE, FRESH], affinities: [],
  });

  assert.ok(offers.length > 0, 'expected a routine offer');
  assert.ok(offers.every((offer) => Number(offer.propensity) <= 1 && Number(offer.propensity) >= 0),
    'propensity must be a probability');
});

// ---------------------------------------------------------------------------
// Cold chain
// ---------------------------------------------------------------------------

test('cold chain: a sustained excursion alerts, a reading inside the band does not', () => {
  const sensors = [
    { ID: 'T1', store_ID: 'S1', article_ID: 'A1', readingAt: '2026-02-01T12:00:00Z', sensorType: 'TEMPERATURE', value: 12 },
    { ID: 'T2', store_ID: 'S1', article_ID: 'A1', readingAt: '2026-02-01T13:00:00Z', sensorType: 'TEMPERATURE', value: 13 },
    { ID: 'T3', store_ID: 'S1', article_ID: 'A1', readingAt: '2026-02-02T12:00:00Z', sensorType: 'TEMPERATURE', value: 5 },
  ];
  const inventory = [{
    ID: 'IV1', store_ID: 'S1', article_ID: 'A1', businessDate: '2026-02-01',
    bookStock: 50, countedStock: 50, onOrder: 0,
  }];

  const alerts = detectColdChain({
    sensors, articles: [ARTICLE], articleGroups: GROUPS, inventory,
  });

  assert.equal(alerts.length, 1, 'only the breaching day should alert');
  assert.equal(alerts[0].detectedAt.slice(0, 10), '2026-02-01');
  assert.ok(Number(alerts[0].stockAtRisk) > 0);
});

test('cold chain: stock at risk counts the latest snapshot once, not every snapshot day', () => {
  const sensors = [
    { ID: 'T1', store_ID: 'S1', article_ID: 'A1', readingAt: '2026-02-05T12:00:00Z', sensorType: 'TEMPERATURE', value: 14 },
  ];
  // Five daily snapshots of the same 50 units.
  const inventory = ['01', '02', '03', '04', '05'].map((day) => ({
    ID: `IV${day}`, store_ID: 'S1', article_ID: 'A1', businessDate: `2026-02-${day}`,
    bookStock: 50, countedStock: 50, onOrder: 0,
  }));

  const alerts = detectColdChain({ sensors, articles: [ARTICLE], articleGroups: GROUPS, inventory });
  // 50 units at 0.80 cost = 40 EUR in the zone; exposure is a fraction of that.
  assert.ok(Number(alerts[0].stockAtRisk) <= 40,
    `stock at risk should not exceed the zone's stock value, got ${alerts[0].stockAtRisk}`);
});

// ---------------------------------------------------------------------------
// Insight feed
// ---------------------------------------------------------------------------

test('insights: the feed ranks by impact weighted by confidence', () => {
  const feed = buildInsightFeed({
    shrinkAlerts: [{
      ID: 'SA-1', store_ID: 'S1', article_ID: 'A1', pattern: 'PRICE_ERROR',
      severity: 'CRITICAL', anomalyScore: 100, valueAtRisk: 500,
      detectedOn: '2026-02-01', evidence: 'e', recommendedAction: 'a',
    }],
    coldChainAlerts: [{
      ID: 'CC-1', store_ID: 'S1', assetId: 'CH-S1', assetName: 'Chiller',
      detectedAt: '2026-02-01T12:00:00Z', measuredTemp: 12, targetTemp: 5,
      toleranceBand: 3, breachMinutes: 60, severity: 'HIGH',
      stockAtRisk: 20, recommendedAction: 'a',
    }],
    articles: [ARTICLE], stores: [STORE],
  });

  assert.equal(feed.length, 2);
  assert.equal(feed[0].sourceId, 'SA-1', 'the 500 EUR item should rank first');
  assert.ok(feed.every((row) => row.criticality >= 1 && row.criticality <= 3));
  assert.ok(feed.every((row) => Number(row.confidence) > 0 && Number(row.confidence) <= 1));
});

test('insights: repeat excursions on one cabinet collapse to its worst', () => {
  const coldChainAlerts = ['01', '02', '03'].map((day, index) => ({
    ID: `CC-${day}`, store_ID: 'S1', assetId: 'CH-S1', assetName: 'Chiller',
    detectedAt: `2026-02-${day}T12:00:00Z`, measuredTemp: 12, targetTemp: 5,
    toleranceBand: 3, breachMinutes: 60, severity: 'HIGH',
    stockAtRisk: 10 * (index + 1), recommendedAction: 'a',
  }));

  const feed = buildInsightFeed({ coldChainAlerts, articles: [ARTICLE], stores: [STORE] });
  assert.equal(feed.length, 1, 'one cabinet should contribute one feed entry');
  assert.equal(feed[0].sourceId, 'CC-03', 'the worst excursion should be the one kept');
});
