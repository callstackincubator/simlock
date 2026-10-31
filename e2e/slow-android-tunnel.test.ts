import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  DEVICE_READY_MS,
  freeLoopbackPort,
  waitFor,
  withHttpDaemon,
  withSharedDaemon,
  type SharedTestEnv,
} from "./helpers/index.js";

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

const FORWARD_IN = "/data/local/tmp/simlock-forward-in";

// why: through a gateway the holder's socket is relayed to the worker, and only a real emulator proves both directions of the device side there: `adb reverse` reaching the caller, and the host protocol reaching a device server.
describe.skipIf(!hasAndroidSdk)(
  "simlock tunnel reverse and forward on a real emulator through a gateway",
  { tags: ["slow", "android"] },
  () => {
    it(
      "serves the caller's page to the emulator through reverse, and a device server's bytes to the caller's loopback port through forward, with the caller's bytes arriving",
      { timeout: 480_000 },
      async () => {
        const gatewayPort = await freeLoopbackPort();
        const gateway: SharedTestEnv = await withSharedDaemon({
          configOverrides: {
            capabilities: { tunnel: { enabled: true } },
            http: { enabled: true, host: "127.0.0.1", port: gatewayPort },
          },
          driver: "none",
          role: "gateway",
        });
        let worker: SharedTestEnv | undefined;
        const page = createServer((_request, response) => {
          response.writeHead(200, { "content-type": "text/plain" }).end(BODY);
        });
        try {
          const joined = await gateway.cli(["token", "create", "--role", "worker"]);
          expect(joined.code, joined.stderr).toBe(0);
          worker = await withSharedDaemon({
            configOverrides: {
              capabilities: { tunnel: { enabled: true } },
              gateway: {
                label: "worker",
                token: (joined.json as { secret: string }).secret,
                url: `ws://127.0.0.1:${String(gatewayPort)}`,
              },
              http: { enabled: false, host: "127.0.0.1", port: await freeLoopbackPort() },
              idle: { shutdownAfterMs: 300_000 },
              warmPool: { learn: false },
            },
            driver: "real",
          });
          const reversePort = await freeLoopbackPort();
          const forwardPort = await freeLoopbackPort();
          await new Promise<void>((resolve) => page.listen(reversePort, "127.0.0.1", resolve));

          const lease = await gateway.cli(
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
          const created = await gateway.cli(["token", "create", "--role", "operator"]);
          expect(created.code, created.stderr).toBe(0);
          const secret = (created.json as { secret: string }).secret;

          const tunnel = gateway.cliBackground([
            "--token",
            secret,
            "tunnel",
            "reverse",
            String(reversePort),
            "forward",
            String(forwardPort),
            "--url",
            `http://127.0.0.1:${String(gatewayPort)}`,
            "--lease",
            leaseId,
          ]);
          await tunnel.firstStdoutLine(60_000);
          const lines = [
            `reverse device:${String(reversePort)} -> localhost:${String(reversePort)} (lease ${leaseId})`,
            `forward localhost:${String(forwardPort)} -> device:${String(forwardPort)} (lease ${leaseId})`,
          ];
          await waitFor(async () => tunnel.stdoutSoFar() === `${lines.join("\n")}\n`, {
            interval: 500,
            label: "both tunnel lines",
            timeout: 30_000,
          });

          let answer = "";
          await waitFor(
            async () => {
              const fetched = await gateway.cli([
                "adb",
                "shell",
                `(printf 'GET / HTTP/1.0\\r\\n\\r\\n'; sleep 2) | nc 127.0.0.1 ${String(reversePort)}`,
              ]);
              answer = fetched.stdout;
              return answer.includes(BODY);
            },
            {
              interval: 1_000,
              label: "the device reading the caller's page through the gateway",
              timeout: 60_000,
            },
          );
          expect(answer).toContain(BODY);

          const server = gateway.cliBackground([
            "adb",
            "shell",
            `(printf 'device-ok'; sleep 30) | nc -l -p ${String(forwardPort)} > ${FORWARD_IN}`,
          ]);
          const received = await new Promise<string>((resolve, reject) => {
            const giveUp = Date.now() + 5_000;
            const attempt = (): void => {
              const socket = connect({ host: "127.0.0.1", port: forwardPort });
              let heard = "";
              socket.once("connect", () => {
                socket.write("from-caller");
              });
              socket.on("data", (chunk) => {
                heard += chunk.toString("utf8");
                if (heard.includes("device-ok")) {
                  socket.destroy();
                  resolve(heard);
                }
              });
              socket.once("close", () => {
                if (heard.includes("device-ok")) return;
                if (Date.now() > giveUp) {
                  reject(new Error(`no answer from the device server: ${heard}`));
                } else setTimeout(attempt, 250);
              });
              socket.on("error", () => undefined);
            };
            attempt();
          });
          expect(received).toBe("device-ok");
          await waitFor(
            async () => {
              const read = await gateway.cli(["adb", "shell", `cat ${FORWARD_IN}`]);
              return read.stdout.includes("from-caller");
            },
            {
              interval: 1_000,
              label: "the device server receiving the caller's bytes",
              timeout: 30_000,
            },
          );
          server.kill("SIGINT");

          tunnel.kill("SIGINT");
          expect((await tunnel.waitForExit(10_000)).code).toBe(0);
        } finally {
          await new Promise<void>((resolve) => page.close(() => resolve()));
          await gateway
            .cli(["nuke", "--delete-devices", "--yes"], { timeout: 120_000 })
            .catch(() => undefined);
          await Promise.allSettled([worker?.teardown(), gateway.teardown()]);
        }
      },
    );
  },
);
