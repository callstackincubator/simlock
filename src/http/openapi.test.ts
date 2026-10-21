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
});
