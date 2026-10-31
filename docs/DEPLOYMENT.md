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
- 변경 완료 보고에는 수정한 문서, source commit, Argo CD revision, Prometheus/Grafana 검증
  결과와 남은 화면 검증 경계를 함께 적습니다.
