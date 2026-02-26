const express = require('express');
const client = require('prom-client');
const { BetaAnalyticsDataClient } = require('@google-analytics/data');

const app = express();
const port = 9999;

// ============================================
// 설정
// ============================================

const GA4_KEY_FILE = process.env.GA4_KEY_FILE || '/app/credentials.json';
const FETCH_INTERVAL = 5 * 60 * 1000; // 5분

// 멀티 속성 파싱: GA4_PROPERTIES=blog:252603434,portfolio:987654321
// 하위 호환: GA4_PROPERTY_ID만 있으면 default:ID로 변환
function parseProperties() {
  const raw = process.env.GA4_PROPERTIES;
  if (raw) {
    return raw.split(',').map((entry) => {
      const [name, propertyId] = entry.trim().split(':');
      return { name, propertyId };
    });
  }
  const legacyId = process.env.GA4_PROPERTY_ID;
  if (legacyId) {
    return [{ name: 'default', propertyId: legacyId }];
  }
  console.error('GA4_PROPERTIES 또는 GA4_PROPERTY_ID 환경변수가 필요합니다');
  process.exit(1);
}

const ga4Properties = parseProperties();

const analyticsClient = new BetaAnalyticsDataClient({
  keyFilename: GA4_KEY_FILE,
});

// ============================================
// Prometheus Registry & 메트릭 정의
// ============================================

const register = new client.Registry();
client.collectDefaultMetrics({ register });

// --- 프로덕트 메트릭 (mock 로직 유지) ---

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
});
register.registerMetric(httpRequestDuration);

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status'],
});
register.registerMetric(httpRequestsTotal);

const frontendErrorTotal = new client.Counter({
  name: 'frontend_error_total',
  help: 'Frontend errors by type',
  labelNames: ['type'],
});
register.registerMetric(frontendErrorTotal);

const webVitalsLcp = new client.Gauge({
  name: 'web_vitals_lcp_seconds',
  help: 'Largest Contentful Paint in seconds',
});
register.registerMetric(webVitalsLcp);

const webVitalsFid = new client.Gauge({
  name: 'web_vitals_fid_seconds',
  help: 'First Input Delay in seconds',
});
register.registerMetric(webVitalsFid);

const webVitalsCls = new client.Gauge({
  name: 'web_vitals_cls',
  help: 'Cumulative Layout Shift',
});
register.registerMetric(webVitalsCls);

// --- 비즈니스 메트릭 (GA4에서 수집, service 레이블 포함) ---

const businessDau = new client.Gauge({
  name: 'business_dau',
  help: 'Daily Active Users',
  labelNames: ['service'],
});
register.registerMetric(businessDau);

const businessMau = new client.Gauge({
  name: 'business_mau',
  help: 'Monthly Active Users',
  labelNames: ['service'],
});
register.registerMetric(businessMau);

const businessNewUsers = new client.Gauge({
  name: 'business_new_users_total',
  help: 'New users (from GA4)',
  labelNames: ['service'],
});
register.registerMetric(businessNewUsers);

const businessChurnedUsers = new client.Gauge({
  name: 'business_churned_users_total',
  help: 'Churned users estimated: previousMAU + newUsers30d - currentMAU',
  labelNames: ['service'],
});
register.registerMetric(businessChurnedUsers);

const businessPreviousMau = new client.Gauge({
  name: 'business_previous_mau',
  help: 'Previous period Monthly Active Users (31-60 days ago)',
  labelNames: ['service'],
});
register.registerMetric(businessPreviousMau);

const businessSessions = new client.Gauge({
  name: 'business_sessions_total',
  help: 'Total sessions (from GA4)',
  labelNames: ['service'],
});
register.registerMetric(businessSessions);

const businessSessionDuration = new client.Gauge({
  name: 'business_session_duration_seconds',
  help: 'Average session duration in seconds',
  labelNames: ['service'],
});
register.registerMetric(businessSessionDuration);

const businessPageViews = new client.Gauge({
  name: 'business_page_views_total',
  help: 'Total page views (from GA4)',
  labelNames: ['service'],
});
register.registerMetric(businessPageViews);

const businessCtaClicks = new client.Gauge({
  name: 'business_cta_clicks_total',
  help: 'CTA clicks (from GA4)',
  labelNames: ['service'],
});
register.registerMetric(businessCtaClicks);

