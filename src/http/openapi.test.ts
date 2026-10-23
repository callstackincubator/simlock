import { validate } from "@readme/openapi-parser";
import { describe, expect, it } from "vitest";

import packageJson from "../../package.json" with { type: "json" };
import { optionalModules } from "../module-registry/index.js";
import { buildOpenApiDocument } from "./openapi.js";

describe("buildOpenApiDocument", () => {
  it("an integrator builds the document and gets valid OpenAPI 3.1", async () => {
    const document = buildOpenApiDocument([]);

    const result = await validate(structuredClone(document) as never);

    expect(result.valid).toBe(true);
    expect(document.openapi).toMatch(/^3\.1\./);
    expect(document.info).toEqual({ title: "simlock HTTP API", version: packageJson.version });
    expect(document.servers).toBeUndefined();
    expect(document.components?.securitySchemes).toEqual({
      bearer: { type: "http", scheme: "bearer" },
    });
    expect(document.paths?.["/v1/healthz"]?.get?.security ?? []).toEqual([]);
    expect(document.paths?.["/v1/status"]?.get?.security).toEqual([{ bearer: [] }]);
  });

  it("an integrator reads /v1/status and POST /v1/devices and finds tag, role, reply and error codes", () => {
    const paths = buildOpenApiDocument([]).paths ?? {};
    const status = paths["/v1/status"]?.get;
    const add = paths["/v1/devices"]?.post;

    expect(summarize(status)).toEqual({
      codes503: ["DAEMON_STOPPING", "DAEMON_STARTUP_FAILED"],
      description: expect.stringContaining("Role: agent."),
      statuses: ["200", "401", "403", "500", "503"],
      tags: ["System"],
    });
    expect(Object.keys(replySchema(status, "200").properties ?? {})).toEqual(
      expect.arrayContaining(["devices", "leases", "capacity", "daemon"]),
    );
    expect(summarize(add)).toMatchObject({
      description: expect.stringContaining("Role: admin."),
      tags: ["Devices"],
    });
    expect(add?.requestBody).toMatchObject({ required: true });
    expect(replySchema(add, "200").required).toEqual(
      expect.arrayContaining(["id", "driverDeviceId", "reenrolled"]),
    );
    expect(
      Object.fromEntries(
        ["400", "403", "409", "415", "422", "501"].map((code) => [code, errorCodes(add, code)]),
      ),
    ).toEqual({
      "400": ["BAD_REQUEST"],
      "403": ["FORBIDDEN"],
      "409": ["DEVICE_BUSY"],
      "415": ["UNSUPPORTED_MEDIA_TYPE"],
      "422": ["DEVICE_NOT_ENROLLABLE", "NO_DRIVER"],
      "501": ["UNSUPPORTED_IN_GATEWAY_MODE"],
    });
  });

  it("an integrator reads the lease routes in the document, each with its own codes and every SSE event's data schema", () => {
    const paths = buildOpenApiDocument([]).paths ?? {};
    const operation = (path: string, method: "get" | "post" | "delete") => paths[path]?.[method];
    const post = operation("/v1/lease-requests", "post");
    const cancel = operation("/v1/lease-requests/{id}", "delete");
    const release = operation("/v1/leases/{id}", "delete");

    expect(
      Object.fromEntries(
        [
          ["POST", "/v1/lease-requests"],
          ["GET", "/v1/lease-requests"],
          ["GET", "/v1/lease-requests/{id}"],
          ["GET", "/v1/lease-requests/{id}/events"],
          ["DELETE", "/v1/lease-requests/{id}"],
          ["GET", "/v1/leases"],
          ["GET", "/v1/leases/{id}"],
          ["POST", "/v1/leases/{id}/renew"],
          ["POST", "/v1/leases/{id}/exec"],
          ["GET", "/v1/leases/{id}/events"],
          ["DELETE", "/v1/leases/{id}"],
        ].map(([method, path]) => [
          `${method} ${path}`,
          operation(path!, method!.toLowerCase() as "get")?.tags,
        ]),
      ),
    ).toEqual({
      "DELETE /v1/lease-requests/{id}": ["Lease requests"],
      "DELETE /v1/leases/{id}": ["Leases"],
      "GET /v1/lease-requests": ["Lease requests"],
      "GET /v1/lease-requests/{id}": ["Lease requests"],
      "GET /v1/lease-requests/{id}/events": ["Lease requests"],
      "GET /v1/leases": ["Leases"],
      "GET /v1/leases/{id}": ["Leases"],
      "GET /v1/leases/{id}/events": ["Leases"],
      "POST /v1/lease-requests": ["Lease requests"],
      "POST /v1/leases/{id}/exec": ["Leases"],
      "POST /v1/leases/{id}/renew": ["Leases"],
    });
    expect(replySchema(post, "201").required).toEqual(["request"]);
    expect(post?.parameters).toEqual([
      expect.objectContaining({ in: "header", name: "Idempotency-Key", required: false }),
    ]);
    expect(Object.keys(responseOf(post, "201").headers ?? {})).toEqual(["Location"]);
    expect(
      Object.fromEntries(["409", "422", "503"].map((status) => [status, errorCodes(post, status)])),
    ).toEqual({
      "409": ["LEASE_ID_TAKEN", "REQUESTER_ALREADY_LEASED"],
      "422": ["UNKNOWN_MODEL"],
      "503": ["NO_CAPACITY", "DAEMON_STOPPING", "DAEMON_STARTUP_FAILED"],
    });
    expect(Object.keys(replySchema(release, "202").properties ?? {})).toEqual([
      "device",
      "released",
    ]);
    expect(responseOf(cancel, "204")).toEqual({ description: "Success" });
    expect(errorCodes(cancel, "409")).toEqual(["REQUEST_NOT_CANCELLABLE"]);
    expect(
      Object.fromEntries(
        (
          [
            ["get", "/v1/lease-requests/{id}", "404"],
            ["get", "/v1/lease-requests/{id}/events", "404"],
            ["delete", "/v1/lease-requests/{id}", "404"],
            ["get", "/v1/leases/{id}", "404"],
            ["post", "/v1/leases/{id}/renew", "404"],
            ["get", "/v1/leases/{id}/events", "404"],
            ["delete", "/v1/leases/{id}", "404"],
            ["post", "/v1/leases/{id}/exec", "404"],
            ["post", "/v1/leases/{id}/exec", "501"],
            ["post", "/v1/leases/{id}/exec", "504"],
          ] as const
        ).map(([method, path, status]) => [
          `${method} ${path} ${status}`,
          errorCodes(operation(path, method), status),
        ]),
      ),
    ).toEqual({
      "delete /v1/lease-requests/{id} 404": ["UNKNOWN_LEASE_REQUEST"],
      "delete /v1/leases/{id} 404": ["UNKNOWN_LEASE"],
      "get /v1/lease-requests/{id} 404": ["UNKNOWN_LEASE_REQUEST"],
      "get /v1/lease-requests/{id}/events 404": ["UNKNOWN_LEASE_REQUEST"],
      "get /v1/leases/{id} 404": ["UNKNOWN_LEASE"],
      "get /v1/leases/{id}/events 404": ["UNKNOWN_LEASE"],
      "post /v1/leases/{id}/exec 404": ["UNKNOWN_LEASE"],
      "post /v1/leases/{id}/exec 501": ["UNSUPPORTED_IN_GATEWAY_MODE"],
      "post /v1/leases/{id}/exec 504": ["EXEC_TIMEOUT"],
      "post /v1/leases/{id}/renew 404": ["UNKNOWN_LEASE"],
    });
    expect({
      existingLeaseId: errorFields(post, "409"),
      capacityReason: errorFields(post, "503"),
      leaseId: errorFields(cancel, "409"),
      retryAfter: Object.entries(responseOf(post, "503").headers ?? {}).map(([name, header]) => [
        name,
        (header as { required?: boolean }).required ?? false,
      ]),
    }).toEqual({
      existingLeaseId: ["code", "message", "existingLeaseId"],
      capacityReason: ["code", "message", "capacityReason"],
      leaseId: ["code", "message", "leaseId"],
      retryAfter: [["Retry-After", false]],
    });

    expect({
      exec: streamEvents(operation("/v1/leases/{id}/exec", "post")),
      lease: streamEvents(operation("/v1/leases/{id}/events", "get")),
      stages: streamEvents(operation("/v1/lease-requests/{id}/events", "get")),
    }).toEqual({
      exec: ["error", "exit", "output"],
      lease: ["device_recovered", "device_unhealthy", "lease_lost"],
      stages: [
        "booting",
        "cancelled",
        "downloading",
        "failed",
        "granted",
        "provisioning",
        "queued",
        "reclaiming",
      ],
    });
    const renew = operation("/v1/leases/{id}/renew", "post");
    expect(errorCodes(renew, "415")).toEqual(["UNSUPPORTED_MEDIA_TYPE"]);
    expect(renew?.requestBody).toEqual(expect.objectContaining({ required: false }));
    expect({
      exec: dataShapes(operation("/v1/leases/{id}/exec", "post")),
      lease: dataShapes(operation("/v1/leases/{id}/events", "get")),
      stages: dataShapes(operation("/v1/lease-requests/{id}/events", "get")),
    }).toEqual({
      exec: [["chunk", "stream"], ["error"], ["exitCode"]],
      lease: [["attempts", "event"], ["event"], ["event", "reason"]],
      stages: [
        ["createdAt", "id", "component", "percent", "state", "waiting"],
        ["createdAt", "id", "error", "state"],
        ["createdAt", "id", "etaSeconds", "state"],
        ["createdAt", "id", "lease", "state"],
        ["createdAt", "id", "queuePosition", "state"],
        ["createdAt", "id", "state"],
      ],
    });
    for (const stream of [
      operation("/v1/leases/{id}/exec", "post"),
      operation("/v1/leases/{id}/events", "get"),
      operation("/v1/lease-requests/{id}/events", "get"),
    ]) {
      expect(Object.keys(streamMessage(stream).properties ?? {})).toEqual(["data", "event"]);
    }
  });

  it("an integrator reads the admin routes in the document, with the side that answers 501, each route's own codes, the events query and install's two sides", () => {
    const paths = buildOpenApiDocument([]).paths ?? {};
    const operation = (path: string, method: "get" | "post" | "delete") => paths[path]?.[method];
    const routes = [
      ["get", "/v1/workers", "Workers"],
      ["post", "/v1/workers/{id}/drain", "Workers"],
      ["delete", "/v1/workers/{id}/drain", "Workers"],
      ["delete", "/v1/workers/{id}", "Workers"],
      ["get", "/v1/components", "Components"],
      ["delete", "/v1/components/{platform}/{version}", "Components"],
      ["post", "/v1/components/install", "Components"],
      ["get", "/v1/tokens", "Tokens"],
      ["get", "/v1/events", "Events"],
      ["get", "/v1/events/stream", "Events"],
    ] as const;

    expect(
      Object.fromEntries(
        routes.map(([method, path]) => [`${method} ${path}`, operation(path, method)?.tags]),
      ),
    ).toEqual(
      Object.fromEntries(routes.map(([method, path, tag]) => [`${method} ${path}`, [tag]])),
    );
    const sideOf = (method: "get" | "post" | "delete", path: string) => {
      const found = operation(path, method);
      return {
        codes501: errorCodes(found, "501"),
        gatewayOnly: found?.description?.toLowerCase().includes("gateway only"),
        workerOnly: found?.description?.toLowerCase().includes("worker only"),
      };
    };
    expect({
      drain: sideOf("post", "/v1/workers/{id}/drain"),
      undrain: sideOf("delete", "/v1/workers/{id}/drain"),
      remove: sideOf("delete", "/v1/workers/{id}"),
      list: sideOf("get", "/v1/components"),
      componentRemove: sideOf("delete", "/v1/components/{platform}/{version}"),
      install: sideOf("post", "/v1/components/install"),
    }).toEqual({
      drain: { codes501: ["UNSUPPORTED_IN_WORKER_MODE"], gatewayOnly: true, workerOnly: false },
      undrain: { codes501: ["UNSUPPORTED_IN_WORKER_MODE"], gatewayOnly: true, workerOnly: false },
      remove: { codes501: ["UNSUPPORTED_IN_WORKER_MODE"], gatewayOnly: true, workerOnly: false },
      list: { codes501: ["UNSUPPORTED_IN_GATEWAY_MODE"], gatewayOnly: false, workerOnly: true },
      componentRemove: {
        codes501: ["UNSUPPORTED_IN_GATEWAY_MODE"],
        gatewayOnly: false,
        workerOnly: true,
      },
      install: {
        codes501: ["UNSUPPORTED_IN_GATEWAY_MODE", "UNSUPPORTED_IN_WORKER_MODE"],
        gatewayOnly: true,
        workerOnly: true,
      },
    });
    expect(operation("/v1/components/install", "post")?.description?.toLowerCase()).toContain(
      "without `workers`",
    );

    expect(
      Object.fromEntries(
        (
          [
            ["post", "/v1/workers/{id}/drain", "404"],
            ["delete", "/v1/workers/{id}/drain", "404"],
            ["delete", "/v1/workers/{id}", "409"],
            ["post", "/v1/components/install", "403"],
            ["post", "/v1/components/install", "404"],
            ["post", "/v1/components/install", "422"],
            ["post", "/v1/components/install", "503"],
            ["post", "/v1/components/install", "504"],
            ["get", "/v1/events", "422"],
            ["get", "/v1/events", "503"],
          ] as const
        ).map(([method, path, status]) => [
          `${method} ${path} ${status}`,
          errorCodes(operation(path, method), status),
        ]),
      ),
    ).toEqual({
      "delete /v1/workers/{id} 409": ["WORKER_CONNECTED"],
      "delete /v1/workers/{id}/drain 404": ["UNKNOWN_WORKER"],
      "get /v1/events 422": ["HISTORY_NOT_KEPT"],
      "get /v1/events 503": ["HISTORY_UNAVAILABLE", "DAEMON_STOPPING", "DAEMON_STARTUP_FAILED"],
      "post /v1/components/install 403": ["DOWNLOADS_DISABLED", "FORBIDDEN"],
      "post /v1/components/install 404": ["UNKNOWN_WORKER"],
      "post /v1/components/install 422": ["NO_DRIVER"],
      "post /v1/components/install 503": [
        "WORKER_UNREACHABLE",
        "DAEMON_STOPPING",
        "DAEMON_STARTUP_FAILED",
      ],
      "post /v1/components/install 504": ["DOWNLOAD_TIMEOUT"],
      "post /v1/workers/{id}/drain 404": ["UNKNOWN_WORKER"],
    });
    expect({
      components: queryNames(operation("/v1/components", "get")),
      componentRemove: queryNames(operation("/v1/components/{platform}/{version}", "delete")),
      events: queryNames(operation("/v1/events", "get")),
    }).toEqual({
      components: ["platform"],
      componentRemove: ["dryRun"],
      events: ["before", "limit", "since"],
    });
    expect(
      Object.keys(replySchema(operation("/v1/events", "get"), "200").properties ?? {}),
    ).toEqual(["events"]);

    const install = operation("/v1/components/install", "post");
    expect(streamEvents(install)).toEqual(["error", "progress", "result"]);
    expect(dataKeys(install)).toEqual([
      ["component", "outcome", "platform", "version"],
      ["error"],
      ["fraction", "stage", "workerId"],
      ["results"],
      ["stage", "workerId"],
    ]);
    const stream = operation("/v1/events/stream", "get");
    const message = streamMessage(stream).properties as {
      event?: { type?: string; enum?: unknown };
      data?: { properties?: Record<string, object> };
    };
    expect(message.event?.type).toBe("string");
    expect(message.event?.enum).toBeUndefined();
    expect(Object.keys(message.data?.properties ?? {}).sort()).toEqual(
      ["event", "id", "module", "payload", "seq", "timestamp"].sort(),
    );
    expect(message.data?.properties?.payload).not.toHaveProperty("type");
    expect(operation("/v1/events/stream", "get")?.description).toContain(
      "/simlock/docs/reference/events",
    );
  });
});

