import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { ConversationPage } from "./ConversationPage.tsx";
import type { Root } from "react-dom/client";
import { HomeTriage, SessionAwareHomeTriage } from "./HomeTriage.tsx";
import { AppRoot } from "./AppRoot.tsx";
import { sessionState } from "./session-state.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActivityLedger } from "../../daemon/src/activity-ledger.ts";
import { daemonConfigFromEnv } from "../../daemon/src/config.ts";
import { handleRequest } from "../../daemon/src/index.ts";
import { PersonaRegistry } from "../../daemon/src/persona-registry.ts";
import type { PersonaRuntime } from "../../daemon/src/persona-service.ts";
import { SessionLock } from "../../daemon/src/session-lock.ts";
import { createDaemonSystemAdmissions } from "../../daemon/src/system-admission.ts";

const window = new Window({ url: "https://homeling.test/lite/" });
const saved = new Map<string, PropertyDescriptor | undefined>();
const originalFetch = globalThis.fetch;
let root: Root;
let container: HTMLElement;
let createRoot: typeof import("react-dom/client").createRoot;
const mira = { id: "mira", name: "Mira", avatar: { color: "#86efac" }, spaceId: "space-not-persona", mainPaneId: "main", systemPrompt: "", createdAt: "2026-10-08", status: "idle" };
const request = (id: string, personaId: string | undefined, paneId = "main", status = "pending") => ({ id, personaId, paneId, status, kind: "prompt-select", createdAt: "2026-10-08", payload: { question: "Approve build?", options: [] } });
beforeAll(async () => {
  for (const [key, value] of Object.entries({ window, document: window.document, navigator: window.navigator, HTMLElement: window.HTMLElement, ResizeObserver: window.ResizeObserver, MutationObserver: window.MutationObserver, requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window), IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  ({ createRoot } = await import("react-dom/client"));
});
afterEach(async () => { await act(() => root?.unmount()); container?.remove(); globalThis.fetch = originalFetch; sessionState.lock(); });
afterAll(() => {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  window.close();
});
async function mount(suspended = false, pollIntervalMs = 10000) {
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<MemoryRouter><HomeTriage suspended={suspended} pollIntervalMs={pollIntervalMs} /></MemoryRouter>));
}

const activity = (paneId: string) => ({ observation: "live", events: [], occurrences: [{ occurrenceKey: "3f0ec6a3-14db-40e5-a222-cade2e7f8001", personaId: "mira", spaceId: mira.spaceId, paneId, title: "Build", createdAt: "2026-10-08", status: "active" }] });
const taskLookup = (paneId: string, occurrenceKey = "3f0ec6a3-14db-40e5-a222-cade2e7f8001") => ({ occurrence: { ...activity(paneId).occurrences[0], occurrenceKey }, current: true, observation: "live", liveAvailable: true });

test("home counts distinct registry personas, not requests, spaces, legacy or settled items; links target their actual conversations", async () => {
  globalThis.fetch = (async (url: RequestInfo | URL) => String(url).endsWith("persona/list")
    ? Response.json({ personas: [mira, { ...mira, id: "sol", name: "Sol", mainPaneId: "sol-main" }] })
    : String(url).includes("/activity/task/") ? Response.json(taskLookup("task /1"))
    : String(url).endsWith("/activity") ? Response.json(activity("task /1"))
    : Response.json([request("1", "mira"), { ...request("2", "mira", "task /1"), taskOccurrenceKey: "3f0ec6a3-14db-40e5-a222-cade2e7f8001" }, request("3", "sol", "sol-main"), request("4", "space-not-persona"), request("5", undefined), request("6", "unknown"), request("7", "mira", "main", "resolved"), request("8", "sol", "sol-main", "expired")])) as unknown as typeof fetch;
  await mount();
  expect(container.textContent).toContain("2 companions need you");
  expect([...container.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual(["/persona/mira", "/p/task%20%2F1?occurrence=3f0ec6a3-14db-40e5-a222-cade2e7f8001", "/persona/sol"]);
});

test("successful polling removes resolved requests and hides the zero summary without push", async () => {
  let requests = [request("1", "mira")];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.method ?? "GET").toBe("GET");
    return String(url).endsWith("persona/list") ? Response.json({ personas: [mira] }) : Response.json(requests);
  }) as unknown as typeof fetch;
  await mount(false, 10);
  expect(container.textContent).toContain("1 companion needs you");
  requests = [request("1", "mira", "main", "resolved")];
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  expect(container.querySelector("section")).toBeNull();
  expect(container.querySelector("a")).toBeNull();
});

