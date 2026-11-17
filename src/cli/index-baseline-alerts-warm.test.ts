import { describe, expect, it } from "vitest";
import { FakeClock } from "../ports/index.js";
import { SimlockError } from "../contract/index.js";
import type { SimlockAdminClient } from "../simlock-client/client.js";
import { runCli } from "./index.js";
import { fakeClient, outputCapture } from "./test-index.js";

describe("CLI: alerts test (ADR 0035 §1)", () => {
  const USAGE = "Usage: simlock alerts test <destination> [--json]\n";
  const errorLine = (stderr: string): unknown => JSON.parse(stderr.trim().split("\n").at(-1) ?? "");

  async function runAlerts(argv: string[], overrides: Partial<SimlockAdminClient> = {}) {
    const output = outputCapture();
    const inputs: unknown[] = [];
    let connected = false;
    const code = await runCli(
      argv,
      output.environmentWith({
        connectAdmin: async () => {
          connected = true;
          return fakeClient({
            testAlertDestination: (input) => {
              inputs.push(input);
              return Promise.resolve({ destination: input.destination, status: 204 });
            },
            ...overrides,
          });
        },
      }),
    );
    return { code, connected, inputs, stderr: output.stderr, stdout: output.stdout };
  }

  it("simlock alerts test prints the sent line, --json prints the output, a missing name prints the Expected line, simlock alerts and --help print the usage, and an unknown subcommand is a usage error", async () => {
    const sent = await runAlerts(["alerts", "test", "ops-slack"]);
    expect([sent.code, sent.stdout, sent.inputs]).toEqual([
      0,
      "Sent a test message to ops-slack: HTTP 204\n",
      [{ destination: "ops-slack" }],
    ]);

    const json = await runAlerts(["alerts", "test", "ops-slack", "--json"]);
    expect([json.code, json.stdout]).toEqual([0, '{"destination":"ops-slack","status":204}\n']);

    for (const argv of [["alerts"], ["alerts", "--help"], ["alerts", "test", "--help"]]) {
      const usage = await runAlerts(argv);
      expect([usage.code, usage.stdout, usage.stderr, usage.connected]).toEqual([
        0,
        USAGE,
        "",
        false,
      ]);
    }

    for (const [argv, message] of [
      [["alerts", "test"], "Expected destination (run `simlock --help` for usage)"],
      [["alerts", "foo"], "Unknown alerts command: foo (run `simlock --help` for usage)"],
    ] as const) {
      const refused = await runAlerts([...argv]);
      expect(refused.code).toBe(2);
      expect(refused.connected).toBe(false);
      expect(JSON.parse(refused.stderr)).toEqual({ error: { code: "USAGE", message } });
    }
  });

  it("simlock alerts test exits 1 on ALERT_SEND_FAILED and 12 on UNKNOWN_ALERT_DESTINATION with the error line", async () => {
    const failed = await runAlerts(["alerts", "test", "ops-slack"], {
      testAlertDestination: () =>
        Promise.reject(
          new SimlockError("ALERT_SEND_FAILED", "transport", "ops-slack answered HTTP 404", {
            destination: "ops-slack",
            status: 404,
          }),
        ),
    });
    expect([failed.code, failed.stdout, errorLine(failed.stderr)]).toEqual([
      1,
      "",
      { error: { code: "ALERT_SEND_FAILED", message: "ops-slack answered HTTP 404" } },
    ]);

    const unknown = await runAlerts(["alerts", "test", "nope"], {
      testAlertDestination: () =>
        Promise.reject(
          new SimlockError("UNKNOWN_ALERT_DESTINATION", "domain", "No alert destination named", {
            destination: "nope",
          }),
        ),
    });
    expect([unknown.code, errorLine(unknown.stderr)]).toEqual([
      12,
      { error: { code: "UNKNOWN_ALERT_DESTINATION", message: "No alert destination named" } },
    ]);
  });
});

