import type { EventBus } from "../bus/index.js";
import type { Clock, Filesystem, TimerHandle } from "../ports/index.js";
import type { Config } from "./config.js";
import type { CleanupActionExecutor } from "./cleanup-executor.js";
import { automaticCleanupRules, manualCleanupRules } from "./cleanup/rules.js";
import type { CleanupRule, Proposal, RegistryView } from "./cleanup/types.js";
import type { Registry } from "./registry.js";

export interface CleanupReaperOptions {
  readonly clock: Clock;
  readonly config: Config;
  readonly eventBus: EventBus;
  readonly filesystem: Filesystem;
  readonly executor?: CleanupActionExecutor;
  /** @deprecated Transitional compatibility while daemon wiring is migrated. */
  readonly leaseEngine?: { executeCleanup(proposal: Proposal): Promise<boolean> };
  readonly registry: Registry;
  readonly rules?: readonly CleanupRule[];
  readonly diskPath?: string;
  readonly tickMs?: number;
}

export interface CleanupRunOptions {
  readonly dryRun?: boolean;
  readonly rule?: string;
}

/**
 * Reconciles pure cleanup proposals against current registry safety invariants.
 */
export class CleanupReaper {
  readonly #automaticRules: readonly CleanupRule[];
  readonly #manualRules: readonly CleanupRule[];
  readonly #unsubscribe: readonly (() => void)[];
  #followUpRequested = false;
  #running: Promise<readonly Proposal[]> | undefined;
  #tickTimer: TimerHandle | undefined;
  #disposed = false;

  constructor(private readonly options: CleanupReaperOptions) {
    if (options.executor === undefined && options.leaseEngine === undefined) {
      throw new Error("CleanupReaper requires an executor");
    }
    this.#automaticRules = options.rules ?? automaticCleanupRules;
    this.#manualRules = manualCleanupRules;
    this.#unsubscribe = [
      options.eventBus.subscribe("lease.released", () => this.#trigger()),
      options.eventBus.subscribe("daemon.started", () => this.#trigger()),
      options.eventBus.subscribe("disk.pressure-detected", () => this.#trigger()),
    ];
    this.#armTick();
  }

  get manualRules(): readonly CleanupRule[] {
    return this.#manualRules;
  }

  async run({ dryRun = false, rule }: CleanupRunOptions = {}): Promise<readonly Proposal[]> {
    if (!dryRun && rule === undefined) {
      return this.#scheduleRun();
    }

    return this.#runOnce(rule === undefined ? { dryRun } : { dryRun, rule });
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    for (const unsubscribe of this.#unsubscribe) {
      unsubscribe();
    }
    if (this.#tickTimer !== undefined) {
      this.options.clock.cancel(this.#tickTimer);
      this.#tickTimer = undefined;
    }
  }

  async #runOnce({ dryRun = false, rule }: CleanupRunOptions = {}): Promise<readonly Proposal[]> {
    const view = await this.#view();
    const proposals = filterProposals(this.#rulesFor(rule), view);
    if (dryRun) {
      return proposals;
    }

    for (const proposal of proposals) {
      await this.#executor().execute(proposal);
    }

    return proposals;
  }

  #trigger(): void {
    if (this.#disposed) {
      return;
    }
    void this.#scheduleRun().catch(() => undefined);
  }

  #executor(): CleanupActionExecutor {
    if (this.options.executor !== undefined) return this.options.executor;
    const legacy = this.options.leaseEngine;
    if (legacy === undefined) throw new Error("CleanupReaper requires an executor");
    return {
      execute: async (proposal) => {
        const executed = await legacy.executeCleanup(proposal);
        if (executed) {
          this.options.eventBus.emit(
            "cleanup.executed",
            {
              action: proposal.action,
              reason: proposal.reason,
              ruleName: proposal.rule,
              target: proposal.target,
            },
            "cleanup-reaper",
          );
        }
        return executed;
      },
    };
  }

  #scheduleRun(): Promise<readonly Proposal[]> {
    if (this.#running !== undefined) {
      this.#followUpRequested = true;
      return this.#running;
    }

    const running = this.#runScheduled();
    this.#running = running;
    void running.then(
      () => {
        if (this.#running === running) {
          this.#running = undefined;
        }
      },
      () => {
        if (this.#running === running) {
          this.#running = undefined;
        }
      },
    );
    return running;
  }

  async #runScheduled(): Promise<readonly Proposal[]> {
    let proposals: readonly Proposal[] = [];
    do {
      this.#followUpRequested = false;
      proposals = await this.#runOnce();
    } while (this.#followUpRequested);
    return proposals;
  }

  #armTick(): void {
    if (this.#disposed) {
      return;
    }
    this.#tickTimer = this.options.clock.setTimer(this.options.tickMs ?? 60_000, () => {
      this.#tickTimer = undefined;
      void this.#scheduleRun().then(
        () => this.#armTick(),
        () => this.#armTick(),
      );
    });
  }

  #rulesFor(name: string | undefined): readonly CleanupRule[] {
    if (name === undefined) {
      return this.#automaticRules;
    }

    return this.#manualRules.filter((rule) => rule.name === name);
  }

  async #view(): Promise<RegistryView> {
    const snapshot = this.options.registry.snapshot;
    return {
      config: this.options.config,
      devices: snapshot.devices,
      diskFreeBytes: await this.options.filesystem.diskFree(this.options.diskPath ?? "."),
      leases: snapshot.leases,
      now: this.options.clock.now(),
    };
  }
}

function filterProposals(rules: readonly CleanupRule[], view: RegistryView): readonly Proposal[] {
  const deduped = dedupe(rules.flatMap((rule) => rule.evaluate(view)));
  return deduped.filter((proposal) => isSafeProposal(proposal, view));
}

function dedupe(proposals: readonly Proposal[]): readonly Proposal[] {
  const selected = new Map<string, Proposal>();

  for (const proposal of proposals) {
    const key = `${proposal.target}:${proposal.action}`;
    if (!selected.has(key)) {
      selected.set(key, proposal);
    }
  }

  for (const proposal of selected.values()) {
    if (proposal.action === "destroy") {
      selected.delete(`${proposal.target}:shutdown`);
    }
  }

  return [...selected.values()];
}

function isSafeProposal(proposal: Proposal, view: RegistryView): boolean {
  const device = view.devices.find((candidate) => candidate.id === proposal.target);
  if (device === undefined || view.leases.some((lease) => lease.deviceId === device.id)) {
    return false;
  }

  if (
    device.state === "leased" ||
    device.state === "provisioning" ||
    device.state === "reclaiming"
  ) {
    return false;
  }

  return (
    (proposal.action === "shutdown" && device.state === "ready") ||
    (proposal.action === "destroy" && device.state === "shutdown")
  );
}
