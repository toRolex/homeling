import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Root } from "react-dom/client";
import { SessionBoundary, SessionLockButton } from "./SessionBoundary.tsx";
import { sessionState } from "./session-state.ts";

const window = new Window({ url: "https://homeling.test/lite/" });
const originals = new Map<string, PropertyDescriptor | undefined>();
const originalFetch = globalThis.fetch;
let createRoot: typeof import("react-dom/client").createRoot;
let root: Root;
let container: HTMLElement;
beforeAll(async () => {
  for (const [key, value] of Object.entries({ window, document: window.document, navigator: window.navigator, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  ({ createRoot } = await import("react-dom/client"));
});
afterEach(async () => {
  if (root) await act(() => root.unmount());
  container?.remove();
  globalThis.fetch = originalFetch;
  sessionState.lock();
});
afterAll(() => {
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  window.close();
});

async function mount() {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<><SessionLockButton /><SessionBoundary><section data-route="/persona/p1"><textarea defaultValue="keep my draft" /></section></SessionBoundary></>));
}

function metadata(locked: boolean) {
  return Response.json({ mode: "tailscale-identity", locked, available: true, ...(locked ? {} : { epoch: 1, idleDeadline: Date.now() + 60_000, absoluteDeadline: Date.now() + 600_000 }), generation: "identity-boot", serverNow: Date.now() });
}

test("locked UI masks but retains the mounted application and draft instead of replacing its route", () => {
  sessionState.apply({ locked: true, mode: "local-unlock" });
  const markup = renderToStaticMarkup(<SessionBoundary><section data-route="/persona/p1"><textarea defaultValue="keep my draft" /></section></SessionBoundary>);
  expect(markup).toContain('inert=""');
  expect(markup).toContain('data-route="/persona/p1"');
  expect(markup).toContain("keep my draft");
  expect(markup).toContain("<dialog");
  expect(markup).toContain('type="password"');
  expect(markup).not.toContain("localStorage");
});

test("local mode cold reload retains manual unlock when the server cookie is already valid", async () => {
  let writes = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") writes++;
    return Response.json({ mode: "local-unlock", locked: false, available: true, epoch: 1, generation: "local-boot", serverNow: Date.now(), idleDeadline: Date.now() + 60_000, absoluteDeadline: Date.now() + 600_000 });
  }) as unknown as typeof fetch;
  sessionState.apply({ locked: true });
  await mount();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(sessionState.get()).toMatchObject({ mode: "local-unlock", locked: true, lockConfirmed: false, ready: false });
  expect(container.querySelector('input[type="password"]')).not.toBeNull();
  expect(container.textContent).toContain("unlock-secret");
  expect(writes).toBe(0);
});

test("identity mode establishes once, confirms the browser cookie, catches up before ready, and hides password controls", async () => {
  let established = false;
  let posts = 0;
  let businessWrites = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/session/establish")) { posts++; expect(init?.body).toBe("{}"); established = true; return metadata(false); }
    if (url.endsWith("/session")) return metadata(!established);
    if (["/persona/list", "/snapshot", "/requests"].some((path) => url.endsWith(path))) return url.endsWith("/persona/list") ? Response.json({ personas: [] }) : Response.json([]);
    businessWrites++;
    throw new Error(`Unexpected request ${url}`);
  }) as unknown as typeof fetch;
  sessionState.apply({ locked: true, mode: "local-unlock" });
  await mount();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(posts).toBe(1);
  expect(established).toBe(true);
  expect(sessionState.get()).toMatchObject({ mode: "tailscale-identity", locked: false, ready: true, epoch: 1 });
  expect(container.querySelector('input[type="password"]')).toBeNull();
  expect(container.textContent).not.toContain("unlock-secret");
  expect([...container.querySelectorAll("button")].some((button) => button.textContent === "Lock Homeling")).toBe(false);
  expect(businessWrites).toBe(0);
});

test("identity protocol failures stay masked, show localized status, and never expose parser bodies", async () => {
  const rawBody = "<html>private proxy detail</html>";
  globalThis.fetch = (async () => new Response(rawBody, { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
  sessionState.apply({ locked: true });
  await mount();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(sessionState.get().locked).toBe(true);
  expect(container.querySelector('input[type="password"]')).toBeNull();
  expect(container.textContent).toContain("session response was not valid");
  expect(container.textContent).not.toContain(rawBody);
  expect(container.textContent).not.toContain("password");
});

test("a missing cookie stops automatic establish retries while keeping the draft masked", async () => {
  let posts = 0;
  let tick: (() => void) | undefined;
  const originalInterval = window.setInterval;
  window.setInterval = ((callback: () => void) => { tick = callback; return 1; }) as unknown as typeof window.setInterval;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/establish")) { posts++; return metadata(false); }
    return metadata(true);
  }) as unknown as typeof fetch;
  sessionState.apply({ locked: true });
  try {
    await mount();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(posts).toBe(1);
    expect(sessionState.get().ready).toBe(false);
    expect(container.textContent).toContain("could not keep the secure session");
    for (let i = 0; i < 3; i++) await act(async () => { tick?.(); });
    expect(posts).toBe(1);
    expect(container.querySelector("textarea")?.value).toBe("keep my draft");
  } finally { window.setInterval = originalInterval; }
});

test("invalid session responses fail closed without bootstrap or raw parser text", async () => {
  const cases = [
    () => new Response("", { headers: { "content-type": "application/json" } }),
    () => new Response("{broken", { headers: { "content-type": "application/json" } }),
    () => Response.json({ mode: "unknown", locked: true }),
    () => Response.json({ mode: "tailscale-identity", locked: false, available: true }),
    () => { const response = metadata(true); Object.defineProperty(response, "redirected", { value: true }); return response; },
    ...[401, 403, 429, 503].map(status => () => Response.json({ code: "session.unavailable" }, { status })),
  ];
  for (const response of cases) {
    let writes = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => { if (init?.method === "POST") writes++; return response(); }) as unknown as typeof fetch;
    sessionState.apply({ locked: true });
    await mount();
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(sessionState.get().locked).toBe(true);
    expect(sessionState.get().ready).toBe(false);
    expect(writes).toBe(0);
    expect(container.querySelector('input[type="password"]') === null).toBe(true);
    expect(container.textContent).not.toContain("SyntaxError");
    await act(() => root.unmount()); container.remove();
  }
});
