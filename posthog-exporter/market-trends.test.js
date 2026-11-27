const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

function moduleUnderTest() {
  assert.ok(fs.existsSync(`${__dirname}/market-trends.js`), 'market search collector is missing');
  return require('./market-trends');
}
const NOW = Date.parse('2026-11-27T01:00:00Z');
const DAY = 86400000;
function response() {
  return {startDate: '2025-11-24', endDate: '2026-11-22', timeUnit: 'week', results:
    ['미니멀', '변화추적(트래킹)', '에이전트', '1인사업가', '밸런스'].map(title => ({title,
      data: [{period: '2025-11-24', ratio: 0}, {period: '2026-11-16', ratio: 12.5}]}))};
}

test('uses 52 complete Monday-Sunday weeks in Korea, including the Monday boundary', () => {
  const {completedWeeks} = moduleUnderTest();
  assert.deepEqual(completedWeeks(NOW), {startDate: '2025-11-24', endDate: '2026-11-22'});
  assert.deepEqual(completedWeeks(Date.parse('2026-11-22T14:59:59Z')),
    {startDate: '2025-11-17', endDate: '2026-11-15'});
  assert.deepEqual(completedWeeks(Date.parse('2026-11-22T15:00:00Z')),
    {startDate: '2025-11-24', endDate: '2026-11-22'});
});

test('preserves reported ratios and zero, while missing weeks remain null', () => {
  const {toSnapshot} = moduleUnderTest();
  const snapshot = toSnapshot(response(), NOW);
  assert.equal(snapshot.rows.length, 52);
  assert.equal(snapshot.rows[0].time, '2025-11-24T00:00:00+09:00');
  assert.equal(snapshot.rows[0]['미니멀'], 0);
  assert.equal(snapshot.rows[1]['미니멀'], null);
  assert.equal(snapshot.rows[51]['미니멀'], 12.5);
  assert.equal(snapshot.observedAt, new Date(NOW).toISOString());
});

test('rejects missing groups, duplicate weeks, invalid ratios and incomplete periods atomically', () => {
  const {toSnapshot} = moduleUnderTest();
  const mutations = [
    r => r.results.pop(),
    r => r.results.push(r.results[0]),
    r => r.results[0].data.push(r.results[0].data[0]),
    r => r.results[0].data[0].ratio = -1,
    r => r.results[0].data[0].ratio = 101,
    r => r.results[0].data[0].ratio = null,
    r => r.results[0].data[0].period = '2026-11-23',
    r => r.results[0].data[0].period = '2026-11-17',
    r => r.endDate = '2026-11-27',
  ];
  for (const mutate of mutations) {
    const raw = response(); mutate(raw);
    assert.throws(() => toSnapshot(raw, NOW), /Invalid Naver/);
  }
});

test('empty data for a known keyword is unavailable rather than zero', () => {
  const {toSnapshot} = moduleUnderTest();
  const raw = response(); raw.results[3].data = [];
  assert.ok(toSnapshot(raw, NOW).rows.every(row => row['1인사업가'] === null));
});

test('calls only the official API with the five user topics and server-side credentials', async () => {
  const {createMarketTrends} = moduleUnderTest();
  const collector = createMarketTrends({clock: () => NOW,
    readCredentials: () => ({id: 'private-id', secret: 'private-secret'}),
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://openapi.naver.com/v1/datalab/search');
      assert.equal(options.headers['X-Naver-Client-Secret'], 'private-secret');
      const body = JSON.parse(options.body);
      assert.equal(body.endDate, '2026-11-22');
      assert.equal(body.timeUnit, 'week');
      assert.deepEqual(body.keywordGroups[1].keywords, ['변화추적', '변화 추적', '트래킹']);
      assert.equal(body.keywordGroups.length, 5);
      return {ok: true, json: async () => response()};
    }});
  assert.equal(await collector.refresh(), true);
  assert.equal(collector.current.rows.length, 52);
  assert.doesNotMatch(JSON.stringify(collector.current), /private-id|private-secret/);
});

test('refresh failure retains last good observation, then expires it after 72 hours', async () => {
  const {createMarketTrends} = moduleUnderTest();
  let now = NOW, failed = false;
  const collector = createMarketTrends({clock: () => now, readCredentials: () => ({id: 'a', secret: 'b'}),
    fetchImpl: async () => {if (failed) throw Error('credential must not escape');
      return {ok: true, json: async () => response()};}});
  await collector.refresh();
  failed = true; now += DAY + 1;
  assert.equal(await collector.refresh(), false);
  assert.equal(collector.current.observedAt, new Date(NOW).toISOString());
  assert.equal(collector.lastSuccessAt, NOW);
  assert.equal(collector.failed, true);
  now = NOW + 3 * DAY + 1;
  assert.equal(collector.current, null);
});

test('failed first fetch never returns a successful empty chart', async () => {
  const {createMarketTrends} = moduleUnderTest();
  const collector = createMarketTrends({clock: () => NOW, readCredentials: () => ({id: 'a', secret: 'b'}),
    fetchImpl: async () => ({ok: false, status: 403})});
  assert.equal(await collector.refresh(), false);
  assert.equal(collector.current, null);
  assert.equal(collector.lastSuccessAt, 0);
});
