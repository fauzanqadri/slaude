---
title: Helm charts
description: Install slaude and the sandbox MCP server with Helm. The slaude chart renders the single-pod deploy or the gateway and node topology; the sandbox chart runs the server behind sandbox mode.
---

# Helm charts

Two charts live in `deploy/helm/`. Each release tag publishes both to GHCR as OCI artifacts, versioned with the image:

```sh
helm install slaude oci://ghcr.io/<owner>/charts/slaude --version <tag> -f values.yaml
helm install sandbox oci://ghcr.io/<owner>/charts/sandbox --version <tag> -f sandbox-values.yaml
```

Neither chart creates a Secret. Every credential is a Secret you create (sealed, or synced from your secret store) and name in the values.

---

## 1. `slaude`

`topology` selects one of two shapes.

| Topology | Objects | Use |
|---|---|---|
| `mono` (default) | One Deployment with one replica, a ReadWriteOnce `$SLAUDE_HOME` PVC, a Service | One persona per release, as `deploy/k8s/slaude.yaml` |
| `scale` | The gateway (ServiceAccount, Deployment, PodDisruptionBudget), one node Deployment and PodDisruptionBudget per label, three ConfigMaps, a ReadWriteMany `$SLAUDE_HOME`, the Service and Ingress, KEDA ScaledObjects or CPU HPAs, and the optional node egress NetworkPolicy | The [multi-node](multi-node.md) topology |

The `scale` topology is the same set of objects as `deploy/k8s-scale/`. `tests/deploy/helm-parity.test.ts` renders the chart with `tests/deploy/fixtures/scale-values.yaml` and requires it to equal `kubectl kustomize deploy/k8s-scale` object for object, apart from the Secrets and the Namespace. The fixture is the starting point for your own values.

### Main values

| Value | Meaning |
|---|---|
| `image.repository`, `image.tag` | The slaude image. The tag defaults to the chart's `appVersion`. |
| `home.*` | `$SLAUDE_HOME`: mount path, size, storage class, an existing claim. `scale` needs a ReadWriteMany class. |
| `mono.secretName`, `mono.config` | `mono`: the Secret loaded whole, and settings rendered into a ConfigMap. |
| `scale.secrets.gateway`, `scale.secrets.node` | `scale`: the gateway's Secret and the Secret every node shares. A node never loads the gateway's. |
| `scale.nodes[]` | One entry per node label: `label`, `replicas`, `credentialSecret` (the Secret holding that label's `SLAUDE_NODE_TOKEN`), `minReplicas`, `maxReplicas`. |
| `scale.config`, `scale.gatewayConfig`, `scale.nodeManifest` | The shared ConfigMap, the gateway-only ConfigMap (Vault, outbound hosts), the nodes' stdio MCP manifest. |
| `scale.autoscale.mode` | `keda`, `hpa` or `none`. Never both autoscalers on one Deployment. |
| `scale.egressPolicy.enabled` | The node egress allow-list. Needs a CNI that enforces NetworkPolicy. Add the sandbox server under `extraRules` when sandbox mode is on. |
| `ingress.*` | The public `/slack` path only. `/v1` and `/metrics` stay inside the cluster. |
| `sandbox.mcpUrl`, `sandbox.tokenSecretRef` | Turns [sandbox mode](../guides/sandbox.md) on in every slaude container. |
| `agentApi.enabled`, `agentApi.clientsConfigMap` | Mounts a ConfigMap of agent API clients, one key per client, at `$SLAUDE_HOME/api-clients` on the gateway (on the pod in `mono`). |

`values.schema.json` refuses an unknown top-level key, an unknown topology and a malformed node label. A missing Secret name fails the render instead of producing an empty reference.

## 2. `sandbox`

The sandbox MCP server that sandbox mode calls. It serves the tools under the `X-Sandbox-Session` header, creates a sandbox per session, and pushes commits with its own credential. Point slaude at it with `sandbox.mcpUrl: http://<release>-sandbox.<namespace>:8080/mcp`.

| Value | Meaning |
|---|---|
| `image.repository` | The server image (required). |
| `tokenSecretRef` | The bearer slaude sends: the same Secret key as slaude's `sandbox.tokenSecretRef`. |
| `backend` | `k8s` (a Pod and a PVC per session), or `local`, `docker`, `vps`, `vercel`. |
| `sandbox.image`, `sandbox.idleTtlMinutes`, `sandbox.keepDays` | The image every sandbox starts from, when an idle sandbox stops, when a stopped one is deleted. |
| `repos`, `mirrors.*` | Repositories cloned into a new sandbox from server-side mirrors, and the mirrors volume and read-only clone key. |
| `push.remotes`, `push.tokenSecretRef` | The only remotes `git_push` may push to, and the push credential. |
| `k8s.*` | The sandbox namespace and each sandbox's storage, CPU and memory. |
| `networkPolicy.enabled` | Only slaude's pods may call the server; sandbox pods accept no inbound connection and reach only the listed egress. |

With `backend: k8s` the chart adds a ServiceAccount and a Role in the sandbox namespace limited to `pods`, `pods/exec` and `persistentvolumeclaims`. No other backend gets RBAC or an API token.

## 3. Local cluster

`deploy/k8s-local/up.sh --helm` (or `SLAUDE_LOCAL_HELM=1`) brings up the local minikube cluster from the chart instead of the plain manifests. `helm-overlay.ts` renders the chart with `deploy/k8s-local/helm-values.yaml` and reuses the local overlay's generators and patches, so `verify-turns.sh` runs unchanged. The parity test also builds this overlay and requires it to equal the plain one.
