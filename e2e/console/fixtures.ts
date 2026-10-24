import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  request as httpRequest,
  type Server,
  type ServerResponse,
} from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { test as base, expect, type Page } from "@playwright/test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { type RawData, WebSocket } from "ws";

import type { FakeDriverScript } from "../fake-driver/types.js";
import { cli, cliBackground, type CliBackgroundHandle, type CliResult } from "../helpers/cli.js";
import { freeLoopbackPort } from "../helpers/port.js";
import { REPO_ROOT } from "../helpers/repo-root.js";
import { waitFor } from "../helpers/wait.js";

/**
 * The browser lane's daemons. Each is a real daemon process with HTTP enabled on a free
 * loopback port and its own `SIMLOCK_HOME`, so nothing here touches the machine's own Simlock.
 * A worker runs the end-to-end suite's fake driver; a gateway runs no drivers at all.
 */

export interface ConsoleDaemon {
  /** The console's address, exactly as `simlock status --json` reports it. */
  readonly url: string;
  /** Runs `simlock` against this daemon, for a test that changes its state (a revoked token). */
  readonly cli: (args: readonly string[]) => Promise<CliResult>;
  readonly tokens: {
    readonly operator: string;
    readonly agent: string;
    readonly worker: string;
  };
}

/** A daemon a test drives itself: its CLI, and stopping and starting it in place. */
export interface RunningDaemon extends ConsoleDaemon {
  readonly port: number;
  /** The daemon's unix socket, for a test that drives it with the programmatic client. */
  readonly socketPath: string;
  cliBackground(args: readonly string[]): CliBackgroundHandle;
  /** Replaces the fake driver's script. A daemon reads its host facts and catalog at start. */
  writeDriverScript(script: FakeDriverScript): Promise<void>;
  /** `simlock daemon stop`, keeping the home: `start()` brings the same daemon back. */
  stop(): Promise<void>;
  /** `simlock daemon start` on the same home, port and tokens. */
  start(): Promise<void>;
  /** Stops the daemon and deletes its home. */
  dispose(options?: { readonly preservePages?: readonly Page[] }): Promise<void>;
  /** why: stats read completed minutes only, so this moves the usage rows two minutes back. */
  prepareHistoricalUsage(): Promise<void>;
}

export interface StartOptions {
  readonly config?: Readonly<Record<string, unknown>>;
  /** The fake driver's script, written before the daemon starts. */
  readonly driverScript?: FakeDriverScript;
}

const FAKE_DRIVER_MODULE = join(REPO_ROOT, "dist/e2e/index.js");
const activePages = new Set<Page>();

async function isProcessAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function pidsHoldingSocket(socketPath: string): Promise<number[]> {
  if (!existsSync(socketPath)) return [];
  return new Promise((resolve, reject) => {
    execFile("lsof", ["-t", socketPath], (error, stdout) => {
      if (error) {
        const failure = error as NodeJS.ErrnoException & { stderr?: string };
        if (
          String(failure.code) !== "1" ||
          (failure.stderr?.trim() && !failure.stderr.includes("No such file or directory"))
        ) {
          reject(error);
          return;
        }
      }
      resolve(
        stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== "")
          .map(Number)
          .filter((pid) => Number.isInteger(pid)),
      );
    });
  });
}

async function discoverDaemonPids(
  socketPath: string,
): Promise<{ error?: unknown; pids: number[] }> {
  try {
    return { pids: await pidsHoldingSocket(socketPath) };
  } catch (error: unknown) {
    return { error, pids: [] };
  }
}

async function requestDaemonStop(
  socketPath: string,
  gatewayFlag: readonly string[],
  env: NodeJS.ProcessEnv,
  daemonStarted: boolean,
  discovery: { readonly error?: unknown; readonly pids: readonly number[] },
): Promise<unknown> {
  if (!existsSync(socketPath)) return undefined;
  if (discovery.pids.length === 0 && discovery.error === undefined) return undefined;
  try {
    const stopped = await cli([...gatewayFlag, "daemon", "stop"], env);
    if (daemonStarted && stopped.code !== 0)
      return new Error(`daemon stop failed: ${stopped.stderr}`);
  } catch (error: unknown) {
    return error;
  }
  try {
    await waitFor(() => !existsSync(socketPath), {
      timeout: 10_000,
      label: "daemon socket removed",
    });
  } catch (error: unknown) {
    return error;
  }
  return undefined;
}

