#!/usr/bin/env bash
# Creates the two secrets this overlay references, from local untracked files,
# then applies the overlay. Run from the repo root. Nothing here is committed.
set -euo pipefail
NS=askpdf
kubectl get namespace "$NS" >/dev/null 2>&1 || kubectl create namespace "$NS"

# Gemini + JWT from the gitignored .env
set -a; source .env; set +a
kubectl -n "$NS" create secret generic askpdf-real-secrets \
  --from-literal=GEMINI_API_KEY="$GEMINI_API_KEY" \
  --from-literal=JWT_ACCESS_SECRET="$JWT_ACCESS_SECRET" \
  --from-literal=JWT_REFRESH_SECRET="$JWT_REFRESH_SECRET" \
  --dry-run=client -o yaml | kubectl apply -f -

# GCS service-account key from the gitignored .secrets dir
kubectl -n "$NS" create secret generic askpdf-gcs-key \
  --from-file=key.json="$GCS_KEY_FILE" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl apply -k deploy/k8s/overlays/local-real
kubectl -n "$NS" rollout restart deployment/api deployment/worker
echo "applied. real Gemini + GCS are live."
