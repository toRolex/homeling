import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActivityLedger } from "./activity-ledger.ts";
import { daemonConfigFromEnv } from "./config.ts";
import { handleRequest } from "./index.ts";
import { PersonaRegistry } from "./persona-registry.ts";
import type { PersonaRuntime } from "./persona-service.ts";
import { SessionLock } from "./session-lock.ts";
import { createDaemonSystemAdmissions } from "./system-admission.ts";
import { handleUnlockedRequest } from "./session-test-fixture.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

test("scoped history rechecks the real occurrence after upstream body arrival and stale controls never dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "homeling-scoped-activity-")); roots.push(root);
  const cfg = { ...daemonConfigFromEnv({ HOMELING_REGISTRY_PATH: join(root, "registry.json") }), trustedUsers: ["me"], tailscaleHost: "home.tail.test", publicOrigin: "https://home.tail.test" };
  const activity = new ActivityLedger(join(root, "activity.json"));
  const session = new SessionLock(); const { token } = session.unlock("test");
  const user = session.admission(session.admit(token, "test"));
  const observer = createDaemonSystemAdmissions().activityObserve;
  const occurrence = await activity.register({ personaId: "a", spaceId: "s", paneId: "p", title: "Old build" }, user);
  activity.live(observer);
  const begun = Promise.withResolvers<void>(); const delayed = Promise.withResolvers<Response>();
  let writes = 0;
  const fetcher = async (_input: string | URL | Request, init?: RequestInit) => { if (init?.method === "POST") { writes++; return Response.json({ ok: true }); } begun.resolve(); return delayed.promise; };
  const unavailable = (): never => { throw new Error("Herdr must not be used by scoped proxy"); };
  const runtime: PersonaRuntime = { cfg, registry: new PersonaRegistry(cfg.registryPath), activity, fetcher, herdr: { createSpace: unavailable, createTab: unavailable, readPane: unavailable, sendText: unavailable, sendKeys: unavailable, closePane: unavailable, renameSpace: unavailable, snapshot: unavailable, subscribe: unavailable } };
  const req = (action: string, method = "GET") => Object.assign(new Request(`https://home.tail.test/lite/api/activity/task/${occurrence.occurrenceKey}/${action}`, { method, headers: { host: "home.tail.test", origin: "https://home.tail.test", "tailscale-user-login": "me", "content-type": "application/json" }, ...(method === "POST" ? { body: JSON.stringify({ text: "Old instruction", submit: true }) } : {}) }), { remoteAddress: "127.0.0.1" });
  const reading = handleRequest(req("history"), cfg, fetcher, runtime);
  await begun.promise;
  await activity.observe("pane_agent_status_changed", { pane_id: "p", workspace_id: "s", agent_status: "working" }, observer);
  await activity.observe("pane_agent_status_changed", { pane_id: "p", workspace_id: "s", agent_status: "done" }, observer);
  await activity.observe("pane_agent_status_changed", { pane_id: "p", workspace_id: "s", agent_status: "working" }, observer);
  delayed.resolve(Response.json({ entries: [{ text: "NEWER TASK SECRET" }] }));
  const rejected = await reading;
  expect(rejected.status).toBe(409);
  expect(await rejected.text()).not.toContain("NEWER TASK SECRET");
  for (const action of ["reply", "stop", "control-key"]) {
    const write = await handleUnlockedRequest(req(action, "POST"), cfg, fetcher, runtime);
    expect(write.status).toBe(409);
  }
  expect(writes).toBe(0);
});

