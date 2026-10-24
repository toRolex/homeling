import { expect, test } from "bun:test";
import { createECDH } from "node:crypto";
import { mkdtemp, realpath, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PushStore, emptyPushState } from "./push-store.ts";
import { handlePushRequest } from "./push-api.ts";
import { SessionLock } from "./session-lock.ts";
import { SessionController } from "./session-controller.ts";
import { daemonConfigFromEnv } from "./config.ts";
import { handleRequest } from "./index.ts";
import { createPushOutput, sendPushTest } from "./push-output.ts";
import { createDaemonSystemAdmissions } from "./system-admission.ts";
import type { PushPayload } from "@homeling/contracts";

function subscription(suffix = "locale") {
  const ecdh = createECDH("prime256v1"); ecdh.generateKeys();
  return { endpoint: `https://fcm.googleapis.com/fcm/send/${suffix}`, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: Buffer.alloc(16).toString("base64url") } };
}
function request(action: string, body: unknown) {
  return new Request(`https://home.example/lite/api/push/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
test("a locale edit between output read and claim uses the currently persisted subscription, not the stale snapshot", async () => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), "homeling-push-locale-claim-"));
  try {
    const store = new PushStore(join(dir, "push.json")); const lock = new SessionLock(); const { token } = lock.unlock("alice");
    const admission = lock.admission(lock.admit(token, "alice")); const caps = createDaemonSystemAdmissions(); const sub = subscription();
    const sent: PushPayload[] = [];
    const transport = { send: async (_sub: unknown, payload: PushPayload) => { sent.push(payload); return { status: "sent" as const }; } };
    const runtime = { store, publicKey: "public", transport };
    await handlePushRequest(request("subscribe", { ...sub, locale: "en" }), runtime, "alice", admission);
    const view = { load: async () => { const old = await store.load(); await handlePushRequest(request("locale", { endpoint: sub.endpoint, locale: "de" }), runtime, "alice", admission); return old; }, mutate: store.mutate.bind(store) };
    const output = createPushOutput({ store: view, transport, clock: { now: () => 123 }, admission: caps.pushDeliver, cleanupAdmission: caps.pushCleanup });
    await output.send({ version: 1, type: "notification", title: "Mira", body: "fallback", bodyTemplate: { key: "push.approval", params: { question: "Original" } }, tag: "same", url: "/lite/", occurrenceKey: "same" });
    expect(sent[0]?.body).toBe("Benötigt deine Zustimmung: Original");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("native output and explicit test sends render each subscription locale without changing identity or replaying after preference edits", async () => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), "homeling-push-locale-output-"));
  try {
    const store = new PushStore(join(dir, "push.json")); const lock = new SessionLock(); const { token } = lock.unlock("alice");
    const admission = lock.admission(lock.admit(token, "alice")); const caps = createDaemonSystemAdmissions();
    const sent: { endpoint: string; payload: PushPayload }[] = [];
    const transport = { send: async (sub: { endpoint: string }, payload: PushPayload) => { sent.push({ endpoint: sub.endpoint, payload }); return { status: "sent" as const }; } };
    const runtime = { store, publicKey: "public", transport };
    const de = subscription("de"), ja = subscription("ja");
    await handlePushRequest(request("subscribe", { ...de, locale: "de" }), runtime, "alice", admission);
    await handlePushRequest(request("subscribe", { ...ja, locale: "ja" }), runtime, "alice", admission);
    const output = createPushOutput({ store, transport, clock: { now: () => 123 }, admission: caps.pushDeliver, cleanupAdmission: caps.pushCleanup });
    const question = "Original question $& {question} 原文";
    const payload: PushPayload = { version: 1, type: "notification", title: "Mira 原名", body: "legacy body", bodyTemplate: { key: "push.approval", params: { question } }, tag: "same-tag", url: "/lite/persona/mira", occurrenceKey: "same-occurrence" };
    await output.send(payload);
    expect(sent.find(item => item.endpoint === de.endpoint)?.payload.body).toBe(`Benötigt deine Zustimmung: ${question}`);
    expect(sent.find(item => item.endpoint === ja.endpoint)?.payload.body).toBe(`承認が必要です：${question}`);
    expect(sent.every(item => item.payload.title === "Mira 原名" && item.payload.tag === "same-tag" && item.payload.occurrenceKey === "same-occurrence" && item.payload.url === "/lite/persona/mira")).toBe(true);
    await handlePushRequest(request("locale", { endpoint: de.endpoint, locale: "ko" }), runtime, "alice", admission);
    expect(sent).toHaveLength(2);
    expect((await output.send(payload)).suppressed).toBe(2);
    expect(sent).toHaveLength(2);
    await sendPushTest(store, transport, de.endpoint, "alice", admission);
    expect(sent.at(-1)?.payload.body).toContain("알림이 연결되었습니다");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("actual HTTP locale entry reuses Origin, JSON and user-session admission without native sends", async () => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), "homeling-push-locale-http-"));
  try {
    const cfg = { ...daemonConfigFromEnv({}), tailscaleHost: "home.example", publicOrigin: "https://home.example", trustedUsers: ["alice"] };
    const sessions = new SessionController({ verify: () => secret => secret === "a".repeat(43) });
    let sends = 0;
    const runtime = { store: new PushStore(join(dir, "push.json")), publicKey: "public", transport: { send: async () => { sends++; return { status: "sent" as const }; } } };
    let sessionHeaders: Record<string, string> = {};
    const http = (path: string, body: unknown, cookie?: string, origin = "https://home.example", contentType = "application/json") => Object.assign(new Request(`https://home.example/lite/api/${path}`, { method: "POST", headers: { host: "home.example", "tailscale-user-login": "alice", origin, "content-type": contentType, ...(cookie ? { cookie, ...sessionHeaders } : {}) }, body: JSON.stringify(body) }), { remoteAddress: "127.0.0.1" });
    const sub = subscription(); const update = { endpoint: sub.endpoint, locale: "de" };
    expect((await handleRequest(http("push/locale", update), cfg, fetch, undefined, sessions, runtime)).status).toBe(423);
    expect((await handleRequest(http("push/locale", update, undefined, "https://evil.example"), cfg, fetch, undefined, sessions, runtime)).status).toBe(403);
    const unlocked = await handleRequest(http("session/unlock", { secret: "a".repeat(43) }), cfg, fetch, undefined, sessions, runtime);
    const cookie = unlocked.headers.get("set-cookie")!.split(";")[0]!;
    expect((await handleRequest(http("push/locale", update, cookie), cfg, fetch, undefined, sessions, runtime)).status).toBe(423);
    const session = await unlocked.json() as { epoch: number; generation: string };
    sessionHeaders = { "x-homeling-session-epoch": String(session.epoch), "x-homeling-session-generation": session.generation };
    expect((await handleRequest(http("push/subscribe", { ...sub, locale: "en" }, cookie), cfg, fetch, undefined, sessions, runtime)).status).toBe(201);
    expect((await handleRequest(http("push/locale", update, cookie, "https://home.example", "text/plain"), cfg, fetch, undefined, sessions, runtime)).status).toBe(415);
    expect((await handleRequest(http("push/locale", update, cookie), cfg, fetch, undefined, sessions, runtime)).status).toBe(200);
    expect((await runtime.store.load()).subscriptions[0]?.locale).toBe("de"); expect(sends).toBe(0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("locking during streamed locale input rejects the old lease after parsing without a commit", async () => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), "homeling-push-locale-body-"));
  try {
    const store = new PushStore(join(dir, "push.json")); const lock = new SessionLock(); const { token } = lock.unlock("alice");
    const admission = lock.admission(lock.admit(token, "alice")); const sub = subscription();
    const runtime = { store, publicKey: "public", transport: { send: async () => ({ status: "sent" as const }) } };
    await handlePushRequest(request("subscribe", { ...sub, locale: "en" }), runtime, "alice", admission);
    let finish!: () => void;
    const body = new ReadableStream<Uint8Array>({ start(controller) { finish = () => { controller.enqueue(new TextEncoder().encode(JSON.stringify({ endpoint: sub.endpoint, locale: "de" }))); controller.close(); }; } });
    const pending = handlePushRequest(new Request("https://home.example/lite/api/push/locale", { method: "POST", headers: { "content-type": "application/json" }, body }), runtime, "alice", admission);
    lock.lock(token, "alice"); finish();
    expect((await pending)?.status).toBe(423);
    expect((await store.load()).subscriptions[0]?.locale).toBe("en");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test.each(["queued", "commit"] as const)("locale update at %s keeps original admission and cannot commit after lock", async (boundary) => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), "homeling-push-locale-fence-"));
  try {
    const store = new PushStore(join(dir, "push.json")); const lock = new SessionLock(); const { token } = lock.unlock("alice");
    const original = lock.admission(lock.admit(token, "alice")); const sub = subscription();
    const runtime = { store, publicKey: "public", transport: { send: async () => ({ status: "sent" as const }) } };
    await handlePushRequest(request("subscribe", { ...sub, locale: "en" }), runtime, "alice", original);
    const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    // This injected public port delays only the asynchronous filesystem commit used by PushStore.
    const held = { assert: original.assert, dispatch<T>(operation: () => T): T { entered.resolve(); return release.promise.then(() => original.dispatch(operation)) as T; } };
    const prior = boundary === "queued" ? store.mutate(state => ({ next: { ...state, preferences: { enabled: false } }, result: undefined }), held).catch(() => undefined) : undefined;
    if (prior) await entered.promise;
    const pending = handlePushRequest(request("locale", { endpoint: sub.endpoint, locale: "de" }), runtime, "alice", boundary === "commit" ? held : original);
    if (!prior) await entered.promise;
    lock.lock(token, "alice"); release.resolve();
    await prior;
    expect((await pending)?.status).toBe(423);
    expect((await store.load()).subscriptions[0]?.locale).toBe("en");
    expect((await store.load()).preferences.enabled).toBe(true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test.each([undefined, "unsupported"])("legacy locale %s reads as English without modifying its stored bytes", async (locale) => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), "homeling-push-locale-legacy-"));
  try {
    const path = join(dir, "push.json"); const sub = subscription();
    const bytes = JSON.stringify({ ...emptyPushState(), subscriptions: [{ ...sub, owner: "alice", ...(locale === undefined ? {} : { locale }) }] });
    await writeFile(path, bytes, { mode: 0o600 });
    const runtime = { store: new PushStore(path), publicKey: "public", transport: { send: async () => ({ status: "sent" as const }) } };
    const response = await handlePushRequest(new Request("https://home.example/lite/api/push/status"), runtime, "alice");
    expect((await response!.json()).subscriptions[0].locale).toBe("en");
    expect(await readFile(path, "utf8")).toBe(bytes);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("locale updates reject unknown or foreign endpoints and malformed locale without any state or send effect", async () => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), "homeling-push-locale-owner-"));
  try {
    const store = new PushStore(join(dir, "push.json")); const lock = new SessionLock();
    const alice = lock.unlock("alice").token; const bob = lock.unlock("bob").token;
    const admitAlice = lock.admission(lock.admit(alice, "alice")); const admitBob = lock.admission(lock.admit(bob, "bob"));
    let sends = 0;
    const runtime = { store, publicKey: "public", transport: { send: async () => { sends++; return { status: "sent" as const }; } } };
    const sub = subscription();
    await handlePushRequest(request("subscribe", { ...sub, locale: "ja" }), runtime, "alice", admitAlice);
    const before = await store.load();
    expect((await handlePushRequest(request("locale", { endpoint: sub.endpoint, locale: "de" }), runtime, "bob", admitBob))?.status).toBe(404);
    expect((await handlePushRequest(request("locale", { endpoint: "https://fcm.googleapis.com/fcm/send/missing", locale: "de" }), runtime, "alice", admitAlice))?.status).toBe(404);
    for (const body of [{ endpoint: sub.endpoint, locale: "fr" }, { endpoint: sub.endpoint, locale: 1 }, { endpoint: sub.endpoint, locale: "de", keys: sub.keys }]) expect((await handlePushRequest(request("locale", body), runtime, "alice", admitAlice))?.status).toBe(400);
    expect((await handlePushRequest(request("locale", { endpoint: sub.endpoint, locale: "de" }), runtime, "alice"))?.status).toBe(423);
    expect(await store.load()).toEqual(before); expect(sends).toBe(0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("re-enrollment without locale preserves the existing browser subscription language", async () => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), "homeling-push-locale-enroll-"));
  try {
    const store = new PushStore(join(dir, "push.json")); const lock = new SessionLock(); const { token } = lock.unlock("alice");
    const admission = lock.admission(lock.admit(token, "alice"));
    const runtime = { store, publicKey: "public", transport: { send: async () => ({ status: "sent" as const }) } };
    const sub = subscription();
    await handlePushRequest(request("subscribe", { ...sub, locale: "de" }), runtime, "alice", admission);
    await handlePushRequest(request("subscribe", sub), runtime, "alice", admission);
    const status = await handlePushRequest(new Request("https://home.example/lite/api/push/status"), runtime, "alice");
    expect((await status!.json()).subscriptions[0].locale).toBe("de");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("existing-owner locale update survives restart without enabling, changing claims, creating subscriptions or sending", async () => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), "homeling-push-locale-"));
  try {
    const path = join(dir, "push.json"); const store = new PushStore(path);
    const lock = new SessionLock(); const { token } = lock.unlock("alice"); const admission = lock.admission(lock.admit(token, "alice"));
    let sends = 0;
    const runtime = { store, publicKey: "public", transport: { send: async () => { sends++; return { status: "sent" as const }; } } };
    const sub = subscription();
    expect((await handlePushRequest(request("subscribe", { ...sub, locale: "en" }), runtime, "alice", admission))?.status).toBe(201);
    await store.mutate(state => ({ next: { ...state, preferences: { enabled: false }, deliveries: { existing: 123 }, pendingOccurrences: { existing: { binding: "main", identity: "same", occurrenceKey: "same-occurrence", active: true } } }, result: undefined }), admission);
    const before = await store.load();
    const result = await handlePushRequest(request("locale", { endpoint: sub.endpoint, locale: "de" }), runtime, "alice", admission);
    expect(result?.status).toBe(200);
    const restarted = new PushStore(path);
    const status = await handlePushRequest(new Request("https://home.example/lite/api/push/status"), { ...runtime, store: restarted }, "alice");
    expect((await status!.json()).subscriptions).toEqual([{ endpoint: sub.endpoint, locale: "de" }]);
    const after = await restarted.load();
    expect(after.subscriptions).toHaveLength(1);
    expect(after.subscriptions[0]!.keys).toEqual(sub.keys);
    expect(after.preferences).toEqual(before.preferences);
    expect(after.deliveries).toEqual(before.deliveries);
    expect(after.pendingOccurrences).toEqual(before.pendingOccurrences);
    expect(sends).toBe(0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
