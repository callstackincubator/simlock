import {
  RuntimeMissingError,
  SeedSettleFailedError,
  type SeedSettler,
  type VirtualSpec,
} from "../core/index.js";
import { parseOsConstraint } from "../contract/index.js";
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
    const spec = await seeds
      .resolveSeedSpec({
        model: input.model,
        platform: input.platform,
        ...(input.osVersion === undefined ? {} : { osVersion: input.osVersion }),
        ...(input.imageTag === undefined ? {} : { imageTag: input.imageTag }),
      })
      .catch((error: unknown) => {
        if (!(error instanceof RuntimeMissingError)) throw error;
        throw runtimeMissing(error, input.osVersion);
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

/**
 * why: `seed.make` never downloads, so the lease's "pass --allow-download" is no advice here; it names the command that installs the runtime (ADR 0090 §4).
 * A refusal no download could fix for an exact version or the default (below iOS 16, out of range, an image tag) keeps the lease's own words, because that command would fail for it.
 */
function runtimeMissing(error: RuntimeMissingError, osVersion: string | undefined): DispatchError {
  const name = error.platform === "ios" ? "iOS" : "Android";
  const asked = osVersion === undefined ? undefined : parseOsConstraint(osVersion);
  const exact = asked?.ok === true && asked.constraint.kind === "exact";
  const ranged = asked?.ok === true && !exact;
  const message = exact
    ? `${name} ${asked.constraint.version} is not installed; install it with simlock component install ${error.platform} ${asked.constraint.version}`
    : `no installed ${name} runtime fits ${osVersion ?? "the default"}; install one with simlock component install ${error.platform} and a version`;
  return new DispatchError(
    "RUNTIME_MISSING",
    error.downloadable || ranged ? message : error.message,
    {
      downloadable: error.downloadable,
      osVersion: error.osVersion,
      platform: error.platform,
    },
  );
}
