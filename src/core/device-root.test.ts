import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { type Filesystem, MemoryFilesystem, NodeFilesystem } from "../ports/index.js";
import type { Platform } from "./domain.js";
import { ensureOwnedRoot, OWNED_ROOT_MARKER_FILE, OwnedRootError } from "./index.js";

const instanceId = "instance-a";
const root = "/home/agent/.simlock/devices/ios";
const markerPath = `${root}/${OWNED_ROOT_MARKER_FILE}`;
const uid = 501;

interface Overrides {
  readonly instanceId?: string;
  readonly path?: string;
  readonly platform?: Platform;
}

function createFilesystem(): MemoryFilesystem {
  return new MemoryFilesystem(undefined, uid);
}

async function ensure(filesystem: Filesystem, overrides: Overrides = {}): Promise<string> {
  return ensureOwnedRoot({
    filesystem,
    instanceId: overrides.instanceId ?? instanceId,
    path: overrides.path ?? root,
    platform: overrides.platform ?? "ios",
    uid,
  });
}

/** The reason the root was refused, failing the test when it was accepted instead. */
async function refusal(filesystem: Filesystem, overrides: Overrides = {}): Promise<string> {
  try {
    await ensure(filesystem, overrides);
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(OwnedRootError);
    return (error as OwnedRootError).reason;
  }

  throw new Error("expected the root to be refused");
}

function marker(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    owner: "simlock",
    instanceId,
    platform: "ios",
    ...overrides,
  });
}

/** An existing root nobody validated: created behind Simlock's back, like a user's `mkdir -p`. */
async function seedRoot(filesystem: MemoryFilesystem, markerContents?: string): Promise<void> {
  await filesystem.mkdirp(root);
  if (markerContents !== undefined) {
    await filesystem.writeFileAtomic(markerPath, markerContents);
  }
}

describe("ensureOwnedRoot", () => {
  it("creates a missing root, its parents, and its ownership marker", async () => {
    const filesystem = createFilesystem();

    await expect(ensure(filesystem)).resolves.toBe(root);
    await expect(filesystem.lstat(root)).resolves.toMatchObject({
      kind: "directory",
      mode: 0o700,
      uid,
    });
    await expect(filesystem.readFile(markerPath).then(JSON.parse)).resolves.toEqual({
      schemaVersion: 1,
      owner: "simlock",
      instanceId,
      platform: "ios",
    });
  });

  it("gives a new root owner-only permissions even when the umask stripped them", async () => {
    const filesystem = new UmaskedFilesystem(undefined, uid);

    await ensure(filesystem);

    await expect(filesystem.lstat(root)).resolves.toMatchObject({ mode: 0o700 });
  });

  it("returns the resolved path for a root written with relative segments", async () => {
    const filesystem = createFilesystem();

    await expect(
      ensure(filesystem, { path: "/home/agent/.simlock/devices/android/../ios" }),
    ).resolves.toBe(root);
  });

  it("reuses a root it already owns without rewriting its marker", async () => {
    const filesystem = createFilesystem();
    await ensure(filesystem);
    const original = await filesystem.readFile(markerPath);

    await expect(ensure(filesystem)).resolves.toBe(root);
    await expect(filesystem.readFile(markerPath)).resolves.toBe(original);
  });

  it("validates, rather than creates, a root another process created first", async () => {
    const filesystem = new RacingFilesystem(root, uid);
    await seedRoot(filesystem, marker());
    const original = await filesystem.readFile(markerPath);

    await expect(ensure(filesystem)).resolves.toBe(root);
    await expect(filesystem.readFile(markerPath)).resolves.toBe(original);
  });

  it("refuses an empty root nobody marked", async () => {
    const filesystem = createFilesystem();
    await seedRoot(filesystem);

    await expect(refusal(filesystem)).resolves.toBe("missing-marker");
  });

  it("refuses an unmarked root that already holds something", async () => {
    const filesystem = createFilesystem();
    await seedRoot(filesystem);
    await filesystem.writeFileAtomic(`${root}/someone-elses-work.txt`, "");

    await expect(refusal(filesystem)).resolves.toBe("non-empty-unowned-root");
  });

  it("refuses a path occupied by something that is not a directory", async () => {
    const filesystem = createFilesystem();
    await filesystem.mkdirp("/home/agent/.simlock/devices");
    await filesystem.writeFileAtomic(root, "not a directory");

    await expect(refusal(filesystem)).resolves.toBe("non-empty-unowned-root");
  });

  it("refuses a symlinked root", async () => {
    const filesystem = createFilesystem();
    await filesystem.mkdirp("/somewhere/else");
    filesystem.defineSymlink(root, "/somewhere/else");

    await expect(refusal(filesystem)).resolves.toBe("symlink");
  });

  it("refuses a symlinked marker", async () => {
    const filesystem = createFilesystem();
    await ensure(filesystem);
    await filesystem.writeFileAtomic("/home/agent/elsewhere.json", marker());
    filesystem.defineSymlink(markerPath, "/home/agent/elsewhere.json");

    await expect(refusal(filesystem)).resolves.toBe("symlink");
  });

  it("refuses a root owned by another user", async () => {
    const filesystem = createFilesystem();
    await ensure(filesystem);
    filesystem.defineAttributes(root, { uid: uid + 1 });

    await expect(refusal(filesystem)).resolves.toBe("wrong-owner");
  });

  it("accepts a root owned by anyone when the platform has no uids", async () => {
    const filesystem = createFilesystem();
    await ensure(filesystem);
    filesystem.defineAttributes(root, { uid: uid + 1 });

    await expect(
      ensureOwnedRoot({ filesystem, instanceId, path: root, platform: "ios" }),
    ).resolves.toBe(root);
  });

  it.each([0o750, 0o770, 0o701])("refuses a root reachable beyond its owner (%s)", async (mode) => {
    const filesystem = createFilesystem();
    await ensure(filesystem);
    filesystem.defineAttributes(root, { mode });

    await expect(refusal(filesystem)).resolves.toBe("wrong-permissions");
  });

  it.each([
    ["is not valid JSON", "{ definitely not json"],
    ["names an unknown schema version", marker({ schemaVersion: 2 })],
    ["names another owner", marker({ owner: "somebody-else" })],
    ["names another platform", marker({ platform: "android" })],
    ["carries no instance id", marker({ instanceId: undefined })],
    ["is not an object", JSON.stringify("simlock")],
  ])("refuses a root whose marker %s", async (_case, contents) => {
    const filesystem = createFilesystem();
    await seedRoot(filesystem, contents);

    await expect(refusal(filesystem)).resolves.toBe("invalid-marker");
  });

  it("refuses a root whose marker cannot be read", async () => {
    const filesystem = createFilesystem();
    await seedRoot(filesystem);
    await filesystem.mkdirp(markerPath);

    await expect(refusal(filesystem)).resolves.toBe("invalid-marker");
  });

  it("refuses a root whose marker names another instance", async () => {
    const filesystem = createFilesystem();
    await seedRoot(filesystem, marker({ instanceId: "instance-b" }));

    await expect(refusal(filesystem)).resolves.toBe("wrong-instance");
  });

  it("reports the root and platform it refused", async () => {
    const filesystem = createFilesystem();
    await seedRoot(filesystem);

    await expect(ensure(filesystem)).rejects.toMatchObject({
      reason: "missing-marker",
      path: root,
      platform: "ios",
    });
  });
});

