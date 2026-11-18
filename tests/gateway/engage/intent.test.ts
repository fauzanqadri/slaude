import { describe, expect, test } from "bun:test";
import "../../../src/decision/adapters/index";
import { adapterFromConfig, registerAdapter } from "../../../src/decision/registry";
import { DecisionError, type DecisionAdapter, type DecisionRequest, type DecisionResult } from "../../../src/decision/types";
import { memoryEngageState, redisEngageState } from "../../../src/gateway/engage/budget";
import { classifyIntent, hasWord, intentQuestion, latestPrUrl, MAX_SCAN_CHARS, prefilter, prUrls } from "../../../src/gateway/engage/intent";
import { makeGateRunner } from "../../../src/gateway/gate/runner";
import { parseAgentYaml } from "../../../src/persona/agent-def";
import { PayloadError } from "../../../src/persona/sync/payload";
import { fakeEngageRedis } from "../../helpers/fake-engage-redis";

const PR = "https://git.example.com/projects/proj/repos/svc/pull-requests/4000";
const GH = "https://github.com/example/svc/pull/12";
const words = { words: ["review", "cek pr", "approve"] };

describe("prUrls", () => {
  test("finds pull and merge request links on the common path shapes", () => {
    expect(prUrls(`see ${PR} and ${GH} and https://gitlab.example.com/g/p/-/merge_requests/7`)).toEqual([
      PR,
      GH,
      "https://gitlab.example.com/g/p/-/merge_requests/7",
    ]);
  });

  test("reads Slack's wrapped links and drops what follows the number", () => {
    expect(prUrls(`<${PR}|svc#4000>`)).toEqual([PR]);
    expect(prUrls(`<${PR}/diff#chg-main.go>`)).toEqual([PR]);
    expect(prUrls(`<${PR}/overview>`)).toEqual([PR]);
  });

  test("each link once, and nothing for a link that is not a pull request", () => {
    expect(prUrls(`${PR} ${PR}`)).toEqual([PR]);
    expect(prUrls("https://git.example.com/projects/proj/repos/svc/browse")).toEqual([]);
    expect(prUrls("pull-requests/4000")).toEqual([]);
  });

  test("text past the scan bound is not read", () => {
    expect(prUrls(`${"x".repeat(MAX_SCAN_CHARS)} ${PR}`)).toEqual([]);
  });
});

describe("hasWord", () => {
  test("whole words and phrases, ignoring case and width", () => {
    expect(hasWord("Tolong REVIEW ya", words.words)).toBe(true);
    expect(hasWord("bisa cek  PR ini?", words.words)).toBe(true);
    expect(hasWord("ｒｅｖｉｅｗ dong", words.words)).toBe(true);
  });

  test("not inside another word", () => {
    expect(hasWord("the reviewer left", words.words)).toBe(false);
    expect(hasWord("preview build", words.words)).toBe(false);
    expect(hasWord("approved already", words.words)).toBe(false);
  });

  test("no words configured matches nothing", () => {
    expect(hasWord("review", [])).toBe(false);
  });
});

describe("prefilter", () => {
  test("a link passes at the root and in a thread, whatever the wording", () => {
    expect(prefilter(`tolong review <${PR}>`, words, false)).toEqual({ kind: "link", url: PR });
    expect(prefilter(`<@U0PEER> ${PR}`, words, true)).toEqual({ kind: "link", url: PR });
    expect(prefilter(`merged ${PR}`, words, false)).toEqual({ kind: "link", url: PR });
  });

  test("a word without a link passes only in a thread", () => {
    expect(prefilter("review lagi dong", words, true)).toEqual({ kind: "word" });
    expect(prefilter("review lagi dong", words, false)).toBeNull();
  });

  test("neither a link nor a word fails", () => {
    expect(prefilter("lunch?", words, true)).toBeNull();
    expect(prefilter("lunch?", words, false)).toBeNull();
  });
});

describe("latestPrUrl", () => {
  test("the most recent link in the thread", () => {
    expect(latestPrUrl([{ text: `root ${PR}` }, { text: "ok" }, { text: `new one ${GH}` }, { text: "review lagi dong" }])).toBe(GH);
  });

  test("none in the thread", () => {
    expect(latestPrUrl([{ text: "a" }, {}])).toBeNull();
  });
});

describe("intentQuestion", () => {
  test("carries the configured question and two options", () => {
    const q = intentQuestion({ question: "Does the new message ask someone to review a pull request?" });
    expect(q.intent!.instructions).toContain("ask someone to review a pull request?");
    expect(Object.keys(q.intent!.options)).toEqual(["yes", "no"]);
  });
});

type Script = (req: DecisionRequest) => DecisionResult | Promise<DecisionResult>;
const scripts = new Map<string, Script>();
registerAdapter("intent-scripted-test", async (block) => {
  const adapter: DecisionAdapter = { name: "intent-scripted-test", decide: async (req) => scripts.get(String(block.script))!(req) };
  return adapter;
});
async function runnerFor(script: Script, tAct = 0.8) {
  const id = `i${scripts.size}`;
  scripts.set(id, script);
  const adapter = await adapterFromConfig({ type: "intent-scripted-test", script: id }, { resolveSecret: async () => "" });
  return makeGateRunner({ mode: "off", adapter, tAct, timeoutMs: 200, contextMessages: 8, log: () => {} });
}
const intent = { question: "Does the new message ask someone to review a pull request?" };
const state = { message: "tolong review <link>", recent: [] };

