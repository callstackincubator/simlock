import type { SeedSettler, VirtualSpec } from "../core/index.js";
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

  readonly seedMake: Handler<"seed.make"> = async (input) => ({
    model: input.model,
    outcome: "already-settled",
    platform: input.platform,
    osVersion: "",
    sourceId: "",
  });
}
