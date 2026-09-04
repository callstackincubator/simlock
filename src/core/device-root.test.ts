import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  CryptoIdGenerator,
  type Filesystem,
  MemoryFilesystem,
  NodeFilesystem,
} from "../ports/index.js";
import type { Platform } from "./domain.js";
import { ensureOwnedRoot, OWNED_ROOT_MARKER_FILE, OwnedRootError } from "./index.js";

const instanceId = "instance-a";
const parent = "/home/agent/.simlock/devices";
const root = `${parent}/ios`;
const markerPath = `${root}/${OWNED_ROOT_MARKER_FILE}`;
const uid = 501;
const idGenerator = new CryptoIdGenerator();

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
    idGenerator,
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
    // The root is assembled beside itself and published with one rename, so the only
    // thing that may be left in the parent afterwards is the root.
    await expect(filesystem.readdir(parent)).resolves.toEqual(["ios"]);
  });

  it("publishes a root and its marker in the same instant", async () => {
    // A root that becomes visible before its marker does is refused for ever after by
    // every later start, and a crash between the two steps makes that permanent.
    const filesystem = new ObservingFilesystem(root, uid);

    await ensure(filesystem);

    expect(filesystem.rootContentsWhenItAppeared).toEqual([OWNED_ROOT_MARKER_FILE]);
  });

  it("leaves nothing at the root when it cannot finish creating one", async () => {
    const filesystem = new FullDiskFilesystem(uid);

    await expect(refusal(filesystem)).resolves.toBe("unreadable");
    await expect(filesystem.exists(root)).resolves.toBe(false);
    await expect(filesystem.readdir(parent)).resolves.toEqual([]);
  });

  it("refuses a root that was swapped between being created and being used", async () => {
    const filesystem = new SwappedRootFilesystem(uid);

    await expect(refusal(filesystem)).resolves.toBe("wrong-permissions");
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
    // Bytes Simlock would never write itself: a marker in its own form could be rewritten
    // byte for byte, since serialisation is deterministic, and this would notice nothing.
    const original = `${JSON.stringify({ platform: "ios", instanceId, owner: "simlock", schemaVersion: 1, writtenBy: "0.1.0" })}\n`;
    await seedRoot(filesystem, original);

    await expect(ensure(filesystem)).resolves.toBe(root);
    await expect(filesystem.readFile(markerPath)).resolves.toBe(original);
  });

  it("validates, rather than creates, a root another process created first", async () => {
    const filesystem = new RacingFilesystem(root, uid);
    await seedRoot(filesystem, marker());
    const original = await filesystem.readFile(markerPath);

    await expect(ensure(filesystem)).resolves.toBe(root);
    await expect(filesystem.readFile(markerPath)).resolves.toBe(original);
    await expect(filesystem.readdir(parent)).resolves.toEqual(["ios"]);
  });

  it.each([
    ["a relative one", "devices/ios"],
    ["one written against the home directory", "~/devices/ios"],
    ["an empty one", ""],
  ])(
    "refuses %s rather than resolving it against whatever directory the daemon started in",
    async (_case, path) => {
      const filesystem = createFilesystem();

      await expect(refusal(filesystem, { path })).resolves.toBe("not-absolute");
    },
  );

  it("names the path it was given when refusing one that is not absolute", async () => {
    const filesystem = createFilesystem();

    await expect(ensure(filesystem, { path: "devices/ios" })).rejects.toMatchObject({
      reason: "not-absolute",
      path: "devices/ios",
    });
  });

  it.each([
    ["the root cannot be read", root],
    ["its marker cannot be read", markerPath],
  ])("refuses a root as unreadable when %s", async (_case, failingPath) => {
    const filesystem = createFilesystem();
    await seedRoot(filesystem);
    filesystem.defineFailure(failingPath, "EACCES");

    await expect(refusal(filesystem)).resolves.toBe("unreadable");
  });

  it("refuses a root whose parent cannot be created rather than failing the daemon", async () => {
    // A `deviceRoot` of `<home>/notes.txt/ios` is a typo, not a reason to stop every
    // driver: CP2 skips one platform on an OwnedRootError and dies on anything else.
    const filesystem = createFilesystem();
    filesystem.defineFailure(parent, "ENOTDIR");

    await expect(refusal(filesystem)).resolves.toBe("unreadable");
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
      ensureOwnedRoot({ filesystem, idGenerator, instanceId, path: root, platform: "ios" }),
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
    ["carries an empty instance id", marker({ instanceId: "" })],
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

    const created = await ensureOwnedRoot({
      filesystem,
      idGenerator,
      instanceId,
      path,
      platform: "ios",
    });
    const revalidated = await ensureOwnedRoot({
      filesystem,
      idGenerator,
      instanceId,
      path,
      platform: "ios",
    });

    expect(created).toBe(path);
    expect(revalidated).toBe(path);
    expect(await filesystem.realpath(path)).not.toBe(path);
  });

  it("gives every daemon racing to create one root the same root and marker", async () => {
    // Three daemons starting at once on a fresh home, against a real kernel. Creating the
    // root in place makes two of them refuse it -- the loser sees an unmarked directory,
    // or the winner's half-written marker, and calls it somebody else's data.
    const filesystem = new NodeFilesystem();
    home = await mkdtemp(join(tmpdir(), "simlock-device-root-race-"));
    const path = join(home, "devices", "ios");

    const results = await Promise.allSettled(
      [0, 1, 2].map(async () =>
        ensureOwnedRoot({ filesystem, idGenerator, instanceId, path, platform: "ios" }),
      ),
    );

    expect(
      results.map((result) =>
        result.status === "fulfilled" ? result.value : String(result.reason),
      ),
    ).toEqual([path, path, path]);
    await expect(filesystem.readdir(path)).resolves.toEqual([OWNED_ROOT_MARKER_FILE]);
    await expect(filesystem.readdir(join(home, "devices"))).resolves.toEqual(["ios"]);
    await expect(
      filesystem.readFile(join(path, OWNED_ROOT_MARKER_FILE)).then(JSON.parse),
    ).resolves.toMatchObject({ instanceId, platform: "ios" });
  });
});

