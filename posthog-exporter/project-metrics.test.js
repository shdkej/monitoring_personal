const test = require('node:test');
const assert = require('node:assert/strict');
const client = require('prom-client');
const {registerActivity} = require('./project-metrics');

test('product freshness keeps each successful source observation across repeated scrapes and removes expired data', async () => {
  const row = scope => ({scope, activity: {sessions: 0}, values: {}});
  const source = {projects: ['1', '2'], fresh: [
    {health: {observedAt: 1793145600000, rows: [row('Virtue')]}},
    {health: {observedAt: 1793145660000, rows: [row('policycock')]}},
  ]};
  const register = new client.Registry();
  registerActivity(client, register, source);
  const values = async () => (await register.getMetricsAsJSON())
    .find(metric => metric.name === 'product_last_success_timestamp_seconds')?.values
    .map(({labels, value}) => ({service: labels.service, value}));
  const expected = [{service: 'virtue', value: 1793145600}, {service: 'policycock', value: 1793145660}];
  assert.deepEqual(await values(), expected);
  assert.deepEqual(await values(), expected);
  source.fresh = [];
  assert.deepEqual(await values(), []);
});
