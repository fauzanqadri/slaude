---
title: Sandbox mode
description: Run a thread's shell and file tools in an isolated per-thread sandbox served by a sandbox MCP server, with git pushes made server-side.
---

# Sandbox mode (`/sandbox`)

Sandbox mode moves a thread's shell and file tools (Bash, Read, Write, Edit, Glob, Grep) into an isolated sandbox that belongs to that thread. The sandbox is created by a separate **sandbox MCP server** on the first tool call and reused for the rest of the thread. The conversation, the model API key, MCP credentials, the knowledge base and the transcript stay on slaude.

The sandbox holds no credential. Commits leave it only through `git_push`, which the sandbox server runs with its own key after a person approves.

> **Prerequisites:** The operator has set `SLAUDE_SANDBOX=1` and `SLAUDE_SANDBOX_MCP_URL` (off by default), and runs a sandbox MCP server that serves the tools below.

---

## 1. Commands

| Command | Effect |
|---|---|
| `/sandbox` or `/sandbox status` | Shows whether the thread is in sandbox mode. Open to everyone. |
| `/sandbox on` | From the next message, the thread's tools run in its sandbox. If the thread runs in an [environment](environments.md), that environment is switched off first (only someone allowed to switch it off may do this). |
| `/sandbox off` | Leaves sandbox mode and asks the server to destroy the sandbox at once. Files and unpushed commits are gone. |

`on` and `off` are limited to `SLAUDE_SANDBOX_AUTO_USERS` when it is set. Choosing an environment with `/env use` or `/remote` ends sandbox mode in the same way: the last command wins.

The agent can also move a thread into its sandbox before code work with the `enter_sandbox` tool, under the same allowlist. It never replaces an environment the user chose.

## 2. What the agent sees

- In a thread that is not in sandbox mode, while a server is configured, the system prompt carries a short `<sandbox-available>` hint: code work belongs in the sandbox.
- In sandbox mode, the prompt carries a `<sandbox-mode>` block: where the repositories are (`SLAUDE_SANDBOX_ROOT`), that the sandbox holds no credential, and how to publish.

## 3. Tools

The server serves the six aliased tools plus four of its own, all under `mcp__remote__*`, the same namespace as remote environments.

| Tool | Permission |
|---|---|
| `read`, `glob`, `grep`, `bash_output` | Allowed, as for the local built-ins |
| `write`, `edit` | As `Write` and `Edit`: ask, or allowed in `acceptEdits` |
| `bash`, `bash_kill` | As `Bash` |
| `git_fetch` | Allowed: it moves branches from the server's mirror into the sandbox as `mirror/<branch>` and publishes nothing |
| `git_push` | Always asks a person. Refused in `plan`, `dontAsk` and `bypassPermissions`. An approval is never remembered as an allow rule. The branch must match `SLAUDE_GIT_PUSH_BRANCH_PATTERN` (default `^agent/…`). The server never force-pushes and pushes only to the remotes it is configured for. |

Every other local-only built-in that writes files or runs code (NotebookEdit, Monitor, REPL, Workflow, worktrees, Artifact) is disabled in sandbox mode, as in remote mode.

## 4. Split deployments

On a gateway with nodes, the gateway signs the thread's sandbox switch into the job token (`sandbox: true`), and the node reads it from there; a node has no database. The switch is part of the session fingerprint, so turning it on or off restarts a warm session on its next turn.

## 5. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SLAUDE_SANDBOX` | `0` | Feature switch. The URL alone does nothing. |
| `SLAUDE_SANDBOX_MCP_URL` | empty | The sandbox MCP server (streamable HTTP). |
| `SLAUDE_SANDBOX_MCP_TOKEN` | empty | Bearer sent to the server. Stripped from the agent's own environment. |
| `SLAUDE_SANDBOX_ROOT` | `/workspace` | Where the repositories are inside a sandbox (for the prompt). |
| `SLAUDE_SANDBOX_AUTO_USERS` | empty | Slack user ids allowed to switch sandbox mode, comma-separated. Empty or `*` means everyone. |
| `SLAUDE_GIT_PUSH_BRANCH_PATTERN` | `^agent/[A-Za-z0-9][A-Za-z0-9._/-]*$` | Branch names `git_push` may publish, matched against the whole name. Set the sandbox server's own rule to the same pattern. |

## 6. The server contract

slaude expects an MCP server over streamable HTTP that:

- keys every call on the `X-Sandbox-Session` header (the thread's session id), creating a sandbox on the first call and reusing it after;
- serves `bash`, `bash_output`, `bash_kill`, `read`, `write`, `edit`, `glob`, `grep`, `git_push` and `git_fetch` with the same argument shapes as slaude's remote tools;
- accepts `DELETE /sandbox` with the same headers to destroy a session's sandbox at once;
- stops idle sandboxes and deletes them after a retention window, so a failed delete is not a leak.
