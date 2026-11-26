const test = require('node:test');
const assert = require('node:assert/strict');
const {collectHealth} = require('./app-health');

test('per-app cohort intersection, absent web vitals, measured zero, and invalid union', async () => {
  const result = await collectHealth(async () => [[0, 5, 4, 7, 0, 50, 2.5, null, 1, 2, 3, 0, 0]]);
  assert.deepEqual(result.rows[0].values, {
    errors7d: 0, churned7d: 2, taskCompletions7d: 50,
    retentionPercent: 50, lcpP75ms: 2.5,
  });
  assert.equal(result.rows[1].values.taskCompletions7d, 0);
  assert.equal(result.rows[2].values.taskCompletions7d, undefined);
  assert.equal(result.rows[1].values.errors7d, 0);
  assert.equal(result.rows[1].values.retentionPercent, undefined);
  await assert.rejects(collectHealth(async () => [[0, 5, 4, 3, 0, 0, null, null, 0, 0, 0, 0, 0]]));
});