async function captureCleanupError(
  current: unknown,
  action: () => Promise<unknown>,
): Promise<unknown> {
  try {
    await action();
    return current;
  } catch (error: unknown) {
    return current ?? error;
  }
}

async function stopBackgroundProcesses(handles: readonly CliBackgroundHandle[]): Promise<void> {
  await Promise.all(
    handles.map(async (handle) => {
      handle.kill("SIGTERM");
      try {
        await handle.waitForExit(10_000);
      } catch {
        handle.kill("SIGKILL");
        await handle.waitForExit(10_000);
      }
    }),
  );
}

async function waitForDaemonPidsToExit(pids: ReadonlySet<number>): Promise<void> {
  const alive = async () =>
    (await Promise.all([...pids].map((pid) => isProcessAlive(pid)))).some(Boolean);
  try {
    await waitFor(async () => !(await alive()), {
      timeout: 5_000,
      interval: 100,
      label: "daemon process exited",
    });
  } catch {
    for (const pid of pids) {
      if (!(await isProcessAlive(pid))) continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    await waitFor(async () => !(await alive()), {
      timeout: 10_000,
      interval: 100,
      label: "daemon process exited after SIGKILL",
    });
  }
}

async function closeActivePages(preserved: ReadonlySet<Page>): Promise<unknown> {
  let firstError: unknown;
  for (const page of activePages) {
    if (preserved.has(page)) continue;
    if (!page.isClosed()) {
      try {
        await page.unrouteAll({ behavior: "ignoreErrors" });
      } catch (error: unknown) {
        firstError ??= error;
      }
      try {
        await page.close();
      } catch (error: unknown) {
        firstError ??= error;
      }
    }
    activePages.delete(page);
  }
  return firstError;
}

/**
 * Pins a worker's capacity to the flow, not the machine running it, as the end-to-end suite
 * does: fake devices use no real memory, so a nominal per-device budget keeps the RAM gate from
 * refusing a lease on a small CI runner.
 */
const FAKE_CAPACITY = {
  limits: {
    maxRunning: 8,
    ios: { maxDevices: 8, maxRunning: 8 },
    android: { maxDevices: 8, maxRunning: 8 },
  },
  ramBudget: { iosBytesPerDevice: 1024 * 1024, androidBytesPerDevice: 1024 * 1024 },
};

export async function startDaemon(
  mode: "worker" | "gateway",
  options: StartOptions = {},
): Promise<RunningDaemon> {
  const home = await mkdtemp(join(tmpdir(), "simlock-console-"));
  const port = await freeLoopbackPort();
  const scriptPath = join(home, "fake-driver-script.json");
  // why: a gateway lives in `<home>/gateway` and every CLI call that reaches it says `--gateway` (ADR 0034).
  const dataDirectory = mode === "gateway" ? join(home, "gateway") : home;
  const gatewayFlag = mode === "gateway" ? ["--gateway"] : [];
  const { http: extraHttp, ...extraConfig } = options.config ?? {};
  // why: a worker that joins a gateway may not enable HTTP (it is reached through the gateway), so it defaults off; a test's explicit `http.enabled` still wins, so an invalid override is not silently repaired.
  const joined = (extraConfig.gateway as { url?: unknown } | undefined)?.url !== undefined;
  const httpConfig = {
    enabled: !joined,
    host: "127.0.0.1",
    port,
    ...(extraHttp as object | undefined),
  };
  await mkdir(dataDirectory, { recursive: true });
  await writeFile(
    join(dataDirectory, "config.json"),
    JSON.stringify({
      ...(mode === "worker" ? FAKE_CAPACITY : {}),
      http: httpConfig,
      ...extraConfig,
      // why: a standalone worker has agent-device on by default (ADR 0046); the console specs do not ask for it, and a test's own `capabilities` (a stream, say) must not replace this pin, so it merges one level deep.
      ...(mode === "worker"
        ? {
            capabilities: {
              "agent-device": { enabled: false },
              ...(extraConfig.capabilities as object | undefined),
            },
          }
        : {}),
    }),
  );
  if (options.driverScript !== undefined) {
    await writeFile(scriptPath, JSON.stringify(options.driverScript));
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SIMLOCK_HOME: home,
    ...(mode === "worker"
      ? {
          SIMLOCK_DRIVERS_MODULE: FAKE_DRIVER_MODULE,
          SIMLOCK_FAKE_DRIVER_LOG: join(home, "fake-driver-calls.jsonl"),
          SIMLOCK_FAKE_DRIVER_SCRIPT: scriptPath,
        }
      : {}),
  };
  const socketPath = join(dataDirectory, "daemon.sock");
  const background = new Set<CliBackgroundHandle>();
  const daemonPids = new Set<number>();
  let daemonStarted = false;
  let daemonMayBeRunning = false;
  let daemonPidDiscoveryFailed = false;
  const stop = async () => {
    if (!daemonMayBeRunning) return;
    const discovery = await discoverDaemonPids(socketPath);
    for (const pid of discovery.pids) daemonPids.add(pid);
    daemonPidDiscoveryFailed ||= discovery.error !== undefined;
    const stopError = await requestDaemonStop(
      socketPath,
      gatewayFlag,
      env,
      daemonStarted,
      discovery,
    );
    if (!existsSync(socketPath)) {
      daemonStarted = false;
      daemonMayBeRunning = false;
    }
    if (discovery.error !== undefined) throw discovery.error;
    if (stopError !== undefined) throw stopError;
  };
  const start = async () => {
    const readLog = () => readFile(join(dataDirectory, "daemon.log"), "utf8").catch(() => "");
    const before = (await readLog()).length;
    daemonMayBeRunning = true;
    const started = await cli([...gatewayFlag, "daemon", "start"], env, { timeout: 30_000 });
    // why: `daemon start` exits 0 once the daemon answers from its socket, which can come before
    // the daemon fails to bind its HTTP port and stops (#553). So a clean exit is not yet a start:
    // wait for this start's own "HTTP gateway listening" or `EADDRINUSE` line (the log keeps the
    // earlier starts' lines), and fail on the latter.
    if (started.code === 0 && !httpConfig.enabled) {
      daemonStarted = true;
      return;
    }
    if (started.code === 0) {
      await waitFor(
        async () => {
          const added = (await readLog()).slice(before);
          return added.includes("EADDRINUSE") || added.includes('"HTTP gateway listening"');
        },
        { label: "the daemon's HTTP listener" },
      );
      if (!(await readLog()).slice(before).includes("EADDRINUSE")) {
        daemonStarted = true;
        return;
      }
    }
    // why: a failed start reports only what the CLI saw while polling the socket, and `dispose`
    // deletes this home with `daemon.log` — the only record of the cause the daemon itself wrote.
    // Read the tail here, before any caller's catch reaches `dispose`, and fail with both.
    const tail = (await readLog()).split("\n").slice(-20).join("\n");
    expect(started.code, `daemon start failed: ${started.stderr}\n${tail}`).toBe(0);
  };
  const dispose = async (options: { readonly preservePages?: readonly Page[] } = {}) => {
    const preserved = new Set(options.preservePages ?? []);
    let cleanupError = await closeActivePages(preserved);
    cleanupError = await captureCleanupError(cleanupError, () =>
      stopBackgroundProcesses([...background]),
    );
    let stopError: unknown;
    try {
      await stop();
    } catch (error: unknown) {
      stopError = error;
    }
    await waitForDaemonPidsToExit(daemonPids);
    if (daemonPidDiscoveryFailed) {
      throw cleanupError ?? new Error(`cannot verify daemon exit for ${socketPath}`);
    }
    if (stopError !== undefined && daemonPids.size === 0) throw stopError;
    // why: disposal can remove the home after a forced stop only once every discovered daemon PID
    // has exited; explicit stop() callers still receive the graceful-stop error above.
    if (daemonPids.size > 0) {
      daemonStarted = false;
      daemonMayBeRunning = false;
    }
    await rm(home, { force: true, recursive: true });
    if (cleanupError !== undefined) throw cleanupError;
  };
  try {
    await start();
    const status = await cli([...gatewayFlag, "status", "--json"], env);
    const url = (status.json as { daemon: { consoleUrl?: string } }).daemon.consoleUrl;
    if (httpConfig.enabled) expect(url).toBe(`http://127.0.0.1:${port}/`);
    else expect(url).toBeUndefined();
    const mint = async (role: string) => {
      const minted = await cli([...gatewayFlag, "token", "create", "--role", role], env);
      expect(minted.code, minted.stderr).toBe(0);
      return (minted.json as { secret: string }).secret;
    };
    const tokens = {
      agent: await mint("agent"),
      operator: await mint("operator"),
      worker: await mint("worker"),
    };
    if (url !== undefined) {
      await waitFor(
        async () => {
          try {
            return (await fetch(new URL("/v1/healthz", url))).ok;
          } catch {
            return false;
          }
        },
        { label: "HTTP listener accepting connections" },
      );
    }
    return {
      cli: (args) => cli([...gatewayFlag, ...args], env),
      cliBackground(args) {
        const handle = cliBackground([...gatewayFlag, ...args], env);
        background.add(handle);
        return handle;
      },
      dispose,
      port,
      socketPath,
      start,
      stop,
      async prepareHistoricalUsage() {
        await stop();
        // why: the daemon writes history.db until its process exits, not until its socket goes.
        await waitFor(
          async () =>
            !(await Promise.all([...daemonPids].map((pid) => isProcessAlive(pid)))).some(Boolean),
          { timeout: 20_000, interval: 100, label: "daemon process exited" },
        );
        const database = new DatabaseSync(join(dataDirectory, "history.db"));
        try {
          // why: Usage reads whole minutes only; moving the real projection while stopped keeps
          // presentation tests deterministic without changing the daemon's clock or live database.
          database.exec(
            "UPDATE minute_rows SET minute = minute - 120000, carryUntil = CASE WHEN carryUntil IS NULL THEN NULL ELSE carryUntil - 120000 END",
          );
          database.exec("UPDATE gaps SET at = at - 120000");
        } finally {
          database.close();
        }
        await start();
      },
      tokens,
      url: url ?? "",
      writeDriverScript: (script) => writeFile(scriptPath, JSON.stringify(script)),
    };
  } catch (error: unknown) {
    await dispose();
    throw error;
  }
}

/** A gateway and the workers that joined it, each labelled. */
export interface Fleet {
  readonly gateway: RunningDaemon;
  readonly workers: readonly RunningDaemon[];
}

/**
 * Starts a gateway and one worker per entry of `workers`, each joined to it with its label, and
 * waits until the gateway lists every one of them as connected and has read it: a worker that is
 * still `starting`, or not yet read, has no capacity or catalog in its view, and a test that
 * leases through the gateway or reads a card's capacity right away would see that gap.
 */
export async function startFleet(
  workers: readonly {
    readonly label: string;
    readonly driverScript?: FakeDriverScript;
    readonly config?: Readonly<Record<string, unknown>>;
  }[],
  options: { readonly gatewayConfig?: Readonly<Record<string, unknown>> } = {},
): Promise<Fleet> {
  const gateway = await startDaemon(
    "gateway",
    options.gatewayConfig === undefined ? {} : { config: options.gatewayConfig },
  );
  const started: RunningDaemon[] = [];
  try {
    for (const worker of workers) {
      started.push(
        await startDaemon("worker", {
          config: {
            ...worker.config,
            gateway: {
              label: worker.label,
              token: gateway.tokens.worker,
              url: `ws://127.0.0.1:${gateway.port}`,
            },
          },
          ...(worker.driverScript === undefined ? {} : { driverScript: worker.driverScript }),
        }),
      );
    }
    await waitFor(
      async () => {
        const listed = await gateway.cli(["worker", "list", "--json"]);
        const views = (
          listed.json as {
            workers?: readonly { capacity?: unknown; connection: string; health?: string }[];
          }
        ).workers;
        return (
          views?.length === workers.length &&
          views.every(
            (view) =>
              view.connection === "connected" &&
              view.health !== "starting" &&
              view.capacity !== undefined,
          )
        );
      },
      { label: "every worker connected to the gateway and read by it" },
    );
    return { gateway, workers: started };
  } catch (error: unknown) {
    await disposeFleet({ gateway, workers: started });
    throw error;
  }
}

export async function disposeFleet(
  fleet: Fleet,
  options: { readonly preservePages?: readonly Page[] } = {},
): Promise<void> {
  await Promise.all(fleet.workers.map((worker) => worker.dispose(options)));
  await fleet.gateway.dispose(options);
}

/** The protocol range the stand-in below claims: older than any this gateway speaks. */
export const OLD_PROTOCOL = { max: 3, min: 1 } as const;

/**
 * A worker too old for the gateway, without building an old Simlock: it dials the gateway's
 * uplink with a real join token, as a worker does, and answers the gateway's `hello` the way a
 * daemon speaking only protocol {@link OLD_PROTOCOL} does. The gateway then lists it as
 * `incompatible` with both ranges. Resolves once the uplink is open; call the result to hang up.
 */
export async function joinOldWorker(
  gateway: RunningDaemon,
  identity: { readonly id: string; readonly label: string },
): Promise<() => void> {
  const socket = new WebSocket(`ws://127.0.0.1:${gateway.port}/v1/uplink`, {
    headers: {
      authorization: `Bearer ${gateway.tokens.worker}`,
      "x-simlock-worker-id": identity.id,
      "x-simlock-worker-label": encodeURIComponent(identity.label),
    },
  });
  socket.on("message", (data: RawData) => {
    for (const line of rawText(data).split("\n")) {
      if (line.trim() === "") continue;
      const frame = JSON.parse(line) as {
        id?: number;
        type?: string;
        payload?: { protocolRange?: unknown };
      };
      if (frame.type !== "hello" || frame.id === undefined) continue;
      const reply = {
        error: {
          code: "PROTOCOL_VERSION_UNSUPPORTED",
          details: {
            client: frame.payload?.protocolRange,
            daemon: OLD_PROTOCOL,
            daemonVersion: "0.0.1",
          },
          message: "No protocol version in common",
        },
        id: frame.id,
        ok: false,
      };
      socket.send(`${JSON.stringify(reply)}\n`);
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  return () => socket.close();
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.from(data).toString("utf8");
}

const PROXY_ISSUER = "https://proxy.example.test";
const PROXY_AUDIENCE = "simlock-console";
const PROXY_HEADER = "cf-access-jwt-assertion";

export type ProxyMode = "signed-in" | "expired" | "redirect" | "html";

export interface ProxiedDaemon {
  readonly url: string;
  readonly loginUrl: string;
  readonly signedOutUrl: string;
  readonly daemon: RunningDaemon;
  setMode(mode: ProxyMode): void;
  holdIdentity(): () => void;
  reset(): void;
  dispose(): Promise<void>;
}

export async function startProxiedDaemon(
  options: { readonly signOutUrl?: boolean; readonly driverScript?: FakeDriverScript } = {},
): Promise<ProxiedDaemon> {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const jwk = { ...(await exportJWK(publicKey)), alg: "ES256", kid: "test-key", use: "sig" };
  const sign = (expiresAt: number) =>
    new SignJWT({ email: "alice@example.test", name: "Alice" })
      .setProtectedHeader({ alg: "ES256", kid: "test-key" })
      .setIssuer(PROXY_ISSUER)
      .setAudience(PROXY_AUDIENCE)
      .setSubject("u1")
      .setIssuedAt()
      .setExpirationTime(expiresAt)
      .sign(privateKey);
  let mode: ProxyMode = "signed-in";
  let held: Promise<void> | undefined;
  let daemonPort = 0;
  const listen = (server: Server, port: number) =>
    new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const close = (server: Server) =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });

  const idpPort = await freeLoopbackPort();
  const idp = createServer((req, res) => {
    const signedOut = req.url === "/signed-out";
    res.setHeader("content-type", "text/html");
    res.end(`<h1>${signedOut ? "Signed out of the proxy" : "Proxy login"}</h1>`);
  });
  await listen(idp, idpPort);
  const loginUrl = `http://127.0.0.1:${idpPort}/login`;
  const signedOutUrl = `http://127.0.0.1:${idpPort}/signed-out`;

  const forward = async (req: IncomingMessage, res: ServerResponse) => {
    const exp = Math.floor(Date.now() / 1000) + (mode === "expired" ? -600 : 3600);
    const headers = {
      ...req.headers,
      [PROXY_HEADER]: await sign(exp),
      host: `127.0.0.1:${daemonPort}`,
    };
    if (req.url === "/v1/identity" && held !== undefined) await held;
    const upstream = httpRequest(
      { headers, host: "127.0.0.1", method: req.method, path: req.url, port: daemonPort },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    upstream.on("error", () => res.destroy());
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  };
  const proxy = createServer((req, res) => {
    if (req.url === "/.test/jwks") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    if (req.url !== "/v1/healthz" && mode === "redirect") {
      res.writeHead(302, { location: loginUrl });
      res.end();
      return;
    }
    if (req.url !== "/v1/healthz" && mode === "html") {
      res.writeHead(403, { "content-type": "text/html" });
      res.end("<h1>Proxy sign-in</h1>");
      return;
    }
    void forward(req, res);
  });
  const proxyPort = await freeLoopbackPort();
  await listen(proxy, proxyPort);
  let daemon: RunningDaemon;
  try {
    daemon = await startDaemon("worker", {
      ...(options.driverScript === undefined ? {} : { driverScript: options.driverScript }),
      config: {
        http: {
          proxyAuth: {
            audience: PROXY_AUDIENCE,
            header: PROXY_HEADER,
            issuer: PROXY_ISSUER,
            jwksUrl: `http://127.0.0.1:${proxyPort}/.test/jwks`,
            ...(options.signOutUrl === false ? {} : { signOutUrl: signedOutUrl }),
          },
        },
      },
    });
  } catch (error: unknown) {
    await Promise.all([close(proxy), close(idp)]);
    throw error;
  }
  daemonPort = daemon.port;
  return {
    daemon,
    dispose: async () => {
      await Promise.all([close(proxy), close(idp)]);
      await daemon.dispose();
    },
    holdIdentity() {
      let release: () => void = () => {};
      held = new Promise<void>((resolve) => (release = resolve));
      return () => {
        held = undefined;
        release();
      };
    },
    loginUrl,
    reset() {
      mode = "signed-in";
      held = undefined;
    },
    setMode: (next) => void (mode = next),
    signedOutUrl,
    url: `http://127.0.0.1:${proxyPort}/`,
  };
}

/**
 * `daemon` is a single host, shared by every test in a Playwright worker, and the base URL every
 * `page.goto` resolves against. `gateway` starts only for a test that asks for it.
 */
export const test = base.extend<
  { proxied: ProxiedDaemon },
  { daemon: RunningDaemon; gateway: RunningDaemon; proxiedDaemon: ProxiedDaemon }
>({
  page: async ({ context }, use) => {
    const page = await context.newPage();
    activePages.add(page);
    try {
      await use(page);
    } finally {
      activePages.delete(page);
      await page.close();
    }
  },
  proxiedDaemon: [
    // oxlint-disable-next-line no-empty-pattern -- as below.
    async ({}, use) => {
      const proxied = await startProxiedDaemon();
      await use(proxied);
      await proxied.dispose();
    },
    { scope: "worker", timeout: 60_000 },
  ],
  proxied: async ({ proxiedDaemon }, use) => {
    proxiedDaemon.reset();
    await use(proxiedDaemon);
  },
  daemon: [
    // oxlint-disable-next-line no-empty-pattern -- Playwright requires a destructuring pattern here, even an empty one.
    async ({}, use) => {
      const daemon = await startDaemon("worker");
      await use(daemon);
      await daemon.dispose();
    },
    { scope: "worker", timeout: 60_000 },
  ],
  gateway: [
    // oxlint-disable-next-line no-empty-pattern -- as above.
    async ({}, use) => {
      const daemon = await startDaemon("gateway");
      await use(daemon);
      await daemon.dispose();
    },
    { scope: "worker", timeout: 60_000 },
  ],
  baseURL: async ({ daemon }, use) => {
    await use(daemon.url);
  },
});

export { expect };

/** Signs in through the sign-in screen, as an operator would. */
export async function signIn(page: Page, token: string): Promise<void> {
  await page.getByLabel("Operator token").fill(token);
  await page.getByRole("button", { name: "Sign in" }).click();
}

// why: while the first identity check runs the page shows "Signing in…" with nothing focusable, so a Tab
// and the typing sent before the form shows are lost; wait for the form and the focus first.
/** Signs in with the keyboard alone: tabs to the token field, types the token and presses Enter. */
export async function signInWithKeyboard(page: Page, token: string, tab: string): Promise<void> {
  const field = page.getByLabel("Operator token");
  await expect(field).toBeVisible();
  await expect(field).toBeEnabled();
  await page.keyboard.press(tab);
  await expect(field).toBeFocused();
  await page.keyboard.type(token);
  await page.keyboard.press("Enter");
}

export const NAV = [
  { label: "Overview", path: "/" },
  { label: "Inbox", path: "/inbox" },
  { label: "Fleet", path: "/fleet" },
  { label: "Leases", path: "/leases" },
  { label: "Queue", path: "/queue" },
  { label: "Activity", path: "/activity" },
  { label: "Usage", path: "/usage" },
] as const;

export const NAV_GROUPS = [
  { label: "Operate", links: ["Fleet", "Leases", "Queue"] },
  { label: "Observe", links: ["Activity", "Usage"] },
] as const;

export const NAV_LABELS = NAV.map((entry) => entry.label);

// why: pages slide and fade in; an audit or a measurement taken mid-way reads a half-faded colour.
export async function settled(page: Page): Promise<void> {
  await page.evaluate(() =>
    Promise.all(
      document.getAnimations().map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
}

// why: on a phone the sidebar folds into a menu, which has to be opened before its links show.
export async function openFromNav(page: Page, label: string): Promise<void> {
  const nav = page.getByRole("navigation", { name: "Console" });
  if ((page.viewportSize()?.width ?? Infinity) < 768) {
    await nav.getByRole("button", { name: "Open menu" }).click();
  }
  await nav.getByRole("link", { name: label, exact: true }).click();
}

// why: a host with one lease held by `surface-agent`, for checks that need the console's menu,
// dialog and toast open.
export async function startHostWithLease(): Promise<RunningDaemon> {
  const host = await startDaemon("worker", {
    driverScript: { ios: { availableOsVersions: ["18.4"], knownModels: ["iPhone 16"] } },
  });
  const granted = await host.cli([
    "lease",
    "--platform",
    "ios",
    "--device",
    "iPhone 16",
    "--os",
    "18.4",
    "--agent-id",
    "surface-agent",
    "--detach",
  ]);
  expect(granted.code, granted.stderr).toBe(0);
  return host;
}

// why: signs in on Leases and opens, in turn, an error toast (a release the daemon never answers),
// the row's menu over it, and the release dialog over it, calling `check` with each open.
export async function withActionSurfaces(
  page: Page,
  host: RunningDaemon,
  check: (surface: "toast" | "menu" | "dialog") => Promise<void>,
): Promise<void> {
  await page.goto(new URL("/leases", host.url).toString());
  await signIn(page, host.tokens.operator);
  await expect(page.getByRole("heading", { level: 1, name: "Leases" })).toBeVisible();
  const row = page.locator("main tbody tr").filter({ hasText: "surface-agent" });
  const menuButton = row.getByRole("button", { name: "Actions for surface-agent" });
  const dialog = page.getByRole("alertdialog", { name: "Release surface-agent's lease?" });
  await page.route("**/v1/leases/*", (route) =>
    route.request().method() === "DELETE" ? route.abort() : route.continue(),
  );
  await menuButton.click();
  await page.getByRole("menuitem", { name: "Release lease" }).click();
  await dialog.getByRole("button", { name: "Release lease" }).click();
  await expect(
    page.getByRole("region", { name: "Notifications" }).getByText("The daemon did not answer."),
  ).toBeVisible();
  await settled(page);
  await check("toast");

  await menuButton.click();
  await expect(page.getByRole("menuitem", { name: "Release lease" })).toBeVisible();
  await settled(page);
  await check("menu");

  await page.getByRole("menuitem", { name: "Release lease" }).click();
  await expect(dialog).toBeVisible();
  await settled(page);
  await check("dialog");
}
