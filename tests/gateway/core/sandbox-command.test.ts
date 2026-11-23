import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as CronJobs from "../../../src/db/cron-jobs";
import * as Envs from "../../../src/db/environments";
import * as OneOnOne from "../../../src/db/one-on-one";
import * as Remote from "../../../src/db/remote";
import * as Sandbox from "../../../src/db/sandbox";
import { __resetMasterKeyCache } from "../../../src/db/crypto";
import { handleEnvCommand, type EnvCommandDeps } from "../../../src/gateway/core/env-command";
import { handleSandboxCommand, type SandboxCommandCtx, type SandboxCommandDeps } from "../../../src/gateway/core/sandbox-command";

let replies: string[], notes: string[], reloads: number, destroyed: string[];
const ctx = (over: Partial<{ userId: string; isManager: boolean }> = {}): SandboxCommandCtx => ({
  teamId: "T1", channelId: "C1", threadTs: "1.0", userId: over.userId ?? "U_A", sessionId: "S1", isManager: over.isManager ?? false,
  reply: async (t: string) => { replies.push(t); },
  sayPrivately: async () => {},
  reload: () => { reloads++; },
  reloadAfterTurn: () => { reloads++; },
  note: (t: string) => { notes.push(t); },
});
const deps = (ok = true): SandboxCommandDeps => ({
  destroy: async (sid) => { destroyed.push(sid); return ok; },
  envCleanup: async () => {},
});
const envDeps = (): EnvCommandDeps => ({
  preflight: async (i) => ({ ok: true, dir: i.dir }),
  cleanup: async () => {},
  status: async () => "reachable",
  provision: (async () => {}) as never,
  generateKeyPair: (c) => ({ privateKey: `PRIV-${c}`, publicKey: `ssh-ed25519 AAAA ${c}` }),
  validKey: () => true,
  listForeignThreadCrons: CronJobs.countForeignThreadJobs,
  destroySandbox: async (sid) => { destroyed.push(sid); return true; },
});
const on = { kind: "sandbox", action: "on" } as const;
const off = { kind: "sandbox", action: "off" } as const;
const status = { kind: "sandbox", action: "status" } as const;

beforeEach(async () => {
  process.env.SLAUDE_SANDBOX_MCP_URL = "https://sandbox.test/mcp";
  process.env.SLAUDE_SANDBOX = "1";
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  __resetMasterKeyCache();
  await Sandbox._wipeForTests();
  await Remote._wipeForTests();
  await OneOnOne._wipeForTests();
  replies = []; notes = []; reloads = 0; destroyed = [];
});
afterEach(() => {
  delete process.env.SLAUDE_SANDBOX_MCP_URL;
  delete process.env.SLAUDE_SANDBOX;
  delete process.env.SLAUDE_REMOTE;
  delete process.env.SLAUDE_SANDBOX_AUTO_USERS;
});