describe("CLI: baseline save", () => {
  const saved = (overrides: Record<string, unknown> = {}) => ({
    baseline: {
      mode: "full",
      model: "Pixel 9",
      name: "checkout",
      osVersion: "36",
      platform: "android",
      savedAt: "2026-11-02T13:40:00.000Z",
      version: 1,
      ...overrides,
    },
    leaseId: "L1",
  });

  async function runSave(argv: string[], answer = saved()) {
    const output = outputCapture();
    const inputs: unknown[] = [];
    let connected = false;
    const code = await runCli(
      argv,
      output.environmentWith({
        connectAdmin: async () => {
          connected = true;
          return fakeClient({
            saveBaseline: (input) => {
              inputs.push(input);
              return Promise.resolve(answer as never);
            },
          });
        },
      }),
    );
    return { code, connected, inputs, stderr: output.stderr, stdout: output.stdout };
  }

  it("simlock baseline save sends the name, lease and note and prints the baseline's version, spec and size with the lease it ended, and refuses a missing --lease as USAGE", async () => {
    const android = await runSave(
      ["baseline", "save", "checkout", "--lease", "L1", "--note", "app 4.2, test user"],
      saved({ imageTag: "google_apis", sizeBytes: 4_800_000_000 }),
    );
    expect([android.code, android.stdout, android.inputs]).toEqual([
      0,
      "Saved baseline checkout v1: android Pixel 9, Android 36 (google_apis), full, 4.8 GB. Lease L1 ended.\n",
      [{ leaseId: "L1", name: "checkout", note: "app 4.2, test user" }],
    ]);

    const ios = await runSave(
      ["baseline", "save", "login", "--lease", "L5"],
      saved({
        mode: "slim",
        model: "iPhone 17",
        name: "login",
        osVersion: "27.0",
        platform: "ios",
        sizeBytes: 3_100_000_000,
      }),
    );
    expect(ios.stdout).toBe(
      "Saved baseline login v1: ios iPhone 17, iOS 27.0, slim, 3.1 GB. Lease L1 ended.\n",
    );
    expect(ios.inputs).toEqual([{ leaseId: "L5", name: "login" }]);

    const small = await runSave(
      ["baseline", "save", "tiny", "--lease", "L1"],
      saved({ sizeBytes: 250_000_000 }),
    );
    expect(small.stdout).toContain("full, 250.0 MB. Lease L1 ended.");
    const uncounted = await runSave(["baseline", "save", "tiny", "--lease", "L1"], saved());
    expect(uncounted.stdout).toBe(
      "Saved baseline checkout v1: android Pixel 9, Android 36, full. Lease L1 ended.\n",
    );

    const missing = await runSave(["baseline", "save", "checkout"]);
    expect([missing.code, missing.connected, missing.stdout]).toEqual([2, false, ""]);
    expect(JSON.parse(missing.stderr)).toMatchObject({ error: { code: "USAGE" } });

    const twoNames = await runSave(["baseline", "save", "checkout", "other", "--lease", "L1"]);
    expect([twoNames.code, twoNames.connected, twoNames.inputs]).toEqual([2, false, []]);
  });
});

describe("CLI: baseline list", () => {
  const checkout = {
    imageTag: "google_apis",
    mode: "full",
    model: "Pixel 9",
    name: "checkout",
    osVersion: "36",
    platform: "android",
    savedAt: new Date(2026, 10, 2, 13, 40).toISOString(),
    sizeBytes: 4_900_000_000,
    version: 2,
  } as const;
  const login = {
    mode: "slim",
    model: "iPhone 17",
    name: "login",
    note: "signed in",
    osVersion: "27.0",
    platform: "ios",
    savedAt: new Date(2026, 10, 1, 9, 12).toISOString(),
    staleReason: "runtime com.apple.CoreSimulator.SimRuntime.iOS-27-0 is not installed",
    version: 1,
  } as const;

  async function runList(argv: string[], baselines: readonly (typeof checkout | typeof login)[]) {
    const output = outputCapture();
    const code = await runCli(
      argv,
      output.environmentWith({
        connectAdmin: async () =>
          fakeClient({ listBaselines: () => Promise.resolve({ baselines: [...baselines] }) }),
      }),
    );
    return { code, stderr: output.stderr, stdout: output.stdout };
  }

  it("simlock baseline list prints a table of each baseline with a - for an uncounted size and its stale reason under the row, --json the baselines, and says when there are none", async () => {
    const table = await runList(["baseline", "list"], [checkout, login]);
    expect([table.code, table.stdout]).toEqual([
      0,
      [
        "NAME      VERSION  PLATFORM  MODEL      OS    MODE  IMAGE        SIZE    SAVED             NOTE",
        "checkout  2        android   Pixel 9    36    full  google_apis  4.9 GB  2026-11-02 13:40",
        "login     1        ios       iPhone 17  27.0  slim  -            -       2026-11-01 09:12  signed in",
        "  stale: runtime com.apple.CoreSimulator.SimRuntime.iOS-27-0 is not installed",
        "",
      ].join("\n"),
    ]);

    const json = await runList(["baseline", "list", "--json"], [checkout, login]);
    expect([json.code, JSON.parse(json.stdout)]).toEqual([0, { baselines: [checkout, login] }]);

    const none = await runList(["baseline", "list"], []);
    expect([none.code, none.stdout]).toEqual([0, "No baselines on this worker.\n"]);
  });
});

