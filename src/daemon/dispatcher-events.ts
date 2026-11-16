import { EVENTS_PAGE_DEFAULT } from "../contract/index.js";
import { createUsageReader, type UsageReader } from "../core/index.js";
import { DispatchError, eventsPageAnswer, usageAnswer } from "./dispatch.js";
import type { DispatcherOptions, Handler } from "./dispatcher-options.js";

export class EventHandlers {
  readonly #usage: UsageReader;

  constructor(private readonly options: DispatcherOptions) {
    this.#usage = createUsageReader({
      historyPath: options.historyPath ?? "",
      opened: () => options.historyPath !== undefined && options.eventHistory.status().opened,
      tokenLabels: async () =>
        new Map(
          ((await options.tokens?.list()) ?? []).flatMap((token) =>
            token.label === undefined ? [] : [[token.id, token.label] as const],
          ),
        ),
      workers: () => [
        {
          id: options.instanceId,
          ...(options.config.gateway.label === undefined
            ? {}
            : { label: options.config.gateway.label }),
        },
      ],
    });
  }

  readonly usageGet: Handler<"usage.get"> = (input) => usageAnswer(this.#usage.get(input));

  readonly eventsReplay: Handler<"events.replay"> = (input) => {
    // why: a worker's own events carry no workerId, so `worker` can only name this daemon or no one (ADR 0012 §1)
    if (input.workerId !== undefined && input.workerId !== this.options.instanceId) {
      return Promise.resolve([]);
    }
    return input.beforeId === undefined && input.limit === undefined
      ? this.options.eventHistory.replay(
          input.sinceTs === undefined ? {} : { sinceTs: input.sinceTs },
        )
      : eventsPageAnswer(
          this.options.eventHistory.replayPage({
            ...(input.beforeId === undefined ? {} : { beforeId: input.beforeId }),
            limit: input.limit ?? EVENTS_PAGE_DEFAULT,
          }),
        );
  };

  readonly eventsSubscribe: Handler<"events.subscribe"> = (_input, session) => {
    const subscriptionId = session.manageEventSubscription(true);
    if (subscriptionId === undefined) {
      throw new DispatchError("INTERNAL", "Transport did not provide a subscription id");
    }
    return { subscribed: true, subscriptionId };
  };

  readonly eventsUnsubscribe: Handler<"events.unsubscribe"> = (_input, session) => {
    session.manageEventSubscription(false);
    return { subscribed: false };
  };

  dispose(): void {
    void this.#usage.stop();
  }
}
