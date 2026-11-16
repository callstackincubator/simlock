import { describe, expect, it } from "vitest";
import { SimlockError } from "../contract/index.js";
import { runCli } from "./index.js";
import { fakeClient, outputCapture } from "./test-index.js";

describe("CLI: catalog", () => {
  it("prints a model named after an Object.prototype member with no paired runtime", async () => {
    const output = outputCapture();
    const environment = output.environmentWith({
      connectAdmin: async () =>
        fakeClient({
          getCatalog: () =>
            Promise.resolve({
              platforms: [
                {
                  modelAliases: {},
                  classDefaults: {},
                  modelClasses: {},
                  modelRuntimes: {},
                  models: ["constructor"],
                  platform: "ios",
                  runtimes: [],
                },
              ],
            }),
        }),
    });

    await expect(runCli(["catalog"], environment)).resolves.toBe(0);

    expect(output.stdout).toContain("    (no class):\n      constructor: (no paired runtime)\n");
  });

  it("prints (none) for a platform with no models", async () => {
    const output = outputCapture();
    const environment = output.environmentWith({
      connectAdmin: async () =>
        fakeClient({
          getCatalog: () =>
            Promise.resolve({
              platforms: [
                {
                  modelAliases: {},
                  classDefaults: {},
                  modelClasses: {},
                  modelRuntimes: {},
                  models: [],
                  platform: "android",
                  runtimes: ["35"],
                },
              ],
            }),
        }),
    });

    await expect(runCli(["catalog"], environment)).resolves.toBe(0);

    expect(output.stdout).toBe(
      ["Platform: android", "  Runtimes: 35 (default: (none))", "  Models: (none)", ""].join("\n"),
    );
  });

  it("prints each model with the runtimes it pairs with", async () => {
    const output = outputCapture();
    const environment = output.environmentWith({
      connectAdmin: async () =>
        fakeClient({
          getCatalog: () =>
            Promise.resolve({
              platforms: [
                {
                  defaultRuntime: "26.0",
                  modelAliases: {},
                  classDefaults: {},
                  modelClasses: {},
                  modelRuntimes: {
                    "iPhone 16": ["18.4", "26.0"],
                    "iPhone 8": [],
                    "iPhone XS": ["18.4"],
                  },
                  models: ["iPhone 16", "iPhone XS", "iPhone 8"],
                  platform: "ios",
                  runtimes: ["18.4", "26.0"],
                },
              ],
            }),
        }),
    });

    await expect(runCli(["catalog"], environment)).resolves.toBe(0);

    expect(output.stdout).toBe(
      [
        "Platform: ios",
        "  Runtimes: 18.4, 26.0 (default: 26.0)",
        "  Models:",
        "    (no class):",
        "      iPhone 16: 18.4, 26.0",
        "      iPhone XS: 18.4",
        "      iPhone 8: (no paired runtime)",
        "",
      ].join("\n"),
    );
  });

  it("prints each model under its class in the order of the enum, and an unclassed model under (no class)", async () => {
    const catalog = {
      defaultRuntime: "26.0",
      classDefaults: { phone: "iPhone 17", tablet: "iPad Pro" },
      modelAliases: { "iPhone 17": ["iphone-17", "i17"] },
      modelClasses: {
        "Apple TV 4K": "tv" as const,
        "Apple Watch Series 11 (46mm)": "watch" as const,
        "iPad Pro": "tablet" as const,
        "iPhone 17": "phone" as const,
        "iPhone 16": "phone" as const,
      },
      modelRuntimes: {
        "Apple TV 4K": ["26.0"],
        "Apple Watch Series 11 (46mm)": ["26.0"],
        "iPad Pro": ["26.0"],
        "iPhone 16": ["26.0"],
        "iPhone 17": ["26.0"],
        Mystery: [],
      },
      models: [
        "Mystery",
        "Apple Watch Series 11 (46mm)",
        "iPhone 17",
        "Apple TV 4K",
        "iPad Pro",
        "iPhone 16",
      ],
      platform: "ios" as const,
      runtimes: ["26.0"],
      customModels: ["iPhone 16"],
    };
    const output = outputCapture();
    const environment = output.environmentWith({
      connectAdmin: async () =>
        fakeClient({ getCatalog: () => Promise.resolve({ platforms: [catalog] }) }),
    });

    await expect(runCli(["catalog"], environment)).resolves.toBe(0);

    expect(output.stdout).toBe(
      [
        "Platform: ios",
        "  Runtimes: 26.0 (default: 26.0)",
        "  Models:",
        "    phone (default: iPhone 17):",
        "      iPhone 17: 26.0",
        "        Other names: iphone-17, i17",
        "      iPhone 16 (custom): 26.0",
        "    tablet (default: iPad Pro):",
        "      iPad Pro: 26.0",
        "    watch (default: none):",
        "      Apple Watch Series 11 (46mm): 26.0",
        "    tv (default: none):",
        "      Apple TV 4K: 26.0",
        "    (no class):",
        "      Mystery: (no paired runtime)",
        "",
      ].join("\n"),
    );
  });

  it.each([
    {
      field: "classDefaults",
      catalog: {
        classDefaults: { phone: "Pixel 9", tv: "Not Even Listed" },
        modelAliases: {},
        modelClasses: {},
        modelRuntimes: {},
        models: [],
        platform: "android" as const,
        runtimes: [],
      },
    },
    {
      field: "modelClasses",
      catalog: {
        modelAliases: {},
        classDefaults: {},
        modelClasses: { "Pixel 8": "phone" as const, "Odd One": "tv" as const },
        modelRuntimes: {},
        models: ["Pixel 8"],
        platform: "android" as const,
        runtimes: [],
      },
    },
  ])("carries $field in --json as received", async ({ catalog }) => {
    const output = outputCapture();
    const environment = output.environmentWith({
      connectAdmin: async () =>
        fakeClient({ getCatalog: () => Promise.resolve({ platforms: [catalog] }) }),
    });

    await expect(runCli(["catalog", "--json"], environment)).resolves.toBe(0);

    expect(JSON.parse(output.stdout)).toEqual({ platforms: [catalog] });
  });

  it("prints the Android default image tag on the line after Runtimes when set, and carries it in --json only then", async () => {
    const android = {
      classDefaults: {},
      modelAliases: {},
      modelClasses: {},
      modelRuntimes: {},
      models: [],
      platform: "android" as const,
      runtimes: ["36"],
    };
    const run = async (catalog: object, extra: readonly string[]) => {
      const output = outputCapture();
      const environment = output.environmentWith({
        connectAdmin: async () =>
          fakeClient({
            getCatalog: () => Promise.resolve({ platforms: [catalog as typeof android] }),
          }),
      });
      await expect(
        runCli(["catalog", "--platform", "android", ...extra], environment),
      ).resolves.toBe(0);
      return output.stdout;
    };
    const tagged = { ...android, defaultImageTag: "google_apis_playstore" };

    expect(await run(tagged, [])).toBe(
      [
        "Platform: android",
        "  Runtimes: 36 (default: (none))",
        "  Default image tag: google_apis_playstore",
        "  Models: (none)",
        "",
      ].join("\n"),
    );
    expect(await run(android, [])).not.toContain("Default image tag");
    expect(JSON.parse(await run(tagged, ["--json"])).platforms[0].defaultImageTag).toBe(
      "google_apis_playstore",
    );
    expect(JSON.parse(await run(android, ["--json"])).platforms[0]).not.toHaveProperty(
      "defaultImageTag",
    );
  });

  it("prints (none) for a platform that has images but none installed", async () => {
    const output = outputCapture();
    const environment = output.environmentWith({
      connectAdmin: async () =>
        fakeClient({
          getCatalog: () =>
            Promise.resolve({
              platforms: [
                {
                  images: [],
                  modelAliases: {},
                  classDefaults: {},
                  modelClasses: {},
                  modelRuntimes: {},
                  models: [],
                  platform: "android",
                  runtimes: [],
                },
              ],
            }),
        }),
    });

    await expect(runCli(["catalog"], environment)).resolves.toBe(0);

    expect(output.stdout).toBe(
      [
        "Platform: android",
        "  Runtimes: (none) (default: (none))",
        "  Models: (none)",
        "  Images: (none)",
        "",
      ].join("\n"),
    );
  });

  it("prints a model's other names and each image", async () => {
    const output = outputCapture();
    const environment = output.environmentWith({
      connectAdmin: async () =>
        fakeClient({
          getCatalog: () =>
            Promise.resolve({
              platforms: [
                {
                  defaultRuntime: "35",
                  images: [
                    { abi: "x86_64", runtime: "34", tag: "default" },
                    { abi: "arm64-v8a", runtime: "35", tag: "google_apis" },
                  ],
                  modelAliases: { "Pixel 8": ["pixel_8"] },
                  classDefaults: {},
                  modelClasses: { "Pixel 8": "phone" },
                  modelRuntimes: { "My Tablet": ["34", "35"], "Pixel 8": ["34", "35"] },
                  models: ["My Tablet", "Pixel 8"],
                  platform: "android",
                  runtimes: ["34", "35"],
                },
              ],
            }),
        }),
    });

    await expect(runCli(["catalog"], environment)).resolves.toBe(0);

    expect(output.stdout).toBe(
      [
        "Platform: android",
        "  Runtimes: 34, 35 (default: 35)",
        "  Models:",
        "    phone (default: none):",
        "      Pixel 8: 34, 35",
        "        Other names: pixel_8",
        "    (no class):",
        "      My Tablet: 34, 35",
        "  Images (runtime, tag, ABI):",
        "    34 default x86_64",
        "    35 google_apis arm64-v8a",
        "",
      ].join("\n"),
    );
  });

  it("exits 12 when the daemon refuses with DOWNLOADS_DISABLED", async () => {
    const output = outputCapture();
    const client = fakeClient({
      installComponent: () =>
        Promise.reject(
          new SimlockError("DOWNLOADS_DISABLED", "domain", "downloads.policy is never", {
            policy: "never",
          }),
        ),
    });

    await expect(
      runCli(
        ["component", "install", "ios", "26.4"],
        output.environmentWith({ connectAdmin: async () => client }),
      ),
    ).resolves.toBe(12);
    expect(output.stdout).toBe("");
    expect(JSON.parse(output.stderr.trim().split("\n").at(-1) ?? "")).toEqual({
      error: { code: "DOWNLOADS_DISABLED", message: expect.any(String) },
    });
  });

  it.each([
    ["a missing version", ["component", "install", "ios"]],
    ["an extra argument", ["component", "install", "ios", "26.4", "26.5"]],
    ["an unknown platform", ["component", "install", "tvos", "26.4"]],
    ["--json", ["component", "install", "ios", "26.4", "--json"]],
    ["an unknown subcommand", ["component", "uninstall", "ios", "26.4"]],
  ])("exits 2 with USAGE for %s, without asking the daemon", async (_label, argv) => {
    const output = outputCapture();
    let installs = 0;
    const client = fakeClient({
      installComponent: (input) => {
        installs += 1;
        return Promise.resolve({ ...input, component: input.version, outcome: "installed" });
      },
    });

    await expect(
      runCli(argv, output.environmentWith({ connectAdmin: async () => client })),
    ).resolves.toBe(2);
    expect(installs).toBe(0);
    expect(JSON.parse(output.stderr.trim().split("\n").at(-1) ?? "")).toMatchObject({
      error: { code: "USAGE" },
    });
  });

  it.each([[["component"]], [["component", "--help"]], [["component", "install", "--help"]]])(
    "prints the command's usage for %j without connecting to the daemon",
    async (argv) => {
      const output = outputCapture();
      let connected = false;

      await expect(
        runCli(
          argv,
          output.environmentWith({
            connectAdmin: async () => {
              connected = true;
              return fakeClient();
            },
          }),
        ),
      ).resolves.toBe(0);
      expect(output.stdout).toBe(
        "Usage: simlock component install <ios|android> <version> [--worker <id>... | --all-workers]\n" +
          "       simlock component list [--platform <ios|android>]\n" +
          "       simlock component remove <ios|android> <version> [--dry-run] [--yes]\n",
      );
      expect(connected).toBe(false);
    },
  );
});

