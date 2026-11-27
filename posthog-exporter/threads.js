const {readFile} = require('node:fs/promises');
const {Gauge} = require('prom-client');
const ACCOUNTS = ['minimal_collector', '_archivenoh'];
const METRICS = ['views', 'likes', 'replies', 'reposts', 'quotes'];
const DAY = 86400, MAX_AGE = 3 * 3600000;
const validCount = value => Number.isSafeInteger(value) && value >= 0;
async function request(url, token) {
  const response = await fetch(url, {headers: {Authorization: 'Bearer ' + token},
    redirect: 'error', signal: AbortSignal.timeout(20000)});
  if (!response.ok) throw Error('Threads HTTP ' + response.status);
  return response.json();
}
// Meta returns navigation to adjacent time ranges even when the requested range is complete.
function checkNextPage(next, until) {
  if (!next) return;
  const page = new URL(next);
  const params = page.searchParams;
  // Navigation links can use a different provider-side ID than /me.
  if (page.origin !== 'https://graph.threads.com' || !/^\/v1\.0\/\d+\/threads_insights$/.test(page.pathname) || params.has('after') || params.has('before') ||
      Number(params.get('since')) !== until + 1 || !(Number(params.get('until')) > until)) {
    throw Error('Incomplete Threads insights');
  }
}
async function readThreadsAccount(account, token, now, get = request) {
  if (!ACCOUNTS.includes(account)) throw Error('Unsupported Threads account');
  const base = 'https://graph.threads.com/v1.0/';
  const profile = await get(base + 'me?fields=id,username', token);
  if (profile.username !== account || !/^\d{5,30}$/.test(profile.id)) throw Error('Threads account mismatch');
  // Meta's documented day boundaries are not midnight UTC. Discover eight
  // consecutive completed boundaries; the oldest is the start of seven days.
  const endpoint = base + profile.id + '/threads_insights';
  const probe = new URLSearchParams({metric:'views', since:String(Math.floor(now/1000)-10*DAY), until:String(Math.floor(now/1000))});
  const daily = await get(endpoint + '?' + probe, token);
  checkNextPage(daily.paging?.next, Number(probe.get('until')));
  if (daily.data?.length !== 1 || daily.data[0].name !== 'views' || daily.data[0].period !== 'day' ||
      !Array.isArray(daily.data[0].values)) throw Error('Missing Threads day boundaries');
  const ends = daily.data[0].values.map(item => {
    const end = Date.parse(item.end_time);
    if (!Number.isFinite(end) || !validCount(item.value)) throw Error('Invalid Threads day');
    return end;
  }).filter(end => end <= now).sort((a,b)=>a-b).slice(-8);
  if (ends.length !== 8 || now - ends[7] > 2*DAY*1000 ||
      ends.slice(1).some((end,i) => ![23,24,25].includes((end-ends[i])/3600000)) ||
      Math.abs(ends[7]-ends[0]-7*DAY*1000) > 3600000) throw Error('Incomplete Threads days');
  const since = ends[0]/1000, until = ends[7]/1000;
  // The API includes both requested day labels, including for reaction totals.
  const params = new URLSearchParams({metric: METRICS.join(','), since: String(ends[1]/1000), until: String(until)});
  const response = await get(endpoint + '?' + params, token);
  checkNextPage(response.paging?.next, until);
  if (!Array.isArray(response.data) || response.data.length !== METRICS.length)
    throw Error('Incomplete Threads insights');
  const values = {};
  for (const metric of METRICS) {
    const rows = response.data.filter(row => row.name === metric);
    if (rows.length !== 1 || rows[0].period !== 'day') throw Error('Invalid Threads metric');
    const row = rows[0];
    if (metric === 'views' && row.values) {
      // Refuse sparse or misaligned day buckets instead of silently under-counting a week.
      if (!Array.isArray(row.values) || row.values.length !== 7) throw Error('Incomplete Threads days');
      const expected = new Set(ends.slice(1));
      let sum = 0;
      for (const item of row.values) {
        if (!validCount(item.value) || !expected.delete(Date.parse(item.end_time))) throw Error('Invalid Threads day');
        sum += item.value;
      }
      if (expected.size || !validCount(sum)) throw Error('Invalid Threads total');
      values[metric] = sum;
    } else {
      if (!validCount(row.total_value?.value)) throw Error('Missing Threads total');
      values[metric] = row.total_value.value;
    }
  }
  return {account, observedAt: new Date(now).toISOString(), periodStart: new Date(since*1000).toISOString(),
    periodEnd: new Date(until*1000).toISOString(), values};
}
async function readToken(account) {
  try { return (await readFile('/etc/analytics-threads/' + account, 'utf8')).trim(); }
  catch (err) { if (err.code === 'ENOENT') return null; throw err; }
}
function createThreads(registry, {clock = Date.now, readToken: read = readToken, readAccount = readThreadsAccount} = {}) {
  const rows = new Map(), configured = new Set();
  const fresh = account => {
    const row = rows.get(account), age = clock() - Date.parse(row?.observedAt);
    return row && age >= 0 && age <= MAX_AGE ? row : null;
  };
  const failures = new Gauge({name:'threads_account_consecutive_failures',help:'Consecutive failed Threads account refreshes',
    labelNames:['account'],registers:[registry]});
  new Gauge({name:'threads_account_connection',help:'Threads state: 0 missing credentials, 1 awaiting valid data, 2 fresh verified data',
    labelNames:['account'],registers:[registry],collect(){for(const account of ACCOUNTS)this.set({account},!configured.has(account)?0:fresh(account)?2:1)}});
  new Gauge({name:'threads_account_last_success_timestamp_seconds',help:'Last verified Threads observation',
    labelNames:['account'],registers:[registry],collect(){this.reset();for(const [account,row] of rows)this.set({account},Date.parse(row.observedAt)/1000)}});
  new Gauge({name:'threads_account_period_end_timestamp_seconds',help:'End of the seven completed source-day insight window',
    labelNames:['account'],registers:[registry],collect(){this.reset();for(const account of ACCOUNTS){const row=fresh(account);if(row)this.set({account},Date.parse(row.periodEnd)/1000)}}});
  new Gauge({name:'threads_account_discovery',help:'Official Threads profile views and reactions in seven completed source days',
    labelNames:['account','metric'],registers:[registry],collect(){this.reset();for(const account of ACCOUNTS){const row=fresh(account);if(row)for(const metric of METRICS)this.set({account,metric},row.values[metric])}}});
  let pending;
  function refresh() {
    if (!pending) pending = Promise.all(ACCOUNTS.map(async account => {
      try {
        const token = await read(account);
        if (!token) {configured.delete(account);rows.delete(account);failures.set({account},0);return;}
        configured.add(account);
        const row = await readAccount(account, token, clock());
        if (row.account !== account || !METRICS.every(metric => validCount(row.values?.[metric])) ||
            !Number.isFinite(Date.parse(row.observedAt))) throw Error('Invalid Threads snapshot');
        rows.set(account,row);failures.set({account},0);
      } catch {
        failures.inc({account});
        // Never include provider errors, request URLs or token content in logs.
        console.error('Threads insights unavailable for ' + account);
      }
    })).finally(()=>{pending=null});
    return pending;
  }
  return {refresh};
}
module.exports = {ACCOUNTS, METRICS, readThreadsAccount, createThreads};
