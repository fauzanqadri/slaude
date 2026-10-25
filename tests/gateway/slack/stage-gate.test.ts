import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as PendingGates from "../../../src/db/pending-gates";
import * as Workflow from "../../../src/db/workflow";
import { db } from "../../../src/db/schema";
import { StageGate } from "../../../src/gateway/slack/stage-gate";
import type { FactoryClient } from "../../../src/workflow/client";

let handler: (args: any) => Promise<void>;
let posted: any[];
let approvals: any[];
let failApprove = false;
const transport: any = {
  client: { chat: { postMessage: async (m: any) => { posted.push(m); return { ts: "9.9" }; } } },
  action: (_re: RegExp, h: any) => { handler = h; },
};
const client = {
  startRun: async () => ({}),
  approve: async (runId: string, a: any) => { if (failApprove) throw new Error("factory down"); approvals.push([runId, a]); return {}; },
  cancel: async () => ({}),
} as unknown as FactoryClient;

async function click(gateId: string, decision: "approve" | "reject", user: string) {
  const responses: any[] = [];
  await handler({ ack: async () => {}, action: { action_id: `slaude_stage:${decision}:${gateId}` }, body: { user: { id: user } }, respond: async (r: any) => { responses.push(r); } });
  return responses;
}

let gate: StageGate;
beforeEach(async () => {
  process.env.SLAUDE_WORKFLOW = "1";
  process.env.SLAUDE_WORKFLOW_SERVICE_URL = "https://factory.test";
  await Workflow._wipeForTests();
  await db.run("DELETE FROM pending_gates");
  posted = []; approvals = []; failApprove = false;
  gate = new StageGate(transport, { client });
  await Workflow.start({ channelId: "C1", threadTs: "1.0", sessionId: "S1", runId: "run-C1-1.0", pipeline: "ticket", starter: "U_A" });
  await Workflow.addParticipant("C1", "1.0", "U_B", "U_A");
  await Workflow.beginStage("run-C1-1.0", "triage", 2, "r:triage:2");
});
afterEach(() => { delete process.env.SLAUDE_WORKFLOW; delete process.env.SLAUDE_WORKFLOW_SERVICE_URL; });

const post = (over: any = {}) => gate.post({ channel: "C1", threadTs: "1.0", sessionId: "S1", stage: "triage", summary: "Root cause found", outcome: "code", ...over });

describe("stage approval cards", () => {
  it("posts a card naming who may decide and stores stage, attempt and outcome", async () => {
    const r = await post();
    expect("gateId" in r).toBe(true);
    const gateId = (r as any).gateId;
    expect(posted[0].thread_ts).toBe("1.0");
    expect(JSON.stringify(posted[0].blocks)).toContain("<@U_A>, <@U_B>");
    expect(JSON.stringify(posted[0].blocks)).toContain(`slaude_stage:approve:${gateId}`);
    const row = await PendingGates.get(gateId);
    expect(row?.payload).toMatchObject({ type: "stage", runId: "run-C1-1.0", stage: "triage", attempt: 2, outcome: "code" });
  });

  it("refuses a card for another stage, a thread with no run, or when the flag is off", async () => {
    expect(await post({ stage: "planning" })).toEqual({ error: 'The workflow is at stage "triage", not "planning".' });
    expect(await gate.post({ channel: "C1", threadTs: "2.0", sessionId: "S2", stage: "intake", summary: "x" })).toEqual({ error: "No running workflow in this thread." });
    delete process.env.SLAUDE_WORKFLOW;
    expect(await post()).toEqual({ error: "Workflows are not enabled on this deployment." });
  });

  it("a click from someone else is refused and the card stays pending", async () => {
    const { gateId } = (await post()) as any;
    const res = await click(gateId, "approve", "U_X");
    expect(res[0].text).toContain("only this workflow's starter and participants");
    expect(approvals).toEqual([]);
    expect((await PendingGates.get(gateId))?.status).toBe("pending");
  });

  it("a participant approves: the factory gets the signal first, then the card is decided", async () => {
    const { gateId } = (await post()) as any;
    const res = await click(gateId, "approve", "U_B");
    expect(approvals).toEqual([["run-C1-1.0", { gateId, stage: "triage", attempt: 2, decision: "approve", by: "U_B", outcome: "code" }]]);
    expect((await PendingGates.get(gateId))?.status).toBe("approved");
    expect(res[0]).toMatchObject({ replace_original: true, text: "Stage *triage* (attempt 2) → *Approved* by <@U_B>" });
    expect((await click(gateId, "approve", "U_A"))[0].text).toContain("already decided");
    expect(approvals).toHaveLength(1);
  });

  it("if the factory is unreachable the card stays clickable", async () => {
    const { gateId } = (await post()) as any;
    failApprove = true;
    const res = await click(gateId, "approve", "U_A");
    expect(res[0].text).toContain("Could not reach the workflow");
    expect((await PendingGates.get(gateId))?.status).toBe("pending");
  });

  it("reject sends a note pointing at the thread and no outcome", async () => {
    const { gateId } = (await post()) as any;
    await click(gateId, "reject", "U_A");
    expect(approvals[0][1]).toEqual({ gateId, stage: "triage", attempt: 2, decision: "reject", by: "U_A", note: "Rejected by <@U_A>; the reason is in the thread." });
    expect((await PendingGates.get(gateId))?.status).toBe("denied");
  });

  it("with the flag off a click is refused and the card stays pending", async () => {
    const { gateId } = (await post()) as any;
    delete process.env.SLAUDE_WORKFLOW;
    const res = await click(gateId, "approve", "U_A");
    expect(res[0].text).toContain("disabled");
    expect((await PendingGates.get(gateId))?.status).toBe("pending");
  });
});
