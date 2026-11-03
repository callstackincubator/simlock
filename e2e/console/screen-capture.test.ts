import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { NodeBytePipeLauncher } from "../../dist/ports/index.js";
import { captureLog, writeCaptureProgram } from "./screen-capture.js";

// why: the console lane reads this program's log as its proof that a capture stopped, so the log
// must say "closed" for each way the daemon stops one. A viewer leaving cancels the feed's body,
// which destroys the program's stdout before the feed's close ends its stdin
// (`src/stream/feed.ts` `followedBy`); the real capture program takes either as its end
// (`vendor/screen-capture/Sources/SimlockCapture/Options.swift`, EPIPE is "the viewer going away").
// A loaded runner can let the program write between the two steps. The second case makes that gap
// on purpose: it waits for the program to act on the lost reader before it ends stdin.

describe("the console lane's capture program", () => {
  it("logs closed when its stdin ends and when its reader goes away before its stdin ends", async () => {
    const cases = [
      { cancelReaderFirst: false, name: "stdin ends" },
      { cancelReaderFirst: true, name: "reader goes away first" },
    ];
    const logs: Record<string, readonly string[]> = {};
    for (const { cancelReaderFirst, name } of cases) {
      const dir = await mkdtemp(join(tmpdir(), "simlock-capture-"));
      try {
        const command = await writeCaptureProgram(dir);
        const child = new NodeBytePipeLauncher().start(command, ["device-1"], {
          env: process.env,
        });
        const reader = child.stdout.getReader();
        const first = await reader.read();
        expect(first.done).toBe(false);
        if (cancelReaderFirst) {
          await reader.cancel();
          await child.exited;
        }
        child.closeStdin();
        await child.exited;
        logs[name] = (await captureLog(dir))
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => line.split(" ")[0] ?? "");
      } finally {
        await rm(dir, { force: true, recursive: true });
      }
    }
    expect(logs).toEqual({
      "reader goes away first": ["opened", "closed"],
      "stdin ends": ["opened", "closed"],
    });
  });
});
