import { expect, test } from "bun:test";
import { handleUnlockedRequest as handleRequest } from './session-test-fixture.ts';
import { daemonConfigFromEnv } from "./config.ts";
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BridgeFetch } from "./bridge-proxy.ts";

const pane = { paneId: "w1:p1", workspaceId: "w1", tabId: "t1", agent: "claude", cwd: "/work", sessionName: "s1", status: "working" };
const identity = JSON.stringify(["w1:p1", "w1", "t1", "claude", "/work", "s1", null, null]);
const screen = "Working on task\n  keep this indentation";
function config() { return { ...daemonConfigFromEnv({}), registryPath: join(tmpdir(), `homeling-control-fixture-${crypto.randomUUID()}`, 'registry.json'), trustedUsers: ["me"], tailscaleHost: "home.tail.ts.net", publicOrigin: "https://home.tail.ts.net" }; }
function request(body: unknown = { action: "interrupt", identity, confirmed: true }, path = "/lite/api/pane/w1:p1/control-key", headers: Record<string, string> = {}) {
  const requestHeaders = new Headers({ host: "home.tail.ts.net", origin: "https://home.tail.ts.net", "tailscale-user-login": "me", "content-type": "application/json", ...headers });
  // Explicit remote cases retain the original missing-identity/missing-Origin assertions.
  if (Object.hasOwn(headers, "host")) {
    if (!Object.hasOwn(headers, "tailscale-user-login")) requestHeaders.delete("tailscale-user-login");
    if (!Object.hasOwn(headers, "origin")) requestHeaders.delete("origin");
  }
  return Object.assign(new Request(`http://localhost:8790${path}`, { method: "POST", headers: requestHeaders, body: JSON.stringify(body) }), { remoteAddress: "127.0.0.1" });

}
function bridge(options: { status?: string; changed?: boolean; truncated?: boolean; failure?: string } = {}) {
  const writes: Record<string, unknown>[] = [];
  let reads = 0;
  const fetcher: BridgeFetch = async (input, init) => {
    if (init?.method === "POST") {
      writes.push(JSON.parse(String(init.body)));
      if (options.failure === "throw") throw new Error("network lost");
      if (options.failure) return Response.json({ ok: false, code: options.failure }, { status: 409 });
      return Response.json({ ok: true });
    }
    if (String(input).endsWith("/snapshot")) return Response.json({ bridge: "connected", agents: [{ ...pane, status: options.status ?? "working", sessionName: options.changed && ++reads > 1 ? "s2" : "s1" }], shellPanes: [] });
    return Response.json({ paneId: pane.paneId, text: screen, truncated: options.truncated });
  };
  return { fetcher, writes };
}

test("fixed interrupt is revalidated and forwarded as a bound real Ctrl-C", async () => {
  const { fetcher, writes } = bridge();
  const response = await handleRequest(request(), config(), fetcher);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ outcome: "accepted" });
  expect(writes).toEqual([{ keys: ["ctrl+c"], expected_prompt: screen }]);
});

test("Escape uses the real neutral key name, not text or Esc", async () => {
  const { fetcher, writes } = bridge();
  expect((await handleRequest(request({ action: "escape", identity, confirmed: true }), config(), fetcher)).status).toBe(200);
  expect(writes).toEqual([{ keys: ["Escape"], expected_prompt: screen }]);
});

test("authorizing keys, forged keys, missing confirmation and identity fail before bridge access", async () => {
  for (const body of [{ action: "Enter", identity, confirmed: true }, { action: "cmd+k", identity, confirmed: true }, { action: "interrupt", identity, confirmed: true, keys: ["Enter"] }, { action: "escape", identity }, null]) {
    const { fetcher, writes } = bridge();
    expect((await handleRequest(request(body), config(), fetcher)).status).toBe(400);
    expect(writes).toHaveLength(0);
  }
  const { fetcher, writes } = bridge();
  expect((await handleRequest(request({}, "/lite/api/pane/w1:p1/keys"), config(), fetcher)).status).toBe(404);
  expect(writes).toHaveLength(0);
});

