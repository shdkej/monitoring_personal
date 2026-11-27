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

## 시계열 보관과 기간 집계

- 2026-11-27 live flags·Prometheus CR·Pod volume과 Space `modules/k3s-apps/monitoring.tf`를
  대조했습니다. 현재 **retention 3d, emptyDir**이며 장기 보관용 PVC가 없습니다. TSDB의 가장
  오래된 시각은 2026-11-23 18:00 UTC였고, 대표 지표 5종의 최근 35일 조회에서 7일 이전
  샘플은 없었습니다. 기본 대시보드의 Last 30 days가 30일 보관을 의미하지 않습니다.
- emptyDir는 Pod 삭제·교체 시 없어집니다. 같은 Pod 안의 컨테이너 재시작과는 구분합니다.
  장기 보관을 변경할 때는 용량·백업·기존 기록 이전을 검토하고, 현재 데이터 보존 전에
  Prometheus Pod를 재생성하지 않습니다. 이 점검에서는 운영 설정을 변경하지 않았습니다.
- 실제 scrape 간격은 node-exporter 30초, dispatcher 1분, PostHog/analytics 5분, YACE 15분입니다.
  원천 갱신은 별개입니다: PostHog 15분, GA4/Instagram API·Gmail 1시간, S3 저장량은 AWS 일간
  지표입니다. scrape 성공과 원천 관측 시각·오류를 함께 확인합니다.
- 최근 7일 합계 gauge를 시간에 따라 저장한 곡선은 달력 일간·주간·월간 집계가 아닙니다.
  시간 선택만 바꿔도 집계 기간은 바뀌지 않습니다. 반복 관측값을 sum/increase로 더해 주·월
  합계를 만들지 않으며, 고유 사용자·세션·비율·백분위는 해당 기간의 원천에서 다시 산출합니다.