describe("buildOpenApiDocument with a module that carries http", () => {
  it("an integrator builds the document from the real modules and gets valid OpenAPI 3.1", async () => {
    const document = buildOpenApiDocument(optionalModules);

    const result = await validate(structuredClone(document) as never);

    expect(result.valid).toBe(true);
  });

  it("an integrator reads GET /v1/stream/workers/{workerId}/devices/{deviceId} under stream, with its headers, binary 200, 405 and refusals, and no lease stream, agent-device or uplink path", () => {
    const document = buildOpenApiDocument(optionalModules);
    const device = document.paths?.["/v1/stream/workers/{workerId}/devices/{deviceId}"]?.get;
    const ok = (device?.responses ?? {})["200"] as OkResponse;

    expect(document.tags?.find((tag) => tag.name === "stream")?.description).toContain(
      "capabilities.stream.enabled",
    );
    expect(sortedKeys(ok.content)).toEqual([
      "application/vnd.simlock.stream+h264",
      "application/vnd.simlock.stream+mjpeg",
    ]);
    expect(sortedKeys(document.paths).filter((path) => path.startsWith("/v1/stream"))).toEqual([
      "/v1/stream/workers/{workerId}/devices/{deviceId}",
    ]);
    expect(device?.tags).toEqual(["stream"]);
    expect(
      Object.fromEntries(
        ["401", "403", "404", "405", "409", "415", "500", "502", "503"].map((status) => [
          status,
          errorCodes(device, status),
        ]),
      ),
    ).toEqual({
      "401": ["UNAUTHENTICATED"],
      "403": ["FORBIDDEN"],
      "404": ["UNKNOWN_DEVICE", "UNKNOWN_WORKER"],
      "405": ["BAD_REQUEST"],
      "409": ["DEVICE_NOT_RUNNING"],
      "415": ["STREAM_NOT_SUPPORTED"],
      "500": ["INTERNAL"],
      "502": ["STREAM_UNAVAILABLE"],
      "503": ["STREAM_UNAVAILABLE", "WORKER_UNREACHABLE"],
    });
    expect(sortedKeys(okHeaders(device))).toEqual([
      "simlock-stream-codec",
      "simlock-stream-fps",
      "simlock-stream-height",
      "simlock-stream-width",
    ]);
    expect(
      sortedKeys(document.paths).filter(
        (path) => path.startsWith("/v1/agent-device") || path === "/v1/uplink",
      ),
    ).toEqual([]);
    expect((document.tags ?? []).map((tag) => tag.name)).toEqual(["stream"]);
  });
});