describe("CLI: component install on a gateway's workers (ADR 0010 §7)", () => {
  function progressLines(stderr: string): unknown[] {
    return stderr
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown)
      .filter((line) => !Object.hasOwn(line as object, "notice"));
  }

  it("--all-workers prints progress with each worker's id, one result line, and exits 15 when one worker is refused", async () => {
    const output = outputCapture();
    const asked: unknown[] = [];
    const results = [
      { outcome: "installed" as const, version: "35", workerId: "wrk_a" },
      {
        error: { code: "DOWNLOADS_DISABLED", message: "Downloads are disabled" },
        outcome: "refused" as const,
        workerId: "wrk_b",
      },
    ];
    const client = fakeClient({
      installComponentOnWorkers: async (input, options) => {
        asked.push(input);
        options?.onProgress?.({ stage: "waiting", workerId: "wrk_a" });
        options?.onProgress?.({ fraction: 0.5, stage: "downloading", workerId: "wrk_b" });
        return { results };
      },
    });

    await expect(
      runCli(
        ["component", "install", "android", "35", "--all-workers"],
        output.environmentWith({ connectAdmin: async () => client }),
      ),
    ).resolves.toBe(15);

    expect(asked).toEqual([{ platform: "android", version: "35", workers: "all" }]);
    expect(progressLines(output.stderr)).toEqual([
      { stage: "waiting", workerId: "wrk_a" },
      { fraction: 0.5, stage: "downloading", workerId: "wrk_b" },
    ]);
    expect(output.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(output.stdout)).toEqual({ results });
  });

  it("exits 0 when every named worker ends installed or already-installed, and names each --worker given", async () => {
    const output = outputCapture();
    const asked: unknown[] = [];
    const client = fakeClient({
      installComponentOnWorkers: async (input) => {
        asked.push(input);
        return {
          results: [
            { outcome: "installed", version: "26.4", workerId: "wrk_a" },
            { outcome: "already-installed", version: "26.4", workerId: "wrk_b" },
          ],
        };
      },
    });

    await expect(
      runCli(
        ["component", "install", "ios", "26.4", "--worker", "wrk_a", "--worker", "wrk_b"],
        output.environmentWith({ connectAdmin: async () => client }),
      ),
    ).resolves.toBe(0);

    expect(asked).toEqual([{ platform: "ios", version: "26.4", workers: ["wrk_a", "wrk_b"] }]);
  });

  it.each(["skipped", "failed", "unknown"] as const)(
    "exits 15 when a worker ends %s",
    async (outcome) => {
      const output = outputCapture();
      const client = fakeClient({
        installComponentOnWorkers: async () => ({
          results: [
            { outcome: "installed", version: "35", workerId: "wrk_a" },
            { error: { code: "WORKER_UNREACHABLE", message: "gone" }, outcome, workerId: "wrk_b" },
          ],
        }),
      });

      await expect(
        runCli(
          ["component", "install", "android", "35", "--all-workers"],
          output.environmentWith({ connectAdmin: async () => client }),
        ),
      ).resolves.toBe(15);
    },
  );

  it("refuses --worker together with --all-workers as USAGE, without connecting", async () => {
    const output = outputCapture();
    let connected = false;

    await expect(
      runCli(
        ["component", "install", "android", "35", "--worker", "wrk_a", "--all-workers"],
        output.environmentWith({
          connectAdmin: async () => {
            connected = true;
            return fakeClient();
          },
        }),
      ),
    ).resolves.toBe(2);
    expect(connected).toBe(false);
    expect(JSON.parse(output.stderr.trim().split("\n").at(-1) ?? "")).toMatchObject({
      error: { code: "USAGE" },
    });
  });

  it.each([
    "component install <ios|android> <version>",
    "events, stats,",
    "component list [--platform <ios|android>]",
  ])("lists the command in the usage banner: %s", async (fragment) => {
    const output = outputCapture();
    await runCli(["--help"], output.environmentWith({}));
    expect(output.stdout).toContain(fragment);
  });
});

