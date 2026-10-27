import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { MemoryRouter, useNavigate, type NavigateFunction } from "react-router";
import type { Root } from "react-dom/client";
import { AppRoot } from "./AppRoot.tsx";
import { LocaleProvider } from "./locale.tsx";
import { PersonaMemoryEditor } from "./PersonaMemoryEditor.tsx";
import { SessionLockButton } from "./SessionBoundary.tsx";
import { sessionState } from "./session-state.ts";

const window = new Window({ url: "https://homeling.test/lite/persona/mira/memory" });
const globals = new Map<string, PropertyDescriptor | undefined>();
const originalFetch = globalThis.fetch;
let root: Root;
let container: HTMLElement;
let createRoot: typeof import("react-dom/client").createRoot;
let navigate: NavigateFunction;
function RouterControl() { navigate = useNavigate(); return null; }
beforeAll(async () => {
  for (const [key, value] of Object.entries({ window, document: window.document, navigator: window.navigator, HTMLElement: window.HTMLElement, ResizeObserver: window.ResizeObserver, MutationObserver: window.MutationObserver, requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window), IS_REACT_ACT_ENVIRONMENT: true })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  ({ createRoot } = await import("react-dom/client"));
});
afterEach(async () => {
  if (root) await act(() => root.unmount());
  container?.remove(); globalThis.fetch = originalFetch; sessionState.lock();
});
afterAll(() => {
  for (const [key, descriptor] of globals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  window.close();
});
const persona = { id: "mira", name: "Mira", avatar: { color: "#86efac" }, spaceId: "space", mainPaneId: "pane", systemPrompt: "", createdAt: "2026-10-09", status: "idle" };

function fakeServer(firstIdleMs = 700) {
  let locked = true, epoch = 0, deadline = 0, writes = 0, unlocks = 0;
  let mainPaneId = persona.mainPaneId;
  let businessAttempts = 0;
  const secret = "x".repeat(43); // Fake fixture only, never real credentials.
  const documents = { facts: { content: "Original fact", revision: "facts-0" }, preferences: { content: "Short replies", revision: "preferences-0" }, project: { content: "Garden", revision: "project-0" } };
  const view = () => ({ documents, effective: "next-session", injection: { strategy: "first-message-prefix", unsupported: true, notice: "unsupported native injection; first-message prefix only, edits apply next session." } });
  const state = () => ({ mode: "local-unlock", locked: locked || Date.now() >= deadline, available: true, epoch, generation: "root-memory-fixture", serverNow: Date.now(), ...(deadline ? { idleDeadline: deadline, absoluteDeadline: deadline + 60_000 } : {}) });
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const pathname = new URL(String(input), "https://homeling.test").pathname;
    if (init?.method && !["GET", "HEAD"].includes(init.method) && !pathname.startsWith("/lite/api/session")) businessAttempts++;
    if (pathname === "/lite/api/session/unlock") {
      if (JSON.parse(String(init?.body)).secret !== secret) return Response.json({ locked: true }, { status: 401 });
      locked = false; epoch++; unlocks++; deadline = Date.now() + (unlocks === 1 ? firstIdleMs : 10_000);
      return Response.json(state());
    }
    if (pathname === "/lite/api/session/lock") { locked = true; return Response.json(state()); }
    if (pathname === "/lite/api/session") return Response.json(state());
    if (pathname === "/lite/api/persona/list") return Response.json({ personas: [{ ...persona, mainPaneId }] });
    if (pathname === "/lite/api/snapshot") return Response.json({ bridge: "connected", agents: [], shellPanes: [] });
    if (pathname === "/lite/api/requests") return Response.json([]);
    if (pathname === "/lite/api/launchers") return Response.json({ launchers: [], home: "/fixture" });
    if (/^\/lite\/api\/pane\/[^/]+\/history$/.test(pathname)) return Response.json({ available: true, paneId: mainPaneId, entries: [], hasMore: false });
    if (pathname === "/lite/api/persona/mira/memory") {
      if (init?.method === "PUT") {
        writes++;
        if (state().locked) return Response.json({ code: "session.locked", executed: false }, { status: 423 });
        const update = JSON.parse(String(init.body)) as { kind: keyof typeof documents; content: string; revision: string };
        if (documents[update.kind].revision !== update.revision) return Response.json({ code: "memory.conflict" }, { status: 409 });
        documents[update.kind] = { content: update.content, revision: `${update.kind}-${writes}` };
      }
      return Response.json(view());
    }
    return new Response("unexpected fake route", { status: 404 });
  };
  return { fetcher, secret, documents, writes: () => writes, unlocks: () => unlocks, deadline: () => deadline, businessAttempts: () => businessAttempts, replaceMainPane(id: string) { mainPaneId = id; } };
}
function lockDialog() { return container.querySelector<HTMLDialogElement>('dialog[aria-labelledby="homeling-lock-title"]')!; }
async function unlock(secret: string) {
  await act(async () => {
    const input = lockDialog().querySelector<HTMLInputElement>('input[type="password"]')!;
    input.value = secret;
    lockDialog().querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
  });
}
function facts() { return container.querySelector<HTMLTextAreaElement>('form[data-kind="facts"] textarea')!; }
async function editFacts(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(facts(), value);
    facts().dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
  });
}
async function saveFacts() {
  await act(async () => { container.querySelector('form[data-kind="facts"]')!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event); });
}

