# Agent host API and sandbox mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an external orchestrator use a persona through a generic `/agent/v1` API (tasks, requests, actions, CloudEvents webhooks), let a thread run its file and shell tools in an isolated sandbox, and ship Helm charts for both.

**Architecture:** Seven pull requests, each usable without the ones after it. Sandbox mode reuses `src/remote/`'s tool aliasing with an HTTP MCP transport. The API is one new module, `src/agentapi/`, mounted beside `/v1` in `src/health.ts`; tasks run through the existing turn queue or a locked-down background-style query; requests are their own table and Slack cards; events go through an outbox delivered by a leader-only loop. slaude stores the caller's `correlation` and never reads it.

**Tech Stack:** Bun, TypeScript, zod, bun:test, `bun:sqlite` and Postgres (`src/db/`), Slack Bolt, Helm 3.

**Spec:** `docs/superpowers/specs/2026-11-23-agent-api-and-sandbox-trd.md`

## Global Constraints

- Public repo: no deployment names, people, channel ids or organisation names in code, tests, docs, commit messages or PR text. Generic fixtures only (`support-bot`, `process-engine`, `slack:channel:<id>`).
- Before every `git add`: scratch scan, then the leak scan from `CLAUDE.md` over `git diff --cached -U0`.
- No `Co-Authored-By` or "Generated with" trailer. Enable the hook once: `git config core.hooksPath .githooks`. One logical change per commit, Conventional Commits.
- Gates after every task: `bun run typecheck` and the task's tests. Full `bun test` before each pull request.
- Every new table: a Postgres migration in `src/db/migrations/` (next number after the latest on `main`, currently `0054`) and the same table in `src/db/drivers/sqlite.ts`. `tests/db/schema-drift.test.ts` must stay green.
- Every PR ships as a release candidate (schema or agent loop). No tag, version bump or release notes inside a feature PR; that is the release step (`.claude/skills/release-prep/SKILL.md`).
- New behaviour is off unless configured: no `SLAUDE_SANDBOX_MCP_URL` means no sandbox; no `api-clients/` file means `/agent/v1` answers `404` on every path.
- Each PR description links the TRD and states which TRD sections it implements.

## Review Focus

- A sandbox-mode thread must never fall back to local tools when the sandbox server is unreachable: the call fails, it does not run on the host.
- `git_push` never pushes with force, never to a remote outside the allowlist, never a branch outside `SLAUDE_GIT_PUSH_BRANCH_PATTERN`.
- A client can never read, cancel or receive events for another client's resources.
- A repeated `Idempotency-Key` with a different body is a `409`, never a silent second resource.
- An outbox row is written in the same transaction as the state change; a crash between them must not produce an event for a change that did not commit, or lose one for a change that did.
- A request card click from someone outside the resolved respondents is refused and leaves the request pending.
- A task whose turn was lost in a restart ends `failed` with an event, never `running` forever.

## File Structure

- **PR 1 (sandbox):** Create `src/db/sandbox.ts`, `src/gateway/core/sandbox-command.ts`, `src/remote/sandbox-call.ts`, `src/remote/tools/git-push.ts`. Modify `src/remote/mcp.ts`, `src/remote/fingerprint.ts`, `src/agent/manager.ts`, `src/agent/session-mode.ts`, `src/config/env.ts`, `src/config/gateway-only-env.ts`, `src/gateway/slack/commands.ts`, `src/gateway/core/surface-mcp.ts`, `src/tools/contracts/surface.ts`, `src/soul/runtime/modules/remote.md`. Tests under `tests/remote/`, `tests/db/`, `tests/gateway/core/`, `tests/agent/manager-remote.test.ts`.
- **PR 2 (Helm):** Create `deploy/helm/slaude/**`, `deploy/helm/sandbox/**`, `tests/deploy/helm-parity.test.ts`, `tests/deploy/fixtures/scale-values.yaml`. Modify `deploy/k8s-local/up.sh`, `.github/workflows/` (chart lint and OCI publish), `docs/site/_content/deploy/` (one page).
- **PR 3 to 7 (agent API):** Create `src/agentapi/{index,routes,clients,auth,idempotency,conversations,capabilities,tasks,submit-tool,requests,request-card,outbox,deliver,signature,actions,triggers}.ts`, `src/db/agent-api.ts`, migrations `00xx_agent_api_*.sql`, `docs/agent-api/openapi.yaml`. Modify `src/health.ts`, `src/server.ts`, `src/gateway/core/gateway.ts` (`GatewayHandle`), `src/knowledge/gated-dispatch.ts` (`TurnOrigin`), `src/gateway/slack/commands.ts`. Tests under `tests/agentapi/`.

