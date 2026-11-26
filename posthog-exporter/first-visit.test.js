const test = require('node:test');
const assert = require('node:assert/strict');
const {firstVisitMetrics} = require('./first-visit');

test('first-session counts deduplicate within app and preserve absent denominators', async () => {
  const data = await firstVisitMetrics(async (project, query) => {
    assert.equal(project, '424014');
    assert.match(query, /GROUP BY app, distinct_id/);
    assert.match(query, /HAVING countIf\(event = 'first_session_started'\) > 0/);
    assert.match(query, /properties.traffic_kind = 'user'/);
    assert.match(query, /entered \+ interval 24 hour <= toDateTime\(1800000000\) AND NOT/);
    return [['virtue', 4, 1, 2, 1, 1, 1], ['policycock', 1, 0, 0, 0, 0, 0]];
  }, 1800000000);
  assert.deepEqual(data.get('Virtue'), {sharedDropped: 1, otherDropped: 1, firstVisitActivationPercent: 25, shareNewVisitors7d: 2, sharedActivated: 1, sharedPending: 1, otherActivated: 0, otherPending: 2});
  assert.deepEqual(data.get('policycock'), {sharedDropped: 0, otherDropped: 0, firstVisitActivationPercent: 0, shareNewVisitors7d: 0, sharedActivated: 0, sharedPending: 0, otherActivated: 0, otherPending: 1});
  assert.equal((await firstVisitMetrics(async () => [], 1800000000)).size, 0);
  await assert.rejects(firstVisitMetrics(async () => [['virtue', 4, 3, 3, 0, 0, 0]], 1800000000));
});

test('drop-offs cannot exceed unactivated visits from the same channel', async () => {
  await assert.rejects(firstVisitMetrics(async () => [['policycock', 3, 1, 2, 1, 2, 0]], 1800000000));
  await assert.rejects(firstVisitMetrics(async () => [['policycock', 3, 1, 2, 1, 0, 2]], 1800000000));
});