describe("ensureOwnedRoot on a real filesystem", () => {
  let home: string | undefined;

  afterEach(async () => {
    if (home !== undefined) {
      await rm(home, { force: true, recursive: true });
      home = undefined;
    }
  });

  it("accepts a root reached through a symlinked ancestor", async () => {
    // The ordinary case this must not fail on: `/tmp` is itself a symlink on macOS, and
    // every temporary home lives under it. Only the root and its marker are checked
    // without following links -- comparing realpath against the configured path would
    // refuse a perfectly healthy machine.
    const filesystem = new NodeFilesystem();
    home = await mkdtemp(join(tmpdir(), "simlock-device-root-"));
    await filesystem.mkdirp(join(home, "real"));
    await symlink(join(home, "real"), join(home, "link"));
    const path = join(home, "link", "ios");

    const created = await ensureOwnedRoot({ filesystem, instanceId, path, platform: "ios" });
    const revalidated = await ensureOwnedRoot({ filesystem, instanceId, path, platform: "ios" });

    expect(created).toBe(path);
    expect(revalidated).toBe(path);
    expect(await filesystem.realpath(path)).not.toBe(path);
  });
});

/** `mkdir` under a restrictive umask: the mode is a request the umask subtracts from. */
class UmaskedFilesystem extends MemoryFilesystem {
  async mkdir(path: string, options: { readonly mode?: number } = {}): Promise<void> {
    await super.mkdir(path, { mode: (options.mode ?? 0o777) & ~0o277 });
  }
}

/**
 * Reports the root as absent exactly once, so the first `mkdir` loses a race it could not
 * have seen coming -- the window every check-then-create has.
 */
class RacingFilesystem extends MemoryFilesystem {
  #absentOnce: string | undefined;

  constructor(absentOnce: string, owner: number) {
    super(undefined, owner);
    this.#absentOnce = absentOnce;
  }

  async lstat(path: string): ReturnType<MemoryFilesystem["lstat"]> {
    if (path === this.#absentOnce) {
      this.#absentOnce = undefined;
      const error: NodeJS.ErrnoException = new Error(`No such file or directory: ${path}`);
      error.code = "ENOENT";
      throw error;
    }

    return super.lstat(path);
  }
}
