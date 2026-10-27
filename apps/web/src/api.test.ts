import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PersonaAppearanceError, updatePersonaAppearance, createPersona, fetchLaunchers, fetchPaneScreen, fetchPersonas, launchTask, sendPaneReply, sendPersonaMessage, stopPaneTask, sendPaneControlKey, transcribeAudio, approvePendingRequest } from "./api.ts";

import { sessionState } from "./session-state.ts";
beforeEach(() => { sessionState.apply({ locked: false, epoch: 1, generation: "api-fixture" }); sessionState.caughtUp(); });
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; sessionState.lock(); });

test("customization sends only name/avatar PATCH and locked sessions dispatch nothing", async () => {
  const patch = { name: "Nova", avatar: { color: "#93c5fd", character: "curious", pet: "cat" } };
  let writes = 0;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    writes++;
    expect(String(url)).toBe("/lite/api/persona/mira%2Fone");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual(patch);
    return Response.json({ persona: { id: "mira/one", ...patch } });
  }) as typeof fetch;
  expect(await updatePersonaAppearance("mira/one", patch)).toMatchObject(patch);
  sessionState.lock();
  await expect(updatePersonaAppearance("mira/one", patch)).rejects.toThrow("Session not ready");
  expect(writes).toBe(1);
});

test("customization distinguishes pre-dispatch lock from an interrupted or malformed 423", async () => {
  const patch = { name: "Nova", avatar: { color: "#93c5fd" } };
  for (const [body, notDispatched] of [[{ executed: false, deliveryUnknown: false }, true], [{ executed: true, deliveryUnknown: true }, false], [{}, false]] as const) {
    sessionState.apply({ locked: false, epoch: 2, generation: "api-fixture" }); sessionState.caughtUp();
    globalThis.fetch = (async () => Response.json({ code: "session.locked", ...body }, { status: 423 })) as unknown as typeof fetch;
    try { await updatePersonaAppearance("mira", patch); throw new Error("expected failure"); }
    catch (error) { expect(error).toBeInstanceOf(PersonaAppearanceError); expect((error as PersonaAppearanceError).notDispatched).toBe(notDispatched); }
  }
});

describe("control key API", () => {
  test("423 is classified before generic not-submitted or executed-false branches", async () => {
    for (const [body, outcome] of [[{}, "unknown"], [{ executed: false }, "unknown"], [{ outcome: "not-submitted" }, "unknown"], [{ executed: false, deliveryUnknown: true, outcome: "not-submitted" }, "unknown"], [{ executed: false, deliveryUnknown: false }, "not-submitted"]] as const) {
      sessionState.apply({ locked: false, epoch: 4, generation: "api-fixture" }); sessionState.caughtUp();
      globalThis.fetch = (async () => Response.json(body, { status: 423 })) as unknown as typeof fetch;
      expect((await sendPaneControlKey("p1", "interrupt", "identity")).outcome).toBe(outcome);
    }
  });
  test("posts a confirmed semantic action rather than text or raw keys", async () => {
    let posted: unknown;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      posted = { url: String(input), body: JSON.parse(String(init?.body)) };
      return Response.json({ outcome: "accepted" });
    }) as typeof fetch;
    expect(await sendPaneControlKey("w1:p2", "escape", "identity")).toEqual({ outcome: "accepted" });
    expect(posted).toEqual({ url: "/lite/api/pane/w1%3Ap2/control-key", body: { action: "escape", identity: "identity", confirmed: true } });
  });
  test("network and malformed success are unknown; definite auth failure is not submitted; no retries", async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; throw new Error("lost"); }) as unknown as typeof fetch;
    expect((await sendPaneControlKey("p", "interrupt", "i")).outcome).toBe("unknown");
    expect(calls).toBe(1);
    globalThis.fetch = (async () => Response.json({ ok: true })) as unknown as typeof fetch;
    expect((await sendPaneControlKey("p", "interrupt", "i")).outcome).toBe("unknown");
    globalThis.fetch = (async () => new Response("identity required", { status: 401 })) as unknown as typeof fetch;
    expect((await sendPaneControlKey("p", "interrupt", "i")).outcome).toBe("not-submitted");
  });
});

