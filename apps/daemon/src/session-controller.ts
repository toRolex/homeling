import type { UnlockVerifier } from "./unlock-credentials.ts";
import type { SessionMode } from "./config.ts";
import { randomBytes } from "node:crypto";
import { SessionLock, SessionLocked, lockedResponse, type MutationAdmission } from "./session-lock.ts";

export const SESSION_PATH = "/lite/api/session";
export const SESSION_COOKIE = "__Secure-homeling_session";
export const DEV_SESSION_COOKIE = "homeling_dev_session";
interface Bucket { start: number; attempts: number }
const noStore = { "cache-control": "no-store" };
const invalidJson = Symbol("invalid session JSON");
async function readSmallJson(req: Request): Promise<unknown | typeof invalidJson> {
  const length = req.headers.get("content-length");
  if (length && Number(length) > 1_024) throw new Error("body too large");
  const reader = req.body?.getReader();
  if (!reader) throw new Error("body required");
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  const signal = AbortSignal.any([req.signal, AbortSignal.timeout(5_000)]);
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw new Error("unlock body cancelled");
      const { done, value } = await reader.read();
      if (signal.aborted) throw new Error("unlock body cancelled");
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1_024) throw new Error("body too large");
      chunks.push(value);
    }
  } finally { signal.removeEventListener("abort", cancel); await reader.cancel().catch(() => undefined); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return invalidJson; }
}
export class SessionController {
  readonly generation = randomBytes(16).toString("hex");
  private readonly lock: SessionLock;
  private readonly buckets = new Map<string, Bucket>();
  private active = 0;
  private fingerprint: string | undefined;
  private readonly now: () => number;
  constructor(private readonly options: { verify: () => UnlockVerifier | null; mode?: SessionMode; devHttp?: boolean; now?: () => number; idleMs?: number; absoluteMs?: number }) {
    this.now = options.now ?? Date.now;
    this.lock = new SessionLock(options);
  }
  private token(req: Request): string | undefined {
    const name = this.options.devHttp ? DEV_SESSION_COOKIE : SESSION_COOKIE;
    const cookies = (req.headers.get("cookie") ?? "").split(";").map((part) => part.trim());
    const values = cookies.filter((part) => part.startsWith(`${name}=`)).map((part) => part.slice(name.length + 1));
    return values.length === 1 && /^[A-Za-z0-9_-]{43}$/.test(values[0]!) ? values[0] : undefined;
  }
  private refreshVerifier(): UnlockVerifier | null {
    if (this.options.mode === "tailscale-identity") return null;
    let verify: UnlockVerifier | null;
    try { verify = this.options.verify(); } catch { verify = null; }
    if (!verify || (this.fingerprint !== undefined && verify.fingerprint !== this.fingerprint)) this.lock.revokeAll();
    this.fingerprint = verify?.fingerprint;
    return verify;
  }
  admission(req: Request, subject: string): MutationAdmission {
    if (this.options.mode !== "tailscale-identity" && !this.refreshVerifier()) throw new SessionLocked();
    const expected = req.headers.get("x-homeling-session-epoch");
    const epoch = expected && expected.length <= 16 && /^[1-9][0-9]*$/.test(expected) ? Number(expected) : NaN;
    const state = this.lock.state(this.token(req), subject);
    if (!Number.isSafeInteger(epoch) || state.locked || state.epoch !== epoch || req.headers.get("x-homeling-session-generation") !== this.generation) throw new SessionLocked();
    const lease = this.lock.admission(this.lock.admit(this.token(req), subject));
    const assert = () => { if (this.options.mode !== "tailscale-identity" && !this.refreshVerifier()) throw new SessionLocked(); lease.assert(); };
    return { assert, dispatch<T>(effect: () => T): T { assert(); return lease.dispatch(effect); } };
  }
  private consume(key: string, limit: number): boolean {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket || now >= bucket.start + 60_000) {
      bucket = { start: now, attempts: 0 }; this.buckets.set(key, bucket);
    }
    if (now < bucket.start || bucket.attempts >= limit) return false;
    bucket.attempts++;
    return true;
  }
  async handle(req: Request, subject: string): Promise<Response | undefined> {
    let pathname: string;
    try { pathname = new URL(req.url).pathname; } catch { return Response.json({ code: "session.invalid_request" }, { status: 400, headers: noStore }); }
    const mode = this.options.mode ?? "local-unlock";
    const available = mode === "tailscale-identity" || this.refreshVerifier() !== null;
    if (pathname === SESSION_PATH && req.method === "GET") {
      return Response.json({ ...this.lock.state(this.token(req), subject), generation: this.generation, serverNow: this.now(), available, mode }, { headers: noStore });
    }
    if (pathname === `${SESSION_PATH}/establish` && req.method === "POST") {
      if (mode !== "tailscale-identity") return Response.json({ code: "session.action_unavailable" }, { status: 404, headers: noStore });
      if (req.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return Response.json({ code: "session.invalid_request" }, { status: 415, headers: noStore });
      const body = await readSmallJson(req).catch(() => invalidJson);
      if (body === invalidJson || !body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0) return Response.json({ code: "session.invalid_request" }, { status: 400, headers: noStore });
      const currentToken = this.token(req);
      const currentState = this.lock.state(currentToken, subject);
      if (!currentState.locked) return Response.json({ ...currentState, generation: this.generation, serverNow: this.now(), available: true, mode }, { headers: noStore });
      const global = this.consume("global", 10);
      const principal = this.consume(`subject:${subject}`, 5);
      if (!global || !principal || this.active >= 2) return Response.json({ code: "session.rate_limited" }, { status: 429, headers: { ...noStore, "retry-after": "60" } });
      this.active++;
      try {
        const unlocked = this.lock.unlock(subject, currentToken);
        const cookie = `${SESSION_COOKIE}=${unlocked.token}; Path=/lite/; HttpOnly; SameSite=Strict; Secure; Max-Age=28800`;
        return Response.json({ ...unlocked.state, generation: this.generation, serverNow: this.now(), available: true, mode }, { headers: { ...noStore, "set-cookie": cookie } });
      } catch (error) {
        if (error instanceof SessionLocked) return lockedResponse();
        return Response.json({ code: "session.unavailable" }, { status: 503, headers: noStore });
      } finally { this.active--; }
    }
    if (pathname === `${SESSION_PATH}/unlock` && mode === "tailscale-identity") return Response.json({ code: "session.action_unavailable" }, { status: 404, headers: noStore });
    if (req.method !== "POST" || ![`${SESSION_PATH}/unlock`, `${SESSION_PATH}/lock`, `${SESSION_PATH}/activity`].includes(pathname)) return undefined;
    if (req.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return Response.json({ error: "application/json required" }, { status: 415, headers: noStore });
    if (pathname === `${SESSION_PATH}/lock`) {
      this.lock.lock(this.token(req), subject);
      return Response.json({ locked: true, generation: this.generation, serverNow: this.now(), available, mode }, { headers: noStore });
    }
    if (pathname === `${SESSION_PATH}/activity`) {
      try {
        this.admission(req, subject).assert();
        return Response.json({ ...this.lock.activity(this.token(req), subject), generation: this.generation, serverNow: this.now(), available, mode }, { headers: noStore });
      }
      catch { return lockedResponse(); }
    }
    // Count attempts before parsing/hashing, independent of cookie/session rotation.
    const global = this.consume("global", 10);
    const principal = this.consume(`subject:${subject}`, 5);
    if (!global || !principal || this.active >= 2) return Response.json({ error: "Too many unlock attempts", code: "session.rate_limited" }, { status: 429, headers: { ...noStore, "retry-after": "60" } });
    this.active++;
    try {
      const verify = this.refreshVerifier();
      if (!verify) return Response.json({ locked: true, error: "Local unlock credentials are unavailable", code: "session.unavailable" }, { status: 503, headers: noStore });
      const parsedBody = await readSmallJson(req).catch(() => invalidJson);
      if (parsedBody === invalidJson) return Response.json({ error: "Invalid unlock body (maximum 1KiB)" }, { status: 400, headers: noStore });
      const body = parsedBody as { secret?: unknown } | null;
      const currentVerifier = this.refreshVerifier();
      if (!body || typeof body.secret !== "string" || body.secret.length !== 43 || !currentVerifier || !currentVerifier(body.secret)) return Response.json({ locked: true, code: "session.invalid_secret" }, { status: 401, headers: noStore });
      const unlocked = this.lock.unlock(subject, this.token(req));
      const name = this.options.devHttp ? DEV_SESSION_COOKIE : SESSION_COOKIE;
      const cookie = `${name}=${unlocked.token}; Path=/lite/; HttpOnly; SameSite=Strict${this.options.devHttp ? "" : "; Secure"}; Max-Age=28800`;
      return Response.json({ ...unlocked.state, generation: this.generation, serverNow: this.now(), available, mode }, { headers: { ...noStore, "set-cookie": cookie } });
    } catch (error) {
      if (error instanceof SessionLocked) return lockedResponse();
      return Response.json({ locked: true, code: "session.unavailable" }, { status: 503, headers: noStore });
    } finally { this.active--; }
  }
}
