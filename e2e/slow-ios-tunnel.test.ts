import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { DEVICE_READY_MS, freeLoopbackPort, waitFor, withHttpDaemon } from "./helpers/index.js";
import { simctlInSet, sweepStaleDeviceSets } from "./helpers/ios-device-set.js";

const execFileAsync = promisify(execFile);

const FROM_SIMULATOR = "from-the-simulator";
const FROM_CALLER = "from-the-caller";

// why: no iOS runtime ships `nc` or `python` (F20), so the simulator side is two small C programs built for the simulator SDK and run with `simctl spawn`.
const LISTENER_SOURCE = `
#include <arpa/inet.h>
#include <netinet/in.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>
int main(int argc, char **argv) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  struct sockaddr_in address = {0};
  address.sin_family = AF_INET;
  address.sin_port = htons((unsigned short)atoi(argv[1]));
  address.sin_addr.s_addr = inet_addr("127.0.0.1");
  if (bind(fd, (struct sockaddr *)&address, sizeof address) != 0) return 2;
  listen(fd, 4);
  for (;;) {
    int client = accept(fd, 0, 0);
    char buffer[64];
    read(client, buffer, sizeof buffer);
    write(client, "${FROM_SIMULATOR}", ${String(FROM_SIMULATOR.length)});
    close(client);
  }
}
`;

const CLIENT_SOURCE = `
#include <netdb.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>
int main(int argc, char **argv) {
  struct addrinfo hints = {0}, *found;
  hints.ai_socktype = SOCK_STREAM;
  if (getaddrinfo("localhost", argv[1], &hints, &found) != 0) return 2;
  for (struct addrinfo *next = found; next != 0; next = next->ai_next) {
    int fd = socket(next->ai_family, next->ai_socktype, next->ai_protocol);
    if (connect(fd, next->ai_addr, next->ai_addrlen) != 0) { close(fd); continue; }
    write(fd, "GET / HTTP/1.0\\r\\n\\r\\n", 18);
    char buffer[256];
    ssize_t count;
    while ((count = read(fd, buffer, sizeof buffer)) > 0) fwrite(buffer, 1, (size_t)count, stdout);
    return 0;
  }
  return 3;
}
`;

async function buildForSimulator(directory: string, name: string, source: string) {
  const sourcePath = join(directory, `${name}.c`);
  const output = join(directory, name);
  await writeFile(sourcePath, source);
  await execFileAsync("xcrun", [
    "--sdk",
    "iphonesimulator",
    "clang",
    "-target",
    "arm64-apple-ios17.0-simulator",
    sourcePath,
    "-o",
    output,
  ]);
  return output;
}

async function readFrom(port: number): Promise<string> {
  return await new Promise<string>((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    let received = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(FROM_CALLER));
    socket.on("data", (chunk: string) => {
      received += chunk;
    });
    socket.on("close", () => resolve(received));
    socket.on("error", () => resolve(received));
  });
}

