#!/usr/bin/env node
'use strict';

/**
 * Stage 3 of the data pipeline: run every scenario engine over the generated
 * base data and write the AI entity CSVs that CAP deploys alongside it.
 *
 * The engines used here are exactly the ones the running service calls from its
 * `recalculate` actions - there is no second implementation - so the seeded
 * rows and a live recalculation always agree.
 *
 * Usage:  node tools/generate_ai_outputs.js [--data db/data]
 */

const path = require('path');
const { readCsv, writeCsv } = require('../srv/lib/csv');

const { generateForecasts } = require('../srv/lib/engines/forecast');
const { detectShrink } = require('../srv/lib/engines/shrink');
const { planReplenishment } = require('../srv/lib/engines/replenishment');
const { recommendMarkdowns } = require('../srv/lib/engines/markdown');
const { mineAffinities } = require('../srv/lib/engines/affinity');
const { buildOffers } = require('../srv/lib/engines/personalization');
const { detectColdChain } = require('../srv/lib/engines/coldchain');
const { buildInsightFeed, buildModelMetrics } = require('../srv/lib/engines/insights');

const NAMESPACE = 'smart.retail';

function parseArgs(argv) {
  const options = { data: 'db/data' };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--data') options.data = argv[index + 1];
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const dataDir = path.resolve(process.cwd(), options.data);
  const load = (entity) => readCsv(path.join(dataDir, `${NAMESPACE}-${entity}.csv`));
  const save = (entity, rows) => {
    const count = writeCsv(path.join(dataDir, `${NAMESPACE}-${entity}.csv`), rows);
    console.log(`  ${entity.padEnd(24)} ${String(count).padStart(8)}`);
    return count;
  };

  console.log('Reading base data...');
  const stores = load('Stores');
  const articles = load('Articles');
  const articleGroups = load('ArticleGroups');
  const suppliers = load('Suppliers');
  const customers = load('Customers');
  const posSystems = load('PosSystems');
  const hourlySales = load('HourlySales');
  const receipts = load('Receipts');
  const receiptItems = load('ReceiptItems');
  const cancellations = load('Cancellations');
  const inventory = load('InventorySnapshots');
  const sensors = load('ShelfSensorReadings');

  if (!hourlySales.length) {
    console.error('No HourlySales found - run tools/synthesize_dataset.py first.');
    process.exit(1);
  }
  console.log(`  ${hourlySales.length} hourly rows, ${receipts.length} receipts, `
    + `${articles.length} articles across ${stores.length} stores\n`);

  console.log('Running scenario engines...');

  const forecasts = generateForecasts(hourlySales, { horizonHours: 48, maxArticlesPerStore: 45 });
  const shrinkAlerts = detectShrink({ cancellations, hourlySales, articles, posSystems, inventory });
  const replenishmentTasks = planReplenishment({
    inventory, hourlySales, articles, suppliers, stores, forecasts,
  });
  const markdowns = recommendMarkdowns({ inventory, hourlySales, articles, articleGroups, stores });
  const affinities = mineAffinities({ receipts, receiptItems, articles, articleGroups });
  const offers = buildOffers({ customers, receipts, receiptItems, articles, affinities });
  const coldChainAlerts = detectColdChain({ sensors, articles, articleGroups, inventory });

  const insights = buildInsightFeed({
    shrinkAlerts, replenishmentTasks, markdowns, affinities, offers,
    coldChainAlerts, forecasts, articles, stores,
  });
  const metrics = buildModelMetrics({
    forecasts, shrinkAlerts, replenishmentTasks, markdowns, offers, coldChainAlerts, affinities,
  });

  console.log('\nWriting AI entities...');
  save('DemandForecasts', forecasts);
  save('ShrinkAlerts', shrinkAlerts);
  save('ReplenishmentTasks', replenishmentTasks);
  save('MarkdownRecommendations', markdowns);
  save('BasketAffinities', affinities);
  save('NextBestOffers', offers);
  save('ColdChainAlerts', coldChainAlerts);
  save('AIInsights', insights);
  save('ModelMetrics', metrics);

  // A short readout so a bad run is obvious without opening the files.
  const euros = (rows, field) =>
    rows.reduce((total, row) => total + (Number(row[field]) || 0), 0).toFixed(2);

  console.log('\nScenario summary:');
  console.log(`  Checkout integrity  ${shrinkAlerts.length} alerts, EUR ${euros(shrinkAlerts, 'valueAtRisk')} at risk`);
  console.log(`  Replenishment       ${replenishmentTasks.length} tasks, EUR ${euros(replenishmentTasks, 'lostSalesValue')} lost sales exposure`);
  console.log(`  Waste & markdown    ${markdowns.length} items, EUR ${euros(markdowns, 'marginImpact')} margin impact`);
  console.log(`  Merchandising       ${affinities.length} rules (${affinities.filter((r) => r.isCrossZone).length} cross-zone)`);
  console.log(`  Personalisation     ${offers.length} offers, EUR ${euros(offers, 'expectedRevenue')} expected`);
  console.log(`  Cold chain          ${coldChainAlerts.length} alerts, EUR ${euros(coldChainAlerts, 'stockAtRisk')} stock exposed`);
  console.log(`  Insight feed        ${insights.length} ranked insights`);

  const mapeMetric = metrics.find((row) => row.metricName === 'MAPE');
  if (mapeMetric) console.log(`  Forecast MAPE       ${mapeMetric.metricValue}%`);
}

main();
