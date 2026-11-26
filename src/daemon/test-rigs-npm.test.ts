import { afterEach, describe, expect, it, vi } from "vitest";

import { NodeFilesystem, NodeNpmCli } from "../ports/index.js";
import type { DaemonServer } from "./server.js";
import { start, stopDaemons } from "./test-main.js";
import { cleanUp, startWorker } from "./test-relay-support.js";

// why: the version check runs `npm view simlock@latest` at every start (`update.check` is on by default), so a rig that leaves the real npm CLI in place makes the unit lane ask the registry and leaves a child process behind (#1885). The view call is the deterministic witness; it is stubbed so this test asks no registry itself.
describe("the shared daemon test rigs", { timeout: 30_000 }, () => {
  const daemons: DaemonServer[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await stopDaemons();
    await cleanUp(daemons, directories);
  });

  it("start daemons whose version check runs no real npm CLI", async () => {
    const view = vi
      .spyOn(NodeNpmCli.prototype, "view")
      .mockResolvedValue({ ok: false, message: "stubbed by the test" });

    await start({ filesystem: new NodeFilesystem() });
    await startWorker(directories, daemons, {});

    expect(view.mock.calls).toEqual([]);
  });
});
