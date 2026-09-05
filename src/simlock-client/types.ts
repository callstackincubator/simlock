/**
 * Public types for `simlock/client` and `simlock/admin` (ADR 0003 §10). Every type here is
 * `z.infer`red from a contract schema (`src/contract/operations.ts`, `schemas.ts`, `pushes.ts`)
 * rather than hand-declared, so a schema change is a compile-time type change here too, never a
 * silent drift. Nothing in this file imports from `src/core`, `src/daemon`, or `src/drivers` --
 * see `no-core-leak.test.ts`, which asserts the compiled `.d.ts` for these two entry points
 * never mentions a core-private type name.
 */
import type { z } from "zod";

import type { OPERATIONS, OperationName, PUSH_SCHEMAS } from "../contract/index.js";
import type { leaseProgressSchema } from "../contract/schemas.js";

type OpInput<Name extends OperationName> = z.infer<(typeof OPERATIONS)[Name]["input"]>;
type OpOutput<Name extends OperationName> = z.infer<(typeof OPERATIONS)[Name]["output"]>;

// ---- agent-visible operations -------------------------------------------------------------

export type CatalogGetInput = OpInput<"catalog.get">;
export type CatalogGetOutput = OpOutput<"catalog.get">;
export type StatusGetOutput = OpOutput<"status.get">;
export type LeaseRequestInput = OpInput<"lease.request">;
/** `lease.request`'s output -- deliberately not named `LeaseRequestOutput` since it is the
 * thing every frontend actually calls a "grant" (device + lease + timing estimates). */
export type LeaseGrant = OpOutput<"lease.request">;
export type LeaseCancelInput = OpInput<"lease.cancel">;
export type LeaseCancelOutput = OpOutput<"lease.cancel">;
export type LeaseRenewInput = OpInput<"lease.renew">;
/** Also `lease.renew`'s output, and the element type of `lease.list`'s array -- one shape,
 * reused wherever the contract reuses `leaseRecordSchema`. */
export type LeaseRecord = OpOutput<"lease.renew">;
export type LeaseReleaseInput = OpInput<"lease.release">;
export type LeaseReleaseOutput = OpOutput<"lease.release">;
export type LeaseListOutput = OpOutput<"lease.list">;
export type DoctorRunInput = OpInput<"doctor.run">;
export type DoctorReport = OpOutput<"doctor.run">;
export type DriverPassthroughInput = OpInput<"driver.passthrough">;
/** The scoped command `simlock simctl` / `simlock adb` runs; see `passthroughCommandSchema`. */
export type PassthroughCommand = OpOutput<"driver.passthrough">;

// ---- admin-only operations ------------------------------------------------------------------

export type LeaseReleaseAllOutput = OpOutput<"lease.release-all">;
export type ListGetInput = OpInput<"list.get">;
export type ListGetOutput = OpOutput<"list.get">;
export type CleanupRunInput = OpInput<"cleanup.run">;
export type CleanupRunOutput = OpOutput<"cleanup.run">;
export type NukeRunInput = OpInput<"nuke.run">;
export type NukeReport = OpOutput<"nuke.run">;
export type SimlockConfig = OpOutput<"config.get">;
export type DaemonStopOutput = OpOutput<"daemon.stop">;
export type EventsReplayInput = OpInput<"events.replay">;
export type EventsReplayOutput = OpOutput<"events.replay">;
export type EventsSubscribeOutput = OpOutput<"events.subscribe">;
export type EventsUnsubscribeOutput = OpOutput<"events.unsubscribe">;
export type TokenCreateInput = OpInput<"token.create">;
export type TokenCreateOutput = OpOutput<"token.create">;
export type TokenListOutput = OpOutput<"token.list">;
export type TokenRevokeInput = OpInput<"token.revoke">;
export type TokenRevokeOutput = OpOutput<"token.revoke">;

// ---- pushes ---------------------------------------------------------------------------------

export type LeaseProgress = z.infer<typeof leaseProgressSchema>;
export type EventPush = z.infer<(typeof PUSH_SCHEMAS)["event"]>;

export interface LeaseLostPush {
  readonly leaseId: string;
  readonly deviceId: string;
  /** A server-reported reason (`"expired"`, `"explicit"`, `"closed"`, ...) or, when this
   * client's own connection died, the client-synthesized `"daemon-connection-lost"` (ADR
   * §10). Not a closed enum on the wire, so kept as `string` here rather than invented. */
  readonly reason: string;
}

export interface DeviceUnhealthyPush {
  readonly leaseId: string;
  readonly deviceId: string;
}

export interface DeviceRecoveredPush {
  readonly leaseId: string;
  readonly deviceId: string;
  readonly attempts: number;
}

// ---- connect options --------------------------------------------------------------------------

export interface RequestLeaseOptions {
  /** ADR §10's one stateful client behaviour -- see `client.ts`'s `#requestLeaseWithAbort` for
   * the four distinct behaviours this drives. */
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: LeaseProgress) => void;
}
