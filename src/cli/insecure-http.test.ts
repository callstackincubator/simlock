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
  const farm = new FakeFarm({ "status.get": () => EMPTY_STATUS });
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
});
