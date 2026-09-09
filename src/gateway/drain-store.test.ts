import { describe, expect, it } from "vitest";

import type { Logger } from "../ports/index.js";
import { MemoryFilesystem } from "../ports/index.js";
import { FileDrainStore } from "./drain-store.js";

/** A minimal `Logger` that only records `error` calls -- everything this suite needs to assert
 * the corrupt-file fallback logs loudly rather than swallowing silently. */
function recordingLogger(): {
  logger: Logger;
  errors: Array<{ message: string; fields?: Record<string, unknown> }>;
} {
  const errors: Array<{ message: string; fields?: Record<string, unknown> }> = [];
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: (message, fields) => {
      errors.push(fields === undefined ? { message } : { fields, message });
    },
    child: () => logger,
  };
  return { errors, logger };
}

/**
 * C1 (round 1 review, #119): `FileDrainStore` -- the on-disk half of ADR §8a/§9's "the only
 * gateway state that survives a restart" -- had no test of its own anywhere in the repo. Every
 * registry-level persistence test injects `MemoryDrainStore`, which exercises the `#drained` set,
 * not the file; `gateway-fleet.e2e.test.ts`'s restart test is the only place the real store was
 * even constructed, and it never read the file back either. This file closes that gap directly,
 * over a `MemoryFilesystem` rather than the real disk, the same way every other persistence test
 * in this codebase does.
 */
describe("FileDrainStore", () => {
  const PATH = "/home/.simlock/workers.json";

  it("round-trips an empty store as an empty array without touching the filesystem", async () => {
    const filesystem = new MemoryFilesystem();
    const store = new FileDrainStore({ filesystem, path: PATH });

    expect(await filesystem.exists(PATH)).toBe(false);
    await expect(store.load()).resolves.toEqual([]);
  });

  it("saves drained worker ids as `{drained: [...]}` and loads them back, mode 0o600", async () => {
    const filesystem = new MemoryFilesystem();
    const store = new FileDrainStore({ filesystem, path: PATH });

    await store.save(["wrk_a", "wrk_b"]);

    expect(await filesystem.exists(PATH)).toBe(true);
    const raw = await filesystem.readFile(PATH);
    expect(JSON.parse(raw)).toEqual({ drained: ["wrk_a", "wrk_b"] });
    expect((await filesystem.stat(PATH)).mode).toBe(0o600);

    // A fresh store instance -- the same file, not the same object -- reading it back is the
    // shape a real gateway restart depends on: a new process, same directory.
    const reloaded = new FileDrainStore({ filesystem, path: PATH });
    await expect(reloaded.load()).resolves.toEqual(["wrk_a", "wrk_b"]);
  });

  it("a later save overwrites the file rather than merging with what was there before", async () => {
    const filesystem = new MemoryFilesystem();
    const store = new FileDrainStore({ filesystem, path: PATH });

    await store.save(["wrk_a", "wrk_b"]);
    await store.save(["wrk_b"]);

    await expect(store.load()).resolves.toEqual(["wrk_b"]);
  });

  it("falls back to an empty array, logging loudly, when the file holds invalid JSON", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/.simlock");
    await filesystem.writeFileAtomic(PATH, "not json at all");
    const { errors, logger } = recordingLogger();
    const store = new FileDrainStore({ filesystem, logger, path: PATH });

    await expect(store.load()).resolves.toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.fields).toMatchObject({ path: PATH });
  });

  it("falls back to an empty array when the file is valid JSON but `drained` is not an array", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/.simlock");
    await filesystem.writeFileAtomic(PATH, JSON.stringify({ drained: "wrk_a" }));
    const store = new FileDrainStore({ filesystem, path: PATH });

    await expect(store.load()).resolves.toEqual([]);
  });

  it("drops non-string entries from `drained` rather than throwing", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/home/.simlock");
    await filesystem.writeFileAtomic(
      PATH,
      JSON.stringify({ drained: ["wrk_a", 7, null, "wrk_b"] }),
    );
    const store = new FileDrainStore({ filesystem, path: PATH });

    await expect(store.load()).resolves.toEqual(["wrk_a", "wrk_b"]);
  });
});
