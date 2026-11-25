import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { findClientByToken, hashToken, loadClients } from "../../src/agentapi/clients";

const TOKEN = "t".repeat(40);
const SECRET = "s".repeat(40);
const ENV = { AGENT_API_PROCESS_ENGINE_TOKEN: TOKEN, AGENT_API_PROCESS_ENGINE_SECRET: SECRET };

const VALID = `
name: process-engine
token: { env: AGENT_API_PROCESS_ENGINE_TOKEN }
personas: [support-bot]
channels: ["slack:channel:C0EXAMPLE"]
actions: [git_push]
events:
  url: https://engine.example.internal/slaude/events
  secret: { env: AGENT_API_PROCESS_ENGINE_SECRET }
  notifyHosts: [engine.example.internal]
`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "api-clients-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (file: string, body: string) => writeFileSync(join(dir, file), body);

describe("loadClients", () => {
  test("a missing directory means no clients", async () => {
    expect((await loadClients(join(dir, "absent"), ENV)).size).toBe(0);
  });

  test("a valid file loads with its token hashed and its references normalised", async () => {
    write("process-engine.yaml", VALID);
    const clients = await loadClients(dir, ENV);
    const c = clients.get("process-engine")!;
    expect(c.name).toBe("process-engine");
    expect(c.tokenHash).toBe(createHash("sha256").update(TOKEN).digest("hex"));
    expect(c.personas).toEqual(["support-bot"]);
    expect(c.channels).toEqual(["slack:channel:C0EXAMPLE"]);
    expect(c.actions).toEqual(["git_push"]);
    expect(c.events).toEqual({ url: "https://engine.example.internal/slaude/events", secret: SECRET, notifyHosts: ["engine.example.internal"] });
    expect(JSON.stringify(c)).not.toContain(TOKEN);
  });

  test("tokenSha256 is taken as the hash, and actions and notifyHosts default to empty", async () => {
    const hash = hashToken(TOKEN);
    write("engine.yml", VALID.replace("name: process-engine", "name: engine")
      .replace("token: { env: AGENT_API_PROCESS_ENGINE_TOKEN }", `tokenSha256: ${hash.toUpperCase()}`)
      .replace("actions: [git_push]\n", "")
      .replace("  notifyHosts: [engine.example.internal]\n", ""));
    const c = (await loadClients(dir, ENV)).get("engine")!;
    expect(c.tokenHash).toBe(hash);
    expect(c.actions).toEqual([]);
    expect(c.events.notifyHosts).toEqual([]);
  });

  test("an unknown key fails, at the top and inside events", async () => {
    write("process-engine.yaml", VALID + "extra: 1\n");
    await expect(loadClients(dir, ENV)).rejects.toThrow(/process-engine\.yaml/);
    write("process-engine.yaml", VALID.replace("  notifyHosts", "  retries: 3\n  notifyHosts"));
    await expect(loadClients(dir, ENV)).rejects.toThrow(/retries/);
  });

  test("a missing env reference fails and names the variable, never a value", async () => {
    write("process-engine.yaml", VALID);
    const err = await loadClients(dir, { AGENT_API_PROCESS_ENGINE_TOKEN: TOKEN }).catch((e: Error) => e);
    expect(String(err)).toContain("AGENT_API_PROCESS_ENGINE_SECRET");
    expect(String(err)).not.toContain(TOKEN);
  });

  test("token and tokenSha256 together fail, and so does neither", async () => {
    write("process-engine.yaml", VALID.replace("personas:", `tokenSha256: ${hashToken(TOKEN)}\npersonas:`));
    await expect(loadClients(dir, ENV)).rejects.toThrow(/exactly one of token and tokenSha256/);
    write("process-engine.yaml", VALID.replace("token: { env: AGENT_API_PROCESS_ENGINE_TOKEN }\n", ""));
    await expect(loadClients(dir, ENV)).rejects.toThrow(/exactly one of token and tokenSha256/);
  });

  test("two clients with one token fail, whichever way each gives it", async () => {
    write("process-engine.yaml", VALID);
    write("other.yaml", VALID.replace("name: process-engine", "name: other").replace("token: { env: AGENT_API_PROCESS_ENGINE_TOKEN }", `tokenSha256: ${hashToken(TOKEN)}`));
    await expect(loadClients(dir, ENV)).rejects.toThrow(/same token/);
  });

  test("the name must match the file name", async () => {
    write("engine.yaml", VALID);
    await expect(loadClients(dir, ENV)).rejects.toThrow(/name "process-engine" does not match the file name "engine"/);
  });

  test("a short token, a plain-http event URL and a non-channel reference fail", async () => {
    write("process-engine.yaml", VALID);
    await expect(loadClients(dir, { ...ENV, AGENT_API_PROCESS_ENGINE_TOKEN: "short" })).rejects.toThrow(/at least 32/);
    write("process-engine.yaml", VALID.replace("https://engine", "http://engine"));
    await expect(loadClients(dir, ENV)).rejects.toThrow(/https/);
    write("process-engine.yaml", VALID.replace("slack:channel:C0EXAMPLE", "slack:user:U0EXAMPLE"));
    await expect(loadClients(dir, ENV)).rejects.toThrow(/channel/);
  });

  test("a Kubernetes ConfigMap mount reads through its symlinks and skips its dot entries", async () => {
    const data = join(dir, "..2026_11_25_00_00_00.000000001");
    mkdirSync(data);
    writeFileSync(join(data, "process-engine.yaml"), VALID);
    symlinkSync(data, join(dir, "..data"));
    symlinkSync(join("..data", "process-engine.yaml"), join(dir, "process-engine.yaml"));
    write("README.txt", "not a client");
    expect([...(await loadClients(dir, ENV)).keys()]).toEqual(["process-engine"]);
  });
});

describe("findClientByToken", () => {
  test("matches by hash and refuses anything else", async () => {
    write("process-engine.yaml", VALID);
    const clients = await loadClients(dir, ENV);
    expect(findClientByToken(clients, TOKEN)?.name).toBe("process-engine");
    expect(findClientByToken(clients, TOKEN + "x")).toBeNull();
    expect(findClientByToken(clients, "")).toBeNull();
    expect(findClientByToken(new Map(), TOKEN)).toBeNull();
  });
});
