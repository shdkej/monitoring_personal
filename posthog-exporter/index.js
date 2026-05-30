const express = require('express');
const client = require('prom-client');

// ============================================
// 설정
// ============================================
// PostHog Cloud(US) Query API를 폴링해 제품 지표를 Prometheus 메트릭으로 노출하는 얇은 브리지.
// 계산은 PostHog에 위임하고, 여기서는 결과 숫자만 가져온다 (설계 D3).

const PORT = process.env.PORT || 9101;
const POSTHOG_HOST = process.env.POSTHOG_HOST || 'https://us.posthog.com';
const TOKEN = process.env.POSTHOG_ACCESS_TOKEN;
const FETCH_INTERVAL = Number(process.env.FETCH_INTERVAL_MS) || 5 * 60 * 1000; // 5분

// 연동된 앱 → PostHog 프로젝트ID 매핑. 예: "virtue:424014,blog:111"
function parseProjects() {
  const map = {};
  (process.env.POSTHOG_PROJECTS || 'virtue:424014').split(',').forEach((entry) => {
    const [name, pid] = entry.trim().split(':');
    if (name && pid) map[name] = pid;
  });
  return map;
}
const projects = parseProjects();

// 대시보드에 표시할 전체 앱 목록. 연동 안 된 앱은 N/A로 노출(connected=0).
const allApps = (process.env.PRODUCT_APPS || 'virtue,blog,afzma')
  .split(',').map((s) => s.trim()).filter(Boolean);

if (!TOKEN) {
  console.error('POSTHOG_ACCESS_TOKEN 환경변수가 필요합니다');
  process.exit(1);
}

// ============================================
// Prometheus Registry & 메트릭
// ============================================

const register = new client.Registry();

const appConnected = new client.Gauge({
  name: 'product_app_connected',
  help: '앱이 PostHog에 연동됐는지 (1=연동, 0=미연동→대시보드 N/A)',
  labelNames: ['service'],
});
const activeUsers = new client.Gauge({
  name: 'product_active_users',
  help: '활성 유저 ($pageview 기준 distinct person)',
  labelNames: ['service', 'period'],
});
const pageViews = new client.Gauge({
  name: 'product_page_views',
  help: '페이지뷰 수',
  labelNames: ['service', 'period'],
});
const churnedUsers = new client.Gauge({
  name: 'product_churned_users',
  help: '이탈 유저 (이전 7일 활성 중 최근 7일 $pageview 미발생). PostHog person 코호트 기반 (추정 아님)',
  labelNames: ['service'],
});
const productClicks = new client.Gauge({
  name: 'product_clicks',
  help: 'autocapture 클릭 수 (CTR 분자). 명시적 CTA 아닌 전체 인터랙션 클릭',
  labelNames: ['service', 'period'],
});
register.registerMetric(appConnected);
register.registerMetric(activeUsers);
register.registerMetric(pageViews);
register.registerMetric(churnedUsers);
register.registerMetric(productClicks);

// TODO(트랙 A 2차): product_retention (재방문율) 추가

// ============================================
// PostHog Query API (HogQL)
// ============================================

async function hogql(projectId, query) {
  const res = await fetch(`${POSTHOG_HOST}/api/projects/${projectId}/query/`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query } }),
  });
  if (!res.ok) {
    throw new Error(`PostHog ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = await res.json();
  return data.results; // [[value], ...]
}

async function fetchApp(name, projectId) {
  const svc = { service: name };
  const dau = await hogql(projectId,
    "SELECT count(DISTINCT person_id) FROM events WHERE event = '$pageview' AND timestamp > now() - interval 1 day");
  const wau = await hogql(projectId,
    "SELECT count(DISTINCT person_id) FROM events WHERE event = '$pageview' AND timestamp > now() - interval 7 day");
  const pv = await hogql(projectId,
    "SELECT count() FROM events WHERE event = '$pageview' AND timestamp > now() - interval 7 day");
  // 이탈: 이전 7일(7~14d) 활성 중 최근 7일(0~7d) 미방문 person 수
  const churned = await hogql(projectId,
    "SELECT count(DISTINCT person_id) FROM events WHERE event = '$pageview' AND timestamp > now() - interval 14 day AND timestamp <= now() - interval 7 day AND person_id NOT IN (SELECT DISTINCT person_id FROM events WHERE event = '$pageview' AND timestamp > now() - interval 7 day)");
  // CTR 분자: autocapture 클릭 수 (7일)
  const clicks = await hogql(projectId,
    "SELECT count() FROM events WHERE event = '$autocapture' AND timestamp > now() - interval 7 day");

  activeUsers.set({ ...svc, period: '1d' }, Number(dau?.[0]?.[0]) || 0);
  activeUsers.set({ ...svc, period: '7d' }, Number(wau?.[0]?.[0]) || 0);
  pageViews.set({ ...svc, period: '7d' }, Number(pv?.[0]?.[0]) || 0);
  churnedUsers.set(svc, Number(churned?.[0]?.[0]) || 0);
  productClicks.set({ ...svc, period: '7d' }, Number(clicks?.[0]?.[0]) || 0);
}

async function fetchAll() {
  for (const app of allApps) {
    const pid = projects[app];
    if (!pid) {
      appConnected.set({ service: app }, 0); // 미연동 → 값 메트릭 없음 → Grafana N/A
      continue;
    }
    appConnected.set({ service: app }, 1);
    try {
      await fetchApp(app, pid);
      console.log(`[${new Date().toISOString()}] ${app}(${pid}) 수집 완료`);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] ${app} 수집 실패:`, err.message);
    }
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
app.get('/health', (req, res) => {
  res.json({ status: 'ok', host: POSTHOG_HOST, projects, allApps });
});

// 첫 폴링을 끝낸 뒤 서빙 시작 (초기 데이터 보장). 실패해도 서버는 띄운다.
async function start() {
  try {
    await fetchAll();
  } catch (err) {
    console.error('초기 수집 실패:', err.message);
  }
  setInterval(fetchAll, FETCH_INTERVAL);
  app.listen(PORT, () => {
    console.log(`posthog-exporter on port ${PORT}`);
    console.log(`연동 앱: ${Object.entries(projects).map(([k, v]) => `${k}:${v}`).join(', ') || '(없음)'}`);
    console.log(`전체 앱: ${allApps.join(', ')}`);
  });
}
start();
