const test = require('node:test');
const assert = require('node:assert/strict');
const {Registry} = require('prom-client');
const {registerGA4} = require('./ga4');

test('GA4 refresh keeps observed zero, isolates unavailable apps, and expires old observations', async () => {
  let now = Date.parse('2026-11-26T02:00:00Z');
  const registry = new Registry();
  let report = '';
  const refresh = registerGA4(registry, () => now, () => report);
  const sample = {scope: 'app', observedAt: '2026-11-26T01:00:00Z', status: 'ok', values: {newUsers: 0, sessions: 3}};
  const feed = rows => async () => ({ok: true, json: async () => ({schemaVersion: 1, source: 'ga4', rows})});
  await refresh(feed([sample, {...sample, scope: 'other', status: 'unavailable'}]));
  const data = () => registry.getSingleMetric('ga4_app_rolling7d_count').get().then(metric => metric.values);
  assert.deepEqual((await data()).map(row => [row.labels.scope, row.labels.metric, row.value]),
    [['app', 'newUsers', 0], ['app', 'sessions', 3]]);
  const engagement = () => registry.getSingleMetric('ga4_app_session_engagement_seconds').get().then(metric => metric.values);
  assert.deepEqual(await engagement(), []);
  const measured = {scope: 'app', observedAt: sample.observedAt, status: 'ok', sessions: 2, seconds: 0};
  report = JSON.stringify({schemaVersion: 1, rows: [measured, {...measured, scope: 'empty', sessions: 0},
    {...measured, scope: 'duration', seconds: 18}, {...measured, scope: 'failed', status: 'unavailable'}]});
  assert.deepEqual((await engagement()).map(row => [row.labels.scope, row.value]), [['app', 0], ['duration', 18]]);
  await assert.rejects(refresh(feed([sample, sample])));
  assert.equal((await data()).length, 2);
  now += 30 * 3600 * 1000;
  assert.deepEqual(await data(), []);
  assert.deepEqual(await engagement(), []);
});
