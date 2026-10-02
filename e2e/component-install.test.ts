import { describe, expect, it } from "vitest";

import {
  type CliResult,
  events,
  freeLoopbackPort,
  type TestEnv,
  waitFor,
  withDaemon,
} from "./helpers/index.js";

const MISSING = ["lease", "--platform", "ios", "--device", "iPhone 16", "--os", "19.0"] as const;

describe("lease-triggered component installs", () => {
  it("installs a missing runtime once for two concurrent leases with --allow-download, and grants both", async () => {
    const env = await withDaemon();
    await env.driverScript.set({
      ios: {
        availableOsVersions: ["18.4"],
        knownModels: ["iPhone 16"],
        // Long enough that the second request surely arrives while the first install runs.
        latencyMs: { installComponent: 3_000 },
      },
    });
    await env.driverLog.clear();

    const first = env.cliBackground([
      ...MISSING,
      "--allow-download",
      "--agent-id",
      "agent-a",
      "--detach",
    ]);
    await waitFor(
      async () =>
        (await env.driverLog.calls()).some((call) => call.operation === "installComponent"),
      { label: "the first lease's install started" },
    );
    const second = await env.cli(
      [...MISSING, "--allow-download", "--agent-id", "agent-b", "--detach"],
      { timeout: 30_000 },
    );
    const firstResult = await first.waitForExit(30_000);

    expect(firstResult.code, firstResult.stderr).toBe(0);
    expect(second.code, second.stderr).toBe(0);
    const installs = (await env.driverLog.calls()).filter(
      (call) => call.operation === "installComponent",
    );
    expect(installs.map((call) => call.arguments)).toEqual([["19.0"]]);
    const componentEvents = (await events(env.env))
      .filter((entry) => entry.event.startsWith("component."))
      .map((entry) => entry.event);
    expect(componentEvents).toEqual(["component.install-started", "component.installed"]);
  });
});

/** Every stderr line the CLI wrote, parsed. */
function stderrLines(result: CliResult): unknown[] {
  return result.stderr
    .trim()
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as unknown);
}

async function installCalls(env: TestEnv): Promise<unknown[]> {
  return (await env.driverLog.calls())
    .filter((call) => call.operation === "installComponent")
    .map((call) => call.arguments);
}

describe("simlock component install", () => {
  it("installs a missing runtime with progress on stderr, the catalog then lists it, and a repeat reports already-installed", async () => {
    const env = await withDaemon();
    await env.driverScript.set({
      ios: { availableOsVersions: ["18.4"], installProgress: [50], knownModels: ["iPhone 16"] },
    });
    await env.driverLog.clear();

    const first = await env.cli(["component", "install", "ios", "19.0"]);

    expect(first.code, first.stderr).toBe(0);
    expect(first.json).toEqual({
      component: "19.0",
      outcome: "installed",
      platform: "ios",
      version: "19.0",
    });
    expect(stderrLines(first)).toContainEqual({ fraction: 0.5, stage: "downloading" });

    const catalog = await env.cli(["catalog", "--platform", "ios", "--json"]);
    expect(catalog.code, catalog.stderr).toBe(0);
    expect(catalog.json).toMatchObject({ platforms: [{ runtimes: ["18.4", "19.0"] }] });

    const repeat = await env.cli(["component", "install", "ios", "19.0"]);
    expect(repeat.code, repeat.stderr).toBe(0);
    expect(repeat.json).toMatchObject({ outcome: "already-installed", version: "19.0" });
    expect(await installCalls(env)).toEqual([["19.0"]]);
  });

  it('fails with DOWNLOADS_DISABLED and exit 12 under downloads.policy "never", reaching no driver', async () => {
    const env = await withDaemon({ configOverrides: { downloads: { policy: "never" } } });
    await env.driverLog.clear();

    const result = await env.cli(["component", "install", "android", "35"]);

    expect(result.code, result.stderr).toBe(12);
    expect(result.stdout).toBe("");
    expect(result.error?.code).toBe("DOWNLOADS_DISABLED");
    const calls = await env.driverLog.calls();
    expect(
      calls.filter(
        (call) => call.operation === "findComponent" || call.operation === "installComponent",
      ),
    ).toEqual([]);
  });

  it("refuses an agent session with FORBIDDEN, installing nothing", async () => {
    const env = await withDaemon();
    await env.driverLog.clear();

    // A credential the daemon rejects falls back to an agent session (with a notice).
    const result = await env.cli([
      "--token",
      "not-an-admin-credential",
      "component",
      "install",
      "ios",
      "26.4",
    ]);

    expect(result.code, result.stderr).toBe(1);
    expect(result.error?.code).toBe("FORBIDDEN");
    expect(await installCalls(env)).toEqual([]);
  });
});

