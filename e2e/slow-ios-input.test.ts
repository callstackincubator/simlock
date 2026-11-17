import { execFileSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assertPinnedAgentDevice,
  cleanupAgents,
  FIRST_SNAPSHOT,
  freeLoopbackPort,
  listLeases,
  listRequests,
  makeAgent,
  newAgentToken,
  ok,
  openInputSocket,
  progress,
  waitFor,
  waitForAgentDevice,
  withSharedDaemon,
  type Agent,
  type SharedTestEnv,
} from "./helpers/index.js";

const AGENT_DEVICE = process.env.SIMLOCK_E2E_AGENT_DEVICE;
const SETTINGS = "com.apple.Preferences";
const INPUT_BUTTON = 0x04;
const INPUT_KEY = 0x06;
const INPUT_TOUCH = 0x03;
const INPUT_ADMITTED = 0x83;
const INPUT_CONFIG = 0x82;
// why: USB HID keyboard usages for the letters a, b and c.
const TYPED = [0x04, 0x05, 0x06] as const;

// why: the file proves an iOS 27 runtime, where ADR 0049 once dropped keys, the app switcher and Lock.
function hasIos27Runtime(): boolean {
  if (process.platform !== "darwin" || process.arch !== "arm64") return false;
  try {
    return /^iOS 2[7-9]|^iOS [3-9]\d/m.test(
      execFileSync("xcrun", ["simctl", "list", "runtimes"], { encoding: "utf8" }),
    );
  } catch {
    return false;
  }
}

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function* nodesOf(node: unknown): Generator<Record<string, unknown>> {
  if (typeof node !== "object" || node === null) return;
  if (!Array.isArray(node)) yield node as Record<string, unknown>;
  for (const child of Object.values(node)) yield* nodesOf(child);
}

function boxOf(node: Record<string, unknown>): Box | undefined {
  const rect = node["rect"] as Box | undefined;
  return rect !== undefined && typeof rect.width === "number" ? rect : undefined;
}

// why: the search field is the node agent-device types a SearchField (Settings' list also holds buttons
// labelled Search, and a cell named "Optimising Search and Siri"); the screen is the largest box in the
// same snapshot, so the tap's fraction is measured against one size.
function searchFieldAndScreen(json: unknown): { field?: Box; screen?: Box } {
  const boxed = [...nodesOf(json)].flatMap((node) => {
    const box = boxOf(node);
    return box === undefined ? [] : [{ box, node }];
  });
  const area = (box: Box) => box.width * box.height;
  const screen = boxed.map((entry) => entry.box).sort((left, right) => area(right) - area(left))[0];
  const field = boxed.find(({ node }) => node["type"] === "SearchField")?.box;
  return {
    ...(field === undefined ? {} : { field }),
    ...(screen === undefined ? {} : { screen }),
  };
}

