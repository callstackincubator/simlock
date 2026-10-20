import type { z } from "zod";

import type { OPERATIONS } from "../../contract/index.js";
import { buildHttpSession } from "../../http/dispatcher-session.js";
import { mapError } from "../../http/errors.js";
import type { Identity } from "../../auth/index.js";
import type { Clock } from "../../ports/index.js";
import {
  frontReply,
  failure,
  notAvailable,
  refusal,
  workerUnreachable,
  type FrontReply,
} from "../shared/replies.js";
import { validDeviceKey } from "../shared/release-scope.js";
import { leaseCallFields, leaseIdOf, replyData, type RpcRead } from "../shared/rpc.js";
import { addressField, asRecord } from "../shared/selectors.js";
import {
  ALLOCATE_SCOPE_KEYS,
  REPLY_SCOPE_KEYS,
  exchange,
  leaseCall,
  listLeases,
  releaseAgentDevice,
  releaseSimlock,
  relay,
  scopeOf,
  unreachableReply,
  type FrontContext,
} from "./context.js";
import { chosenTtl } from "./ttl.js";

type Grant = z.infer<(typeof OPERATIONS)["lease.request"]["output"]>;

const NO_CEILING = "agent-device reported no lease ceiling for this lease";
const QUEUE_WAIT_MS = 330_000;
const CANCEL_RETRY_MS = 1_000;
const LEASE_GONE = new Set(["LEASE_NOT_FOUND", "LEASE_EXPIRED", "LEASE_REVOKED"]);
const CLASS_OF_TARGET: Record<string, "phone" | "tv" | "desktop"> = {
  desktop: "desktop",
  mobile: "phone",
  tv: "tv",
};

const present = (value: unknown): boolean => value !== undefined && value !== null;

interface Plan {
  readonly leaseId: string;
  readonly platform: "ios" | "android";
  readonly model?: string;
  readonly class?: "phone" | "tv" | "desktop";
  readonly ttlMs?: number;
}

// why: connect proxy names the backend that rents the platform (ios-instance, android-instance) on every allocate; any other backend is a different kind of device.
const BACKEND_OF_PLATFORM: Record<string, string> = {
  android: "android-instance",
  ios: "ios-instance",
};

function foreignBackend(params: Record<string, unknown>): boolean {
  const backend = params["backend"];
  if (!present(backend)) return false;
  const platform = params["platform"];
  return typeof platform !== "string" || BACKEND_OF_PLATFORM[platform] !== backend;
}

function notPlain(params: Record<string, unknown>): boolean {
  const provider = params["leaseProvider"];
  return (
    foreignBackend(params) ||
    params["retainOnClose"] === true ||
    (present(provider) && provider !== "proxy") ||
    Object.entries(params).some(
      ([key, value]) => present(value) && (key.startsWith("provider") || key.startsWith("aws")),
    )
  );
}

function deviceRefusal(fields: ReturnType<typeof leaseCallFields>): FrontReply | undefined {
  if (!present(fields.platform)) return refusal("refused: name --platform ios or android");
  return undefined;
}

function refusalFor(params: Record<string, unknown>): FrontReply | undefined {
  const fields = leaseCallFields(params);
  const ttl = fields.ttlMs;
  if (leaseIdOf(fields.leaseId) === undefined) {
    return refusal("refused: this agent-device is too old for simlock; upgrade it");
  }
  if (notPlain(params)) return refusal("refused: simlock leases only plain devices");
  const device = deviceRefusal(fields);
  if (device !== undefined) return device;
  if (present(ttl) && !(typeof ttl === "number" && Number.isFinite(ttl) && ttl > 0)) {
    return refusal("refused: ttlMs must be a positive number of milliseconds");
  }
  return undefined;
}

function holderReply(holder: Awaited<ReturnType<FrontContext["link"]["status"]>>): FrontReply {
  if (holder.state === "unreachable") return workerUnreachable();
  return notAvailable(holder.state === "unavailable" ? holder.reason : NO_CEILING);
}

