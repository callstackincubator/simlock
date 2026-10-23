import { describe, expect, it } from "vitest";

import type { CapturedStream } from "./feed.js";
import { StreamRefusalError } from "./refusal.js";
import { handleStreamRequest, streamResponse, type StreamLink, streamTargetOf } from "./service.js";

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

const TARGET = { deviceId: "dev_1", workerId: "w1" };

function get(path = "/v1/stream/workers/w1/devices/dev_1"): Request {
  return new Request(`http://daemon${path}`);
}

// why: a path is parsed by a pure function with many shapes of input, and the route table above it only
// hands it whatever matched a prefix.
describe("streamTargetOf", () => {
  it("reads the worker and device a stream path names, unescaped, and nothing for any other path", () => {
    expect(streamTargetOf("/v1/stream/workers/w1/devices/dev_1")).toEqual({
      deviceId: "dev_1",
      workerId: "w1",
    });
    expect(streamTargetOf("/v1/stream/workers/28e5b99c/devices/dev%5F1")).toEqual({
      deviceId: "dev_1",
      workerId: "28e5b99c",
    });
    for (const path of [
      "/v1/stream/workers/w1/devices/",
      "/v1/stream/workers/w1/devices/dev_1/frames",
      "/v1/stream/workers/w1/devices/%zz",
      "/v1/stream/leases/lse_1",
    ]) {
      expect(streamTargetOf(path), path).toBeUndefined();
    }
  });
});

describe("handleStreamRequest", () => {
  it("refuses a path that names no stream, a lease's included, with the body shape every other route uses and opens nothing", async () => {
    const asked: unknown[] = [];
    const options = {
      link: linkThat(async (target) => {
        asked.push(target);
        return stream();
      }),
    };
    for (const path of [
      "/v1/stream/leases/lse_1",
      "/v1/stream/leases",
      "/v1/stream/workers/w1",
      "/v1/stream/devices/d1",
    ]) {
      const response = await handleStreamRequest(
        options,
        get(path),
        OPERATOR,
        streamTargetOf(path),
      );
      expect(response.status, path).toBe(404);
      expect(await response.json(), path).toEqual({
        error: { code: "UNKNOWN_DEVICE", message: "This path names no stream" },
      });
    }
    expect(asked).toEqual([]);
  });

  it("refuses to be written to", async () => {
    const response = await handleStreamRequest(
      { link: linkThat(async () => stream()) },
      new Request("http://daemon/v1/stream/workers/w1/devices/dev_1", { method: "POST" }),
      OPERATOR,
      TARGET,
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
      TARGET,
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
      TARGET,
    );
    expect(response.status).toBe(500);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("INTERNAL");
  });

  it("answers a stream with its picture described in the headers", async () => {
    const response = await handleStreamRequest(
      { link: linkThat(async () => stream("mjpeg")) },
      get(),
      OPERATOR,
      TARGET,
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
      ].sort(),
    );
  });
});

describe("streamResponse", () => {
  it("hands the body out unchanged", async () => {
    const bytes = new Uint8Array([0, 0, 0, 5, 5, 123]);
    const response = streamResponse({
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
