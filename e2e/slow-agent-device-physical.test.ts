import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";

import {
  assertPinnedAgentDevice,
  freeLoopbackPort,
  listLeases,
  newAgentToken,
  waitForAgentDevice,
  waitForFree,
  withSharedDaemon,
  type SharedTestEnv,
} from "./helpers/index.js";

const MINUTE = 60_000;
const PNG_MAGIC = "89504e470d0a1a0a";

type Platform = "android" | "ios";

const ANDROID_SERIAL = process.env["SIMLOCK_PHYSICAL_ANDROID"];
const IOS_UDID = process.env["SIMLOCK_PHYSICAL_IOS"];
// why: teamId and bundleId let Xcode sign the runner automatically; only a provisioning profile switches agent-device to manual signing (a signing identity alone does not), so each goes in only when set.
const IOS_SIGNING = {
  teamId: process.env["SIMLOCK_E2E_IOS_TEAM_ID"],
  bundleId: process.env["SIMLOCK_E2E_IOS_BUNDLE_ID"],
  ...(process.env["SIMLOCK_E2E_IOS_PROVISIONING_PROFILE"]
    ? { provisioningProfile: process.env["SIMLOCK_E2E_IOS_PROVISIONING_PROFILE"] }
    : {}),
  ...(process.env["SIMLOCK_E2E_IOS_SIGNING_IDENTITY"]
    ? { signingIdentity: process.env["SIMLOCK_E2E_IOS_SIGNING_IDENTITY"] }
    : {}),
} as const;

function unset(name: string, value: string | undefined): string | undefined {
  return value === undefined || value === "" ? name : undefined;
}

const missing = {
  android: unset("SIMLOCK_PHYSICAL_ANDROID", ANDROID_SERIAL),
  ios:
    unset("SIMLOCK_PHYSICAL_IOS", IOS_UDID) ??
    unset("SIMLOCK_E2E_IOS_TEAM_ID", IOS_SIGNING.teamId) ??
    unset("SIMLOCK_E2E_IOS_BUNDLE_ID", IOS_SIGNING.bundleId),
} as const;

interface RpcAnswer {
  readonly result?: { readonly ok?: boolean; readonly data?: Record<string, unknown> };
  readonly error?: { readonly message: string };
}

function deviceKeyOf(allocated: RpcAnswer): string | undefined {
  const lease = allocated.result?.data?.["lease"] as { deviceKey?: string } | undefined;
  return lease?.deviceKey;
}

function writtenPath(shot: RpcAnswer, requested: string): string {
  const named = shot.result?.data?.["path"];
  return existsSync(requested) || typeof named !== "string" ? requested : named;
}