---

## PR 0: TRD

### Task 0.1: Commit the TRD and this plan
**Files:** `docs/superpowers/specs/2026-11-23-agent-api-and-sandbox-trd.md`, `docs/superpowers/plans/2026-11-23-agent-api-and-sandbox.md`.
- [ ] **Step 1:** Leak scan; check the three Mermaid diagrams render on GitHub (no `;` inside a sequence message).
- [ ] **Step 2:** Commit `docs: TRD and plan for an agent host API and sandbox mode`. Open the PR with the TRD's section 4 diagrams summarised in the description.

---

## PR 1: Sandbox mode (TRD section 6)

The design exists on an older branch that diverged from `main` long ago. Rebuild it on `main`; do not cherry-pick. Do not port anything process-specific (stage cards, workflow commands, a commit trailer, a fixed branch prefix).

### Task 1.1: Config
**Files:** Modify `src/config/env.ts`, `src/config/gateway-only-env.ts`; Test `tests/config/gateway-only-env-coverage.test.ts`.
**Interfaces:** Produces `env.sandbox.{enabled(), mcpUrl(), mcpToken(), root(), autoUsers(), pushRemotes(), branchPattern()}`; `mcpUrl()` returns `""` unless `SLAUDE_SANDBOX=1`.
- [ ] **Step 1:** Test: with `SLAUDE_SANDBOX` unset, `env.sandbox.mcpUrl()` is `""` even when `SLAUDE_SANDBOX_MCP_URL` is set; with `SLAUDE_SANDBOX=1` it returns the URL. `SLAUDE_GIT_PUSH_BRANCH_PATTERN` defaults to `^agent/[A-Za-z0-9._/-]+$`.
- [ ] **Step 2:** Run; FAIL. **Step 3:** Implement. **Step 4:** PASS; commit `config: sandbox mode settings`.

### Task 1.2: `sandbox_threads` table
**Files:** Create migration `00xx_sandbox_threads.sql`, `src/db/sandbox.ts`; Modify `src/db/drivers/sqlite.ts`; Test `tests/db/sandbox.test.ts`.
**Interfaces:** `enableSandbox(channelId, threadTs, userId)`, `disableSandbox(channelId, threadTs)`, `sandboxFor(channelId, threadTs): Promise<SandboxThreadRow | null>`.
- [ ] **Step 1:** Test enable, read, disable, enable twice is idempotent. **Step 2:** FAIL. **Step 3:** Implement on both drivers. **Step 4:** PASS with `schema-drift.test.ts`; commit `db: sandbox_threads`.

### Task 1.3: HTTP MCP transport for the remote tool aliases
**Files:** Modify `src/remote/mcp.ts`; Create `src/remote/sandbox-call.ts`; Test `tests/remote/mcp.test.ts`.
**Interfaces:** `sandboxMcpServer(url, sessionId, token): McpServerConfig` (type `http`, headers `Authorization`, `X-Sandbox-Session`). Reuses `REMOTE_TOOL_ALIASES`, `makeRemoteCanUseTool`, `denyLocalBuiltins`.
- [ ] **Step 1:** Test the config shape, the header values, and that `denyLocalBuiltins` still denies the six local tools when the sandbox server is the alias target.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; commit `remote: sandbox MCP server over HTTP`.

### Task 1.4: Session wiring and fingerprint
**Files:** Modify `src/agent/manager.ts`, `src/remote/fingerprint.ts`, `src/agent/session-mode.ts`, `src/soul/runtime/modules/remote.md`; Test `tests/agent/manager-remote.test.ts`, `tests/agent/node-session-mode.test.ts`.
- [ ] **Step 1:** Tests: a thread in `sandbox_threads` gets the sandbox server and aliased tools; a thread not in it gets host tools; toggling changes the fingerprint so a fresh SDK session starts; the session-mode prompt block names the sandbox root; with the sandbox unreachable, a tool call errors and nothing runs locally.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; commit `agent: run a thread's tools in its sandbox`.

