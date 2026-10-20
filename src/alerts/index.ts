import type { EventBus } from "../bus/index.js";
import type { AlertDestination } from "../core/index.js";
import { ALERT_EVENTS } from "../core/index.js";
import type { Clock, IdGenerator, Logger, WebhookPoster } from "../ports/index.js";
import { DestinationQueue } from "./queue.js";
import { type AlertTestResult, sendTest } from "./sample.js";

export type { AlertTestResult };

export interface Alerts {
  test(destination: string): Promise<AlertTestResult>;
  stop(): void;
}

export function createAlerts(options: {
  destinations: readonly AlertDestination[];
  eventBus: EventBus;
  poster: WebhookPoster;
  clock: Clock;
  idGenerator: IdGenerator;
  logger: Logger;
  version: string;
  workerLabel(workerId: string): string | undefined;
}): Alerts {
  const { destinations, eventBus, poster, clock, idGenerator, logger, version } = options;
  const workerLabel = (workerId: string): string => options.workerLabel(workerId) ?? workerId;
  const stopController = new AbortController();
  const queues = destinations.map(
    (destination) =>
      new DestinationQueue({ destination, poster, clock, logger, version, workerLabel }),
  );

  const unsubscribes = ALERT_EVENTS.filter((name) =>
    destinations.some((destination) => destination.events.includes(name)),
  ).map((name) =>
    eventBus.subscribe(name, (envelope) => {
      for (const queue of queues) {
        if (queue.destination.events.includes(name)) queue.enqueue(envelope);
      }
    }),
  );

  return {
    test(name) {
      if (stopController.signal.aborted) return Promise.resolve({ ok: false, reason: "stopped" });
      const destination = destinations.find((each) => each.name === name);
      if (destination === undefined)
        return Promise.resolve({ ok: false, reason: "unknown-destination" });
      return sendTest({
        destination,
        poster,
        clock,
        idGenerator,
        stopSignal: stopController.signal,
        version,
        workerLabel,
      });
    },
    stop() {
      stopController.abort();
      for (const unsubscribe of unsubscribes) unsubscribe();
      const discarded: Record<string, number> = {};
      for (const queue of queues) {
        const count = queue.stop();
        if (count > 0) discarded[queue.destination.name] = count;
      }
      if (Object.keys(discarded).length > 0) logger.info("Alerts discarded at stop", { discarded });
    },
  };
}
