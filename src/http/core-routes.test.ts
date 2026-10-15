import { describe, expect, it } from "vitest";

import { EventBus } from "../bus/index.js";
import { CORE_ROUTE_SEGMENTS } from "../contract/index.js";
import { OwnerRoutedFactBus } from "../daemon/owner-routed-facts.js";
import { FakeClock, JsonLinesLogger, MemoryLogSink } from "../ports/index.js";
import { createHttpApp } from "./app.js";
import {
  FakeDispatcher,
  FakeRegistry,
  FakeTokenVerifier,
  sequenceIdGenerator,
  testConfig,
} from "./test-fakes.js";

describe("the routes createHttpApp registers", () => {
  it("every route createHttpApp registers starts with a name in CORE_ROUTE_SEGMENTS", () => {
    const clock = new FakeClock(1_000);
    const eventBus = new EventBus(clock);
    const dispatcher = new FakeDispatcher(clock);
    const registry = new FakeRegistry();
    const app = createHttpApp({
      clock,
      config: testConfig(),
      dispatch: (op, input, session) => dispatcher.dispatch(op, input, session) as never,
      eventBus,
      idGenerator: sequenceIdGenerator("gw"),
      leaseRequests: dispatcher.requests,
      logger: new JsonLinesLogger({ clock, sink: new MemoryLogSink() }),
      ownerRoutedFacts: new OwnerRoutedFactBus(eventBus, registry),
      registry,
      tokens: new FakeTokenVerifier(),
    });

    const segments = app.routes
      .map((route) => route.path)
      .filter((path) => path.startsWith("/v1/"))
      .map((path) => path.split("/")[2] ?? "");

    expect(segments.length).toBeGreaterThan(0);
    expect(segments.filter((segment) => !CORE_ROUTE_SEGMENTS.includes(segment))).toEqual([]);
  });

  it("CORE_ROUTE_SEGMENTS names the ten core first segments and uplink", () => {
    expect([...CORE_ROUTE_SEGMENTS].sort()).toEqual(
      [
        "catalog",
        "components",
        "devices",
        "events",
        "healthz",
        "lease-requests",
        "leases",
        "status",
        "tokens",
        "uplink",
        "workers",
      ].sort(),
    );
  });
});
