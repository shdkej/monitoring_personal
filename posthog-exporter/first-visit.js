const {PROJECT} = require('./calendar');

async function firstVisitMetrics(hogql, end) {
  const start = end - 7 * 86400;
  // Group on the anonymous first-session UUID. Retries, reloads and repeated
  // completions represent one visit, and a completion must have its matching entry.
  const activation = 'completed >= entered AND completed <= entered + interval 24 hour';
  const dropped = `entered + interval 24 hour <= toDateTime(${end}) AND NOT (${activation})`;
  const query = `SELECT app, count(), countIf(${activation}), countIf(shared), countIf(shared AND ${activation}),
      countIf(shared AND ${dropped}), countIf(NOT shared AND ${dropped})
    FROM (
      SELECT properties.app_id AS app, distinct_id,
        minIf(timestamp, event = 'first_session_started') AS entered,
        minIf(timestamp, event = 'first_session_activated') AS completed,
        maxIf(if(properties.referral_source = 'share', 1, 0), event = 'first_session_started') AS shared
      FROM events
      WHERE timestamp >= toDateTime(${start}) AND timestamp < toDateTime(${end})
        AND event IN ('first_session_started', 'first_session_activated')
        AND properties.app_id IN ('policycock', 'virtue') AND properties.traffic_kind = 'user'
      GROUP BY app, distinct_id HAVING countIf(event = 'first_session_started') > 0
    ) GROUP BY app`;
  const rows = await hogql(PROJECT, query);
  if (!Array.isArray(rows)) throw new Error('Missing first visit report');
  const scopes = {policycock: 'policycock', virtue: 'Virtue'};
  const metrics = new Map();
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== 7) throw new Error('Invalid first visit row');
    const [app, visits, activated, referrals, sharedActivated, sharedDropped, otherDropped] = row;
    const scope = Object.hasOwn(scopes, app) && scopes[app];
    if (!scope || metrics.has(scope) || !row.slice(1).every(n => Number.isSafeInteger(n) && n >= 0) ||
        visits === 0 || activated > visits || referrals > visits || sharedActivated > Math.min(referrals, activated) ||
        sharedDropped > referrals - sharedActivated ||
        otherDropped > visits - referrals - (activated - sharedActivated)) throw new Error('Invalid first visit counts');
    metrics.set(scope, {firstVisitActivationPercent: 100 * activated / visits, shareNewVisitors7d: referrals,
      sharedDropped, otherDropped, sharedActivated, sharedPending: referrals - sharedActivated, otherActivated: activated - sharedActivated,
      otherPending: visits - referrals - (activated - sharedActivated)});
  }
  return metrics;
}

module.exports = {firstVisitMetrics};
