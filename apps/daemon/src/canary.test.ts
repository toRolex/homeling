import { describe, expect, test } from "bun:test";
import { parseServeStatusRootProxy, parseGitStatusPorcelain } from "./canary.ts";

describe("parseServeStatusRootProxy", () => {
  const protectedAuthority = "rolexdemacbook-air.tail616cc1.ts.net:443";
  test("selects the protected authority with multiple root listeners and fails closed if it disappears", () => {
    const root = (proxy: unknown) => ({ Handlers: { "/": { Proxy: proxy } } });
    const parse = (web: unknown) => parseServeStatusRootProxy(JSON.stringify({ Web: web }), protectedAuthority);
    expect(parse({ [protectedAuthority]: root("http://127.0.0.1:8787"), "rolexdemacbook-air.tail616cc1.ts.net:8443": root("http://127.0.0.1:8790") })).toBe("http://127.0.0.1:8787");
    expect(parse({ "other.ts.net:443": root("http://127.0.0.1:8787"), "rolexdemacbook-air.tail616cc1.ts.net:8443": root("http://127.0.0.1:8787") })).toBeNull();
    for (const proxy of [null, 8787, "", {}, []]) expect(parse({ [protectedAuthority]: root(proxy) })).toBeNull();
    expect(parseServeStatusRootProxy("null", protectedAuthority)).toBeNull();
  });
  test("extracts the / proxy from a real `tailscale serve status --json` payload", () => {
    const payload = `{
      "TCP": { "443": { "HTTPS": true } },
      "Web": {
        "rolexdemacbook-air.tail616cc1.ts.net:443": {
          "Handlers": {
            "/": { "Proxy": "http://127.0.0.1:8787" },
            "/lite/": { "Proxy": "http://127.0.0.1:8790" }
          }
        }
      }
    }`;
    expect(parseServeStatusRootProxy(payload, protectedAuthority)).toBe("http://127.0.0.1:8787");
  });

  test("returns null when no root handler exists", () => {
    const payload = `{"Web":{"h:443":{"Handlers":{"/lite/":{"Proxy":"http://127.0.0.1:8790"}}}}}`;
    expect(parseServeStatusRootProxy(payload, protectedAuthority)).toBeNull();
  });

  test("returns null on malformed JSON", () => {
    expect(parseServeStatusRootProxy("not json", protectedAuthority)).toBeNull();
    expect(parseServeStatusRootProxy("{}", protectedAuthority)).toBeNull();
  });
});

describe("parseGitStatusPorcelain", () => {
  test("empty output is clean", () => {
    expect(parseGitStatusPorcelain("")).toEqual([]);
  });

  test("parses dirty entries", () => {
    const out = " M bridge/server.ts\n?? patches/evil.patch\n";
    expect(parseGitStatusPorcelain(out)).toEqual([" M bridge/server.ts", "?? patches/evil.patch"]);
  });

  test("whitespace-only output is clean", () => {
    expect(parseGitStatusPorcelain("\n\n")).toEqual([]);
  });
});
