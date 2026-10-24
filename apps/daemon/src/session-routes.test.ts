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
});

test("8443 front door unlocks and admits writes only with exact transport and origin", async () => {
  const cfg = daemonConfigFromEnv({ HOMELING_TAILSCALE_HOST: "home.ts.net", HOMELING_PUBLIC_ORIGIN: "https://home.ts.net:8443", HOMELING_TRUSTED_USERS: "alice" });
  const secret = "b".repeat(43);
  const session = new SessionController({ verify: () => (input) => input === secret });
  const make = (path: string, method = "POST", overrides: Record<string, string | null> = {}, remoteAddress = "127.0.0.1", body: unknown = {}) => {
    const headers = new Headers({ host: "home.ts.net:8443", origin: "https://home.ts.net:8443", "tailscale-user-login": "alice", "content-type": "application/json" });
    for (const [key, value] of Object.entries(overrides)) value === null ? headers.delete(key) : headers.set(key, value);
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
