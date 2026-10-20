import type { EventBus } from "../bus/index.js";
import type { AlertDestination } from "../core/index.js";
import { ALERT_EVENTS } from "../core/index.js";
import type { Clock, Logger, WebhookPoster } from "../ports/index.js";
import { DestinationQueue } from "./queue.js";

export interface Alerts {
  stop(): void;
}

export function createAlerts(options: {
  destinations: readonly AlertDestination[];
  eventBus: EventBus;
  poster: WebhookPoster;
  clock: Clock;
  logger: Logger;
  version: string;
}): Alerts {
  const { destinations, eventBus, poster, clock, logger, version } = options;
  const queues = destinations.map((destination) => ({
    destination,
    queue: new DestinationQueue({ destination, poster, clock, logger, version }),
  }));

  const unsubscribes = ALERT_EVENTS.filter((name) =>
    destinations.some((destination) => destination.events.includes(name)),
  ).map((name) =>
    eventBus.subscribe(name, (envelope) => {
      for (const { destination, queue } of queues) {
        if (!destination.events.includes(name)) continue;
        queue.enqueue(envelope);
      }
    }),
  );

  return {
    stop() {
      for (const unsubscribe of unsubscribes) unsubscribe();
      const discarded: Record<string, number> = {};
      for (const { destination, queue } of queues) {
        const count = queue.stop();
        if (count > 0) discarded[destination.name] = count;
      }
      if (Object.keys(discarded).length > 0) logger.info("Alerts discarded at stop", { discarded });
    },
  };
}