### Task 1.5: `/sandbox` command and `enter_sandbox` tool
**Files:** Create `src/gateway/core/sandbox-command.ts`; Modify `src/gateway/slack/commands.ts`, `src/tools/contracts/surface.ts`, `src/gateway/core/surface-mcp.ts`; Test `tests/gateway/core/sandbox-command.test.ts`, `tests/gateway/slack/commands-sandbox.test.ts`, `tests/surface-mcp.test.ts`.
- [ ] **Step 1:** Tests: `/sandbox on|off|status`; `on|off` refused for a user outside `SLAUDE_SANDBOX_AUTO_USERS` when set; `enter_sandbox` follows the same rule for the turn's initiator; `status` always answers; `off` asks the server to destroy the session.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; commit `gateway: /sandbox and enter_sandbox`.

### Task 1.6: `git_push` with server-side credentials
**Files:** Create `src/remote/tools/git-push.ts`; Test `tests/remote/git-push.test.ts`.
- [ ] **Step 1:** Tests: refuses a remote outside `SLAUDE_GIT_PUSH_REMOTES`; refuses a branch not matching `SLAUDE_GIT_PUSH_BRANCH_PATTERN`; never sends `force`; goes through the permission gate; records audit.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; commit `remote: git_push through the sandbox server`.

### Task 1.7: Docs and field note
**Files:** Create `docs/site/_content/deploy/sandbox.md`, `docs/site/_content/field-notes/<date>-sandbox-mode.md`; Modify `CLAUDE.md` (one findings line).
- [ ] **Step 1:** Write; leak scan; commit `docs: sandbox mode`.

---

## PR 2: Helm charts (TRD section 7)

### Task 2.1: `deploy/helm/slaude`, `scale` topology
**Files:** Create `deploy/helm/slaude/{Chart.yaml,values.yaml,values.schema.json,templates/*}`, `tests/deploy/helm-parity.test.ts`, `tests/deploy/fixtures/scale-values.yaml`.
- [ ] **Step 1:** Parity test: `helm template` with the fixture; compare the gateway and node Deployments (image, env names, probes, ports, volumes, security context), the ConfigMap keys, the Service and Ingress against `deploy/k8s-scale/`. Skip with a message when `helm` is not on `PATH`.
- [ ] **Step 2:** FAIL. **Step 3:** Templates for namespace-less resources, config, PVC, gateway, node per label, ingress, optional KEDA or HPA, optional egress NetworkPolicy. Secrets by name only. **Step 4:** PASS; commit `deploy: slaude Helm chart (scale)`.

### Task 2.2: `mono` topology and sandbox and API values
- [ ] **Step 1:** Test: `topology: mono` renders one Deployment with a `$SLAUDE_HOME` PVC and no node Deployment; `sandbox.mcpUrl` sets `SLAUDE_SANDBOX=1` and the URL; `agentApi.clientsConfigMap` mounts at `$SLAUDE_HOME/api-clients`; the schema rejects an unknown topology.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; commit `deploy: mono topology and sandbox values`.

### Task 2.3: `deploy/helm/sandbox`
**Files:** Create `deploy/helm/sandbox/**`; Test `tests/deploy/helm-sandbox.test.ts`.
- [ ] **Step 1:** Test: server Deployment and Service; with `backend: k8s`, a ServiceAccount and a Role limited to pods in the release namespace; token, push key and remotes by Secret reference; idle and destroy timeouts as env; NetworkPolicies when enabled.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; commit `deploy: sandbox server Helm chart`.

### Task 2.4: Local cluster and CI
**Files:** Modify `deploy/k8s-local/up.sh`, `.github/workflows/<ci>.yml`; Create `docs/site/_content/deploy/helm.md`.
- [ ] **Step 1:** `up.sh --helm` installs the slaude chart instead of the kustomize overlay; `verify-turns.sh` passes unchanged.
- [ ] **Step 2:** CI: `helm lint` and `helm template` for both charts and topologies, `kubeconform` when available, OCI push of both charts on a release tag.
- [ ] **Step 3:** Commit `deploy: Helm in local cluster and CI`.

---

## PR 3: `/agent/v1` foundation (TRD sections 5.1, 5.2)

### Task 3.1: Client registry
**Files:** Create `src/agentapi/clients.ts`; Test `tests/agentapi/clients.test.ts`.
**Interfaces:** `loadClients(dir): Promise<Map<string, ApiClient>>`; `ApiClient = { name, token, personas, channels, actions, events: { url, secret, notifyHosts } }`; tokens and secrets resolved from `{ env: NAME }`.
- [ ] **Step 1:** Tests: valid file loads; unknown key fails (zod `.strict()`); missing env reference fails loudly at boot; two clients with one token fail. **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; commit `agentapi: client registry`.

