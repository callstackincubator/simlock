import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it, onTestFinished } from "vitest";

import {
  ANDROID,
  FIRST_SNAPSHOT,
  freeLoopbackPort,
  hasIosRuntime,
  listLeases,
  makeAgent,
  warmUp,
  withSharedDaemon,
  type SharedTestEnv,
} from "./index.js";

// why: a host that answers `xcrun simctl list runtimes` with each of <answers> in turn (an Error is thrown), on a clock that only `pause` moves.
function host(answers: readonly (string | Error)[], platform = "darwin", arch = "arm64") {
  const state = { calls: 0, clock: 0 };
  const timeouts: number[] = [];
  const probe = {
    arch,
    list: (timeoutMs: number) => {
      timeouts.push(timeoutMs);
      const answer = answers[Math.min(state.calls++, answers.length - 1)]!;
      if (typeof answer === "string") return answer;
      throw answer;
    },
    now: () => state.clock,
    pause: (ms: number) => {
      state.clock += ms;
    },
    platform,
  };
  return { probe, state, timeouts };
}

const failure = (stderr: string, code?: string) =>
  Object.assign(new Error("failed"), { code, stderr });
const IOS_LISTED =
  "== Runtimes ==\niOS 27.1 (27.1 - 24B80) - com.apple.CoreSimulator.SimRuntime.iOS-27-1\n";
const SERVICE_DOWN = "Failed to locate a valid instance of CoreSimulatorService in the bootstrap.";

describe("hasIosRuntime", () => {
  it("is true where simctl lists an iOS runtime and false where it lists none, on an Apple-silicon Mac", () => {
    expect(hasIosRuntime(host([IOS_LISTED]).probe)).toBe(true);
    expect(hasIosRuntime(host(["== Runtimes ==\ntvOS 27.0 (27.0 - 24J5)\n"]).probe)).toBe(false);
  });

  it("is false without asking simctl on Linux and on an Intel Mac", () => {
    const linux = host([IOS_LISTED], "linux", "arm64");
    const intel = host([IOS_LISTED], "darwin", "x64");

    expect([hasIosRuntime(linux.probe), hasIosRuntime(intel.probe)]).toEqual([false, false]);
    expect([linux.state.calls, intel.state.calls]).toEqual([0, 0]);
  });

  it("is false at once on a Mac with no xcrun or no simctl", () => {
    const noXcrun = host([failure("", "ENOENT")]);
    const noSimctl = host([
      failure('xcrun: error: unable to find utility "simctl", not a developer tool or in PATH'),
    ]);

    expect([hasIosRuntime(noXcrun.probe), hasIosRuntime(noSimctl.probe)]).toEqual([false, false]);
    expect([noXcrun.state.calls, noSimctl.state.calls]).toEqual([1, 1]);
  });

  it("asks again when simctl fails, and is true once it lists an iOS runtime", () => {
    const flaky = host([failure(SERVICE_DOWN), failure(SERVICE_DOWN), IOS_LISTED]);

    expect(hasIosRuntime(flaky.probe)).toBe(true);
    expect(flaky.state).toEqual({ calls: 3, clock: 1_000 });
  });

  it("throws simctl's own error, and does not return false, when simctl still fails after 5 s", () => {
    const down = host([failure(SERVICE_DOWN)]);

    expect(() => hasIosRuntime(down.probe)).toThrow(
      `xcrun simctl list runtimes kept failing for 5 s on a Mac that has simctl, so its iOS cases cannot be skipped: ${SERVICE_DOWN}`,
    );
    expect(down.state.clock).toBe(5_000);
  });
});

describe("hasIosRuntime, a simctl that hangs", () => {
  it("gives each simctl call 15 s, and throws saying it gave no answer when the calls keep timing out", () => {
    const hung = host([failure("", "ETIMEDOUT")]);

    expect(() => hasIosRuntime(hung.probe)).toThrow(
      "xcrun simctl list runtimes kept failing for 5 s on a Mac that has simctl, so its iOS cases cannot be skipped: no answer in 15 s",
    );
    expect(new Set(hung.timeouts)).toEqual(new Set([15_000]));
  });
});

describe("warmUp", () => {
  it("when a later warm-up lease fails, rejects and leaves none of the warm-up leases it took held", async () => {
    const env = await withSharedDaemon({
      configOverrides: {
        http: { enabled: false, host: "127.0.0.1", port: await freeLoopbackPort() },
      },
      driverScript: {
        android: {
          availableOsVersions: ["34"],
          defaultModels: { phone: ["Pixel 8"] },
          knownModels: ["Pixel 8"],
          modelClasses: { "Pixel 8": "phone" },
        },
      },
    });
    try {
      await warmUp(env, ANDROID, 2);
      expect(await listLeases(env)).toEqual([]);
      await env.driverScript.merge({
        android: { failures: { provision: { type: "BootTimeoutError" } } },
      });

      await expect(warmUp(env, ANDROID, 3)).rejects.toThrow(/Timed out waiting for device to boot/);

      expect(await listLeases(env)).toEqual([]);
    } finally {
      await env.teardown();
    }
  });
});

interface RpcCall {
  readonly params?: { readonly command?: string; readonly flags?: Record<string, unknown> };
}

// why: agent-device's CLI bounds a snapshot request by its own --timeout and, without one, by its 90 s default envelope (DAEMON_REQUEST_TIMEOUT_MS, packages/command-registry/src/timeout-policy.ts at v0.21.36), whatever the process timeout is; a stand-in daemon records the request the pinned CLI sends.
describe.skipIf(process.env.SIMLOCK_E2E_AGENT_DEVICE === undefined)("FIRST_SNAPSHOT", () => {
  it("an agent's snapshot run with FIRST_SNAPSHOT reaches agent-device's daemon with a 150000 ms budget", async () => {
    const calls: RpcCall[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        if (request.url?.endsWith("/health") === true) {
          response.end(JSON.stringify({ ok: true }));
          return;
        }
        const call = JSON.parse(body) as RpcCall & { id?: unknown };
        calls.push(call);
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: call.id,
            result: { ok: false, error: { code: "COMMAND_FAILED", message: "stand-in daemon" } },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const env = {
      httpPort: (server.address() as AddressInfo).port,
      cli: () => Promise.resolve({ code: 0 }),
    } as unknown as SharedTestEnv;
    const agent = await makeAgent(env, "first-snapshot", {
      direct: true,
      token: { secret: "stand-in", id: "stand-in" },
    });

    await agent.run(["snapshot"], FIRST_SNAPSHOT);

    expect(calls.map((call) => call.params?.command)).toEqual(["snapshot"]);
    expect(calls[0]?.params?.flags?.["timeoutMs"]).toBe(150_000);
  });
});
