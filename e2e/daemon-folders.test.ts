import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { freeLoopbackPort, REPO_ROOT, type TestEnv, waitFor, withDaemon } from "./helpers/index.js";

// why: an env's teardown stops only the worker's socket, so a test stops a gateway it started in its own `finally`.

const NO_GATEWAY = "No gateway on this machine. Start one with: simlock --gateway daemon start";
const MODE_REMOVED =
  '"mode" is no longer a config key. A daemon started with --gateway is a gateway; any other is a worker. Remove "mode" from config.json.';

function gatewayFolder(env: TestEnv): string {
  return join(env.home, "gateway");
}

async function makeGatewayPresent(env: TestEnv): Promise<void> {
  const port = await freeLoopbackPort();
  const set = await env.cli(["--gateway", "config", "set", "http.port", String(port)]);
  expect(set.code, set.stderr).toBe(0);
}

async function startGateway(env: TestEnv): Promise<void> {
  await makeGatewayPresent(env);
  const started = await env.cli(["--gateway", "daemon", "start"]);
  expect(started.code, started.stderr).toBe(0);
  await waitFor(() => existsSync(join(gatewayFolder(env), "admin.token")), {
    label: "the gateway's admin.token written",
  });
}

async function stopGateway(env: TestEnv): Promise<void> {
  await env.cli(["--gateway", "daemon", "stop"]);
}

function daemonMode(result: { readonly json: unknown }): unknown {
  return (result.json as { daemon: { mode: string } }).daemon.mode;
}