### Task 3.2: Router, auth and mount
**Files:** Create `src/agentapi/{index,routes,auth}.ts`; Modify `src/health.ts`, `src/server.ts`, `src/gateway/core/gateway.ts`; Test `tests/agentapi/auth.test.ts`, `tests/gateway/api/route-table.test.ts`.
- [ ] **Step 1:** Tests over real HTTP (pattern of `tests/gateway/api/v1-roundtrip.test.ts`): no clients means `404` everywhere; wrong token `401`; constant-time compare (`timingSafeStringEqual`); body over the cap `413` (`readBodyCapped`); errors are `{error}`; mounted for gateway and mono, never node.
- [ ] **Step 2:** FAIL. **Step 3:** `RouteDef` table in the style of `src/gateway/api/index.ts`. **Step 4:** PASS; commit `agentapi: router and bearer auth`.

### Task 3.3: Idempotency and conversations
**Files:** Create `src/agentapi/{idempotency,conversations}.ts`, `src/db/agent-api.ts`, migration `00xx_agent_api_base.sql` (`agent_idempotency`, `agent_conversations`); Modify `src/db/drivers/sqlite.ts`; Test `tests/agentapi/conversations.test.ts`.
- [ ] **Step 1:** Tests: create returns `201 {conversationId}`; persona or channel outside the client allowlist `403`; same key and body returns the first response; same key, different body `409`; another client's conversation `404`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; commit `agentapi: conversations and idempotency`.

### Task 3.4: Capabilities and turn origin `api`
**Files:** Create `src/agentapi/capabilities.ts`; Modify `src/knowledge/gated-dispatch.ts`; Test `tests/agentapi/capabilities.test.ts`, existing job-token tests.
- [ ] **Step 1:** Tests: capabilities report fresh context, sandbox (from `env.sandbox`), allowed actions (client allowlist intersected with persona tools); `TurnOrigin` accepts `api`, is signed into the job token, and is not interactive.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; commit `agentapi: capabilities and api turn origin`.

---

## PR 4: Tasks (TRD section 5.3)

### Task 4.1: `agent_tasks` and lifecycle
**Files:** migration `00xx_agent_tasks.sql`, `src/db/agent-api.ts`, `src/agentapi/tasks.ts`; Test `tests/agentapi/tasks.test.ts`.
**Interfaces:** status `queued → running → completed | failed | cancelled`; `GET /tasks/:id`, `POST /tasks/:id/cancel`.
- [ ] **Step 1:** Tests: `POST /tasks` returns `202 {taskId}`; status transitions; cancel of a finished task `409`; deadline past ends `failed`. **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; commit `agentapi: task records`.

### Task 4.2: `context: thread` through the turn queue
- [ ] **Step 1:** Test: a thread task dispatches through `QueueDispatch.dispatch` (`src/gateway/core/dispatch.ts`) with origin `api`; the turn's end marks the task; a restart leaves a running task that the sweep fails. **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; commit `agentapi: thread tasks`.

### Task 4.3: `context: fresh` and `placement: workspace`
- [ ] **Step 1:** Test: a fresh task builds its query with `passQueryOptions` and `passChildEnv` (`src/background/runner.ts`): no tools unless allowed, `settingSources: []`, strict MCP config; `placement: workspace` mounts the sandbox server from PR 1, and is refused with `422` when the sandbox is off. **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; commit `agentapi: fresh tasks and workspace placement`.

### Task 4.4: `submit_result`
**Files:** Create `src/agentapi/submit-tool.ts`; Test `tests/agentapi/submit-tool.test.ts`.
- [ ] **Step 1:** Tests: result checked against the task's JSON Schema; schema problems go back to the model; `validateUrl` called through `outboundFetch`; `422 {problems}` goes back to the model; a second submit after success refused. **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; commit `agentapi: submit_result`.

---

## PR 5: Requests (TRD section 5.4)

### Task 5.1: `agent_requests`
**Files:** migration `00xx_agent_requests.sql`, `src/db/agent-api.ts`, `src/agentapi/requests.ts`; Test `tests/agentapi/requests.test.ts`.
- [ ] **Step 1:** Tests: create `202 {requestId}`; kinds `decision` and `choice` (options required for `choice`); default expiry 3 days, more than 30 refused; read, remind, cancel; another client's request `404`. **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; commit `agentapi: request records`.

