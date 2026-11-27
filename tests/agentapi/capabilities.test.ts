import { describe, expect, test } from "bun:test";
import { makeAgentApiHandler } from "../../src/agentapi/index";
import { hashToken, type ApiClient } from "../../src/agentapi/clients";
import { capabilityRoutes, connectorNames, type CapabilityDeps } from "../../src/agentapi/capabilities";
import { mintJobToken, verifyJobToken } from "../../src/gateway/api/auth";
import { isInteractiveOrigin, TURN_ORIGINS } from "../../src/knowledge/gated-dispatch";
import { stampFromSenders, turnStamp } from "../../src/gateway/slack/permission-gate";

const TOKEN = "a".repeat(40);
const CLIENT: ApiClient = {
  name: "process-engine",
  tokenHash: hashToken(TOKEN),
  personas: ["support-bot", "unknown-bot"],
  channels: ["slack:channel:C0EXAMPLE"],
  actions: ["git_push", "not_a_tool"],
  events: { url: "https://engine.example.internal/events", secret: "s".repeat(40), notifyHosts: [] },
};

const MCP = { mcpServers: { tickets: { type: "http", url: "https://tickets.example.internal/mcp" }, docs: { type: "http", url: "https://docs.example.internal/mcp" } } };

const get = async (persona: string, deps: Partial<CapabilityDeps> = {}) => {
  const h = makeAgentApiHandler({
    clients: () => new Map([[CLIENT.name, CLIENT]]),
    routes: capabilityRoutes({
      personaMcp: (n) => (n === "support-bot" ? MCP : n === "other-bot" ? null : undefined),
      sandboxOn: () => false,
      ...deps,
    }),
  });
  const r = (await h(new Request(`http://x/agent/v1/personas/${persona}/capabilities`, { headers: { authorization: `Bearer ${TOKEN}` } })))!;
  return { status: r.status, body: (await r.json()) as any };
};

describe("GET /agent/v1/personas/:id/capabilities", () => {
  test("sandbox off: host placement only, no git_push, connector names without URLs", async () => {
    const r = await get("support-bot");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      persona: "support-bot",
      contexts: ["thread", "fresh"],
      placements: ["host"],
      sandbox: { enabled: false },
      actions: [],
      connectors: ["docs", "tickets"],
    });
    expect(JSON.stringify(r.body)).not.toContain("example.internal");
  });

  test("sandbox on: workspace placement and git_push; a tool the host cannot run as an action is dropped", async () => {
    const r = await get("support-bot", { sandboxOn: () => true });
    expect(r.body.placements).toEqual(["host", "workspace"]);
    expect(r.body.sandbox).toEqual({ enabled: true });
    expect(r.body.actions).toEqual(["git_push"]);
  });

  test("a persona outside the client's allowlist, or unknown here, is 404", async () => {
    expect((await get("other-bot")).status).toBe(404);
    expect((await get("unknown-bot")).status).toBe(404);
  });

  test("connector names come from mcpServers only", () => {
    expect(connectorNames(null)).toEqual([]);
    expect(connectorNames({ mcpServers: [] })).toEqual([]);
    expect(connectorNames({ servers: { a: {} } })).toEqual([]);
    expect(connectorNames(MCP)).toEqual(["docs", "tickets"]);
  });
});

describe("turn origin api", () => {
  test("is a turn origin, signed into the job token, and not interactive", () => {
    expect(TURN_ORIGINS).toContain("api");
    expect(isInteractiveOrigin("api")).toBe(false);
    const v = verifyJobToken(
      mintJobToken(
        { tenant: "default", persona: "support-bot", session: "S1", team: "T0TEAM", channel: "C0EXAMPLE", thread: "1.0", initiator: "", scope: "turn", origin: "api" },
        { secret: "api-origin-secret" },
      ),
      { secret: "api-origin-secret" },
    );
    expect(v.ok && v.claims.origin).toBe("api");
  });

  test("a permission card in an api turn stamps no initiator, so only an approver or manager decides it", () => {
    expect(turnStamp("U0EXAMPLE", "api")).toEqual({ initiator: null, origin: "api" });
    expect(stampFromSenders([{ userId: "U0EXAMPLE", origin: "api" }])).toEqual({ initiator: null, origin: "api" });
  });
});