test("read failure is visible and preserves only an explicitly labelled last confirmed summary", async () => {
  let fail = false;
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    if (fail) throw new Error("offline");
    return String(url).endsWith("persona/list") ? Response.json({ personas: [mira] }) : Response.json([request("1", "mira")]);
  }) as unknown as typeof fetch;
  await mount(false, 10);
  fail = true;
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("These are the last confirmed requests");
  expect(container.textContent).toContain("1 companion needs you");
});

test.each(["settled-latest", "reused-owner", "not-current", "not-live-available", "request-key-mismatch", "gap", "wrong-persona", "wrong-space", "read-failed"])("unconfirmed task %s retains persona count without exposing an unscoped writable link", async (scenario) => {
  const current = activity("task");
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    if (String(url).endsWith("persona/list")) return Response.json({ personas: [mira] });
    if (String(url).includes("/activity/task/")) return Response.json({ occurrence: current.occurrences[0], current: scenario !== "not-current", liveAvailable: scenario !== "not-live-available", observation: "live" });
    if (!String(url).endsWith("/activity")) return Response.json([{ ...request("task-request", "mira", "task"), ...(scenario === "request-key-mismatch" ? { taskOccurrenceKey: "3f0ec6a3-14db-40e5-a222-cade2e7f8002" } : {}) }]);
    if (scenario === "read-failed") throw new Error("offline");
    return Response.json({ ...current, observation: scenario === "gap" ? "gap" : "live", occurrences: scenario === "reused-owner"
      ? [...current.occurrences, { ...current.occurrences[0], occurrenceKey: "3f0ec6a3-14db-40e5-a222-cade2e7f8002", personaId: "other-owner", spaceId: "other-space" }]
      : scenario === "settled-latest"
      ? [...current.occurrences, { ...current.occurrences[0], occurrenceKey: "3f0ec6a3-14db-40e5-a222-cade2e7f8002", createdAt: "2026-10-01", status: "completed" }]
      : [{ ...current.occurrences[0], personaId: scenario === "wrong-persona" ? "someone-else" : "mira", spaceId: scenario === "wrong-space" ? "legacy-space" : mira.spaceId }] });
  }) as unknown as typeof fetch;
  await mount();
  expect(container.textContent).toContain("1 companion needs you");
  expect(container.textContent).toContain("Task ownership cannot be confirmed");
  expect(container.querySelector("a")).toBeNull();
});

test("task lookup uses the newest append record even when its timestamp is older", async () => {
  const current = activity("task");
  globalThis.fetch = (async (url: RequestInfo | URL) => String(url).endsWith("persona/list") ? Response.json({ personas: [mira] })
    : String(url).includes("/activity/task/") ? Response.json(taskLookup("task", "3f0ec6a3-14db-40e5-a222-cade2e7f8002"))
    : String(url).endsWith("/activity") ? Response.json({ ...current, occurrences: [...current.occurrences, { ...current.occurrences[0], occurrenceKey: "3f0ec6a3-14db-40e5-a222-cade2e7f8002", createdAt: "2026-10-01" }] })
    : Response.json([request("task-request", "mira", "task")])) as unknown as typeof fetch;
  await mount();
  expect(container.querySelector("a")?.getAttribute("href")).toBe("/p/task?occurrence=3f0ec6a3-14db-40e5-a222-cade2e7f8002");
});

function visibility(hidden: boolean) {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: hidden ? "hidden" : "visible" });
  document.dispatchEvent(new window.Event("visibilitychange") as unknown as Event);
}

test("hidden pages stop GETs; resumed generations discard old responses even if transport ignores abort", async () => {
  let requestReads = 0;
  let finishOld!: (response: Response) => void;
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    if (String(url).endsWith("persona/list")) return Response.json({ personas: [mira] });
    requestReads++;
    if (requestReads === 1) return new Promise<Response>((resolve) => { finishOld = resolve; });
    return Response.json([]);
  }) as unknown as typeof fetch;
  await mount(false, 10);
  expect(requestReads).toBe(1);
  await act(async () => visibility(true));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  expect(requestReads).toBe(1);
  await act(async () => visibility(false));
  expect(requestReads).toBe(2);
  await act(async () => finishOld(Response.json([request("old", "mira")])));
  expect(container.querySelector("section")).toBeNull();
});

