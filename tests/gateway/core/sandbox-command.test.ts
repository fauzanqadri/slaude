import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as OneOnOne from "../../../src/db/one-on-one";
import * as Remote from "../../../src/db/remote";
import * as Sandbox from "../../../src/db/sandbox";
import { __resetMasterKeyCache } from "../../../src/db/crypto";
import { handleSandboxCommand, type SandboxCommandDeps } from "../../../src/gateway/core/sandbox-command";
import { handleRemoteCommand, type RemoteCommandDeps } from "../../../src/gateway/core/remote-command";
import * as CronJobs from "../../../src/db/cron-jobs";

let replies: string[], notes: string[], reloads: number, destroyed: string[];
const ctx = (over: Partial<{ userId: string; isManager: boolean }> = {}) => ({
  channelId: "C1", threadTs: "1.0", userId: over.userId ?? "U_A", sessionId: "S1", isManager: over.isManager ?? false,
  reply: async (t: string) => { replies.push(t); },
  reloadAfterTurn: () => { reloads++; },
  note: (t: string) => { notes.push(t); },
});
const deps = (ok = true): SandboxCommandDeps => ({
  destroy: async (sid) => { destroyed.push(sid); return ok; },
  remoteCleanup: async () => {},
});
const on = { kind: "sandbox", action: "on" } as const;
const off = { kind: "sandbox", action: "off" } as const;
const status = { kind: "sandbox", action: "status" } as const;

beforeEach(async () => {
  process.env.SLAUDE_SANDBOX_MCP_URL = "https://sandbox.test/mcp";
  process.env.SLAUDE_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  __resetMasterKeyCache();
  await Sandbox._wipeForTests();
  await Remote._wipeForTests();
  await OneOnOne._wipeForTests();
  replies = []; notes = []; reloads = 0; destroyed = [];
});
afterEach(() => {
  delete process.env.SLAUDE_SANDBOX_MCP_URL;
  delete process.env.SLAUDE_REMOTE;
  delete process.env.SLAUDE_SANDBOX_AUTO_USERS;
});

describe("/sandbox", () => {
  it("not configured → refused, nothing stored", async () => {
    delete process.env.SLAUDE_SANDBOX_MCP_URL;
    await handleSandboxCommand(on, ctx(), deps());
    expect(replies[0]).toContain("not configured");
    expect(await Sandbox.find("C1", "1.0")).toBeNull();
  });

  it("on stores the flag and reloads after the turn; status reports it; on again is a no-op", async () => {
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

  it("an allowlist limits on and off to its users; status stays open; unset or * = everyone", async () => {
    process.env.SLAUDE_SANDBOX_AUTO_USERS = "U_A, U_C";
    await handleSandboxCommand(on, ctx({ userId: "U_B" }), deps());
    expect(replies[0]).toContain("allowlist");
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

  it("off when not on → nothing destroyed", async () => {
    await handleSandboxCommand(off, ctx(), deps());
    expect(replies[0]).toContain("not on");
    expect(destroyed).toEqual([]);
    expect(reloads).toBe(0);
  });

  it("on in a /remote thread by its owner ends remote mode and releases the lock /remote created", async () => {
    await OneOnOne.lock({ channelId: "C1", threadTs: "1.0", lockedUser: "U_A", createdBy: "U_A" });
    await Remote.setTarget({ channelId: "C1", threadTs: "1.0", teamId: "T1", userId: "U_A", addr: "tcA", dir: "/r", lockByRemote: true });
    await handleSandboxCommand(on, ctx(), deps());
    expect(await Remote.findTarget("C1", "1.0")).toBeNull();
    expect(await OneOnOne.find("C1", "1.0")).toBeNull();
    expect(await Sandbox.find("C1", "1.0")).not.toBeNull();
    expect(replies[0]).toContain("Remote mode is off");
  });

  it("on in someone else's /remote thread is refused and keeps the target", async () => {
    await Remote.setTarget({ channelId: "C1", threadTs: "1.0", teamId: "T1", userId: "U_A", addr: "tcA", dir: "/r", lockByRemote: false });
    await handleSandboxCommand(on, ctx({ userId: "U_B" }), deps());
    expect(await Remote.findTarget("C1", "1.0")).not.toBeNull();
    expect(await Sandbox.find("C1", "1.0")).toBeNull();
    expect(replies[0]).toContain("Only <@U_A>");
  });
});

describe("/remote on replaces sandbox mode", () => {
  it("clears the flag, destroys the sandbox and notes the transcript", async () => {
    process.env.SLAUDE_REMOTE = "1";
    await Remote.putKeyIfAbsent("T1", "U_A", { privateKey: "PRIV", publicKey: "PUB" });
    await Sandbox.set({ channelId: "C1", threadTs: "1.0", createdBy: "U_A" });
    const rdeps: RemoteCommandDeps = {
      preflight: async () => ({ ok: true, dir: "/abs" }),
      ping: async () => "direct",
      cleanup: async () => {},
      generateKeyPair: (c) => ({ privateKey: `PRIV-${c}`, publicKey: `PUB ${c}` }),
      validKey: () => true,
      listForeignThreadCrons: CronJobs.countForeignThreadJobs,
      destroySandbox: async (sid) => { destroyed.push(sid); return true; },
    };
    await handleRemoteCommand({ kind: "remote", action: "on", addr: "tcAddr1", dir: "/r" }, {
      teamId: "T1", channelId: "C1", threadTs: "1.0", userId: "U_A", sessionId: "S1", isManager: false,
      reply: async (t) => { replies.push(t); }, sayPrivately: async () => {}, reload: () => { reloads++; },
      note: (t) => { notes.push(t); },
    }, rdeps);
    expect(await Remote.findTarget("C1", "1.0")).not.toBeNull();
    expect(await Sandbox.find("C1", "1.0")).toBeNull();
    expect(destroyed).toEqual(["S1"]);
    expect(notes[0]).toContain("destroyed");
  });
});
