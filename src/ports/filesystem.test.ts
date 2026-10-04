import { symlink } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { type Filesystem, MemoryFilesystem, NodeFilesystem } from "./index.js";

// Per process: `afterEach` deletes it, so a shared name let two overlapping runs (two suites in
// one checkout, Stryker's runners in one sandbox) delete each other's files mid-test.
const temporaryDirectory = `${process.cwd()}/.simlock-ports-test-${process.pid}`;

const implementations: Array<{
  name: string;
  create(): Filesystem;
  /** Neither implementation creates symlinks through the port, and both have to be asked. */
  link(filesystem: Filesystem, path: string, target: string): Promise<void>;
}> = [
  {
    name: "memory filesystem",
    create: () => new MemoryFilesystem(),
    link: async (filesystem, path, target) => {
      (filesystem as MemoryFilesystem).defineSymlink(path, target);
    },
  },
  {
    name: "node filesystem",
    create: () => new NodeFilesystem(),
    link: async (_filesystem, path, target) => {
      await symlink(target, path);
    },
  },
];

afterEach(async () => {
  await new NodeFilesystem().rm(temporaryDirectory);
});

describe.each(implementations)("Filesystem contract: $name", ({ create, link }) => {
  it("atomically writes and overwrites a complete file", async () => {
    const filesystem = create();
    const file = `${temporaryDirectory}/devices/registry.json`;

    await filesystem.mkdirp(`${temporaryDirectory}/devices`);
    await filesystem.writeFileAtomic(file, "first version");
    await filesystem.writeFileAtomic(file, "complete replacement");

    await expect(filesystem.readFile(file)).resolves.toBe("complete replacement");
    await expect(filesystem.readdir(`${temporaryDirectory}/devices`)).resolves.toEqual([
      "registry.json",
    ]);
  });

  it("reads a file from a byte offset, and nothing past its end", async () => {
    const filesystem = create();
    const file = `${temporaryDirectory}/daemon.log`;
    await filesystem.mkdirp(temporaryDirectory);
    await filesystem.writeFileAtomic(file, "é line one\nline two\n");

    // "é" is two bytes: the offset counts bytes, not characters.
    await expect(filesystem.readFileFrom(file, 12)).resolves.toBe("line two\n");
    await expect(filesystem.readFileFrom(file, 0)).resolves.toBe("é line one\nline two\n");
    await expect(filesystem.readFileFrom(file, 21)).resolves.toBe("");
    await expect(filesystem.readFileFrom(file, 500)).resolves.toBe("");
  });

  it("keeps a file's identity across a rename and gives a new file at the same path another", async () => {
    const filesystem = create();
    const file = `${temporaryDirectory}/daemon.log`;
    await filesystem.mkdirp(temporaryDirectory);
    await filesystem.writeFileAtomic(file, "old\n");
    const original = (await filesystem.stat(file)).identity;

    await filesystem.rename(file, `${file}.1`);
    await filesystem.writeFileAtomic(file, "new\n");

    expect((await filesystem.stat(`${file}.1`)).identity).toBe(original);
    expect((await filesystem.stat(file)).identity).not.toBe(original);
  });

  it("creates nested directories idempotently", async () => {
    const filesystem = create();
    const directory = `${temporaryDirectory}/devices/ready`;

    await filesystem.mkdirp(directory);
    await filesystem.mkdirp(directory);

    await expect(filesystem.stat(directory)).resolves.toMatchObject({ kind: "directory" });
  });

  it("writes a file exclusively, refusing the second writer rather than replacing", async () => {
    const filesystem = create();
    const file = `${temporaryDirectory}/instance.json`;

    await filesystem.mkdirp(temporaryDirectory);
    await filesystem.writeFileExclusive(file, "first writer");

    await expect(filesystem.writeFileExclusive(file, "second writer")).rejects.toMatchObject({
      code: "EEXIST",
    });
    await expect(filesystem.readFile(file)).resolves.toBe("first writer");
  });

  it("moves a directory and everything under it in one step", async () => {
    const filesystem = create();
    const staging = `${temporaryDirectory}/.ios.staging`;

    await filesystem.mkdirp(`${staging}/nested`);
    await filesystem.writeFileAtomic(`${staging}/nested/marker.json`, "{}");
    await filesystem.rename(staging, `${temporaryDirectory}/ios`);

    await expect(filesystem.readFile(`${temporaryDirectory}/ios/nested/marker.json`)).resolves.toBe(
      "{}",
    );
    await expect(filesystem.exists(staging)).resolves.toBe(false);
  });

  it("refuses to move a directory onto one that holds something", async () => {
    const filesystem = create();
    const staging = `${temporaryDirectory}/.ios.staging`;
    const occupied = `${temporaryDirectory}/ios`;

    await filesystem.mkdirp(staging);
    await filesystem.mkdirp(occupied);
    await filesystem.writeFileAtomic(`${occupied}/someone-elses-work.txt`, "");

    await expect(filesystem.rename(staging, occupied)).rejects.toMatchObject({
      code: "ENOTEMPTY",
    });
  });

  it("reports whether a path is there", async () => {
    const filesystem = create();

    await filesystem.mkdirp(temporaryDirectory);
    await filesystem.writeFileAtomic(`${temporaryDirectory}/instance.json`, "{}");

    await expect(filesystem.exists(`${temporaryDirectory}/instance.json`)).resolves.toBe(true);
    await expect(filesystem.exists(`${temporaryDirectory}/absent.json`)).resolves.toBe(false);
  });

  it("answers about what a symlink points at, not about the link", async () => {
    const filesystem = create();

    await filesystem.mkdirp(`${temporaryDirectory}/real`);
    await link(filesystem, `${temporaryDirectory}/live`, `${temporaryDirectory}/real`);
    await link(filesystem, `${temporaryDirectory}/dangling`, `${temporaryDirectory}/gone`);

    await expect(filesystem.exists(`${temporaryDirectory}/live`)).resolves.toBe(true);
    await expect(filesystem.exists(`${temporaryDirectory}/dangling`)).resolves.toBe(false);
  });

  it("reports a symlink as a symlink, and resolves it to what it points at", async () => {
    const filesystem = create();
    await filesystem.mkdirp(`${temporaryDirectory}/devices/real`);
    await link(
      filesystem,
      `${temporaryDirectory}/devices/ios`,
      `${temporaryDirectory}/devices/real`,
    );

    await expect(filesystem.lstat(`${temporaryDirectory}/devices/ios`)).resolves.toMatchObject({
      kind: "symlink",
    });
    await expect(filesystem.stat(`${temporaryDirectory}/devices/ios`)).resolves.toMatchObject({
      kind: "directory",
    });
    await expect(filesystem.realpath(`${temporaryDirectory}/devices/ios`)).resolves.toBe(
      await filesystem.realpath(`${temporaryDirectory}/devices/real`),
    );
  });

  it("refuses to answer for a path that runs through a file", async () => {
    // A mistyped device root -- `<home>/notes.txt/ios` -- is a different problem from one
    // that is simply not there yet, and callers can only tell them apart by the errno.
    const filesystem = create();

    await filesystem.mkdirp(temporaryDirectory);
    await filesystem.writeFileAtomic(`${temporaryDirectory}/notes.txt`, "");

    await expect(filesystem.exists(`${temporaryDirectory}/notes.txt/ios`)).rejects.toMatchObject({
      code: "ENOTDIR",
    });
  });

  it("sizes a directory as the bytes of the files under it, subdirectories included, without following a symlink", async () => {
    const filesystem = create();
    const root = `${temporaryDirectory}/image`;
    await filesystem.mkdirp(`${root}/data`);
    await filesystem.mkdirp(`${temporaryDirectory}/outside`);
    await filesystem.writeFileAtomic(`${root}/system.img`, "abcd");
    await filesystem.writeFileAtomic(`${root}/data/userdata.img`, "0123456789");
    await filesystem.writeFileAtomic(`${temporaryDirectory}/outside/big.img`, "x".repeat(100));
    await link(filesystem, `${root}/linked`, `${temporaryDirectory}/outside`);

    await expect(filesystem.directorySize(root)).resolves.toBe(14);
  });

  it("refuses to size a directory that is not there", async () => {
    const filesystem = create();

    await expect(filesystem.directorySize(`${temporaryDirectory}/missing`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe.each(implementations)("Filesystem ownership contract: $name", ({ create }) => {
  it("reports what a path is, who owns it, and how exposed it is", async () => {
    const filesystem = create();
    const root = `${temporaryDirectory}/devices/ios`;

    await filesystem.mkdirp(root);
    await filesystem.chmod(root, 0o700);

    await expect(filesystem.lstat(root)).resolves.toEqual({
      kind: "directory",
      mode: 0o700,
      uid: process.getuid?.() ?? 0,
    });
  });

  it("reports the permission bits a path was last given, not the ones it was created with", async () => {
    const filesystem = create();
    const root = `${temporaryDirectory}/devices/ios`;

    await filesystem.mkdirp(`${temporaryDirectory}/devices`);
    await filesystem.mkdir(root, { mode: 0o777 });
    await filesystem.chmod(root, 0o700);

    await expect(filesystem.lstat(root)).resolves.toMatchObject({ mode: 0o700 });
  });

  it("refuses to create a directory that already exists", async () => {
    const filesystem = create();
    const root = `${temporaryDirectory}/devices/ios`;

    await filesystem.mkdirp(root);

    await expect(filesystem.mkdir(root)).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("creates only the final path segment", async () => {
    const filesystem = create();

    await expect(filesystem.mkdir(`${temporaryDirectory}/devices/ios`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("resolves a path to one that resolves to itself", async () => {
    const filesystem = create();
    const root = `${temporaryDirectory}/devices/ios`;

    await filesystem.mkdirp(root);
    const resolved = await filesystem.realpath(root);

    expect(resolved.endsWith("/devices/ios")).toBe(true);
    await expect(filesystem.realpath(resolved)).resolves.toBe(resolved);
  });
});

describe("MemoryFilesystem", () => {
  it("resolves symlinked path components, not just the last one", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/private/devices/ios");
    filesystem.defineSymlink("/devices", "/private/devices");

    await expect(filesystem.realpath("/devices/ios")).resolves.toBe("/private/devices/ios");
  });

  it("reports the ownership and permissions a test defines for a path", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/devices/ios");
    filesystem.defineAttributes("/devices/ios", { uid: 4242, mode: 0o755 });

    await expect(filesystem.lstat("/devices/ios")).resolves.toEqual({
      kind: "directory",
      mode: 0o755,
      uid: 4242,
    });
  });

  it("refuses to size a directory when a path under it was declared broken", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/image/data");
    await filesystem.writeFileAtomic("/image/data/userdata.img", "0123456789");
    filesystem.defineFailure("/image/data/userdata.img", "EACCES");

    await expect(filesystem.directorySize("/image")).rejects.toMatchObject({ code: "EACCES" });
  });

  it("fails at a path a test declared broken, with the errno it declared", async () => {
    // The only way to reach the branches that turn a filesystem failure into a typed
    // rejection: an EACCES on a device root cannot be produced by writing to the double.
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/devices/ios");
    filesystem.defineFailure("/devices/ios", "EACCES");

    await expect(filesystem.lstat("/devices/ios")).rejects.toMatchObject({ code: "EACCES" });
    await expect(filesystem.readdir("/devices/ios")).rejects.toMatchObject({ code: "EACCES" });
    await expect(filesystem.mkdirp("/devices/ios")).rejects.toMatchObject({ code: "EACCES" });
  });

  it("gives a new directory owner-only permissions unless a mode says otherwise", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/devices");

    await filesystem.mkdir("/devices/ios");

    await expect(filesystem.lstat("/devices/ios")).resolves.toMatchObject({ mode: 0o700 });
  });
});
