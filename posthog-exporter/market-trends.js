const fs = require('node:fs');
const groups = require('./market-trends-keywords.json');
const DAY = 86400000;

function completedWeeks(now) {
  const kst = new Date(now + 9 * 3600000);
  const today = Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate());
  const end = today - ((kst.getUTCDay() + 6) % 7 + 1) * DAY;
  const date = value => new Date(value).toISOString().slice(0, 10);
  return {startDate: date(end - 363 * DAY), endDate: date(end)};
}

function toSnapshot(raw, now) {
  const period = completedWeeks(now);
  const invalid = () => {throw Error('Invalid Naver search trend response');};
  if (raw?.startDate !== period.startDate || raw.endDate !== period.endDate ||
      raw.timeUnit !== 'week' || !Array.isArray(raw.results) || raw.results.length !== groups.length) invalid();
  const names = groups.map(group => group.groupName);
  const rows = Array.from({length: 52}, (_, index) => ({
    time: new Date(Date.parse(period.startDate) + index * 7 * DAY).toISOString().slice(0, 10) + 'T00:00:00+09:00',
    ...Object.fromEntries(names.map(name => [name, null])),
  }));
  const byDate = new Map(rows.map(row => [row.time.slice(0, 10), row]));
  const seenGroups = new Set();
  for (const result of raw.results) {
    if (!names.includes(result.title) || seenGroups.has(result.title) || !Array.isArray(result.data)) invalid();
    seenGroups.add(result.title);
    const seenDates = new Set();
    for (const point of result.data) {
      if (!byDate.has(point.period) || seenDates.has(point.period) ||
          typeof point.ratio !== 'number' || !Number.isFinite(point.ratio) || point.ratio < 0 || point.ratio > 100) invalid();
      seenDates.add(point.period);
      byDate.get(point.period)[result.title] = point.ratio;
    }
  }
  return {source: 'Naver DataLab', sourceUrl: 'https://datalab.naver.com/keyword/trendSearch.naver',
    observedAt: new Date(now).toISOString(), ...period, timeUnit: 'week',
    normalization: 'Shared maximum across requested keywords and period = 100', groups, rows};
}

function readCredentials() {
  return {
    id: fs.readFileSync('/etc/market-trends/client-id', 'utf8').trim(),
    secret: fs.readFileSync('/etc/market-trends/client-secret', 'utf8').trim(),
  };
}

function createMarketTrends({clock = Date.now, fetchImpl = fetch, readCredentials: credentials = readCredentials} = {}) {
  let snapshot = null, lastSuccessAt = 0, lastAttemptAt = null, failed = false;
  return {
    get current() {return snapshot && clock() - lastSuccessAt <= 3 * DAY ? snapshot : null;},
    get lastSuccessAt() {return lastSuccessAt;},
    get failed() {return failed;},
    async refresh() {
      const now = clock();
      if (lastAttemptAt !== null && now - lastAttemptAt < (failed ? DAY / 4 : DAY)) return !failed;
      lastAttemptAt = now;
      try {
        const {id, secret} = credentials();
        if (!id || !secret) throw Error('Missing Naver credentials');
        const response = await fetchImpl('https://openapi.naver.com/v1/datalab/search', {
          method: 'POST', signal: AbortSignal.timeout(20000),
          headers: {'Content-Type': 'application/json', 'X-Naver-Client-Id': id, 'X-Naver-Client-Secret': secret},
          body: JSON.stringify({...completedWeeks(now), timeUnit: 'week', keywordGroups: groups}),
        });
        if (!response.ok) throw Error('Naver search trend request failed');
        const next = toSnapshot(await response.json(), now);
        snapshot = next;
        lastSuccessAt = now;
        failed = false;
        return true;
      } catch {
        // Never log response bodies, credentials or request headers.
        failed = true;
        return false;
      }
    },
  };
}

module.exports = {completedWeeks, toSnapshot, createMarketTrends};