interface SseFrame {
  readonly event: string;
  readonly data: unknown;
}

/** The whole SSE body, keepalives skipped. The route ends it on its `result` or `error` event. */
async function readSse(response: Response): Promise<SseFrame[]> {
  const frames: SseFrame[] = [];
  for (const raw of (await response.text()).split("\n\n")) {
    if (raw.trim() === "" || raw.startsWith(":")) continue;
    let event = "";
    let data = "";
    for (const line of raw.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    frames.push({ data: JSON.parse(data) as unknown, event });
  }
  return frames;
}

interface HttpDaemon {
  readonly env: TestEnv;
  install(
    auth: Record<string, string>,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Response>;
  token(role: "agent" | "operator"): Promise<Record<string, string>>;
}

async function httpDaemon(): Promise<HttpDaemon> {
  const port = await freeLoopbackPort();
  const env = await withDaemon({
    configOverrides: { http: { enabled: true, host: "127.0.0.1", port } },
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitFor(
    async () => {
      try {
        return (await fetch(`${baseUrl}/v1/healthz`)).ok;
      } catch {
        return false;
      }
    },
    { label: "HTTP API accepting connections" },
  );
  return {
    env,
    install: (auth, body, signal) =>
      fetch(`${baseUrl}/v1/components/install`, {
        body: JSON.stringify(body),
        headers: { ...auth, "content-type": "application/json" },
        method: "POST",
        ...(signal === undefined ? {} : { signal }),
      }),
    async token(role) {
      const created = await env.cli(["token", "create", "--role", role]);
      expect(created.code, created.stderr).toBe(0);
      return { authorization: `Bearer ${(created.json as { secret: string }).secret}` };
    },
  };
}

describe("POST /v1/components/install", () => {
  it("answers 403 to an agent token, and streams progress then one result event to an operator token", async () => {
    const { env, install, token } = await httpDaemon();
    await env.driverScript.set({ android: { availableOsVersions: ["34"], installProgress: [41] } });
    await env.driverLog.clear();

    const refused = await install(await token("agent"), { platform: "android", version: "35" });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("FORBIDDEN");
    expect(await installCalls(env)).toEqual([]);

    const response = await install(await token("operator"), {
      platform: "android",
      version: "35",
    });
    expect(response.status).toBe(200);
    expect(await readSse(response)).toEqual([
      { data: { fraction: 0.41, stage: "downloading" }, event: "progress" },
      {
        data: { component: "35", outcome: "installed", platform: "android", version: "35" },
        event: "result",
      },
    ]);
  });

  it("keeps installing when the client disconnects, and a repeat of the request joins that install", async () => {
    const { env, install, token } = await httpDaemon();
    await env.driverScript.set({
      android: { availableOsVersions: ["34"], latencyMs: { installComponent: 3_000 } },
    });
    await env.driverLog.clear();
    const operator = await token("operator");

    const disconnect = new AbortController();
    const first = await install(
      operator,
      { platform: "android", version: "35" },
      disconnect.signal,
    );
    expect(first.status).toBe(200);
    await waitFor(async () => (await installCalls(env)).length === 1, {
      label: "the install started",
    });
    disconnect.abort();

    const repeat = await install(operator, { platform: "android", version: "35" });
    expect(await readSse(repeat)).toEqual([
      {
        data: { component: "35", outcome: "installed", platform: "android", version: "35" },
        event: "result",
      },
    ]);
    expect(await installCalls(env)).toEqual([["35"]]);
    const componentEvents = (await events(env.env))
      .filter((entry) => entry.event.startsWith("component."))
      .map((entry) => entry.event);
    expect(componentEvents).toEqual(["component.install-started", "component.installed"]);
  });
});