function defineSuite(platform: Platform, id: string): void {
  const tag = platform === "android" ? "Android" : "iOS";
  const addressKey = platform === "android" ? "serial" : "udid";
  describe.skipIf(missing[platform] !== undefined)(
    missing[platform] === undefined
      ? `agent-device with a physical ${tag} phone (real agent-device)`
      : `agent-device with a physical ${tag} phone (skipped: ${missing[platform]} is not set)`,
    { tags: ["slow", "physical", platform] },
    () => {
      let env: SharedTestEnv;
      let secret: string;

      // why: the agent-device CLI reads `/health` before any lease and sends its two instance ids on every RPC; a lease on the phone daemon must accept them.
      const pins = async (): Promise<Record<string, string>> => {
        const response = await fetch(`http://127.0.0.1:${env.httpPort}/v1/agent-device/health`, {
          headers: { authorization: `Bearer ${secret}` },
        });
        const health = (await response.json()) as {
          readonly instanceId?: string;
          readonly upstream?: { readonly instanceId?: string };
        };
        return {
          ...(health.instanceId === undefined
            ? {}
            : { "x-agent-device-instance": health.instanceId }),
          ...(health.upstream?.instanceId === undefined
            ? {}
            : { "x-agent-device-upstream-instance": health.upstream.instanceId }),
        };
      };

      const call = async (method: string, params: Record<string, unknown>): Promise<RpcAnswer> => {
        const response = await fetch(`http://127.0.0.1:${env.httpPort}/v1/agent-device/rpc`, {
          body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
          headers: {
            authorization: `Bearer ${secret}`,
            "content-type": "application/json",
            ...(await pins()),
          },
          method: "POST",
          signal: AbortSignal.timeout(6 * MINUTE),
        });
        return (await response.json()) as RpcAnswer;
      };

      beforeAll(async () => {
        const pinned = await assertPinnedAgentDevice(platform);
        env = await withSharedDaemon({
          configOverrides: {
            capabilities: {
              "agent-device": {
                command: pinned,
                enabled: true,
                ...(platform === "ios" ? { ios: IOS_SIGNING } : {}),
              },
            },
            http: { enabled: true, host: "127.0.0.1", port: await freeLoopbackPort() },
          },
          driver: "real",
        });
        const token = await newAgentToken(env);
        secret = token.secret;
        await waitForAgentDevice(env, secret);
        const added = await env.cli(["device", "add", "--platform", platform, id, "--json"], {
          timeout: 2 * MINUTE,
        });
        expect(added.code, `device add failed: ${added.stderr}`).toBe(0);
      }, 10 * MINUTE);

      afterAll(async () => {
        await env?.teardown();
      }, 2 * MINUTE);

      it(
        `a raw agent_device.lease.allocate with physical: true and platform: "${platform}" is granted that ${addressKey}, a screenshot on the lease answers a PNG, and agent_device.lease.release releases the Simlock lease`,
        { timeout: 15 * MINUTE },
        async () => {
          const leaseId = randomBytes(16).toString("hex");
          const scope = { clientId: "slow-lane", leaseProvider: "proxy", runId: "slow-lane" };

          const allocated = await call("agent_device.lease.allocate", {
            ...scope,
            leaseId,
            physical: true,
            platform,
            ttlMs: 10 * MINUTE,
          });

          expect(allocated.error, JSON.stringify(allocated)).toBeUndefined();
          expect(allocated.result?.ok).toBe(true);
          const [lease] = await listLeases(env);
          expect(lease?.id).toBe(leaseId);
          const devices = (await env.cli(["list", "--devices"])).json as {
            readonly id: string;
            readonly driverDeviceId: string;
          }[];
          expect(devices.find((device) => device.id === lease?.deviceId)?.driverDeviceId).toBe(id);

          // why: like the CLI, a command carries the scope the lease was allocated under plus the device key agent-device's reply named; without all of them agent-device refuses the lease's owner.
          const deviceKey = deviceKeyOf(allocated);
          const dir = await mkdtemp(join(tmpdir(), "simlock-ad-phone-"));
          onTestFinished(() => rm(dir, { force: true, recursive: true }));
          const png = join(dir, "shot.png");
          // why: the CLI addresses the leased phone by its serial or udid on each command; with 26 devices known to agent-device none is picked for it.
          const flags = { platform, [addressKey]: id };
          const meta = { ...scope, deviceKey, leaseId };
          const opened = await call("agent_device.command", {
            command: "open",
            flags,
            meta,
            positionals: [],
          });
          expect(opened.error, JSON.stringify(opened)).toBeUndefined();
          const shot = await call("agent_device.command", {
            command: "screenshot",
            flags,
            meta,
            positionals: [png],
          });
          expect(shot.error, JSON.stringify(shot)).toBeUndefined();
          expect((await readFile(writtenPath(shot, png))).subarray(0, 8).toString("hex")).toBe(
            PNG_MAGIC,
          );

          const released = await call("agent_device.lease.release", {
            ...scope,
            deviceKey,
            leaseId,
          });
          expect(released.error, JSON.stringify(released)).toBeUndefined();
          await waitForFree(env);
        },
      );
    },
  );
}

defineSuite("android", ANDROID_SERIAL ?? "");
defineSuite("ios", IOS_UDID ?? "");
