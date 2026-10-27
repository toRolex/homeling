import { expect, test } from "bun:test";
import { SessionController } from "./session-controller.ts";
const secret = "a".repeat(43);
function req(path: string, body?: string, cookie?: string, generation?: string) {
  return new Request(`https://home.ts.net/lite/api/session${path}`, { method: body === undefined ? "GET" : "POST", headers: { origin: "https://home.ts.net", "content-type": "application/json", ...(cookie ? { cookie, "x-homeling-session-epoch": "1" } : {}), ...(generation ? { "x-homeling-session-generation": generation } : {}) }, body });
}
test("a stale browser tab cannot re-admit old intent with another tab's newly rotated cookie", async () => {
  const controller = new SessionController({ verify: () => (input) => input === secret });
  const first = (await controller.handle(req("/unlock", JSON.stringify({ secret })), "alice"))!;
  const firstCookie = first.headers.get("set-cookie")!.split(";", 1)[0]!;
  const firstState = await first.json() as { epoch: number };
  await controller.handle(req("/lock", "{}", firstCookie), "alice");
  const rotated = (await controller.handle(req("/unlock", JSON.stringify({ secret }), firstCookie), "alice"))!;
  const newCookie = rotated.headers.get("set-cookie")!.split(";", 1)[0]!;
  const newState = await rotated.json() as { epoch: number };
  const stale = req("", undefined, newCookie, controller.generation); stale.headers.set("x-homeling-session-epoch", String(firstState.epoch));
  expect(() => controller.admission(stale, "alice")).toThrow("session.locked");
  const fresh = req("", undefined, newCookie, controller.generation); fresh.headers.set("x-homeling-session-epoch", String(newState.epoch));
  expect(controller.admission(fresh, "alice")).toBeDefined();
  fresh.headers.delete("x-homeling-session-epoch");
  expect(() => controller.admission(fresh, "alice")).toThrow("session.locked");
  const rebooted = new SessionController({ verify: () => (input) => input === secret });
  const restarted = (await rebooted.handle(req("/unlock", JSON.stringify({ secret })), "alice"))!;
  const rebootCookie = restarted.headers.get("set-cookie")!.split(";", 1)[0]!;
  const oldBoot = req("", undefined, rebootCookie, controller.generation);
  expect(() => rebooted.admission(oldBoot, "alice")).toThrow("session.locked");
  expect(rebooted.admission(req("", undefined, rebootCookie, rebooted.generation), "alice")).toBeDefined();
});

test("credential corruption or local rotation revokes already-admitted operations at their next commit", async () => {
  let verify: (((input: string) => boolean) & { fingerprint?: string }) | null = Object.assign((input: string) => input === secret, { fingerprint: "v1" });
  const controller = new SessionController({ verify: () => verify });
  const response = (await controller.handle(req("/unlock", JSON.stringify({ secret })), "alice"))!;
  const cookie = response.headers.get("set-cookie")!.split(";", 1)[0]!;
  const admission = controller.admission(req("", undefined, cookie, controller.generation), "alice");
  verify = null;
  expect(() => admission.dispatch(() => "write")).toThrow("session.locked");
  expect(() => controller.admission(req("", undefined, cookie, controller.generation), "alice")).toThrow("session.locked");
});

test("subject and global throttles count attempts without a cookie, regardless of newly generated session ids", async () => {
  const controller = new SessionController({ verify: () => () => false, now: () => 1_000 });
  for (let i = 0; i < 5; i++) expect((await controller.handle(req("/unlock", JSON.stringify({ secret }), `new=${i}`), "alice"))!.status).toBe(401);
  expect((await controller.handle(req("/unlock", JSON.stringify({ secret })), "alice"))!.status).toBe(429);
  for (let i = 0; i < 4; i++) expect((await controller.handle(req("/unlock", JSON.stringify({ secret })), `other${i}`))!.status).toBe(401);
  expect((await controller.handle(req("/unlock", JSON.stringify({ secret })), "bob"))!.status).toBe(429);
});
test("unlock rejects an oversized streaming body without verifying or minting a cookie", async () => {
  let verified = 0;
  const controller = new SessionController({ verify: () => () => { verified++; return true; } });
  const response = (await controller.handle(req("/unlock", "x".repeat(1_025)), "alice"))!;
  expect(response.status).toBe(400); expect(response.headers.get("set-cookie")).toBeNull(); expect(verified).toBe(0);
});

test("a cancelled unlock body cannot consume a credential verification or mint a session", async () => {
  let verified = 0;
  const controller = new SessionController({ verify: () => () => { verified++; return true; } });
  const abort = new AbortController(); abort.abort();
  const response = (await controller.handle(new Request("https://home.ts.net/lite/api/session/unlock", { method: "POST", signal: abort.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ secret }) }), "alice"))!;
  expect(response.status).toBe(400); expect(verified).toBe(0); expect(response.headers.get("set-cookie")).toBeNull();
});