test("a persona conversation keeps its draft through lock and main-pane replacement without replaying a write", async () => {
  sessionState.lock();
  const server = fakeServer(10_000); globalThis.fetch = server.fetcher as typeof fetch;
  window.localStorage.setItem("homeling.locale", "en");
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<LocaleProvider><MemoryRouter initialEntries={["/persona/mira"]}><SessionLockButton /><AppRoot /></MemoryRouter></LocaleProvider>));
  await unlock(server.secret);
  await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 100)); });
  const input = container.querySelector<HTMLTextAreaElement>("#reply-draft")!;
  expect(input).not.toBeNull();
  const draft = "Keep this draft, never send it automatically";
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(input, draft);
    input.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
  });
  expect(input.value).toBe(draft);
  await act(async () => { [...container.querySelectorAll("button")].find(button => button.textContent === "Lock Homeling")!.click(); });
  expect(lockDialog().open).toBe(true);
  server.replaceMainPane("recovered-pane");
  await unlock(server.secret);
  await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 3_100)); });
  expect(lockDialog().open).toBe(false);
  expect(container.querySelector<HTMLTextAreaElement>("#reply-draft")!.value).toBe(draft);
  expect(server.writes()).toBe(0);
  expect(server.businessAttempts()).toBe(0);
});

test("actual AppRoot with locale and production memory transport unlocks, saves, preserves a locked draft and never replays on unlock", async () => {
  sessionState.lock(); // Start locked, never manufacture an unlocked client fixture.
  const server = fakeServer();
  globalThis.fetch = server.fetcher as typeof fetch;
  window.localStorage.setItem("homeling.locale", "en");
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<LocaleProvider><MemoryRouter initialEntries={["/persona/mira/memory"]}><RouterControl /><AppRoot slots={{ memory: id => <PersonaMemoryEditor personaId={id} /> }} /></MemoryRouter></LocaleProvider>));
  expect(lockDialog().open).toBe(true); expect(server.writes()).toBe(0);
  await unlock(server.secret);
  expect(lockDialog().open).toBe(false); expect(sessionState.get().ready).toBe(true);
  expect(facts().value).toBe("Original fact");
  expect(container.textContent).toContain("unsupported");
  await editFacts("Saved through actual root"); await saveFacts();
  expect(server.documents.facts.content).toBe("Saved through actual root"); expect(server.writes()).toBe(1);
  const draft = "保留草稿 <script>我自己输入</script>";
  await editFacts(draft);
  await act(async () => { await new Promise(resolve => window.setTimeout(resolve, Math.max(0, server.deadline() - Date.now()) + 100)); });
  expect(lockDialog().open).toBe(true);
  expect(facts().value).toBe(draft);
  // A synthetic submit cannot bypass the real client epoch gate, even though the form stays mounted.
  await saveFacts();
  expect(server.writes()).toBe(1); expect(facts().value).toBe(draft);
  await unlock(server.secret);
  expect(server.unlocks()).toBe(2); expect(lockDialog().open).toBe(false);
  expect(server.writes()).toBe(1); expect(facts().value).toBe(draft);
  await act(async () => container.querySelector<HTMLButtonElement>('button[data-reload]')!.click());
  expect(facts().value).toBe(draft); expect(server.writes()).toBe(1);
  await saveFacts();
  expect(server.documents.facts.content).toBe(draft); expect(server.writes()).toBe(2);
  expect(container.querySelector("script")).toBeNull();
  await act(async () => navigate("/settings"));
  expect(container.textContent).toContain("Lock Homeling");
  await act(async () => {
    const language = container.querySelector<HTMLSelectElement>("#homeling-language")!;
    language.value = "ja"; language.dispatchEvent(new window.Event("change", { bubbles: true }) as unknown as Event);
  });
  expect(document.documentElement.lang).toBe("ja");
  await act(async () => navigate("/persona/mira/memory"));
  expect(facts().value).toBe(draft); expect(server.writes()).toBe(2);
});
