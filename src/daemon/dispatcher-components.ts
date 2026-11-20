import type { ComponentProgress } from "../contract/index.js";
import {
  BaselineInUseError,
  BaselineSaveFailedError,
  ComponentInUseError,
  effectiveAllowDownload,
  UnknownBaselineError,
  UnknownLeaseError,
  type ComponentInstallerProgress,
} from "../core/index.js";
import { DispatchError } from "./dispatch.js";
import { describeEnrollmentError } from "./dispatcher-devices.js";
import type { DispatcherOptions, Handler } from "./dispatcher-options.js";

export class ComponentHandlers {
  constructor(private readonly options: DispatcherOptions) {}

  readonly warmForget: Handler<"warm.forget"> = async (input) => {
    if (this.options.warmKinds === undefined)
      throw new DispatchError("INTERNAL", "The warm pool is unavailable");
    const forgotten = this.options.warmKinds.forget(input);
    return {
      forgotten: forgotten.map((spec) => ({
        platform: spec.platform,
        model: spec.model,
        osVersion: spec.osVersion,
        mode: spec.mode ?? "full",
        ...(spec.imageTag === undefined ? {} : { imageTag: spec.imageTag }),
        ...(spec.baseline === undefined ? {} : { baseline: spec.baseline.name }),
      })),
    };
  };

  readonly baselineSave: Handler<"baseline.save"> = async (input, session) => {
    if (this.options.baselines === undefined)
      throw new DispatchError("INTERNAL", "Baselines are unavailable");
    const lease = this.options.registry.snapshot.leases.find(
      (candidate) => candidate.id === input.leaseId,
    );
    if (lease === undefined) throw new UnknownLeaseError(input.leaseId);
    const held = this.options.registry.snapshot.devices.find(
      (candidate) => candidate.id === lease.deviceId,
    );
    if (held?.physical === true) {
      throw new DispatchError(
        "BAD_REQUEST",
        `lease ${lease.id} is on a physical device; only a simulator or emulator can be saved as a baseline`,
      );
    }
    try {
      return await this.options.baselines.save({
        leaseId: input.leaseId,
        name: input.name,
        ...(input.note === undefined ? {} : { note: input.note }),
        requesterId: session.principal,
      });
    } catch (error: unknown) {
      if (error instanceof BaselineSaveFailedError) {
        throw new DispatchError("BASELINE_SAVE_FAILED", error.message, {
          leaseId: error.leaseId,
          name: error.baselineName,
        });
      }
      throw error;
    }
  };

  readonly baselineList: Handler<"baseline.list"> = async () => {
    if (this.options.baselines === undefined)
      throw new DispatchError("INTERNAL", "Baselines are unavailable");
    return { baselines: [...(await this.options.baselines.list())] };
  };

  readonly baselineRemove: Handler<"baseline.remove"> = async (input, session) => {
    if (this.options.baselines === undefined)
      throw new DispatchError("INTERNAL", "Baselines are unavailable");
    if (input.workerId !== undefined) {
      throw new DispatchError(
        "BAD_REQUEST",
        "workerId names a gateway's worker, and this daemon is not a gateway; remove without --worker",
      );
    }
    try {
      const removed = await this.options.baselines.remove({
        name: input.name,
        requesterId: session.principal,
      });
      return {
        deletedDevices: [...removed.deletedDevices],
        name: removed.name,
        versions: [...removed.versions],
      };
    } catch (error: unknown) {
      if (error instanceof BaselineInUseError) {
        throw new DispatchError("BASELINE_IN_USE", error.message, {
          leaseId: error.leaseId,
          name: error.baselineName,
        });
      }
      if (error instanceof UnknownBaselineError) {
        throw new DispatchError("UNKNOWN_BASELINE", error.message, { name: error.baselineName });
      }
      throw describeEnrollmentError(error);
    }
  };

  readonly componentInstall: Handler<"component.install"> = async (input, session) => {
    if (!effectiveAllowDownload(this.options.config.downloads.policy, true)) {
      throw new DispatchError(
        "DOWNLOADS_DISABLED",
        'Downloads are disabled by configuration: downloads.policy is "never"',
        { policy: "never" },
      );
    }
    const onComponentProgress = session.onComponentProgress;
    const onStarted = session.onStarted;
    const result = await this.options.components.install({
      component: input.version,
      platform: input.platform,
      requesterId: session.principal,
      ...(onComponentProgress === undefined
        ? {}
        : { onProgress: (progress) => onComponentProgress(toWireProgress(progress)) }),
      ...(onStarted === undefined ? {} : { onAdmitted: onStarted }),
    });
    // why: No `stillNeeded` is passed, so `not-needed` cannot come back; a version is always present
    // for the two outcomes that can.
    if (result.outcome === "not-needed" || result.version === undefined) {
      throw new Error(`Internal: component install ended as ${result.outcome} with no version`);
    }
    return {
      component: input.version,
      outcome: result.outcome,
      platform: input.platform,
      version: result.version,
    };
  };

  readonly componentList: Handler<"component.list"> = async (input) => ({
    components: await this.options.components.list(input.platform),
  });

  readonly componentRemove: Handler<"component.remove"> = async (input, session) => {
    try {
      const result = await this.options.components.remove({
        platform: input.platform,
        requesterId: session.principal,
        version: input.version,
        ...(input.dryRun === undefined ? {} : { dryRun: input.dryRun }),
      });
      return { platform: input.platform, version: input.version, ...result };
    } catch (error: unknown) {
      if (error instanceof ComponentInUseError) {
        throw new DispatchError("COMPONENT_IN_USE", error.message, {
          devices: error.devices,
          foreignDevices: error.foreignDevices,
        });
      }
      throw error;
    }
  };
}

/**
 * why: The installer's progress in the contract's words: its percentage, already within 0..100,
 * becomes a fraction from 0 to 1, rounded to three decimals so that 1.1 percent is 0.011 and not
 * the 0.011000000000000001 a plain division gives. Only 100 percent becomes 1: 99.96 would round
 * up to it, and 1 is what an install says once it is complete. With none (the install has just
 * started, or the driver's was not a number) there is no fraction.
 */
function toWireProgress(progress: ComponentInstallerProgress): ComponentProgress {
  if (progress.stage === "waiting") return { stage: "waiting" };
  if (progress.percent === undefined) return { stage: "downloading" };
  const fraction = Math.round(progress.percent * 10) / 1000;
  return { fraction: progress.percent < 100 ? Math.min(fraction, 0.999) : 1, stage: "downloading" };
}
