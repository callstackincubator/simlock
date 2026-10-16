import type { AbsentReason } from "./domain.js";
import type { Driver, PresentPhysical } from "./driver.js";

export type PhysicalRead =
  | { readonly present: true; readonly osVersion?: string }
  | { readonly present: false; readonly reason: AbsentReason };

export type LatestPresence =
  | { readonly present: true }
  | { readonly present: false; readonly reason: AbsentReason };

/** why: every presence read goes through this module, so the one place that remembers the last
 * answer per device is here; the worker view reports it as `presence` (ADR 0022). */
const latest = new Map<string, LatestPresence>();

export function latestPresence(driverDeviceId: string): LatestPresence | undefined {
  return latest.get(driverDeviceId);
}

function remember(answer: ReadonlyMap<string, PhysicalRead>): void {
  for (const [id, read] of answer) {
    latest.set(id, read.present ? { present: true } : { present: false, reason: read.reason });
  }
}

function reads(
  ids: readonly string[],
  entries: readonly PresentPhysical[],
): ReadonlyMap<string, PhysicalRead> {
  const answer = new Map<string, PhysicalRead>(
    ids.map((id) => [id, { present: false, reason: "not-present" }]),
  );
  for (const entry of entries) {
    if (!answer.has(entry.driverDeviceId)) continue;
    answer.set(
      entry.driverDeviceId,
      entry.present
        ? {
            present: true,
            ...(entry.osVersion === undefined ? {} : { osVersion: entry.osVersion }),
          }
        : { present: false, reason: entry.reason ?? "not-present" },
    );
  }
  return answer;
}

export async function readPhysicalPresenceDetail(
  driver: Pick<Driver, "listPresentPhysical">,
  ids: readonly string[],
): Promise<ReadonlyMap<string, PhysicalRead>> {
  const answer = reads(ids, await driver.listPresentPhysical(ids));
  remember(answer);
  return answer;
}

export async function readPhysicalPresence(
  driver: Pick<Driver, "listPresentPhysical">,
  ids: readonly string[],
): Promise<ReadonlyMap<string, boolean>> {
  const answer = reads(ids, await driver.listPresentPhysical(ids));
  remember(answer);
  return new Map([...answer].map(([id, read]) => [id, read.present]));
}
