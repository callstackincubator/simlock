import { createServer, Server } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { setUp as setUpAgentDeviceRig } from "./test-support.js";
import type { RelayTarget } from "../daemon/relay.js";
import type { DaemonServer } from "../daemon/server.js";
import { startFleet } from "../daemon/test-relay-support.js";
import { removeDirectory } from "../test-support/remove-directory.js";

interface Thief {
  readonly port: () => number | undefined;
  readonly release: () => Promise<void>;
}

// why: no seam sits between a rig's port pick and its daemon's bind, so this stands in for another
// process of a parallel lane: the next TCP listener closed in this process has its port taken at once.
function takeNextReleasedPort(): Thief {
  const original = Server.prototype.close;
  let thief: Server | undefined;
  let taken: number | undefined;
  Server.prototype.close = function close(this: Server, callback?: (error?: Error) => void) {
    const address = this.address();
    if (typeof address !== "object" || address === null) return original.call(this, callback);
    Server.prototype.close = original;
    return original.call(this, (error?: Error) => {
      const squatter = createServer();
      squatter.listen(address.port, "127.0.0.1", () => {
        thief = squatter;
        taken = address.port;
        callback?.(error);
      });
    });
  } as typeof Server.prototype.close;
  return {
    port: () => taken,
    release: async () => {
      Server.prototype.close = original;
      await new Promise<void>((resolve) =>
        thief === undefined ? resolve() : thief.close(() => resolve()),
      );
    },
  };
}

async function answersHealth(port: number): Promise<boolean> {
  return (await fetch(`http://127.0.0.1:${String(port)}/v1/healthz`)).ok;
}

describe("the shared daemon test rigs", { timeout: 30_000 }, () => {
  const daemons: DaemonServer[] = [];
  const directories: string[] = [];
  const target: RelayTarget = () => Promise.resolve(new Response("ok"));

  afterEach(async () => {
    await Promise.all(daemons.splice(0).map((daemon) => daemon.stop("test")));
    // why: on Windows the fleet worker's directory stays busy for a few seconds after its daemon stopped, longer than `removeDirectory` waits, so the removal is tried again until it goes through.
    await Promise.all(
      directories
        .splice(0)
        .map((directory) =>
          vi.waitFor(() => removeDirectory(directory), { interval: 250, timeout: 10_000 }),
        ),
    );
  });

  it("start their daemon on another port when another listener takes the port they picked before the daemon binds it", async () => {
    const rigs: Record<string, () => Promise<number>> = {
      "agent-device setUp": async () => Number(new URL((await setUpAgentDeviceRig()).origin).port),
      startFleet: async () => (await startFleet({ daemons, directories, target })).port,
    };
    const outcomes: Record<string, string> = {};
    for (const [name, start] of Object.entries(rigs)) {
      const thief = takeNextReleasedPort();
      try {
        const port = await start();
        outcomes[name] =
          port !== thief.port() && (await answersHealth(port)) ? "started" : `port ${String(port)}`;
      } catch (error) {
        outcomes[name] = String((error as { code?: unknown }).code ?? error);
      } finally {
        await thief.release();
      }
    }

    expect(outcomes).toEqual({ "agent-device setUp": "started", startFleet: "started" });
  });
});
