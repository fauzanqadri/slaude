/**
 * Conversations: a persona, a channel and an optional thread, bound by a client.
 *
 *   POST /agent/v1/conversations       Idempotency-Key required
 *     { persona, channel, thread?, title? } -> 201 { conversationId, thread? }
 *   GET  /agent/v1/conversations/:id  -> 200, or 404 when it is another client's
 *
 * The persona and the channel must be in the client's allowlist (403 otherwise).
 * When no thread is given, the thread is bound when the first message is posted.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { json, notFound } from "../gateway/api/http";
import { formatRef, parseRef } from "../refs/parse";
import * as Store from "../db/agent-api";
import { idempotent } from "./idempotency";
import type { AgentRouteDef } from "./routes";

const THREAD_RE = /^\d{1,12}\.\d{1,9}$/;
const CONVERSATION_ID_RE = /^conv_[0-9a-f]{32}$/;

const createSchema = z
  .object({
    persona: z.string().min(1).max(128),
    channel: z.string().min(1).max(256),
    thread: z.string().regex(THREAD_RE, "must be a Slack thread timestamp").optional(),
    title: z.string().min(1).max(200).optional(),
  })
  .strict();

export function newConversationId(): string {
  return `conv_${randomUUID().replace(/-/g, "")}`;
}

export function conversationView(row: Store.ConversationRow) {
  return {
    conversationId: row.id,
    persona: row.persona,
    channel: row.channel,
    ...(row.thread_ts ? { thread: row.thread_ts } : {}),
    ...(row.title ? { title: row.title } : {}),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export function conversationRoutes(): AgentRouteDef[] {
  return [
    {
      name: "conversations.create",
      methods: ["POST"],
      pattern: ["conversations"],
      handle: ({ req, client, body }) =>
        idempotent(req, client, "conversations.create", body, async (tx) => {
          const parsed = createSchema.safeParse(body);
          if (!parsed.success) {
            const problems = parsed.error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message));
            return json(400, { error: "invalid body", problems });
          }
          const ref = parseRef(parsed.data.channel, ["channel"]);
          if (!ref.ok) return json(400, { error: "invalid body", problems: [`channel: ${ref.reason}`] });
          const channel = formatRef(ref.ref);
          if (!client.personas.includes(parsed.data.persona)) return json(403, { error: "persona not allowed for this client" });
          if (!client.channels.includes(channel)) return json(403, { error: "channel not allowed for this client" });

          const id = newConversationId();
          await Store.insertConversation(
            {
              id,
              client: client.name,
              persona: parsed.data.persona,
              channel,
              thread_ts: parsed.data.thread ?? null,
              title: parsed.data.title ?? null,
              created_at: Date.now(),
            },
            tx,
          );
          return {
            status: 201,
            body: { conversationId: id, ...(parsed.data.thread ? { thread: parsed.data.thread } : {}) },
            resourceId: id,
          };
        }),
    },
    {
      name: "conversations.get",
      methods: ["GET"],
      pattern: ["conversations", ":id"],
      handle: async ({ client, seg }) => {
        const id = seg[1]!;
        if (!CONVERSATION_ID_RE.test(id)) return notFound();
        const row = await Store.findConversation(client.name, id);
        return row ? json(200, conversationView(row)) : notFound();
      },
    },
  ];
}