describe("CLI: baselines through a gateway (#1208)", () => {
  const GATEWAY = {
    daemonHome: { dataDirectory: "/simlock/gateway", gatewayPresent: true, role: "gateway" },
  } as const;
  const checkout = {
    imageTag: "google_apis",
    mode: "full",
    model: "Pixel 9",
    name: "checkout",
    note: "app 4.2, test user",
    osVersion: "36",
    platform: "android",
    savedAt: new Date(2026, 10, 2, 13, 10).toISOString(),
    sizeBytes: 4_800_000_000,
    version: 2,
    workerId: "wrk_a",
  } as const;
  const smoke = {
    mode: "slim",
    model: "iPhone 17",
    name: "smoke",
    osVersion: "27.0",
    platform: "ios",
    savedAt: new Date(2026, 9, 30, 9, 2).toISOString(),
    staleReason: "runtime com.apple.CoreSimulator.SimRuntime.iOS-27-0 is not installed",
    version: 1,
    workerId: "wrk_a",
  } as const;

  it("simlock worker list prints a worker's Baselines line, its image tag in brackets and a stale one marked, none for a worker without any, and no line for one that has not read them", async () => {
    const output = outputCapture();
    const worker = { connection: "connected", drained: false, lastSeenAt: 1 } as const;
    await runCli(
      ["worker", "list"],
      output.environmentWith({
        clock: new FakeClock(1_000),
        connectAdmin: async () =>
          fakeClient({
            listWorkers: () =>
              Promise.resolve({
                workers: [
                  { ...worker, baselines: [checkout, smoke], id: "wrk_a" },
                  { ...worker, baselines: [], id: "wrk_b" },
                  { ...worker, health: "starting", id: "wrk_c" },
                ],
              } as never),
          }),
      }),
    );

    expect(output.stdout.split("\n").filter((line) => /^\s+Baselines:/.test(line))).toEqual([
      "  Baselines: checkout v2: android Pixel 9, Android 36 (google_apis), full; smoke v1: ios iPhone 17, iOS 27.0, slim, stale",
      "  Baselines: none",
    ]);
  });

  it("simlock --gateway baseline list puts the worker first in each row, and says when no worker holds a baseline", async () => {
    const run = async (baselines: readonly (typeof checkout | typeof smoke)[]) => {
      const output = outputCapture();
      await runCli(
        ["--gateway", "baseline", "list"],
        output.environmentWith({
          ...GATEWAY,
          connectAdmin: async () =>
            fakeClient({ listBaselines: () => Promise.resolve({ baselines: [...baselines] }) }),
        }),
      );
      return output.stdout;
    };

    expect(await run([checkout, smoke])).toBe(
      [
        "WORKER  NAME      VERSION  PLATFORM  MODEL      OS    MODE  IMAGE        SIZE    SAVED             NOTE",
        "wrk_a   checkout  2        android   Pixel 9    36    full  google_apis  4.8 GB  2026-11-02 13:10  app 4.2, test user",
        "wrk_a   smoke     1        ios       iPhone 17  27.0  slim  -            -       2026-10-30 09:02",
        "  stale: runtime com.apple.CoreSimulator.SimRuntime.iOS-27-0 is not installed",
        "",
      ].join("\n"),
    );
    expect(await run([])).toBe("No baselines on any worker.\n");
  });

  it("simlock --gateway baseline remove --worker sends the worker, asks and prints ending in from <worker id>, and without --worker asks nothing and sends the remove", async () => {
    const run = async (argv: string[]) => {
      const output = outputCapture();
      const sent: unknown[] = [];
      const questions: string[] = [];
      await runCli(
        ["--gateway", ...argv],
        output.environmentWith({
          ...GATEWAY,
          confirm: async (question) => {
            questions.push(question);
            return true;
          },
          connectAdmin: async () =>
            fakeClient({
              listBaselines: () =>
                Promise.resolve({
                  baselines: [{ ...smoke, version: 3, workerId: "wrk_b" }, smoke],
                }),
              removeBaseline: (input) => {
                sent.push(input);
                return Promise.resolve({ deletedDevices: [], name: input.name, versions: [1] });
              },
            }),
        }),
      );
      return { questions, sent, stdout: output.stdout };
    };

    expect(await run(["baseline", "remove", "smoke", "--worker", "wrk_a"])).toEqual({
      questions: ["Remove baseline smoke v1 from wrk_a? [y/N] "],
      sent: [{ name: "smoke", workerId: "wrk_a" }],
      stdout: "Removed baseline smoke v1 from wrk_a.\n",
    });
    expect(await run(["baseline", "remove", "smoke"])).toMatchObject({
      questions: [],
      sent: [{ name: "smoke" }],
    });
  });
});

