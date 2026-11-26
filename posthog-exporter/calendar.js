// Only allowlisted app IDs and hostnames can become public scope labels.
const PROJECT = '424014';
const scopes = [
  {name: 'policycock', appId: 'policycock'},
  {name: 'miniapp-image-tools', appId: 'miniapp-image-tools'},
  {name: 'Infinity', hosts: ['infinity.aws.shdkej.com']},
  {name: 'shdkej.com', hosts: ['shdkej.com']},
  {name: 'Virtue', hosts: ['virtue.aws.shdkej.com', 'virtue.oracle.shdkej.com']},
  {name: '앱 미지정'},
];
const DAY = 86400000;
const SEOUL = 9 * 3600000;
const dateLabel = time => new Date(time).toISOString().slice(0, 10);

function windowsFor(now) {
  const utcDay = Math.floor(now.getTime() / DAY) * DAY;
  const localDay = Math.floor((now.getTime() + SEOUL) / DAY) * DAY;
  const monday = localDay - ((new Date(localDay).getUTCDay() + 6) % 7) * DAY;
  const currentMonth = new Date(localDay);
  currentMonth.setUTCDate(1);
  const make = (start, end, offset) => ({
    start: (start - offset) / 1000, end: (end - offset) / 1000,
    periodStart: dateLabel(start), periodEnd: dateLabel(end - DAY),
    timeZone: offset ? 'Asia/Seoul' : 'UTC',
  });
  const days = (end, count, step) => Array.from({length: count}, (_, i) => (
    make(end - (count - i) * step, end - (count - i - 1) * step, SEOUL)
  ));
  const monthStart = diff => Date.UTC(currentMonth.getUTCFullYear(), currentMonth.getUTCMonth() + diff, 1);
  return {
    day: days(localDay, 7, DAY),
    week: days(monday, 4, 7 * DAY),
    month: [make(monthStart(-2), monthStart(-1), SEOUL), make(monthStart(-1), monthStart(0), SEOUL)],
    rolling7d: [make(utcDay - 7 * DAY, utcDay, 0)],
  };
}

function scopeSQL() {
  const appIds = scopes.filter(scope => scope.appId).map(scope => "'" + scope.appId + "'");
  const conditions = [];
  for (const [index, scope] of scopes.entries()) {
    if (scope.appId) conditions.push("properties.app_id = '" + scope.appId + "'", index);
    if (scope.hosts) {
      const hosts = scope.hosts.map(host => "'" + host + "'").join(', ');
      conditions.push('properties.app_id IS NULL AND properties.$host IN (' + hosts + ')', index);
    }
  }
  const attribution = 'multiIf(' + [...conditions, scopes.length - 1].join(', ') + ')';
  const filter = "coalesce(properties.traffic_kind, '') != 'synthetic' AND " +
    "(properties.app_id IS NULL OR properties.app_id IN (" + appIds.join(', ') + "))";
  return {attribution, filter};
}

function queryFor(windows) {
  const {attribution, filter} = scopeSQL();
  const bucketCases = windows.slice(0, -1).flatMap((win, i) => ['timestamp < toDateTime(' + win.end + ')', i]);
  const bucket = bucketCases.length ? 'multiIf(' + [...bucketCases, windows.length - 1].join(', ') + ')' : 'toInt64(0)';
  const session = "properties['$session_id']";
  const identified = "coalesce(toString(" + session + "), '') != ''";
  return `SELECT ${attribution} AS app_scope, ${bucket} AS bucket_index,
    count(), countIf(event = '$pageview'), uniqExactIf(${session}, ${identified}), countIf(${identified})
    FROM events
    WHERE timestamp >= toDateTime(${windows[0].start}) AND timestamp < toDateTime(${windows.at(-1).end})
      AND ${filter}
    GROUP BY app_scope, bucket_index`;
}

function parseCounts(results, windows) {
  if (!Array.isArray(results)) throw new Error('Missing PostHog aggregate rows');
  const byScope = scopes.map(() => new Map());
  for (const result of results) {
    if (!Array.isArray(result) || result.length !== 6 ||
        result.some(n => !Number.isSafeInteger(n) || n < 0)) throw new Error('Invalid PostHog aggregate');
    const [scope, bucket, events, pageviews, sessions, identified] = result;
    if (scope >= scopes.length || bucket >= windows.length || byScope[scope].has(bucket) ||
        pageviews > events || identified > events || sessions > identified) throw new Error('Inconsistent PostHog aggregate');
    byScope[scope].set(bucket, {values: {events, pageviews, sessions}, eventsWithSessionId: identified});
  }
  return byScope;
}

async function collectSnapshot(hogql, now = new Date()) {
  const observedAt = now.toISOString();
  const rows = scopes.map(scope => ({scope: scope.name, method: 'PostHog exporter · HogQL',
    observedAt, status: 'ok', periodStatus: 'ok', periods: {}}));
  // Each resolution is queried independently so one session across a date boundary
  // counts once in the longer bucket. All apps share one scan per resolution.
  for (const [period, windows] of Object.entries(windowsFor(now))) {
    const data = parseCounts(await hogql(PROJECT, queryFor(windows)), windows);
    for (const [index, row] of rows.entries()) {
      const samples = windows.map(({periodStart, periodEnd, timeZone}, i) => ({
        periodStart, periodEnd, timeZone, observedAt,
        ...(data[index].get(i) ?? {values: {events: 0, pageviews: 0, sessions: 0}, eventsWithSessionId: 0}),
      }));
      if (period === 'rolling7d') Object.assign(row, samples[0]);
      else row.periods[period] = samples;
    }
  }
  return {schemaVersion: 1, source: 'posthog', observedAt, rows};
}

function createSnapshotCache(load) {
  let current = null;
  let pending = null;
  return {
    get current() { return current; },
    refresh() {
      if (!pending) pending = load().then(result => { current = result; }).finally(() => { pending = null; });
      return pending;
    },
  };
}

module.exports = {collectSnapshot, createSnapshotCache, scopeSQL, scopes, PROJECT};
