import type { EventBus } from "../bus/index.js";
import type { Clock, Logger } from "../ports/index.js";
import type { Config } from "./config.js";
import type { DeviceOperationClaims } from "./device-operation-claims.js";
import type { DeviceState, Platform } from "./domain.js";
import type {
  Driver,
  DriverDevice,
  DriverRejection,
  DriverRejectionReason,
  DriverSource,
  PrerequisiteCheck,
} from "./driver.js";
import type { CapacityReader, LeaseExpirer, WarmPoolReader } from "./core-ports.js";
import type { Registry } from "./registry.js";
import type { SerializedDecision } from "./serialized-decision.js";
import type { StartupRead } from "./startup-read.js";

export type DoctorFinding =
  | {
      readonly kind: "registry-device-missing";
      readonly deviceId: string;
      readonly platform: Platform;
    }
  | { readonly kind: "orphan-device"; readonly device: DriverDevice; readonly platform: Platform }
  | { readonly kind: "orphan-process"; readonly device: DriverDevice; readonly platform: Platform }
  | { readonly kind: "expired-live-lease"; readonly leaseId: string; readonly deviceId: string }
  | {
      readonly kind: "foreign-state-change";
      readonly deviceId: string;
      readonly platform: Platform;
      readonly expected: "running" | "stopped";
      readonly observed: "running" | "stopped";
    }
  | {
      readonly kind: "foreign-provenance-change";
      readonly deviceId: string;
      readonly platform: Platform;
      readonly detail: ProvenanceDrift;
    }
  | {
      readonly kind: "driver-unavailable";
      readonly platform: Platform;
      readonly reason: DriverRejectionReason;
      readonly detail: string;
    }
  | {
      readonly kind: "legacy-device";
      readonly deviceId: string;
      readonly platform: Platform;
      readonly device: DriverDevice;
      readonly path?: string;
    }
  | {
      readonly kind: "stalled-transition";
      readonly deviceId: string;
      readonly platform: Platform;
      readonly state: "provisioning" | "reclaiming";
      readonly enteredAt: number;
      readonly ageMs: number;
      readonly thresholdMs: number;
    }
  | {
      readonly kind: "driver-advisory";
      readonly platform: Platform;
      readonly code: string;
      readonly message: string;
    }
  | {
      readonly kind: "prerequisite-missing";
      readonly platform: Platform;
      readonly prerequisite: string;
      readonly message: string;
      readonly remedy: string;
    }
  | {
      /**
       * why: the worker's login service names a Node or `main.js` that is gone. Like
       * `driver-advisory` it is not drift: `--fix` never acts on it, and `doctor.reconciled` does not carry it.
       */
      readonly kind: "service-broken";
      readonly manager: "launchd" | "systemd" | "task-scheduler";
      readonly name: string;
      readonly missing: readonly string[];
      readonly remedy: string;
    }
  | {
      readonly kind: "warm-pool-target-unreachable";
      readonly platform?: Platform;
      readonly target: string;
      readonly reason: "runtime-missing" | "unknown-model" | "mode-unavailable" | "over-limit";
      readonly message: string;
      readonly remedy: string;
    }
  | {
      readonly kind: "module-unavailable";
      readonly module: string;
      readonly message: string;
      readonly remedy: string;
    };

/**
 * why: the service manager's answer for this role's service, injected so the core checks no path
 * itself; `check` returns the paths the service names that are gone, none when whole or absent.
 */
export interface ServiceCheck {
  readonly manager: "launchd" | "systemd" | "task-scheduler";
  readonly name: string;
  readonly check: () => Promise<readonly string[]>;
}

export type OptionalModuleFinding = Extract<DoctorFinding, { readonly kind: "module-unavailable" }>;

export type ProvenanceDrift = "erased" | "mark-mismatch" | "durable-mark-missing";

export type OrphanDeviceFinding = Extract<DoctorFinding, { readonly kind: "orphan-device" }>;

export interface DoctorReport {
  readonly findings: readonly DoctorFinding[];
  readonly sources: readonly DoctorSource[];
}

export interface DoctorSource extends Omit<DriverSource, "id"> {
  readonly platform: Platform;
  readonly baselineName?: string;
  readonly baselineVersion?: number;
}

/** why: the baselines the worker holds name their sources and are checked for staleness before a report. */
export interface DoctorBaselines {
  checkStale(): Promise<void>;
  nameSources(sources: readonly DriverSource[]): readonly (DriverSource & {
    readonly baselineName?: string;
    readonly baselineVersion?: number;
  })[];
}

export interface DoctorQuarantine {
  enterFromStalledTransition(deviceId: string, findingState: DeviceState): Promise<boolean>;
}

export type DoctorConfig = Pick<Config, "stalledTransition" | "warmPool"> & {
  readonly android: Pick<Config["android"], "virtualDevices">;
  /** why: `modes` is the list a `mode-unavailable` finding names (ADR 0082 §2). */
  readonly ios: Pick<Config["ios"], "modes" | "virtualDevices">;
};

export interface DoctorOptions {
  readonly clock: Clock;
  readonly config: DoctorConfig;
  /**
   * why: The decision section every registry write of this daemon is made in. A write made outside it
   * can land on top of a concurrent one that read the registry before it, and undo it.
   */
  readonly baselines?: DoctorBaselines;
  readonly decisions: Pick<SerializedDecision, "run">;
  readonly drivers: readonly Driver[];
  readonly eventBus: EventBus;
  readonly leaseExpirer?: LeaseExpirer;
  readonly quarantine?: DoctorQuarantine;
  readonly claims?: Pick<DeviceOperationClaims, "isClaimed">;
  readonly driverRejections?: readonly DriverRejection[];
  readonly logger?: Logger;
  readonly optionalModules?: () => readonly OptionalModuleFinding[];
  readonly warmPool?: {
    readonly figures: WarmPoolReader["figures"];
    readonly runningCapacity: () => CapacityReader["runningCapacity"];
  };
  readonly prerequisiteChecks?: readonly PrerequisiteCheck[];
  readonly serviceCheck?: ServiceCheck;
  readonly runningPlatforms?: () => readonly Platform[];
  readonly registry: Registry;
}

export interface DoctorReconcileOptions {
  readonly fix?: boolean;
  readonly read?: StartupRead;
  /**
   * why: deliberately not part of `fix`: someone already running `doctor --fix` unattended in
   * CI must not acquire a destructive behaviour by upgrading (ADR 0001, decision 6).
   */
  readonly purgeOrphans?: boolean;
  readonly prerequisites?: boolean;
}

export function key(platform: string, deviceId: string): string {
  return `${platform}:${deviceId}`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