describe("CLI: baseline remove", () => {
  const login = {
    mode: "slim",
    model: "iPhone 17",
    name: "login",
    osVersion: "27.0",
    platform: "ios",
    savedAt: new Date(2026, 10, 1, 9, 12).toISOString(),
    version: 1,
  } as const;

  async function runRemove(
    argv: string[],
    options: { confirm?: ((question: string) => Promise<boolean>) | undefined; deleted?: string[] },
  ) {
    const output = outputCapture();
    const removed: unknown[] = [];
    const code = await runCli(
      argv,
      output.environmentWith({
        confirm: options.confirm,
        connectAdmin: async () =>
          fakeClient({
            listBaselines: () => Promise.resolve({ baselines: [login] }),
            removeBaseline: (input) => {
              removed.push(input);
              return Promise.resolve({
                deletedDevices: options.deleted ?? [],
                name: input.name,
                versions: [1],
              });
            },
          }),
      }),
    );
    return { code, removed, stderr: output.stderr, stdout: output.stdout };
  }

  it("simlock baseline remove asks Remove baseline <name> v<n>? first, removes with --yes or an answered yes and prints how many idle devices it deleted, and refuses with USAGE when there is no terminal or the answer is no", async () => {
    const questions: string[] = [];
    const asked = await runRemove(["baseline", "remove", "login"], {
      confirm: async (question) => {
        questions.push(question);
        return true;
      },
    });
    expect([asked.code, asked.stdout, asked.removed, questions]).toEqual([
      0,
      "Removed baseline login v1.\n",
      [{ name: "login" }],
      ["Remove baseline login v1? [y/N] "],
    ]);

    const yes = await runRemove(["baseline", "remove", "login", "--yes"], {
      confirm: async () => {
        throw new Error("--yes must not ask");
      },
      deleted: ["dev_1"],
    });
    expect(yes.stdout).toBe("Removed baseline login v1. Deleted 1 idle device made from it.\n");
    const many = await runRemove(["baseline", "remove", "login", "--yes"], {
      deleted: ["dev_1", "dev_2"],
    });
    expect(many.stdout).toBe("Removed baseline login v1. Deleted 2 idle devices made from it.\n");

    for (const confirm of [undefined, async () => false]) {
      const refused = await runRemove(["baseline", "remove", "login"], { confirm });
      expect([refused.code, refused.removed, refused.stdout]).toEqual([2, [], ""]);
      expect(JSON.parse(refused.stderr.trim().split("\n").at(-1) ?? "")).toEqual({
        error: { code: "USAGE", message: "baseline remove requires confirmation or --yes" },
      });
    }
  });
});

