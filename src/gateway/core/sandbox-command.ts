import { env } from "../../config/env";
import * as Remote from "../../db/remote";
import * as Sandbox from "../../db/sandbox";
import { SANDBOX_GONE_NOTE, destroySandbox, turnSandboxOff } from "../../remote/sandbox-destroy";
import type { SlashHit } from "../slack/commands";
import { turnRemoteOff, type RemoteCommandDeps } from "./remote-command";

type SandboxHit = Extract<SlashHit, { kind: "sandbox" }>;

export interface SandboxCommandCtx {
  channelId: string;
  threadTs: string;
  userId: string;
  /** The thread's session id: the X-Sandbox-Session the sandbox server keys on. */
  sessionId: string;
  isManager: boolean;
  reply(text: string): Promise<void>;
  /** Reboot the session once the current turn ends (agent.reloadAfterTurn). */
  reloadAfterTurn(): void;
  /** Queue a line for the agent's transcript on its next turn (agent.noteSessionEvent). */
  note(text: string): void;
}

export interface SandboxCommandDeps {
  destroy: (sessionId: string) => Promise<boolean>;
  remoteCleanup?: RemoteCommandDeps["cleanup"];
}

const defaultDeps: SandboxCommandDeps = { destroy: destroySandbox };

/** `/sandbox [on|off|status]`: per-thread sandbox mode. On and off are limited to
 *  SLAUDE_SANDBOX_AUTO_USERS; status is open. On replaces /remote (the last
 *  command wins); off destroys the sandbox at once. */
export async function handleSandboxCommand(hit: SandboxHit, ctx: SandboxCommandCtx, deps: SandboxCommandDeps = defaultDeps): Promise<void> {
  if (!env.sandbox.mcpUrl()) {
    await ctx.reply(":no_entry: `/sandbox` is not configured on this deployment (SLAUDE_SANDBOX_MCP_URL is empty).");
    return;
  }
  const { channelId, threadTs, userId } = ctx;

  if (hit.action === "status") {
    const on = await Sandbox.find(channelId, threadTs);
    await ctx.reply(on
      ? `Sandbox mode: *on* (since <@${on.created_by}> turned it on) — my shell and file tools run in this thread's sandbox.`
      : "Sandbox mode: *off* — tools run on the server. `/sandbox on` to work on code in a sandbox.");
    return;
  }

  if (!env.sandbox.autoAllowed(userId)) {
    await ctx.reply(":no_entry: You are not on this deployment's sandbox allowlist (SLAUDE_SANDBOX_AUTO_USERS); ask the manager to add you.");
    return;
  }

  if (hit.action === "off") {
    const r = await turnSandboxOff(channelId, threadTs, ctx.sessionId, deps.destroy);
    if (!r.wasOn) {
      await ctx.reply("Sandbox mode is not on in this thread.");
      return;
    }
    ctx.note(SANDBOX_GONE_NOTE);
    ctx.reloadAfterTurn();
    await ctx.reply(r.destroyed
      ? ":wastebasket: Sandbox *off* and destroyed — anything not pushed is gone. Tools run on the server from the next message."
      : ":warning: Sandbox *off*, but the sandbox server did not confirm the destroy; it will stop the sandbox when idle and delete it later. Tools run on the server from the next message.");
    return;
  }

  // action === "on"
  if (await Sandbox.find(channelId, threadTs)) {
    await ctx.reply("Sandbox mode is already on in this thread.");
    return;
  }
  let replacedRemote = false;
  if (await Remote.findTarget(channelId, threadTs)) {
    const r = await turnRemoteOff(ctx, deps.remoteCleanup ? { cleanup: deps.remoteCleanup } : undefined);
    if (!r.ok) {
      await ctx.reply(r.message);
      return;
    }
    replacedRemote = true;
  }
  await Sandbox.set({ channelId, threadTs, createdBy: userId });
  ctx.reloadAfterTurn();
  await ctx.reply(
    `:package: Sandbox *on* — from the next message my shell and file tools run in this thread's own sandbox (the first command takes ~20s to start it).${replacedRemote ? " Remote mode is off." : ""} \`/sandbox off\` destroys it.`,
  );
}
