import type { AgentDeviceHealthProbe } from "./host/health.js";
import type { AgentDeviceUpstream, AgentDeviceUpstreamState } from "./host/upstream.js";

type Answer = { readonly body: unknown } | { readonly error: Error } | "never";

export class FakeAgentDeviceHealth implements AgentDeviceHealthProbe {
  readonly reads: string[] = [];
  #answer: Answer = "never";

  respondWith(body: unknown): void {
    this.#answer = { body };
  }

  rejectWith(error: Error): void {
    this.#answer = { error };
  }

  // fallow-ignore-next-line unused-class-member -- reached through the AgentDeviceHealthProbe port by the supervisor.
  async read(baseUrl: string): Promise<unknown> {
    this.reads.push(baseUrl);
    if (this.#answer === "never") return new Promise<never>(() => undefined);
    if ("error" in this.#answer) throw this.#answer.error;
    return this.#answer.body;
  }
}

export interface FakeAgentDeviceRequest {
  readonly method: string;
  readonly path: string;
  readonly tenant: string | undefined;
  readonly rpcMethod?: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

interface FakeAgentDeviceLease {
  readonly leaseId: string;
  readonly address: string | undefined;
  readonly tenant: string | undefined;
  readonly scope: {
    readonly runId: unknown;
    readonly leaseProvider: unknown;
    readonly clientId: unknown;
    readonly deviceKey: unknown;
  };
  readonly ttlMs: unknown;
  ended: boolean;
}

interface FakeFailure {
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type FakeLeaseGoneReason = "LEASE_NOT_FOUND" | "LEASE_EXPIRED" | "LEASE_REVOKED";

interface RunningCommand {
  readonly leaseId: string;
  readonly address: string | undefined;
  readonly ended: Promise<void>;
}

export interface FakeReplyDevice {
  readonly name?: string;
  readonly target?: string;
}

export interface FakeInventoryDevice {
  readonly id: string;
  readonly name?: string;
  readonly platform?: string;
  readonly target?: string;
}

export interface FakeAllocateReplyEdit {
  readonly runId?: string;
  readonly clientId?: string;
}

interface Gate {
  readonly promise: Promise<void>;
  open(): void;
}

function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, promise };
}

const present = (value: unknown): boolean => value !== undefined && value !== null;

function addressOf(params: Record<string, unknown>): string | undefined {
  const address = params["udid"] ?? params["serial"];
  return typeof address === "string" ? address : undefined;
}

function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function scopeRequired(id: unknown): Response {
  return errorEnvelope(id, {
    code: "UNAUTHORIZED",
    details: { reason: "LEASE_SCOPE_REQUIRED" },
    message: "lease scope required",
  });
}

async function readRpc(request: Request, tenantHeader: string | undefined) {
  const body = (await request.json()) as {
    readonly id?: unknown;
    readonly method?: string;
    readonly params?: Record<string, unknown>;
  };
  const params = body.params ?? {};
  const meta = (params["meta"] ?? {}) as Record<string, unknown>;
  const stamped = params["tenantId"] ?? meta["tenantId"];
  const tenant = tenantHeader ?? (typeof stamped === "string" ? stamped : undefined);
  return { id: body.id, meta, method: body.method ?? "", params, tenant };
}

function envelope(id: unknown, result: unknown): Response {
  return Response.json({ id, jsonrpc: "2.0", result });
}

function errorEnvelope(id: unknown, failure: FakeFailure): Response {
  return Response.json({
    error: { code: -32000, data: failure, message: failure.message },
    id,
    jsonrpc: "2.0",
  });
}

export class FakeAgentDevice implements AgentDeviceUpstream {
  readonly requests: FakeAgentDeviceRequest[] = [];
  readonly leases = new Map<string, FakeAgentDeviceLease>();
  readonly abortedCommands: string[] = [];
  readonly abortedReleases: string[] = [];
  // why: the ids of releases whose request was hung up on before the fake answered, so a test can wait until the hang-up has reached the daemon side.
  readonly hungUpReleases: string[] = [];
  readonly refused: string[] = [];
  readonly uploads: string[] = [];
  // why: the headers the proxy sent the daemon with each upload preflight, so a test can see which of the caller's credentials reached it.
  readonly preflightHeaders: Record<string, string>[] = [];
  baseUrl = "http://127.0.0.1:47001";
  token = "daemon-token-1";
  generation = 1;
  leaseMaxTtlMs: number;
  onRelease: (() => Promise<void>) | undefined;
  // why: the body of each release answer sent, so a test can read what the daemon said.
  readonly releaseReplies: string[] = [];
  onHeartbeat: (() => Promise<void>) | undefined;
  #unavailable: string | undefined;
  #unreachable = false;
  #failAllocate: FakeFailure | undefined;
  #failRelease: FakeFailure | undefined;
  #failHeartbeat: FakeFailure | undefined;
  #failCommand: FakeFailure | undefined;
  #failCommandStatus: { readonly status: number; readonly body: string } | undefined;
  readonly #goneReasons = new Map<string, FakeLeaseGoneReason>();
  #allocateBody: string | undefined;
  #replyDeviceKey: string | undefined;
  #anyTenantReleases = false;
  #allocateGate: Gate | undefined;
  #commandGate: Gate | undefined;
  #streamChunks: readonly string[] | undefined;
  #restarts = 0;
  readonly #running = new Set<RunningCommand>();
  #releaseWaitsForCommands = true;
  #commandsOutliveRequests = false;
  #hangRelease = false;
  #releaseBody: string | undefined;
  #replyEdit: FakeAllocateReplyEdit | undefined;
  #replyDevice: FakeReplyDevice | "none" | undefined;
  #devicesAnswer:
    | { readonly body: string }
    | { readonly list: readonly FakeInventoryDevice[] }
    | undefined;

  constructor(options: { readonly leaseMaxTtlMs?: number } = {}) {
    this.leaseMaxTtlMs = options.leaseMaxTtlMs ?? 4 * 60 * 60_000 + 10_000;
  }

  current(): AgentDeviceUpstreamState {
    if (this.#unavailable !== undefined) {
      return { reason: this.#unavailable, state: "unavailable" };
    }
    return {
      baseUrl: this.baseUrl,
      generation: this.generation,
      leaseMaxTtlMs: this.leaseMaxTtlMs,
      state: "running",
      token: this.token,
    };
  }

  setUnavailable(reason: string | undefined): void {
    this.#unavailable = reason;
  }

  setUnreachable(unreachable: boolean): void {
    this.#unreachable = unreachable;
  }

  failNextAllocate(failure: FakeFailure): void {
    this.#failAllocate = failure;
  }

  failNextRelease(failure: FakeFailure): void {
    this.#failRelease = failure;
  }

  failNextHeartbeat(failure: FakeFailure): void {
    this.#failHeartbeat = failure;
  }

  failNextCommand(failure: FakeFailure): void {
    this.#failCommand = failure;
  }

  failNextCommandWithStatus(status: number, body: string): void {
    this.#failCommandStatus = { body, status };
  }

  // why: agent-device answers a heartbeat for a lease it no longer holds with UNAUTHORIZED and one of three reasons; this makes it forget `leaseId` for the given one.
  loseLease(leaseId: string, reason: FakeLeaseGoneReason): void {
    this.leases.delete(leaseId);
    this.#goneReasons.set(leaseId, reason);
  }

  answerNextAllocateWith(body: string): void {
    this.#allocateBody = body;
  }

  nameDeviceKeyInNextReply(deviceKey: string): void {
    this.#replyDeviceKey = deviceKey;
  }

  // why: a daemon that finds a lease whichever tenant names it lets a cross-tenant release through to agent-device; only the simlock release is guarded by the front's owner check.
  letAnyTenantRelease(): void {
    this.#anyTenantReleases = true;
  }

  holdAllocate(): void {
    this.#allocateGate = gate();
  }

  letAllocateGo(): void {
    this.#allocateGate?.open();
  }

  holdCommand(): void {
    this.#commandGate = gate();
  }

  releaseCommand(): void {
    this.#commandGate?.open();
  }

  // why: agent-device does not watch its caller hang up, so a command whose request simlock aborted still runs until the test lets it go.
  keepCommandsAfterAbort(): void {
    this.#commandsOutliveRequests = true;
  }

  answerNextReleaseWith(body: string): void {
    this.#releaseBody = body;
  }

  hangNextRelease(): void {
    this.#hangRelease = true;
  }

  // why: the reply carries the edited values while the lease the fake stores keeps the scope the CLI's allocate carried.
  editNextAllocateReply(edit: FakeAllocateReplyEdit): void {
    this.#replyEdit = edit;
  }

  // why: agent-device names the device it picked beside the lease in its allocate reply; `"none"` is a reply that names no device.
  nameDeviceInNextReply(device: FakeReplyDevice | "none"): void {
    this.#replyDevice = device;
  }

  // why: the `devices` command answers the daemon's whole inventory, which the front must cut down to the token's own devices.
  listDevices(devices: readonly FakeInventoryDevice[]): void {
    this.#devicesAnswer = { list: devices };
  }

  answerDevicesWith(body: string): void {
    this.#devicesAnswer = { body };
  }

  streamNextCommand(chunks: readonly string[]): void {
    this.#streamChunks = chunks;
  }

  // why: a release answers while a command on the lease still runs, so a test can tell what stopped the front's renewals.
  answerReleaseWhileCommandsRun(): void {
    this.#releaseWaitsForCommands = false;
  }

  restart(): void {
    this.#restarts += 1;
    this.generation += 1;
    this.baseUrl = `http://127.0.0.1:${47_001 + this.#restarts}`;
    this.token = `daemon-token-${this.generation}`;
    this.leases.clear();
  }

  rpcRequests(rpcMethod: string): readonly FakeAgentDeviceRequest[] {
    return this.requests.filter((request) => request.rpcMethod === rpcMethod);
  }

  // fallow-ignore-next-line complexity -- one fake dispatching each agent-device call by method.
  async fetch(request: Request): Promise<Response> {
    if (this.#unreachable) {
      const refused = (await request
        .clone()
        .json()
        .catch(() => undefined)) as { readonly method?: unknown } | undefined;
      this.refused.push(typeof refused?.method === "string" ? refused.method : request.url);
      throw new TypeError("fetch failed");
    }
    const url = new URL(request.url);
    const base = new URL(this.baseUrl);
    if (url.origin !== base.origin) throw new TypeError("fetch failed: wrong origin");
    if (request.headers.get("authorization") !== `Bearer ${this.token}`) {
      return Response.json(
        { code: "UNAUTHORIZED", error: "bad token", ok: false },
        { status: 401 },
      );
    }
    const tenantHeader = request.headers.get("x-agent-device-tenant") ?? undefined;
    if (url.pathname === "/health") {
      this.requests.push({ method: request.method, path: url.pathname, tenant: tenantHeader });
      return Response.json({ ok: true, rpcProtocolVersion: 2, service: "agent-device-daemon" });
    }
    if (url.pathname === "/upload/preflight") {
      this.preflightHeaders.push(Object.fromEntries(request.headers));
      this.requests.push({ method: request.method, path: url.pathname, tenant: tenantHeader });
      return Response.json({
        ok: true,
        upload: { headers: {}, url: `${this.baseUrl}/upload/direct/ticket-1` },
      });
    }
    if (url.pathname.startsWith("/upload/direct/")) {
      this.requests.push({ method: request.method, path: url.pathname, tenant: tenantHeader });
      this.uploads.push(await request.text());
      return Response.json({ ok: true });
    }
    if (url.pathname !== "/rpc") {
      this.requests.push({ method: request.method, path: url.pathname, tenant: tenantHeader });
      return new Response("Not found", { status: 404 });
    }
    return this.#rpc(request, tenantHeader);
  }

  async #rpc(request: Request, tenantHeader: string | undefined): Promise<Response> {
    const call = await readRpc(request, tenantHeader);
    const { id, meta, method, params, tenant } = call;
    this.requests.push({ method: request.method, params, path: "/rpc", rpcMethod: method, tenant });
    switch (method.replace(/^agent[_-]device\./, "")) {
      case "lease.allocate":
        return this.#allocate(id, params, tenant);
      case "lease.heartbeat":
        await this.onHeartbeat?.();
        return this.#heartbeat(id, params, tenant);
      case "lease.release":
        void untilAborted(request.signal).then(() => {
          this.hungUpReleases.push(String(params["leaseId"]));
        });
        await this.onRelease?.();
        request.signal.throwIfAborted();
        {
          const reply = await this.#release(request, id, params, tenant);
          this.releaseReplies.push(await reply.clone().text());
          return reply;
        }
      default:
        return this.#command(request, id, params, meta);
    }
  }

  async #allocate(
    id: unknown,
    params: Record<string, unknown>,
    tenant: string | undefined,
  ): Promise<Response> {
    if (this.#allocateGate !== undefined) await this.#allocateGate.promise;
    const raw = this.#allocateBody;
    this.#allocateBody = undefined;
    if (raw !== undefined) return new Response(raw, { status: 200 });
    const failure = this.#failAllocate;
    this.#failAllocate = undefined;
    if (failure !== undefined) return errorEnvelope(id, failure);
    const leaseId = String(params["leaseId"]);
    const address = addressOf(params);
    if (address !== undefined && this.#claimed(address)) {
      return errorEnvelope(id, {
        code: "DEVICE_IN_USE",
        message: "device is in use by another session",
      });
    }
    const scope = {
      clientId: params["clientId"],
      deviceKey: this.#replyDeviceKey ?? params["deviceKey"],
      leaseProvider: params["leaseProvider"],
      runId: params["runId"],
    };
    this.#replyDeviceKey = undefined;
    const edit = this.#replyEdit;
    this.#replyEdit = undefined;
    const picked = this.#replyDevice;
    this.#replyDevice = undefined;
    this.leases.set(leaseId, {
      address,
      ended: false,
      leaseId,
      scope,
      tenant,
      ttlMs: params["ttlMs"],
    });
    return envelope(id, {
      data: {
        ...(picked === "none" || address === undefined
          ? {}
          : { device: { id: address, name: `simlock-${address}`, ...picked } }),
        lease: { ...scope, ...edit, leaseId, tenantId: tenant, ttlMs: params["ttlMs"] },
      },
      ok: true,
    });
  }

  #heartbeat(id: unknown, params: Record<string, unknown>, tenant: string | undefined): Response {
    const failure = this.#failHeartbeat;
    this.#failHeartbeat = undefined;
    if (failure !== undefined) return errorEnvelope(id, failure);
    const leaseId = String(params["leaseId"]);
    const lease = this.leases.get(leaseId);
    if (lease === undefined || lease.tenant !== tenant) {
      const reason = this.#goneReasons.get(leaseId) ?? "LEASE_NOT_FOUND";
      return errorEnvelope(id, {
        code: "UNAUTHORIZED",
        details: { reason },
        message: reason.toLowerCase().replaceAll("_", " "),
      });
    }
    return envelope(id, { data: { lease: params }, ok: true });
  }

  #claimed(address: string): boolean {
    return (
      [...this.leases.values()].some((lease) => lease.address === address) ||
      [...this.#running].some((command) => command.address === address)
    );
  }

  // fallow-ignore-next-line complexity -- one fake mirroring agent-device's release checks in order.
  async #release(
    request: Request,
    id: unknown,
    params: Record<string, unknown>,
    tenant: string | undefined,
  ): Promise<Response> {
    const leaseId = String(params["leaseId"]);
    if (this.#hangRelease) {
      this.#hangRelease = false;
      await untilAborted(request.signal);
      this.abortedReleases.push(leaseId);
      throw new Error("aborted");
    }
    const failure = this.#failRelease;
    this.#failRelease = undefined;
    if (failure !== undefined) return errorEnvelope(id, failure);
    const raw = this.#releaseBody;
    this.#releaseBody = undefined;
    if (raw !== undefined) return new Response(raw, { status: 200 });
    if (tenant === undefined || !present(params["runId"])) return scopeRequired(id);
    const lease = this.leases.get(leaseId);
    if (lease === undefined) return envelope(id, { ok: true, released: false });
    if (!this.#anyTenantReleases && lease.tenant !== tenant) {
      return errorEnvelope(id, { code: "LEASE_NOT_FOUND", message: "lease not found" });
    }
    const keys = ["leaseProvider", "clientId", "deviceKey"] as const;
    if (keys.some((key) => present(lease.scope[key]) && !present(params[key]))) {
      return scopeRequired(id);
    }
    if (
      lease.scope.runId !== params["runId"] ||
      keys.some((key) => present(params[key]) && lease.scope[key] !== params[key])
    ) {
      return errorEnvelope(id, {
        code: "UNAUTHORIZED",
        details: { reason: "LEASE_SCOPE_MISMATCH" },
        message: "lease scope mismatch",
      });
    }
    this.leases.delete(lease.leaseId);
    const running = [...this.#running].filter((command) => command.leaseId === leaseId);
    if (running.length > 0 && this.#releaseWaitsForCommands) {
      const aborted = untilAborted(request.signal).then(() => {
        this.abortedReleases.push(leaseId);
        throw new Error("aborted");
      });
      await Promise.race([Promise.all(running.map((command) => command.ended)), aborted]);
    }
    return envelope(id, { ok: true, released: !lease.ended });
  }

  // fallow-ignore-next-line complexity -- one fake mirroring agent-device's command handling.
  async #command(
    request: Request,
    id: unknown,
    params: Record<string, unknown>,
    meta: Record<string, unknown>,
  ): Promise<Response> {
    const command = String(params["command"] ?? "");
    const leaseId = meta["leaseId"];
    if (this.#commandGate !== undefined) {
      const finish = gate();
      const running: RunningCommand = {
        address: typeof leaseId === "string" ? this.leases.get(leaseId)?.address : undefined,
        ended: finish.promise,
        leaseId: typeof leaseId === "string" ? leaseId : "",
      };
      this.#running.add(running);
      const aborted = new Promise<never>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => {
          this.abortedCommands.push(command);
          if (!this.#commandsOutliveRequests) reject(new Error("aborted"));
        });
      });
      try {
        await Promise.race([this.#commandGate.promise, aborted]);
      } finally {
        this.#running.delete(running);
        finish.open();
      }
    }
    const chunks = this.#streamChunks;
    this.#streamChunks = undefined;
    if (chunks !== undefined) {
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            controller.close();
          },
        }),
        { headers: { "content-type": "application/x-ndjson" } },
      );
    }
    const failure = this.#failCommand;
    this.#failCommand = undefined;
    if (failure !== undefined) return errorEnvelope(id, failure);
    const status = this.#failCommandStatus;
    this.#failCommandStatus = undefined;
    if (status !== undefined) return new Response(status.body, { status: status.status });
    const inventory = this.#devicesAnswer;
    if (command === "devices" && inventory !== undefined) {
      if ("body" in inventory) return new Response(inventory.body, { status: 200 });
      return envelope(id, { data: { devices: inventory.list }, ok: true });
    }
    if (command === "close" && typeof leaseId === "string") {
      const lease = this.leases.get(leaseId);
      if (lease !== undefined) lease.ended = true;
    }
    return envelope(id, { command, ok: true });
  }
}
