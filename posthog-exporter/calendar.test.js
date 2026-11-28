const test = require('node:test');
const assert = require('node:assert/strict');
const { collectSnapshot, createSnapshotCache } = require('./calendar');

test('complete Korean calendar periods, UTC rolling range, and missing session coverage', async () => {
  const queries = [];
  const now = new Date('2026-03-01T15:00:01Z'); // Monday 00:00 in Seoul
  const feed = await collectSnapshot(async (project, query) => {
    assert.equal(project, '424014');
    queries.push(query);
    return [[0, 0, 14, 0, 0, 0], [2, 0, 17, 3, 3, 17]];
  }, now);
  assert.equal(queries.length, 4);
  for (const q of queries) {
    assert.match(q, /uniqExactIf/);
    assert.match(q, /synthetic/);
    assert.match(q, /virtue.aws.shdkej.com/);
  }
  assert.equal(feed.rows.length, 7);
  const row = feed.rows[0];
  assert.deepEqual([row.periodStart, row.periodEnd], ['2026-02-22', '2026-02-28']);
  assert.equal(row.eventsWithSessionId, 0);
  assert.deepEqual(row.values, {events: 14, pageviews: 0, sessions: 0});
  assert.deepEqual(Object.values(row.periods).map(group => group.length), [7, 4, 2]);
  assert.equal(row.periods.day.at(-1).periodEnd, '2026-03-01');
  assert.equal(row.periods.week.at(-1).periodStart, '2026-02-23');
  assert.equal(row.periods.month.at(-1).periodEnd, '2026-02-28');
  assert.equal(feed.rows[2].periods.month[0].eventsWithSessionId, 17);
  assert.equal(feed.rows[2].periods.month[0].values.sessions, 3);
  assert.equal(feed.rows[4].values.events, 0);
});

test('invalid or duplicate counts cannot become zero or replace an observed snapshot', async () => {
  for (const rows of [null, [[0, 0, null, 0, 0, 0]], [[0, 0, 1, 0, 2, 1]],
    [[9, 0, 1, 0, 1, 1]], [[0, 0, 1, 0, 1, 1], [0, 0, 1, 0, 1, 1]]]) {
    await assert.rejects(() => collectSnapshot(async () => rows));
  }
  let fail = false;
  const cache = createSnapshotCache(async () => {
    if (fail) throw new Error('upstream unavailable');
    return {observedAt: '2026-11-25T01:00:00Z'};
  });
  assert.equal(cache.current, null);
  await cache.refresh();
  const before = cache.current;
  fail = true;
  await assert.rejects(() => cache.refresh());
  assert.equal(cache.current, before);
});
