const test = require('node:test');
const assert = require('node:assert/strict');
const {firstVisitMetrics} = require('./first-visit');

test('first-session counts deduplicate within app and preserve absent denominators', async () => {
  const data = await firstVisitMetrics(async (project, query) => {
    assert.equal(project, '424014');
    assert.match(query, /GROUP BY app, distinct_id/);
    assert.match(query, /HAVING countIf\(event = 'first_session_started'\) > 0/);
    assert.match(query, /properties.traffic_kind = 'user'/);
    return [['virtue', 4, 1, 2], ['policycock', 1, 0, 0]];
  }, 1800000000);
  assert.deepEqual(data.get('Virtue'), {firstVisitActivationPercent: 25, shareNewVisitors7d: 2});
  assert.deepEqual(data.get('policycock'), {firstVisitActivationPercent: 0, shareNewVisitors7d: 0});
  assert.equal((await firstVisitMetrics(async () => [], 1800000000)).size, 0);
  await assert.rejects(firstVisitMetrics(async () => [['virtue', 1, 2, 0]], 1800000000));
});
