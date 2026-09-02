import { symlink } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { type Filesystem, MemoryFilesystem, NodeFilesystem } from "./index.js";

const temporaryDirectory = `${process.cwd()}/.simlock-ports-test`;

const implementations: Array<{
  name: string;
  create(): Filesystem;
}> = [
  {
    name: "memory filesystem",
    create: () => new MemoryFilesystem(),
  },
  {
    name: "node filesystem",
    create: () => new NodeFilesystem(),
  },
];

afterEach(async () => {
  await new NodeFilesystem().rm(temporaryDirectory);
});

describe.each(implementations)("Filesystem contract: $name", ({ create }) => {
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

  it("creates nested directories idempotently", async () => {
    const filesystem = create();
    const directory = `${temporaryDirectory}/devices/ready`;

    await filesystem.mkdirp(directory);
    await filesystem.mkdirp(directory);

    await expect(filesystem.stat(directory)).resolves.toMatchObject({ kind: "directory" });
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
  it("reports its configured free disk space", async () => {
    const filesystem = new MemoryFilesystem(42_000);

    await expect(filesystem.diskFree("/")).resolves.toBe(42_000);
  });

  it("reports a defined symlink as a symlink rather than as what it points at", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/devices/real");
    filesystem.defineSymlink("/devices/ios", "/devices/real");

    await expect(filesystem.lstat("/devices/ios")).resolves.toMatchObject({ kind: "symlink" });
    await expect(filesystem.stat("/devices/ios")).resolves.toMatchObject({ kind: "directory" });
    await expect(filesystem.realpath("/devices/ios")).resolves.toBe("/devices/real");
  });

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

  it("gives a new directory owner-only permissions unless a mode says otherwise", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/devices");

    await filesystem.mkdir("/devices/ios");

    await expect(filesystem.lstat("/devices/ios")).resolves.toMatchObject({ mode: 0o700 });
  });
});

describe("NodeFilesystem", () => {
  it("reports a symlink without following it", async () => {
    const filesystem = new NodeFilesystem();
    await filesystem.mkdirp(`${temporaryDirectory}/devices/real`);
    await symlink(`${temporaryDirectory}/devices/real`, `${temporaryDirectory}/devices/ios`);

    await expect(filesystem.lstat(`${temporaryDirectory}/devices/ios`)).resolves.toMatchObject({
      kind: "symlink",
    });
    await expect(filesystem.realpath(`${temporaryDirectory}/devices/ios`)).resolves.toBe(
      await filesystem.realpath(`${temporaryDirectory}/devices/real`),
    );
  });
});
