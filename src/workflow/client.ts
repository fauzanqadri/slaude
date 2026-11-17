import { env } from "../config/env";

const TIMEOUT_MS = 15_000;

/** An answer from the factory API that is not a success; `status` 0 = unreachable. */
export class FactoryError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface StartRunInput {
  pipeline: string;
  channelId: string;
  threadTs: string;
  sessionId: string;
  starter: string;
  ticketRef?: string;
  request: string;
}

export interface ApprovalInput {
  gateId: string;
  stage: string;
  attempt?: number;
  decision: "approve" | "reject";
  by: string;
  outcome?: string;
  note?: string;
}

async function call<T>(path: string, body: unknown): Promise<T> {
  const base = env.workflow.serviceUrl();
  if (!base) throw new FactoryError(0, "SLAUDE_WORKFLOW_SERVICE_URL is empty");
  const token = env.workflow.serviceToken();
  let res: Response;
  try {
    res = await fetch(new URL(path, base), {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new FactoryError(0, `factory unreachable: ${(e as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { msg = (JSON.parse(text) as { error?: string }).error ?? text; } catch {}
    throw new FactoryError(res.status, msg || `factory returned ${res.status}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

/** The factory API (framework docs/04-http-contract.md). */
export const factory = {
  startRun: (i: StartRunInput) => call<{ runId: string; pipeline: string; pipelineVersion: number }>("/runs", i),
  approve: (runId: string, a: ApprovalInput) => call<Record<string, never>>(`/runs/${encodeURIComponent(runId)}/approvals`, a),
  cancel: (runId: string, by: string) => call<Record<string, never>>(`/runs/${encodeURIComponent(runId)}/cancel`, { by }),
};
export type FactoryClient = typeof factory;
