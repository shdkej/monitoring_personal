const test = require('node:test');
const assert = require('node:assert/strict');
const {collectHealth} = require('./app-health');

test('per-app cohort intersection, absent web vitals, measured zero, and invalid union', async () => {
  const result = await collectHealth(async () => [[0, 1, 5, 4, 7, 0, 2.5, null]]);
  assert.deepEqual(result.rows[0].values, {
    active1d: 1, active7d: 5, errors7d: 0, churned7d: 2, retained7d: 2,
    retentionPercent: 50, lcpP75ms: 2.5,
  });
  assert.equal(result.rows[1].values.errors7d, 0);
  assert.equal(result.rows[1].values.retentionPercent, undefined);
  await assert.rejects(collectHealth(async () => [[0, 1, 5, 4, 3, 0, null, null]]));
});
