import { describe, expect, it } from "vitest";

import {
  DAEMON_PROTOCOL_VERSION,
  parseDaemonResponse,
  parseRequestFrame,
  serializeFrame,
} from "./index.js";

describe("daemon protocol", () => {
  it("keeps the current protocol version and newline framing", () => {
    // ADR 0005: protocol 5, no compatibility shim -- `device.exec`, its `output` push family,
    // `status.get`'s always-present `mode`, and the gateway surface (`worker.*`, `workerId`,
    // the `worker` token role) all land on the wire with nothing kept behind them, exactly as
    // ADR 0004's removals took it to 4, so under ADR 0003 §6's honesty rule the range does not
    // widen to keep speaking 4.
    expect(DAEMON_PROTOCOL_VERSION).toBe(5);
    expect(serializeFrame({ id: 1, type: "hello" })).toBe('{"id":1,"type":"hello"}\n');
  });

  it("parses only request envelopes", () => {
    expect(parseRequestFrame({ id: "one", payload: {}, type: "status.get" })).toEqual({
      id: "one",
      payload: {},
      type: "status.get",
    });
    expect(parseRequestFrame({ id: null, type: "status.get" })).toBeUndefined();
  });

  it("parses response success, failure, and push frames", () => {
    expect(parseDaemonResponse({ id: 1, ok: true, payload: { health: "running" } })).toEqual({
      id: 1,
      kind: "success",
      payload: { health: "running" },
    });
    expect(parseDaemonResponse({ error: { code: "BAD" }, id: 2, ok: false })).toEqual({
      error: { code: "BAD" },
      id: 2,
      kind: "failure",
    });
    expect(parseDaemonResponse({ payload: { id: 3 }, push: "event" })).toEqual({
      kind: "push",
      payload: { id: 3 },
      push: "event",
    });
  });

  it("rejects invalid response envelopes", () => {
    expect(parseDaemonResponse(null)).toBeUndefined();
    expect(parseDaemonResponse({ id: "one", ok: true })).toBeUndefined();
  });
});