test("blocked, unknown, finished, truncated, stale identity and approval races fail closed", async () => {
  for (const options of [{ status: "blocked" }, { status: "unknown" }, { status: "done" }, { truncated: true }, { changed: true }]) {
    const { fetcher, writes } = bridge(options);
    expect((await handleRequest(request(), config(), fetcher)).status).toBe(409);
    expect(writes).toHaveLength(0);
  }
  const { fetcher, writes } = bridge();
  expect((await handleRequest(request({ action: "escape", identity: "old", confirmed: true }), config(), fetcher)).status).toBe(409);
  expect(writes).toHaveLength(0);
  let snapshots = 0;
  const race: BridgeFetch = async (input, init) => {
    if (String(input).endsWith("/snapshot")) return Response.json({ bridge: "connected", agents: [{ ...pane, status: ++snapshots > 1 ? "blocked" : "working" }], shellPanes: [] });
    return fetcher(input, init);
  };
  expect((await handleRequest(request(), config(), race)).status).toBe(409);
  expect(writes).toHaveLength(0);
});

test("permission screens are rejected even when snapshot status lags", async () => {
  const { fetcher, writes } = bridge();
  const guarded: BridgeFetch = async (input, init) => String(input).endsWith("/api/pane/w1:p1")
    ? Response.json({ paneId: pane.paneId, text: "Bash command\n  rm -rf build\nDo you want to proceed?\n❯ 1. Yes\n  2. No\nEsc to cancel · Tab to amend" })
    : fetcher(input, init);
  expect((await handleRequest(request(), config(), guarded)).status).toBe(409);
  expect(writes).toHaveLength(0);
});

test("empty, wrong-pane and failed screens, malformed snapshot and binding-read failure are explicit non-writes", async () => {
  for (const value of [{ paneId: pane.paneId, text: "" }, { paneId: "other", text: screen }, { paneId: pane.paneId, text: screen, truncated: "yes" }, null]) {
    const { fetcher, writes } = bridge();
    const bad: BridgeFetch = async (input, init) => String(input).endsWith("/api/pane/w1:p1") ? Response.json(value) : fetcher(input, init);
    expect(await (await handleRequest(request(), config(), bad)).json()).toMatchObject({ outcome: "not-submitted" });
    expect(writes).toHaveLength(0);
  }
  const { fetcher, writes } = bridge();
  const badSnapshot: BridgeFetch = async (input, init) => String(input).endsWith("/snapshot") ? Response.json(null) : fetcher(input, init);
  expect(await (await handleRequest(request(), config(), badSnapshot)).json()).toMatchObject({ outcome: "not-submitted" });
  expect(writes).toHaveLength(0);
  const failedRead: BridgeFetch = async () => { throw new Error("unavailable"); };
  expect(await (await handleRequest(request(), config(), failedRead)).json()).toMatchObject({ outcome: "not-submitted" });
  const guarded = bridge({ failure: "prompt.read_failed" });
  expect(await (await handleRequest(request(), config(), guarded.fetcher)).json()).toMatchObject({ outcome: "not-submitted" });
});

test("cached pending requests block a control key even when the snapshot no longer reports blocked", async () => {
  const cfg = config();
  const { fetcher, writes } = bridge();
  const pending: BridgeFetch = async (input) => {
    if (String(input).endsWith("/snapshot")) return Response.json({ bridge: "connected", agents: [{ ...pane, status: "blocked" }], shellPanes: [] });
    return Response.json({ paneId: pane.paneId, text: "Bash command\n  rm -rf build\nDo you want to proceed?\n❯ 1. Yes\n  2. No\nEsc to cancel · Tab to amend" });
  };
  const get = Object.assign(new Request("http://localhost:8790/lite/api/requests", { headers: { host: "localhost:8790" } }), { remoteAddress: "127.0.0.1" });
  expect((await (await handleRequest(get, cfg, pending)).json() as unknown[]).length).toBe(1);
  expect((await handleRequest(request(), cfg, fetcher)).status).toBe(409);
  expect(writes).toHaveLength(0);
});

test("unknown writes stay locked and no request is automatically retried", async () => {
  const cfg = config();
  const { fetcher, writes } = bridge({ failure: "throw" });
  const first = await handleRequest(request(), cfg, fetcher);
  expect(await first.json()).toMatchObject({ outcome: "unknown" });
  const second = await handleRequest(request(), cfg, fetcher);
  expect(await second.json()).toMatchObject({ outcome: "unknown" });
  expect(writes).toHaveLength(1);
});

test("concurrent requests cannot enqueue a second key while validation is still in flight", async () => {
  const cfg = config();
  const { fetcher, writes } = bridge();
  let release!: () => void;
  let blocked = false;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const slow: BridgeFetch = async (input, init) => {
    if (!blocked) { blocked = true; await held; }
    return fetcher(input, init);
  };
  const first = handleRequest(request(), cfg, slow);
  expect((await handleRequest(request(), cfg, slow)).status).toBe(429);
  expect(writes).toHaveLength(0);
  release();
  expect((await first).status).toBe(200);
  expect(writes).toHaveLength(1);
});

