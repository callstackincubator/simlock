import { describe, expect, it } from "vitest";

import { FakeHttpJsonRequester } from "./test-http.js";
import { CloudApi, CloudApiError } from "./api.js";

const response = {
  id: "lease_one",
  status: "active",
  error: null,
};

function setup() {
  const http = new FakeHttpJsonRequester();
  const api = new CloudApi({ url: "https://api.example.com", apiKey: "adc_secret", http });
  return { api, http };
}

// why: this protocol parser is a decomposed part of the Android driver; malformed upstream responses cannot be forced through its device surface.
describe("CloudApi", () => {
  it("creates a deadline-free account lease and releases it explicitly", async () => {
    const { api, http } = setup();
    http.answers.set("POST https://api.example.com/v2/leases", { status: 202, body: response });
    http.answers.set("GET https://api.example.com/v2/leases/lease_one", {
      status: 200,
      body: response,
    });
    http.answers.set("DELETE https://api.example.com/v2/leases/lease_one", {
      status: 200,
      body: { ...response, status: "released" },
    });

    const created = await api.createLease({
      name: "simlock",
      purpose: "development",
      idempotencyKey: "request_one",
    });
    expect(created).toEqual({
      id: "lease_one",
      status: "active",
      error: undefined,
    });
    await api.get("lease_one");
    const released = await api.release("lease_one");
    expect(released.status).toBe("released");
    expect(http.requests).toEqual([
      {
        method: "POST",
        url: "https://api.example.com/v2/leases",
        token: "adc_secret",
        body: {
          name: "simlock",
          purpose: "development",
          idempotency_key: "request_one",
        },
      },
      { method: "GET", url: "https://api.example.com/v2/leases/lease_one", token: "adc_secret" },
      { method: "DELETE", url: "https://api.example.com/v2/leases/lease_one", token: "adc_secret" },
    ]);
    const adbUrl = api.adbUrl("lease_one");
    const headers = api.authorizationHeaders();
    expect(adbUrl).toBe("wss://api.example.com/v2/leases/lease_one/adb");
    expect(headers).toEqual({ authorization: "Bearer adc_secret" });
  });

  it("refuses malformed or mismatched leases and reports an HTTP refusal without its response body", async () => {
    const { api, http } = setup();
    const key = "GET https://api.example.com/v2/leases/lease_one";
    http.answers.set(key, { status: 200, body: response });
    const accepted = await api.get("lease_one");
    expect(accepted.id).toBe("lease_one");
    const invalid = [
      { ...response, id: "different" },
      { ...response, status: "unknown" },
      { ...response, error: 123 },
      { ...response, id: "../lease_one" },
    ];
    for (const body of invalid) {
      http.answers.set(key, { status: 200, body });
      const fetching = api.get("lease_one");
      await expect(fetching).rejects.toThrow(/AgentDeviceCloud returned/);
    }
    http.answers.set(key, { status: 404, body: { detail: "adc_secret" } });
    const fetching = api.get("lease_one");
    const refusal = new CloudApiError(404, "AgentDeviceCloud request failed (HTTP 404)");
    await expect(fetching).rejects.toEqual(refusal);
  });

  it("keeps the bearer credential on a trusted origin and refuses path-like lease ids", async () => {
    const http = new FakeHttpJsonRequester();
    const local = new CloudApi({ url: "http://127.0.0.1:8000", apiKey: "adc_secret", http });
    const adbUrl = local.adbUrl("lease_one");
    expect(adbUrl).toBe("ws://127.0.0.1:8000/v2/leases/lease_one/adb");
    for (const url of [
      "http://api.example.com",
      "https://user:pass@api.example.com",
      "https://api.example.com/path",
      "https://api.example.com?key=secret",
    ]) {
      const construct = () => new CloudApi({ url, apiKey: "adc_secret", http });
      expect(construct).toThrow("AgentDeviceCloud URL must be");
    }
    const foreignLease = () => local.adbUrl("../lease_one");
    expect(foreignLease).toThrow();
    expect(http.requests).toEqual([]);
  });
});
