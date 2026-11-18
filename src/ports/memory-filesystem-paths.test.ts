import { describe, expect, it } from "vitest";

import { MemoryFilesystem } from "./index.js";

const STYLES = ["D:\\a\\b", "\\a\\b", "D:/a/b", "/a/b"] as const;

async function withTree(): Promise<MemoryFilesystem> {
  const filesystem = new MemoryFilesystem();
  await filesystem.mkdirp("/a");
  return filesystem;
}

describe("MemoryFilesystem path styles", () => {
  it("reads `D:\\a\\b`, `\\a\\b`, `D:/a/b` and `/a/b` as one entry, `C:\\a` and `D:\\a` as one, and returns the `/` form", async () => {
    for (const written of STYLES) {
      for (const read of STYLES) {
        const filesystem = await withTree();
        await filesystem.writeFileAtomic(written, "x");
        expect(await filesystem.readFile(read), `write ${written}, read ${read}`).toBe("x");
        expect(await filesystem.readdir("D:\\a"), `readdir after ${written}`).toEqual(["b"]);
        await filesystem.rename(read, "C:\\a\\c");
        expect(await filesystem.exists("/a/b"), `rename from ${read}`).toBe(false);
        expect(await filesystem.readFile("/a/c")).toBe("x");
        await filesystem.rm(read === "/a/b" ? "D:\\a\\c" : "\\a\\c");
        expect(await filesystem.exists("/a/c")).toBe(false);
      }
    }

    const made = new MemoryFilesystem();
    await made.mkdirp("D:\\x\\y");
    expect((await made.lstat("/x/y")).kind).toBe("directory");
    expect(await made.realpath("D:\\x")).toBe("/x");

    const linked = await withTree();
    linked.defineSymlink("/link", "D:\\a");
    await linked.writeFileAtomic("/a/f", "y");
    expect(await linked.realpath("/link")).toBe("/a");
    expect(await linked.readFile("/link/f")).toBe("y");

    const injected = await withTree();
    injected.defineFailure("D:\\a\\f", "EIO");
    await expect(injected.readFile("/a/f")).rejects.toMatchObject({ code: "EIO" });

    const replaced = await withTree();
    replaced.defineSymlink("/link", "/a");
    await replaced.replaceSymlink("/link", "D:\\a\\other");
    expect(await replaced.readlink("/link")).toBe("/a/other");

    const relative = new MemoryFilesystem();
    relative.defineFailure("rel\\file", "EIO");
    await expect(relative.readFile("rel\\file")).rejects.toMatchObject({ code: "EIO" });
    await expect(relative.readFile("/rel/file")).rejects.toMatchObject({ code: "ENOENT" });

    const missing = new MemoryFilesystem();
    await expect(missing.readFile("D:\\nope")).rejects.toThrow(/D:\\nope|\/nope/);
  });
});
