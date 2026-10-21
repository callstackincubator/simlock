import { validate } from "@readme/openapi-parser";
import { describe, expect, it } from "vitest";

import packageJson from "../../package.json" with { type: "json" };
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
});

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

function errorCodes(operation: { responses?: object } | undefined, status: string) {
  return replySchema(operation, status).properties?.error?.properties?.code?.enum;
}
