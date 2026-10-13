import { describe, expect, it } from "vitest";

import type { Logger } from "../ports/index.js";
import { RelayConnection, type RelayPush, type RelayTarget } from "./relay.js";
import { relayInput, settle } from "./test-relay-support.js";

const logger: Logger = {
  child: () => logger,
  debug: () => undefined,
  error: () => undefined,
  info: () => undefined,
  warn: () => undefined,
};

type Input = Parameters<RelayConnection["request"]>[0];

describe("a worker's relay connection", () => {
  it("answers { cancelled: true } and never runs the target for a request that arrives after the connection closed", async () => {
    let ran = false;
    const target: RelayTarget = () => {
      ran = true;
      return Promise.resolve(new Response("late"));
    };
    const relays = new RelayConnection({ echo: target }, logger);
    const push: RelayPush = { chunk: () => Promise.resolve(), head: () => Promise.resolve() };

    relays.abortAll();
    const outcome = await settle(relays.request(relayInput() as Input, push));

    expect(outcome).toEqual({ state: "fulfilled", value: { cancelled: true } });
    expect(ran).toBe(false);
  });

  it("answers { cancelled: true } and cancels the target's body when relay.cancel lands while the head is being written", async () => {
    let bodyCancelled = false;
    const target: RelayTarget = () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            cancel: () => {
              bodyCancelled = true;
            },
            pull: () => new Promise<void>(() => undefined),
          }),
        ),
      );
    const relays = new RelayConnection({ echo: target }, logger);
    const input = relayInput() as Input;
    const push: RelayPush = {
      chunk: () => Promise.resolve(),
      head: () => {
        relays.cancel(input.relayId);
        return Promise.resolve();
      },
    };

    const outcome = await settle(relays.request(input, push));

    expect(outcome).toEqual({ state: "fulfilled", value: { cancelled: true } });
    expect(bodyCancelled).toBe(true);
  });
});
