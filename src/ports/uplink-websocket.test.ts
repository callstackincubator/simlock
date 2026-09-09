/**
 * P3: `WebSocketUplinkListenerFactory#handleUpgrade` reads `x-simlock-worker-id` and the
 * URI-decoded `x-simlock-worker-label` *before* `authenticate` runs -- so anyone who can reach
 * the gateway's HTTP port, with no credential at all, can make it claim an arbitrary worker id
 * and a label up to Node's header budget (~16 KB). Both reach `authenticate`'s `claimed`
 * argument regardless of the outcome, and a refusal still emits `worker.rejected` on the
 * gateway's bus with them attached (`GatewayService`/`WorkerRegistry`, exercised elsewhere) --
 * this file is the one place that can drive a real HTTP upgrade with attacker-shaped headers and
 * observe what actually reaches that boundary, unauthenticated.
 *
 * A real `http.Server` and the real `ws` library on both ends, not a hand-built
 * `IncomingMessage` -- `#handleUpgrade` is private, and a header this large or this shaped is
 * exactly the kind of thing worth proving survives an actual HTTP round trip rather than a
 * fabricated request object.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import type { ClaimedUplinkIdentity, UplinkAuthOutcome } from "./uplink.js";
import { WebSocketUplinkConnector, WebSocketUplinkListenerFactory } from "./uplink-websocket.js";

let server: Server | undefined;

afterEach(async () => {
  if (server === undefined) return;
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
});

/** Starts a real gateway-side listener whose `authenticate` always refuses (recording every
 * `claimed` it was handed) and returns the base URL to dial it at. */
async function startRefusingGateway(): Promise<{
  url: string;
  claims: ClaimedUplinkIdentity[];
}> {
  const claims: ClaimedUplinkIdentity[] = [];
  const factory = new WebSocketUplinkListenerFactory();
  await factory.listen({
    authenticate: (_credential, claimed): Promise<UplinkAuthOutcome> => {
      claims.push(claimed);
      return Promise.resolve("unauthenticated");
    },
    accept: () => {
      throw new Error("this gateway never accepts");
    },
  });
  server = createServer((_request, response) => {
    response.writeHead(404).end();
  });
  factory.attach(server);
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { claims, url: `ws://127.0.0.1:${port}` };
}

/** Dials with no credential the gateway will accept, and swallows the resulting refusal -- every
 * test here is about what `authenticate` was handed, not about the connection succeeding. */
async function dialAndIgnoreRefusal(url: string, workerId: string, label?: string): Promise<void> {
  await new WebSocketUplinkConnector()
    .connect({ token: "irrelevant", url, workerId, ...(label === undefined ? {} : { label }) })
    .catch(() => undefined);
}

describe("WebSocketUplinkListenerFactory / P3", () => {
  it("truncates an over-long claimed workerId before authenticate ever sees it", async () => {
    const { claims, url } = await startRefusingGateway();
    const longId = "w".repeat(10_000);

    await dialAndIgnoreRefusal(url, longId);

    expect(claims).toHaveLength(1);
    expect(claims[0]?.workerId).toHaveLength(128);
    expect(claims[0]?.workerId).toBe(longId.slice(0, 128));
  });

  it("truncates an over-long claimed label the same way", async () => {
    const { claims, url } = await startRefusingGateway();
    const longLabel = "mac-mini-".repeat(100);

    await dialAndIgnoreRefusal(url, "wrk_1", longLabel);

    expect(claims).toHaveLength(1);
    expect(claims[0]?.label).toHaveLength(128);
    expect(claims[0]?.label).toBe(longLabel.slice(0, 128));
  });

  it("drops a claimed label containing a control character instead of passing it through", async () => {
    const { claims, url } = await startRefusingGateway();

    // A worker's own label never contains one; an attacker's header can claim anything.
    await dialAndIgnoreRefusal(url, "wrk_1", "mac-mini-evil\ntitle");

    expect(claims).toHaveLength(1);
    expect(claims[0]?.label).toBeUndefined();
  });

  it("still accepts an ordinary short, printable label unchanged", async () => {
    const { claims, url } = await startRefusingGateway();

    await dialAndIgnoreRefusal(url, "wrk_1", "mac-mini-1");

    expect(claims).toHaveLength(1);
    expect(claims[0]).toEqual({ label: "mac-mini-1", workerId: "wrk_1" });
  });
});
