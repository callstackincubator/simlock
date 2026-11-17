import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { REPO_ROOT } from "./helpers/index.js";

const execFileAsync = promisify(execFile);

// why: a flow picks its daemon's port inline, so the window between the pick and the daemon's bind
// is seen only from a vitest run of its own. Its setup file stands in for another process of the
// parallel lane: in each test, the first TCP listener the flow closes has its port taken at once
// and held to the test's end. The `GET /v1/stats` flow already starts through withHttpDaemon: the control.
const TAKE_FIRST_RELEASED_PORT = `
import { createServer, Server } from "node:net";
import { afterEach, beforeEach } from "vitest";

const close = Server.prototype.close;
let taker;
beforeEach(() => {
  Server.prototype.close = function (callback) {
    const address = this.address();
    if (typeof address !== "object" || address === null) return close.call(this, callback);
    Server.prototype.close = close;
    return close.call(this, (error) => {
      const squatter = createServer((socket) => socket.destroy());
      squatter.listen(address.port, address.address, () => {
        taker = squatter;
        callback?.(error);
      });
    });
  };
});
afterEach(async () => {
  Server.prototype.close = close;
  const squatter = taker;
  taker = undefined;
  if (squatter !== undefined) await new Promise((resolve) => squatter.close(() => resolve()));
});
`;

const FLOWS: Record<string, readonly string[]> = {
  "e2e/daemon-folders.test.ts": [
    "--gateway config set makes a gateway present in an owner-only folder, after which --gateway status starts it",
    "a gateway started with --gateway runs beside the worker of the same root, each in its own folder",
    "on a machine with only a present gateway, plain daemon start and plain status reach the gateway and start no worker",
    "with a worker and a present gateway, a plain worker drain exits 2 with the worker's message and the --gateway hint; with --gateway the gateway answers UNKNOWN_WORKER (exit 12) for the worker's id",
    "with a worker and a present gateway, a worker error of another code carries no hint",
    "on a machine with only a gateway, plain daemon logs and events --since read the gateway's files",
    "simlock --gateway mcp lists the gateway's catalog, plain simlock mcp lists the worker's",
    "plain simlock mcp on a machine with only a present gateway lists the gateway's catalog",
    "a --gateway mcp session that started before any gateway existed reaches it once simlock --gateway daemon start has run",
    "with a gateway present but stopped, a --gateway mcp tool call starts the gateway in <root>/gateway",
  ],
  "e2e/daemon-lifecycle.test.ts": [
    "a service manager sends SIGTERM to a running gateway daemon: it stops cleanly, emits daemon.stopping reason signal, removes admin.token, exits 0",
  ],
  "e2e/daemon-log.test.ts": [
    "at debug, a device.exec command leaves one process line with its exit code and no line holding its output",
  ],
  "e2e/device-exec.test.ts": [
    "runs the driver-scoped command on the daemon and streams both its output and its exit code",
    "runs exec with stdinFile and the command reads the file's bytes, then end of input",
    "runs every exec with the lease's folder as its working folder",
    "refuses through the fake driver's own mirrored list, and never runs what it refuses",
    "checks ownership per role: an agent's own lease, and an operator that must name its holder",
  ],
  "e2e/http-api.test.ts": [
    "token create -> healthz -> catalog -> lease-request -> granted -> renew -> release, with auth enforced throughout",
    "refuses a ttlMs above lease.maxTtlMs on both routes, whatever shape the request takes",
    "POST /v1/lease-requests refuses a malformed os range as BAD_REQUEST naming the accepted forms",
    "POST /v1/lease-requests takes a class, or only a platform, and refuses a device beside a class",
    "POST /v1/lease-requests with leaseId grants a lease with exactly that ID, and renew and release name it",
    "POST /v1/lease-requests answers 400 BAD_REQUEST for each leaseId the pattern rejects, and 201 for a 64-character one",
    "POST /v1/lease-requests answers 409 LEASE_ID_TAKEN, naming the ID, for an ID an active lease holds",
    "with an operator token returns the same body as simlock stats --json for a fixed from/to, without requests, and &ledger=1 adds them, on a single host; an agent token gets 403",
  ],
  "e2e/lease-limit-per-requester.test.ts": [
    "HTTP answers 409 REQUESTER_ALREADY_LEASED to the third lease request of one token at lease.maxPerRequester 2",
  ],
  "e2e/physical-leasing.test.ts": ["cancelled when its requester cancels"],
  "e2e/usage-stats.test.ts": [
    "on a gateway with two workers, simlock stats --json has fleet totals and one entry per worker, and each worker's own covers itself only",
  ],
};

interface Report {
  readonly testResults: readonly {
    readonly name: string;
    readonly assertionResults: readonly { readonly title: string; readonly status: string }[];
  }[];
}

function escape(title: string): string {
  return title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("e2e flows on a picked port", () => {
  it(
    "the flows that start a daemon on a port they picked pass when another listener takes the first port each one releases",
    { timeout: 480_000 },
    async () => {
      const work = await mkdtemp(join(tmpdir(), "simlock-e2e-picked-ports-"));
      try {
        const files = Object.keys(FLOWS);
        const titles = Object.values(FLOWS).flat();
        const config = {
          test: {
            fileParallelism: true,
            hookTimeout: 120_000,
            include: files,
            maxWorkers: 4,
            root: REPO_ROOT,
            setupFiles: [join(REPO_ROOT, "e2e/helpers/setup.ts"), join(work, "take-port.mjs")],
            tags: ["slow", "ios", "android", "physical", "physical-manual"].map((name) => ({
              name,
            })),
            testNamePattern: titles.map(escape).join("|"),
            testTimeout: 120_000,
          },
        };
        await writeFile(join(work, "take-port.mjs"), TAKE_FIRST_RELEASED_PORT, "utf8");
        await writeFile(
          join(work, "vitest.config.mjs"),
          `export default ${JSON.stringify(config)};\n`,
          "utf8",
        );

        await execFileAsync(
          process.execPath,
          [
            join(REPO_ROOT, "node_modules/vitest/vitest.mjs"),
            "run",
            "--config",
            join(work, "vitest.config.mjs"),
            "--reporter=json",
            `--outputFile=${join(work, "report.json")}`,
          ],
          { cwd: REPO_ROOT, env: process.env, maxBuffer: 64 * 1024 * 1024 },
        ).catch(() => undefined);
        const report = JSON.parse(await readFile(join(work, "report.json"), "utf8")) as Report;

        const outcomes = Object.fromEntries(
          report.testResults.flatMap((file) =>
            file.assertionResults
              .filter((result) => result.status !== "skipped")
              .map((result) => [result.title, result.status]),
          ),
        );
        expect(outcomes).toEqual(Object.fromEntries(titles.map((title) => [title, "passed"])));
      } finally {
        await rm(work, { force: true, recursive: true });
      }
    },
  );
});
