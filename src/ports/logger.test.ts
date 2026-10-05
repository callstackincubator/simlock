import { mkdtemp, readFile, readdir, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { FakeClock } from "./clock.js";
import { JsonLinesLogger, MemoryLogSink, NodeFileLogSink, NoopLogger } from "./logger.js";

describe("JsonLinesLogger", () => {
  it("writes one JSON object per line with timestamp, level, module, message, and fields", () => {
    const clock = new FakeClock(1_000);
    const sink = new MemoryLogSink();
    const logger = new JsonLinesLogger({ clock, level: "debug", module: "daemon", sink });

    logger.info("Daemon starting", { version: "1.0.0" });

    expect(sink.records).toHaveLength(1);
    expect(sink.records).toEqual([
      {
        timestamp: 1_000,
        level: "info",
        module: "daemon",
        message: "Daemon starting",
        fields: { version: "1.0.0" },
      },
    ]);
  });

  it("omits the fields key when no fields are given", () => {
    const sink = new MemoryLogSink();
    const logger = new JsonLinesLogger({ clock: new FakeClock(), sink });

    logger.info("Daemon starting");

    expect(sink.records[0]).not.toHaveProperty("fields");
  });

  it("derives the timestamp from the injected clock, never Date.now", () => {
    const clock = new FakeClock(42);
    const sink = new MemoryLogSink();
    const logger = new JsonLinesLogger({ clock, sink });

    logger.info("tick");
    clock.advance(1_000);
    logger.info("tock");

    expect(sink.records.map((record) => record.timestamp)).toEqual([42, 1_042]);
  });

  it("filters records below the configured level", () => {
    const sink = new MemoryLogSink();
    const logger = new JsonLinesLogger({ clock: new FakeClock(), level: "warn", sink });

    logger.debug("too quiet");
    logger.info("still too quiet");
    logger.warn("loud enough");
    logger.error("also loud enough");

    expect(sink.records.map((record) => record.message)).toEqual([
      "loud enough",
      "also loud enough",
    ]);
  });

  it("defaults to the info level", () => {
    const sink = new MemoryLogSink();
    const logger = new JsonLinesLogger({ clock: new FakeClock(), sink });

    logger.debug("dropped");
    logger.info("kept");

    expect(sink.records.map((record) => record.message)).toEqual(["kept"]);
  });

  it("scopes child loggers by dot-joining the module name", () => {
    const sink = new MemoryLogSink();
    const logger = new JsonLinesLogger({ clock: new FakeClock(), module: "daemon", sink });

    logger.child("connection-host").info("Claimed socket");

    expect(sink.records[0]?.module).toBe("daemon.connection-host");
  });

  it("nests grandchild module scopes", () => {
    const sink = new MemoryLogSink();
    const logger = new JsonLinesLogger({ clock: new FakeClock(), module: "daemon", sink });

    logger.child("server").child("connection").info("opened");

    expect(sink.records[0]?.module).toBe("daemon.server.connection");
  });

  it("a child logger inherits the configured level", () => {
    const sink = new MemoryLogSink();
    const logger = new JsonLinesLogger({ clock: new FakeClock(), level: "error", sink });

    logger.child("server").warn("dropped");
    logger.child("server").error("kept");

    expect(sink.records.map((record) => record.message)).toEqual(["kept"]);
  });
});

describe("NoopLogger", () => {
  it("accepts a record at every level without throwing, and returns itself for child()", () => {
    const logger = new NoopLogger();
    expect(() => {
      logger.debug("x");
      logger.info("x");
      logger.warn("x");
      logger.error("x");
    }).not.toThrow();
    expect(logger.child("scoped")).toBe(logger);
  });
});

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "simlock-logger-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("NodeFileLogSink", () => {
  it("appends one line per write to the target file", async () => {
    const directory = await tempDir();
    const path = join(directory, "daemon.log");
    const sink = new NodeFileLogSink({ path });

    sink.write('{"a":1}');
    sink.write('{"a":2}');
    sink.close();

    expect(await readFile(path, "utf8")).toBe('{"a":1}\n{"a":2}\n');
  });

  it("creates the parent directory if missing", async () => {
    const directory = await tempDir();
    const path = join(directory, "nested", "daemon.log");
    const sink = new NodeFileLogSink({ path });

    sink.write("hello");
    sink.close();

    expect(await readFile(path, "utf8")).toBe("hello\n");
  });

  it("picks up the existing file size so rotation still triggers across restarts", async () => {
    const directory = await tempDir();
    const path = join(directory, "daemon.log");
    const first = new NodeFileLogSink({ path, maxBytes: 40 });
    first.write("a".repeat(30));
    first.close();

    const second = new NodeFileLogSink({ path, maxBytes: 40 });
    second.write("b".repeat(30));
    second.close();

    expect(await readdir(directory)).toEqual(["daemon.log", "daemon.log.1"]);
  });

  it("rotates to <path>.1 once a write would exceed the cap, keeping exactly one generation", async () => {
    const directory = await tempDir();
    const path = join(directory, "daemon.log");
    // "first\n" (6 bytes) + "second\n" (7 bytes) = 13 bytes, comfortably under the 30-byte
    // cap; the third write ("third-line-here\n", 17 bytes) would push the file to 30 bytes
    // exactly -- not over -- so a fourth write is what actually forces the rotation.
    const sink = new NodeFileLogSink({ path, maxBytes: 30 });

    sink.write("first"); // 6 bytes -> 6
    sink.write("second"); // 7 bytes -> 13
    sink.write("third-line-here"); // 16 bytes -> 29, still under the cap
    sink.write("fourth"); // 7 bytes; 29 + 7 > 30, rotates first
    sink.close();

    const entries = await readdir(directory);
    expect(entries.sort()).toEqual(["daemon.log", "daemon.log.1"]);
    const rotated = await readFile(join(directory, "daemon.log.1"), "utf8");
    expect(rotated).toBe("first\nsecond\nthird-line-here\n");
    const current = await readFile(path, "utf8");
    expect(current).toBe("fourth\n");
  });

  it("replaces an existing rotated generation instead of accumulating them", async () => {
    const directory = await tempDir();
    const path = join(directory, "daemon.log");
    const sink = new NodeFileLogSink({ path, maxBytes: 10 });

    sink.write("aaaaaaaaaa");
    sink.write("bbbbbbbbbb"); // rotates: aaaa -> daemon.log.1
    sink.write("cccccccccc"); // rotates again: bbbb -> daemon.log.1 (replacing aaaa)
    sink.close();

    expect(await readdir(directory)).toEqual(["daemon.log", "daemon.log.1"]);
    expect(await readFile(join(directory, "daemon.log.1"), "utf8")).toContain("bbbbbbbbbb");
    expect(await readFile(join(directory, "daemon.log.1"), "utf8")).not.toContain("aaaaaaaaaa");
  });

  describe("with a retention window and a total size cap", () => {
    const DAY = 24 * 60 * 60 * 1000;

    function stamped(timestamp: number, filler = ""): string {
      return JSON.stringify({ timestamp, filler });
    }

    async function generations(directory: string): Promise<string[]> {
      return (await readdir(directory)).sort();
    }

    it("a rotation renames the current file to .1 and shifts existing generations up by one", async () => {
      const directory = await tempDir();
      const path = join(directory, "events.jsonl");
      const clock = new FakeClock(1_000);
      const sink = new NodeFileLogSink({
        clock,
        maxBytes: 10,
        path,
        retentionMs: DAY,
        totalMaxBytes: 1_000_000,
      });

      sink.write("aaaaaaaaaa");
      sink.write("bbbbbbbbbb"); // rotates: a -> .1
      sink.write("cccccccccc"); // rotates: a -> .2, b -> .1
      sink.write("dddddddddd"); // rotates: a -> .3, b -> .2, c -> .1
      sink.close();

      expect(await generations(directory)).toEqual([
        "events.jsonl",
        "events.jsonl.1",
        "events.jsonl.2",
        "events.jsonl.3",
      ]);
      expect(await readFile(`${path}.1`, "utf8")).toBe("cccccccccc\n");
      expect(await readFile(`${path}.2`, "utf8")).toBe("bbbbbbbbbb\n");
      expect(await readFile(`${path}.3`, "utf8")).toBe("aaaaaaaaaa\n");
      expect(await readFile(path, "utf8")).toBe("dddddddddd\n");
    });

    it("a generation whose newest line is older than the retention is deleted on the next rotation", async () => {
      const directory = await tempDir();
      const path = join(directory, "events.jsonl");
      const clock = new FakeClock(0);
      const sink = new NodeFileLogSink({
        clock,
        maxBytes: 40,
        path,
        retentionMs: 1_000,
        totalMaxBytes: 1_000_000,
      });

      sink.write(stamped(0));
      sink.write(stamped(9_500)); // rotates: the line at 0 -> .1
      clock.advance(10_000);
      sink.write(stamped(10_000)); // rotates: .1 -> .2, 9_500 -> .1; the sweep drops .2

      sink.close();
      expect(await generations(directory)).toEqual(["events.jsonl", "events.jsonl.1"]);
      expect(await readFile(`${path}.1`, "utf8")).toContain('"timestamp":9500,');
    });

    it("keeps a generation whose newest line is still inside the retention, though it also holds old lines", async () => {
      const directory = await tempDir();
      const path = join(directory, "events.jsonl");
      const clock = new FakeClock(0);
      const sink = new NodeFileLogSink({
        clock,
        maxBytes: 200,
        path,
        retentionMs: 1_000,
        totalMaxBytes: 1_000_000,
      });

      sink.write(stamped(0));
      sink.write(stamped(9_500)); // the newest line of this generation is recent
      clock.advance(10_000);
      sink.write(stamped(10_000, "x".repeat(200))); // rotates: mixed generation -> .1

      sink.close();
      expect(await generations(directory)).toContain("events.jsonl.1");
    });

    it("when the generations exceed maxBytes the oldest are deleted until the total fits, and the current file is never deleted", async () => {
      const directory = await tempDir();
      const path = join(directory, "events.jsonl");
      const sink = new NodeFileLogSink({
        clock: new FakeClock(1_000),
        maxBytes: 10,
        path,
        retentionMs: DAY,
        totalMaxBytes: 25,
      });

      for (const letter of ["a", "b", "c", "d", "e", "f"]) sink.write(letter.repeat(10));
      sink.close();

      // 11-byte files: the current one plus at most one generation fit in 25 bytes.
      expect(await generations(directory)).toEqual(["events.jsonl", "events.jsonl.1"]);
      expect(await readFile(path, "utf8")).toBe("ffffffffff\n");
      expect(await readFile(`${path}.1`, "utf8")).toBe("eeeeeeeeee\n");
    });

    it("never deletes the current file even when it alone exceeds maxBytes", async () => {
      const directory = await tempDir();
      const path = join(directory, "events.jsonl");
      const sink = new NodeFileLogSink({
        clock: new FakeClock(1_000),
        maxBytes: 100,
        path,
        retentionMs: DAY,
        totalMaxBytes: 5,
      });

      sink.write("a".repeat(50));
      sink.close();

      expect(await readFile(path, "utf8")).toBe(`${"a".repeat(50)}\n`);
    });

    it("a sink without retention options keeps one generation, as daemon.log does today", async () => {
      const directory = await tempDir();
      const path = join(directory, "daemon.log");
      const sink = new NodeFileLogSink({ maxBytes: 10, path });

      for (const letter of ["a", "b", "c", "d"]) sink.write(letter.repeat(10));
      sink.close();

      expect(await generations(directory)).toEqual(["daemon.log", "daemon.log.1"]);
    });

    it("the sweep runs when the sink opens, so a generation past retention is deleted at daemon start without a rotation", async () => {
      const directory = await tempDir();
      const path = join(directory, "events.jsonl");
      const writer = new NodeFileLogSink({ maxBytes: 10_000, path });
      writer.write(stamped(5));
      writer.close();
      await rename(path, `${path}.1`);
      await writeFile(path, `${stamped(9_000_000)}\n`);

      const sink = new NodeFileLogSink({
        clock: new FakeClock(10_000_000),
        maxBytes: 10_000,
        path,
        retentionMs: 1_000,
        totalMaxBytes: 1_000_000,
      });
      sink.close();

      expect(await generations(directory)).toEqual(["events.jsonl"]);
    });

    it("keeps numbered generations with only a retention", async () => {
      const directory = await tempDir();
      const path = join(directory, "events.jsonl");
      const sink = new NodeFileLogSink({
        clock: new FakeClock(1_000),
        maxBytes: 10,
        path,
        retentionMs: DAY,
      });

      for (const letter of ["a", "b", "c", "d"]) sink.write(letter.repeat(10));
      sink.close();

      expect(await generations(directory)).toEqual([
        "events.jsonl",
        "events.jsonl.1",
        "events.jsonl.2",
        "events.jsonl.3",
      ]);
    });

    it("keeps numbered generations with only a total size cap, and deletes the oldest to fit it", async () => {
      const directory = await tempDir();
      const path = join(directory, "events.jsonl");
      const sink = new NodeFileLogSink({ maxBytes: 10, path, totalMaxBytes: 30 });

      for (const letter of ["a", "b", "c", "d"]) sink.write(letter.repeat(10));
      sink.close();

      // Each file is 11 bytes: the current file plus one generation fit 30, a second do not.
      expect(await generations(directory)).toEqual(["events.jsonl", "events.jsonl.1"]);
      expect(await readFile(`${path}.1`, "utf8")).toBe("cccccccccc\n");
      expect(await readFile(path, "utf8")).toBe("dddddddddd\n");
    });

    it("keeps a generation whose newest line is exactly at the retention boundary", async () => {
      const directory = await tempDir();
      const path = join(directory, "events.jsonl");
      await writeFile(`${path}.1`, `${stamped(9_000)}\n`);
      await writeFile(path, "");

      const sink = new NodeFileLogSink({
        clock: new FakeClock(10_000),
        maxBytes: 10_000,
        path,
        retentionMs: 1_000,
      });
      sink.close();

      expect(await generations(directory)).toEqual(["events.jsonl", "events.jsonl.1"]);
    });

    it("at open deletes as many of the oldest generations as it takes to fit the total, and no more", async () => {
      const directory = await tempDir();
      const path = join(directory, "events.jsonl");
      for (const generation of [1, 2, 3, 4]) {
        await writeFile(`${path}.${generation}`, `${"x".repeat(9)}\n`);
      }
      // The current file counts as one full generation (10 bytes) plus three of 10 = exactly 40.

      const sink = new NodeFileLogSink({ maxBytes: 10, path, totalMaxBytes: 40 });
      sink.close();

      expect(await generations(directory)).toEqual([
        "events.jsonl",
        "events.jsonl.1",
        "events.jsonl.2",
        "events.jsonl.3",
      ]);
    });

    it("at open deletes several generations when two or more do not fit", async () => {
      const directory = await tempDir();
      const path = join(directory, "events.jsonl");
      for (const generation of [1, 2, 3, 4]) {
        await writeFile(`${path}.${generation}`, `${"x".repeat(9)}\n`);
      }

      const sink = new NodeFileLogSink({ maxBytes: 10, path, totalMaxBytes: 25 });
      sink.close();

      expect(await generations(directory)).toEqual(["events.jsonl", "events.jsonl.1"]);
    });

    it("does not count a generation already deleted for age against the size cap", async () => {
      const directory = await tempDir();
      const path = join(directory, "events.jsonl");
      // Each line is 16 bytes with its newline. The current file counts as one full 16-byte
      // generation, so .1 and .2 fit a 48-byte cap exactly -- but not with .3 counted too.
      await writeFile(`${path}.1`, `{"timestamp":9500}\n`);
      await writeFile(`${path}.2`, `{"timestamp":9400}\n`);
      await writeFile(`${path}.3`, `{"timestamp":5}\n`);
      const lineBytes = Buffer.byteLength(`{"timestamp":9500}\n`);

      const sink = new NodeFileLogSink({
        clock: new FakeClock(10_000),
        maxBytes: lineBytes,
        path,
        retentionMs: 1_000,
        totalMaxBytes: 3 * lineBytes,
      });
      sink.close();

      expect(await generations(directory)).toEqual([
        "events.jsonl",
        "events.jsonl.1",
        "events.jsonl.2",
      ]);
    });

    it("judges a generation whose last line carries no timestamp by its file time", async () => {
      const directory = await tempDir();
      const path = join(directory, "events.jsonl");
      const staleFile = new Date(1_000);
      for (const [generation, lastLine] of [
        [1, '{"other":1}'],
        [2, "null"],
        [3, "not json"],
      ] as const) {
        await writeFile(`${path}.${generation}`, `${lastLine}\n`);
        await utimes(`${path}.${generation}`, staleFile, staleFile);
      }

      const sink = new NodeFileLogSink({
        clock: new FakeClock(10_000_000),
        maxBytes: 10_000,
        path,
        retentionMs: 1_000,
      });
      sink.close();

      expect(await generations(directory)).toEqual(["events.jsonl"]);
    });

    it("keeps a generation whose last line carries no timestamp while its file time is within retention", async () => {
      const directory = await tempDir();
      const path = join(directory, "events.jsonl");
      const freshFile = new Date(9_999_500);
      for (const [generation, lastLine] of [
        [1, '{"other":1}'],
        [2, "null"],
        [3, "not json"],
      ] as const) {
        await writeFile(`${path}.${generation}`, `${lastLine}\n`);
        await utimes(`${path}.${generation}`, freshFile, freshFile);
      }

      const sink = new NodeFileLogSink({
        clock: new FakeClock(10_000_000),
        maxBytes: 10_000,
        path,
        retentionMs: 1_000,
      });
      sink.close();

      expect(await generations(directory)).toEqual([
        "events.jsonl",
        "events.jsonl.1",
        "events.jsonl.2",
        "events.jsonl.3",
      ]);
    });

    it("deletes only the files it rotated beside its own path, never a neighbour", async () => {
      const directory = await tempDir();
      const path = join(directory, "events.jsonl");
      await writeFile(join(directory, "events.jsonl.backup"), "keep\n");
      await writeFile(join(directory, "other.jsonl.1"), "keep\n");
      const sink = new NodeFileLogSink({
        clock: new FakeClock(1_000),
        maxBytes: 10,
        path,
        retentionMs: 1,
        totalMaxBytes: 12,
      });

      for (const letter of ["a", "b", "c", "d"]) sink.write(letter.repeat(10));
      sink.close();

      const kept = await generations(directory);
      expect(kept).toContain("events.jsonl.backup");
      expect(kept).toContain("other.jsonl.1");
    });
  });
});
