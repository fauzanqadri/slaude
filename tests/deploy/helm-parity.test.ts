/**
 * The slaude chart's `scale` topology against the plain manifests. With
 * tests/deploy/fixtures/scale-values.yaml, `helm template` must emit exactly
 * what `kubectl kustomize deploy/k8s-scale` emits, apart from the Secrets and
 * the Namespace the chart never creates. The optional manifests (CPU HPA,
 * node egress policy) are matched by the values that turn them on. And the
 * local overlay built on the chart (deploy/k8s-local/helm-overlay.ts) must
 * equal the plain local overlay, object for object.
 *
 * Needs helm and kubectl; skipped without them.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAllDocuments } from "yaml";
import { stageLocal } from "./stage-local";

const root = join(import.meta.dir, "../..");
const has = (bin: string) => Bun.spawnSync(["sh", "-c", `command -v ${bin}`]).exitCode === 0;
const tools = has("helm") && has("kubectl");
if (!tools) console.warn("helm-parity: helm or kubectl not on PATH; skipped");

const parse = (text: string): any[] => parseAllDocuments(text).map((d) => d.toJSON()).filter(Boolean);
const run = (cmd: string[]): string => {
  const r = Bun.spawnSync(cmd, { cwd: root });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed: ${r.stderr.toString()}`);
  return r.stdout.toString();
};
const kustomize = (dir: string) => parse(run(["kubectl", "kustomize", "--load-restrictor", "LoadRestrictionsNone", dir]));
const FIXTURE = "tests/deploy/fixtures/scale-values.yaml";
const render = (...sets: string[]) =>
  parse(run(["helm", "template", "slaude", "deploy/helm/slaude", "-n", "slaude-scale", "-f", FIXTURE, ...sets.flatMap((s) => ["--set", s])]));

const key = (d: any) => `${d.kind}/${d.metadata?.name}`;
/** node.json is compared as JSON: the chart pretty-prints it, the manifest is hand-written. */
const normalise = (d: any) => {
  const node = d.kind === "ConfigMap" && d.data?.["node.json"];
  return node ? { ...d, data: { ...d.data, "node.json": JSON.parse(node) } } : d;
};
const byKey = (docs: any[]) => Object.fromEntries(docs.map((d) => [key(d), normalise(d)]));

const tmp = mkdtempSync(join(tmpdir(), "slaude-helm-parity-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe.skipIf(!tools)("slaude chart, scale topology", () => {
  test("renders deploy/k8s-scale exactly (Secrets and the Namespace excepted)", () => {
    const plain = kustomize("deploy/k8s-scale").filter((d) => d.kind !== "Secret" && d.kind !== "Namespace");
    expect(byKey(render())).toEqual(byKey(plain));
  }, 60_000);

  test("autoscale.mode=hpa renders optional/node-cpu-fallback-hpa.yaml instead of the ScaledObjects", () => {
    const docs = render("scale.autoscale.mode=hpa");
    expect(docs.filter((d) => d.kind === "ScaledObject")).toEqual([]);
    const hpas = docs.filter((d) => d.kind === "HorizontalPodAutoscaler");
    const plain = parse(readFileSync(join(root, "deploy/k8s-scale/optional/node-cpu-fallback-hpa.yaml"), "utf8"));
    expect(byKey(hpas)).toEqual(byKey(plain));
  }, 60_000);

  test("egressPolicy.enabled renders optional/node-egress-networkpolicy.yaml", () => {
    const docs = render("scale.egressPolicy.enabled=true").filter((d) => d.kind === "NetworkPolicy");
    const plain = parse(readFileSync(join(root, "deploy/k8s-scale/optional/node-egress-networkpolicy.yaml"), "utf8"));
    expect(byKey(docs)).toEqual(byKey(plain));
  }, 60_000);

  test("the local overlay on the chart equals the plain local overlay", () => {
    stageLocal(tmp);
    // The staged copy needs the chart too.
    run(["cp", "-R", "deploy/helm", join(tmp, "deploy/helm")]);
    const out = join(tmp, "helm-overlay");
    run(["bun", "deploy/k8s-local/helm-overlay.ts", "--local", join(tmp, "deploy/k8s-local"), "--chart", join(tmp, "deploy/helm/slaude"), "--out", out]);
    expect(byKey(kustomize(out))).toEqual(byKey(kustomize(join(tmp, "deploy/k8s-local"))));
  }, 120_000);
});
