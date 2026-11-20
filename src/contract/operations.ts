import { z } from "zod";
import { CONSOLE_URL_MAX_LENGTH } from "./console-url.js";
import { defineOperation } from "./operation-definition.js";
import {
  baselineList,
  baselineRemove,
  baselineSave,
  cleanupRun,
  configGet,
  daemonStop,
  daemonUpdate,
  doctorRun,
  eventsReplay,
  eventsSubscribe,
  eventsUnsubscribe,
  listGet,
  nukeRun,
  tokenCreate,
  tokenList,
  tokenRevoke,
  usageGet,
  warmForget,
} from "./operations-admin.js";
import {
  alertsTest,
  componentInstall,
  componentList,
  componentRemove,
  deviceAdd,
  deviceRemove,
  identityGet,
  inboxGet,
  relayCancel,
  relayRequest,
  workerDrain,
  workerInstallComponent,
  workerList,
  workerRemove,
  workerUndrain,
  workerUpdate,
} from "./operations-fleet.js";
import { leaseRequest } from "./operations-lease-request.js";
import {
  deviceExec,
  deviceRotate,
  driverPassthrough,
  leaseCancel,
  leaseGet,
  leaseList,
  leaseRelease,
  leaseReleaseAll,
  leaseReleaseRun,
  leaseRenew,
} from "./operations-leases.js";
import {
  capabilityListSchema,
  daemonHealthSchema,
  daemonModeSchema,
  daemonUpdateFields,
  historyStatusSchema,
  hostFactsSchema,
  hostLoadSchema,
  platformCatalogSchema,
  platformSchema,
  statusCapacitySchema,
  statusDeviceSchema,
  statusInstallsSchema,
  statusLeaseSchema,
  statusWarmPoolSchema,
  waitingRequestSchema,
  workerViewSchema,
} from "./schemas.js";

export type { Effect, OperationDefinition } from "./operation-definition.js";
export {
  LEASE_ID_PATTERN,
  leaseIdSchema,
  refuseModelWithClass,
  refuseBadLabel,
  refuseBadRunId,
  RUN_ID_PATTERN,
  leaseRequestFields,
  // fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
  leaseRequest,
  requestedDevice,
  requestedClass,
} from "./operations-lease-request.js";
export {
  // fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
  leaseCancel,
  // fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
  leaseRenew,
  leaseRelease,
  // fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
  driverPassthrough,
  LEASE_FILE_NAME_PATTERN,
  EXEC_STDIN_MAX_LENGTH,
  // fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
  deviceExec,
  // fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
  leaseList,
  // fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
  leaseGet,
  // fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
  leaseReleaseAll,
  leaseReleaseRun,
} from "./operations-leases.js";
export {
  // fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
  doctorRun,
  // fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
  listGet,
  // fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
  cleanupRun,
  // fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
  nukeRun,
  // fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
  warmForget,
  // fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
  baselineSave,
  // fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
  baselineList,
  // fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
  baselineRemove,
  // fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
  configGet,
  // fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
  daemonStop,
  // fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
  daemonUpdate,
  // fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
  eventsReplay,
  // fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
  usageGet,
  // fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
  eventsSubscribe,
  // fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
  eventsUnsubscribe,
  // fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
  tokenCreate,
  // fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
  tokenList,
  // fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
  tokenRevoke,
} from "./operations-admin.js";
export {
  // fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
  workerList,
  // fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
  workerDrain,
  // fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
  workerUndrain,
  // fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
  workerRemove,
  // fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
  workerUpdate,
  // fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
  componentInstall,
  // fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
  componentList,
  WORKER_RESULT_MESSAGE_MAX_LENGTH,
  // fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
  workerInstallComponent,
  // fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
  componentRemove,
  // fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
  deviceAdd,
  // fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
  deviceRemove,
  // fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
  relayRequest,
  // fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
  relayCancel,
  // fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
  alertsTest,
  // fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
  inboxGet,
} from "./operations-fleet.js";

// fallow-ignore-next-line unused-export -- consumed only through the OPERATIONS registry, not by name; still public contract surface.
export const catalogGet = defineOperation({
  name: "catalog.get",
  role: "agent",
  effect: "read",
  input: z.object({ platform: platformSchema.optional() }),
  output: z.object({ platforms: z.array(platformCatalogSchema) }),
});

export const statusGet = defineOperation({
  name: "status.get",
  role: "agent",
  effect: "read",
  input: z.object({}),
  output: z.object({
    // why: `devices`, `leases`, `capacity` and `queueDepth` are absent while `daemon.health` is
    // `starting`: the registry has not been checked yet, so a reader sees a daemon that says
    // it is starting and what host it runs on, and nothing it could mistake for an empty fleet.
    devices: z.array(statusDeviceSchema).optional(),
    leases: z.array(statusLeaseSchema).optional(),
    capacity: statusCapacitySchema.optional(),
    warmPool: statusWarmPoolSchema.optional(),
    capabilities: capabilityListSchema.optional(),
    daemon: z.object({
      health: daemonHealthSchema,
      mode: daemonModeSchema,
      consoleUrl: z.string().max(CONSOLE_URL_MAX_LENGTH).optional(),
      ...daemonUpdateFields,
    }),
    host: hostFactsSchema,
    load: hostLoadSchema.optional(),
    history: historyStatusSchema.optional(),
    queueDepth: z.number().optional(),
    physicalQueueDepth: z.number().optional(),
    installs: statusInstallsSchema.optional(),
    waiting: z.array(waitingRequestSchema).optional(),
    /** why: Absent, not empty, from a worker: an empty array would read as a gateway with no workers. */
    workers: z.array(workerViewSchema).optional(),
  }),
});

export const OPERATIONS = {
  "identity.get": identityGet,
  "catalog.get": catalogGet,
  "status.get": statusGet,
  "lease.request": leaseRequest,
  "lease.cancel": leaseCancel,
  "lease.renew": leaseRenew,
  "lease.release": leaseRelease,
  "lease.list": leaseList,
  "lease.get": leaseGet,
  "driver.passthrough": driverPassthrough,
  "device.exec": deviceExec,
  "device.rotate": deviceRotate,
  "doctor.run": doctorRun,
  "lease.release-all": leaseReleaseAll,
  "lease.release-run": leaseReleaseRun,
  "list.get": listGet,
  "cleanup.run": cleanupRun,
  "nuke.run": nukeRun,
  "warm.forget": warmForget,
  "baseline.save": baselineSave,
  "baseline.list": baselineList,
  "baseline.remove": baselineRemove,
  "config.get": configGet,
  "daemon.stop": daemonStop,
  "daemon.update": daemonUpdate,
  "events.replay": eventsReplay,
  "events.subscribe": eventsSubscribe,
  "events.unsubscribe": eventsUnsubscribe,
  "usage.get": usageGet,
  "inbox.get": inboxGet,
  "token.create": tokenCreate,
  "token.list": tokenList,
  "token.revoke": tokenRevoke,
  "worker.list": workerList,
  "worker.drain": workerDrain,
  "worker.undrain": workerUndrain,
  "worker.remove": workerRemove,
  "worker.update": workerUpdate,
  "component.install": componentInstall,
  "component.list": componentList,
  "worker.install-component": workerInstallComponent,
  "component.remove": componentRemove,
  "device.add": deviceAdd,
  "device.remove": deviceRemove,
  "relay.request": relayRequest,
  "relay.cancel": relayCancel,
  "alerts.test": alertsTest,
} as const;

export type OperationName = keyof typeof OPERATIONS;
