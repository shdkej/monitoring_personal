# =============================================================================
# k8s 시크릿 배포 자동화
# 대시보드는 Kustomize + ArgoCD가 자동 관리 (monitoring-config)
# ga4-credentials는 space 레포에서 관리
# =============================================================================

KUBECONFIG ?= ~/workspace/space/infra-oracle/.kubeconfig
KUBECTL := kubectl --kubeconfig=$(KUBECONFIG)

.PHONY: secrets

# Slack webhook Secret 배포
secrets:
	@echo ">>> Deploying alertmanager-slack-webhook secret"
	@$(KUBECTL) create secret generic alertmanager-slack-webhook \
		--namespace monitoring \
		--from-literal=slack-webhook-url="$${SLACK_WEBHOOK_URL}" \
		--dry-run=client -o yaml | $(KUBECTL) apply -f -
	@echo ">>> Done"
