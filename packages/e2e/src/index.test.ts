import { describe, expect, it, vi } from "vitest";

import { simlockDevices, type SimlockDevicesOptions } from "./index.js";

const created = vi.hoisted(() => ({ options: [] as unknown[] }));

vi.mock("./provider.js", async (importActual) => {
  const actual = await importActual<typeof import("./provider.js")>();
  return {
    ...actual,
    createProvider: (...args: Parameters<typeof actual.createProvider>) => {
      created.options.push(args[0]);
      return actual.createProvider(...args);
    },
  };
});

const GOOD = {
  url: "https://farm.example.com",
  token: "agent-token",
  platform: "ios",
  device: "iPhone 17 Pro",
} as const;

function call(patch: Record<string, unknown>): ReturnType<typeof simlockDevices> {
  return simlockDevices({ ...GOOD, ...patch } as unknown as SimlockDevicesOptions);
}

function checkedOptions(): Record<string, unknown> {
  return created.options.at(-1) as Record<string, unknown>;
}

describe("simlockDevices", () => {
  it("checks every option at config load, names a bad one in its error, fills the defaults, and returns a provider named simlock", () => {
    expect(call({}).name).toBe("simlock");
    expect(checkedOptions()).toEqual({
      ...GOOD,
      extraApps: [],
      ttlMs: 180_000,
      queueMs: 1_200_000,
      installConcurrency: 3,
    });

    const accepted: [Record<string, unknown>, Record<string, unknown>][] = [
      [{ url: "https://farm.example.com/" }, { url: "https://farm.example.com" }],
      [{ url: "http://10.0.0.5:7777" }, { url: "http://10.0.0.5:7777" }],
      [{ ttlMs: 30_000 }, { ttlMs: 30_000 }],
      [{ queueMs: 1 }, { queueMs: 1 }],
      [{ installConcurrency: 1 }, { installConcurrency: 1 }],
      [{ platform: "android" }, { platform: "android" }],
      [{ deviceMode: "full" }, { deviceMode: "full" }],
      [
        { osVersion: "26.0", imageTag: "x", deviceBaseline: "b", extraApps: ["a.app"] },
        { osVersion: "26.0", imageTag: "x", deviceBaseline: "b", extraApps: ["a.app"] },
      ],
    ];
    for (const [given, checked] of accepted) {
      call(given);
      expect(checkedOptions()).toMatchObject(checked);
    }

    const refused: [Record<string, unknown>, string][] = [
      [
        { url: "farm.example.com" },
        'simlockDevices: url must be an http(s) URL of the simlock gateway or worker; got "farm.example.com"',
      ],
      [
        { url: "https://farm.example.com/v1" },
        'simlockDevices: url must not end in /v1; got "https://farm.example.com/v1"',
      ],
      [{ token: "" }, "simlockDevices: token is required (a simlock agent token)"],
      [{ token: undefined }, "simlockDevices: token is required (a simlock agent token)"],
      [{ platform: "tvos" }, 'simlockDevices: platform must be "ios" or "android"; got "tvos"'],
      [{ device: undefined }, "simlockDevices: device is required (a model the farm lists)"],
      [{ deviceMode: "fast" }, 'simlockDevices: deviceMode must be "slim" or "full"; got "fast"'],
      [{ ttlMs: 0 }, "simlockDevices: ttlMs must be a number of at least 30000; got 0"],
      [{ ttlMs: NaN }, "simlockDevices: ttlMs must be a number of at least 30000; got NaN"],
      [{ ttlMs: 29_999 }, "simlockDevices: ttlMs must be a number of at least 30000; got 29999"],
      [{ queueMs: -1 }, "simlockDevices: queueMs must be a positive number; got -1"],
      [{ queueMs: 0 }, "simlockDevices: queueMs must be a positive number; got 0"],
      [
        { installConcurrency: 0 },
        "simlockDevices: installConcurrency must be a whole number of at least 1; got 0",
      ],
      [
        { installConcurrency: 1.5 },
        "simlockDevices: installConcurrency must be a whole number of at least 1; got 1.5",
      ],
      [{ extraApps: "a.app" }, "simlockDevices: extraApps must be a list of paths"],
      [{ extraApps: ["a.app", 3] }, "simlockDevices: extraApps must be a list of paths"],
      [{ tenant: "x" }, 'simlockDevices: unknown option "tenant"'],
      [{ osVersion: 26 }, "simlockDevices: osVersion must be a non-empty string; got 26"],
      [{ imageTag: "" }, 'simlockDevices: imageTag must be a non-empty string; got ""'],
      [{ deviceBaseline: 1 }, "simlockDevices: deviceBaseline must be a non-empty string; got 1"],
    ];
    for (const [given, message] of refused) {
      expect(() => call(given), message).toThrow(new Error(message));
    }
  });
});
