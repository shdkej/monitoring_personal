const {createSnapshotCache} = require('./calendar');
const DAY = 86400, WEEK = 7 * DAY, KST = 9 * 3600;
const APPS = {policycock: '모두의정책', virtue: 'Virtue'};
const MAX_ROWS = 50000;
const date = t => new Date((t + KST) * 1000).toISOString().slice(0, 10);
function monday(t) {
  const day = Math.floor((t + KST) / DAY) * DAY;
  return day - (new Date(day * 1000).getUTCDay() + 6) % 7 * DAY - KST;
}
function queryFor(now) {
  // No IDs leave the query boundary. One row per app/browser, filtered before aggregation.
  return `SELECT properties.app_id,
    toUnixTimestamp(minIf(timestamp, event = 'first_session_started')),
    if(countIf(event = 'first_session_activated') > 0, toUnixTimestamp(minIf(timestamp, event = 'first_session_activated')), NULL),
    maxIf(if(properties.referral_source = 'share', 1, 0), event = 'first_session_started'),
    maxIf(if(properties.pmf_identity_version = 1, 1, 0), event = 'first_session_started'),
    groupArrayIf(toUnixTimestamp(timestamp), event = 'pmf_core_completed')
    FROM events
    WHERE timestamp >= toDateTime(${monday(now) - 4 * WEEK}) AND timestamp < toDateTime(${now})
      AND properties.app_id IN ('policycock', 'virtue') AND properties.traffic_kind = 'user'
      AND event IN ('first_session_started', 'first_session_activated', 'pmf_core_completed')
    GROUP BY properties.app_id, distinct_id
    HAVING countIf(event = 'first_session_started') > 0
    LIMIT ${MAX_ROWS + 1}`;
}
function aggregatePmf(rows, now) {
  if (!Number.isFinite(now) || !Array.isArray(rows) || rows.length > MAX_ROWS) throw Error('Invalid or truncated PMF source');
  const week = monday(now), start = week - 4 * WEEK;
  const parsed = rows.map(r => {
    if (!Array.isArray(r) || r.length !== 6) throw Error('Invalid PMF row shape');
    const [app, entry, done, shared, linked, core] = r;
    const validTime = t => typeof t === 'number' && Number.isFinite(t) && t >= start && t <= now;
    if (!Object.hasOwn(APPS, app) || !validTime(entry) || (done !== null && !validTime(done)) ||
        ![0, 1].includes(shared) || ![0, 1].includes(linked) || !Array.isArray(core) || !core.every(validTime)) throw Error('Invalid PMF row');
    const activated = done !== null && done >= entry && done <= entry + DAY;
    const reuseMature = activated && linked === 1 && done + 8 * DAY <= now;
    return {app, entry, done, shared, linked, activated, mature: entry + DAY <= now, reuseMature,
      reused: reuseMature && core.some(t => t >= done + DAY && t < done + 8 * DAY)};
  });
  function summarize(service, cohort, selected) {
    const entrants = selected.length, activated = selected.filter(r => r.activated).length;
    const mature = selected.filter(r => r.mature);
    const numerator = mature.filter(r => r.activated).length;
    const reuseDenominator = selected.filter(r => r.reuseMature).length;
    const reuseNumerator = selected.filter(r => r.reused).length;
    const reusePending = selected.filter(r => r.activated && r.linked && !r.reuseMature).length;
    const unlinked = selected.filter(r => r.activated && !r.linked).length;
    const observed = selected.length ? date(Math.min(...selected.map(r => r.entry))) : null;
    return {service, app: APPS[service], weekStart: date(cohort), entrants, activated,
      activationNumerator: numerator, activationDenominator: mature.length,
      activationPercent: mature.length ? numerator / mature.length * 100 : null,
      activationSample: `${numerator} / ${mature.length}`, pending: entrants - mature.length,
      reuseNumerator, reuseDenominator, reusePercent: reuseDenominator ? reuseNumerator / reuseDenominator * 100 : null,
      reuseSample: reuseDenominator ? `${reuseNumerator} / ${reuseDenominator}` : '— / —',
      reusePending, unlinked,
      reuseStatus: reuseDenominator ? '관측 완료' : reusePending ? '관찰 중' : unlinked ? '과거 표본 미측정' : '표본 없음',
      coverage: entrants ? (cohort === week ? '이번 주 진행 중' : '수신 기록 기준') : '수신 기록 없음',
      firstObserved: observed};
  }
  const summary = [], cohorts = [], channels = [], reuse = [];
  for (const app of Object.keys(APPS)) {
    const appRows = parsed.filter(r => r.app === app), current = appRows.filter(r => r.entry >= week);
    summary.push(summarize(app, week, current));
    reuse.push(summarize(app, week, appRows));
    for (let i = 0; i < 5; i++) {
      const from = week - i * WEEK;
      cohorts.push(summarize(app, from, appRows.filter(r => r.entry >= from && r.entry < from + WEEK)));
    }
    for (const shared of [1, 0]) channels.push({...summarize(app, week, current.filter(r => r.shared === shared)), channel: shared ? '공유 링크' : '기타 · 출처 미지정'});
  }
  return {observedAt: new Date(now * 1000).toISOString(), timeZone: 'Asia/Seoul', weekStart: date(week),
    windowStart: date(start), summary, cohorts, channels, reuse};
}
function selectPmf(report, service = 'all') {
  if (service === 'policycock|virtue') service = 'all';
  if (service !== 'all' && !Object.hasOwn(APPS, service)) throw Error('Unsupported PMF app');
  return {...report, ...Object.fromEntries(['summary', 'cohorts', 'channels', 'reuse'].map(k => [k,
    report[k].filter(r => service === 'all' || r.service === service).map(r => ({...r, observedAt: report.observedAt}))]))};
}
function createPmf(hogql, clock = Date.now) {
  const cache = createSnapshotCache(async () => {
    const now = Math.floor(clock() / 1000);
    return aggregatePmf(await hogql('424014', queryFor(now)), now);
  });
  return {refresh: () => cache.refresh(), get current() {
    const snapshot = cache.current;
    return snapshot && clock() - Date.parse(snapshot.observedAt) <= 45 * 60 * 1000 ? snapshot : null;
  }};
}
module.exports = {aggregatePmf, selectPmf, createPmf, queryFor};
