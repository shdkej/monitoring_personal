# Monitoring 배포 경로

## 정본 관계

운영 경로는 **`monitoring_personal` → Space Argo CD → Kubernetes `monitoring` 네임스페이스**입니다.
로컬 Docker 또는 Docker Compose는 운영·검증 경로가 아닙니다.

- `monitoring_personal`: exporter 소스와 `kustomization.yaml`이 만드는 `ServiceMonitor`,
  `PrometheusRule`, `AlertmanagerConfig`, Grafana datasource/dashboard ConfigMap, exporter
  `Deployment`/`Service`의 정본입니다.
- `space/modules/k3s-apps/monitoring.tf`: `kube-prometheus-stack` Helm 기반의 Prometheus,
  Grafana, Prometheus Operator와 Grafana sidecar를 제공합니다.
- `space/argocd/apps/monitoring-config.yaml`: `monitoring_personal`의 기본 브랜치를 Argo CD
  애플리케이션 `monitoring-config`으로 동기화하며 prune과 self-heal을 사용합니다.
- Kubernetes: Prometheus Operator가 `ServiceMonitor`를 scrape하고, Grafana sidecar가
  dashboard ConfigMap을 읽어 Grafana에 reload합니다.

## 반복 가능한 변경·검증 순서

1. `monitoring_personal`에서 exporter·규칙·대시보드·Kustomize 리소스를 수정합니다.
2. `kubectl kustomize .`와 관련 exporter 테스트로 입력을 검증한 뒤 해당 저장소를 commit/push합니다.
3. `kubectl -n argocd get application monitoring-config`에서 새 revision의 `Synced`와
   `Healthy`를 확인합니다.
4. Kubernetes의 ConfigMap/Deployment와 Prometheus 쿼리에서 새 리소스와 지표 값을 확인합니다.
5. dashboard 변경은 Grafana sidecar reload 로그를 확인하고, 인증된 Grafana 화면이 가능하면
   실제 패널 렌더까지 확인합니다. 화면 검증이 불가능하면 그 경계를 완료 보고에 남깁니다.

## 대시보드 탐색과 제거

- `main-overview`의 상단에는 비즈니스·고객·제품·시스템 상세 대시보드로 가는 네 링크가 보입니다.
  데이터가 표시되는 요약 카드 값에도 각 대응 링크가 있고, `N/A` 상태에서도 상단 링크로 이동할 수 있습니다.
- 대시보드는 Kustomize가 생성한 ConfigMap을 Grafana sidecar가 읽습니다. 소스 JSON과
  `configMapGenerator` 항목을 함께 제거하면 Argo CD prune 후 sidecar가 대시보드 파일을 제거하며,
  현재 실제 provider는 `disableDeletion: false`입니다. Dispatcher 상세 대시보드는 제거하지만
  별도 exporter와 메트릭 수집은 이 변경의 범위가 아닙니다.

## Dashboard 계약

- 패널은 exporter가 실제로 발행하는 지표만 조회합니다. exporter 지표를 바꾸면 dashboard
  PromQL도 같은 변경에서 함께 갱신합니다.
- 정상 상태는 가능한 한 `0`으로 표시해 `No data`와 구분합니다. `No data`는 scrape·배포·쿼리
  계약이 깨진 신호로 취급합니다.
- 지표 정의의 정본은 [`business-layer-design.md`](business-layer-design.md)이며, 대시보드는
  비즈니스·고객·제품·시스템 4개 레이어에 8개씩 배치합니다. 미연동 앱, 미정의 이벤트, 분모가
  없는 비율은 0으로 채우지 않고 `N/A`와 필요한 입력을 표시합니다.
- 제품 데이터는 PostHog, 유입 데이터는 GA4, 운영 데이터는 Prometheus/CloudWatch에서 읽습니다.
  Gmail은 지원 메일 주소/라벨과 집계 단위가 정해지고 connector가 연결된 뒤에만 사용합니다.
- 새 PostHog 퍼널 지표는 `start > 0`일 때만 전환·이탈률 series를 발행합니다. 시작자가 없을 때
  이탈률을 0%로 오인하지 않도록 해당 series는 내보내지 않습니다.
- PostHog exporter는 공유 프로젝트 424014를 15분마다 네 번 조회해 앱별 완료 구간을 갱신합니다.
  `posthog_app_calendar_count`의 `scope`는 승인된 앱 ID를 우선하고, ID가 없으면 등록된 호스트로 분류합니다.
  남은 무기명 소스는 ‘앱 미지정’입니다. 등록되지 않은 명시적 ID와 합성 이벤트는 집계에서 제외합니다.
  `period`는 한국 시간 일간 7개·주간 4개·월간 2개와 UTC 최근 완료 7일(`rolling7d`)이며
  `period_start`와 `period_end`는 양 끝 날짜를 포함합니다. `metric`은 `events`, `pageviews`,
  `sessions`, `eventsWithSessionId`입니다. 세션 수는 각 구간에서 비어 있지 않은 고유 세션 ID 수입니다.
  기존 `product_sessions{service="virtue"}`는 공유 프로젝트 전체의 직전 7일 값을 유지합니다.
