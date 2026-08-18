# Deployment

Two Kustomize overlays over a shared base:

| Overlay | What it runs | Use |
| --- | --- | --- |
| `overlays/local` | Everything in-cluster: Mongo + Redis StatefulSets, local file storage, **fake** AI provider | Self-contained laptop cluster, no credentials, no quota |
| `overlays/local-real` | `local` + real Gemini + real GCS | Production-shaped smoke test on the laptop |
| `overlays/gcp` | Managed Mongo (URI) + Memorystore + GCS via Workload Identity, secrets from Secret Manager | GKE |

The base (`base/`) holds what every environment shares: the two Deployments,
Services, Ingress, HPA, PodDisruptionBudgets, the ConfigMap, the ServiceAccount,
a NetworkPolicy restricting `/metrics` to the monitoring namespace, and a
pre-sync Job that builds MongoDB indexes (production runs with `autoIndex`
off).

## Local cluster (kind)

```bash
# Tools (no sudo): kubectl + kind into ~/.local/bin, then a cluster with an
# ingress-ready node mapping localhost:8080 -> the API.
kind create cluster --config deploy/k8s/kind-cluster.yaml

kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.11.2/deploy/static/provider/kind/deploy.yaml

docker build -t askpdf:dev --target runtime .
kind load docker-image askpdf:dev --name askpdf

# Self-contained (fake provider, local storage):
kubectl apply -k deploy/k8s/overlays/local

# The API is then reachable at http://localhost:8080
```

### Real Gemini + GCS on the laptop

`overlays/local-real` references two secrets **by name**; the values never
enter git. `setup-real.sh` creates them from your untracked `.env` and
`.secrets/`, then applies the overlay:

```bash
bash deploy/k8s/overlays/local-real/setup-real.sh
```

> A bare `kubectl apply -k overlays/local` after this **resets** the config back
> to the fake provider and drops the secret mounts, because it re-applies the
> base spec. Always re-run through `local-real` (or `setup-real.sh`) to keep the
> real setup. This is why the real config lives in a committed overlay rather
> than in imperative `kubectl patch` commands.

## GKE

The `gcp` overlay expects:

- **MongoDB** — a connection URI (Atlas or self-managed) in Secret Manager.
- **Redis** — Memorystore private IP in the ConfigMap, or copy `redis.yaml`
  from the local overlay to keep it in-cluster (see ADR 0001).
- **GCS** — bucket via Workload Identity, so no key on disk. Bind the
  Kubernetes SA to a Google SA with `roles/storage.objectAdmin`
  (the annotation and the exact `gcloud` command are in
  `patch-workload-identity.yaml`).
- **Secrets** — via the External Secrets Operator; `secretstore.yaml`
  documents the contract without holding any value.

```bash
# after building and pushing the image to Artifact Registry, and editing the
# image name in overlays/gcp/kustomization.yaml:
kubectl apply -k deploy/k8s/overlays/gcp
```

See `docs/adr/` for why Redis is a StatefulSet not a cache, and why the API and
worker scale on different signals.