describe("daemon folders (ADR 0034)", () => {
  it.each([
    ["status", ["status"]],
    ["daemon status", ["daemon", "status"]],
    ["daemon stop", ["daemon", "stop"]],
    ["daemon logs", ["daemon", "logs"]],
    ["events --since 1h", ["events", "--since", "1h"]],
    ["config get", ["config", "get"]],
    ["adb shell ls -h", ["adb", "shell", "ls", "-h"]],
    ["adb -h", ["adb", "-h"]],
    ["simctl --help", ["simctl", "--help"]],
  ])(
    "with no gateway present, every --gateway command but daemon start and config set exits 2 with GATEWAY_NOT_PRESENT and starts nothing (%s)",
    async (_name, argv) => {
      const env = await withDaemon({ mode: "auto" });

      const result = await env.cli(["--gateway", ...argv]);

      expect(result.code).toBe(2);
      expect(result.error).toEqual({ code: "GATEWAY_NOT_PRESENT", message: NO_GATEWAY });
      expect(existsSync(gatewayFolder(env))).toBe(false);
      expect(existsSync(env.socketPath)).toBe(false);
    },
  );

  it.each([
    ["--gateway status --help", ["--gateway", "status", "--help"]],
    ["--gateway --help", ["--gateway", "--help"]],
  ])("`%s` prints usage, not the error", async (_name, argv) => {
    const env = await withDaemon({ mode: "auto" });

    const result = await env.cli(argv);

    expect(result.code).toBe(0);
    expect(result.error).toBeUndefined();
    expect(result.stdout).toContain("Usage: simlock");
  });

  it("--gateway config set makes a gateway present, after which --gateway status starts it", async () => {
    const env = await withDaemon({ mode: "auto" });

    try {
      await makeGatewayPresent(env);
      expect(existsSync(join(gatewayFolder(env), "config.json"))).toBe(true);

      const status = await env.cli(["--gateway", "status", "--json"]);

      expect(status.code, status.stderr).toBe(0);
      expect(daemonMode(status)).toBe("gateway");
    } finally {
      await stopGateway(env);
    }
  });

  it("a gateway started with --gateway runs beside the worker of the same root, each in its own folder", async () => {
    const env = await withDaemon();

    try {
      await startGateway(env);

      const worker = await env.cli(["status", "--json"]);
      const gateway = await env.cli(["--gateway", "status", "--json"]);

      expect(daemonMode(worker)).toBe("worker");
      expect(daemonMode(gateway)).toBe("gateway");
      const workerInstance = await readFile(join(env.home, "instance.json"), "utf8");
      const gatewayInstance = await readFile(join(gatewayFolder(env), "instance.json"), "utf8");
      expect(gatewayInstance).not.toBe(workerInstance);
      const gatewayState = new DatabaseSync(join(gatewayFolder(env), "state.db"));
      try {
        const devicesTables = gatewayState
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'devices'")
          .all();
        expect(devicesTables).toEqual([]);
      } finally {
        gatewayState.close();
      }
    } finally {
      await stopGateway(env);
    }
  });

  it("simlock config set mode gateway exits 2 with the mode message and leaves config.json as it was", async () => {
    const env = await withDaemon({ mode: "auto" });
    await writeFile(env.configPath, '{"http":{"port":4999}}\n', "utf8");

    const result = await env.cli(["config", "set", "mode", "gateway"]);

    expect(result.code).toBe(2);
    expect(result.error?.code).toBe("USAGE");
    expect(result.error?.message).toBe(`Invalid config after setting mode: ${MODE_REMOVED}`);
    expect(await readFile(env.configPath, "utf8")).toBe('{"http":{"port":4999}}\n');
  });

  it("a daemon started from a config that still sets mode does not start, and the CLI prints the mode message with exit 1", async () => {
    const env = await withDaemon({ mode: "auto" });
    await writeFile(env.configPath, '{"mode":"worker"}\n', "utf8");

    const result = await env.cli(["daemon", "start"]);

    expect(result.code).toBe(1);
    expect(result.error).toEqual({ code: "INTERNAL", message: MODE_REMOVED });
    expect(existsSync(env.socketPath)).toBe(false);
  });

  it("a gateway that fails to start logs the reason to <root>/gateway/daemon.log, not <root>/daemon.log", async () => {
    const env = await withDaemon({ mode: "auto" });
    const holder = createServer();
    const port = await new Promise<number>((resolve) => {
      holder.listen(0, "127.0.0.1", () => {
        const address = holder.address();
        resolve(typeof address === "object" && address !== null ? address.port : 0);
      });
    });

    try {
      const set = await env.cli(["--gateway", "config", "set", "http.port", String(port)]);
      expect(set.code, set.stderr).toBe(0);

      await env.cli(["--gateway", "daemon", "start"]);

      const gatewayLog = join(gatewayFolder(env), "daemon.log");
      await waitFor(
        async () =>
          existsSync(gatewayLog) &&
          (await readFile(gatewayLog, "utf8")).includes("Daemon failed to start"),
        { label: "the gateway's start failure in <root>/gateway/daemon.log" },
      );
      expect(existsSync(join(env.home, "daemon.log"))).toBe(false);
    } finally {
      await stopGateway(env);
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
  });

  it("the daemon entry run with an unknown argument exits 1 and logs Daemon failed to start to <root>/daemon.log", async () => {
    const env = await withDaemon({ mode: "auto" });

    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, [join(REPO_ROOT, "dist/daemon/main.js"), "--bogus"], {
        env: env.env,
        stdio: "ignore",
      });
      child.once("error", reject);
      child.once("close", resolve);
    });

    expect(code).toBe(1);
    expect(await readFile(join(env.home, "daemon.log"), "utf8")).toContain(
      "Daemon failed to start",
    );
  });

  it("the daemon entry run in a folder that still holds state.json exits 1, logs the upgrade instructions as its last line and creates no state.db", async () => {
    const env = await withDaemon({ mode: "auto" });
    await writeFile(join(env.home, "state.json"), "{}\n", "utf8");

    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, [join(REPO_ROOT, "dist/daemon/main.js")], {
        env: env.env,
        stdio: "ignore",
      });
      child.once("error", reject);
      child.once("close", resolve);
    });

    expect(code).toBe(1);
    const lines = (await readFile(join(env.home, "daemon.log"), "utf8")).trim().split("\n");
    expect(JSON.parse(lines.at(-1) ?? "{}")).toMatchObject({
      fields: {
        message: `Found ${join(env.home, "state.json")}, which this Simlock no longer reads. To upgrade: with the older Simlock, release every lease and run \`simlock nuke --delete-devices\`; then remove ${join(env.home, "state.json")} and start again. See "Breaking: state moves to state.db" in docs/CLI.md.`,
      },
      message: "Daemon failed to start",
    });
    expect(existsSync(join(env.home, "state.db"))).toBe(false);
  });

  it("on a machine with only a present gateway, plain daemon start and plain status reach the gateway and start no worker", async () => {
    const env = await withDaemon({ mode: "auto" });

    try {
      await makeGatewayPresent(env);

      const started = await env.cli(["daemon", "start"]);
      const status = await env.cli(["status", "--json"]);

      expect(started.code, started.stderr).toBe(0);
      expect(status.code, status.stderr).toBe(0);
      expect(daemonMode(status)).toBe("gateway");
      expect(existsSync(join(env.home, "instance.json"))).toBe(false);
    } finally {
      await stopGateway(env);
    }
  });

  it("with a worker and a present gateway, a plain worker drain exits 2 with the worker's message and the --gateway hint; with --gateway the gateway answers UNKNOWN_WORKER (exit 12) for the worker's id", async () => {
    const env = await withDaemon();

    try {
      await startGateway(env);
      const workerId = JSON.parse(await readFile(join(env.home, "instance.json"), "utf8")).id;

      const plain = await env.cli(["worker", "drain", workerId]);
      const viaGateway = await env.cli(["--gateway", "worker", "drain", workerId]);

      expect(plain.code).toBe(2);
      expect(plain.error).toEqual({
        code: "UNSUPPORTED_IN_WORKER_MODE",
        message:
          "worker.drain acts on a gateway's workers, and this daemon is not a gateway. A gateway also runs on this machine: run the command again with --gateway.",
      });
      expect(viaGateway.code).toBe(12);
      expect(viaGateway.error?.code).toBe("UNKNOWN_WORKER");
    } finally {
      await stopGateway(env);
    }
  });

  it("on a machine that got its gateway first, simlock --local daemon start starts a worker in <root>, and plain status reaches it afterwards", async () => {
    const env = await withDaemon({ mode: "auto" });

    try {
      await makeGatewayPresent(env);
      expect(existsSync(join(env.home, "instance.json"))).toBe(false);

      const started = await env.cli(["--local", "daemon", "start"]);
      const status = await env.cli(["status", "--json"]);

      expect(started.code, started.stderr).toBe(0);
      expect(existsSync(join(env.home, "instance.json"))).toBe(true);
      expect(status.code, status.stderr).toBe(0);
      expect(daemonMode(status)).toBe("worker");
    } finally {
      await stopGateway(env);
    }
  });

  it("with a worker and a present gateway, a worker error of another code carries no hint", async () => {
    const env = await withDaemon();

    try {
      await startGateway(env);

      const result = await env.cli(["release", "lease_unknown"]);

      expect(result.error?.code).toBe("UNKNOWN_LEASE");
      expect(result.error?.message).toBe("Unknown lease: lease_unknown");
    } finally {
      await stopGateway(env);
    }
  });

  it("on a machine with only a gateway, plain daemon logs and events --since read the gateway's files", async () => {
    const env = await withDaemon({ mode: "auto" });

    try {
      await startGateway(env);
      await stopGateway(env);
      const gatewayLog = await readFile(join(gatewayFolder(env), "daemon.log"), "utf8");

      const logs = await env.cli(["daemon", "logs"]);
      const events = await env.cli(["events", "--since", "1h"]);

      expect(logs.code, logs.stderr).toBe(0);
      expect(gatewayLog).toContain("Daemon started");
      expect(logs.stdout).toBe(gatewayLog);
      expect(events.code, events.stderr).toBe(0);
      const started = events.stdout
        .split("\n")
        .filter((line) => line !== "")
        .map(
          (line) =>
            JSON.parse(line) as { event: string; payload: { configSnapshot?: { mode?: string } } },
        )
        .find((entry) => entry.event === "daemon.started");
      expect(started?.payload.configSnapshot?.mode).toBe("gateway");
      expect(existsSync(join(env.home, "daemon.log"))).toBe(false);
    } finally {
      await stopGateway(env);
    }
  });

  describe("MCP", () => {
    it("simlock --gateway mcp lists the gateway's catalog, plain simlock mcp lists the worker's", async () => {
      const env = await withDaemon();
      await env.driverScript.set({
        ios: { knownModels: ["iPhone 16"], availableOsVersions: ["18.4"] },
      });

      try {
        await startGateway(env);
        const workerMcp = await env.mcpClient();
        const gatewayMcp = await env.mcpClient({ gateway: true });

        const workerCatalog = await workerMcp.client.callTool({
          name: "list_devices",
          arguments: {},
        });
        const gatewayCatalog = await gatewayMcp.client.callTool({
          name: "list_devices",
          arguments: {},
        });

        expect(workerCatalog.structuredContent).toMatchObject({
          platforms: expect.arrayContaining([
            expect.objectContaining({ platform: "ios", models: ["iPhone 16"] }),
          ]),
        });
        expect(gatewayCatalog.structuredContent).toEqual({ platforms: [] });
      } finally {
        await stopGateway(env);
      }
    });

    it("simlock --local mcp on a machine with only a present gateway lists the worker's catalog", async () => {
      const env = await withDaemon({ mode: "auto" });
      await env.driverScript.set({
        ios: { knownModels: ["iPhone 16"], availableOsVersions: ["18.4"] },
      });
      const mcp = await env.mcpClient({ local: true });

      try {
        await makeGatewayPresent(env);

        const catalog = await mcp.client.callTool({ name: "list_devices", arguments: {} });

        expect(catalog.structuredContent).toMatchObject({
          platforms: expect.arrayContaining([
            expect.objectContaining({ platform: "ios", models: ["iPhone 16"] }),
          ]),
        });
        expect(existsSync(join(env.home, "instance.json"))).toBe(true);
      } finally {
        await stopGateway(env);
      }
    });

    it("plain simlock mcp on a machine with only a present gateway lists the gateway's catalog", async () => {
      const env = await withDaemon({ mode: "auto" });
      await env.driverScript.set({
        ios: { knownModels: ["iPhone 16"], availableOsVersions: ["18.4"] },
      });
      const mcp = await env.mcpClient();

      try {
        await makeGatewayPresent(env);

        const catalog = await mcp.client.callTool({ name: "list_devices", arguments: {} });

        expect(catalog.isError).toBeFalsy();
        expect(catalog.structuredContent).toEqual({ platforms: [] });
        expect(existsSync(join(env.home, "instance.json"))).toBe(false);
      } finally {
        await stopGateway(env);
      }
    });

    it("with no gateway present, a --gateway mcp tool call fails with GATEWAY_NOT_PRESENT", async () => {
      const env = await withDaemon({ mode: "auto" });
      const mcp = await env.mcpClient({ gateway: true });

      const result = await mcp.client.callTool({ name: "list_devices", arguments: {} });

      expect(result.isError).toBe(true);
      expect(JSON.parse((result.content as { text: string }[])[0]?.text ?? "{}")).toEqual({
        code: "GATEWAY_NOT_PRESENT",
        message: NO_GATEWAY,
      });
      expect(existsSync(gatewayFolder(env))).toBe(false);
    });

    it("a --gateway mcp session that started before any gateway existed reaches it once simlock --gateway daemon start has run", async () => {
      const env = await withDaemon({ mode: "auto" });
      const mcp = await env.mcpClient({ gateway: true });

      try {
        const before = await mcp.client.callTool({ name: "list_devices", arguments: {} });
        expect(before.isError).toBe(true);

        await startGateway(env);
        const after = await mcp.client.callTool({ name: "list_devices", arguments: {} });

        expect(after.isError).toBeFalsy();
        expect(after.structuredContent).toEqual({ platforms: [] });
      } finally {
        await stopGateway(env);
      }
    });

    it("with a gateway present but stopped, a --gateway mcp tool call starts the gateway in <root>/gateway", async () => {
      const env = await withDaemon({ mode: "auto" });
      const mcp = await env.mcpClient({ gateway: true });

      try {
        await makeGatewayPresent(env);

        const result = await mcp.client.callTool({ name: "list_devices", arguments: {} });

        expect(result.isError).toBeFalsy();
        const status = await env.cli(["--gateway", "status", "--json"]);
        expect(daemonMode(status)).toBe("gateway");
        expect(existsSync(join(env.home, "instance.json"))).toBe(false);
        expect(existsSync(join(gatewayFolder(env), "gateway"))).toBe(false);
      } finally {
        await stopGateway(env);
      }
    });
  });
});
