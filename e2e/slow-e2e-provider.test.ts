import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { checkOptions } from "../packages/e2e/src/options.js";
import { createProvider } from "../packages/e2e/src/provider.js";
import {
  assertPinnedAgentDevice,
  cleanupAgents,
  freeLoopbackPort,
  hasIosRuntime,
  IOS,
  listLeases,
  loadAgentDeviceClient,
  newAgentToken,
  REPO_ROOT,
  waitForAgentDevice,
  waitForFree,
  warmUp,
  withSharedDaemon,
  type SharedTestEnv,
} from "./helpers/index.js";

const AGENT_DEVICE = process.env.SIMLOCK_E2E_AGENT_DEVICE;

// why: the provider names its session from the first 12 characters of the run id, so the test names the same session when it drives the lease.
const RUN_ID = "slow-e2e-provider-run";

describe.skipIf(AGENT_DEVICE === undefined || !hasIosRuntime())(
  "the e2e provider through a real worker (iOS)",
  { tags: ["slow", "ios"] },
  () => {
    let env: SharedTestEnv;

    beforeAll(async () => {
      const pinned = await assertPinnedAgentDevice("ios");
      env = await withSharedDaemon({
        driver: "real",
        keepSeeds: true,
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
      await warmUp(env, IOS, 1);
    }, 420_000);

    afterAll(async () => {
      await cleanupAgents();
      await env?.teardown();
    }, 120_000);

    it(
      "acquires a simulator with the fixture app installed, keeps the lease through a close of the session, and ends it on release",
      { timeout: 900_000 },
      async () => {
        const token = await newAgentToken(env);
        const catalog = await env.cli(["catalog", "--json", "--platform", "ios"]);
        expect(catalog.code, catalog.stderr).toBe(0);
        const model = (
          catalog.json as {
            platforms: { platform: string; classDefaults: Record<string, string> }[];
          }
        ).platforms.find((platform) => platform.platform === "ios")?.classDefaults["phone"];
        expect(model, "the catalog names a default phone model").toBeDefined();

        const lines: string[] = [];
        const provider = createProvider(
          checkOptions({
            url: `http://127.0.0.1:${String(env.httpPort)}`,
            token: token.secret,
            platform: "ios",
            device: model as string,
          }),
          loadAgentDeviceClient as unknown as Parameters<typeof createProvider>[1],
        );
        const lease = await provider.acquire({
          platform: "ios",
          runId: RUN_ID,
          targetName: "ios",
          slot: 0,
          slots: 1,
          agentDeviceVersion: "0.21.37",
          app: IOS.bundleId,
          appPath: IOS.app,
          projectRoot: REPO_ROOT,
          env: {},
          signal: new AbortController().signal,
          log: (line) => lines.push(line),
        });
        expect(lease.installedApp).toBe(IOS.bundleId);
        expect((await listLeases(env)).map((row) => row.id)).toContain(lease.id);

        // why: the lease names a client id, a provider and a device key that the agent-device CLI has no flag for, so a runner drives it through the client with the scope the provider handed over, as the e2e package's consumers do.
        const createClient = (await loadAgentDeviceClient()) as unknown as (
          config: Record<string, unknown>,
        ) => {
          apps: {
            open: (options: Record<string, unknown>) => Promise<unknown>;
            close: (options: Record<string, unknown>) => Promise<unknown>;
          };
        };
        const runner = createClient({
          daemonBaseUrl: lease.daemon.baseUrl,
          daemonAuthToken: lease.daemon.authToken,
          session: `e2e-${RUN_ID.slice(0, 12)}-0`,
          ...lease.client,
        });
        await runner.apps.open({
          app: IOS.bundleId,
          platform: "ios",
          udid: lease.deviceId as string,
        });
        await runner.apps.close({ app: IOS.bundleId });
        expect(
          (await listLeases(env)).map((row) => row.id),
          "a close keeps the lease",
        ).toContain(lease.id);

        await provider.release(lease, {
          runId: RUN_ID,
          targetName: "ios",
          env: {},
          signal: new AbortController().signal,
          log: (line) => lines.push(line),
        });
        expect(await listLeases(env)).toEqual([]);
        await waitForFree(env);
      },
    );
  },
);