/** Records what the root held the first moment it existed at all. */
class ObservingFilesystem extends MemoryFilesystem {
  rootContentsWhenItAppeared: readonly string[] | undefined;
  readonly #root: string;

  constructor(watched: string, owner: number) {
    super(undefined, owner);
    this.#root = watched;
  }

  async mkdir(path: string, options: { readonly mode?: number } = {}): Promise<void> {
    await super.mkdir(path, options);
    await this.#observe();
  }

  async writeFileAtomic(path: string, contents: string): Promise<void> {
    await super.writeFileAtomic(path, contents);
    await this.#observe();
  }

  async rename(from: string, to: string): Promise<void> {
    await super.rename(from, to);
    await this.#observe();
  }

  async #observe(): Promise<void> {
    if (this.rootContentsWhenItAppeared === undefined && (await super.exists(this.#root))) {
      this.rootContentsWhenItAppeared = await super.readdir(this.#root);
    }
  }
}

/** No room for the marker, so the create path has to unwind everything it built. */
class FullDiskFilesystem extends MemoryFilesystem {
  constructor(owner: number) {
    super(undefined, owner);
  }

  async writeFileAtomic(path: string, contents: string): Promise<void> {
    if (path.endsWith(OWNED_ROOT_MARKER_FILE)) {
      const error: NodeJS.ErrnoException = new Error("No space left on device");
      error.code = "ENOSPC";
      throw error;
    }

    await super.writeFileAtomic(path, contents);
  }
}

/** Something replaces the root in the instant between it being published and being used. */
class SwappedRootFilesystem extends MemoryFilesystem {
  constructor(owner: number) {
    super(undefined, owner);
  }

  async rename(from: string, to: string): Promise<void> {
    await super.rename(from, to);
    this.defineAttributes(to, { mode: 0o777 });
  }
}

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
