import { z } from "zod";

import type { HttpJsonRequester } from "../../ports/index.js";

const text = z.string();
const nonemptyId = text.min(1);
const boundedId = nonemptyId.max(120);
const leaseId = boundedId.regex(/^[a-zA-Z0-9_-]+$/);
const boundedTimestamp = text.max(64);
const datedTimestamp = boundedTimestamp.datetime({ offset: true });
const timestamp = datedTimestamp.nullable();
const boundedError = text.max(4_096);
const errorMessage = boundedError.nullable();
const status = z.enum(["queued", "active", "released", "expired", "failed"]);
const leaseResponse = z.object({
  id: leaseId,
  status,
  started_at: timestamp,
  expires_at: timestamp,
  error: errorMessage,
});

export interface CloudLease {
  readonly id: string;
  readonly status: "queued" | "active" | "released" | "expired" | "failed";
  readonly startedAtMs: number | undefined;
  readonly expiresAtMs: number | undefined;
  readonly error: string | undefined;
}

export interface CloudProvisionRequest {
  readonly name: string;
  readonly purpose: "development" | "ci";
  readonly ttlSeconds: number;
  readonly idempotencyKey: string;
}

export class CloudApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CloudApiError";
  }
}

export interface CloudApiOptions {
  readonly url: string;
  readonly apiKey: string;
  readonly http: HttpJsonRequester;
}

export class CloudApi {
  readonly #origin: string;

  constructor(private readonly options: CloudApiOptions) {
    const url = new URL(options.url);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    const secure = url.protocol === "https:" || (url.protocol === "http:" && local);
    if (
      secure === false ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.pathname !== "/"
    ) {
      throw new Error("AgentDeviceCloud URL must be an HTTPS origin, or HTTP on localhost");
    }
    if (options.apiKey.length === 0) throw new Error("AgentDeviceCloud API key is required");
    this.#origin = url.origin;
  }

  async createLease(input: CloudProvisionRequest): Promise<CloudLease> {
    return await this.#request("POST", "/v1/leases", {
      name: input.name,
      purpose: input.purpose,
      ttl_seconds: input.ttlSeconds,
      idempotency_key: input.idempotencyKey,
    });
  }

  async get(id: string): Promise<CloudLease> {
    const path = this.#leasePath(id);
    return await this.#request("GET", path, undefined, id);
  }

  async renew(id: string, ttlSeconds: number): Promise<CloudLease> {
    const path = this.#leasePath(id);
    return await this.#request("POST", `${path}/renew`, { ttl_seconds: ttlSeconds }, id);
  }

  async release(id: string): Promise<CloudLease> {
    const path = this.#leasePath(id);
    return await this.#request("DELETE", path, undefined, id);
  }

  adbUrl(id: string): string {
    const path = this.#leasePath(id);
    const url = new URL(`${path}/adb`, this.#origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.href;
  }

  authorizationHeaders(): Readonly<Record<string, string>> {
    return { authorization: `Bearer ${this.options.apiKey}` };
  }

  #leasePath(id: string): string {
    const checked = leaseId.parse(id);
    const encoded = encodeURIComponent(checked);
    return `/v1/leases/${encoded}`;
  }

  async #request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
    expectedId?: string,
  ): Promise<CloudLease> {
    const response = await this.options.http.request({
      method,
      url: `${this.#origin}${path}`,
      token: this.options.apiKey,
      ...(body === undefined ? {} : { body }),
    });
    if (response.status < 200 || response.status >= 300) {
      const code = String(response.status);
      throw new CloudApiError(response.status, `AgentDeviceCloud request failed (HTTP ${code})`);
    }
    const checked = leaseResponse.safeParse(response.body);
    if (checked.success === false) throw new Error("AgentDeviceCloud returned an invalid lease");
    const lease = checked.data;
    if (expectedId !== undefined && lease.id !== expectedId) {
      throw new Error("AgentDeviceCloud returned a different lease");
    }
    const startedAtMs = lease.started_at === null ? undefined : Date.parse(lease.started_at);
    const expiresAtMs = lease.expires_at === null ? undefined : Date.parse(lease.expires_at);
    if (lease.status === "active" && (startedAtMs === undefined || expiresAtMs === undefined)) {
      throw new Error("AgentDeviceCloud returned an active lease without its lifetime");
    }
    return {
      id: lease.id,
      status: lease.status,
      startedAtMs,
      expiresAtMs,
      error: lease.error === null ? undefined : lease.error,
    };
  }
}
