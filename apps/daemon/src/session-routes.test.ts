import { expect, test } from "bun:test";
import { handleRequest } from "./index.ts";
import { daemonConfigFromEnv } from "./config.ts";
import { SessionController } from "./session-controller.ts";
const cfg = daemonConfigFromEnv({ HOMELING_TAILSCALE_HOST: "home.ts.net", HOMELING_TRUSTED_USERS: "alice" });
function request(path: string, method = "POST", cookie?: string) {
  return Object.assign(new Request(`https://home.ts.net${path}`, { method, headers: { host: "home.ts.net", origin: "https://home.ts.net", "tailscale-user-login": "alice", "content-type": "application/json", ...(cookie ? { cookie } : {}) }, ...(method !== "GET" ? { body: "{}" } : {}) }), { remoteAddress: "127.0.0.1" });
}
test("production session credentials require the fixed trusted HTTPS terminator, not arbitrary HTTP or forwarded headers", async () => {
  const secret = "a".repeat(43);
  const session = new SessionController({ verify: () => (input) => input === secret });
  const make = (remoteAddress: string, host = "home.ts.net", origin = "https://home.ts.net") => Object.assign(new Request("http://localhost:8790/lite/api/session/unlock", { method: "POST", headers: { host, origin, "tailscale-user-login": "alice", "content-type": "application/json", "x-forwarded-proto": "https" }, body: JSON.stringify({ secret }) }), { remoteAddress });
  const directRemote = await handleRequest(make("100.64.0.2"), cfg, undefined, undefined, session);
  expect(directRemote.status).toBe(403);
  expect(directRemote.headers.get("set-cookie")).toBeNull();
  const plainLocal = await handleRequest(make("127.0.0.1", "localhost:8790", "http://localhost:8790"), cfg, undefined, undefined, session);
  expect(plainLocal.status).toBe(403);
  const terminatedHttps = await handleRequest(make("127.0.0.1"), cfg, undefined, undefined, session);
  expect(terminatedHttps.status).toBe(200);
  expect(terminatedHttps.headers.get("set-cookie")).toContain("Secure");
  expect((await handleRequest(make("127.0.0.1", "home.ts.net:443", "https://home.ts.net:443"), cfg, undefined, undefined, session)).status).toBe(200);
  const localOnly = daemonConfigFromEnv({ HOMELING_TAILSCALE_HOST: "", HOMELING_PUBLIC_ORIGIN: "", HOMELING_TRUSTED_USERS: "alice" });
  expect((await handleRequest(make("127.0.0.1"), localOnly, undefined, undefined, session)).status).toBe(403);
});

test("8443 front door unlocks and admits writes only with exact transport and origin", async () => {
  const cfg = daemonConfigFromEnv({ HOMELING_TAILSCALE_HOST: "home.ts.net", HOMELING_PUBLIC_ORIGIN: "https://home.ts.net:8443", HOMELING_TRUSTED_USERS: "alice" });
  const secret = "b".repeat(43);
  const session = new SessionController({ verify: () => (input) => input === secret });
  const make = (path: string, method = "POST", overrides: Record<string, string | null> = {}, remoteAddress = "127.0.0.1", body: unknown = {}) => {
    const headers = new Headers({ host: "home.ts.net:8443", origin: "https://home.ts.net:8443", "tailscale-user-login": "alice", "content-type": "application/json" });
    for (const [key, value] of Object.entries(overrides)) {
      if (value === null) headers.delete(key);
      else headers.set(key, value);
    }
    return Object.assign(new Request(`http://127.0.0.1:8790${path}`, { method, headers, ...(method === "GET" ? {} : { body: JSON.stringify(body) }) }), { remoteAddress });
  };
  const call = (req: ReturnType<typeof make>) => handleRequest(req, cfg, async () => Response.json({ ok: true }), undefined, session);
  expect((await call(make("/lite/api/session", "GET"))).status).toBe(200);
  const unlocked = await call(make("/lite/api/session/unlock", "POST", {}, "127.0.0.1", { secret }));
  expect(unlocked.status).toBe(200);
  expect(unlocked.headers.get("set-cookie")).toContain("Secure");
  const state = await unlocked.json();
  const credentials = { cookie: unlocked.headers.get("set-cookie")!.split(";")[0]!, "x-homeling-session-epoch": String(state.epoch), "x-homeling-session-generation": state.generation };
  let writes = 0;
  const write = (headers: Record<string, string | null> = {}, peer = "127.0.0.1", path = "/lite/api/pane/p/reply") => handleRequest(make(path, "POST", { ...credentials, ...headers }, peer, { text: "hello" }), cfg, async () => { writes++; return Response.json({ ok: true }); }, undefined, session);
  expect((await write()).status).toBe(200);
  expect(writes).toBe(1);
  const rejectedHeaders: Record<string, string | null>[] = [
    { host: "home.ts.net" }, { host: "home.ts.net:443" }, { host: "home.ts.net:8444" }, { host: "other.ts.net:8443" },
    { origin: "https://home.ts.net" }, { origin: "https://home.ts.net:8444" }, { origin: "http://home.ts.net:8443" },
    { origin: null }, { origin: "null" }, { origin: "https://home.ts.net:8443/lite/" }, { origin: "https://home.ts.net:8443/?q=1" },
    { origin: "https://home.ts.net:8443/#x" }, { origin: "https://alice@home.ts.net:8443" },
    { "tailscale-user-login": "mallory" }, { "tailscale-user-login": null },
    { host: "localhost:8790", origin: "http://localhost:8790", "x-forwarded-proto": "https" },
  ];
  for (const headers of rejectedHeaders) {
    for (const path of ["/lite/api/pane/p/reply", "/lite/api/session/unlock", "/lite/api/session/lock", "/lite/api/unknown"]) {
      const result = await write(headers, "127.0.0.1", path);
      expect([401, 403]).toContain(result.status);
      expect(result.headers.get("set-cookie")).toBeNull();
    }
  }
  expect((await write({}, "100.64.0.2")).status).toBe(403);
  for (const host of ["home.ts.net", "home.ts.net:443", "home.ts.net:8444"]) expect((await call(make("/lite/api/session", "GET", { host }))).status).toBe(403);
  expect(writes).toBe(1);
  expect((await write({ "x-homeling-session-epoch": String(state.epoch + 1) })).status).toBe(423);
  expect((await write({ "x-homeling-session-generation": "old" })).status).toBe(423);
  expect((await call(make("/lite/api/session/lock", "POST", credentials))).status).toBe(200);
  expect((await write()).status).toBe(423);
  expect(writes).toBe(1);
});

