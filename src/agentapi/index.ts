/**
 * The agent host API, `/agent/v1`: the HTTP entry point.
 *
 * Order of checks for a path under `/agent/v1`:
 *   1. no registered client → 404 on every path (the API does not exist here);
 *   2. no or wrong bearer token → 401, before any route is matched, so an
 *      unauthenticated caller learns nothing about the routes;
 *   3. unknown path → 404, known path with another method → 405;
 *   4. a body over the cap → 413, malformed JSON → 400;
 *   5. the handler. A thrown error is logged and answered 500.
 * Every error body is `{ error }`.
 *
 * Mounted on the gateway role only; on mono only with SLAUDE_AGENT_API_ON_MONO=1
 * (see agentApiHandlerForRole in src/health.ts).
 */
import { json, methodNotAllowed, notFound, readBodyCapped } from "../gateway/api/http";
import { authenticate } from "./auth";
import type { ApiClient } from "./clients";
import { agentRoutes, matchAgentRoute, type AgentRouteDef } from "./routes";

export const AGENT_API_PREFIX = "/agent/v1";
/** Request bodies above this are refused with 413. */
export const AGENT_API_MAX_BODY = 256 * 1024;

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

export interface AgentApiOptions {
  /** The registered clients, read on every request so a reload takes effect. */
  clients: () => ReadonlyMap<string, ApiClient>;
  /** Test seam; defaults to agentRoutes(). */
  routes?: AgentRouteDef[];
  maxBodyBytes?: number;
}

export function isAgentApiPath(pathname: string): boolean {
  return pathname === AGENT_API_PREFIX || pathname.startsWith(`${AGENT_API_PREFIX}/`);
}

export function makeAgentApiHandler(opts: AgentApiOptions): (req: Request) => Promise<Response | null> {
  const routes = opts.routes ?? agentRoutes();
  const maxBody = opts.maxBodyBytes ?? AGENT_API_MAX_BODY;
  return async (req) => {
    const url = new URL(req.url);
    if (!isAgentApiPath(url.pathname)) return null;
    const clients = opts.clients();
    if (clients.size === 0) return notFound();

    const client = authenticate(req, clients);
    if (!client) return json(401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });

    const seg = url.pathname.slice(AGENT_API_PREFIX.length).split("/").filter(Boolean);
    const matched = routes.filter((r) => matchAgentRoute(r, seg));
    if (matched.length === 0) return notFound();
    const route = matched.find((r) => r.methods.includes(req.method));
    if (!route) return methodNotAllowed();

    let body: unknown;
    if (BODY_METHODS.has(req.method)) {
      const text = await readBodyCapped(req, maxBody);
      if (text === null) return json(413, { error: `body larger than ${maxBody} bytes` });
      if (text.trim()) {
        try {
          body = JSON.parse(text);
        } catch {
          return json(400, { error: "body is not valid JSON" });
        }
      } else {
        body = {};
      }
    }

    try {
      return await route.handle({ req, seg, client, body });
    } catch (e) {
      console.error(`[agentapi] ${route.name} client=${client.name} failed: ${(e as Error)?.message ?? e}`);
      return json(500, { error: "internal error" });
    }
  };
}
