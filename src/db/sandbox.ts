import { db } from "./schema";

export interface SandboxThreadRow {
  channel_id: string;
  thread_ts: string;
  created_by: string;
  created_at: number;
}

/** Turn sandbox mode on for a thread: its shell and file tools run on the sandbox
 *  MCP server (SLAUDE_SANDBOX_MCP_URL) instead of here. Upsert — re-setting
 *  refreshes created_by. */
export async function set(input: { channelId: string; threadTs: string; createdBy: string }): Promise<void> {
  await db.run(
    `INSERT INTO sandbox_threads (channel_id, thread_ts, created_by, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(channel_id, thread_ts)
     DO UPDATE SET created_by = excluded.created_by, created_at = excluded.created_at`,
    [input.channelId, input.threadTs, input.createdBy, Date.now()],
  );
}

/** Turn it off. Returns the removed row, or null when it was not on. */
export async function clear(channelId: string, threadTs: string): Promise<SandboxThreadRow | null> {
  const row = await find(channelId, threadTs);
  if (row) await db.run("DELETE FROM sandbox_threads WHERE channel_id = ? AND thread_ts = ?", [channelId, threadTs]);
  return row;
}

export async function find(channelId: string, threadTs: string): Promise<SandboxThreadRow | null> {
  return db.one<SandboxThreadRow>("SELECT * FROM sandbox_threads WHERE channel_id = ? AND thread_ts = ?", [
    channelId,
    threadTs,
  ]);
}

export async function _wipeForTests(): Promise<void> {
  await db.run("DELETE FROM sandbox_threads");
}
