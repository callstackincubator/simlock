import { describe, expect, it } from "vitest";

import type { EventEnvelope } from "../../bus/index.js";
import { ALERT_EVENTS, ALERT_FORMATS } from "../../core/index.js";
import { ALERT_FORMAT_REGISTRY } from "./index.js";

describe.each(Object.entries(ALERT_FORMAT_REGISTRY))("format %s", (name, format) => {
  it("every registered format passes the conformance suite", () => {
    expect(name).toBe(format.name);
    for (const event of ALERT_EVENTS) {
      const envelope = {
        id: "evt_1",
        seq: 1,
        timestamp: 5,
        event,
        payload: { workerId: "wrk_1" },
        module: "test",
      } as unknown as EventEnvelope;

      const built = format.build({
        envelope,
        destination: {
          name: "d",
          format: format.name,
          url: "https://x.example",
          events: [event],
          secret: "s",
        },
        version: "1.2.3",
        workerLabel: (id) => id,
      });

      expect(() => JSON.parse(built.body)).not.toThrow();
      expect(built.headers["Content-Type"]).toBe("application/json");
      expect(built.headers["User-Agent"]).toBe("simlock/1.2.3");
    }
  });
});

describe("ALERT_FORMAT_REGISTRY", () => {
  it("has exactly the formats core names", () => {
    expect(Object.keys(ALERT_FORMAT_REGISTRY).sort()).toEqual([...ALERT_FORMATS].sort());
  });
});