test("late task ownership response from a hidden generation cannot restore requests or start new task GETs", async () => {
  let reads = 0;
  let taskReads = 0;
  let finishOld!: (response: Response) => void;
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    if (String(url).endsWith("persona/list")) return Response.json({ personas: [mira] });
    if (String(url).endsWith("/activity")) return new Promise<Response>((resolve) => { finishOld = resolve; });
    if (String(url).includes("/activity/task/")) { taskReads++; return Response.json(taskLookup("task")); }
    reads++;
    return Response.json(reads === 1 ? [request("old", "mira", "task")] : []);
  }) as unknown as typeof fetch;
  await mount();
  expect(finishOld).toBeDefined();
  await act(async () => visibility(true));
  await act(async () => visibility(false));
  expect(reads).toBe(2);
  await act(async () => finishOld(Response.json(activity("task"))));
  expect(container.querySelector("section")).toBeNull();
  expect(taskReads).toBe(0);
});

test("locking during the first task lookup prevents later lookups even when transport ignores abort", async () => {
  const taskReads: string[] = [];
  let finish!: (response: Response) => void;
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    const path = String(url);
    if (path.endsWith("persona/list")) return Response.json({ personas: [mira] });
    if (path.endsWith("requests")) return Response.json([request("first", "mira", "task1"), request("second", "mira", "task2")]);
    if (path.endsWith("/activity")) return Response.json({ ...activity("task1"), occurrences: [...activity("task1").occurrences, { ...activity("task2").occurrences[0], occurrenceKey: "3f0ec6a3-14db-40e5-a222-cade2e7f8002" }] });
    taskReads.push(path);
    return new Promise<Response>((resolve) => { finish = resolve; });
  }) as unknown as typeof fetch;
  await mount();
  expect(taskReads).toHaveLength(1);
  await act(async () => root.render(<MemoryRouter><HomeTriage suspended /></MemoryRouter>));
  await act(async () => finish(Response.json(taskLookup("task1"))));
  expect(taskReads).toHaveLength(1);
  expect(container.textContent).toBe("");
});

test("locked suspension performs no reads, hides prior summary, and invalidates in-flight reads", async () => {
  let reads = 0;
  let finish!: (response: Response) => void;
  globalThis.fetch = (async () => { reads++; return new Promise<Response>((resolve) => { finish = resolve; }); }) as unknown as typeof fetch;
  await mount(true);
  expect(reads).toBe(0);
  await act(async () => root.render(<MemoryRouter><HomeTriage /></MemoryRouter>));
  expect(reads).toBe(2);
  await act(async () => root.render(<MemoryRouter><HomeTriage suspended /></MemoryRouter>));
  await act(async () => finish(Response.json([request("late", "mira")])));
  expect(container.textContent).toBe("");
  expect(reads).toBe(2);
});

test("unlock waits for a fresh triage read rather than flashing a pre-lock pending request", async () => {
  let delayed = false;
  let finish!: (response: Response) => void;
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    if (String(url).endsWith("persona/list")) return Response.json({ personas: [mira] });
    if (delayed) return new Promise<Response>((resolve) => { finish = resolve; });
    return Response.json([request("old", "mira")]);
  }) as unknown as typeof fetch;
  await mount();
  expect(container.textContent).toContain("1 companion needs you");
  await act(async () => root.render(<MemoryRouter><HomeTriage suspended /></MemoryRouter>));
  delayed = true;
  await act(async () => root.render(<MemoryRouter><HomeTriage /></MemoryRouter>));
  expect(container.querySelector("section")).toBeNull();
  await act(async () => finish(Response.json([])));
  expect(container.querySelector("section")).toBeNull();
});

test("production AppRoot really suspends triage on server lock and until read-only unlock catch-up completes", async () => {
  sessionState.lock();
  let pendingReads = 0;
  let finishSnapshot!: (response: Response) => void;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url);
    if (path.endsWith("/session")) return Response.json({ mode: "local-unlock", locked: true, generation: "boot", serverNow: Date.now(), available: true });
    if (path.endsWith("/session/unlock")) return Response.json({ mode: "local-unlock", locked: false, available: true, epoch: 2, generation: "boot", serverNow: Date.now(), idleDeadline: Date.now() + 60_000, absoluteDeadline: Date.now() + 600_000 });
    if (path.endsWith("persona/list")) return Response.json({ personas: [mira] });
    if (path.endsWith("requests")) { pendingReads++; expect(init?.method ?? "GET").toBe("GET"); return Response.json([request("needs-you", "mira")]); }
    if (path.endsWith("snapshot")) return new Promise<Response>((resolve) => { finishSnapshot = resolve; });
    return Response.json({ paneId: "main", available: false, reason: "no-log" });
  }) as unknown as typeof fetch;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<MemoryRouter><AppRoot slots={{ homeSummary: <SessionAwareHomeTriage /> }} /></MemoryRouter>));
  expect(pendingReads).toBe(0);
  await settleUntil(() => container.querySelector('input[type="password"]') !== null);
  const input = container.querySelector('input[type="password"]')! as HTMLInputElement;
  input.value = "x".repeat(43);
  await act(async () => container.querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
  expect(sessionState.get().locked).toBe(false);
  expect(sessionState.get().ready).toBe(false);
  expect(pendingReads).toBe(1); // SessionBoundary catch-up only; triage is still suspended.
  expect(container.textContent).not.toContain("1 companion needs you");
  await act(async () => finishSnapshot(Response.json({ ts: 1, bridge: "connected", agents: [], shellPanes: [] })));
  expect(sessionState.get().ready).toBe(true);
  expect(pendingReads).toBe(2);
  expect(container.textContent).toContain("1 companion needs you");
  await act(async () => sessionState.lock());
  expect(container.textContent).not.toContain("1 companion needs you");
  expect(pendingReads).toBe(2);
});