test("a delayed cancellation and unknown result isolate same-pane text, including after a browser refresh", async () => {
  const cfg = config();
  const { fetcher, writes } = bridge();
  let finish!: () => void;
  let started!: () => void;
  const written = new Promise<void>((resolve) => { started = resolve; });
  const held = new Promise<void>((resolve) => { finish = resolve; });
  let appliedKeys = 0;
  const delayed: BridgeFetch = async (input, init) => {
    if (init?.method === "POST") {
      // Pause after a successful upstream binding check, before the actual key write.
      expect(JSON.parse(String(init.body))).toEqual({ keys: ["ctrl+c"], expected_prompt: screen });
      started();
      await held;
      appliedKeys++;
      throw new Error("late key result lost");
    }
    return fetcher(input, init);
  };
  const key = handleRequest(request(), cfg, delayed);
  await written;
  let replies = 0;
  const textFetcher: BridgeFetch = async () => { replies++; return Response.json({ ok: true }); };
  const reply = () => handleRequest(request({ text: "new instruction", submit: true }, "/lite/api/pane/w1:p1/reply"), cfg, textFetcher);
  expect((await reply()).status).toBe(409);
  expect(replies).toBe(0);
  expect(writes).toHaveLength(0);
  finish();
  expect(await (await key).json()).toMatchObject({ outcome: "unknown" });
  expect(appliedKeys).toBe(1);
  expect(await (await reply()).json()).toMatchObject({ ok: false, textDelivered: false });
  expect(replies).toBe(0);
  expect(writes).toHaveLength(0);
});

test("malformed write response is unknown and validation follows snapshot-screen-snapshot-write", async () => {
  const cfg = config();
  const routes: Array<{ path: string; method: string; login: string | null }> = [];
  const { fetcher, writes } = bridge();
  const traced: BridgeFetch = async (input, init) => {
    routes.push({ path: new URL(String(input)).pathname, method: init?.method ?? "GET", login: new Headers(init?.headers).get("tailscale-user-login") });
    if (init?.method === "POST") { await fetcher(input, init); return new Response("bad json"); }
    return fetcher(input, init);
  };
  const remote = request(undefined, undefined, { host: cfg.tailscaleHost, "tailscale-user-login": "me", origin: `https://${cfg.tailscaleHost}` });
  expect(await (await handleRequest(remote, cfg, traced)).json()).toMatchObject({ outcome: "unknown" });
  expect(routes).toEqual([
    { path: "/api/snapshot", method: "GET", login: "me" },
    { path: "/api/pane/w1:p1", method: "GET", login: "me" },
    { path: "/api/snapshot", method: "GET", login: "me" },
    { path: "/api/pane/w1:p1/keys", method: "POST", login: "me" },
  ]);
  expect(writes).toHaveLength(1);
  expect(await (await handleRequest(request(), cfg, traced)).json()).toMatchObject({ outcome: "unknown" });
  expect(routes).toHaveLength(4);
});

test("binding rejection is definitely not submitted and rapid repeats are throttled", async () => {
  const cfg = config();
  const { fetcher, writes } = bridge({ failure: "prompt_changed" });
  expect(await (await handleRequest(request(), cfg, fetcher)).json()).toMatchObject({ outcome: "not-submitted" });
  expect((await handleRequest(request(), cfg, fetcher)).status).toBe(429);
  expect(writes).toHaveLength(1);
});

test("remote identity, Origin and JSON protections reject before bridge calls", async () => {
  const cfg = config();
  const { fetcher, writes } = bridge();
  const rejectedHeaders: Array<Record<string, string>> = [
    { host: cfg.tailscaleHost, origin: `https://${cfg.tailscaleHost}` },
    { host: cfg.tailscaleHost, "tailscale-user-login": "me" },
    { host: cfg.tailscaleHost, "tailscale-user-login": "me", origin: "https://evil.test" },
    { host: cfg.tailscaleHost, "tailscale-user-login": "me", origin: `https://${cfg.tailscaleHost}`, "content-type": "text/plain" },
  ];
  for (const headers of rejectedHeaders) {
    const response = await handleRequest(request(undefined, undefined, headers), cfg, fetcher);
    expect([401, 403, 415]).toContain(response.status);
  }
  expect(writes).toHaveLength(0);
});