function okHeaders(operation: { responses?: object } | undefined): Record<string, unknown> {
  return ((operation?.responses ?? {}) as Record<string, OkResponse>)["200"]?.headers ?? {};
}

type OkResponse = { content?: Record<string, unknown>; headers?: Record<string, unknown> };

function sortedKeys(record: object | undefined): string[] {
  return Object.keys(record ?? {}).sort();
}

function summarize(
  operation: { tags?: string[]; description?: string; responses?: object } | undefined,
) {
  return {
    codes503: errorCodes(operation, "503"),
    description: operation?.description,
    statuses: Object.keys(operation?.responses ?? {}).sort(),
    tags: operation?.tags,
  };
}

interface JsonSchema {
  readonly required?: readonly string[];
  readonly properties?: {
    readonly [name: string]: unknown;
    readonly error?: {
      readonly properties?: { readonly code?: { readonly enum?: readonly string[] } };
    };
  };
}

function replySchema(operation: { responses?: object } | undefined, status: string): JsonSchema {
  const responses = (operation?.responses ?? {}) as Record<
    string,
    { content?: { "application/json"?: { schema?: JsonSchema } } }
  >;
  return responses[status]?.content?.["application/json"]?.schema ?? {};
}

function responseOf(operation: { responses?: object } | undefined, status: string) {
  const responses = (operation?.responses ?? {}) as Record<
    string,
    { description?: string; headers?: object }
  >;
  return responses[status] ?? {};
}