async function settleUntil(check: () => boolean) {
  for (let attempt = 0; attempt < 100 && !check(); attempt++) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  }
  expect(check()).toBe(true);
}

test("triage consumes real daemon ledger ownership and scoped history, and the same link becomes read-only after a new work cycle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "homeling-triage-api-"));
  try {
    const cfg = daemonConfigFromEnv({ HOMELING_REGISTRY_PATH: join(directory, "registry.json") });
    const ledger = new ActivityLedger(join(directory, "activity.json"));
    const lock = new SessionLock(); const { token } = lock.unlock("test");
    const user = lock.admission(lock.admit(token, "test"));
    const observer = createDaemonSystemAdmissions().activityObserve;
    const occurrence = await ledger.register({ personaId: mira.id, spaceId: mira.spaceId, paneId: "owned-task", title: "Build" }, user);
    ledger.live(observer);
    const upstreamCalls: string[] = [];
    const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method ?? "GET").toBe("GET");
      upstreamCalls.push(String(input));
      return Response.json({ paneId: "owned-task", available: true, entries: [], hasMore: false, fileTruncated: false, total: 0 });
    };
    const unavailable = (): never => { throw new Error("No real Herdr access"); };
    const runtime: PersonaRuntime = { cfg, registry: new PersonaRegistry(cfg.registryPath), activity: ledger, fetcher, herdr: { createSpace: unavailable, createTab: unavailable, readPane: unavailable, sendText: unavailable, sendKeys: unavailable, closePane: unavailable, renameSpace: unavailable, snapshot: unavailable, subscribe: unavailable } };
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input); calls.push(path);
      if (path.endsWith("persona/list")) return Response.json({ personas: [mira] });
      if (path.endsWith("requests")) return Response.json([{ ...request("approval", "mira", "owned-task"), taskOccurrenceKey: occurrence.occurrenceKey, payload: { question: "Owned task permission", options: [{ id: "yes", label: "Allow owned task" }] } }]);
      if (path.endsWith("snapshot")) return Response.json({ ts: 1, bridge: "connected", agents: [], shellPanes: [] });
      if (path.endsWith("launchers")) return Response.json({ launchers: [] });
      const req = Object.assign(new Request(new URL(path, "http://localhost:8790"), { ...init, headers: { host: "localhost:8790" } }), { remoteAddress: "127.0.0.1" });
      return handleRequest(req, cfg, fetcher, runtime);
    }) as unknown as typeof fetch;
    sessionState.apply({ locked: false, epoch: 2, generation: "boot" }); sessionState.caughtUp();
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    const routes = <Routes><Route path="/" element={<HomeTriage />} /><Route path="/p/:paneId" element={<ConversationPage />} /></Routes>;
    await act(async () => root.render(<MemoryRouter>{routes}</MemoryRouter>));
    await settleUntil(() => container.querySelector("a") !== null);
    const link = container.querySelector("a")!;
    expect(link.getAttribute("href")).toBe(`/p/owned-task?occurrence=${occurrence.occurrenceKey}`);
    await act(async () => link.dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }) as unknown as Event));
    await settleUntil(() => container.textContent?.includes("Owned task permission") === true);
    expect(container.textContent).toContain("Owned task permission");
    expect(calls).toContain(`/lite/api/activity/task/${occurrence.occurrenceKey}/history`);
    expect(calls.some((path) => path.includes("/pane/"))).toBe(false);
    expect(upstreamCalls.some((path) => path.endsWith("/api/pane/owned-task/history"))).toBe(true);
    await ledger.observe("pane_agent_status_changed", { pane_id: "owned-task", workspace_id: mira.spaceId, agent_status: "working" }, observer);
    await ledger.observe("pane_agent_status_changed", { pane_id: "owned-task", workspace_id: mira.spaceId, agent_status: "done" }, observer);
    await ledger.observe("pane_agent_status_changed", { pane_id: "owned-task", workspace_id: mira.spaceId, agent_status: "working" }, observer);
    calls.length = 0; upstreamCalls.length = 0;
    await act(async () => root.render(<MemoryRouter key="stale" initialEntries={[`/p/owned-task?occurrence=${occurrence.occurrenceKey}`]}>{routes}</MemoryRouter>));
    await settleUntil(() => container.textContent?.includes("Recorded task") === true);
    expect(container.querySelector("textarea") !== null).toBe(false);
    expect(container.textContent).not.toContain("Owned task permission");
    expect(calls.some((path) => path.endsWith("requests") || path.endsWith("/history"))).toBe(false);
    expect(upstreamCalls).toHaveLength(0);
  } finally {
    await act(() => root?.unmount());
    await rm(directory, { recursive: true, force: true });
  }
});

