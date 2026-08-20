import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
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
  it("discards every record and returns itself for child()", () => {
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
  const directory = await mkdtemp(join(tmpdir(), "pitlane-logger-"));
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
});
