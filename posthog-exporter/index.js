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

// 앱별 전환 퍼널: "app:startEvent:convertEvent" (쉼표 구분). 전환율 = convert유저/start유저
// funnel 정의가 없는 앱은 전환 메트릭 미노출 → 대시보드 N/A
// virtue: 판정 시도(deed_judge_attempted) → 저장(deed_saved). add_flow_started는 배포본 미발생이라 제외.
function parseFunnels() {
  const map = {};
  (process.env.POSTHOG_FUNNELS || 'virtue:deed_judge_attempted:deed_saved').split(',').forEach((entry) => {
    const [app, start, convert] = entry.trim().split(':');
    if (app && start && convert) map[app] = { start, convert };
  });
  return map;
}
const funnels = parseFunnels();

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
const conversions = new client.Gauge({
  name: 'product_conversions',
  help: '핵심 전환 유저 수 (앱별 funnel의 convert 이벤트, 30일 distinct person)',
  labelNames: ['service'],
});
const conversionRate = new client.Gauge({
  name: 'product_conversion_rate',
  help: '전환율 % (convert 유저 / funnel start 유저 × 100, 30일)',
  labelNames: ['service'],
});
const retainedUsers = new client.Gauge({
  name: 'product_retained_users',
  help: '재방문 유저 (이전 7일 활성 중 최근 7일도 $pageview 발생)',
  labelNames: ['service'],
});
const retentionRate = new client.Gauge({
  name: 'product_retention_rate',
  help: '주간 재방문율 % (retained / 이전 7일 활성 × 100). 이탈율 = 100 − 이 값',
  labelNames: ['service'],
});
// --- 프로덕트 헬스 (L2) ---
const webVitalsLcp = new client.Gauge({
  name: 'product_web_vitals_lcp_ms',
  help: 'LCP p75 (ms, PostHog $web_vitals 30일). Google 기준: <2500 양호, >4000 불량',
  labelNames: ['service'],
});
const webVitalsInp = new client.Gauge({
  name: 'product_web_vitals_inp_ms',
  help: 'INP p75 (ms, FID 후속 지표). Google 기준: <200 양호, >500 불량',
  labelNames: ['service'],
});
const productErrors = new client.Gauge({
  name: 'product_errors',
  help: '프론트 에러 수 ($exception 7일)',
  labelNames: ['service'],
});
const productSessions = new client.Gauge({
  name: 'product_sessions',
  help: '세션 수 (7일 uniq $session_id). 서비스 정상 여부 지표',
  labelNames: ['service'],
});
register.registerMetric(appConnected);
register.registerMetric(activeUsers);
register.registerMetric(pageViews);
register.registerMetric(churnedUsers);
register.registerMetric(conversions);
register.registerMetric(conversionRate);
register.registerMetric(retainedUsers);
register.registerMetric(retentionRate);
register.registerMetric(webVitalsLcp);
register.registerMetric(webVitalsInp);
register.registerMetric(productErrors);
register.registerMetric(productSessions);

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
  // 리텐션 코호트: 이전 7일(7~14d) 활성 = 분모, 그중 최근 7일(0~7d)도 활성 = retained
  const prevActive = await hogql(projectId,
    "SELECT count(DISTINCT person_id) FROM events WHERE event = '$pageview' AND timestamp > now() - interval 14 day AND timestamp <= now() - interval 7 day");
  const retained = await hogql(projectId,
    "SELECT count(DISTINCT person_id) FROM events WHERE event = '$pageview' AND timestamp > now() - interval 14 day AND timestamp <= now() - interval 7 day AND person_id IN (SELECT DISTINCT person_id FROM events WHERE event = '$pageview' AND timestamp > now() - interval 7 day)");
  const prev = Number(prevActive?.[0]?.[0]) || 0;
  const ret = Number(retained?.[0]?.[0]) || 0;

  activeUsers.set({ ...svc, period: '1d' }, Number(dau?.[0]?.[0]) || 0);
  activeUsers.set({ ...svc, period: '7d' }, Number(wau?.[0]?.[0]) || 0);
  pageViews.set({ ...svc, period: '7d' }, Number(pv?.[0]?.[0]) || 0);
  // 이탈·재방문은 같은 코호트에서 일관 산출 (이탈 = 이전활성 − 재방문)
  retainedUsers.set(svc, ret);
  churnedUsers.set(svc, Math.max(0, prev - ret));
  retentionRate.set(svc, prev > 0 ? (ret / prev) * 100 : 0);

  // 프로덕트 헬스: web vitals(p75, 30일) · 프론트 에러 · 세션
  const lcp = await hogql(projectId,
    "SELECT round(quantile(0.75)(toFloat(properties['$web_vitals_LCP_value'])), 0) FROM events WHERE event = '$web_vitals' AND timestamp > now() - interval 30 day");
  const inp = await hogql(projectId,
    "SELECT round(quantile(0.75)(toFloat(properties['$web_vitals_INP_value'])), 0) FROM events WHERE event = '$web_vitals' AND timestamp > now() - interval 30 day");
  const errs = await hogql(projectId,
    "SELECT count() FROM events WHERE event = '$exception' AND timestamp > now() - interval 7 day");
  const sess = await hogql(projectId,
    "SELECT uniq(properties['$session_id']) FROM events WHERE timestamp > now() - interval 7 day");
  webVitalsLcp.set(svc, Number(lcp?.[0]?.[0]) || 0);
  webVitalsInp.set(svc, Number(inp?.[0]?.[0]) || 0);
  productErrors.set(svc, Number(errs?.[0]?.[0]) || 0);
  productSessions.set(svc, Number(sess?.[0]?.[0]) || 0);

  // 전환 퍼널 (앱별 정의가 있을 때만). 30일 distinct person 기준
  const f = funnels[name];
  if (f) {
    const starts = await hogql(projectId,
      `SELECT count(DISTINCT person_id) FROM events WHERE event = '${f.start}' AND timestamp > now() - interval 30 day`);
    const convs = await hogql(projectId,
      `SELECT count(DISTINCT person_id) FROM events WHERE event = '${f.convert}' AND timestamp > now() - interval 30 day`);
    const s = Number(starts?.[0]?.[0]) || 0;
    const c = Number(convs?.[0]?.[0]) || 0;
    conversions.set(svc, c);
    conversionRate.set(svc, s > 0 ? (c / s) * 100 : 0);
  }
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
