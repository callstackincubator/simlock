import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  IpcError,
  MemoryFilesystem,
  MemoryIpcTransport,
  resolveDaemonSocketPath,
  type IpcConnector,
} from "../ports/index.js";
import { runCli } from "./index.js";
import { buildCliEnvironment } from "./environment.js";
import { readPipedStdin } from "./stdio.js";
import { parseDuration } from "./duration.js";
import { fakeClient, outputCapture, realCliEnvironmentPorts } from "./test-index.js";

// why: a part of a decomposed module: these tests drive the environment builder, the duration
// parser and the stdin reader directly, the parts that own those behaviours (ADR 0063 section 2).
describe("CLI: the daemon endpoint check", () => {
  it("buildCliEnvironment reports the daemon endpoint present only while its socket file exists", async () => {
    const filesystem = new MemoryFilesystem();
    const environment = buildCliEnvironment(realCliEnvironmentPorts(filesystem), {});
    const socketPath = resolveDaemonSocketPath("/simlock", "linux");

    expect(await environment.daemonEndpointPresent()).toBe(false);
    await filesystem.mkdirp("/simlock");
    await filesystem.writeFileAtomic(socketPath, "");
    expect(await environment.daemonEndpointPresent()).toBe(true);
    await filesystem.rm(socketPath);
    expect(await environment.daemonEndpointPresent()).toBe(false);
  });

  it("on Windows reports the named pipe present while something answers it, and not after it closes", async () => {
    const ipc = new MemoryIpcTransport();
    const environment = buildCliEnvironment(
      { ...realCliEnvironmentPorts(), ipc, hostPlatform: "win32" },
      {},
    );

    expect(await environment.daemonEndpointPresent()).toBe(false);
    const listener = await ipc.listen(
      resolveDaemonSocketPath("/simlock", "win32"),
      () => undefined,
    );
    expect(await environment.daemonEndpointPresent()).toBe(true);
    await listener.close();
    expect(await environment.daemonEndpointPresent()).toBe(false);
  });

  it("on Windows counts a pipe that does not answer in time as present, since only a refused or missing one proves it gone", async () => {
    const connector: IpcConnector = {
      connect: async () => {
        throw new IpcError("connection-timeout", "timed out", undefined);
      },
    };
    const environment = buildCliEnvironment(
      { ...realCliEnvironmentPorts(), ipc: connector, hostPlatform: "win32" },
      {},
    );

    expect(await environment.daemonEndpointPresent()).toBe(true);
  });
});

describe("CLI: requester id from the agent session", () => {
  const sessionEnv = { CLAUDE_CODE_SESSION_ID: "abc" };

  it("buildCliEnvironment falls back to the pid when no agent id or session id is set", () => {
    expect(buildCliEnvironment(realCliEnvironmentPorts(), {}).requesterId).toBe(
      String(process.pid),
    );
  });

  it("simlock lease --agent-id overrides a session-derived id", async () => {
    const requested: string[] = [];
    const client = fakeClient({
      requestLease: (input, _options) => {
        requested.push(input.requesterId ?? "<none>");
        return fakeClient().requestLease(input);
      },
    });
    const output = outputCapture();
    const environment = {
      ...buildCliEnvironment(realCliEnvironmentPorts(), sessionEnv),
      connectAdmin: async () => client,
      stderr: { write: (value: string) => (output.stderr += value) },
      stdout: { write: (value: string) => (output.stdout += value) },
    };

    await expect(
      runCli(["lease", "--platform", "ios", "--device", "iPhone 17 Pro", "--detach"], environment),
    ).resolves.toBe(0);
    await expect(
      runCli(
        [
          "lease",
          "--platform",
          "ios",
          "--device",
          "iPhone 17 Pro",
          "--detach",
          "--agent-id",
          "explicit-agent",
        ],
        environment,
      ),
    ).resolves.toBe(0);

    expect(requested).toEqual(["claude-code:abc", "explicit-agent"]);
  });
});

describe("CLI: pure helpers", () => {
  it("parseDuration parses units and rejects garbage", () => {
    expect(parseDuration("500")).toBe(500);
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("2s")).toBe(2_000);
    expect(parseDuration("3m")).toBe(180_000);
    expect(parseDuration("1h")).toBe(3_600_000);
    expect(() => parseDuration("banana")).toThrow("Invalid duration");
  });

  it("parseDuration accepts the d unit and rejects an unknown one", () => {
    expect(parseDuration("2d")).toBe(2 * 24 * 60 * 60 * 1000);
    expect(() => parseDuration("2w")).toThrow("Invalid duration");
  });
});

describe("readPipedStdin", () => {
  function fakeStdin(chunks: readonly string[], isTTY: boolean): typeof process.stdin {
    const stream = Readable.from(chunks);
    return Object.assign(stream, { isTTY }) as unknown as typeof process.stdin;
  }

  it("reads a terminal stdin to its end, joining its chunks", async () => {
    const stdin = fakeStdin(["typed ", "text\n"], true);
    const stdinGetter = vi.spyOn(process, "stdin", "get").mockReturnValue(stdin);

    try {
      await expect(readPipedStdin()).resolves.toBe("typed text\n");
    } finally {
      stdinGetter.mockRestore();
    }
  });

  it("reads a piped stdin to EOF, concatenating every chunk in order", async () => {
    const stdin = fakeStdin(["piped ", "pay", "load\n"], false);
    const stdinGetter = vi.spyOn(process, "stdin", "get").mockReturnValue(stdin);

    try {
      await expect(readPipedStdin()).resolves.toBe("piped payload\n");
    } finally {
      stdinGetter.mockRestore();
    }
  });

  it("returns an empty string for a piped stdin that carries nothing", async () => {
    const stdin = fakeStdin([], false);
    const stdinGetter = vi.spyOn(process, "stdin", "get").mockReturnValue(stdin);

    try {
      await expect(readPipedStdin()).resolves.toBe("");
    } finally {
      stdinGetter.mockRestore();
    }
  });
});