- PostHog의 일부 지표만 완료 일간 7개·주간 4개·월간 2개를 원천에서 다시 조회합니다.
  이 과거 기간 label은 오래 보관된 Prometheus sample과 다릅니다. 현재 제품 세션 패널은
  `period="rolling7d"`만 사용합니다. 레이어별 실측 범위와 미연결 항목은
  [기간별 수집 현황](business-layer-design.md#기간별-수집-현황-2026-11-27)을 따릅니다.
- 참고: [Prometheus 보관 설정](https://prometheus.io/docs/prometheus/latest/storage/),
  [Kubernetes emptyDir 수명](https://kubernetes.io/docs/reference/storage/volume-types/#emptydir).

## 대시보드 탐색과 제거

- `main-overview`의 상단에는 비즈니스·고객·제품·시스템 상세 대시보드로 가는 네 링크가 보입니다.
  데이터가 표시되는 요약 카드 값에도 각 대응 링크가 있고, `N/A` 상태에서도 상단 링크로 이동할 수 있습니다.
- 대시보드는 Kustomize가 생성한 ConfigMap을 Grafana sidecar가 읽습니다. 소스 JSON과
  `configMapGenerator` 항목을 함께 제거하면 Argo CD prune 후 sidecar가 대시보드 파일을 제거하며,
  현재 실제 provider는 `disableDeletion: false`입니다. Dispatcher 상세 대시보드는 제거하지만
  별도 exporter와 메트릭 수집은 이 변경의 범위가 아닙니다.

## Dashboard 계약

- **사용자가 명시적으로 요청하지 않으면 Grafana 대시보드를 새로 만들지 않습니다.**
  지표 추가·교체, 로그 내용 표시, 상세 조회는 기존 대시보드의 패널을 수정하거나 확장합니다.
  상세 화면이 편리하다는 판단만으로 별도 대시보드 UID·JSON·배포 ConfigMap을 추가하지 않습니다.
  사용자 지시(2026-11-26): “내가 말하지 않는한 대시보드 새로 만들지 마.”
- 패널은 exporter가 실제로 발행하는 지표만 조회합니다. exporter 지표를 바꾸면 dashboard
  PromQL도 같은 변경에서 함께 갱신합니다.
- 정상 상태는 가능한 한 `0`으로 표시해 `No data`와 구분합니다. `No data`는 scrape·배포·쿼리
  계약이 깨진 신호로 취급합니다.
- 지표 정의의 정본은 [`business-layer-design.md`](business-layer-design.md)이며, 대시보드는
  비즈니스·고객·제품·시스템 4개 레이어에 8개씩 배치합니다. 미연동 앱, 미정의 이벤트, 분모가
  없는 비율은 0으로 채우지 않고 `N/A`와 필요한 입력을 표시합니다.
- 제품 데이터는 PostHog, 유입 데이터는 GA4, 운영 데이터는 Prometheus/CloudWatch에서 읽습니다.
  고객 문의는 exporter에서 매시간 gog로 최근 7일 수신 대화를 조회합니다. 앱 이름은 GA4·PostHog 앱 범위에서 가져옵니다. 모호한 짧은 이름과 미지정 범위를 제외합니다. `monitoring/analytics-gmail-api`에는 대상 계정(`account`)과 OAuth 자격 증명(`credentials.json`)이 필요합니다. 읽기 전용 OAuth가 기본이며, 운영에서 선택한 기존 gog 인증을 재사용하는 경우에만 Secret의 `grant-mode`를 `existing-gog`로 지정합니다. 이 갱신 토큰은 원래 Google 권한을 유지합니다. exporter는 액세스 토큰의 권한과 사서함 계정을 확인하고, gog 프로세스에 단기 토큰만 전달하고 실행 명령은 읽기 전용 `gmail.messages.search`로 제한합니다. gog v0.48.1 공식 Linux 배포본의 SHA256을 검사하며 amd64 및 arm64를 지원합니다. `analytics_api_last_success_timestamp_seconds{source="gmail"}`로 수집 시각을 확인합니다. 오류가 지속되어 마지막 확인 이후 3시간이 지나면 건수를 숨깁니다.
- 새 PostHog 퍼널 지표는 `start > 0`일 때만 전환·이탈률 series를 발행합니다. 시작자가 없을 때
  이탈률을 0%로 오인하지 않도록 해당 series는 내보내지 않습니다.
- exporter는 PostHog 프로젝트 목록을 시간마다 탐색하고, 15분마다 프로젝트와 앱별로 집계합니다. 공유 프로젝트 424014에서는 승인된 앱 ID를 먼저 적용하고 호스트를 보조로 사용합니다. 개인 Grafana는 새 프로젝트, 최근 120일의 유효한 앱 ID와 소유 도메인의 새 호스트를 포함합니다. 식별되지 않은 이벤트는 해당 프로젝트의 ‘앱 미지정’으로 묶고 합성 트래픽은 제외합니다. 앱별 집계는 45분 동안 유효합니다. `product_sessions{service="virtue"}`를 포함한 기존 지표도 해당 앱의 값입니다. 핵심 작업과 퍼널은 이벤트 정의가 있는 앱에만 적용합니다.
- `posthog_app_calendar_count`는 한국 시간 일간 7개·주간 4개·월간 2개와 UTC 최근 완료 7일을 제공합니다. 공개 Space 피드용 `/analytics-posthog.json`은 등록된 범위만 별도로 집계합니다. 수집 실패 시 마지막 성공 시각을 유지합니다.
- GA4 네 속성의 API 보고서와 Instagram 인사이트의 exporter 설정은 `k8s/posthog-exporter/deployment.yaml`에 있습니다. `analytics_api_last_success_timestamp_seconds`와 `analytics_api_consecutive_failures`로 원천별 성공 시각과 연속 실패 횟수를 조회합니다. 고객 대시보드의 유입 패널은 GA4 일간 추이, 최근 완료 7일의 앱별 유입, Instagram 계정 조회·도달을 동시에 표시합니다. 계정별 조회와 앱 유입은 서로 다른 집계입니다.
- exporter 소스를 수정하면 Deployment의 `SOURCE_REVISION`을 갱신하여 새 Pod가 코드를 읽게 합니다. 회귀 검사는 `cd posthog-exporter && node --test`로 실행합니다.
- 세션당 참여시간은 GA4 참여 시간(초)을 세션 수로 나눕니다. 세션이 없는 속성의 평균은 비워 둡니다. 채널별 세션 합과 전체 세션을 대조하며, Instagram 신규 사용자는 첫 사용자 소스, 유입 세션은 세션 소스를 사용합니다. 완료 구간의 가로축은 Prometheus 수집 시각입니다. GA4 속성 추가 시 API 속성 매핑과 읽기 권한을 함께 확인합니다.
- 운영 GA4 네 속성과 Instagram `@minimal_collector`는 클러스터에서 매시간 API를 직접 조회합니다. Instagram은 지정 계정의 UTC 최근 완료 7일 조회수와 도달 계정 수를 조회합니다. 시스템 사용자 인증은 `monitoring/analytics-instagram-api`의 `access-token`, `account-id`, `graph-host`를 읽습니다. 운영 호스트는 `graph.facebook.com`입니다. 연결 해제나 권한 회수 후에는 해당 Secret을 갱신하고 실제 계정과 보고서를 재검증합니다. 전환된 원천에서 3시간 넘게 검증된 새 관측이 없으면 값을 숨깁니다.
- 공개 Space 피드와 개인 Grafana는 각각의 공개 범위를 사용합니다. 공개 달력 피드의 앱 등록은 Space의 `analytics-inventory.json`과 함께 확인합니다.
- 변경 완료 보고에는 수정한 문서, source commit, Argo CD revision, Prometheus/Grafana 검증
  결과와 남은 화면 검증 경계를 함께 적습니다.

고객 레이어의 첫 방문 지표는 policycock과 Virtue 웹의 동의 기반 이벤트를 15분마다 조회합니다. 시각 기준 지난 7일의 `first_session_started`를 브라우저의 첫 세션 ID별로 묶고, 같은 ID의 `first_session_activated`와 공유 유입 표시를 집계합니다. 브라우저 저장소가 지워지면 새 방문으로 관측될 수 있습니다. 시작 이벤트가 없으면 완료율은 비어 있으며 공유 유입 수는 0입니다.

Instagram의 `@every.policy` 조회수·조회한 사람 수는 SAM-PC의 기존 일일 Ego 작업이 비공개 ConfigMap에 전달합니다. 마지막 관측 후 30시간이 지나면 숨기며 API가 담당하는 `@minimal_collector`는 기존 시간별 API 값을 사용합니다.

## 노드 헬스체크 표시

- 기존 `layer-system`의 6번 패널을 재사용합니다. Grafana 기본 Stat 타일에 노드 이름과
  `수집 정상`(초록)·`수집 실패`(빨강)·`미수집`(회색)을 함께 표시합니다. 숫자 0/1과 긴
  수집 label, 일정한 sparkline을 화면에 노출하지 않습니다. 새 대시보드·플러그인은 없습니다.
- `up{job="node-exporter"}`를 instant query로 읽고 `kube_node_info`의 `internal_ip:9100`과
  연결해 `node` 이름을 붙입니다. 현재 node-exporter의 포트 9100 기준이며 포트 변경 시
  쿼리의 연결 조건도 갱신합니다. 같은 노드의 시계열은 하나로 집계합니다.
- node-exporter의 `up=0`은 수집 실패, 정상적으로 수집된 Kubernetes 노드 목록에 있지만
  node-exporter 대상이 없으면 `-1` 미수집입니다. `kube-state-metrics`의 `up=1`로 목록의
  수집 상태를 확인하며 목록 자체를 확인할 수 없으면 데이터 없음으로 표시합니다.
  이 상태는 Kubernetes Ready나 CPU·메모리·디스크의 종합 건강 판정이 아닙니다.
- 범위 조회의 과거 정상값을 마지막 값으로 남기지 않습니다. 대시보드 조회 범위의 종료
  시점을 평가하며, Prometheus의 최근 샘플 선택·staleness 규칙은 그대로 적용됩니다.
- 검증은 JSON/Kustomize 빌드 → live PromQL의 정상·실패·대상 누락·목록 누락 사례 →
  Argo CD revision/ConfigMap/Grafana 패널 설정 일치 → 데스크톱·모바일 실제 렌더 순서입니다.
  복구는 해당 패널 JSON 변경을 되돌려 같은 GitOps 경로로 반영합니다. 수집기 재시작과
  Prometheus 이전·스토리지 변경은 필요하지 않습니다.

## OpenClaw 에러 로그 수

- 시스템 레이어 5번 패널은 네트워크 지연 대신 `openclaw_log_errors_24h`를 표시합니다.
  조회 시점 직전 24시간의 `ERROR`·`FATAL` JSONL 레코드 수이며 WARN, 메시지의 error 문자열,
  크론 실패 횟수와는 다릅니다. 정수 건수이며 SLO를 정하지 않아 색상은 중립으로 유지합니다.
- 기존 `infinity-dispatcher-exporter`의 `dispatcher-exporter/exporter.py`가 집계합니다.
  Deployment는 OpenClaw 호스트 `oracle-arm-2`에 배치하고 `/home/ubuntu/.openclaw/logs`를
  `/data/openclaw-logs`로 읽기 전용 마운트합니다. API 서비스 계정 토큰은 마운트하지 않습니다.
  OpenClaw 설정·크론·재시작은 필요하지 않습니다. 별도 Loki나 로그 전송기를 설치하지 않습니다.
- 기본 프로필 `openclaw-YYYY-MM-DD.log`와 `.1`~`.5` 회전 파일만 읽습니다. 날짜는 호스트
  시간대 차이를 포함해 고르고, 실제 집계는 각 레코드의 시간대가 있는 `time`으로 제한합니다.
  보존 파일에 남은 로그 기준이며, 보존 기간 단축이나 회전 파일 초과 삭제로 사라진 로그는 복원하지
  않습니다. 파일 경로·프로필·로그 형식이 바뀌면 collector 계약도 갱신해야 합니다.
- Prometheus에는 로그 본문·사용자/세션 식별자를 내보내지 않습니다. 읽기·형식 오류 또는 최근 24시간 로그가
  없으면 `openclaw_log_read_error=1`만 내보내고 건수는 숨깁니다. 정상 로그가 있고 에러가 없을 때만
  0건입니다. 쓰는 중인 마지막 미완성 줄은 다음 수집으로 넘깁니다.
- 기존 ServiceMonitor가 1분마다 수집합니다. Grafana는 instant query로 최신 건수를 읽으며
  수집 실패 뒤 과거 정상 건수를 `lastNotNull`로 재사용하지 않습니다. 대시보드 시간 선택과
  무관하게 선택 구간의 끝 시점에서 직전 24시간을 집계한 값입니다.
- `/metrics`에서 로그를 집계하므로 100m CPU 제한의 운영 Pod에서 응답이 약 1.2초 걸렸습니다.
  readiness/liveness timeout은 5초이며 Prometheus 수집 제한은 10초입니다. 로그량 증가로
  수집이 실패하면 실제 소요 시간부터 확인합니다.
- 검증: `python3 -m unittest discover -s dispatcher-exporter -v`, `kubectl kustomize .`,
  Deployment server dry-run → commit/push → Argo CD 새 revision → exporter rollout →
  `openclaw_log_read_error == 0` 및 `openclaw_log_errors_24h` → Grafana 실제 패널을 확인합니다.
  exporter 수정 시 Deployment `SOURCE_REVISION`도 갱신합니다. 복구는 이 변경 커밋을 revert하여
  push하고 Argo CD 동기화와 이전 snapshot 수집을 확인하는 경로입니다.
- 형식·마운트 참고: [OpenClaw logging](https://docs.openclaw.ai/logging),
  [Kubernetes hostPath](https://kubernetes.io/docs/concepts/storage/volumes/#hostpath).

## S3 저장량·예상 요금

- `k8s/monitoring-config/yace-config.yaml`이 기존 YACE v0.63.0에 S3 customNamespace와
  AWS/Billing static job을 추가합니다. 새 exporter·AWS 권한·유료 요청 메트릭은 만들지 않습니다.
- 버킷 태그 없이 CloudWatch의 정확한 `BucketName, StorageType` 차원을 수집합니다. 소유 계정의
  일반 버킷을 확인한 리전은 ap-northeast-2, ap-northeast-1, ap-south-1, us-east-1, eu-central-1입니다.
  새 리전의 버킷을 추가하면 이 목록도 갱신합니다. directory/vector bucket은 별도 계측 대상입니다.
- 저장량·객체 수는 AWS 일간 지표입니다. period 86400, length 259200으로 최근 3일의 최신 값을
  요청하며 원래 CloudWatch timestamp를 Prometheus sample timestamp로 붙이지 않습니다.
  오래된 일간 sample의 수집 거부를 피하기 위한 설정이며 실시간 저장량이라는 뜻은 아닙니다.
  YACE의 기존 AWS polling은 5분, Prometheus scrape는 15분입니다. instant 패널은 최근 30분의
  수집값을 사용하고 NaN은 0으로 채우지 않습니다. 과거 추이는 수집 시작 이후만 있습니다.
- 저장량은 모든 관측 StorageType을 합산하며 객체 수는 AllStorageTypes만 사용합니다.
  복제된 exporter 시계열은 버킷/클래스 기준 max로 중복 제거합니다. 미관측 버킷은 0으로 추정하지
  않고 관측 버킷 수를 함께 표시합니다. 현재/과거 객체 버전·메타데이터·미완료 multipart 등이
  포함될 수 있으므로 현재 객체 목록 크기와 다를 수 있습니다.
- 요약 카드와 버킷별 표·추이·과금/성능 설명은 기존 시스템 레이어(`layer-system`)에 둡니다.
  상세 패널은 하단의 접힌 `S3 상세` 행에 있으며, 별도 `s3-storage` 대시보드는 사용하지 않습니다.
- 요금은 us-east-1의 AWS/Billing `EstimatedCharges{ServiceName=AmazonS3,Currency=USD}`이며
  S3 계정 전체의 월 누적 예상 금액입니다. 다른 서비스/최종 청구액과 구분합니다. Free Tier API
  전체 18개 혜택을 2026-11-26 확인했으나 S3 항목은 없었습니다. 5GB 무료 한도나 예산을
  가정하지 않습니다. 월 예산은 사용자가 정한 뒤 사용률·잔액을 연결합니다.
- S3는 저장 총량의 고정 한도/일괄 감속 구간이 없습니다. prefix별 최소 쓰기 3,500/s·읽기 5,500/s는
  AWS가 안내하는 처리 성능 기준이며 고정 한도가 아닙니다. 현재 AWS/S3에는 저장량·객체 수만
  있어 요청률·지연·503 성능 여유는 미측정입니다. 유료 request metrics 활성화는 별도 비용 승인
  이후 대상 버킷·prefix와 지표를 정합니다.
- ConfigMap 배포 후 대상 YACE Deployment rollout을 실행하고
  `/metrics`의 S3/요금 시계열과 Prometheus, Grafana 카드를 대조합니다. 복구는 변경 커밋 revert와
  YACE rollout입니다. S3 버킷·객체·스토리지 클래스는 변경하지 않습니다.

## OpenClaw 에러 내용

- 기존 exporter의 `/openclaw/errors`는 최근 24시간 ERROR/FATAL 중 최신 50개의 발생 시각·레벨·
  메시지(최대 2,000자)를 JSON으로 제공합니다. 인증된 Grafana의 Infinity datasource가 내부
  ClusterIP Service로만 접근합니다. 외부 Ingress/NodePort나 로그 저장소를 새로 만들지 않습니다.
- Bearer/API/AWS/GitHub/Slack 토큰, 비밀번호·쿠키·세션 키, 이메일·긴 숫자 식별자 등 알려진
  패턴을 마스킹합니다. 임의의 모든 개인정보를 완벽히 판정하는 필터는 아니므로 로그에 비밀값을
  쓰지 않는 원천 규칙은 계속 필요합니다. 원문 레코드나 trace/session 필드는 전송하지 않습니다.
- 원천 오류는 HTTP 503이며 빈 목록 성공으로 숨기지 않습니다. 정상 무오류는 빈 표와 0건입니다.
  메시지는 Prometheus label로 저장하지 않으며 JSON 응답은 no-store입니다. 상태 probe는
  로그를 재집계하지 않는 `/healthz`로 분리했습니다.
- Grafana Infinity `yesoreyeram-infinity-datasource@4.1.8`은 Space monitoring.tf에 선언합니다.
  실제 ConfigMap의 기존 plugins 목록을 보존하여 추가하고 Grafana plugin API 설치/실제 로딩을
  검증합니다. datasource 정본은 이 저장소 `k8s/monitoring-config/grafana-datasource.yaml`이며
  allowedHosts는 해당 내부 Service만 허용합니다. OpenClaw 크론·설정·재시작은 바꾸지 않습니다.

OpenClaw 메시지 표는 모바일에서 열이 찌그러지지 않도록 KST 발생 시각·레벨·메시지를 한 셀에 줄바꿈하여 표시합니다. UUID와 sessionKey·chatId·messageId 같은 메시지 내부 식별자도 마스킹합니다.

### 내 지표 지도

`agent-metrics` ServiceMonitor가 default 네임스페이스의 앱 전용 metrics 포트를 1분마다 읽습니다. Grafana의 ‘내 지표 지도’(UID `agent-metrics-board`)는 저장한 정의가 있는 칸마다 최신 값과 원천 측정 시각을 표시합니다. 설정은 Metrics 앱에서 수정합니다. 수집 점검에는 `up{namespace="default",service="agent-metrics",endpoint="metrics"}`를 사용합니다.

## 시장 검색 추이

- 기존 비즈니스 대시보드 `layer-business`의 6번 ARPPU 패널을 교체합니다. 대시보드나 패널을
  추가하지 않고 8개 지표를 유지합니다. 앱 선택과 무관한 공통 시장 검색어입니다.
- 수집 정본은 `posthog-exporter/market-trends.js`와 `market-trends-keywords.json`입니다.
  기존 exporter 프로세스가 [네이버 데이터랩 공식 검색 API](https://developers.naver.com/docs/serviceapi/datalab/search/search.md)를
  매일 한 번 조회합니다. 검색어는 사용자 지정 5개이며 띄어쓰기와 트래킹 표현만 묶습니다.
  검색어 그룹을 바꿀 때는 패널의 Infinity columns도 함께 바꿉니다.
- Kubernetes Secret `monitoring/market-trends-naver`의 `client-id`, `client-secret`을
  `/etc/market-trends`에 읽기 전용으로 마운트합니다. 기존 승인된 네이버 인증을 재사용하며
  비밀값을 저장소·로그·Grafana에 넣지 않습니다. 누락되어도 기존 analytics 수집은 계속됩니다.
- 한국 시간 기준 최근 완료된 월~일 52주입니다. 전체 기기·성별·연령이며 API에 지역 필터는
  없습니다. 다섯 그룹·기간 전체의 공통 최고 검색량을 100으로 삼은 원천 상대지수를 유지합니다.
  미반환 주는 null이고 선으로 잇거나 0으로 채우지 않습니다. 넓은 검색어의 다른 의미도 포함됩니다.
- 성공 뒤 24시간, 실패 뒤 6시간 간격으로 재시도합니다. 실패 시 마지막 정상 응답과 원래 수집
  시각을 유지하고, 72시간 초과 또는 최초 실패는 HTTP 503으로 표시합니다. 재시작 시 메모리
  캐시를 다시 수집합니다. `market_trends_last_success_timestamp_seconds`와
  `market_trends_refresh_error`로 신선도·실패를 확인합니다.
- 기존 내부 Service의 `/market-trends.json`을 Infinity datasource `market-trends`가 읽습니다.
  allowedHosts는 해당 내부 Service만 허용합니다. 외부 Ingress·새 플러그인·Prometheus 과거
  데이터 적재는 필요하지 않습니다. 패널의 기본 상대 기간은 1년이고 절대 기간 선택 시 해당
  범위만 표시됩니다. 원천 응답은 항상 현재 기준 최근 완료 52주입니다.
- 검증 순서: `cd posthog-exporter && npm ci --ignore-scripts && node --test` →
  `kubectl kustomize .` 및 Deployment/ConfigMap server dry-run → commit/push → Argo CD
  revision·rollout → 내부 JSON의 52행/5열·누락값 → Grafana `/api/ds/query`와 실제 PC·모바일
  렌더를 확인합니다. 소스 수정 시 `SOURCE_REVISION`도 갱신합니다. 복구는 변경 커밋 revert와
  Argo CD 동기화이며 기존 analytics 설정과 다른 Secret은 유지합니다.
- 2026-11-27 기존 인증으로 실제 API 응답을 확인했습니다. 이 레거시 API는
  [공식 전환 공지](https://developers.naver.com/notice/article/32530)에 따라 **2027-06-30 종료**
  예정이므로 그 전에 NAVER API HUB의 인증·요금·응답 계약을 확인해 이전해야 합니다.
  Google Trends 공개 embed는 429, 공식 API는 신청이 필요한 상태여서 사용하지 않습니다.

### 인증정보 보호와 점검 범위

- 네이버 키는 exporter의 Secret 파일에서 읽고 고정된 공식 HTTPS API 요청에만 사용합니다.
  Grafana datasource에는 네이버 인증정보를 넣지 않습니다. JSON 응답은 허용된 집계 필드만
  만들며 원천 응답·요청 헤더·예외 본문을 로그로 출력하지 않습니다.
- 2026-11-27 현재 키와 관리자 비밀번호를 원문·base64·URL 인코딩 형태로 대조했습니다.
  이 저장소 전체 Git 이력의 파일 객체 484개, 이번 작업의 Space/KL 커밋, ConfigMap,
  최근 2시간 exporter/Grafana 로그, 현재 데이터·대시보드·datasource 응답에서 일치가 없었습니다.
  전체 호스트 포렌식이나 모든 과거 자격증명에 대한 검사는 아닙니다.
- 공개 Grafana의 비로그인 dashboard/datasource/proxy/query 요청은 모두 401입니다.
  exporter는 ClusterIP이고 외부 Ingress가 없습니다. 서비스 계정의 Secret get/list는 거부됩니다.
  내부 endpoint는 애플리케이션 인증이 없으므로 ClusterIP를 Grafana 전용 접근 통제로 간주하지 않습니다.
- 남은 기존 설정: K3s Secret 저장 암호화가 꺼져 있고, 실제 HTTPS 로그인 쿠키에도 Secure 속성이
  없습니다. HTTPS 리다이렉트·HSTS·HttpOnly는 확인했습니다. monitoring NetworkPolicy도 없어
  Pod 사이 접근을 격리하지 않습니다. 검토에서 운영 설정은 변경하지 않았습니다. 우선 Secure 쿠키,
  이어 저장 암호화 및 Grafana/Prometheus 소비 경로를 보존하는 네트워크 제한을 별도 보강합니다.
  참고: [Grafana 쿠키 보호](https://grafana.com/docs/grafana/latest/setup-grafana/configure-security/configure-security-hardening/),
  [K3s 저장 암호화](https://docs.k3s.io/cli/secrets-encrypt),
  [Kubernetes NetworkPolicy](https://kubernetes.io/docs/concepts/services-networking/network-policies/).
