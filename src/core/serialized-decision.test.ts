import { describe, expect, it } from "vitest";

import { SerializedDecision } from "./serialized-decision.js";

describe("SerializedDecision", () => {
  it("does not enter a later decision until the current one commits", async () => {
    const decisions = new SerializedDecision();
    const order: string[] = [];
    let commitFirst!: () => void;
    const firstCommit = new Promise<void>((resolve) => {
      commitFirst = resolve;
    });

    const first = decisions.run(async () => {
      order.push("first:read");
      await firstCommit;
      order.push("first:commit");
    });
    const second = decisions.run(() => {
      order.push("second:read-and-commit");
    });

    await Promise.resolve();
    expect(order).toEqual(["first:read"]);

    commitFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:read", "first:commit", "second:read-and-commit"]);
  });

  it("continues after a failed decision", async () => {
    const decisions = new SerializedDecision();

    await expect(
      decisions.run(() => {
        throw new Error("failed decision");
      }),
    ).rejects.toThrow("failed decision");
    await expect(decisions.run(() => "committed")).resolves.toBe("committed");
  });
});
