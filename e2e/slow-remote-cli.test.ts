import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DEVICE_READY_MS, withHttpDaemon } from "./helpers/index.js";

describe.skipIf(process.platform !== "darwin")(
  "the CLI against a worker's HTTP address (real simulator)",
  { tags: ["slow", "ios"] },
  () => {
    it(
      "leases, reports status, runs simctl and releases from a data folder with no daemon, each exiting 0, and starts no second daemon",
      { timeout: 480_000 },
      async () => {
        const { env, port } = await withHttpDaemon((httpPort) => ({
          configOverrides: { http: { enabled: true, host: "127.0.0.1", port: httpPort } },
          driver: "real",
        }));
        const clientHome = await mkdtemp(join(tmpdir(), "simlock-remote-cli-"));
        try {
          const created = await env.cli(["token", "create", "--role", "agent"]);
          expect(created.code, created.stderr).toBe(0);
          const remote = {
            env: {
              SIMLOCK_AGENT_ID: "remote-cli",
              SIMLOCK_HOME: clientHome,
              SIMLOCK_TOKEN: (created.json as { secret: string }).secret,
              SIMLOCK_URL: `http://127.0.0.1:${String(port)}`,
            },
          };

          const lease = await env.cli(["lease", "--platform", "ios", "--detach"], {
            ...remote,
            timeout: DEVICE_READY_MS,
          });
          expect(lease.code, `lease failed: ${lease.stdout} ${lease.stderr}`).toBe(0);
          const leaseId = (lease.json as { lease: { id: string } }).lease.id;

          const status = await env.cli(["status", "--json"], remote);
          expect(status.code, status.stderr).toBe(0);
          const apps = await env.cli(["simctl", "listapps"], { ...remote, timeout: 60_000 });
          expect(apps.code, `simctl failed: ${apps.stdout} ${apps.stderr}`).toBe(0);
          const released = await env.cli(["release", leaseId], remote);
          expect(released.code, released.stderr).toBe(0);

          expect(await readdir(clientHome)).not.toContain("instance.json");
          expect(await readdir(clientHome)).not.toContain("daemon.log");
        } finally {
          await rm(clientHome, { force: true, recursive: true });
        }
      },
    );
  },
);