### Task 5.2: Request card and respondents
**Files:** Create `src/agentapi/request-card.ts`; Modify the Slack action registration; Test `tests/agentapi/request-card.test.ts`.
**Interfaces:** `action_id` `slaude_req:<option>:<requestId>`; card built in the style of `ApprovalGate` (`src/gateway/slack/approval-gate.ts`).
- [ ] **Step 1:** Tests: respondents resolved from users, roles (`usersWithRole`, `roleOf`) and category (`decideApprovers`); a click by someone else is refused and the request stays pending; the answer stores the responder and resolved roles; a decided card keeps its blocks and replaces the buttons with a decision line; a second click is ignored. **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; commit `agentapi: request cards`.

### Task 5.3: Expiry sweep, audit, metrics
- [ ] **Step 1:** Tests: the sweep runs under `leaderLoop`, claims each expiry once with `claimSlot`, edits the card; `audit()` events `request.opened|answered|expired|cancelled`; counters by kind and outcome. **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; commit `agentapi: request expiry, audit and metrics`.

---

## PR 6: Outbox and CloudEvents (TRD section 5.6)

### Task 6.1: `agent_outbox` in the same transaction
**Files:** migration `00xx_agent_outbox.sql`, `src/agentapi/outbox.ts`; Test `tests/agentapi/outbox.test.ts`.
- [ ] **Step 1:** Tests: task completion and request answer write the outbox row in the same transaction; a failed state write writes no row. **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; commit `agentapi: event outbox`.

### Task 6.2: Delivery, signature, retry
**Files:** Create `src/agentapi/{deliver,signature}.ts`; Test `tests/agentapi/deliver.test.ts`, `tests/agentapi/signature.test.ts`.
- [ ] **Step 1:** Tests: structured CloudEvents 1.0 body and `application/cloudevents+json`; `webhook-signature: v1,<hex>` matches the snippet in the docs page; exponential backoff schedule; `notify.url` used only when its host is in `notifyHosts`, else the client URL; `404` or `410` from a notify URL stops delivery; delivery through `outboundFetch`; one worker under `leaderLoop`. **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; commit `agentapi: CloudEvents webhook delivery`.

### Task 6.3: Docs
**Files:** Create `docs/site/_content/guides/agent-api.md` (client file, signature verification snippet, event types), a field note, one `CLAUDE.md` findings line.
- [ ] **Step 1:** Write; leak scan; commit `docs: agent API events`.

---

## PR 7: Actions, triggers, OpenAPI (TRD sections 5.5, 5.7)

### Task 7.1: Actions
**Files:** Create `src/agentapi/actions.ts`; Test `tests/agentapi/actions.test.ts`.
- [ ] **Step 1:** Tests: tool outside the client allowlist `403`; allowed tool runs with no model through the permission policy and owner guardrails; audit row records the client; `git_push` in a sandbox thread uses PR 1's tool. **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; commit `agentapi: actions`.

### Task 7.2: Trigger dispatch
**Files:** Create `src/agentapi/triggers.ts`; Modify `src/gateway/slack/commands.ts`; Test `tests/agentapi/triggers.test.ts`.
- [ ] **Step 1:** Tests: a configured `/<command>` posts `{conversationId, actor, text}` to its client's event URL as a CloudEvent `ai.slaude.trigger.invoked` through the outbox; an unconfigured command behaves as today. **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS; commit `agentapi: slash command triggers`.

### Task 7.3: OpenAPI and drift test
**Files:** Create `docs/agent-api/openapi.yaml`, `tests/agentapi/openapi-drift.test.ts`.
- [ ] **Step 1:** Test: every route in the agent API route table appears in the OpenAPI document with the same method and path, and the reverse. **Step 2:** FAIL. **Step 3:** Write the document. **Step 4:** PASS; commit `docs: agent API OpenAPI document`.

---

## End-to-end verification

- **After PR 1:** in a test channel on a test persona, `/sandbox on`, ask for a `Bash` command, and check it ran in a sandbox pod; `/sandbox off` destroys it; `git_push` to a disallowed branch is refused.
- **After PR 2:** `deploy/k8s-local/up.sh --helm` then `verify-turns.sh`; install both charts into a test namespace and repeat the PR 1 check.
- **After PR 7:** from a local script acting as a client: open a conversation, submit a fresh task with `placement: workspace`, receive a signed CloudEvent at a local receiver, open a decision request, answer it in Slack, receive `request.responded`, run `git_push` as an action. Repeat a create with the same `Idempotency-Key` and get the first response. Restart the pod mid-task and check `GET /tasks/:id` reports `failed` with an event.
