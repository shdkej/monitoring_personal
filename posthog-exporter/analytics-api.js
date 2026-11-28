const {readFile} = require('node:fs/promises');
const {JWT} = require('google-auth-library');
const {Gauge} = require('prom-client');
const {readGmail} = require('./gmail');

const PROPERTIES = {blog: '252603434', afzma: '523848883', policycock: '565383231'};
const INSTAGRAM = 'minimal_collector';
const HOUR = 3600000;
const MAX_AGE = 3 * HOUR;

async function request(url, token, body) {
  const headers = {Authorization: 'Bearer ' + token};
  const options = {headers, redirect: 'error', signal: AbortSignal.timeout(20000)};
  if (body) Object.assign(options, {method: 'POST', body: JSON.stringify(body)});
  if (body) headers['Content-Type'] = 'application/json';
  const response = await fetch(url, options);
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return response.json();
}

const gaRange = {startDate: '7daysAgo', endDate: 'yesterday'};
function gaReport(metrics, dimensions = []) {
  return {dateRanges: [gaRange], metrics: metrics.map(name => ({name})), dimensions: dimensions.map(name => ({name})),
    keepEmptyRows: true, limit: '10000'};
}
function attributed(rows) {
  if (rows.some(([source]) => typeof source !== 'string' || !source) || new Set(rows.map(([source]) => source)).size !== rows.length) throw new Error('Incomplete GA4 sources');
  const instagram = /^(?:ig|instagram|(?:[a-z0-9-]+\.)*instagram\.com|com\.instagram\.android)$/i;
  return rows.reduce((sum, [source, count]) => instagram.test(source) ? sum + count : sum, 0);
}

function parseReport(report, query) {
  const names = list => (list || []).map(header => header.name).join('|');
  if (!report || names(report.metricHeaders) !== names(query.metrics) || names(report.dimensionHeaders) !== names(query.dimensions)) {
    throw new Error('Unexpected GA4 report columns');
  }
  const rows = report.rows ?? [];
  if (!Array.isArray(rows) || rows.length !== (report.rowCount ?? 0) ||
      report.metadata?.dataLossFromOtherRow || report.metadata?.subjectToThresholding ||
      report.metadata?.samplingMetadatas?.length) throw new Error('Incomplete GA4 report');
  return rows.map(row => {
    if (row.metricValues?.length !== query.metrics.length || (row.dimensionValues || []).length !== query.dimensions.length)
      throw new Error('Incomplete GA4 row');
    const counts = row.metricValues.map(({value}) => {
      if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
        throw new Error('Invalid GA4 count');
      return Number(value);
    });
    return [...(row.dimensionValues || []).map(({value}) => value), ...counts];
  });
}

function publicRow(scope, now, timeZone, method, values) {
  const day = new Intl.DateTimeFormat('en-CA', {timeZone, year: 'numeric', month: '2-digit', day: '2-digit'}).format(now);
  const midnight = Date.parse(day + 'T00:00:00Z');
  const daysAgo = n => new Date(midnight - n * 86400000).toISOString().slice(0, 10);
  return {scope, observedAt: new Date(now).toISOString(), status: 'ok', method, timeZone,
    periodStart: daysAgo(7), periodEnd: daysAgo(1), values};
}

