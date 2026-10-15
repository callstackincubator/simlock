import type { Platform, ScreenAvailability, ScreenSettings } from "../core/index.js";
import type { LeaseEndParticipant } from "../leasing/index.js";
import type { Clock, Logger } from "../ports/index.js";
import { createCaptureRegistry, createStreamLeaseEnd } from "./captures.js";
import { DEFAULT_SILENCE_MS, DEFAULT_START_MS } from "./feed.js";
import { createGatewayStreamLink, type FleetPort } from "./gateway-link.js";
import {
  createStreamMount,
  createStreamRelayTarget,
  STREAM_TARGET,
  type StreamMount,
  type StreamRelayTarget,
} from "./mounts.js";
import type { StreamServiceOptions } from "./service.js";
import { createWorkerStreamLink, type ScreenOpener, type StreamRegistry } from "./worker-link.js";

export interface WorkerStreamOptions {
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
  readonly relayTargetName: string;
  readonly leaseEnd: LeaseEndParticipant;
  readonly capabilitySource: StreamCapabilitySource;
}

// why: the mount, the relay target and the lease-end participant sit on one link and one registry, so
// a stream asked for on this host and one relayed by a gateway go through the same lease check, and a
// lease that ends has one place to stop its captures whichever door the picture came in by.
export function createWorkerStream(options: WorkerStreamOptions): WorkerStream {
  const captures = createCaptureRegistry();
  const service: StreamServiceOptions = {
    link: createWorkerStreamLink({
      bounds: { clock: options.clock, silenceMs: DEFAULT_SILENCE_MS, startMs: DEFAULT_START_MS },
      captures,
      registry: options.registry,
      screens: options.screens,
      settings: options.settings,
    }),
    logger: options.logger,
  };
  return {
    capabilitySource: {
      name: STREAM_TARGET,
      read: async () => describeAvailability(await options.screens.screenAvailability()),
    },
    leaseEnd: createStreamLeaseEnd(captures),
    mount: createStreamMount(service),
    relayTarget: createStreamRelayTarget(service),
    relayTargetName: STREAM_TARGET,
  };
}

export interface GatewayStreamOptions {
  readonly fleet: FleetPort;
  readonly logger: Logger;
}

export function createGatewayStream(options: GatewayStreamOptions): {
  readonly mount: StreamMount;
  readonly relayTargetName: string;
} {
  return {
    mount: createStreamMount({
      link: createGatewayStreamLink({ fleet: options.fleet }),
      logger: options.logger,
    }),
    relayTargetName: STREAM_TARGET,
  };
}

function describeAvailability(platforms: readonly ScreenAvailability[]): {
  readonly state: "available" | "unavailable";
  readonly reason?: string;
} {
  const available: Platform[] = platforms
    .filter((entry) => entry.reason === undefined)
    .map((entry) => entry.platform);
  const missing = platforms.filter((entry) => entry.reason !== undefined);
  const why = missing.map((entry) => `${entry.platform}: ${entry.reason ?? ""}`).join("; ");
  if (available.length === 0) {
    return {
      reason: why === "" ? "No driver on this host can capture a screen" : why,
      state: "unavailable",
    };
  }
  return why === ""
    ? { state: "available" }
    : { reason: `Available on ${available.join(", ")}; ${why}`, state: "available" };
}
