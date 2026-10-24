import { describe, expect, test } from "bun:test";
import { handleUnlockedRequest as handleRequest } from "./session-test-fixture.ts";
import type { BridgeFetch } from "./bridge-proxy.ts";
import { daemonConfigFromEnv } from "./config.ts";
import { PersonaRegistry } from './persona-registry.ts';
import { HerdrSocketClient } from './herdr-client.ts';
import { ActivityLedger } from './activity-ledger.ts';
import { fixtureAdmission } from './session-test-fixture.ts';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const permissionScreen = `Bash command\n\n  rm -rf build\n\nDo you want to proceed?\n❯ 1. Yes\n  2. No\n\nEsc to cancel · Tab to amend`;

function request(path: string, options: { method?: string; body?: string; contentType?: string; origin?: string; remoteAddress?: string; login?: string; host?: string } = {}) {
  const headers = new Headers({ host: options.host ?? "homeling.tail1234.ts.net" });
  if (options.login) headers.set("tailscale-user-login", options.login);
  else if (!options.remoteAddress && !options.host) headers.set("tailscale-user-login", "me@github.com");
  if (options.contentType) headers.set("content-type", options.contentType);
  if (options.origin) headers.set("origin", options.origin);
  else if (!options.remoteAddress && !options.host) headers.set("origin", "https://homeling.tail1234.ts.net");
  return Object.assign(new Request(`http://localhost:8790${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body,
  }), { remoteAddress: options.remoteAddress ?? "127.0.0.1" });
}

function cfg() {
  return { ...daemonConfigFromEnv({}), registryPath: join(tmpdir(), `homeling-request-fixture-${crypto.randomUUID()}`, 'registry.json'), bridgeOrigin: "http://127.0.0.1:8787", tailscaleHost: "homeling.tail1234.ts.net", publicOrigin: "https://homeling.tail1234.ts.net", trustedUsers: ["me@github.com"] };
}

describe("pending request daemon routes", () => {
  test("GET /lite/api/requests extracts a blocked pane's real terminal prompt", async () => {
    const forwardedLogins: Array<string | null> = [];
    const fetcher: BridgeFetch = async (input, init) => {
      forwardedLogins.push(new Headers(init?.headers).get("tailscale-user-login"));
      const url = String(input);
      if (url.endsWith("/api/snapshot")) return Response.json({
        bridge: "connected", agents: [{
          paneId: "w1:p1", workspaceId: "w1", workspaceLabel: "Work", workspaceNumber: 1,
          tabId: "w1:t1", agent: "claude", status: "blocked", cwd: "/work", focused: true,
        }], shellPanes: [], workspaces: [], tabs: [], sessions: [], ts: Date.now(),
      });
      if (url.endsWith("/api/pane/w1:p1")) return Response.json({ paneId: "w1:p1", text: permissionScreen, revision: 12 });
      throw new Error(`unexpected bridge route ${url}`);
    };
    const response = await handleRequest(request("/lite/api/requests", { login: "me@github.com" }), cfg(), fetcher);
    expect(response.status).toBe(200);
    expect(forwardedLogins).toEqual(["me@github.com", "me@github.com"]);
    const requests = await response.json() as Array<Record<string, unknown>>;
    expect(requests[0]).toMatchObject({
      paneId: "w1:p1", kind: "prompt-select", status: "pending",
      payload: { question: "Do you want to proceed?" },
    });
    const firstOption = (requests[0]?.payload as { options: Array<Record<string, unknown>> }).options[0]!;
    expect(firstOption).toMatchObject({ id: "1", label: "Yes" });
    expect(firstOption).not.toHaveProperty("keys");
    expect(requests[0]).not.toHaveProperty("personaId"); // Legacy space is not a registered persona.
    const config = cfg();
    const registry = new PersonaRegistry('/unused/registry.json', async () => JSON.stringify({ version: 1, personas: [{ id: 'persona-actual', spaceId: 'w1', mainPaneId: 'w1:p1', name: 'Work', avatar: { color: '#86efac' }, launcherCommand: 'claude', createdAt: '2026-10-09T00:00:00Z', paused: false, systemPromptInjected: false }], archivedSpaces: [], orphans: [] }));
    const mapped = await handleRequest(request('/lite/api/requests'), config, fetcher, { cfg: config, fetcher, registry, herdr: new HerdrSocketClient({ socketPath: '/unused/herdr.sock' }) });
    const [mappedMain] = await mapped.json();
    expect(mappedMain.personaId).toBe('persona-actual');
    expect(mappedMain.taskOccurrenceKey).toBeUndefined();
    const dir = await mkdtemp(join(await realpath(tmpdir()), 'homeling-request-owner-'));
    try {
      const activity = new ActivityLedger(join(dir, 'activity.json'));
      const task = await activity.register({ personaId: 'persona-actual', spaceId: 'w1', paneId: 'w1:p1', title: 'Approve fixtures' }, fixtureAdmission());
      const taskRegistry = new PersonaRegistry('/unused/task-registry.json', async () => JSON.stringify({ version: 1, personas: [{ id: 'persona-actual', spaceId: 'w1', mainPaneId: 'w1:main', name: 'Work' }], archivedSpaces: [], orphans: [] }));
      const taskCfg = cfg();
      const taskResponse = await handleRequest(request('/lite/api/requests'), taskCfg, fetcher, { cfg: taskCfg, fetcher, registry: taskRegistry, activity, herdr: new HerdrSocketClient({ socketPath: '/unused/herdr.sock' }) });
      expect((await taskResponse.json())[0]).toMatchObject({ personaId: 'persona-actual', taskOccurrenceKey: task.occurrenceKey });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test("approval rejects cross-origin and non-JSON calls before bridge writes", async () => {
    const config = cfg();
    let writes = 0;
    const fetcher: BridgeFetch = async () => { writes++; return Response.json({ ok: true }); };
    const response = await handleRequest(request("/lite/api/requests/not-a-real-id/approve", {
      method: "POST", contentType: "text/plain", body: '{"optionId":"1"}', origin: "https://evil.example",
    }), config, fetcher);
    expect(response.status).toBe(403);
    expect(writes).toBe(0);

    const wrongType = await handleRequest(request("/lite/api/requests/not-a-real-id/approve", {
      method: "POST", contentType: "text/plain", body: '{"optionId":"1"}',
    }), config, fetcher);
    expect(wrongType.status).toBe(415);
    expect(writes).toBe(0);
  });

  test("stop requires trusted origin and only sends a fixed Ctrl-C", async () => {
    const config = cfg();
    const forwarded: Array<{ url: string; body: string | null }> = [];
    const fetcher: BridgeFetch = async (input, init) => {
      forwarded.push({ url: String(input), body: init?.body ? await new Response(init.body).text() : null });
      return Response.json({ ok: true });
    };
    const path = "/lite/api/pane/w1:p1/stop";
    const remote = { host: config.tailscaleHost, remoteAddress: "127.0.0.1", login: "me@github.com", contentType: "application/json", method: "POST" };
    const noOrigin = await handleRequest(request(path, { ...remote, body: "{}" }), config, fetcher);
    const badOrigin = await handleRequest(request(path, { ...remote, origin: "https://evil.example", body: "{}" }), config, fetcher);
    expect(noOrigin.status).toBe(403);
    expect(badOrigin.status).toBe(403);
    expect(forwarded).toHaveLength(0);

    const allowed = await handleRequest(request(path, {
      ...remote, origin: `https://${config.tailscaleHost}`, body: '{"keys":["rm -rf /"]}',
    }), config, fetcher);
    expect(allowed.status).toBe(200);
    expect(forwarded).toEqual([{ url: `${config.bridgeOrigin}/api/pane/w1:p1/keys`, body: '{"keys":["ctrl+c"]}' }]);
  });

  test("POST approval revalidates then forwards guarded keys and resolves the request", async () => {
    const config = cfg();
    let screen = permissionScreen;
    const bridgeWrites: Array<{ url: string; body: Record<string, unknown>; login: string | null }> = [];
    const fetcher: BridgeFetch = async (input, init) => {
      const url = String(input);
      if (init?.method === "POST") {
        bridgeWrites.push({
          url,
          body: JSON.parse(String(init.body)) as Record<string, unknown>,
          login: new Headers(init.headers).get("tailscale-user-login"),
        });
        return Response.json({ ok: true });
      }
      if (url.endsWith("/api/snapshot")) return Response.json({
        bridge: "connected", agents: [{
          paneId: "w1:p1", workspaceId: "w1", workspaceLabel: "Work", workspaceNumber: 1,
          tabId: "w1:t1", agent: "claude", status: "blocked", cwd: "/work", focused: true,
        }], shellPanes: [], workspaces: [], tabs: [], sessions: [], ts: Date.now(),
      });
      if (url.endsWith("/api/pane/w1:p1")) return Response.json({ text: screen });
      throw new Error(`unexpected bridge route ${url}`);
    };
    const pending = await handleRequest(request("/lite/api/requests", { login: "me@github.com" }), config, fetcher);
    const [item] = await pending.json() as Array<{ id: string }>;
    const approved = await handleRequest(request(`/lite/api/requests/${encodeURIComponent(item!.id)}/approve`, {
      method: "POST", contentType: "application/json", body: '{"optionId":"1"}', login: "me@github.com",
    }), config, fetcher);
    expect(approved.status).toBe(200);
    expect(await approved.json()).toEqual({ status: "resolved", outcome: "submitted" });
    expect(bridgeWrites).toHaveLength(1);
    expect(bridgeWrites[0]?.url).toContain("/api/pane/w1:p1/keys");
    expect(bridgeWrites[0]?.body.keys).toEqual(["1"]);
    expect(bridgeWrites[0]?.login).toBe("me@github.com");
  });
});
