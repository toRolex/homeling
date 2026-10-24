import { describe, expect, test } from "bun:test";
import { daemonConfigFromEnv } from "./config.ts";
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

describe("daemonConfigFromEnv", () => {
  function withEnv(env: Record<string, string>, fn: () => void) {
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(env)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    try {
      fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  test("defaults: loopback 8790, apps/web/dist, no trusted users yet", () => {
    withEnv({}, () => {
      const c = daemonConfigFromEnv({});
      expect(c.port).toBe(8790);
      expect(c.webDist.endsWith("apps/web/dist")).toBe(true);
      expect(c.trustedUsers).toEqual([]);
      expect(c.tailscaleHost).toBe("");
      expect(c.allowAnyHost).toBe(false);
    });
  });

  test("env overrides: port, web dist, trusted users, tailscale host", () => {
    withEnv(
      {
        HOMELING_PORT: "9000",
        HOMELING_WEB_DIST: "/srv/web",
        HOMELING_TRUSTED_USERS: "a@x.com, b@x.com",
        HOMELING_TAILSCALE_HOST: "host.tail1234.ts.net",
        HOMELING_ALLOW_ANY_HOST: "1",
      },
      () => {
        const c = daemonConfigFromEnv({});
        expect(c.port).toBe(9000);
        expect(c.webDist).toBe("/srv/web");
        expect(c.trustedUsers).toEqual(["a@x.com", "b@x.com"]);
        expect(c.tailscaleHost).toBe("host.tail1234.ts.net");
        expect(c.allowAnyHost).toBe(true);
      },
    );
  });

  test("memory uses a dedicated Homeling data directory with an explicit override", () => {
    const c = daemonConfigFromEnv({ HOMELING_MEMORY_DIR: "/srv/homeling/memory" });
    expect(c.memoryPath).toBe("/srv/homeling/memory");
    expect(daemonConfigFromEnv({ HOMELING_DATA_DIR: "/srv/homeling" }).memoryPath).toBe("/srv/homeling/memory");
  });

  test("registry and Herdr socket paths are configurable", () => {
    const c = daemonConfigFromEnv({ HOMELING_REGISTRY_PATH: "/tmp/registry.json", HERDR_SOCKET_PATH: "/tmp/herdr.sock" });
    expect(c.registryPath).toBe("/tmp/registry.json");
    expect(c.herdrSocketPath).toBe("/tmp/herdr.sock");
  });

  test('push secrets/state must stay in an absolute directory outside both repository and Collie', () => {
    expect(() => daemonConfigFromEnv({ HOMELING_PUSH_DIR: 'push-data' })).toThrow(/absolute/);
    expect(() => daemonConfigFromEnv({ HOMELING_PUSH_DIR: resolve(import.meta.dir, '../../..', '.private-push') })).toThrow(/outside/);
    expect(() => daemonConfigFromEnv({ HOMELING_PUSH_DIR: join(homedir(), '.local/share/collie/push') })).toThrow(/outside/);
    expect(daemonConfigFromEnv({ HOMELING_PUSH_DIR: '/tmp/homeling-external-push', HOMELING_PUSH_SUBJECT: 'mailto:test@example.com' })).toMatchObject({ pushDataDir: '/tmp/homeling-external-push', pushSubject: 'mailto:test@example.com' });
  });

  test("explicit env object wins over process.env", () => {
    withEnv({ HOMELING_PORT: "9001" }, () => {
      const c = daemonConfigFromEnv({ HOMELING_PORT: "9002" });
      expect(c.port).toBe(9002);
    });
  });

  test("public origin is canonical and defaults to HTTPS 443 without blocking local startup", () => {
    const base = { HOMELING_TAILSCALE_HOST: "home.ts.net", HOMELING_PUBLIC_ORIGIN: "" };
    expect(daemonConfigFromEnv(base)).toMatchObject({ publicOrigin: "https://home.ts.net" });
    expect(daemonConfigFromEnv({ ...base, HOMELING_TAILSCALE_HOST: "" })).toMatchObject({ publicOrigin: "" });
    for (const origin of ["https://HOME.ts.net:443/", "https://home.ts.net"]) {
      expect(daemonConfigFromEnv({ ...base, HOMELING_PUBLIC_ORIGIN: origin })).toMatchObject({ publicOrigin: "https://home.ts.net" });
    }
    expect(daemonConfigFromEnv({ ...base, HOMELING_PUBLIC_ORIGIN: "https://home.ts.net:8443/" })).toMatchObject({ publicOrigin: "https://home.ts.net:8443" });
  });

  test("explicit public origin rejects malformed or mismatched front doors", () => {
    for (const origin of ["not a URL", "http://home.ts.net:8443", "https://other.ts.net:8443", "https://alice@home.ts.net", "https://home.ts.net/lite/", "https://home.ts.net/?x=1", "https://home.ts.net/#x"]) {
      expect(() => daemonConfigFromEnv({ HOMELING_TAILSCALE_HOST: "home.ts.net", HOMELING_PUBLIC_ORIGIN: origin })).toThrow(/HOMELING_PUBLIC_ORIGIN/);
    }
    expect(() => daemonConfigFromEnv({ HOMELING_TAILSCALE_HOST: "", HOMELING_PUBLIC_ORIGIN: "https://home.ts.net:8443" })).toThrow(/HOMELING_PUBLIC_ORIGIN/);
  });

  test("invalid port falls back to default", () => {
    const c = daemonConfigFromEnv({ HOMELING_PORT: "not-a-port" });
    expect(c.port).toBe(8790);
  });

  test("bridge origin must remain a loopback HTTP origin", () => {
    expect(() => daemonConfigFromEnv({ HOMELING_BRIDGE_ORIGIN: "https://bridge.example.com" })).toThrow(/loopback HTTP origin/);
    expect(() => daemonConfigFromEnv({ HOMELING_BRIDGE_ORIGIN: "http://127.0.0.1:8787/api" })).toThrow(/loopback HTTP origin/);
    expect(daemonConfigFromEnv({ HOMELING_BRIDGE_ORIGIN: "http://127.0.0.2:8788/" }).bridgeOrigin).toBe("http://127.0.0.2:8788");
  });
});
