import { describe, expect, it } from "vitest";

import { EventBus } from "../bus/index.js";
import { CORE_ROUTE_SEGMENTS } from "../contract/index.js";
import { OwnerRoutedFactBus } from "../daemon/owner-routed-facts.js";
import { FakeClock, JsonLinesLogger, MemoryLogSink } from "../ports/index.js";
import { fakeAuth } from "../auth/testing.js";
import { createHttpApp } from "./app.js";
import { buildOpenApiDocument } from "./openapi.js";
import { DECLARED_ROUTES } from "./route-declarations.js";
import { FakeDispatcher, FakeRegistry, sequenceIdGenerator, testConfig } from "./test-fakes.js";

// why: a task that declares a route deletes its line, so the list shrinks to nothing.
const UNDECLARED_ROUTES = [
  "GET /v1/components",
  "DELETE /v1/components/{platform}/{version}",
  "POST /v1/lease-requests",
  "GET /v1/lease-requests",
  "GET /v1/lease-requests/{id}",
  "GET /v1/lease-requests/{id}/events",
  "DELETE /v1/lease-requests/{id}",
  "GET /v1/leases/{id}",
  "POST /v1/leases/{id}/renew",
  "POST /v1/leases/{id}/exec",
  "POST /v1/components/install",
  "GET /v1/leases/{id}/events",
  "DELETE /v1/leases/{id}",
  "GET /v1/leases",
  "GET /v1/tokens",
  "GET /v1/workers",
  "POST /v1/workers/{id}/drain",
  "DELETE /v1/workers/{id}/drain",
  "DELETE /v1/workers/{id}",
  "GET /v1/events",
  "GET /v1/events/stream",
];

function coverageProblems(
  registered: readonly string[],
  declared: readonly string[],
  undeclared: readonly string[],
): string[] {
  const known = new Set([...declared, ...undeclared]);
  return [
    ...registered.filter((route) => !known.has(route)).map((route) => `not declared: ${route}`),
    ...declared
      .filter((route) => !registered.includes(route))
      .map((route) => `declared but not registered: ${route}`),
    ...undeclared
      .filter((route) => !registered.includes(route))
      .map((route) => `listed undeclared but not registered: ${route}`),
    ...undeclared
      .filter((route) => declared.includes(route))
      .map((route) => `declared and listed undeclared: ${route}`),
  ];
}

function buildApp() {
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

  it("a route registered but neither declared nor on the undeclared list fails, as does a declared path not registered", () => {
    const registered = buildApp()
      .routes.filter((route) => route.path.startsWith("/v1/"))
      .map((route) => routeKey(route.method, route.path));
    const declared = DECLARED_ROUTES.map((route) => routeKey(route.method, route.path));
    const documented = Object.entries(buildOpenApiDocument([]).paths ?? {}).flatMap(
      ([path, item]) => Object.keys(item).map((method) => routeKey(method, path)),
    );

    expect(coverageProblems([...new Set(registered)], declared, UNDECLARED_ROUTES)).toEqual([]);
    expect([...documented].sort()).toEqual([...declared].sort());
    expect(coverageProblems([...registered, "GET /v1/new"], declared, UNDECLARED_ROUTES)).toEqual([
      "not declared: GET /v1/new",
    ]);
    expect(
      coverageProblems(
        registered.filter((route) => route !== "GET /v1/status"),
        declared,
        UNDECLARED_ROUTES,
      ),
    ).toEqual(["declared but not registered: GET /v1/status"]);
    expect(coverageProblems(registered, declared, [...UNDECLARED_ROUTES, "GET /v1/gone"])).toEqual([
      "listed undeclared but not registered: GET /v1/gone",
    ]);
  });

  it("CORE_ROUTE_SEGMENTS names the eleven core first segments and uplink", () => {
    expect([...CORE_ROUTE_SEGMENTS].sort()).toEqual(
      [
        "catalog",
        "components",
        "devices",
        "events",
        "healthz",
        "identity",
        "lease-requests",
        "leases",
        "stats",
        "status",
        "tokens",
        "uplink",
        "workers",
      ].sort(),
    );
  });
});
