import { z } from "zod";

import type { HttpJsonRequester } from "../../../ports/index.js";
import { cloudOrigin } from "./origin.js";

const text = z.string();
const nonemptyId = text.min(1);
const boundedId = nonemptyId.max(120);
const leaseId = boundedId.regex(/^[a-zA-Z0-9_-]+$/);
const boundedError = text.max(4_096);
const errorMessage = boundedError.nullable();
const status = z.enum(["queued", "active", "released", "expired", "failed"]);
const leaseResponse = z.object({
  id: leaseId,
  status,
  error: errorMessage,
});

function decodeLease(body: unknown, expectedId?: string): CloudLease {
  const checked = leaseResponse.safeParse(body);
  if (checked.success === false) throw new Error("AgentDeviceCloud returned an invalid lease");
  const lease = checked.data;
  if (expectedId !== undefined && lease.id !== expectedId) {
    throw new Error("AgentDeviceCloud returned a different lease");
  }
  return {
    id: lease.id,
    status: lease.status,
    error: lease.error === null ? undefined : lease.error,
  };
}

export interface CloudLease {
  readonly id: string;
  readonly status: "queued" | "active" | "released" | "expired" | "failed";
  readonly error: string | undefined;
}

export interface CloudProvisionRequest {
  readonly name: string;
  readonly purpose: "development" | "ci";
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
    this.#origin = cloudOrigin(options.url);
    if (options.apiKey.length === 0) throw new Error("AgentDeviceCloud API key is required");
  }

  async createLease(input: CloudProvisionRequest): Promise<CloudLease> {
    return await this.#request("POST", "/v2/leases", {
      name: input.name,
      purpose: input.purpose,
      idempotency_key: input.idempotencyKey,
    });
  }

  async get(id: string): Promise<CloudLease> {
    const path = this.#leasePath(id);
    return await this.#request("GET", path, undefined, id);
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
    return `/v2/leases/${encoded}`;
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
    return decodeLease(response.body, expectedId);
  }
}