test("scoped replies share the native cancellation barrier while busy and after an unknown key result", async () => {
  const root = await mkdtemp(join(tmpdir(), "homeling-scoped-cancel-")); roots.push(root);
  const cfg = { ...daemonConfigFromEnv({ HOMELING_REGISTRY_PATH: join(root, "registry.json") }), trustedUsers: ["me"], tailscaleHost: "home.tail.test", publicOrigin: "https://home.tail.test" };
  const activity = new ActivityLedger(join(root, "activity.json"));
  const lock = new SessionLock(); const { token } = lock.unlock("test");
  const occurrence = await activity.register({ personaId: "a", spaceId: "s", paneId: "p", title: "Build" }, lock.admission(lock.admit(token, "test")));
  activity.live(createDaemonSystemAdmissions().activityObserve);
  const begun = Promise.withResolvers<void>(); const held = Promise.withResolvers<Response>();
  let replies = 0;
  const pane = { paneId: "p", workspaceId: "s", tabId: "t", agent: "claude", cwd: "/", sessionName: "session", status: "working" };
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") {
      if (String(input).endsWith("/reply")) { replies++; return Response.json({ ok: true }); }
      begun.resolve(); return held.promise;
    }
    return String(input).endsWith("/snapshot") ? Response.json({ bridge: "connected", agents: [pane], shellPanes: [] }) : Response.json({ paneId: "p", text: "Working on task", truncated: false });
  };
  const unavailable = (): never => { throw new Error("Herdr must not be used"); };
  const runtime: PersonaRuntime = { cfg, registry: new PersonaRegistry(cfg.registryPath), activity, fetcher, herdr: { createSpace: unavailable, createTab: unavailable, readPane: unavailable, sendText: unavailable, sendKeys: unavailable, closePane: unavailable, renameSpace: unavailable, snapshot: unavailable, subscribe: unavailable } };
  const req = (path: string, body: unknown) => Object.assign(new Request(`https://home.tail.test${path}`, { method: "POST", headers: { host: "home.tail.test", origin: "https://home.tail.test", "tailscale-user-login": "me", "content-type": "application/json" }, body: JSON.stringify(body) }), { remoteAddress: "127.0.0.1" });
  const key = handleUnlockedRequest(req("/lite/api/pane/p/control-key", { action: "interrupt", confirmed: true, identity: JSON.stringify(["p", "s", "t", "claude", "/", "session", null, null]) }), cfg, fetcher, runtime);
  await begun.promise;
  const reply = () => handleUnlockedRequest(req(`/lite/api/activity/task/${occurrence.occurrenceKey}/reply`, { text: "must not enter a cancelled input", submit: true }), cfg, fetcher, runtime);
  const busy = await reply();
  expect(busy.status).toBe(409);
  expect(await busy.json()).toMatchObject({ executed: false, textDelivered: false });
  held.reject(new Error("key outcome lost"));
  expect(await (await key).json()).toMatchObject({ outcome: "unknown" });
  const unknown = await reply();
  expect(unknown.status).toBe(409);
  expect(await unknown.json()).toMatchObject({ executed: false, textDelivered: false });
  expect(replies).toBe(0);
});

test("authenticated Activity API reads durable history without triggering Herdr or recovery writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "homeling-activity-api-")); roots.push(root);
  const cfg = daemonConfigFromEnv({ HOMELING_REGISTRY_PATH: join(root, "registry.json"), HOMELING_WEB_DIST: root });
  const activity = new ActivityLedger(join(root, "activity.json"));
  const session = new SessionLock(); const { token } = session.unlock("test");
  const occurrence = await activity.register({ personaId: "a", spaceId: "s", paneId: "p", title: "Build" }, session.admission(session.admit(token, "test")));
  const unavailable = (): never => { throw new Error("Herdr must not be called by Activity GET"); };
  const runtime: PersonaRuntime = { cfg, registry: new PersonaRegistry(cfg.registryPath), activity, herdr: { createSpace: unavailable, createTab: unavailable, readPane: unavailable, sendText: unavailable, sendKeys: unavailable, closePane: unavailable, renameSpace: unavailable, snapshot: unavailable, subscribe: unavailable }, fetcher: async () => { throw new Error("Bridge must not be called"); } };
  const req = (path: string, remoteAddress = "127.0.0.1") => Object.assign(new Request(`http://localhost:8790${path}`, { headers: { host: "localhost:8790" } }), { remoteAddress });
  const response = await handleRequest(req("/lite/api/persona/a/activity"), cfg, runtime.fetcher, runtime);
  expect(response.status).toBe(200);
  expect((await response.json()).events[0].kind).toBe("task.created");
  const detail = await handleRequest(req(`/lite/api/activity/task/${occurrence.occurrenceKey}`), cfg, runtime.fetcher, runtime);
  expect(await detail.json()).toMatchObject({ occurrence: { paneId: "p", occurrenceKey: occurrence.occurrenceKey }, current: true });
  const absent = await handleRequest(req("/lite/api/persona/b/activity"), cfg, runtime.fetcher, runtime);
  expect(absent.status).toBe(404);
  const denied = await handleRequest(req("/lite/api/persona/a/activity", "192.168.1.2"), cfg, runtime.fetcher, runtime);
  expect(denied.status).toBe(401);
});
