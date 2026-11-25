import { afterEach, describe, expect, it, vi } from "vitest";
import { Dispatcher } from "./dispatcher.js";
import { createClient, createHarness, hello, stopTestDaemons } from "./test-server.js";

afterEach(() => {
  vi.restoreAllMocks();
  return stopTestDaemons();
});

const PASS_THROUGH = [
  "lease.renew",
  "lease.cancel",
  "lease.get",
  "lease.list",
  "status.get",
  "list.get",
  "catalog.get",
  "cleanup.run",
  "doctor.run",
  "nuke.run",
  "warm.forget",
  "baseline.list",
  "baseline.remove",
  "baseline.save",
  "events.replay",
  "usage.get",
  "inbox.get",
  "events.subscribe",
  "events.unsubscribe",
  "driver.passthrough",
  "device.rotate",
  "relay.cancel",
  "config.get",
  "identity.get",
  "token.create",
  "token.list",
  "token.revoke",
  "worker.list",
  "worker.drain",
  "worker.undrain",
  "worker.remove",
  "worker.update",
  "alerts.test",
  "component.list",
  "component.remove",
  "device.add",
  "device.remove",
] as const;

describe("the socket's pass-through requests (pin)", () => {
  it("hands each pass-through request to the dispatcher under its own name with the payload it carried", async () => {
    const harness = await createHarness();
    const client = await createClient(harness.socketPath);
    await hello(client);
    const dispatch = vi
      .spyOn(Dispatcher.prototype, "dispatch")
      .mockResolvedValue({ routed: true } as never);

    const handed = [];
    for (const operation of PASS_THROUGH) {
      dispatch.mockClear();
      const answer = await client.request(operation, { marker: operation });
      handed.push({
        operation,
        answered: answer.ok,
        calls: dispatch.mock.calls.map(([name, input]) => ({ name, input })),
      });
    }
    expect(handed).toEqual(
      PASS_THROUGH.map((operation) => ({
        operation,
        answered: true,
        calls: [{ name: operation, input: { marker: operation } }],
      })),
    );
    await client.close();
  });
});
