import { describe, expect, it, vi } from "vitest";
import { runCli } from "./index.js";
import { EMPTY_STATUS, fakeClient, outputCapture } from "./test-index.js";
import { FakeFarm } from "./test-remote.js";

interface Setup {
  readonly url?: string;
  readonly token?: string | undefined;
  readonly insecureVariable?: string;
}

function session(setup: Setup = {}) {
  const farm = new FakeFarm({
    "identity.get": () => ({ name: "ci", principal: "tok_1", role: "agent", via: "token" }),
    "status.get": () => EMPTY_STATUS,
  });
  const output = outputCapture();
  const connectAdmin = vi.fn(async () => fakeClient());
  const environment = output.environmentWith({
    connectAdmin,
    connectExistingAdmin: connectAdmin,
    webSocket: farm,
    tunnelToken: setup.token ?? "slk_t",
    ...(setup.url === undefined ? {} : { tunnelUrl: setup.url }),
    ...(setup.insecureVariable === undefined
      ? {}
      : { allowInsecureHttpFromEnv: setup.insecureVariable }),
  });
  return { farm, output, run: (argv: readonly string[]) => runCli(argv, environment) };
}

const TAILSCALE = "http://100.75.181.35:4700";

describe("CLI: plain http to a remote farm by opt-in", () => {
  it("with --allow-insecure-http before or after the command, or SIMLOCK_ALLOW_INSECURE_HTTP=1, a command reaches the http farm at ws://", async () => {
    const runs: { setup: Setup; argv: string[] }[] = [
      { setup: {}, argv: ["--allow-insecure-http", "whoami", "--url", TAILSCALE] },
      { setup: {}, argv: ["whoami", "--url", TAILSCALE, "--allow-insecure-http"] },
      { setup: { insecureVariable: "1", url: TAILSCALE }, argv: ["whoami"] },
    ];
    for (const { setup, argv } of runs) {
      const { farm, output, run } = session(setup);
      expect(await run(argv), argv.join(" ")).toBe(0);
      expect(output.stderr).toBe("");
      expect(farm.connections.map(({ url }) => url)).toEqual([
        "ws://100.75.181.35:4700/v1/session",
      ]);
    }
  });

  it("an http farm URL to a non-loopback host with no opt-in exits 2 naming the flag and the variable, before it connects", async () => {
    const refusal = {
      error: {
        code: "USAGE",
        message:
          "--url must be https://, or http:// only for 127.0.0.1, [::1] or localhost; to connect over plain http anyway (the token is sent unencrypted), pass --allow-insecure-http or set SIMLOCK_ALLOW_INSECURE_HTTP=1",
      },
    };
    const refused: { setup: Setup; argv: string[] }[] = [
      { setup: {}, argv: ["whoami", "--url", TAILSCALE] },
      { setup: { url: TAILSCALE }, argv: ["whoami"] },
      { setup: { url: TAILSCALE }, argv: ["tunnel", "forward", "8081"] },
      { setup: { url: TAILSCALE }, argv: ["files", "list"] },
      { setup: { url: TAILSCALE }, argv: ["mcp"] },
      { setup: { insecureVariable: "", url: TAILSCALE }, argv: ["whoami"] },
    ];
    for (const { setup, argv } of refused) {
      const { farm, output, run } = session(setup);
      expect(await run(argv), argv.join(" ")).toBe(2);
      expect(JSON.parse(output.stderr), argv.join(" ")).toEqual(refusal);
      expect(farm.connections, argv.join(" ")).toEqual([]);
    }
  });

  it("the opt-in changes nothing else: other schemes, a path and the length limit refuse as before, a bad variable value is refused only where a farm URL is checked", async () => {
    const scheme = "--url must be https://, or http:// only for 127.0.0.1, [::1] or localhost";
    const origin = "--url must be the farm's origin only: no path, query or fragment";
    const variable = "SIMLOCK_ALLOW_INSECURE_HTTP must be 1, or unset";
    const cases: { setup: Setup; argv: string[]; message: string }[] = [
      ...["ws://gw.example.com", "ftp://gw.example.com", "gw.example.com:4700"].map((url) => ({
        argv: ["whoami", "--allow-insecure-http", "--url", url],
        message: scheme,
        setup: {},
      })),
      ...["ws://gw.example.com", "gw.example.com:4700"].map((url) => ({
        argv: ["whoami", "--url", url],
        message: scheme,
        setup: { insecureVariable: "1" },
      })),
      {
        argv: ["whoami", "--allow-insecure-http", "--url", `http://${"a".repeat(2042)}`],
        message: scheme,
        setup: {},
      },
      {
        argv: ["whoami", "--allow-insecure-http", "--url", "http://gw.example.com/v1"],
        message: origin,
        setup: {},
      },
      {
        argv: ["whoami", "--allow-insecure-http=1", "--url", TAILSCALE],
        message: "--allow-insecure-http takes no value",
        setup: {},
      },
      ...["true", "yes", "0"].map((value) => ({
        argv: ["whoami", "--url", TAILSCALE],
        message: variable,
        setup: { insecureVariable: value },
      })),
      {
        argv: ["whoami", "--url", "ws://gw.example.com"],
        message: variable,
        setup: { insecureVariable: "true" },
      },
      ...["true", "yes"].map((value) => ({
        argv: ["tunnel", "forward", "8081", "--local"],
        message: variable,
        setup: { insecureVariable: value, url: TAILSCALE },
      })),
      {
        argv: ["tunnel", "forward", "8081", "--local"],
        message: `${scheme}; to connect over plain http anyway (the token is sent unencrypted), pass --allow-insecure-http or set SIMLOCK_ALLOW_INSECURE_HTTP=1`,
        setup: { url: TAILSCALE },
      },
    ];
    for (const { setup, argv, message } of cases) {
      const { farm, output, run } = session(setup);
      expect(await run(argv), argv.join(" ")).toBe(2);
      expect(JSON.parse(output.stderr), argv.join(" ")).toEqual({
        error: { code: "USAGE", message },
      });
      expect(farm.connections, argv.join(" ")).toEqual([]);
    }

    const local: { setup: Setup; argv: string[] }[] = [
      { setup: {}, argv: ["whoami", "--local", "--allow-insecure-http"] },
      { setup: { insecureVariable: "true" }, argv: ["whoami"] },
      ...["1", "true"].map((value) => ({
        argv: ["whoami", "--local"],
        setup: { insecureVariable: value, url: TAILSCALE },
      })),
    ];
    for (const { setup, argv } of local) {
      const { farm, output, run } = session(setup);
      expect(await run(argv), argv.join(" ")).toBe(0);
      expect(output.stderr, argv.join(" ")).not.toContain('"error"');
      expect(farm.connections, argv.join(" ")).toEqual([]);
    }
  });
});
