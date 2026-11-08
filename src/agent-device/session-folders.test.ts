import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { release } from "./test-edge.js";
import {
  adminSession,
  command,
  granted,
  hex,
  leaseTenant,
  principals,
  secrets,
  setUp,
  type Rig,
} from "./test-support.js";

async function sessionFolder(rig: Rig, path: string): Promise<void> {
  await rig.filesystem.mkdirp(path);
  await rig.filesystem.writeFileAtomic(join(path, "events.ndjson"), '{"version":1}\n');
}

describe("agent-device session folders on a worker", () => {
  it("a lease end, by release or by simlock, removes the session folders of that lease under its tenant, including one a --session name made, and keeps another live lease's folder", async () => {
    const rig = await setUp();
    const sessions = join(dirname(rig.stateDbPath), "agent-device", "sessions");
    await granted(rig, 1);
    await granted(rig, 2, {}, { token: secrets.two });
    await command(rig, "snapshot", 1, {}, { session: "my-session" });
    await command(rig, "snapshot", 1, {}, { session: "qa/ios" });
    await command(rig, "snapshot", 1, {}, { session: "x/../../../victim" });
    const tenantOne = leaseTenant(principals.one, 1);
    const own = [
      join(sessions, hex(1)),
      join(sessions, `${tenantOne}_${hex(1)}`),
      join(sessions, `${tenantOne}_my-session`),
      join(sessions, `${tenantOne}_qa_ios`),
      join(sessions, `${tenantOne}_x_.._.._.._victim`),
    ];
    const other = join(sessions, `${leaseTenant(principals.two, 2)}_${hex(2)}`);
    // why: the in-memory filesystem keeps `..` as a name, so this folder is the exact path a lease end would remove if the wire-supplied name `x/../../../victim` reached it with its separators; `join` would fold it away.
    const victim = `${sessions}/${tenantOne}_x/../../../victim`;
    await sessionFolder(rig, join(sessions, `${tenantOne}_x`));
    for (const path of [...own, other]) await sessionFolder(rig, path);
    await rig.filesystem.mkdirp(victim);

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

    const ended = join(sessions, `${leaseTenant(principals.two, 2)}_e2e-ios-0`);
    await command(rig, "snapshot", 2, { token: secrets.two }, { session: "e2e-ios-0" });
    await sessionFolder(rig, ended);
    await rig.daemon.dispatch("lease.release-all", {}, adminSession);
    await expect.poll(() => rig.filesystem.exists(ended), { timeout: 5_000 }).toBe(false);
    expect(await rig.filesystem.exists(other)).toBe(false);
  });
});
