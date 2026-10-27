import { expect, test } from "bun:test";

for (const concurrency of [1, 8]) {
  test(`missing socket survives ${concurrency} concurrent requests and background recovery in a child process`, async () => {
    const source = (file: string) => JSON.stringify(`${import.meta.dir}/${file}.ts`);
    const program = `
      import { mkdtemp, rm } from "node:fs/promises";
      import { join } from "node:path";
      import { tmpdir } from "node:os";
      import { handleRequest } from ${source("index")};
      import { HerdrSocketClient } from ${source("herdr-client")};
      import { PersonaRegistry } from ${source("persona-registry")};
      import { ActivityLedger } from ${source("activity-ledger")};
      import { createActivityObserver } from ${source("activity-observer")};
      import { recoverPersonas, createEventObserver } from ${source("persona-service")};
      import { createDaemonSystemAdmissions } from ${source("system-admission")};
      const root = await mkdtemp(join(tmpdir(), "homeling-containment-"));
      const cfg = {
        sessionMode: "tailscale-identity", port: 8790, hostname: "127.0.0.1",
        webDist: root, indexHtml: "index.html", trustedUsers: ["fixture@example.test"],
        tailscaleHost: "fixture.ts.net", publicOrigin: "https://fixture.ts.net",
        allowAnyHost: false, bridgeOrigin: "http://127.0.0.1:1",
        registryPath: join(root, "registry.json"), herdrSocketPath: join(root, "missing.sock"),
      };
      const runtime = {
        cfg, registry: new PersonaRegistry(cfg.registryPath),
        activity: new ActivityLedger(join(root, "activity.json")),
        herdr: new HerdrSocketClient({ socketPath: cfg.herdrSocketPath, timeoutMs: 100 }),
        fetcher: async () => Response.json({ bridge: "connected", agents: [], shellPanes: [], launchers: [] }),
      };
      await runtime.registry.createPersona({ id: "fixture", name: "Fixture", avatar: { color: "#123456" },
        spaceId: "fixture-space", mainPaneId: "fixture-pane", systemPrompt: "", createdAt: "2026-01-01T00:00:00.000Z" });
      const caps = createDaemonSystemAdmissions();
      const observer = createActivityObserver(runtime.activity, runtime.herdr, caps.activityObserve, { retryMs: 20 });
      const events = createEventObserver(runtime, caps.personaRecovery);
      const request = (path, init = {}) => handleRequest(Object.assign(new Request(cfg.publicOrigin + path, {
        ...init, headers: { host: "fixture.ts.net", "tailscale-user-login": "fixture@example.test",
          origin: cfg.publicOrigin, "content-type": "application/json" },
      }), { remoteAddress: "127.0.0.1" }), cfg, runtime.fetcher, runtime);
      try {
        const recovery = recoverPersonas(runtime, caps.personaRecovery).then(() => "unexpected", error => error.code);
        const client = await Promise.all(Array.from({ length: ${concurrency} }, () =>
          runtime.herdr.snapshot().then(() => "unexpected", error => error.code)));
        const [established, lists] = await Promise.all([
          request("/lite/api/session/establish", { method: "POST", body: "{}" }),
          Promise.all(Array.from({ length: ${concurrency} }, async () => {
            const response = await request("/lite/api/persona/list");
            return { status: response.status, body: await response.json() };
          })),
        ]);
        const catchup = await Promise.all(["session", "requests", "snapshot", "launchers"].map(async path =>
          (await request("/lite/api/" + path)).status));
        await new Promise(resolve => setTimeout(resolve, 100));
        console.log(JSON.stringify({ client, recovery: await recovery, established: established.status, lists, catchup, survived: true }));
      } finally {
        observer.close(); events.close(); await rm(root, { recursive: true, force: true });
      }
    `;
    const child = Bun.spawn([process.execPath, "-e", program], { stdout: "pipe", stderr: "pipe", timeout: 5_000 });
    const [exit, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect(exit).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      client: Array(concurrency).fill("herdr.unavailable"),
      recovery: "herdr.unavailable",
      established: 200,
      lists: Array(concurrency).fill({ status: 502, body: { error: "Herdr snapshot unavailable", code: "herdr.unavailable" } }),
      catchup: [200, 200, 200, 200],
      survived: true,
    });
    const diagnostics = stderr.split("\n").filter(Boolean);
    expect(diagnostics).toContain("[homeling-daemon] activity observation unavailable");
    expect(diagnostics.every(line => line === "[homeling-daemon] activity observation unavailable")).toBe(true);
  });
}
