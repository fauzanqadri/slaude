import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as Workflow from "../../src/db/workflow";
import { createWorkflowApi } from "../../src/workflow/api";

const TOKEN = "c".repeat(32);
let turns: Array<[string, string]>;
let posts: Array<[string, string]>;
const api = createWorkflowApi({
  injectTurn: async (row, prompt) => { turns.push([row.run_id, prompt]); },
  post: async (row, text) => { posts.push([row.run_id, text]); },
});
const call = (path: string, body: unknown, token = TOKEN) =>
  api(new Request(`http://slaude${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }));
const turn = (over: Record<string, unknown> = {}) => ({ runId: "run-C1-1.0", stage: "intake", attempt: 1, prompt: "do intake", requestId: "run-C1-1.0:intake:1", ...over });

beforeEach(async () => {
  process.env.SLAUDE_WORKFLOW = "1";
  process.env.SLAUDE_WORKFLOW_SERVICE_URL = "https://factory.test";
  process.env.SLAUDE_WORKFLOW_CALLBACK_TOKEN = TOKEN;
  await Workflow._wipeForTests();
  turns = []; posts = [];
  await Workflow.start({ channelId: "C1", threadTs: "1.0", sessionId: "S1", runId: "run-C1-1.0", pipeline: "ticket", ticketRef: "PL-1", starter: "U_A" });
});
afterEach(() => { for (const k of ["SLAUDE_WORKFLOW", "SLAUDE_WORKFLOW_SERVICE_URL", "SLAUDE_WORKFLOW_CALLBACK_TOKEN"]) delete process.env[k]; });

describe("/workflow/v1 callbacks", () => {
  it("other paths are not ours; off, or a short token, answers 404; a wrong token 401", async () => {
    expect(await api(new Request("http://slaude/v1/x"))).toBeNull();
    delete process.env.SLAUDE_WORKFLOW;
    expect((await call("/workflow/v1/turns", turn()))!.status).toBe(404);
    process.env.SLAUDE_WORKFLOW = "1";
    process.env.SLAUDE_WORKFLOW_CALLBACK_TOKEN = "short";
    expect((await call("/workflow/v1/turns", turn(), "short"))!.status).toBe(404);
    process.env.SLAUDE_WORKFLOW_CALLBACK_TOKEN = TOKEN;
    expect((await call("/workflow/v1/turns", turn(), "x".repeat(32)))!.status).toBe(401);
  });

  it("a turn records the stage and attempt and is injected once per requestId", async () => {
    expect((await call("/workflow/v1/turns", turn({ stage: "triage", attempt: 2, requestId: "r:triage:2" })))!.status).toBe(200);
    const dup = await call("/workflow/v1/turns", turn({ stage: "triage", attempt: 2, requestId: "r:triage:2" }));
    expect(await dup!.json()).toEqual({ duplicate: true });
    expect(turns).toEqual([["run-C1-1.0", "do intake"]]);
    const row = await Workflow.find("C1", "1.0");
    expect([row?.stage, row?.attempt]).toEqual(["triage", 2]);
  });

  it("400 on a bad body, 404 for an unknown run, 409 once the run finished", async () => {
    expect((await call("/workflow/v1/turns", { runId: "run-C1-1.0" }))!.status).toBe(400);
    expect((await call("/workflow/v1/turns", turn({ runId: "run-x" })))!.status).toBe(404);
    await Workflow.finish("run-C1-1.0");
    expect((await call("/workflow/v1/turns", turn()))!.status).toBe(409);
  });

  it("remind names the starter and participants; finish closes the run and posts once", async () => {
    await Workflow.addParticipant("C1", "1.0", "U_B", "U_A");
    expect((await call("/workflow/v1/runs/run-C1-1.0/remind", { stage: "triage" }))!.status).toBe(200);
    expect(posts[0]![1]).toBe(":hourglass: Stage *triage* is still waiting for an approval from <@U_A>, <@U_B>.");
    expect((await call("/workflow/v1/runs/run-C1-1.0/finish", { reason: "answer" }))!.status).toBe(200);
    expect((await call("/workflow/v1/runs/run-C1-1.0/finish", { reason: "answer" }))!.status).toBe(200);
    expect(posts.slice(1)).toEqual([["run-C1-1.0", ":checkered_flag: Workflow `ticket` for PL-1 finished: *answer*."]]);
    expect(await Workflow.running("C1", "1.0")).toBeNull();
  });
});
