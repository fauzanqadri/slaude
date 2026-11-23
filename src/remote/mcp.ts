import { createSdkMcpServer, tool, type CanUseTool, type HookCallback, type McpHttpServerConfig, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { env } from "../config/env";
import { z } from "zod";
import { RemoteError, type Exec } from "./types";
import { ReadState, readTool, writeTool, editTool, fail, type ToolText } from "./tools/files";
import { globTool, grepTool } from "./tools/search";
import { bashTool, bashOutputTool, bashKillTool } from "./tools/bash";

export const REMOTE_MCP_NAME = "remote";
export const REMOTE_BUILTINS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep"] as const;
export const REMOTE_TOOL_ALIASES: Record<string, string> = Object.fromEntries(
  REMOTE_BUILTINS.map((n) => [n, `mcp__${REMOTE_MCP_NAME}__${n.toLowerCase()}`]),
);

/** Other SDK built-ins (sdk-tools.d.ts) that write files, run code, or read local
 *  files and have no remote counterpart: disabled while remote mode is on.
 *  Left allowed on purpose: TaskOutput/TaskStop (they manage subagents too; local
 *  shells cannot start since Bash is rerouted), web, todo, plan, and cron tools. */
export const REMOTE_DENIED_LOCAL_TOOLS = [
  "NotebookEdit", // writes a local file
  "Monitor",      // runs a local shell command
  "REPL",         // runs JavaScript in the local process
  "Workflow",     // runs a local script
  "EnterWorktree", // local git worktree
  "ExitWorktree",  // local git worktree (can delete one)
  "Artifact",     // publishes a local file
] as const;

const PREFIX = `mcp__${REMOTE_MCP_NAME}__`;
/** git_fetch (sandbox server) only moves refs from the server's mirror into the sandbox;
 *  it publishes nothing and touches no working tree, so it is allowed like a read. */
const READ_ONLY = new Set(["read", "glob", "grep", "bash_output", "git_fetch"]);
const EDITS = new Set(["write", "edit"]);
const SHELL = new Set(["bash", "bash_kill"]);
/** Publishes code (sandbox server): asks in every mode that can ask, never auto-allowed,
 *  never remembered (see gitPushGuard). */
const PUBLISH = new Set(["git_push"]);

export function builtinFor(toolName: string): string | null {
  if (!toolName.startsWith(PREFIX)) return null;
  const t = toolName.slice(PREFIX.length);
  if (SHELL.has(t)) return "Bash";
  const b = REMOTE_BUILTINS.find((n) => n.toLowerCase() === t);
  return b ?? null;
}

/**
 * Mirror the SDK's own treatment of the built-in each remote tool replaces:
 * read-only tools never prompt; plan mode denies changes; edits auto-allow in
 * acceptEdits; shell asks unless bypassPermissions. null = not a remote tool
 * (caller's normal path).
 *
 * Gating sites (every place that matches tool names) and why remote parity holds:
 *  - permission-gate.ts `permissionPolicy` (gateway resolver + REST openPermission):
 *    matches SLAUDE_AUTO_ALLOW_TOOLS names and mcp__slaude_* prefixes. The resolver is
 *    called with the BUILT-IN name (Bash/Write/Edit), so it decides exactly as locally.
 *  - node/shims/permission.ts resolver: same permissionPolicy, same renaming.
 *  - permission-gate.ts approval card: raw input preview; shows Bash + the command.
 *  - status-text.ts: tool events can carry the post-alias name, so mcp__remote__* is
 *    rendered like its built-in (same safe subject), marked "(remote)" once.
 *  - manager.ts turnTools / AUTO_EVOLVE_IGNORE: match the model-emitted block.name.
 *  - knowledge/ingest.ts Write/Edit: separate ingest query, not a remote session.
 *  - SDK mode handling (plan/acceptEdits/bypassPermissions): built-in names only,
 *    reproduced here.
 */
export function remotePermission(toolName: string, mode: string): "allow" | "ask" | "deny" | null {
  if (!toolName.startsWith(PREFIX)) return null;
  const t = toolName.slice(PREFIX.length);
  if (READ_ONLY.has(t)) return "allow";
  if (PUBLISH.has(t)) return mode === "plan" || mode === "dontAsk" || mode === "bypassPermissions" ? "deny" : "ask";
  // An unknown tool under our prefix is never approved (and never reaches an approver).
  if (!EDITS.has(t) && !SHELL.has(t)) return "deny";
  if (mode === "plan" || mode === "dontAsk") return "deny";
  if (mode === "bypassPermissions") return "allow";
  if (EDITS.has(t)) return mode === "acceptEdits" ? "allow" : "ask";
  return "ask";
}

export function makeRemoteCanUseTool(base: CanUseTool | undefined, getMode: () => string): CanUseTool {
  return async (toolName, input, ctx) => {
    const mode = getMode();
    const d = remotePermission(toolName, mode);
    if (d === "allow") return { behavior: "allow", updatedInput: input };
    if (d === "deny") {
      return { behavior: "deny", message: `Not permitted on the remote machine in ${mode} mode.` };
    }
    // Fail closed: with no approver, anything not decided above is denied.
    if (!base) return { behavior: "deny", message: "No approver is configured." };
    const r = await base(d === "ask" ? builtinFor(toolName) ?? toolName : toolName, input, ctx);
    // A publish is never remembered: an allow rule would skip this gate on the next push.
    if (r.behavior === "allow" && r.updatedPermissions && PUBLISH.has(toolName.slice(PREFIX.length))) {
      return { ...r, updatedPermissions: undefined };
    }
    return r;
  };
}

const DENIED_LOCAL = new Set<string>([...REMOTE_BUILTINS, ...REMOTE_DENIED_LOCAL_TOOLS]);

/** Belt and braces for toolAliases and disallowedTools: hooks see the post-alias
 *  name, so this fires only if something reaches a LOCAL built-in directly (spec §4.1). */
export const denyLocalBuiltins: HookCallback = async (input) => {
  if (input.hook_event_name !== "PreToolUse") return {};
  if (!DENIED_LOCAL.has((input as any).tool_name)) return {};
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Remote mode is on: local file and shell tools are disabled for this thread.",
    },
  };
};