const businessFunnelStep = new client.Gauge({
  name: 'business_funnel_step',
  help: 'Users at each funnel step',
  labelNames: ['service', 'step'],
});
register.registerMetric(businessFunnelStep);

const businessTrafficSource = new client.Gauge({
  name: 'business_traffic_source',
  help: 'Traffic by source',
  labelNames: ['service', 'source'],
});
register.registerMetric(businessTrafficSource);

// ============================================
// 프로덕트 메트릭 업데이트 (mock 로직)
// ============================================

function randomInRange(min, max) {
  return Math.random() * (max - min) + min;
}

function randomInt(min, max) {
  return Math.floor(randomInRange(min, max + 1));
}

function getTrafficMultiplier() {
  const hour = new Date().getHours();
  if (hour >= 9 && hour <= 21) {
    return 1.0 + Math.sin(((hour - 9) * Math.PI) / 12) * 0.5;
  } else if (hour >= 0 && hour <= 6) {
    return 0.3;
  }
  return 0.7;
}

function updateProductMetrics() {
  const multiplier = getTrafficMultiplier();

  const routes = ['/api/users', '/api/products', '/api/orders', '/api/auth', '/api/search'];
  const statuses = ['200', '200', '200', '200', '201', '400', '404', '500'];

  routes.forEach((route) => {
    const count = Math.floor(randomInRange(5, 30) * multiplier);
    for (let i = 0; i < count; i++) {
      const status = statuses[randomInt(0, statuses.length - 1)];
      const duration = status === '200' ? randomInRange(0.01, 0.5) : randomInRange(0.1, 2);
      httpRequestDuration.observe({ method: 'GET', route, status }, duration);
      httpRequestsTotal.inc({ method: 'GET', route, status });
    }
  });

  const errorTypes = ['js_error', 'network_error', 'render_error', 'timeout'];
  errorTypes.forEach((type) => {
    if (Math.random() < 0.3) {
      frontendErrorTotal.inc({ type }, randomInt(1, 5));
    }
  });

  webVitalsLcp.set(randomInRange(1.5, 4.0));
  webVitalsFid.set(randomInRange(0.05, 0.3));
  webVitalsCls.set(randomInRange(0.05, 0.2));
}

// ============================================
// GA4 비즈니스 메트릭 수집 (멀티 속성)
// ============================================

