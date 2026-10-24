import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { handleUnlockedRequest as handleRequest } from "./session-test-fixture.ts";
import type { BridgeFetch } from "./bridge-proxy.ts";

const ROOT = join(import.meta.dir, ".tmp-server-fixture");
const TAILSCALE_HOST = "rolexdemacbook-air.tail616cc1.ts.net";

const CFG = {
  port: 8790,
  hostname: "127.0.0.1",
  webDist: ROOT,
  indexHtml: "index.html",
  trustedUsers: ["me@github.com"] as readonly string[],
  tailscaleHost: TAILSCALE_HOST,
  publicOrigin: `https://${TAILSCALE_HOST}`,
  allowAnyHost: false,
  bridgeOrigin: "http://127.0.0.1:8787",
  registryPath: "/tmp/homeling-test-registry.json",
  herdrSocketPath: "/tmp/homeling-test-herdr.sock",
};

function req(opts: {
  remoteAddress?: string;
  host?: string;
  login?: string;
  origin?: string;
  path?: string;
  method?: string;
  contentType?: string;
  body?: string;
}): Request & { remoteAddress?: string | null } {
  const headers = new Headers();
  if (opts.host !== undefined) headers.set("host", opts.host);
  if (opts.login !== undefined) headers.set("tailscale-user-login", opts.login);
  if (opts.origin !== undefined) headers.set("origin", opts.origin);
  else if (opts.method && opts.method !== "GET" && opts.remoteAddress === "127.0.0.1" && opts.host === "localhost:8790") {
    headers.set("host", TAILSCALE_HOST);
    headers.set("tailscale-user-login", opts.login ?? "me@github.com");
    headers.set("origin", `https://${TAILSCALE_HOST}`);
  }
  if (opts.contentType !== undefined) headers.set("content-type", opts.contentType);
  return Object.assign(
    new Request(`https://placeholder${opts.path ?? "/lite/"}`, {
      method: opts.method ?? "GET", headers, body: opts.body,
    }),
    { remoteAddress: opts.remoteAddress },
  );
}

beforeAll(async () => {
  await mkdir(ROOT, { recursive: true });
  await writeFile(join(ROOT, "index.html"), "<html>lite-shell</html>");
});

