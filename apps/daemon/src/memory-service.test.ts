import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersonaRegistry } from "./persona-registry.ts";
import { PersonaMemoryStore } from "./persona-memory.ts";
import { createPersona, recoverPersonas, sendPersonaMessage, type PersonaRuntime } from "./persona-service.ts";
import type { HerdrPane, HerdrPort } from "./herdr-client.ts";
import { SessionLock } from "./session-lock.ts";
import { handleRequest } from "./index.ts";
import { SessionController } from "./session-controller.ts";
import { createDaemonSystemAdmissions } from "./system-admission.ts";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(command: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "homeling-memory-service-"))); roots.push(root);
  let panes: HerdrPane[] = [];
  let sequence = 0;
  const texts: string[] = [], replies: string[] = [];
  const allocate = () => {
    const pane = { pane_id: `pane-${++sequence}`, workspace_id: "w", tab_id: "t", cwd: root };
    panes.push(pane); return pane;
  };
  let readHook: (() => Promise<void>) | undefined;
  let replyHook: (() => Promise<Response>) | undefined;
  const herdr: HerdrPort = {
    async createSpace(label) { const pane = allocate(); return { workspace_id: "w", label, root_pane: pane }; },
    async createTab() { return allocate(); },
    async readPane() { await readHook?.(); return "$ "; },
    async sendText(_pane, text) { texts.push(text); },
    async sendKeys() {}, async closePane(id) { panes = panes.filter(pane => pane.pane_id !== id); },
    async renameSpace() {},
    async snapshot() { return { workspaces: [{ workspace_id: "w", label: "Mira" }], tabs: [], panes, agents: panes.map(pane => ({ pane_id: pane.pane_id, agent_status: "idle" })) }; },
    subscribe() { return { close() {} }; },
  };
  const cfg = { port: 8790, hostname: "127.0.0.1", webDist: root, indexHtml: "index.html", trustedUsers: [], tailscaleHost: "test.tail.ts.net", publicOrigin: "https://test.tail.ts.net", allowAnyHost: false, bridgeOrigin: "http://127.0.0.1:8787", registryPath: join(root, "registry.json"), herdrSocketPath: join(root, "fake.sock"), memoryPath: join(root, "memory") };
  const memory = new PersonaMemoryStore(cfg.memoryPath);
  const runtime = {
    cfg, herdr, registry: new PersonaRegistry(cfg.registryPath), memory,
    fetcher: async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/api/launchers")) return Response.json({ launchers: [{ command, label: command, cwd: root }], home: root });
      if (String(url).endsWith("/reply")) { replies.push(JSON.parse(String(init?.body)).text); return replyHook ? replyHook() : Response.json({ ok: true }); }
      return new Response("not found", { status: 404 });
    },
  } satisfies PersonaRuntime & { memory: PersonaMemoryStore };
  const lock = new SessionLock(), { token } = lock.unlock("fixture"), admission = lock.admission(lock.admit(token, "fixture"));
  return { root, memory, runtime, lock, token, admission, texts, replies, removePane() { panes = []; }, onRead(hook: () => Promise<void>) { readHook = hook; }, onReply(hook: () => Promise<Response>) { replyHook = hook; } };
}

test("actual HTTP memory save requires a session, refuses bad Origin, and GET does not recover panes", async () => {
  const f = await fixture("pi");
  const persona = await createPersona(f.runtime, { name: "Mira", avatar: { color: "#86efac" } }, null, f.admission);
  f.removePane();
  const secret = "a".repeat(43);
  const sessions = new SessionController({ verify: () => input => input === secret });
  const cfg = { ...f.runtime.cfg, trustedUsers: ["memory-fixture"] };
  const base = `https://${cfg.tailscaleHost}`;
  let lease: { epoch: number; generation: string };
  const request = (method: string, body?: string, cookie?: string, origin = base) => Object.assign(new Request(`${base}/lite/api/persona/${persona.id}/memory`, { method, headers: { host: cfg.tailscaleHost, "tailscale-user-login": "memory-fixture", origin, "content-type": "application/json", ...(cookie ? { cookie, "x-homeling-session-epoch": String(lease.epoch), "x-homeling-session-generation": lease.generation } : {}) }, ...(body ? { body } : {}) }), { remoteAddress: "127.0.0.1" });
  const get = await handleRequest(request("GET"), cfg, f.runtime.fetcher, f.runtime, sessions);
  expect(get.status).toBe(200);
  const memory = await get.json();
  const body = JSON.stringify({ kind: "facts", content: "New HTTP fact", revision: memory.documents.facts.revision });
  const refused = await handleRequest(request("PUT", body), cfg, f.runtime.fetcher, f.runtime, sessions);
  expect(refused.status).toBe(423);
  expect((await f.memory.read(persona.id)).documents.facts.content).toBe("");
  const unlocked = await sessions.handle(new Request(`${base}/lite/api/session/unlock`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret }) }), "memory-fixture");
  const cookie = unlocked!.headers.get("set-cookie")!.split(";", 1)[0]!;
  lease = await unlocked!.json() as typeof lease;
  const crossOrigin = await handleRequest(request("PUT", body, cookie, "https://evil.invalid"), cfg, f.runtime.fetcher, f.runtime, sessions);
  expect(crossOrigin.status).toBe(403);
  const saved = await handleRequest(request("PUT", body, cookie), cfg, f.runtime.fetcher, f.runtime, sessions);
  expect(saved.status).toBe(200);
  expect((await f.memory.read(persona.id)).documents.facts.content).toBe("New HTTP fact");
  expect(f.texts).toHaveLength(1); expect(f.replies).toHaveLength(0);
});

