import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { clearAllButState } from "./lane-home.js";

// why: lane-home is a helper file of the e2e lane, outside any module surface; the daemon start and stop that puts a kept seed's rows back runs only on the slow lane, where a server left behind fails a flow far from its cause.
describe("clearAllButState", () => {
  it("keeps the adb server's record, which the flow's own daemon needs to adopt a server left running under an attached emulator", async () => {
    const home = await mkdtemp(join(tmpdir(), "simlock-lane-home-test-"));
    try {
      for (const name of [
        "state.db",
        "adb-server.json",
        "daemon.log",
        "history.db",
        "admin.token",
      ]) {
        await writeFile(join(home, name), "x");
      }

      await clearAllButState(home);

      expect((await readdir(home)).sort()).toEqual(["adb-server.json", "state.db"]);
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });
});