test("identity mode gates all private reads and writes, with only the exact health read public", async () => {
  const identityCfg = daemonConfigFromEnv({ HOMELING_SESSION_MODE: "tailscale-identity", HOMELING_TAILSCALE_HOST: "home.ts.net", HOMELING_PUBLIC_ORIGIN: "https://home.ts.net:8443", HOMELING_TRUSTED_USERS: "alice" });
  const session = new SessionController({ mode: "tailscale-identity", verify: () => { throw new Error("local verifier must not be read"); } });
  const makeIdentityRequest = (path: string, method = "GET", overrides: Record<string, string | null> = {}, peer: string | null = "127.0.0.1") => {
    const headers = new Headers({ host: "home.ts.net:8443", origin: "https://home.ts.net:8443", "tailscale-user-login": "alice", ...(method === "GET" || method === "HEAD" ? {} : { "content-type": "application/json" }) });
    for (const [key, value] of Object.entries(overrides)) value === null ? headers.delete(key) : headers.set(key, value);
    return Object.assign(new Request(`http://127.0.0.1:8790${path}`, { method, headers, ...(method === "GET" || method === "HEAD" ? {} : { body: "{}" }) }), { remoteAddress: peer });
  };
  let privateReads = 0;
  const call = (path: string, method = "GET", headers: Record<string, string | null> = {}, peer: string | null = "127.0.0.1") => handleRequest(makeIdentityRequest(path, method, headers, peer), identityCfg, async () => { privateReads++; return Response.json({ private: true }); }, undefined, session);
  for (const path of ["/lite/api/session", "/lite/api/snapshot", "/lite/api/persona/list", "/lite/api/push/status", "/lite/api/unknown"]) {
    for (const invalid of [
      [{ "tailscale-user-login": null }, "127.0.0.1"],
      [{ "tailscale-user-login": "mallory" }, "127.0.0.1"],
      [{ host: "home.ts.net:443" }, "127.0.0.1"],
      [{ host: "home.ts.net:8444" }, "127.0.0.1"],
      [{ host: "foreign.ts.net:8443" }, "127.0.0.1"],
      [{ host: "localhost:8790", origin: "http://localhost:8790" }, "127.0.0.1"],
      [{}, "100.64.0.2"],
      [{}, null],
    ] as const) {
      expect([401, 403]).toContain((await call(path, "GET", invalid[0], invalid[1])).status);
      expect([401, 403]).toContain((await call(path, "HEAD", invalid[0], invalid[1])).status);
    }
  }
  expect((await call("/lite/api/health")).status).toBe(200);
  expect((await call("/lite/api/health", "HEAD")).status).toBe(200);
  expect((await call("/api/health", "GET", { host: "localhost:8790", origin: "http://localhost:8790", "tailscale-user-login": null })).status).toBe(404);
  for (const [path, status] of [["/lite/api/session/establish", 200], ["/lite/api/session/unlock", 404], ["/lite/api/unknown", 423]] as const) {
    const response = await call(path, "POST", { origin: "https://home.ts.net:8443" });
    expect(response.status).toBe(status);
  }
  expect(privateReads).toBe(0);
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    for (const origin of [null, "null", "http://home.ts.net:8443", "https://home.ts.net", "https://home.ts.net:8444", "https://user@home.ts.net:8443", "https://home.ts.net:8443/lite/", "https://home.ts.net:8443?bad=1", "https://home.ts.net:8443#bad"]) {
      const response = await call("/lite/api/session/establish", method, { origin });
      expect(response.status).toBe(403);
      expect(response.headers.get("set-cookie")).toBeNull();
    }
  }
  expect((await call("/lite/api/session/establish", "POST", { origin: "https://home.ts.net" })).status).toBe(403);
  expect((await call("/lite/api/session/establish", "POST", { origin: null })).status).toBe(403);
  expect((await call("/lite/api/snapshot", "GET", { host: "home.ts.net:443" })).status).toBe(403);
  expect(privateReads).toBe(0);
});

test("all business writes, unknown routes and loopback are locked with zero upstream effects", async () => {
  let writes = 0;
  const session = new SessionController({ verify: () => null });
  for (const path of ["/lite/api/launch", "/lite/api/pane/p/reply", "/lite/api/pane/p/stop", "/lite/api/pane/p/keys", "/lite/api/requests/r/approve", "/lite/api/persona", "/lite/api/persona/p/memory", "/lite/api/push/subscribe", "/lite/api/stt", "/lite/api/health"]) {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const result = await handleRequest(request(path, method), cfg, async () => { writes++; return Response.json({ ok: true }); }, undefined, session);
      expect(result.status).toBe(423);
      expect(await result.json()).toMatchObject({ code: "session.locked", executed: false, textDelivered: false, deliveryUnknown: false });
    }
  }
  expect(writes).toBe(0);
});
