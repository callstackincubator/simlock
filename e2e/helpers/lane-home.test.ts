import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { iosSourceDataOwner } from "../../src/drivers/ios/index.js";
import { clearAllButState, releaseLaneHome, restoreKeptSeeds } from "./lane-home.js";

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

describe("a seed the lane keeps between flows", () => {
  it("keeps its file rows and indexed mark, so the next flow copies it instead of making it again", async () => {
    const home = await mkdtemp(join(tmpdir(), "simlock-lane-home-test-"));
    const udid = "00000000-0000-0000-0000-0000000000AA";
    const startDaemon = (): DatabaseSync => {
      const database = new DatabaseSync(join(home, "state.db"));
      for (const migration of iosSourceDataOwner.migrations) database.exec(migration);
      return database;
    };
    try {
      await mkdir(join(home, "seeds", udid), { recursive: true });
      const first = startDaemon();
      first.exec(
        `INSERT INTO ios_source_data (source_id, kind, spec_key, udid, set_path, device_type_id, runtime_id,
           model, os_version, state, maker, created_at, indexed)
         VALUES ('seed-1', 'seed', 'kind', '${udid}', '${join(home, "seeds")}', 'type', 'runtime',
           'iPhone 17', '27.0', 'ready', 'daemon', 0, 1);
         INSERT INTO ios_source_files (source_id, relative_path, kind)
         VALUES ('seed-1', 'data/Library/Logs', 'link')`,
      );
      first.close();

      await releaseLaneHome(home);
      const second = startDaemon();
      second.close();
      await restoreKeptSeeds(home);

      const restored = new DatabaseSync(join(home, "state.db"), { readOnly: true });
      expect(restored.prepare("SELECT indexed FROM ios_source_data").all()).toEqual([
        { indexed: 1 },
      ]);
      expect(
        restored.prepare("SELECT source_id, relative_path, kind FROM ios_source_files").all(),
      ).toEqual([{ kind: "link", relative_path: "data/Library/Logs", source_id: "seed-1" }]);
      restored.close();
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });
});
