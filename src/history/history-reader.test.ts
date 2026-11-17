import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { NodeFilesystem, NodeSqliteOpener } from "../ports/index.js";
import { HISTORY_DB_NAME, openHistoryReader } from "./index.js";
import { ProbeSqliteOpener } from "./testing.js";
import { JUNK, directories, dataDirectory, rig, stopping, readHistoryOf } from "./test-history.js";

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("openHistoryReader", () => {
  it("reads rows a writer committed while that writer is still open", async () => {
    const rigged = await rig();
    const history = rigged.history();
    await history.start();
    const first = stopping(rigged.bus, "first");
    rigged.clock.advance(5);
    const second = stopping(rigged.bus, "second");

    const read = await readHistoryOf(rigged.directory);
    const sinceFirst = await openHistoryReader({
      dataDirectory: rigged.directory,
      filesystem: new NodeFilesystem(),
      sqlite: new NodeSqliteOpener(),
    }).read({ sinceTs: first.timestamp });
    await history.stop();

    expect(read).toEqual([first, second]);
    expect(sinceFirst).toEqual([second]);
  });

  it("opens history.db read-only", async () => {
    const rigged = await rig();
    const history = rigged.history();
    await history.start();
    const sqlite = new ProbeSqliteOpener();

    await openHistoryReader({
      dataDirectory: rigged.directory,
      filesystem: new NodeFilesystem(),
      sqlite,
    }).read({ sinceTs: 0 });
    await history.stop();

    expect(sqlite.connections.map((connection) => connection.readOnly)).toEqual([true]);
  });

  it("throws, and does not answer empty, when history.db cannot be examined for a reason other than being missing", async () => {
    const directory = await dataDirectory();
    class DeniedFilesystem extends NodeFilesystem {
      override async stat(): Promise<never> {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      }
    }

    await expect(
      openHistoryReader({
        dataDirectory: directory,
        filesystem: new DeniedFilesystem(),
        sqlite: new NodeSqliteOpener(),
      }).read({ sinceTs: 0 }),
    ).rejects.toThrow(/permission denied/);
  });

  it("answers empty when history.db is missing", async () => {
    const directory = await dataDirectory();

    expect(await readHistoryOf(directory)).toEqual([]);
  });

  it("throws when history.db is present and unreadable", async () => {
    const directory = await dataDirectory();
    await writeFile(join(directory, HISTORY_DB_NAME), JUNK);

    await expect(readHistoryOf(directory)).rejects.toThrow(/not a database/);
  });
});