// why: only a real simulator proves that its sockets are the worker's loopback sockets and that `lsof` and `ps eww` name its processes by `SIMULATOR_UDID`; the unit tests fake both.
describe.skipIf(process.platform !== "darwin")(
  "simlock tunnel on a real iOS simulator against a lone worker",
  { tags: ["slow", "ios"] },
  () => {
    it(
      "forwards to a listener in the simulator and refuses a worker-only listener, reverses to the caller's loopback and refuses a second reverse of the port",
      { timeout: 900_000 },
      async () => {
        await sweepStaleDeviceSets();
        const { env, port } = await withHttpDaemon((httpPort) => ({
          configOverrides: {
            capabilities: { tunnel: { enabled: true } },
            http: { enabled: true, host: "127.0.0.1", port: httpPort },
            idle: { shutdownAfterMs: 300_000 },
            warmPool: { learn: false },
          },
          driver: "real",
        }));
        const programs = await mkdtemp(join(tmpdir(), "simlock-ios-tunnel-"));
        // why: a server socket that never reads never sees the peer's FIN, stays open, and `close()` waits on it forever; `resume()` drains what the tunnel sends.
        const workerOnly = createServer((socket) => socket.resume().end("worker-only"));
        let listener: ReturnType<typeof spawn> | undefined;
        try {
          const listenerBinary = await buildForSimulator(programs, "listen", LISTENER_SOURCE);
          const clientBinary = await buildForSimulator(programs, "client", CLIENT_SOURCE);

          const lease = await env.cli(
            ["lease", "--platform", "ios", "--agent-id", "tunnel", "--detach"],
            { timeout: DEVICE_READY_MS },
          );
          expect(lease.code, `lease failed: ${lease.stderr}`).toBe(0);
          const grant = lease.json as {
            device: { driverDeviceId: string };
            environment: Record<string, string>;
            lease: { id: string };
          };
          const leaseId = grant.lease.id;
          const udid = grant.device.driverDeviceId;
          const deviceSet = grant.environment.SIMLOCK_IOS_DEVICE_SET as string;

          const [appPort, workerPort, reversePort] = [
            await freeLoopbackPort(),
            await freeLoopbackPort(),
            await freeLoopbackPort(),
          ];
          const [appCaller, workerCaller, reverseCaller] = [
            await freeLoopbackPort(),
            await freeLoopbackPort(),
            await freeLoopbackPort(),
          ];
          await new Promise<void>((resolve) => workerOnly.listen(workerPort, "127.0.0.1", resolve));
          listener = spawn(
            "xcrun",
            ["simctl", "--set", deviceSet, "spawn", udid, listenerBinary, String(appPort)],
            { stdio: "ignore" },
          );

          const created = await env.cli(["token", "create", "--role", "operator"]);
          expect(created.code, created.stderr).toBe(0);
          const secret = (created.json as { secret: string }).secret;
          const url = `http://127.0.0.1:${String(port)}`;

          const tunnel = env.cliBackground([
            "--token",
            secret,
            "tunnel",
            "forward",
            `${String(appPort)}:${String(appCaller)}`,
            "forward",
            `${String(workerPort)}:${String(workerCaller)}`,
            "reverse",
            `${String(reversePort)}:${String(reverseCaller)}`,
            "--url",
            url,
            "--lease",
            leaseId,
          ]);
          await tunnel.firstStdoutLine(60_000);

          let answered = "";
          await waitFor(
            async () => {
              answered = await readFrom(appCaller);
              return answered === FROM_SIMULATOR;
            },
            {
              interval: 1_000,
              label: () => `the simulator listener's bytes through forward, last: ${answered}`,
              timeout: 60_000,
            },
          );
          expect(await readFrom(workerCaller)).toBe("");
          const page = createServer((socket) =>
            socket.resume().end(`HTTP/1.0 200 OK\r\n\r\n${FROM_CALLER}`),
          );
          await new Promise<void>((resolve) => page.listen(reverseCaller, "127.0.0.1", resolve));
          try {
            let reversed = "";
            await waitFor(
              async () => {
                const spawned = await simctlInSet(deviceSet, [
                  "spawn",
                  udid,
                  clientBinary,
                  String(reversePort),
                ]).catch(() => ({ stdout: "" }));
                reversed = spawned.stdout;
                return reversed.includes(FROM_CALLER);
              },
              {
                interval: 1_000,
                label: () =>
                  `the simulator reading the caller's page through reverse, last: ${reversed}`,
                timeout: 60_000,
              },
            );
          } finally {
            await new Promise<void>((resolve) => page.close(() => resolve()));
          }

          const second = await env.cli(
            [
              "--token",
              secret,
              "tunnel",
              "reverse",
              `${String(reversePort)}:${String(reverseCaller)}`,
              "--url",
              url,
              "--lease",
              leaseId,
            ],
            { timeout: 60_000 },
          );
          expect(second.code).toBe(1);
          expect(second.stderr).toContain("TUNNEL_PORT_IN_USE");

          tunnel.kill("SIGINT");
          const ended = await tunnel.waitForExit(10_000);
          expect(ended.code).toBe(0);
          expect(ended.stderr).toContain(
            `warning: forward ${String(workerPort)}: nothing on the lease's simulator listens on port ${String(workerPort)}`,
          );
        } finally {
          listener?.kill("SIGKILL");
          await new Promise<void>((resolve) => workerOnly.close(() => resolve()));
          await rm(programs, { force: true, recursive: true });
          await env
            .cli(["nuke", "--delete-devices", "--yes"], { timeout: 180_000 })
            .catch(() => undefined);
        }
      },
    );
  },
);
