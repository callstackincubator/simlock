import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DEVICE_READY_MS, freeLoopbackPort, waitFor, withHttpDaemon } from "./helpers/index.js";

const ANDROID_HOME =
  process.env.ANDROID_HOME ??
  process.env.ANDROID_SDK_ROOT ??
  join(homedir(), "Library/Android/sdk");
const hasAndroidSdk =
  existsSync(ANDROID_HOME) && existsSync(join(ANDROID_HOME, "platform-tools", "adb"));

const BODY = "simlock-tunnel-ok";

// why: only a real emulator proves that `adb reverse` reaches the caller's loopback listener through the tunnel socket; the fast end-to-end test fakes the device side.
describe.skipIf(!hasAndroidSdk)(
  "simlock tunnel reverse on a real emulator against a lone worker",
  { tags: ["slow", "android"] },
  () => {
    it(
      "serves a page held on the caller's loopback port to the emulator through reverse",
      { timeout: 420_000 },
      async () => {
        const { env, port } = await withHttpDaemon((httpPort) => ({
          configOverrides: {
            capabilities: { tunnel: { enabled: true } },
            http: { enabled: true, host: "127.0.0.1", port: httpPort },
            idle: { shutdownAfterMs: 300_000 },
            warmPool: { learn: false },
          },
          driver: "real",
        }));
        const page = createServer((_request, response) => {
          response.writeHead(200, { "content-type": "text/plain" }).end(BODY);
        });
        try {
          const callerPort = await freeLoopbackPort();
          await new Promise<void>((resolve) => page.listen(callerPort, "127.0.0.1", resolve));

          const lease = await env.cli(
            [
              "lease",
              "--platform",
              "android",
              "--device",
              "Pixel 9",
              "--agent-id",
              "tunnel",
              "--detach",
            ],
            { timeout: DEVICE_READY_MS },
          );
          expect(lease.code, `lease failed: ${lease.stderr}`).toBe(0);
          const leaseId = (lease.json as { lease: { id: string } }).lease.id;

          const created = await env.cli(["token", "create", "--role", "operator"]);
          expect(created.code, created.stderr).toBe(0);
          const secret = (created.json as { secret: string }).secret;

          const tunnel = env.cliBackground([
            "--token",
            secret,
            "tunnel",
            "reverse",
            String(callerPort),
            "--url",
            `http://127.0.0.1:${String(port)}`,
            "--lease",
            leaseId,
          ]);
          expect(await tunnel.firstStdoutLine(60_000)).toBe(
            `reverse device:${String(callerPort)} -> localhost:${String(callerPort)} (lease ${leaseId})`,
          );

          let answer = "";
          await waitFor(
            async () => {
              const fetched = await env.cli([
                "adb",
                "shell",
                `(printf 'GET / HTTP/1.0\\r\\n\\r\\n'; sleep 2) | nc 127.0.0.1 ${String(callerPort)}`,
              ]);
              answer = fetched.stdout;
              return answer.includes(BODY);
            },
            {
              interval: 1_000,
              label: "the device reading the caller's page through reverse",
              timeout: 60_000,
            },
          );
          expect(answer).toContain(BODY);

          tunnel.kill("SIGINT");
          expect((await tunnel.waitForExit(10_000)).code).toBe(0);
        } finally {
          await new Promise<void>((resolve) => page.close(() => resolve()));
          await env
            .cli(["nuke", "--delete-devices", "--yes"], { timeout: 120_000 })
            .catch(() => undefined);
        }
      },
    );
  },
);
