import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FakeClock,
  type Filesystem,
  JsonLinesLogger,
  MemoryFilesystem,
  MemoryLogSink,
  NodeFileLogSink,
  NodeFilesystem,
} from "../ports/index.js";
import {
  EVENT_FILE_NAME,
  EventBus,
  type EventEnvelope,
  EventHistory,
  readEventFile,
} from "./index.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function eventFilePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "simlock-event-file-"));
  directories.push(directory);
  return join(directory, EVENT_FILE_NAME);
}

function memoryLogger(): { readonly logger: JsonLinesLogger; readonly sink: MemoryLogSink } {
  const sink = new MemoryLogSink();
  return { logger: new JsonLinesLogger({ clock: new FakeClock(), sink }), sink };
}

function history(options: {
  readonly bus: EventBus;
  readonly path: string;
  readonly sink?: NodeFileLogSink | { write(line: string): void };
  readonly filesystem?: Filesystem;
  readonly logger?: JsonLinesLogger;
}): EventHistory {
  return new EventHistory({
    bus: options.bus,
    filesystem: options.filesystem ?? new NodeFilesystem(),
    logger: options.logger ?? memoryLogger().logger,
    path: options.path,
    ...(options.sink === undefined ? {} : { sink: options.sink }),
  });
}

function envelope(seq: number, timestamp: number, id = `evt_${seq}`): EventEnvelope {
  return {
    id,
    seq,
    timestamp,
    event: "daemon.stopping",
    payload: { reason: `r${seq}` },
    module: "daemon",
  };
}

function lines(...envelopes: EventEnvelope[]): string {
  return envelopes.map((entry) => `${JSON.stringify(entry)}\n`).join("");
}

