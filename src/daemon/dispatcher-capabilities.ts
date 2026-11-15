import type { z } from "zod";

import { capabilityReason, type capabilitySchema } from "../contract/index.js";
import type { TimerHandle } from "../ports/index.js";
import { DispatchError } from "./dispatch.js";
import type { CapabilitySource, DispatcherOptions } from "./dispatcher-options.js";

const CAPABILITY_READ_BUDGET_MS = 1_000;

type CapabilityEntry = z.infer<typeof capabilitySchema>;

// why: a module can never make status.get fail or hang, which would cut the worker off from its gateway.
export async function readCapabilities(
  options: DispatcherOptions,
): Promise<CapabilityEntry[] | undefined> {
  const sources = options.capabilitySources;
  if (sources === undefined || sources.length === 0) return undefined;
  return Promise.all(sources.map((source) => readCapability(options, source)));
}

async function readCapability(
  options: DispatcherOptions,
  source: CapabilitySource,
): Promise<CapabilityEntry> {
  const unreadable: CapabilityEntry = {
    name: source.name,
    reason: capabilityReason(`could not read ${source.name}'s status`),
    state: "unavailable",
  };
  let timer: TimerHandle | undefined;
  const expired = new Promise<undefined>((resolve) => {
    timer = options.clock.setTimer(CAPABILITY_READ_BUDGET_MS, () => resolve(undefined));
  });
  try {
    const answer = await Promise.race([source.read().catch((): undefined => undefined), expired]);
    if (answer === undefined) return unreadable;
    if (answer.state === "available" || answer.state === "off") {
      return { name: source.name, state: answer.state };
    }
    if (answer.state !== "unavailable") {
      return { name: source.name, reason: "reported an invalid status", state: "unavailable" };
    }
    return {
      name: source.name,
      reason: capabilityReason(answer.reason ?? ""),
      state: "unavailable",
    };
  } finally {
    if (timer !== undefined) options.clock.cancel(timer);
  }
}

// why: a request that waits in the worker's queue is not checked again; the check runs once, before leasing.
export async function requireCapabilities(
  options: DispatcherOptions,
  requires: readonly string[] | undefined,
): Promise<void> {
  if (requires === undefined || requires.length === 0) return;
  const sources = options.capabilitySources ?? [];
  const states = await Promise.all(
    requires.map(async (name) => {
      const source = sources.find((candidate) => candidate.name === name);
      return source === undefined ? undefined : readCapability(options, source);
    }),
  );
  const missing = requires.filter((_name, index) => states[index]?.state !== "available");
  if (missing.length === 0) return;
  throw new DispatchError("CAPABILITY_MISSING", `This worker cannot serve ${missing.join(", ")}`, {
    capabilities: missing,
  });
}
