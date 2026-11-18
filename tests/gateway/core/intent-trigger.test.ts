import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { rmSync } from "node:fs";
import { createGateway } from "../../../src/gateway/core/gateway";
import { AgentManager } from "../../../src/agent/manager";
import type { Transport } from "../../../src/gateway/core/transport";
import { makeSlackSurfaceFactory } from "../../../src/gateway/slack/surface";
import { writeSoulFixture, WORLD } from "../../../src/gateway/sim/soul-fixture";
import { __resetSoulDataMemo, setSoulData, soulData } from "../../../src/soul/extract";
import { SoulDataSchema } from "../../../src/soul/data";
import { paths } from "../../../src/config/home";
import { db } from "../../../src/db/schema";
import * as OneOnOne from "../../../src/db/one-on-one";
import * as Sessions from "../../../src/db/sessions";
import * as MentionOnly from "../../../src/db/mention-only";
import * as Workflow from "../../../src/db/workflow";
import { makeGateRunner } from "../../../src/gateway/gate/runner";
import type { DecisionAdapter, DecisionRequest } from "../../../src/decision/types";
import { __setEngageStateForTests, memoryEngageState } from "../../../src/gateway/engage/budget";
import { __resetPersonaRegistry } from "../../../src/persona/registry";
import { factory } from "../../../src/workflow/client";
import { metrics } from "../../../src/metrics";

/**
 * The intent check through the real handler: a message nobody @mentioned that holds a pull
 * request link (or a listed word in a thread that holds one), confirmed by the decision
 * adapter, starts the intent's pipeline in the message's thread with its author as the
 * starter. Everything else is dropped exactly as today.
 */
const TEAM = "T";
const CH = "C0TEAM";
const DEV = "U0DEV0001";
const COLLEAGUE = "U0PEER";
const PR = "https://git.example.com/projects/proj/repos/svc/pull-requests/4000";
const PR2 = "https://git.example.com/projects/proj/repos/svc/pull-requests/4001";

function makeGw(adapter: DecisionAdapter | null) {
  const events = new Map<string, (args: any) => Promise<void>>();
  const posts: any[] = [];
  const state: { thread: any[] } = { thread: [] };
  const client: any = {
    auth: { test: async () => ({ user_id: "USLAUDEBOT", user: "quill", bot_id: "B_SLAUDE", team: TEAM, url: "x" }) },
    chat: { postMessage: async (a: any) => (posts.push(a), { ok: true, ts: `${Date.now()}.${posts.length}` }), update: async () => ({ ok: true }), postEphemeral: async () => ({ ok: true }) },
    reactions: { add: async () => ({ ok: true }), remove: async () => ({ ok: true }) },
    assistant: { threads: { setStatus: async () => ({ ok: true }) } },
    conversations: {
      info: async () => ({}), members: async () => ({}),
      replies: async () => ({ ok: true, messages: state.thread, response_metadata: { next_cursor: "" } }),
      history: async () => ({ ok: true, messages: [] }),
    },
    users: { info: async () => ({ user: { real_name: "Test" } }), profile: { set: async () => ({}) } },
    search: { messages: async () => ({}) },
  };
  const t: Transport = { client, action: () => {}, use: () => {}, start: async () => {}, stop: async () => {}, event: (n: string, fn: any) => void events.set(n, fn) };
  const agent = new AgentManager();
  const sends: string[] = [];
  agent.sendMessage = async (id: string, text: string) => {
    sends.push(text);
    agent.emit("event", { type: "done", sessionId: id });
  };
  const gateRunner = makeGateRunner({ mode: "off", adapter, tAct: 0.8, timeoutMs: 400, contextMessages: 8, log: () => {} });
  const h = createGateway(agent, t, { gateRunner, lookupClientFactory: () => client, surfaceFactory: makeSlackSurfaceFactory(client) });
  return { client, events, posts, sends, state, h };
}
type Gw = ReturnType<typeof makeGw>;

const nowTs = (o = 0) => `${Math.floor(Date.now() / 1000) + o}.000100`;
let seq = 0;
const nextTs = () => nowTs(++seq);
const event = (text: string, ts: string, thread?: string, user = DEV) => ({ type: "message", channel: CH, channel_type: "channel", user, team: TEAM, ts, ...(thread ? { thread_ts: thread } : {}), text });
const deliver = (g: Gw, text: string, ts: string, thread?: string, user = DEV, context: Record<string, unknown> = {}) =>
  g.events.get("message")!({ event: event(text, ts, thread, user), client: g.client, context: { teamId: TEAM, ...context } });
const settle = () => Bun.sleep(40);