describe("classifyIntent", () => {
  test("a confident yes is a run; the adapter sees only the intent question", async () => {
    let asked: string[] = [];
    const r = await runnerFor((req) => ((asked = Object.keys(req.questions)), { intent: { choice: "yes", confidence: 0.95 } }));
    expect(await classifyIntent(r, intent, state, 500)).toEqual({ answer: "run", reason: "answer" });
    expect(asked).toEqual(["intent"]);
  });

  test("answers from the adapter even with the gate off", async () => {
    const r = await runnerFor(() => ({ intent: { choice: "yes", confidence: 0.9 } }));
    expect(r.mode).toBe("off");
    expect((await classifyIntent(r, intent, state, 500)).answer).toBe("run");
  });

  test("a no, or a yes below the act threshold, is a pass", async () => {
    expect(await classifyIntent(await runnerFor(() => ({ intent: { choice: "no", confidence: 0.99 } })), intent, state, 500)).toEqual({ answer: "pass", reason: "answer" });
    expect(await classifyIntent(await runnerFor(() => ({ intent: { choice: "yes", confidence: 0.6 } })), intent, state, 500)).toEqual({ answer: "pass", reason: "low" });
  });

  test("no adapter, an error, a timeout or a malformed answer is a pass", async () => {
    const none = makeGateRunner({ mode: "off", adapter: null, tAct: 0.8, timeoutMs: 200, contextMessages: 8, log: () => {} });
    expect(await classifyIntent(none, intent, state, 500)).toEqual({ answer: "pass", reason: "noadapter" });
    expect(await classifyIntent(null, intent, state, 500)).toEqual({ answer: "pass", reason: "noadapter" });
    const down = await runnerFor(() => {
      throw new DecisionError("transport", "down");
    });
    expect(await classifyIntent(down, intent, state, 500)).toEqual({ answer: "pass", reason: "error" });
    const hang = await runnerFor(() => new Promise<DecisionResult>(() => {}));
    expect(await classifyIntent(hang, intent, state, 30)).toEqual({ answer: "pass", reason: "error" });
    const bad = await runnerFor(() => ({ intent: { choice: "maybe", confidence: 1 } }));
    expect((await classifyIntent(bad, intent, state, 500)).answer).toBe("pass");
  });
});

describe("intent budget and cap", () => {
  for (const [label, make] of [
    ["memory", (now: () => number) => memoryEngageState({ now })],
    ["redis", (now: () => number) => redisEngageState(fakeEngageRedis({ now }), "t", { now })],
  ] as const) {
    test(`${label}: the daily budget and the hourly cap are per channel and separate from engage`, async () => {
      let t = Date.UTC(2026, 10, 18, 10);
      const s = make(() => t);
      expect(await s.spendIntent("C1", 2, "T")).toBe("ok");
      expect(await s.spendIntent("C1", 2, "T")).toBe("ok");
      expect(await s.spendIntent("C1", 2, "T")).toBe("day");
      expect(await s.spendIntent("C2", 2, "T")).toBe("ok");
      // The engage budget is untouched.
      expect(await s.spend("C1", "T")).toBe("ok");
      expect(await s.intentSlot("C1", 1, "T")).toBe("ok");
      expect(await s.intentSlot("C1", 1, "T")).toBe("cap");
      expect(await s.actSlot("C1", 1, "T")).toBe("ok");
      t += 3_600_000;
      expect(await s.intentSlot("C1", 1, "T")).toBe("ok");
      t += 86_400_000;
      expect(await s.spendIntent("C1", 2, "T")).toBe("ok");
    });
  }
});

describe("intents in agent.yaml", () => {
  const doc = (extra: string) => `name: ana\nsoul: You are Ana.\n${extra}`;
  const soulOf = (yaml: string) => parseAgentYaml("ana", yaml).spec.definition.soulData;

  test("compiled per channel, mode shadow and no words by default", () => {
    const s = soulOf(
      doc(
        "channels:\n  slack:channel:C0EXAMPLE:\n    intents:\n      - name: pr_review\n        question: Does the new message ask someone to review a pull request?\n        pipeline: review\n" +
          "  C0OTHER1:\n    intents:\n      - { name: pr_review, question: q?, pipeline: review, mode: on, words: [review] }\n",
      ),
    );
    expect(s.channelIntents).toEqual([
      { channel: "C0EXAMPLE", name: "pr_review", mode: "shadow", question: "Does the new message ask someone to review a pull request?", words: [], pipeline: "review" },
      { channel: "C0OTHER1", name: "pr_review", mode: "on", question: "q?", words: ["review"], pipeline: "review" },
    ]);
  });

  test("no intents: nothing recorded", () => {
    expect(soulOf(doc("channels:\n  C0EXAMPLE:\n    engage: { level: addressed }\n")).channelIntents).toEqual([]);
  });

  test("a repeated name in one channel is refused with its path", () => {
    try {
      soulOf(doc("channels:\n  C0EXAMPLE:\n    intents:\n      - { name: a, question: q?, pipeline: review }\n      - { name: a, question: q?, pipeline: other }\n"));
      throw new Error("expected a refusal");
    } catch (e) {
      expect(e).toBeInstanceOf(PayloadError);
      expect((e as Error).message).toContain("intents[1].name");
    }
  });
});
