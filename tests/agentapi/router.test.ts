import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { agentApiHandlerForRole, healthRoutes } from "../../src/health";
import { makeAgentApiHandler } from "../../src/agentapi/index";
import { hashToken, type ApiClient } from "../../src/agentapi/clients";
import type { AgentRouteDef } from "../../src/agentapi/routes";
import { json } from "../../src/gateway/api/http";
import { env } from "../../src/config/env";
import { paths } from "../../src/config/home";

const TOKEN = "a".repeat(40);
const CLIENT: ApiClient = {
  name: "process-engine",
  tokenHash: hashToken(TOKEN),
  personas: ["support-bot"],
  channels: ["slack:channel:C0EXAMPLE"],
  actions: [],
  events: { url: "https://engine.example.internal/events", secret: "s".repeat(40), notifyHosts: [] },
};

let clients: Map<string, ApiClient> = new Map([[CLIENT.name, CLIENT]]);
const seen: Array<{ client: string; body: unknown }> = [];
const TEST_ROUTES: AgentRouteDef[] = [
  {
    name: "test.echo",
    methods: ["POST"],
    pattern: ["echo", ":id"],
    handle: async ({ client, body, seg }) => {
      seen.push({ client: client.name, body });
      return json(200, { id: seg[1], body });
    },
  },
  { name: "test.boom", methods: ["GET"], pattern: ["boom"], handle: async () => { throw new Error("secret detail"); } },
];

let server: ReturnType<typeof Bun.serve>;
let base: string;
beforeAll(() => {
  const routes = healthRoutes({
    liveSessions: () => 0,
    agentApi: makeAgentApiHandler({ clients: () => clients, routes: TEST_ROUTES, maxBodyBytes: 64 }),
  });
  server = Bun.serve({ port: 0, fetch: async (req) => (await routes(req)) ?? new Response("fallthrough", { status: 418 }) });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));
afterEach(() => {
  clients = new Map([[CLIENT.name, CLIENT]]);
  seen.length = 0;
});

const call = (path: string, init: RequestInit & { token?: string | null } = {}) => {
  const { token = TOKEN, ...rest } = init;
  return fetch(base + path, { ...rest, headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...(rest.headers ?? {}) } });
};

describe("/agent/v1 router", () => {
  test("with no client registered, every path is 404, even with a token", async () => {
    clients = new Map();
    for (const p of ["/agent/v1", "/agent/v1/echo/1", "/agent/v1/anything"]) {
      const r = await call(p, { method: "POST", body: "{}" });
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ error: "not found" });
    }
  });

  test("no token or a wrong token is 401 before any route is matched", async () => {
    for (const token of [null, "", TOKEN + "x", "b".repeat(40)]) {
      for (const p of ["/agent/v1/echo/1", "/agent/v1/no-such-route"]) {
        const r = await call(p, { method: "POST", body: "{}", token });
        expect(r.status).toBe(401);
        expect(r.headers.get("www-authenticate")).toBe("Bearer");
        expect(await r.json()).toEqual({ error: "unauthorized" });
      }
    }
    const basic = await call("/agent/v1/echo/1", { method: "POST", body: "{}", token: null, headers: { authorization: `Basic ${TOKEN}` } });
    expect(basic.status).toBe(401);
    expect(seen).toEqual([]);
  });

  test("an authenticated call reaches the handler with the client and the parsed body", async () => {
    const r = await call("/agent/v1/echo/42", { method: "POST", body: JSON.stringify({ a: 1 }) });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ id: "42", body: { a: 1 } });
    expect(seen).toEqual([{ client: "process-engine", body: { a: 1 } }]);
  });

  test("an empty body is {}", async () => {
    const r = await call("/agent/v1/echo/1", { method: "POST" });
    expect(((await r.json()) as { body: unknown }).body).toEqual({});
  });

  test("unknown path 404, known path with another method 405", async () => {
    expect((await call("/agent/v1/nope")).status).toBe(404);
    expect((await call("/agent/v1/echo")).status).toBe(404);
    const r = await call("/agent/v1/echo/1", { method: "GET" });
    expect(r.status).toBe(405);
    expect(await r.json()).toEqual({ error: "method not allowed" });
  });

  test("a body over the cap is 413, with or without a Content-Length", async () => {
    const big = JSON.stringify({ x: "y".repeat(100) });
    expect((await call("/agent/v1/echo/1", { method: "POST", body: big })).status).toBe(413);
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(big)); c.close(); } });
    expect((await call("/agent/v1/echo/1", { method: "POST", body: stream })).status).toBe(413);
    expect(seen).toEqual([]);
  });

  test("malformed JSON is 400", async () => {
    const r = await call("/agent/v1/echo/1", { method: "POST", body: "{nope" });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "body is not valid JSON" });
  });

  test("a handler error is 500 and its message is not returned", async () => {
    const r = await call("/agent/v1/boom");
    expect(r.status).toBe(500);
    expect(await r.text()).not.toContain("secret detail");
  });

  test("paths outside /agent/v1 are not taken", async () => {
    expect((await call("/agent/v10/echo/1", { method: "POST" })).status).toBe(418);
    expect((await call("/agentv1")).status).toBe(418);
  });

  test("the built-in whoami route names the client", async () => {
    const h = makeAgentApiHandler({ clients: () => clients });
    const r = (await h(new Request("http://x/agent/v1/whoami", { headers: { authorization: `Bearer ${TOKEN}` } })))!;
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ name: "process-engine", personas: ["support-bot"], channels: ["slack:channel:C0EXAMPLE"], actions: [] });
  });
});

describe("where /agent/v1 is mounted", () => {
  const h = async () => null;
  test("gateway always, node never, mono only when opted in", () => {
    expect(agentApiHandlerForRole("gateway", false, h)).toBe(h);
    expect(agentApiHandlerForRole("node", true, h)).toBeUndefined();
    expect(agentApiHandlerForRole("node", false, h)).toBeUndefined();
    expect(agentApiHandlerForRole("mono", false, h)).toBeUndefined();
    expect(agentApiHandlerForRole("mono", true, h)).toBe(h);
  });
});

describe("agent API env", () => {
  const NAMES = ["SLAUDE_AGENT_API_CLIENTS_DIR", "SLAUDE_AGENT_API_ON_MONO"];
  afterEach(() => { for (const n of NAMES) delete process.env[n]; });

  test("clients directory: default, relative to $SLAUDE_HOME, absolute", () => {
    expect(env.agentApi.clientsDir()).toBe(join(paths.home, "api-clients"));
    process.env.SLAUDE_AGENT_API_CLIENTS_DIR = "clients";
    expect(env.agentApi.clientsDir()).toBe(join(paths.home, "clients"));
    process.env.SLAUDE_AGENT_API_CLIENTS_DIR = "/etc/slaude/clients";
    expect(env.agentApi.clientsDir()).toBe("/etc/slaude/clients");
  });

  test("mono opt-in is off by default", () => {
    expect(env.agentApi.onMono()).toBe(false);
    process.env.SLAUDE_AGENT_API_ON_MONO = "1";
    expect(env.agentApi.onMono()).toBe(true);
  });
});
