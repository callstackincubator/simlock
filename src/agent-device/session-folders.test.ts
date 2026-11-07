import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { release } from "./test-edge.js";
import { command, granted, hex, principals, secrets, setUp, type Rig } from "./test-support.js";

async function sessionFolder(rig: Rig, path: string): Promise<void> {
  await rig.filesystem.mkdirp(path);
  await rig.filesystem.writeFileAtomic(join(path, "events.ndjson"), '{"version":1}\n');
}

describe("agent-device session folders on a worker", () => {
  it("a lease end removes the session folders of that lease, including one a --session name made, and keeps another live lease's folder", async () => {
    const rig = await setUp();
    const sessions = join(dirname(rig.stateDbPath), "agent-device", "sessions");
    await granted(rig, 1);
    await granted(rig, 2, {}, { token: secrets.two });
    await command(rig, "snapshot", 1, {}, { session: "my-session" });
    await command(rig, "snapshot", 1, {}, { session: "qa/ios" });
    await command(rig, "snapshot", 1, {}, { session: "x/../../../victim" });
    const own = [
      join(sessions, hex(1)),
      join(sessions, `${principals.one}_${hex(1)}`),
      join(sessions, `${principals.one}_my-session`),
      join(sessions, `${principals.one}_qa_ios`),
      join(sessions, `${principals.one}_x_.._.._.._victim`),
    ];
    const other = join(sessions, `${principals.two}_${hex(2)}`);
    // why: the wire-supplied name `x/../../../victim` must not reach a folder outside `sessions/`.
    const victim = join(dirname(sessions), "victim");
    await sessionFolder(rig, join(sessions, `${principals.one}_x`));
    for (const path of [...own, other, victim]) await sessionFolder(rig, path);

    await release(rig, 1);
    await expect
      .poll(() => rig.filesystem.exists(join(sessions, hex(1))), { timeout: 5_000 })
      .toBe(false);

    const left = await Promise.all(
      [...own, other, victim].map(async (path) => ({
        exists: await rig.filesystem.exists(path),
        path,
      })),
    );
    expect(left).toEqual([
      ...own.map((path) => ({ exists: false, path })),
      { exists: true, path: other },
      { exists: true, path: victim },
    ]);
  });
});
