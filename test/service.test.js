'use strict';

/**
 * Integration tests against the OData services.
 *
 * `test/engines.test.js` covers the algorithms on hand-built fixtures. These
 * cover the parts that only exist once CAP is running: the projections and
 * aggregate views, the authorisation rules, the queue actions and the audit
 * trail they write. Several of the defects this project hit - a 400 on a store
 * filter, a missing projection breaking $expand, an empty string surviving as
 * text where a null was meant - were invisible to unit tests because they were
 * properties of the service, not of the engines.
 *
 * cds.test boots the server in-process against a throwaway SQLite database
 * seeded from db/data, so this needs no running server and leaves no state
 * behind.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// An in-memory database, seeded from db/data on boot exactly as the file-backed
// one is. Without this the tests inherit the project's configured SQLite file
// and work the real queue in it - releasing orders, acknowledging alerts,
// replacing forecasts - so running the suite would quietly leave the developer's
// database in a state the seed data never described.
process.env.CDS_REQUIRES_DB_CREDENTIALS_URL = ':memory:';

const cds = require('@sap/cds');

const root = path.resolve(__dirname, '..');
const { GET, POST, axios } = cds.test(root);

// The mock users from package.json. Every request states who is making it,
// because almost everything here is a question about authorisation.
const as = (user) => ({ auth: { username: user, password: user } });
const MANAGER = as('manager');
const ANALYST = as('analyst');
const VIEWER = as('viewer');

// Let the assertions do the reporting rather than axios throwing first.
axios.defaults.validateStatus = () => true;

const expectStatus = (response, status, what) =>
  assert.equal(response.status, status,
    `${what}: expected ${status}, got ${response.status} ${JSON.stringify(response.data?.error?.message ?? '')}`);

// ---------------------------------------------------------------------------
// Projections and navigation
// ---------------------------------------------------------------------------

test('service: the AI entities are served and seeded', async () => {
  const response = await GET('/ai/ShrinkAlerts?$top=1&$count=true', VIEWER);
  expectStatus(response, 200, 'reading ShrinkAlerts');
  assert.ok(response.data['@odata.count'] > 0, 'expected seeded alerts');
});

test('service: $expand resolves across every association the workbench uses', async () => {
  // Each of these needs the target entity exposed on AIService. A missing
  // projection does not fail at compile time - it fails here, with a 400.
  const cases = [
    ['ShrinkAlerts', 'store($select=name),article($select=name),posSystem($select=name,kind)'],
    ['ReplenishmentTasks', 'store($select=name),article($select=name),supplier($select=name,leadTimeDays)'],
    ['NextBestOffers', 'store($select=name),customer($select=displayName,loyaltyTier),article($select=name)'],
    ['MarkdownRecommendations', 'store($select=name),article($select=name)'],
    ['BasketAffinities', 'antecedent($select=name),consequent($select=name)'],
    ['ColdChainAlerts', 'store($select=name)'],
    ['DemandForecasts', 'store($select=name),article($select=name)'],
    ['AIInsights', 'store($select=name)'],
  ];
  for (const [entity, expand] of cases) {
    const response = await GET(`/ai/${entity}?$top=1&$expand=${expand}`, VIEWER);
    expectStatus(response, 200, `$expand on ${entity}`);
  }
});

test('service: every workbench entity accepts a store filter', async () => {
  // The regression this pins down: aggregate views expose `storeId` while
  // entity projections expose `store_ID`, and filtering the wrong one is a 400.
  // It shipped once because only "All stores" had ever been tried.
  const entities = ['ShrinkAlerts', 'ReplenishmentTasks', 'MarkdownRecommendations',
    'DemandForecasts', 'BasketAffinities', 'NextBestOffers', 'ColdChainAlerts', 'AIInsights'];
  for (const entity of entities) {
    const response = await GET(`/ai/${entity}?$top=1&$filter=store_ID eq 'STR01'`, VIEWER);
    expectStatus(response, 200, `store filter on ${entity}`);
  }
});

test('service: the aggregate views filter on storeId, not store_ID', async () => {
  for (const view of ['InsightSummary', 'ShrinkByPattern']) {
    const ok = await GET(`/ai/${view}?$top=1&$filter=storeId eq 'STR01'`, VIEWER);
    expectStatus(ok, 200, `storeId filter on ${view}`);
  }
});

test('service: $count reports the collection, not the page', async () => {
  const page = await GET('/ai/NextBestOffers?$top=5&$count=true', VIEWER);
  expectStatus(page, 200, 'paged read');
  assert.equal(page.data.value.length, 5);
  assert.ok(page.data['@odata.count'] > 5,
    'the count should describe the collection, otherwise paging cannot be rendered');
});

test('service: $apply aggregates the whole filtered collection', async () => {
  // The KPI tiles depend on this; without it they can only sum the loaded page.
  const response = await GET(
    "/ai/ShrinkAlerts?$apply=filter(state eq 'OPEN')/aggregate($count as n,valueAtRisk with sum as total)",
    VIEWER);
  expectStatus(response, 200, '$apply aggregate');
  const [row] = response.data.value;
  assert.ok(row.n > 0 && row.total > 0);

  const counted = await GET("/ai/ShrinkAlerts?$top=0&$count=true&$filter=state eq 'OPEN'", VIEWER);
  assert.equal(row.n, counted.data['@odata.count'],
    'the aggregate and the count must agree, or the tiles contradict the footer');
});

test('service: search uses tolower on both sides', async () => {
  // Enum-valued columns are stored upper case; a case-sensitive contains()
  // silently finds nothing for the casing a user actually types.
  const lower = await GET("/ai/ShrinkAlerts?$top=0&$count=true&$filter=contains(tolower(pattern),'tag')", VIEWER);
  expectStatus(lower, 200, 'tolower search');
  assert.ok(lower.data['@odata.count'] > 0, 'expected TAG_ABSENT alerts to match "tag"');
});

// ---------------------------------------------------------------------------
// Authorisation
// ---------------------------------------------------------------------------

test('service: an unauthenticated request is challenged, not merely refused', async () => {
  const response = await GET('/ai/ShrinkAlerts?$top=1');

  // 401 with a challenge specifically, not 403. A browser only opens its
  // sign-in prompt on a 401; a 403 leaves the user staring at an error with no
  // way to authenticate. This assertion was originally written to accept either
  // and so did not catch that.
  assert.equal(response.status, 401, 'the service must challenge, so the browser prompts');
  assert.match(response.headers['www-authenticate'] || '', /^Basic/,
    'a challenge without WWW-Authenticate does not prompt anything');
});

test('service: an unknown user is refused rather than quietly given access', async () => {
  // Mocked authentication accepts any name with any password and grants an
  // unrecognised one no roles. That is safe - it fails closed - but it means a
  // mistyped sign-in looks like a broken application rather than a bad
  // password, which is why the UI has to explain it.
  const response = await GET('/ai/ShrinkAlerts?$top=1', as('nobody'));
  expectStatus(response, 403, 'an unknown user reading alerts');
  assert.match(response.data?.error?.message || '', /nobody/,
    'the message should name the user, so the UI can tell them who they are');
});

test('service: a viewer may read but not work the queue', async () => {
  expectStatus(await GET('/ai/ShrinkAlerts?$top=1', VIEWER), 200, 'viewer read');

  const [alert] = (await GET("/ai/ShrinkAlerts?$top=1&$filter=state eq 'OPEN'", VIEWER)).data.value;
  const response = await POST(`/ai/ShrinkAlerts(ID='${alert.ID}')/AIService.acknowledge`,
    { note: 'nope' }, VIEWER);
  expectStatus(response, 403, 'viewer acknowledging an alert');
});

test('service: an analyst may recalculate but not act on a recommendation', async () => {
  const [alert] = (await GET("/ai/ShrinkAlerts?$top=1&$filter=state eq 'OPEN'", ANALYST)).data.value;
  expectStatus(
    await POST(`/ai/ShrinkAlerts(ID='${alert.ID}')/AIService.acknowledge`, { note: 'nope' }, ANALYST),
    403, 'analyst acknowledging an alert');

  expectStatus(await POST('/ai/backfillActuals', {}, ANALYST), 200, 'analyst backfilling actuals');
});

test('service: recalculate is closed to a viewer and open to the analyst role', async () => {
  // recalculate replaces every stored recommendation, so it sits behind Analyst
  // rather than behind read access. The manager persona holds Analyst as well
  // as StoreManager, which is why it is allowed here - the boundary being
  // pinned down is the viewer's, not the manager's.
  expectStatus(await POST('/ai/recalculate', { scenario: 'MERCHANDISING' }, VIEWER),
    403, 'viewer recalculating');
  expectStatus(await POST('/ai/recalculate', { scenario: 'MERCHANDISING' }, ANALYST),
    200, 'analyst recalculating');
});

// ---------------------------------------------------------------------------
// Queue actions and the audit trail
// ---------------------------------------------------------------------------

test('service: acknowledging records the transition without destroying the advice', async () => {
  const [alert] = (await GET("/ai/ShrinkAlerts?$top=1&$filter=state eq 'OPEN'", MANAGER)).data.value;
  assert.ok(alert.recommendedAction, 'fixture should carry a recommendation');

  const response = await POST(`/ai/ShrinkAlerts(ID='${alert.ID}')/AIService.acknowledge`,
    { note: 'Checked on the shop floor' }, MANAGER);
  expectStatus(response, 200, 'acknowledge');
  assert.equal(response.data.state, 'ACKNOWLEDGED');

  const after = (await GET(`/ai/ShrinkAlerts(ID='${alert.ID}')`, MANAGER)).data;
  assert.equal(after.state, 'ACKNOWLEDGED');
  // The regression this pins down: the note used to be written over
  // recommendedAction, so working the queue erased the reason for the alert.
  assert.equal(after.recommendedAction, alert.recommendedAction,
    'acknowledging must not overwrite the recommendation');

  const log = (await GET(
    `/ai/ActivityLog?$filter=targetId eq '${alert.ID}' and action eq 'acknowledge'`, MANAGER)).data.value;
  assert.equal(log.length, 1, 'expected exactly one audit row');
  assert.equal(log[0].fromState, 'OPEN');
  assert.equal(log[0].toState, 'ACKNOWLEDGED');
  assert.equal(log[0].note, 'Checked on the shop floor');
  assert.ok(log[0].changedBy, 'the audit row must say who acted');
});

test('service: the audit trail cannot be written through the service', async () => {
  const response = await POST('/ai/ActivityLog', {
    ID: 'AL-forged', targetEntity: 'ShrinkAlerts', targetId: 'X', action: 'acknowledge',
  }, MANAGER);
  assert.ok(response.status >= 400, `expected the log to be read-only, got ${response.status}`);
});

test('service: acting twice on the same record is refused', async () => {
  const [task] = (await GET("/ai/ReplenishmentTasks?$top=1&$filter=state eq 'OPEN'", MANAGER)).data.value;
  expectStatus(await POST(`/ai/ReplenishmentTasks(ID='${task.ID}')/AIService.releaseOrder`,
    { quantity: task.recommendedQty }, MANAGER), 200, 'first release');

  const again = await POST(`/ai/ReplenishmentTasks(ID='${task.ID}')/AIService.releaseOrder`,
    { quantity: task.recommendedQty }, MANAGER);
  expectStatus(again, 409, 'releasing an already-released order');
});

test('service: a nonsensical order quantity is refused', async () => {
  const [task] = (await GET("/ai/ReplenishmentTasks?$top=1&$filter=state eq 'OPEN'", MANAGER)).data.value;
  expectStatus(
    await POST(`/ai/ReplenishmentTasks(ID='${task.ID}')/AIService.releaseOrder`, { quantity: 0 }, MANAGER),
    400, 'releasing zero units');
});

test('service: an unknown scenario is rejected rather than silently doing nothing', async () => {
  const response = await POST('/ai/recalculate', { scenario: 'NOT_A_SCENARIO' }, ANALYST);
  expectStatus(response, 400, 'recalculating an unknown scenario');
});

// ---------------------------------------------------------------------------
// The measurement loop
// ---------------------------------------------------------------------------

test('service: acting opens an outcome, and it stays pending without evidence', async () => {
  const [task] = (await GET("/ai/ReplenishmentTasks?$top=1&$filter=state eq 'OPEN'", MANAGER)).data.value;
  await POST(`/ai/ReplenishmentTasks(ID='${task.ID}')/AIService.releaseOrder`,
    { quantity: task.recommendedQty }, MANAGER);

  const outcomes = (await GET(`/ai/ScenarioOutcomes?$filter=targetId eq '${task.ID}'`, MANAGER)).data.value;
  assert.equal(outcomes.length, 1, 'releasing an order should open exactly one outcome');
  assert.equal(outcomes[0].verdict, 'PENDING');
  assert.equal(outcomes[0].unit, 'units',
    'expected and observed must share a unit, or they cannot be compared');

  // The action was taken today; sales data ends well before that. Claiming the
  // recommendation failed on that basis would be a claim the data cannot make.
  const evaluated = await POST('/ai/evaluateOutcomes', {}, ANALYST);
  expectStatus(evaluated, 200, 'evaluateOutcomes');
  assert.ok(evaluated.data.stillPending > 0, 'expected outcomes with no evidence yet');

  const after = (await GET(`/ai/ScenarioOutcomes?$filter=targetId eq '${task.ID}'`, MANAGER)).data.value;
  assert.equal(after[0].verdict, 'PENDING',
    'an outcome with no evidence must stay pending, not be recorded as missed');
});

test('service: a replayed evaluation reaches a verdict and says that it was replayed', async () => {
  const [task] = (await GET("/ai/ReplenishmentTasks?$top=1&$filter=state eq 'OPEN'", MANAGER)).data.value;
  await POST(`/ai/ReplenishmentTasks(ID='${task.ID}')/AIService.releaseOrder`,
    { quantity: task.recommendedQty }, MANAGER);

  const replayed = await POST('/ai/evaluateOutcomes', { asOf: '2026-06-20' }, ANALYST);
  expectStatus(replayed, 200, 'replayed evaluateOutcomes');
  assert.ok(replayed.data.evaluated > 0, 'a replay inside the loaded history should measure something');

  const [outcome] = (await GET(`/ai/ScenarioOutcomes?$filter=targetId eq '${task.ID}'`, MANAGER)).data.value;
  assert.notEqual(outcome.verdict, 'PENDING');
  assert.match(outcome.narrative, /^\[replayed from 2026-06-20\]/,
    'a replayed verdict must be labelled, so it is never read as a real measurement');
});

test('service: forecasts can be replayed to a past origin and then scored', async () => {
  const replay = await POST('/ai/recalculate',
    { scenario: 'DEMAND_FORECAST', asOf: '2026-06-26T12:00:00Z' }, ANALYST);
  expectStatus(replay, 200, 'replayed recalculate');
  assert.ok(replay.data.value[0].rowsWritten > 0);

  const scored = await POST('/ai/backfillActuals', {}, ANALYST);
  expectStatus(scored, 200, 'backfillActuals after a replay');
  assert.ok(scored.data.matched > 0,
    'a forecast replayed into observed history must have hours to score against');
  assert.equal(typeof scored.data.wape, 'number');
  assert.equal(typeof scored.data.bias, 'number',
    'WAPE is unreadable at this grain without the signed bias beside it');
});

test('service: an invalid asOf is rejected rather than silently ignored', async () => {
  expectStatus(await POST('/ai/recalculate', { scenario: 'DEMAND_FORECAST', asOf: 'yesterday' }, ANALYST),
    400, 'recalculate with a bad asOf');
});

test('service: ForecastAccuracy only reports forecasts that were actually measured', async () => {
  // Unmeasured actuals must be null. They were once written as empty strings,
  // which survived as text, satisfied `is not null`, and made this view report
  // every pending forecast as a confirmed zero sale.
  await POST('/ai/recalculate', { scenario: 'DEMAND_FORECAST' }, ANALYST);
  const rows = (await GET('/ai/ForecastAccuracy?$top=50', VIEWER)).data.value;
  for (const row of rows) {
    assert.ok(row.actual !== null && row.actual !== undefined,
      'a row in this view should never have a null actual');
  }
});

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

test('analytics: the aggregate views are served and internally consistent', async () => {
  const daily = await GET('/analytics/DailySales?$top=5', VIEWER);
  expectStatus(daily, 200, 'DailySales');
  assert.ok(daily.data.value.length > 0);

  for (const row of daily.data.value) {
    const computed = Number(row.netRevenue) + Number(row.vatAmount);
    assert.ok(Math.abs(computed - Number(row.grossAmount)) < 0.05,
      `net + VAT should reconcile to gross: ${computed} vs ${row.grossAmount}`);
  }
});

test('analytics: is closed to anonymous callers too', async () => {
  const response = await GET('/analytics/DailySales?$top=1');
  assert.ok(response.status === 401 || response.status === 403,
    `expected AnalyticsService to be closed, got ${response.status}`);
});
