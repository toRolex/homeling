import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, type ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router";
import type { Root } from "react-dom/client";
import { AppRoot } from "./AppRoot.tsx";
import { LocaleProvider, LanguageSettings } from "./locale.tsx";
import { sessionState } from "./session-state.ts";
import { PushSettings } from "./PushSettings.tsx";

const window = new Window({ url: "https://homeling.test/lite/p/p1" });
const saved = new Map<string, PropertyDescriptor | undefined>();
const originalFetch = globalThis.fetch;
let root: Root;
let container: HTMLElement;
let createRoot: typeof import("react-dom/client").createRoot;
beforeAll(async () => {
  for (const [key, value] of Object.entries({ window, document: window.document, navigator: window.navigator, HTMLElement: window.HTMLElement, ResizeObserver: window.ResizeObserver, MutationObserver: window.MutationObserver, getComputedStyle: window.getComputedStyle.bind(window), requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window), IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  ({ createRoot } = await import("react-dom/client"));
});
afterEach(async () => { await act(() => root?.unmount()); container?.remove(); window.localStorage.clear(); globalThis.fetch = originalFetch; sessionState.lock(); });
afterAll(() => {
  for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); }
  window.close();
});
function Location() { return <output data-location>{useLocation().pathname}</output>; }
async function changeLocale(locale: string) {
  const select = container.querySelector("select")!;
  await act(async () => { select.value = locale; select.dispatchEvent(new window.Event("change", { bubbles: true }) as unknown as Event); });
}
async function unlock() {
  await act(async () => {
    const password = container.querySelector<HTMLInputElement>('[type="password"]')!;
    password.value = "a".repeat(43);
    password.closest("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
  });
}
function fakeServer(onReply: () => Promise<Response>) {
  let locked = true;
  let sessionWrites = 0, localeWrites = 0, enrollments = 0;
  let remoteLocale = "en";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/session")) {
      if (init?.method === "POST") sessionWrites++;
      if (url.endsWith("/unlock")) locked = false;
      if (url.endsWith("/establish")) locked = false;
      if (url.endsWith("/lock")) locked = true;
      return Response.json({ mode: "local-unlock", locked, available: true, epoch: locked ? undefined : 1, generation: "boot", idleDeadline: Date.now() + 900_000, absoluteDeadline: Date.now() + 28_800_000, serverNow: Date.now() });
    }
    if (url.endsWith("/push/status")) return Response.json({ publicKey: "public", preferences: { enabled: false }, subscriptions: [{ endpoint: "https://fcm.googleapis.com/fcm/send/existing", locale: remoteLocale }], retractTags: [] });
    if (url.endsWith("/push/subscribe")) { enrollments++; const update = JSON.parse(String(init?.body)); remoteLocale = update.locale ?? remoteLocale; return Response.json({ ok: true }, { status: 201 }); }
    if (url.endsWith("/push/locale")) { localeWrites++; if (locked) return Response.json({ executed: false, deliveryUnknown: false }, { status: 423 }); const update = JSON.parse(String(init?.body)); remoteLocale = update.locale; return Response.json({ ok: true, locale: remoteLocale }); }
    if (url.endsWith("/reply")) return onReply();
    if (url.endsWith("/persona/list")) return Response.json({ personas: [] });
    if (url.endsWith("/snapshot")) return Response.json({ bridge: "connected", agents: [], shellPanes: [], workspaces: [], tabs: [], sessions: [], ts: Date.now() });
    if (url.endsWith("/requests")) return Response.json([]);
    if (url.endsWith("/launchers")) return Response.json({ launchers: [] });
    if (url.includes("/history")) return Response.json({ paneId: "p1", available: true, entries: [], hasMore: false, total: 0, fileTruncated: false });
    if (url.endsWith("/pane/p1")) return Response.json({ paneId: "p1", text: "Original terminal output 原文", truncated: false });
    throw new Error(`Unexpected fake request: ${url} ${init?.method}`);
  }) as typeof fetch;
  return { sessionWrites: () => sessionWrites, localeWrites: () => localeWrites, remoteLocale: () => remoteLocale, enrollments: () => enrollments };
}
async function mount(path = "/p/p1", settings: ReactNode = <button data-other-settings>Push settings extension</button>) {
  sessionState.lock();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<LocaleProvider><MemoryRouter initialEntries={[path]}><Location />{path !== "/settings" ? <LanguageSettings /> : null}<AppRoot slots={{ settings }} /></MemoryRouter></LocaleProvider>));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
}
test.each(["/p/p1", "/t/p1"])("unknown retry refresh for %s cannot prompt or send after its page unmounts", async (path) => {
  let writes = 0, gated = false, confirmations = 0;
  const read = Promise.withResolvers<Response>();
  fakeServer(async () => { writes++; return Response.json({ ok: false, deliveryUnknown: true }, { status: 502 }); });
  const transport = globalThis.fetch, originalConfirm = Object.getOwnPropertyDescriptor(window, "confirm");
  Object.defineProperty(window, "confirm", { configurable: true, value: () => { confirmations++; return true; } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/history") && gated) return read.promise;
    if (url.endsWith("/snapshot")) return Response.json({ bridge: "connected", agents: [{ paneId: "p1", paneLabel: "Task", workspaceId: "s1", tabId: "t1", status: "working", agentKind: "claude" }], shellPanes: [], workspaces: [], tabs: [], sessions: [], ts: Date.now() });
    return transport(input, init);
  }) as typeof fetch;
  try {
    await mount(path); await unlock();
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
    await act(() => { Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "retry safely"); textarea.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event); });
    await act(async () => textarea.closest("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
    expect(writes).toBe(1);
    gated = true;
    const retry = [...container.querySelectorAll("button")].find(item => item.textContent === "Retry")!;
    await act(() => retry.click());
    await act(() => root.unmount());
    await act(async () => { read.resolve(Response.json({ paneId: "p1", available: true, entries: [], hasMore: false, total: 0, fileTruncated: false })); });
    expect(confirmations).toBe(0); expect(writes).toBe(1);
  } finally { if (originalConfirm) Object.defineProperty(window, "confirm", originalConfirm); else Reflect.deleteProperty(window, "confirm"); }
});
test("failed manual server lock keeps drafts fail-closed and visibly unconfirmed until a locked read", async () => {
  fakeServer(async () => { throw new Error("unexpected message write"); });
  const transport = globalThis.fetch;
  let serverLocked = false;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/session/lock")) throw new Error("connection lost");
    if (String(input).endsWith("/session") && serverLocked) return Response.json({ mode: "local-unlock", locked: true, available: true, generation: "boot", serverNow: Date.now() });
    return transport(input, init);
  }) as typeof fetch;
  await mount("/settings"); await unlock();
  const lock = [...container.querySelectorAll("button")].find(item => item.textContent === "Lock Homeling")!;
  await act(async () => lock.click());
  expect(sessionState.get().locked).toBe(true);
  expect(container.textContent).toContain("Server lock is not confirmed");
  const check = () => [...container.querySelectorAll("button")].find(item => item.textContent === "Check session again")!;
  await act(async () => check().click());
  expect(container.textContent).toContain("Server lock is not confirmed");
  expect(sessionState.get().ready).toBe(false);
  serverLocked = true;
  await act(async () => check().click());
  expect(container.textContent).not.toContain("Server lock is not confirmed");
  expect(container.textContent).toContain("Homeling is locked");
});
test("a failed native-language update remains visible across remount and does not replay on unlock", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(window.navigator, "serviceWorker");
  const worker = { scope: `${window.location.origin}/lite/`, active: {}, pushManager: { getSubscription: async () => ({ endpoint: "https://fcm.googleapis.com/fcm/send/existing" }) } };
  Object.defineProperty(window.navigator, "serviceWorker", { configurable: true, value: { getRegistration: async () => worker } });
  try {
    const server = fakeServer(async () => { throw new Error("unexpected message write"); });
    const transport = globalThis.fetch; let fail = true, attempts = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => { if (String(input).endsWith("/push/locale")) { attempts++; if (fail) throw new Error("lost response"); } return transport(input, init); }) as typeof fetch;
    await mount("/settings"); await unlock(); await changeLocale("de");
    expect(attempts).toBe(1); expect(window.localStorage.getItem("homeling.pushLocalePending")).toBe("1");
    await act(() => root.unmount()); container.remove();
    await mount("/settings"); await unlock();
    expect(attempts).toBe(1); expect(container.textContent).toContain("nicht synchronisiert");
    fail = false;
    await act(async () => container.querySelector("button[data-locale-sync]")!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event));
    expect(attempts).toBe(2); expect(server.localeWrites()).toBe(1); expect(window.localStorage.getItem("homeling.pushLocalePending")).toBeNull();
  } finally { if (descriptor) Object.defineProperty(window.navigator, "serviceWorker", descriptor); else Reflect.deleteProperty(window.navigator, "serviceWorker"); }
});
test("production settings compose lock, push and language; only explicit enrollment allocates and carries the selected locale", async () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let current: PushSubscription | null = null, allocations = 0, permissions = 0;
  const subscription = { endpoint: "https://fcm.googleapis.com/fcm/send/existing", toJSON: () => ({ endpoint: "https://fcm.googleapis.com/fcm/send/existing", keys: { p256dh: "fixture", auth: "fixture" } }), unsubscribe: async () => true } as unknown as PushSubscription;
  const worker = { scope: `${window.location.origin}/lite/`, active: {}, pushManager: { getSubscription: async () => current, subscribe: async () => { allocations++; current = subscription; return subscription; } } };
  const define = (object: object, key: string, value: unknown) => { const id = object === window ? `window:${key}` : object === window.navigator ? `navigator:${key}` : `global:${key}`; descriptors.set(id, Object.getOwnPropertyDescriptor(object, key)); Object.defineProperty(object, key, { configurable: true, value }); };
  const notification = { requestPermission: async () => { permissions++; return "granted"; } };
  define(window.navigator, "serviceWorker", { getRegistration: async () => worker }); define(window, "PushManager", {}); define(window, "Notification", notification); define(window, "isSecureContext", true); define(globalThis, "Notification", notification);
  try {
    const server = fakeServer(async () => { throw new Error("unexpected message write"); });
    await mount("/settings", <PushSettings />); await unlock(); await changeLocale("ja");
    expect(permissions).toBe(0); expect(allocations).toBe(0); expect(server.enrollments()).toBe(0);
    expect(container.textContent).toContain("Homeling の通知");
    expect(container.textContent).toContain("Homeling をロック");
    const enable = [...container.querySelectorAll("button")].find(item => item.textContent === "許可して登録")!;
    await act(async () => enable.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event));
    expect(permissions).toBe(1); expect(allocations).toBe(1); expect(server.enrollments()).toBe(1);
    expect(server.remoteLocale()).toBe("ja"); expect(server.localeWrites()).toBe(0);
    expect(container.textContent).toContain("このデバイスは登録済みです");
  } finally {
    for (const [id, descriptor] of descriptors) { const [scope, key] = id.split(":"); const object = scope === "window" ? window : scope === "navigator" ? window.navigator : globalThis; if (descriptor) Object.defineProperty(object, key!, descriptor); else Reflect.deleteProperty(object, key!); }
  }
});
test("real locked settings persist locally, show unsynced, and unlock never replays a native preference update", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(window.navigator, "serviceWorker");
  let allocations = 0;
  const worker = { scope: `${window.location.origin}/lite/`, active: {}, pushManager: { getSubscription: async () => ({ endpoint: "https://fcm.googleapis.com/fcm/send/existing" }), subscribe: async () => { allocations++; throw new Error("must not allocate"); } } };
  Object.defineProperty(window.navigator, "serviceWorker", { configurable: true, value: { getRegistration: async () => worker } });
  try {
    const server = fakeServer(async () => { throw new Error("unexpected message write"); });
    await mount("/settings");
    const select = container.querySelector<HTMLSelectElement>("#homeling-locked-language")!;
    await act(async () => { select.value = "de"; select.dispatchEvent(new window.Event("change", { bubbles: true }) as unknown as Event); });
    expect(window.localStorage.getItem("homeling.locale")).toBe("de");
    expect(container.textContent).toContain("ausdrücklich erneut synchronisieren");
    expect(server.localeWrites()).toBe(0);
    await unlock();
    expect(server.localeWrites()).toBe(0);
    const retry = container.querySelector<HTMLButtonElement>("button[data-locale-sync]")!;
    expect(retry.disabled).toBe(false);
    await act(async () => retry.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event));
    expect(server.localeWrites()).toBe(1); expect(server.remoteLocale()).toBe("de"); expect(allocations).toBe(0);
    expect(container.textContent).toContain("ist synchronisiert");
  } finally { if (descriptor) Object.defineProperty(window.navigator, "serviceWorker", descriptor); else Reflect.deleteProperty(window.navigator, "serviceWorker"); }
});
test("production conversation shell and its launch confirmation change locale without dispatching a task", async () => {
  let writes = 0;
  fakeServer(async () => { writes++; return Response.json({ ok: true }); });
  await mount(); await unlock(); await changeLocale("de");
  expect(container.textContent).toContain("Aufgabe starten");
  expect(container.textContent).toContain("Verlaufabfrage");
  expect(container.querySelector('a[href="/"]')?.textContent).toBe("Zurück zu Homelings");
  expect(container.querySelector("[data-location]")?.textContent).toBe("/p/p1");
  expect(writes).toBe(0);
});
test("production task metadata and mirror controls change locale without translating terminal output", async () => {
  fakeServer(async () => { throw new Error("unexpected business write"); });
  await mount("/t/p1"); await unlock();
  await act(async () => [...container.querySelectorAll("button")].find((item) => item.textContent === "View raw pane output")!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }) as unknown as Event));
  await changeLocale("de");
  expect(container.textContent).toContain("Original-Pane ausblenden");
  expect(container.textContent).toContain("Aufgabe p1");
  expect(container.querySelector('[data-testid="pane-mirror"]')?.textContent).toBe("Original terminal output 原文");
  expect(container.querySelector("[data-location]")?.textContent).toBe("/t/p1");
});
test("locked language control changes only local copy and does not unlock or write a session", async () => {
  const server = fakeServer(async () => { throw new Error("unexpected business write"); });
  await mount("/settings");
  const dialog = container.querySelector<HTMLDialogElement>('dialog[aria-labelledby="homeling-lock-title"]')!;
  expect(dialog.open).toBe(true);
  const select = dialog.querySelector<HTMLSelectElement>("#homeling-locked-language")!;
  await act(async () => { select.value = "es"; select.dispatchEvent(new window.Event("change", { bubbles: true }) as unknown as Event); });
  expect(dialog.querySelector("h1")?.textContent).toBe("Homeling está bloqueado");
  expect(dialog.open).toBe(true);
  expect(server.sessionWrites()).toBe(0);
  expect(container.querySelectorAll("#homeling-language").length).toBe(1);
  expect(container.querySelectorAll("#homeling-locked-language").length).toBe(1);
});
test("production settings selector persists after root remount and retains lock and extension controls", async () => {
  fakeServer(async () => { throw new Error("unexpected business write"); });
  await mount("/settings"); await unlock();
  const extension = container.querySelector("[data-other-settings]");
  expect(container.textContent).toContain("Lock Homeling");
  await changeLocale("ko");
  expect(container.querySelector("[data-other-settings]")).toBe(extension);
  expect(container.querySelector("h1")?.textContent).toBe("설정");
  await act(() => root.unmount()); container.remove();
  await mount("/settings"); await unlock();
  expect(container.querySelector("select")?.value).toBe("ko");
  expect(container.querySelector("h1")?.textContent).toBe("설정");
});
test("production root retains its real draft and route across locale and session lock changes", async () => {
  let writes = 0;
  fakeServer(async () => { writes++; return Response.json({ ok: true }); });
  await mount(); await unlock();
  const textarea = container.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "My original draft 请继续");
    textarea.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
  });
  await changeLocale("ja");
  expect(container.querySelector("textarea")).toBe(textarea);
  expect(textarea.value).toBe("My original draft 请继续");
  await act(() => sessionState.lock());
  await changeLocale("de");
  expect(container.querySelector("#homeling-lock-title")?.textContent).toBe("Dieser Browser ist blockiert");
  expect(container.textContent).toContain("Serversperre nicht bestätigt");
  expect(textarea.value).toBe("My original draft 请继续");
  await unlock();
  expect(container.querySelector("textarea")).toBe(textarea);
  expect(textarea.value).toBe("My original draft 请继续");
  expect(container.querySelector("[data-location]")?.textContent).toBe("/p/p1");
  expect(writes).toBe(0);
});
test("production root keeps an uncertain send blocked across locale changes and unlock, without replay", async () => {
  let writes = 0;
  fakeServer(async () => { writes++; return Response.json({ ok: false, deliveryUnknown: true, error: "unknown write" }, { status: 503 }); });
  await mount(); await unlock();
  const textarea = container.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Do not translate this outgoing text");
    textarea.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
  });
  await act(async () => textarea.closest("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
  expect(writes).toBe(1);
  expect(textarea.disabled).toBe(true);
  await changeLocale("zh");
  expect(container.textContent).toContain("Do not translate this outgoing text");
  expect(container.querySelector("textarea")).toBe(textarea);
  expect(textarea.disabled).toBe(true);
  await act(() => sessionState.lock()); await unlock(); await changeLocale("es");
  expect(writes).toBe(1);
  expect(textarea.disabled).toBe(true);
  expect(container.querySelector("[data-location]")?.textContent).toBe("/p/p1");
});
