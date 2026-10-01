import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import { FakeClock, MemoryFilesystem } from "../ports/index.js";
import { followLog } from "./follow-log.js";

const LOG = "/simlock/daemon.log";

/** A filesystem that rotates the log once, from inside the next read of `trigger` -- the
 * narrowest window a real rotation can land in. */
class RotatingFilesystem extends MemoryFilesystem {
  #armed: { readonly trigger: string; readonly rotate: () => Promise<void> } | undefined;

  rotateDuringNextReadOf(trigger: string, rotate: () => Promise<void>): void {
    this.#armed = { rotate, trigger };
  }

  override async readFileFrom(path: string, offset: number): Promise<string> {
    const armed = this.#armed;
    if (armed !== undefined && armed.trigger === path) {
      this.#armed = undefined;
      await armed.rotate();
    }
    return super.readFileFrom(path, offset);
  }
}

async function start(filesystem: MemoryFilesystem) {
  const clock = new FakeClock(0);
  const signals = new EventEmitter();
  let out = "";
  const done = followLog({
    clock,
    filesystem,
    path: LOG,
    signals,
    write: (text) => {
      out += text;
    },
  });
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  await settle();
  return {
    clock,
    done,
    output: () => out,
    signals,
    tick: async () => {
      clock.advance(250);
      await settle();
    },
  };
}

async function seed(filesystem: MemoryFilesystem, contents: string): Promise<void> {
  await filesystem.mkdirp("/simlock");
  await filesystem.writeFileAtomic(LOG, contents);
}

describe("followLog", () => {
  it("a rotation between a poll's rotation check and its read loses no line and prints none twice", async () => {
    const filesystem = new RotatingFilesystem();
    await seed(filesystem, "a\n");
    const run = await start(filesystem);

    await filesystem.writeFileAtomic(LOG, "a\nb\n");
    filesystem.rotateDuringNextReadOf(LOG, async () => {
      await filesystem.rename(LOG, `${LOG}.1`);
      await filesystem.writeFileAtomic(LOG, "after rotation 1\nafter rotation 2\n");
    });
    await run.tick();
    await run.tick();

    expect(run.output()).toBe("a\nb\nafter rotation 1\nafter rotation 2\n");
    run.signals.emit("SIGINT");
    await run.done;
  });

  it("a rotation during the initial tail does not reprint the tail as new lines", async () => {
    const filesystem = new RotatingFilesystem();
    await seed(filesystem, "a\nb\n");
    filesystem.rotateDuringNextReadOf(LOG, async () => {
      await filesystem.rename(LOG, `${LOG}.1`);
      await filesystem.writeFileAtomic(LOG, "c\n");
    });
    const run = await start(filesystem);
    await run.tick();

    expect(run.output()).toBe("a\nb\nc\n");
    run.signals.emit("SIGINT");
    await run.done;
  });

  it("the unfinished last line of a rotated file is printed, ending in a newline", async () => {
    const filesystem = new MemoryFilesystem();
    await seed(filesystem, "a\n");
    const run = await start(filesystem);

    await filesystem.writeFileAtomic(LOG, "a\npartial");
    await filesystem.rename(LOG, `${LOG}.1`);
    await filesystem.writeFileAtomic(LOG, "next\n");
    await run.tick();

    expect(run.output()).toBe("a\npartial\nnext\n");
    run.signals.emit("SIGINT");
    await run.done;
  });

  it("a read that fails for a reason other than a missing file rejects, leaving no timer or handler", async () => {
    const filesystem = new MemoryFilesystem();
    await seed(filesystem, "a\n");
    const run = await start(filesystem);

    filesystem.defineFailure(LOG, "EACCES");
    await run.tick();

    await expect(run.done).rejects.toMatchObject({ code: "EACCES" });
    expect(run.clock.pendingTimerCount).toBe(0);
    expect(run.signals.listenerCount("SIGINT")).toBe(0);
    expect(run.signals.listenerCount("SIGTERM")).toBe(0);
  });
});
