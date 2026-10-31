import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FakeDriver, FakeInputFactory, fakeDeviceDataTables } from "../core/testing.js";
import { MemoryFilesystem, NoopLogger, SystemClock } from "../ports/index.js";
import type { DispatchSession } from "./dispatch.js";
import { startDaemon } from "./main.js";
import type { DaemonServer } from "./server.js";

const holder: DispatchSession = {
  manageEventSubscription: () => undefined,
  via: "socket",
  principal: "holder-1",
  role: "agent",
};

describe("device.rotate", () => {
  const daemons: DaemonServer[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(daemons.splice(0).map((daemon) => daemon.stop("test")));
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
    );
  });

  async function worker(options: {
    readonly inputModule: boolean;
    readonly input: FakeInputFactory;
  }) {
    const dataDirectory = await mkdtemp(join(tmpdir(), "simlock-e2e-rotate-"));
    directories.push(dataDirectory);
    const daemon = await startDaemon({
      configOverrides: { capabilities: { input: { enabled: options.inputModule } } },
      dataDirectory,
      deviceDataTables: fakeDeviceDataTables,
      drivers: [
        new FakeDriver({
          availableOsVersions: ["18.0"],
          clock: new SystemClock(),
          input: options.input,
          knownModels: ["iPhone 15"],
          platform: "ios",
        }),
      ],
      filesystem: new MemoryFilesystem(),
      logger: new NoopLogger(),
      version: "1.0.0-e2e",
    });
    daemons.push(daemon);
    const granted = await daemon.dispatch(
      "lease.request",
      { model: "iPhone 15", platform: "ios" },
      holder,
    );
    return { daemon, leaseId: (granted as { lease: { id: string } }).lease.id };
  }

  it(
    "answers a holder's rotate of its iOS-simulator lease and sends the helper that orientation",
    { timeout: 60_000 },
    async () => {
      const input = new FakeInputFactory({ height: 2556, orientation: "portrait", width: 1179 });
      const { daemon, leaseId } = await worker({ input, inputModule: false });

      const answer = await daemon.dispatch(
        "device.rotate",
        { leaseId, orientation: "landscape_left" },
        holder,
      );

      expect(answer).toEqual({ leaseId, orientation: "landscape_left" });
      expect(input.opened).toHaveLength(1);
      expect(input.opened[0]?.sent).toEqual([
        { kind: "orientation", orientation: "landscape_left" },
      ]);
      expect(input.opened[0]?.closes).toBe(1);
    },
  );
});