describe("EventHistory", () => {
  it("writes every emitted event as one JSON line equal to its envelope", async () => {
    const path = await eventFilePath();
    const bus = new EventBus(new FakeClock(1_000));
    history({ bus, path, sink: new NodeFileLogSink({ path }) });

    const first = bus.emit("daemon.stopping", { reason: "line\nbreak" }, "daemon");
    const second = bus.emit(
      "lease.expired",
      { leaseId: "l-1", deviceId: "d-1", ownerId: "o-1" },
      "leases",
    );

    const written = (await readFile(path, "utf8")).trimEnd().split("\n");
    expect(written.map((line) => JSON.parse(line) as unknown)).toEqual([first, second]);
  });

  it("logs a throwing sink once, and later events still reach the ring and other subscribers", async () => {
    const path = await eventFilePath();
    const bus = new EventBus(new FakeClock(1_000));
    const { logger, sink: logSink } = memoryLogger();
    const write = vi.fn(() => {
      throw new Error("disk full");
    });
    history({ bus, path, sink: { write }, logger });
    const delivered: string[] = [];
    bus.subscribeAll((entry) => delivered.push(entry.event));

    bus.emit("daemon.stopping", { reason: "a" }, "daemon");
    bus.emit("daemon.stopping", { reason: "b" }, "daemon");

    expect(write).toHaveBeenCalledTimes(1);
    expect(logSink.records.filter((record) => record.level === "error")).toHaveLength(1);
    expect(delivered).toEqual(["daemon.stopping", "daemon.stopping"]);
    expect(bus.replay().map((entry) => entry.payload)).toEqual([{ reason: "a" }, { reason: "b" }]);
  });

  it("replays with sinceTs the events an earlier bus wrote to the same file", async () => {
    const path = await eventFilePath();
    const earlierSink = new NodeFileLogSink({ path });
    const earlier = new EventBus(new FakeClock(1_000));
    history({ bus: earlier, path, sink: earlierSink });
    const granted = earlier.emit(
      "lease.granted",
      { leaseId: "l-1", deviceId: "d-1", requester: "agent" },
      "leases",
    );
    earlierSink.close();

    const later = new EventBus(new FakeClock(2_000));
    const restarted = history({ bus: later, path, sink: new NodeFileLogSink({ path }) });

    expect(await restarted.replay({ sinceTs: 0 })).toEqual([granted]);
  });

  it("replays with sinceTs the events the ring has already overwritten", async () => {
    const path = await eventFilePath();
    const bus = new EventBus(new FakeClock(1_000), 1);
    const events = history({ bus, path, sink: new NodeFileLogSink({ path }) });

    const first = bus.emit("daemon.stopping", { reason: "a" }, "daemon");
    const second = bus.emit("daemon.stopping", { reason: "b" }, "daemon");

    expect(bus.replay()).toEqual([second]);
    expect(await events.replay({ sinceTs: 0 })).toEqual([first, second]);
  });

  it("replays the ring without sinceTs and reads no file", async () => {
    const path = await eventFilePath();
    const bus = new EventBus(new FakeClock(1_000));
    const filesystem = new NodeFilesystem();
    const readSpy = vi.spyOn(filesystem, "readFile");
    const events = history({ bus, filesystem, path, sink: new NodeFileLogSink({ path }) });
    const emitted = bus.emit("daemon.stopping", { reason: "a" }, "daemon");

    expect(await events.replay()).toEqual([emitted]);
    expect(readSpy).not.toHaveBeenCalled();
  });

  it("replays with sinceTs from the ring when there is no sink", async () => {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/data");
    await filesystem.writeFileAtomic("/data/events.jsonl", lines(envelope(9, 900)));
    const bus = new EventBus(new FakeClock(1_000));
    const events = history({ bus, filesystem, path: "/data/events.jsonl" });
    const emitted = bus.emit("daemon.stopping", { reason: "a" }, "daemon");

    expect(await events.replay({ sinceTs: 0 })).toEqual([emitted]);
  });

  it("replays with sinceTs from the ring when the event file cannot be read", async () => {
    const path = await eventFilePath();
    const bus = new EventBus(new FakeClock(1_000));
    const filesystem = new NodeFilesystem();
    vi.spyOn(filesystem, "readFile").mockRejectedValue(
      Object.assign(new Error("permission denied"), { code: "EACCES" }),
    );
    const events = history({ bus, filesystem, path, sink: new NodeFileLogSink({ path }) });
    const emitted = bus.emit("daemon.stopping", { reason: "a" }, "daemon");

    expect(await events.replay({ sinceTs: 0 })).toEqual([emitted]);
  });

  it("replays with sinceTs from the ring once the writer has stopped", async () => {
    const path = await eventFilePath();
    const bus = new EventBus(new FakeClock(1_000));
    let fail = false;
    const fileSink = new NodeFileLogSink({ path });
    const events = history({
      bus,
      path,
      sink: {
        write: (line) => {
          if (fail) throw new Error("disk full");
          fileSink.write(line);
        },
      },
    });
    bus.emit("daemon.stopping", { reason: "on disk" }, "daemon");
    fail = true;
    bus.emit("daemon.stopping", { reason: "memory only" }, "daemon");

    expect((await events.replay({ sinceTs: 0 })).map((entry) => entry.payload)).toEqual([
      { reason: "on disk" },
      { reason: "memory only" },
    ]);
  });
});

