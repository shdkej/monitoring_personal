const {PROJECT, scopes, scopeSQL} = require('./calendar');

const completionEvents = new Map([
  ['policycock', 'case_opened'],
  ['miniapp-image-tools', 'transform_succeeded'],
]);

function healthQuery(end) {
  const {attribution, filter} = scopeSQL();
  const daysAgo = n => 'toDateTime(' + (end - n * 86400) + ')';
  const completedEnd = Math.floor(end / 86400) * 86400;
  const completionWindow = 'timestamp >= toDateTime(' + (completedEnd - 7 * 86400) +
    ') AND timestamp < toDateTime(' + completedEnd + ')';
  const events = Array.from(completionEvents, ([app, event]) =>
    "(properties.app_id = '" + app + "' AND event = '" + event + "')").join(' OR ');
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
    ${vital('LCP')}, ${vital('INP')}
    FROM events WHERE timestamp >= ${daysAgo(30)} AND timestamp < toDateTime(${end}) AND ${filter}
    GROUP BY scope_id`;
}

async function collectHealth(hogql, now = Date.now()) {
  const results = await hogql(PROJECT, healthQuery(Math.floor(now / 1000)));
  if (!Array.isArray(results)) throw new Error('Missing PostHog app health rows');
  const values = new Map();
  for (const row of results) {
    if (!Array.isArray(row) || row.length !== 8 ||
        row.slice(0, 6).some(n => !Number.isSafeInteger(n) || n < 0) ||
        row.slice(6).some(n => n !== null && (!Number.isFinite(n) || n < 0))) throw new Error('Invalid app health row');
    const [i, wau, prev, union, errors, completions, lcp, inp] = row;
    if (i >= scopes.length || values.has(i) || union < Math.max(wau, prev) ||
        union > wau + prev) throw new Error('Inconsistent app health row');
    const retained = prev + wau - union;
    const series = {errors7d: errors, churned7d: prev - retained};
    if (completionEvents.has(scopes[i].name)) series.taskCompletions7d = completions;
    if (prev > 0) series.retentionPercent = 100 * retained / prev;
    if (lcp !== null) series.lcpP75ms = lcp;
    if (inp !== null) series.inpP75ms = inp;
    values.set(i, series);
  }
  return {observedAt: now, rows: scopes.map(({name}, i) => ({scope: name,
    values: values.get(i) ?? {errors7d: 0, churned7d: 0,
      ...(completionEvents.has(name) ? {taskCompletions7d: 0} : {})},
  }))};
}

module.exports = {collectHealth};