test("identity establish is secret-free, rate-limited, lease-idempotent, and never calls the local verifier", async () => {
  let verified = 0;
  const controller = new SessionController({ mode: "tailscale-identity", verify: () => { verified++; throw new Error("identity mode must not load local credentials"); } });
  const metadata = await controller.handle(req(""), "alice");
  expect(metadata?.headers.get("set-cookie")).toBeNull();
  expect(await metadata?.json()).toMatchObject({ mode: "tailscale-identity", locked: true, available: true });
  const denied = await controller.handle(req("/unlock", JSON.stringify({ secret })), "alice");
  expect(denied?.status).toBe(404);
  expect(denied?.headers.get("set-cookie")).toBeNull();
  const malformed = await controller.handle(req("/establish", JSON.stringify({ secret })), "alice");
  expect(malformed?.status).toBe(400);
  expect(malformed?.headers.get("set-cookie")).toBeNull();
  const established = await controller.handle(req("/establish", "{}"), "alice");
  expect(established?.status).toBe(200);
  const cookie = established!.headers.get("set-cookie")!;
  expect(cookie).toContain("__Secure-homeling_session=");
  for (const flag of ["Path=/lite/", "HttpOnly", "SameSite=Strict", "Secure", "Max-Age=28800"]) expect(cookie).toContain(flag);
  const firstState = await established!.json() as { epoch: number; generation: string };
  const currentCookie = cookie.split(";", 1)[0]!;
  const idempotent = await controller.handle(req("/establish", "{}", currentCookie, firstState.generation), "alice");
  expect(idempotent?.status).toBe(200);
  expect(idempotent?.headers.get("set-cookie")).toBeNull();
  expect(await idempotent?.json()).toMatchObject({ locked: false, epoch: firstState.epoch, generation: firstState.generation });
  const admissionRequest = req("", undefined, currentCookie, firstState.generation);
  admissionRequest.headers.set("x-homeling-session-epoch", String(firstState.epoch));
  expect(() => controller.admission(admissionRequest, "alice").assert()).not.toThrow();
  expect(() => controller.admission(admissionRequest, "mallory")).toThrow("session.locked");
  expect(verified).toBe(0);
});

test("identity establish rejects invalid bodies, throttles new leases, and keeps dispatch revocable", async () => {
  const controller = new SessionController({ mode: "tailscale-identity", verify: () => { throw new Error("must not verify"); } });
  for (const body of ["null", "[]", "", "{broken", JSON.stringify({ padding: "x".repeat(1_100) })]) {
    const response = (await controller.handle(req("/establish", body), "alice"))!;
    expect(response.status).toBe(400);
    expect(response.headers.get("set-cookie")).toBeNull();
  }
  const local = new SessionController({ verify: () => null });
  expect((await local.handle(req("/establish", "{}"), "alice"))!.status).toBe(404);
  const established = (await controller.handle(req("/establish", "{}"), "alice"))!;
  const cookie = established.headers.get("set-cookie")!.split(";", 1)[0]!;
  const state = await established.json() as { epoch: number };
  const admittedRequest = req("", undefined, cookie, controller.generation);
  admittedRequest.headers.set("x-homeling-session-epoch", String(state.epoch));
  const admission = controller.admission(admittedRequest, "alice");
  const activity = (await controller.handle(req("/activity", "{}", cookie, controller.generation), "alice"))!;
  expect(await activity.json()).toMatchObject({ mode: "tailscale-identity", available: true, locked: false });
  await controller.handle(req("/lock", "{}", cookie), "alice");
  let effects = 0;
  expect(() => admission.dispatch(() => effects++)).toThrow("session.locked");
  expect(effects).toBe(0);
  for (let i = 0; i < 4; i++) expect((await controller.handle(req("/establish", "{}"), "alice"))!.status).toBe(200);
  expect((await controller.handle(req("/establish", "{}"), "alice"))!.status).toBe(429);
});

test("unlock alone mints a strict HTTPS cookie; polls and activity never resurrect a locked session", async () => {
  const controller = new SessionController({ verify: () => (input) => input === secret });
  expect((await controller.handle(req(""), "alice"))!.status).toBe(200);
  const response = (await controller.handle(req("/unlock", JSON.stringify({ secret })), "alice"))!;
  expect(response.status).toBe(200);
  const setCookie = response.headers.get("set-cookie")!;
  expect(setCookie).toContain("__Secure-homeling_session=");
  for (const flag of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/lite/"]) expect(setCookie).toContain(flag);
  const cookie = setCookie.split(";", 1)[0]!;
  expect(controller.admission(req("", undefined, cookie, controller.generation), "alice")).toBeDefined();
  await controller.handle(req("/lock", "{}", cookie), "alice");
  expect(() => controller.admission(req("", undefined, cookie, controller.generation), "alice")).toThrow("session.locked");
  expect((await controller.handle(req("/activity", "{}", cookie), "alice"))!.status).toBe(423);
});
