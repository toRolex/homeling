import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleUnlockedRequest as handleRequest, fixtureAdmission, fixtureRecovery } from "./session-test-fixture.ts";
import { HerdrSocketClient, type HerdrPane } from "./herdr-client.ts";
import type { DaemonConfig } from "./config.ts";
import { PersonaRegistry } from "./persona-registry.ts";
import { createEventObserver, deletePersona, recoverPersonas, sendPersonaMessage, type PersonaRuntime } from "./persona-service.ts";
import type { BridgeFetch } from "./bridge-proxy.ts";
import { handleRequest as handleLockedRequest } from "./index.ts";
import { SessionController } from "./session-controller.ts";

interface MemoryState {
  workspaces: Array<{ workspace_id: string; label: string }>;
  tabs: Array<{ tab_id: string; workspace_id: string }>;
  panes: HerdrPane[];
  text: Array<{ paneId: string; text: string }>;
  keys: Array<{ paneId: string; keys: string[] }>;
  closed: string[];
  eventStreams: Socket[];
  startedAgents: Set<string>;
  agentStatus: string;
  actions: string[];
  paneReads: number;
  readScreens: string[];
  failSendKeys: boolean;
}

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function pane(workspaceId: string, paneNo: number, tabNo: number, cwd: string): HerdrPane {
  return { pane_id: `${workspaceId}:p${paneNo}`, workspace_id: workspaceId, tab_id: `${workspaceId}:t${tabNo}`, cwd };
}

