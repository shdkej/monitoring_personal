const express = require('express');
const {registerGA4} = require('./ga4');
const {createAnalyticsApi, HOUR} = require('./analytics-api');
const {projectMetrics, registerActivity} = require('./project-metrics');
const {firstVisitMetrics} = require('./first-visit');
const client = require('prom-client');
const {collectSnapshot, createSnapshotCache} = require('./calendar');

// ============================================
// 설정
// ============================================
// PostHog Cloud(US) Query API를 폴링해 제품 지표를 Prometheus 메트릭으로 노출하는 얇은 브리지.
// 계산은 PostHog에 위임하고, 여기서는 결과 숫자만 가져온다 (설계 D3).

const PORT = process.env.PORT || 9101;
const POSTHOG_HOST = process.env.POSTHOG_HOST || 'https://us.posthog.com';
const TOKEN = process.env.POSTHOG_ACCESS_TOKEN;
const FETCH_INTERVAL = Number(process.env.FETCH_INTERVAL_MS) || 5 * 60 * 1000; // 5분

if (!TOKEN) {
  console.error('POSTHOG_ACCESS_TOKEN 환경변수가 필요합니다');
  process.exit(1);
}

// ============================================
// Prometheus Registry & 메트릭
// ============================================

const register = new client.Registry();

async function hogql(projectId, query) {
  const res = await fetch(`${POSTHOG_HOST}/api/projects/${projectId}/query/`, {
    method: 'POST',
    signal: AbortSignal.timeout(60000),
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }),
  });
  if (!res.ok) {
    throw new Error(`PostHog HTTP ${res.status}`);
  }
  const data = await res.json();
  return data.results; // [[value], ...]
}

const privateProjects = projectMetrics(POSTHOG_HOST, TOKEN, hogql);
registerActivity(client, register, privateProjects);
// Only the previously approved app list is served by the Space publication endpoint.
const calendar = createSnapshotCache(() => collectSnapshot(hogql));
new client.Gauge({
  name: 'posthog_app_calendar_count',
  help: 'Received events, pageviews, identified sessions and events with a session ID per app and completed period',
  labelNames: ['scope', 'period', 'period_start', 'period_end', 'metric'],
  registers: [register],
  collect() {
    this.reset();
    for (const row of privateProjects.fresh.flatMap(p => p.calendar.rows)) {
      for (const [period, samples] of Object.entries({...row.periods, rolling7d: [row]})) {
        for (const sample of samples) {
          const labels = {scope: row.scope, period, period_start: sample.periodStart, period_end: sample.periodEnd};
          for (const [metric, count] of Object.entries({...sample.values, eventsWithSessionId: sample.eventsWithSessionId})) {
            this.set({...labels, metric}, count);
          }
        }
      }
    }
  },
});
new client.Gauge({
  name: 'posthog_app_calendar_observed_timestamp_seconds',
  help: 'Source observation time of the last complete PostHog app calendar snapshot',
  registers: [register],
  collect() {
    const times = privateProjects.fresh.map(p => Date.parse(p.calendar.observedAt) / 1000);
    this.set(times.length ? Math.min(...times) : 0);
  },
});


new client.Gauge({
  name: 'posthog_app_health',
  help: 'Per-app rolling churn, retention, errors and web vitals from PostHog',
  labelNames: ['scope', 'metric'], registers: [register],
  collect() {
    this.reset();
    for (const {scope, values} of privateProjects.fresh.flatMap(p => p.health.rows)) {
      for (const [metric, value] of Object.entries(values)) this.set({scope, metric}, value);
    }
  },
});

const firstVisits = createSnapshotCache(async () => {
  const observedAt = Date.now();
  return {observedAt, metrics: await firstVisitMetrics(hogql, Math.floor(observedAt / 1000))};
});
new client.Gauge({
  name: 'posthog_app_first_visits',
  help: 'Seven-day new measured browser cohort, first-session activation and share referrals',
  labelNames: ['scope', 'metric'], registers: [register],
  collect() {
    this.reset();
    const snapshot = firstVisits.current;
    if (!snapshot || Date.now() - snapshot.observedAt > 45 * 60 * 1000) return;
    for (const [scope, metrics] of snapshot.metrics) {
      for (const [metric, n] of Object.entries(metrics)) this.set({scope, metric}, n);
    }
    for (const scope of ['policycock', 'Virtue']) {
      if (!snapshot.metrics.has(scope)) this.set({scope, metric: 'shareNewVisitors7d'}, 0);
    }
  },
});

async function refreshCalendar() {
  if (calendar.current && Date.now() - Date.parse(calendar.current.observedAt) < 15 * 60 * 1000) return;
  try {
    await calendar.refresh();
  } catch (err) {
    console.error('PostHog 앱별 달력 집계 실패:', err.message);
  }
}

// ============================================
// HTTP 서버
// ============================================

const app = express();
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});
app.get('/analytics-posthog.json', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!calendar.current) return res.status(503).json({error: 'Awaiting PostHog aggregates'});
  res.json(calendar.current);
});
app.get('/health', (req, res) => {
  res.json({ status: 'ok', host: POSTHOG_HOST, projects: privateProjects.projects, allApps: privateProjects.fresh.flatMap(p => p.health.rows.map(r => r.scope)) });
});

// 첫 폴링을 끝낸 뒤 서빙 시작 (초기 데이터 보장). 실패해도 서버는 띄운다.
async function start() {
  const analyticsApi = createAnalyticsApi(register);
  const refreshApi = () => analyticsApi.refresh().catch(() => console.error('Analytics API refresh failed'));
  void refreshApi();
  setInterval(refreshApi, HOUR);
  const collectGA4 = registerGA4(register, {api: analyticsApi});
  const refreshGA4 = () => collectGA4().catch(err => console.error('GA4 피드 수집 실패:', err.message));
  const refreshHealth = () => privateProjects.refresh().catch(err => console.error('PostHog 앱 품질 수집 실패:', err.message));
  const refreshFirstVisits = () => firstVisits.refresh().catch(err => console.error('PostHog 첫 방문 수집 실패:', err.message));
  void refreshFirstVisits();
  setInterval(refreshFirstVisits, 15 * 60 * 1000);
  void refreshHealth();
  setInterval(refreshHealth, 15 * 60 * 1000);
  void refreshGA4();
  setInterval(refreshGA4, 15 * 60 * 1000);
  void refreshCalendar();
  setInterval(refreshCalendar, Math.min(FETCH_INTERVAL, 5 * 60 * 1000));
  app.listen(PORT, () => {
    console.log(`posthog-exporter on port ${PORT}`);
  });
}
start();
