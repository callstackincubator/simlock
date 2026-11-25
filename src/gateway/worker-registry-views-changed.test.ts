import { describe, expect, it } from "vitest";
import { RETENTION_MS, registry } from "./test-worker-registry.js";

describe("WorkerRegistry", () => {
  it("orders views by id, so two reads agree", () => {
    const { workers } = registry();
    workers.connected("wrk_c", undefined, undefined);
    workers.connected("wrk_a", undefined, undefined);
    workers.connected("wrk_b", undefined, undefined);

    expect(workers.views().map((view) => view.id)).toEqual(["wrk_a", "wrk_b", "wrk_c"]);
  });

  describe("onViewsChanged", () => {
    it("fires once per committed change, after the view is committed", () => {
      const { workers } = registry();
      const seen: Array<string | undefined> = [];
      workers.onViewsChanged(() => seen.push(workers.view("wrk_1")?.connection));

      workers.connected("wrk_1", undefined, undefined);

      expect(seen).toEqual(["connected"]);
    });

    it("does not fire for a call that changes nothing", async () => {
      const { workers } = registry();
      workers.connected("wrk_1", undefined, undefined);
      let fired = 0;
      workers.onViewsChanged(() => {
        fired += 1;
      });

      await workers.setDrained("wrk_1", false);
      workers.refresh("wrk_missing", { queueDepth: 1 });
      workers.disconnected("wrk_1");
      workers.disconnected("wrk_1");

      expect(fired).toBe(1); // only the first `disconnected()` -- the second is the no-op repeat.
    });

    it("stops firing once unsubscribed", () => {
      const { workers } = registry();
      let fired = 0;
      const unsubscribe = workers.onViewsChanged(() => {
        fired += 1;
      });

      workers.connected("wrk_1", undefined, undefined);
      unsubscribe();
      workers.disconnected("wrk_1");

      expect(fired).toBe(1);
    });

    it("does not let a throwing listener break the mutation or starve the other listeners", () => {
      const { workers } = registry();
      let afterFired = 0;
      workers.onViewsChanged(() => {
        throw new Error("a subscriber's own bug");
      });
      workers.onViewsChanged(() => {
        afterFired += 1;
      });

      expect(() => workers.connected("wrk_1", undefined, undefined)).not.toThrow();

      expect(workers.view("wrk_1")?.connection).toBe("connected");
      expect(afterFired).toBe(1);
    });

    it("fires for remove() and pruneExpired(), each forgetting a view through #forget", async () => {
      const { clock, workers } = registry();
      let fired = 0;
      workers.onViewsChanged(() => {
        fired += 1;
      });

      workers.connected("wrk_1", undefined, undefined); // 1
      workers.disconnected("wrk_1"); // 2
      await workers.remove("wrk_1"); // 3

      workers.connected("wrk_2", undefined, undefined); // 4
      workers.disconnected("wrk_2"); // 5
      clock.advance(RETENTION_MS + 1);
      await workers.pruneExpired(); // 6

      expect(fired).toBe(6);
      expect(workers.view("wrk_1")).toBeUndefined();
      expect(workers.view("wrk_2")).toBeUndefined();
    });
  });
});
