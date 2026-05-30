# 비즈니스 레이어 모니터링 설계

> 상태: 설계 (구현 전) · 최종 수정 2026-05-30

## 1. 배경

비즈니스/제품 지표를 모니터링에 통합하려 한다. 요청 지표는 신규 유저, 이탈 유저,
CTA 클릭율/CTR, 퍼널 drop-off, 캠페인별 전환, 수익, CS 건수.

기존 상태는 두 경로가 어정쩡하게 공존했다.
- 비즈니스 대시보드(`layer-business.json`)는 GA4 플러그인을 직접 쿼리한다.
- `ga4-exporter`(자작 Node.js 앱)는 GA4 API에서 `business_*` 메트릭을 계산해 Prometheus로
  내보내지만, 로컬 docker-compose에만 있고 운영 k8s에는 배포되지 않았다. 대시보드도 이 메트릭을
  쓰지 않는다.

여기에 PostHog를 도입한다.

## 2. 도구별 담당 (관점 분리)

| 도구 | 담당 | 다루는 질문 |
|------|------|-------------|
| **GA4** | 유입 | 누가, 어디서, 어떤 채널/캠페인으로 들어왔나 |
| **PostHog** | 제품 내 사용 과정 | 들어와서 무엇을 했나 — 퍼널, 이탈(retention), CTA, 전환, 수익 |
| Prometheus/Loki/CloudWatch | 인프라/시스템 | 가용성, 성능, 비용 |

GA4와 PostHog는 측정 대상이 다르므로 경쟁이 아니라 분업이다. GA4는 가볍게 유지한다.

## 3. 핵심 결정

### D1. 시각화는 Grafana 단일 통합
모든 레이어를 Grafana 한 화면에서 본다. 비즈니스도 예외 없음.

### D2. exporter는 하나 — PostHog exporter. ga4-exporter 폐기
- GA4 유입 지표는 **GA4 플러그인 직접 연동**으로 이미 Grafana에서 본다 → GA4용 exporter 불필요.
- PostHog 제품 지표만 Grafana로 올리려면 **PostHog → Prometheus 브리지**가 필요하다.
- 따라서 단일 exporter는 PostHog exporter이며, `ga4-exporter`는 GA4 플러그인과 역할이 겹쳐
  폐기한다.
- 트레이드오프: GA4 지표에 Prometheus 기반 알림을 걸 수단이 사라진다. GA4는 "가볍게"가
  원칙이고 유입 알림 수요가 낮아 수용한다. 필요해지면 그때 최소 범위로 되살린다.

### D3. PostHog 브리지는 "얇게" 유지
계산(퍼널·retention·전환·수익)은 PostHog 안에서 정의(인사이트/HogQL)하고, exporter는 그
**결과 KPI 숫자만 폴링해 Prometheus 메트릭으로 노출**한다. exporter 코드 안에서 churn 추정식
같은 자체 계산을 다시 만들지 않는다. (ga4-exporter가 했던 실수를 반복하지 않는다.)

### D4. PostHog는 Cloud(US) — Query API 폴링
ClickHouse 직접 접근이 불가하므로 브리지는 PostHog **Query API(HogQL)** 를 Personal API Key로
폴링한다.
- 엔드포인트: `POST https://us.posthog.com/api/projects/{project_id}/query/`
- PostHog는 프로젝트 단위. 앱 → 프로젝트ID 매핑을 설정으로 받는다.
  현재 `virtue` 프로젝트만 존재하고 blog/afzma는 미생성.

### D5. 앱별 표시 + 미연동 앱은 N/A
대시보드는 앱별 섹션(virtue/blog/afzma)을 동일 구조로 깔고, PostHog 미연동 앱도 빈칸이 아니라
**N/A로 명시**한다.
- exporter: 연동된 앱(virtue)만 실제 값을 노출. 미연동 앱은 메트릭이 비거나, 명시적
  `product_app_connected{service="blog"} 0` 표식을 함께 노출.
- Grafana: stat 패널의 **No value 옵션을 "N/A"** 로 설정 → 데이터 없는 앱은 "No data" 대신 N/A.
  (추이/timeseries는 N/A 표현이 어색하므로 미연동 앱은 stat 위주로 둔다.)
- 앱을 PostHog에 새로 등록하면 exporter 설정에 프로젝트ID만 추가하면 값이 채워진다.

## 4. 목표 아키텍처

```
GA4 ──────(GA4 플러그인 직접)──────────────────────┐
                                                    │
PostHog ──(posthog-exporter: 얇은 브리지)──> Prometheus ─┼──> Grafana (단일 뷰)
                                                    │
인프라 ── Prometheus · Loki · CloudWatch ───────────┘
```

- exporter 1개 = `posthog-exporter`
- `ga4-exporter` 디렉토리/배포/scrape job 제거

## 5. 지표 배치

| 지표 | 출처 | 비고 |
|------|------|------|
| 신규 유저 / DAU / MAU / 세션 | GA4 플러그인 | 유입 (기존 패널 유지) |
| 채널·캠페인 **유입** | GA4 플러그인 | 유입 관점 |
| 퍼널 drop-off | PostHog | 제품 사용 과정 |
| 이탈 (retention) | PostHog | 코호트 기반, 추정식 아님 |
| CTA 클릭율 / CTR | PostHog | autocapture 이벤트 |
| 캠페인별 **전환** | PostHog | 들어와서 전환했나 |
| 수익 | PostHog (revenue) | 소스 확정 필요 → 미결 |
| CS 건수 | (외부) | 이번 범위 제외 |

## 6. 마이그레이션

1. 방금 추가한 하이브리드 패널 정리
   - 퍼널·캠페인(GA4 플러그인): 유입 관점으로 유지하거나 PostHog 전환 시 재배치
   - 이탈·CTR(ga4-exporter 의존): PostHog 브리지로 대체. ga4-exporter 폐기 시 이 패널은
     PostHog 출처로 교체해야 함 (그 전까지는 로컬에서만 의미)
2. `posthog-exporter` PoC: PostHog Query API에서 KPI 1~2개를 메트릭으로 노출
3. Grafana 비즈니스 레이어를 GA4(유입) + PostHog(제품) 두 출처로 재구성
4. `posthog-exporter`를 운영 k8s(space 레포)에 배포, prometheus scrape 추가
5. `ga4-exporter` 폐기 (디렉토리/compose/scrape 제거)

## 7. 확정 사항 / 미결

확정:
- PostHog = Cloud, US 리전 → Query API(HogQL) 폴링 (D4)
- 등록된 앱 = `virtue` 하나. blog/afzma는 미연동 → N/A 표시 (D5)
- GA4 + PostHog는 한 대시보드에서 패널별 데이터소스로 공존 (이미 검증된 방식)

미결 (다음 결정):
- **virtue에 이벤트 수집이 실제로 시작됐나** — pageview·CTA click 등 어떤 이벤트가 들어오는지
  (브리지가 가져올 KPI를 정하려면 필요)
- 수익 데이터 소스 (PostHog revenue 이벤트 vs 결제사 API/DB)
- 메트릭 네이밍 컨벤션 (`product_*` 또는 `ph_*`)
- PoC로 가장 먼저 가져올 KPI 1~2개 (예: virtue 핵심 퍼널의 전환율)

## 변경 이력

- 2026-05-30: 최초 작성. exporter 단일화(PostHog), ga4-exporter 폐기 방향 확정.
- 2026-05-30: PostHog Cloud(US) 확정 → Query API 브리지(D4). 앱별 N/A 표시 설계(D5).
  등록 앱 virtue 1개. GA4+PostHog 한 대시보드 공존 확인.
