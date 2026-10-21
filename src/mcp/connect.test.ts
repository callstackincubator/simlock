// why: `main.test.ts` mocks `connect.js`, so this loop has no other test — this file holds the
// default startup deadline it shares with the CLI's own loop (#663).
import { describe, expect, it } from "vitest";

import { FakeClock, FakeDaemonLauncher, IpcError, MemoryIpcTransport } from "../ports/index.js";
import { connectWithAutoLaunch } from "./connect.js";

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("MCP: auto-launch's startup deadline (#663)", () => {
  it("waits for a daemon it auto-launched to the shared 20 s deadline and past it reports a failed start as DAEMON_STARTUP_FAILED", async () => {
    // why: nothing ever listens, so this loop can end only on its deadline; 19.95 s and 20 s
    // straddle that bound (testing rule 10) and are written as numbers, not read back from the
    // constant, so a loop that falls back to a bound of its own goes red here.
    const clock = new FakeClock(0);
    const launcher = new FakeDaemonLauncher();
    let done = false;
    let connected = false;
    const connecting = connectWithAutoLaunch({
      clock,
      ipc: new MemoryIpcTransport(),
      launcher,
      principal: "agent-1",
      socketPath: "/simlock/daemon.sock",
    });
    void connecting.then(
      () => {
        connected = true;
        done = true;
      },
      () => {
        done = true;
      },
    );
    await settle();
    while (!done && clock.now() < 19_950) {
      clock.advance(50);
      await settle();
      await settle();
    }
    expect(connected, "it connected although nothing was ever listening").toBe(false);
    expect(
      done,
      `gave up at ${String(clock.now())}ms, before the 20 s deadline it defaults to`,
    ).toBe(false);
    clock.advance(50);
    await settle();
    await settle();
    expect(
      done,
      `still polling at ${String(clock.now())}ms, past the 20 s deadline it defaults to`,
    ).toBe(true);
    await expect(connecting).rejects.toMatchObject({
      code: "DAEMON_STARTUP_FAILED",
      message: expect.stringContaining("Timed out starting simlock daemon"),
    });
    expect(launcher.launches).toBe(1);
  });
});

describe("MCP: auto-launch's daemon that exits while starting (#760)", () => {
  const fatal = (message: string): string =>
    `${JSON.stringify({ message: "Daemon failed to start", fields: { message } })}\n`;

  // why: the winner is not listening yet at the first poll after the launch, so the loop reaches
  // the launched daemon's exit before it finds the winner.
  class LateWinnerTransport extends MemoryIpcTransport {
    connects = 0;
    override async connect(endpoint: string): ReturnType<MemoryIpcTransport["connect"]> {
      this.connects += 1;
      if (this.connects === 2) {
        throw new IpcError("endpoint-not-found", `No IPC endpoint at ${endpoint}`, undefined);
      }
      return super.connect(endpoint);
    }
  }

  async function answerHello(ipc: MemoryIpcTransport): Promise<void> {
    await ipc.listen("/simlock/daemon.sock", (connection) => {
      connection.onData((chunk) => {
        for (const line of chunk.split("\n").filter((value) => value !== "")) {
          const frame = JSON.parse(line) as { id: number; type: string };
          if (frame.type !== "hello") continue;
          void connection.write(
            `${JSON.stringify({
              id: frame.id,
              ok: true,
              payload: {
                daemonProtocolRange: { max: 3, min: 3 },
                principal: "agent-1",
                protocolVersion: 3,
                role: "agent",
                version: "0.3.0",
              },
            })}\n`,
          );
        }
      });
    });
  }

  it("rejects with the start error as soon as the launched daemon exits, and connects when another daemon answers", async () => {
    const outcome = async (message: string, winner: boolean) => {
      const clock = new FakeClock(0);
      const ipc = new LateWinnerTransport();
      const launcher = new FakeDaemonLauncher(winner ? () => answerHello(ipc) : undefined, {
        exit: { code: 1, signal: null },
        output: fatal(message),
      });
      const result = await Promise.race([
        connectWithAutoLaunch({
          clock,
          ipc,
          launcher,
          principal: "agent-1",
          socketPath: "/simlock/daemon.sock",
        }).then(
          (client) => `connected as ${client.role}`,
          (error: unknown) => `${(error as { code: string }).code}: ${(error as Error).message}`,
        ),
        settle()
          .then(settle)
          .then(settle)
          .then(() => "still waiting"),
      ]);
      return { result, elapsed: clock.now() };
    };
    expect({
      refused: await outcome("Found state.json", false),
      raced: await outcome("Simlock daemon is already running", true),
    }).toEqual({
      refused: {
        result: "DAEMON_STARTUP_FAILED: The daemon could not start: Found state.json",
        elapsed: 0,
      },
      raced: { result: "connected as agent", elapsed: 0 },
    });
  });

  it("names the exit code when the launched daemon's output cannot be read", async () => {
    const clock = new FakeClock(0);
    const launcher = {
      launch: async () => ({
        exited: Promise.resolve({ code: 3, signal: null }),
        readOutput: async (): Promise<string> => {
          throw new Error("daemon.log was replaced");
        },
      }),
    };
    const result = await connectWithAutoLaunch({
      clock,
      ipc: new MemoryIpcTransport(),
      launcher,
      principal: "agent-1",
      socketPath: "/simlock/daemon.sock",
    }).then(
      () => "connected",
      (error: unknown) => (error as Error).message,
    );
    expect(result).toBe("The daemon exited with code 3 while starting; see `simlock daemon logs`");
  });
});

