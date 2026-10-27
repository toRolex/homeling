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
