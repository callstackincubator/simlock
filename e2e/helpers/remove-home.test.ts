import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { removeHome } from "./remove-home.js";

// why: removeHome is a helper file of the e2e lane, outside any module surface, and the race it
// retries (a writer adding files between rm's listing and its rmdir) is forced only here.
describe("removeHome", () => {
  it("removes a home whose folder a process is still filling while it is removed", async () => {
    const home = await mkdtemp(join(tmpdir(), "simlock-remove-home-"));
    const folder = join(home, "simlock.avd", "modem_simulator");
    await mkdir(folder, { recursive: true });
    await Promise.all(
      Array.from({ length: 500 }, (_, index) => writeFile(join(folder, `seed-${index}`), "x")),
    );
    const until = Date.now() + 600;
    let count = 0;
    const writer = (async () => {
      while (Date.now() < until) {
        count += 1;
        await writeFile(join(folder, `file-${count}`), "x").catch(() => undefined);
      }
    })();

    try {
      await removeHome(home);
      await writer;
      await expect(stat(home)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await writer;
      await rm(home, { force: true, recursive: true });
    }
  });
});
