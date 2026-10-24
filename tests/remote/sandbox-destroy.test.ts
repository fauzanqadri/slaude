import { describe, it, expect, afterEach } from "bun:test";
import { destroySandbox } from "../../src/remote/sandbox-destroy";

let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => {
  server?.stop(true);
  server = undefined;
  delete process.env.SLAUDE_SANDBOX_MCP_URL;
  delete process.env.SLAUDE_SANDBOX_MCP_TOKEN;
});

type Seen = { method: string; path: string; auth: string | null; session: string | null };
function serve(status: number, seen: Seen[]) {
  server = Bun.serve({
    port: 0,
    fetch: (req) => {
      seen.push({ method: req.method, path: new URL(req.url).pathname, auth: req.headers.get("authorization"), session: req.headers.get("x-sandbox-session") });
      return new Response(null, { status });
    },
  });
  process.env.SLAUDE_SANDBOX_MCP_URL = `http://127.0.0.1:${server.port}/mcp`;
  process.env.SLAUDE_SANDBOX_MCP_TOKEN = "tok";
}

describe("destroySandbox", () => {
  it("sends DELETE /sandbox with the bearer and session header", async () => {
    const seen: Seen[] = [];
    serve(204, seen);
    expect(await destroySandbox("11111111-1111-4111-8111-111111111111")).toBe(true);
    expect(seen).toEqual([{ method: "DELETE", path: "/sandbox", auth: "Bearer tok", session: "11111111-1111-4111-8111-111111111111" }]);
  });

  it("false on an error status, an unreachable server, or no URL", async () => {
    serve(502, []);
    expect(await destroySandbox("s")).toBe(false);
    server!.stop(true);
    expect(await destroySandbox("s")).toBe(false);
    delete process.env.SLAUDE_SANDBOX_MCP_URL;
    expect(await destroySandbox("s")).toBe(false);
  });
});
