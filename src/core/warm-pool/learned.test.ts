import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { NodeFilesystem, NodeSqliteOpener, NoopLogger } from "../../ports/index.js";
import { openStateDatabase } from "../../state/index.js";
import type { VirtualSpec } from "../domain.js";
import { openMemoryState } from "../testing.js";
import { LearnedKinds, warmPoolOwner } from "./learned.js";

const HOUR = 3_600_000;
const T0 = 1_000 * HOUR;

function spec(model: string, extra: Partial<VirtualSpec> = {}): VirtualSpec {
  return { model, osVersion: "18.4", physical: false, platform: "ios", ...extra };
}

async function open() {
  const state = await openMemoryState([warmPoolOwner]);
  return { kinds: new LearnedKinds(state), state };
}

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("LearnedKinds", () => {
  it("counts a kind's peak over the last 24 hours, at least one, lists the newest last lease first, and keeps a full untagged kind leased twice as one row", async () => {
    const phone = spec("iPhone 16");
    const cases: readonly {
      readonly name: string;
      readonly run: (kinds: LearnedKinds) => number;
      readonly count: number;
      readonly rows?: number;
    }[] = [
      {
        count: 3,
        name: "three overlapping leases",
        run: (kinds) => {
          kinds.learn(phone, "a", T0);
          kinds.learn(phone, "b", T0 + 1);
          kinds.learn(phone, "c", T0 + 2);
          return T0 + 10;
        },
      },
      {
        count: 2,
        name: "a lease granted at the instant of the read beside a held one",
        run: (kinds) => {
          kinds.learn(phone, "a", T0);
          kinds.learn(phone, "b", T0 + 10);
          return T0 + 10;
        },
      },
      {
        count: 1,
        name: "two in sequence",
        run: (kinds) => {
          kinds.learn(phone, "a", T0);
          kinds.ended("a", T0 + 5);
          kinds.learn(phone, "b", T0 + 5);
          return T0 + 10;
        },
      },
      {
        count: 1,
        name: "one granted 25 hours ago and still held",
        run: (kinds) => {
          kinds.learn(phone, "a", T0 - 25 * HOUR);
          return T0;
        },
      },
      {
        count: 1,
        name: "one ended 24 hours and 1 ms ago beside a held one",
        run: (kinds) => {
          kinds.learn(phone, "old", T0 - 25 * HOUR);
          kinds.learn(phone, "held", T0 - 25 * HOUR + 50);
          kinds.ended("old", T0 - 24 * HOUR - 1);
          return T0;
        },
      },
      {
        count: 2,
        name: "two overlapping leases, one of them ended inside the window",
        run: (kinds) => {
          kinds.learn(phone, "old", T0 - 25 * HOUR);
          kinds.learn(phone, "held", T0 - 25 * HOUR + 50);
          kinds.ended("old", T0 - 24 * HOUR + 1);
          return T0 - 24 * HOUR + 1;
        },
      },
      {
        count: 1,
        name: "no lease rows left",
        rows: 1,
        run: (kinds) => {
          kinds.learn(phone, "old", T0 - 30 * HOUR);
          kinds.ended("old", T0 - 29 * HOUR);
          kinds.learn(spec("iPad Pro"), "other", T0);
          return T0;
        },
      },
    ];

    for (const { count, name, rows, run } of cases) {
      const { kinds, state } = await open();
      const now = run(kinds);
      if (rows !== undefined) {
        expect(
          state.database.prepare("SELECT COUNT(*) AS n FROM warm_kind_leases").get()?.n,
          name,
        ).toBe(rows);
      }
      expect(kinds.kinds(now).find((kind) => kind.spec.model === "iPhone 16")?.count, name).toBe(
        count,
      );
    }

    const { kinds } = await open();
    kinds.learn(phone, "a", T0);
    kinds.learn(spec("iPad Pro"), "b", T0 + 10);
    kinds.learn(phone, "c", T0 + 20);
    kinds.learn(spec("iPhone 16", { mode: "slim" }), "d", T0 + 5);
    expect(
      kinds.kinds(T0 + 30).map((kind) => [kind.spec.model, kind.spec.mode, kind.lastLeasedAt]),
    ).toEqual([
      ["iPhone 16", undefined, T0 + 20],
      ["iPad Pro", undefined, T0 + 10],
      ["iPhone 16", "slim", T0 + 5],
    ]);
  });

  it("keeps at most 32 kinds per platform, dropping the oldest by last lease with its lease rows, and counts the other platform apart", async () => {
    const leaseRows = (state: Awaited<ReturnType<typeof open>>["state"]): number =>
      Number(state.database.prepare("SELECT COUNT(*) AS n FROM warm_kind_leases").get()?.n);
    const { kinds, state } = await open();
    for (let index = 0; index < 32; index += 1) {
      kinds.learn(spec(`Phone ${String(index)}`), `lease-${String(index)}`, T0 + index);
    }
    kinds.learn(spec("Pixel", { platform: "android" }), "lease-pixel", T0 + 40);

    expect(kinds.kinds(T0 + 50)).toHaveLength(33);
    expect(leaseRows(state)).toBe(33);

    kinds.learn(spec("Phone 32"), "lease-32", T0 + 41);

    const after = kinds.kinds(T0 + 50);
    expect(after).toHaveLength(33);
    expect(after.some((kind) => kind.spec.model === "Phone 0")).toBe(false);
    expect(after.some((kind) => kind.spec.model === "Phone 1")).toBe(true);
    expect(after.some((kind) => kind.spec.platform === "android")).toBe(true);
    expect(leaseRows(state)).toBe(33);
  });

  it("forgetMatching forgets every kind of the model on its platform, narrowed by the OS, mode and image tag given, and answers them", async () => {
    const pixel36 = spec("Pixel", { osVersion: "36", platform: "android" });
    const pixel35 = spec("Pixel", { osVersion: "35", platform: "android" });
    const tagged = spec("Pixel", { imageTag: "google_apis", osVersion: "35", platform: "android" });
    const slim = spec("Pixel", { mode: "slim", osVersion: "36", platform: "android" });
    const fill = async () => {
      const opened = await open();
      opened.kinds.learn(pixel36, "a", T0);
      opened.kinds.learn(pixel35, "b", T0 + 1);
      opened.kinds.learn(tagged, "c", T0 + 2);
      opened.kinds.learn(slim, "d", T0 + 3);
      opened.kinds.learn(spec("Pixel 9", { osVersion: "36", platform: "android" }), "e", T0 + 4);
      opened.kinds.learn(spec("Pixel"), "f", T0 + 5);
      return opened.kinds;
    };
    const cases: readonly {
      readonly match: Parameters<LearnedKinds["forgetMatching"]>[0];
      readonly forgotten: readonly VirtualSpec[];
    }[] = [
      {
        forgotten: [slim, tagged, pixel35, pixel36],
        match: { model: "Pixel", platform: "android" },
      },
      {
        forgotten: [slim, pixel36],
        match: { model: "Pixel", osVersion: "36", platform: "android" },
      },
      {
        forgotten: [pixel36],
        match: { mode: "full", model: "Pixel", osVersion: "36", platform: "android" },
      },
      {
        forgotten: [tagged, pixel35],
        match: { model: "Pixel", osVersion: "35", platform: "android" },
      },
      {
        forgotten: [tagged],
        match: { imageTag: "google_apis", model: "Pixel", platform: "android" },
      },
      { forgotten: [], match: { model: "Pixel 7", platform: "android" } },
    ];
    for (const { forgotten, match } of cases) {
      const kinds = await fill();
      expect(kinds.forgetMatching(match), JSON.stringify(match)).toEqual(forgotten);
      expect(kinds.kinds(T0 + 10), JSON.stringify(match)).toHaveLength(6 - forgotten.length);
    }
  });

  it("survives a reopen of the same file, and forget and clear remove the rows", async () => {
    const directory = await mkdtemp(join(tmpdir(), "simlock-learned-"));
    directories.push(directory);
    const openFile = () =>
      openStateDatabase({
        dataDirectory: directory,
        filesystem: new NodeFilesystem(),
        logger: new NoopLogger(),
        oldFiles: [],
        owners: [warmPoolOwner],
        sqlite: new NodeSqliteOpener(),
        upgradeStep: "",
      });
    const first = await openFile();
    const written = new LearnedKinds(first);
    written.learn(spec("iPhone 16"), "a", T0);
    written.learn(spec("iPad Pro"), "b", T0 + 1);
    first.close();

    const second = await openFile();
    const reopened = new LearnedKinds(second);
    expect(reopened.kinds(T0 + 5).map((kind) => kind.spec.model)).toEqual([
      "iPad Pro",
      "iPhone 16",
    ]);

    reopened.forget(spec("iPad Pro"));
    expect(reopened.kinds(T0 + 5).map((kind) => kind.spec.model)).toEqual(["iPhone 16"]);
    expect(
      Number(second.database.prepare("SELECT COUNT(*) AS n FROM warm_kind_leases").get()?.n),
    ).toBe(1);

    reopened.clear();
    expect(reopened.kinds(T0 + 5)).toEqual([]);
    expect(
      Number(second.database.prepare("SELECT COUNT(*) AS n FROM warm_kind_leases").get()?.n),
    ).toBe(0);
    second.close();
  });

  it("warmPoolOwner version 1 creates both STRICT tables with their columns", async () => {
    const { state } = await open();
    const table = (name: string) =>
      state.database.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(name)?.sql;
    const columns = (name: string) =>
      state.database
        .prepare(`SELECT name, type, "notnull" AS required FROM pragma_table_info('${name}')`)
        .all()
        .map((column) => [column.name, column.type, column.required]);

    expect(warmPoolOwner.version).toBe(1);
    expect(String(table("warm_kinds"))).toMatch(/STRICT/);
    expect(String(table("warm_kind_leases"))).toMatch(/STRICT/);
    expect(columns("warm_kinds")).toEqual([
      ["id", "INTEGER", 0],
      ["platform", "TEXT", 1],
      ["model", "TEXT", 1],
      ["os_version", "TEXT", 1],
      ["mode", "TEXT", 1],
      ["image_tag", "TEXT", 1],
      ["last_leased_at", "INTEGER", 1],
    ]);
    expect(columns("warm_kind_leases")).toEqual([
      ["lease_id", "TEXT", 1],
      ["kind_id", "INTEGER", 1],
      ["granted_at", "INTEGER", 1],
      ["ended_at", "INTEGER", 0],
    ]);
  });
});
