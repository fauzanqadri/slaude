import { beforeEach, describe, expect, test } from "bun:test";
import { makeAgentApiHandler } from "../../src/agentapi/index";
import { hashToken, type ApiClient } from "../../src/agentapi/clients";
import { canonicalJson, idempotent, IDEMPOTENCY_RETENTION_MS, requestHash } from "../../src/agentapi/idempotency";
import * as Store from "../../src/db/agent-api";
import { db } from "../../src/db/schema";

const client = (name: string, token: string): ApiClient => ({
  name,
  tokenHash: hashToken(token),
  personas: ["support-bot"],
  channels: ["slack:channel:C0EXAMPLE"],
  actions: [],
  events: { url: "https://engine.example.internal/events", secret: "s".repeat(40), notifyHosts: [] },
});
const A = "a".repeat(40);
const B = "b".repeat(40);
const clients = new Map([["engine-a", client("engine-a", A)], ["engine-b", client("engine-b", B)]]);
const handler = makeAgentApiHandler({ clients: () => clients });

const call = async (path: string, init: { method?: string; token?: string; key?: string | null; body?: unknown } = {}) => {
  const headers: Record<string, string> = { authorization: `Bearer ${init.token ?? A}` };
  if (init.key !== null) headers["idempotency-key"] = init.key ?? "k-1";
  const r = (await handler(
    new Request(`http://x/agent/v1${path}`, {
      method: init.method ?? "POST",
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
  ))!;
  return { status: r.status, headers: r.headers, body: (await r.json()) as any };
};

const CREATE = { persona: "support-bot", channel: "slack:channel:C0EXAMPLE", title: "Ticket review" };

beforeEach(async () => { await Store._wipeForTests(); });

describe("POST /agent/v1/conversations", () => {
  test("creates a conversation: 201 {conversationId}, readable by its client", async () => {
    const r = await call("/conversations", { body: CREATE });
    expect(r.status).toBe(201);
    expect(r.body.conversationId).toMatch(/^conv_[0-9a-f]{32}$/);
    expect(r.body.thread).toBeUndefined();

    const g = await call(`/conversations/${r.body.conversationId}`, { method: "GET", key: null });
    expect(g.status).toBe(200);
    expect(g.body).toMatchObject({ conversationId: r.body.conversationId, persona: "support-bot", channel: "slack:channel:C0EXAMPLE", title: "Ticket review" });
    expect(g.body.thread).toBeUndefined();
  });

  test("an existing thread is bound and echoed", async () => {
    const r = await call("/conversations", { body: { ...CREATE, thread: "1700000000.000100" } });
    expect(r.status).toBe(201);
    expect(r.body.thread).toBe("1700000000.000100");
  });

  test("a persona or a channel outside the client's allowlist is 403 and creates nothing", async () => {
    expect((await call("/conversations", { key: "p", body: { ...CREATE, persona: "other-bot" } })).status).toBe(403);
    expect((await call("/conversations", { key: "c", body: { ...CREATE, channel: "slack:channel:C0OTHER" } })).status).toBe(403);
    expect(await db.query("SELECT * FROM agent_conversations")).toEqual([]);
  });

  test("a bad body is 400 with the problems", async () => {
    const r = await call("/conversations", { body: { persona: "support-bot", channel: "slack:channel:C0EXAMPLE", extra: 1 } });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid body");
    expect((await call("/conversations", { body: { ...CREATE, thread: "yesterday" } })).status).toBe(400);
    expect((await call("/conversations", { body: { ...CREATE, channel: "nonsense" } })).status).toBe(400);
  });

  test("the Idempotency-Key header is required", async () => {
    const r = await call("/conversations", { key: null, body: CREATE });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("Idempotency-Key");
    expect((await call("/conversations", { key: "has space", body: CREATE })).status).toBe(400);
  });

  test("the same key and body returns the first response and creates one row", async () => {
    const first = await call("/conversations", { body: CREATE });
    const again = await call("/conversations", { body: { title: "Ticket review", channel: CREATE.channel, persona: CREATE.persona } });
    expect(again.status).toBe(201);
    expect(again.body).toEqual(first.body);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(first.headers.get("idempotent-replayed")).toBeNull();
    expect((await db.query("SELECT id FROM agent_conversations")).length).toBe(1);
  });

  test("the same key with a different body is 409", async () => {
    await call("/conversations", { body: CREATE });
    const r = await call("/conversations", { body: { ...CREATE, title: "Something else" } });
    expect(r.status).toBe(409);
    expect((await db.query("SELECT id FROM agent_conversations")).length).toBe(1);
  });

  test("a refusal is not stored, so the client can fix the call and retry under the key", async () => {
    expect((await call("/conversations", { body: { ...CREATE, persona: "other-bot" } })).status).toBe(403);
    expect((await call("/conversations", { body: CREATE })).status).toBe(201);
  });

  test("keys are per client: another client may reuse a key", async () => {
    const a = await call("/conversations", { body: CREATE });
    const b = await call("/conversations", { token: B, body: CREATE });
    expect(b.status).toBe(201);
    expect(b.body.conversationId).not.toBe(a.body.conversationId);
  });

  test("two concurrent calls under one key create one conversation", async () => {
    const [x, y] = await Promise.all([call("/conversations", { body: CREATE }), call("/conversations", { body: CREATE })]);
    expect([x.status, y.status]).toEqual([201, 201]);
    expect(x.body.conversationId).toBe(y.body.conversationId);
    expect((await db.query("SELECT id FROM agent_conversations")).length).toBe(1);
  });
});

describe("GET /agent/v1/conversations/:id", () => {
  test("another client's conversation is 404, as is an unknown or malformed id", async () => {
    const { body } = await call("/conversations", { body: CREATE });
    const other = await call(`/conversations/${body.conversationId}`, { method: "GET", token: B, key: null });
    expect(other.status).toBe(404);
    expect(other.body).toEqual({ error: "not found" });
    expect((await call(`/conversations/conv_${"0".repeat(32)}`, { method: "GET", key: null })).status).toBe(404);
    expect((await call("/conversations/%E0%A4%A", { method: "GET", key: null })).status).toBe(404);
  });
});

describe("idempotency records", () => {
  test("bodies hash the same whatever the key order; route is part of the hash", () => {
    expect(canonicalJson({ b: [1, { d: 1, c: 2 }], a: null })).toBe('{"a":null,"b":[1,{"c":2,"d":1}]}');
    expect(requestHash("r", { a: 1, b: 2 })).toBe(requestHash("r", { b: 2, a: 1 }));
    expect(requestHash("r1", { a: 1 })).not.toBe(requestHash("r2", { a: 1 }));
  });

  test("the same key on another route is 409", async () => {
    const c = clients.get("engine-a")!;
    const req = () => new Request("http://x", { headers: { "idempotency-key": "shared" } });
    expect((await idempotent(req(), c, "one", {}, async () => ({ status: 201, body: { ok: 1 } }))).status).toBe(201);
    expect((await idempotent(req(), c, "two", {}, async () => ({ status: 201, body: { ok: 2 } }))).status).toBe(409);
  });

  test("a record past the retention window counts as absent", async () => {
    const c = clients.get("engine-a")!;
    const req = () => new Request("http://x", { headers: { "idempotency-key": "old" } });
    let n = 0;
    const create = async () => ({ status: 201, body: { n: ++n } });
    const t0 = 1_000_000_000_000;
    await idempotent(req(), c, "r", {}, create, () => t0);
    const late = await idempotent(req(), c, "r", {}, create, () => t0 + IDEMPOTENCY_RETENTION_MS + 1);
    expect(await late.json()).toEqual({ n: 2 });
    expect(await Store.purgeIdempotency(t0 + IDEMPOTENCY_RETENTION_MS + 2)).toBe(1);
  });
});