- 클러스터 내부 `posthog-exporter:9101/analytics-posthog.json`은 동일한 성공 스냅샷을 반환합니다.
  초기 수집 전에는 HTTP 503, 재조회 실패 뒤에는 마지막 성공 값과 원래 관측 시각을 반환합니다.
  `posthog_app_calendar_observed_timestamp_seconds`로 경과 시간을 확인할 수 있습니다.
  달력 경계·원천 장애 회귀 검사는 `cd posthog-exporter && node --test`로 실행합니다.
- PostHog exporter는 컨테이너 시작 시 저장소를 clone하므로 `posthog-exporter/index.js` 변경에는
  같은 변경에서 `k8s/posthog-exporter/deployment.yaml`의 `SOURCE_REVISION`을 갱신해 Pod rollout을
  유도합니다.
- 고객 레이어(`layer-customer`)의 신규 사용자와 유입 채널별 세션 패널에서 앱을 선택합니다. GA4 `ga4_app_rolling7d_count{scope,metric}`은 Space의 HTTPS `analytics-ga4.json`을 15분마다 읽어 등록 속성의 최근 7일 신규 사용자와 세션을 제공합니다. Space 원천은 매일 10:15 KST에 갱신합니다. 앱 수집 실패 또는 마지막 관측 후 30시간이 지나면 해당 값은 노출하지 않습니다. `ga4_app_observed_timestamp_seconds`로 속성별 원천 시각을 조회합니다.
- 제품 레이어(`layer-product`)의 제품 세션 수는 UTC 최근 완료 7일에 확인한 앱별 고유 세션 ID 수입니다. `posthog_app_health{scope,metric}`은 같은 앱 귀속 조건으로 15분마다 한 번 조회합니다. 이탈 사용자·재방문율·예외는 이동 구간, LCP·INP는 최근 30일 관측값의 p75입니다. 재방문율 분모나 Web Vitals 관측값이 없으면 빈 값입니다. 핵심 작업 완료 건수는 UTC 최근 완료 7일의 앱별 지정 이벤트 건수입니다. 제품 레이어의 세션당 참여시간은 Space 예약 수집기가 monitoring/ga4-session-engagement ConfigMap에 기록한 GA4 최근 7일 평균을 초 단위로 표시합니다. 세션이 없거나 평균이 수집되지 않은 경우 빈 값입니다. 비교 차트는 45분을 넘긴 PostHog 관측을 숨깁니다. 그래프 가로축은 scrape 시각이고 신규 게이지 이력은 배포 후 쌓입니다.
- GA4 채널별 7일 집계는 같은 비공개 ConfigMap에서 읽어 `ga4_app_channel_sessions{scope,channel}`로 표시합니다. 수집기는 기간과 속성을 확인하고 표 합계 및 각 채널의 합을 전체 세션과 대조합니다. 일치하지 않으면 해당 속성의 채널 계열은 비어 있습니다. 직접 조회 가능한 속성의 30일 일간 채널 상세도 같은 패널에서 볼 수 있습니다.
- 고객 레이어의 ‘유입 보기’는 기존 2번 패널만 전환합니다. GA4의 `ga4_app_instagram_acquisition{scope,metric}`은 세션 소스별 세션 및 첫 사용자 소스별 신규 사용자를 각각 전체 수치와 대조한 최근 7일 집계입니다. 소스 instagram, ig, instagram.com 및 하위 도메인, com.instagram.android를 포함합니다. `instagram_account_discovery{account,metric}`은 최근 7일 소셜 계정 측정값이며 앱 필터와 독립입니다. 출처가 표시한 조회수(views), 조회한 사람(viewers), 도달(reach)을 구분합니다. 예약 수집기가 같은 비공개 ConfigMap의 instagram.json을 별도 필드 소유자로 갱신하며 접근 불가 또는 30시간이 지난 값은 비어 있습니다.
- GA4 속성이 추가되면 Space Status의 원천 목록과 운영 수집기를 갱신하고 새 공개 피드 행을 확인합니다. exporter와 앱 선택기는 피드에서 새 속성을 읽습니다. PostHog 앱 등록은 `posthog-exporter/calendar.js`의 프로젝트·앱 귀속과 Space Status 공개 인벤토리를 함께 확인합니다. 별도 프로젝트는 해당 계정 권한·이벤트 단위·공개 범위를 확인한 뒤 귀속 쿼리에 연결합니다.
- 변경 완료 보고에는 수정한 문서, source commit, Argo CD revision, Prometheus/Grafana 검증
  결과와 남은 화면 검증 경계를 함께 적습니다.

고객 레이어의 첫 방문 지표는 policycock과 Virtue 웹의 동의 기반 이벤트를 15분마다 조회합니다. 시각 기준 지난 7일의 `first_session_started`를 브라우저의 첫 세션 ID별로 묶고, 같은 ID의 `first_session_activated`와 공유 유입 표시를 집계합니다. 브라우저 저장소가 지워지면 새 방문으로 관측될 수 있습니다. 시작 이벤트가 없으면 완료율은 비어 있으며 공유 유입 수는 0입니다.
