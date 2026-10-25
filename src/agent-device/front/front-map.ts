import type { Identity } from "../../auth/index.js";
import type { Clock } from "../../ports/index.js";

const MAX_PRINCIPALS_PER_REFRESH = 100;

interface DeviceFacts {
  readonly platform?: "ios" | "android";
  readonly model?: string;
  readonly name?: string;
  readonly target?: string;
  readonly deviceKey?: string;
  // why: an adopted entry was rebuilt after a gateway restart and has no device key until a call names one.
  readonly adopted?: boolean;
  // why: agent-device's device list was read for this lease's name, so a device it did not name is not asked about again.
  readonly named?: boolean;
}

export interface FrontMapEntry extends DeviceFacts {
  readonly identity: Identity;
  readonly address: string;
  readonly ttlMs: number;
  readonly deadline: number;
}

export type EndedBy = "agent" | "simlock";

export interface HeldView extends DeviceFacts {
  readonly identity: Identity;
  readonly address: string;
  readonly ttlMs: number;
  readonly endedAt?: number;
  readonly endedBy?: EndedBy;
}

export interface ListedLease {
  readonly id: string;
  readonly ttlDeadline: number;
}

interface Held extends Omit<DeviceFacts, "deviceKey" | "name" | "named"> {
  deviceKey?: string;
  name?: string;
  named?: boolean;
  readonly identity: Identity;
  readonly address: string;
  ttlMs: number;
  deadline: number;
  endedAt?: number;
  endedBy?: EndedBy;
  releasing: boolean;
}

export class FrontMap {
  readonly #held = new Map<string, Held>();
  readonly #waiting = new Map<string, number>();

  startWaiting(leaseId: string): void {
    this.#waiting.set(leaseId, (this.#waiting.get(leaseId) ?? 0) + 1);
  }

  stopWaiting(leaseId: string): void {
    const left = (this.#waiting.get(leaseId) ?? 0) - 1;
    if (left > 0) this.#waiting.set(leaseId, left);
    else this.#waiting.delete(leaseId);
  }

  waitingIds(): readonly string[] {
    return [...this.#waiting.keys()];
  }

  constructor(readonly clock: Clock) {}

  add(leaseId: string, entry: FrontMapEntry): void {
    this.#prune();
    this.#held.set(leaseId, { ...entry, releasing: false });
  }

  get(leaseId: string): HeldView | undefined {
    this.#prune();
    return this.#held.get(leaseId);
  }

  liveOf(requesterId: string): readonly (HeldView & { readonly leaseId: string })[] {
    this.#prune();
    return [...this.#held]
      .filter(([, held]) => held.identity.principal === requesterId && held.endedAt === undefined)
      .map(([leaseId, held]) => ({ ...held, leaseId }));
  }

  setDeviceKey(leaseId: string, deviceKey: string): void {
    const held = this.#held.get(leaseId);
    if (held !== undefined && held.deviceKey === undefined) held.deviceKey = deviceKey;
  }

  setName(leaseId: string, name: string | undefined): void {
    const held = this.#held.get(leaseId);
    if (held === undefined) return;
    held.named = true;
    if (name !== undefined) held.name = name;
  }

  setTtl(leaseId: string, ttlMs: number): void {
    const held = this.#held.get(leaseId);
    if (held !== undefined) held.ttlMs = ttlMs;
  }

  beginRelease(leaseId: string): void {
    const held = this.#held.get(leaseId);
    if (held !== undefined) held.releasing = true;
  }

  cancelRelease(leaseId: string): void {
    const held = this.#held.get(leaseId);
    if (held !== undefined) held.releasing = false;
  }

  markEnded(leaseId: string, by: EndedBy = "simlock"): void {
    const held = this.#held.get(leaseId);
    if (held === undefined || held.endedAt !== undefined) return;
    if (by === "simlock" && held.releasing) return;
    held.endedAt = this.clock.now();
    held.endedBy = by;
    held.releasing = false;
  }

  async refresh(
    list: (identity: Identity) => Promise<readonly ListedLease[]>,
    stillHeld: (leaseId: string) => boolean = () => false,
  ): Promise<void> {
    this.#prune();
    const now = this.clock.now();
    const byPrincipal = new Map<string, { identity: Identity; oldest: number; ids: string[] }>();
    for (const [id, held] of this.#held) {
      if (held.endedAt !== undefined || held.deadline > now) continue;
      const group = byPrincipal.get(held.identity.principal);
      if (group === undefined) {
        byPrincipal.set(held.identity.principal, {
          identity: held.identity,
          ids: [id],
          oldest: held.deadline,
        });
      } else {
        group.ids.push(id);
        group.oldest = Math.min(group.oldest, held.deadline);
      }
    }
    const groups = [...byPrincipal.values()]
      .sort((a, b) => a.oldest - b.oldest)
      .slice(0, MAX_PRINCIPALS_PER_REFRESH);
    await Promise.all(
      groups.map(async (group) => {
        let listed: readonly ListedLease[];
        try {
          listed = await list(group.identity);
        } catch {
          return;
        }
        for (const id of group.ids) {
          const held = this.#held.get(id);
          if (held === undefined) continue;
          const found = listed.find((lease) => lease.id === id);
          if (found === undefined) {
            if (!stillHeld(id)) this.markEnded(id);
          } else held.deadline = found.ttlDeadline;
        }
      }),
    );
  }

  #prune(): void {
    const now = this.clock.now();
    for (const [id, held] of this.#held) {
      if (held.endedAt !== undefined && now - held.endedAt >= held.ttlMs) this.#held.delete(id);
    }
  }
}
