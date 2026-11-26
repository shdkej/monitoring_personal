const client = require('prom-client');
const {apiRows} = require('./analytics-api');
const {readFile} = require('node:fs/promises');
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

function registerGA4(registry, {
  clock = Date.now, readEngagement = () => readFile('/etc/ga4-engagement/report.json', 'utf8'),
  readInstagram = () => readFile('/etc/ga4-engagement/instagram.json', 'utf8'), api,
} = {}) {
  let rows = [];
  async function currentPrivateRows() {
    if (api?.ga4.size) return apiRows([], api.ga4, clock());
    let report;
    try {
      report = JSON.parse(await readEngagement());
    } catch {
      // The optional volume can be empty until the scheduled collector succeeds.
    }
    const now = clock();
    const legacy = report?.schemaVersion === 1 && Array.isArray(report.rows) ? report.rows : [];
    return legacy.filter(row => {
      const observed = Date.parse(row?.observedAt);
      return typeof row?.scope === 'string' && observed <= now && now - observed <= MAX_AGE_MS;
    });
  }
  new client.Gauge({
    name: 'ga4_app_rolling7d_count',
    help: 'GA4 last seven completed days by property',
    labelNames: ['scope', 'metric'], registers: [registry],
    collect() {
      this.reset();
      const now = clock();
      for (const {scope, observed, values} of apiRows(rows, api?.ga4, now)) {
        if (!values || observed > now || now - observed > MAX_AGE_MS) continue;
        for (const metric of ['newUsers', 'sessions']) this.set({scope, metric}, values[metric]);
      }
    },
  });
  new client.Gauge({
    name: 'ga4_app_session_engagement_seconds',
    help: 'Average engagement time per session in seconds, last seven days in the GA4 property',
    labelNames: ['scope'], registers: [registry],
    async collect() {
      this.reset();
      for (const row of await currentPrivateRows()) {
        if (row.status === 'ok' && Number.isSafeInteger(row.sessions) && row.sessions > 0 &&
            Number.isFinite(row.seconds) && row.seconds >= 0) {
          this.set({scope: row.scope}, row.seconds);
        }
      }
    },
  });
  new client.Gauge({
    name: 'ga4_app_channel_sessions',
    help: 'Sessions by GA4 property and default session channel group for the last seven completed days',
    labelNames: ['scope', 'channel'], registers: [registry],
    async collect() {
      this.reset();
      for (const row of await currentPrivateRows()) {
        if (!row.channelSessions || typeof row.channelSessions !== 'object' || Array.isArray(row.channelSessions)) continue;
        const channels = Object.entries(row.channelSessions);
        if (channels.length > 32 || !Number.isSafeInteger(row.sessions) || row.sessions < 0 ||
            !channels.every(([name, count]) => name.length > 0 && name.length <= 48 && Number.isSafeInteger(count) && count >= 0) ||
            channels.reduce((sum, [, count]) => sum + count, 0) !== row.sessions) continue;
        for (const [channel, count] of channels) this.set({scope: row.scope, channel}, count);
      }
    },
  });
  new client.Gauge({
    name: 'ga4_app_instagram_acquisition', help: 'Instagram-attributed sessions and first-user acquisitions in seven completed GA4 days',
    labelNames: ['scope', 'metric'], registers: [registry],
    async collect() {
      this.reset();
      for (const row of await currentPrivateRows()) {
        for (const metric of ['sessions', 'newUsers']) {
          const count = row.instagramAcquisition?.[metric];
          if (Number.isSafeInteger(count) && count >= 0) this.set({scope: row.scope, metric}, count);
        }
      }
    },
  });
  new client.Gauge({
    name: 'instagram_account_discovery', help: 'Observed Instagram account views, viewers or reach for the most recent seven-day reporting window',
    labelNames: ['account', 'metric'], registers: [registry],
    async collect() {
      this.reset();
      let report;
      try { report = JSON.parse(await readInstagram()); } catch { /* Optional Ego snapshot. */ }
      const legacy = report?.schemaVersion === 1 && report.source === 'instagram' && Array.isArray(report.rows) ? report.rows : [];
      const now = clock();
      const accounts = apiRows(legacy.filter(row => row?.scope), api?.instagram, now);
      for (const account of ['minimal_collector', 'every.policy']) {
        const valid = accounts.filter(row => row?.scope === account);
        if (valid.length !== 1 || valid[0].status !== 'ok') continue;
        const {observedAt, values} = valid[0];
        const observed = Date.parse(observedAt);
        if (!Number.isFinite(observed) || observed > now || now - observed > MAX_AGE_MS) continue;
        for (const metric of ['views', 'reach', 'viewers']) {
          const count = values?.[metric];
          if (Number.isSafeInteger(count) && count >= 0) this.set({account, metric}, count);
        }
      }
    },
  });
  new client.Gauge({
    name: 'ga4_app_observed_timestamp_seconds', help: 'Last source observation by GA4 property',
    labelNames: ['scope'], registers: [registry],
    collect() {
      this.reset();
      for (const {scope, observed} of apiRows(rows, api?.ga4, clock())) {
        if (Number.isFinite(observed)) this.set({scope}, observed / 1000);
      }
    },
  });

  return async function refresh(fetchFeed = fetch) {
    if (api?.ga4.size) return;
    const response = await fetchFeed(SOURCE, {signal: AbortSignal.timeout(15000), redirect: 'error'});
    if (!response.ok) throw new Error('GA4 feed HTTP ' + response.status);
    rows = readRows(await response.json());
  };
}

module.exports = {registerGA4};