describe("readEventFile", () => {
  async function filesystemWith(files: Record<string, string>): Promise<MemoryFilesystem> {
    const filesystem = new MemoryFilesystem();
    await filesystem.mkdirp("/data");
    for (const [path, contents] of Object.entries(files)) {
      await filesystem.writeFileAtomic(path, contents);
    }
    return filesystem;
  }

  it("returns the rotated generation before the current file", async () => {
    const filesystem = await filesystemWith({
      "/data/events.jsonl": lines(envelope(3, 300), envelope(4, 400)),
      "/data/events.jsonl.1": lines(envelope(1, 100), envelope(2, 200)),
    });

    const read = await readEventFile(filesystem, "/data/events.jsonl", { sinceTs: 0 });

    expect(read.map((entry) => entry.seq)).toEqual([1, 2, 3, 4]);
  });

  it("returns once a generation that shows up in both reads, and skips none", async () => {
    const filesystem = await filesystemWith({
      "/data/events.jsonl": lines(envelope(2, 200), envelope(3, 300)),
      "/data/events.jsonl.1": lines(envelope(1, 100)),
    });
    // A rotation lands between the two reads, whichever file is read first: what was current
    // becomes the rotated generation, and the new current file holds one later event.
    const read = filesystem.readFile.bind(filesystem);
    let rotated = false;
    vi.spyOn(filesystem, "readFile").mockImplementation(async (path) => {
      const contents = await read(path);
      if (!rotated) {
        rotated = true;
        const current = await read("/data/events.jsonl");
        await filesystem.writeFileAtomic("/data/events.jsonl.1", current);
        await filesystem.writeFileAtomic("/data/events.jsonl", lines(envelope(4, 400)));
      }
      return contents;
    });

    const result = await readEventFile(filesystem, "/data/events.jsonl", { sinceTs: 0 });

    expect(result.map((entry) => entry.seq)).toEqual([2, 3]);
  });

  it("skips a JSON line that is not an envelope and returns the lines around it", async () => {
    const filesystem = await filesystemWith({
      "/data/events.jsonl": `${lines(envelope(1, 100))}null\n[]\n{"seq":"2"}\n${lines(envelope(3, 300))}`,
    });

    const read = await readEventFile(filesystem, "/data/events.jsonl", { sinceTs: 0 });

    expect(read.map((entry) => entry.seq)).toEqual([1, 3]);
  });

  it("the event file reader skips a line with no id", async () => {
    const { id: _id, ...withoutId } = envelope(2, 200);
    const { seq: _seq, ...withoutSeq } = envelope(5, 500);
    const { timestamp: _timestamp, ...withoutTimestamp } = envelope(6, 600);
    const filesystem = await filesystemWith({
      "/data/events.jsonl": `${lines(envelope(1, 100))}${JSON.stringify(withoutId)}\n${JSON.stringify({ ...envelope(4, 400), id: 4 })}\n${JSON.stringify(withoutSeq)}\n${JSON.stringify(withoutTimestamp)}\n${lines(envelope(3, 300))}`,
    });

    const read = await readEventFile(filesystem, "/data/events.jsonl", { sinceTs: 0 });

    expect(read.map((entry) => entry.seq)).toEqual([1, 3]);
  });

  it("the event file reader returns an event found in both generations once", async () => {
    const filesystem = await filesystemWith({
      "/data/events.jsonl": lines(envelope(1, 100, "evt_same"), envelope(2, 200)),
      "/data/events.jsonl.1": lines(envelope(1, 100, "evt_same")),
    });

    const read = await readEventFile(filesystem, "/data/events.jsonl", { sinceTs: 0 });

    expect(read.map((entry) => entry.id)).toEqual(["evt_same", "evt_2"]);
  });

  it("two events with the same seq and timestamp but different ids are both read back from the file", async () => {
    const filesystem = await filesystemWith({
      "/data/events.jsonl": lines(envelope(1, 100, "evt_a")),
      "/data/events.jsonl.1": lines(envelope(1, 100, "evt_b")),
    });

    const read = await readEventFile(filesystem, "/data/events.jsonl", { sinceTs: 0 });

    expect(read.map((entry) => entry.id)).toEqual(["evt_b", "evt_a"]);
  });

  it("skips a line that is not JSON and returns the lines around it", async () => {
    const filesystem = await filesystemWith({
      "/data/events.jsonl": `${lines(envelope(1, 100))}{"seq":2,"times\n${lines(envelope(3, 300))}`,
    });

    const read = await readEventFile(filesystem, "/data/events.jsonl", { sinceTs: 0 });

    expect(read.map((entry) => entry.seq)).toEqual([1, 3]);
  });
});
