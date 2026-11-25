/**
 * Registered clients of the agent host API (`/agent/v1`).
 *
 * One YAML file per client, `<name>.yaml`, in the clients directory
 * (`$SLAUDE_HOME/api-clients/` by default; the Helm chart mounts a ConfigMap
 * there). The client is the authorisation boundary: the personas, channels and
 * action tools it may use, and where its events go.
 *
 * The bearer token is kept only as a SHA-256 hash. A file may give the hash
 * itself (`tokenSha256`), so the plaintext never reaches slaude. The event
 * signing secret has to be held in plaintext to sign; that is why the API is
 * not served on mono by default (see the TRD, section 5.2).
 *
 * Every error names the file and the field or variable, never a value.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { z } from "zod";
import { formatRef, parseRef } from "../refs/parse";

export interface ApiClient {
  name: string;
  /** Lowercase hex SHA-256 of the bearer token. */
  tokenHash: string;
  personas: string[];
  /** Normalised channel references (`slack:channel:<id>`). */
  channels: string[];
  actions: string[];
  events: { url: string; secret: string; notifyHosts: string[] };
}

/** Shorter tokens and secrets are refused: they are guessable or a placeholder left in. */
export const MIN_SECRET_LENGTH = 32;

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const SHA256_HEX = /^[0-9a-fA-F]{64}$/;
const HOST = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::\d{1,5})?$/;

const envRef = z.object({ env: z.string().regex(ENV_NAME, "must be an environment variable name") }).strict();

const fileSchema = z
  .object({
    name: z.string().regex(NAME, "must be lowercase letters, digits and dashes"),
    token: envRef.optional(),
    tokenSha256: z.string().regex(SHA256_HEX, "must be 64 hex characters").optional(),
    personas: z.array(z.string().min(1)).min(1),
    channels: z.array(z.string()).min(1),
    actions: z.array(z.string().min(1)).default([]),
    events: z
      .object({
        url: z.string().url().refine((u) => new URL(u).protocol === "https:", "must be an https URL"),
        secret: envRef,
        notifyHosts: z.array(z.string().toLowerCase().regex(HOST, "must be a host name")).default([]),
      })
      .strict(),
  })
  .strict()
  .refine((f) => (f.token === undefined) !== (f.tokenSha256 === undefined), "give exactly one of token and tokenSha256");

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** The files a directory holds as clients: `*.yaml` or `*.yml`, followed through
 *  symlinks, skipping dot entries (a ConfigMap mount's `..data` and timestamped
 *  directories). */
async function clientFiles(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: string[] = [];
  for (const n of names.sort()) {
    if (n.startsWith(".")) continue;
    const ext = extname(n);
    if (ext !== ".yaml" && ext !== ".yml") continue;
    const path = join(dir, n);
    if ((await stat(path)).isFile()) out.push(path);
  }
  return out;
}

function resolveEnv(file: string, field: string, ref: { env: string }, source: Record<string, string | undefined>): string {
  const v = source[ref.env];
  if (!v) throw new Error(`${file}: ${field} names ${ref.env}, which is not set`);
  if (v.length < MIN_SECRET_LENGTH) throw new Error(`${file}: ${field} (${ref.env}) must be at least ${MIN_SECRET_LENGTH} characters`);
  return v;
}

function parseFile(path: string, text: string, source: Record<string, string | undefined>): ApiClient {
  const file = basename(path);
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(text);
  } catch (e) {
    throw new Error(`${file}: not valid YAML: ${(e as Error).message}`);
  }
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message));
    throw new Error(`${file}: ${problems.join("; ")}`);
  }
  const f = parsed.data;
  const stem = basename(file, extname(file));
  if (f.name !== stem) throw new Error(`${file}: name "${f.name}" does not match the file name "${stem}"`);

  const channels = f.channels.map((c, i) => {
    const r = parseRef(c, ["channel"]);
    if (!r.ok) throw new Error(`${file}: channels.${i}: ${r.reason}`);
    return formatRef(r.ref);
  });

  return {
    name: f.name,
    tokenHash: f.token ? hashToken(resolveEnv(file, "token", f.token, source)) : f.tokenSha256!.toLowerCase(),
    personas: f.personas,
    channels,
    actions: f.actions,
    events: { url: f.events.url, secret: resolveEnv(file, "events.secret", f.events.secret, source), notifyHosts: f.events.notifyHosts },
  };
}

/**
 * Load every client in `dir`. A missing directory is no clients (the API then
 * answers 404 everywhere). Any invalid file fails the whole load, so a bad edit
 * stops boot instead of silently dropping a client.
 */
export async function loadClients(dir: string, source: Record<string, string | undefined> = process.env): Promise<Map<string, ApiClient>> {
  const clients = new Map<string, ApiClient>();
  const byHash = new Map<string, string>();
  for (const path of await clientFiles(dir)) {
    const c = parseFile(path, await readFile(path, "utf8"), source);
    const other = byHash.get(c.tokenHash);
    if (other) throw new Error(`${basename(path)}: client "${c.name}" has the same token as "${other}"`);
    byHash.set(c.tokenHash, c.name);
    clients.set(c.name, c);
  }
  return clients;
}

/**
 * The client a bearer token belongs to, or null. The presented token is hashed
 * and compared with every client's hash in constant time, without stopping at
 * the first match, so the time taken says nothing about which client matched.
 */
export function findClientByToken(clients: ReadonlyMap<string, ApiClient>, token: string): ApiClient | null {
  if (!token) return null;
  const presented = Buffer.from(hashToken(token), "hex");
  let found: ApiClient | null = null;
  for (const c of clients.values()) {
    if (timingSafeEqual(presented, Buffer.from(c.tokenHash, "hex")) && !found) found = c;
  }
  return found;
}
