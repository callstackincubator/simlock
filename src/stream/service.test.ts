import { describe, expect, it } from "vitest";

import type { CapturedStream } from "./feed.js";
import { StreamRefusalError } from "./refusal.js";
import { handleStreamRequest, leaseIdOf, streamResponse, type StreamLink } from "./service.js";

function stream(codec: "h264" | "mjpeg" = "h264"): CapturedStream {
  return {
    body: new ReadableStream<Uint8Array>(),
    close: async () => undefined,
    meta: { codec, fps: 30, height: 720, width: 330 },
  };
}

function linkThat(serve: StreamLink["serve"]): StreamLink {
  return { serve };
}

const OPERATOR = { principal: "tok_op", role: "operator" } as const;

function get(path = "/v1/stream/leases/lse_1"): Request {
  return new Request(`http://daemon${path}`);
}

describe("leaseIdOf", () => {
  it("reads the lease a stream path names, including a fleet id with a dot in it", () => {
    expect(leaseIdOf("/v1/stream/leases/lse_1")).toBe("lse_1");
    expect(leaseIdOf("/v1/stream/leases/28e5b99c.lse_c09b")).toBe("28e5b99c.lse_c09b");
  });

  it("reads nothing for a path that is not one lease", () => {
    for (const path of [
      "/v1/stream/leases",
      "/v1/stream/leases/",
      "/v1/stream/leases/lse_1/frames",
      "/v1/stream/devices/lse_1",
      "/v1/stream/leases/%zz",
    ]) {
      expect(leaseIdOf(path), path).toBeUndefined();
    }
  });

  it("unescapes an id that arrived escaped", () => {
    expect(leaseIdOf("/v1/stream/leases/lse%5F1")).toBe("lse_1");
  });
});

describe("handleStreamRequest", () => {
  it("refuses a path that names no lease with the body shape every other route uses", async () => {
    const response = await handleStreamRequest(
      { link: linkThat(async () => stream()) },
      get("/v1/stream/leases"),
      OPERATOR,
      leaseIdOf("/v1/stream/leases"),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "UNKNOWN_LEASE", message: "This path names no stream lease" },
    });
  });

  it("refuses to be written to", async () => {
    const response = await handleStreamRequest(
      { link: linkThat(async () => stream()) },
      new Request("http://daemon/v1/stream/leases/lse_1", { method: "POST" }),
      OPERATOR,
      "lse_1",
    );
    expect(response.status).toBe(405);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("BAD_REQUEST");
  });

  it("carries a link's refusal out as its own status and code", async () => {
    // why: the codes are the point. A gateway forwards a worker's refusal, so a viewer that is told 415
    // learned something the gateway could not have invented, and a client that reads `error.code` needs
    // no special case for a stream that never started.
    const refusal = new StreamRefusalError(415, "STREAM_NOT_SUPPORTED", "not a simulator");
    const response = await handleStreamRequest(
      { link: linkThat(async () => Promise.reject(refusal)) },
      get(),
      OPERATOR,
      "lse_1",
    );
    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({
      error: { code: "STREAM_NOT_SUPPORTED", message: "not a simulator" },
    });
  });

  it("answers an unexpected failure as an internal one rather than leaking a bare message", async () => {
    const response = await handleStreamRequest(
      { link: linkThat(async () => Promise.reject(new Error("spawn ENOENT"))) },
      get(),
      OPERATOR,
      "lse_1",
    );
    expect(response.status).toBe(500);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("INTERNAL");
  });

  it("answers a stream with its picture described in the headers", async () => {
    const response = await handleStreamRequest(
      { link: linkThat(async () => stream("mjpeg")) },
      get(),
      OPERATOR,
      "lse_1",
    );
    expect(response.status).toBe(200);
    expect([...response.headers].sort()).toEqual(
      [
        ["cache-control", "no-store"],
        ["content-type", "application/vnd.simlock.stream+mjpeg"],
        ["simlock-stream-codec", "mjpeg"],
        ["simlock-stream-fps", "30"],
        ["simlock-stream-height", "720"],
        ["simlock-stream-width", "330"],
        ["x-simlock-lease", "lse_1"],
      ].sort(),
    );
  });
});

describe("streamResponse", () => {
  it("hands the body out unchanged", async () => {
    const bytes = new Uint8Array([0, 0, 0, 5, 5, 123]);
    const response = streamResponse("lse_1", {
      ...stream(),
      body: new ReadableStream<Uint8Array>({
        start: (controller) => {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    });
    // why: nothing between a simulator's framebuffer and a browser re-frames the envelope, so a reader
    // of this body must see exactly the bytes the capture program wrote.
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });
});
