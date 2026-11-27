/**
 * The `/agent/v1` route table, in the style of the node-facing `/v1` table
 * (`src/gateway/api/index.ts`). Every route is authenticated as a registered
 * client before it is matched; a handler gets the client and the parsed body.
 */
import { json } from "../gateway/api/http";
import type { ApiClient } from "./clients";
import { capabilityRoutes } from "./capabilities";
import { conversationRoutes } from "./conversations";

export interface AgentRouteCtx {
  req: Request;
  /** Path segments after "agent/v1", raw (not URI-decoded). */
  seg: string[];
  client: ApiClient;
  /** The parsed JSON body for POST, PUT and PATCH; undefined otherwise. */
  body?: unknown;
}

export interface AgentRouteDef {
  /** Stable name, used in logs, tests and the OpenAPI drift test. */
  name: string;
  methods: readonly string[];
  /** Segments after "agent/v1"; ":x" matches any one segment. */
  pattern: readonly string[];
  handle(ctx: AgentRouteCtx): Promise<Response>;
}

export function matchAgentRoute(route: Pick<AgentRouteDef, "pattern">, seg: readonly string[]): boolean {
  if (route.pattern.length !== seg.length) return false;
  return route.pattern.every((p, i) => p.startsWith(":") ? seg[i]!.length > 0 : p === seg[i]);
}

/** The route table. Later pull requests add tasks, requests and actions. */
export function agentRoutes(): AgentRouteDef[] {
  return [
    {
      name: "client.whoami",
      methods: ["GET"],
      pattern: ["whoami"],
      handle: async ({ client }) =>
        json(200, { name: client.name, personas: client.personas, channels: client.channels, actions: client.actions }),
    },
    ...conversationRoutes(),
    ...capabilityRoutes(),
  ];
}
