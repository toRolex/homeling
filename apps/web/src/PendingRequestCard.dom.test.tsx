import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { PendingRequest } from "@homeling/contracts";
import { PendingRequestCard } from "./PendingRequestCard.tsx";
import { approvePendingRequest } from "./api.ts";
import { sessionState } from "./session-state.ts";

const window = new Window();
const saved = new Map<string, PropertyDescriptor | undefined>();
const originalFetch = globalThis.fetch;
let root: Root | undefined;
let container: HTMLElement;
let createRoot: typeof import("react-dom/client").createRoot;
beforeAll(async () => {
  for (const [key, value] of Object.entries({ window, document: window.document, navigator: window.navigator, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  ({ createRoot } = await import("react-dom/client"));
});
afterEach(async () => { if (root) await act(() => root!.unmount()); root = undefined; container?.remove(); globalThis.fetch = originalFetch; sessionState.lock(); });
afterAll(() => { for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } window.close(); });

test("the free text card posts the typed answer and occurrence through the real API client once", async () => {
  const request: PendingRequest = { id: "cooperation:answer", paneId: "p", taskOccurrenceKey: "run", createdAt: "2026-10-27T00:00:00Z", status: "pending", kind: "prompt-select", payload: {
    question: "Which report?", options: [{ id: "report", label: "Default report" }], collaboration: { freeText: true, details: ["Output requirements"] },
  } };
  const posts: unknown[] = [];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    posts.push({ url: String(url), method: init?.method, body: JSON.parse(String(init?.body)) });
    return Response.json({ status: "resolved", outcome: "submitted" });
  }) as typeof fetch;
  sessionState.apply({ locked: false, epoch: 1, generation: "cooperation-ui" }); sessionState.caughtUp();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(<PendingRequestCard request={request} onApprove={(id, option, freeText) => approvePendingRequest(id, option, request.taskOccurrenceKey, freeText)} />));
  expect(container.querySelector("details")?.textContent).toContain("Output requirements");
  const textarea = container.querySelector("textarea")!;
  const send = [...container.querySelectorAll("button")].find(button => button.textContent === "Send")!;
  expect(send.disabled).toBe(true);
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Plain text report");
    textarea.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
  });
  expect(send.disabled).toBe(false);
  await act(async () => send.click());
  await act(async () => send.click());
  expect(posts).toEqual([{ url: "/lite/api/requests/cooperation%3Aanswer/approve", method: "POST", body: { optionId: "__free_text__", occurrenceKey: "run", freeText: "Plain text report" } }]);
  expect(container.textContent).toContain("Handled");
});

for (const state of ["pending", "running", "unknown"] as const) {
  test(`saved reply exposes failed dispatch; inspected ${state} stage gates explicit recovery`, async () => {
    const request: PendingRequest = { id: "cooperation:answer", paneId: "p", taskOccurrenceKey: "run", createdAt: "2026-10-27T00:00:00Z", status: "pending", kind: "prompt-select", payload: {
      question: "Approve?", options: [{ id: "approve", label: "Approve" }], collaboration: { freeText: false, details: [] },
    } };
    const calls: string[] = [];
    let stage = state as string;
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = String(url); calls.push(`${init?.method ?? "GET"} ${path}`);
      if (path.endsWith("/approve")) return Response.json({ status: "resolved", outcome: "submitted", dispatch: { dispatched: false, reason: "snapshot-unavailable" } });
      if (path.endsWith("/advance")) { stage = "running"; return Response.json({ dispatched: true, outcome: "submitted" }); }
      return Response.json({ task: { steps: [{ id: "prepare", status: stage }] } });
    }) as typeof fetch;
    sessionState.apply({ locked: false, epoch: 1, generation: "cooperation-ui" }); sessionState.caughtUp();
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root!.render(<PendingRequestCard request={request} onApprove={(id, option) => approvePendingRequest(id, option, request.taskOccurrenceKey)} />));
    const button = (label: string) => [...container.querySelectorAll("button")].find(item => item.textContent === label)!;
    await act(async () => button("Approve").click());
    expect(container.textContent).toContain("Reply saved; stage not dispatched");
    expect(container.textContent).toContain("snapshot-unavailable");
    expect(button("Approve").disabled).toBe(true);
    expect(calls).toHaveLength(1);
    await act(async () => button("Inspect stage state").click());
    expect(container.textContent).toContain(`prepare: ${state}`);
    const advance = button("Advance once (server checks apply)");
    expect(advance.disabled).toBe(state !== "pending");
    await act(async () => { advance.click(); advance.click(); });
    expect(calls.filter(call => call.includes("/advance"))).toHaveLength(state === "pending" ? 1 : 0);
    if (state === "pending") {
      expect(container.textContent).toContain("stage dispatched, not yet completed");
      expect(button("Advance once (server checks apply)").disabled).toBe(true);
    }
    expect(calls.filter(call => call.includes("/approve"))).toHaveLength(1);
  });
}

for (const failure of ["network", "locked"] as const) {
  test(`recovery ${failure} failure never resends the saved reply or automatically retries advance`, async () => {
    const request: PendingRequest = { id: "cooperation:answer", paneId: "p", taskOccurrenceKey: "run", createdAt: "2026-10-27T00:00:00Z", status: "pending", kind: "prompt-select", payload: {
      question: "Approve?", options: [{ id: "approve", label: "Approve" }], collaboration: { freeText: false, details: [] },
    } };
    let writes = 0;
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      if (String(url).endsWith("/approve")) return Response.json({ status: "resolved", outcome: "submitted", dispatch: { dispatched: false, outcome: "unknown" } });
      if (String(url).endsWith("/advance")) {
        writes++;
        if (failure === "network") throw new Error("lost response");
        return Response.json({ executed: false, deliveryUnknown: false }, { status: 423 });
      }
      return Response.json({ task: { steps: [{ id: "prepare", status: "pending" }] } });
    }) as typeof fetch;
    sessionState.apply({ locked: false, epoch: 1, generation: "cooperation-ui" }); sessionState.caughtUp();
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root!.render(<PendingRequestCard request={request} onApprove={(id, option) => approvePendingRequest(id, option, "run")} />));
    const button = (label: string) => [...container.querySelectorAll("button")].find(item => item.textContent === label)!;
    await act(async () => button("Approve").click());
    expect(container.textContent).toContain("stage delivery unconfirmed");
    await act(async () => button("Inspect stage state").click());
    await act(async () => button("Advance once (server checks apply)").click());
    expect(writes).toBe(1);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("could not be confirmed");
    expect(container.textContent).not.toContain("Advance once");
    expect(button("Approve").disabled).toBe(true);
    if (failure === "locked") expect(sessionState.get().ready).toBe(false);
  });
}

test("successful dispatch acknowledgement is shown separately from task completion", async () => {
  const request: PendingRequest = { id: "cooperation:answer", paneId: "p", taskOccurrenceKey: "run", createdAt: "2026-10-27T00:00:00Z", status: "pending", kind: "prompt-select", payload: {
    question: "Approve?", options: [{ id: "approve", label: "Approve" }], collaboration: { freeText: false, details: [] },
  } };
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(<PendingRequestCard request={request} onApprove={async () => ({ status: "resolved", outcome: "submitted", dispatch: { dispatched: true, outcome: "submitted" } })} />));
  await act(async () => container.querySelector("button")!.click());
  expect(container.textContent).toContain("Reply saved; stage dispatched, not yet completed.");
});
