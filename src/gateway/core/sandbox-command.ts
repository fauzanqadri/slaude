/**
 * `/sandbox [on|off|status]`: per-thread sandbox mode. While on, the thread's
 * shell and file tools run on the sandbox MCP server (SLAUDE_SANDBOX_MCP_URL),
 * keyed by the thread's session id. On and off are limited to
 * SLAUDE_SANDBOX_AUTO_USERS; status is open. On replaces the thread's
 * environment (the last command wins); off destroys the sandbox at once.
 */
import { someSameAt } from "../../access/wired";
import { env } from "../../config/env";
import * as Envs from "../../db/environments";
import * as Sandbox from "../../db/sandbox";
import { SANDBOX_GONE_NOTE, destroySandbox, turnSandboxOff } from "../../remote/sandbox-destroy";
import type { SlashHit } from "../slack/commands";
import { defaultEnvDeps, turnEnvironmentOff, type EnvCommandCtx, type EnvCommandDeps } from "./env-command";

type SandboxHit = Extract<SlashHit, { kind: "sandbox" }>;

export interface SandboxCommandCtx extends EnvCommandCtx {
  /** Reboot the session once the current turn ends (agent.reloadAfterTurn). */
  reloadAfterTurn(): void;
}

export interface SandboxCommandDeps {
  destroy: (sessionId: string) => Promise<boolean>;
  /** Cleanup for an environment that `/sandbox on` replaces. */
  envCleanup: EnvCommandDeps["cleanup"];
}

/**
 * Whether a person may switch sandbox mode (`/sandbox on|off`, and the agent's
 * `enter_sandbox` on their turn). Unset, empty or `*` means everyone; otherwise
 * the speaker must be one of SLAUDE_SANDBOX_AUTO_USERS, compared through the
 * access seam.
 */
export async function maySwitchSandbox(o: { persona: string | null | undefined; teamId: string | null | undefined; userId: string | null | undefined }): Promise<boolean> {
  const listed = env.sandbox.autoUsers();
  if (listed.length === 0 || listed.includes("*")) return true;
  if (!o.userId) return false;
  return someSameAt(listed, (other) => ({ site: "sandbox.switch_allowed", persona: o.persona, teamId: o.teamId, userId: o.userId, otherUserId: other }));
}

const defaultDeps: SandboxCommandDeps = { destroy: destroySandbox, envCleanup: defaultEnvDeps.cleanup };

export async function handleSandboxCommand(hit: SandboxHit, ctx: SandboxCommandCtx, deps: SandboxCommandDeps = defaultDeps): Promise<void> {
  if (!env.sandbox.activeUrl()) {
    await ctx.reply(":no_entry: `/sandbox` is not enabled on this deployment (SLAUDE_SANDBOX is off or SLAUDE_SANDBOX_MCP_URL is empty).");
    return;
  }
  const { channelId, threadTs, userId } = ctx;

  if (hit.action === "status") {
    const on = await Sandbox.find(channelId, threadTs);
    await ctx.reply(on
      ? `Sandbox mode: *on* (turned on by <@${on.created_by}>). My shell and file tools run in this thread's sandbox.`
      : "Sandbox mode: *off*. Tools run on the server. `/sandbox on` to work on code in a sandbox.");
    return;
  }

  if (!(await maySwitchSandbox({ persona: ctx.personaId, teamId: ctx.teamId, userId }))) {
    await ctx.reply(":no_entry: You may not switch sandbox mode on this deployment (SLAUDE_SANDBOX_AUTO_USERS). Ask the manager to add you.");
    return;
  }

  if (hit.action === "off") {
    const r = await turnSandboxOff(channelId, threadTs, ctx.sessionId, deps.destroy);
    if (!r.wasOn) {
      await ctx.reply("Sandbox mode is not on in this thread.");
      return;
    }
    ctx.note?.(SANDBOX_GONE_NOTE);
    ctx.reloadAfterTurn();
    await ctx.reply(r.destroyed
      ? ":wastebasket: Sandbox *off* and destroyed. Anything not pushed is gone. Tools run on the server from the next message."
      : ":warning: Sandbox *off*, but the sandbox server did not confirm the destroy; it stops idle sandboxes and deletes them later. Tools run on the server from the next message.");
    return;
  }

  // action === "on"
  if (await Sandbox.find(channelId, threadTs)) {
    await ctx.reply("Sandbox mode is already on in this thread.");
    return;
  }
  let replacedEnv = false;
  if (await Envs.findBinding(channelId, threadTs)) {
    const r = await turnEnvironmentOff(ctx, { cleanup: deps.envCleanup });
    if (!r.ok) {
      await ctx.reply(r.message);
      return;
    }
    replacedEnv = r.wasBound;
  }
  await Sandbox.set({ channelId, threadTs, createdBy: userId });
  ctx.reloadAfterTurn();
  await ctx.reply(
    `:package: Sandbox *on*. From the next message my shell and file tools run in this thread's own sandbox (the first command starts it, which can take a while).${replacedEnv ? " The thread's environment is off." : ""} \`/sandbox off\` destroys it.`,
  );
}
