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
});
