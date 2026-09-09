# monitoring_personal

운영 경로는 Kubernetes/Argo CD입니다. Grafana 대시보드와 Prometheus Operator 리소스는
`kustomization.yaml`을 통해 배포되며, 로컬 Docker Compose 구성은 사용하지 않습니다.

구성요소 관계, 변경 순서와 운영 검증 기준은 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)에
정리합니다.
