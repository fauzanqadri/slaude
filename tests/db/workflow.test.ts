import { describe, it, expect, beforeEach } from "bun:test";
import * as Workflow from "../../src/db/workflow";

beforeEach(async () => { await Workflow._wipeForTests(); });
const base = { channelId: "C1", threadTs: "1.0", sessionId: "S1", runId: "run-C1-1.0", pipeline: "ticket", ticketRef: "PL-1", starter: "U_A" };

describe("workflow_threads + participants", () => {
  it("start, find, running, and approver rules (starter + participants only)", async () => {
    await Workflow.start(base);
    expect((await Workflow.running("C1", "1.0"))?.run_id).toBe("run-C1-1.0");
    expect((await Workflow.findByRun("run-C1-1.0"))?.starter_user_id).toBe("U_A");
    await Workflow.addParticipant("C1", "1.0", "U_B", "U_A");
    await Workflow.addParticipant("C1", "1.0", "U_B", "U_A"); // idempotent
    expect(await Workflow.participants("C1", "1.0")).toEqual(["U_B"]);
    expect(await Workflow.isApprover("C1", "1.0", "U_A")).toBe(true);
    expect(await Workflow.isApprover("C1", "1.0", "U_B")).toBe(true);
    expect(await Workflow.isApprover("C1", "1.0", "U_C")).toBe(false);
    expect(await Workflow.removeParticipant("C1", "1.0", "U_B")).toBe(true);
    expect(await Workflow.removeParticipant("C1", "1.0", "U_B")).toBe(false);
  });

  it("beginStage is idempotent on requestId and records stage and attempt", async () => {
    await Workflow.start(base);
    expect(await Workflow.beginStage("run-C1-1.0", "triage", 1, "r:triage:1")).toBe(true);
    expect(await Workflow.beginStage("run-C1-1.0", "triage", 1, "r:triage:1")).toBe(false);
    expect(await Workflow.beginStage("run-C1-1.0", "triage", 2, "r:triage:2")).toBe(true);
    const row = await Workflow.find("C1", "1.0");
    expect([row?.stage, row?.attempt]).toEqual(["triage", 2]);
  });

  it("finish stops approvals; a new start in the thread resets stage and participants", async () => {
    await Workflow.start(base);
    await Workflow.addParticipant("C1", "1.0", "U_B", "U_A");
    await Workflow.finish("run-C1-1.0");
    expect(await Workflow.running("C1", "1.0")).toBeNull();
    expect(await Workflow.isApprover("C1", "1.0", "U_A")).toBe(false);
    await Workflow.start({ ...base, starter: "U_C" });
    expect((await Workflow.running("C1", "1.0"))?.starter_user_id).toBe("U_C");
    expect(await Workflow.participants("C1", "1.0")).toEqual([]);
  });
});
