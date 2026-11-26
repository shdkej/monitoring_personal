const client = require('prom-client');
const SOURCE = 'https://status.aws.shdkej.com/analytics-ga4.json';
// The publisher runs once a day at 10:15 KST. Allow six hours for a delayed run.
const MAX_AGE_MS = 30 * 3600 * 1000;

function readRows(feed) {
  if (feed.schemaVersion !== 1 || feed.source !== 'ga4' || !Array.isArray(feed.rows) || !feed.rows.length) {
    throw new Error('Invalid GA4 feed');
  }
  const seen = new Set();
  return feed.rows.map(row => {
    if (typeof row.scope !== 'string' || !row.scope.trim() || seen.has(row.scope)) throw new Error('Invalid GA4 scope');
    seen.add(row.scope);
    const observed = Date.parse(row.observedAt);
    if (row.status === 'unavailable') return {scope: row.scope, observed};
    if (row.status !== 'ok' || !Number.isFinite(observed) ||
        !['newUsers', 'sessions'].every(k => Number.isSafeInteger(row.values?.[k]) && row.values[k] >= 0)) {
      throw new Error('Invalid GA4 measurement');
    }
    return {scope: row.scope, observed, values: row.values};
  });
}

function registerGA4(registry, clock = Date.now) {
  let rows = [];
  new client.Gauge({
    name: 'ga4_app_rolling7d_count',
    help: 'GA4 last seven days by property in the Space analytics feed',
    labelNames: ['scope', 'metric'], registers: [registry],
    collect() {
      this.reset();
      const now = clock();
      for (const {scope, observed, values} of rows) {
        if (!values || observed > now || now - observed > MAX_AGE_MS) continue;
        for (const metric of ['newUsers', 'sessions']) this.set({scope, metric}, values[metric]);
      }
    },
  });
  new client.Gauge({
    name: 'ga4_app_observed_timestamp_seconds', help: 'Last source observation by GA4 property',
    labelNames: ['scope'], registers: [registry],
    collect() {
      this.reset();
      for (const {scope, observed} of rows) {
        if (Number.isFinite(observed)) this.set({scope}, observed / 1000);
      }
    },
  });

  return async function refresh(fetchFeed = fetch) {
    const response = await fetchFeed(SOURCE, {signal: AbortSignal.timeout(15000), redirect: 'error'});
    if (!response.ok) throw new Error('GA4 feed HTTP ' + response.status);
    rows = readRows(await response.json());
  };
}

module.exports = {registerGA4};