describe("CLI: component list (ADR 0010 §8)", () => {
  const listing = {
    components: [
      {
        devices: 2,
        foreignDevices: 1,
        installedAt: 1_790_864_071_200,
        installedBySimlock: true,
        platform: "android" as const,
        sizeBytes: 4_200_000_000,
        variant: "google_apis/arm64-v8a",
        version: "35",
      },
    ],
  };

  it("prints the daemon's component.list answer as one JSON object on stdout, and exits 0", async () => {
    const output = outputCapture();
    const asked: unknown[] = [];
    const client = fakeClient({
      listComponents: async (input) => {
        asked.push(input);
        return listing;
      },
    });

    await expect(
      runCli(["component", "list"], output.environmentWith({ connectAdmin: async () => client })),
    ).resolves.toBe(0);

    expect(asked).toEqual([{}]);
    expect(output.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(output.stdout)).toEqual(listing);
  });

  it("asks for one platform with --platform", async () => {
    const output = outputCapture();
    const asked: unknown[] = [];
    const client = fakeClient({
      listComponents: async (input) => {
        asked.push(input);
        return { components: [] };
      },
    });

    await expect(
      runCli(
        ["component", "list", "--platform", "ios"],
        output.environmentWith({ connectAdmin: async () => client }),
      ),
    ).resolves.toBe(0);

    expect(asked).toEqual([{ platform: "ios" }]);
  });

  it.each([
    ["an unknown platform", ["component", "list", "--platform", "tvos"]],
    ["a positional argument", ["component", "list", "ios"]],
    ["an unknown flag", ["component", "list", "--json"]],
  ])("exits 2 with USAGE for %s, without asking the daemon", async (_label, argv) => {
    const output = outputCapture();
    let listed = 0;
    const client = fakeClient({
      listComponents: () => {
        listed += 1;
        return Promise.resolve({ components: [] });
      },
    });

    await expect(
      runCli(argv, output.environmentWith({ connectAdmin: async () => client })),
    ).resolves.toBe(2);
    expect(listed).toBe(0);
    expect(JSON.parse(output.stderr.trim().split("\n").at(-1) ?? "")).toMatchObject({
      error: { code: "USAGE" },
    });
  });
});
