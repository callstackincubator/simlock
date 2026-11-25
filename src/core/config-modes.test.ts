import { describe, expect, it, vi } from "vitest";
import { MemoryFilesystem } from "../ports/index.js";
import { loadConfig } from "./index.js";
import { configPath, createStats } from "./test-config.js";

describe("loadConfig modes (ADR 0005)", () => {
  async function load(
    contents: unknown,
    options: {
      readonly overrides?: Parameters<typeof loadConfig>[0]["overrides"];
      readonly role?: "worker" | "gateway";
      readonly warn?: (message: string) => void;
    } = {},
  ) {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock");
    await filesystem.writeFileAtomic(configPath, JSON.stringify(contents));
    return loadConfig({
      configPath,
      filesystem,
      systemStats: createStats(),
      ...(options.role === undefined ? {} : { role: options.role }),
      ...(options.overrides === undefined ? {} : { overrides: options.overrides }),
      ...(options.warn === undefined ? {} : { warn: options.warn }),
    });
  }

  it("defaults to worker mode, with HTTP on and a 24h disconnected-view retention", async () => {
    const config = await load({});

    expect(config.mode).toBe("worker");
    expect(config.http.enabled).toBe(true);
    expect(config.gateway).toEqual({
      disconnectedRetentionMs: 24 * 60 * 60_000,
      execTimeoutMs: 11 * 60_000,
      leaseRequestTimeoutMs: 5 * 60_000,
      routing: "warm-then-free",
      alerts: { destinations: [] },
      admission: { timeoutMs: 5_000 },
    });
  });

  it("an operator's gateway.admission.command and gateway.admission.timeoutMs are checked at load: an argv list is read, an empty list, an empty string or text is refused, the timeout defaults to 5000, and 0 or over 60000 is refused", async () => {
    const admission = (written: unknown) => load({ gateway: { admission: written } });
    const argument = (length: number) => "a".repeat(length);

    const read = await admission({ command: ["bun", "/etc/simlock/policy.ts"], timeoutMs: 60_000 });
    expect(read.gateway.admission).toEqual({
      command: ["bun", "/etc/simlock/policy.ts"],
      timeoutMs: 60_000,
    });
    expect((await admission({ command: [argument(4096)] })).gateway.admission?.timeoutMs).toBe(
      5_000,
    );
    expect((await load({})).gateway.admission).toEqual({ timeoutMs: 5_000 });

    const refused = [
      [{ command: [] }, "gateway.admission.command"],
      [{ command: ["bun", ""] }, "gateway.admission.command"],
      [{ command: "bun policy.ts" }, "gateway.admission.command"],
      [{ command: [argument(4097)] }, "gateway.admission.command"],
      [{ command: Array.from({ length: 65 }, () => "a") }, "gateway.admission.command"],
      [{ timeoutMs: 0 }, "gateway.admission.timeoutMs"],
      [{ timeoutMs: 60_001 }, "gateway.admission.timeoutMs"],
      [{ timeoutMs: 1.5 }, "gateway.admission.timeoutMs"],
    ] as const;
    for (const [written, key] of refused) {
      await expect(admission(written), JSON.stringify(written)).rejects.toThrow(key);
    }
  });

  it.each([
    ["file worker", { contents: { mode: "worker" } }],
    ["file gateway", { contents: { mode: "gateway" } }],
    ["override gateway", { contents: {}, overrides: { mode: "gateway" } }],
  ] as const)(
    "refuses a config that sets mode, either value, from the file or the overrides, with the message that names --gateway (%s)",
    async (_name, { contents, ...options }) => {
      await expect(load(contents, options)).rejects.toThrow(
        '"mode" is no longer a config key. A daemon started with --gateway is a gateway; any other is a worker. Remove "mode" from config.json.',
      );
    },
  );

  it("turns HTTP on by default in gateway mode -- a gateway is the fleet's contact point", async () => {
    const config = await load({}, { role: "gateway" });

    expect(config.http.enabled).toBe(true);
    expect(config.http.port).toBe(4700);
  });

  it("refuses a gateway that switches HTTP off, naming the key, and loads a worker that does", async () => {
    await expect(load({ http: { enabled: false } }, { role: "gateway" })).rejects.toThrow(
      "http.enabled",
    );
    await expect(load({ http: { enabled: false } })).resolves.toMatchObject({
      http: { enabled: false },
      mode: "worker",
    });
  });

  it("keeps an explicit gateway http host/port", async () => {
    const config = await load({ http: { host: "0.0.0.0", port: 4800 } }, { role: "gateway" });

    expect(config.http).toEqual({ enabled: true, host: "0.0.0.0", port: 4800 });
  });

  it("warns about worker-only keys in a gateway's config and ignores them", async () => {
    const warn = vi.fn();
    const config = await load(
      {
        capacity: { strategy: "fixed", config: { maxRunning: 3 } },
        ios: { defaultMode: "slim" },
        lease: { defaultTtlMs: 60_000 },
      },
      { role: "gateway", warn },
    );

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Ignoring "capacity"'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Ignoring "ios"'));
    expect(config.lease.defaultTtlMs).toBe(60_000);
    // why: "Ignored" means "nothing in gateway mode reads it" -- the value is still parsed and
    // merged, so a config file can be shared between a worker and a gateway with only `mode`
    // differing. The warning is what makes that visible rather than silent.
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('Ignoring "lease"'));
  });

  it("reads lease.maxPerRequester in gateway mode without an ignored-key warning", async () => {
    const warn = vi.fn();

    const config = await load({ lease: { maxPerRequester: 2 } }, { role: "gateway", warn });

    expect(config.lease).toMatchObject({ maxPerRequester: 2 });
    expect(warn).not.toHaveBeenCalled();
  });

  it("reads metrics.retention in a gateway config without a warning", async () => {
    const warn = vi.fn();

    const config = await load(
      { metrics: { retention: 120 * 24 * 3_600_000 } },
      { role: "gateway", warn },
    );

    expect(config.metrics).toEqual({ retention: 120 * 24 * 3_600_000 });
    expect(warn).not.toHaveBeenCalled();
  });

  it("reads update.check in a gateway config without a warning", async () => {
    const warn = vi.fn();

    const config = await load({ update: { check: false } }, { role: "gateway", warn });

    expect(config.update).toEqual({ check: false });
    expect(warn).not.toHaveBeenCalled();
  });

  it("raises the unknown-key warning for eventLog.rotateBytes in a gateway config", async () => {
    const warn = vi.fn();
    await load({ eventLog: { rotateBytes: 1024 } }, { role: "gateway", warn });

    expect(warn).toHaveBeenCalledWith('Unknown config key: "eventLog.rotateBytes"');
  });

  it("warns about android.emulator on a gateway without refusing the config", async () => {
    const warn = vi.fn();
    const config = await load(
      { android: { defaultModels: {}, emulator: { headless: true } } },
      { role: "gateway", warn },
    );

    expect(warn).toHaveBeenCalledWith(
      'Ignoring "android": it configures a worker, and this daemon runs in gateway mode.',
    );
    expect(config.mode).toBe("gateway");
  });

  it("warns about the worker-side gateway.* keys on a gateway, but not the gateway's own", async () => {
    const warn = vi.fn();
    const config = await load(
      {
        gateway: {
          url: "ws://127.0.0.1:4700/v1/uplink",
          token: "secret",
          label: "ignored",
          disconnectedRetentionMs: 60_000,
        },
      },
      { role: "gateway" },
    );

    expect(config.gateway.disconnectedRetentionMs).toBe(60_000);

    const warned = await load(
      { gateway: { url: "ws://127.0.0.1:4700/v1/uplink" } },
      { role: "gateway", warn },
    );
    expect(warned.mode).toBe("gateway");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Ignoring "gateway.url"'));
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining('Ignoring "gateway.disconnectedRetentionMs"'),
    );

    const withHeaders = vi.fn();
    await load({ gateway: { headers: { "x-a": "1" } } }, { role: "gateway", warn: withHeaders });
    expect(withHeaders.mock.calls.map(([message]) => message)).toEqual([
      expect.stringContaining('Ignoring "gateway.headers"'),
    ]);
    const withoutHeaders = vi.fn();
    await load(
      { gateway: { disconnectedRetentionMs: 60_000 } },
      { role: "gateway", warn: withoutHeaders },
    );
    expect(withoutHeaders).not.toHaveBeenCalled();
  });

  it("says nothing about worker keys on a worker, which is every daemon today", async () => {
    const warn = vi.fn();
    await load({ capacity: { strategy: "fixed", config: { maxRunning: 3 } } }, { warn });

    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps a worker's gateway.url/token/label", async () => {
    const config = await load({
      gateway: { url: "wss://fleet.example", token: "join-secret", label: "mac-1" },
    });

    expect(config.gateway.url).toBe("wss://fleet.example");
    expect(config.gateway.token).toBe("join-secret");
    expect(config.gateway.label).toBe("mac-1");
  });

  it("refuses a worker that names a gateway but no join token, and the reverse", async () => {
    // why: Either alone is an operator half-finishing a join, and a worker that silently never
    // joined looks exactly like one whose gateway is down -- so this fails the start instead.
    await expect(load({ gateway: { url: "ws://fleet.example" } })).rejects.toThrow("gateway.token");
    await expect(load({ gateway: { token: "join-secret" } })).rejects.toThrow("gateway.url");
  });

  it("stops the load on a bad gateway.headers with the message naming it, and keeps every accepted row", async () => {
    const key = (what: string) => `Invalid config value for "gateway.headers": expected ${what}`;
    const shape = "an object of header names to text values";
    const joined = { url: "wss://fleet.example", token: "join-secret" };
    const many = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`x-h${i}`, "v"]));
    const fat = Object.fromEntries(
      Array.from({ length: 3 }, (_, i) => [`x-h${i}`, "a".repeat(3000)]),
    );
    const refused: readonly (readonly [string, unknown, string])[] = [
      ["an array", ["a"], shape],
      ["a non-text value", { "x-ok": 1 }, shape],
      ["17 entries", many, "at most 16 headers"],
      [
        "a name with a space",
        { "X Bad": "v" },
        "a header name of 1 to 100 letters, digits and HTTP name symbols (got X Bad)",
      ],
      [
        "an empty name",
        { "": "x" },
        "a header name of 1 to 100 letters, digits and HTTP name symbols (got )",
      ],
      [
        "a 101-character name",
        { ["a".repeat(101)]: "v" },
        `a header name of 1 to 100 letters, digits and HTTP name symbols (got ${"a".repeat(101)})`,
      ],
      ["one name twice", { "X-A": "1", "x-a": "2" }, "each header name once (got x-a twice)"],
      [
        "a line break",
        { "x-ok": "line\nbreak" },
        "a header value of at most 4096 plain ASCII characters (in x-ok)",
      ],
      [
        "a non-ASCII value",
        { "x-ok": "café" },
        "a header value of at most 4096 plain ASCII characters (in x-ok)",
      ],
      [
        "a 4097-character value",
        { "x-ok": "a".repeat(4097) },
        "a header value of at most 4096 plain ASCII characters (in x-ok)",
      ],
      ["over 8192 in all", fat, "at most 8192 characters of header names and values in all"],
      [
        "8193 in all",
        { "x-a": "a".repeat(4096), "x-b": "b".repeat(4091) },
        "at most 8192 characters of header names and values in all",
      ],
      ...[
        "authorization",
        "x-simlock-worker-id",
        "x-simlock-worker-label",
        "host",
        "connection",
        "upgrade",
        "origin",
      ].map((name): readonly [string, unknown, string] => [
        `${name} in capitals`,
        { [name.toUpperCase()]: "x" },
        `no header Simlock sets itself (${name.toUpperCase()})`,
      ]),
      ["Authorization", { Authorization: "x" }, "no header Simlock sets itself (Authorization)"],
      [
        "a sec-websocket- name",
        { "Sec-WebSocket-Key": "x" },
        "no header Simlock sets itself (Sec-WebSocket-Key)",
      ],
    ];
    for (const role of ["worker", "gateway"] as const) {
      for (const [name, headers, what] of refused) {
        await expect(
          load({ gateway: { ...joined, headers } }, { role }),
          `${role}: ${name}`,
        ).rejects.toThrow(key(what));
      }
    }
    // why: the edge itself is accepted, so moving a cap by one fails a named row.
    const sixteen = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`x-h${i}`, "v"]));
    const longestName = { ["a".repeat(100)]: "v" };
    for (const headers of [sixteen, longestName]) {
      await expect(load({ gateway: { ...joined, headers } })).resolves.toBeDefined();
    }
    await expect(load({ gateway: { headers: { "x-a": "1" } } })).rejects.toThrow(
      key("gateway.url to be set too, since gateway.headers is set"),
    );
    await expect(load({ gateway: { token: "t", headers: { "x-a": "1" } } })).rejects.toThrow(
      'Invalid config value for "gateway.url": expected a gateway URL, since gateway.token is set',
    );

    const exactly8192 = { "x-a": "a".repeat(4096), "x-b": "b".repeat(4090) };
    expect((await load({ gateway: { ...joined, headers: exactly8192 } })).gateway.headers).toEqual(
      exactly8192,
    );
    const accepted = { "CF-Access-Client-Id": "abc.access", "x-empty": "", "x-tab": "a\tb" };
    expect((await load({ gateway: { ...joined, headers: accepted } })).gateway.headers).toEqual(
      accepted,
    );
    expect((await load({ gateway: { headers: {} } })).gateway.url).toBeUndefined();
  });

  it("refuses a joined worker's own HTTP listener with the exact error, and keeps every valid and invalid neighbour as it was", async () => {
    const refusal =
      'Invalid config value for "http.enabled": expected false when gateway.url is set (joined workers are reached through the gateway)';
    const joined = { url: "wss://fleet.example", token: "join-secret" };
    type Case = {
      readonly name: string;
      readonly contents: Record<string, unknown>;
      readonly overrides?: Parameters<typeof loadConfig>[0]["overrides"];
      readonly role?: "worker" | "gateway";
      readonly error?: string;
      readonly http?: boolean;
    };
    const cases: readonly Case[] = [
      { name: "file only", contents: { gateway: joined, http: { enabled: true } }, error: refusal },
      {
        name: "overrides only",
        contents: {},
        overrides: { gateway: joined, http: { enabled: true } },
        error: refusal,
      },
      {
        name: "membership in file, HTTP in overrides",
        contents: { gateway: joined },
        overrides: { http: { enabled: true } },
        error: refusal,
      },
      {
        name: "HTTP in file, membership in overrides",
        contents: { http: { enabled: true } },
        overrides: { gateway: joined },
        error: refusal,
      },
      {
        name: "override false repairs file true",
        contents: { gateway: joined, http: { enabled: true } },
        overrides: { http: { enabled: false } },
        http: false,
      },
      {
        name: "ws URL, HTTP false",
        contents: { gateway: { ...joined, url: "ws://fleet.example/x" }, http: { enabled: false } },
        http: false,
      },
      { name: "wss URL, HTTP omitted", contents: { gateway: joined }, http: false },
      { name: "standalone, HTTP true", contents: { http: { enabled: true } }, http: true },
      { name: "standalone, HTTP false", contents: { http: { enabled: false } }, http: false },
      { name: "standalone, HTTP omitted", contents: {}, http: true },
      { name: "gateway, HTTP omitted", contents: {}, role: "gateway", http: true },
      {
        name: "gateway, HTTP true",
        contents: { http: { enabled: true } },
        role: "gateway",
        http: true,
      },
      {
        name: "gateway, HTTP false",
        contents: { http: { enabled: false } },
        role: "gateway",
        error: "http.enabled",
      },
      {
        name: "gateway ignoring membership keys",
        contents: { gateway: joined, http: { enabled: true } },
        role: "gateway",
        http: true,
      },
      {
        name: "empty URL",
        contents: { gateway: { url: "", token: "t" }, http: { enabled: true } },
        error: "a ws:// or wss:// URL",
      },
      {
        name: "malformed URL",
        contents: { gateway: { url: "not a url", token: "t" }, http: { enabled: true } },
        error: "a ws:// or wss:// URL",
      },
      {
        name: "http URL",
        contents: { gateway: { url: "http://fleet.example", token: "t" }, http: { enabled: true } },
        error: "a ws:// or wss:// URL",
      },
      {
        name: "https URL",
        contents: {
          gateway: { url: "https://fleet.example", token: "t" },
          http: { enabled: true },
        },
        error: "a ws:// or wss:// URL",
      },
      {
        name: "URL without token",
        contents: { gateway: { url: "wss://fleet.example" }, http: { enabled: true } },
        error: "gateway.token",
      },
      {
        name: "token without URL",
        contents: { gateway: { token: "t" }, http: { enabled: true } },
        error: "a gateway URL, since gateway.token is set",
      },
      {
        name: "removed mode key",
        contents: { mode: "worker", gateway: joined, http: { enabled: true } },
        error: '"mode" is no longer a config key',
      },
    ];

    for (const { name, contents, overrides, role, error, http } of cases) {
      const outcome = load(contents, {
        ...(overrides === undefined ? {} : { overrides }),
        ...(role === undefined ? {} : { role }),
      });
      if (error === undefined) {
        await expect(outcome, name).resolves.toMatchObject({ http: { enabled: http } });
      } else if (error === refusal) {
        await expect(outcome, name).rejects.toMatchObject({ message: refusal });
      } else {
        await expect(outcome, name).rejects.toThrow(error);
      }
    }
  });

  it.each(["http://fleet.example/v1/uplink", "fleet.example", "not a url"])(
    "rejects a gateway.url that is not a WebSocket URL: %s",
    async (url) => {
      await expect(load({ gateway: { url } })).rejects.toThrow("a ws:// or wss:// URL");
    },
  );

  it("rejects a non-positive disconnected retention", async () => {
    await expect(load({ gateway: { disconnectedRetentionMs: 0 } })).rejects.toThrow(
      "gateway.disconnectedRetentionMs",
    );
  });

  it("rejects a non-positive lease-request timeout", async () => {
    // why: P2 (round 2 review): bounds the one forwarded uplink call that used to have none of its
    // own -- see FleetForwarding.withLeaseRequestTimeout.
    await expect(load({ gateway: { leaseRequestTimeoutMs: 0 } })).rejects.toThrow(
      "gateway.leaseRequestTimeoutMs",
    );
  });

  it("defaults the gateway lease-request timeout well under the exec backstop", async () => {
    const config = await load({}, { role: "gateway" });
    expect(config.gateway.leaseRequestTimeoutMs).toBeLessThan(config.gateway.execTimeoutMs);
  });

  it("reports the role it was loaded for as config.mode", async () => {
    expect((await load({}, { role: "gateway" })).mode).toBe("gateway");
    expect((await load({}, { role: "worker" })).mode).toBe("worker");
  });

  it("defaults the memoryPressure section, refuses a bad value naming its key, and warns a gateway it is worker-only", async () => {
    expect((await load({})).memoryPressure).toEqual({
      clearAfterMs: 60_000,
      enabled: true,
      pauseNewDevices: { level: "critical", minAvailablePercent: 10 },
      pauseWarming: { level: "warn", minAvailablePercent: 20 },
    });
    const accepted = await load({
      memoryPressure: { pauseWarming: { level: "off", minAvailablePercent: 0 }, clearAfterMs: 0 },
    });
    expect(accepted.memoryPressure).toMatchObject({
      clearAfterMs: 0,
      pauseWarming: { level: "off", minAvailablePercent: 0 },
    });

    const refused = [
      { memoryPressure: { pauseWarming: { level: "bogus" } } },
      { memoryPressure: { pauseNewDevices: { minAvailablePercent: 101 } } },
      { memoryPressure: { pauseNewDevices: { minAvailablePercent: -1 } } },
      { memoryPressure: { clearAfterMs: -1 } },
    ];
    const keys = [
      "memoryPressure.pauseWarming.level",
      "memoryPressure.pauseNewDevices.minAvailablePercent",
      "memoryPressure.pauseNewDevices.minAvailablePercent",
      "memoryPressure.clearAfterMs",
    ];
    for (const [index, file] of refused.entries()) {
      await expect(load(file)).rejects.toThrow(keys[index]!);
    }

    const warn = vi.fn();
    await load({ memoryPressure: { enabled: false } }, { role: "gateway", warn });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Ignoring "memoryPressure"'));
  });

  it("HTTP defaults to port 4700 for a gateway and 4701 for a worker", async () => {
    expect((await load({}, { role: "gateway" })).http.port).toBe(4700);
    expect((await load({})).http.port).toBe(4701);
  });
});
