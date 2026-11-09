import { describe, expect, it } from "vitest";

import { FakeHttpJsonRequester } from "../../ports/index.js";
import { CloudApi, CloudApiError } from "./cloud-api.js";

const response = {
  id: "lease_one",
  status: "active",
  started_at: "2026-11-09T12:00:00+00:00",
  expires_at: "2026-11-09T12:30:00+00:00",
  error: null,
};

function setup() {
  const http = new FakeHttpJsonRequester();
  const api = new CloudApi({ url: "https://api.example.com", apiKey: "adc_secret", http });
  return { api, http };
}

// why: this protocol parser is a decomposed part of the Android driver; malformed upstream responses cannot be forced through its device surface.
describe("CloudApi", () => {
  it("uses the account's REST lease lifecycle and parses the upstream expiry", async () => {
    const { api, http } = setup();
    http.answers.set("POST https://api.example.com/v1/leases", { status: 202, body: response });
    http.answers.set("GET https://api.example.com/v1/leases/lease_one", {
      status: 200,
      body: response,
    });
    http.answers.set("POST https://api.example.com/v1/leases/lease_one/renew", {
      status: 200,
      body: response,
    });
    http.answers.set("DELETE https://api.example.com/v1/leases/lease_one", {
      status: 200,
      body: { ...response, status: "released" },
    });

    const created = await api.createLease({
      name: "simlock",
      purpose: "development",
      ttlSeconds: 1800,
      idempotencyKey: "request_one",
    });
    expect(created).toEqual({
      id: "lease_one",
      status: "active",
      startedAtMs: 1794225600000,
      expiresAtMs: 1794227400000,
      error: undefined,
    });
    await api.get("lease_one");
    await api.renew("lease_one", 900);
    const released = await api.release("lease_one");
    expect(released.status).toBe("released");
    expect(http.requests).toEqual([
      {
        method: "POST",
        url: "https://api.example.com/v1/leases",
        token: "adc_secret",
        body: {
          name: "simlock",
          purpose: "development",
          ttl_seconds: 1800,
          idempotency_key: "request_one",
        },
      },
      { method: "GET", url: "https://api.example.com/v1/leases/lease_one", token: "adc_secret" },
      {
        method: "POST",
        url: "https://api.example.com/v1/leases/lease_one/renew",
        token: "adc_secret",
        body: { ttl_seconds: 900 },
      },
      { method: "DELETE", url: "https://api.example.com/v1/leases/lease_one", token: "adc_secret" },
    ]);
    expect(api.adbUrl("lease_one")).toBe("wss://api.example.com/v1/leases/lease_one/adb");
    expect(api.authorizationHeaders()).toEqual({ authorization: "Bearer adc_secret" });
  });

  it("refuses malformed or mismatched leases and reports an HTTP refusal without its response body", async () => {
    const { api, http } = setup();
    const key = "GET https://api.example.com/v1/leases/lease_one";
    http.answers.set(key, { status: 200, body: response });
    const accepted = await api.get("lease_one");
    expect(accepted.id).toBe("lease_one");
    const invalid = [
      { ...response, id: "different" },
      { ...response, status: "unknown" },
      { ...response, started_at: null },
      { ...response, expires_at: "tomorrow" },
    ];
    for (const body of invalid) {
      http.answers.set(key, { status: 200, body });
      await expect(api.get("lease_one")).rejects.toThrow(/AgentDeviceCloud returned/);
    }
    http.answers.set(key, { status: 404, body: { detail: "adc_secret" } });
    await expect(api.get("lease_one")).rejects.toEqual(
      new CloudApiError(404, "AgentDeviceCloud request failed (HTTP 404)"),
    );
  });

  it("keeps the bearer credential on a trusted origin and refuses path-like lease ids", async () => {
    const http = new FakeHttpJsonRequester();
    const local = new CloudApi({ url: "http://127.0.0.1:8000", apiKey: "adc_secret", http });
    expect(local.adbUrl("lease_one")).toBe("ws://127.0.0.1:8000/v1/leases/lease_one/adb");
    for (const url of [
      "http://api.example.com",
      "https://user:pass@api.example.com",
      "https://api.example.com/path",
      "https://api.example.com?key=secret",
    ]) {
      expect(() => new CloudApi({ url, apiKey: "adc_secret", http })).toThrow(
        "AgentDeviceCloud URL must be",
      );
    }
    expect(() => local.adbUrl("../lease_one")).toThrow();
    expect(http.requests).toEqual([]);
  });
});
