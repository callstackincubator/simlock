import { expect } from "vitest";
import {
  Member,
  Rig,
  setUp,
  envelopeOf,
  hex,
  grantedOnGateway,
  fleetLeases,
} from "./test-gateway.js";

export const LEASE_HEADER = "x-agent-device-lease-id";

export const notYoursOnGateway = (n: number): string =>
  `refused: lease ${hex(n)} is not one of yours on this gateway`;

export function leased(n: number): Record<string, string> {
  return { [LEASE_HEADER]: hex(n) };
}

export function holderOf(rig: Rig, n: number): Member {
  const member = rig.members.find((candidate) => candidate.fake.leases.has(hex(n)));
  if (member === undefined) throw new Error(`no worker holds the agent-device lease ${hex(n)}`);
  return member;
}

// why: the gateway lists a lease only once its worker's next view reaches it, which can trail the grant.
export async function listedByGateway(rig: Rig, count: number): Promise<void> {
  await expect.poll(async () => (await fleetLeases(rig)).length).toBe(count);
}

// why: a worker with room for one lease each puts two leases on two workers.
export async function twoLeasesOnTwoWorkers(): Promise<Rig> {
  const rig = await setUp({
    workers: [
      { label: "w1", maxRunning: 1 },
      { label: "w2", maxRunning: 1 },
    ],
  });
  await grantedOnGateway(rig, 1);
  await grantedOnGateway(rig, 2);
  await listedByGateway(rig, 2);
  expect(holderOf(rig, 1)).not.toBe(holderOf(rig, 2));
  return rig;
}

export function addressOfLease(rig: Rig, n: number): string {
  const address = holderOf(rig, n).fake.leases.get(hex(n))?.address;
  expect(address).toBeDefined();
  return address as string;
}

export function pathsReceived(member: Member): string[] {
  return member.fake.requests.map((request) => request.path);
}

export async function listedNames(response: Response): Promise<string[]> {
  const answer = await envelopeOf(response);
  const data = answer.result?.["data"] as { devices?: { name?: string }[] } | undefined;
  expect(Array.isArray(data?.devices), "expected a devices list in result.data").toBe(true);
  return (data?.devices ?? []).map((device) => String(device.name)).sort();
}

export const picksTheDevice = "refused: simlock picks the device";
