import { buildCapacityFigures, redactConfig } from "../core/index.js";
import {
  consoleUrlField,
  fitPlatformCatalog,
  withoutQuarantineMessages,
} from "../contract/index.js";
import { readCapabilities } from "./dispatcher-capabilities.js";
import { decorateDevice, leasesFor, waitingFor } from "./dispatcher-device-views.js";
import type { DispatcherOptions, Handler } from "./dispatcher-options.js";
import type { UpdateProgress } from "./update-coordinator.js";

export class StatusHandlers {
  constructor(private readonly options: DispatcherOptions) {}

  readonly catalogGet: Handler<"catalog.get"> = async (input) => ({
    platforms: (await this.options.catalog.listCatalog(input.platform))
      .map(fitPlatformCatalog)
      .map((entry) => this.#withDefaults(entry)),
  });

  /** why: ADR 0066 §5 and ADR 0078 §3: a gateway routes by the worker's default mode (iOS) and default image tag (Android), which only config knows. */
  #withDefaults<Entry extends { readonly platform: string }>(entry: Entry): Entry {
    const { ios, android } = this.options.config;
    if (entry.platform === "ios") return { ...entry, defaultMode: ios.defaultMode };
    if (entry.platform === "android" && android.defaultImageTag !== undefined) {
      return { ...entry, defaultImageTag: android.defaultImageTag };
    }
    return entry;
  }

  readonly statusGet: Handler<"status.get"> = async (_input, session) => {
    const daemon = {
      health: this.options.health(),
      mode: this.options.config.mode,
      ...consoleUrlField(this.options.config.http),
      version: this.options.version,
      ...this.#updateFields(),
    };
    const host = this.options.hostFacts();
    const load = this.options.load?.();
    const loadField = load === undefined ? {} : { load };
    const memoryPressure = this.options.memoryPressure?.();
    // why: while starting, the registry has not been checked against the machine, so what it holds
    // is a claim nobody has looked at; the answer is the daemon, its host and the load reading.
    const history = this.options.eventHistory.status();
    if (daemon.health === "starting") return { daemon, history, host, ...loadField };
    const capabilities = await readCapabilities(this.options);
    const snapshot = this.options.registry.snapshot;
    const answer = {
      ...(capabilities === undefined ? {} : { capabilities }),
      capacity: {
        ...buildCapacityFigures(snapshot.virtualDevices, this.options.capacity),
        ...(memoryPressure === undefined ? {} : { memoryPressure }),
      },
      devices: snapshot.devices.map((device) => decorateDevice(this.options, device)),
      daemon,
      history,
      host,
      ...loadField,
      installs: [...this.options.components.inProgress()],
      leases: leasesFor(this.options, session),
      physicalQueueDepth: this.options.queue.physicalQueueDepth,
      queueDepth: this.options.queue.queueDepth,
      waiting: waitingFor(this.options, session),
      warmPool: this.options.warmPool.figures(),
    };
    return session.role === "agent" ? withoutQuarantineMessages(answer) : answer;
  };

  #updateFields(): UpdateProgress {
    return (
      this.options.update?.state() ?? { update: null, lastUpdateFailure: null, latestVersion: null }
    );
  }

  readonly listGet: Handler<"list.get"> = (input) => {
    const snapshot = this.options.registry.snapshot;
    switch (input.kind) {
      case "leases":
        return [...snapshot.leases];
      case "rules":
        return this.options.reaper.rules;
      case "requests":
        return [...this.options.queue.waitingRequests()];
      case "devices":
      case undefined:
        return snapshot.devices.map((device) => decorateDevice(this.options, device));
    }
  };

  readonly configGet: Handler<"config.get"> = (input) =>
    input.showSecrets === true ? this.options.config : redactConfig(this.options.config);
}
