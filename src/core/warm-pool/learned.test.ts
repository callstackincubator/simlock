import { describe, expect, it } from "vitest";

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

describe("LearnedKinds", () => {
  it("counts a kind's peak over the last 24 hours, at least one, lists the newest last lease first, and keeps a full untagged kind leased twice as one row", async () => {
    const phone = spec("iPhone 16");
    const cases: readonly {
      readonly name: string;
      readonly run: (kinds: LearnedKinds) => number;
      readonly count: number;
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
        run: (kinds) => {
          kinds.learn(phone, "old", T0 - 30 * HOUR);
          kinds.ended("old", T0 - 29 * HOUR);
          kinds.learn(spec("iPad Pro"), "other", T0);
          return T0;
        },
      },
    ];

    for (const { count, name, run } of cases) {
      const { kinds } = await open();
      const now = run(kinds);
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
});
