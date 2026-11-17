import { env } from "../config/env";
import * as Sandbox from "../db/sandbox";

const TIMEOUT_MS = 15_000;

/** Ask the sandbox MCP server to destroy one session's sandbox now (`DELETE /sandbox`,
 *  same bearer and X-Sandbox-Session as the MCP calls). True on success. A failure
 *  is not fatal: the server still stops the sandbox when idle and deletes it after
 *  its keep window. */
export async function destroySandbox(sessionId: string): Promise<boolean> {
  const base = env.sandbox.activeUrl();
  if (!base) return false;
  const token = env.sandbox.mcpToken();
  try {
    const res = await fetch(new URL("/sandbox", base), {
      method: "DELETE",
      headers: { "X-Sandbox-Session": sessionId, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** What Claude is told after the thread leaves sandbox mode. */
export const SANDBOX_GONE_NOTE =
  "The sandbox for this thread was turned off and destroyed: files under /workspace and any unpushed commits are gone. Shell and file tools run on the slaude server again.";

/** Turn a thread's sandbox mode off and destroy its sandbox. `wasOn` false = nothing
 *  to do; `destroyed` false = the server did not confirm (it still reaps idle ones). */
export async function turnSandboxOff(
  channelId: string,
  threadTs: string,
  sessionId: string,
  destroy: (sessionId: string) => Promise<boolean> = destroySandbox,
): Promise<{ wasOn: boolean; destroyed: boolean }> {
  const row = await Sandbox.clear(channelId, threadTs);
  if (!row) return { wasOn: false, destroyed: false };
  return { wasOn: true, destroyed: await destroy(sessionId) };
}
