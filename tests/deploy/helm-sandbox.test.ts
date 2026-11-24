/**
 * The sandbox server chart: the server and its Service, the Kubernetes
 * backend's RBAC (one namespace, sandbox pods and their claims only), Secrets
 * by reference, the lifecycle timeouts as env, and the NetworkPolicies. Needs
 * helm; skipped without it.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";

const root = join(import.meta.dir, "../..");
const hasHelm = Bun.spawnSync(["sh", "-c", "command -v helm"]).exitCode === 0;
if (!hasHelm) console.warn("helm-sandbox: helm not on PATH; skipped");

const BASE = ["image.repository=ghcr.io/example/sandbox-mcp-server", "tokenSecretRef.name=sandbox-token"];
const helm = (sets: string[]) =>
  Bun.spawnSync(["helm", "template", "s", "deploy/helm/sandbox", "-n", "sbx", ...sets.flatMap((s) => ["--set", s])], { cwd: root });
const render = (...sets: string[]): any[] => {
  const r = helm([...BASE, ...sets]);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return parseAllDocuments(r.stdout.toString()).map((d) => d.toJSON()).filter(Boolean);
};
const of = (docs: any[], kind: string) => docs.filter((d) => d.kind === kind);
const server = (docs: any[]) => of(docs, "Deployment")[0].spec.template.spec;
const envOf = (docs: any[]) => Object.fromEntries(server(docs).containers[0].env.map((e: any) => [e.name, e.value ?? e.valueFrom]));
const T = 30_000;

describe.skipIf(!hasHelm)("sandbox chart", () => {
  test("a server Deployment and its Service, the token by Secret reference", () => {
    const docs = render();
    expect(of(docs, "Deployment")).toHaveLength(1);
    expect(of(docs, "Service")[0].spec.ports[0]).toEqual({ name: "http", port: 8080, targetPort: "http" });
    expect(envOf(docs).SLAUDE_SANDBOX_MCP_TOKEN).toEqual({ secretKeyRef: { name: "sandbox-token", key: "SLAUDE_SANDBOX_MCP_TOKEN" } });
    expect(server(docs).containers[0].readinessProbe.httpGet.path).toBe("/healthz");
  }, T);

  test("backend k8s: a ServiceAccount and a Role on pods, exec and claims in the sandbox namespace only", () => {
    const docs = render("k8s.namespace=sandboxes");
    const role = of(docs, "Role")[0];
    expect(role.metadata.namespace).toBe("sandboxes");
    const resources = role.rules.flatMap((r: any) => r.resources).sort();
    expect(resources).toEqual(["persistentvolumeclaims", "pods", "pods/exec"]);
    expect(role.rules.flatMap((r: any) => r.verbs)).not.toContain("*");
    expect(of(docs, "ClusterRole")).toEqual([]);
    const binding = of(docs, "RoleBinding")[0];
    expect(binding.subjects).toEqual([{ kind: "ServiceAccount", name: "s-sandbox", namespace: "sbx" }]);
    expect(server(docs).serviceAccountName).toBe("s-sandbox");
    expect(envOf(docs).SANDBOX_NAMESPACE).toBe("sandboxes");
  }, T);

  test("another backend gets no RBAC and no API token", () => {
    const docs = render("backend=docker");
    expect(of(docs, "Role")).toEqual([]);
    expect(of(docs, "ServiceAccount")).toEqual([]);
    expect(server(docs).automountServiceAccountToken).toBe(false);
    expect(envOf(docs).SANDBOX_NAMESPACE).toBeUndefined();
  }, T);

  test("push token and clone key by Secret reference; remotes and timeouts as env", () => {
    const docs = render("push.tokenSecretRef.name=push", "push.remotes={git@example.com:org/a.git,git@example.com:org/b.git}", "mirrors.cloneKeySecret=clone", "sandbox.idleTtlMinutes=30", "sandbox.keepDays=3");
    const e = envOf(docs);
    expect(e.SLAUDE_GIT_PUSH_TOKEN).toEqual({ secretKeyRef: { name: "push", key: "SLAUDE_GIT_PUSH_TOKEN" } });
    expect(e.SLAUDE_GIT_PUSH_REMOTES).toBe("git@example.com:org/a.git,git@example.com:org/b.git");
    expect(e.SANDBOX_IDLE_TTL_MIN).toBe("30");
    expect(e.SANDBOX_KEEP_DAYS).toBe("3");
    expect(e.SANDBOX_CLONE_SSH_COMMAND).toContain("/etc/sandbox/clone/id");
    expect(server(docs).volumes).toContainEqual({ name: "clone-key", secret: { secretName: "clone", defaultMode: 0o400 } });
    expect(of(docs, "Secret")).toEqual([]);
  }, T);

  test("network policies: only slaude may call the server; sandbox pods take no inbound connection", () => {
    expect(of(render(), "NetworkPolicy")).toEqual([]);
    const pols = of(render("networkPolicy.enabled=true"), "NetworkPolicy");
    const srv = pols.find((p) => p.metadata.name === "s-sandbox-server");
    expect(srv.spec.ingress[0].from[0].podSelector.matchLabels).toEqual({ "app.kubernetes.io/name": "slaude" });
    const box = pols.find((p) => p.metadata.name === "s-sandbox-sandboxes");
    expect(box.spec.podSelector.matchExpressions).toEqual([{ key: "sandbox/session", operator: "Exists" }]);
    expect(box.spec.ingress).toEqual([]);
    expect(box.spec.policyTypes).toEqual(["Ingress", "Egress"]);
  }, T);

  test("refuses to render without the image or the token Secret", () => {
    expect(helm(["tokenSecretRef.name=t"]).stderr.toString()).toContain("image.repository is required");
    expect(helm(["image.repository=r"]).stderr.toString()).toContain("tokenSecretRef.name is required");
  }, T);
});