async function memoryHerdr(root: string, state: MemoryState): Promise<string> {
  const socketPath = join(root, "herdr.sock");
  const server = createServer((socket: Socket) => {
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline)) as { id: string; method: string; params: Record<string, unknown> };
      const reply = (result: unknown) => {
        const frame = Buffer.from(`${JSON.stringify({ id: request.id, result })}\n`);
        const label = typeof p.label === "string" ? Buffer.from(p.label) : Buffer.alloc(0);
        const labelOffset = label.length > 0 && label.some((byte) => byte >= 0x80) ? frame.indexOf(label) : -1;
        if (labelOffset >= 0) {
          const splitAt = labelOffset + 1;
          socket.write(frame.subarray(0, splitAt));
          setTimeout(() => socket.end(frame.subarray(splitAt)), 1);
        } else socket.end(frame);
      };
      const p = request.params;
      if (request.method === "workspace.create") {
        const workspaceNo = state.workspaces.length + 1;
        const workspaceId = `w${workspaceNo}`;
        const tabNo = 1;
        const createdPane = pane(workspaceId, 1, tabNo, String(p.cwd));
        const workspace = { workspace_id: workspaceId, label: String(p.label ?? workspaceId) };
        state.workspaces.push(workspace);
        state.tabs.push({ tab_id: createdPane.tab_id, workspace_id: workspaceId });
        state.panes.push(createdPane);
        reply({ type: "workspace_info", workspace, root_pane: createdPane });
      } else if (request.method === "tab.create") {
        const workspaceId = String(p.workspace_id);
        const tabNo = state.tabs.filter((tab) => tab.workspace_id === workspaceId).length + 1;
        const paneNo = tabNo;
        const createdPane = pane(workspaceId, paneNo, tabNo, typeof p.cwd === "string" ? p.cwd : "/home/test");
        state.tabs.push({ tab_id: createdPane.tab_id, workspace_id: workspaceId });
        state.panes.push(createdPane);
        reply({ type: "pane_info", root_pane: createdPane });
      } else if (request.method === "pane.send_text") {
        state.actions.push("send_text");
        state.text.push({ paneId: String(p.pane_id), text: String(p.text) });
        reply({ type: "ok" });
      } else if (request.method === "pane.read") {
        state.paneReads += 1;
        state.actions.push("pane_read");
        reply({ type: "pane_read", read: { text: state.readScreens.shift() ?? "$ ", truncated: false, revision: 1 } });
      } else if (request.method === "pane.send_keys") {
        state.actions.push("send_keys");
        const paneId = String(p.pane_id);
        state.keys.push({ paneId, keys: p.keys as string[] });
        if (state.failSendKeys) socket.end(`${JSON.stringify({ id: "", error: { code: "send_failed", message: "input rejected" } })}\n`);
        else {
          if ((p.keys as string[]).includes("Enter")) state.startedAgents.add(paneId);
          reply({ type: "ok" });
        }
      } else if (request.method === "pane.close") {
        const paneId = String(p.pane_id);
        state.closed.push(paneId);
        state.panes = state.panes.filter((item) => item.pane_id !== paneId);
        reply({ type: "ok" });
        for (const stream of state.eventStreams) stream.write(`${JSON.stringify({ event: "pane_closed", data: { pane_id: paneId } })}\n`);
      } else if (request.method === "workspace.rename") {
        const workspace = state.workspaces.find((item) => item.workspace_id === p.workspace_id);
        if (workspace) workspace.label = String(p.label);
        reply({ type: "workspace_info", workspace });
      } else if (request.method === "session.snapshot") {
        state.actions.push("snapshot");
        reply({ type: "session_snapshot", snapshot: {
          workspaces: state.workspaces,
          tabs: state.tabs,
          panes: state.panes,
          agents: state.panes.filter((item) => state.startedAgents.has(item.pane_id)).map((item) => ({ pane_id: item.pane_id, agent_status: state.agentStatus })),

        } });
      } else if (request.method === "events.subscribe") {
        state.eventStreams.push(socket);
        socket.write(`${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`);
        const eventFrame = Buffer.from(`${JSON.stringify({ event: "pane_closed", data: { pane_id: "w1:p1", label: "伙伴" } })}\n`);
        const splitAt = eventFrame.indexOf(Buffer.from("伙伴")) + 1;
        setTimeout(() => {
          socket.write(eventFrame.subarray(0, splitAt));
          setTimeout(() => socket.write(eventFrame.subarray(splitAt)), 1);
        }, 5);
      } else {
        socket.end(`${JSON.stringify({ id: "", error: { code: "unknown_method", message: request.method } })}\n`);
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return socketPath;
}

async function fixture(options: { failSendKeys?: boolean; failFirstReplyPartial?: boolean; launchers?: Array<{ command: string; label: string; cwd?: string }> } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "homeling-persona-")));
  roots.push(root);
  const state: MemoryState = { workspaces: [], tabs: [], panes: [], text: [], keys: [], closed: [], eventStreams: [], startedAgents: new Set(), agentStatus: "working", actions: [], paneReads: 0, readScreens: [], failSendKeys: options.failSendKeys ?? false };
  const socketPath = await memoryHerdr(root, state);
  let launcherRows = options.launchers ?? [{ command: "agent --start", label: "Agent", cwd: "/home/test" }];
  let failNextPartialReply = options.failFirstReplyPartial ?? false;
  const cfg: DaemonConfig = {
    port: 8790, hostname: "127.0.0.1", webDist: root, indexHtml: "index.html",
    trustedUsers: ["me@github.com"], tailscaleHost: "homeling.tail1234.ts.net", publicOrigin: "https://homeling.tail1234.ts.net", allowAnyHost: false,
    bridgeOrigin: "http://127.0.0.1:8787", registryPath: join(root, "registry.json"), herdrSocketPath: socketPath,
  };
  const deliveries: Array<{ url: string; body: unknown }> = [];
  const bridgeCalls: string[] = [];
  const fetcher: BridgeFetch = async (input, init) => {
    const url = String(input);
    bridgeCalls.push(url);
    if (url.endsWith("/api/launchers")) {
      return Response.json({ launchers: launcherRows, home: "/home/test" });
    }
    if (url.endsWith("/reply")) {
      state.actions.push("reply");
      deliveries.push({ url, body: JSON.parse(await new Response(init?.body).text()) });
      if (failNextPartialReply) {
        failNextPartialReply = false;
        return Response.json({ ok: false, error: "submit failed", textDelivered: true }, { status: 502 });
      }
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  };
  const runtime: PersonaRuntime = { cfg, fetcher, registry: new PersonaRegistry(cfg.registryPath), herdr: new HerdrSocketClient({ socketPath }) };
  return { cfg, state, deliveries, bridgeCalls, fetcher, runtime, setLaunchers(rows: typeof launcherRows) { launcherRows = rows; } };
}

function request(path: string, options: { method?: string; body?: string; contentType?: string; host?: string; origin?: string; remoteAddress?: string; login?: string } = {}) {
  const headers = new Headers({ host: options.host ?? "homeling.tail1234.ts.net" });
  if (!options.remoteAddress && !options.host && !options.login) headers.set("tailscale-user-login", "me@github.com");
  if (options.contentType) headers.set("content-type", options.contentType);
  if (options.origin) headers.set("origin", options.origin);
  else if (!options.remoteAddress && !options.host) headers.set("origin", "https://homeling.tail1234.ts.net");
  if (options.login) headers.set("tailscale-user-login", options.login);
  return Object.assign(new Request(`http://daemon.test${path}`, {
    method: options.method ?? "GET", headers,
    ...(options.body !== undefined ? { body: options.body } : {}),
  }), { remoteAddress: options.remoteAddress ?? "127.0.0.1" });
}

