import type { z } from "zod";

import type { OPERATIONS, OperationName } from "../contract/index.js";
import type { Logger } from "../ports/index.js";
import { NoopLogger } from "../ports/index.js";
import { identityGet, runDispatch, type DispatchSession, type ErasedHandler } from "./dispatch.js";
import { AdminHandlers } from "./dispatcher-admin.js";
import { ComponentHandlers } from "./dispatcher-components.js";
import { DeviceHandlers } from "./dispatcher-devices.js";
import { EventHandlers } from "./dispatcher-events.js";
import { ExecHandlers } from "./dispatcher-exec.js";
import { FleetHandlers, unsupportedOnWorker } from "./dispatcher-fleet.js";
import { LeaseHandlers } from "./dispatcher-leases.js";
import type { DispatcherOptions, WorkerOperationName } from "./dispatcher-options.js";
import { SeedHandlers } from "./dispatcher-seed.js";
import { StatusHandlers } from "./dispatcher-status.js";

export { DispatchError, type ContractDispatcher, type DispatchSession } from "./dispatch.js";
export type { CapabilitySource, DispatcherOptions } from "./dispatcher-options.js";
export { DoctorUnavailableError, NukeUnavailableError } from "./dispatcher-admin.js";

export class Dispatcher {
  readonly #logger: Logger;
  readonly #dispatchLogger: Logger;
  /**
   * why: Total over every operation but `daemon.stop`. Deliberately *not* a partial map: a declared
   * operation whose handler was never written is otherwise invisible to the compiler and only
   * shows up as `UNKNOWN_REQUEST` at runtime -- which is exactly how `driver.passthrough` came
   * to be declared, dispatched, and unimplemented at once.
   *
   * ADR 0012: a worker answers the fleet operations as a fleet of one. `worker.list` returns
   * this host as its only worker; the operations that act on a gateway's workers refuse with
   * `UNSUPPORTED_IN_WORKER_MODE`, so adding a gateway operation still makes the compiler ask
   * what a worker answers.
   */
  readonly #handlers: Record<WorkerOperationName, ErasedHandler>;
  readonly #events: EventHandlers;
  readonly #status: StatusHandlers;
  readonly #leases: LeaseHandlers;
  readonly #components: ComponentHandlers;
  readonly #seeds: SeedHandlers;
  readonly #admin: AdminHandlers;
  readonly #fleet: FleetHandlers;
  readonly #exec: ExecHandlers;
  readonly #devices: DeviceHandlers;

  constructor(private readonly options: DispatcherOptions) {
    this.#logger = options.logger ?? new NoopLogger();
    this.#events = new EventHandlers(options);
    this.#status = new StatusHandlers(options);
    this.#leases = new LeaseHandlers(options);
    this.#components = new ComponentHandlers(options);
    this.#seeds = new SeedHandlers(options);
    this.#admin = new AdminHandlers(options);
    this.#fleet = new FleetHandlers(options, {
      components: this.#components,
      leases: this.#leases,
      status: this.#status,
    });
    this.#dispatchLogger = this.#logger.child("dispatch");
    this.#exec = new ExecHandlers(options);
    this.#devices = new DeviceHandlers(options);
    // why: Arrow-function class fields (not methods): each closes over `this` so it can be stored in
    // `#handlers` and invoked as a plain function, the same way any other transport-independent
    // callback would be. None of these run a role or ownership check -- `dispatch()` above
    // already did, per the ADR's ordering.

    this.#handlers = {
      "catalog.get": this.#status.catalogGet,
      "status.get": this.#status.statusGet,
      "lease.request": this.#leases.leaseRequest,
      "lease.cancel": this.#leases.leaseCancel,
      "lease.renew": this.#leases.leaseRenew,
      "lease.release": this.#leases.leaseRelease,
      "lease.list": this.#leases.leaseList,
      "lease.get": this.#leases.leaseGet,
      "driver.passthrough": this.#exec.driverPassthrough,
      "device.exec": this.#exec.deviceExec,
      "device.rotate": this.#devices.deviceRotate,
      "relay.request": this.#fleet.relayRequest,
      "relay.cancel": this.#fleet.relayCancel,
      "doctor.run": this.#admin.doctorRun,
      "lease.release-all": this.#leases.leaseReleaseAll,
      "lease.release-run": this.#leases.leaseReleaseRun,
      "list.get": this.#status.listGet,
      "cleanup.run": this.#admin.cleanupRun,
      "nuke.run": this.#admin.nukeRun,
      "warm.forget": this.#components.warmForget,
      "baseline.save": this.#components.baselineSave,
      "baseline.list": this.#components.baselineList,
      "baseline.remove": this.#components.baselineRemove,
      "config.get": this.#status.configGet,
      "events.replay": this.#events.eventsReplay,
      "usage.get": this.#events.usageGet,
      "events.subscribe": this.#events.eventsSubscribe,
      "events.unsubscribe": this.#events.eventsUnsubscribe,
      "identity.get": identityGet,
      "token.create": this.#admin.tokenCreate,
      "inbox.get": this.#fleet.inboxGet,
      "token.list": this.#admin.tokenList,
      "token.revoke": this.#admin.tokenRevoke,
      "component.install": this.#components.componentInstall,
      "seed.make": this.#seeds.seedMake,
      "component.list": this.#components.componentList,
      "component.remove": this.#components.componentRemove,
      "device.add": this.#devices.deviceAdd,
      "device.remove": this.#devices.deviceRemove,
      "daemon.update": this.#admin.daemonUpdate,
      "worker.list": this.#fleet.workerList,
      "worker.drain": unsupportedOnWorker("worker.drain"),
      "worker.undrain": unsupportedOnWorker("worker.undrain"),
      "worker.remove": unsupportedOnWorker("worker.remove"),
      "worker.update": unsupportedOnWorker("worker.update"),
      "worker.install-component": unsupportedOnWorker(
        "worker.install-component",
        "worker.install-component installs on a gateway's workers, and this daemon is not a gateway; install on this host without naming workers",
      ),
      "alerts.test": unsupportedOnWorker(
        "alerts.test",
        "alerts.test sends to a gateway's alert destinations, and this daemon is not a gateway; run it against the gateway",
      ),
    };
  }

  dispose(): void {
    this.#fleet.dispose();
    this.#events.dispose();
  }

  dispatch<Op extends OperationName>(
    operation: Op,
    rawInput: unknown,
    session: DispatchSession,
  ): Promise<z.infer<(typeof OPERATIONS)[Op]["output"]>> {
    return runDispatch(operation, rawInput, session, {
      handlers: this.#handlers,
      authorizeLookups: {
        ownerId: (leaseId) =>
          this.options.registry.snapshot.leases.find((lease) => lease.id === leaseId)?.ownerId,
        leaseRequesterId: (leaseId) =>
          this.options.registry.snapshot.leases.find((lease) => lease.id === leaseId)?.requesterId,
        pendingRequestOwner: (requesterId, platform) =>
          this.options.queue.pendingRequestOwner(requesterId, platform),
      },
      awaitReady: () => this.options.awaitReady(),
      onOutputMismatch: (operationName, issues) => {
        this.#logger.error("Operation output failed contract validation", {
          operation: operationName,
          issues,
        });
      },
      observe: {
        clock: this.options.clock,
        logger: this.#dispatchLogger,
        codeOf: (error) => this.options.errorCode?.(error) ?? "INTERNAL",
      },
    });
  }
}