async function fetchGA4MetricsForProperty({ name, propertyId }) {
  const property = `properties/${propertyId}`;
  const svc = { service: name };

  try {
    const [response] = await analyticsClient.batchRunReports({
      property,
      requests: [
        // Report 0: DAU (오늘)
        {
          dateRanges: [{ startDate: 'today', endDate: 'today' }],
          metrics: [
            { name: 'activeUsers' },
            { name: 'newUsers' },
            { name: 'sessions' },
            { name: 'averageSessionDuration' },
            { name: 'screenPageViews' },
          ],
        },
        // Report 1: MAU (현재 30일 + 이전 31~60일, 이탈 유저 계산용)
        {
          dateRanges: [
            { startDate: '30daysAgo', endDate: 'today' },
            { startDate: '60daysAgo', endDate: '31daysAgo' },
          ],
          metrics: [
            { name: 'activeUsers' },
            { name: 'newUsers' },
          ],
        },
        // Report 2: 아웃바운드 클릭 (향상된 측정의 click 이벤트)
        {
          dateRanges: [{ startDate: 'today', endDate: 'today' }],
          dimensions: [{ name: 'eventName' }],
          metrics: [{ name: 'eventCount' }],
          dimensionFilter: {
            filter: {
              fieldName: 'eventName',
              stringFilter: { value: 'click' },
            },
          },
        },
        // Report 3: 블로그 참여 퍼널 (page_view → scroll → click)
        {
          dateRanges: [{ startDate: 'today', endDate: 'today' }],
          dimensions: [{ name: 'eventName' }],
          metrics: [{ name: 'eventCount' }],
          dimensionFilter: {
            filter: {
              fieldName: 'eventName',
              inListFilter: {
                values: ['page_view', 'scroll', 'click'],
              },
            },
          },
        },
        // Report 4: 트래픽 채널별 사용자 (sessionDefaultChannelGroup)
        {
          dateRanges: [{ startDate: 'today', endDate: 'today' }],
          dimensions: [{ name: 'sessionDefaultChannelGroup' }],
          metrics: [{ name: 'activeUsers' }],
          orderBys: [{ metric: { metricName: 'activeUsers' }, desc: true }],
          limit: 10,
        },
      ],
    });

    const reports = response.reports;

    // Report 0: 기본 메트릭
    const basicRow = reports[0].rows?.[0];
    if (basicRow) {
      const values = basicRow.metricValues;
      businessDau.set(svc, Number(values[0].value) || 0);
      businessNewUsers.set(svc, Number(values[1].value) || 0);
      businessSessions.set(svc, Number(values[2].value) || 0);
      businessSessionDuration.set(svc, Number(values[3].value) || 0);
      businessPageViews.set(svc, Number(values[4].value) || 0);
    }

    // Report 1: MAU (현재 + 이전 기간) & 이탈 유저 계산
    // 2개 dateRange × 2개 metric = 4개 metricValues
    // [0] activeUsers (현재 30일), [1] newUsers (현재 30일)
    // [2] activeUsers (이전 31~60일), [3] newUsers (이전 31~60일)
    const mauRow = reports[1].rows?.[0];
    let currentMau = 0;
    let previousMau = 0;
    let newUsers30d = 0;
    if (mauRow) {
      currentMau = Number(mauRow.metricValues[0].value) || 0;
      newUsers30d = Number(mauRow.metricValues[1].value) || 0;
      previousMau = Number(mauRow.metricValues[2].value) || 0;
      businessMau.set(svc, currentMau);
      businessPreviousMau.set(svc, previousMau);
    }

    // Report 2: CTA 클릭
    const ctaRow = reports[2].rows?.[0];
    businessCtaClicks.set(svc, ctaRow ? Number(ctaRow.metricValues[0].value) : 0);

    // Report 3: 블로그 참여 퍼널 (page_view → scroll → click)
    const funnelMap = { page_view: 'view', scroll: 'engage', click: 'click' };
    Object.values(funnelMap).forEach((step) => businessFunnelStep.set({ ...svc, step }, 0));
    if (reports[3].rows) {
      reports[3].rows.forEach((row) => {
        const eventName = row.dimensionValues[0].value;
        const step = funnelMap[eventName];
        if (step) {
          businessFunnelStep.set({ ...svc, step }, Number(row.metricValues[0].value) || 0);
        }
      });
    }

    // Report 4: 트래픽 채널 (sessionDefaultChannelGroup → 소문자 라벨)
    const channelMap = {
      'Direct': 'direct',
      'Organic Search': 'organic',
      'Organic Social': 'social',
      'Referral': 'referral',
      'Paid Search': 'paid',
      'Paid Social': 'paid',
      'Email': 'email',
      'Unassigned': 'unassigned',
    };
    if (reports[4].rows) {
      reports[4].rows.forEach((row) => {
        const channel = row.dimensionValues[0].value || 'Unassigned';
        const source = channelMap[channel] || channel.toLowerCase();
        businessTrafficSource.set({ ...svc, source }, Number(row.metricValues[0].value) || 0);
      });
    }

    // 이탈 유저 계산: 이전 기간에 있었지만 현재 기간에 없는 유저 추정
    // churn ≈ previousMAU + newUsers30d - currentMAU
    // 음수 방지 (유저가 급증한 경우)
    const estimatedChurn = Math.max(0, previousMau + newUsers30d - currentMau);
    businessChurnedUsers.set(svc, estimatedChurn);

    console.log(`[${new Date().toISOString()}] GA4 메트릭 수집 완료: ${name} (${propertyId})`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] GA4 메트릭 수집 실패 [${name}]:`, err.message);
  }
}

async function fetchGA4Metrics() {
  for (const prop of ga4Properties) {
    await fetchGA4MetricsForProperty(prop);
  }
}

// ============================================
// 초기화 및 스케줄링
// ============================================

// 프로덕트 메트릭: 10초마다
updateProductMetrics();
setInterval(updateProductMetrics, 10000);

// GA4 비즈니스 메트릭: 즉시 + 5분마다
fetchGA4Metrics();
setInterval(fetchGA4Metrics, FETCH_INTERVAL);

// ============================================
// HTTP 서버
// ============================================

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    properties: ga4Properties.map((p) => ({ name: p.name, propertyId: p.propertyId })),
  });
});

app.listen(port, () => {
  console.log(`GA4 Exporter running on port ${port}`);
  console.log(`Properties: ${ga4Properties.map((p) => `${p.name}:${p.propertyId}`).join(', ')}`);
  console.log(`Metrics: http://localhost:${port}/metrics`);
});
