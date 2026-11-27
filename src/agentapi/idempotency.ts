/**
 * Idempotency for `/agent/v1` create calls.
 *
 * Every create call carries an `Idempotency-Key` header. The first successful
 * response is stored under (client, key) in the same transaction as the
 * resource it created, so the two cannot disagree:
 *   - the same key with the same route and body returns the stored response,
 *     marked `idempotent-replayed: true`;
 *   - the same key with another route or body is `409`;
 *   - a refusal (a `Response` from `create`, such as 400 or 403) is not stored,
 *     so the client may fix the call and retry under the same key.
 * When two calls race on one key, the second insert finds the row, its
 * transaction rolls back, and it answers from the row like a repeat.
 * Records are kept for IDEMPOTENCY_RETENTION_MS; an older one counts as absent.
 */
import { createHash } from "node:crypto";
import { json } from "../gateway/api/http";
import * as Store from "../db/agent-api";
import { db, type DbClient } from "../db/schema";
import type { ApiClient } from "./clients";

export const IDEMPOTENCY_HEADER = "idempotency-key";
export const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;
const KEY_RE = /^[\x21-\x7e]{1,255}$/;

export interface Created {
  status: number;
  body: unknown;
  /** The id of the resource created, kept with the record. */
  resourceId?: string;
}

/** JSON with object keys sorted at every depth, so equal bodies hash equal. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

export function requestHash(route: string, body: unknown): string {
  return createHash("sha256").update(route).update("\n").update(canonicalJson(body)).digest("hex");
}

class KeyTaken extends Error {}

/**
 * Run `create` once per (client, Idempotency-Key). `create` gets the transaction
 * to write its resource in; it returns what to store and send, or a Response
 * for a refusal that is not stored.
 */
export async function idempotent(
  req: Request,
  client: ApiClient,
  route: string,
  body: unknown,
  create: (tx: DbClient) => Promise<Created | Response>,
  now: () => number = Date.now,
): Promise<Response> {
  const key = req.headers.get(IDEMPOTENCY_HEADER)?.trim() ?? "";
  if (!key) return json(400, { error: "Idempotency-Key header required" });
  if (!KEY_RE.test(key)) return json(400, { error: "Idempotency-Key must be 1 to 255 visible ASCII characters" });
  const hash = requestHash(route, body);

  const replay = async (): Promise<Response | null> => {
    const row = await Store.findIdempotency(client.name, key);
    if (!row) return null;
    if (row.route !== route || row.request_hash !== hash) {
      return json(409, { error: "Idempotency-Key was already used with a different request" });
    }
    return new Response(row.response, {
      status: row.status,
      headers: { "content-type": "application/json", "idempotent-replayed": "true" },
    });
  };

  const existing = await Store.findIdempotency(client.name, key);
  if (existing && existing.created_at < now() - IDEMPOTENCY_RETENTION_MS) {
    await db.run("DELETE FROM agent_idempotency WHERE client = ? AND idem_key = ? AND created_at = ?", [
      client.name,
      key,
      existing.created_at,
    ]);
  } else if (existing) {
    return (await replay())!;
  }

  try {
    const out = await db.transaction(async (tx): Promise<Response | { status: number; response: string }> => {
      const r = await create(tx);
      if (r instanceof Response) return r;
      const response = JSON.stringify(r.body);
      const stored = await Store.insertIdempotency(
        {
          client: client.name,
          idem_key: key,
          route,
          request_hash: hash,
          status: r.status,
          response,
          resource_id: r.resourceId ?? null,
          created_at: now(),
        },
        tx,
      );
      if (!stored) throw new KeyTaken();
      return { status: r.status, response };
    }, { immediate: true });
    if (out instanceof Response) return out;
    return new Response(out.response, { status: out.status, headers: { "content-type": "application/json" } });
  } catch (e) {
    if (!(e instanceof KeyTaken)) throw e;
    return (await replay()) ?? json(409, { error: "Idempotency-Key is in use" });
  }
}
