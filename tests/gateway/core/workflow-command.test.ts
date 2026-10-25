import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as Workflow from "../../../src/db/workflow";
import { handleParticipantCommand, handleWorkflowCommand, startWorkflow } from "../../../src/gateway/core/workflow-command";
import { FactoryError, type FactoryClient } from "../../../src/workflow/client";

let replies: string[];
const calls: any[] = [];
function client(over: Partial<Record<keyof FactoryClient, (...a: any[]) => Promise<any>>> = {}): FactoryClient {
  return {
    startRun: async (i: any) => { calls.push(["start", i]); return over.startRun ? over.startRun(i) : { runId: `run-${i.channelId}-${i.threadTs}`, pipeline: i.pipeline, pipelineVersion: 1 }; },
    approve: async (...a: any[]) => { calls.push(["approve", ...a]); return {}; },
    cancel: async (...a: any[]) => { calls.push(["cancel", ...a]); return over.cancel ? over.cancel(...a) : {}; },
  } as FactoryClient;
}
const ctx = (over: Partial<{ userId: string; isManager: boolean }> = {}) => ({
  channelId: "C1", threadTs: "1.0", userId: over.userId ?? "U_A", sessionId: "S1", isManager: over.isManager ?? false,
  reply: async (t: string) => { replies.push(t); },
});

beforeEach(async () => {
  process.env.SLAUDE_WORKFLOW = "1";
  process.env.SLAUDE_WORKFLOW_SERVICE_URL = "https://factory.test";
  await Workflow._wipeForTests();
  replies = []; calls.length = 0;
});
afterEach(() => { delete process.env.SLAUDE_WORKFLOW; delete process.env.SLAUDE_WORKFLOW_SERVICE_URL; });

describe("/workflow", () => {
  it("off (flag or URL missing) → not enabled, nothing written, factory not called", async () => {
    delete process.env.SLAUDE_WORKFLOW;
    await handleWorkflowCommand({ kind: "workflow", action: "start", pipeline: "ticket", request: "" }, ctx(), client());
    process.env.SLAUDE_WORKFLOW = "1"; delete process.env.SLAUDE_WORKFLOW_SERVICE_URL;
    await handleParticipantCommand({ kind: "participant", action: "list" }, ctx());
    expect(replies.every((r) => r.includes("not enabled"))).toBe(true);
    expect(calls).toEqual([]);
    expect(await Workflow.find("C1", "1.0")).toBeNull();
  });

  it("start records the typer as starter and calls the factory with run-<channel>-<thread>", async () => {
    await handleWorkflowCommand({ kind: "workflow", action: "start", pipeline: "ticket", ticketRef: "PL-9", request: "" }, ctx(), client());
    expect(calls[0][1]).toEqual({ pipeline: "ticket", channelId: "C1", threadTs: "1.0", sessionId: "S1", starter: "U_A", ticketRef: "PL-9", request: "(see the thread)" });
    const row = await Workflow.running("C1", "1.0");
    expect([row?.run_id, row?.starter_user_id, row?.ticket_ref]).toEqual(["run-C1-1.0", "U_A", "PL-9"]);
    expect(replies[0]).toContain("`ticket@1` started for PL-9");
  });

  it("a second start in the thread is refused without calling the factory", async () => {
    await startWorkflow({ channelId: "C1", threadTs: "1.0", sessionId: "S1", starter: "U_A", pipeline: "ticket", request: "x" }, client());
    const r = await startWorkflow({ channelId: "C1", threadTs: "1.0", sessionId: "S1", starter: "U_B", pipeline: "ticket", request: "x" }, client());
    expect(r).toEqual({ ok: false, message: expect.stringContaining("already has a running workflow") });
    expect(calls.filter((c) => c[0] === "start")).toHaveLength(1);
  });

  it("a factory error (unknown pipeline) closes the thread row and says why", async () => {
    const r = await startWorkflow({ channelId: "C1", threadTs: "1.0", sessionId: "S1", starter: "U_A", pipeline: "nope", request: "x" },
      client({ startRun: async () => { throw new FactoryError(422, 'unknown pipeline "nope"'); } }));
    expect(r).toEqual({ ok: false, message: ':x: unknown pipeline "nope"' });
    expect(await Workflow.running("C1", "1.0")).toBeNull();
  });

  it("status shows stage, starter and participants; cancel is starter or manager only", async () => {
    await startWorkflow({ channelId: "C1", threadTs: "1.0", sessionId: "S1", starter: "U_A", pipeline: "ticket", request: "x" }, client());
    await Workflow.beginStage("run-C1-1.0", "triage", 2, "r2");
    await Workflow.addParticipant("C1", "1.0", "U_B", "U_A");
    await handleWorkflowCommand({ kind: "workflow", action: "status" }, ctx(), client());
    expect(replies[0]).toContain("stage *triage* (attempt 2)");
    expect(replies[0]).toContain("<@U_B>");
    await handleWorkflowCommand({ kind: "workflow", action: "cancel" }, ctx({ userId: "U_B" }), client());
    expect(replies[1]).toContain("Only <@U_A>");
    await handleWorkflowCommand({ kind: "workflow", action: "cancel" }, ctx({ userId: "U_M", isManager: true }), client());
    expect(calls.at(-1)).toEqual(["cancel", "run-C1-1.0", "U_M"]);
  });
});

describe("/participant", () => {
  beforeEach(async () => { await startWorkflow({ channelId: "C1", threadTs: "1.0", sessionId: "S1", starter: "U_A", pipeline: "ticket", request: "x" }, client()); replies = []; });

  it("the starter or a manager adds and removes; a participant cannot; list is open", async () => {
    await handleParticipantCommand({ kind: "participant", action: "add", userIds: ["U_B", "U_A"] }, ctx());
    expect(await Workflow.participants("C1", "1.0")).toEqual(["U_B"]);
    await handleParticipantCommand({ kind: "participant", action: "add", userIds: ["U_C"] }, ctx({ userId: "U_B" }));
    expect(replies.at(-1)).toContain("Only <@U_A>");
    await handleParticipantCommand({ kind: "participant", action: "add", userIds: ["U_C"] }, ctx({ userId: "U_M", isManager: true }));
    await handleParticipantCommand({ kind: "participant", action: "remove", userIds: ["U_B"] }, ctx());
    expect(await Workflow.participants("C1", "1.0")).toEqual(["U_C"]);
    await handleParticipantCommand({ kind: "participant", action: "list" }, ctx({ userId: "U_Z" }));
    expect(replies.at(-1)).toBe("May approve stages: <@U_A> (starter), <@U_C>.");
  });

  it("needs a running workflow", async () => {
    await Workflow.finish("run-C1-1.0");
    await handleParticipantCommand({ kind: "participant", action: "add", userIds: ["U_B"] }, ctx());
    expect(replies[0]).toContain("Start a workflow first");
  });
});
