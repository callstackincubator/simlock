import { SeedSettleFailedError, type SeedSettler, type VirtualSpec } from "../core/index.js";
import { DispatchError, type SeedKind } from "./dispatch.js";
import type { DispatcherOptions, Handler } from "./dispatcher-options.js";

/** why: what `seed.make` needs of the worker: the lease's resolution of a kind, and the settler that makes and settles its seed (ADR 0090 §4). */
export interface SeedMaking {
  readonly settler: Pick<SeedSettler, "settle">;
  resolveSeedSpec(request: {
    readonly platform: "ios" | "android";
    readonly model: string;
    readonly osVersion?: string;
    readonly imageTag?: string;
  }): Promise<VirtualSpec>;
}

export class SeedHandlers {
  constructor(private readonly options: DispatcherOptions) {}

  readonly seedMake: Handler<"seed.make"> = async (input, session) => {
    const { seeds } = this.options;
    if (seeds === undefined) throw new DispatchError("INTERNAL", "Seeds are unavailable");
    const spec = await seeds.resolveSeedSpec({
      model: input.model,
      platform: input.platform,
      ...(input.osVersion === undefined ? {} : { osVersion: input.osVersion }),
      ...(input.imageTag === undefined ? {} : { imageTag: input.imageTag }),
    });
    const kind: SeedKind = {
      model: spec.model,
      osVersion: spec.osVersion,
      platform: spec.platform,
      ...(spec.imageTag === undefined ? {} : { imageTag: spec.imageTag }),
    };
    try {
      const result = await seeds.settler.settle(spec, {
        onProgress: (progress) => session.onSeedProgress?.(kind, progress),
      });
      return { ...kind, ...result };
    } catch (error: unknown) {
      if (error instanceof SeedSettleFailedError) {
        throw new DispatchError("SEED_SETTLE_FAILED", error.message, {
          model: error.model,
          platform: error.platform,
          reason: error.reason,
        });
      }
      throw error;
    }
  };
}