describe("STT API", () => {
  test("uploads raw recorder bytes with cancellation and returns text without a reply call", async () => {
    const audio = new Blob(["clip"], { type: "audio/mp4" });
    const controller = new AbortController();
    const urls: string[] = [];
    globalThis.fetch = (async (input, init) => {
      urls.push(String(input));
      expect(init?.body).toBe(audio);
      expect(new Headers(init?.headers).get("content-type")).toBe("audio/mp4");
      expect(init?.signal).toBeDefined();
      controller.abort();
      expect(init?.signal?.aborted).toBe(true);
      return Response.json({ ok: true, text: "请继续" });
    }) as typeof fetch;
    await expect(transcribeAudio(audio, controller.signal)).resolves.toBe("请继续");
    expect(urls).toEqual(["/lite/api/stt"]);
  });
});

describe("task launch API", () => {
  test("a malformed 423 never proves that a reply, approval or control key was not dispatched", async () => {
    const reset = () => { sessionState.apply({ locked: false, epoch: 3, generation: "api-fixture" }); sessionState.caughtUp(); };
    globalThis.fetch = (async () => Response.json({}, { status: 423 })) as unknown as typeof fetch;
    await expect(sendPaneReply("p1", "hello")).rejects.toMatchObject({ textDelivered: null });
    reset(); expect(await approvePendingRequest("r1", "1")).toMatchObject({ outcome: "unknown" });
    reset(); expect(await sendPaneControlKey("p1", "interrupt", "identity")).toMatchObject({ outcome: "unknown" });
  });
  test("a 423 interrupted reply remains unknown even though it is a client-error status", async () => {
    globalThis.fetch = (async () => Response.json({ ok: false, code: "session.interrupted", deliveryUnknown: true, textDelivered: null }, { status: 423 })) as unknown as typeof fetch;
    await expect(sendPaneReply("p1", "hello")).rejects.toMatchObject({ textDelivered: null });
    expect(sessionState.get().locked).toBe(true);
  });
  test("reads launcher rows and posts only the selected allowlist command", async () => {
    const requests: Array<{ url: string; method: string; body?: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), method: init?.method ?? "GET", body: init?.body?.toString() });
      return init?.method === "POST"
        ? Response.json({ ok: true, pane: { paneId: "w2:p1", workspaceId: "w2", workspaceLabel: "Repo", tabId: "w2:t1", cwd: "/repo" } })
        : Response.json({ launchers: [{ command: "bun test", label: "Test", cwd: "/repo" }], home: "/home/test" });
    }) as unknown as typeof fetch;

    const launchers = await fetchLaunchers();
    const result = await launchTask(launchers.launchers[0]!, "w1:p2");
    expect(requests).toEqual([
      { url: "/lite/api/launchers", method: "GET", body: undefined },
      { url: "/lite/api/launch", method: "POST", body: '{"command":"bun test","paneId":"w1:p2"}' },
    ]);
    expect(result.pane.paneId).toBe("w2:p1");
  });

  test("sends persona-owned tasks to the daemon with an explicit persona id", async () => {
    let body = "";
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = String(init?.body);
      return Response.json({ ok: true, pane: { paneId: "w1:p2", workspaceId: "w1", workspaceLabel: "Mira", tabId: "w1:t2", cwd: "/repo" } });
    }) as unknown as typeof fetch;
    await launchTask({ command: "bun test", label: "Test" }, undefined, "persona-1");
    expect(body).toBe('{"command":"bun test","personaId":"persona-1"}');
  });

  test("surfaces bridge allowlist failure rather than reporting a task", async () => {
    globalThis.fetch = (async () => Response.json(
      { ok: false, error: "Command is not allowlisted", code: "launch.not_allowlisted" },
      { status: 400 },
    )) as unknown as typeof fetch;
    await expect(launchTask({ command: "not allowed", label: "No" })).rejects.toMatchObject({
      message: "Command is not allowlisted",
      code: "launch.not_allowlisted",
    });
  });
});