async function readProperty(scope, property, token, now, get = request) {
  const queries = [
    gaReport(['newUsers', 'sessions', 'userEngagementDuration']),
    gaReport(['sessions'], ['sessionDefaultChannelGroup']),
    gaReport(['sessions'], ['sessionSource']),
    gaReport(['newUsers'], ['firstUserSource']),
  ];
  const {reports} = await get('https://analyticsdata.googleapis.com/v1beta/properties/' + property + ':batchRunReports', token, {requests: queries});
  if (reports?.length !== queries.length) throw new Error('Incomplete GA4 batch');
  const [total, channels, sourcedSessions, sourcedUsers] = reports.map((report, i) => parseReport(report, queries[i]));
  if (total.length > 1) throw new Error('Unexpected GA4 total rows');
  const [newUsers, sessions, duration] = total[0] || [0, 0, 0];
  const instagramAcquisition = {sessions: attributed(sourcedSessions), newUsers: attributed(sourcedUsers)};
  const channelSessions = Object.fromEntries(channels);
  if (channels.length > 32 || channels.some(([name]) => typeof name !== 'string' || !name || name.length > 48) ||
      Object.keys(channelSessions).length !== channels.length)
    throw new Error('Invalid GA4 channels');
  return {scope, observed: now, observedAt: new Date(now).toISOString(), status: sessions ? 'ok' : 'no_sessions',
    publicRow: reports[0].metadata?.timeZone === 'Asia/Seoul'
      ? publicRow(scope, now, 'Asia/Seoul', 'GA4 Data API', total.length ? {sessions, newUsers} : {sessions: null, newUsers: null})
      : null,
    values: {sessions, newUsers}, sessions, seconds: sessions ? duration / sessions : null, channelSessions, instagramAcquisition};
}

async function readAccount(token, accountId, now, get = request, graphHost = 'graph.instagram.com') {
  if (accountId !== 'me' && !/^\d{5,30}$/.test(accountId)) throw new Error('Invalid Instagram account');
  if (!['graph.instagram.com', 'graph.facebook.com'].includes(graphHost)) throw new Error('Invalid Instagram API host');
  if (graphHost === 'graph.facebook.com' && accountId === 'me') throw new Error('Instagram account ID required for this login');
  const base = 'https://' + graphHost + '/v27.0/';
  const profile = await get(base + accountId + '?fields=id,username,followers_count', token);
  if (profile.username !== INSTAGRAM || !/^\d{5,30}$/.test(profile.id)) throw new Error('Unexpected Instagram account');
  const until = Math.floor(now / 86400000) * 86400;
  const params = new URLSearchParams({metric: 'views,reach,total_interactions,profile_views', metric_type: 'total_value', period: 'day',
    since: String(until - 7 * 86400), until: String(until)});
  const {data} = await get(base + profile.id + '/insights?' + params, token);
  if (!Array.isArray(data)) throw new Error('Missing Instagram insights');
  const values = {};
  for (const name of ['views', 'reach']) {
    const rows = data.filter(row => row.name === name);
    if (!rows.length && name === 'reach') continue;
    const value = rows[0]?.total_value?.value;
    if (rows.length !== 1 || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid Instagram insights');
    values[name] = value;
  }
  const expanded = {views: values.views, viewers: values.reach, followers: profile.followers_count};
  for (const [name, key] of [['total_interactions', 'interactions'], ['profile_views', 'profileVisits']]) {
    const matches = data.filter(row => row.name === name);
    if (matches.length === 1) expanded[key] = matches[0]?.total_value?.value;
  }
  const complete = ['views', 'viewers', 'followers', 'interactions', 'profileVisits']
    .every(key => Number.isSafeInteger(expanded[key]) && expanded[key] >= 0);
  return {scope: INSTAGRAM, observed: now, observedAt: new Date(now).toISOString(), status: 'ok', values,
    publicRow: complete ? publicRow(INSTAGRAM, now, 'UTC', 'Instagram Insights API', expanded) : null};
}

async function optionalSecret(path) {
  try { return (await readFile(path, 'utf8')).trim(); } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return null;
  }
}

async function googleToken(credentials) {
  const {client_email: email, private_key: key} = JSON.parse(credentials);
  if (!email || !key) throw new Error('Missing GA4 service account');
  const client = new JWT({email, key, scopes: ['https://www.googleapis.com/auth/analytics.readonly'], transporterOptions: {timeout: 20000}});
  const {token} = await client.getAccessToken();
  if (!token) throw new Error('Missing Google access token');
  return token;
}