describe("/sandbox", () => {
  it("SLAUDE_SANDBOX off: refused even with the URL set, nothing stored", async () => {
    delete process.env.SLAUDE_SANDBOX;
    await handleSandboxCommand(on, ctx(), deps());
    expect(replies[0]).toContain("not enabled");
    expect(await Sandbox.find("C1", "1.0")).toBeNull();
  });

  it("no URL: refused, nothing stored", async () => {
    delete process.env.SLAUDE_SANDBOX_MCP_URL;
    await handleSandboxCommand(on, ctx(), deps());
    expect(replies[0]).toContain("not enabled");
    expect(await Sandbox.find("C1", "1.0")).toBeNull();
  });

  it("on stores the flag and reloads; status reports it; on again changes nothing", async () => {
    await handleSandboxCommand(on, ctx(), deps());
    expect(await Sandbox.find("C1", "1.0")).not.toBeNull();
    expect(reloads).toBe(1);
    await handleSandboxCommand(status, ctx(), deps());
    expect(replies[1]).toContain("*on*");
    await handleSandboxCommand(on, ctx(), deps());
    expect(replies[2]).toContain("already on");
    expect(reloads).toBe(1);
  });

  it("off clears the flag, destroys the sandbox, notes the transcript, reloads", async () => {
    await Sandbox.set({ channelId: "C1", threadTs: "1.0", createdBy: "U_A" });
    await handleSandboxCommand(off, ctx({ userId: "U_B" }), deps());
    expect(await Sandbox.find("C1", "1.0")).toBeNull();
    expect(destroyed).toEqual(["S1"]);
    expect(notes[0]).toContain("destroyed");
    expect(reloads).toBe(1);
    expect(replies[0]).toContain("destroyed");
  });

  it("off when the destroy fails still turns the mode off and says so", async () => {
    await Sandbox.set({ channelId: "C1", threadTs: "1.0", createdBy: "U_A" });
    await handleSandboxCommand(off, ctx(), deps(false));
    expect(await Sandbox.find("C1", "1.0")).toBeNull();
    expect(replies[0]).toContain("did not confirm");
  });

  it("off when not on: nothing destroyed, no reload", async () => {
    await handleSandboxCommand(off, ctx(), deps());
    expect(replies[0]).toContain("not on");
    expect(destroyed).toEqual([]);
    expect(reloads).toBe(0);
  });

  it("an allowlist limits on and off to its users; status stays open; unset or * means everyone", async () => {
    process.env.SLAUDE_SANDBOX_AUTO_USERS = "U_A, U_C";
    await handleSandboxCommand(on, ctx({ userId: "U_B" }), deps());
    expect(replies[0]).toContain("may not switch");
    expect(await Sandbox.find("C1", "1.0")).toBeNull();
    await handleSandboxCommand(on, ctx({ userId: "U_A" }), deps());
    expect(await Sandbox.find("C1", "1.0")).not.toBeNull();
    await handleSandboxCommand(off, ctx({ userId: "U_B" }), deps());
    expect(await Sandbox.find("C1", "1.0")).not.toBeNull();
    expect(destroyed).toEqual([]);
    await handleSandboxCommand(status, ctx({ userId: "U_B" }), deps());
    expect(replies.at(-1)).toContain("*on*");
    process.env.SLAUDE_SANDBOX_AUTO_USERS = "*";
    await handleSandboxCommand(off, ctx({ userId: "U_B" }), deps());
    expect(await Sandbox.find("C1", "1.0")).toBeNull();
    process.env.SLAUDE_SANDBOX_AUTO_USERS = "";
    await handleSandboxCommand(on, ctx({ userId: "U_B" }), deps());
    expect(await Sandbox.find("C1", "1.0")).not.toBeNull();
  });

  it("on in a thread bound to its owner's environment ends it and releases the lock the binding took", async () => {
    process.env.SLAUDE_REMOTE = "1";
    await Remote.putKeyIfAbsent("T1", "U_A", { privateKey: "PRIV", publicKey: "PUB" });
    await Envs.createEnv({ teamId: "T1", userId: "U_A", name: "lap", kind: "tailcat", config: { addr: "tcA" }, defaultDir: "/r" });
    await handleEnvCommand({ kind: "env", action: "use", name: "lap" }, ctx(), envDeps());
    expect(await Envs.findBinding("C1", "1.0")).not.toBeNull();
    expect(await OneOnOne.find("C1", "1.0")).not.toBeNull();
    replies = [];
    await handleSandboxCommand(on, ctx(), deps());
    expect(await Envs.findBinding("C1", "1.0")).toBeNull();
    expect(await OneOnOne.find("C1", "1.0")).toBeNull();
    expect(await Sandbox.find("C1", "1.0")).not.toBeNull();
    expect(replies[0]).toContain("environment is off");
  });

  it("on in a thread bound to someone else's environment is refused and keeps the binding", async () => {
    const e = await Envs.createEnv({ teamId: "T1", userId: "U_A", name: "lap", kind: "tailcat", config: { addr: "tcA" } });
    await Envs.bind({ channelId: "C1", threadTs: "1.0", teamId: "T1", envId: e.id, dir: "/r", lockByEnv: false });
    await OneOnOne.lock({ channelId: "C1", threadTs: "1.0", lockedUser: "U_A", createdBy: "U_A", teamId: "T1" });
    await handleSandboxCommand(on, ctx({ userId: "U_B" }), deps());
    expect(await Envs.findBinding("C1", "1.0")).not.toBeNull();
    expect(await Sandbox.find("C1", "1.0")).toBeNull();
    expect(replies[0]).toContain("Only <@U_A>");
  });
});

describe("choosing an environment replaces sandbox mode", () => {
  it("clears the flag, destroys the sandbox and notes the transcript", async () => {
    process.env.SLAUDE_REMOTE = "1";
    await Remote.putKeyIfAbsent("T1", "U_A", { privateKey: "PRIV", publicKey: "PUB" });
    await Envs.createEnv({ teamId: "T1", userId: "U_A", name: "lap", kind: "tailcat", config: { addr: "tcA" }, defaultDir: "/r" });
    await Sandbox.set({ channelId: "C1", threadTs: "1.0", createdBy: "U_A" });
    await handleEnvCommand({ kind: "env", action: "use", name: "lap" }, ctx(), envDeps());
    expect(await Envs.findBinding("C1", "1.0")).not.toBeNull();
    expect(await Sandbox.find("C1", "1.0")).toBeNull();
    expect(destroyed).toEqual(["S1"]);
    expect(notes[0]).toContain("destroyed");
  });

  it("a failed choice leaves sandbox mode on", async () => {
    process.env.SLAUDE_REMOTE = "1";
    await Envs.createEnv({ teamId: "T1", userId: "U_B", name: "theirs", kind: "tailcat", config: { addr: "tcB" }, defaultDir: "/r" });
    await Sandbox.set({ channelId: "C1", threadTs: "1.0", createdBy: "U_A" });
    await handleEnvCommand({ kind: "env", action: "use", name: "theirs" }, ctx(), envDeps());
    expect(await Sandbox.find("C1", "1.0")).not.toBeNull();
    expect(destroyed).toEqual([]);
  });
});
