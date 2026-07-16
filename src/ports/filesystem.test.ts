import { afterEach, describe, expect, it } from "vitest";

import { type Filesystem, MemoryFilesystem, NodeFilesystem } from "./index.js";

const temporaryDirectory = `${process.cwd()}/.pitlane-ports-test`;

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

describe("MemoryFilesystem", () => {
  it("reports its configured free disk space", async () => {
    const filesystem = new MemoryFilesystem(42_000);

    await expect(filesystem.diskFree("/")).resolves.toBe(42_000);
  });
});
