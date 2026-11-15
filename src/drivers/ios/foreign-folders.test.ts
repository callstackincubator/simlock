import { describe, expect, it } from "vitest";

import { swapForeignFolders } from "./foreign-folders.js";

const folders = {
  deviceSet: "/private/tmp/h/devices/ios",
  logsRoot: "/Users/al/Library/Logs/CoreSimulator",
  ownUdid: "11111111-1111-1111-1111-111111111111",
  sourcesSet: "/private/tmp/h/devices/src",
};
const seed = "AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA";
const usedCopy = "BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB";
const own = folders.ownUdid;

// why: the swap is a pure function with many byte-level cases (spellings, separators, binary neighbours) that a `provision` leans on; the driver's own test proves the files and links it is applied to.
describe("swapForeignFolders", () => {
  it.each([
    {
      name: "a seed's folder becomes the copy's own",
      before: `x ${folders.sourcesSet}/${seed}/data y`,
      after: `x ${folders.deviceSet}/${own}/data y`,
    },
    {
      name: "the folder a baseline was saved from becomes the copy's own",
      before: `${folders.deviceSet}/${usedCopy}/data/Media`,
      after: `${folders.deviceSet}/${own}/data/Media`,
    },
    {
      name: "a log folder becomes the copy's own log folder",
      before: `${folders.logsRoot}/${seed}`,
      after: `${folders.logsRoot}/${own}`,
    },
    {
      name: "the spelling without /private keeps that spelling",
      before: `/tmp/h/devices/src/${seed}/x`,
      after: `/tmp/h/devices/ios/${own}/x`,
    },
    {
      name: "a JSON path with escaped separators keeps them escaped",
      before: `{"p":"\\/private\\/tmp\\/h\\/devices\\/src\\/${seed}\\/x"}`,
      after: `{"p":"\\/private\\/tmp\\/h\\/devices\\/ios\\/${own}\\/x"}`,
    },
    {
      name: "a path already naming the copy is unchanged",
      before: `${folders.deviceSet}/${own}/data ${folders.logsRoot}/${own}`,
      after: `${folders.deviceSet}/${own}/data ${folders.logsRoot}/${own}`,
    },
    {
      name: "bytes around a path, binary ones included, are kept",
      before: `\u0000ÿ\u0080${folders.sourcesSet}/${seed}\u0001þ`,
      after: `\u0000ÿ\u0080${folders.deviceSet}/${own}\u0001þ`,
    },
    {
      name: "a path of some other folder is unchanged",
      before: `/private/tmp/other/devices/src/${seed}`,
      after: `/private/tmp/other/devices/src/${seed}`,
    },
  ])("$name, the length unchanged", ({ before, after }) => {
    const swapped = swapForeignFolders(Buffer.from(before, "latin1"), folders);

    expect(Buffer.from(swapped).toString("latin1")).toBe(after);
    expect(swapped.length).toBe(before.length);
  });
});