let asked: DecisionRequest[] = [];
const answering = (choice: "yes" | "no"): DecisionAdapter => ({
  name: "scripted-test",
  decide: async (req) => (asked.push(req), Object.fromEntries(Object.keys(req.questions).map((k) => [k, { choice, confidence: 0.95 }]))),
});
const yes = answering("yes");
const no = answering("no");
const hangs: DecisionAdapter = { name: "scripted-hangs", decide: () => new Promise(() => {}) };

const intentCount = (outcome: string): number =>
  metrics.render().split("\n")
    .filter((l) => l.startsWith("slaude_intent_total{") && l.includes(`outcome="${outcome}"`))
    .reduce((n, l) => n + Number(l.split(" ").at(-1)), 0);

const setIntent = (mode: "shadow" | "on", words: string[] = ["review", "cek"]) =>
  setSoulData(SoulDataSchema.parse({
    ...soulData(),
    channelIntents: [{ channel: CH, name: "pr_review", mode, question: "Does the new message ask someone to review a pull request?", words, pipeline: "review" }],
  }));

const ENV_KEYS = ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLAUDE_SLACK_MODE", "SLAUDE_SLACK_API_URL", "SLAUDE_WORKFLOW", "SLAUDE_WORKFLOW_SERVICE_URL", "SLAUDE_INTENT_FORCE_SHADOW", "SLAUDE_INTENT_DAILY_BUDGET", "SLAUDE_INTENT_PER_HOUR"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
let gw: Gw | null = null;
let starts: any[] = [];
let startSpy: ReturnType<typeof spyOn> | null = null;

beforeEach(async () => {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.SLAUDE_WORKFLOW = "1";
  process.env.SLAUDE_WORKFLOW_SERVICE_URL = "http://factory.invalid";
  asked = [];
  starts = [];
  writeSoulFixture(WORLD);
  setIntent("on");
  __setEngageStateForTests(memoryEngageState());
  for (const t of ["sessions", "seen_events", "pending_gates", "ignores", "workflow_threads"]) await db.run(`DELETE FROM ${t}`).catch(() => {});
  await OneOnOne._wipeForTests();
  startSpy = spyOn(factory, "startRun").mockImplementation(async (i: any) => (starts.push(i), { runId: `run-${i.channelId}-${i.threadTs}`, pipeline: i.pipeline, pipelineVersion: 1 }));
});
afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  startSpy?.mockRestore();
  await gw?.h.stop();
  gw = null;
  __setEngageStateForTests(null);
  __resetPersonaRegistry();
  __resetSoulDataMemo();
  try { rmSync(paths.soul, { force: true }); } catch {}
});

describe("intent check: starts the pipeline", () => {
  it("a root request with a link starts the pipeline in its thread, with the author as starter and no model turn", async () => {
    const g = (gw = makeGw(yes));
    const ts = nextTs();
    await deliver(g, `tolong review <${PR}|svc#4000>`, ts);
    await settle();
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ pipeline: "review", channelId: CH, threadTs: ts, starter: DEV, request: PR });
    expect(g.sends).toEqual([]);
    expect(g.posts.at(-1)!.thread_ts).toBe(ts);
    expect(g.posts.at(-1)!.text).toContain("review@1");
    // The adapter was asked only the intent question, and saw no gate questions.
    expect(Object.keys(asked[0]!.questions)).toEqual(["intent"]);
  });

  it("a request addressed to a colleague starts it and does not disengage the thread", async () => {
    const g = (gw = makeGw(yes));
    const ts = nextTs();
    await deliver(g, `<@${COLLEAGUE}> tolong review ${PR}`, ts);
    await settle();
    expect(starts).toHaveLength(1);
    const row = await Sessions.findAnyByThread({ team_id: TEAM, channel_id: CH, thread_ts: ts });
    expect(row?.engaged).toBeTruthy();
  });

  it("a thread reply with a word and no link takes the most recent link in the thread", async () => {
    const g = (gw = makeGw(yes));
    const root = nowTs(-100);
    g.state.thread = [{ ts: root, user: DEV, text: `[REVIEW] <${PR}>` }, { ts: nowTs(-50), user: COLLEAGUE, text: `fixed in <${PR2}>` }];
    await deliver(g, "review lagi dong", nextTs(), root);
    await settle();
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ threadTs: root, request: PR2 });
  });

  it("two app copies of one message start one run", async () => {
    const g = (gw = makeGw(yes));
    const ts = nextTs();
    await Promise.all([
      deliver(g, `please review ${PR}`, ts, undefined, DEV, { apiAppId: "A0ONE" }),
      deliver(g, `please review ${PR}`, ts, undefined, DEV, { apiAppId: "A0TWO" }),
    ]);
    await settle();
    expect(starts).toHaveLength(1);
  });
});

