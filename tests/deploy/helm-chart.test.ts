/**
 * The slaude chart's values: the mono topology, sandbox mode, the agent API
 * client registry, and what the schema refuses. The scale topology's objects
 * are pinned to deploy/k8s-scale by helm-parity.test.ts. Needs helm; skipped
 * without it.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";

const root = join(import.meta.dir, "../..");
const hasHelm = Bun.spawnSync(["sh", "-c", "command -v helm"]).exitCode === 0;
if (!hasHelm) console.warn("helm-chart: helm not on PATH; skipped");

const helm = (...args: string[]) => Bun.spawnSync(["helm", "template", "t", "deploy/helm/slaude", "-n", "ns", ...args], { cwd: root });
const render = (...sets: string[]): any[] => {
  const r = helm(...sets.flatMap((s) => ["--set", s]));
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return parseAllDocuments(r.stdout.toString()).map((d) => d.toJSON()).filter(Boolean);
};
const refused = (...sets: string[]): string => {
  const r = helm(...sets.flatMap((s) => ["--set", s]));
  expect(r.exitCode).not.toBe(0);
  return r.stderr.toString();
};
const deployments = (docs: any[]) => docs.filter((d) => d.kind === "Deployment");
const container = (d: any) => d.spec.template.spec.containers[0];
const envOf = (c: any) => Object.fromEntries((c.env ?? []).map((e: any) => [e.name, e.value ?? e.valueFrom]));
const SCALE = ["topology=scale", "scale.secrets.gateway=gw", "scale.secrets.node=nd", "scale.nodes[0].label=default", "scale.nodes[0].credentialSecret=cred"];
const T = 30_000;

describe.skipIf(!hasHelm)("slaude chart values", () => {
  test("mono: one Deployment, one replica, a ReadWriteOnce $SLAUDE_HOME, no node or gateway", () => {
    const docs = render("mono.secretName=slaude-secrets");
    const deps = deployments(docs);
    expect(deps.map((d) => d.metadata.name)).toEqual(["slaude"]);
    expect(deps[0].spec.replicas).toBe(1);
    expect(deps[0].spec.strategy.type).toBe("Recreate");
    const pvc = docs.find((d) => d.kind === "PersistentVolumeClaim");
    expect(pvc.spec.accessModes).toEqual(["ReadWriteOnce"]);
    expect(deps[0].spec.template.spec.volumes[0].persistentVolumeClaim.claimName).toBe(pvc.metadata.name);
    const c = container(deps[0]);
    expect(envOf(c).SLAUDE_HOME).toBe("/data");
    expect(c.envFrom).toEqual([{ secretRef: { name: "slaude-secrets" } }]);
    expect(docs.some((d) => d.kind === "ServiceAccount" || d.kind === "ScaledObject")).toBe(false);
  }, T);

  test("scale: a gateway and a node per label on a ReadWriteMany $SLAUDE_HOME", () => {
    const docs = render(...SCALE, "scale.nodes[1].label=gpu", "scale.nodes[1].credentialSecret=cred-gpu");
    expect(deployments(docs).map((d) => d.metadata.name).sort()).toEqual(["slaude-gateway", "slaude-node", "slaude-node-gpu"]);
    expect(docs.find((d) => d.kind === "PersistentVolumeClaim").spec.accessModes).toEqual(["ReadWriteMany"]);
    const gpu = deployments(docs).find((d) => d.metadata.name === "slaude-node-gpu");
    expect(gpu.spec.template.metadata.labels["slaude.dev/node-label"]).toBe("gpu");
    expect(envOf(container(gpu)).SLAUDE_NODE_TOKEN).toEqual({ secretKeyRef: { name: "cred-gpu", key: "SLAUDE_NODE_TOKEN" } });
  }, T);

  test("sandbox.mcpUrl turns sandbox mode on in every slaude container, the token by Secret reference", () => {
    const sets = ["sandbox.mcpUrl=http://sandbox:8080/mcp", "sandbox.tokenSecretRef.name=sbx", "sandbox.gitPushBranchPattern=^agent/.+$"];
    for (const docs of [render(...sets), render(...SCALE, ...sets)]) {
      for (const d of deployments(docs)) {
        const e = envOf(container(d));
        expect(e.SLAUDE_SANDBOX).toBe("1");
        expect(e.SLAUDE_SANDBOX_MCP_URL).toBe("http://sandbox:8080/mcp");
        expect(e.SLAUDE_SANDBOX_MCP_TOKEN).toEqual({ secretKeyRef: { name: "sbx", key: "SLAUDE_SANDBOX_MCP_TOKEN" } });
        expect(e.SLAUDE_GIT_PUSH_BRANCH_PATTERN).toBe("^agent/.+$");
      }
    }
    for (const d of deployments(render())) expect(envOf(container(d)).SLAUDE_SANDBOX).toBeUndefined();
  }, T);

  test("agentApi mounts the clients ConfigMap at $SLAUDE_HOME/api-clients on the gateway only", () => {
    const docs = render(...SCALE, "agentApi.enabled=true", "agentApi.clientsConfigMap=clients");
    for (const d of deployments(docs)) {
      const mount = container(d).volumeMounts.find((m: any) => m.name === "api-clients");
      if (d.metadata.name === "slaude-gateway") {
        expect(mount).toEqual({ name: "api-clients", mountPath: "/data/api-clients", readOnly: true });
        expect(d.spec.template.spec.volumes).toContainEqual({ name: "api-clients", configMap: { name: "clients" } });
      } else expect(mount).toBeUndefined();
    }
    const mono = deployments(render("agentApi.enabled=true", "agentApi.clientsConfigMap=clients"))[0];
    expect(container(mono).volumeMounts.map((m: any) => m.mountPath)).toContain("/data/api-clients");
    expect(refused("agentApi.enabled=true")).toContain("agentApi.clientsConfigMap is required");
  }, T);

  test("the schema refuses an unknown topology, an unknown top-level key and a bad node label", () => {
    expect(refused("topology=big")).toContain("/topology");
    expect(refused("sandboxx.mcpUrl=x")).toContain("sandboxx");
    expect(refused(...SCALE, "scale.nodes[0].label=Bad_Label")).toContain("label");
    expect(refused("sandbox.mcpUrl=not-a-url")).toContain("mcpUrl");
  }, T);

  test("scale refuses missing Secret names instead of rendering an empty reference", () => {
    expect(refused("topology=scale", "scale.secrets.node=nd", "scale.nodes[0].label=default", "scale.nodes[0].credentialSecret=c")).toContain("scale.secrets.gateway is required");
    expect(refused("topology=scale", "scale.secrets.gateway=gw", "scale.secrets.node=nd")).toContain("credentialSecret is required");
  }, T);
});
