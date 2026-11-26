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
- exporter는 PostHog 프로젝트 목록을 시간마다 탐색하고, 15분마다 프로젝트와 앱별로 집계합니다. 공유 프로젝트 424014에서는 승인된 앱 ID를 먼저 적용하고 호스트를 보조로 사용합니다. 개인 Grafana는 새 프로젝트, 최근 120일의 유효한 앱 ID와 소유 도메인의 새 호스트를 포함합니다. 식별되지 않은 이벤트는 해당 프로젝트의 ‘앱 미지정’으로 묶고 합성 트래픽은 제외합니다. 앱별 집계는 45분 동안 유효합니다. `product_sessions{service="virtue"}`를 포함한 기존 지표도 해당 앱의 값입니다. 핵심 작업과 퍼널은 이벤트 정의가 있는 앱에만 적용합니다.
- `posthog_app_calendar_count`는 한국 시간 일간 7개·주간 4개·월간 2개와 UTC 최근 완료 7일을 제공합니다. 공개 Space 피드용 `/analytics-posthog.json`은 등록된 범위만 별도로 집계합니다. 수집 실패 시 마지막 성공 시각을 유지합니다.
- GA4 네 속성의 API 보고서와 Instagram 인사이트의 exporter 설정은 `k8s/posthog-exporter/deployment.yaml`에 있습니다. `analytics_api_last_success_timestamp_seconds`와 `analytics_api_consecutive_failures`로 원천별 성공 시각과 연속 실패 횟수를 조회합니다. 고객 대시보드의 ‘유입 보기’는 계정 단위 조회·도달 및 GA4 앱 단위 유입을 같은 패널에서 전환합니다. 계정별 조회와 앱 유입은 서로 다른 집계입니다.
- exporter 소스를 수정하면 Deployment의 `SOURCE_REVISION`을 갱신하여 새 Pod가 코드를 읽게 합니다. 회귀 검사는 `cd posthog-exporter && node --test`로 실행합니다.
- 세션당 참여시간은 GA4 참여 시간(초)을 세션 수로 나눕니다. 세션이 없는 속성의 평균은 비워 둡니다. 채널별 세션 합과 전체 세션을 대조하며, Instagram 신규 사용자는 첫 사용자 소스, 유입 세션은 세션 소스를 사용합니다. 완료 구간의 가로축은 Prometheus 수집 시각입니다. GA4 속성 추가 시 API 속성 매핑과 읽기 권한을 함께 확인합니다.
- 공개 Space 피드와 개인 Grafana는 각각의 공개 범위를 사용합니다. 공개 달력 피드의 앱 등록은 Space의 `analytics-inventory.json`과 함께 확인합니다.
- 변경 완료 보고에는 수정한 문서, source commit, Argo CD revision, Prometheus/Grafana 검증
  결과와 남은 화면 검증 경계를 함께 적습니다.

고객 레이어의 첫 방문 지표는 policycock과 Virtue 웹의 동의 기반 이벤트를 15분마다 조회합니다. 시각 기준 지난 7일의 `first_session_started`를 브라우저의 첫 세션 ID별로 묶고, 같은 ID의 `first_session_activated`와 공유 유입 표시를 집계합니다. 브라우저 저장소가 지워지면 새 방문으로 관측될 수 있습니다. 시작 이벤트가 없으면 완료율은 비어 있으며 공유 유입 수는 0입니다.
