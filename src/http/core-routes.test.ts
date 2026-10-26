import { describe, expect, it } from "vitest";

import { EventBus } from "../bus/index.js";
import { CORE_ROUTE_SEGMENTS } from "../contract/index.js";
import { OwnerRoutedFactBus } from "../daemon/owner-routed-facts.js";
import { FakeClock, JsonLinesLogger, MemoryLogSink } from "../ports/index.js";
import { fakeAuth } from "../auth/testing.js";
import { optionalModules } from "../module-registry/index.js";
import { createHttpApp, type HttpMount } from "./app.js";
import { buildOpenApiDocument } from "./openapi.js";
import { DECLARED_ROUTES } from "./route-declarations.js";
import { FakeDispatcher, FakeRegistry, sequenceIdGenerator, testConfig } from "./test-fakes.js";

function coverageProblems(registered: readonly string[], declared: readonly string[]): string[] {
  const known = new Set(declared);
  return [
    ...registered.filter((route) => !known.has(route)).map((route) => `not declared: ${route}`),
    ...declared
      .filter((route) => !registered.includes(route))
      .map((route) => `declared but not registered: ${route}`),
  ];
}

function buildApp(mounts: readonly HttpMount[] = []) {
  const clock = new FakeClock(1_000);
  const eventBus = new EventBus(clock);
  const dispatcher = new FakeDispatcher(clock);
  const registry = new FakeRegistry();
  return createHttpApp({
    clock,
    config: testConfig(),
    dispatch: (op, input, session) => dispatcher.dispatch(op, input, session) as never,
    eventBus,
    idGenerator: sequenceIdGenerator("gw"),
    leaseRequests: dispatcher.requests,
    logger: new JsonLinesLogger({ clock, sink: new MemoryLogSink() }),
    ownerRoutedFacts: new OwnerRoutedFactBus(eventBus, registry),
    registry,
    auth: fakeAuth(new Map()),
    mounts,
  });
}

function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path.replaceAll(/:([^/]+)/g, "{$1}")}`;
}

describe("the routes createHttpApp registers", () => {
  it("every route createHttpApp registers starts with a name in CORE_ROUTE_SEGMENTS", () => {
    const app = buildApp();

    const segments = app.routes
      .map((route) => route.path)
      .filter((path) => path.startsWith("/v1/"))
      .map((path) => path.split("/")[2] ?? "");

    expect(segments.length).toBeGreaterThan(0);
    expect(segments.filter((segment) => !CORE_ROUTE_SEGMENTS.includes(segment))).toEqual([]);
  });

  it("the stream mount counts as covered because its definition carries http, the agent-device mount as left out because it does not, and no undeclared list remains", () => {
    const mounts = optionalModules.map((definition) => ({
      prefix: definition.name,
      handle: () => Promise.resolve(new Response()),
    }));
    const isModulePath = (path: string) =>
      optionalModules.some(
        (definition) =>
          path === `/v1/${definition.name}` || path.startsWith(`/v1/${definition.name}/`),
      );
    const registered = buildApp(mounts)
      .routes.filter((route) => route.path.startsWith("/v1/"))
      .map((route) => ({ key: routeKey(route.method, route.path), path: route.path }));
    const core = [
      ...new Set(registered.filter((route) => !isModulePath(route.path)).map((route) => route.key)),
    ];
    const declared = DECLARED_ROUTES.map((route) => routeKey(route.method, route.path));
    const moduleRoutes = optionalModules.flatMap((definition) =>
      (definition.http?.routes ?? []).map((route) => routeKey(route.method, route.path)),
    );
    const documented = Object.entries(buildOpenApiDocument(optionalModules).paths ?? {}).flatMap(
      ([path, item]) => Object.keys(item).map((method) => routeKey(method, path)),
    );

    expect(registered.some((route) => route.path.startsWith("/v1/stream"))).toBe(true);
    expect(registered.some((route) => route.path.startsWith("/v1/agent-device"))).toBe(true);
    expect(coverageProblems(core, declared)).toEqual([]);
    expect(moduleRoutes).toEqual([
      "GET /v1/stream/workers/{workerId}/devices/{deviceId}",
      "GET /v1/leases/{id}/stream",
    ]);
    expect([...documented].sort()).toEqual([...declared, ...moduleRoutes].sort());
    expect(coverageProblems([...core, "GET /v1/new"], declared)).toEqual([
      "not declared: GET /v1/new",
    ]);
    expect(
      coverageProblems(
        core.filter((route) => route !== "GET /v1/status"),
        declared,
      ),
    ).toEqual(["declared but not registered: GET /v1/status"]);
  });

  it("CORE_ROUTE_SEGMENTS names the core first segments and uplink", () => {
    expect([...CORE_ROUTE_SEGMENTS].sort()).toEqual(
      [
        "catalog",
        "components",
        "devices",
        "events",
        "healthz",
        "identity",
        "inbox",
        "lease-requests",
        "leases",
        "stats",
        "status",
        "update",
        "tokens",
        "uplink",
        "workers",
      ].sort(),
    );
  });
});