function createAnalyticsApi(registry, {
  clock = Date.now, googleEnabled = process.env.GA4_API_ENABLED === 'true',
  instagramEnabled = process.env.INSTAGRAM_API_ENABLED === 'true',
  gmailEnabled = process.env.GMAIL_GOG_ENABLED === 'true',
} = {}) {
  // A configured source owns its labels immediately, including after pod restarts.
  // Empty entries are unavailable until a complete API response arrives.
  const ga4 = new Map(googleEnabled ? Object.keys(PROPERTIES).map(scope => [scope, null]) : []);
  const instagram = new Map(instagramEnabled ? [[INSTAGRAM, null]] : []);
  const gmail = new Map(gmailEnabled ? [['customer-support', null]] : []);
  const failures = new Gauge({name: 'analytics_api_consecutive_failures', help: 'Consecutive hourly API refresh failures',
    labelNames: ['source', 'scope'], registers: [registry]});
  const lastSuccess = new Gauge({name: 'analytics_api_last_success_timestamp_seconds', help: 'Last verified direct API result',
    labelNames: ['source', 'scope'], registers: [registry]});
  async function update(source, scope, cache, load) {
    try {
      const row = await load();
      cache.set(scope, row);
      lastSuccess.set({source, scope}, row.observed / 1000);
      failures.set({source, scope}, 0);
    } catch (err) {
      failures.inc({source, scope});
      // Provider or OAuth libraries may attach credentials to error objects.
      const status = /^(HTTP \d{3})$/.test(err.message) ? err.message : 'invalid or unavailable response';
      console.error(source + ' API ' + scope + ': ' + status);
    }
  }
  async function refreshGoogle() {
    if (!googleEnabled) return;
    const auth = readFile('/etc/analytics-ga4/credentials.json', 'utf8').then(googleToken);
    await Promise.all(Object.entries(PROPERTIES).map(([scope, property]) => update('ga4', scope, ga4,
      async () => readProperty(scope, property, await auth, clock()))));
  }
  async function refreshInstagram() {
    if (!instagramEnabled) return;
    await update('instagram', INSTAGRAM, instagram, async () => {
      const token = (await readFile('/etc/analytics-instagram/access-token', 'utf8')).trim();
      const id = await optionalSecret('/etc/analytics-instagram/account-id');
      const host = await optionalSecret('/etc/analytics-instagram/graph-host');
      return readAccount(token, id || 'me', clock(), request, host || 'graph.instagram.com');
    });
  }
  function onceAtATime(load) {
    let pending;
    return () => {
      if (!pending) pending = load().finally(() => { pending = null; });
      return pending;
    };
  }
  const sources = [refreshGoogle, refreshInstagram];
  if (gmailEnabled) sources.push(() => update('gmail', 'customer-support', gmail, () => readGmail(clock())));
  const collectors = sources.map(onceAtATime);
  const refresh = () => Promise.all(collectors.map(collect => collect()));
  function publicSnapshot(source) {
    const cache = source === 'ga4' ? ga4 : instagram;
    const now = clock();
    const rows = Array.from(cache, ([scope, row]) =>
      row?.publicRow && now >= row.observed && now - row.observed <= MAX_AGE
        ? row.publicRow : {scope, status: 'unavailable'});
    const times = rows.filter(row => row.status === 'ok').map(row => row.observedAt).sort();
    return times.length ? {schemaVersion: 1, source, rows, observedAt: times.at(-1)} : null;
  }
  return {ga4, instagram, gmail, refresh, publicSnapshot};
}

// Keep browser data only for scopes that have not been cut over.
function apiRows(legacy, cache, now) {
  if (!cache?.size) return legacy;
  return [...legacy.filter(row => !cache.has(row.scope)), ...[...cache.values()].filter(row =>
    row && now >= row.observed && now - row.observed <= MAX_AGE)];
}

module.exports = {createAnalyticsApi, apiRows, readProperty, readAccount, HOUR, PROPERTIES};