const GIT_PUSH = `${PREFIX}git_push`;

/** git_push must reach a human and may publish only allowed branch names. Hooks run
 *  in every mode, while canUseTool may never be called in bypassPermissions, so the
 *  bypass refusal lives here. The branch check repeats the server's own rule with
 *  this deployment's pattern (SLAUDE_GIT_PUSH_BRANCH_PATTERN). */
export function gitPushGuard(getMode: () => string): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    if ((input as any).tool_name !== GIT_PUSH) return {};
    const deny = (reason: string) => ({
      hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: reason },
    });
    if (getMode() === "bypassPermissions") {
      return deny("git_push needs an approval and this thread is in bypass mode. Ask the user to switch modes first.");
    }
    const branch = String((input as any).tool_input?.branch ?? "");
    if (!validBranch(branch, env.gitPush.branchPattern())) {
      return deny(`git_push may publish only branches matching ${env.gitPush.branchPattern().source}; got ${branch || "(none)"}. Commit on such a branch first.`);
    }
    return {};
  };
}

/** A branch name the pattern accepts and git would accept as a plain ref name. */
export function validBranch(branch: string, pattern: RegExp): boolean {
  if (!branch || branch.startsWith("-") || branch.startsWith("refs/")) return false;
  if (branch.includes("..") || branch.includes("//") || branch.endsWith("/") || branch.endsWith(".lock")) return false;
  if (/[\s~^:?*\[\\]/.test(branch)) return false;
  const m = pattern.exec(branch);
  return !!m && m.index === 0 && m[0] === branch;
}

const GUIDANCE =
  "Stop and tell the user the thread's environment is not reachable. They can check with `/env`; if they restarted `tailcat serve` and got a new address, `/remote <new-address>` (or `/env edit`) re-points it. Do not retry in a loop or work around it.";

function guarded<I>(name: string, fn: (i: I) => Promise<ToolText>) {
  return async (i: I): Promise<ToolText> => {
    const t = performance.now();
    try {
      const { exitCode, ...r } = await fn(i);
      audit(name, i, r.isError ? "error" : "ok", exitCode, t);
      return r;
    } catch (e) {
      audit(name, i, e instanceof RemoteError ? e.code : "exception", undefined, t);
      if (e instanceof RemoteError) return fail(`${e.message}\n${GUIDANCE}`);
      return fail(`remote ${name} failed: ${(e as Error).message}`);
    }
  };
}

/** One line per call (spec §4.6): tool, program name or path basename, exit code,
 *  duration. No content, no address. */
function audit(name: string, input: any, outcome: string, code: number | null | undefined, t0: number) {
  const subject = name === "bash" ? programOf(String(input?.command ?? ""))
    : String(input?.file_path ?? input?.path ?? input?.bash_id ?? input?.shell_id ?? "").split("/").pop();
  console.log(`[remote] tool=${name} subject=${subject || "-"} outcome=${outcome} code=${code === undefined ? "-" : code} ms=${Math.round(performance.now() - t0)}`);
}

/** Program basename of a shell command, for the audit and status lines. Fails closed ("") rather
 *  than parse shell quoting: leading NAME=value assignments (which may hold secrets) are
 *  skipped, but if any value has a character outside a plain-word whitelist (quotes,
 *  escapes, substitutions, ...) or the program token is not a plain word, nothing is
 *  reported. */
export function programOf(command: string): string {
  for (const tok of command.trim().split(/\s+/)) {
    const asg = /^[A-Za-z_][A-Za-z0-9_]*=(.*)$/.exec(tok);
    if (asg) {
      if (!/^[A-Za-z0-9_.:/@%+,=-]*$/.test(asg[1]!)) return "";
      continue;
    }
    if (!tok || tok === "env" || tok === "sudo") continue;
    const p = tok.split("/").pop() ?? "";
    return /^[A-Za-z0-9._+-]+$/.test(p) ? p : "";
  }
  return "";
}

export function createRemoteMcp(o: { exec: Exec; root: string; sessionKey: string }): McpSdkServerConfigWithInstance {
  const files = { exec: o.exec, root: o.root, state: new ReadState() };
  const shell = { exec: o.exec, root: o.root, sessionKey: o.sessionKey, cwd: { value: o.root }, bg: new Map<string, number>() };
  return createSdkMcpServer({
    name: REMOTE_MCP_NAME,
    version: "0.1.0",
    tools: [
      tool("bash", "Run a shell command on the user's machine (remote mode). Same contract as Bash.", {
        command: z.string(),
        timeout: z.number().optional(),
        description: z.string().optional(),
        run_in_background: z.boolean().optional(),
      }, guarded("bash", (i) => bashTool(shell, i))),
      tool("bash_output", "Read new output and status of a remote background job.", {
        bash_id: z.string(),
      }, guarded("bash_output", (i) => bashOutputTool(shell, i))),
      tool("bash_kill", "Stop a remote background job and its whole process group.", {
        shell_id: z.string(),
      }, guarded("bash_kill", (i) => bashKillTool(shell, i))),
      tool("read", "Read a file on the user's machine (remote mode). Same contract as Read.", {
        file_path: z.string(),
        offset: z.number().optional(),
        limit: z.number().optional(),
      }, guarded("read", (i) => readTool(files, i))),
      tool("write", "Write a file on the user's machine (remote mode). Same contract as Write.", {
        file_path: z.string(),
        content: z.string(),
      }, guarded("write", (i) => writeTool(files, i))),
      tool("edit", "Edit a file on the user's machine (remote mode). Same contract as Edit.", {
        file_path: z.string(),
        old_string: z.string(),
        new_string: z.string(),
        replace_all: z.boolean().optional(),
      }, guarded("edit", (i) => editTool(files, i))),
      tool("glob", "Find files by glob on the user's machine (remote mode). Same contract as Glob.", {
        pattern: z.string(),
        path: z.string().optional(),
      }, guarded("glob", (i) => globTool(files, i))),
      tool("grep", "Search file contents on the user's machine (remote mode). Same contract as Grep.", {
        pattern: z.string(),
        path: z.string().optional(),
        glob: z.string().optional(),
        type: z.string().optional(),
        output_mode: z.enum(["content", "files_with_matches", "count"]).optional(),
        "-i": z.boolean().optional(),
        "-n": z.boolean().optional(),
        "-A": z.number().optional(),
        "-B": z.number().optional(),
        "-C": z.number().optional(),
        head_limit: z.number().optional(),
        multiline: z.boolean().optional(),
      }, guarded("grep", (i) => grepTool(files, i))),
    ],
  });
}

/** Sandbox mode: the remote tools served over HTTP by an external sandbox MCP server.
 *  Mounted under REMOTE_MCP_NAME so aliases, permissions and status text are shared
 *  with remote environments. The server binds X-Sandbox-Session to one sandbox
 *  (created on first call, reused after); the model never sees a sandbox id. */
export function sandboxMcpServer(url: string, sessionId: string, token: string = env.sandbox.mcpToken()): McpHttpServerConfig {
  return {
    type: "http",
    url,
    headers: { "X-Sandbox-Session": sessionId, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  };
}