function planOf(params: Record<string, unknown>, cap: number | undefined): Plan {
  const fields = leaseCallFields(params);
  const device =
    typeof fields.device === "string" && fields.device !== "" ? fields.device : undefined;
  const klass = typeof fields.target === "string" ? CLASS_OF_TARGET[fields.target] : undefined;
  const ttlMs = chosenTtl(fields.ttlMs, cap);
  return {
    leaseId: fields.leaseId as string,
    platform: fields.platform as "ios" | "android",
    ...(device === undefined ? (klass === undefined ? {} : { class: klass }) : { model: device }),
    ...(ttlMs === undefined ? {} : { ttlMs }),
  };
}

function pause(clock: Clock, ms: number, wakeOn: (wake: () => void) => void): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = clock.setTimer(ms, resolve);
    wakeOn(() => {
      clock.cancel(timer);
      resolve();
    });
  });
}

type LeaseOutcome =
  | { readonly kind: "granted"; readonly grant: Grant }
  | { readonly kind: "failed"; readonly reply: FrontReply }
  | { readonly kind: "gone" };

// why: a request parked while the daemon starts cannot be called back, so wait on a read that parks at the same gate and give up if the CLI leaves, or a CLI that left would still be admitted.
async function stillWaiting(
  context: FrontContext,
  identity: Identity,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return false;
  const gone = new Promise<false>((resolve) => {
    signal.addEventListener("abort", () => resolve(false), { once: true });
  });
  const ready = context.dispatch("lease.list", {}, buildHttpSession(identity)).then(
    () => true,
    () => true,
  );
  return Promise.race([ready, gone]);
}

function requiresOf(context: FrontContext): { readonly requires?: string[] } {
  const required = context.link.leaseRequires ?? [];
  return required.length === 0 ? {} : { requires: [...required] };
}

