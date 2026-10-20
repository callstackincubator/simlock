import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FakeClock,
  FakeDaemonLauncher,
  FakeSystemStats,
  MemoryFilesystem,
  MemoryIpcTransport,
} from "../ports/index.js";
import { buildCliEnvironment } from "./environment.js";

// why: the real ports barrel is kept, but its Node parent watcher fails to construct, standing in
// for a barrel that cannot load.
vi.mock("../ports/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ports/index.js")>();
  return {
    ...actual,
    NodeParentWatch: class {
      constructor() {
        throw new Error("ports barrel failed to load");
      }
    },
  };
});

const unhandled: unknown[] = [];
const record = (reason: unknown): void => {
  unhandled.push(reason);
};

afterEach(() => {
  process.off("unhandledRejection", record);
  unhandled.length = 0;
});

describe("the default parent watch", () => {
  it("degrades to no watch, without an unhandled rejection, when the Node watcher cannot load", async () => {
    process.on("unhandledRejection", record);
    const environment = buildCliEnvironment(
      {
        clock: new FakeClock(0),
        daemonHome: {
          role: "worker",
          dataDirectory: mkdtempSync(join(tmpdir(), "simlock-cli-lazy-watch-")),
          gatewayPresent: false,
        },
        filesystem: new MemoryFilesystem(),
        ipc: new MemoryIpcTransport(),
        launcher: new FakeDaemonLauncher(),
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
        systemStats: new FakeSystemStats({ cpuCount: 8, totalRamBytes: 32 * 1024 ** 3 }),
      },
      {},
    );
    const onExit = vi.fn();

    const handle = environment.parentWatch?.watch(4321, onExit);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(() => handle?.stop()).not.toThrow();
    expect(unhandled).toEqual([]);
    expect(onExit).not.toHaveBeenCalled();
  });
});
