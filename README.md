# monitoring_personal

Grafana·Prometheus 기반의 개인 서비스 모니터링 구성입니다. 비즈니스·고객·제품·시스템의
4개 레이어를 관찰하며, 고객 대시보드는 GA4(blog·afzma)와 PostHog(virtue)를 구분합니다.
지표 정의와 실제 데이터 공백은
[`docs/business-layer-design.md`](docs/business-layer-design.md)에 기록합니다.
Overview의 비즈니스·고객·제품·시스템 카드를 클릭하면 해당 레이어 상세 대시보드로 이동합니다.

운영 경로는 Kubernetes/Argo CD입니다. Grafana 대시보드와 Prometheus Operator 리소스는
`kustomization.yaml`을 통해 배포되며, 로컬 Docker Compose 구성은 사용하지 않습니다.

구성요소 관계, 변경 순서와 운영 검증 기준은 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)에
정리합니다.
