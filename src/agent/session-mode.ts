import type { OneOnOneLockRow } from "../db/one-on-one";
import { renderRuntimeFile } from "../soul/runtime/render";

/**
 * System-prompt block telling the model whether this thread is a private `/1on1`
 * session. The session reboots whenever the lock is taken or released
 * (gateway: `OneOnOne.lock/unlock` + `agent.reload`), so a block computed from the
 * lock at session start stays accurate for the session's lifetime.
 *
 * Returns "" when the thread is unlocked (ordinary group/channel mode) so the
 * caller can drop it from the appended blocks.
 */
/** Where a remote session's tools run, as the prompt describes it. */
export interface RemoteModeInfo {
  userId: string;
  dir: string;
  /** Absent for a pre-environment tailcat claim. */
  env?: { name: string; kind: string; trust: "user-machine" | "provisioned"; shared?: boolean };
}

/** Sandbox mode for the prompt: `on` = this thread's tools run in its sandbox;
 *  `available` = a sandbox server is configured and this thread is not in it. */
export interface SandboxModeInfo {
  on?: boolean;
  available?: boolean;
  /** The repositories' directory inside the sandbox. */
  root?: string;
  /** The branch names git_push accepts, as a regular expression source. */
  branchPattern?: string;
}

export function sessionModeBlock(
  lock: OneOnOneLockRow | null,
  remote?: RemoteModeInfo | null,
  sandbox: SandboxModeInfo = {},
): string {
  const base = lockBlock(lock);
  if (remote) return [base, remoteBlock(remote)].filter(Boolean).join("\n\n");
  if (sandbox.on) return [base, sandboxBlock(sandbox)].filter(Boolean).join("\n\n");
  if (sandbox.available) return [base, SANDBOX_AVAILABLE_BLOCK].filter(Boolean).join("\n\n");
  return base;
}

const SANDBOX_AVAILABLE_BLOCK = [
  "<sandbox-available>",
  "Code work (cloning, building, testing, editing or committing a repository) runs in a per-thread sandbox, not on this server. Before any code work, call mcp__slaude_surface__enter_sandbox; if the user is not allowed, say so and do not do the code work here. Reading, answering questions and calling MCP tools stay here.",
  "</sandbox-available>",
].join("\n");

function sandboxBlock(s: SandboxModeInfo): string {
  const root = s.root || "/workspace";
  return [
    "<sandbox-mode>",
    `Your file and shell tools (Bash, Read, Write, Edit, Glob, Grep) run in an isolated sandbox for this thread, not on this server. Repositories are under ${root}.`,
    "The sandbox holds no credentials: anything that needs one (pushing code, opening a pull request, calling an API) cannot be done from Bash there. The knowledge base, MCP servers and web tools are unchanged and still run here.",
    "Background jobs: Bash with run_in_background returns an ID; read output with mcp__remote__bash_output and stop it with mcp__remote__bash_kill.",
    `To publish work: commit on a branch whose name matches \`${s.branchPattern ?? "^agent/"}\`, then call mcp__remote__git_push. It asks a person for approval and pushes from outside the sandbox. It never force-pushes.`,
    "The repositories have no remote inside the sandbox, so `git fetch` or `git pull` from Bash fails. To bring newer commits in, call mcp__remote__git_fetch with the branch names; they arrive as mirror/<branch>. Rebase on the mirrored default branch before a push.",
    "If a sandbox tool fails because the sandbox is unreachable or expired, stop and tell the user. Do not retry in a loop and do not work around it.",
    "The user can leave with `/sandbox off`, which destroys the sandbox: push anything worth keeping first.",
    "</sandbox-mode>",
  ].join("\n");
}

function lockBlock(lock: OneOnOneLockRow | null): string {
  if (!lock) return "";
  if (lock.open_scope !== null) {
    const scopeLine = lock.open_scope.trim()
      ? `Active scope constraint (applies to all guests — not the session owner <@${lock.locked_user}>): ${lock.open_scope.trim()}`
      : `No additional scope constraint is active — guests may participate freely.`;
    return renderRuntimeFile("modules/one-on-one-open.md", { LOCKED_USER: lock.locked_user, SCOPE_LINE: scopeLine });
  }
  return renderRuntimeFile("modules/one-on-one-locked.md", { LOCKED_USER: lock.locked_user });
}

function remoteBlock(r: RemoteModeInfo): string {
  const where = r.env?.shared
    ? `on a SHARED machine, environment \`${r.env.name}\` (${r.env.kind}), in \`${r.dir}\`. It is not disposable and other people use it, so change only what the task needs`
    : r.env?.trust === "provisioned"
    ? `in a disposable sandbox environment \`${r.env.name}\` (${r.env.kind}), in \`${r.dir}\``
    : `on <@${r.userId}>'s own machine${r.env ? ` (environment \`${r.env.name}\`, ${r.env.kind})` : ""}, in \`${r.dir}\``;
  return renderRuntimeFile("modules/remote.md", { WHERE: where });
}