afterAll(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describe("handleRequest — routing", () => {
  test("GET /lite/api/health returns ok for a loopback caller", async () => {
    const res = await handleRequest(req({ remoteAddress: "127.0.0.1", host: "localhost:8790", path: "/lite/api/health" }), CFG);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: "homeling-daemon" });
  });

  test("proxies the full /lite/api path to the allowlisted bridge history route", async () => {
    let target = "";
    const forwardedLogins: Array<string | null> = [];
    const fetcher: BridgeFetch = async (input, init) => {
      target = String(input);
      forwardedLogins.push(new Headers(init?.headers).get("tailscale-user-login"));
      return Response.json({ available: true, entries: [] }, { headers: { etag: "\"history-1\"" } });
    };
    const response = await handleRequest(
      req({ remoteAddress: "127.0.0.1", host: "localhost:8790", login: "me@github.com", path: "/lite/api/pane/w1:p2/history?limit=30" }),
      CFG,
      fetcher,
    );

    expect(response.status).toBe(200);
    expect(target).toBe("http://127.0.0.1:8787/api/pane/w1:p2/history?limit=30");
    expect(forwardedLogins).toEqual(["me@github.com"]);
    expect(response.headers.get("etag")).toBe("\"history-1\"");
  });

  test("GET /lite/api/launchers proxies the bridge's allowlist rows", async () => {
    let target = "";
    const fetcher: BridgeFetch = async (input) => {
      target = String(input);
      return Response.json({ launchers: [{ command: "bun test", label: "Test" }], home: "/home/test" });
    };
    const response = await handleRequest(
      req({ remoteAddress: "127.0.0.1", host: "localhost:8790", path: "/lite/api/launchers" }),
      CFG,
      fetcher,
    );
    expect(response.status).toBe(200);
    expect(target).toBe(`${CFG.bridgeOrigin}/api/launchers`);
    expect(await response.json()).toEqual({ launchers: [{ command: "bun test", label: "Test" }], home: "/home/test" });
  });

  test("proxy rejects writes and paths outside the narrow allowlist", async () => {
    let calls = 0;
    const fetcher: BridgeFetch = async () => { calls += 1; return Response.json({}); };
    const base = { remoteAddress: "127.0.0.1", host: "localhost:8790" };
    const write = await handleRequest(req({ ...base, path: "/lite/api/snapshot", method: "POST" }), CFG, fetcher);
    const forbidden = await handleRequest(req({ ...base, path: "/lite/api/pane/p1/reply" }), CFG, fetcher);
    expect(write.status).toBe(405);
    expect(forbidden.status).toBe(404);
    expect(calls).toBe(0);
  });

  test("POST launch uses same-origin access checks and requires JSON", async () => {
    const body = '{"command":"bun test","paneId":"w1:p2"}';
    const forwarded: Array<{ url: string; body: string }> = [];
    const fetcher: BridgeFetch = async (input, init) => {
      forwarded.push({ url: String(input), body: await new Response(init?.body).text() });
      return Response.json({ ok: true, pane: { paneId: "w2:p1" } });
    };
    const launch = { path: "/lite/api/launch", method: "POST", contentType: "application/json", body };
    const accepted = await handleRequest(req({
      remoteAddress: "127.0.0.1", host: `${TAILSCALE_HOST}:443`, login: "me@github.com",
      origin: `https://${TAILSCALE_HOST}`, ...launch,
    }), CFG, fetcher);
    expect(accepted.status).toBe(200);
    expect(forwarded).toEqual([{ url: `${CFG.bridgeOrigin}/api/launch`, body }]);

    const noOrigin = await handleRequest(req({
      remoteAddress: "127.0.0.1", host: `${TAILSCALE_HOST}:443`, login: "me@github.com",
      ...launch,
    }), CFG, fetcher);
    expect(noOrigin.status).toBe(403);
    const proxyPeerNoOrigin = await handleRequest(req({
      remoteAddress: "127.0.0.1", host: `${TAILSCALE_HOST}:443`, login: "me@github.com", ...launch,
    }), CFG, fetcher);
    expect(proxyPeerNoOrigin.status).toBe(403);
    const wrongMediaType = await handleRequest(req({
      remoteAddress: "127.0.0.1", host: "localhost:8790", ...launch, contentType: "text/plain",
    }), CFG, fetcher);
    expect(wrongMediaType.status).toBe(415);
    expect(forwarded).toHaveLength(1);
  });

  test("POST reply uses same-origin access checks before proxying", async () => {
    const body = '{"text":"hello","submit":true}';
    const forwarded: Array<{ url: string; body: string; method: string }> = [];
    const fetcher: BridgeFetch = async (input, init) => {
      forwarded.push({ url: String(input), body: await new Response(init?.body).text(), method: init?.method ?? "" });
      return Response.json({ ok: true });
    };
    const trusted = await handleRequest(req({
      remoteAddress: "127.0.0.1", host: `${TAILSCALE_HOST}:443`, login: "me@github.com",
      origin: `https://${TAILSCALE_HOST}`, path: "/lite/api/pane/w1:p2/reply", method: "POST",
      contentType: "application/json", body,
    }), CFG, fetcher);
    expect(trusted.status).toBe(200);
    expect(forwarded).toEqual([{ url: `${CFG.bridgeOrigin}/api/pane/w1:p2/reply`, body, method: "POST" }]);
    const crossOrigin = await handleRequest(req({
      remoteAddress: "127.0.0.1", host: `${TAILSCALE_HOST}:443`, login: "me@github.com",
      origin: "https://evil.example", path: "/lite/api/pane/w1:p2/reply", method: "POST",
      contentType: "application/json", body,
    }), CFG, fetcher);
    expect(crossOrigin.status).toBe(403);
    expect(forwarded).toHaveLength(1);
  });

  test("reply requires the tailnet Origin even for direct loopback", async () => {
    let calls = 0;
    const fetcher: BridgeFetch = async () => { calls += 1; return Response.json({ ok: true }); };
    const reply = { path: "/lite/api/pane/w1:p2/reply", method: "POST", contentType: "application/json", body: '{"text":"hi"}' };
    const forwardedPeerNoOrigin = await handleRequest(req({
      remoteAddress: "127.0.0.1", host: `${TAILSCALE_HOST}:443`, login: "me@github.com", ...reply,
    }), CFG, fetcher);
    expect(forwardedPeerNoOrigin.status).toBe(403);

    const forwardedPeerWrongOrigin = await handleRequest(req({
      remoteAddress: "127.0.0.1", host: `${TAILSCALE_HOST}:443`, login: "me@github.com",
      origin: "https://localhost:8790", ...reply,
    }), CFG, fetcher);
    expect(forwardedPeerWrongOrigin.status).toBe(403);
    for (const origin of [`http://${TAILSCALE_HOST}`, `https://${TAILSCALE_HOST}:444`]) {
      const mismatchedOrigin = await handleRequest(req({
        remoteAddress: "127.0.0.1", host: `${TAILSCALE_HOST}:443`, login: "me@github.com", origin, ...reply,
      }), CFG, fetcher);
      expect(mismatchedOrigin.status).toBe(403);
    }

    const directLoopback = await handleRequest(req({
      remoteAddress: "127.0.0.1", host: "localhost:8790", origin: "", ...reply,
    }), CFG, fetcher);
    expect(directLoopback.status).toBe(403);
    expect(calls).toBe(0);
  });

  test("GET /lite/ serves the SPA index", async () => {
    const res = await handleRequest(req({ remoteAddress: "127.0.0.1", host: "localhost:8790", path: "/lite/" }), CFG);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<html>lite-shell</html>");
  });

  test("deep link /lite/personas/1 falls back to the SPA index", async () => {
    const res = await handleRequest(req({ remoteAddress: "127.0.0.1", host: "localhost:8790", path: "/lite/personas/1" }), CFG);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<html>lite-shell</html>");
  });

  test("unauthenticated non-loopback /lite/ is rejected with 401 (fail-closed)", async () => {
    const res = await handleRequest(
      req({ remoteAddress: "100.64.0.9", host: `${TAILSCALE_HOST}:443`, path: "/lite/" }),
      CFG,
    );
    expect(res.status).toBe(401);
  });

  test("unauthenticated non-loopback health is also rejected (no anonymous probe)", async () => {
    const res = await handleRequest(
      req({ remoteAddress: "100.64.0.9", host: `${TAILSCALE_HOST}:443`, path: "/lite/api/health" }),
      CFG,
    );
    expect(res.status).toBe(401);
  });

  test("trusted identity can fetch /lite/ over the tailscale host", async () => {
    const res = await handleRequest(
      req({ remoteAddress: "127.0.0.1", host: `${TAILSCALE_HOST}:443`, login: "me@github.com", path: "/lite/" }),
      CFG,
    );
    expect(res.status).toBe(200);
  });
});