describe("persona creation loop over an in-memory Herdr socket", () => {
  test("direct locked avatar PATCH is not dispatched and changes neither space nor durable persona", async () => {
    const { cfg, state, fetcher, runtime } = await fixture();
    const created = await handleRequest(request("/lite/api/persona", { method: "POST", contentType: "application/json", body: JSON.stringify({ name: "Mira", avatar: { color: "#86efac" } }) }), cfg, fetcher, runtime);
    const { persona } = await created.json() as { persona: { id: string } };
    const response = await handleLockedRequest(request(`/lite/api/persona/${persona.id}`, { method: "PATCH", contentType: "application/json", body: JSON.stringify({ name: "Nova", avatar: { color: "#93c5fd", character: "sleepy", pet: "dog" } }) }), cfg, fetcher, runtime, new SessionController({ verify: () => null }));
    expect(response.status).toBe(423);
    expect(await response.json()).toMatchObject({ executed: false, code: "session.locked" });
    expect(await new PersonaRegistry(cfg.registryPath).get(persona.id)).toMatchObject({ name: "Mira", avatar: { color: "#86efac" } });
    expect(state.workspaces[0]?.label).toBe("Mira");
  });
  test("malformed avatar fields are rejected atomically before rename or persistence", async () => {
    const { cfg, state, fetcher, runtime } = await fixture();
    const created = await handleRequest(request("/lite/api/persona", { method: "POST", contentType: "application/json", body: JSON.stringify({ name: "Mira", avatar: { color: "#86efac" } }) }), cfg, fetcher, runtime);
    const { persona } = await created.json() as { persona: { id: string } };
    for (const invalid of [{ character: 9 }, { pet: null }, { character: "x".repeat(81) }, { pet: {} }, { character: "" }]) {
      const response = await handleRequest(request(`/lite/api/persona/${persona.id}`, { method: "PATCH", contentType: "application/json", body: JSON.stringify({ name: "Do not rename", avatar: { color: "#93c5fd", ...invalid } }) }), cfg, fetcher, runtime);
      expect(response.status).toBe(400);
    }
    expect((await runtime.registry.get(persona.id))?.name).toBe("Mira");
    expect(state.workspaces[0]?.label).toBe("Mira");
  });
  test("persona state explains missing and unreported panes without fabricating thinking", async () => {
    const { cfg, state, fetcher, runtime } = await fixture();
    const created = await handleRequest(request("/lite/api/persona", { method: "POST", contentType: "application/json", body: JSON.stringify({ name: "Mira", avatar: { color: "#86efac" } }) }), cfg, fetcher, runtime);
    expect(created.status).toBe(201);
    async function read() { return (await (await handleRequest(request("/lite/api/persona/list"), cfg, fetcher, runtime)).json()).personas[0]; }
    expect(await read()).toMatchObject({ status: "thinking", statusSource: "agent" });
    state.startedAgents.clear();
    expect(await read()).toMatchObject({ status: "active", statusSource: "pane" });
    state.panes = [];
    expect(await read()).toMatchObject({ status: "idle", statusSource: "missing" });
  });
  test("avatar customization and rename survive daemon reload without overwriting a concurrent prompt update", async () => {
    const { cfg, state, fetcher, runtime } = await fixture();
    const created = await handleRequest(request("/lite/api/persona", { method: "POST", contentType: "application/json", body: JSON.stringify({ name: "Mira", avatar: { color: "#86efac" }, systemPrompt: "original" }) }), cfg, fetcher, runtime);
    const { persona } = await created.json() as { persona: { id: string } };
    const avatar = { color: "#93c5fd", character: "curious", pet: "cat" };
    const [customized, prompt] = await Promise.all([
      handleRequest(request(`/lite/api/persona/${persona.id}`, { method: "PATCH", contentType: "application/json", body: JSON.stringify({ name: "Nova", avatar }) }), cfg, fetcher, runtime),
      runtime.registry.patchPersona(persona.id, { systemPrompt: "new memory instructions", systemPromptInjected: true }),
    ]);
    expect(customized.status).toBe(200);
    expect(prompt).toBeDefined();
    const reloaded = { ...runtime, registry: new PersonaRegistry(cfg.registryPath) };
    const listed = await handleRequest(request("/lite/api/persona/list"), cfg, fetcher, reloaded);
    expect((await listed.json()).personas[0]).toMatchObject({ name: "Nova", avatar, systemPrompt: "new memory instructions", systemPromptInjected: true });
    expect(state.workspaces[0]?.label).toBe("Nova");
  });
  test("a read-created cached runtime never retains a prior request's admission", async () => {
    const { cfg, fetcher, deliveries } = await fixture();
    expect((await handleRequest(request("/lite/api/persona/list"), cfg, fetcher)).status).toBe(200);
    const created = await handleRequest(request("/lite/api/persona", { method: "POST", contentType: "application/json", body: JSON.stringify({ name: "Mira", avatar: { color: "#86efac" } }) }), cfg, fetcher);
    const { persona } = await created.json() as { persona: { id: string } };
    const sent = await handleRequest(request(`/lite/api/persona/${persona.id}/message`, { method: "POST", contentType: "application/json", body: JSON.stringify({ text: "hello" }) }), cfg, fetcher);
    expect(sent.status).toBe(200);
    expect(deliveries).toHaveLength(1);
  });
  test("persona message routing cannot bypass an unknown cancellation on its latest main pane", async () => {
    const { cfg, deliveries, fetcher, runtime } = await fixture();
    const created = await handleRequest(request("/lite/api/persona", {
      method: "POST", contentType: "application/json", body: JSON.stringify({ name: "Mira", avatar: { color: "#86efac" } }),
    }), cfg, fetcher, runtime);
    const { persona } = await created.json() as { persona: { id: string; mainPaneId: string } };
    const controlFetcher: BridgeFetch = async (input, init) => {
      if (init?.method === "POST") throw new Error("cancellation result lost");
      if (String(input).endsWith("/snapshot")) return Response.json({ bridge: "connected", agents: [{
        paneId: persona.mainPaneId, workspaceId: "w1", tabId: "w1:t1", agent: "claude", cwd: "/home/test", sessionName: "s", status: "working",
      }], shellPanes: [] });
      return Response.json({ paneId: persona.mainPaneId, text: "Working on task", truncated: false });
    };
    const key = await handleRequest(request(`/lite/api/pane/${encodeURIComponent(persona.mainPaneId)}/control-key`, {
      method: "POST", contentType: "application/json", body: JSON.stringify({ action: "interrupt", confirmed: true,
        identity: JSON.stringify([persona.mainPaneId, "w1", "w1:t1", "claude", "/home/test", "s", null, null]) }),
    }), cfg, controlFetcher, runtime);
    expect(await key.json()).toMatchObject({ outcome: "unknown" });
    const message = await handleRequest(request(`/lite/api/persona/${persona.id}/message`, {
      method: "POST", contentType: "application/json", body: JSON.stringify({ text: "new instruction" }),
    }), cfg, fetcher, runtime);
    expect(message.status).toBe(409);
    expect(await message.json()).toMatchObject({ textDelivered: false });
    expect(deliveries).toHaveLength(0);
  });
  test("creates, messages, launches owned tasks, lists status, and restores a missing main pane", async () => {
    const { cfg, state, deliveries, bridgeCalls, fetcher, runtime } = await fixture();
    const body = JSON.stringify({ name: "Mira", avatar: { color: "#86efac" }, systemPrompt: "Be concise." });
    const created = await handleRequest(request("/lite/api/persona", { method: "POST", contentType: "application/json", body }), cfg, fetcher, runtime);
    expect(created.status).toBe(201);
    const { persona } = await created.json() as { persona: { id: string; name: string; spaceId: string; mainPaneId: string } };
    expect(persona).toMatchObject({ name: "Mira", spaceId: "w1", mainPaneId: "w1:p1" });
    expect(state.text).toEqual([{ paneId: "w1:p1", text: "agent --start" }]);
    expect(state.keys).toEqual([{ paneId: "w1:p1", keys: ["Enter"] }]);
    expect(state.paneReads).toBeGreaterThanOrEqual(2);

    const sent = await handleRequest(request(`/lite/api/persona/${persona.id}/message`, {
      method: "POST", contentType: "application/json", body: JSON.stringify({ text: "Hello" }),
    }), cfg, fetcher, runtime);
    expect(sent.status).toBe(200);
    expect(state.actions.indexOf("send_keys")).toBeLessThan(state.actions.indexOf("reply"));
    expect(await sent.json()).toMatchObject({ ok: true, personaConfirmationText: "[Persona instructions]\nBe concise.\n[End persona instructions]\n\nHello" });
    expect(deliveries[0]).toMatchObject({ url: `${cfg.bridgeOrigin}/api/pane/w1%3Ap1/reply`, body: {
      text: "[Persona instructions]\nBe concise.\n[End persona instructions]\n\nHello", submit: true,
    } });

    const task = await handleRequest(request("/lite/api/launch", {
      method: "POST", contentType: "application/json", body: JSON.stringify({ command: "agent --start", personaId: persona.id }),
    }), cfg, fetcher, runtime);
    expect(task.status).toBe(200);
    const taskResult = await task.json() as { pane: { paneId: string; workspaceId: string } };
    expect(taskResult.pane).toMatchObject({ paneId: "w1:p2", workspaceId: persona.spaceId });
    expect(state.text.at(-1)).toEqual({ paneId: "w1:p2", text: "agent --start" });

    const listed = await handleRequest(request("/lite/api/persona/list"), cfg, fetcher, runtime);
    expect((await listed.json() as { personas: Array<{ status: string }> }).personas[0]?.status).toBe("thinking");
    for (const [wireStatus, expected] of [["blocked", "blocked"], ["idle", "idle"], ["done", "idle"]]) {
      state.agentStatus = wireStatus!;
      const statusResponse = await handleRequest(request("/lite/api/persona/list"), cfg, fetcher, runtime);
      expect((await statusResponse.json() as { personas: Array<{ status: string }> }).personas[0]?.status).toBe(expected);
    }

    state.panes = state.panes.filter((item) => item.pane_id !== persona.mainPaneId);
    await recoverPersonas(runtime, fixtureRecovery);
    const recoveredList = await handleRequest(request("/lite/api/persona/list"), cfg, fetcher, runtime);
    expect((await recoveredList.json() as { personas: Array<{ mainPaneId: string }> }).personas[0]?.mainPaneId).toBe("w1:p3");
    expect(await runtime.registry.get(persona.id)).toMatchObject({ mainPaneId: "w1:p3", spaceId: "w1", systemPromptInjected: false });
    const afterRecoveryMessage = await handleRequest(request(`/lite/api/persona/${persona.id}/message`, {
      method: "POST", contentType: "application/json", body: JSON.stringify({ text: "After recovery" }),
    }), cfg, fetcher, runtime);
    expect(afterRecoveryMessage.status).toBe(200);
    expect(deliveries.at(-1)).toMatchObject({
      url: `${cfg.bridgeOrigin}/api/pane/w1%3Ap3/reply`,
      body: { text: "[Persona instructions]\nBe concise.\n[End persona instructions]\n\nAfter recovery", submit: true },
    });
    const recoveredHistory = await handleRequest(request("/lite/api/pane/w1%3Ap3/history"), cfg, fetcher, runtime);
    expect(recoveredHistory.status).toBe(404);
    expect(bridgeCalls).toContain(`${cfg.bridgeOrigin}/api/pane/w1:p3/history`);
  });

  test("waits for stable nonempty shell output for creation, task launch, and pane recovery", async () => {
    const { cfg, state, fetcher, runtime } = await fixture();
    state.readScreens = ["", "Starting shell", "$ ", "$ "];
    const created = await handleRequest(request("/lite/api/persona", {
      method: "POST", contentType: "application/json",
      body: JSON.stringify({ name: "Mira", avatar: { color: "#86efac" } }),
    }), cfg, fetcher, runtime);
    const { persona } = await created.json() as { persona: { id: string; mainPaneId: string } };
    expect(created.status).toBe(201);
    expect(state.actions.slice(0, 5)).toEqual(["pane_read", "pane_read", "pane_read", "pane_read", "send_text"]);
    state.actions = [];
    state.readScreens = ["", "Starting shell", "$ ", "$ "];
    const task = await handleRequest(request("/lite/api/launch", {
      method: "POST", contentType: "application/json", body: JSON.stringify({ command: "agent --start", personaId: persona.id }),
    }), cfg, fetcher, runtime);
    expect(task.status).toBe(200);
    expect(state.actions.slice(0, 5)).toEqual(["pane_read", "pane_read", "pane_read", "pane_read", "send_text"]);
    state.actions = [];
    state.readScreens = ["", "Starting shell", "$ ", "$ "];
    state.panes = state.panes.filter((item) => item.pane_id !== persona.mainPaneId);
    await recoverPersonas(runtime, fixtureRecovery);
    await handleRequest(request("/lite/api/persona/list"), cfg, fetcher, runtime);
    expect(state.actions.filter((action) => action !== "snapshot").slice(0, 5)).toEqual(["pane_read", "pane_read", "pane_read", "pane_read", "send_text"]);
  });

  test("restores persisted associations after daemon restart without adopting unrelated spaces", async () => {
    const { cfg, state, fetcher, runtime } = await fixture();
    const created = await handleRequest(request("/lite/api/persona", {
      method: "POST", contentType: "application/json",
      body: JSON.stringify({ name: "Mira", avatar: { color: "#86efac" } }),
    }), cfg, fetcher, runtime);
    const { persona } = await created.json() as { persona: { id: string } };
    state.workspaces.push({ workspace_id: "collie-existing", label: "Unrelated" });
    const restarted: PersonaRuntime = {
      ...runtime, registry: new PersonaRegistry(cfg.registryPath),
      herdr: new HerdrSocketClient({ socketPath: cfg.herdrSocketPath }),
    };
    const listed = await handleRequest(request("/lite/api/persona/list"), cfg, fetcher, restarted);
    expect(await listed.json()).toMatchObject({ personas: [{ id: persona.id, spaceId: "w1", mainPaneId: "w1:p1" }] });
    expect(await restarted.registry.list()).toHaveLength(1);
    expect(state.text).toEqual([{ paneId: "w1:p1", text: "agent --start" }]);

    state.panes = [];
    await recoverPersonas(restarted, fixtureRecovery);
    await handleRequest(request("/lite/api/persona/list"), cfg, fetcher, restarted);
    expect(await restarted.registry.get(persona.id)).toMatchObject({ spaceId: "w1", mainPaneId: "w1:p2", systemPromptInjected: false });
    expect(state.tabs.at(-1)?.workspace_id).toBe("w1");
    expect(state.workspaces.find((space) => space.workspace_id === "collie-existing")?.label).toBe("Unrelated");
  });

  test("keeps disjoint PATCH fields and the injection marker while a message is in flight", async () => {
    const { cfg, fetcher, runtime } = await fixture();
    const created = await handleRequest(request("/lite/api/persona", {
      method: "POST", contentType: "application/json",
      body: JSON.stringify({ name: "Mira", avatar: { color: "#86efac" }, systemPrompt: "Be concise." }),
    }), cfg, fetcher, runtime);
    const { persona } = await created.json() as { persona: { id: string } };
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const delayedRuntime: PersonaRuntime = { ...runtime, fetcher: async (input, init) => {
      if (String(input).endsWith("/reply")) { markStarted(); await gate; }
      return fetcher(input, init);
    } };
    const sending = handleRequest(request(`/lite/api/persona/${persona.id}/message`, {
      method: "POST", contentType: "application/json", body: JSON.stringify({ text: "Hello" }),
    }), cfg, delayedRuntime.fetcher, delayedRuntime);
    await started;
    const rename = handleRequest(request(`/lite/api/persona/${persona.id}`, {
      method: "PATCH", contentType: "application/json", body: JSON.stringify({ name: "Mira Two" }),
    }), cfg, delayedRuntime.fetcher, delayedRuntime);
    const recolor = handleRequest(request(`/lite/api/persona/${persona.id}`, {
      method: "PATCH", contentType: "application/json", body: JSON.stringify({ avatar: { color: "#93c5fd" } }),
    }), cfg, delayedRuntime.fetcher, delayedRuntime);
    release();
    const responses = await Promise.all([sending, rename, recolor]);
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(await runtime.registry.get(persona.id)).toMatchObject({
      name: "Mira Two", avatar: { color: "#93c5fd" }, systemPromptInjected: true, mainPaneId: "w1:p1",
    });
  });

  test("keeps transcript confirmation text after a first-message partial submit failure", async () => {
    const { cfg, deliveries, fetcher, runtime } = await fixture({ failFirstReplyPartial: true });
    const created = await handleRequest(request("/lite/api/persona", {
      method: "POST", contentType: "application/json",
      body: JSON.stringify({ name: "Mira", avatar: { color: "#86efac" }, systemPrompt: "Be concise." }),
    }), cfg, fetcher, runtime);
    const { persona } = await created.json() as { persona: { id: string } };
    const partial = await handleRequest(request(`/lite/api/persona/${persona.id}/message`, {
      method: "POST", contentType: "application/json", body: JSON.stringify({ text: "Hello" }),
    }), cfg, fetcher, runtime);
    expect(partial.status).toBe(502);
    expect(await partial.json()).toMatchObject({
      textDelivered: true,
      personaConfirmationText: "[Persona instructions]\nBe concise.\n[End persona instructions]\n\nHello",
    });
    expect(await runtime.registry.get(persona.id)).toMatchObject({ systemPromptInjected: true });
    const next = await handleRequest(request(`/lite/api/persona/${persona.id}/message`, {
      method: "POST", contentType: "application/json", body: JSON.stringify({ text: "Next" }),
    }), cfg, fetcher, runtime);
    expect(next.status).toBe(409);
    expect(await next.json()).toMatchObject({ code: "memory.delivery_unknown", deliveryUnknown: true });
    expect(deliveries).toHaveLength(1);
  });

  test("does not silently replace a removed launcher during persona recovery", async () => {
    const { cfg, state, fetcher, runtime, setLaunchers } = await fixture();
    const created = await handleRequest(request("/lite/api/persona", {
      method: "POST", contentType: "application/json",
      body: JSON.stringify({ name: "Mira", avatar: { color: "#86efac" } }),
    }), cfg, fetcher, runtime);
    const { persona } = await created.json() as { persona: { id: string; mainPaneId: string } };
    state.panes = state.panes.filter((item) => item.pane_id !== persona.mainPaneId);
    setLaunchers([{ command: "different-agent --start", label: "Different agent", cwd: "/home/test" }]);

    await recoverPersonas(runtime, fixtureRecovery);
    const recovered = await runtime.registry.get(persona.id);
    expect(recovered).toMatchObject({ mainPaneId: "w1:p1", launcherCommand: "agent --start", needsAttention: "launcher_not_allowlisted" });
    expect(state.text).toEqual([{ paneId: "w1:p1", text: "agent --start" }]);
    expect(state.panes).toEqual([]);
  });

  test("rejects unlisted launchers before allocation and rolls back a failed owned task", async () => {
    const { cfg, state, fetcher, runtime } = await fixture();
    const rejected = await handleRequest(request("/lite/api/persona", {
      method: "POST", contentType: "application/json",
      body: JSON.stringify({ name: "Mira", avatar: { color: "#86efac" }, launcherCommand: "arbitrary-command" }),
    }), cfg, fetcher, runtime);
    expect(rejected.status).toBe(502);
    expect(state.workspaces).toEqual([]);
    expect(await runtime.registry.list()).toEqual([]);
    const created = await handleRequest(request("/lite/api/persona", {
      method: "POST", contentType: "application/json",
      body: JSON.stringify({ name: "Mira", avatar: { color: "#86efac" } }),
    }), cfg, fetcher, runtime);
    const { persona } = await created.json() as { persona: { id: string } };
    state.failSendKeys = true;
    const failed = await handleRequest(request("/lite/api/launch", {
      method: "POST", contentType: "application/json", body: JSON.stringify({ command: "agent --start", personaId: persona.id }),
    }), cfg, fetcher, runtime);
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ ok: false });
    expect(state.closed).toEqual(["w1:p2"]);
    expect(state.panes.map((item) => item.pane_id)).toEqual(["w1:p1"]);
    expect(await runtime.registry.list()).toHaveLength(1);
  });

  test("returns a structured Herdr-unavailable error and records unknown create outcome", async () => {
    const { cfg, fetcher, runtime } = await fixture();
    const missingSocketRuntime: PersonaRuntime = {
      ...runtime,
      herdr: new HerdrSocketClient({ socketPath: join(cfg.herdrSocketPath, "missing") }),
    };
    const response = await handleRequest(request("/lite/api/persona", {
      method: "POST", contentType: "application/json",
      body: JSON.stringify({ name: "Mira", avatar: { color: "#86efac" } }),
    }), cfg, fetcher, missingSocketRuntime);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: "herdr.unavailable" });
    expect(await runtime.registry.list()).toEqual([]);
    expect((await runtime.registry.load()).orphans).toMatchObject([{ spaceId: "unknown" }]);
  });

  test("rolls back partial creation and rejects unsafe API writes", async () => {
    const { cfg, state, fetcher, runtime } = await fixture({ failSendKeys: true });
    const body = JSON.stringify({ name: "Broken", avatar: { color: "#86efac" } });
    const failed = await handleRequest(request("/lite/api/persona", { method: "POST", contentType: "application/json", body }), cfg, fetcher, runtime);
    expect(failed.status).toBe(502);
    expect(await runtime.registry.list()).toEqual([]);
    expect(state.closed).toEqual(["w1:p1"]);
    expect((await runtime.registry.load()).orphans).toHaveLength(1);

    state.failSendKeys = false;
    const denied = await handleRequest(request("/lite/api/persona", {
      method: "POST", contentType: "application/json", body,
      remoteAddress: "100.64.0.2", host: `${cfg.tailscaleHost}:443`, login: "me@github.com", origin: "https://evil.example",
    }), cfg, fetcher, runtime);
    expect(denied.status).toBe(403);
    const badMediaType = await handleRequest(request("/lite/api/persona", { method: "POST", contentType: "text/plain", body }), cfg, fetcher, runtime);
    expect(badMediaType.status).toBe(415);
    expect(await runtime.registry.list()).toEqual([]);

    const missingIdentity = await handleRequest(request("/lite/api/persona", {
      method: "POST", contentType: "application/json", body,
      remoteAddress: "100.64.0.2", host: `${cfg.tailscaleHost}:443`, origin: `https://${cfg.tailscaleHost}`,
    }), cfg, fetcher, runtime);
    expect(missingIdentity.status).toBe(401);
    const hostileHost = await handleRequest(request("/lite/api/persona/list", {
      remoteAddress: "100.64.0.2", host: "evil.example", login: "me@github.com",
    }), cfg, fetcher, runtime);
    expect(hostileHost.status).toBe(403);
  });

  test("preserves multibyte labels when Herdr splits UTF-8 across response chunks", async () => {
    const { runtime } = await fixture();
    const created = await runtime.herdr.createSpace("伙伴", "/home/test");
    expect(created.label).toBe("伙伴");
  });

  test("observes Herdr lifecycle events over the long-lived subscription socket", async () => {
    const { cfg, runtime } = await fixture();
    const event = new Promise<{ event: string; data: unknown }>((resolve) => {
      const stream = runtime.herdr.subscribe((name, data) => {
        stream.close();
        resolve({ event: name, data });
      }, (reason) => { throw new Error(reason); });
    });
    await expect(event).resolves.toEqual({ event: "pane_closed", data: { pane_id: "w1:p1", label: "伙伴" } });
    expect(cfg.herdrSocketPath).toEndWith("herdr.sock");
  });

  test("serializes a first-message marker update with concurrent persona deletion", async () => {
    const { cfg, fetcher, runtime } = await fixture();
    const created = await handleRequest(request("/lite/api/persona", {
      method: "POST", contentType: "application/json",
      body: JSON.stringify({ name: "Mira", avatar: { color: "#86efac" }, systemPrompt: "Be concise." }),
    }), cfg, fetcher, runtime);
    const { persona } = await created.json() as { persona: { id: string } };
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const delayedRuntime: PersonaRuntime = {
      ...runtime,
      fetcher: async (input, init) => {
        if (String(input).endsWith("/reply")) {
          markStarted();
          await gate;
          return Response.json({ ok: true });
        }
        return fetcher(input, init);
      },
    };
    const sending = sendPersonaMessage(delayedRuntime, persona.id, "hello", null, fixtureAdmission());
    await started;
    const deleting = deletePersona(delayedRuntime, persona.id, fixtureAdmission());
    release();
    await Promise.all([sending, deleting]);
    expect(await runtime.registry.get(persona.id)).toBeUndefined();
    expect((await runtime.registry.load()).archivedSpaces).toMatchObject([{ spaceId: "w1" }]);
  });

  test("does not resurrect a main pane when its close event races persona deletion", async () => {
    const { cfg, state, fetcher, runtime } = await fixture();
    const created = await handleRequest(request("/lite/api/persona", {
      method: "POST", contentType: "application/json",
      body: JSON.stringify({ name: "Mira", avatar: { color: "#86efac" } }),
    }), cfg, fetcher, runtime);
    const { persona } = await created.json() as { persona: { id: string } };
    const observer = createEventObserver(runtime, fixtureRecovery);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const deleted = await handleRequest(request(`/lite/api/persona/${persona.id}`, { method: "DELETE" }), cfg, fetcher, runtime);
    await new Promise((resolve) => setTimeout(resolve, 20));
    observer.close();

    expect(deleted.status).toBe(200);
    expect(await runtime.registry.list()).toEqual([]);
    expect(state.closed).toEqual(["w1:p1"]);
    expect(state.panes).toEqual([]);
    expect(state.text).toEqual([{ paneId: "w1:p1", text: "agent --start" }]);
  });

  test("patches, pauses, and deletes a persona while archiving its space", async () => {
    const { cfg, state, fetcher, runtime } = await fixture();
    const created = await handleRequest(request("/lite/api/persona", {
      method: "POST", contentType: "application/json",
      body: JSON.stringify({ name: "Mira", avatar: { color: "#86efac" } }),
    }), cfg, fetcher, runtime);
    const { persona } = await created.json() as { persona: { id: string } };

    const patched = await handleRequest(request(`/lite/api/persona/${persona.id}`, {
      method: "PATCH", contentType: "application/json", body: JSON.stringify({ name: "Mira Two", paused: true }),
    }), cfg, fetcher, runtime);
    expect(patched.status).toBe(200);
    expect(state.workspaces[0]?.label).toBe("Mira Two");
    const pausedMessage = await handleRequest(request(`/lite/api/persona/${persona.id}/message`, {
      method: "POST", contentType: "application/json", body: JSON.stringify({ text: "hello" }),
    }), cfg, fetcher, runtime);
    expect(pausedMessage.status).toBe(409);

    const deleted = await handleRequest(request(`/lite/api/persona/${persona.id}`, { method: "DELETE" }), cfg, fetcher, runtime);
    expect(deleted.status).toBe(200);
    expect(state.closed).toEqual(["w1:p1"]);
    expect(state.workspaces[0]?.label).toBe("[Archived] Mira Two");
    expect(await runtime.registry.list()).toEqual([]);
    expect((await runtime.registry.load()).archivedSpaces).toMatchObject([{ spaceId: "w1", personaName: "Mira Two" }]);
  });
});