async function requestLease(
  context: FrontContext,
  identity: Identity,
  plan: Plan,
  signal: AbortSignal,
): Promise<LeaseOutcome> {
  if (!(await stillWaiting(context, identity, signal))) return { kind: "gone" };
  let admitted = false;
  let aborted = signal.aborted;
  let settled = false;
  let cancelling = false;
  let wakeCancel: (() => void) | undefined;
  const session = buildHttpSession(identity);
  const cancelUntilGone = async (): Promise<void> => {
    const until = context.clock.now() + QUEUE_WAIT_MS;
    while (!settled && context.clock.now() < until) {
      try {
        const { result } = await context.dispatch(
          "lease.cancel",
          { requesterId: plan.leaseId },
          session,
        );
        if (result !== "not-cancellable") return;
      } catch {
        return;
      }
      await pause(context.clock, CANCEL_RETRY_MS, (wake) => {
        wakeCancel = wake;
      });
    }
  };
  const startCancel = (): void => {
    if (cancelling) return;
    cancelling = true;
    void cancelUntilGone();
  };
  const onAbort = (): void => {
    aborted = true;
    if (admitted) startCancel();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  context.map.startWaiting(plan.leaseId);
  context.link.asked?.(plan.leaseId);
  try {
    const grant = await context.dispatch(
      "lease.request",
      {
        leaseId: plan.leaseId,
        platform: plan.platform,
        requesterId: plan.leaseId,
        timeoutMs: QUEUE_WAIT_MS,
        ...(plan.model === undefined ? {} : { model: plan.model }),
        ...(plan.class === undefined ? {} : { class: plan.class }),
        ...(plan.ttlMs === undefined ? {} : { ttlMs: plan.ttlMs }),
        ...requiresOf(context),
      },
      buildHttpSession(identity, {
        onRequestAdmitted: () => {
          admitted = true;
          if (aborted) startCancel();
        },
      }),
    );
    return { grant, kind: "granted" };
  } catch (error: unknown) {
    const mapped = mapError(error);
    return {
      kind: "failed",
      reply:
        mapped.code === "QUEUE_TIMEOUT"
          ? failure("timed out waiting for a device; nothing was leased", 504)
          : refusal(`refused by simlock: ${mapped.message}`),
    };
  } finally {
    settled = true;
    context.map.stopWaiting(plan.leaseId);
    wakeCancel?.();
    signal.removeEventListener("abort", onAbort);
  }
}

function forwardedBody(
  call: RpcRead & { kind: "request" },
  plan: Plan,
  address: string,
  ceiling: number,
) {
  const { device: _device, deviceKey: _deviceKey, target: _target, ...rest } = call.params;
  return {
    ...call.body,
    params: {
      ...rest,
      ttlMs: ceiling,
      [addressField(plan.platform)]: address,
    },
  };
}

export interface AllocateArguments {
  readonly request: Request;
  readonly identity: Identity;
  readonly call: RpcRead & { readonly kind: "request" };
}

interface Granted {
  readonly request: Request;
  readonly identity: Identity;
  readonly call: RpcRead & { readonly kind: "request" };
  readonly plan: Plan;
  readonly grant: Grant;
  readonly address: string;
}

export async function allocate(
  context: FrontContext,
  { request, identity, call }: AllocateArguments,
): Promise<Response | undefined> {
  const refused = refusalFor(call.params);
  if (refused !== undefined) return frontReply(refused, call);
  const plan = planOf(call.params, context.leaseTtlCapMs);
  await context.map.refresh((who) => listLeases(context, who));
  if (request.signal.aborted) return undefined;
  const outcome = await requestLease(context, identity, plan, request.signal);
  if (outcome.kind === "gone") return undefined;
  if (outcome.kind === "failed") return frontReply(outcome.reply, call);
  const { grant } = outcome;
  const address = grant.device.address;
  if (request.signal.aborted || address === undefined || address === "") {
    await releaseSimlock(context, identity, plan.leaseId);
    return request.signal.aborted
      ? undefined
      : frontReply(failure("simlock granted a device with no address; nothing was leased"), call);
  }
  const holder = await context.link.status(plan.leaseId, identity);
  if (holder.state !== "running" || holder.leaseMaxTtlMs === undefined) {
    await releaseSimlock(context, identity, plan.leaseId);
    return frontReply(holderReply(holder), call);
  }
  const forwarded = new Request(request.url, {
    body: JSON.stringify(forwardedBody(call, plan, address, holder.leaseMaxTtlMs)),
    headers: leaseCall(request, "agent_device.lease.allocate", {}, null).headers,
    method: "POST",
  });
  const reply = await exchange(context, forwarded, identity, "allocate", plan.leaseId);
  const made = { address, call, grant, identity, plan, request };
  if (reply.reading.kind === "success") return keepOrRelease(context, made, reply, reply.reading);
  if (reply.reading.kind === "error") {
    await releaseSimlock(context, identity, plan.leaseId);
    return relay(reply);
  }
  await settleNoReply(context, made);
  return unreachableReply(reply, call, "agent-device did not answer the allocate");
}

async function keepOrRelease(
  context: FrontContext,
  { request, identity, plan, grant, address }: Granted,
  reply: Parameters<typeof relay>[0],
  reading: { readonly result: Record<string, unknown> },
): Promise<Response | undefined> {
  if (!request.signal.aborted) {
    context.map.add(plan.leaseId, {
      address,
      deadline: grant.lease.ttlDeadline,
      identity,
      model: grant.device.spec.model,
      platform: plan.platform,
      ttlMs: grant.lease.ttlMs,
      ...replyFacts(reading.result),
    });
    return relay(reply);
  }
  const lease = replyData(reading.result)?.["lease"];
  const named =
    typeof lease === "object" && lease !== null ? (lease as Record<string, unknown>) : {};
  const ended = await releaseAgentDevice(
    context,
    request,
    identity,
    plan.leaseId,
    scopeOf(named, REPLY_SCOPE_KEYS),
  );
  if (ended.reading.kind === "success") await releaseSimlock(context, identity, plan.leaseId);
  return undefined;
}

async function settleNoReply(
  context: FrontContext,
  { request, identity, call, plan }: Granted,
): Promise<void> {
  const ended = await releaseAgentDevice(
    context,
    request,
    identity,
    plan.leaseId,
    scopeOf(call.params, ALLOCATE_SCOPE_KEYS),
  );
  const holds =
    ended.reading.kind === "error" &&
    (ended.reading.code === undefined || !LEASE_GONE.has(ended.reading.code));
  if (!holds) await releaseSimlock(context, identity, plan.leaseId);
}

function replyFacts(result: Record<string, unknown>) {
  const data = replyData(result);
  const device = asRecord(data?.["device"]);
  const deviceKey = asRecord(data?.["lease"])?.["deviceKey"];
  return {
    ...(device === undefined ? {} : { target: stringOr(device["target"], "mobile") }),
    ...(typeof device?.["name"] === "string" ? { name: device["name"] } : {}),
    ...(validDeviceKey(deviceKey) ? { deviceKey } : {}),
  };
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}
