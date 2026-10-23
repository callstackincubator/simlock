import { isNewerVersion } from "../../../src/contract/version-order";
import type { WorkerView } from "./workers";

// why: the facts of a worker's update that every surface reads the same way: the version it runs,
// the latest the gateway knows, the update in flight and how many devices hold a lease.
export interface UpdateFacts {
  readonly version?: string;
  readonly latestVersion: string | null;
  readonly update: Exclude<WorkerView["update"], undefined>;
  readonly leased: number;
}

export function updateFactsOf(worker: WorkerView): UpdateFacts {
  return {
    latestVersion: worker.latestVersion ?? null,
    leased: (worker.devices ?? []).filter((device) => device.state === "leased").length,
    update: worker.update ?? null,
    ...(worker.version === undefined ? {} : { version: worker.version }),
  };
}

// why: the "newer" rule is the contract's (`isNewerVersion`); the console never compares itself.
export function isBehind(facts: UpdateFacts): boolean {
  return (
    facts.version !== undefined &&
    facts.latestVersion !== null &&
    isNewerVersion(facts.latestVersion, facts.version)
  );
}

export function versionLine(facts: UpdateFacts): string | undefined {
  if (facts.version === undefined) return undefined;
  const base = `simlock ${facts.version}`;
  return isBehind(facts) ? `${base} · ${facts.latestVersion} available` : base;
}
