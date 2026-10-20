import { afterEach, describe, expect, it } from "vitest";

import type { DaemonServer } from "./server.js";
import { cleanUp, openUplink, startWorker } from "./test-relay-support.js";

describe("identity.get over a worker's uplink", () => {
  const daemons: DaemonServer[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    await cleanUp(daemons, directories);
  });

  it("identity.get answers the gateway's principal, admin and via uplink over a real uplink session", async () => {
    const fixture = await startWorker(directories, daemons, {});
    const uplink = await openUplink(fixture.worker);

    await expect(uplink.wire.call("identity.get", {})).resolves.toEqual({
      name: "gw:test",
      principal: "gw:test",
      role: "admin",
      via: "uplink",
    });
  });
});
