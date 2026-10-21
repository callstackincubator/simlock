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

    expect(status?.tags).toEqual(["System"]);
    expect(status?.description).toContain("Role: agent.");
    expect(Object.keys(status?.responses ?? {}).sort()).toEqual([
      "200",
      "401",
      "403",
      "500",
      "503",
    ]);
    expect(errorCodes(status, "503")).toEqual(["DAEMON_STOPPING", "DAEMON_STARTUP_FAILED"]);
    expect(add?.tags).toEqual(["Devices"]);
    expect(add?.description).toContain("Role: admin.");
    expect(add?.requestBody).toMatchObject({ required: true });
    expect(replySchema(add, "200").required).toEqual(
      expect.arrayContaining(["id", "driverDeviceId", "reenrolled"]),
    );
    expect(errorCodes(add, "422")).toEqual(["DEVICE_NOT_ENROLLABLE", "NO_DRIVER"]);
    expect(errorCodes(add, "403")).toEqual(["FORBIDDEN"]);
    expect(errorCodes(add, "415")).toEqual(["UNSUPPORTED_MEDIA_TYPE"]);
    expect(errorCodes(add, "400")).toEqual(["BAD_REQUEST"]);
    expect(errorCodes(add, "409")).toEqual(["DEVICE_BUSY"]);
    expect(errorCodes(add, "501")).toEqual(["UNSUPPORTED_IN_GATEWAY_MODE"]);
  });
});

interface JsonSchema {
  readonly required?: readonly string[];
  readonly properties?: {
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
