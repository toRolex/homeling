import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

describe("documented deployment commands", () => {
  test.each([false, true])("installer persists access configuration without changing Collie (existing agent: %s)", async (existingAgent) => {
    const home = await mkdtemp(join(tmpdir(), "homeling-deployment-"));
    try {
      const bin = join(home, "bin");
      const collie = join(home, ".local/share/collie");
      const agentDir = join(home, "Library/LaunchAgents");
      await mkdir(bin, { recursive: true });
      await mkdir(join(collie, "bin"), { recursive: true });
      if (existingAgent) {
        await mkdir(agentDir, { recursive: true });
        await writeFile(join(agentDir, "herdr.collie.plist"), "protected Collie agent");
      }
      const collieBinary = join(collie, "bin/collie");
      await writeFile(collieBinary, "protected Collie binary");
      await writeFile(join(bin, "bun"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      await writeFile(join(bin, "launchctl"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HOME/launchctl-calls"\n', { mode: 0o755 });
      const process = Bun.spawn(["bash", join(root, "scripts/install-launchd.sh")], {
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          HOME: home,
          HOMELING_REPO: root,
          HOMELING_PORT: "8790",
          HOMELING_TRUSTED_USERS: "test@example.com,second@example.com",
          HOMELING_TAILSCALE_HOST: "test-mac.tail0000.ts.net",
          HOMELING_PUBLIC_ORIGIN: "https://test-mac.tail0000.ts.net:8443",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()]);
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
      const plist = await readFile(join(agentDir, "com.homeling.daemon.plist"), "utf8");
      expect(plist).toContain(`<string>${bin}/bun</string>`);
      expect(plist).toContain(`<string>${root}/apps/daemon/src/index.ts</string>`);
      expect(plist).toContain("<key>HOMELING_PORT</key><string>8790</string>");
      expect(plist).toContain("<key>HOMELING_TRUSTED_USERS</key><string>test@example.com,second@example.com</string>");
      expect(plist).toContain("<key>HOMELING_TAILSCALE_HOST</key><string>test-mac.tail0000.ts.net</string>");
      expect(plist).toContain("<key>HOMELING_PUBLIC_ORIGIN</key><string>https://test-mac.tail0000.ts.net:8443</string>");
      expect(plist).toContain("<key>KeepAlive</key><true/>");
      const calls = await readFile(join(home, "launchctl-calls"), "utf8");
      expect(calls).toContain("/com.homeling.daemon");
      expect(calls).toContain(`bootstrap gui/`);
      expect(calls).not.toContain("herdr.collie");
      expect(await readFile(collieBinary, "utf8")).toBe("protected Collie binary");
      if (existingAgent) {
        expect(await readFile(join(agentDir, "herdr.collie.plist"), "utf8")).toBe("protected Collie agent");
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
  test.each(["native", "gnu-fallback"])("actual canary shell checks the saved protected listener and refuses missing or switched keys (%s stat)", async (statFlavor) => {
    const home = await mkdtemp(join(tmpdir(), "homeling-canary-entry-"));
    try {
      const bin = join(home, "bin"), collie = join(home, "collie"), state = join(home, "baseline.env");
      await mkdir(bin); await mkdir(join(collie, "bin"), { recursive: true });
      await writeFile(join(collie, "bin/collie"), "protected binary");
      await writeFile(join(bin, "git"), '#!/bin/sh\ncase "$3" in rev-parse) printf "abc123\\n";; status) [ "${FAKE_GIT_FAILED:-0}" = 0 ] || exit 1; printf "%s" "${FAKE_GIT_DIRTY:-}";; *) exit 2;; esac\n', { mode: 0o755 });
      await writeFile(join(bin, "tailscale"), '#!/bin/sh\nprintf "%s" "$FAKE_SERVE"\n', { mode: 0o755 });
      await writeFile(join(bin, "bun"), `#!/bin/sh\nexec '${process.execPath}' --no-env-file "$@"\n`, { mode: 0o755 });
      if (statFlavor === "gnu-fallback") await writeFile(join(bin, "stat"), '#!/bin/sh\ncase "$1" in\n  -f) count=0; [ ! -f "$HOME/stat-probes" ] || read -r count < "$HOME/stat-probes"; count=$((count + 1)); printf "%s\\n" "$count" > "$HOME/stat-probes"; printf "filesystem probe %s\\n" "$count"; exit 1;;\n  -c) printf "1700000000\\n";;\n  *) exit 2;;\nesac\n', { mode: 0o755 });
      const base = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, COLLIE_DIR: collie, HOMELING_CANARY_STATE: state, HOMELING_CANARY_SERVE_AUTHORITY: "node:443", FAKE_SERVE: JSON.stringify({ Web: { "node:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8787" } } } } }) };
      const run = async (action: string, extra = {}) => {
        const child = Bun.spawn(["bash", join(root, "scripts/canary.sh"), action], { env: { ...base, ...extra }, stdout: "pipe", stderr: "pipe" });
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); return { code, stdout, stderr };
      };
      const saved = await run("save");
      expect({ code: saved.code, diagnostic: saved.code === 0 ? "" : saved.stdout + saved.stderr }).toEqual({ code: 0, diagnostic: "" });
      const original = await readFile(state, "utf8");
      expect(original).toMatch(/^COLLIE_BIN='[0-9]+ [a-f0-9]{64}'$/m);
      expect(original).toContain("SERVE_AUTHORITY='node:443'");
      const dual = JSON.stringify({ Web: { "node:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8787" } } }, "node:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8790" } } } } });
      expect((await run("save", { FAKE_SERVE: dual })).code).toBe(0);
      expect((await run("check", { FAKE_SERVE: dual, HOMELING_CANARY_SERVE_AUTHORITY: "" })).code).toBe(0);
      expect((await run("check", { FAKE_SERVE: dual, HOMELING_CANARY_SERVE_AUTHORITY: "other:443" })).code).toBe(1);
      expect((await run("save", { HOMELING_CANARY_SERVE_AUTHORITY: "" })).code).toBe(1);
      expect((await run("save", { HOMELING_CANARY_SERVE_AUTHORITY: "node:8443" })).code).toBe(1);
      for (const web of [
        { "node:8443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8787" } } } },
        { "other:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8787" } } } },
        { "node:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:8790" } } } },
        { "node:443": { Handlers: { "/": { Proxy: 8787 } } } },
      ]) expect((await run("check", { FAKE_SERVE: JSON.stringify({ Web: web }) })).code).toBe(1);
      expect((await run("check", { FAKE_SERVE: "not JSON" })).code).toBe(1);
      await writeFile(state, original.replace("SERVE_AUTHORITY='node:443'\n", ""));
      expect((await run("check")).code).toBe(1);
      await writeFile(state, original);
      const normal = await run("check");
      expect({ code: normal.code, diagnostic: normal.code === 0 ? "" : normal.stdout + normal.stderr }).toEqual({ code: 0, diagnostic: "" });
      expect((await run("check", { FAKE_GIT_DIRTY: " M tracked.txt" })).code).toBe(1);
      expect((await run("check", { FAKE_GIT_FAILED: "1" })).code).toBe(1);
      const ambiguous = JSON.stringify({ Web: { a: { Handlers: { "/": { Proxy: "http://127.0.0.1:8787" } } }, b: { Handlers: { "/": { Proxy: "http://127.0.0.1:8787" } } } } });
      expect((await run("check", { FAKE_SERVE: ambiguous })).code).toBe(1);
      expect((await run("check", { FAKE_SERVE: "{}" })).code).toBe(1);
      await writeFile(join(collie, "bin/collie"), "changed binary");
      expect((await run("check")).code).toBe(1);
      expect(await readFile(state, "utf8")).toBe(original);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  test("README commands resolve to repository scripts and CI checks", async () => {
    const readme = await Bun.file(join(root, "README.md")).text();
    const commands = [...readme.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1]!).join("\n");
    const scripts = [...commands.matchAll(/bash (scripts\/[\w-]+\.sh)/g)].map((match) => match[1]!);
    expect(scripts).toContain("scripts/install-launchd.sh");
    expect(scripts).toContain("scripts/build-web.sh");
    expect(scripts).toContain("scripts/canary.sh");
    for (const script of scripts) expect(existsSync(join(root, script))).toBe(true);

    const pkg = await Bun.file(join(root, "package.json")).json();
    const ci = await Bun.file(join(root, ".github/workflows/ci.yml")).text();
    for (const command of ["bun install --frozen-lockfile", "bun run typecheck", "bun test", "bun run build"]) {
      expect(commands).toContain(command);
      expect(ci).toContain(`run: ${command}`);
    }
    for (const match of commands.matchAll(/^bun run ([\w:-]+)$/gm)) {
      expect(pkg.scripts[match[1]!]).toBeDefined();
    }
    expect(commands).toContain("tailscale serve --bg --https=8443 http://127.0.0.1:8790");
    expect(commands).toContain("tailscale serve --https=8443 off");
    expect(commands).not.toMatch(/tailscale (?:serve reset|funnel)/);
    expect(commands).not.toContain("install:launchd");
  });
});
