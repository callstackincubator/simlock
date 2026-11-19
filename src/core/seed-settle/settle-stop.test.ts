import { describe, expect, it } from "vitest";

import { type DriverSource, SeedSettlerStoppedError } from "../driver.js";
import {
  deferred,
  expectSettled,
  flush,
  iphoneSpec,
  minute,
  quick,
  settlerRig,
  warmingPaused,
} from "./test-rig.js";

describe("seed settler: daemon stop", () => {
  it("starts no settle after beginStop, aborts a running settle on stop and resolves once the driver returns, and fails an operator's wait, and starts none for a check that was under way when the stop began", async () => {
    const running = await settlerRig();
    running.ios.sources = [quick("seed", 3)];
    const returned = deferred<void>();
    const order: string[] = [];
    running.ios.settleSeed = (_id, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            order.push("signal aborted");
            void returned.promise.then(() => {
              order.push("driver returned");
              reject(signal.reason);
            });
          },
          { once: true },
        );
      });
    await running.started();
    await running.advance(5 * minute);
    expect(running.ios.settles, "a settle is running").toHaveLength(1);
    running.settler.beginStop();
    expect(running.ios.settles[0]?.signal.aborted, "beginStop leaves the running settle").toBe(
      false,
    );
    const stopped = running.settler.stop().then(() => order.push("stop resolved"));
    await flush();
    expect(order, "stop waits for the driver").toEqual(["signal aborted"]);
    returned.resolve();
    await stopped;
    expect(order).toEqual(["signal aborted", "driver returned", "stop resolved"]);

    const idle = await settlerRig();
    idle.ios.sources = [quick("seed", 3)];
    await idle.started();
    idle.settler.beginStop();
    await idle.advance(5 * minute);
    expectSettled(idle, [], "no settle starts after beginStop");
    await expect(idle.settler.stop(), "stop with none running").resolves.toBeUndefined();
    await expect(
      idle.settler.settle(iphoneSpec, { onProgress: () => undefined }),
      "an operator's call after stop",
    ).rejects.toBeInstanceOf(SeedSettlerStoppedError);

    const racing = await settlerRig();
    const listing = deferred<DriverSource[]>();
    racing.ios.listSources = () => listing.promise;
    await racing.started();
    await racing.advance(5 * minute);
    racing.settler.beginStop();
    listing.resolve([quick("seed", 3)]);
    await flush();
    expectSettled(racing, [], "a stop began while the check listed seeds");

    const waiting = await settlerRig({ pressure: warmingPaused });
    await waiting.started();
    const asked = waiting.settler.settle(iphoneSpec, { onProgress: () => undefined });
    const outcome = asked.then(
      () => "answered",
      (error: unknown) => error,
    );
    await flush();
    await waiting.settler.stop();
    expect(await outcome).toBeInstanceOf(SeedSettlerStoppedError);
  });
});
