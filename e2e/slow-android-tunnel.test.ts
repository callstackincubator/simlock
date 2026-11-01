import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DEVICE_READY_MS,
  freeLoopbackPort,
  openInputSocket,
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

const ADB = join(ANDROID_HOME, "platform-tools", "adb");

// why: the worker runs its own adb server (`adbServerPort`), which the user's default server cannot see; the rules a tunnel set live there.
function workerAdb(
  serverPort: number,
  args: readonly string[],
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(ADB, ["-P", String(serverPort), ...args], (error, stdout) => {
      resolve({
        code: error === null ? 0 : typeof error.code === "number" ? error.code : 1,
        stdout,
      });
    });
  });
}

// why: a page that says it loaded and, when it is tapped anywhere, says so; each request comes back to the caller only through the reverse tunnel.
const TAP_PAGE = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0"><button style="position:fixed;inset:0;width:100vw;height:100vh;font-size:48px"
onclick="fetch('/tapped?'+Date.now()).catch(function(){})">tap</button>
<script>fetch('/loaded').catch(function(){})</script></body></html>`;

const CHROME = "com.android.chrome";

// why: a gateway relays a lease's input socket and tunnel socket to its worker side by side, and only a real emulator proves a relayed tap moves its screen and that a request it causes comes back through the relayed tunnel.
describe.skipIf(!hasAndroidSdk)(
  "input and tunnel together on a real emulator through a gateway",
  { tags: ["slow", "android"] },
  () => {
    const gatewayPort = { value: 0 };
    let gateway: SharedTestEnv | undefined;
    let worker: SharedTestEnv | undefined;
    const lease = { id: "", secret: "", serial: "" };

    function onGateway(): SharedTestEnv {
      if (gateway === undefined) throw new Error("the gateway did not start");
      return gateway;
    }

    function workerAdbPort(): number {
      const port = worker?.adbServerPort;
      if (port === undefined) throw new Error("the worker has no adb server of its own");
      return port;
    }

    async function resumedActivity(): Promise<string> {
      const dump = await onGateway().cli([
        "adb",
        "shell",
        "dumpsys activity activities | grep -E 'ResumedActivity'",
      ]);
      return dump.stdout;
    }

    beforeAll(async () => {
      gatewayPort.value = await freeLoopbackPort();
      gateway = await withSharedDaemon({
        configOverrides: {
          capabilities: { input: { enabled: true }, tunnel: { enabled: true } },
          http: { enabled: true, host: "127.0.0.1", port: gatewayPort.value },
        },
        driver: "none",
        role: "gateway",
      });
      const joined = await gateway.cli(["token", "create", "--role", "worker"]);
      expect(joined.code, joined.stderr).toBe(0);
      worker = await withSharedDaemon({
        configOverrides: {
          capabilities: { input: { enabled: true }, tunnel: { enabled: true } },
          gateway: {
            label: "worker",
            token: (joined.json as { secret: string }).secret,
            url: `ws://127.0.0.1:${String(gatewayPort.value)}`,
          },
          http: { enabled: false, host: "127.0.0.1", port: await freeLoopbackPort() },
          idle: { shutdownAfterMs: 300_000 },
          warmPool: { learn: false },
        },
        driver: "real",
      });
      const granted = await gateway.cli(
        [
          "lease",
          "--platform",
          "android",
          "--device",
          "Pixel 9",
          "--agent-id",
          "input-tunnel",
          "--detach",
        ],
        { timeout: DEVICE_READY_MS },
      );
      expect(granted.code, `lease failed: ${granted.stderr}`).toBe(0);
      lease.id = (granted.json as { lease: { id: string } }).lease.id;
      const created = await gateway.cli(["token", "create", "--role", "operator"]);
      expect(created.code, created.stderr).toBe(0);
      lease.secret = (created.json as { secret: string }).secret;
      const devices = await workerAdb(workerAdbPort(), ["devices"]);
      const serials = devices.stdout
        .split("\n")
        .filter((line) => line.endsWith("\tdevice"))
        .map((line) => line.split("\t")[0] ?? "");
      expect(serials, devices.stdout).toHaveLength(1);
      lease.serial = serials[0] ?? "";
    }, DEVICE_READY_MS + 120_000);

    afterAll(async () => {
      await gateway
        ?.cli(["nuke", "--delete-devices", "--yes"], { timeout: 120_000 })
        .catch(() => undefined);
      await Promise.allSettled([worker?.teardown(), gateway?.teardown()]);
    }, 240_000);

    it(
      "a home button sent on the input socket through a gateway takes a real emulator from Settings to its home screen",
      { timeout: 180_000 },
      async () => {
        const home = await onGateway().cli([
          "adb",
          "shell",
          "cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME | tail -n 1",
        ]);
        const launcher = home.stdout.trim().split("/")[0] ?? "";
        expect(launcher, home.stdout).toMatch(/^[a-z][\w.]+$/);
        expect(launcher).not.toBe("com.android.settings");

        const opened = await onGateway().cli([
          "adb",
          "shell",
          "am start -W -a android.settings.SETTINGS",
        ]);
        expect(opened.code, opened.stderr).toBe(0);
        await waitFor(async () => (await resumedActivity()).includes("com.android.settings"), {
          interval: 1_000,
          label: "Settings in the foreground",
          timeout: 30_000,
        });

        const socket = await openInputSocket(gatewayPort.value, lease.id, lease.secret);
        try {
          await socket.waitForTag(0x83);
          const config = (await socket.waitForTag(0x82)) as {
            width: number;
            inputUnavailable?: true;
          };
          expect(config.inputUnavailable).toBeUndefined();
          expect(config.width).toBeGreaterThan(1);
          socket.send(0x04, { button: "home" });
          let resumed = "";
          await waitFor(
            async () => {
              resumed = await resumedActivity();
              return resumed.includes(launcher) && !resumed.includes("com.android.settings");
            },
            {
              interval: 1_000,
              label: () => `the home screen in the foreground, resumed: ${resumed}`,
              timeout: 30_000,
            },
          );
        } finally {
          socket.close();
        }
      },
    );

    it(
      "a tap sent through a gateway on a page the emulator loaded through a reverse tunnel makes the page call the caller back through that tunnel, and once the lease is released under the open tunnel no reverse or forward rule is left for the emulator's serial",
      { timeout: 300_000 },
      async () => {
        const requests: string[] = [];
        const page = createServer((request, response) => {
          requests.push(request.url ?? "");
          response.writeHead(200, { "content-type": "text/html" }).end(TAP_PAGE);
        });
        const pagePort = await freeLoopbackPort();
        await new Promise<void>((resolve) => page.listen(pagePort, "127.0.0.1", resolve));
        const socket = await openInputSocket(gatewayPort.value, lease.id, lease.secret);
        try {
          const env = onGateway();
          const chrome = await env.cli(["adb", "shell", `pm path ${CHROME}`]);
          expect(chrome.stdout, "the emulator's image has no Chrome to open the page in").toContain(
            "package:",
          );
          // why: Chrome's first-run screens would cover the page; on an emulator image Chrome reads its flags from this file once it is the debug app.
          for (const step of [
            `echo '_ --disable-fre --no-default-browser-check --no-first-run' > /data/local/tmp/chrome-command-line`,
            `am set-debug-app --persistent ${CHROME}`,
            `pm grant ${CHROME} android.permission.POST_NOTIFICATIONS`,
            `am force-stop ${CHROME}`,
          ]) {
            await env.cli(["adb", "shell", step]);
          }

          const tunnel = env.cliBackground([
            "--token",
            lease.secret,
            "tunnel",
            "reverse",
            String(pagePort),
            "--url",
            `http://127.0.0.1:${String(gatewayPort.value)}`,
            "--lease",
            lease.id,
          ]);
          expect(await tunnel.firstStdoutLine(60_000)).toBe(
            `reverse device:${String(pagePort)} -> localhost:${String(pagePort)} (lease ${lease.id})`,
          );

          const view = await env.cli([
            "adb",
            "shell",
            `am start -a android.intent.action.VIEW -d http://localhost:${String(pagePort)}/ -p ${CHROME}`,
          ]);
          expect(view.code, view.stderr).toBe(0);
          await waitFor(() => requests.includes("/loaded"), {
            interval: 500,
            label: () => `the page loaded through the tunnel, requests: ${requests.join(" ")}`,
            timeout: 90_000,
          });
          expect(requests.some((url) => url.startsWith("/tapped"))).toBe(false);

          await socket.waitForTag(0x82);
          await waitFor(
            () => {
              if (requests.some((url) => url.startsWith("/tapped"))) return true;
              socket.send(0x03, { type: "begin", x: 0.5, y: 0.6 });
              socket.send(0x03, { type: "end", x: 0.5, y: 0.6 });
              return false;
            },
            {
              interval: 3_000,
              label: () => `a tapped request through the tunnel, requests: ${requests.join(" ")}`,
              timeout: 60_000,
            },
          );

          const rules = await workerAdb(workerAdbPort(), ["-s", lease.serial, "reverse", "--list"]);
          expect(rules.stdout).toContain(`tcp:${String(pagePort)}`);
          const released = await env.cli(["release", lease.id]);
          expect(released.code, released.stderr).toBe(0);
          const ended = await tunnel.waitForExit(30_000);
          expect(ended.code, ended.stderr).toBe(14);
          expect(ended.error?.code).toBe("TUNNEL_LEASE_ENDED");

          let left = { forward: "", reverse: "" };
          await waitFor(
            async () => {
              const reverse = await workerAdb(workerAdbPort(), [
                "-s",
                lease.serial,
                "reverse",
                "--list",
              ]);
              const forward = await workerAdb(workerAdbPort(), ["forward", "--list"]);
              left = {
                forward: forward.stdout
                  .split("\n")
                  .filter((line) => line.startsWith(`${lease.serial} `))
                  .join("\n"),
                reverse: reverse.stdout.trim(),
              };
              return reverse.code === 0 && forward.code === 0;
            },
            {
              interval: 2_000,
              label: "the emulator answering adb after its reclaim",
              timeout: 120_000,
            },
          );
          expect(left).toEqual({ forward: "", reverse: "" });
        } finally {
          socket.close();
          await new Promise<void>((resolve) => page.close(() => resolve()));
        }
      },
    );
  },
);