function streamMessage(operation: { responses?: object } | undefined): StreamSchema {
  const responses = (operation?.responses ?? {}) as Record<
    string,
    { content?: { "text/event-stream"?: { schema?: StreamSchema } } }
  >;
  return responses["200"]?.content?.["text/event-stream"]?.schema ?? {};
}

function dataShapes(operation: { responses?: object } | undefined) {
  const data = streamMessage(operation).properties?.data as
    | { anyOf?: Shape[]; oneOf?: Shape[] }
    | undefined;
  return (data?.anyOf ?? data?.oneOf ?? [])
    .map((shape) => Object.keys(shape.properties ?? {}))
    .sort((a, b) => a.join().localeCompare(b.join()));
}

interface Shape {
  readonly properties?: object;
}

function streamEvents(operation: { responses?: object } | undefined) {
  return [...(streamMessage(operation).properties?.event?.enum ?? [])].sort();
}

interface StreamSchema {
  readonly properties?: {
    readonly data?: object;
    readonly event?: { readonly enum?: readonly string[] };
  };
}

function errorFields(operation: { responses?: object } | undefined, status: string) {
  return Object.keys(replySchema(operation, status).properties?.error?.properties ?? {});
}

function errorCodes(operation: { responses?: object } | undefined, status: string) {
  return replySchema(operation, status).properties?.error?.properties?.code?.enum;
}

function queryNames(operation: { parameters?: unknown } | undefined) {
  return ((operation?.parameters ?? []) as { in: string; name: string }[])
    .filter((parameter) => parameter.in === "query")
    .map((parameter) => parameter.name);
}

function dataKeys(operation: { responses?: object } | undefined) {
  const flatten = (shape: Shape & { anyOf?: Shape[]; oneOf?: Shape[] }): string[][] => {
    const branches = shape.anyOf ?? shape.oneOf;
    return branches === undefined
      ? [Object.keys(shape.properties ?? {}).sort()]
      : branches.flatMap((branch) => flatten(branch as never));
  };
  return flatten(streamMessage(operation).properties?.data as never).sort((a, b) =>
    a.join().localeCompare(b.join()),
  );
}
