import { db } from "./schema";

export interface WorkflowThreadRow {
  channel_id: string;
  thread_ts: string;
  session_id: string;
  run_id: string;
  pipeline: string;
  ticket_ref: string | null;
  starter_user_id: string;
  stage: string | null;
  attempt: number;
  status: "running" | "finished";
  last_request_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface ParticipantRow {
  channel_id: string;
  thread_ts: string;
  user_id: string;
  added_by: string;
  added_at: number;
}

/** Record a new run for a thread. A finished run in the same thread is replaced; its participants go with it. */
export async function start(i: { channelId: string; threadTs: string; sessionId: string; runId: string; pipeline: string; ticketRef?: string; starter: string }): Promise<void> {
  const now = Date.now();
  await db.run("DELETE FROM workflow_participants WHERE channel_id = ? AND thread_ts = ?", [i.channelId, i.threadTs]);
  await db.run(
    `INSERT INTO workflow_threads (channel_id, thread_ts, session_id, run_id, pipeline, ticket_ref, starter_user_id, stage, attempt, status, last_request_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, 'running', NULL, ?, ?)
     ON CONFLICT(channel_id, thread_ts) DO UPDATE SET
       session_id = excluded.session_id, run_id = excluded.run_id, pipeline = excluded.pipeline,
       ticket_ref = excluded.ticket_ref, starter_user_id = excluded.starter_user_id, stage = NULL,
       attempt = 0, status = 'running', last_request_id = NULL, created_at = excluded.created_at, updated_at = excluded.updated_at`,
    [i.channelId, i.threadTs, i.sessionId, i.runId, i.pipeline, i.ticketRef ?? null, i.starter, now, now],
  );
}

export async function find(channelId: string, threadTs: string): Promise<WorkflowThreadRow | null> {
  return db.one<WorkflowThreadRow>("SELECT * FROM workflow_threads WHERE channel_id = ? AND thread_ts = ?", [channelId, threadTs]);
}

export async function findByRun(runId: string): Promise<WorkflowThreadRow | null> {
  return db.one<WorkflowThreadRow>("SELECT * FROM workflow_threads WHERE run_id = ?", [runId]);
}

/** A running run in this thread, or null. */
export async function running(channelId: string, threadTs: string): Promise<WorkflowThreadRow | null> {
  const row = await find(channelId, threadTs);
  return row && row.status === "running" ? row : null;
}

/**
 * Record that a stage turn was requested. Returns false when `requestId` was already
 * seen (an activity retry), so the caller must not start the turn again.
 */
export async function beginStage(runId: string, stage: string, attempt: number, requestId: string): Promise<boolean> {
  const row = await findByRun(runId);
  if (!row) throw new Error(`unknown run ${runId}`);
  if (row.last_request_id === requestId) return false;
  await db.run("UPDATE workflow_threads SET stage = ?, attempt = ?, last_request_id = ?, updated_at = ? WHERE run_id = ?", [stage, attempt, requestId, Date.now(), runId]);
  return true;
}

export async function finish(runId: string): Promise<WorkflowThreadRow | null> {
  const row = await findByRun(runId);
  if (!row) return null;
  await db.run("UPDATE workflow_threads SET status = 'finished', updated_at = ? WHERE run_id = ?", [Date.now(), runId]);
  return row;
}

export async function addParticipant(channelId: string, threadTs: string, userId: string, addedBy: string): Promise<void> {
  await db.run(
    `INSERT INTO workflow_participants (channel_id, thread_ts, user_id, added_by, added_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(channel_id, thread_ts, user_id) DO NOTHING`,
    [channelId, threadTs, userId, addedBy, Date.now()],
  );
}

export async function removeParticipant(channelId: string, threadTs: string, userId: string): Promise<boolean> {
  const had = await db.one("SELECT 1 AS x FROM workflow_participants WHERE channel_id = ? AND thread_ts = ? AND user_id = ?", [channelId, threadTs, userId]);
  if (had) await db.run("DELETE FROM workflow_participants WHERE channel_id = ? AND thread_ts = ? AND user_id = ?", [channelId, threadTs, userId]);
  return !!had;
}

export async function participants(channelId: string, threadTs: string): Promise<string[]> {
  const rows = await db.query<ParticipantRow>("SELECT * FROM workflow_participants WHERE channel_id = ? AND thread_ts = ? ORDER BY added_at", [channelId, threadTs]);
  return rows.map((r) => r.user_id);
}

/** The starter or a participant of the thread's running run. */
export async function isApprover(channelId: string, threadTs: string, userId: string): Promise<boolean> {
  const row = await running(channelId, threadTs);
  if (!row) return false;
  if (row.starter_user_id === userId) return true;
  return (await participants(channelId, threadTs)).includes(userId);
}

export async function _wipeForTests(): Promise<void> {
  await db.run("DELETE FROM workflow_participants");
  await db.run("DELETE FROM workflow_threads");
}
