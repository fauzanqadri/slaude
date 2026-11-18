/**
 * Intent check: a message nobody @mentioned that asks for something a
 * workflow pipeline does (today: a pull request review). Independent of the
 * engage ladder and of the channel's engage level.
 *
 * Order for one message (each step can end it; only the last starts anything):
 *   prefilter (no model: a pull request link, or a listed word in a thread
 *   whose messages hold one) -> budget -> classifier (the decision adapter,
 *   one yes or no question, own deadline) -> the caller's claim, cap and start.
 *
 * Every failure is a pass. Nothing here logs message text.
 */
import type { DecisionQuestion } from "../../decision/types";
import type { GateRunner } from "../gate/runner";
import type { ChannelIntent } from "../../soul/data";

/** Text past this length is not scanned (the regular expressions stay linear on a bounded input). */
export const MAX_SCAN_CHARS = 4000;

/**
 * A pull request or merge request URL on any of the common hosts' path shapes.
 * Slack wraps a link as `<url>` or `<url|label>`, so the URL stops at `|`, `>`
 * or white space; anything after the number is dropped.
 */
const PR_URL = /https?:\/\/[^\s<>|]+?\/(?:pull-requests|pull|merge_requests)\/\d+/gi;

/** The pull request URLs in a text, in order of appearance, each once. */
export function prUrls(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.slice(0, MAX_SCAN_CHARS).matchAll(PR_URL)) seen.add(m[0]);
  return [...seen];
}

const fold = (s: string): string => s.normalize("NFKC").toLowerCase();
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether `text` holds one of `words` as a whole word or phrase, ignoring case. */
export function hasWord(text: string, words: readonly string[]): boolean {
  if (!words.length) return false;
  const t = fold(text.slice(0, MAX_SCAN_CHARS));
  return words.some((w) => {
    const f = fold(w).trim();
    if (!f) return false;
    return new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRe(f).replace(/\s+/g, "\\s+")}($|[^\\p{L}\\p{N}_])`, "u").test(t);
  });
}

export type Prefilter =
  /** The message itself holds a link: the first one is the request. */
  | { kind: "link"; url: string }
  /** No link, but a listed word in a thread reply: the link must come from the thread. */
  | { kind: "word" };

/** The cheap check, no model call. A root message needs a link; a thread reply needs a link or a listed word. */
export function prefilter(text: string, intent: Pick<ChannelIntent, "words">, inThread: boolean): Prefilter | null {
  const urls = prUrls(text);
  if (urls.length) return { kind: "link", url: urls[0]! };
  if (inThread && hasWord(text, intent.words)) return { kind: "word" };
  return null;
}

/** The most recent pull request URL in a thread's messages (oldest first, as Slack returns them). */
export function latestPrUrl(messages: readonly { text?: string }[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const urls = prUrls(String(messages[i]?.text ?? ""));
    if (urls.length) return urls[urls.length - 1]!;
  }
  return null;
}

/** The single question put to the adapter, built from the intent's own wording. */
export function intentQuestion(intent: Pick<ChannelIntent, "question">): Record<string, DecisionQuestion> {
  return {
    intent: {
      instructions:
        "The state holds a new chat message from a team channel and, when it is a thread reply, earlier messages of that thread. " +
        "The message may be addressed to a colleague by name; that does not change the answer. Answer this question about the new message: " +
        intent.question,
      options: { yes: "yes", no: "no, or not clear" },
    },
  };
}

/** What the classifier's input carries. Lines are already redacted and cut by the caller. */
export interface IntentState {
  message: string;
  recent: { role: "agent" | "user"; text: string }[];
}

export type IntentVerdict = { answer: "run" | "pass"; reason: "answer" | "low" | "noadapter" | "error" };

/**
 * One question to the configured decision adapter. "run" only on a "yes" at or
 * above the runner's act threshold; no adapter, an error, a timeout or a
 * malformed answer is a pass.
 */
export async function classifyIntent(
  runner: Pick<GateRunner, "ask" | "tAct" | "hasAdapter"> | null | undefined,
  intent: Pick<ChannelIntent, "question">,
  state: IntentState,
  deadlineMs: number,
): Promise<IntentVerdict> {
  if (!runner?.hasAdapter || !runner.ask) return { answer: "pass", reason: "noadapter" };
  try {
    const r = await runner.ask(intentQuestion(intent), state, deadlineMs);
    const a = r?.intent;
    if (!a) return { answer: "pass", reason: "error" };
    if (a.choice !== "yes") return { answer: "pass", reason: "answer" };
    return a.confidence >= (runner.tAct ?? 0.8) ? { answer: "run", reason: "answer" } : { answer: "pass", reason: "low" };
  } catch {
    return { answer: "pass", reason: "error" };
  }
}
