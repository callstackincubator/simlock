import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { expectClipboardIsolated } from "./clipboard.js";

type Sync = "off" | "before device write" | "after device write";

const clipboards = { device: "", host: "" };
let hostToDevice: Sync = "off";

function write(target: "device" | "host", value: string): void {
  clipboards[target] = value;
  if (target !== "host" || hostToDevice === "off") return;
  if (hostToDevice === "before device write") {
    clipboards.device = value;
  } else {
    setTimeout(() => {
      clipboards.device = value;
    }, 500);
  }
}

vi.mock("node:child_process", () => ({
  execFile: (command: string, args: unknown, callback?: unknown) => {
    const done = (typeof args === "function" ? args : callback) as (
      error: null,
      result: { stderr: string; stdout: string },
    ) => void;
    const target = command === "pbpaste" ? "host" : "device";
    done(null, { stderr: "", stdout: clipboards[target] });
  },
  spawn: (command: string) => {
    const child = Object.assign(new EventEmitter(), {
      stderr: Object.assign(new EventEmitter(), { setEncoding: () => undefined }),
      stdin: {
        end: (value: string) => {
          write(command === "pbcopy" ? "host" : "device", value);
          queueMicrotask(() => child.emit("close", 0));
        },
      },
    });
    return child;
  },
}));

async function outcome(sync: Sync): Promise<string> {
  clipboards.device = "";
  clipboards.host = "";
  hostToDevice = sync;
  const result = expectClipboardIsolated("UDID").then(
    () => "passed",
    (error: Error) => error.message.split(":")[0] ?? "",
  );
  await vi.advanceTimersByTimeAsync(20_000);
  return result;
}

// why: an ordering the surface cannot force: the slow lane's real clipboards decide when a sync
// lands, so only this fake pair can land it before or after the device write.
describe("expectClipboardIsolated", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes when neither clipboard syncs", async () => {
    expect(await outcome("off")).toBe("passed");
  });

  it("reports host-to-device sync at the same check whether it lands before or after the device write", async () => {
    expect([await outcome("before device write"), await outcome("after device write")]).toEqual([
      "host change did not reach device",
      "host change did not reach device",
    ]);
  });
});
