# =============================================================================
# k8s 시크릿 배포 자동화
# 대시보드는 Kustomize + ArgoCD가 자동 관리 (monitoring-config)
# ga4-credentials는 space 레포에서 관리
# =============================================================================

KUBECONFIG ?= ~/workspace/space/infra-oracle/.kubeconfig
KUBECTL := kubectl --kubeconfig=$(KUBECONFIG)

.PHONY: secrets secrets-grafana-datasources

# Slack webhook Secret 배포
secrets:
	@echo ">>> Deploying alertmanager-slack-webhook secret"
	@$(KUBECTL) create secret generic alertmanager-slack-webhook \
		--namespace monitoring \
		--from-literal=slack-webhook-url="$${SLACK_WEBHOOK_URL}" \
		--dry-run=client -o yaml | $(KUBECTL) apply -f -
	@echo ">>> Done"

# Grafana 데이터소스 환경변수 Secret 배포 (GA4 + CloudWatch)
secrets-grafana-datasources:
	@echo ">>> Deploying grafana-datasource-secrets"
	@$(KUBECTL) create secret generic grafana-datasource-secrets \
		--namespace monitoring \
		--from-literal=GA4_CLIENT_EMAIL="$${GA4_CLIENT_EMAIL}" \
		--from-literal=GA4_GCP_PROJECT="$${GA4_GCP_PROJECT}" \
		--from-literal=GA4_PRIVATE_KEY="$${GA4_PRIVATE_KEY}" \
		--from-literal=AWS_ACCESS_KEY_ID="$${AWS_ACCESS_KEY_ID}" \
		--from-literal=AWS_SECRET_ACCESS_KEY="$${AWS_SECRET_ACCESS_KEY}" \
		--dry-run=client -o yaml | $(KUBECTL) apply -f -
	@echo ">>> Done"
