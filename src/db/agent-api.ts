/**
 * Storage for the agent host API (/agent/v1): idempotency records and
 * conversations. Later pull requests add tasks, requests and the outbox.
 */
import { db, type DbClient } from "./schema";

export interface IdempotencyRow {
  client: string;
  idem_key: string;
  route: string;
  request_hash: string;
  status: number;
  /** The JSON response body, as sent the first time. */
  response: string;
  resource_id: string | null;
  created_at: number;
}

export interface ConversationRow {
  id: string;
  client: string;
  persona: string;
  channel: string;
  thread_ts: string | null;
  title: string | null;
  created_at: number;
}

export async function findIdempotency(client: string, key: string, q: DbClient = db): Promise<IdempotencyRow | null> {
  const row = await q.one<IdempotencyRow>("SELECT * FROM agent_idempotency WHERE client = ? AND idem_key = ?", [client, key]);
  return row ? { ...row, status: Number(row.status), created_at: Number(row.created_at) } : null;
}

/** Record the first response for (client, key). False when a row is already there. */
export async function insertIdempotency(row: IdempotencyRow, q: DbClient = db): Promise<boolean> {
  const r = await q.run(
    `INSERT INTO agent_idempotency (client, idem_key, route, request_hash, status, response, resource_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (client, idem_key) DO NOTHING`,
    [row.client, row.idem_key, row.route, row.request_hash, row.status, row.response, row.resource_id, row.created_at],
  );
  return r.changes > 0;
}

/** Delete records created before `before` (epoch ms). Returns how many went. */
export async function purgeIdempotency(before: number): Promise<number> {
  return (await db.run("DELETE FROM agent_idempotency WHERE created_at < ?", [before])).changes;
}

export async function insertConversation(row: ConversationRow, q: DbClient = db): Promise<void> {
  await q.run(
    `INSERT INTO agent_conversations (id, client, persona, channel, thread_ts, title, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.client, row.persona, row.channel, row.thread_ts, row.title, row.created_at],
  );
}

/** The conversation, only when it belongs to `client`. */
export async function findConversation(client: string, id: string): Promise<ConversationRow | null> {
  const row = await db.one<ConversationRow>("SELECT * FROM agent_conversations WHERE id = ? AND client = ?", [id, client]);
  return row ? { ...row, created_at: Number(row.created_at) } : null;
}

export async function _wipeForTests(): Promise<void> {
  await db.run("DELETE FROM agent_idempotency");
  await db.run("DELETE FROM agent_conversations");
}