// why: the stdio host mocks this connector; this seam can force a socket to close before hello
// both in the launch loop and in the final connection after the launched process exits.
describe("MCP: a socket closed before hello (#790)", () => {
  it("reports only a closed handshake after launching the daemon as a failed start", async () => {
    for (const scenario of [
      {
        launch: false,
        afterExit: false,
        refused: false,
        code: "DAEMON_CONNECTION_LOST",
        connects: 1,
      },
      {
        launch: true,
        afterExit: false,
        refused: false,
        code: "DAEMON_STARTUP_FAILED",
        connects: 2,
      },
      { launch: true, afterExit: true, refused: false, code: "DAEMON_STARTUP_FAILED", connects: 3 },
      {
        launch: true,
        afterExit: false,
        refused: true,
        code: "ADMIN_AUTHENTICATION_FAILED",
        connects: 2,
      },
      {
        launch: true,
        afterExit: true,
        refused: true,
        code: "ADMIN_AUTHENTICATION_FAILED",
        connects: 3,
      },
    ]) {
      const transport = new MemoryIpcTransport();
      const socketPath = "/simlock/daemon.sock";
      let accepted = 0;
      const listen = () =>
        transport.listen(socketPath, (connection) => {
          accepted += 1;
          if (scenario.refused) {
            connection.onData((chunk) => {
              const frame = JSON.parse(chunk.trim()) as { id: number };
              void connection.write(
                `${JSON.stringify({
                  id: frame.id,
                  ok: false,
                  error: { code: "ADMIN_AUTHENTICATION_FAILED", message: "refused" },
                })}\n`,
              );
            });
          } else {
            void connection.close();
          }
        });
      if (!scenario.launch) await listen();
      const launcher = new FakeDaemonLauncher(
        async () => {
          await listen();
        },
        { exit: { code: 1, signal: null } },
      );
      let connects = 0;
      const result = await connectWithAutoLaunch({
        clock: new FakeClock(0),
        ipc: {
          connect: async (endpoint) => {
            connects += 1;
            if (scenario.afterExit && connects === 2) {
              throw new IpcError("endpoint-not-found", "not yet listening", undefined);
            }
            return transport.connect(endpoint);
          },
        },
        launcher,
        principal: "agent-1",
        socketPath,
      }).then(
        () => ({ code: "connected" }),
        (error: unknown) => error,
      );
      expect(result, JSON.stringify(scenario)).toMatchObject({ code: scenario.code });
      expect(launcher.launches).toBe(scenario.launch ? 1 : 0);
      expect(connects).toBe(scenario.connects);
      expect(accepted).toBe(1);
    }
  });
});
