/** Bearer authentication for `/agent/v1`. */
import { findClientByToken, type ApiClient } from "./clients";

/** The bearer token of a request, or "" when the header is absent or not a bearer. */
export function bearerToken(req: Request): string {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(h);
  return m ? m[1]! : "";
}

/** The client that sent this request, or null. */
export function authenticate(req: Request, clients: ReadonlyMap<string, ApiClient>): ApiClient | null {
  return findClientByToken(clients, bearerToken(req));
}
