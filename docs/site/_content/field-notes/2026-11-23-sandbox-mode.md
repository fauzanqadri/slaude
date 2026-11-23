# Sandbox mode: a thread's tools on a sandbox MCP server

A thread can now run its shell and file tools in an isolated sandbox that belongs to the thread, served by an external
MCP server over streamable HTTP. This note records the decisions behind it. The mechanism only; nothing here is
specific to a deployment.

## Shape

- **One namespace with remote environments.** The sandbox server is mounted as the `remote` MCP server, so the
  aliases (`Bash` to `mcp__remote__bash` and the rest), the permission mirror, the local-tool deny hook, status text
  and owner-guardrail name matching are the ones remote environments already use. Only the transport differs: HTTP
  with an `X-Sandbox-Session` header instead of SSH.
- **Keyed by session id.** The server creates a sandbox on the first call for a session and reuses it. The model never
  sees a sandbox id.
- **A row per thread.** `sandbox_threads` (migration 0055) holds the switch. On a node, the gateway signs `sandbox: true`
  into the job token and the switch joins the session fingerprint, so a change restarts a warm session.
- **The last command wins.** `/sandbox on` switches off the thread's environment (through the same check `/env off`
  uses, now one function, `turnEnvironmentOff`), and choosing an environment destroys the sandbox. The agent's
  `enter_sandbox` never replaces an environment.
- **A remote environment beats the sandbox** if both are somehow present: the person chose their own machine.

## Publishing

`git_push` runs on the sandbox server with the server's key. slaude adds three checks of its own:

- it always asks a person and is refused in `plan`, `dontAsk` and `bypassPermissions`;
- an approval is never kept as an allow rule, since a rule would skip the next push's card;
- a `PreToolUse` hook refuses bypass mode (hooks run in every mode, `canUseTool` may not) and any branch outside
  `SLAUDE_GIT_PUSH_BRANCH_PATTERN`, matched against the whole name, plus the usual unsafe ref shapes.

The server keeps its own branch and remote rules. The two patterns must agree; slaude's check is the earlier refusal,
not the only one.

`git_fetch` is allowed like a read: it moves branches from the server's mirror into the sandbox and publishes nothing.

## Not done here

- A note queued for the agent after `/sandbox off` is in-process; on a split deployment the node misses it, though the
  reload still reaches it.
- No local-execution kill switch: a thread outside sandbox mode still has host tools.
