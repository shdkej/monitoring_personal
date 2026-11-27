# monitoring_personal

Grafana·Prometheus 기반의 개인 서비스 모니터링 구성입니다. 비즈니스·고객·제품·시스템의
4개 레이어에 각각 8개 지표를 표시합니다. 고객·제품 레이어에서 앱을 여러 개 선택하면 해당 지표의 차트에 앱별 범례가 표시됩니다. 기본값은 전체 앱입니다.
지표 정의와 실제 데이터 공백은
[`docs/business-layer-design.md`](docs/business-layer-design.md)에 기록합니다.
Overview 상단의 비즈니스·고객·제품·시스템 링크로 각 상세 대시보드로 바로 이동할 수 있고,
데이터가 표시되는 요약 카드 값도 대응 레이어로 연결됩니다.

운영 경로는 Kubernetes/Argo CD입니다. Grafana 대시보드와 Prometheus Operator 리소스는
`kustomization.yaml`을 통해 배포되며, 로컬 Docker Compose 구성은 사용하지 않습니다.

구성요소 관계, 변경 순서와 운영 검증 기준은 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)에
정리합니다.
Grafana 변경은 [Dashboard 계약](docs/DEPLOYMENT.md#dashboard-계약)에 따라 기존 대시보드에서 처리하며,
새 대시보드는 사용자가 명시적으로 요청한 경우에만 만듭니다.

시스템 레이어의 노드 헬스체크는 노드 이름과 수집 정상·수집 실패·미수집 상태를 타일로 표시합니다.
조회 시점의 수집 상태이며, CPU·메모리·디스크 상태는 각 패널에서 확인합니다.

시스템 레이어는 최근 24시간 OpenClaw 에러 로그 수를 표시합니다. 기존 dispatcher exporter가
호스트 로그를 읽기 전용으로 집계하며, Prometheus에는 건수만 전송합니다. 같은 영역의 표에는 마스킹한 최근 오류 메시지 50개를 표시합니다. 회귀 검증은
`python3 -m unittest discover -s dispatcher-exporter -v`로 실행합니다.

시스템 레이어의 S3 카드는 관측 저장량·객체 수·버킷 수·월 누적 예상 요금을 표시하며,
같은 대시보드 하단의 `S3 상세` 행을 펼치면 버킷별 값과 과금·성능 기준 및 미측정 항목을 확인할 수 있습니다.

비즈니스 레이어의 시장 검색 추이는 네이버 데이터랩에서 미니멀·변화추적(트래킹)·에이전트·
1인사업가·밸런스의 최근 완료 52주를 매일 조회합니다. 기존 ARPPU 패널을 교체하며 전체 8개
지표를 유지합니다. 검색량은 공통 최고값 100의 상대지수이고, 누락된 주는 빈 구간입니다.
수집·인증·검증 방법과 API 전환 기한은 [시장 검색 추이 운영 계약](docs/DEPLOYMENT.md#시장-검색-추이)에 있습니다.
