import { describe, expect, it } from "vitest";

import { withDaemon } from "./helpers/index.js";
import { ANDROID_SDK } from "./helpers/test-android-sdk.js";
import { DEVICE_READY_MS } from "./helpers/wait.js";

const WIFI_JOIN_MS = 90_000;

interface WifiState {
  readonly connected: boolean;
  readonly wlan0Ipv4: boolean;
}

// why: #1586: every copy restores the one seed's boot snapshot and every emulator on the host shares one netsimd, and only real emulators show whether each copy joins that Wi-Fi.
describe.skipIf(ANDROID_SDK === undefined)(
  "Wi-Fi on two real emulators of one worker",
  { tags: ["slow", "android"] },
  () => {
    it(
      "two Pixel 9 leases held at once both report Wi-Fi connected with an IPv4 address on wlan0",
      { timeout: 900_000 },
      async () => {
        const env = await withDaemon({
          driver: "real",
          configOverrides: { idle: { shutdownAfterMs: 300 }, warmPool: { learn: false } },
        });
        try {
          const lease = async (agent: string) => {
            const granted = await env.cli(
              [
                "lease",
                "--platform",
                "android",
                "--device",
                "Pixel 9",
                "--agent-id",
                agent,
                "--detach",
              ],
              { timeout: DEVICE_READY_MS },
            );
            expect(granted.code, `lease failed: ${granted.stderr}`).toBe(0);
            return granted.json as { device: { address?: string } };
          };
          // why: a worker's `simlock adb` has no lease to aim at, so each call names the lease's own serial.
          const shell = async (grant: { device: { address?: string } }, command: string) =>
            (await env.cli(["adb", "-s", grant.device.address ?? "", "shell", command])).stdout;
          const wifiOf = async (grant: { device: { address?: string } }): Promise<WifiState> => ({
            connected: /Wifi is connected to/.test(await shell(grant, "cmd wifi status")),
            wlan0Ipv4: /\binet \d/.test(await shell(grant, "ip -4 addr show wlan0")),
          });

          const grants = await Promise.all([lease("wifi-one"), lease("wifi-two")]);

          // why: a guest joins Wi-Fi some seconds after its boot, so the state is read until both joined or the join time is over, and asserted once.
          let states: WifiState[] = [];
          const deadline = Date.now() + WIFI_JOIN_MS;
          do {
            states = await Promise.all(grants.map(wifiOf));
            if (states.every((state) => state.connected && state.wlan0Ipv4)) break;
            await new Promise((resolve) => setTimeout(resolve, 2_000));
          } while (Date.now() < deadline);
          const evidence = await Promise.all(
            grants.map(
              async (grant) =>
                `${grant.device.address ?? "?"}: ${(await shell(grant, "cmd wifi status")).split("\n").slice(0, 2).join(" / ")}`,
            ),
          );

          expect(states, evidence.join("\n")).toEqual([
            { connected: true, wlan0Ipv4: true },
            { connected: true, wlan0Ipv4: true },
          ]);
        } finally {
          await env
            .cli(["nuke", "--delete-devices", "--yes"], { timeout: 120_000 })
            .catch(() => undefined);
        }
      },
    );
  },
);
