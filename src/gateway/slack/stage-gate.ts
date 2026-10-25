import { randomBytes } from "node:crypto";
import { env } from "../../config/env";
import * as PendingGates from "../../db/pending-gates";
import * as Workflow from "../../db/workflow";
import { factory, type FactoryClient } from "../../workflow/client";
import { clientForApp, type AppRef, type Transport } from "../core/transport";

export interface StageApprovalRequest {
  channel: string;
  threadTs: string;
  app?: AppRef;
  sessionId: string;
  stage: string;
  summary: string;
  /** What happens after an approval, shown on the card. */
  next?: string;
  /** Set by a classifying stage (triage); forwarded with the approval. */
  outcome?: string;
}

const PREFIX = "slaude_stage";

/**
 * Stage approval cards for ticket workflows. A separate permission from tool cards
 * (permission-gate) and plan approvals (approval-gate): only the run's starter and
 * participants may decide, checked against workflow_threads/workflow_participants on
 * every click. The card has no in-process waiter; the decision goes to the factory as a
 * signal, and the factory starts the next stage. Any replica can handle a click.
 */
export class StageGate {
  #transport: Transport;
  #client: FactoryClient;

  constructor(transport: Transport, deps: { client?: FactoryClient } = {}) {
    this.#transport = transport;
    this.#client = deps.client ?? factory;
    transport.action(new RegExp(`^${PREFIX}:(approve|reject):.+$`), async ({ ack, action, body, respond }) => {
      await ack();
      const m = (action as { action_id: string }).action_id.match(new RegExp(`^${PREFIX}:(approve|reject):(.+)$`));
      if (!m) return;
      const decision = m[1] as "approve" | "reject";
      const gateId = m[2]!;
      const userId: string = (body as any).user?.id ?? "unknown";
      const ephemeral = async (text: string) => { try { await respond({ response_type: "ephemeral", replace_original: false, text }); } catch {} };

      if (!env.workflow.active()) return ephemeral(":no_entry: Workflows are disabled on this deployment; this card stays pending.");
      const row = await PendingGates.get(gateId);
      const p = (row?.payload ?? {}) as { type?: string; runId?: string; stage?: string; attempt?: number; channel?: string; threadTs?: string; outcome?: string };
      if (!row || p.type !== "stage" || row.status !== "pending") return ephemeral(":lock: This stage was already decided.");
      if (!(await Workflow.isApprover(p.channel!, p.threadTs!, userId))) {
        return ephemeral(`:no_entry: <@${userId}>, only this workflow's starter and participants can decide its stages. \`/participant list\` shows who.`);
      }
      // Signal first, resolve second: a failed call leaves the card clickable, so an
      // approval is never shown as decided while the workflow never heard of it.
      try {
        await this.#client.approve(p.runId!, {
          gateId, stage: p.stage!, attempt: p.attempt, decision, by: userId,
          ...(decision === "approve" && p.outcome ? { outcome: p.outcome } : {}),
          // ponytail: no typed note yet; the reason is expected in the thread. A modal can collect it later.
          ...(decision === "reject" ? { note: `Rejected by <@${userId}>; the reason is in the thread.` } : {}),
        });
      } catch (e) {
        return ephemeral(`:warning: Could not reach the workflow (${(e as Error).message}). The card stays open; try again.`);
      }
      const resolved = await PendingGates.resolve(gateId, decision === "approve" ? "approved" : "denied", userId);
      if (!resolved) return ephemeral(":lock: This stage was already decided.");
      try {
        await respond({
          replace_original: true,
          text: `Stage *${p.stage}* (attempt ${p.attempt ?? 1}) → ${decision === "approve" ? "*Approved*" : "*Rejected*"} by <@${userId}>`,
          blocks: [],
        });
      } catch {}
    });
  }

  /** Post the card for the thread's current stage. Returns at once; the decision arrives as a click. */
  async post(req: StageApprovalRequest): Promise<{ gateId: string } | { error: string }> {
    if (!env.workflow.active()) return { error: "Workflows are not enabled on this deployment." };
    const run = await Workflow.running(req.channel, req.threadTs);
    if (!run) return { error: "No running workflow in this thread." };
    if (run.stage && run.stage !== req.stage) return { error: `The workflow is at stage "${run.stage}", not "${req.stage}".` };
    const attempt = run.attempt || 1;
    const people = [run.starter_user_id, ...(await Workflow.participants(req.channel, req.threadTs))];
    const gateId = `${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
    await PendingGates.create({
      id: gateId,
      kind: "approval",
      sessionId: req.sessionId,
      payload: { type: "stage", runId: run.run_id, stage: req.stage, attempt, channel: req.channel, threadTs: req.threadTs, outcome: req.outcome ?? null },
    });
    try {
      await clientForApp(this.#transport, req.app).chat.postMessage({
        channel: req.channel,
        thread_ts: req.threadTs,
        text: `:white_check_mark: Stage "${req.stage}" is ready for approval`,
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: `:white_check_mark: *Stage ${req.stage} ready* (attempt ${attempt})\n${req.summary}` } },
          {
            type: "context",
            elements: [
              { type: "mrkdwn", text: `${req.outcome ? `Outcome: *${req.outcome}* · ` : ""}${req.next ? `Next: ${req.next} · ` : ""}May decide: ${people.map((u) => `<@${u}>`).join(", ")}` },
            ],
          },
          {
            type: "actions",
            elements: [
              { type: "button", style: "primary", text: { type: "plain_text", text: "Approve" }, action_id: `${PREFIX}:approve:${gateId}` },
              { type: "button", style: "danger", text: { type: "plain_text", text: "Reject" }, action_id: `${PREFIX}:reject:${gateId}` },
            ],
          },
        ],
      });
    } catch (e) {
      await PendingGates.resolve(gateId, "cancelled", "system").catch(() => {});
      return { error: `Could not post the approval card: ${(e as Error).message}` };
    }
    return { gateId };
  }
}