// why: the share of pixels that moved between two screenshots of one simulator; the app switcher and
// Lock repaint most of a screen, so a press counts when more than CHANGED of it moved.
const CHANGED = 0.3;
function changedFraction(before: PNG, after: PNG): number {
  if (before.width !== after.width || before.height !== after.height) return 1;
  let moved = 0;
  for (let i = 0; i < before.data.length; i += 4) {
    const delta =
      Math.abs(before.data[i]! - after.data[i]!) +
      Math.abs(before.data[i + 1]! - after.data[i + 1]!) +
      Math.abs(before.data[i + 2]! - after.data[i + 2]!);
    if (delta > 48) moved++;
  }
  return moved / (before.data.length / 4);
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(AGENT_DEVICE === undefined || !hasIos27Runtime())(
  "iOS simulator input on an iOS 27 runtime",
  { tags: ["slow", "ios"] },
  () => {
    let env: SharedTestEnv;

    beforeAll(async () => {
      const pinned = await assertPinnedAgentDevice("ios");
      env = await withSharedDaemon({
        driver: "real",
        configOverrides: {
          http: { enabled: true, host: "127.0.0.1", port: await freeLoopbackPort() },
          capabilities: {
            "agent-device": { enabled: true, command: pinned },
            input: { enabled: true },
          },
          capacity: { config: { limits: { ios: { maxDevices: 1, maxRunning: 1 } } } },
        },
      });
      const probe = await newAgentToken(env);
      await waitForAgentDevice(env, probe.secret);
    }, 420_000);

    afterAll(async () => {
      await cleanupAgents();
      if (env !== undefined) {
        await env.cli(["release", "--all", "--yes"], { timeout: 60_000 });
        // why: no warm pool is configured here, so a released simulator is destroyed and no replacement turns ready; waitForFree would wait for one; only the lease and the request have to be gone before the daemon stops.
        await waitFor(
          async () =>
            (await listLeases(env)).length === 0 && (await listRequests(env)).length === 0,
          { interval: 1_000, label: "no lease and no request after the release", timeout: 120_000 },
        );
      }
      await env?.teardown();
    }, 420_000);

    it(
      "on a leased iOS 27 simulator, keys sent on the input socket reach Settings' search field, app_switcher takes Settings out of the foreground, and so does lock after Settings is reopened",
      { timeout: 900_000 },
      async () => {
        const a: Agent = await makeAgent(env, "ios-input");
        ok(await a.run(["open", "--platform", "ios", "--os", ">=27"], { timeout: 330_000 }));
        ok(await a.run(["open", SETTINGS]));
        const shots = await mkdtemp(join(tmpdir(), "simlock-ios-input-"));
        progress(`screenshots of the iOS input test are saved in ${shots}`);

        const snapshot = await a.run(["snapshot", "--json"], FIRST_SNAPSHOT);
        ok(snapshot);
        const { field, screen } = searchFieldAndScreen(snapshot.json);
        expect(field, "Settings' search field in the snapshot").toBeDefined();
        expect(screen, "the screen in the snapshot").toBeDefined();
        const lease = (await listLeases(env))[0];
        const socket = await openInputSocket(env.httpPort, lease?.id ?? "", a.token);
        const appState = (await a.run(["appstate", "--json"])).data as
          | { device_udid?: string; ios_simulator_device_set?: string }
          | undefined;
        expect(appState?.device_udid, "appstate names the simulator").toBeDefined();
        const frame = async (name: string): Promise<PNG> => {
          const file = join(shots, `${name}.png`);
          execFileSync("xcrun", [
            "simctl",
            "--set",
            appState!.ios_simulator_device_set!,
            "io",
            appState!.device_udid!,
            "screenshot",
            file,
          ]);
          return PNG.sync.read(await readFile(file));
        };
        const waitForScreenChange = async (before: PNG, name: string): Promise<PNG> => {
          let latest = before;
          await waitFor(
            async () => {
              latest = await frame(name);
              return changedFraction(before, latest) > CHANGED;
            },
            { interval: 2_000, label: `the screen changed for ${name}`, timeout: 30_000 },
          );
          return latest;
        };
        try {
          await socket.waitForTag(INPUT_ADMITTED);
          const config = (await socket.waitForTag(INPUT_CONFIG)) as Record<string, unknown>;
          expect(config["keyboardUnavailable"], "no keyboardUnavailable on iOS 27").toBeUndefined();

          const x = (field!.x + field!.width / 2 - screen!.x) / screen!.width;
          const y = (field!.y + field!.height / 2 - screen!.y) / screen!.height;
          socket.send(INPUT_TOUCH, { type: "begin", x, y });
          socket.send(INPUT_TOUCH, { type: "end", x, y });
          // why: the first keys on a freshly booted simulator can be lost (ADR 0085 Context), so
          // the keys are sent again until they show, up to a bound.
          await waitFor(
            async () => {
              for (const usage of TYPED) {
                socket.send(INPUT_KEY, { type: "down", usage });
                socket.send(INPUT_KEY, { type: "up", usage });
              }
              const typed = await a.run(["snapshot"]);
              return typed.code === 0 && /abc/i.test(typed.stdout);
            },
            { interval: 3_000, label: "typed keys in the snapshot", timeout: 60_000 },
          );
          const frameA = await frame("1-typed");

          // why: agent-device's appstate keeps answering runningForeground behind the app switcher and
          // its screenshot hangs there, so the presses are read off the simulator's own screen.
          socket.send(INPUT_BUTTON, { button: "app_switcher" });
          const switcher = await waitForScreenChange(frameA, "2-app-switcher");

          ok(await a.run(["open", SETTINGS]));
          await sleep(3_000);
          const reopened = await frame("2b-reopened");
          expect(
            changedFraction(switcher, reopened),
            "Settings is back after the switcher",
          ).toBeGreaterThan(CHANGED);
          socket.send(INPUT_BUTTON, { button: "lock" });
          await waitForScreenChange(reopened, "3-lock");
        } finally {
          socket.close();
        }
        ok(await a.run(["close"]));
      },
    );
  },
);
