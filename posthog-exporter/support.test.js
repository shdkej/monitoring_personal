const {test} = require('node:test');
const assert = require('node:assert/strict');
const {Registry} = require('prom-client');
const {registerSupport} = require('./support');

test('support threads publish observed counts only while the private snapshot is complete and fresh', async () => {
  const registry = new Registry();
  const now = Date.now();
  const snapshot = {schemaVersion: 1, observedAt: Math.floor(now / 1000), counts: {policycock: 0, Virtue: 2}};
  registerSupport(registry, async () => JSON.stringify(snapshot), () => now);
  const values = async () => (await registry.getSingleMetric('customer_support_threads').get()).values;
  assert.deepEqual((await values()).map(row => [row.labels.scope, row.value]), [['policycock', 0], ['Virtue', 2]]);
  snapshot.observedAt -= 30 * 3600 + 1;
  assert.deepEqual(await values(), []);
  snapshot.observedAt = Math.floor(now / 1000);
  delete snapshot.counts.Virtue;
  assert.deepEqual(await values(), []);
});

test('support snapshot identifies all named scopes, requiring exact coverage', async () => {
  const registry = new Registry();
  const now = Date.now();
  const scopes = ['blog', 'app:sample', 'project-7 / host:foo.shdkej.com'];
  const snapshot = {schemaVersion: 2, observedAt: Math.floor(now / 1000), scopes,
    counts: Object.fromEntries(scopes.map(scope => [scope, 0]))};
  registerSupport(registry, async () => JSON.stringify(snapshot), () => now);
  const values = async () => (await registry.getSingleMetric('customer_support_threads').get()).values;
  assert.deepEqual((await values()).map(row => row.labels.scope), scopes);
  snapshot.counts['AI 브리핑'] = 3;
  assert.deepEqual(await values(), []);
  snapshot.scopes.push('AI 브리핑');
  assert.deepEqual(await values(), []);
});
