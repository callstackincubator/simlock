import type { ScreenAvailability, ScreenSettings } from "../core/index.js";
import type { ModuleLeaseEndParticipant, WorkerContext } from "../modules/index.js";
import type { Clock, Logger } from "../ports/index.js";
import { createCaptureRegistry, createStreamLeaseEnd } from "./captures.js";
import { DEFAULT_SILENCE_MS, DEFAULT_START_MS } from "./feed.js";
import { createGatewayStreamLink, type FleetPort } from "./gateway-link.js";
import {
  createStreamMount,
  createStreamRelayTarget,
  type StreamMount,
  type StreamRelayTarget,
} from "./mounts.js";
import type { StreamServiceOptions } from "./service.js";
import { createWorkerStreamLink, type ScreenOpener, type StreamRegistry } from "./worker-link.js";

const DEVICE_STOP_EVENTS = [
  "device.shutdown",
  "device.absence-detected",
  "device.quarantined",
  "device.deleted",
] as const;

export interface WorkerStreamOptions {
  readonly name: string;
  readonly instanceId: string;
  readonly events: WorkerContext<unknown>["events"];
  readonly registry: StreamRegistry;
  readonly screens: ScreenOpener & {
    screenAvailability(): Promise<readonly ScreenAvailability[]>;
  };
  readonly clock: Clock;
  readonly logger: Logger;
  readonly settings: ScreenSettings;
}

export interface StreamCapabilitySource {
  readonly name: string;
  read(): Promise<{ readonly state: "available" | "unavailable"; readonly reason?: string }>;
}

export interface WorkerStream {
  readonly mount: StreamMount;
  readonly relayTarget: StreamRelayTarget;
  readonly leaseEnd: ModuleLeaseEndParticipant;
  readonly capabilitySource: StreamCapabilitySource;
}

// why: the mount, the relay target and the lease-end participant sit on one link and one registry, so
// a stream asked for on this host and one relayed by a gateway go through the same device check, and a
// lease that ends has one place to stop its captures whichever door the picture came in by.
export function createWorkerStream(options: WorkerStreamOptions): WorkerStream {
  const captures = createCaptureRegistry();
  const service: StreamServiceOptions = {
    link: createWorkerStreamLink({
      bounds: { clock: options.clock, silenceMs: DEFAULT_SILENCE_MS, startMs: DEFAULT_START_MS },
      captures,
      instanceId: options.instanceId,
      registry: options.registry,
      screens: options.screens,
      settings: options.settings,
    }),
    logger: options.logger,
  };
  // why: a device that stops with no lease end (the warm pool's shutdown, the reaper, a phone unplugged,
  // quarantine, a delete) runs no reclaim hook, and a capture does not end by itself when its device
  // does -- a simulator's repeats its last frame -- so these four events are what end it.
  for (const event of DEVICE_STOP_EVENTS) {
    options.events.subscribe(event, (envelope) => {
      void captures.stopOnDevice(envelope.payload.deviceId);
    });
  }
  return {
    capabilitySource: {
      name: options.name,
      read: async () => describeAvailability(await options.screens.screenAvailability()),
    },
    leaseEnd: createStreamLeaseEnd(captures),
    mount: createStreamMount(service),
    relayTarget: createStreamRelayTarget(service),
  };
}

export interface GatewayStreamOptions {
  readonly fleet: FleetPort;
  readonly logger: Logger;
}

export function createGatewayStream(options: GatewayStreamOptions): {
  readonly mount: StreamMount;
} {
  return {
    mount: createStreamMount({
      link: createGatewayStreamLink({ fleet: options.fleet }),
      logger: options.logger,
    }),
  };
}

function describeAvailability(platforms: readonly ScreenAvailability[]): {
  readonly state: "available" | "unavailable";
  readonly reason?: string;
} {
  // why: an `available` capability carries no reason on the wire, so a platform that cannot capture
  // on a host where another can says why when a stream on it is asked for, as a 503 with its reason.
  if (platforms.some((entry) => entry.reason === undefined)) return { state: "available" };
  const why = platforms.map((entry) => `${entry.platform}: ${entry.reason ?? ""}`).join("; ");
  return {
    reason: why === "" ? "No driver on this host can capture a screen" : why,
    state: "unavailable",
  };
}
