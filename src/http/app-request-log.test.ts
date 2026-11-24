import { describe, expect, it } from "vitest";

import type { HttpMount } from "./app-types.js";
import { agentAuth, buildHarness } from "./test-app.js";

const jsonMount: HttpMount = {
  prefix: "json-mount",
  handle: async () => Response.json({ error: { code: "MOUNT_REFUSED" } }, { status: 400 }),
};

function requestLines(logSink: ReturnType<typeof buildHarness>["logSink"]) {
  return logSink.records.filter((record) => record.message === "request");
}

describe("the request log line", () => {
  it("carries the answer's error code on a refused request and leaves the answer's body intact", async () => {
    const { app, logSink } = buildHarness();

    const response = await app.request("/v1/leases/lse_missing", { headers: agentAuth });

    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "UNKNOWN_LEASE",
    );
    expect(requestLines(logSink)).toEqual([
      expect.objectContaining({
        fields: expect.objectContaining({
          code: "UNKNOWN_LEASE",
          path: "/v1/leases/lse_missing",
          status: 404,
        }),
      }),
    ]);
  });

  it("has no code on an answer that succeeded", async () => {
    const { app, logSink } = buildHarness();

    const response = await app.request("/v1/leases", { headers: agentAuth });

    expect(response.status).toBe(200);
    const [line] = requestLines(logSink);
    expect(line?.fields).toMatchObject({ path: "/v1/leases", status: 200 });
    expect(line?.fields).not.toHaveProperty("code");
  });

  it("has no code on a mount's own refusal", async () => {
    const { app, logSink } = buildHarness({ mounts: [jsonMount] });

    const response = await app.request("/v1/json-mount/x", { headers: agentAuth });

    expect(response.status).toBe(400);
    const [line] = requestLines(logSink);
    expect(line?.fields).toMatchObject({ path: "/v1/json-mount/x", status: 400 });
    expect(line?.fields).not.toHaveProperty("code");
  });

  it("carries the code of simlock's own refusal on a mount's path", async () => {
    const { app, logSink } = buildHarness({ mounts: [jsonMount] });

    const response = await app.request("/v1/json-mount/x");

    expect(response.status).toBe(401);
    expect(requestLines(logSink)).toEqual([
      expect.objectContaining({
        fields: expect.objectContaining({
          code: "UNAUTHENTICATED",
          path: "/v1/json-mount/x",
          status: 401,
        }),
      }),
    ]);
  });
});