describe("intent check: dropped as today", () => {
  const nothing = (g: Gw) => {
    expect(starts).toEqual([]);
    expect(g.sends).toEqual([]);
    expect(g.posts).toEqual([]);
  };

  it("a classifier no (a link shared, not a request)", async () => {
    const g = (gw = makeGw(no));
    const before = intentCount("classifier_pass");
    await deliver(g, `merged ${PR}`, nextTs());
    await settle();
    expect(asked).toHaveLength(1);
    nothing(g);
    expect(intentCount("classifier_pass") - before).toBe(1);
  });

  it("no link and no word: no model call", async () => {
    const g = (gw = makeGw(yes));
    await deliver(g, "anyone up for lunch?", nextTs());
    await settle();
    expect(asked).toEqual([]);
    nothing(g);
  });

  it("a word in a thread that holds no link: no model call", async () => {
    const g = (gw = makeGw(yes));
    const root = nowTs(-100);
    g.state.thread = [{ ts: root, user: DEV, text: "the build is red" }];
    await deliver(g, "cek dong", nextTs(), root);
    await settle();
    expect(asked).toEqual([]);
    nothing(g);
  });

  it("a /1on1 thread", async () => {
    const root = nowTs(-100);
    await OneOnOne.lock({ channelId: CH, threadTs: root, lockedUser: WORLD.manager, createdBy: WORLD.manager });
    const g = (gw = makeGw(yes));
    await deliver(g, `review ${PR}`, nextTs(), root);
    await settle();
    expect(starts).toEqual([]);
    expect(g.sends).toEqual([]);
  });

  it("a /mention-only thread", async () => {
    const root = nowTs(-100);
    await MentionOnly.set({ channelId: CH, threadTs: root, createdBy: WORLD.manager, teamId: TEAM });
    const g = (gw = makeGw(yes));
    await deliver(g, `review ${PR}`, nextTs(), root);
    await settle();
    await MentionOnly.clear(CH, root);
    expect(asked).toEqual([]);
    expect(starts).toEqual([]);
  });

  it("a classifier that does not answer in time", async () => {
    const g = (gw = makeGw(hangs));
    await deliver(g, `tolong review ${PR}`, nextTs());
    await settle();
    nothing(g);
  });

  it("no adapter configured", async () => {
    const g = (gw = makeGw(null));
    await deliver(g, `tolong review ${PR}`, nextTs());
    await settle();
    nothing(g);
  });

  it("mode shadow: classified and counted, nothing starts", async () => {
    setIntent("shadow");
    const g = (gw = makeGw(yes));
    const before = intentCount("shadow_run");
    await deliver(g, `tolong review ${PR}`, nextTs());
    await settle();
    expect(asked).toHaveLength(1);
    nothing(g);
    expect(intentCount("shadow_run") - before).toBe(1);
  });

  it("the kill switch puts an intent that is on in shadow", async () => {
    process.env.SLAUDE_INTENT_FORCE_SHADOW = "1";
    const g = (gw = makeGw(yes));
    await deliver(g, `tolong review ${PR}`, nextTs());
    await settle();
    nothing(g);
  });

  it("an exhausted daily budget: no model call", async () => {
    process.env.SLAUDE_INTENT_DAILY_BUDGET = "1";
    const g = (gw = makeGw(yes));
    await deliver(g, `cek ${PR}`, nextTs());
    await settle();
    await deliver(g, `cek ${PR2}`, nextTs());
    await settle();
    expect(asked).toHaveLength(1);
    expect(starts).toHaveLength(1);
  });

  it("the hourly cap: a confirmed request past it starts nothing", async () => {
    process.env.SLAUDE_INTENT_PER_HOUR = "1";
    const g = (gw = makeGw(yes));
    await deliver(g, `review ${PR}`, nextTs());
    await deliver(g, `review ${PR2}`, nextTs());
    await settle();
    expect(starts).toHaveLength(1);
  });

  it("a channel with no intents is untouched", async () => {
    setSoulData(SoulDataSchema.parse({ ...soulData(), channelIntents: [] }));
    const g = (gw = makeGw(yes));
    await deliver(g, `tolong review ${PR}`, nextTs());
    await settle();
    expect(asked).toEqual([]);
    nothing(g);
  });

  it("a thread that already has a running workflow keeps it", async () => {
    const g = (gw = makeGw(yes));
    const ts = nextTs();
    await deliver(g, `review ${PR}`, ts);
    await settle();
    // A later request in the same thread, addressed to a colleague, does not start a second run.
    await Sessions.setEngagedForThread({ team_id: TEAM, channel_id: CH, thread_ts: ts }, false);
    await deliver(g, `<@${COLLEAGUE}> review ${PR} again please`, nextTs(), ts);
    await settle();
    expect(starts).toHaveLength(1);
    expect(await Workflow.running(CH, ts)).toBeTruthy();
  });
});