test("persona pi creation and recovery actually launch with frozen context while ordinary messages remain raw", async () => {
  const f = await fixture("pi");
  const persona = await createPersona(f.runtime, { name: "Mira", avatar: { color: "#86efac" }, systemPrompt: "Be kind" }, null, f.admission);
  expect(f.texts[0]).toMatch(/^pi --append-system-prompt '/);
  const path = f.texts[0]!.match(/'([^']+)'$/)![1]!;
  expect(await readFile(path, "utf8")).toContain("Be kind");
  const before = await f.memory.read(persona.id);
  await f.memory.save(persona.id, "facts", "Lives in Guangzhou", before.documents.facts.revision, f.admission);
  const sent = await sendPersonaMessage(f.runtime, persona.id, "Hello", null, f.admission);
  expect(sent.status).toBe(200); expect(f.replies[0]).toBe("Hello");
  expect(await readFile(path, "utf8")).not.toContain("Guangzhou");
  f.removePane();
  await recoverPersonas(f.runtime, createDaemonSystemAdmissions().personaRecovery);
  const nextPath = f.texts.at(-1)!.match(/'([^']+)'$/)![1]!;
  expect(await readFile(nextPath, "utf8")).toContain("Lives in Guangzhou");
  expect((await f.runtime.registry.get(persona.id))!.memorySession!.paneId).not.toBe(persona.mainPaneId);
});

test("unsupported kind prefixes only its first message using launch-time memory, with exact confirmation and original display evidence", async () => {
  const f = await fixture("claude");
  const persona = await createPersona(f.runtime, { name: "Mira", avatar: { color: "#86efac" } }, null, f.admission);
  const empty = await f.memory.read(persona.id);
  const saved = await f.memory.save(persona.id, "facts", "Lives in Guangzhou", empty.documents.facts.revision, f.admission);
  f.removePane(); await recoverPersonas(f.runtime, createDaemonSystemAdmissions().personaRecovery);
  await f.memory.save(persona.id, "facts", "Lives in Shenzhen", saved.documents.facts.revision, f.admission);
  const userText = "[Persona memory]\nI wrote this prefix myself";
  const response = await sendPersonaMessage(f.runtime, persona.id, userText, null, f.admission);
  const body = await response.json();
  expect(f.replies[0]).toContain("Lives in Guangzhou"); expect(f.replies[0]).not.toContain("Lives in Shenzhen");
  expect(body).toMatchObject({ personaConfirmationText: f.replies[0], memoryInjection: { unsupported: true }, personaMessagePresentation: { displayText: userText, confirmationText: f.replies[0], historyBinding: "unbound" } });
  await sendPersonaMessage(f.runtime, persona.id, "Next", null, f.admission);
  expect(f.replies[1]).toBe("Next");
});

test("unknown injected delivery remains sticky across unlock and daemon runtime recreation without replay", async () => {
  const f = await fixture("claude");
  const persona = await createPersona(f.runtime, { name: "Mira", avatar: { color: "#86efac" }, systemPrompt: "Be kind" }, null, f.admission);
  f.onReply(async () => { throw new Error("fake transport lost"); });
  const unknown = await sendPersonaMessage(f.runtime, persona.id, "Hello", null, f.admission);
  expect(await unknown.json()).toMatchObject({ deliveryUnknown: true, personaConfirmationText: f.replies[0] });
  const { token } = f.lock.unlock("fixture", f.token), nextAdmission = f.lock.admission(f.lock.admit(token, "fixture"));
  const restarted = { ...f.runtime, registry: new PersonaRegistry(f.runtime.cfg.registryPath) };
  const retry = await sendPersonaMessage(restarted, persona.id, "Hello", null, nextAdmission);
  expect(retry.status).toBe(409); expect(f.replies).toHaveLength(1);
});

test("creation failures persist a safe orphan reason and expose no raw upstream error", async () => {
  const f = await fixture("claude");
  const marker = "SYNTHETIC_PRIVATE_ERROR_TOKEN";
  f.runtime.herdr.sendText = async () => { throw new Error(marker); };
  await expect(createPersona(f.runtime, { name: "Mira", avatar: { color: "#86efac" } }, null, f.admission)).rejects.not.toThrow(marker);
  expect(await readFile(f.runtime.cfg.registryPath, "utf8")).not.toContain(marker);
  expect((await f.runtime.registry.load()).orphans).toHaveLength(1);
});

test("injected partial replies preserve unknown semantics without forwarding arbitrary error fields", async () => {
  const f = await fixture("claude");
  const persona = await createPersona(f.runtime, { name: "Mira", avatar: { color: "#86efac" }, systemPrompt: "Be kind" }, null, f.admission);
  const marker = "SYNTHETIC_PRIVATE_ERROR_TOKEN";
  f.onReply(async () => Response.json({ ok: false, error: marker, code: marker, textDelivered: true, extra: marker }, { status: 502 }));
  const response = await sendPersonaMessage(f.runtime, persona.id, "Hello", null, f.admission);
  expect(await response.clone().text()).not.toContain(marker);
  expect(await response.json()).toMatchObject({ ok: false, textDelivered: true });
  expect((await f.runtime.registry.get(persona.id))?.memoryDeliveryUnknown).toBe(true);
});

test("a lock reached during shell readiness prevents the memory launcher from dispatching", async () => {
  const f = await fixture("pi");
  f.onRead(async () => { f.lock.lock(f.token, "fixture"); });
  await expect(createPersona(f.runtime, { name: "Mira", avatar: { color: "#86efac" }, systemPrompt: "Be kind" }, null, f.admission)).rejects.toThrow("session.locked");
  expect(f.texts).toHaveLength(0); expect(f.replies).toHaveLength(0);
  expect(await f.runtime.registry.list()).toHaveLength(0);
});