test.each(["historical", "wrong-pane", "unknown"])("actual task approval route %s cannot expose newer-pane history, approvals or composer", async (scenario) => {
  sessionState.apply({ locked: false, epoch: 2, generation: "boot" }); sessionState.caughtUp();
  const calls: string[] = [];
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    const path = String(url); calls.push(path);
    if (path.includes("/activity/task/")) return scenario === "unknown" ? Response.json({ error: "not found" }, { status: 404 })
      : Response.json({ ...taskLookup("task"), current: scenario !== "historical", occurrence: { ...taskLookup("task").occurrence, paneId: scenario === "wrong-pane" ? "another-pane" : "task" } });
    if (path.endsWith("requests")) return Response.json([{ ...request("new-task-request", "mira", "task"), payload: { question: "NEW TASK PERMISSION", options: [{ id: "yes", label: "Allow new task" }] } }]);
    if (path.endsWith("snapshot")) return Response.json({ ts: 1, bridge: "connected", agents: [], shellPanes: [] });
    if (path.endsWith("launchers")) return Response.json({ launchers: [] });
    return Response.json({ paneId: "task", available: false, reason: "no-log" });
  }) as unknown as typeof fetch;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<MemoryRouter initialEntries={["/p/task?occurrence=3f0ec6a3-14db-40e5-a222-cade2e7f8001"]}><Routes><Route path="/p/:paneId" element={<ConversationPage />} /></Routes></MemoryRouter>));
  expect(container.querySelector("textarea") !== null).toBe(false);
  expect(container.textContent).not.toContain("NEW TASK PERMISSION");
  expect(calls.some((path) => path.includes("/pane/") || path.endsWith("requests"))).toBe(false);
});

for (const kind of ["task", "main"] as const) {
  test(`summary ${kind} link reaches the actual pane approval card, main identity follows rebuilt registry pane`, async () => {
    sessionState.apply({ locked: false, epoch: 2, generation: "boot" }); sessionState.caughtUp();
    const target = kind === "task" ? "task /1" : "rebuilt-main";
    const paths: string[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const path = String(url); paths.push(path);
      if (path.endsWith("persona/list")) return Response.json({ personas: [{ ...mira, mainPaneId: "rebuilt-main" }] });
      if (path.endsWith("requests")) return Response.json([{ ...request("target", "mira", target), payload: { question: "Target permission", options: [{ id: "yes", label: "Allow target" }] } }, request("other", "mira", "other-pane")]);
      if (path.includes("/activity/task/")) return Response.json(taskLookup(target));
      if (path.endsWith("/activity")) return Response.json(activity(target));
      if (path.endsWith("snapshot")) return Response.json({ ts: 1, bridge: "connected", agents: [], shellPanes: [] });
      if (path.endsWith("launchers")) return Response.json({ launchers: [] });
      return Response.json({ available: false, reason: "no-log", paneId: target });
    }) as unknown as typeof fetch;
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root.render(<MemoryRouter><Routes><Route path="/" element={<HomeTriage />} /><Route path="/p/:paneId" element={<ConversationPage />} /><Route path="/persona/:personaId" element={<ConversationPage />} /></Routes></MemoryRouter>));
    const link = container.querySelector("a")!;
    await act(async () => link.dispatchEvent(new window.MouseEvent("click", { bubbles: true, button: 0 }) as unknown as Event));
    expect(container.textContent).toContain("Target permission");
    expect(container.textContent).not.toContain("Approve build?");
    expect(paths.some((path) => path.endsWith(kind === "task" ? "activity/task/3f0ec6a3-14db-40e5-a222-cade2e7f8001/history" : `pane/${encodeURIComponent(target)}/history`))).toBe(true);
  });
}
