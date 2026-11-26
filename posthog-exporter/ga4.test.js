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

test('channel totals are independently verified, finite, and expire with the private observation', async () => {
  let now = Date.parse('2026-11-26T02:00:00Z');
  const measured = {scope: 'app', observedAt: '2026-11-26T01:00:00Z', sessions: 5,
    status: 'unavailable', channelSessions: {Direct: 3, Referral: 2}};
  const report = {schemaVersion: 1, rows: [measured, {...measured, scope: 'mismatch', sessions: 3},
    {...measured, scope: 'invalid', channelSessions: {Direct: 5.5, Referral: -0.5}},
    {...measured, scope: 'no-events', sessions: 0, status: 'no_sessions', channelSessions: {}}]};
  const registry = new Registry();
  registerGA4(registry, () => now, () => JSON.stringify(report));
  const get = () => registry.getSingleMetric('ga4_app_channel_sessions').get().then(m => m.values);
  assert.deepEqual((await get()).map(r => [r.labels.scope, r.labels.channel, r.value]),
    [['app', 'Direct', 3], ['app', 'Referral', 2]]);
  now += 31 * 3600 * 1000;
  assert.deepEqual(await get(), []);
});
