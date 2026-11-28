const test = require('node:test');
const assert = require('node:assert/strict');
const {Registry} = require('prom-client');
const {createAnalyticsApi, readAccount, readProperty, HOUR} = require('./analytics-api');
const {registerGA4} = require('./ga4');

function reports(rows) {
  return async (url, token, {requests}) => ({reports: requests.map((q, i) => {
    const dimensions = q.dimensions.length;
    return {metadata: {timeZone: "Asia/Seoul"}, metricHeaders: q.metrics, dimensionHeaders: q.dimensions, rowCount: rows[i].length,
      rows: rows[i].map(row => ({dimensionValues: row.slice(0, dimensions).map(value => ({value})),
        metricValues: row.slice(dimensions).map(value => ({value: String(value)}))}))};
  })});
}

test('Data API preserves distinct acquisition attribution and rejects duplicate sources', async () => {
  const totals = [[3, 8, 13]], channels = [['Direct', 2], ['Referral', 6]];
  const sessions = [['instagram', 4], ['L.Instagram.com', 1], ['instagram.com.example', 3]];
  const users = [['(direct)', 2], ['ig', 1]];
  const read = values => readProperty('a', '123', 'example', 0, reports(values));
  const row = await read([totals, channels, sessions, users]);
  assert.deepEqual(row.instagramAcquisition, {sessions: 5, newUsers: 1});
  assert.equal(row.seconds, 13 / 8);
  assert.deepEqual(row.channelSessions, {Direct: 2, Referral: 6});
  const empty = await read([[], [], [], []]);
  assert.deepEqual(empty.publicRow.values, {sessions: null, newUsers: null});
  assert.equal(empty.sessions, 0);
  assert.equal(empty.seconds, null);
  assert.deepEqual(empty.instagramAcquisition, {sessions: 0, newUsers: 0});
  await assert.rejects(read([totals, channels, [sessions[0], sessions[0]], users]), /Incomplete GA4 sources/);
});

test('Instagram verifies account and seven-day account totals, and keeps missing reach unavailable', async () => {
  const now = Date.parse('2026-11-26T09:00:00Z');
  const response = async url => {
    if (url.includes('fields=')) return {username: 'minimal_collector', id: '123456789'};
    const params = new URL(url).searchParams;
    assert.equal(params.get('metric_type'), 'total_value');
    assert.equal(Number(params.get('until')) - Number(params.get('since')), 7 * 86400);
    return {data: [{name: 'views', total_value: {value: 0}}]};
  };
  const row = await readAccount('example', 'me', now, response);
  assert.deepEqual(row.values, {views: 0});
  await assert.rejects(readAccount('example', 'me', now, async () => ({username: 'other', id: '123456789'})), /Unexpected Instagram/);
  const facebook = await readAccount('example', '123456789', now, url => {
    assert.equal(new URL(url).hostname, 'graph.facebook.com');
    return response(url);
  }, 'graph.facebook.com');
  assert.deepEqual(facebook.values, {views:0});
  await assert.rejects(readAccount('example', '123456789', now, response, 'example.org'), /Invalid Instagram API host/);
});

test('cutover survives restart and expired direct samples never revive browser values', async () => {
  let now = Date.now();
  const r = new Registry();
  const api = createAnalyticsApi(r, {googleEnabled: true, instagramEnabled: false});
  let legacyCalls = 0;
  const never = () => { legacyCalls++; throw Error('legacy unavailable'); };
  const fallbackIG = async () => JSON.stringify({schemaVersion: 1, source: 'instagram', rows: [
    {scope: 'minimal_collector', status: 'ok', observedAt: new Date(now).toISOString(), values: {views: 3}},
  ]});
  const refresh = registerGA4(r, {clock: () => now, readEngagement: never, readInstagram: fallbackIG, api});
  await refresh(never);
  const values = async name => (await r.getSingleMetric(name).get()).values;
  assert.deepEqual(await values('ga4_app_rolling7d_count'), []);
  // The unsegmented count and independently estimated breakdowns can differ.
  const data = [ [[0, 1, 0]], [['Direct', 2]], [['instagram', 2]], [] ];
  api.ga4.set('blog', await readProperty('blog', '123', 'example', now, reports(data)));
  assert.deepEqual((await values('ga4_app_rolling7d_count')).map(m => m.value), [0, 1]);
  assert.equal((await values('ga4_app_channel_sessions'))[0].value, 2);
  assert.equal((await values('ga4_app_instagram_acquisition'))[0].value, 2);
  assert.equal((await values('ga4_app_session_engagement_seconds'))[0].value, 0);
  assert.equal((await values('instagram_account_discovery'))[0].value, 3);
  now += 3 * HOUR + 1;
  assert.deepEqual(await values('ga4_app_rolling7d_count'), []);
  assert.equal(legacyCalls, 0);
});

test('one Meta profile and one insights response supply both projections', async () => {
  const now = Date.parse('2026-11-28T01:00:00Z');
  const calls = [];
  const row = await readAccount('test', '123456789', now, async url => {
    calls.push(url);
    if (url.includes('fields=')) return {id: '123456789', username: 'minimal_collector', followers_count: 2};
    return {data: ['views', 'reach', 'profile_views', 'total_interactions'].map((name, i) =>
      ({name, total_value: {value: i}}))};
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(row.values, {views: 0, reach: 1});
  assert.deepEqual(row.publicRow.values, {views: 0, viewers: 1, followers: 2, profileVisits: 2, interactions: 3});
  assert.equal(row.publicRow.periodEnd, '2026-11-27');
});