describe("persona API", () => {
  test("retains transcript confirmation text on partial persona message delivery", async () => {
    const confirmationText = "[Persona instructions]\\nBe concise\\n[End persona instructions]\\n\\nhello";
    globalThis.fetch = (async () => Response.json({
      ok: false, error: "submit failed", textDelivered: true, personaConfirmationText: confirmationText,
    }, { status: 502 })) as unknown as typeof fetch;
    await expect(sendPersonaMessage("persona-1", "hello")).rejects.toMatchObject({ textDelivered: true, confirmationText });
  });

  test("loads, creates, and messages personas through the daemon API", async () => {
    const requests: Array<{ url: string; method: string; body?: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), method: init?.method ?? "GET", body: init?.body?.toString() });
      if (String(input).endsWith("/persona/list")) return Response.json({ personas: [] });
      if (String(input).endsWith("/persona")) return Response.json({ persona: {
        id: "persona-1", name: "Mira", avatar: { color: "#86efac" }, spaceId: "w1", mainPaneId: "w1:p1",
        systemPrompt: "", createdAt: "2026-10-08T00:00:00Z", status: "active",
      } }, { status: 201 });
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;

    expect(await fetchPersonas()).toEqual({ personas: [] });
    await expect(createPersona({ name: "Mira", avatar: { color: "#86efac" } })).resolves.toMatchObject({ id: "persona-1" });
    await sendPersonaMessage("persona-1", "hello");
    expect(requests).toEqual([
      { url: "/lite/api/persona/list", method: "GET", body: undefined },
      { url: "/lite/api/persona", method: "POST", body: '{"name":"Mira","avatar":{"color":"#86efac"}}' },
      { url: "/lite/api/persona/persona-1/message", method: "POST", body: '{"text":"hello"}' },
    ]);
  });
});

describe("task detail APIs", () => {
  test("reads the current pane screen over the same-origin daemon API", async () => {
    let url = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      url = String(input);
      return Response.json({ paneId: "w1:p2", text: "screen", truncated: false });
    }) as unknown as typeof fetch;
    await expect(fetchPaneScreen("w1:p2")).resolves.toMatchObject({ text: "screen" });
    expect(url).toBe("/lite/api/pane/w1%3Ap2");
  });

  test("posts a semantic stop request without accepting caller-supplied keys", async () => {
    const requests: Array<{ url: string; method: string; body: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), method: init?.method ?? "", body: String(init?.body) });
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;
    await stopPaneTask("w1:p2");
    expect(requests).toEqual([{ url: "/lite/api/pane/w1%3Ap2/stop", method: "POST", body: "{}" }]);
  });
});

describe("sendPaneReply", () => {
  test("posts Collie's reply request shape and accepts its ActionResponse", async () => {
    const requests: Array<{ url: string; method: string; body: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), method: init?.method ?? "", body: String(init?.body) });
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;

    await sendPaneReply("w1:p2", "hello");
    expect(requests).toEqual([{
      url: "/lite/api/pane/w1%3Ap2/reply", method: "POST", body: '{"text":"hello","submit":true}',
    }]);
  });

  test("treats a definite daemon-side 403 as not delivered", async () => {
    globalThis.fetch = (async () => new Response("cross-origin rejected", { status: 403 })) as unknown as typeof fetch;
    await expect(sendPaneReply("p1", "hello")).rejects.toMatchObject({ textDelivered: false });
  });

  test("preserves Collie's partial text delivery signal for safe retry", async () => {
    globalThis.fetch = (async () => Response.json(
      { ok: false, error: "submit failed", textDelivered: true }, { status: 502 },
    )) as unknown as typeof fetch;
    await expect(sendPaneReply("p1", "hello")).rejects.toMatchObject({ textDelivered: true });
  });
});
