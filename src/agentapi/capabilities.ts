/**
 * `GET /agent/v1/personas/:id/capabilities`: what a client may ask of a persona
 * on this host, so an engine can plan a process before it starts one.
 *
 *   contexts    `thread` (a turn in the conversation's thread) and `fresh` (a
 *               new context with no history);
 *   placements  `host` always; `workspace` only when sandbox mode is on;
 *   actions     the client's action allowlist intersected with the tools this
 *               host can run as an action, `git_push` only with sandbox mode;
 *   connectors  the names of the persona's MCP servers, never their URLs.
 *
 * A persona outside the client's allowlist, or one this host does not know, is
 * 404, the same answer as a resource of another client.
 */
import { json, notFound } from "../gateway/api/http";
import { env } from "../config/env";
import { getPersonaRegistry } from "../persona/registry";
import type { AgentRouteDef } from "./routes";

/** Tools an action can run without a model, and whether each needs sandbox mode. */
export const ACTION_TOOLS: Readonly<Record<string, { needsSandbox: boolean }>> = {
  git_push: { needsSandbox: true },
};

export interface CapabilityDeps {
  /** The persona's MCP config (`.mcp.json` shape), or null when it has none;
   *  undefined when the persona is not known here. */
  personaMcp: (name: string) => unknown | null | undefined;
  sandboxOn: () => boolean;
}

export const defaultCapabilityDeps: CapabilityDeps = {
  personaMcp: (name) => {
    const r = getPersonaRegistry();
    const p = r.lookupByName(name);
    if (p) return p.mcp ?? null;
    if (name === "default") return r.defaultPersona?.()?.mcp ?? null;
    return undefined;
  },
  sandboxOn: () => env.sandbox.activeUrl() !== "",
};

export function connectorNames(mcp: unknown): string[] {
  const servers = mcp && typeof mcp === "object" ? (mcp as { mcpServers?: unknown }).mcpServers : undefined;
  return servers && typeof servers === "object" && !Array.isArray(servers) ? Object.keys(servers).sort() : [];
}

export function capabilityRoutes(deps: CapabilityDeps = defaultCapabilityDeps): AgentRouteDef[] {
  return [
    {
      name: "personas.capabilities",
      methods: ["GET"],
      pattern: ["personas", ":id", "capabilities"],
      handle: async ({ client, seg }) => {
        const persona = seg[1]!;
        if (!client.personas.includes(persona)) return notFound();
        const mcp = deps.personaMcp(persona);
        if (mcp === undefined) return notFound();
        const sandbox = deps.sandboxOn();
        const actions = client.actions.filter((t) => {
          const tool = ACTION_TOOLS[t];
          return tool !== undefined && (!tool.needsSandbox || sandbox);
        });
        return json(200, {
          persona,
          contexts: ["thread", "fresh"],
          placements: sandbox ? ["host", "workspace"] : ["host"],
          sandbox: { enabled: sandbox },
          actions,
          connectors: connectorNames(mcp),
        });
      },
    },
  ];
}
