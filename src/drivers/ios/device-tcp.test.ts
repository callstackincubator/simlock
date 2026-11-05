import { describe, expect, it } from "vitest";

import { type VirtualDriverDevice } from "../../core/index.js";
import {
  FakeClock,
  FakeTcpListenerFactory,
  FakeTcpProbe,
  FakeTcpStreamConnector,
  type LoopbackHost,
  type ProcessResult,
  type ProcessRunner,
} from "../../ports/index.js";
import { createIosDeviceTcp } from "./device-tcp.js";

const UDID = "5A1E4B7C-0000-4000-8000-00000000AAAA";
const OTHER_UDID = "5A1E4B7C-0000-4000-8000-00000000BBBB";
const PORT = 9100;

const simulator: VirtualDriverDevice = {
  address: UDID,
  deviceId: "dev_1",
  driverData: { deviceTypeId: "iphone", name: "simlock-1", runtimeId: "ios", udid: UDID },
  physical: false,
};

// why: the lines `lsof -nP -iTCP:<p> -sTCP:LISTEN -Fpn` printed on this Mac for a process on two loopback addresses and one on all interfaces.
function lsofOutput(...holders: readonly (readonly [number, ...string[]])[]): string {
  return holders
    .map(([pid, ...addresses]) =>
      [
        `p${String(pid)}`,
        ...addresses.flatMap((address, index) => [
          `f${String(5 + index)}`,
          `n${address}:${String(PORT)}`,
        ]),
      ].join("\n"),
    )
    .join("\n")
    .concat("\n");
}

const ok = (stdout: string): ProcessResult => ({ code: 0, stderr: "", stdout });

// why: stands in for `lsof` and `ps eww` by what they were asked, not by the order of the calls.
class MachineRunner implements ProcessRunner {
  lookup: ProcessResult | "hangs" = { code: 1, stderr: "", stdout: "" };
  readonly environments = new Map<number, string>();

  async run(command: string, args: readonly string[]): Promise<ProcessResult> {
    if (command === "lsof") {
      if (this.lookup === "hangs") return await new Promise<ProcessResult>(() => undefined);
      return this.lookup;
    }
    const pid = Number(args.at(-1));
    const environment = this.environments.get(pid);
    return environment === undefined
      ? { code: 1, stderr: "", stdout: "" }
      : ok(`PID TT STAT TIME COMMAND\n${String(pid)} ?? S 0:00.01 ${environment}\n`);
  }

  spawn(): never {
    throw new Error("unused");
  }

  spawnStreaming(): never {
    throw new Error("unused");
  }
}

function setup(connector: FakeTcpStreamConnector = new FakeTcpStreamConnector()) {
  const runner = new MachineRunner();
  const clock = new FakeClock();
  const deviceTcp = createIosDeviceTcp({
    clock,
    connector,
    listeners: new FakeTcpListenerFactory(),
    probe: new FakeTcpProbe(),
    runner,
  });
  const signal = new AbortController().signal;
  const connect = () => deviceTcp.connect(simulator, PORT, signal);
  const dialled = (): readonly LoopbackHost[] => connector.connections.map(({ host }) => host);
  return { clock, connect, connector, dialled, runner };
}

const environmentOf = (udid: string) =>
  `/bin/app PATH=/usr/bin SIMULATOR_UDID=${udid} HOME=/Users/x`;
const NOTHING = `nothing on the lease's simulator listens on port ${String(PORT)}`;

// why: the owner check is pure decision logic with many cases over the real lsof lines, which the module's one surface (the tunnel module) cannot enumerate cheaply; the spec names this seam.
describe("iOS deviceTcp forward connections", () => {
  it("reaches the port only when a process of the lease's simulator listens there", async () => {
    const accepted: {
      readonly name: string;
      readonly holders: readonly (readonly [number, ...string[]])[];
      readonly environments: Record<number, string>;
      readonly dialled: readonly LoopbackHost[];
    }[] = [
      {
        dialled: ["127.0.0.1"],
        environments: { 10: environmentOf(UDID) },
        holders: [[10, "127.0.0.1", "[::1]"]],
        name: "the lease's simulator on 127.0.0.1",
      },
      {
        dialled: ["::1"],
        environments: { 10: environmentOf(UDID) },
        holders: [[10, "[::1]"]],
        name: "the lease's simulator on ::1 only",
      },
      {
        dialled: ["127.0.0.1"],
        environments: { 10: environmentOf(UDID) },
        holders: [[10, "*"]],
        name: "the lease's simulator on all interfaces",
      },
      {
        dialled: ["::1"],
        environments: { 10: environmentOf(UDID), 20: environmentOf(OTHER_UDID) },
        holders: [
          [10, "*"],
          [20, "127.0.0.1"],
        ],
        name: "all interfaces while another process holds 127.0.0.1",
      },
      {
        dialled: ["::1"],
        environments: { 10: environmentOf(UDID), 20: environmentOf(OTHER_UDID) },
        holders: [
          [10, "[::1]"],
          [20, "127.0.0.1"],
        ],
        name: "::1 while another simulator holds 127.0.0.1",
      },
    ];
    for (const { dialled, environments, holders, name } of accepted) {
      const machine = setup();
      machine.runner.lookup = ok(lsofOutput(...holders));
      for (const [pid, environment] of Object.entries(environments)) {
        machine.runner.environments.set(Number(pid), environment);
      }
      const stream = await machine.connect();
      expect(machine.dialled(), name).toEqual(dialled);

      const peer = machine.connector.connections[0]?.peer;
      await stream.write("ping");
      expect(peer?.writtenText(), name).toBe("ping");
      peer?.send("pong");
      const reader = stream.readable.getReader();
      expect(new TextDecoder().decode((await reader.read()).value), name).toBe("pong");
    }

    const refused: {
      readonly name: string;
      readonly lookup: ProcessResult;
      readonly environments: Record<number, string>;
      readonly message: string;
    }[] = [
      {
        environments: { 20: environmentOf(OTHER_UDID) },
        lookup: ok(lsofOutput([20, "127.0.0.1"])),
        message: NOTHING,
        name: "another simulator's process",
      },
      {
        environments: { 30: "/usr/bin/adb PATH=/usr/bin HOME=/Users/x" },
        lookup: ok(lsofOutput([30, "*"])),
        message: NOTHING,
        name: "a worker process with no SIMULATOR_UDID",
      },
      {
        environments: { 30: `/usr/bin/node server.js --env=SIMULATOR_UDID=${UDID} PATH=/usr/bin` },
        lookup: ok(lsofOutput([30, "127.0.0.1"])),
        message: NOTHING,
        name: "SIMULATOR_UDID only inside an argument",
      },
      {
        environments: {},
        lookup: { code: 1, stderr: "", stdout: "" },
        message: NOTHING,
        name: "lookup exit 1 with no output",
      },
      {
        environments: {},
        lookup: { code: 2, stderr: "lsof: can't run\nsecond line", stdout: "" },
        message: "could not check the port's owner: lsof: can't run",
        name: "lookup exit 2",
      },
    ];
    for (const { environments, lookup, message, name } of refused) {
      const machine = setup();
      machine.runner.lookup = lookup;
      for (const [pid, environment] of Object.entries(environments)) {
        machine.runner.environments.set(Number(pid), environment);
      }
      await expect(machine.connect(), name).rejects.toMatchObject({ message });
      expect(machine.connector.connections, name).toEqual([]);
    }
  });
});