describe("CLI: warm forget", () => {
  const USAGE =
    "Usage: simlock warm forget <ios|android> <model> [<os>] [--mode <slim|full>] [--image-tag <tag>] [--json]\n";
  const pixel = { model: "Pixel", mode: "full", osVersion: "36", platform: "android" } as const;

  const checkoutKind = { ...pixel, baseline: "checkout" } as const;

  async function runWarm(
    argv: string[],
    forgotten: (typeof pixel | typeof checkoutKind)[] = [pixel],
  ) {
    const output = outputCapture();
    const inputs: unknown[] = [];
    let connected = false;
    const code = await runCli(
      argv,
      output.environmentWith({
        connectAdmin: async () => {
          connected = true;
          return fakeClient({
            forgetWarmKind: (input) => {
              inputs.push(input);
              return Promise.resolve({ forgotten });
            },
          });
        },
      }),
    );
    return { code, connected, inputs, stderr: output.stderr, stdout: output.stdout };
  }

  it("simlock warm forget sends the platform, model, OS, mode and image tag it was given and prints each kind forgotten, or that none was learned", async () => {
    const forgot = await runWarm(["warm", "forget", "android", "Pixel"]);
    expect([forgot.code, forgot.stdout, forgot.inputs]).toEqual([
      0,
      "Forgot android Pixel 36 (full).\nIts idle devices are no longer kept warm: the idle rules shut them down and delete them, unless a configured warmPool.targets entry keeps them.\n",
      [{ model: "Pixel", platform: "android" }],
    ]);

    const narrowed = await runWarm(
      ["warm", "forget", "android", "Pixel", "36", "--mode", "full", "--image-tag", "google_apis"],
      [],
    );
    expect(narrowed.stdout).toBe(
      "The warm pool has learned no kind matching android Pixel 36 (full, google_apis).\n",
    );
    expect(narrowed.inputs).toEqual([
      {
        imageTag: "google_apis",
        mode: "full",
        model: "Pixel",
        osVersion: "36",
        platform: "android",
      },
    ]);

    const named = await runWarm(["warm", "forget", "android", "Pixel"], [checkoutKind]);
    expect(named.stdout).toContain("Forgot android Pixel 36 (full, baseline checkout).\n");

    const none = await runWarm(["warm", "forget", "ios", "iPhone 16"], []);
    expect([none.code, none.stdout]).toEqual([
      0,
      "The warm pool has learned no kind matching ios iPhone 16.\n",
    ]);

    const json = await runWarm(["warm", "forget", "android", "Pixel", "--json"]);
    expect([json.code, JSON.parse(json.stdout)]).toEqual([0, { forgotten: [pixel] }]);
  });

  it("simlock warm and --help print the usage without connecting; a bad platform, a missing model, extra words, a bad --mode and an unknown subcommand are usage errors", async () => {
    for (const argv of [["warm"], ["warm", "--help"], ["warm", "forget", "--help"]]) {
      const usage = await runWarm(argv);
      expect([usage.code, usage.stdout, usage.stderr, usage.connected]).toEqual([
        0,
        USAGE,
        "",
        false,
      ]);
    }

    for (const [argv, message] of [
      [["warm", "forget", "tvos", "Pixel"], "warm forget needs a platform first: ios or android"],
      [["warm", "forget", "android"], "warm forget takes <platform> <model> and an optional <os>"],
      [
        ["warm", "forget", "android", "Pixel", "36", "extra"],
        "warm forget takes <platform> <model> and an optional <os>",
      ],
      [["warm", "forget", "android", "Pixel", "--mode", "tiny"], "--mode is slim or full"],
      [["warm", "boot"], "Unknown warm command: boot"],
    ] as const) {
      const refused = await runWarm([...argv]);
      expect([refused.code, refused.connected]).toEqual([2, false]);
      expect(JSON.parse(refused.stderr)).toEqual({
        error: { code: "USAGE", message: `${message} (run \`simlock --help\` for usage)` },
      });
    }
  });
});
