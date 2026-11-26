const {PROJECT, scopes, scopeSQL} = require('./calendar');

const completionEvents = new Map([
  ['policycock', 'case_opened'],
  ['Virtue', 'deed_saved'],
  ['miniapp-image-tools', 'transform_succeeded'],
]);

function healthQuery(end, groups, privateScope) {
  const {attribution, filter} = scopeSQL(groups, privateScope);
  const daysAgo = n => 'toDateTime(' + (end - n * 86400) + ')';
  const completedEnd = Math.floor(end / 86400) * 86400;
  const completionWindow = 'timestamp >= toDateTime(' + (completedEnd - 7 * 86400) +
    ') AND timestamp < toDateTime(' + completedEnd + ')';
  const tasks = groups.flatMap((scope, index) => completionEvents.has(scope.name)
    ? ["(" + attribution + " = " + index + " AND event = '" + completionEvents.get(scope.name) + "')"] : []);
  const events = tasks.join(' OR ') || '0';
  const virtue = groups.findIndex(scope => scope.name === 'Virtue');
  const view = "event = '$pageview'";
  const current = view + ' AND timestamp >= ' + daysAgo(7);
  const prev = view + ' AND timestamp >= ' + daysAgo(14) + ' AND timestamp < ' + daysAgo(7);
  function vital(key) {
    const property = "toFloat(properties['$web_vitals_" + key + "_value'])";
    const observed = "event = '$web_vitals' AND " + property + ' IS NOT NULL';
    return 'if(countIf(' + observed + ') > 0, quantileIf(0.75)(' + property + ', ' + observed + '), NULL)';
  }
  return `SELECT ${attribution} AS scope_id,
    uniqExactIf(person_id, ${current}),
    uniqExactIf(person_id, ${prev}),
    uniqExactIf(person_id, ${view} AND timestamp >= ${daysAgo(14)}),
    countIf(event = '$exception' AND timestamp >= ${daysAgo(7)}),
    countIf(${completionWindow} AND (${events})),
    ${vital('LCP')}, ${vital('INP')},
    uniqExactIf(person_id, ${view} AND timestamp >= ${daysAgo(1)}), countIf(${current}),
    uniqExactIf(properties.$session_id, coalesce(toString(properties.$session_id), '') != '' AND timestamp >= ${daysAgo(7)}),
    uniqExactIf(person_id, ${attribution} = ${virtue} AND event = 'deed_judge_attempted'),
    uniqExactIf(person_id, ${attribution} = ${virtue} AND event = 'deed_saved')
    FROM events WHERE timestamp >= ${daysAgo(30)} AND timestamp < toDateTime(${end}) AND ${filter}
    GROUP BY scope_id`;
}

async function collectHealth(hogql, now = Date.now(), {id = PROJECT, groups = scopes, privateScope = false} = {}) {
  const results = await hogql(id, healthQuery(Math.floor(now / 1000), groups, privateScope));
  if (!Array.isArray(results)) throw new Error('Missing PostHog app health rows');
  const values = new Map();
  for (const row of results) {
    if (!Array.isArray(row) || row.length !== 13 ||
        row.slice(0, 6).concat(row.slice(8)).some(n => !Number.isSafeInteger(n) || n < 0) ||
        row.slice(6, 8).some(n => n !== null && (!Number.isFinite(n) || n < 0))) throw new Error('Invalid app health row');
    const [i, wau, prev, union, errors, completions, lcp, inp, dau, pageviews, sessions, starts, conversions] = row;
    if (i >= groups.length || values.has(i) || union < Math.max(wau, prev) ||
        union > wau + prev) throw new Error('Inconsistent app health row');
    const retained = prev + wau - union;
    const series = {errors7d: errors, churned7d: prev - retained};
    if (completionEvents.has(groups[i].name)) series.taskCompletions7d = completions;
    if (prev > 0) series.retentionPercent = 100 * retained / prev;
    if (lcp !== null) series.lcpP75ms = lcp;
    if (inp !== null) series.inpP75ms = inp;
    values.set(i, {values: series, activity: {dau, wau, pageviews, sessions, retained, starts, conversions}});
  }
  return {observedAt: now, rows: groups.map(({name}, i) => ({scope: name,
    ...(values.get(i) ?? {activity: {dau:0, wau:0, pageviews:0, sessions:0, retained:0, starts:0, conversions:0}, values: {errors7d: 0, churned7d: 0,
      ...(completionEvents.has(name) ? {taskCompletions7d: 0} : {})}}),
  }))};
}

module.exports = {collectHealth};
